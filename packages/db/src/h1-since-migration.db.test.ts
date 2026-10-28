import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #830: 0085 drops broker_accounts.h1_since (the H1 mark, #670...#828). The database is migrated
// to 0084 from a copy of the folder whose journal stops there, seeded with raw SQL at 0084's
// columns, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0085_drop_h1_since';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

interface AccountRow {
  id: string;
  user_id: string;
  broker_user_id: string;
  status: string;
  service_since: Date | null;
}

const rowsOf = async (pool: TempDatabase['pool']) =>
  (
    await pool.query<AccountRow>(
      'select id, user_id, broker_user_id, status, service_since from broker_accounts order by id',
    )
  ).rows;

let partial: string;
let db: TempDatabase;
let before: AccountRow[];

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0085-'));
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

  let telegramUserId = 930_000;
  const account = async (h1Since: string | null, serviceSince: string | null) => {
    const [user] = (
      await db.pool.query<{ id: string }>(
        'insert into users (telegram_user_id, token_balance) values ($1, 10) returning id',
        [++telegramUserId],
      )
    ).rows;
    await db.pool.query(
      `insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
         token_key_id, access_token_expires_at, status, h1_since, service_since)
       values ($1, $2, $3, $3, 'k1', now() + interval '1 hour', 'active', $4, $5)`,
      [user!.id, `broker-${String(telegramUserId)}`, Buffer.from('enc'), h1Since, serviceSince],
    );
  };
  await account('2026-10-20T10:00:00Z', '2026-10-21T10:00:00Z');
  await account(null, null);
  before = await rowsOf(db.pool);

  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
  await rm(partial, { recursive: true, force: true });
});

describe('migration 0085', () => {
  it('D1 keeps every account row and its other columns', async () => {
    expect(before).toHaveLength(2);
    expect(before.filter((row) => row.service_since !== null)).toHaveLength(1);
    expect(await rowsOf(db.pool)).toEqual(before);
  });

  it('D2 drops h1_since; service_since stays', async () => {
    const { rows: columns } = await db.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'broker_accounts' and column_name in ('h1_since', 'service_since')
       order by column_name`,
    );
    expect(columns.map((row) => row.column_name)).toEqual(['service_since']);
  });
});
