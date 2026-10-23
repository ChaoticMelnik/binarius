import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, sessionSettings, type TempDatabase } from './testing';

// #719: 0078 drops trading_sessions.last_signal_action (the pause's memory, #379...#698) and its
// CHECK. The database is migrated to 0077 from a copy of the folder whose journal stops there,
// seeded with raw SQL at 0077's columns, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0078_drop_last_signal_action';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

interface SessionRow {
  id: string;
  status: string;
  start_signal_action: string | null;
  settings: unknown;
}

const rowsOf = async (pool: TempDatabase['pool']) =>
  (
    await pool.query<SessionRow>(
      'select id, status, start_signal_action, settings from trading_sessions order by id',
    )
  ).rows;

let partial: string;
let db: TempDatabase;
let before: SessionRow[];

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0078-'));
  await cp(drizzleDir, partial, { recursive: true });
  const journalPath = path.join(partial, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === FIRST_NEW);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journalPath, JSON.stringify(journal));
  db = await createTempDatabase(baseUrl, (pool) =>
    migrate(createDb(pool), { migrationsFolder: partial }),
  );

  // one active session per account
  let telegramUserId = 910_000;
  const session = async (lastSignalAction: string | null, startSignalAction: string | null) => {
    const [user] = (
      await db.pool.query<{ id: string }>(
        'insert into users (telegram_user_id, token_balance) values ($1, 10) returning id',
        [++telegramUserId],
      )
    ).rows;
    const [account] = (
      await db.pool.query<{ id: string }>(
        `insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
           token_key_id, access_token_expires_at, status)
         values ($1, $2, $3, $3, 'k1', now() + interval '1 hour', 'active') returning id`,
        [user!.id, `broker-${String(telegramUserId)}`, Buffer.from('enc')],
      )
    ).rows;
    await db.pool.query(
      `insert into trading_sessions (broker_account_id, mode, settings, last_signal_action,
         start_signal_action)
       values ($1, 'demo', $2, $3, $4)`,
      [account!.id, JSON.stringify(sessionSettings()), lastSignalAction, startSignalAction],
    );
  };
  await session('up', 'up');
  await session('down', null);
  await session(null, null);
  before = await rowsOf(db.pool);

  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
  await rm(partial, { recursive: true, force: true });
});

describe('migration 0078', () => {
  it('D1 keeps every session row and its other columns', async () => {
    expect(before).toHaveLength(3);
    expect(before.map((row) => row.start_signal_action).sort()).toEqual(['up', null, null].sort());
    expect(await rowsOf(db.pool)).toEqual(before);
  });

  it('D2 drops last_signal_action and its CHECK; start_signal_action and its CHECK stay', async () => {
    const { rows: columns } = await db.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'trading_sessions'
         and column_name in ('last_signal_action', 'start_signal_action')`,
    );
    expect(columns.map((row) => row.column_name)).toEqual(['start_signal_action']);
    const { rows: constraints } = await db.pool.query<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid = 'trading_sessions'::regclass
         and conname in ('trading_sessions_last_signal_action_check',
                         'trading_sessions_start_signal_action_check')`,
    );
    expect(constraints.map((row) => row.conname)).toEqual([
      'trading_sessions_start_signal_action_check',
    ]);
  });
});
