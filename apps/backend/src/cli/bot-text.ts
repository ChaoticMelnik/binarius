import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  BOT_TEXT_CATALOG,
  BOT_TEXT_GROUP_TITLES,
  BOT_TEXT_SOURCE_MAX,
  BOT_TEXTS_APPLIED_WITHIN_S,
  DATABASE_URL_RULES,
  botTextRejectionMessage,
  isBotTextKey,
  isBotTextWritable,
  parseUrlEnv,
  readEnv,
  resolveBotTextOverrides,
  type BotTextKey,
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

--version — версия из show: при несовпадении сохранение отклоняется.`;

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
  | { command: 'list' }
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
  if (command === 'list') {
    if (key !== undefined || values.file !== undefined || version !== undefined) {
      throw new UsageError('list не принимает аргументов');
    }
    return { command };
  }
  if (command !== 'show' && command !== 'set' && command !== 'reset') {
    throw new UsageError(command === undefined ? 'нет команды' : `неизвестная команда: ${command}`);
  }
  if (key === undefined) throw new UsageError('нет ключа');
  // reset takes a key the catalog no longer has, so its row can be removed
  if (!isBotTextKey(key) && command !== 'reset') throw new UsageError(`неизвестный ключ: ${key}`);
  if (isBotTextKey(key) && command !== 'show' && !isBotTextWritable(key)) {
    throw new UsageError(`${key}: команды и профиль правятся после #301`);
  }
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
    const readOnly = isBotTextWritable(key) ? '' : ' (только чтение до #301)';
    io.out(`${key}\t${BOT_TEXT_CATALOG[key].group}\t${stamp(byKey.get(key))}${readOnly}`);
  }
  for (const [key, rejection] of rejected) {
    io.out(`${key}: не действует — ${botTextRejectionMessage(rejection, key)}`);
  }
}

function show(key: BotTextKey, rows: BotTextOverrideRecord[], io: BotTextIo): void {
  const entry = BOT_TEXT_CATALOG[key];
  const row = rows.find((r) => r.key === key);
  const resolved = resolveBotTextOverrides(rows);
  const rejection = resolved.rejected.get(key);
  io.err(`${key} · ${BOT_TEXT_GROUP_TITLES[entry.group]} · ${entry.description}`);
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

export async function runBotTextCli(
  argv: readonly string[],
  source: NodeJS.ProcessEnv,
  io: BotTextIo,
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

  let databaseUrl: string;
  try {
    databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDb(pool);
  const actor = { type: AuditActorType.System, staffId: null };
  try {
    switch (parsed.command) {
      case 'list':
        list(await listBotTextOverrides(db), io);
        return EXIT_OK;
      case 'show':
        show(parsed.key as BotTextKey, await listBotTextOverrides(db), io);
        return EXIT_OK;
      case 'set':
        return report(
          parsed.key,
          await saveBotTextOverride(db, {
            key: parsed.key,
            source: fileText,
            expectedVersion: parsed.version,
            actor,
          }),
          io,
          fileText,
        );
      case 'reset':
        return report(
          parsed.key,
          await resetBotTextOverride(db, {
            key: parsed.key,
            expectedVersion: parsed.version,
            actor,
          }),
          io,
        );
    }
  } catch (error) {
    // as kill-switch: a commit whose acknowledgement was lost leaves the state unknown
    io.err(
      parsed.command === 'list' || parsed.command === 'show'
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
