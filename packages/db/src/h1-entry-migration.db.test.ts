import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #836: 0086 adds trade_intents.submit_not_before_at and its CHECK against the deadline. The
// database is migrated to 0085 from a copy of the folder whose journal stops there, seeded with
// an intent at 0085's columns, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0086_h1_entry_not_before';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let db: TempDatabase;
let account: { userId: string; accountId: string };
let telegramUserId = 940_000;

const seedAccount = async (pool: TempDatabase['pool']) => {
  const [user] = (
    await pool.query<{ id: string }>(
      'insert into users (telegram_user_id, token_balance) values ($1, 10) returning id',
      [++telegramUserId],
    )
  ).rows;
  const [row] = (
    await pool.query<{ id: string }>(
      `insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
         token_key_id, access_token_expires_at, status)
       values ($1, $2, $3, $3, 'k1', now() + interval '1 hour', 'active') returning id`,
      [user!.id, `broker-${String(telegramUserId)}`, Buffer.from('enc')],
    )
  ).rows;
  return { userId: user!.id, accountId: row!.id };
};

const insertIntent = (
  pool: TempDatabase['pool'],
  seed: { userId: string; accountId: string },
  columns: Record<string, string>,
) => {
  const names = Object.keys(columns);
  return pool.query(
    `insert into trade_intents (broker_account_id, user_id, mode, asset_id, amount, action,
       duration_sec, client_request_id, tokens_reserved, status${names.map((n) => `, ${n}`).join('')})
     values ($1, $2, 'demo', 91, 10, 'up', 5, $3, 0, 'rejected'${names.map((_n, i) => `, $${String(i + 4)}`).join('')})`,
    [seed.accountId, seed.userId, `r-${String(++telegramUserId)}`, ...Object.values(columns)],
  );
};

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0086-'));
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
  account = await seedAccount(db.pool);
  await insertIntent(db.pool, account, { submit_deadline_at: '2026-10-29T06:00:00.700Z' });

  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
  await rm(partial, { recursive: true, force: true });
});

describe('migration 0086', () => {
  it('E1 keeps an earlier intent with a NULL hold', async () => {
    const { rows } = await db.pool.query<{ submit_not_before_at: Date | null }>(
      'select submit_not_before_at from trade_intents',
    );
    expect(rows).toEqual([{ submit_not_before_at: null }]);
  });

  it('E1 accepts a hold before its deadline', async () => {
    await expect(
      insertIntent(db.pool, account, {
        submit_not_before_at: '2026-10-29T06:00:01.000Z',
        submit_deadline_at: '2026-10-29T06:00:01.700Z',
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['equal to', '2026-10-29T06:00:01.000Z'],
    ['after', '2026-10-29T06:00:00.900Z'],
  ])('E1 refuses a hold %s its deadline', async (_name, deadline) => {
    await expect(
      insertIntent(db.pool, account, {
        submit_not_before_at: '2026-10-29T06:00:01.000Z',
        submit_deadline_at: deadline,
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'trade_intents_submit_window_check' });
  });
});
