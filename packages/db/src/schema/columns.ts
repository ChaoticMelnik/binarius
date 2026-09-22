import { sql } from 'drizzle-orm';
import { check, customType, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

export const id = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// pg-core 0.45 ships no bytea builder
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// text + CHECK instead of pgEnum: adding or removing a value is one forward migration.
// Values are our own constants, so inlining them as literals is safe; bound parameters
// would not survive drizzle-kit's DDL serialization.
export const sqlLiteralList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

export const inList = (
  name: string,
  column: AnyPgColumn,
  values: Readonly<Record<string, string>>,
) => check(name, sql`${column} in (${sqlLiteralList(Object.values(values))})`);
