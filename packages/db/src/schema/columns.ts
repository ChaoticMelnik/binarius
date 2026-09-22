import { sql } from 'drizzle-orm';
import { bigint, check, customType, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

export const id = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// drizzle-kit serializes snapshots with JSON.stringify, which throws on a BigInt default,
// so the zero has to reach it as SQL rather than as 0n
export const tokenAmount = (name: string) =>
  bigint(name, { mode: 'bigint' })
    .notNull()
    .default(sql`0`);

// pg-core 0.45 ships no bytea builder
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// PostgreSQL orders NaN above every finite value, so a bare `> 0` accepts 'NaN'::numeric, and
// double precision additionally accepts Infinity. Broker and postback numbers are external input,
// so every money and price column states the guard explicitly.
export const positiveMoney = (name: string, column: AnyPgColumn, nullable = false) =>
  check(
    name,
    nullable
      ? sql`${column} is null or (${column} > 0 and ${column} <> 'NaN'::numeric)`
      : sql`${column} > 0 and ${column} <> 'NaN'::numeric`,
  );

export const finitePrice = (name: string, column: AnyPgColumn, nullable = false) =>
  check(
    name,
    nullable
      ? sql`${column} is null or (${column} > 0 and ${column} < 'Infinity'::double precision)`
      : sql`${column} > 0 and ${column} < 'Infinity'::double precision`,
  );

// text + CHECK instead of pgEnum: adding or removing a value is one forward migration.
// Values are our own constants, so inlining them as literals is safe; bound parameters
// would not survive drizzle-kit's DDL serialization. The guard keeps that assumption true.
export const sqlLiteralList = (values: readonly string[]) =>
  sql.raw(
    values
      .map((value) => {
        if (!/^[a-z0-9_-]+$/i.test(value)) {
          throw new Error(`enum literal is not a bare identifier, refusing to inline: ${value}`);
        }
        return `'${value}'`;
      })
      .join(', '),
  );

export const inList = (
  name: string,
  column: AnyPgColumn,
  values: Readonly<Record<string, string>>,
) => check(name, sql`${column} in (${sqlLiteralList(Object.values(values))})`);
