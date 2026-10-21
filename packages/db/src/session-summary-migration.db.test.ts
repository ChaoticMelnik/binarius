import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import {
  createTempDatabase,
  seedTradingSession,
  seedUserWithAccount,
  type TempDatabase,
} from './testing';

// #537: 0072 closes the summary step of every session whose text summary the backend sent before
// the deploy (final_notice_sent_at set, summary_sent_at NULL), so the fallback sender does not send
// it twice, and adds the fallback list's partial index. The database is migrated to 0071 from a copy
// of the folder whose journal stops there, seeded, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0072_session_summary_fallback';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let db: TempDatabase;

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0072-'));
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

const marksOf = async (id: string) => {
  const { rows } = await db.pool.query<{ final: string | null; summary: string | null }>(
    'select final_notice_sent_at::text as final, summary_sent_at::text as summary from trading_sessions where id = $1',
    [id],
  );
  return rows[0];
};

describe('migration 0072', () => {
  it('B1 closes the summary step of a session whose text summary was sent; B2 leaves the rest; B3 adds the index', async () => {
    // one active session per account
    const session = async () =>
      seedTradingSession(
        db.db,
        (await seedUserWithAccount(db.db, { balance: 10n })).brokerAccountId,
      );
    const sent = await session();
    const both = await session();
    const open = await session();
    await db.pool.query(
      `update trading_sessions set final_notice_sent_at = now() - interval '1 hour' where id = $1`,
      [sent.id],
    );
    await db.pool.query(
      `update trading_sessions set final_notice_sent_at = now() - interval '2 hours', summary_sent_at = now() - interval '1 hour' where id = $1`,
      [both.id],
    );
    const before = { both: await marksOf(both.id), open: await marksOf(open.id) };

    await runMigrations(db.pool);

    const closed = await marksOf(sent.id);
    expect(closed?.final).not.toBeNull();
    expect(closed?.summary).toBe(closed?.final);
    expect(await marksOf(both.id)).toEqual(before.both);
    expect(await marksOf(open.id)).toEqual({ final: null, summary: null });

    const { rows } = await db.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'trading_sessions_summary_fallback_idx'`,
    );
    expect(rows.map((row) => row.indexdef)).toEqual([
      'CREATE INDEX trading_sessions_summary_fallback_idx ON public.trading_sessions USING btree (final_notice_sent_at) WHERE ((final_notice_sent_at IS NOT NULL) AND (summary_sent_at IS NULL))',
    ]);
  });
});
