import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, AuditAction, staff, verifyPassword } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { runStaffCli } from './staff';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for apps/backend integration tests (see README)');
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

/** Runs the CLI the way the container does, against this file's own database. */
async function run(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runStaffCli(argv, { DATABASE_URL: tmp.url }, (line) => lines.push(line));
  return { code, lines };
}

const PASSWORD_LINE = /^Пароль: [A-HJ-NP-Za-km-z2-9]{24}$/;

const staffRow = async (login: string) => {
  const [row] = await tmp.db.select().from(staff).where(eq(staff.login, login));
  return row;
};

describe('staff create', () => {
  it('prints the account and the password once, and records the creation', async () => {
    const { code, lines } = await run('create', '--login', 'ada', '--telegram-id', '42');

    expect(code).toBe(0);
    // exactly two lines: a third would mean something else reached a terminal that scrolls
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Создана учётная запись ada');
    expect(lines[1]).toMatch(PASSWORD_LINE);

    const row = await staffRow('ada');
    expect(row?.telegramUserId).toBe(42n);
    // the password is printed, never stored: the row holds a hash it verifies against
    expect(row?.passwordHash).not.toContain(lines[1]?.slice('Пароль: '.length) ?? '');
    expect(await verifyPassword(row?.passwordHash ?? '', lines[1]?.slice('Пароль: '.length) ?? '')).toBe(
      true,
    );

    const entries = await tmp.db
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.entityId, row?.id ?? ''));
    expect(entries).toEqual([
      { action: AuditAction.StaffCreated, payload: expect.objectContaining({ via: 'cli' }) },
    ]);
  });

  // the password must not be printed before the row exists: a reader who saw it and then saw
  // the failure has no way to know which of the two happened
  it('says the login is taken and writes nothing on a duplicate', async () => {
    await run('create', '--login', 'taken', '--telegram-id', '77');

    const { code, lines } = await run('create', '--login', 'taken', '--telegram-id', '78');

    expect([code, lines]).toEqual([1, ['Такой логин или Telegram ID уже занят']]);
  });

  it('says the Telegram id is taken too', async () => {
    await run('create', '--login', 'first-owner', '--telegram-id', '4242');

    const { code, lines } = await run('create', '--login', 'second-owner', '--telegram-id', '4242');

    expect([code, lines]).toEqual([1, ['Такой логин или Telegram ID уже занят']]);
  });
});

describe('staff reset-password', () => {
  it('prints a new password the old one no longer opens', async () => {
    const created = await run('create', '--login', 'rotate-me', '--telegram-id', '91');
    const before = created.lines[1]?.slice('Пароль: '.length) ?? '';

    const { code, lines } = await run('reset-password', '--login', 'rotate-me');

    expect(code).toBe(0);
    expect(lines.at(-1)).toMatch(PASSWORD_LINE);
    const after = lines.at(-1)?.slice('Пароль: '.length) ?? '';
    expect(after).not.toBe(before);
    const row = await staffRow('rotate-me');
    expect(await verifyPassword(row?.passwordHash ?? '', after)).toBe(true);
    expect(await verifyPassword(row?.passwordHash ?? '', before)).toBe(false);
  });
});

describe('an account that is not there', () => {
  it.each([['disable'], ['reset-password']])('%s answers 1 and says so', async (command) => {
    const { code, lines } = await run(command, '--login', 'nobody-here');

    expect([code, lines]).toEqual([1, ['Учётная запись nobody-here не найдена']]);
  });
});

describe('staff disable', () => {
  it('reports what it closed and leaves the account disabled', async () => {
    await run('create', '--login', 'retiring', '--telegram-id', '55');

    const { code, lines } = await run('disable', '--login', 'retiring');

    expect(code).toBe(0);
    expect(lines).toEqual([
      'Отключена retiring: закрыто запросов на вход 0, отозвано сессий 0',
    ]);
    expect((await staffRow('retiring'))?.status).toBe('disabled');
  });
});

describe('a command that was not understood', () => {
  it.each([
    ['no command at all', []],
    ['an unknown command', ['promote', '--login', 'ada']],
    ['a login the column would refuse', ['create', '--login', 'ab', '--telegram-id', '1']],
    ['a create with no telegram id', ['create', '--login', 'ada']],
    ['a flag create does not take', ['disable', '--login', 'ada', '--telegram-id', '1']],
  ])('%s exits 2 with the usage', async (_label, argv) => {
    const { code, lines } = await run(...argv);

    expect(code).toBe(2);
    expect(lines.at(-1)).toContain('staff create --login');
    // the reason first, then the usage: a bare usage block does not say what was wrong
    expect(lines).toHaveLength(2);
  });

  it('touches no database when it did not understand the command', async () => {
    const lines: string[] = [];
    // no DATABASE_URL at all: reaching the pool would throw `Missing required env DATABASE_URL`
    const code = await runStaffCli(['nonsense'], {}, (line) => lines.push(line));

    expect(code).toBe(2);
  });
});
