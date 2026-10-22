import { pathToFileURL } from 'node:url';
import { Client, Pool } from 'pg';
import {
  DATABASE_URL_RULES,
  errorLogFields,
  parseUrlEnv,
  readEnv,
  type EnvSource,
} from '@binarius/shared';
import {
  MIGRATIONS_ADVISORY_LOCK_KEY,
  MigrationJournalError,
  migrationStatus,
  readMigrationJournal,
  runMigrations,
  type JournalEntry,
} from '../migrate';

// 0 the database is at (or ahead of) the journal, 1 it is not or the outcome is unknown
const EXIT_OK = 0;
const EXIT_FAILED = 1;

export interface MigrateCliDeps {
  apply: (pool: Pool) => Promise<void>;
}

// name and code only (Rule 8): a pg error's detail and message can carry row values
function describeFailure(error: unknown): string {
  if (error instanceof MigrationJournalError) return error.message;
  const { err, cause } = errorLogFields(error);
  const one = ({ name, code }: { name: string; code?: string }) =>
    code === undefined ? name : `${name} ${code}`;
  return cause === undefined ? one(err) : `${one(err)}, cause ${one(cause)}`;
}

function isDeadlock(error: unknown): boolean {
  const { err, cause } = errorLogFields(error);
  return err.code === '40P01' || cause?.code === '40P01';
}

const plural = (count: number) => (count === 1 ? 'migration' : 'migrations');

// One runner for the host, CI, the compose `migrate` service and the server. The advisory lock
// serialises concurrent runs: drizzle's migrator has none, and two of them on an empty database
// collide on the journal table (23505).
export async function runMigrateCli(
  source: EnvSource,
  print: (line: string) => void,
  deps: MigrateCliDeps = { apply: runMigrations },
): Promise<number> {
  let databaseUrl: string;
  let journal: JournalEntry[];
  try {
    databaseUrl = parseUrlEnv(readEnv(source, 'DATABASE_URL'), 'DATABASE_URL', DATABASE_URL_RULES);
  } catch (error) {
    // our own env messages name the variable, never its value
    print(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  try {
    journal = readMigrationJournal();
  } catch (error) {
    print(`migration failed: ${describeFailure(error)}`);
    return EXIT_FAILED;
  }

  const lock = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  // a dropped idle connection is reported by the next query's rejection, not by a crash
  lock.on('error', () => undefined);
  pool.on('error', () => undefined);
  try {
    await lock.connect();
    // session-level: it outlives the migrator's COMMIT and goes with lock.end() below
    await lock.query('select pg_advisory_lock($1::bigint)', [MIGRATIONS_ADVISORY_LOCK_KEY]);

    let status = await migrationStatus(pool, journal);
    if (status.kind === 'ahead') {
      print(
        `warning: the database is ahead of this checkout's journal: last applied ${status.lastApplied}, last known ${status.lastKnown} (${status.lastKnownWhen})`,
      );
    }
    if (status.kind === 'behind') {
      let pending = status.pending;
      try {
        await deps.apply(pool);
      } catch (error) {
        // the whole batch is one transaction, rolled back whole, and the journal table's DDL is
        // IF NOT EXISTS, so one repeat under the same lock is safe (deadlock on 2026-10-15)
        if (!isDeadlock(error)) throw error;
        print('deadlock while applying, retrying once');
        status = await migrationStatus(pool, journal);
        if (status.kind === 'behind') {
          pending = status.pending;
          await deps.apply(pool);
        } else {
          pending = [];
        }
      }
      const after = await migrationStatus(pool, journal);
      if (after.kind === 'behind') {
        print(`migration incomplete: still ${after.pending.length} pending after apply`);
        return EXIT_FAILED;
      }
      if (pending.length > 0) {
        print(`applied ${pending.length} ${plural(pending.length)}: ${pending.join(', ')}`);
        return EXIT_OK;
      }
    }
    const last = journal.at(-1) as JournalEntry;
    print(`nothing to apply: ${journal.length} ${plural(journal.length)}, last ${last.tag}`);
    return EXIT_OK;
  } catch (error) {
    print(`migration failed: ${describeFailure(error)}`);
    return EXIT_FAILED;
  } finally {
    await pool.end().catch(() => undefined);
    await lock.end().catch(() => undefined);
  }
}

// The module is imported by its test, so the command only runs when this file is what node was
// started with. `pnpm db:migrate` resolves to exactly that.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const code = await runMigrateCli(process.env, (line) => {
    process.stdout.write(`${line}\n`);
  });
  process.exit(code);
}
