import {
  BrokerRestErrorCode,
  MIN_CYCLE_PAYOUT_PCT,
  MomentumDirection,
  NoSignalReason,
  pairPayoutAccepted,
  SignalFeedOutcome,
  SignalKind,
  telegramHtml,
  TradeAction,
  TrendDirection,
  type BotPlainKey,
  type BotStaticHtmlKey,
  type PairView,
  type SignalFeatures,
  type SignalParams,
  type TelegramHtml,
  type TradingSignalResponse,
} from '@binarius/shared';
import type { DemoDurationSec } from './demo-catalog';
import { atrTicksText, DEMO_DURATION_LABELS, labelsOf, payoutText, TEXTS, textOf } from './texts';

// The analysis screen (#126, docs/bot-demo.md): pure, from the pair read at the press and the
// backend's answer. Every number on it is the answer's — a feature, or a period from `params` —
// or the pair's payout and the break-even share computed from it; nothing is the bot's own. Which buttons go under it is demo.ts's. The
// words are catalog keys (bot-texts.ts), read when a screen is built.

// `satisfies Record<NoSignalReason, …>`: a reason added to shared's constant fails tsc here.
export const NO_SIGNAL_REASON_TEXT = labelsOf({
  [NoSignalReason.VolatilityTooLow]: 'noSignalVolatilityTooLow',
  [NoSignalReason.VolatilityTooHigh]: 'noSignalVolatilityTooHigh',
  [NoSignalReason.VolatilityBelowTickFloor]: 'noSignalVolatilityBelowTickFloor',
  [NoSignalReason.TrendFlat]: 'noSignalTrendFlat',
  [NoSignalReason.RsiNeutral]: 'noSignalRsiNeutral',
  [NoSignalReason.TrendMomentumDisagree]: 'noSignalTrendMomentumDisagree',
  [NoSignalReason.RsiOverbought]: 'noSignalRsiOverbought',
  [NoSignalReason.RsiOversold]: 'noSignalRsiOversold',
  [NoSignalReason.InsufficientCandles]: 'noSignalInsufficientCandles',
  [NoSignalReason.CandleGap]: 'noSignalCandleGap',
  [NoSignalReason.Stale]: 'noSignalStale',
  [NoSignalReason.InvalidCandle]: 'noSignalInvalidCandle',
} as const satisfies Record<NoSignalReason, BotPlainKey>);

export const TREND_WORDS = labelsOf({
  [TrendDirection.Up]: 'trendUp',
  [TrendDirection.Down]: 'trendDown',
  [TrendDirection.Flat]: 'trendFlat',
} as const satisfies Record<TrendDirection, BotPlainKey>);

export const MOMENTUM_WORDS = labelsOf({
  [MomentumDirection.Up]: 'momentumUp',
  [MomentumDirection.Down]: 'momentumDown',
  [MomentumDirection.Neutral]: 'momentumNeutral',
} as const satisfies Record<MomentumDirection, BotPlainKey>);

// Told by the refusal, not by comparing ATR with bounds: the decider checks volatility first (the
// tick floor among it, #379), so any later rule refusal and a signal both had it inside the bounds.
export const VOLATILITY_WORDS = labelsOf({
  normal: 'volatilityNormal',
  low: 'volatilityLow',
  high: 'volatilityHigh',
  tickFloor: 'volatilityTickFloor',
} as const);

const REFUSAL_VOLATILITY: Partial<Record<NoSignalReason, keyof typeof VOLATILITY_WORDS>> = {
  [NoSignalReason.VolatilityTooLow]: 'low',
  [NoSignalReason.VolatilityTooHigh]: 'high',
  [NoSignalReason.VolatilityBelowTickFloor]: 'tickFloor',
};

const EMA_RELATION_WORDS = labelsOf({
  above: 'emaAbove',
  below: 'emaBelow',
  equal: 'emaEqual',
} as const);

const SIGNAL_HEADLINES = {
  [TradeAction.Up]: 'analysisSignalUp',
  [TradeAction.Down]: 'analysisSignalDown',
} as const satisfies Record<TradeAction, BotStaticHtmlKey>;

// toFixed throws outside 0-100; the broker's digits are 2-7 today, and a value outside a sane
// range is printed at the nearest bound rather than failing the screen
const MAX_PRICE_DIGITS = 10;
export const formatPrice = (value: number, digits: number): string =>
  value.toFixed(Math.min(Math.max(Math.trunc(digits), 0), MAX_PRICE_DIGITS));
export const formatRsi = (value: number): string => value.toFixed(1);
// a live 1m ATR% sits in the hundredths and thousandths: two decimals would print 0.00
export const formatAtrPct = (value: number): string => value.toFixed(3);
// the ATR in the pair's quote steps (#379)
export const formatAtrTicks = (value: number): string => value.toFixed(1);

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
  const header = TEXTS.analysisHeader({ subject: analysisSubject(pair, durationSec) });
  if (response.outcome === SignalFeedOutcome.FetchFailed) {
    const body =
      response.code === BrokerRestErrorCode.RateLimited && response.retryAfterSec !== undefined
        ? TEXTS.analysisRateLimited({ seconds: String(response.retryAfterSec) })
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
    // a pair below the cycle floor gets no session button (demo.ts); the note says why
    const payout = pairPayoutAccepted(pair)
      ? payoutText(pair)
      : telegramHtml`${payoutText(pair)}
${TEXTS.analysisCycleUnavailable({ payoutFloor: String(MIN_CYCLE_PAYOUT_PCT) })}`;
    return {
      text: telegramHtml`${header}
${textOf(SIGNAL_HEADLINES[decision.action])}

${features}
${payout}

${TEXTS.analysisDisclaimer}`,
      stake: decision.action,
    };
  }
  const headline = TEXTS.analysisNoSignal({ reason: NO_SIGNAL_REASON_TEXT[decision.reason] });
  if (!('features' in decision)) {
    return {
      text: telegramHtml`${header}
${headline}

${TEXTS.analysisDataHint}`,
      stake: null,
    };
  }
  const volatility = VOLATILITY_WORDS[REFUSAL_VOLATILITY[decision.reason] ?? 'normal'];
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
  text: telegramHtml`${TEXTS.analysisHeader({ subject: analysisSubject(pair, durationSec) })}
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
  const atr = `${volatility} — ATR${params.atrPeriod} ${formatAtrPct(f.atrPct)}% · ${atrTicksText(formatAtrTicks(f.atrTicks))}`;
  return telegramHtml`${TEXTS.analysisTrend({ value: trend })}
${TEXTS.analysisMomentum({ value: momentum })}
${TEXTS.analysisVolatility({ value: atr })}
${TEXTS.analysisCandles({ count: String(f.closedCandles) })}
${TEXTS.analysisLastPrice({ price: formatPrice(f.lastClose, pair.digits) })}`;
}
