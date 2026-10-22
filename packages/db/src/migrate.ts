import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { errorLogFields } from '@binarius/shared';
import { createDb } from './client';

// resolved from the package root so it works from src/ (tsx) and dist/ (tsc -b) alike
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(createDb(pool), { migrationsFolder });
}

// Advisory locks are per database, so the temporary databases of parallel test files never
// contend for it. Above 2^32 on purpose: pg_locks then shows it split into classid/objid.
export const MIGRATIONS_ADVISORY_LOCK_KEY = 7_500_075_001;

export class MigrationJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationJournalError';
  }
}

export interface JournalEntry {
  tag: string;
  when: number;
}

// drizzle's migrator applies only the entries whose `when` is later than the last applied row,
// so an entry dated earlier than one already applied would be skipped forever, silently.
export function assertJournalOrder(entries: readonly JournalEntry[]): void {
  if (entries.length === 0) throw new MigrationJournalError('the migration journal is empty');
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1] as JournalEntry;
    const entry = entries[index] as JournalEntry;
    if (!(entry.when > previous.when)) {
      throw new MigrationJournalError(
        `the migration journal is out of order: ${entry.tag} is not later than ${previous.tag}`,
      );
    }
  }
}

export function readMigrationJournal(folder: string = migrationsFolder): JournalEntry[] {
  const raw: unknown = JSON.parse(readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8'));
  const list = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) {
    throw new MigrationJournalError('the migration journal has no entries list');
  }
  const entries = list.map((item: unknown): JournalEntry => {
    const { tag, when } = (item ?? {}) as { tag?: unknown; when?: unknown };
    if (typeof tag !== 'string' || typeof when !== 'number' || !Number.isSafeInteger(when)) {
      throw new MigrationJournalError('the migration journal has an entry without a tag or when');
    }
    return { tag, when };
  });
  assertJournalOrder(entries);
  return entries;
}

export type MigrationStatus =
  | { kind: 'behind'; pending: string[] }
  | { kind: 'current'; applied: number; last: string; lastApplied: number }
  | { kind: 'ahead'; lastApplied: number; lastKnown: string; lastKnownWhen: number };

// lastApplied is the newest created_at in drizzle.__drizzle_migrations, which the migrator
// compares with `when` exactly like this
export function judgeMigrations(
  entries: readonly JournalEntry[],
  lastApplied: number | undefined,
): MigrationStatus {
  const lastKnown = entries.at(-1);
  if (lastKnown === undefined) throw new MigrationJournalError('the migration journal is empty');
  if (lastApplied === undefined || lastApplied < lastKnown.when) {
    return {
      kind: 'behind',
      pending: entries
        .filter((entry) => lastApplied === undefined || entry.when > lastApplied)
        .map((entry) => entry.tag),
    };
  }
  if (lastApplied === lastKnown.when) {
    return { kind: 'current', applied: entries.length, last: lastKnown.tag, lastApplied };
  }
  return { kind: 'ahead', lastApplied, lastKnown: lastKnown.tag, lastKnownWhen: lastKnown.when };
}

// Two statements: a subquery on a missing table fails at parse time (42P01) even inside a CASE.
export async function migrationStatus(
  pool: Pool,
  entries: readonly JournalEntry[] = readMigrationJournal(),
): Promise<MigrationStatus> {
  const table = await pool.query<{ table: string | null }>(
    `select to_regclass('drizzle.__drizzle_migrations')::text as table`,
  );
  if (table.rows[0]?.table == null) return judgeMigrations(entries, undefined);
  // pg returns int8 as a string; drizzle's migrator does the same Number() on it
  const result = await pool.query<{ last: string | null }>(
    'select max(created_at)::text as last from drizzle.__drizzle_migrations',
  );
  const raw = result.rows[0]?.last ?? null;
  if (raw === null) return judgeMigrations(entries, undefined);
  const lastApplied = Number(raw);
  if (!Number.isSafeInteger(lastApplied)) {
    throw new MigrationJournalError(
      'drizzle.__drizzle_migrations: created_at is not a safe integer',
    );
  }
  return judgeMigrations(entries, lastApplied);
}

export interface StartupLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

// false means the process must not start: a schema behind the image fails its queries at run
// time, and an unreadable status says nothing. A schema ahead is the owner's accepted risk.
export async function checkSchemaAtStartup(pool: Pool, logger: StartupLogger): Promise<boolean> {
  let status: MigrationStatus;
  try {
    status = await migrationStatus(pool);
  } catch (error) {
    logger.error(errorLogFields(error), 'database schema check failed');
    return false;
  }
  if (status.kind === 'behind') {
    logger.error(
      { pending: status.pending },
      'database schema is behind this image, run the migrations first',
    );
    return false;
  }
  if (status.kind === 'ahead') {
    logger.warn(
      {
        lastApplied: status.lastApplied,
        lastKnown: status.lastKnown,
        lastKnownWhen: status.lastKnownWhen,
      },
      'database schema is ahead of this image',
    );
    return true;
  }
  logger.info({ applied: status.applied, last: status.last }, 'database schema is current');
  return true;
}
