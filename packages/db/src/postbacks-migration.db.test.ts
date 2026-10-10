import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// D11 (#141): 0044 starts with a guard that refuses a non-empty deposit_events, because its new
// NOT NULL columns have no defaults and two columns are dropped. The database is migrated to
// 0043 from a copy of the folder whose journal stops there, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0044_postbacks';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let tmp: TempDatabase;
beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0044-'));
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
const tableExists = async (table: string) => {
  const { rows } = await tmp.pool.query('select to_regclass($1) as oid', [table]);
  return (rows[0] as { oid: string | null }).oid !== null;
};
const messages = (error: unknown): string => {
  const parts: string[] = [];
  for (let e = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    parts.push(e.message);
  }
  return parts.join(' | ');
};

describe('migration 0044', () => {
  it('G1 refuses a non-empty deposit_events and leaves the schema as it was', async () => {
    // SQL, not drizzle: the drizzle schema is already the new shape
    await tmp.pool.query(
      `insert into deposit_events (postback_id, payload) values ('pb-local', '{}'::jsonb)`,
    );

    const error = await runMigrations(tmp.pool).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(messages(error)).toContain('deposit_events must be empty before 0044_postbacks');
    expect(await columnExists('deposit_events', 'postback_id')).toBe(true);
    expect(await tableExists('postback_deliveries')).toBe(false);
  });

  it('G2 runs on an empty deposit_events', async () => {
    await tmp.pool.query('delete from deposit_events');

    await runMigrations(tmp.pool);

    expect(await tableExists('postback_deliveries')).toBe(true);
    expect(await columnExists('deposit_events', 'postback_id')).toBe(false);
    expect(await columnExists('deposit_events', 'broker_user_id')).toBe(true);
  });
});
