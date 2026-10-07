import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOT_TEXT_CATALOG } from '@binarius/shared';
import { auditLog, botTextOverrides } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import {
  decodeBotTextFile,
  parseBotTextArgs,
  readAtMost,
  runBotTextCli,
  streamAtMost,
} from './bot-text';

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

async function run(argv: string[], files: Record<string, Uint8Array> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBotTextCli(
    argv,
    { DATABASE_URL: tmp.url },
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      readFile: (path) =>
        files[path] === undefined
          ? Promise.reject(new Error('ENOENT'))
          : Promise.resolve(files[path]),
      readStdin: () => Promise.resolve(files['-'] ?? new Uint8Array()),
    },
  );
  return { code, out, err };
}

describe('parseBotTextArgs', () => {
  it.each([
    [['set', 'welcome'], 'нужен --file'],
    [['set', 'welcome', '--file', 'a', '--version', 'abc'], '--version'],
    [['show', 'welcome', 'extra'], 'лишние аргументы'],
    [['set', 'renamedKey', '--file', 'a'], 'неизвестный ключ'],
    [['set', 'startCommand', '--file', 'a'], '#301'],
    [['reset', 'profileDescription'], '#301'],
    [['list', 'welcome'], 'list'],
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

  it('answers a usage error with exit 2 and the usage', async () => {
    const { code, err } = await run(['set', 'startCommand', '--file', 'a']);
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
    expect(out.find((line) => line.startsWith('startCommand'))).toContain('только чтение до #301');
  });

  it('L2 shows the text alone on stdout and the rest on stderr', async () => {
    const { code, out, err } = await run(['show', 'welcome']);
    expect(code).toBe(0);
    expect(out).toEqual([BOT_TEXT_CATALOG.welcome.source]);
    expect(err[1]).toBe('исходный, версия 0');
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
    ['Привет, {name}', 'Неизвестный плейсхолдер {name}'],
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
