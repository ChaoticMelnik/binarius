import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { TRADING_SWITCH_REASON_MAX, TradingSwitchSource } from '@binarius/shared';
import { inList } from './columns';

// The global trading switch (#144, docs/kill-switch.md): one row at most. Every reader takes a
// missing row as closed (tradingOpenSql), so a DELETE by hand stops trading and never opens it.
export const tradingSwitch = pgTable(
  'trading_switch',
  {
    id: boolean('id').primaryKey().default(true),
    tradingEnabled: boolean('trading_enabled').notNull(),
    source: text('source').$type<TradingSwitchSource>().notNull(),
    reason: text('reason'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('trading_switch_singleton_check', sql`${t.id}`),
    inList('trading_switch_source_check', t.source, TradingSwitchSource),
    check('trading_switch_stop_reason_check', sql`${t.tradingEnabled} or ${t.reason} is not null`),
    check(
      'trading_switch_reason_length_check',
      sql`char_length(${t.reason}) between 1 and ${sql.raw(String(TRADING_SWITCH_REASON_MAX))}`,
    ),
  ],
);
