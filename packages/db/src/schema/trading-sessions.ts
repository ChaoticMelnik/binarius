import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
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
    // the direction of the signal the start route checked (#568): the bot's session picture until
    // the session's first trade. Written only by createTradingSession from POST /trading/sessions,
    // never updated; NULL on rows before #568 and on the CLI's session-start, which checks no signal
    startSignalAction: text('start_signal_action').$type<TradeAction>(),
    // the summary card's at-most-once mark (#318): set by claimSessionSummary's one CAS, never
    // cleared; NULL on every session that has not sent its card
    summarySentAt: timestamp('summary_sent_at', { withTimezone: true }),
    // The session notices' cursor (#464, docs/bot-session.md → Trade messages): how many of the
    // session's settled trades, in creation order, the backend's sender has claimed for sending.
    // Raised one by one by claimSessionTradeNotice's CAS, lowered only by its release.
    notifiedTrades: integer('notified_trades').notNull().default(0),
    // the summary message's at-most-once mark (#464): set by claimSessionFinalNotice's one CAS,
    // never cleared; the card of #318 waits for it
    finalNoticeSentAt: timestamp('final_notice_sent_at', { withTimezone: true }),
    // The session's live cycle message (#551, docs/bot-session.md → The state): Telegram's
    // message_id of the message the next step of the same cycle edits, and the index (from 0, in
    // the cursor's order) of the first settled trade it shows. Both NULL until a new message of
    // the session was sent; written only by recordSessionCycleMessage after a send went through,
    // never cleared: a later cycle's trade sends a new message and moves them.
    cycleMessageId: integer('cycle_message_id'),
    cycleMessageFrom: integer('cycle_message_from'),
    // The bot's status message of the session (#567, docs/bot-session.md → Recovery after a
    // restart): Telegram's message_id of the newest status message the bot tracked it on, so the
    // bot can track it again after a restart. Written by recordSessionStatusMessage's CAS (`is
    // null or < messageId`: message ids grow within a chat, #587; the owner in the predicate),
    // cleared only by forgetSessionStatusMessage's (the same id, the owner) once the bot reports
    // it lost; read by listTrackedSessions.
    statusMessageId: integer('status_message_id'),
    // The waiting message under the session's messages (#536, docs/bot-session.md → The waiting
    // message): Telegram's message_id of the live «🔎 Ждём сигнал…» with its «⏹», NULL when there
    // is none (not sent, deleted, handed to the bot at a stop, or its send's outcome unknown); and
    // its slot, the latest message of the session it was claimed after
    // (`greatest(coalesce(cycle_message_id, 0), coalesce(status_message_id, 0))`, #587; 0 before
    // either), NULL when no waiting message is claimed. Written by the backend's sender:
    // claimSessionWaiting's CAS claims the slot before the send, recordSessionWaitingMessage
    // writes the id after it, releaseSessionWaiting frees the slot after a certain refusal,
    // clearSessionWaitingMessage drops the id and frees the slot after the delete; and by the stop
    // route (#587): stopTradingSession with the pressed waiting message's id drops it in its own
    // UPDATE, clearSessionWaitingMessage by that id on a 409; the sender re-reads the id before
    // its delete (#587 round 1). A newer message of the session leaves the slot behind, and the
    // waiting message is then deleted and sent again under it.
    waitingMessageId: integer('waiting_message_id'),
    waitingAfterMessage: integer('waiting_after_message'),
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
    inList('trading_sessions_start_signal_action_check', t.startSignalAction, TradeAction),
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
    check('trading_sessions_notified_trades_check', sql`${t.notifiedTrades} >= 0`),
    check(
      'trading_sessions_cycle_message_pair_check',
      sql`(${t.cycleMessageId} is null) = (${t.cycleMessageFrom} is null)`,
    ),
    check('trading_sessions_cycle_message_id_check', sql`${t.cycleMessageId} > 0`),
    check('trading_sessions_cycle_message_from_check', sql`${t.cycleMessageFrom} >= 0`),
    check('trading_sessions_status_message_id_check', sql`${t.statusMessageId} > 0`),
    check('trading_sessions_waiting_message_id_check', sql`${t.waitingMessageId} > 0`),
    check('trading_sessions_waiting_after_message_check', sql`${t.waitingAfterMessage} >= 0`),
    // a live waiting message always stands on a claimed slot
    check(
      'trading_sessions_waiting_pair_check',
      sql`${t.waitingMessageId} is null or ${t.waitingAfterMessage} is not null`,
    ),
    uniqueIndex('trading_sessions_active_account_idx')
      .on(t.brokerAccountId)
      .where(sql`${t.status} = ${literal(TradingSessionStatus.Active)}`),
    // the runnable scan's predicate and order, so the scan reads it in order and stops at its limit
    index('trading_sessions_runnable_idx')
      .on(t.lastDecisionAt.asc().nullsFirst(), t.createdAt)
      .where(sql`${t.status} = ${literal(TradingSessionStatus.Active)}`),
    // the notice sender's scan (#464): the sessions without their summary, oldest first
    index('trading_sessions_notice_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.finalNoticeSentAt} is null`),
    // the bot's recovery list (#567): the sessions with a status message and no card yet, oldest
    // first
    index('trading_sessions_tracked_idx')
      .on(t.startedAt)
      .where(sql`${t.statusMessageId} is not null and ${t.summarySentAt} is null`),
  ],
);
