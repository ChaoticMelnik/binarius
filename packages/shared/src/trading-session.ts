import { botLanguageSchema } from './bot-language';
import * as z from 'zod';
import { pairViewSchema } from './catalog';
import { REFERRAL_CODE_PATTERN } from './referral';
import { SessionStakeStrategy } from './session-steps';
import {
  intervalForDuration,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SHORTEST_INTERVAL_MS,
} from './signal';
import { multiplyDecimal, StakeRefusal, stakeScale } from './stake';
import { decimalStringSchema, normalizeDecimal, type DecimalString } from './money';
import {
  createTradeIntentRequestSchema,
  INT4_MAX,
  TRADE_INTENT_TRANSITIONS,
  telegramUserIdSchema,
  tradeActionSchema,
  tradeAmountSchema,
  tradeIntentViewSchema,
  tradeModeSchema,
} from './trading';

// trading_sessions.settings (docs/trading-session.md -> Settings). The column is checked at read,
// not at write: a row written by hand is a boundary too. Version 3 is the only one written
// (#552): its length is in cycles. A version 1 or 2 row keeps its length in trades
// (sessionProgress); a version 1 row reads as the fixed strategy (sessionStakeParams).
export const TRADING_SESSION_SETTINGS_VERSION = 3;
export const MAX_SESSION_CYCLES = 20;
// the CLI's and the start route's default; the schema itself requires the field
export const DEFAULT_SESSION_CYCLES = 5;
// A session's trade is no shorter than the shortest candle its signal is decided on (#552): a
// shorter trade has no signal of its own. It also bounds the trades an hour can hold
// (MAX_SESSION_SUMMARY_TRADES).
export const MIN_SESSION_DURATION_SEC = SIGNAL_SHORTEST_INTERVAL_MS / 1000;
const MAX_STAKE_SCALE = 8;

const sessionSettingsFields = {
  assetId: createTradeIntentRequestSchema.shape.assetId,
  durationSec: createTradeIntentRequestSchema.shape.durationSec.min(MIN_SESSION_DURATION_SEC),
};
// v1/v2 rows were written with at most 20 trades (the bound before #552)
const sessionTradesField = z.int().min(1).max(20);
const sessionCyclesField = z.int().min(1).max(MAX_SESSION_CYCLES);

const stakeFields = {
  baseStake: tradeAmountSchema,
  stakeScale: z.int().min(0).max(MAX_STAKE_SCALE),
};

// the rules against baseStake are the worker's assertStakeParams (apps/trading-worker/src/stake/
// config.ts), which planSessionStart and the orchestrator run
export const martingaleLimitsSchema = z.strictObject({
  maxSteps: z.int().min(2),
  maxStake: tradeAmountSchema,
  // the sizer parses every limit inside numeric(20,8) (parseAmount); a larger one fails here, at
  // the writer, rather than as invalid_settings on the session's first attempt
  maxSessionLoss: tradeAmountSchema,
  maxSessionDurationMs: z.int().min(1),
});
export type MartingaleLimits = z.infer<typeof martingaleLimitsSchema>;

const settingsV1Schema = z.strictObject({
  version: z.literal(1),
  ...sessionSettingsFields,
  trades: sessionTradesField,
  stake: z.strictObject(stakeFields),
});

const strategyStakeSchema = z.discriminatedUnion('strategy', [
  z.strictObject({ strategy: z.literal(SessionStakeStrategy.Fixed), ...stakeFields }),
  z.strictObject({
    strategy: z.literal(SessionStakeStrategy.Martingale),
    ...stakeFields,
    limits: martingaleLimitsSchema,
  }),
]);

const settingsV2Schema = z.strictObject({
  version: z.literal(2),
  ...sessionSettingsFields,
  trades: sessionTradesField,
  stake: strategyStakeSchema,
});

const settingsV3Schema = z.strictObject({
  version: z.literal(3),
  ...sessionSettingsFields,
  cycles: sessionCyclesField,
  stake: strategyStakeSchema,
});

export const tradingSessionSettingsSchema = z.discriminatedUnion('version', [
  settingsV1Schema,
  settingsV2Schema,
  settingsV3Schema,
]);
export type TradingSessionSettings = z.infer<typeof tradingSessionSettingsSchema>;

// The session's stake strategy and its parameters, frozen in its row at the start: v1 is fixed.
// The worker's sizer takes this shape (StakeParams); every reader of the strategy goes through it.
export type SessionStakeParams = z.infer<typeof strategyStakeSchema>;
export function sessionStakeParams(settings: TradingSessionSettings): SessionStakeParams {
  if (settings.version === 1) return { strategy: SessionStakeStrategy.Fixed, ...settings.stake };
  return settings.stake;
}

// The session's length and how much of it is done (#552; docs/trading-session.md -> The
// attempt): the session completes when done reaches planned. A v1/v2 row counts settled trades
// against settings.trades, as it did. A v3 row counts cycles: under fixed every settled trade is
// a cycle; under martingale only a win closes one (readHistory in apps/trading-worker/src/stake/
// size.ts, sessionTradeSteps), so a loss or a tie never ends the session mid-series.
export function sessionProgress(
  settings: TradingSessionSettings,
  counts: { settled: number; won: number },
): { planned: number; done: number } {
  if (settings.version !== 3) return { planned: settings.trades, done: counts.settled };
  const done =
    settings.stake.strategy === SessionStakeStrategy.Martingale ? counts.won : counts.settled;
  return { planned: settings.cycles, done };
}

// The default martingale limits from the session's base stake B (#450; docs/stake.md -> Defaults):
// at most three raises in a row, one stake at most 12×B, the session's loss at most 20×B, the
// session's hour. 12× rather than the owner's «~10×» lets the fourth stake through at every
// payout from the start's 80 % floor; 10n here brings the owner's figure back.
export const MARTINGALE_MAX_STEPS = 4;
export const MARTINGALE_MAX_STAKE_MULTIPLIER = 12n;
export const MARTINGALE_MAX_SESSION_LOSS_MULTIPLIER = 20n;
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
  // the session's last cycle closed (sessionProgress): settings.cycles, or settings.trades of v1/v2
  Completed: 'completed',
  // an intent of the session is in manual_review, or the account is halted
  ManualReview: 'manual_review',
  // the last two intents of the session are rejected
  RejectedTwice: 'rejected_twice',
  // started_at + the maximum duration passed, on the database clock
  Timeout: 'timeout',
  // the stake sizer answered stop with a code other than the four below; the code is in the log
  // line
  StakeStop: 'stake_stop',
  // the martingale limits of the session's settings (#450): the sizer's codes of the same name
  MaxStepsExceeded: 'max_steps_exceeded',
  MaxStakeExceeded: 'max_stake_exceeded',
  MaxSessionLossExceeded: 'max_session_loss_exceeded',
  // the sizer's maxSessionDurationMs on the worker's clock; the database clock's timeout above
  // usually ends the session first
  SessionDurationExceeded: 'session_duration_exceeded',
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
  // SESSION_NO_SIGNAL_CANDLES candles of the session's signal interval (#637) since the later of
  // started_at and the session's last intent change, on the database clock, while the session
  // waited for a signal (#509)
  NoSignalTimeout: 'no_signal_timeout',
} as const;
export type TradingSessionStopReason =
  (typeof TradingSessionStopReason)[keyof typeof TradingSessionStopReason];

export const tradingSessionStopReasonSchema = z.enum(TradingSessionStopReason);

// The fixed stake of a session from the account's min_trade_amount: the canonical spelling
// (normalizeDecimal) and its own fraction length as the scale, so every positive numeric(20,8)
// minimum passes assertStakeParams. A minimum of 0 gives baseStake '0', which the settings refuse:
// the start route answers balance_unavailable and the CLI zero_min_trade_amount (#130 n1).
export function stakeSettingsFor(minTradeAmount: DecimalString): {
  baseStake: DecimalString;
  stakeScale: number;
} {
  const canonical = normalizeDecimal(minTradeAmount);
  const [, fraction = ''] = canonical.split('.');
  return { baseStake: decimalStringSchema.parse(canonical), stakeScale: fraction.length };
}

// The session's stake from the user's saved stake of the session's mode (#297, #326). NULL keeps
// stakeSettingsFor's answer exactly; a saved stake takes the minimum's grid (stakeScale). The
// caller ran checkStake against the same minimum first (the start route's step 6a before 6), so
// a saved stake never has more fraction digits than that grid.
export function stakeSettingsFrom(
  stake: DecimalString | null,
  minTradeAmount: DecimalString,
): { baseStake: DecimalString; stakeScale: number } {
  if (stake === null) return stakeSettingsFor(minTradeAmount);
  return {
    baseStake: decimalStringSchema.parse(normalizeDecimal(stake)),
    stakeScale: stakeScale(minTradeAmount),
  };
}

// The worker's deadline for a session (started_at + this, on the database clock) and the start
// route's refusal of a session that cannot fit it (docs/trading-session.md -> Routes).
export const SESSION_MAX_DURATION_MS = 3_600_000;
// per trade on top of its duration: with no close event a trade settles CATCHUP_GRACE_MS (10 s)
// to + CATCHUP_TICK_MS (5 s) after its close, and a held-back attempt adds up to
// CATCHUP_STALLED_RETRY_MS (30 s); 120 keeps room (stated: shared cannot import the worker)
export const SESSION_SETTLE_SLACK_SEC = 120;

export const martingaleLimitsFor = (baseStake: DecimalString): MartingaleLimits => ({
  maxSteps: MARTINGALE_MAX_STEPS,
  maxStake: multiplyDecimal(baseStake, MARTINGALE_MAX_STAKE_MULTIPLIER),
  maxSessionLoss: multiplyDecimal(baseStake, MARTINGALE_MAX_SESSION_LOSS_MULTIPLIER),
  maxSessionDurationMs: SESSION_MAX_DURATION_MS,
});

// The settings both writers store (the start route and the session-start CLI): v3 with the
// strategy of the process (SESSION_STAKE_STRATEGY) and, for martingale, the default limits. A
// stake the schema refuses (a zero minimum, a limit outside numeric(20,8)) is the caller's refusal.
export function buildSessionSettings(input: {
  assetId: number;
  durationSec: number;
  cycles: number;
  stake: { baseStake: DecimalString; stakeScale: number };
  strategy: SessionStakeStrategy;
}) {
  const { strategy, stake } = input;
  return tradingSessionSettingsSchema.safeParse({
    version: TRADING_SESSION_SETTINGS_VERSION,
    assetId: input.assetId,
    durationSec: input.durationSec,
    cycles: input.cycles,
    stake:
      strategy === SessionStakeStrategy.Martingale
        ? { strategy, ...stake, limits: martingaleLimitsFor(stake.baseStake) }
        : { strategy, ...stake },
  });
}

// A session that waits this many candles of its signal interval for a signal stops with
// no_signal_timeout (#509; in candles since #637, owner 2026-10-18): counted from the later of
// started_at and its last intent's change, on the database clock
export const SESSION_NO_SIGNAL_CANDLES = 20;

export function sessionSignalCandleMs(durationSec: number): number {
  return SIGNAL_CHART_INTERVAL_MS[intervalForDuration(durationSec)];
}

export function sessionNoSignalTimeoutMs(
  durationSec: number,
  candles: number = SESSION_NO_SIGNAL_CANDLES,
): number {
  return candles * sessionSignalCandleMs(durationSec);
}

// The start's refusal of a session whose worst case cannot fit the hour (#552): under martingale a
// cycle takes up to MARTINGALE_MAX_STEPS trades (the default limits' maxSteps), under fixed one.
// Ties add trades beyond it that nothing bounds; such a session ends with timeout.
export function sessionFitsDeadline(
  cycles: number,
  durationSec: number,
  strategy: SessionStakeStrategy,
): boolean {
  const stepsPerCycle = strategy === SessionStakeStrategy.Martingale ? MARTINGALE_MAX_STEPS : 1;
  return (
    cycles * stepsPerCycle * (durationSec + SESSION_SETTLE_SLACK_SEC) * 1000 <=
    SESSION_MAX_DURATION_MS
  );
}

// The most settled trades one session can hold (#552): its intents run one at a time, each settles
// no earlier than its duration after it opened, and the hour ends the session. The summary's trades
// and the card's columns are bounded by it.
export const MAX_SESSION_SUMMARY_TRADES =
  SESSION_MAX_DURATION_MS / (MIN_SESSION_DURATION_SEC * 1000);
if (!Number.isInteger(MAX_SESSION_SUMMARY_TRADES)) {
  throw new Error('MAX_SESSION_SUMMARY_TRADES must be an integer');
}

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
  // the request's mode is not the user's trading mode (#327): the start route's pre-check
  // (checkTradingSessionStart) and createTradingSession under the users lock
  ModeNotAllowed: 'mode_not_allowed',
  // a real session on a DEMO_ONLY process (#396): createTradingSession refuses it before its
  // transaction, so before mode_not_allowed of the lock
  DemoOnly: 'demo_only',
  ActiveSessionExists: 'active_session_exists',
  SessionTooLong: 'session_too_long',
  BalanceUnavailable: 'balance_unavailable',
  PairUnavailable: 'pair_unavailable',
  // the string of PairsCatalogErrorCode.Unavailable: the same cache answers both routes
  CatalogUnavailable: 'catalog_unavailable',
  // the pair's signal on the current candle is no_signal (#509): no session starts on it
  NoSignal: 'no_signal',
  // the signal could not be read (broker failure, rate limit): the start refuses, never opens
  SignalUnavailable: 'signal_unavailable',
  NotFound: 'not_found',
  SessionNotActive: 'session_not_active',
  // the session's stake against the account's snapshot (#297, checkStake)
  StakePrecision: StakeRefusal.Precision,
  StakeBelowMinimum: StakeRefusal.BelowMinimum,
  InsufficientBalance: StakeRefusal.AboveAvailable,
} as const;
export type TradingSessionErrorCode =
  (typeof TradingSessionErrorCode)[keyof typeof TradingSessionErrorCode];

export const createTradingSessionRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
  brokerAccountId: z.uuid().optional(),
  // required (#327): the bot's button carries the mode it was drawn in
  mode: tradeModeSchema,
  assetId: sessionSettingsFields.assetId,
  durationSec: sessionSettingsFields.durationSec,
  cycles: sessionCyclesField.default(DEFAULT_SESSION_CYCLES),
});
export type CreateTradingSessionRequest = z.infer<typeof createTradingSessionRequestSchema>;

export const readTradingSessionQuerySchema = z.object({ telegramUserId: telegramUserIdSchema });
// the body of POST /trading/sessions/stop (all of the user's, #122) and of the summary claim
export const stopTradingSessionRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
});

// A Telegram message id as trading_sessions stores it (integer, CHECK > 0): an id past the bound
// is a 400, not a 500.
const telegramMessageIdSchema = z.int().min(1).max(INT4_MAX);

// POST /trading/sessions/:id/stop: waitingMessageId is the waiting message whose «⏹» was pressed
// (#587). The stop hands it to the bot: the route clears it in the stop's own UPDATE when it is
// the one recorded, and the bot draws its reply in place of that message.
export const stopOneTradingSessionRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
  waitingMessageId: telegramMessageIdSchema.optional(),
});
export type StopOneTradingSessionRequest = z.infer<typeof stopOneTradingSessionRequestSchema>;

const countSchema = z.int().min(0);

// won/lost/tied by the sign of the linked broker trade's profit
export const tradingSessionTradesSchema = z.strictObject({
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
  // null only for a row whose settings fail every version, which only a hand-written row can
  settings: tradingSessionSettingsSchema.nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  trades: tradingSessionTradesSchema,
  // the session's length and its closed cycles (sessionProgress); a v1/v2 row counts its trades,
  // settings that do not read give 0 and 0
  cycles: z.strictObject({ planned: countSchema, closed: countSchema }),
  lastIntent: tradeIntentViewSchema.nullable(),
  // the direction of the bot's session picture (#568): the last intent's, else the signal the
  // start route checked; null on a session without a trade yet that was started before #568 or by
  // the CLI session-start, which checks no signal
  signalAction: tradeActionSchema.nullable(),
  // null while the account has no snapshot
  balance: tradingSessionBalanceSchema.nullable(),
  // the backend's summary message of the session went out (#464): the bot's card waits for it
  noticesDone: z.boolean(),
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
export const safeParseStopOneTradingSessionRequest = (input: unknown) =>
  stopOneTradingSessionRequestSchema.safeParse(input);
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
  trades: z.array(sessionSummaryTradeSchema).min(1).max(MAX_SESSION_SUMMARY_TRADES),
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

// POST /trading/sessions/:id/status-message (#567, docs/bot-session.md → Recovery after a
// restart): the bot's first poll of a status message records its id, the newest id wins (#587:
// message ids grow within a chat, so a relaunch's message replaces the first one); the answer is
// the view GET /trading/sessions/:id gives.
export const SESSION_STATUS_MESSAGE_SUFFIX = '/status-message';

export const recordSessionStatusMessageRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
  messageId: telegramMessageIdSchema,
});
export type RecordSessionStatusMessageRequest = z.infer<
  typeof recordSessionStatusMessageRequestSchema
>;

// POST /trading/sessions/:id/status-message/lost (#567): Telegram refused an edit of the recorded
// message for good (gone or 403), so the bot has the backend forget it, by the same id: a message
// recorded after it stays. The body names the lost message; false when nothing was forgotten.
export const SESSION_STATUS_MESSAGE_LOST_SUFFIX = `${SESSION_STATUS_MESSAGE_SUFFIX}/lost`;

export const forgetSessionStatusMessageRequestSchema = z.strictObject({
  telegramUserId: telegramUserIdSchema,
  messageId: telegramMessageIdSchema,
});
export type ForgetSessionStatusMessageRequest = z.infer<
  typeof forgetSessionStatusMessageRequestSchema
>;

export const forgetSessionStatusMessageResponseSchema = z.strictObject({ forgotten: z.boolean() });
export type ForgetSessionStatusMessageResponse = z.infer<
  typeof forgetSessionStatusMessageResponseSchema
>;

// GET /trading/sessions/tracked (#567): the sessions the bot tracks again after a restart, oldest
// first, at most TRACKED_SESSIONS_MAX; a uuid never equals 'tracked', so /:id keeps its routes
export const TRADING_SESSIONS_TRACKED_PATH = `${TRADING_SESSIONS_PATH}/tracked`;
export const TRACKED_SESSIONS_MAX = 2_000;

export const trackedSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(TRACKED_SESSIONS_MAX).default(TRACKED_SESSIONS_MAX),
});

// telegramUserId is the owner's, the chat the message is in; assetId is null for settings that
// do not read
export const trackedSessionSchema = z.strictObject({
  id: z.uuid(),
  telegramUserId: telegramUserIdSchema,
  messageId: telegramMessageIdSchema,
  assetId: z.int().min(1).max(INT4_MAX).nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  // the owner's language of the bot's texts (#508): the recovered tracker edits in it
  language: botLanguageSchema,
});
export type TrackedSession = z.infer<typeof trackedSessionSchema>;

export const trackedSessionsResponseSchema = z.strictObject({
  sessions: z.array(trackedSessionSchema).max(TRACKED_SESSIONS_MAX),
});
export type TrackedSessionsResponse = z.infer<typeof trackedSessionsResponseSchema>;

export const safeParseRecordSessionStatusMessageRequest = (input: unknown) =>
  recordSessionStatusMessageRequestSchema.safeParse(input);
export const safeParseTrackedSessionsQuery = (input: unknown) =>
  trackedSessionsQuerySchema.safeParse(input);
export const safeParseTrackedSessionsResponse = (input: unknown) =>
  trackedSessionsResponseSchema.safeParse(input);
export const safeParseForgetSessionStatusMessageRequest = (input: unknown) =>
  forgetSessionStatusMessageRequestSchema.safeParse(input);
export const safeParseForgetSessionStatusMessageResponse = (input: unknown) =>
  forgetSessionStatusMessageResponseSchema.safeParse(input);

// POST /trading/sessions/:id/share (#538, docs/trading-session.md → Routes): what the shared promo
// card needs, in one call. The body is stopTradingSessionRequestSchema's. A POST because it creates
// the caller's referral code on first use, as /invite does; it writes nothing else.
export const SESSION_SHARE_SUFFIX = '/share';

// a settled trade as the summary has it, plus its direction for the card's badge
export const sessionShareTradeSchema = sessionSummaryTradeSchema.extend({
  action: tradeActionSchema,
});
export type SessionShareTrade = z.infer<typeof sessionShareTradeSchema>;

// the pair from the backend's catalog; digits place the price labels (Rule 20)
export const sessionSharePairSchema = z.strictObject(
  pairViewSchema.pick({ symbol: true, isOtc: true, digits: true }).shape,
);

// referralCode is null for a blocked user or one without a users row: the caption's link falls
// back to the plain share payload
export const sessionShareSchema = z.strictObject({
  session: tradingSessionViewSchema,
  trades: z.array(sessionShareTradeSchema).max(MAX_SESSION_SUMMARY_TRADES),
  pair: sessionSharePairSchema.nullable(),
  referralCode: z.string().regex(REFERRAL_CODE_PATTERN).nullable(),
});
export type SessionShare = z.infer<typeof sessionShareSchema>;

export const sessionShareResponseSchema = z.strictObject({ share: sessionShareSchema });
export type SessionShareResponse = z.infer<typeof sessionShareResponseSchema>;

export const safeParseSessionShareResponse = (input: unknown) =>
  sessionShareResponseSchema.safeParse(input);
