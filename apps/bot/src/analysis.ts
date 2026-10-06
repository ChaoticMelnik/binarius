import {
  BrokerRestErrorCode,
  MomentumDirection,
  NoSignalReason,
  SignalFeedOutcome,
  SignalKind,
  telegramHtml,
  TradeAction,
  TrendDirection,
  type PairView,
  type SignalFeatures,
  type SignalParams,
  type TelegramHtml,
  type TradingSignalResponse,
} from '@binarius/shared';
import type { DemoDurationSec } from './demo-catalog';
import { DEMO_DURATION_LABELS, TEXTS } from './texts';

// The analysis screen (#126, docs/bot-demo.md): pure, from the pair read at the press and the
// backend's answer. Every number on it is the answer's — a feature, or a period from `params` —
// or the pair's payout; nothing is the bot's own. Which buttons go under it is demo.ts's.

// `satisfies Record<NoSignalReason, …>`: a reason added to shared's constant fails tsc here.
export const NO_SIGNAL_REASON_TEXT = {
  [NoSignalReason.VolatilityTooLow]: 'волатильность слишком низкая',
  [NoSignalReason.VolatilityTooHigh]: 'волатильность слишком высокая',
  [NoSignalReason.TrendFlat]: 'тренд не определён',
  [NoSignalReason.RsiNeutral]: 'импульс нейтральный',
  [NoSignalReason.TrendMomentumDisagree]: 'тренд и импульс расходятся',
  [NoSignalReason.InsufficientCandles]: 'данных по свечам пока недостаточно',
  [NoSignalReason.CandleGap]: 'в свечах есть пропуск',
  [NoSignalReason.Stale]: 'свечи брокера отстают',
  [NoSignalReason.InvalidCandle]: 'свечи пришли с ошибкой',
} as const satisfies Record<NoSignalReason, string>;

export const TREND_WORDS = {
  [TrendDirection.Up]: 'вверх',
  [TrendDirection.Down]: 'вниз',
  [TrendDirection.Flat]: 'не определён',
} as const satisfies Record<TrendDirection, string>;

export const MOMENTUM_WORDS = {
  [MomentumDirection.Up]: 'вверх',
  [MomentumDirection.Down]: 'вниз',
  [MomentumDirection.Neutral]: 'нейтральный',
} as const satisfies Record<MomentumDirection, string>;

// Told by the refusal, not by comparing ATR% with bounds: the decider checks volatility first,
// so any later rule refusal and a signal both had it inside the bounds.
export const VOLATILITY_WORDS = {
  normal: 'в норме',
  low: 'слишком низкая',
  high: 'слишком высокая',
} as const;

const EMA_RELATION_WORDS = { above: 'выше', below: 'ниже', equal: 'равна' } as const;

const SIGNAL_HEADLINES = {
  [TradeAction.Up]: TEXTS.analysisSignalUp,
  [TradeAction.Down]: TEXTS.analysisSignalDown,
} as const satisfies Record<TradeAction, TelegramHtml>;

// toFixed throws outside 0-100; the broker's digits are 2-7 today, and a value outside a sane
// range is printed at the nearest bound rather than failing the screen
const MAX_PRICE_DIGITS = 10;
export const formatPrice = (value: number, digits: number): string =>
  value.toFixed(Math.min(Math.max(Math.trunc(digits), 0), MAX_PRICE_DIGITS));
export const formatRsi = (value: number): string => value.toFixed(1);
// a live 1m ATR% sits in the hundredths and thousandths: two decimals would print 0.00
export const formatAtrPct = (value: number): string => value.toFixed(3);

export const analysisSubject = (pair: PairView, durationSec: DemoDurationSec): string =>
  `${pair.symbol} · ${DEMO_DURATION_LABELS[durationSec]}`;

export interface AnalysisScreen {
  text: TelegramHtml;
  // the direction of the stake button, set on a signal only
  stake: TradeAction | null;
}

export interface AnalysisScreenInput {
  pair: PairView;
  durationSec: DemoDurationSec;
  response: TradingSignalResponse;
}

export function analysisScreen({
  pair,
  durationSec,
  response,
}: AnalysisScreenInput): AnalysisScreen {
  const header = TEXTS.analysisHeader(analysisSubject(pair, durationSec));
  if (response.outcome === SignalFeedOutcome.FetchFailed) {
    const body =
      response.code === BrokerRestErrorCode.RateLimited && response.retryAfterSec !== undefined
        ? TEXTS.analysisRateLimited(String(response.retryAfterSec))
        : TEXTS.analysisUnavailable;
    return {
      text: telegramHtml`${header}
${body}`,
      stake: null,
    };
  }
  const { decision, params } = response;
  if (decision.kind === SignalKind.Signal) {
    const features = featureLines(decision.features, params, pair, VOLATILITY_WORDS.normal);
    return {
      text: telegramHtml`${header}
${SIGNAL_HEADLINES[decision.action]}

${features}
${TEXTS.demoPayout(String(pair.payout))}

${TEXTS.analysisDisclaimer}`,
      stake: decision.action,
    };
  }
  const headline = TEXTS.analysisNoSignal(NO_SIGNAL_REASON_TEXT[decision.reason]);
  if (!('features' in decision)) {
    return {
      text: telegramHtml`${header}
${headline}

${TEXTS.analysisDataHint}`,
      stake: null,
    };
  }
  const volatility =
    decision.reason === NoSignalReason.VolatilityTooLow
      ? VOLATILITY_WORDS.low
      : decision.reason === NoSignalReason.VolatilityTooHigh
        ? VOLATILITY_WORDS.high
        : VOLATILITY_WORDS.normal;
  return {
    text: telegramHtml`${header}
${headline}

${featureLines(decision.features, params, pair, volatility)}

${TEXTS.analysisNoSignalHint}`,
    stake: null,
  };
}

// What the handler shows when the backend did not answer with a body it could read.
export const analysisUnavailableScreen = (
  pair: PairView,
  durationSec: DemoDurationSec,
): AnalysisScreen => ({
  text: telegramHtml`${TEXTS.analysisHeader(analysisSubject(pair, durationSec))}
${TEXTS.analysisUnavailable}`,
  stake: null,
});

function featureLines(
  f: SignalFeatures,
  params: SignalParams,
  pair: PairView,
  volatility: string,
): TelegramHtml {
  const relation =
    f.emaFast > f.emaSlow
      ? EMA_RELATION_WORDS.above
      : f.emaFast < f.emaSlow
        ? EMA_RELATION_WORDS.below
        : EMA_RELATION_WORDS.equal;
  const fast = `EMA${params.emaFast} ${formatPrice(f.emaFast, pair.digits)}`;
  const slow = `EMA${params.emaSlow} ${formatPrice(f.emaSlow, pair.digits)}`;
  const trend = `${TREND_WORDS[f.trend]} — ${fast} ${relation} ${slow}`;
  const momentum = `${MOMENTUM_WORDS[f.momentum]} — RSI${params.rsiPeriod} ${formatRsi(f.rsi)}`;
  const atr = `${volatility} — ATR${params.atrPeriod} ${formatAtrPct(f.atrPct)}%`;
  return telegramHtml`${TEXTS.analysisTrend(trend)}
${TEXTS.analysisMomentum(momentum)}
${TEXTS.analysisVolatility(atr)}
${TEXTS.analysisCandles(String(f.closedCandles))}
${TEXTS.analysisLastPrice(formatPrice(f.lastClose, pair.digits))}`;
}
