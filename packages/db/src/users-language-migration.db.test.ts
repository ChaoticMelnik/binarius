import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { botLanguageOf } from '@binarius/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #508: 0063 gives every existing user the language a first /start gives, from the language_code
// on file. The SQL spells botLanguageOf's rule with PostgreSQL's regex engine, so the two are
// compared row by row over one corpus: the database is migrated to 0062 from a copy of the folder
// whose journal stops there, seeded, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0063_users_language';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const CORPUS = [
  null,
  'ru',
  'RU',
  'ru-RU',
  'Ru-ru',
  'rus',
  'ruby',
  'en',
  'en-US',
  'uk',
  'be',
  'kk',
  'de-DE',
] as const;

let partial: string;
let db: TempDatabase;

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0063-'));
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

describe('migration 0063', () => {
  it('ML1 sets each existing user the language botLanguageOf gives its language_code; ML2 the CHECK stands after it', async () => {
    for (const [index, code] of CORPUS.entries()) {
      await db.pool.query('insert into users (telegram_user_id, language_code) values ($1, $2)', [
        String(1000 + index),
        code,
      ]);
    }

    await runMigrations(db.pool);

    const { rows } = await db.pool.query<{ language_code: string | null; language: string }>(
      'select language_code, language from users order by telegram_user_id',
    );
    expect(rows.map((row) => [row.language_code, row.language])).toEqual(
      CORPUS.map((code) => [code, botLanguageOf(code)]),
    );
    expect(rows.filter((row) => row.language === 'en')).toHaveLength(8);
    await expect(
      db.pool.query("update users set language = 'de' where telegram_user_id = 1000"),
    ).rejects.toMatchObject({ constraint: 'users_language_check' });
  });
});
