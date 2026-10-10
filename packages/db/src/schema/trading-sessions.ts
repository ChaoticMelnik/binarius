import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  TradeAction,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type TradingSessionSettings,
} from '@binarius/shared';
import { createdAt, id, inList, literal, updatedAt } from './columns';
import { brokerAccounts } from './broker-accounts';

// The session orchestrator's table (#130; the orchestrator is #287; docs/trading-session.md). `settings` is typed for the
// writers only: $type has no runtime effect, so the orchestrator parses the column at read.
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
      .$type<TradingSessionSettings>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    stopReason: text('stop_reason').$type<TradingSessionStopReason>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    // the order key of the runnable scan; NULL until the first attempt reached an ending
    lastDecisionAt: timestamp('last_decision_at', { withTimezone: true }),
    // the direction of the last attempt that decided anything, NULL after a no_signal or before
    // any decision: the pause after two losses holds while it stays the losing direction (#379)
    lastSignalAction: text('last_signal_action').$type<TradeAction>(),
    // the summary card's at-most-once mark (#318): set by claimSessionSummary's one CAS, never
    // cleared; NULL on every session that has not sent its card
    summarySentAt: timestamp('summary_sent_at', { withTimezone: true }),
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
    inList('trading_sessions_stop_reason_check', t.stopReason, TradingSessionStopReason),
    inList('trading_sessions_last_signal_action_check', t.lastSignalAction, TradeAction),
    // Two CHECKs, not one: a single `(stopped) = (reason and end)` accepts paused/reason/NULL and
    // active/NULL/now, because false = false holds. Each pair alone pins its column to `stopped`.
    check(
      'trading_sessions_stop_reason_pair_check',
      sql`(${t.status} = ${literal(TradingSessionStatus.Stopped)}) = (${t.stopReason} is not null)`,
    ),
    check(
      'trading_sessions_ended_at_pair_check',
      sql`(${t.status} = ${literal(TradingSessionStatus.Stopped)}) = (${t.endedAt} is not null)`,
    ),
    check('trading_sessions_settings_object_check', sql`jsonb_typeof(${t.settings}) = 'object'`),
    uniqueIndex('trading_sessions_active_account_idx')
      .on(t.brokerAccountId)
      .where(sql`${t.status} = ${literal(TradingSessionStatus.Active)}`),
    // the runnable scan's predicate and order, so the scan reads it in order and stops at its limit
    index('trading_sessions_runnable_idx')
      .on(t.lastDecisionAt.asc().nullsFirst(), t.createdAt)
      .where(sql`${t.status} = ${literal(TradingSessionStatus.Active)}`),
  ],
);
