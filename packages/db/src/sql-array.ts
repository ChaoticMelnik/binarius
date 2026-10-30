import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

// one array parameter, not a list of N parameters
export const uuidIn = (column: SQLWrapper, ids: readonly string[]): SQL =>
  sql`${column} = any(${sql.param([...ids])}::uuid[])`;
