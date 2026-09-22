import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { TradeMode } from '@binarius/shared';
import { createdAt, id, inList, updatedAt } from './columns';
import { brokerAccounts } from './broker-accounts';

export const TradingSessionStatus = {
  Active: 'active',
  Paused: 'paused',
  Stopped: 'stopped',
} as const;
export type TradingSessionStatus = (typeof TradingSessionStatus)[keyof typeof TradingSessionStatus];

// skeleton (#7): settings firm up with the session orchestration issue (#20)
export const tradingSessions = pgTable(
  'trading_sessions',
  {
    id: id(),
    brokerAccountId: uuid('broker_account_id')
      .notNull()
      .references(() => brokerAccounts.id, { onDelete: 'restrict' }),
    mode: text('mode').$type<TradeMode>().notNull(),
    status: text('status')
      .$type<TradingSessionStatus>()
      .notNull()
      .default(TradingSessionStatus.Active),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // FK target for trade_intents: mode is part of the key so a demo session cannot
    // parent a real intent
    unique('trading_sessions_id_account_mode_key').on(t.id, t.brokerAccountId, t.mode),
    index('trading_sessions_account_status_idx').on(t.brokerAccountId, t.status),
    inList('trading_sessions_mode_check', t.mode, TradeMode),
    inList('trading_sessions_status_check', t.status, TradingSessionStatus),
  ],
);
