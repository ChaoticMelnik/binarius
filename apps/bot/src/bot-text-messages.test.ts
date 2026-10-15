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
  MAX_PAIR_DIGITS,
  SessionTradeResult,
  NotificationLevel,
  MomentumDirection,
  NoSignalReason,
  pairLabel,
  plainTextOf,
  RULE_REFUSAL_REASONS,
  telegramHtml,
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
  type PairTypeGroup,
  type PairView,
  type SignalDecision,
  type TelegramHtml,
  type TradingSessionView,
  type TradingSignalResponse,
} from '@binarius/shared';
import { analysisScreen, analysisUnavailableScreen } from './analysis';
import { DEMO_DURATIONS_SEC, type DemoDurationSec } from './demo-catalog';
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
  paysupportText,
  demoDurationsScreen,
  demoPairsScreen,
  demoSummary,
  cycleStakeText,
  launchText,
  helpText,
  intentStatusText,
  sessionCardFooter,
  sessionStatusText,
  sessionTexts as notices,
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
const d = (value: string) => value as DecimalString;
const lengthOf = (text: TelegramHtml) => plainTextOf(text).length;
const NAME = x(W.firstName);

// a payout of six characters whose break-even share is five («100.0»), below the cycle floor so the
// analysis prints its note too (#379)
const pair: PairView = { ...PAIR_EURUSD, symbol: x(W.symbol), payout: 0.0001 };
const GROUPS: PairTypeGroup[] = [
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
    Object.values(TradeMode).flatMap((mode) =>
      // a saved real stake, or none: the real hint's {stake} is then the minimum or its label
      [null, STAKE].map((realStake) =>
        statusCard({
          firstName: NAME,
          mode,
          tokens: { balance: COUNT, reserved: COUNT, available: COUNT },
          broker,
          brokerUnavailable,
          demoStake: STAKE,
          realStake,
        }),
      ),
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
  atrTicks: 999_999_999.9,
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
// in both modes: the disclaimer and the hint follow the user's mode (#121); with the amounts'
// line and without it (#482)
const screens = (responses: TradingSignalResponse[]) =>
  responses.flatMap((response) =>
    DEMO_DURATIONS_SEC.flatMap((durationSec) =>
      Object.values(TradeMode).flatMap((mode) =>
        [false, true].map(
          (chooseAmount) =>
            analysisScreen({ mode, pair: widePair, durationSec, response, chooseAmount }).text,
        ),
      ),
    ),
  );
// The card's indicators (#482): each word at the widest number, and «данных мало» at the widest
// counts; with no field, all three short at 0
const WIDE = -999_999_999.5;
const SHORT = { ok: false, closedCandles: 99_999, required: 99_999 } as const;
const macdOf = (cross: string, histogram: number) => ({
  ok: true,
  macd: 0,
  signal: 0,
  histogram,
  cross,
});
const MACDS = [
  macdOf('up', WIDE),
  macdOf('down', WIDE),
  macdOf('none', WIDE),
  macdOf('none', -WIDE),
  macdOf('none', 0),
  SHORT,
];
const MAS = [
  { ok: true, value: WIDE, lastClose: WIDE },
  { ok: true, value: WIDE, lastClose: 1 },
  { ok: true, value: WIDE, lastClose: -999_999_999.75 },
  SHORT,
];
const INDICATORS = [
  undefined,
  ...MACDS.flatMap((macd) => MAS.map((ma) => ({ macd, ma50: ma, ma200: ma }))),
];
const cardFeatures = Object.values(TrendDirection).flatMap((trend) =>
  [100, 0, 50].map((rsi) => ({ ...featuresOf(trend, MomentumDirection.Up), rsi })),
);
const cards = () =>
  screens(
    Object.values(TradeAction).flatMap((action) =>
      cardFeatures.flatMap((features) =>
        INDICATORS.map((indicators) =>
          tradingSignalResponseSchema.parse({
            ...decided({ kind: SignalKind.Signal, action, features }),
            ...(indicators === undefined ? {} : { indicators }),
          }),
        ),
      ),
    ),
  );
const DATA_DETAILS = {
  [NoSignalReason.InsufficientCandles]: { detail: { closedCandles: 1, required: 2 } },
  [NoSignalReason.CandleGap]: { detail: { index: 1, expectedTimestamp: 1, actualTimestamp: 2 } },
  [NoSignalReason.Stale]: { detail: { lastCandleTimestamp: 1, ageMs: 2, maxAgeMs: 1 } },
  [NoSignalReason.InvalidCandle]: { detail: { index: 1, problem: 'ohlc_order' } },
};

// each in both modes: the header follows the view's mode (#121)
const intentViews = [
  ...Object.values(TradeIntentStatus)
    .filter((status) => status !== TradeIntentStatus.Rejected)
    .map((status) => ({ status, lastError: null })),
  ...[null, ...Object.values(TradeIntentFailureReason)].map((lastError) => ({
    status: TradeIntentStatus.Rejected,
    lastError,
  })),
].flatMap((view) => Object.values(TradeMode).map((mode) => ({ ...view, mode })));

const N = 999;
// none, one read before the last trade at the widest age statusCards uses, one read after (#337)
const SESSION_BALANCES: TradingSessionView['balance'][] = [
  null,
  { available: USD, ageSec: 99_999 * 60, current: false },
  { available: USD, ageSec: 0, current: true },
];
const sessionTexts = (
  status: TradingSessionStatus,
  stopReasons: (TradingSessionStopReason | null)[],
): TelegramHtml[] =>
  [pairLabel({ symbol: x(W.symbol + 10), isOtc: true }), null].flatMap((symbol) =>
    [...DEMO_DURATIONS_SEC, INT4_MAX].flatMap((durationSec) =>
      stopReasons.flatMap((stopReason) =>
        [0, 1, 2, N].flatMap((settled) =>
          [null, ...Object.values(TradeIntentStatus).map((s) => intentView({ status: s }))].flatMap(
            (lastIntent) =>
              Object.values(TradeMode).flatMap((mode) =>
                SESSION_BALANCES.map((balance) =>
                  sessionStatusText(
                    symbol,
                    sessionView({
                      mode,
                      status,
                      stopReason,
                      settings: {
                        ...SESSION_VIEW.settings!,
                        assetId: INT4_MAX,
                        durationSec,
                        stake: { baseStake: STAKE, stakeScale: 8 },
                      },
                      trades: {
                        planned: N,
                        settled,
                        rejected: 0,
                        won: N,
                        lost: N,
                        tied: N,
                        profit: USD,
                      },
                      lastIntent,
                      balance,
                    }),
                    { deadline: true },
                  ),
                ),
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
  // each state at its widest, five lines of it (#118)
  paysupport: () =>
    [
      { status: 'paid' as const, requested: false },
      { status: 'held' as const, requested: false },
      { status: 'paid' as const, requested: true },
      { status: 'refunded' as const, requested: true },
    ].map((state) =>
      paysupportText(
        Array.from({ length: W.paysupportLines }, () => ({
          id: '6c1f6a2e-3b7d-4c55-9a51-2f6b8e7d9a10',
          paidAt: 1_790_000_000,
          packageCode: 'p50',
          totalAmount: INT4_MAX,
          ...state,
        })),
      ),
    ),
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
  analysisCard: cards,
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
    [pairLabel({ symbol: x(W.symbol + 10), isOtc: true }), null].flatMap((symbol) =>
      [...DEMO_DURATIONS_SEC, INT4_MAX].flatMap((durationSec) =>
        Object.values(TradeAction).flatMap((action) =>
          intentViews.flatMap((view) =>
            // the two tails the callers draw, never both (#360)
            [{ deadline: true }, { sessionOffer: true }].map((tail) =>
              intentStatusText(
                symbol,
                intentView({ ...view, action, durationSec, amount: STAKE, assetId: 9_999_999_999 }),
                tail,
              ),
            ),
          ),
        ),
      ),
    ),
  demoPairs: () => GROUPS.map((group) => demoPairsScreen(group, 998, 999)),
  demoDurations: () => [demoDurationsScreen(pair)],
  // the header by the session's mode (#327)
  sessionNoSettings: () =>
    Object.values(TradeMode).map((mode) =>
      sessionStatusText(null, sessionView({ mode, settings: null })),
    ),
  sessionRunning: () =>
    [TradingSessionStatus.Active, TradingSessionStatus.Paused].flatMap((status) =>
      sessionTexts(status, [null]),
    ),
  sessionCompleted: () =>
    sessionTexts(TradingSessionStatus.Stopped, [TradingSessionStopReason.Completed]),
  sessionStopped: () => sessionTexts(TradingSessionStatus.Stopped, [...STOP_REASONS, null]),
  // a session's trade, sent by the backend through the same builder (#464): each class, with and
  // without the adaptive line, the prices with the most digits a pair has and as String() prints
  // the widest double
  sessionTrade: () =>
    Object.values(SessionTradeResult).flatMap((result) =>
      [d('1'), STAKE].flatMap((baseStake) =>
        [
          { digits: MAX_PAIR_DIGITS, price: -999_999_999.123 },
          { digits: null, price: -1.2345678901234567e-308 },
        ].map(({ digits, price }) =>
          notices.sessionTradeText({
            amount: STAKE,
            outcome: d('-9999999999999.99999999'),
            result,
            openPrice: price,
            closePrice: price,
            digits,
            cycle: N,
            step: N,
            baseStake,
          }),
        ),
      ),
    ),
  // the finished session's summary, sent by the backend through the same builder (#464)
  sessionSummary: () =>
    [pairLabel({ symbol: x(W.symbol + 10), isOtc: true }), null].flatMap((symbol) =>
      [TradingSessionStopReason.Completed, ...STOP_REASONS].flatMap((stopReason) =>
        Object.values(TradeMode).flatMap((mode) =>
          SESSION_BALANCES.flatMap((balance) =>
            // each plural of the count
            [N, 992, 991].map((settled) =>
              notices.sessionSummaryText(symbol, INT4_MAX, {
                mode,
                stopReason,
                trades: {
                  planned: N,
                  settled,
                  rejected: 0,
                  won: N,
                  lost: N,
                  tied: N,
                  profit: USD,
                },
                balance,
              }),
            ),
          ),
        ),
      ),
    ),
  // the card's footer (#318): plain text on the image, at each plural and every count tied
  sessionCardFooter: () =>
    [N, 992, 991].map(
      (count) => telegramHtml`${sessionCardFooter(count, { won: N, lost: N, tied: N })}`,
    ),
  settings: () =>
    Object.values(NotificationLevel).flatMap((level) =>
      [null, STAKE].flatMap((stake) =>
        [null, STAKE].map((realStake) => settingsText(level, stake, realStake, NAME)),
      ),
    ),
  // by the picker's mode (#326)
  stakePicker: () =>
    Object.values(TradeMode).flatMap((mode) =>
      [null, STAKE].flatMap((stake) =>
        [0, 1].map((presets) =>
          stakePickerText({
            user: {
              ...userContextOf(NAME, mode, {
                tokens: { balance: COUNT, reserved: COUNT, available: COUNT },
                broker: null,
                demoStake: stake,
                realStake: stake,
              }),
              stake,
            },
            mode,
            minTradeAmount: STAKE,
            demoAvailable: STAKE,
            realAvailable: STAKE,
            presets,
          }),
        ),
      ),
    ),
  demoSummary: () =>
    DEMO_DURATIONS_SEC.map((durationSec: DemoDurationSec) => demoSummary(pair, durationSec)),
  // #476: the amount screen, with and without the saved line, the amounts or none
  demoCycleStake: () =>
    [
      undefined,
      ...Object.values(TradeMode).flatMap((mode) => [
        { amount: null, mode },
        { amount: STAKE, mode },
      ]),
    ].flatMap((saved) =>
      [false, true].flatMap((empty) =>
        [999, 992, 991].flatMap((trades) =>
          DEMO_DURATIONS_SEC.map((durationSec: DemoDurationSec) =>
            cycleStakeText({
              firstName: NAME,
              durationSec,
              symbol: pairLabel(pair),
              stake: STAKE,
              access: {
                tokens: { balance: COUNT, reserved: COUNT, available: COUNT },
                broker: brokerBalance(),
                demoStake: STAKE,
                realStake: STAKE,
              },
              broker: brokerBalance(),
              empty,
              trades,
              ...(saved === undefined ? {} : { saved }),
            }),
          ),
        ),
      ),
    ),
  // the three plurals, each at the widest count
  demoLaunch: () =>
    [
      undefined,
      ...Object.values(TradeMode).flatMap((mode) => [
        { amount: null, mode },
        { amount: STAKE, mode },
      ]),
    ].flatMap((saved) =>
      [null, STAKE].flatMap((amount) =>
        [999, 992, 991].flatMap((trades) =>
          DEMO_DURATIONS_SEC.flatMap((durationSec: DemoDurationSec) =>
            // the cycle's line by mode (#327)
            Object.values(TradeMode).map((mode) =>
              launchText({
                firstName: NAME,
                durationSec,
                symbol: pairLabel(pair),
                amount,
                trades,
                saved,
                mode,
              }),
            ),
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
      settingsStakeReal: '{level}: {stake}, {firstName}',
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

  it.each(['intentStatus', 'analysisNoSignal'])(
    'M5 estimates %s exactly with markup and entities in the labels',
    (id) => {
      const texts = { actionUp: '<b></b>'.repeat(9), actionDown: '&amp;'.repeat(12) };
      const message = ASSEMBLED.find((m) => m.id === id)!;
      setBotTextSource(recording(texts).source);
      const real = Math.max(...REAL[id]!().map(lengthOf));
      expect(real).toBe(estimateBotTextMessage(message, recording(texts).source));
    },
  );

  // #482: the block's columns follow the longest label after the overrides, by String#length
  it.each([
    [
      'M4',
      'a long label and a long word',
      { cardRowTrend: '🟢'.repeat(20), macdCrossUp: 'я'.repeat(64), rsiOverbought: 'я'.repeat(40) },
    ],
    [
      'M5',
      'markup and entities in the labels',
      {
        cardRowPair: '<b></b>'.repeat(3),
        cardRowDirection: '&amp;'.repeat(4),
        cardDirectionUp: '<i>x</i>'.repeat(5),
        maPriceEqual: '&lt;'.repeat(9),
      },
    ],
  ])('%s estimates analysisCard exactly with %s', (_id, _case, texts) => {
    const message = ASSEMBLED.find((m) => m.id === 'analysisCard')!;
    setBotTextSource(recording(texts).source);
    const real = Math.max(...REAL.analysisCard!().map(lengthOf));
    expect(real).toBe(estimateBotTextMessage(message, recording(texts).source));
  });

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

  it.each(['intentStatus', 'analysisNoSignal'])(
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
