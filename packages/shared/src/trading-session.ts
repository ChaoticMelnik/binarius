import * as z from 'zod';
import { decimalScale, DEMO_STAKE_MIN_SCALE, DemoStakeRefusal } from './demo-stake';
import { decimalStringSchema, normalizeDecimal, type DecimalString } from './money';
import {
  createTradeIntentRequestSchema,
  TRADE_INTENT_TRANSITIONS,
  telegramUserIdSchema,
  tradeAmountSchema,
  tradeIntentViewSchema,
  tradeModeSchema,
} from './trading';

// trading_sessions.settings, version 1 (docs/trading-session.md -> Settings). The column is
// checked at read, not at write: a row written by hand is a boundary too.
export const TRADING_SESSION_SETTINGS_VERSION = 1;
export const MAX_SESSION_TRADES = 20;
// the CLI's and the start route's default; the schema itself requires the field
export const DEFAULT_SESSION_TRADES = 5;
const MAX_STAKE_SCALE = 8;

export const tradingSessionSettingsSchema = z.strictObject({
  version: z.literal(TRADING_SESSION_SETTINGS_VERSION),
  assetId: createTradeIntentRequestSchema.shape.assetId,
  durationSec: createTradeIntentRequestSchema.shape.durationSec,
  trades: z.int().min(1).max(MAX_SESSION_TRADES),
  // the fixed strategy only (Rule 23): the orchestrator builds { strategy: 'fixed', ...stake }
  stake: z.strictObject({
    baseStake: tradeAmountSchema,
    stakeScale: z.int().min(0).max(MAX_STAKE_SCALE),
  }),
});
export type TradingSessionSettings = z.infer<typeof tradingSessionSettingsSchema>;

export const safeParseTradingSessionSettings = (input: unknown) =>
  tradingSessionSettingsSchema.safeParse(input);

export const TradingSessionStatus = {
  Active: 'active',
  Paused: 'paused',
  Stopped: 'stopped',
} as const;
export type TradingSessionStatus = (typeof TradingSessionStatus)[keyof typeof TradingSessionStatus];
export const tradingSessionStatusSchema = z.enum(TradingSessionStatus);

export const TradingSessionStopReason = {
  // settled trades reached settings.trades
  Completed: 'completed',
  // an intent of the session is in manual_review, or the account is halted
  ManualReview: 'manual_review',
  // the last two intents of the session are rejected
  RejectedTwice: 'rejected_twice',
  // started_at + the maximum duration passed, on the database clock
  Timeout: 'timeout',
  // the stake sizer answered stop; its code is in the log line
  StakeStop: 'stake_stop',
  // the intent creation refused for a durable reason; the code is in the log line
  AccountUnavailable: 'account_unavailable',
  // the pair left the catalog or refuses the duration
  PairUnavailable: 'pair_unavailable',
  // no balance snapshot row for the account
  BalanceUnavailable: 'balance_unavailable',
  // settings fail the schema or the sizer's parameter rules
  InvalidSettings: 'invalid_settings',
  // the stop routes of #283 and #122; nothing in the worker writes it
  UserStopped: 'user_stopped',
  // the global trading switch is closed (#144, stopPausedSessions)
  KillSwitch: 'kill_switch',
} as const;
export type TradingSessionStopReason =
  (typeof TradingSessionStopReason)[keyof typeof TradingSessionStopReason];

export const tradingSessionStopReasonSchema = z.enum(TradingSessionStopReason);

// The fixed stake of a session from the account's min_trade_amount: the canonical spelling
// (normalizeDecimal) and its own fraction length as the scale, so every positive numeric(20,8)
// minimum passes assertStakeParams. A minimum of 0 gives baseStake '0', which settings v1 refuse:
// the start route answers balance_unavailable and the CLI zero_min_trade_amount (#130 n1).
export function stakeSettingsFor(minTradeAmount: DecimalString): {
  baseStake: DecimalString;
  stakeScale: number;
} {
  const canonical = normalizeDecimal(minTradeAmount);
  const [, fraction = ''] = canonical.split('.');
  return { baseStake: decimalStringSchema.parse(canonical), stakeScale: fraction.length };
}

// The session's stake from the user's saved demo stake (#297). NULL keeps stakeSettingsFor's
// answer exactly; a saved stake also widens the scale by its own fraction length, so a stake
// saved under a finer minimum stays on the grid that settings v1 and the sizer use.
export function demoStakeSettings(
  demoStake: DecimalString | null,
  minTradeAmount: DecimalString,
): { baseStake: DecimalString; stakeScale: number } {
  if (demoStake === null) return stakeSettingsFor(minTradeAmount);
  return {
    baseStake: decimalStringSchema.parse(normalizeDecimal(demoStake)),
    stakeScale: Math.max(
      DEMO_STAKE_MIN_SCALE,
      decimalScale(minTradeAmount),
      decimalScale(demoStake),
    ),
  };
}

// The worker's deadline for a session (started_at + this, on the database clock) and the start
// route's refusal of a session that cannot fit it (docs/trading-session.md -> Routes).
export const SESSION_MAX_DURATION_MS = 3_600_000;
// per trade on top of its duration: with no close event a trade settles CATCHUP_GRACE_MS (10 s)
// to + CATCHUP_TICK_MS (5 s) after its close, and a held-back attempt adds up to
// CATCHUP_STALLED_RETRY_MS (30 s); 120 keeps room (stated: shared cannot import the worker)
export const SESSION_SETTLE_SLACK_SEC = 120;

export const sessionFitsDeadline = (trades: number, durationSec: number): boolean =>
  trades * (durationSec + SESSION_SETTLE_SLACK_SEC) * 1000 <= SESSION_MAX_DURATION_MS;

// upper estimate of POST /trading/sessions: one bounded broker balance request plus statements;
// the bot's request timeout must not be shorter (#284)
export const TRADING_SESSION_START_BUDGET_MS = 4_000;
// upper estimate of GET /trading/sessions/:id, POST /trading/sessions/:id/stop and
// POST /trading/sessions/stop: one bounded broker balance request for a finished session plus
// statements (#337); the stop of all reads its sessions in parallel, one request per account (#122)
export const TRADING_SESSION_VIEW_BUDGET_MS = 4_000;

export const TRADING_SESSIONS_PATH = '/trading/sessions';
// every active session of the user (#122); a uuid never equals 'stop', so the id routes keep theirs
export const TRADING_SESSIONS_STOP_PATH = `${TRADING_SESSIONS_PATH}/stop`;

export const TradingSessionErrorCode = {
  UserNotFound: 'user_not_found',
  BrokerAccountNotFound: 'broker_account_not_found',
  AmbiguousBrokerAccount: 'ambiguous_broker_account',
  AccountNotConfirmed: 'account_not_confirmed',
  AccountRevoked: 'account_revoked',
  AccountHalted: 'account_halted',
  UserBlocked: 'user_blocked',
  InsufficientTokens: 'insufficient_tokens',
  // the global trading switch is closed (#144, docs/kill-switch.md)
  TradingPaused: 'trading_paused',
  // sessions are demo only until #327: createTradingSession refuses a non-demo session, and the
  // start route refuses a user whose trading mode is real (#121, checkTradingSessionStart)
  ModeNotAllowed: 'mode_not_allowed',
  // a real session on a DEMO_ONLY process (#396), before mode_not_allowed
  DemoOnly: 'demo_only',
  ActiveSessionExists: 'active_session_exists',
  SessionTooLong: 'session_too_long',
  BalanceUnavailable: 'balance_unavailable',
  PairUnavailable: 'pair_unavailable',
  // the pair pays less than MIN_CYCLE_PAYOUT_PCT (#379)
  PayoutTooLow: 'payout_too_low',
  // the string of PairsCatalogErrorCode.Unavailable: the same cache answers both routes
  CatalogUnavailable: 'catalog_unavailable',
  NotFound: 'not_found',
  SessionNotActive: 'session_not_active',
  // the session's stake against the account's snapshot (#297, checkDemoStake)
  StakePrecision: DemoStakeRefusal.Precision,
  StakeBelowMinimum: DemoStakeRefusal.BelowMinimum,
  InsufficientDemoBalance: DemoStakeRefusal.AboveAvailable,
} as const;
export type TradingSessionErrorCode =
  (typeof TradingSessionErrorCode)[keyof typeof TradingSessionErrorCode];

export const createTradingSessionRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
  brokerAccountId: z.uuid().optional(),
  assetId: tradingSessionSettingsSchema.shape.assetId,
  durationSec: tradingSessionSettingsSchema.shape.durationSec,
  trades: tradingSessionSettingsSchema.shape.trades.default(DEFAULT_SESSION_TRADES),
});
export type CreateTradingSessionRequest = z.infer<typeof createTradingSessionRequestSchema>;

export const readTradingSessionQuerySchema = z.object({ telegramUserId: telegramUserIdSchema });
// the body of both stop routes: one session by id, and all of the user's (#122)
export const stopTradingSessionRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
});

const countSchema = z.int().min(0);

// won/lost/tied by the sign of the linked broker trade's profit
export const tradingSessionTradesSchema = z.strictObject({
  planned: countSchema,
  settled: countSchema,
  rejected: countSchema,
  won: countSchema,
  lost: countSchema,
  tied: countSchema,
  // the sum of the settled trades' profit, by SQL at scale 8 (#337); '0.00000000' with none
  profit: decimalStringSchema,
});

// The account's balance in the session's mode, as stored (#337): ageSec of the newest
// observation, current when no settlement of the session is newer than it
export const tradingSessionBalanceSchema = z.strictObject({
  available: decimalStringSchema,
  ageSec: z.int().nonnegative(),
  current: z.boolean(),
});

export const tradingSessionViewSchema = z.strictObject({
  id: z.uuid(),
  mode: tradeModeSchema,
  status: tradingSessionStatusSchema,
  stopReason: tradingSessionStopReasonSchema.nullable(),
  // null only for a row whose settings fail v1, which only a hand-written row can
  settings: tradingSessionSettingsSchema.nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  trades: tradingSessionTradesSchema,
  lastIntent: tradeIntentViewSchema.nullable(),
  // null while the account has no snapshot
  balance: tradingSessionBalanceSchema.nullable(),
});
export type TradingSessionView = z.infer<typeof tradingSessionViewSchema>;

// Nothing of the session can move any more: stopped, and its last trade has no edge left in the
// shared graph. The backend refreshes the balance for such a view and the bot stops following it
// (#337); a last trade in manual_review keeps edges, so such a session is not finished.
export const isTradingSessionFinished = (
  view: Pick<TradingSessionView, 'status' | 'lastIntent'>,
): boolean =>
  view.status === TradingSessionStatus.Stopped &&
  (view.lastIntent === null || TRADE_INTENT_TRANSITIONS[view.lastIntent.status].length === 0);

export const tradingSessionResponseSchema = z.strictObject({ session: tradingSessionViewSchema });
export type TradingSessionResponse = z.infer<typeof tradingSessionResponseSchema>;

// the sessions POST /trading/sessions/stop stopped; an empty list is an answer, not a refusal
export const tradingSessionsStoppedResponseSchema = z.strictObject({
  sessions: z.array(tradingSessionViewSchema),
});
export type TradingSessionsStoppedResponse = z.infer<typeof tradingSessionsStoppedResponseSchema>;

const { ActiveSessionExists, ...plainRefusals } = TradingSessionErrorCode;

// active_session_exists carries the account's active session, so a retry after a timeout learns
// what the first request created; null when that session ended before it was read
export const tradingSessionRefusalSchema = z.union([
  z.strictObject({
    error: z.literal(ActiveSessionExists),
    session: tradingSessionViewSchema.nullable(),
  }),
  z.strictObject({ error: z.enum(plainRefusals) }),
]);
export type TradingSessionRefusal = z.infer<typeof tradingSessionRefusalSchema>;

export const safeParseCreateTradingSessionRequest = (input: unknown) =>
  createTradingSessionRequestSchema.safeParse(input);
export const safeParseReadTradingSessionQuery = (input: unknown) =>
  readTradingSessionQuerySchema.safeParse(input);
export const safeParseStopTradingSessionRequest = (input: unknown) =>
  stopTradingSessionRequestSchema.safeParse(input);
export const safeParseTradingSessionResponse = (input: unknown) =>
  tradingSessionResponseSchema.safeParse(input);
export const safeParseTradingSessionsStoppedResponse = (input: unknown) =>
  tradingSessionsStoppedResponseSchema.safeParse(input);
export const safeParseTradingSessionRefusal = (input: unknown) =>
  tradingSessionRefusalSchema.safeParse(input);

// POST /trading/sessions/:id/summary (#318): the finished session's card, claimed at most once.
// The request body is stopTradingSessionRequestSchema's. Its own code, not a TradingSessionErrorCode:
// every refusal of the claim is one answer, and the bot's action on it is one (no card).
export const SESSION_SUMMARY_SUFFIX = '/summary';

export const SessionSummaryErrorCode = { Unavailable: 'summary_unavailable' } as const;
export type SessionSummaryErrorCode =
  (typeof SessionSummaryErrorCode)[keyof typeof SessionSummaryErrorCode];

// A settled trade of the session in creation order. profit is the broker trade's (Rule 2); the
// prices are not money and only place the card's line.
export const sessionSummaryTradeSchema = z.strictObject({
  profit: decimalStringSchema,
  // zod 4 refuses Infinity and NaN in z.number()
  openPrice: z.number(),
  closePrice: z.number(),
});

// result is the sum of the trades' profit by SQL at scale 8, the view's own fragment
export const sessionSummarySchema = z.strictObject({
  result: decimalStringSchema,
  trades: z.array(sessionSummaryTradeSchema).min(1).max(MAX_SESSION_TRADES),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionSummaryResponseSchema = z.strictObject({ summary: sessionSummarySchema });
export type SessionSummaryResponse = z.infer<typeof sessionSummaryResponseSchema>;

export const sessionSummaryRefusalSchema = z.strictObject({
  error: z.literal(SessionSummaryErrorCode.Unavailable),
});
export type SessionSummaryRefusal = z.infer<typeof sessionSummaryRefusalSchema>;

export const safeParseSessionSummaryResponse = (input: unknown) =>
  sessionSummaryResponseSchema.safeParse(input);
export const safeParseSessionSummaryRefusal = (input: unknown) =>
  sessionSummaryRefusalSchema.safeParse(input);
