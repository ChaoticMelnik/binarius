import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { composeServiceEnvValue, composeServiceValue } from '@binarius/shared/testing';
import { runMigrateCli } from './cli/migrate';
import {
  assertJournalOrder,
  judgeMigrations,
  MigrationJournalError,
  readMigrationJournal,
  type JournalEntry,
} from './migrate';

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  'utf8',
);

const entries: JournalEntry[] = [
  { tag: '0000_a', when: 100 },
  { tag: '0001_b', when: 200 },
  { tag: '0002_c', when: 300 },
];

describe('judgeMigrations', () => {
  it('an empty database is behind by every entry, in journal order', () => {
    expect(judgeMigrations(entries, undefined)).toEqual({
      kind: 'behind',
      pending: ['0000_a', '0001_b', '0002_c'],
    });
  });

  it('a partly migrated database is behind by the suffix after its last applied entry', () => {
    expect(judgeMigrations(entries, 100)).toEqual({
      kind: 'behind',
      pending: ['0001_b', '0002_c'],
    });
  });

  it('the last entry applied is current', () => {
    expect(judgeMigrations(entries, 300)).toEqual({
      kind: 'current',
      applied: 3,
      last: '0002_c',
      lastApplied: 300,
    });
  });

  it('a row newer than the journal is ahead', () => {
    expect(judgeMigrations(entries, 301)).toEqual({
      kind: 'ahead',
      lastApplied: 301,
      lastKnown: '0002_c',
      lastKnownWhen: 300,
    });
  });
});

describe('the migration journal', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'binarius-journal-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const journalIn = (name: string, list: unknown): string => {
    const folder = path.join(scratch, name);
    mkdirSync(path.join(folder, 'meta'), { recursive: true });
    writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ entries: list }));
    return folder;
  };

  it('the real journal is in order and every tag has its SQL file', () => {
    const real = readMigrationJournal();
    expect(real.length).toBeGreaterThan(0);
    for (const { tag } of real) expect(existsSync(path.join(drizzleDir, `${tag}.sql`))).toBe(true);
  });

  it('refuses an entry that is not later than the one before it', () => {
    const folder = journalIn('out-of-order', [
      { tag: '0000_a', when: 200 },
      { tag: '0001_b', when: 100 },
    ]);
    expect(() => readMigrationJournal(folder)).toThrow(
      new MigrationJournalError(
        'the migration journal is out of order: 0001_b is not later than 0000_a',
      ),
    );
  });

  it('refuses two entries with the same when', () => {
    expect(() =>
      assertJournalOrder([
        { tag: '0000_a', when: 100 },
        { tag: '0001_b', when: 100 },
      ]),
    ).toThrow(MigrationJournalError);
  });

  it('refuses an empty journal', () => {
    expect(() => readMigrationJournal(journalIn('empty', []))).toThrow(
      new MigrationJournalError('the migration journal is empty'),
    );
  });
});

describe('runMigrateCli before any connection', () => {
  it('names the missing variable and exits 1', async () => {
    const lines: string[] = [];
    expect(await runMigrateCli({}, (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual(['migration failed: Missing required env DATABASE_URL']);
  });
});

describe('the compose migrate service', () => {
  it('never restarts, runs the runner and reads the apps’ DATABASE_URL', () => {
    expect(composeServiceValue(composeYaml, 'migrate', 'restart')).toBe('"no"');
    expect(composeServiceValue(composeYaml, 'migrate', 'command')).toBe('pnpm db:migrate');
    expect(composeServiceEnvValue(composeYaml, 'migrate', 'DATABASE_URL')).toBe('*database-url');
  });
});
