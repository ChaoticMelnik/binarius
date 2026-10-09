import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  BOT_TEXT_CATALOG,
  BOT_TEXT_GROUP_TITLES,
  BOT_TEXT_SOURCE_MAX,
  BOT_TEXT_VARS,
  BOT_TEXTS_APPLIED_WITHIN_S,
  DATABASE_URL_RULES,
  botTextRejectionMessage,
  isBotTextKey,
  parseNoWhitespaceEnv,
  parseUrlEnv,
  readEnv,
  resolveBotTextOverrides,
  type BotTextKey,
  type BotTextVarName,
  AuditActorType,
} from '@binarius/shared';
import {
  createDb,
  listBotTextOverrides,
  resetBotTextOverride,
  saveBotTextOverride,
  type BotTextOverrideRecord,
  type BotTextWriteResult,
} from '@binarius/db';
import {
  BOT_PROFILE_METHODS,
  botProfileMethodsOf,
  createBotProfileApi,
  publishBotProfile,
  readBotProfileSource,
  type BotProfileApi,
  type BotProfileMethod,
  type BotProfileMethodResult,
  type CreateBotProfileApiOptions,
} from '../bot-texts/publish';
import { formatFailure } from './kill-switch';

// The client bot's texts (#299, docs/bot-texts.md → The CLI). 0 done, 1 the command could not be
// carried out, 2 not understood. `show` prints the text alone on stdout, so `show > file` is the
// file `set --file` takes back.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `Тексты клиентского бота.

  bot-text list                                     все ключи: изменён или исходный
  bot-text show <ключ>                              действующий текст (в stdout)
  bot-text set <ключ> --file <путь|-> [--version N] сохранить текст из файла или stdin
  bot-text reset <ключ> [--version N]               вернуть исходный текст
  bot-text publish                                  опубликовать меню команд и профиль в Telegram

--version — версия из show: при несовпадении сохранение отклоняется.
set и reset ключа команд или профиля сразу публикуют его в Telegram (нужен TELEGRAM_BOT_TOKEN).`;

// a UTF-8 text of BOT_TEXT_SOURCE_MAX UTF-16 units takes at most this many bytes
const FILE_MAX_BYTES = 4 * BOT_TEXT_SOURCE_MAX;

export interface BotTextIo {
  out(line: string): void;
  err(line: string): void;
  // at most `maxBytes`: one byte over the cap is enough to refuse, and the rest is never read
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
  readStdin(maxBytes: number): Promise<Uint8Array>;
}

type Parsed =
  | { command: 'list' | 'publish' }
  | { command: 'show' | 'reset'; key: string; version?: number }
  | { command: 'set'; key: string; file: string; version?: number };

export class UsageError extends Error {
  override readonly name = 'UsageError';
}
// the file is unreadable as a text, which is not a usage mistake
export class BotTextFileError extends Error {
  override readonly name = 'BotTextFileError';
}

export function parseBotTextArgs(argv: readonly string[]): Parsed {
  let values: { file?: string; version?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { file: { type: 'string' }, version: { type: 'string' } },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const [command, key, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError('лишние аргументы');
  if (values.version !== undefined && !/^\d{1,15}$/.test(values.version)) {
    throw new UsageError('--version: целое число из show');
  }
  const version = values.version === undefined ? undefined : Number(values.version);
  if (command === 'list' || command === 'publish') {
    if (key !== undefined || values.file !== undefined || version !== undefined) {
      throw new UsageError(`${command} не принимает аргументов`);
    }
    return { command };
  }
  if (command !== 'show' && command !== 'set' && command !== 'reset') {
    throw new UsageError(command === undefined ? 'нет команды' : `неизвестная команда: ${command}`);
  }
  if (key === undefined) throw new UsageError('нет ключа');
  // reset takes a key the catalog no longer has, so its row can be removed
  if (!isBotTextKey(key) && command !== 'reset') throw new UsageError(`неизвестный ключ: ${key}`);
  if (command === 'show') {
    if (values.file !== undefined || version !== undefined) {
      throw new UsageError('show принимает только ключ');
    }
    return { command, key };
  }
  if (command === 'reset') {
    if (values.file !== undefined) throw new UsageError('--file не нужен для reset');
    return { command, key, ...(version === undefined ? {} : { version }) };
  }
  if (values.file === undefined) throw new UsageError('нужен --file <путь> или --file -');
  return { command, key, file: values.file, ...(version === undefined ? {} : { version }) };
}

// A path like /dev/zero or a pipe with no end is read only as far as the cap needs.
export async function readAtMost(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(maxBytes);
    let total = 0;
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(bytes, total, maxBytes - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return bytes.subarray(0, total);
  } finally {
    await handle.close();
  }
}

export async function streamAtMost(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  // leaving the loop early closes the stream
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

// Strict UTF-8, no BOM, LF line ends, and the one trailing newline an editor adds taken off.
export function decodeBotTextFile(bytes: Uint8Array): string {
  if (bytes.length > FILE_MAX_BYTES) {
    throw new BotTextFileError(`Файл больше ${FILE_MAX_BYTES} байт.`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new BotTextFileError('Файл не в UTF-8.');
  }
  return decoded.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

const stamp = (row: BotTextOverrideRecord | undefined) =>
  row === undefined ? 'исходный' : `изменён, версия ${row.version}, ${row.updatedAt.toISOString()}`;

function list(rows: BotTextOverrideRecord[], io: BotTextIo): void {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const { rejected } = resolveBotTextOverrides(rows);
  for (const key of Object.keys(BOT_TEXT_CATALOG) as BotTextKey[]) {
    io.out(`${key}\t${BOT_TEXT_CATALOG[key].group}\t${stamp(byKey.get(key))}`);
  }
  for (const [key, rejection] of rejected) {
    io.out(`${key}: не действует — ${botTextRejectionMessage(rejection, key)}`);
  }
}

// what the text may hold (#358): the key's variables from the registry, then its fragments
function placeholdersLine(key: BotTextKey): string {
  const entry = BOT_TEXT_CATALOG[key];
  const variables = (entry.vars as readonly BotTextVarName[]).map((name) => {
    const { description, sample } = BOT_TEXT_VARS[name];
    return `{${name}} — ${description} (образец: ${sample})`;
  });
  const fragments = Object.keys(entry.fragments).map((name) => `{${name}}`);
  return [
    variables.length === 0 ? 'переменных нет' : `переменные: ${variables.join('; ')}`,
    ...(fragments.length === 0 ? [] : [`фрагменты: ${fragments.join(', ')}`]),
  ].join('; ');
}

function show(key: BotTextKey, rows: BotTextOverrideRecord[], io: BotTextIo): void {
  const entry = BOT_TEXT_CATALOG[key];
  const row = rows.find((r) => r.key === key);
  const resolved = resolveBotTextOverrides(rows);
  const rejection = resolved.rejected.get(key);
  io.err(`${key} · ${BOT_TEXT_GROUP_TITLES[entry.group]} · ${entry.description}`);
  io.err(placeholdersLine(key));
  io.err(`${stamp(row)}${row === undefined ? ', версия 0' : ''}`);
  if (rejection !== undefined) {
    io.err(`не действует — ${botTextRejectionMessage(rejection, key)}; показан исходный`);
  }
  io.out(resolved.source.sourceOf(key));
}

function report(key: string, result: BotTextWriteResult, io: BotTextIo, saved?: string): number {
  if (result.ok) {
    io.out(
      result.version === 0
        ? `Сброшено: ${key}. Бот и push backend'а вернут исходный текст в течение ${BOT_TEXTS_APPLIED_WITHIN_S} с.`
        : `Сохранено: ${key}, версия ${result.version}. Бот и push backend'а применят текст в течение ${BOT_TEXTS_APPLIED_WITHIN_S} с.`,
    );
    if (isBotTextKey(key) && saved === BOT_TEXT_CATALOG[key].source) {
      io.err('Текст совпадает с исходным: чтобы вернуть исходный, есть reset.');
    }
    return EXIT_OK;
  }
  switch (result.reason) {
    case 'unchanged':
      io.out('Текст не изменился.');
      return EXIT_OK;
    case 'already_default':
      io.out('Уже исходный текст.');
      return EXIT_OK;
    case 'version_conflict':
      io.err(`Текст уже изменил другой сотрудник (текущая версия ${result.currentVersion}).`);
      return EXIT_FAILED;
    case 'refused':
      for (const { key: culprit, rejection } of result.problems) {
        const prefix = culprit === key ? '' : `${culprit}: `;
        io.err(`${prefix}${botTextRejectionMessage(rejection, culprit)}`);
      }
      return EXIT_FAILED;
  }
}

// what Telegram answered, by identity (Rule 8): never its description or the payload
function publishLine(result: BotProfileMethodResult): string {
  if (result.ok) return `${result.method}: опубликовано`;
  const one = ({ name, code }: { name: string; code?: string }) =>
    code === undefined ? name : `${name} ${code}`;
  const cause = result.cause === undefined ? '' : ` (${one(result.cause)})`;
  const telegram =
    result.telegramErrorCode === undefined ? '' : `, Telegram ${result.telegramErrorCode}`;
  return `${result.method}: ошибка — ${one(result.err)}${cause}${telegram}`;
}

const PUBLISH_HINT = 'Публикация не удалась: после восстановления выполните bot-text publish.';

// After the commit, from the rows as they are now: whether every method was published.
async function publish(
  db: ReturnType<typeof createDb>,
  api: BotProfileApi,
  methods: readonly BotProfileMethod[],
  io: BotTextIo,
): Promise<boolean> {
  let results: BotProfileMethodResult[];
  try {
    results = await publishBotProfile(api, await readBotProfileSource(db), methods);
  } catch (error) {
    io.err(`Не удалось прочитать тексты для публикации: ${formatFailure(error)}.`);
    io.err(PUBLISH_HINT);
    return false;
  }
  for (const result of results) io.out(publishLine(result));
  const published = results.every((result) => result.ok);
  if (!published) io.err(PUBLISH_HINT);
  return published;
}

export interface BotTextCliDeps {
  createApi(options: CreateBotProfileApiOptions): BotProfileApi;
}

export async function runBotTextCli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  io: BotTextIo,
  deps: BotTextCliDeps = { createApi: createBotProfileApi },
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseBotTextArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return EXIT_USAGE;
  }
  let fileText = '';
  if (parsed.command === 'set') {
    try {
      fileText = decodeBotTextFile(
        await (parsed.file === '-'
          ? io.readStdin(FILE_MAX_BYTES + 1)
          : io.readFile(parsed.file, FILE_MAX_BYTES + 1)),
      );
    } catch (error) {
      io.err(
        error instanceof BotTextFileError
          ? error.message
          : `Не удалось прочитать файл: ${formatFailure(error)}.`,
      );
      return EXIT_FAILED;
    }
  }

  // a `commands`/`profile` key, or publish: the token is read before anything is written, so a
  // run that could not publish writes nothing either
  const methods: readonly BotProfileMethod[] =
    parsed.command === 'publish'
      ? BOT_PROFILE_METHODS
      : (parsed.command === 'set' || parsed.command === 'reset') && isBotTextKey(parsed.key)
        ? botProfileMethodsOf(parsed.key)
        : [];
  let databaseUrl: string;
  let token = '';
  try {
    databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
    if (methods.length > 0) {
      token = parseNoWhitespaceEnv(readEnv(source, 'TELEGRAM_BOT_TOKEN'), 'TELEGRAM_BOT_TOKEN');
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDb(pool);
  const actor = { type: AuditActorType.System, staffId: null };
  // awaited where it is returned: `finally` ends the pool, and the publish reads through it
  const publishAfter = async (code: number, written: boolean): Promise<number> => {
    if (written && methods.length > 0) await publish(db, deps.createApi({ token }), methods, io);
    // saved is saved, whatever Telegram answered (#240, В6)
    return code;
  };
  try {
    switch (parsed.command) {
      case 'list':
        list(await listBotTextOverrides(db), io);
        return EXIT_OK;
      case 'show':
        show(parsed.key as BotTextKey, await listBotTextOverrides(db), io);
        return EXIT_OK;
      case 'publish':
        return (await publish(db, deps.createApi({ token }), methods, io)) ? EXIT_OK : EXIT_FAILED;
      case 'set': {
        const result = await saveBotTextOverride(db, {
          key: parsed.key,
          source: fileText,
          expectedVersion: parsed.version,
          actor,
        });
        return await publishAfter(report(parsed.key, result, io, fileText), result.ok);
      }
      case 'reset': {
        const result = await resetBotTextOverride(db, {
          key: parsed.key,
          expectedVersion: parsed.version,
          actor,
        });
        return await publishAfter(report(parsed.key, result, io), result.ok);
      }
    }
  } catch (error) {
    // as kill-switch: a commit whose acknowledgement was lost leaves the state unknown
    io.err(
      parsed.command === 'list' || parsed.command === 'show' || parsed.command === 'publish'
        ? `Не удалось прочитать тексты: ${formatFailure(error)}.`
        : `Не удалось выполнить команду: ${formatFailure(error)}. Состояние могло измениться — проверьте командой show.`,
    );
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const code = await runBotTextCli(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readFile: readAtMost,
    readStdin: (maxBytes) => streamAtMost(process.stdin, maxBytes),
  });
  process.exit(code);
}
