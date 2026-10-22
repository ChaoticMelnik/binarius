import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema/index';

export type Db = NodePgDatabase<typeof schema>;

// the app owns the pool (and its shutdown); within this package only the migration runner
// (src/cli/migrate.ts) reads env and opens connections
export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
