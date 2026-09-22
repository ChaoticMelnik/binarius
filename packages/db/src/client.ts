import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema/index';

export type Db = NodePgDatabase<typeof schema>;

// the app owns the pool (and its shutdown); this package never reads env or opens connections
export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
