import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createDb, type Db } from './client';
import { runMigrations } from './migrate';

export interface TempDatabase {
  url: string;
  pool: Pool;
  db: Db;
  drop(): Promise<void>;
}

const PREFIX = 'binarius_test_';
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;
// the name carries its creation time so a database left behind by a crashed run can be reaped
const NAME_PATTERN = /^binarius_test_(\d+)_[0-9a-f]{8}$/;

// One migrated database per test file: integration tests commit for real (append-only tables
// cannot be cleaned afterwards) and may open concurrent transactions. Requires CREATEDB on the
// role in DATABASE_URL — the compose/CI role is a superuser.
export async function createTempDatabase(baseUrl: string): Promise<TempDatabase> {
  const name = `${PREFIX}${Date.now()}_${randomBytes(4).toString('hex')}`;
  await withAdmin(baseUrl, async (admin) => {
    await reapOrphans(admin);
    await admin.query(`CREATE DATABASE "${name}"`);
  });
  const url = withDatabase(baseUrl, name);
  const pool = new Pool({ connectionString: url });
  try {
    await runMigrations(pool);
  } catch (error) {
    await pool.end();
    await withAdmin(baseUrl, (admin) => dropDatabase(admin, name));
    throw error;
  }
  return {
    url,
    pool,
    db: createDb(pool),
    drop: async () => {
      await pool.end();
      await withAdmin(baseUrl, (admin) => dropDatabase(admin, name));
    },
  };
}

async function withAdmin<T>(baseUrl: string, run: (admin: Pool) => Promise<T>): Promise<T> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

// WITH (FORCE) terminates sessions still attached to an orphan; the caller ends its own pool first
async function dropDatabase(admin: Pool, name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

async function reapOrphans(admin: Pool): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    'select datname from pg_database where datname like $1',
    [`${PREFIX}%`],
  );
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
  for (const { datname } of rows) {
    // the pattern also guards the identifier interpolated into DROP DATABASE
    const match = NAME_PATTERN.exec(datname);
    if (match === null || Number(match[1]) > cutoff) continue;
    await dropDatabase(admin, datname);
  }
}

function withDatabase(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
