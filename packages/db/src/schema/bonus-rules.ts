import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { BonusRuleKind } from '@binarius/shared';
import { createdAt, id, inList, updatedAt } from './columns';

// Versioned bonus rules (#13, docs/bonus-rules.md). A row is never edited: a new version
// supersedes it. The triggers in drizzle/0059_bonus_rules.sql refuse an UPDATE of any column but
// is_active, valid_from, valid_to and updated_at, and every DELETE and TRUNCATE, so the version a
// ledger row names (token_ledger.bonus_rule_id) always says what was credited. `priority` is #7's
// skeleton column and has no reader: a code resolves to its one active version.
export const bonusRules = pgTable(
  'bonus_rules',
  {
    id: id(),
    code: text('code').notNull(),
    version: integer('version').notNull(),
    kind: text('kind').$type<BonusRuleKind>().notNull(),
    // a version inserted any way but `bonus-rule activate` stays off
    isActive: boolean('is_active').notNull().default(false),
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
    uniqueIndex('bonus_rules_code_version_key').on(t.code, t.version),
    uniqueIndex('bonus_rules_active_code_idx')
      .on(t.code)
      .where(sql`${t.isActive}`),
    // the target of token_ledger_bonus_rule_fk: a ledger row names a rule of the kind its
    // reference requires
    unique('bonus_rules_id_kind_key').on(t.id, t.kind),
    check('bonus_rules_version_check', sql`${t.version} >= 1`),
    inList('bonus_rules_kind_check', t.kind, BonusRuleKind),
    check(
      'bonus_rules_validity_check',
      sql`${t.validFrom} is null or ${t.validTo} is null or ${t.validTo} > ${t.validFrom}`,
    ),
  ],
);
