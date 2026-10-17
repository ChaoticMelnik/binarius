import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { staff, StaffStatus, verifyPassword } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { runStaffCli } from './staff';

// The real operations under a wrapper that can fail on demand. `after` is a commit whose answer
// was lost: the operation resolves, then the caller sees the error pg raises when the connection
// drops (no SQLSTATE, no cause). A file of its own, because vi.mock replaces the module for the
// whole file's graph; @binarius/db/testing imports the operations by relative path, so the
// fixtures below run unwrapped.
const failure = vi.hoisted(() => ({
  mode: undefined as undefined | 'after' | 'hashPassword' | 'generatePassword',
}));
vi.mock('@binarius/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@binarius/db')>();
  const lost =
    <A extends unknown[], R>(operation: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const result = await operation(...args);
      if (failure.mode === 'after') throw new Error('Connection terminated unexpectedly');
      return result;
    };
  return {
    ...actual,
    createStaffAccount: lost(actual.createStaffAccount),
    disableStaffAccount: lost(actual.disableStaffAccount),
    resetStaffPassword: lost(actual.resetStaffPassword),
    hashPassword: (...args: Parameters<typeof actual.hashPassword>) =>
      failure.mode === 'hashPassword'
        ? Promise.reject(new Error('scrypt failed'))
        : actual.hashPassword(...args),
    generatePassword: () => {
      if (failure.mode === 'generatePassword') throw new Error('entropy');
      return actual.generatePassword();
    },
  };
});

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
afterEach(() => {
  failure.mode = undefined;
});

async function run(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runStaffCli(argv, { DATABASE_URL: tmp.url }, (line) => lines.push(line));
  return { code, lines };
}

const PASSWORD_LINE = /^Пароль: [A-HJ-NP-Za-km-z2-9]{24}$/;
const passwordOf = (line: string | undefined) => line?.slice('Пароль: '.length) ?? '';
const LOST = 'Ответ потерян, но запрошенное состояние достигнуто: Error';
const REFUSED = 'Команда не выполнена: Error';

const staffRow = async (login: string) => {
  const [row] = await tmp.db.select().from(staff).where(eq(staff.login, login));
  return row;
};

async function created(login: string, telegramId: string): Promise<string> {
  const { code, lines } = await run('create', '--login', login, '--telegram-id', telegramId);
  if (code !== 0) throw new Error(`create ${login}: ${lines.join(' / ')}`);
  return passwordOf(lines[1]);
}

describe('a commit whose answer was lost', () => {
  it('create prints the account and its password after all, and exits 0', async () => {
    failure.mode = 'after';
    const { code, lines } = await run('create', '--login', 'la-create', '--telegram-id', '701');

    expect(code).toBe(0);
    expect(lines).toEqual([LOST, 'Создана учётная запись la-create', expect.any(String)]);
    expect(lines[2]).toMatch(PASSWORD_LINE);
    expect(
      await verifyPassword((await staffRow('la-create'))?.passwordHash ?? '', passwordOf(lines[2])),
    ).toBe(true);
  });

  it('reset-password prints the new password with the counts unknown, and exits 0', async () => {
    const before = await created('la-reset', '702');
    failure.mode = 'after';

    const { code, lines } = await run('reset-password', '--login', 'la-reset');

    expect(code).toBe(0);
    expect(lines).toEqual([
      LOST,
      'Пароль la-reset сброшен: число закрытых запросов, ссылок и отозванных сессий неизвестно',
      expect.any(String),
    ]);
    expect(lines[2]).toMatch(PASSWORD_LINE);
    const hash = (await staffRow('la-reset'))?.passwordHash ?? '';
    expect(await verifyPassword(hash, passwordOf(lines[2]))).toBe(true);
    expect(await verifyPassword(hash, before)).toBe(false);
  });

  it('disable reports the state it found with the counts unknown, and exits 0', async () => {
    await created('la-disable', '703');
    failure.mode = 'after';

    expect(await run('disable', '--login', 'la-disable')).toEqual({
      code: 0,
      lines: [
        LOST,
        'Отключена la-disable: число закрытых запросов, ссылок и отозванных сессий неизвестно',
      ],
    });
    expect((await staffRow('la-disable'))?.status).toBe(StaffStatus.Disabled);
  });
});

describe('a password that could not be made', () => {
  it('a hash that failed: create answers 1 and writes no row', async () => {
    failure.mode = 'hashPassword';
    expect(await run('create', '--login', 'no-hash', '--telegram-id', '704')).toEqual({
      code: 1,
      lines: [REFUSED],
    });
    expect(await staffRow('no-hash')).toBeUndefined();
  });

  it('a hash that failed: reset-password answers 1 and the old password still opens', async () => {
    const before = await created('no-hash-reset', '705');
    failure.mode = 'hashPassword';

    expect(await run('reset-password', '--login', 'no-hash-reset')).toEqual({
      code: 1,
      lines: [REFUSED],
    });
    expect(
      await verifyPassword((await staffRow('no-hash-reset'))?.passwordHash ?? '', before),
    ).toBe(true);
  });

  it.each([
    ['create', ['create', '--login', 'no-entropy', '--telegram-id', '706']],
    ['reset-password', ['reset-password', '--login', 'no-entropy']],
  ])('a generator that threw: %s answers 1 and writes nothing', async (_label, argv) => {
    failure.mode = 'generatePassword';
    expect(await run(...argv)).toEqual({ code: 1, lines: [REFUSED] });
    expect(await staffRow('no-entropy')).toBeUndefined();
  });
});
