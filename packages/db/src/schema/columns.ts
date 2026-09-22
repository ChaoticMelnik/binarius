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

// PostgreSQL orders NaN above every finite value, so a bare `> 0` accepts 'NaN'::numeric.
// A `numeric` column with a typmod rejects Infinity at the type level, so NaN is the only
// escape there; `double precision` has no typmod and admits both, hence the separate helper.
// The helpers are named by column type and split by nullability rather than taking a flag,
// so a wrong choice is a type error at the call site rather than a silent runtime rejection.
export const positiveNumeric = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} > 0 and ${column} <> 'NaN'::numeric`);

export const nullablePositiveNumeric = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} is null or (${column} > 0 and ${column} <> 'NaN'::numeric)`);

// `NaN < Infinity` is false in PostgreSQL's float ordering, so the upper bound excludes both
export const finiteFloat = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} > 0 and ${column} < 'Infinity'::double precision`);

export const nullableFiniteFloat = (name: string, column: AnyPgColumn) =>
  check(
    name,
    sql`${column} is null or (${column} > 0 and ${column} < 'Infinity'::double precision)`,
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
