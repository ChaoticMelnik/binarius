import { DrizzleQueryError } from 'drizzle-orm/errors';
import { Client, Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { until } from '@binarius/shared/testing';
import { runMigrateCli, type MigrateCliDeps } from './cli/migrate';
import {
  checkSchemaAtStartup,
  migrationStatus,
  MIGRATIONS_ADVISORY_LOCK_KEY,
  readMigrationJournal,
  runMigrations,
  type StartupLogger,
} from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const journal = readMigrationJournal();
const tags = journal.map((entry) => entry.tag);
const lastKnown = journal.at(-1) as { tag: string; when: number };
const appliedLine = `applied ${journal.length} migrations: ${tags.join(', ')}`;
const nothingLine = `nothing to apply: ${journal.length} migrations, last ${lastKnown.tag}`;
const UNREACHABLE = 'postgres://binarius@127.0.0.1:1/binarius';

const created: TempDatabase[] = [];
afterEach(async () => {
  for (const tmp of created.splice(0)) await tmp.drop();
});

async function emptyDatabase(): Promise<TempDatabase> {
  const tmp = await createTempDatabase(baseUrl as string, async () => {});
  created.push(tmp);
  return tmp;
}

async function run(url: string, deps?: MigrateCliDeps): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runMigrateCli({ DATABASE_URL: url }, (line) => lines.push(line), deps);
  return { code, lines };
}

async function appliedRows(pool: Pool): Promise<number[]> {
  const result = await pool.query<{ created_at: string }>(
    'select created_at::text from drizzle.__drizzle_migrations order by id',
  );
  return result.rows.map((row) => Number(row.created_at));
}

interface RecordingLogger extends StartupLogger {
  calls: { level: 'info' | 'warn' | 'error'; object: object; message: string }[];
}

function recordingLogger(): RecordingLogger {
  const calls: RecordingLogger['calls'] = [];
  return {
    calls,
    info: (object, message) => calls.push({ level: 'info', object, message }),
    warn: (object, message) => calls.push({ level: 'warn', object, message }),
    error: (object, message) => calls.push({ level: 'error', object, message }),
  };
}

function queryError(code: string): DrizzleQueryError {
  const cause = Object.assign(new Error('from the server'), { name: 'error', code });
  return new DrizzleQueryError('select 1', [], cause);
}

describe('migration status and the runner', () => {
  it('M1 an empty database is behind by every journal entry', async () => {
    const tmp = await emptyDatabase();
    expect(await migrationStatus(tmp.pool)).toEqual({ kind: 'behind', pending: tags });
  });

  it('M2 the runner applies the whole journal into drizzle-kit’s own table', async () => {
    const tmp = await emptyDatabase();
    expect(await run(tmp.url)).toEqual({ code: 0, lines: [appliedLine] });
    expect(await migrationStatus(tmp.pool)).toEqual({
      kind: 'current',
      applied: journal.length,
      last: lastKnown.tag,
      lastApplied: lastKnown.when,
    });
    expect(await appliedRows(tmp.pool)).toEqual(journal.map((entry) => entry.when));
  });

  it('M3 a second run applies nothing', async () => {
    const tmp = await emptyDatabase();
    await run(tmp.url);
    expect(await run(tmp.url)).toEqual({ code: 0, lines: [nothingLine] });
    expect((await appliedRows(tmp.pool)).length).toBe(journal.length);
  });

  it('M4 the runner waits for the advisory lock before it reads or applies anything', async () => {
    const tmp = await emptyDatabase();
    const holder = new Client({ connectionString: tmp.url });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock($1::bigint)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
      let settled = false;
      const running = run(tmp.url).finally(() => {
        settled = true;
      });
      await until('the runner waits for the advisory lock', async () => {
        if (settled) throw new Error('runner settled without waiting for the lock');
        const waiting = await holder.query<{ count: string }>(
          `select count(*)::text as count from pg_locks
            where locktype = 'advisory' and not granted
              and database = (select oid from pg_database where datname = current_database())`,
        );
        return waiting.rows[0]?.count === '1';
      });
      expect(await migrationStatus(tmp.pool)).toEqual({ kind: 'behind', pending: tags });
      expect(settled).toBe(false);
      await holder.query('select pg_advisory_unlock($1::bigint)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
      expect(await running).toEqual({ code: 0, lines: [appliedLine] });
      expect((await migrationStatus(tmp.pool)).kind).toBe('current');
    } finally {
      await holder.end();
    }
  });

  it('M5 two runners at once: one applies, the other finds nothing to apply', async () => {
    const tmp = await emptyDatabase();
    const results = await Promise.all([run(tmp.url), run(tmp.url)]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.flatMap((result) => result.lines).sort()).toEqual(
      [appliedLine, nothingLine].sort(),
    );
    expect((await appliedRows(tmp.pool)).length).toBe(journal.length);
  });

  it('M6 a database ahead of the journal: the runner warns, the startup check lets it run', async () => {
    const tmp = await emptyDatabase();
    await run(tmp.url);
    const newer = lastKnown.when + 1;
    await tmp.pool.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ('later', $1)`,
      [String(newer)],
    );
    expect(await migrationStatus(tmp.pool)).toEqual({
      kind: 'ahead',
      lastApplied: newer,
      lastKnown: lastKnown.tag,
      lastKnownWhen: lastKnown.when,
    });
    expect(await run(tmp.url)).toEqual({
      code: 0,
      lines: [
        `warning: the database is ahead of this checkout's journal: last applied ${newer}, last known ${lastKnown.tag} (${lastKnown.when})`,
        nothingLine,
      ],
    });
    const logger = recordingLogger();
    expect(await checkSchemaAtStartup(tmp.pool, logger)).toBe(true);
    expect(logger.calls).toEqual([
      {
        level: 'warn',
        object: { lastApplied: newer, lastKnown: lastKnown.tag, lastKnownWhen: lastKnown.when },
        message: 'database schema is ahead of this image',
      },
    ]);
  });

  it('M7 the startup check refuses a database behind the journal and passes a current one', async () => {
    const tmp = await emptyDatabase();
    const before = recordingLogger();
    expect(await checkSchemaAtStartup(tmp.pool, before)).toBe(false);
    expect(before.calls).toEqual([
      {
        level: 'error',
        object: { pending: tags },
        message: 'database schema is behind this image, run the migrations first',
      },
    ]);
    await runMigrations(tmp.pool);
    const after = recordingLogger();
    expect(await checkSchemaAtStartup(tmp.pool, after)).toBe(true);
    expect(after.calls).toEqual([
      {
        level: 'info',
        object: { applied: journal.length, last: lastKnown.tag },
        message: 'database schema is current',
      },
    ]);
  });

  it('M8 a failing migration exits 1 by name and code, and the batch rolls back whole', async () => {
    const tmp = await emptyDatabase();
    await tmp.pool.query('create table users (id int)');
    const { code, lines } = await run(tmp.url);
    expect(code).toBe(1);
    expect(lines).toEqual(['migration failed: Error, cause error 42P07']);
    expect(await appliedRows(tmp.pool)).toEqual([]);
    expect(await checkSchemaAtStartup(tmp.pool, recordingLogger())).toBe(false);
  });

  it('M9 an unreachable database: the runner and the startup check both refuse', async () => {
    expect(await run(UNREACHABLE)).toEqual({
      code: 1,
      lines: ['migration failed: Error ECONNREFUSED'],
    });
    const pool = new Pool({ connectionString: UNREACHABLE });
    try {
      const logger = recordingLogger();
      expect(await checkSchemaAtStartup(pool, logger)).toBe(false);
      expect(logger.calls).toEqual([
        {
          level: 'error',
          object: { err: { name: 'Error', code: 'ECONNREFUSED' } },
          message: 'database schema check failed',
        },
      ]);
    } finally {
      await pool.end();
    }
  });
});

describe('a deadlock while applying', () => {
  it('M10 one deadlock is retried once under the same lock', async () => {
    const tmp = await emptyDatabase();
    let calls = 0;
    const apply = async (pool: Pool) => {
      calls += 1;
      if (calls === 1) throw queryError('40P01');
      await runMigrations(pool);
    };
    expect(await run(tmp.url, { apply })).toEqual({
      code: 0,
      lines: ['deadlock while applying, retrying once', appliedLine],
    });
    expect(calls).toBe(2);
    expect((await migrationStatus(tmp.pool)).kind).toBe('current');
  });

  it('M11 a second deadlock exits 1 without a third attempt', async () => {
    const tmp = await emptyDatabase();
    let calls = 0;
    const apply = async () => {
      calls += 1;
      throw queryError('40P01');
    };
    const { code, lines } = await run(tmp.url, { apply });
    expect(code).toBe(1);
    expect(calls).toBe(2);
    expect(lines.at(-1)).toBe('migration failed: Error, cause error 40P01');
  });

  it('M12 any other failure is not retried', async () => {
    const tmp = await emptyDatabase();
    let calls = 0;
    const apply = async () => {
      calls += 1;
      throw queryError('42P07');
    };
    expect(await run(tmp.url, { apply })).toEqual({
      code: 1,
      lines: ['migration failed: Error, cause error 42P07'],
    });
    expect(calls).toBe(1);
  });
});

describe('an apply that returns without applying', () => {
  it('M13 the runner re-reads the status and exits 1 while anything is pending', async () => {
    const tmp = await emptyDatabase();
    expect(await run(tmp.url, { apply: async () => {} })).toEqual({
      code: 1,
      lines: [`migration incomplete: still ${journal.length} pending after apply`],
    });
  });
});
