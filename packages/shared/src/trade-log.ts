import * as z from 'zod';
import { decimalStringSchema } from './money';
import { SessionStakeStrategy } from './session-steps';
import {
  lastTickSchema,
  SIGNAL_ALGORITHM_VERSIONS,
  SignalKind,
  signalIntervalSchema,
  storedSignalJournalEntrySchema,
} from './signal';
import { TradingSessionStopReason } from './trading-session';
import {
  TradeIntentStatus,
  tradeActionSchema,
  tradeIntentFailureReasonSchema,
  tradeModeSchema,
} from './trading';

// The trade log (#666, docs/trade-log.md): one signal_decisions row per decision a session acted
// on, and the export that reads them.

// signal_decisions.context: who decided. `shadow` has no writer in part 1 (#667's).
export const SignalDecisionContext = {
  Session: 'session',
  SessionStart: 'session_start',
  Shadow: 'shadow',
} as const;
export type SignalDecisionContext =
  (typeof SignalDecisionContext)[keyof typeof SignalDecisionContext];

// signal_decisions.outcome: what the writer did with the decision (docs/trade-log.md → The
// writers and their outcomes)
export const SignalDecisionOutcome = {
  Intent: 'intent',
  Started: 'started',
  NoSignal: 'no_signal',
  Paused: 'paused',
  StakeStop: 'stake_stop',
  Refused: 'refused',
  Replayed: 'replayed',
  Shadow: 'shadow',
} as const;
export type SignalDecisionOutcome =
  (typeof SignalDecisionOutcome)[keyof typeof SignalDecisionOutcome];

// Identifiers, not statuses: a later detector adds a version without a migration (#667), and a
// detail is a code of the writer's own closed list (a refusal's or a stake stop's code).
export const SIGNAL_VERSION_PATTERN = /^[a-z0-9_-]{1,16}$/;
export const SIGNAL_DECISION_DETAIL_PATTERN = /^[a-z0-9_]{1,64}$/;

const unixMsSchema = z.int();

// a version the candle replay does not know (an H1 shadow row, #669): emitted as stored
const foreignSignalSchema = z.looseObject({
  version: z
    .string()
    .refine((version) => !(SIGNAL_ALGORITHM_VERSIONS as readonly string[]).includes(version)),
});

export const tradeLogDecisionSchema = z.strictObject({
  id: z.uuid(),
  context: z.enum(SignalDecisionContext),
  outcome: z.enum(SignalDecisionOutcome),
  detail: z.string().regex(SIGNAL_DECISION_DETAIL_PATTERN).nullable(),
  version: z.string().regex(SIGNAL_VERSION_PATTERN),
  assetId: z.int().positive(),
  interval: signalIntervalSchema.nullable(),
  step: z.int().positive().nullable(),
  kind: z.enum(SignalKind),
  action: tradeActionSchema.nullable(),
  decidedAtMs: unixMsSchema,
  takenAtMs: unixMsSchema,
  recordedAtMs: unixMsSchema,
  // the last broker second the row's prices rest on (a shadow row's f + 7 s, #669); null otherwise
  ticksUntilMs: unixMsSchema.nullable(),
  payout: z.number().nullable(),
  lastTick: lastTickSchema.nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
});

export const tradeLogSessionSchema = z.strictObject({
  id: z.uuid(),
  userId: z.uuid(),
  brokerAccountId: z.uuid(),
  mode: tradeModeSchema,
  // null when the row's settings do not parse
  strategy: z.enum(SessionStakeStrategy).nullable(),
  baseStake: decimalStringSchema.nullable(),
  durationSec: z.int().positive().nullable(),
  stopReason: z.enum(TradingSessionStopReason).nullable(),
});

export const tradeLogBrokerTradeSchema = z.strictObject({
  status: z.enum({ Open: 'open', Closed: 'closed' }),
  payout: z.number(),
  openPrice: z.number(),
  openTimestampMs: unixMsSchema,
  closePrice: z.number().nullable(),
  closeTimestampMs: unixMsSchema.nullable(),
  profit: decimalStringSchema.nullable(),
});

export const tradeLogTradeSchema = z.strictObject({
  intentId: z.uuid(),
  status: z.enum(TradeIntentStatus),
  mode: tradeModeSchema,
  action: tradeActionSchema,
  amount: decimalStringSchema,
  durationSec: z.int().positive(),
  createdAtMs: unixMsSchema,
  submittedAtMs: unixMsSchema.nullable(),
  // trade_intents.last_error and submit_deadline_at (#670): why a rejected intent never reached the
  // broker (entry_window_missed: its H1 entry window closed before the take); null deadline means
  // no window
  lastError: tradeIntentFailureReasonSchema.nullable(),
  submitDeadlineAtMs: unixMsSchema.nullable(),
  // the trade's cycle and step in it (sessionTradeSteps); null until the trade is settled
  cycle: z.int().positive().nullable(),
  cycleStep: z.int().positive().nullable(),
  broker: tradeLogBrokerTradeSchema.nullable(),
});

// decision_ticks.status (#668, docs/trade-log.md → The ticks around a decision): how much of the
// window the backend's tick buffer covered
export const DecisionTicksStatus = {
  Complete: 'complete',
  Truncated: 'truncated',
  Unavailable: 'unavailable',
} as const;
export type DecisionTicksStatus = (typeof DecisionTicksStatus)[keyof typeof DecisionTicksStatus];

// decision_ticks.detail: why a window is not `complete`, the first that applies in this order
export const DecisionTicksDetail = {
  Uncovered: 'uncovered',
  Hole: 'hole',
  MaxWait: 'max_wait',
  Quiet: 'quiet',
} as const;
export type DecisionTicksDetail = (typeof DecisionTicksDetail)[keyof typeof DecisionTicksDetail];

// 1 in TRADE_TICKS_SHADOW_SAMPLE shadow rows gets its ticks (owner, #668 В1), chosen by the row's
// uuid; the candidate query inlines the same expression (decision-ticks-ops.ts, K13 pins both)
export const TRADE_TICKS_SHADOW_SAMPLE = 20;
export const shadowTicksSampled = (id: string): boolean =>
  Number.parseInt(id.slice(0, 4), 16) % TRADE_TICKS_SHADOW_SAMPLE === 0;

// [broker timestamp, local receipt ms, price]
export const tradeLogTickRowSchema = z.tuple([z.number(), z.number(), z.number().positive()]);
export type TradeLogTickRow = z.infer<typeof tradeLogTickRowSchema>;

export const tradeLogTicksSchema = z
  .strictObject({
    status: z.enum(DecisionTicksStatus),
    detail: z.enum(DecisionTicksDetail).nullable(),
    fromMs: unixMsSchema,
    untilMs: unixMsSchema,
    count: z.int().nonnegative(),
    rows: z.array(tradeLogTickRowSchema),
  })
  .refine((t) => (t.status === DecisionTicksStatus.Complete) === (t.detail === null), {
    message: 'detail is set exactly when the status is not complete',
  })
  .refine((t) => t.rows.length === t.count, { message: 'rows has count elements' });
export type TradeLogTicks = z.infer<typeof tradeLogTicksSchema>;

// One line of `trade-log export` (JSONL): one decision. `ticks` is null for a decision without a
// decision_ticks row (not a candidate, not captured yet, or past the capture horizon).
export const tradeLogLineSchema = z.strictObject({
  decision: tradeLogDecisionSchema,
  signal: z.union([storedSignalJournalEntrySchema, foreignSignalSchema]),
  session: tradeLogSessionSchema.nullable(),
  trade: tradeLogTradeSchema.nullable(),
  ticks: tradeLogTicksSchema.nullable(),
});
export type TradeLogLine = z.infer<typeof tradeLogLineSchema>;

// One element of `trade-log export --format trades-json`: the stand's calibrate input (its first
// ten fields are the #381 export's), only for a closed broker trade. z.object: an older file with
// fewer or more keys still reads.
export const tradeLogTradeJsonSchema = z.object({
  trading_session_id: z.string(),
  asset_id: z.int(),
  action: tradeActionSchema,
  duration_sec: z.int().positive(),
  created_at_ms: z.number(),
  open_timestamp_ms: z.number(),
  open_price: z.number(),
  close_timestamp_ms: z.number(),
  close_price: z.number(),
  profit: z.string().regex(/^-?\d+(\.\d+)?$/),
  submitted_at_ms: z.number().nullable().optional(),
  payout: z.number().optional(),
  intent_id: z.string().optional(),
  decision_id: z.string().optional(),
  mode: tradeModeSchema.optional(),
  amount: z.string().optional(),
});
export type TradeLogTradeJson = z.infer<typeof tradeLogTradeJsonSchema>;
