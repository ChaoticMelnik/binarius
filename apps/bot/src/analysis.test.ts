import { afterEach, describe, expect, it } from 'vitest';
import {
  BrokerRestErrorCode,
  defaultBotTextSource,
  type BotTextKey,
  CandleProblem,
  DATA_REFUSAL_REASONS,
  intervalForDuration,
  MomentumDirection,
  NoSignalReason,
  plainTextOf,
  RULE_REFUSAL_REASONS,
  SIGNAL_ALGORITHM_VERSION,
  SIGNAL_CHART_INTERVAL_MS,
  SignalFeedOutcome,
  SignalKind,
  TELEGRAM_MESSAGE_LIMIT,
  TradeAction,
  TrendDirection,
  type DataRefusalReason,
  type SignalDataRefusal,
  type SignalDecision,
  type TradingSignalResponse,
} from '@binarius/shared';
import { telegramTextProblems } from '@binarius/shared/testing';
import {
  analysisScreen,
  analysisUnavailableScreen,
  formatAtrPct,
  formatAtrTicks,
  formatPrice,
  formatRsi,
  NO_SIGNAL_REASON_TEXT,
} from './analysis';
import { DEMO_DURATIONS_SEC } from './demo-catalog';
import {
  PAIR_EURUSD,
  SIGNAL_DATA_REFUSAL,
  SIGNAL_DECIDED,
  SIGNAL_FEATURES,
  SIGNAL_FETCH_FAILED,
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

const screenOf = (response: TradingSignalResponse, pair = PAIR_EURUSD) =>
  analysisScreen({ pair, durationSec: 5, response });
const linesOf = (response: TradingSignalResponse, pair = PAIR_EURUSD) =>
  plainTextOf(screenOf(response, pair).text).split('\n');
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

  // A2: the fixture's periods (EMA7/25, RSI10, ATR12) are not the decider's defaults
  it('prints every number of a signal from the answer and the pair, and no other number', () => {
    const text = plainTextOf(screenOf(SIGNAL_DECIDED).text);
    const numbers = (text.match(/\d+(?:\.\d+)?/g) ?? []).sort();
    const expected = [
      // the header's duration label, «⏱ 5 с»
      '5',
      String(SIGNAL_PARAMS.emaFast),
      formatPrice(SIGNAL_FEATURES.emaFast, PAIR_EURUSD.digits),
      String(SIGNAL_PARAMS.emaSlow),
      formatPrice(SIGNAL_FEATURES.emaSlow, PAIR_EURUSD.digits),
      String(SIGNAL_PARAMS.rsiPeriod),
      formatRsi(SIGNAL_FEATURES.rsi),
      String(SIGNAL_PARAMS.atrPeriod),
      formatAtrPct(SIGNAL_FEATURES.atrPct),
      formatAtrTicks(SIGNAL_FEATURES.atrTicks),
      String(SIGNAL_FEATURES.closedCandles),
      formatPrice(SIGNAL_FEATURES.lastClose, PAIR_EURUSD.digits),
      String(PAIR_EURUSD.payout),
      formatBreakEven(PAIR_EURUSD.payout),
    ].sort();
    expect(numbers).toEqual(expected);
  });

  it('lays out a signal: the header, the headline, the features, the payout, the disclaimer', () => {
    expect(plainTextOf(screenOf(SIGNAL_DECIDED).text)).toBe(
      `📊 Анализ: EUR/USD OTC · ⏱ 5 с
📈 Сигнал: ⬆️ Вверх

📐 Тренд по EMA: вверх — EMA7 1.08542 выше EMA25 1.08511
⚡ Импульс по RSI: вверх — RSI10 62.3
🌊 Волатильность по ATR: в норме — ATR12 0.041% · 44.7 шага котировки
🕯 Закрытых свечей: 59
💲 Последняя цена: 1.08560
💰 Выплата: 85% — размер выигрыша при верном прогнозе, не вероятность. Безубыточность: 54.1% верных прогнозов.

⚠️ Сигнал — не прогноз результата и не гарантия. Это демо: деньги не нужны.`,
    );
    expect(plainTextOf(screenOf(signalOf(TradeAction.Down)).text)).toContain('📉 Сигнал: ⬇️ Вниз');
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
    expect(volatilityOf(SIGNAL_DECIDED)).toMatch(/: в норме — /);
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
      const { text } = analysisScreen({ pair, durationSec: 15, response });
      expect(telegramTextProblems(text, TELEGRAM_MESSAGE_LIMIT)).toEqual([]);
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
    return analysisScreen({ pair: PAIR_EURUSD, durationSec: 5, response }).text.value;
  };

  it.each<[string, BotTextKey, TradingSignalResponse]>([
    ['the headline', 'analysisSignalUp', SIGNAL_DECIDED],
    ['the reason', 'noSignalRsiNeutral', SIGNAL_NO_SIGNAL],
    ['the trend word', 'trendUp', SIGNAL_DECIDED],
    ['the momentum word', 'momentumUp', SIGNAL_DECIDED],
    ['the volatility word', 'volatilityNormal', SIGNAL_DECIDED],
    ['the EMA relation', 'emaAbove', SIGNAL_DECIDED],
  ])('shows %s from the source in place', (_name, key, response) => {
    expect(screenWith(key, response)).toContain(stubText(key));
  });
});
