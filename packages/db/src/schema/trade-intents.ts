import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  TRADE_INTENT_TRANSITIONS,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  type DecimalString,
} from '@binarius/shared';
import { createdAt, id, inList, sqlLiteralList, updatedAt } from './columns';
import { brokerAccounts } from './broker-accounts';
import { tradingSessions } from './trading-sessions';
import { users } from './users';

// ARCH-04: how the order reached the broker
export const TradeTransport = { Socket: 'socket', RestFallback: 'rest_fallback' } as const;
export type TradeTransport = (typeof TradeTransport)[keyof typeof TradeTransport];

export const TERMINAL_TRADE_INTENT_STATUSES = Object.entries(TRADE_INTENT_TRANSITIONS)
  .filter(([, targets]) => targets.length === 0)
  .map(([status]) => status as TradeIntentStatus);

export const tradeIntents = pgTable(
  'trade_intents',
  {
    id: id(),
    brokerAccountId: uuid('broker_account_id')
      .notNull()
      .references(() => brokerAccounts.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tradingSessionId: uuid('trading_session_id').references(() => tradingSessions.id, {
      onDelete: 'restrict',
    }),
    mode: text('mode').$type<TradeMode>().notNull(),
    assetId: integer('asset_id').notNull(),
    amount: numeric('amount', { precision: 20, scale: 8, mode: 'string' })
      .$type<DecimalString>()
      .notNull(),
    action: text('action').$type<TradeAction>().notNull(),
    durationSec: integer('duration_sec').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    status: text('status').$type<TradeIntentStatus>().notNull().default(TradeIntentStatus.Planned),
    // ARCH-03: the worker re-reads the intent and rejects a job whose version moved on
    version: integer('version').notNull().default(1),
    tokensReserved: bigint('tokens_reserved', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    transport: text('transport').$type<TradeTransport>(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // ARCH-03: a repeated Telegram update returns the existing intent
    uniqueIndex('trade_intents_account_request_idx').on(t.brokerAccountId, t.clientRequestId),
    // one non-terminal intent per account: the backend's "no conflicting active intent"
    // check holds under concurrent transactions, and an unknown/reconciling intent blocks new ones
    uniqueIndex('trade_intents_active_account_idx')
      .on(t.brokerAccountId)
      .where(sql`${t.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})`),
    // target of the composite FK from broker_trades
    unique('trade_intents_id_account_key').on(t.id, t.brokerAccountId),
    // the intent's user must own the broker account
    foreignKey({
      name: 'trade_intents_account_owner_fk',
      columns: [t.brokerAccountId, t.userId],
      foreignColumns: [brokerAccounts.id, brokerAccounts.userId],
    }),
    // the session, when set, must belong to the same account
    foreignKey({
      name: 'trade_intents_session_account_fk',
      columns: [t.tradingSessionId, t.brokerAccountId],
      foreignColumns: [tradingSessions.id, tradingSessions.brokerAccountId],
    }),
    inList('trade_intents_mode_check', t.mode, TradeMode),
    inList('trade_intents_action_check', t.action, TradeAction),
    inList('trade_intents_status_check', t.status, TradeIntentStatus),
    inList('trade_intents_transport_check', t.transport, TradeTransport),
    check('trade_intents_asset_id_check', sql`${t.assetId} > 0`),
    check('trade_intents_amount_check', sql`${t.amount} > 0`),
    check('trade_intents_duration_sec_check', sql`${t.durationSec} > 0`),
    check('trade_intents_tokens_reserved_check', sql`${t.tokensReserved} >= 0`),
    index('trade_intents_account_status_idx').on(t.brokerAccountId, t.status),
    index('trade_intents_status_updated_idx').on(t.status, t.updatedAt),
    index('trade_intents_user_id_idx').on(t.userId),
    index('trade_intents_session_id_idx').on(t.tradingSessionId),
  ],
);
