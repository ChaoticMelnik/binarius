import type { Logger } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema/index';

export type Db = NodePgDatabase<typeof schema>;

// the app owns the pool (and its shutdown); within this package only the migration runner
// (src/cli/migrate.ts) reads env and opens connections
// logger: the statements a test reads to tell which path a call took
export function createDb(pool: Pool, options: { logger?: Logger } = {}): Db {
  const { logger } = options;
  return logger === undefined ? drizzle(pool, { schema }) : drizzle(pool, { schema, logger });
}
