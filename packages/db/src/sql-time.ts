import { sql, type SQL } from 'drizzle-orm';

// database-clock arithmetic shared by every age predicate (worker, publisher, sweeper): the
// app clock never enters a CAS
export const millisecondsAgo = (ms: number | SQL): SQL =>
  sql`now() - (${ms}::int * interval '1 millisecond')`;
export const millisecondsFromNow = (ms: number): SQL =>
  sql`now() + (${ms}::int * interval '1 millisecond')`;
