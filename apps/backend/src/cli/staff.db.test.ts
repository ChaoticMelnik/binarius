import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditAction } from '@binarius/shared';
import {
  auditLog,
  completeLogin,
  confirmChallengeFromTelegram,
  markChallengeCodeSent,
  staff,
  StaffStatus,
  startLoginChallenge,
  verifyPassword,
} from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { runStaffCli } from './staff';

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

/** One open challenge and two live sessions: the two numbers the summary lines print differ. */
async function issueUnder(login: string, telegramUserId: bigint): Promise<void> {
  const row = await staffRow(login);
  if (row === undefined) throw new Error(`no staff ${login}`);
  const client = { ip: '203.0.113.7', userAgent: 'ua' };
  const open = () =>
    startLoginChallenge(tmp.db, { staffId: row.id, passwordHash: row.passwordHash, ...client });
  for (let session = 0; session < 2; session += 1) {
    const started = await open();
    if (!started.ok) throw new Error('unreachable');
    const confirmed = await confirmChallengeFromTelegram(tmp.db, {
      challengeId: started.challengeId,
      telegramUserId,
    });
    if (confirmed === undefined) throw new Error('unreachable');
    await markChallengeCodeSent(tmp.db, started.challengeId, confirmed.code);
    const done = await completeLogin(tmp.db, {
      challengeId: started.challengeId,
      code: confirmed.code,
      ...client,
    });
    if (!done.ok) throw new Error('unreachable');
  }
  if (!(await open()).ok) throw new Error('unreachable');
}

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
    expect(
      await verifyPassword(row?.passwordHash ?? '', lines[1]?.slice('Пароль: '.length) ?? ''),
    ).toBe(true);

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

  // the boundary is the receive path's, not bigint's: ctx.from.id arrives as a JSON-parsed
  // number, so an account past it would get its invitation and never match on confirmation
  it('accepts the largest id the receive path can match', async () => {
    const { code } = await run('create', '--login', 'edge', '--telegram-id', '9007199254740991');

    expect(code).toBe(0);
    expect((await staffRow('edge'))?.telegramUserId).toBe(9007199254740991n);
  });
});

describe('staff reset-password', () => {
  it('prints a new password the old one no longer opens', async () => {
    const created = await run('create', '--login', 'rotate-me', '--telegram-id', '91');
    const before = created.lines[1]?.slice('Пароль: '.length) ?? '';
    await issueUnder('rotate-me', 91n);

    const { code, lines } = await run('reset-password', '--login', 'rotate-me');

    expect(code).toBe(0);
    expect(lines.at(-1)).toMatch(PASSWORD_LINE);
    expect(lines[0]).toBe(
      'Пароль rotate-me сброшен: закрыто запросов на вход 1, ссылок 0, отозвано сессий 2',
    );
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
    await issueUnder('retiring', 55n);

    const { code, lines } = await run('disable', '--login', 'retiring');

    expect(code).toBe(0);
    expect(lines).toEqual([
      'Отключена retiring: закрыто запросов на вход 1, ссылок 0, отозвано сессий 2',
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
    [
      'a telegram id the receive path could not match',
      ['create', '--login', 'ada', '--telegram-id', '9007199254740992'],
    ],
    [
      'a telegram id bigint would overflow',
      ['create', '--login', 'ada', '--telegram-id', '9999999999999999999'],
    ],
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

// The CLI's one door after the arguments (#150): every database failure is a line and exit 1,
// never an unhandled rejection, and never the driver's message, which carries the query with its
// parameters, the password hash among them.
describe('a database that refuses the command', () => {
  let storedHash: string;
  let oldPassword: string;
  beforeAll(async () => {
    const created = await run('create', '--login', 'refused', '--telegram-id', '601');
    oldPassword = created.lines[1]?.slice('Пароль: '.length) ?? '';
    storedHash = (await staffRow('refused'))?.passwordHash ?? '';
    await tmp.db.execute(
      sql.raw(`create function staff_refuse() returns trigger language plpgsql as $$
        begin raise exception 'refused' using errcode = 'P0001'; end $$`),
    );
    await tmp.db.execute(
      sql.raw(
        'create trigger staff_refuse before insert or update on staff for each row execute function staff_refuse()',
      ),
    );
  });
  afterAll(async () => {
    await tmp.db.execute(sql.raw('drop trigger staff_refuse on staff'));
    await tmp.db.execute(sql.raw('drop function staff_refuse()'));
  });

  const refusedLine = 'Команда не выполнена: Error (error P0001)';
  const noDriverText = (lines: string[]) => {
    const all = lines.join('\n');
    for (const leak of ['Failed query', 'insert into', 'params:', 'ln=', storedHash]) {
      expect(all).not.toContain(leak);
    }
  };

  it('create answers 1, writes no row and prints no driver text', async () => {
    const { code, lines } = await run('create', '--login', 'never-made', '--telegram-id', '602');

    expect([code, lines]).toEqual([1, [refusedLine]]);
    expect(await staffRow('never-made')).toBeUndefined();
    noDriverText(lines);
  });

  it('disable answers 1 and the account stays active', async () => {
    const { code, lines } = await run('disable', '--login', 'refused');

    expect([code, lines]).toEqual([1, [refusedLine]]);
    expect((await staffRow('refused'))?.status).toBe(StaffStatus.Active);
    noDriverText(lines);
  });

  it('reset-password answers 1 and the old password still opens the hash', async () => {
    const { code, lines } = await run('reset-password', '--login', 'refused');

    expect([code, lines]).toEqual([1, [refusedLine]]);
    expect(await verifyPassword((await staffRow('refused'))?.passwordHash ?? '', oldPassword)).toBe(
      true,
    );
    noDriverText(lines);
  });
});

describe('a database without the staff table', () => {
  beforeAll(() => tmp.db.execute(sql.raw('alter table staff rename to staff_absent')));
  afterAll(() => tmp.db.execute(sql.raw('alter table staff_absent rename to staff')));

  it.each([
    [['create', '--login', 'unmigrated', '--telegram-id', '603']],
    [['disable', '--login', 'unmigrated']],
  ])('%j says the database is not migrated', async (argv) => {
    expect(await run(...argv)).toEqual({
      code: 1,
      lines: [
        'Команда не выполнена: Error (error 42P01)',
        'База данных не мигрирована: выполните pnpm db:migrate',
      ],
    });
  });
});

describe('a database that does not exist', () => {
  it('says the result is unknown and how to find out', async () => {
    const url = new URL(tmp.url);
    url.pathname = '/binarius_absent_150';
    const lines: string[] = [];
    const code = await runStaffCli(
      ['disable', '--login', 'anyone'],
      { DATABASE_URL: url.href },
      (line) => lines.push(line),
    );

    expect([code, lines]).toEqual([
      1,
      ['Результат неизвестен: error 3D000', 'Проверьте учётную запись и повторите команду'],
    ]);
  });
});

describe('an environment the CLI cannot start from', () => {
  it.each([
    [{}, 'Команда не выполнена: Missing required env DATABASE_URL'],
    [
      { DATABASE_URL: 'mysql://u:SECRET@h/d' },
      'Команда не выполнена: Env DATABASE_URL must use one of: postgres: postgresql:',
    ],
  ])('%j answers 1 with the variable, never its value', async (source, line) => {
    const lines: string[] = [];
    const code = await runStaffCli(['disable', '--login', 'anyone'], source, (printed) =>
      lines.push(printed),
    );

    expect([code, lines]).toEqual([1, [line]]);
    expect(lines.join('\n')).not.toContain('SECRET');
  });
});

// Today no unique index on staff is reachable from disable; the index here makes one so the
// "taken" answer is shown to belong to create alone.
describe('a unique violation outside create', () => {
  beforeAll(async () => {
    await run('create', '--login', 'uv-one', '--telegram-id', '604');
    await run('create', '--login', 'uv-two', '--telegram-id', '605');
    await tmp.db.execute(
      sql.raw(
        `create unique index staff_one_disabled_idx on staff (status) where status = '${StaffStatus.Disabled}' and login in ('uv-one', 'uv-two')`,
      ),
    );
  });
  afterAll(() => tmp.db.execute(sql.raw('drop index staff_one_disabled_idx')));

  it('disable answers 1 with the error, not «taken», and leaves the account active', async () => {
    expect((await run('disable', '--login', 'uv-one')).code).toBe(0);

    const { code, lines } = await run('disable', '--login', 'uv-two');

    expect([code, lines]).toEqual([1, ['Команда не выполнена: Error (error 23505)']]);
    expect((await staffRow('uv-two'))?.status).toBe(StaffStatus.Active);
  });
});
