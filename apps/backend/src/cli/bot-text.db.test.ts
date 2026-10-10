import { sql } from 'drizzle-orm';
import { GrammyError } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOT_TEXT_CATALOG, type BotProfileMethod } from '@binarius/shared';
import { auditLog, botTextOverrides, listBotTextOverrides } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import {
  decodeBotTextFile,
  parseBotTextArgs,
  readAtMost,
  runBotTextCli,
  streamAtMost,
  type BotTextCliDeps,
} from './bot-text';
import type { BotProfileApi } from '../bot-texts/publish';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const utf8 = (value: string) => new TextEncoder().encode(value);

async function run(
  argv: string[],
  files: Record<string, Uint8Array> = {},
  env: NodeJS.ProcessEnv = { DATABASE_URL: tmp.url },
  deps?: BotTextCliDeps,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBotTextCli(
    argv,
    env,
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      readFile: (path) =>
        files[path] === undefined
          ? Promise.reject(new Error('ENOENT'))
          : Promise.resolve(files[path]),
      readStdin: () => Promise.resolve(files['-'] ?? new Uint8Array()),
    },
    deps,
  );
  return { code, out, err };
}

describe('parseBotTextArgs', () => {
  it.each([
    [['set', 'welcome'], 'нужен --file'],
    [['set', 'welcome', '--file', 'a', '--version', 'abc'], '--version'],
    [['show', 'welcome', 'extra'], 'лишние аргументы'],
    [['set', 'renamedKey', '--file', 'a'], 'неизвестный ключ'],
    [['list', 'welcome'], 'list'],
    [['publish', 'startCommand'], 'publish не принимает аргументов'],
    [['publish', '--version', '1'], 'publish не принимает аргументов'],
    [[], 'нет команды'],
  ])('P refuses %j', (argv, message) => {
    expect(() => parseBotTextArgs(argv)).toThrow(message);
  });

  it('P takes stdin, a version, and a reset of a key the catalog no longer has', () => {
    expect(parseBotTextArgs(['set', 'welcome', '--file', '-', '--version', '7'])).toEqual({
      command: 'set',
      key: 'welcome',
      file: '-',
      version: 7,
    });
    expect(parseBotTextArgs(['reset', 'renamedKey'])).toEqual({
      command: 'reset',
      key: 'renamedKey',
    });
  });

  it("P takes the commands' and the profile's keys, and publish (#301)", () => {
    expect(parseBotTextArgs(['set', 'startCommand', '--file', 'a'])).toEqual({
      command: 'set',
      key: 'startCommand',
      file: 'a',
    });
    expect(parseBotTextArgs(['reset', 'profileDescription'])).toEqual({
      command: 'reset',
      key: 'profileDescription',
    });
    expect(parseBotTextArgs(['publish'])).toEqual({ command: 'publish' });
  });

  it('answers a usage error with exit 2 and the usage', async () => {
    const { code, err } = await run(['set', 'welcome']);
    expect(code).toBe(2);
    expect(err[1]).toContain('bot-text list');
  });
});

describe('decodeBotTextFile', () => {
  it('drops a BOM, turns CRLF into LF and takes off one trailing newline', () => {
    expect(decodeBotTextFile(utf8('﻿a\r\nb\n\n'))).toBe('a\nb\n');
  });

  it('refuses a file that is not UTF-8 or is too large', () => {
    expect(() => decodeBotTextFile(new Uint8Array([0xc3, 0x28]))).toThrow('UTF-8');
    expect(() => decodeBotTextFile(new Uint8Array(4 * 16_384 + 1))).toThrow('байт');
  });
});

describe('reading at most one byte over the cap (#299 review)', () => {
  async function* endless() {
    for (;;) yield new Uint8Array(4096).fill(0x61);
  }
  const refused = async (
    io: { readFile?: typeof readAtMost; readStdin?: (max: number) => Promise<Uint8Array> },
    file: string,
  ) => {
    const err: string[] = [];
    const unused = () => Promise.reject(new Error('not used'));
    const code = await runBotTextCli(
      ['set', 'welcome', '--file', file],
      { DATABASE_URL: tmp.url },
      {
        out: () => undefined,
        err: (line) => err.push(line),
        readFile: io.readFile ?? unused,
        readStdin: io.readStdin ?? unused,
      },
    );
    return { code, err };
  };

  it('refuses a stdin that never ends', async () => {
    expect(await refused({ readStdin: (max) => streamAtMost(endless(), max) }, '-')).toEqual({
      code: 1,
      err: ['Файл больше 65536 байт.'],
    });
  });

  it('refuses /dev/zero', async () => {
    expect(await refused({ readFile: readAtMost }, '/dev/zero')).toEqual({
      code: 1,
      err: ['Файл больше 65536 байт.'],
    });
  });
});

// the cases run in order on one database
describe('bot-text on a database', () => {
  it('L1 lists every key as default on a fresh database', async () => {
    const { code, out } = await run(['list']);
    expect(code).toBe(0);
    expect(out).toHaveLength(Object.keys(BOT_TEXT_CATALOG).length);
    expect(out[0]).toBe('welcome\tstart\tисходный');
    expect(out.find((line) => line.startsWith('startCommand'))).toBe(
      'startCommand\tcommands\tисходный',
    );
  });

  it('L2 shows the text alone on stdout and the rest on stderr', async () => {
    const { code, out, err } = await run(['show', 'welcome']);
    expect(code).toBe(0);
    expect(out).toEqual([BOT_TEXT_CATALOG.welcome.source]);
    expect(err[1]).toBe('переменных нет; фрагменты: {connectButton}');
    expect(err[2]).toBe('исходный, версия 0');
  });

  // #358 K1: the key's variables with their descriptions and samples
  it('K1 lists the variables a text may hold', async () => {
    const { err } = await run(['show', 'codeSent']);
    expect(err[1]).toBe(
      'переменные: {email} — Адрес аккаунта Binodex; неизвестен — «адрес неизвестен» (образец: ada@example.com); {firstName} — Имя пользователя из Telegram (образец: Ада)',
    );
  });

  // K2: a variable the key does not have is refused by name, with the ones it has
  it('K2 refuses a variable the text may not hold', async () => {
    const { code, err } = await run(['set', 'codeSent', '--file', 'f'], {
      f: utf8('Код на {realBalance}'),
    });
    expect(code).toBe(1);
    expect(err).toEqual([
      'Переменная {realBalance} недоступна в этом тексте. Доступны: {email}, {firstName}',
    ]);
  });

  it('L3 saves from stdin and says when the bot applies it', async () => {
    const { code, out } = await run(['set', 'welcome', '--file', '-', '--version', '0'], {
      '-': utf8('Привет, <b>мир</b>\n'),
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Сохранено: welcome, версия \d+\. .* в течение 35 с\.$/);
    expect((await run(['show', 'welcome'])).out).toEqual(['Привет, <b>мир</b>']);
  });

  it('L4 refuses a stale version with the current one', async () => {
    const { code, err } = await run(['set', 'welcome', '--file', 'f', '--version', '999999'], {
      f: utf8('Другой'),
    });
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^Текст уже изменил другой сотрудник \(текущая версия \d+\)\.$/);
  });

  it('L5 reports an unchanged text with exit 0', async () => {
    expect(
      await run(['set', 'welcome', '--file', 'f'], { f: utf8('Привет, <b>мир</b>') }),
    ).toMatchObject({
      code: 0,
      out: ['Текст не изменился.'],
    });
  });

  it.each([
    ['<b>Привет', 'Битый HTML'],
    ['Привет, {name}', 'Переменная {name} недоступна в этом тексте'],
    ['я'.repeat(1025), 'символов при лимите 1024'],
  ])('L6 refuses %j, and the old text stays', async (text, message) => {
    const { code, err } = await run(['set', 'welcome', '--file', 'f'], { f: utf8(text) });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(message);
    expect((await run(['show', 'welcome'])).out).toEqual(['Привет, <b>мир</b>']);
  });

  it('L7 names the host a fragment breaks and the message a text overflows', async () => {
    const fragment = await run(['set', 'featureLines', '--file', 'f'], {
      f: utf8('я'.repeat(950)),
    });
    expect(fragment.err[0]).toMatch(/^Ломает текст-хозяин cardBody: /);
    const extra = `\n${'я'.repeat(250)}`;
    await run(['set', 'cardBody', '--file', 'f'], {
      f: utf8(BOT_TEXT_CATALOG.cardBody.source + extra),
    });
    const bonus = await run(['set', 'cardBonusAlready', '--file', 'f'], {
      f: utf8(BOT_TEXT_CATALOG.cardBonusAlready.source + extra),
    });
    expect(bonus.code).toBe(1);
    expect(bonus.err[0]).toMatch(
      /^Сообщение «Карточка аккаунта» станет \d+ символов при лимите 1024$/,
    );
    expect(bonus.err[1]).toMatch(/^cardBody: Сообщение «Карточка аккаунта»/);
  });

  it('L8 lists an override the loaders reject with the reason', async () => {
    await tmp.db.insert(botTextOverrides).values({ key: 'renamedKey', source: 'x' });
    const { out } = await run(['list']);
    expect(out.find((line) => line.startsWith('welcome'))).toMatch(
      /^welcome\tstart\tизменён, версия \d+, /,
    );
    expect(out.at(-1)).toBe('renamedKey: не действует — Неизвестный ключ — игнорируется');
  });

  it('L9 resets to the default, then reports it is the default already', async () => {
    expect((await run(['reset', 'welcome'])).out[0]).toMatch(/^Сброшено: welcome\./);
    expect(await run(['reset', 'welcome'])).toMatchObject({
      code: 0,
      out: ['Уже исходный текст.'],
    });
    expect((await run(['reset', 'renamedKey'])).code).toBe(0);
  });

  it('L10 writes one audit row per save and reset, with both texts', async () => {
    const rows = await tmp.db
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(sql`${auditLog.action} like 'bot_text_%'`)
      .orderBy(auditLog.createdAt);
    expect(rows.map((row) => [row.action, row.payload.key])).toEqual([
      ['bot_text_saved', 'welcome'],
      ['bot_text_saved', 'cardBody'],
      ['bot_text_reset', 'welcome'],
      ['bot_text_reset', 'renamedKey'],
    ]);
    expect(rows[2]?.payload).toMatchObject({
      oldText: 'Привет, <b>мир</b>',
      newText: BOT_TEXT_CATALOG.welcome.source,
    });
  });

  it('reports a database failure without claiming nothing changed', async () => {
    const err: string[] = [];
    const unused = () => Promise.reject(new Error('not used'));
    const code = await runBotTextCli(
      ['reset', 'welcome'],
      { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
      { out: () => undefined, err: (line) => err.push(line), readFile: unused, readStdin: unused },
    );
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^Не удалось выполнить команду: .*проверьте командой show\.$/);
  });
});

// A fake of the three Bot API methods: what each call carried, and the failure to throw for one.
function fakeProfileApi(fail: Partial<Record<BotProfileMethod, unknown>> = {}) {
  const calls: { method: BotProfileMethod; args: unknown[] }[] = [];
  const created: { token: string }[] = [];
  const call =
    (method: BotProfileMethod) =>
    (...args: unknown[]): Promise<true> => {
      calls.push({ method, args });
      return method in fail ? Promise.reject(fail[method]) : Promise.resolve(true);
    };
  const api = {
    setMyCommands: call('setMyCommands'),
    setMyDescription: call('setMyDescription'),
    setMyShortDescription: call('setMyShortDescription'),
  } as unknown as BotProfileApi;
  const deps: BotTextCliDeps = {
    createApi: (options) => {
      created.push({ token: options.token });
      return api;
    },
  };
  return { calls, created, deps };
}

const refusal = (method: string, code: number) =>
  new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: code, description: 'Bad Request: secret description' },
    method,
    {},
  );

const DEFAULT_MENU = [
  { command: 'start', description: 'Начать' },
  { command: 'menu', description: 'Главное меню' },
  { command: 'stop', description: 'Остановить сессию' },
  { command: 'account', description: 'Аккаунт Binodex' },
  { command: 'settings', description: 'Настройки уведомлений' },
  { command: 'help', description: 'Помощь' },
  { command: 'support', description: 'Поддержка' },
];
const SCOPE = { scope: { type: 'all_private_chats' } };
const TOKEN = '123456:AA-cli-publish-token';
const HINT = 'Публикация не удалась: после восстановления выполните bot-text publish.';

describe('bot-text publishing the menu and the profile (#301)', () => {
  const withToken = () => ({ DATABASE_URL: tmp.url, TELEGRAM_BOT_TOKEN: TOKEN });
  beforeEach(async () => {
    await tmp.db.delete(botTextOverrides);
  });

  it('L11 saves a command description and publishes the menu with it, and only the menu', async () => {
    const fake = fakeProfileApi();
    const { code, out, err } = await run(
      ['set', 'startCommand', '--file', 'f'],
      { f: utf8('Поехали') },
      withToken(),
      fake.deps,
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toMatch(/^Сохранено: startCommand, версия \d+\./);
    expect(out.slice(1)).toEqual(['setMyCommands: опубликовано']);
    expect(fake.created).toEqual([{ token: TOKEN }]);
    expect(fake.calls).toEqual([
      {
        method: 'setMyCommands',
        args: [[{ command: 'start', description: 'Поехали' }, ...DEFAULT_MENU.slice(1)], SCOPE],
      },
    ]);
  });

  it('L12 keeps the save when Telegram refuses, exits 0 and says how to publish again', async () => {
    const fake = fakeProfileApi({ setMyCommands: refusal('setMyCommands', 400) });
    const { code, out, err } = await run(
      ['set', 'menuCommand', '--file', 'f'],
      { f: utf8('Меню') },
      withToken(),
      fake.deps,
    );
    expect(code).toBe(0);
    expect(out.slice(1)).toEqual(['setMyCommands: ошибка — GrammyError, Telegram 400']);
    expect(err).toEqual([HINT]);
    expect(JSON.stringify({ out, err })).not.toContain('secret');
    expect(await listBotTextOverrides(tmp.db)).toMatchObject([
      { key: 'menuCommand', source: 'Меню' },
    ]);
  });

  it('L13 resets the short description and publishes the default', async () => {
    await tmp.db.insert(botTextOverrides).values({ key: 'profileShortDescription', source: 'x' });
    const fake = fakeProfileApi();
    const { code, out } = await run(
      ['reset', 'profileShortDescription'],
      {},
      withToken(),
      fake.deps,
    );
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Сброшено: profileShortDescription\./);
    expect(out.slice(1)).toEqual(['setMyShortDescription: опубликовано']);
    expect(fake.calls).toEqual([
      {
        method: 'setMyShortDescription',
        args: [BOT_TEXT_CATALOG.profileShortDescription.source],
      },
    ]);
  });

  it('L14 publishes all three from the rows, and exits 1 when one fails', async () => {
    await tmp.db.insert(botTextOverrides).values({ key: 'profileDescription', source: 'Описание' });
    const ok = fakeProfileApi();
    expect(await run(['publish'], {}, withToken(), ok.deps)).toEqual({
      code: 0,
      out: [
        'setMyCommands: опубликовано',
        'setMyDescription: опубликовано',
        'setMyShortDescription: опубликовано',
      ],
      err: [],
    });
    expect(ok.calls).toEqual([
      { method: 'setMyCommands', args: [DEFAULT_MENU, SCOPE] },
      { method: 'setMyDescription', args: ['Описание'] },
      { method: 'setMyShortDescription', args: [BOT_TEXT_CATALOG.profileShortDescription.source] },
    ]);

    const failing = fakeProfileApi({ setMyDescription: refusal('setMyDescription', 400) });
    expect(await run(['publish'], {}, withToken(), failing.deps)).toEqual({
      code: 1,
      out: [
        'setMyCommands: опубликовано',
        'setMyDescription: ошибка — GrammyError, Telegram 400',
        'setMyShortDescription: опубликовано',
      ],
      err: [HINT],
    });
  });

  it('L15 refuses a command description without the token before writing anything', async () => {
    const fake = fakeProfileApi();
    const { code, err } = await run(
      ['set', 'startCommand', '--file', 'f'],
      { f: utf8('Поехали') },
      { DATABASE_URL: tmp.url },
      fake.deps,
    );
    expect(code).toBe(1);
    expect(err).toEqual(['Missing required env TELEGRAM_BOT_TOKEN']);
    expect(await listBotTextOverrides(tmp.db)).toEqual([]);
    expect(fake.created).toEqual([]);
  });

  it('L16 saves any other key with no token and publishes nothing', async () => {
    const fake = fakeProfileApi();
    const { code, out } = await run(
      ['set', 'welcome', '--file', 'f'],
      { f: utf8('Привет') },
      { DATABASE_URL: tmp.url },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(fake.created).toEqual([]);
    // the reset of a key the catalog no longer has publishes nothing either
    await tmp.db.insert(botTextOverrides).values({ key: 'renamedKey', source: 'x' });
    const orphan = await run(['reset', 'renamedKey'], {}, { DATABASE_URL: tmp.url }, fake.deps);
    expect(orphan.code).toBe(0);
    expect(fake.created).toEqual([]);
  });

  it('L17 publishes nothing when nothing was written', async () => {
    await tmp.db.insert(botTextOverrides).values({ key: 'startCommand', source: 'Поехали' });
    const fake = fakeProfileApi();
    const files = { f: utf8('Поехали') };
    expect(
      await run(['set', 'startCommand', '--file', 'f'], files, withToken(), fake.deps),
    ).toEqual({ code: 0, out: ['Текст не изменился.'], err: [] });
    expect(await run(['reset', 'profileDescription'], {}, withToken(), fake.deps)).toEqual({
      code: 0,
      out: ['Уже исходный текст.'],
      err: [],
    });
    expect(fake.calls).toEqual([]);
  });
});
