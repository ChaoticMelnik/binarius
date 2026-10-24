import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #634: 0083 gives bot_text_overrides a language and moves the primary key to (language, key).
// Its SQL is edited by hand (drizzle-kit cannot name the old key), so it is run on rows written
// before it: the database is migrated to 0082 from a copy of the folder whose journal stops
// there, seeded, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0083_bot_text_overrides_language';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let db: TempDatabase;

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0083-'));
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

const constraintOf = (statement: string, values: unknown[] = []) =>
  db.pool.query(statement, values).then(
    () => undefined,
    (error: unknown) => {
      const { code, constraint } = error as { code?: string; constraint?: string };
      return { code, constraint };
    },
  );

describe('migration 0083', () => {
  it('BL1 makes the rows before it Russian, as they were; BL2-BL4 the new key and CHECK stand', async () => {
    await db.pool.query(
      "insert into bot_text_overrides (key, source) values ('welcome', 'Привет'), ('zzz', 'x')",
    );
    const before = await db.pool.query<{ key: string; version: string; updated_at: string }>(
      'select key, version::text, updated_at::text from bot_text_overrides order by key',
    );

    await runMigrations(db.pool);

    const after = await db.pool.query<{
      language: string;
      key: string;
      version: string;
      updated_at: string;
    }>(
      'select language, key, version::text, updated_at::text from bot_text_overrides order by key',
    );
    expect(after.rows).toEqual(before.rows.map((row) => ({ language: 'ru', ...row })));

    // BL2: the key in the other language is another row; twice in one language is not
    await db.pool.query(
      "insert into bot_text_overrides (language, key, source) values ('en', 'welcome', 'Hello')",
    );
    expect(
      await constraintOf(
        "insert into bot_text_overrides (language, key, source) values ('ru', 'welcome', 'Ещё')",
      ),
    ).toEqual({ code: '23505', constraint: 'bot_text_overrides_pkey' });
    // BL3: a language outside BotLanguage
    expect(
      await constraintOf(
        "insert into bot_text_overrides (language, key, source) values ('de', 'welcome', 'Hallo')",
      ),
    ).toEqual({ code: '23514', constraint: 'bot_text_overrides_language_check' });
    // BL4: the key stays NOT NULL once it is no longer the whole primary key
    expect(
      await constraintOf(
        "insert into bot_text_overrides (language, key, source) values ('en', null, 'x')",
      ),
    ).toMatchObject({ code: '23502' });
  });
});
