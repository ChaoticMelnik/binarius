import { afterEach, describe, expect, it } from 'vitest';
import {
  BrokerRestErrorCode,
  defaultBotTextSource,
  type BotTextKey,
  CandleProblem,
  DATA_REFUSAL_REASONS,
  intervalForDuration,
  MacdCross,
  MomentumDirection,
  NoSignalReason,
  plainTextOf,
  RULE_REFUSAL_REASONS,
  SIGNAL_ALGORITHM_VERSION,
  SIGNAL_CHART_INTERVAL_MS,
  SignalFeedOutcome,
  SignalKind,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  TradeAction,
  TradeMode,
  TrendDirection,
  type DataRefusalReason,
  type SignalDataRefusal,
  type SignalDecision,
  type SignalIndicators,
  type TradingSignalResponse,
  formatPrice,
  tradingSignalResponseSchema,
} from '@binarius/shared';
import { telegramTextProblems } from '@binarius/shared/testing';
import {
  analysisScreen,
  analysisUnavailableScreen,
  cardBlock,
  formatAtrPct,
  formatAtrTicks,
  formatRsi,
  NO_SIGNAL_REASON_TEXT,
} from './analysis';
import { DEMO_DURATIONS_SEC } from './demo-catalog';
import {
  PAIR_EURUSD,
  SIGNAL_CARD,
  SIGNAL_DATA_REFUSAL,
  SIGNAL_DECIDED,
  SIGNAL_FEATURES,
  SIGNAL_FETCH_FAILED,
  SIGNAL_INDICATORS,
  SIGNAL_NO_SIGNAL,
  SIGNAL_PARAMS,
  signalDecided,
  stubText,
  stubTextSource,
} from './testing';
import { formatBreakEven, setBotTextSource, TEXTS } from './texts';

const head = { version: SIGNAL_ALGORITHM_VERSION } as const;
const signalOf = (action: TradeAction, features = SIGNAL_FEATURES) =>
  signalDecided({ ...head, kind: SignalKind.Signal, action, features });
const ruleRefusalOf = (reason: (typeof RULE_REFUSAL_REASONS)[number], features = SIGNAL_FEATURES) =>
  signalDecided({ ...head, kind: SignalKind.NoSignal, reason, features });

const DATA_DETAILS: { [R in DataRefusalReason]: Extract<SignalDataRefusal, { reason: R }> } = {
  [NoSignalReason.InvalidCandle]: {
    reason: NoSignalReason.InvalidCandle,
    detail: { index: 3, problem: CandleProblem.OhlcOrder },
  },
  [NoSignalReason.CandleGap]: {
    reason: NoSignalReason.CandleGap,
    detail: { index: 12, expectedTimestamp: 1, actualTimestamp: 2 },
  },
  [NoSignalReason.Stale]: {
    reason: NoSignalReason.Stale,
    detail: { lastCandleTimestamp: 1, ageMs: 300_000, maxAgeMs: 120_000 },
  },
  [NoSignalReason.InsufficientCandles]: {
    reason: NoSignalReason.InsufficientCandles,
    detail: { closedCandles: 12, required: 50 },
  },
};
const dataRefusalOf = (reason: DataRefusalReason) =>
  signalDecided({ ...head, kind: SignalKind.NoSignal, ...DATA_DETAILS[reason] } as SignalDecision);

const screenOf = (
  response: TradingSignalResponse,
  pair = PAIR_EURUSD,
  mode: TradeMode = TradeMode.Demo,
  chooseAmount = false,
) => analysisScreen({ mode, pair, durationSec: 5, response, chooseAmount });
const linesOf = (
  response: TradingSignalResponse,
  pair = PAIR_EURUSD,
  mode: TradeMode = TradeMode.Demo,
  chooseAmount = false,
) => plainTextOf(screenOf(response, pair, mode, chooseAmount).text).split('\n');
const SIGNAL_DECISION_DOWN = {
  ...head,
  kind: SignalKind.Signal,
  action: TradeAction.Down,
  features: SIGNAL_FEATURES,
} as const;
// SIGNAL_CARD with some indicators and features replaced
const cardWith = (
  indicators: Partial<SignalIndicators>,
  features: Partial<typeof SIGNAL_FEATURES> = {},
): string[] =>
  linesOf(
    tradingSignalResponseSchema.parse({
      ...SIGNAL_CARD,
      decision: {
        ...head,
        kind: SignalKind.Signal,
        action: TradeAction.Up,
        features: { ...SIGNAL_FEATURES, ...features },
      },
      indicators: { ...SIGNAL_INDICATORS, ...indicators },
    }),
  );
// the value of the block's row with this label
const rowOf = (lines: string[], label: string): string | undefined => {
  const line = lines.find((candidate) => candidate.startsWith(`${label} `));
  return line?.slice('Волатильность '.length);
};
const FEATURE_PREFIXES = ['📐 Тренд по EMA:', '⚡ Импульс по RSI:', '🌊 Волатильность по ATR:'];
const hasFeatureLines = (lines: string[]) =>
  FEATURE_PREFIXES.every((prefix) => lines.some((line) => line.startsWith(prefix)));

describe('the analysis screen', () => {
  // A1
  it("maps each demo duration onto a candle interval of exactly that length (shared's table)", () => {
    for (const durationSec of DEMO_DURATIONS_SEC) {
      expect(SIGNAL_CHART_INTERVAL_MS[intervalForDuration(durationSec)], String(durationSec)).toBe(
        durationSec * 1000,
      );
    }
  });

  // A2 (#482): the card prints the answer's features and indicators and the pair's payout only
  it("prints every number of a signal's card from the answer and the pair, and no other number", () => {
    const text = plainTextOf(screenOf(SIGNAL_CARD).text);
    const numbers = (text.match(/\d+(?:\.\d+)?/g) ?? []).sort();
    const { macd, ma50, ma200 } = SIGNAL_INDICATORS;
    if (!macd.ok || !ma50.ok || !ma200.ok) throw new Error('the fixture has every indicator');
    const expected = [
      // the header's duration label, «⏱ 5 с»
      '5',
      // the row labels MA50 and MA200
      '50',
      '200',
      formatRsi(SIGNAL_FEATURES.rsi),
      formatPrice(macd.histogram, PAIR_EURUSD.digits + 1),
      formatPrice(ma50.value, PAIR_EURUSD.digits),
      formatPrice(ma200.value, PAIR_EURUSD.digits),
      formatAtrPct(SIGNAL_FEATURES.atrPct),
      String(PAIR_EURUSD.payout),
      formatBreakEven(PAIR_EURUSD.payout),
    ].sort();
    expect(numbers).toEqual(expected);
  });

  // AC 1 (#482)
  it('lays out a signal as a card: the header, the title, the block, the payout, the disclaimer', () => {
    expect(plainTextOf(screenOf(SIGNAL_CARD).text)).toBe(
      `📊 Анализ: EUR/USD OTC · ⏱ 5 с
🟢 Сильный сигнал на рост

Пара          EUR/USD OTC
RSI           нейтрально 62.3
MACD          выше сигнальной 0.000023
MA50          цена выше 1.08531
MA200         цена ниже 1.08612
Тренд EMA     вверх
Волатильность в норме 0.041%
Направление   ⬆️ ВВЕРХ 🟢
💰 Выплата: 85% — размер выигрыша при верном прогнозе, не вероятность. Безубыточность: 54.1% верных прогнозов.

⚠️ Сигнал — не прогноз результата и не гарантия. Это демо: деньги не нужны.`,
    );
    expect(screenOf(SIGNAL_CARD).text.value).toContain(
      '<pre>Пара          EUR/USD OTC\nRSI           нейтрально 62.3\n',
    );
    expect(screenOf(SIGNAL_CARD).text.value).toContain('⬆️ ВВЕРХ 🟢</pre>\n💰');
    expect(screenOf(SIGNAL_CARD).photo).toBe(TradeAction.Up);
    const down = screenOf(
      tradingSignalResponseSchema.parse({ ...SIGNAL_CARD, decision: SIGNAL_DECISION_DOWN }),
    );
    expect(down.photo).toBe(TradeAction.Down);
    const downLines = plainTextOf(down.text).split('\n');
    expect(downLines[1]).toBe('🔴 Сильный сигнал на падение');
    expect(downLines).toContain('Направление   ⬇️ ВНИЗ 🔴');
  });

  it('lines the values up in one column, after the longest label', () => {
    const block = linesOf(SIGNAL_CARD).slice(3, 11);
    expect(block).toHaveLength(8);
    const column = 'Волатильность '.length;
    for (const line of block) {
      expect(line.slice(0, column).trimEnd().length, line).toBeLessThan(column);
      expect(line[column - 1], line).toBe(' ');
      expect(line[column], line).not.toBe(' ');
    }
    // the width is String#length: a label with a pair of surrogates is two wide
    expect(
      cardBlock([
        ['🟢🟢', 'a'],
        ['abc', 'b'],
      ]).split('\n'),
    ).toEqual(['🟢🟢 a', 'abc  b']);
  });

  // #482: the RSI's word by the decision's rsiExtremeBand (15 in the fixture), never rsiBand (5)
  it.each([
    [62.34, 'нейтрально 62.3'],
    [60, 'нейтрально 60.0'],
    [65, 'перекуплен 65.0'],
    [64.99, 'нейтрально 65.0'],
    [35, 'перепродан 35.0'],
    [35.01, 'нейтрально 35.0'],
  ])('says RSI %f is «%s»', (rsi, value) => {
    expect(rowOf(cardWith({}, { rsi }), 'RSI')).toBe(value);
  });

  // #482: a cross on the last candle first, the side by the histogram's sign otherwise
  it.each([
    [MacdCross.Up, 0.00002, 'пересечение вверх 0.000020'],
    [MacdCross.Down, -0.00002, 'пересечение вниз -0.000020'],
    [MacdCross.None, 0.00002, 'выше сигнальной 0.000020'],
    [MacdCross.None, -0.00002, 'ниже сигнальной -0.000020'],
    [MacdCross.None, 0, 'на сигнальной 0.000000'],
  ])('says MACD with cross %s and histogram %f is «%s»', (cross, histogram, value) => {
    const macd = { ok: true as const, macd: 0.0001, signal: 0.0001 - histogram, histogram, cross };
    expect(rowOf(cardWith({ macd }), 'MACD')).toBe(value);
  });

  it.each([
    [1.0856, 'цена выше 1.08500'],
    [1.0844, 'цена ниже 1.08500'],
    [1.085, 'цена на MA 1.08500'],
  ])('says a last close of %f against MA 1.085 is «%s»', (lastClose, value) => {
    const ma = { ok: true as const, value: 1.085, lastClose };
    const card = cardWith({ ma50: ma, ma200: ma });
    expect(rowOf(card, 'MA50')).toBe(value);
    expect(rowOf(card, 'MA200')).toBe(value);
  });

  // AC 3: an indicator short of candles says so, with no number of its own
  it('says «данных мало» for an indicator short of candles, and prints no value for it', () => {
    const card = cardWith({
      ma200: { ok: false, closedCandles: 149, required: 200 },
      macd: { ok: false, closedCandles: 20, required: 35 },
    });
    expect(rowOf(card, 'MA200')).toBe('данных мало (149 из 200)');
    expect(rowOf(card, 'MACD')).toBe('данных мало (20 из 35)');
    expect(rowOf(card, 'MA50')).toBe('цена выше 1.08531');
  });

  it('says «данных мало» on all three indicators when the answer has none', () => {
    const lines = linesOf(SIGNAL_DECIDED);
    expect(rowOf(lines, 'MACD')).toBe('данных мало (0 из 35)');
    expect(rowOf(lines, 'MA50')).toBe('данных мало (0 из 50)');
    expect(rowOf(lines, 'MA200')).toBe('данных мало (0 из 200)');
    expect(lines.slice(3, 11)).toHaveLength(8);
  });

  // AC 2, 3: the answer exactly as the feed gives it on 118 rows with the forming one (part 1's
  // feed.test.ts F13): MA200 short, MA50 and MACD with their numbers
  it('prints the indicators of an answer shaped as the feed gives it on 117 closed candles', () => {
    const response = tradingSignalResponseSchema.parse({
      ...SIGNAL_DECIDED,
      indicators: {
        macd: {
          ok: true,
          macd: 0.0000412,
          signal: 0.0000376,
          histogram: 0.0000036,
          cross: 'none',
        },
        ma50: { ok: true, value: 1.0854417, lastClose: 1.085604 },
        ma200: { ok: false, closedCandles: 117, required: 200 },
      },
    });
    const lines = linesOf(response);
    expect(rowOf(lines, 'MACD')).toBe('выше сигнальной 0.000004');
    expect(rowOf(lines, 'MA50')).toBe('цена выше 1.08544');
    expect(rowOf(lines, 'MA200')).toBe('данных мало (117 из 200)');
  });

  it('ends a demo card over the amounts with «Выбери сумму сделки 👇», and only then', () => {
    const lines = linesOf(SIGNAL_CARD, PAIR_EURUSD, TradeMode.Demo, true);
    expect(lines.slice(-3)).toEqual([
      plainTextOf(TEXTS.analysisDisclaimer),
      '',
      'Выбери сумму сделки 👇',
    ]);
    expect(linesOf(SIGNAL_CARD)).not.toContain('Выбери сумму сделки 👇');
    expect(linesOf(SIGNAL_CARD).at(-1)).toBe(plainTextOf(TEXTS.analysisDisclaimer));
    // a refusal has no card and no amounts
    expect(linesOf(SIGNAL_NO_SIGNAL, PAIR_EURUSD, TradeMode.Demo, true)).not.toContain(
      'Выбери сумму сделки 👇',
    );
  });

  // AC 4: no signal and a broker failure stay text, with no picture
  it('draws no picture on any screen but a signal', () => {
    for (const response of [
      SIGNAL_NO_SIGNAL,
      SIGNAL_DATA_REFUSAL,
      SIGNAL_FETCH_FAILED,
      ...RULE_REFUSAL_REASONS.map((reason) => ruleRefusalOf(reason)),
      ...DATA_REFUSAL_REASONS.map(dataRefusalOf),
    ]) {
      expect(screenOf(response).photo).toBeNull();
    }
    expect(analysisUnavailableScreen(PAIR_EURUSD, 5).photo).toBeNull();
  });

  // A3
  it.each(RULE_REFUSAL_REASONS)(
    'names the rule refusal %s in words and keeps the features',
    (reason) => {
      const lines = linesOf(ruleRefusalOf(reason));
      expect(lines[1]).toBe(`⏸ Сигнала нет: ${NO_SIGNAL_REASON_TEXT[reason]}`);
      expect(hasFeatureLines(lines)).toBe(true);
      expect(lines.at(-1)).toBe(plainTextOf(TEXTS.analysisNoSignalHint));
    },
  );

  it('tells the volatility by the refusal', () => {
    const volatilityOf = (response: TradingSignalResponse) =>
      linesOf(response).find((line) => line.startsWith('🌊'));
    expect(volatilityOf(ruleRefusalOf(NoSignalReason.VolatilityTooLow))).toMatch(
      /: слишком низкая — /,
    );
    expect(volatilityOf(ruleRefusalOf(NoSignalReason.VolatilityTooHigh))).toMatch(
      /: слишком высокая — /,
    );
    expect(volatilityOf(ruleRefusalOf(NoSignalReason.VolatilityBelowTickFloor))).toMatch(
      /: меньше порога в шагах котировки — ATR12 0\.041% · 44\.7 шага котировки$/,
    );
    expect(volatilityOf(ruleRefusalOf(NoSignalReason.RsiOverbought))).toMatch(/: в норме — /);
    expect(volatilityOf(SIGNAL_NO_SIGNAL)).toMatch(/: в норме — /);
    expect(rowOf(linesOf(SIGNAL_DECIDED), 'Волатильность')).toBe('в норме 0.041%');
  });

  // #379: the three v2 refusals in words of their own
  it.each([
    [NoSignalReason.VolatilityBelowTickFloor, 'цена движется на считаные шаги котировки'],
    [NoSignalReason.RsiOverbought, 'RSI слишком высокий для входа вверх'],
    [NoSignalReason.RsiOversold, 'RSI слишком низкий для входа вниз'],
  ])('names %s', (reason, words) => {
    expect(linesOf(ruleRefusalOf(reason))[1]).toBe(`⏸ Сигнала нет: ${words}`);
  });

  // #379: a pair below the cycle floor keeps its analysis and its single trade, and the screen
  // says why it has no session button (demo.ts)
  it('notes under a signal on a pair paying below 80 % that no cycle starts on it', () => {
    const note = '🚫 Цикл на этой паре не запускается: выплата ниже 80%.';
    const low = linesOf(SIGNAL_DECIDED, { ...PAIR_EURUSD, payout: 79 });
    const payoutAt = low.findIndex((line) => line.startsWith('💰'));
    expect(low[payoutAt]).toContain('Безубыточность: 55.9%');
    expect(low[payoutAt + 1]).toBe(note);
    expect(screenOf(SIGNAL_DECIDED, { ...PAIR_EURUSD, payout: 79 }).stake).toBe(TradeAction.Up);
    expect(linesOf(SIGNAL_DECIDED, { ...PAIR_EURUSD, payout: 80 })).not.toContain(note);
  });

  // #379: every decided answer below the floor withholds the session row, so the note follows the
  // hint as the last line; candles not read draw no session row anywhere, so no note
  it('notes under a refusal on a pair paying below 80 % that no cycle starts on it', () => {
    const note = '🚫 Цикл на этой паре не запускается: выплата ниже 80%.';
    const low = { ...PAIR_EURUSD, payout: 79 };
    const rule = linesOf(SIGNAL_NO_SIGNAL, low);
    expect(rule.at(-2)).toBe(plainTextOf(TEXTS.analysisNoSignalHint));
    expect(rule.at(-1)).toBe(note);
    const data = linesOf(dataRefusalOf(DATA_REFUSAL_REASONS[0]), low);
    expect(data.at(-2)).toBe(plainTextOf(TEXTS.analysisDataHint));
    expect(data.at(-1)).toBe(note);
    expect(linesOf(SIGNAL_NO_SIGNAL, { ...PAIR_EURUSD, payout: 80 })).not.toContain(note);
    expect(linesOf(SIGNAL_FETCH_FAILED, low)).not.toContain(note);
  });

  // Plan 5 (decision 26): in real mode the analysis names real money
  it('ends a real signal with the real disclaimer and no demo wording', () => {
    const lines = linesOf(SIGNAL_DECIDED, PAIR_EURUSD, TradeMode.Real);
    expect(lines.at(-1)).toBe(plainTextOf(TEXTS.analysisDisclaimerReal));
    expect(lines.join('\n')).not.toMatch(/это демо|деньги не нужны/i);
  });

  // #327: the session waits for a signal in real mode too
  it('ends a real rule refusal with the session hint and a real data refusal with the data hint', () => {
    expect(linesOf(SIGNAL_NO_SIGNAL, PAIR_EURUSD, TradeMode.Real).at(-1)).toBe(
      plainTextOf(TEXTS.analysisNoSignalHint),
    );
    expect(
      linesOf(dataRefusalOf(DATA_REFUSAL_REASONS[0]), PAIR_EURUSD, TradeMode.Real).at(-1),
    ).toBe(plainTextOf(TEXTS.analysisDataHint));
  });

  // #327: the cycle floor is the session's, and sessions run in real mode too
  it('draws the cycle note in real mode on a pair below the cycle floor', () => {
    const low = { ...PAIR_EURUSD, payout: 79 };
    for (const response of [
      SIGNAL_DECIDED,
      SIGNAL_NO_SIGNAL,
      dataRefusalOf(DATA_REFUSAL_REASONS[0]),
    ]) {
      expect(linesOf(response, low, TradeMode.Real)).toContain(
        '🚫 Цикл на этой паре не запускается: выплата ниже 80%.',
      );
    }
    expect(linesOf(SIGNAL_DECIDED, low, TradeMode.Real).at(-1)).toBe(
      plainTextOf(TEXTS.analysisDisclaimerReal),
    );
  });

  it('formats the break-even share to a tenth, a dash where the payout gives none', () => {
    expect(formatBreakEven(80)).toBe('55.6');
    expect(formatBreakEven(68.9)).toBe('59.2');
    expect(formatBreakEven(0.0001)).toBe('100.0');
    expect(formatBreakEven(0)).toBe('—');
    expect(formatBreakEven(-50)).toBe('—');
    expect(formatBreakEven(Number.NaN)).toBe('—');
    expect(formatAtrTicks(2.7879)).toBe('2.8');
  });

  // A4
  it.each(DATA_REFUSAL_REASONS)('names the data refusal %s with no feature line', (reason) => {
    const lines = linesOf(dataRefusalOf(reason));
    expect(lines[1]).toBe(`⏸ Сигнала нет: ${NO_SIGNAL_REASON_TEXT[reason]}`);
    expect(lines.some((line) => FEATURE_PREFIXES.some((prefix) => line.startsWith(prefix)))).toBe(
      false,
    );
    expect(lines.at(-1)).toBe(plainTextOf(TEXTS.analysisDataHint));
  });

  // A5
  it('asks to wait the countdown on rate_limited, and says unavailable without one', () => {
    expect(linesOf(SIGNAL_FETCH_FAILED)[1]).toBe(
      '⚠️ Брокер ограничил запросы. Попробуй через 7 с.',
    );
    const withoutCountdown: TradingSignalResponse = {
      outcome: SignalFeedOutcome.FetchFailed,
      code: BrokerRestErrorCode.RateLimited,
    };
    expect(linesOf(withoutCountdown)[1]).toBe(plainTextOf(TEXTS.analysisUnavailable));
    expect(
      linesOf({ outcome: SignalFeedOutcome.FetchFailed, code: BrokerRestErrorCode.Unavailable })[1],
    ).toBe(plainTextOf(TEXTS.analysisUnavailable));
  });

  // A6
  it("offers the stake in the signal's direction, and only on a signal", () => {
    expect(screenOf(signalOf(TradeAction.Up)).stake).toBe(TradeAction.Up);
    expect(screenOf(signalOf(TradeAction.Down)).stake).toBe(TradeAction.Down);
    for (const response of [
      SIGNAL_NO_SIGNAL,
      SIGNAL_DATA_REFUSAL,
      SIGNAL_FETCH_FAILED,
      ...RULE_REFUSAL_REASONS.map((reason) => ruleRefusalOf(reason)),
      ...DATA_REFUSAL_REASONS.map(dataRefusalOf),
    ]) {
      expect(screenOf(response).stake).toBeNull();
    }
    expect(analysisUnavailableScreen(PAIR_EURUSD, 5).stake).toBeNull();
  });

  // #360: the session row on every decided answer, never where the candles were not read
  it('offers the session on every decided answer, a signal or none, and never without candles', () => {
    for (const response of [
      signalOf(TradeAction.Up),
      signalOf(TradeAction.Down),
      ...RULE_REFUSAL_REASONS.map((reason) => ruleRefusalOf(reason)),
      ...DATA_REFUSAL_REASONS.map(dataRefusalOf),
    ]) {
      expect(screenOf(response).session).toBe(true);
    }
    for (const response of [
      SIGNAL_FETCH_FAILED,
      { outcome: SignalFeedOutcome.FetchFailed, code: BrokerRestErrorCode.RateLimited },
      { outcome: SignalFeedOutcome.FetchFailed, code: BrokerRestErrorCode.Unavailable },
    ] satisfies TradingSignalResponse[]) {
      expect(screenOf(response).session).toBe(false);
    }
    expect(analysisUnavailableScreen(PAIR_EURUSD, 5).session).toBe(false);
  });

  // A7
  it('formats prices to the pair digits, RSI to a tenth and ATR% to a thousandth', () => {
    expect(formatPrice(1.085604, 2)).toBe('1.09');
    expect(formatPrice(1.085604, 7)).toBe('1.0856040');
    // clamped at MAX_PAIR_DIGITS (#379)
    expect(formatPrice(1.085604, 11)).toBe('1.0856040000');
    expect(formatRsi(62.34)).toBe('62.3');
    expect(formatAtrPct(0.0412)).toBe('0.041');
  });

  // A8
  it.each([
    ['выше', 1.2, 1.1],
    ['ниже', 1.1, 1.2],
    ['равна', 1.1, 1.1],
  ])('says the fast EMA is %s the slow one by their order', (word, emaFast, emaSlow) => {
    const features = { ...SIGNAL_FEATURES, emaFast, emaSlow, trend: TrendDirection.Flat };
    const trend = linesOf(ruleRefusalOf(NoSignalReason.TrendFlat, features)).find((line) =>
      line.startsWith('📐'),
    );
    expect(trend).toContain(` ${word} EMA${SIGNAL_PARAMS.emaSlow} `);
  });

  // A9
  it('keeps every screen valid Telegram HTML inside the message limit at the longest holes', () => {
    const pair = {
      ...PAIR_EURUSD,
      symbol: `<&>_*"`.repeat(11).slice(0, 64),
      digits: 7,
      payout: 100,
    };
    const features = {
      ...SIGNAL_FEATURES,
      emaFast: 12345.6789012,
      emaSlow: 12345.6789011,
      lastClose: 99999.9999999,
      closedCandles: 99999,
      momentum: MomentumDirection.Neutral,
    };
    const responses = [
      signalOf(TradeAction.Down, features),
      ...RULE_REFUSAL_REASONS.map((reason) => ruleRefusalOf(reason, features)),
      ...DATA_REFUSAL_REASONS.map(dataRefusalOf),
      SIGNAL_FETCH_FAILED,
    ];
    for (const response of responses) {
      const { text, photo } = analysisScreen({
        mode: TradeMode.Demo,
        pair,
        durationSec: 15,
        response,
        chooseAmount: true,
      });
      // a signal is a caption (#482)
      const limit = photo === null ? TELEGRAM_MESSAGE_LIMIT : TELEGRAM_CAPTION_LIMIT;
      expect(telegramTextProblems(text, limit)).toEqual([]);
      expect(plainTextOf(text)).toContain(pair.symbol);
      expect(text.value).not.toContain('&amp;amp;');
    }
    expect(
      telegramTextProblems(analysisUnavailableScreen(pair, 15).text, TELEGRAM_MESSAGE_LIMIT),
    ).toEqual([]);
  });
});

// Every word map and the headlines are read when a screen is built, so a source swapped after the
// module loaded reaches them: one test per map that used to hold the words themselves (#240).
describe('the text source', () => {
  afterEach(() => setBotTextSource(defaultBotTextSource));

  const screenWith = (key: BotTextKey, response: TradingSignalResponse) => {
    setBotTextSource(stubTextSource(key));
    return analysisScreen({
      mode: TradeMode.Demo,
      pair: PAIR_EURUSD,
      durationSec: 5,
      response,
      chooseAmount: true,
    }).text.value;
  };
  const disagree = ruleRefusalOf(NoSignalReason.TrendMomentumDisagree);

  it.each<[string, BotTextKey, TradingSignalResponse]>([
    ['the card title', 'analysisCardUp', SIGNAL_CARD],
    ['a row label', 'cardRowMa200', SIGNAL_CARD],
    ['the RSI word', 'rsiNeutral', SIGNAL_CARD],
    ['the MACD word', 'macdAbove', SIGNAL_CARD],
    ['the MA word', 'maPriceBelow', SIGNAL_CARD],
    ['the direction', 'cardDirectionUp', SIGNAL_CARD],
    ['the amounts line', 'analysisChooseAmount', SIGNAL_CARD],
    ['the reason', 'noSignalRsiNeutral', SIGNAL_NO_SIGNAL],
    ['the trend word', 'trendUp', SIGNAL_CARD],
    ['the momentum word', 'momentumUp', disagree],
    ['the volatility word', 'volatilityNormal', SIGNAL_CARD],
    ['the EMA relation', 'emaAbove', disagree],
  ])('shows %s from the source in place', (_name, key, response) => {
    expect(screenWith(key, response)).toContain(stubText(key));
  });

  it('shows the short-data word from the source in place, with its numbers', () => {
    expect(screenWith('indicatorShortData', SIGNAL_DECIDED)).toContain(
      'MA200         ЗАГЛУШКА indicatorShortData 0 200',
    );
  });
});
