import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns';

// skeleton (#7): rule kinds and params are defined by the bonus rule engine issue (#13)
export const bonusRules = pgTable(
  'bonus_rules',
  {
    id: id(),
    code: text('code').notNull(),
    kind: text('kind').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    params: jsonb('params')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bonus_rules_code_idx').on(t.code),
    check(
      'bonus_rules_validity_check',
      sql`${t.validFrom} is null or ${t.validTo} is null or ${t.validTo} > ${t.validFrom}`,
    ),
  ],
);
