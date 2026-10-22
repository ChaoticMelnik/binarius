import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #686: 0075 closes every deposit already there as `predates`, attributed or not, so the switch to
// real after a deposit follows only deposits from the deploy on; 0076 opens the kind's planning
// from that moment. The database is migrated to 0074 from a copy of the folder whose journal stops
// there, seeded, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0075_deposit_mode_switch';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let db: TempDatabase;

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0075-'));
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
});
afterAll(async () => {
  await db.drop();
  await rm(partial, { recursive: true, force: true });
});

const outcomeOf = async (id: string) => {
  const { rows } = await db.pool.query<{ outcome: string | null; at: boolean }>(
    'select mode_switch as outcome, mode_switch_at is not null as at from deposit_events where id = $1',
    [id],
  );
  return rows[0];
};

describe('migrations 0075 and 0076', () => {
  it('B1 closes the deposits before 0075 as predates; B2 a later one waits; B3 the index and checks; B4 the kind opens', async () => {
    // raw SQL at 0074's columns, so a later migration's column does not reach this database
    // through the schema
    const [user] = (
      await db.pool.query<{ id: string }>(
        'insert into users (telegram_user_id, token_balance) values (910001, 10) returning id',
      )
    ).rows;
    const [account] = (
      await db.pool.query<{ id: string }>(
        `insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
           token_key_id, access_token_expires_at, status)
         values ($1, 'trader-0075', $2, $2, 'k1', now() + interval '1 hour', 'active') returning id`,
        [user!.id, Buffer.from('enc')],
      )
    ).rows;
    const deposit = async (paymentId: string, attributed: boolean) =>
      (
        await db.pool.query<{ id: string }>(
          `insert into deposit_events (user_id, broker_account_id, source, broker_user_id,
             payment_id, amount)
           values ($1, $2, 'binodex', $3, $4, 10) returning id`,
          attributed
            ? [user!.id, account!.id, 'trader-0075', paymentId]
            : [null, null, 'trader-free-0075', paymentId],
        )
      ).rows[0]!.id;
    const attributed = await deposit('pay-0075-a', true);
    const unattributed = await deposit('pay-0075-u', false);

    await runMigrations(db.pool);

    expect(await outcomeOf(attributed)).toEqual({ outcome: 'predates', at: true });
    expect(await outcomeOf(unattributed)).toEqual({ outcome: 'predates', at: true });

    const later = await deposit('pay-0075-later', true);
    expect(await outcomeOf(later)).toEqual({ outcome: null, at: false });

    const { rows: indexes } = await db.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'deposit_events_mode_switch_pending_idx'`,
    );
    expect(indexes.map((row) => row.indexdef)).toEqual([
      'CREATE INDEX deposit_events_mode_switch_pending_idx ON public.deposit_events USING btree (created_at) WHERE ((user_id IS NOT NULL) AND (mode_switch IS NULL))',
    ]);
    const { rows: checks } = await db.pool.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'deposit_events'::regclass and conname like 'deposit_events_mode_switch%'
        order by conname`,
    );
    expect(checks.map((row) => row.conname)).toEqual([
      'deposit_events_mode_switch_check',
      'deposit_events_mode_switch_pair_check',
    ]);

    const { rows: kinds } = await db.pool.query<{ opened: boolean }>(
      `select plans_from <= now() as opened from notification_kinds where kind = 'real_mode_by_deposit'`,
    );
    expect(kinds).toEqual([{ opened: true }]);
  });
});
