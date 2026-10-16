import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #116: 0060 adds token_ledger.referral_id and re-adds both ledger CHECKs, validated, over the
// rows already there. A database is migrated to the migration before it from a copy of the folder
// whose journal stops there, seeded with the rows that exist in production (starter packs under
// link_bonus v1, a referral), then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '_referral_reward';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let database: TempDatabase;
beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-referral-reward-'));
  await cp(drizzleDir, partial, { recursive: true });
  const journalPath = path.join(partial, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  // by suffix, so a renumbering on rebase does not break the cut
  const cut = journal.entries.findIndex((entry) => entry.tag.endsWith(FIRST_NEW));
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journalPath, JSON.stringify(journal));
  database = await createTempDatabase(baseUrl, (pool) =>
    migrate(createDb(pool), { migrationsFolder: partial }),
  );
});
afterAll(async () => {
  await database.drop();
  await rm(partial, { recursive: true, force: true });
});

describe('migration 0060', () => {
  it('passes over existing starter packs and referrals, and leaves both CHECKs validated', async () => {
    const { pool } = database;
    const { rows: hasColumn } = await pool.query(
      `select 1 from information_schema.columns
         where table_name = 'token_ledger' and column_name = 'referral_id'`,
    );
    expect(hasColumn).toEqual([]);

    // SQL, not drizzle: the drizzle schema is already the new shape
    const { rows: people } = await pool.query<{ id: string }>(
      `insert into users (telegram_user_id) values (720001), (720002) returning id`,
    );
    const [inviter, invitee] = people.map((row) => row.id);
    await pool.query(`insert into referrals (invitee_user_id, inviter_user_id) values ($1, $2)`, [
      invitee,
      inviter,
    ]);
    const { rows: account } = await pool.query<{ id: string }>(
      `insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
         token_key_id, access_token_expires_at)
       values ($1, 'migration-referral-1', '\\x00', '\\x00', 'k1', now() + interval '1 hour')
       returning id`,
      [invitee],
    );
    await pool.query(
      `insert into token_ledger (user_id, kind, balance_delta, broker_account_id, bonus_rule_id, bonus_rule_kind)
       select $1, 'bonus', 100, $2, id, kind from bonus_rules where code = 'link_bonus' and version = 1`,
      [invitee, account[0]!.id],
    );

    await runMigrations(pool);

    const { rows: checks } = await pool.query<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint
         where conname in ('token_ledger_reference_check', 'token_ledger_bonus_rule_check')
         order by conname`,
    );
    expect(checks).toEqual([
      { conname: 'token_ledger_bonus_rule_check', convalidated: true },
      { conname: 'token_ledger_reference_check', convalidated: true },
    ]);
    const { rows: pack } = await pool.query(
      `select referral_id from token_ledger where user_id = $1`,
      [invitee],
    );
    expect(pack).toEqual([{ referral_id: null }]);
  });
});
