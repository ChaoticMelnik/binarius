import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #13: 0059 versions bonus_rules, seeds link_bonus v1, and binds the starter packs already in the
// ledger to it — the one sanctioned bypass of token_ledger_append_only, inside the migration's
// transaction. Each database is migrated to the migration before 0059 from a copy of the folder
// whose journal stops there, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '_bonus_rules';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
const databases: TempDatabase[] = [];
beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-bonus-rules-'));
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
});
afterAll(async () => {
  for (const database of databases) await database.drop();
  await rm(partial, { recursive: true, force: true });
});

async function beforeBonusRules(): Promise<TempDatabase> {
  const database = await createTempDatabase(baseUrl!, (pool) =>
    migrate(createDb(pool), { migrationsFolder: partial }),
  );
  databases.push(database);
  return database;
}

const messages = (error: unknown): string => {
  const parts: string[] = [];
  for (let e = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    parts.push(e.message);
  }
  return parts.join(' | ');
};

// its own pool, ended here, as in stars-refunds-migration.db.test.ts
async function migrationError(url: string): Promise<unknown> {
  const failing = new Pool({ connectionString: url, max: 1 });
  const error = await runMigrations(failing).then(
    () => undefined,
    (e: unknown) => e,
  );
  await failing.end();
  return error;
}

const hasVersionColumn = async (pool: Pool) =>
  (
    await pool.query(
      `select 1 from information_schema.columns where table_name = 'bonus_rules' and column_name = 'version'`,
    )
  ).rows.length === 1;

// SQL, not drizzle: the drizzle schema is already the new shape
async function userWithAccount(pool: Pool, n: number) {
  const { rows: user } = await pool.query<{ id: string }>(
    `insert into users (telegram_user_id) values ($1) returning id`,
    [710_000 + n],
  );
  const { rows: account } = await pool.query<{ id: string }>(
    `insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
       token_key_id, access_token_expires_at)
     values ($1, $2, '\\x00', '\\x00', 'k1', now() + interval '1 hour') returning id`,
    [user[0]!.id, `migration-broker-${n}`],
  );
  return { userId: user[0]!.id, accountId: account[0]!.id };
}

const pack = (pool: Pool, { userId, accountId }: { userId: string; accountId: string }) =>
  pool.query(
    `insert into token_ledger (user_id, kind, balance_delta, broker_account_id, note)
     values ($1, 'bonus', 100, $2, 'link_bonus')`,
    [userId, accountId],
  );

describe('migration 0059', () => {
  it('fails on a bonus_rules row it would have to guess a version for, leaving the schema as it was', async () => {
    const database = await beforeBonusRules();
    await database.pool.query(`insert into bonus_rules (code, kind) values ('by-hand', 'k')`);

    const error = await migrationError(database.url);

    expect(messages(error)).toContain('bonus_rules is not empty');
    expect(await hasVersionColumn(database.pool)).toBe(false);
  });

  it('fails on a bonus that names no broker account, leaving the schema as it was', async () => {
    const database = await beforeBonusRules();
    const { userId } = await userWithAccount(database.pool, 1);
    await database.pool.query(
      `insert into token_ledger (user_id, kind, balance_delta) values ($1, 'bonus', 5)`,
      [userId],
    );

    const error = await migrationError(database.url);

    expect(messages(error)).toContain('a bonus row names no broker account');
    expect(await hasVersionColumn(database.pool)).toBe(false);
    const { rows } = await database.pool.query<{ tgenabled: string }>(
      `select tgenabled from pg_trigger where tgname = 'token_ledger_append_only'`,
    );
    expect(rows).toEqual([{ tgenabled: 'O' }]);
  });

  describe('on a ledger of starter packs', () => {
    let database: TempDatabase;
    let packs: { userId: string; accountId: string }[];
    beforeAll(async () => {
      database = await beforeBonusRules();
      packs = [await userWithAccount(database.pool, 2), await userWithAccount(database.pool, 3)];
      for (const owner of packs) await pack(database.pool, owner);
      // a row of another kind is left alone
      await database.pool.query(
        `insert into token_ledger (user_id, kind, balance_delta, note) values ($1, 'adjustment', 1, 'n')`,
        [packs[0]!.userId],
      );
      await runMigrations(database.pool);
    });

    it('binds every pack to link_bonus v1 and nothing else to a rule', async () => {
      const { rows } = await database.pool.query<{
        kind: string;
        version: number | null;
        rule_kind: string | null;
      }>(
        `select l.kind, r.version, l.bonus_rule_kind as rule_kind
           from token_ledger l left join bonus_rules r on r.id = l.bonus_rule_id
          order by l.kind, l.user_id`,
      );
      expect(rows).toEqual([
        { kind: 'adjustment', version: null, rule_kind: null },
        { kind: 'bonus', version: 1, rule_kind: 'link_bonus' },
        { kind: 'bonus', version: 1, rule_kind: 'link_bonus' },
      ]);
      const { rows: rules } = await database.pool.query<{ code: string; tokens: string }>(
        `select code, params->>'tokens' as tokens from bonus_rules where is_active order by code`,
      );
      expect(rules).toEqual([
        { code: 'link_bonus', tokens: '100' },
        { code: 'referral_reward', tokens: '50' },
      ]);
    });

    it('leaves both ledger triggers enabled, and the ledger refuses an UPDATE again', async () => {
      const { rows } = await database.pool.query<{ tgname: string; tgenabled: string }>(
        `select tgname, tgenabled from pg_trigger
          where tgrelid = 'token_ledger'::regclass and not tgisinternal order by tgname`,
      );
      expect(rows).toEqual([
        { tgname: 'token_ledger_append_only', tgenabled: 'O' },
        { tgname: 'token_ledger_no_truncate', tgenabled: 'O' },
      ]);
      const error = await database.pool
        .query(`update token_ledger set note = 'x' where kind = 'bonus'`)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toMatchObject({ code: 'P0001', message: 'token_ledger is append-only' });
    });
  });
});
