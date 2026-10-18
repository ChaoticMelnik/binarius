// Test-only fixtures and harness for this app's suites. Compiled by `tsc -b` alongside the
// *.test.ts files next to it and imported by no runtime module.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bot, HttpError } from 'grammy';
import type { ApiError, Update, User, UserFromGetMe } from 'grammy/types';
import { vi, type Mock } from 'vitest';
import type { BackendClient } from './backend-client';
import { stakeFingerprint } from './demo';
import type { IntentTracker } from './intent-tracker';
import type { SessionResumer } from './session-resume';
import type { SessionTracker } from './session-tracker';
import { createUserLanguages, type UserLanguages } from './language';
import { LABELS } from './texts';
import {
  BrokerAccountStatus,
  brokerBalanceViewSchema,
  decimalStringSchema,
  BrokerRestErrorCode,
  MacdCross,
  MomentumDirection,
  NoSignalReason,
  NotificationLevel,
  SignalFeedOutcome,
  SIGNAL_ALGORITHM_VERSION,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVALS,
  SignalKind,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  tradingSessionViewSchema,
  tradingSignalResponseSchema,
  TrendDirection,
  UserStatus,
  type BrokerBalanceView,
  type ConfirmLoginResponse,
  type EmailSendCodeResponse,
  type LinkedAccountView,
  type PairsCatalogResponse,
  type PairView,
  type SessionShare,
  type PendingLinkedAccountView,
  type ScanInterval,
  type SignalDecision,
  type SignalFeatures,
  type SignalIndicators,
  type SignalParams,
  type TradeIntentView,
  type TradingAccessResponse,
  type TradingSessionView,
  type TradingSignalResponse,
  type TradingSignalsResponse,
  type UserAccountView,
  type UserReferralView,
  type UserStartView,
  BOT_TEXT_CATALOG,
  BotTextKind,
  defaultBotTextSource,
  type BotTextKey,
  type BotTextSource,
  BotLanguage,
} from '@binarius/shared';
import { stripMessageSpacer } from '@binarius/shared/testing';

// A text source for the tests of the source swap (#240): the named keys read a marked text of
// their own kind, with every variable the key has; every other key its default.
export const stubText = (key: BotTextKey): string => {
  const entry = BOT_TEXT_CATALOG[key];
  const marked = [`ЗАГЛУШКА ${key}`, ...entry.vars.map((name) => `{${name}}`)].join(' ');
  return entry.kind === BotTextKind.Html ? `<b>${marked}</b>` : marked;
};
export const stubTextSource = (...keys: BotTextKey[]): BotTextSource<BotTextKey> => ({
  sourceOf: (key) => (keys.includes(key) ? stubText(key) : defaultBotTextSource.sourceOf(key)),
});

// «💳 Пополнить»'s page in the tests (#27): an https origin's cashierUrlOf
export const CASHIER_URL = 'https://web.example/cashier';

export const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Binarius',
  username: 'binarius_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export const USER: User = { id: 4242, is_bot: false, first_name: 'Ada', last_name: 'Lovelace' };

export const USER_VIEW: UserStartView = {
  telegramUserId: String(USER.id),
  status: UserStatus.Active,
  acquisitionSource: null,
  acquiredAt: null,
  hasActiveBrokerAccount: false,
  pendingBrokerAccounts: [],
  notificationLevel: NotificationLevel.All,
  demoStake: null,
  realStake: null,
  language: BotLanguage.Ru,
};

export const userView = (patch: Partial<UserStartView> = {}): UserStartView => ({
  ...USER_VIEW,
  ...patch,
});

export const PENDING_ACCOUNT_ID = '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01';

// Seven, not the real pack size: a bot that printed its own number instead of the backend's
// would show up as a mismatch.
export const CONFIRMED: ConfirmLoginResponse = {
  account: {
    id: PENDING_ACCOUNT_ID,
    brokerUserId: '101962',
    email: 'ada@example.test',
    isPartnerClient: true,
    status: BrokerAccountStatus.Active,
    createdAt: '2026-10-01T09:28:00.000Z',
  },
  grant: { granted: true, tokens: '7' },
};

// /account (#185): one link of each status, and a user with none
export const LINK_ACTIVE: LinkedAccountView = {
  status: BrokerAccountStatus.Active,
  email: 'ada@example.test',
};
export const LINK_PENDING: PendingLinkedAccountView = {
  status: BrokerAccountStatus.Pending,
  id: PENDING_ACCOUNT_ID,
  email: 'new@example.test',
};
export const LINK_REVOKED: LinkedAccountView = {
  status: BrokerAccountStatus.Revoked,
  email: 'old@example.test',
};
export const ACCOUNT_VIEW: UserAccountView = { status: UserStatus.Active, accounts: [] };
// the /invite read (#115)
export const REFERRAL_VIEW: UserReferralView = {
  status: UserStatus.Active,
  code: 'AbC123xY',
  invited: 2,
  connected: 1,
  tokensEarned: '1050',
};
export const accountView = (patch: Partial<UserAccountView> = {}): UserAccountView => ({
  ...ACCOUNT_VIEW,
  ...patch,
});

// The status card (#24): a fresh snapshot of a demo-only account. Amounts are the wire's decimal
// strings with all eight fraction digits, as the route sends them.
export const BROKER_BALANCE: BrokerBalanceView = brokerBalanceViewSchema.parse({
  real: { available: '0.00000000', held: '0.00000000', total: '0.00000000' },
  demo: { available: '10000.00000000', held: '0.00000000', total: '10000.00000000' },
  minTradeAmount: '1.00000000',
  level: { code: 'standard', rank: 1 },
  restSnapshotAgeSec: 5,
  balanceEventAgeSec: null,
  fresh: true,
});
export const brokerBalance = (patch: Partial<BrokerBalanceView> = {}): BrokerBalanceView => ({
  ...BROKER_BALANCE,
  ...patch,
});
export const ACCESS_VIEW: TradingAccessResponse = {
  status: UserStatus.Active,
  tokens: { balance: '5', reserved: '0', available: '5' },
  broker: BROKER_BALANCE,
  brokerUnavailable: null,
  tradingOpen: true,
  demoStake: null,
  realStake: null,
  tradingMode: TradeMode.Demo,
};
export const accessView = (patch: Partial<TradingAccessResponse> = {}): TradingAccessResponse => ({
  ...ACCESS_VIEW,
  ...patch,
});

// The demo's catalog (#125). PAIR_CLOSED is closed on any clock a test runs at (2100-01-01), so
// a suite on the real clock sees it closed too; the others have no schedule. PAIR_MINUTE_ONLY
// accepts no demo duration (#313: 5 and 15 s) and is never listed.
export const PAIR_EURUSD: PairView = {
  id: 101,
  symbol: 'EUR/USD',
  isOtc: true,
  type: 'currency',
  digits: 5,
  payout: 85,
  maxPayout: 92,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};
// PAIR_EURUSD's regular twin (#428): the live catalog lists a symbol twice, OTC by is_otc only,
// and omits the field on a regular pair. The twins share the label (#631) and go by id, the OTC
// one first. Only in the catalogs of the tests that name it.
export const PAIR_EURUSD_REGULAR: PairView = {
  id: 707,
  symbol: 'EUR/USD',
  type: 'currency',
  digits: 5,
  payout: 54,
  maxPayout: 60,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};
export const PAIR_CLOSED: PairView = {
  id: 404,
  symbol: 'GBP/USD',
  isOtc: false,
  type: 'currency',
  digits: 5,
  payout: 80,
  maxPayout: 88,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 4_102_444_800_000,
};
export const PAIR_SHORT: PairView = {
  id: 202,
  symbol: 'BTC/USD',
  isOtc: true,
  type: 'cryptocurrency',
  digits: 2,
  payout: 90,
  maxPayout: 90,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};
// a type outside the five the broker lists today, grouped under «📁 Другие»
export const PAIR_OTHER_TYPE: PairView = {
  id: 303,
  symbol: 'US10Y',
  type: 'bond',
  digits: 3,
  payout: 70,
  maxPayout: 75,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};
export const PAIR_MINUTE_ONLY: PairView = {
  id: 505,
  symbol: 'AUD/CAD',
  isOtc: false,
  type: 'currency',
  digits: 5,
  payout: 82,
  maxPayout: 88,
  minTimeframe: 60,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};
// accepts 15 s and not 5 s: a signal on the 5 s list has no button for it (#382)
export const PAIR_15S_ONLY: PairView = {
  id: 606,
  symbol: 'NZD/USD',
  isOtc: true,
  type: 'currency',
  digits: 5,
  payout: 83,
  maxPayout: 88,
  minTimeframe: 15,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};

// GET /trading/signals (#382): a list for every interval of SIGNAL_SCAN_INTERVALS, in the route's
// order, with the given signals (none where an interval is not named); the times are the
// scanner's, which the bot ignores
export const signalsResponse = (
  nowMs: number,
  signals: Partial<Record<ScanInterval, readonly (readonly [number, TradeAction])[]>> = {},
): TradingSignalsResponse => ({
  asOf: nowMs - 500,
  lists: SIGNAL_SCAN_INTERVALS.map((interval) => ({
    interval,
    scanned: signals[interval]?.length ?? 0,
    signals: (signals[interval] ?? []).map(([assetId, action]) => ({
      assetId,
      action,
      lastCandleTimestamp: nowMs - 500 - SIGNAL_CHART_INTERVAL_MS[interval],
      decidedAt: nowMs - 500,
      ageMs: 500,
    })),
  })),
});

export const PAIRS_RESPONSE: PairsCatalogResponse = {
  pairs: [PAIR_EURUSD, PAIR_CLOSED, PAIR_SHORT, PAIR_OTHER_TYPE, PAIR_MINUTE_ONLY],
  fetchedAt: 1_790_000_000_000,
  ageMs: 1_500,
  fresh: true,
};
export const pairsResponse = (patch: Partial<PairsCatalogResponse> = {}): PairsCatalogResponse => ({
  ...PAIRS_RESPONSE,
  ...patch,
});

// POST /trading/signal answers (#258), written by hand: the bot does not depend on packages/signal.
// The periods differ from the decider's defaults (EMA9/21, RSI14, ATR14) on purpose, so a screen
// that prints a period of its own instead of the answer's shows.
export const SIGNAL_PARAMS: SignalParams = {
  emaFast: 7,
  emaSlow: 25,
  slopeLookback: 3,
  rsiPeriod: 10,
  rsiBand: 5,
  atrPeriod: 12,
  minAtrPct: 0.001,
  maxAtrPct: 2,
  minClosedCandles: 50,
  maxStaleIntervals: 2,
  rsiExtremeBand: 15,
  minAtrTicks: 5,
};
export const SIGNAL_FEATURES: SignalFeatures = {
  emaFast: 1.085423,
  emaSlow: 1.085114,
  emaSlowSlope: 0.000021,
  rsi: 62.34,
  atr: 0.000447,
  atrPct: 0.0412,
  lastClose: 1.085604,
  lastCandleTimestamp: 1_790_000_040_000,
  closedCandles: 59,
  trend: TrendDirection.Up,
  momentum: MomentumDirection.Up,
  atrTicks: 44.7,
};
export const signalDecided = (decision: SignalDecision): TradingSignalResponse =>
  tradingSignalResponseSchema.parse({
    outcome: SignalFeedOutcome.Decided,
    params: SIGNAL_PARAMS,
    decision,
  });
export const SIGNAL_DECISION: SignalDecision = {
  kind: SignalKind.Signal,
  version: SIGNAL_ALGORITHM_VERSION,
  action: TradeAction.Up,
  features: SIGNAL_FEATURES,
};
export const SIGNAL_DECIDED = signalDecided(SIGNAL_DECISION);
// The display indicators of the analysis card (#482): MACD above its signal line with no cross on
// the last candle, the last close above MA50 and below MA200
export const SIGNAL_INDICATORS: SignalIndicators = {
  macd: { ok: true, macd: 0.000123, signal: 0.0001, histogram: 0.000023, cross: MacdCross.None },
  ma50: { ok: true, value: 1.085312, lastClose: SIGNAL_FEATURES.lastClose },
  ma200: { ok: true, value: 1.086121, lastClose: SIGNAL_FEATURES.lastClose },
};
export const SIGNAL_CARD: TradingSignalResponse = tradingSignalResponseSchema.parse({
  ...SIGNAL_DECIDED,
  indicators: SIGNAL_INDICATORS,
});
export const SIGNAL_NO_SIGNAL = signalDecided({
  kind: SignalKind.NoSignal,
  version: SIGNAL_ALGORITHM_VERSION,
  reason: NoSignalReason.RsiNeutral,
  features: { ...SIGNAL_FEATURES, rsi: 52.1, momentum: MomentumDirection.Neutral },
});
export const SIGNAL_DATA_REFUSAL = signalDecided({
  kind: SignalKind.NoSignal,
  version: SIGNAL_ALGORITHM_VERSION,
  reason: NoSignalReason.CandleGap,
  detail: { index: 12, expectedTimestamp: 1_789_999_340_000, actualTimestamp: 1_789_999_400_000 },
});
export const SIGNAL_FETCH_FAILED: TradingSignalResponse = tradingSignalResponseSchema.parse({
  outcome: SignalFeedOutcome.FetchFailed,
  code: BrokerRestErrorCode.RateLimited,
  retryAfterSec: 7,
});

// A demo intent as POST /trading/intents answers it right after creation (#127): queued, the
// broker's minimum stake, the key the stake button's fixed nonce gives.
export const INTENT_ID = '7c1e9f2a-4b3d-4e5f-8a6b-9c0d1e2f3a4b';
export const STAKE_NONCE = '0123456789ab';
// the fingerprint of the amount ACCESS_VIEW trades: no saved stake, the broker's minimum (#297)
export const STAKE_FINGERPRINT = stakeFingerprint(BROKER_BALANCE.minTradeAmount, TradeMode.Demo);
export const INTENT_VIEW: TradeIntentView = {
  id: INTENT_ID,
  brokerAccountId: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
  telegramUserId: String(USER.id),
  mode: TradeMode.Demo,
  assetId: PAIR_EURUSD.id,
  amount: BROKER_BALANCE.minTradeAmount,
  action: TradeAction.Up,
  durationSec: 15,
  clientRequestId: `demo:${USER.id}:${STAKE_NONCE}`,
  createdAt: '2026-10-06T10:00:00.000Z',
  status: TradeIntentStatus.Queued,
  version: 3,
  tokensReserved: '1',
  transport: null,
  submittedAt: null,
  lastError: null,
  updatedAt: '2026-10-06T10:00:00.000Z',
};
export const intentView = (patch: Partial<TradeIntentView> = {}): TradeIntentView => ({
  ...INTENT_VIEW,
  ...patch,
});

// A demo session as POST /trading/sessions answers it right after creation (#284): active, no
// trade yet, the broker's minimum stake.
export const SESSION_ID = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
export const SESSION_VIEW: TradingSessionView = tradingSessionViewSchema.parse({
  id: SESSION_ID,
  mode: TradeMode.Demo,
  status: 'active',
  stopReason: null,
  settings: {
    version: 1,
    assetId: PAIR_EURUSD.id,
    durationSec: 15,
    trades: 5,
    stake: { baseStake: '1', stakeScale: 0 },
  },
  startedAt: '2026-10-07T10:00:00.000Z',
  endedAt: null,
  trades: { settled: 0, rejected: 0, won: 0, lost: 0, tied: 0, profit: '0.00000000' },
  cycles: { planned: 5, closed: 0 },
  lastIntent: null,
  // no picture (#568): the scenes written before it keep the text message; a scene of the
  // picture passes a direction
  signalAction: null,
  balance: null,
  noticesDone: false,
});
export const sessionView = (patch: Partial<TradingSessionView> = {}): TradingSessionView => ({
  ...SESSION_VIEW,
  ...patch,
});

// POST /trading/sessions/:id/share's answer (#538): a finished session of three settled trades on
// PAIR_EURUSD, and the sender's referral code
export const SHARE_REFERRAL_CODE = 'AbC123xY';
const decimal = (value: string) => decimalStringSchema.parse(value);
export const sessionShare = (patch: Partial<SessionShare> = {}): SessionShare => ({
  session: sessionView({
    status: TradingSessionStatus.Stopped,
    stopReason: TradingSessionStopReason.Completed,
    endedAt: '2026-10-07T10:05:00.000Z',
    cycles: { planned: 5, closed: 3 },
    trades: { settled: 3, rejected: 0, won: 2, lost: 1, tied: 0, profit: decimal('0.70000000') },
    lastIntent: intentView({ status: TradeIntentStatus.Settled }),
  }),
  trades: [
    {
      action: TradeAction.Up,
      profit: decimal('0.85000000'),
      openPrice: 1.0871,
      closePrice: 1.0875,
    },
    {
      action: TradeAction.Down,
      profit: decimal('-1.00000000'),
      openPrice: 1.0875,
      closePrice: 1.0879,
    },
    {
      action: TradeAction.Up,
      profit: decimal('0.85000000'),
      openPrice: 1.0879,
      closePrice: 1.0883,
    },
  ],
  pair: { symbol: PAIR_EURUSD.symbol, isOtc: true, digits: PAIR_EURUSD.digits },
  referralCode: SHARE_REFERRAL_CODE,
  ...patch,
});

// A cache of languages that already holds `telegramUserId`: the scene's updates make no cold read
// (language.ts), so a scene that counts backend calls counts its handler's only.
export const userLanguagesWith = (
  telegramUserId: number = USER.id,
  language: BotLanguage = BotLanguage.Ru,
): UserLanguages => {
  const languages = createUserLanguages();
  languages.set(telegramUserId, language);
  return languages;
};

// A client where every method the scene does not give rejects, so an unexpected call fails the
// scene instead of answering with a fixture. A method added to BackendClient adds a line here.
export const fakeBackend = (patch: Partial<BackendClient> = {}): BackendClient => {
  const unused = () => Promise.reject(new Error('not used here'));
  return {
    recordStart: unused,
    readAccount: unused,
    readReferral: unused,
    confirmLogin: unused,
    sendEmailCode: unused,
    emailLogin: unused,
    recordChatMember: unused,
    setNotificationLevel: unused,
    readLanguage: () => Promise.resolve(BotLanguage.Ru),
    setLanguage: unused,
    readTradingAccess: unused,
    readPairs: unused,
    evaluateSignal: unused,
    readSignals: unused,
    createIntent: unused,
    readIntent: unused,
    startSession: unused,
    readSession: unused,
    stopSession: unused,
    claimSessionSummary: unused,
    readSessionShare: unused,
    stopSessions: unused,
    recordSessionMessage: unused,
    listTrackedSessions: unused,
    // a lost message forgotten: the tracker reports one on every gone or 403 edit (#567)
    forgetSessionMessage: () => Promise.resolve(true),
    setStake: unused,
    setTradingMode: unused,
    readBotTexts: unused,
    createStarsInvoice: unused,
    checkStarsPreCheckout: unused,
    reportStarsPaid: unused,
    listStarsPayments: unused,
    requestStarsRefund: unused,
    ...patch,
  };
};

// a tracker that arms no timer: what every bot built in a test gets unless it asserts on tracking
export const stubTracker = (): { track: Mock<IntentTracker['track']> } => ({ track: vi.fn() });
// the same for the sessions' tracker (#284)
export const stubSessionTracker = (): { track: Mock<SessionTracker['track']> } => ({
  track: vi.fn(),
});
// the session recovery's wiring point (#567): the resume createBot attaches, kept for a test
export const stubSessionResumer = (): { attach: Mock<SessionResumer['attach']> } => ({
  attach: vi.fn(),
});

export const EMAIL = 'ada@example.test';
export const CODE = '123456';
export const CODE_SENT: EmailSendCodeResponse = { codeSent: true };

// the reason a promise rejected with, or undefined when it resolved: what a test needs when the
// assertion is about the error's identity rather than its message
export const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

export interface FakeLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
}

export const fakeLogger = (): FakeLogger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

let updateId = 0;

export const startUpdate = (text: string, chatType = 'private', from: User = USER): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      date: 1,
      chat: { id: from.id, type: chatType, first_name: from.first_name },
      from,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
    },
  }) as unknown as Update;

// A plain message, the way the user sends an address or a code. A text starting with `/` carries
// the bot_command entity Telegram attaches to it, so a command reads as a command.
export const textUpdate = (text: string, chatType = 'private', from: User = USER): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      date: 1,
      chat: { id: from.id, type: chatType, first_name: from.first_name },
      from,
      text,
      ...(text.startsWith('/')
        ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length }] }
        : {}),
    },
  }) as unknown as Update;

// A command posted in a channel: Telegram delivers it as channel_post, with no `from`.
export const channelPostUpdate = (text: string): Update =>
  ({
    update_id: ++updateId,
    channel_post: {
      message_id: ++updateId,
      date: 1,
      chat: { id: -1001234567890, type: 'channel', title: 'Binarius channel' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length }],
    },
  }) as unknown as Update;

// The bot's own membership changing in a chat: in a private chat Telegram sends `kicked` when the
// user blocks the bot and `member` when they unblock it.
export const chatMemberUpdate = (
  newStatus: string,
  {
    oldStatus = newStatus === 'kicked' ? 'member' : 'kicked',
    chatType = 'private',
    from = USER,
  }: { oldStatus?: string; chatType?: string; from?: User } = {},
): Update =>
  ({
    update_id: ++updateId,
    my_chat_member: {
      chat:
        chatType === 'private'
          ? { id: from.id, type: chatType, first_name: from.first_name }
          : { id: -1001, type: chatType, title: 'A group' },
      from,
      date: 1,
      old_chat_member: { status: oldStatus, user: { ...BOT_INFO } },
      new_chat_member: {
        status: newStatus,
        user: { ...BOT_INFO },
        ...(newStatus === 'kicked' ? { until_date: 0 } : {}),
      },
    },
  }) as unknown as Update;

export const callbackUpdate = (data: string, chatType = 'private'): Update =>
  ({
    update_id: ++updateId,
    callback_query: {
      id: 'query-1',
      from: USER,
      chat_instance: 'instance-1',
      data,
      message: {
        message_id: ++updateId,
        date: 1,
        chat: { id: USER.id, type: chatType, first_name: USER.first_name },
        from: { ...BOT_INFO },
      },
    },
  }) as unknown as Update;

// A press under a photo (#482): the analysis card, or the session's summary card (#318) — a
// message with a caption, which an edit cannot turn into text
export const photoCallbackUpdate = (data: string): Update => {
  const update = callbackUpdate(data) as unknown as {
    callback_query: { message: Record<string, unknown> };
  };
  update.callback_query.message.photo = [
    { file_id: 'pressed-photo', file_unique_id: 'pressed', width: 100, height: 50 },
  ];
  update.callback_query.message.caption = 'card';
  return update as unknown as Update;
};

// An inline query (#321): no chat, only the type of the chat it is typed in, when the client says
export const inlineQueryUpdate = (
  query: string,
  { from = USER, chatType }: { from?: User; chatType?: string } = {},
): Update =>
  ({
    update_id: ++updateId,
    inline_query: {
      id: `inline-${String(updateId)}`,
      from,
      query,
      offset: '',
      ...(chatType === undefined ? {} : { chat_type: chatType }),
    },
  }) as unknown as Update;

export const chosenInlineResultUpdate = (resultId: string, query: string): Update =>
  ({
    update_id: ++updateId,
    chosen_inline_result: { result_id: resultId, from: USER, query },
  }) as unknown as Update;

// The Stars purchase (#117): the payload of USER's 150-token invoice, its pre-checkout query and
// the successful_payment that follows
export const STARS_USER_ID = '6c1f6a2e-3b7d-4c55-9a51-2f6b8e7d9a10';
export const STARS_PAYLOAD = `stars:p150:${STARS_USER_ID}`;
export const STARS_INVOICE = {
  payload: STARS_PAYLOAD,
  package: { code: 'p150', tokens: '150', stars: 250 },
};

export const preCheckoutUpdate = (
  patch: { from?: User; payload?: string; totalAmount?: number } = {},
): Update =>
  ({
    update_id: ++updateId,
    pre_checkout_query: {
      id: `pre-checkout-${String(updateId)}`,
      from: patch.from ?? USER,
      currency: 'XTR',
      total_amount: patch.totalAmount ?? 250,
      invoice_payload: patch.payload ?? STARS_PAYLOAD,
    },
  }) as unknown as Update;

export const successfulPaymentUpdate = (chatType = 'private'): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: ++updateId,
      date: 1_790_000_000,
      chat: { id: USER.id, type: chatType, first_name: USER.first_name },
      from: USER,
      successful_payment: {
        currency: 'XTR',
        total_amount: 250,
        invoice_payload: STARS_PAYLOAD,
        telegram_payment_charge_id: 'charge-1',
        provider_payment_charge_id: '',
      },
    },
  }) as unknown as Update;

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

// A programmed answer: the value becomes the `result` of an `ok: true` response, and throwing
// leaves the call the way the transport leaves it. This is also the only way to inject a failure
// the real transport never produces — apiErrors deliberately cannot, see below.
export type ApiAnswer = (
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => unknown | Promise<unknown>;

export interface CapturedApi {
  calls: ApiCall[];
  // an entry makes that method answer the way Telegram would when it refuses (ApiError, which
  // grammY turns into a GrammyError), or fail the way the transport does — HttpError, the only
  // thing grammY's transport throws (core/client.js, toHttpError). Either member beats an
  // answer programmed for the same method, and beats it on every call until the entry is
  // deleted: the precedence is fixed, not one refusal followed by recovery. A scene where
  // getUpdates is refused once and polling then goes on is built by deleting the entry after
  // that call, or by an answer that throws the first time — not by this precedence.
  apiErrors: Map<string, ApiError | HttpError>;
  answers: Map<string, ApiAnswer>;
}

// Every outgoing Bot API call is recorded here instead of reaching Telegram. Unprogrammed
// methods answer `result: true`. The account card reads the message_id of the sendPhoto or
// sendMessage that carried it, so a scene that reaches the pin programs those two with
// messageAnswer; a handler that starts reading another result needs the same.
// The data of the presses that write (#350, docs/bot-navigation.md → The repeat): a «🔄 Повторить»
// carrying one would write again, a second trade or a second session
export const WRITE_CALLBACK_PREFIXES = [
  'demo:stake:',
  'demo:sess:',
  'real:sess:',
  // an amount of the amount screen (#476): saves the stake, then starts a session
  'demo:sa:',
  'session:stop:',
  'confirm:',
  'resend',
  'stk:s:',
  'stk:z:',
  'level:',
  // a refund request from /paysupport (#118)
  'ps:r:',
  // the mode switches (#474): «✅ Подтверждаю» and «🎮 Вернуться в демо» of the mode screen
  'mode:r:ok',
  'mode:d',
  // a language of the language screen (#508); `lang` alone opens the screen, a read
  'lang:',
] as const;

// Every message a scene sends goes through here, so no scene can send a repeat of a write
// unnoticed: the call throws and the scene fails.
export function refuseWriteRetried(method: string, payload: Record<string, unknown>): void {
  for (const button of inlineButtons(payload)) {
    const data = button.callback_data;
    if (
      button.text === LABELS.demoRetryButton &&
      data !== undefined &&
      WRITE_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix))
    ) {
      throw new Error(`${method} repeats a write: ${data}`);
    }
  }
}

// The width spacer (#506, docs/bot-navigation.md → The width) on every text message a scene sends
// and on nothing else. A text without it throws; with it, the call is recorded without it, so the
// suites read the text the seam was given. The answer gets that same recorded object: the e2e
// harness keys the message ids it answers with by the payload object. A caption, an inline answer or a toast holding U+2800
// throws: a picture or no bubble at all sets their width.
const TEXT_METHODS: ReadonlySet<string> = new Set(['sendMessage', 'editMessageText']);
const BRAILLE_BLANK = '\u2800';
const hasBlank = (value: unknown) => typeof value === 'string' && value.includes(BRAILLE_BLANK);

export function refuseWidthSpacerMisuse(
  method: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (TEXT_METHODS.has(method)) {
    const text = typeof payload.text === 'string' ? stripMessageSpacer(payload.text) : undefined;
    if (text === undefined) throw new Error(`${method} sends a text without the width spacer`);
    return { ...payload, text };
  }
  const media = payload.media as { caption?: unknown } | undefined;
  const results = Array.isArray(payload.results)
    ? (payload.results as { caption?: unknown }[])
    : [];
  const blank =
    hasBlank(payload.caption) ||
    hasBlank(media?.caption) ||
    results.some((result) => hasBlank(result.caption)) ||
    (method === 'answerCallbackQuery' && hasBlank(payload.text));
  if (blank) throw new Error(`${method} carries the width spacer outside a text message`);
  return payload;
}

export function captureApi(bot: Bot): CapturedApi {
  const captured: CapturedApi = { calls: [], apiErrors: new Map(), answers: new Map() };
  bot.api.config.use(((
    _prev,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const recorded = refuseWidthSpacerMisuse(method, payload);
    captured.calls.push({ method, payload: recorded });
    refuseWriteRetried(method, payload);
    const failure = captured.apiErrors.get(method);
    if (failure !== undefined) {
      if (failure instanceof Error) throw failure;
      return Promise.resolve(failure);
    }
    const answer = captured.answers.get(method);
    if (answer !== undefined) {
      return Promise.resolve(answer(recorded, signal)).then((result) => ({ ok: true, result }));
    }
    return Promise.resolve({ ok: true, result: true });
  }) as Parameters<typeof bot.api.config.use>[0]);
  return captured;
}

// The first call of `method` goes through and every later one fails with `failure`: a screen
// edited once, then refused when edited again (#126's «⏳» and then the result).
export function failFromSecondCall(
  api: Pick<CapturedApi, 'apiErrors' | 'answers'>,
  method: string,
  failure: ApiError | HttpError,
): void {
  api.answers.set(method, () => {
    api.apiErrors.set(method, failure);
    return true;
  });
}

// The message ids the account card's two carriers answer with, distinct so a test can tell
// which message was pinned.
export const CARD_MESSAGE_ID = 501;
export const TEXT_CARD_MESSAGE_ID = 502;

// A sendPhoto's result with its sizes, smallest first as Telegram lists them: the summary card
// reads the last one's file_id for «📤 Поделиться» (#321).
export const photoAnswer =
  (message_id: number, fileIds: readonly string[]): ApiAnswer =>
  () => ({
    message_id,
    date: 1,
    chat: { id: USER.id, type: 'private', first_name: USER.first_name },
    photo: fileIds.map((file_id, index) => ({
      file_id,
      file_unique_id: `unique-${String(index)}`,
      width: 100 * (index + 1),
      height: 100 * (index + 1),
    })),
  });

// The result of a send: grammY passes it through unchecked, and the bot reads only message_id.
export const messageAnswer =
  (message_id: number): ApiAnswer =>
  () => ({
    message_id,
    date: 1,
    chat: { id: USER.id, type: 'private', first_name: USER.first_name },
  });

export const sentPayload = (
  calls: readonly ApiCall[],
  method: string,
): Record<string, unknown> | undefined => calls.find((call) => call.method === method)?.payload;

export const inlineButtons = (payload: Record<string, unknown> | undefined) =>
  (
    payload?.reply_markup as {
      inline_keyboard?: {
        text: string;
        callback_data?: string;
        url?: string;
        web_app?: { url: string };
        switch_inline_query_chosen_chat?: Record<string, unknown>;
      }[][];
    }
  )?.inline_keyboard?.flat() ?? [];

// the keyboard row by row, where inlineButtons flattens it
export const inlineRows = (payload: Record<string, unknown> | undefined) =>
  (payload?.reply_markup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard ?? [];

// An ephemeral loopback server: `listen` returns the base URL the client should be pointed at.
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
