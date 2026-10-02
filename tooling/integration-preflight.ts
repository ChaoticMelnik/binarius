import pg from 'pg';
import { SKEW_LIMIT_MS } from './db-clock-probe';

// The integration project's globalSetup: one look at the database in TEST_DATABASE_URL before any
// test file creates a temporary database in it. Each refusal names the README section that fixes
// it, instead of the same mistake surfacing as a handful of unrelated red tests (#166).

// `old.status` in RETURNING (packages/db/src/staff-ops.ts) needs 18
const MIN_SERVER_VERSION_NUM = 180_000;
// where the postgres image keeps its cluster: on a Mac that is the compose container in the VM,
// whose clock steps back and lags after a sleep; on a Linux host it is a legal native path
const CONTAINER_DATA_PREFIX = '/var/lib/postgresql';
const SEE = 'see README → Test database';

export interface PreflightFacts {
  serverVersionNum: number;
  dataDirectory: string;
  dbMs: number;
  hostMs: number;
  platform: NodeJS.Platform;
}

export function judgePreflight(facts: PreflightFacts): string[] {
  const problems: string[] = [];
  // negated comparisons, so a value that did not parse (NaN) refuses instead of passing
  if (!(facts.serverVersionNum >= MIN_SERVER_VERSION_NUM)) {
    problems.push(
      `TEST_DATABASE_URL points at PostgreSQL ${facts.serverVersionNum}; the tests need 18 or newer (${SEE})`,
    );
  }
  const skewMs = facts.dbMs - facts.hostMs;
  if (!(Math.abs(skewMs) <= SKEW_LIMIT_MS)) {
    problems.push(
      `the clock of the database in TEST_DATABASE_URL is ${Math.round(skewMs)} ms off this host's (limit ±${SKEW_LIMIT_MS} ms) (${SEE})`,
    );
  }
  if (facts.platform === 'darwin' && facts.dataDirectory.startsWith(CONTAINER_DATA_PREFIX)) {
    problems.push(
      `TEST_DATABASE_URL points at a containerised Postgres (data_directory ${facts.dataDirectory}), not the native one on this Mac (${SEE})`,
    );
  }
  return problems;
}

export default async function preflight(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error(`TEST_DATABASE_URL is required for the integration tests (${SEE})`);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const version = await client.query<{ server_version_num: string }>('show server_version_num');
    const directory = await client.query<{ data_directory: string }>('show data_directory');
    const sentMs = Date.now();
    const clock = await client.query<{ ms: string }>(
      'select (extract(epoch from clock_timestamp()) * 1000)::text as ms',
    );
    const hostMs = (sentMs + Date.now()) / 2;
    const problems = judgePreflight({
      serverVersionNum: Number(version.rows[0]?.server_version_num),
      dataDirectory: directory.rows[0]?.data_directory ?? '',
      dbMs: Number(clock.rows[0]?.ms),
      hostMs,
      platform: process.platform,
    });
    if (problems.length > 0) {
      throw new Error(`integration preflight refused:\n  - ${problems.join('\n  - ')}`);
    }
  } finally {
    await client.end();
  }
}
