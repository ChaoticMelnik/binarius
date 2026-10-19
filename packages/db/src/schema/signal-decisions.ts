import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  MAX_PAIR_DIGITS,
  SIGNAL_DECISION_DETAIL_PATTERN,
  SIGNAL_INTERVALS,
  SIGNAL_VERSION_PATTERN,
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  TradeAction,
  type LastTick,
  type SignalInterval,
  type UnixMs,
} from '@binarius/shared';
import { id, inList, literal, sqlLiteralList, sqlTextLiteral } from './columns';
import { brokerAccounts } from './broker-accounts';
import { tradingSessions } from './trading-sessions';

// The trade log (#666, docs/trade-log.md): one row per decision a session acted on, inserted once
// by the process that acted, with its outcome. The entry's columns rebuild the journal entry
// replaySignalJournalEntry needs (journalEntryOf). No UPDATE writer.
export const signalDecisions = pgTable(
  'signal_decisions',
  {
    id: id(),
    context: text('context').$type<SignalDecisionContext>().notNull(),
    tradingSessionId: uuid('trading_session_id').references(() => tradingSessions.id, {
      onDelete: 'restrict',
    }),
    brokerAccountId: uuid('broker_account_id').references(() => brokerAccounts.id, {
      onDelete: 'restrict',
    }),
    // the session's intents + 1 when the decision was taken: the step its intent key names
    step: integer('step'),
    assetId: integer('asset_id').notNull(),
    // NULL for a version that decides on ticks, not candles (#667)
    interval: text('interval').$type<SignalInterval>(),
    version: text('version').notNull(),
    // the decider's nowMs (the backend clock)
    decidedAtMs: bigint('decided_at_ms', { mode: 'number' }).$type<UnixMs>().notNull(),
    // the writer's clock when it took the decision
    takenAtMs: bigint('taken_at_ms', { mode: 'number' }).$type<UnixMs>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').$type<SignalKind>().notNull(),
    action: text('action').$type<TradeAction>(),
    payout: numeric('payout', { precision: 8, scale: 4, mode: 'number' }),
    digits: integer('digits'),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    decision: jsonb('decision').$type<Record<string, unknown>>().notNull(),
    source: jsonb('source').$type<Record<string, unknown>>().notNull(),
    series: jsonb('series').$type<unknown[]>().notNull(),
    lastTick: jsonb('last_tick').$type<LastTick>(),
    outcome: text('outcome').$type<SignalDecisionOutcome>().notNull(),
    detail: text('detail'),
    // reserved for #667's shadow outcome
    result: jsonb('result').$type<Record<string, unknown>>(),
  },
  (t) => [
    // FK target for trade_intents: an intent's decision is of its own session
    unique('signal_decisions_id_session_key').on(t.id, t.tradingSessionId),
    // a session's decision names that session's account
    foreignKey({
      name: 'signal_decisions_session_account_fk',
      columns: [t.tradingSessionId, t.brokerAccountId],
      foreignColumns: [tradingSessions.id, tradingSessions.brokerAccountId],
    }),
    inList('signal_decisions_context_check', t.context, SignalDecisionContext),
    check(
      'signal_decisions_session_pair_check',
      sql`(${t.context} <> ${literal(SignalDecisionContext.Session)} and ${t.outcome} <> ${literal(SignalDecisionOutcome.Started)}) or ${t.tradingSessionId} is not null`,
    ),
    check(
      'signal_decisions_account_pair_check',
      sql`${t.context} not in (${sqlLiteralList([SignalDecisionContext.Session, SignalDecisionContext.SessionStart])}) or ${t.brokerAccountId} is not null`,
    ),
    check('signal_decisions_step_check', sql`${t.step} > 0`),
    check(
      'signal_decisions_step_pair_check',
      sql`(${t.context} = ${literal(SignalDecisionContext.Session)}) = (${t.step} is not null)`,
    ),
    check('signal_decisions_asset_id_check', sql`${t.assetId} > 0`),
    check(
      'signal_decisions_interval_check',
      sql`${t.interval} in (${sqlLiteralList(SIGNAL_INTERVALS)})`,
    ),
    check(
      'signal_decisions_version_check',
      sql`${t.version} ~ ${sqlTextLiteral(SIGNAL_VERSION_PATTERN.source, 'SIGNAL_VERSION_PATTERN')}`,
    ),
    check('signal_decisions_decided_at_ms_check', sql`${t.decidedAtMs} > 0`),
    check('signal_decisions_taken_at_ms_check', sql`${t.takenAtMs} > 0`),
    inList('signal_decisions_kind_check', t.kind, SignalKind),
    inList('signal_decisions_action_check', t.action, TradeAction),
    check(
      'signal_decisions_action_pair_check',
      sql`(${t.kind} = ${literal(SignalKind.Signal)}) = (${t.action} is not null)`,
    ),
    check('signal_decisions_payout_check', sql`${t.payout} >= 0 and ${t.payout} <> 'NaN'::numeric`),
    check(
      'signal_decisions_digits_check',
      sql`${t.digits} between 0 and ${sql.raw(String(MAX_PAIR_DIGITS))}`,
    ),
    check('signal_decisions_params_check', sql`jsonb_typeof(${t.params}) = 'object'`),
    check('signal_decisions_decision_check', sql`jsonb_typeof(${t.decision}) = 'object'`),
    check('signal_decisions_source_check', sql`jsonb_typeof(${t.source}) = 'object'`),
    check('signal_decisions_series_check', sql`jsonb_typeof(${t.series}) = 'array'`),
    check('signal_decisions_last_tick_check', sql`jsonb_typeof(${t.lastTick}) = 'object'`),
    check('signal_decisions_result_check', sql`jsonb_typeof(${t.result}) = 'object'`),
    inList('signal_decisions_outcome_check', t.outcome, SignalDecisionOutcome),
    check(
      'signal_decisions_outcome_kind_check',
      sql`(${t.kind} = ${literal(SignalKind.NoSignal)}) = (${t.outcome} = ${literal(SignalDecisionOutcome.NoSignal)})`,
    ),
    check(
      'signal_decisions_detail_check',
      sql`${t.detail} ~ ${sqlTextLiteral(SIGNAL_DECISION_DETAIL_PATTERN.source, 'SIGNAL_DECISION_DETAIL_PATTERN')}`,
    ),
    check(
      'signal_decisions_detail_pair_check',
      sql`(${t.outcome} in (${sqlLiteralList([SignalDecisionOutcome.Refused, SignalDecisionOutcome.StakeStop])})) = (${t.detail} is not null)`,
    ),
    // the export's range scan and order
    index('signal_decisions_recorded_idx').on(t.recordedAt, t.id),
    index('signal_decisions_session_idx').on(t.tradingSessionId, t.recordedAt),
  ],
);
