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

// #118: 0048 backfills star_payments.payer_telegram_user_id from each payment's stars_purchased /
// stars_payment_held audit row, then makes it NOT NULL. The database is migrated to 0047 from a
// copy of the folder whose journal stops there, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0048_stars_refunds';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let tmp: TempDatabase;
beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0048-'));
  await cp(drizzleDir, partial, { recursive: true });
  const journalPath = path.join(partial, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === FIRST_NEW);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journalPath, JSON.stringify(journal));
  tmp = await createTempDatabase(baseUrl, (pool) =>
    migrate(createDb(pool), { migrationsFolder: partial }),
  );
});
afterAll(async () => {
  await tmp.drop();
  await rm(partial, { recursive: true, force: true });
});

const columnExists = async (table: string, column: string) => {
  const { rows } = await tmp.pool.query(
    'select 1 from information_schema.columns where table_name = $1 and column_name = $2',
    [table, column],
  );
  return rows.length === 1;
};
const messages = (error: unknown): string => {
  const parts: string[] = [];
  for (let e = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    parts.push(e.message);
  }
  return parts.join(' | ');
};

// SQL, not drizzle: the drizzle schema is already the new shape
async function payment(userId: string, charge: string, status: 'paid' | 'held'): Promise<string> {
  const { rows } = await tmp.pool.query<{ id: string }>(
    `insert into star_payments (user_id, telegram_payment_charge_id, package_code, currency,
       total_amount, tokens, status, paid_at)
     values ($1, $2, 'p50', 'XTR', 100, 50, $3, now()) returning id`,
    [userId, charge, status],
  );
  return rows[0]!.id;
}
const audit = (paymentId: string, action: string, actorId: string) =>
  tmp.pool.query(
    `insert into audit_log (actor_type, actor_id, action, entity_type, entity_id)
     values ('user', $1, $2, 'star_payment', $3)`,
    [actorId, action, paymentId],
  );

let userId: string;
let orphan: string;

describe('migration 0048', () => {
  it('M2 fails on a payment with no audit row and leaves the schema as it was', async () => {
    const { rows } = await tmp.pool.query<{ id: string }>(
      `insert into users (telegram_user_id) values (700001) returning id`,
    );
    userId = rows[0]!.id;
    orphan = await payment(userId, 'charge-orphan', 'paid');

    // its own pool, ended here, as in postbacks-migration.db.test.ts
    const failing = new Pool({ connectionString: tmp.url, max: 1 });
    const error = await runMigrations(failing).then(
      () => undefined,
      (e: unknown) => e,
    );
    await failing.end();

    expect(messages(error)).toContain('payer_telegram_user_id');
    expect(await columnExists('star_payments', 'payer_telegram_user_id')).toBe(false);
  });

  it('M1 backfills the payer from the audit row of a paid and of a held payment', async () => {
    await audit(orphan, 'stars_purchased', '700001');
    const held = await payment(userId, 'charge-held', 'held');
    await audit(held, 'stars_payment_held', '700002');
    // another entity's row with the same id is not this payment's
    await tmp.pool.query(
      `insert into audit_log (actor_type, actor_id, action, entity_type, entity_id)
       values ('user', '1', 'user_viewed', 'user', $1)`,
      [held],
    );

    await runMigrations(tmp.pool);

    const { rows } = await tmp.pool.query<{ id: string; payer: string }>(
      `select id, payer_telegram_user_id::text as payer from star_payments order by id`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.payer]))).toEqual({
      [orphan]: '700001',
      [held]: '700002',
    });
  });
});
