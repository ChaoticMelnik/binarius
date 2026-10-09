import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_TEXT_CATALOG,
  BOT_TEXT_MESSAGES,
  BOT_TEXT_WIDTHS,
  BrokerAccountStatus,
  BrokerBalanceUnavailableReason,
  BrokerRestErrorCode,
  botTextMessageKeys,
  defaultBotTextSource,
  estimateBotTextMessage,
  botTextChangeProblems,
  resolveBotTextOverrides,
  INT4_MAX,
  LinkBonusSkipReason,
  NotificationLevel,
  MomentumDirection,
  NoSignalReason,
  plainTextOf,
  RULE_REFUSAL_REASONS,
  DATA_REFUSAL_REASONS,
  SIGNAL_ALGORITHM_VERSION,
  SignalFeedOutcome,
  SignalKind,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  TrendDirection,
  tradingSignalResponseSchema,
  type BotTextKey,
  type DecimalString,
  type BotTextSource,
  type LinkBonusGrantView,
  type LinkedAccountView,
  type PairView,
  type SignalDecision,
  type TelegramHtml,
  type TradingSignalResponse,
} from '@binarius/shared';
import { analysisScreen, analysisUnavailableScreen } from './analysis';
import { DEMO_DURATIONS_SEC, type DemoAssetGroup, type DemoDurationSec } from './demo-catalog';
import {
  brokerBalance,
  intentView,
  LINK_ACTIVE,
  PAIR_EURUSD,
  sessionView,
  SESSION_VIEW,
  SIGNAL_PARAMS,
} from './testing';
import {
  accountCard,
  accountStatus,
  demoDurationsScreen,
  demoPairsScreen,
  demoSummary,
  launchText,
  helpText,
  intentStatusText,
  sessionStatusText,
  setBotTextSource,
  settingsText,
  stakePickerText,
  statusCard,
  TEXTS,
  botCommands,
  userContextOf,
  type StatusCardInput,
} from './texts';

// The descriptions in packages/shared/src/bot-text-messages.ts against the bot's real assembly:
// each message at its widest inputs is exactly as long as the estimate says (M1), and reads
// exactly the keys the estimate reads (M2).

const W = BOT_TEXT_WIDTHS;
const x = (width: number) => 'x'.repeat(width);
const COUNT = '9223372036854775807';
const USD = '-999999999999.99999999' as DecimalString;
// a stake, the broker's minimum and the demo balance are unsigned money() values (#297)
const STAKE = '999999999999.99999999' as DecimalString;
const lengthOf = (text: TelegramHtml) => plainTextOf(text).length;
const NAME = x(W.firstName);

const pair: PairView = { ...PAIR_EURUSD, symbol: x(W.symbol), payout: 999_999 };
const GROUPS: DemoAssetGroup[] = [
  'currency',
  'commodity',
  'stock',
  'cryptocurrency',
  'index',
  'other',
];

const statusCards = (): TelegramHtml[] => {
  const full = (
    broker: StatusCardInput['broker'],
    brokerUnavailable: StatusCardInput['brokerUnavailable'],
  ) =>
    Object.values(TradeMode).map((mode) =>
      statusCard({
        firstName: NAME,
        mode,
        tokens: { balance: COUNT, reserved: COUNT, available: COUNT },
        broker,
        brokerUnavailable,
        demoStake: STAKE,
      }),
    );
  const big = { available: USD, held: USD, total: USD };
  return [
    ...full(
      brokerBalance({
        real: big,
        demo: big,
        fresh: false,
        restSnapshotAgeSec: 99_999 * 60,
        balanceEventAgeSec: null,
      }),
      null,
    ),
    ...Object.values(BrokerBalanceUnavailableReason).flatMap((reason) => full(null, reason)),
  ];
};

const grants: LinkBonusGrantView[] = [
  { granted: true, tokens: COUNT },
  ...Object.values(LinkBonusSkipReason).map((reason) => ({ granted: false as const, reason })),
];

// Each list has one status, so its header comes with that status's lines, while the estimate adds
// the longest header to the longest line. M1 holds only while the longest header is the one whose
// lines are the longest too: today accountRevoked with accountLineRevoked (bot-texts.ts).
const accountLists = (): TelegramHtml[] =>
  Object.values(BrokerAccountStatus).flatMap((status) =>
    [x(W.email), null].map((email) =>
      accountStatus(
        Array.from(
          { length: W.accountLines },
          (): LinkedAccountView => ({ ...LINK_ACTIVE, status, email }) as LinkedAccountView,
        ),
      ),
    ),
  );

const decided = (decision: Record<string, unknown>): TradingSignalResponse =>
  tradingSignalResponseSchema.parse({
    outcome: SignalFeedOutcome.Decided,
    params: { ...SIGNAL_PARAMS, emaFast: 9999, emaSlow: 9999, rsiPeriod: 9999, atrPeriod: 9999 },
    decision: { version: SIGNAL_ALGORITHM_VERSION, ...decision } as SignalDecision,
  });
const widePair: PairView = { ...pair, digits: 10 };
const featuresOf = (trend: string, momentum: string, emaSlow = -999_999_999.5) => ({
  emaFast: -999_999_999.5,
  emaSlow,
  emaSlowSlope: 0,
  rsi: 100,
  atr: 1,
  atrPct: 99_999.999,
  lastClose: -999_999_999.5,
  lastCandleTimestamp: 1,
  closedCandles: 99_999,
  trend,
  momentum,
});
const allFeatures = Object.values(TrendDirection).flatMap((trend) =>
  Object.values(MomentumDirection).flatMap((momentum) =>
    [-999_999_999.5, 1, -999_999_999.75].map((emaSlow) => featuresOf(trend, momentum, emaSlow)),
  ),
);
const screens = (responses: TradingSignalResponse[]) =>
  responses.flatMap((response) =>
    DEMO_DURATIONS_SEC.map(
      (durationSec) => analysisScreen({ pair: widePair, durationSec, response }).text,
    ),
  );
const DATA_DETAILS = {
  [NoSignalReason.InsufficientCandles]: { detail: { closedCandles: 1, required: 2 } },
  [NoSignalReason.CandleGap]: { detail: { index: 1, expectedTimestamp: 1, actualTimestamp: 2 } },
  [NoSignalReason.Stale]: { detail: { lastCandleTimestamp: 1, ageMs: 2, maxAgeMs: 1 } },
  [NoSignalReason.InvalidCandle]: { detail: { index: 1, problem: 'ohlc_order' } },
};

const intentViews = [
  ...Object.values(TradeIntentStatus)
    .filter((status) => status !== TradeIntentStatus.Rejected)
    .map((status) => ({ status, lastError: null })),
  ...[null, ...Object.values(TradeIntentFailureReason)].map((lastError) => ({
    status: TradeIntentStatus.Rejected,
    lastError,
  })),
];

const N = 999;
const sessionTexts = (
  status: TradingSessionStatus,
  stopReasons: (TradingSessionStopReason | null)[],
): TelegramHtml[] =>
  [x(W.symbol + 10), null].flatMap((symbol) =>
    [...DEMO_DURATIONS_SEC, INT4_MAX].flatMap((durationSec) =>
      stopReasons.flatMap((stopReason) =>
        [0, 1, 2, N].flatMap((settled) =>
          [null, ...Object.values(TradeIntentStatus).map((s) => intentView({ status: s }))].map(
            (lastIntent) =>
              sessionStatusText(
                symbol,
                sessionView({
                  status,
                  stopReason,
                  settings: {
                    ...SESSION_VIEW.settings!,
                    assetId: INT4_MAX,
                    durationSec,
                    stake: { baseStake: STAKE, stakeScale: 8 },
                  },
                  trades: { planned: N, settled, rejected: 0, won: N, lost: N, tied: N },
                  lastIntent,
                }),
                { deadline: true },
              ),
          ),
        ),
      ),
    ),
  );
const STOP_REASONS = Object.values(TradingSessionStopReason).filter(
  (reason) => reason !== TradingSessionStopReason.Completed,
);

// every variant of each message, built by the bot's own code at the widest inputs
const REAL: Record<string, () => TelegramHtml[]> = {
  accountCard: () =>
    ['', x(W.firstName)].flatMap((firstName) =>
      grants.map((grant) => accountCard({ firstName, email: x(W.email), grant })),
    ),
  statusCard: statusCards,
  help: () => [helpText(botCommands())],
  account: accountLists,
  analysisFailed: () => [
    ...screens([
      tradingSignalResponseSchema.parse({
        outcome: SignalFeedOutcome.FetchFailed,
        code: BrokerRestErrorCode.RateLimited,
        retryAfterSec: 99_999,
      }),
    ]),
    ...DEMO_DURATIONS_SEC.map(
      (durationSec) => analysisUnavailableScreen(widePair, durationSec).text,
    ),
  ],
  analysisSignal: () =>
    screens(
      Object.values(TradeAction).flatMap((action) =>
        allFeatures.map((features) => decided({ kind: SignalKind.Signal, action, features })),
      ),
    ),
  analysisNoData: () =>
    screens(
      DATA_REFUSAL_REASONS.map((reason) =>
        decided({ kind: SignalKind.NoSignal, reason, ...DATA_DETAILS[reason] }),
      ),
    ),
  analysisNoSignal: () =>
    screens(
      RULE_REFUSAL_REASONS.flatMap((reason) =>
        allFeatures.map((features) => decided({ kind: SignalKind.NoSignal, reason, features })),
      ),
    ),
  intentStatus: () =>
    [x(W.symbol + 10), null].flatMap((symbol) =>
      [...DEMO_DURATIONS_SEC, INT4_MAX].flatMap((durationSec) =>
        Object.values(TradeAction).flatMap((action) =>
          intentViews.map((view) =>
            intentStatusText(
              symbol,
              intentView({ ...view, action, durationSec, amount: STAKE, assetId: 9_999_999_999 }),
              { deadline: true },
            ),
          ),
        ),
      ),
    ),
  demoPairs: () => GROUPS.map((group) => demoPairsScreen(group, 998, 999)),
  demoDurations: () => [demoDurationsScreen(pair)],
  sessionNoSettings: () => [sessionStatusText(null, sessionView({ settings: null }))],
  sessionRunning: () =>
    [TradingSessionStatus.Active, TradingSessionStatus.Paused].flatMap((status) =>
      sessionTexts(status, [null]),
    ),
  sessionCompleted: () =>
    sessionTexts(TradingSessionStatus.Stopped, [TradingSessionStopReason.Completed]),
  sessionStopped: () => sessionTexts(TradingSessionStatus.Stopped, [...STOP_REASONS, null]),
  settings: () =>
    Object.values(NotificationLevel).flatMap((level) =>
      [null, STAKE].map((stake) => settingsText(level, stake, NAME)),
    ),
  stakePicker: () =>
    [null, STAKE].flatMap((stake) =>
      [0, 1].map((presets) =>
        stakePickerText({
          user: userContextOf(NAME, TradeMode.Demo, {
            tokens: { balance: COUNT, reserved: COUNT, available: COUNT },
            broker: null,
            demoStake: stake,
          }),
          minTradeAmount: STAKE,
          demoAvailable: STAKE,
          presets,
        }),
      ),
    ),
  demoSummary: () =>
    DEMO_DURATIONS_SEC.map((durationSec: DemoDurationSec) => demoSummary(pair, durationSec)),
  // the three plurals, each at the widest count
  demoLaunch: () =>
    [undefined, { amount: null }, { amount: STAKE }].flatMap((saved) =>
      [null, STAKE].flatMap((amount) =>
        [999, 992, 991].flatMap((trades) =>
          DEMO_DURATIONS_SEC.map((durationSec: DemoDurationSec) =>
            launchText({
              firstName: NAME,
              durationSec,
              symbol: pair.symbol,
              amount,
              trades,
              saved,
            }),
          ),
        ),
      ),
    ),
};

const ASSEMBLED = BOT_TEXT_MESSAGES.filter((message) => message.id in REAL);

const recording = (texts: Partial<Record<BotTextKey, string>> = {}) => {
  const read = new Set<BotTextKey>();
  const source: BotTextSource<BotTextKey> = {
    sourceOf: (key) => {
      read.add(key);
      return texts[key] ?? BOT_TEXT_CATALOG[key].source;
    },
  };
  return { read, source };
};

afterEach(() => {
  setBotTextSource(defaultBotTextSource);
});

describe('the assembled messages, against the real assembly', () => {
  it('describes every message the bot assembles', () => {
    expect(ASSEMBLED.map((m) => m.id).sort()).toEqual(Object.keys(REAL).sort());
  });

  it.each(ASSEMBLED)('M1 estimates $id exactly at its widest inputs', (message) => {
    const real = Math.max(...REAL[message.id]!().map(lengthOf));
    expect(real).toBe(estimateBotTextMessage(message, defaultBotTextSource));
  });

  it.each(ASSEMBLED)('M2 reads exactly the keys of $id', (message) => {
    const { read, source } = recording();
    setBotTextSource(source);
    REAL[message.id]!();
    expect([...read].sort()).toEqual([...botTextMessageKeys(message)].sort());
  });

  // #358: the variables an override adds are measured at the widest value the bot prints
  it('M6 estimates /settings exactly with every variable of its keys in the texts', () => {
    const texts = {
      settings: 'Привет, {firstName}! Сейчас: {level}, ставка {stake}',
      settingsStake: '{firstName}: {stake} ({level})',
    };
    const message = ASSEMBLED.find((m) => m.id === 'settings')!;
    setBotTextSource(recording(texts).source);
    const real = Math.max(...REAL.settings!().map(lengthOf));
    expect(real).toBe(estimateBotTextMessage(message, recording(texts).source));
    const { read, source } = recording(texts);
    setBotTextSource(source);
    REAL.settings!();
    expect([...read].sort()).toEqual([...botTextMessageKeys(message)].sort());
  });

  it.each(['intentStatus', 'analysisSignal', 'analysisNoSignal'])(
    'M5 estimates %s exactly with markup and entities in the labels',
    (id) => {
      const texts = { actionUp: '<b></b>'.repeat(9), actionDown: '&amp;'.repeat(12) };
      const message = ASSEMBLED.find((m) => m.id === id)!;
      setBotTextSource(recording(texts).source);
      const real = Math.max(...REAL[id]!().map(lengthOf));
      expect(real).toBe(estimateBotTextMessage(message, recording(texts).source));
    },
  );

  // two overrides, each valid on its own, must not break /account for an unknown address
  it('V11 renders an overridden account line with an overridden unknown address', () => {
    const line = { key: 'accountLineActive', source: '✅ Подключён: <code>{email}</code>' };
    const unknown = { key: 'accountUnknownAddress', source: '<b>адрес неизвестен</b>' };
    const resolved = resolveBotTextOverrides([line, unknown]);
    expect([...resolved.texts.keys()].sort()).toEqual([
      'accountLineActive',
      'accountUnknownAddress',
    ]);
    expect(botTextChangeProblems(unknown.key, unknown.source, [line])).toEqual([]);
    setBotTextSource(resolved.source);
    expect(TEXTS.accountLineActive({ email: null }).value).toBe(
      '✅ Подключён: <code>&lt;b&gt;адрес неизвестен&lt;/b&gt;</code>',
    );
  });

  it.each(['intentStatus', 'analysisSignal', 'analysisNoSignal'])(
    'M4 estimates %s exactly with a long label overridden',
    (id) => {
      const texts = { actionUp: 'я'.repeat(64), demoDuration15: 'я'.repeat(64) };
      const message = ASSEMBLED.find((m) => m.id === id)!;
      setBotTextSource(recording(texts).source);
      const real = Math.max(...REAL[id]!().map(lengthOf));
      expect(real).toBe(estimateBotTextMessage(message, recording(texts).source));
    },
  );
});
