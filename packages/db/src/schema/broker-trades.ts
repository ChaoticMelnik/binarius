import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { TradeAction, TradeMode, type DecimalString, type UnixMs } from '@binarius/shared';
import { createdAt, id, inList, updatedAt } from './columns';
import { brokerAccounts } from './broker-accounts';
import { tradeIntents } from './trade-intents';

export const BrokerTradeStatus = { Open: 'open', Closed: 'closed' } as const;
export type BrokerTradeStatus = (typeof BrokerTradeStatus)[keyof typeof BrokerTradeStatus];

const money = (name: string) =>
  numeric(name, { precision: 20, scale: 8, mode: 'string' }).$type<DecimalString>();

// Broker timestamps are Unix ms (bigint) as the broker sends them; prices are JSON numbers,
// not money. close_* / profit are NULL until settlement: the broker omits them, it never sends 0.
export const brokerTrades = pgTable(
  'broker_trades',
  {
    id: id(),
    brokerAccountId: uuid('broker_account_id')
      .notNull()
      .references(() => brokerAccounts.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id').references(() => tradeIntents.id, { onDelete: 'restrict' }),
    brokerTradeId: text('broker_trade_id').notNull(),
    mode: text('mode').$type<TradeMode>().notNull(),
    assetId: integer('asset_id').notNull(),
    action: text('action').$type<TradeAction>().notNull(),
    amount: money('amount').notNull(),
    payout: numeric('payout', { precision: 8, scale: 4, mode: 'number' }).notNull(),
    openPrice: doublePrecision('open_price').notNull(),
    openTimestampMs: bigint('open_timestamp_ms', { mode: 'number' }).$type<UnixMs>().notNull(),
    closePrice: doublePrecision('close_price'),
    closeTimestampMs: bigint('close_timestamp_ms', { mode: 'number' }).$type<UnixMs>(),
    potentialProfit: money('potential_profit'),
    profit: money('profit'),
    source: text('source'),
    brokerClientId: text('broker_client_id'),
    status: text('status').$type<BrokerTradeStatus>().notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('broker_trades_account_trade_key').on(t.brokerAccountId, t.brokerTradeId),
    // ARCH-04: a trade found by reconciliation links to an intent exactly once
    unique('broker_trades_intent_id_key').on(t.intentId),
    // ...and only to an intent of the same account
    foreignKey({
      name: 'broker_trades_intent_account_fk',
      columns: [t.intentId, t.brokerAccountId],
      foreignColumns: [tradeIntents.id, tradeIntents.brokerAccountId],
    }),
    inList('broker_trades_mode_check', t.mode, TradeMode),
    inList('broker_trades_action_check', t.action, TradeAction),
    inList('broker_trades_status_check', t.status, BrokerTradeStatus),
    check('broker_trades_asset_id_check', sql`${t.assetId} > 0`),
    check('broker_trades_amount_check', sql`${t.amount} > 0`),
    check(
      'broker_trades_closed_check',
      sql`(${t.status} = 'closed') = (${t.closeTimestampMs} is not null)`,
    ),
    index('broker_trades_account_status_idx').on(t.brokerAccountId, t.status),
  ],
);
