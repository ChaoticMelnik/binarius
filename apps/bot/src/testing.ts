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
import type { SessionTracker } from './session-tracker';
import { LABELS } from './texts';
import {
  BrokerAccountStatus,
  brokerBalanceViewSchema,
  BrokerRestErrorCode,
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
  type PendingLinkedAccountView,
  type ScanInterval,
  type SignalDecision,
  type SignalFeatures,
  type SignalParams,
  type TradeIntentView,
  type TradingAccessResponse,
  type TradingSessionView,
  type TradingSignalResponse,
  type TradingSignalsResponse,
  type UserAccountView,
  type UserStartView,
  BOT_TEXT_CATALOG,
  BotTextKind,
  defaultBotTextSource,
  type BotTextKey,
  type BotTextSource,
} from '@binarius/shared';

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
  symbol: 'EUR/USD OTC',
  isOtc: true,
  type: 'currency',
  digits: 5,
  payout: 85,
  maxPayout: 92,
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
  symbol: 'BTC/USD OTC',
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
  symbol: 'NZD/USD OTC',
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
export const STAKE_FINGERPRINT = stakeFingerprint(BROKER_BALANCE.minTradeAmount);
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
  trades: { planned: 5, settled: 0, rejected: 0, won: 0, lost: 0, tied: 0, profit: '0.00000000' },
  lastIntent: null,
  balance: null,
});
export const sessionView = (patch: Partial<TradingSessionView> = {}): TradingSessionView => ({
  ...SESSION_VIEW,
  ...patch,
});

// A client where every method the scene does not give rejects, so an unexpected call fails the
// scene instead of answering with a fixture. A method added to BackendClient adds a line here.
export const fakeBackend = (patch: Partial<BackendClient> = {}): BackendClient => {
  const unused = () => Promise.reject(new Error('not used here'));
  return {
    recordStart: unused,
    readAccount: unused,
    confirmLogin: unused,
    sendEmailCode: unused,
    emailLogin: unused,
    recordChatMember: unused,
    setNotificationLevel: unused,
    readTradingAccess: unused,
    readPairs: unused,
    evaluateSignal: unused,
    readSignals: unused,
    createIntent: unused,
    readIntent: unused,
    startSession: unused,
    readSession: unused,
    stopSession: unused,
    setDemoStake: unused,
    readBotTexts: unused,
    ...patch,
  };
};

// a tracker that arms no timer: what every bot built in a test gets unless it asserts on tracking
export const stubTracker = (): { track: Mock<IntentTracker['track']> } => ({ track: vi.fn() });
// the same for the demo sessions' tracker (#284)
export const stubSessionTracker = (): { track: Mock<SessionTracker['track']> } => ({
  track: vi.fn(),
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
  'session:stop:',
  'confirm:',
  'resend',
  'stk:s:',
  'stk:z:',
  'level:',
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

export function captureApi(bot: Bot): CapturedApi {
  const captured: CapturedApi = { calls: [], apiErrors: new Map(), answers: new Map() };
  bot.api.config.use(((
    _prev,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    captured.calls.push({ method, payload });
    refuseWriteRetried(method, payload);
    const failure = captured.apiErrors.get(method);
    if (failure !== undefined) {
      if (failure instanceof Error) throw failure;
      return Promise.resolve(failure);
    }
    const answer = captured.answers.get(method);
    if (answer !== undefined) {
      return Promise.resolve(answer(payload, signal)).then((result) => ({ ok: true, result }));
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
      }[][];
    }
  )?.inline_keyboard?.flat() ?? [];

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
