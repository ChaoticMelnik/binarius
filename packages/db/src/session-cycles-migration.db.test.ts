import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #552: 0056 rewrites the saved overrides of four session texts, {trades} to {cycles}, and in the
// two launch screens «перед каждой проверит» to «перед каждой сделкой проверит», in one UPDATE
// whose length guard is on the rewritten text. A key holds one row, so the boundary rows live in
// a second database; both are migrated to 0055 from a copy of the folder whose journal stops
// there, seeded, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0056_session_cycles_texts';
const LIMIT = 16_384;
const OLD_PHRASE = 'перед каждой проверит';
const NEW_PHRASE = 'перед каждой сделкой проверит';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
const databases: TempDatabase[] = [];
const migratedTo0055 = async () => {
  const db = await createTempDatabase(baseUrl, (pool) =>
    migrate(createDb(pool), { migrationsFolder: partial }),
  );
  databases.push(db);
  return db;
};

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0056-'));
  await cp(drizzleDir, partial, { recursive: true });
  const journalPath = path.join(partial, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === FIRST_NEW);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journalPath, JSON.stringify(journal));
});
afterAll(async () => {
  for (const db of databases) await db.drop();
  await rm(partial, { recursive: true, force: true });
});

const seed = async (db: TempDatabase, rows: Record<string, string>) => {
  for (const [key, source] of Object.entries(rows)) {
    await db.pool.query('insert into bot_text_overrides (key, source) values ($1, $2)', [
      key,
      source,
    ]);
  }
};
const rowsOf = async (db: TempDatabase) => {
  const { rows } = await db.pool.query<{ key: string; source: string; version: string }>(
    'select key, source, version from bot_text_overrides order by key',
  );
  return Object.fromEntries(rows.map((row) => [row.key, row]));
};

describe('migration 0056', () => {
  it('M1 rewrites {trades} to {cycles} in the four keys, and «перед каждой проверит» in the two launch screens; M3 leaves another key', async () => {
    const db = await migratedTo0055();
    await seed(db, {
      sessionStartButton: '🚀 Сессия из {trades}',
      intentSessionOffer: 'Сессия из {trades} на этой паре.',
      launchCycle: `Бот проведёт {trades} подряд и ${OLD_PHRASE} сигнал.`,
      launchCycleReal: `Бот проведёт {trades} подряд и ${OLD_PHRASE} сигнал. Реальные деньги.`,
      sessionCardFooter: '{trades} · {score}',
    });
    const before = await rowsOf(db);

    await runMigrations(db.pool);

    const after = await rowsOf(db);
    expect(after.sessionStartButton!.source).toBe('🚀 Сессия из {cycles}');
    expect(after.intentSessionOffer!.source).toBe('Сессия из {cycles} на этой паре.');
    expect(after.launchCycle!.source).toBe(`Бот проведёт {cycles} подряд и ${NEW_PHRASE} сигнал.`);
    expect(after.launchCycleReal!.source).toBe(
      `Бот проведёт {cycles} подряд и ${NEW_PHRASE} сигнал. Реальные деньги.`,
    );
    for (const key of Object.keys(before)) {
      expect(after[key]!.version, key).toBe(before[key]!.version);
    }
    expect(after.sessionCardFooter!.source).toBe('{trades} · {score}');
  });

  it('M2 the length guard is on the rewritten text: 16 384 after both replacements is rewritten, 16 385 stays as it was', async () => {
    const db = await migratedTo0055();
    const text = (length: number) => {
      const core = `{trades} ${OLD_PHRASE} `;
      return core + 'ж'.repeat(length - [...core].length);
    };
    const fits = text(LIMIT - (NEW_PHRASE.length - OLD_PHRASE.length));
    const over = text(LIMIT - (NEW_PHRASE.length - OLD_PHRASE.length) + 1);
    expect([[...fits].length, [...over].length]).toEqual([16_376, 16_377]);
    await seed(db, { launchCycle: fits, launchCycleReal: over });

    await runMigrations(db.pool);

    const after = await rowsOf(db);
    const rewritten = after.launchCycle!.source;
    expect([...rewritten].length).toBe(LIMIT);
    expect(rewritten.startsWith(`{cycles} ${NEW_PHRASE} `)).toBe(true);
    expect(after.launchCycleReal!.source).toBe(over);
  });
});
