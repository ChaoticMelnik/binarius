import {
  BrokerRestErrorCode,
  DISPLAY_INDICATOR_PARAMS,
  formatPrice,
  MACD_REQUIRED_CANDLES,
  MacdCross,
  MIN_CYCLE_PAYOUT_PCT,
  MomentumDirection,
  NoSignalReason,
  pairLabel,
  pairPayoutAccepted,
  SignalFeedOutcome,
  SignalKind,
  telegramHtml,
  TradeAction,
  TradeMode,
  TrendDirection,
  type BotPlainKey,
  type BotStaticHtmlKey,
  type PairView,
  type SignalFeatures,
  type SignalIndicators,
  type SignalParams,
  type TelegramHtml,
  type TradingSignalResponse,
} from '@binarius/shared';
import type { DemoDurationSec } from './demo-catalog';
import {
  atrTicksText,
  DEMO_DURATION_LABELS,
  indicatorShortText,
  labelsOf,
  payoutText,
  TEXTS,
  textOf,
} from './texts';

// The analysis screen (#126, docs/bot-demo.md): pure, from the pair read at the press and the
// backend's answer. Every number on it is the answer's — a feature, a display indicator, or a
// period from `params` — or the pair's payout and the break-even share computed from it; nothing
// is the bot's own. A signal is a card (#482): the picture of its direction, sent by demo.ts, under
// a caption with a monospaced block. Which buttons go under it is demo.ts's. The words are catalog
// keys (bot-texts.ts), read when a screen is built.

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

const CARD_TITLES = {
  [TradeAction.Up]: 'analysisCardUp',
  [TradeAction.Down]: 'analysisCardDown',
} as const satisfies Record<TradeAction, BotStaticHtmlKey>;

const CARD_DIRECTIONS = labelsOf({
  [TradeAction.Up]: 'cardDirectionUp',
  [TradeAction.Down]: 'cardDirectionDown',
} as const satisfies Record<TradeAction, BotPlainKey>);

const CARD_ROWS = labelsOf({
  pair: 'cardRowPair',
  rsi: 'cardRowRsi',
  macd: 'cardRowMacd',
  ma50: 'cardRowMa50',
  ma200: 'cardRowMa200',
  trend: 'cardRowTrend',
  volatility: 'cardRowVolatility',
  direction: 'cardRowDirection',
} as const);

const RSI_WORDS = labelsOf({
  overbought: 'rsiOverbought',
  oversold: 'rsiOversold',
  neutral: 'rsiNeutral',
} as const);

const MACD_WORDS = labelsOf({
  crossUp: 'macdCrossUp',
  crossDown: 'macdCrossDown',
  above: 'macdAbove',
  below: 'macdBelow',
  equal: 'macdEqual',
} as const);

// a cross on the last closed candle is told first; without one, the histogram's sign tells the side
const MACD_CROSS_WORDS = {
  [MacdCross.Up]: 'crossUp',
  [MacdCross.Down]: 'crossDown',
  [MacdCross.None]: null,
} as const satisfies Record<MacdCross, keyof typeof MACD_WORDS | null>;

const MA_WORDS = labelsOf({
  above: 'maPriceAbove',
  below: 'maPriceBelow',
  equal: 'maPriceEqual',
} as const);

// The field is absent when the unbroken tail of the candles did not pass their checks
// (docs/signal.md): each indicator then had none, and its row says so rather than going missing.
const NO_INDICATORS: SignalIndicators = {
  macd: { ok: false, closedCandles: 0, required: MACD_REQUIRED_CANDLES },
  ma50: { ok: false, closedCandles: 0, required: DISPLAY_INDICATOR_PARAMS.maShort },
  ma200: { ok: false, closedCandles: 0, required: DISPLAY_INDICATOR_PARAMS.maLong },
};

export const formatRsi = (value: number): string => value.toFixed(1);
// a live 1m ATR% sits in the hundredths and thousandths: two decimals would print 0.00
export const formatAtrPct = (value: number): string => value.toFixed(3);
// the ATR in the pair's quote steps (#379)
export const formatAtrTicks = (value: number): string => value.toFixed(1);

export const analysisSubject = (pair: PairView, durationSec: DemoDurationSec): string =>
  `${pairLabel(pair)} · ${DEMO_DURATION_LABELS[durationSec]}`;

export interface AnalysisScreen {
  text: TelegramHtml;
  // the direction of the stake button behind «➕ Ещё», set on a signal only
  stake: TradeAction | null;
  // the session row (#360): on a signal only (#509), so no session is offered on a pair without one
  session: boolean;
  // the card's picture (#482), by the direction of a signal; null on every other screen
  photo: TradeAction | null;
}

export interface AnalysisScreenInput {
  pair: PairView;
  durationSec: DemoDurationSec;
  response: TradingSignalResponse;
  // the user's mode as the analysis's access read gave it (#121): the disclaimer follows it
  mode: TradeMode;
  // the amounts are drawn under the card (demo.ts, #482): its last line points at them
  chooseAmount: boolean;
}

export function analysisScreen({
  pair,
  durationSec,
  response,
  mode,
  chooseAmount,
}: AnalysisScreenInput): AnalysisScreen {
  const real = mode === TradeMode.Real;
  // Every `decided` answer of a pair below the cycle floor gets no session row (demo.ts, #379), in
  // either mode (#327): the note under the block that would precede it says why
  const withCycleNote = (block: TelegramHtml): TelegramHtml =>
    pairPayoutAccepted(pair)
      ? block
      : telegramHtml`${block}
${TEXTS.analysisCycleUnavailable({ payoutFloor: String(MIN_CYCLE_PAYOUT_PCT) })}`;
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
      session: false,
      photo: null,
    };
  }
  const { decision, params } = response;
  if (decision.kind === SignalKind.Signal) {
    const { action, features } = decision;
    const block = cardBlock(
      cardRows(action, features, params, response.indicators ?? NO_INDICATORS, pair),
    );
    const choose = chooseAmount
      ? telegramHtml`

${TEXTS.analysisChooseAmount}`
      : [];
    return {
      text: telegramHtml`${header}
${textOf(CARD_TITLES[action])}

<pre>${block}</pre>
${withCycleNote(payoutText(pair))}

${real ? TEXTS.analysisDisclaimerReal : TEXTS.analysisDisclaimer}${choose}`,
      stake: action,
      session: true,
      photo: action,
    };
  }
  const headline = TEXTS.analysisNoSignal({ reason: NO_SIGNAL_REASON_TEXT[decision.reason] });
  if (!('features' in decision)) {
    return {
      text: telegramHtml`${header}
${headline}

${withCycleNote(TEXTS.analysisDataHint)}`,
      stake: null,
      session: false,
      photo: null,
    };
  }
  const volatility = VOLATILITY_WORDS[REFUSAL_VOLATILITY[decision.reason] ?? 'normal'];
  return {
    text: telegramHtml`${header}
${headline}

${featureLines(decision.features, params, pair, volatility)}

${withCycleNote(TEXTS.analysisNoSignalHint)}`,
    stake: null,
    session: false,
    photo: null,
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
  session: false,
  photo: null,
});

// The card's block (#482): eight rows, a label and a value, the RSI's word by the bounds of the
// decision's own rsiExtremeBand (the refusals rsi_overbought / rsi_oversold use the same)
function cardRows(
  action: TradeAction,
  features: SignalFeatures,
  params: SignalParams,
  indicators: SignalIndicators,
  pair: PairView,
): [string, string][] {
  const rsiWord =
    features.rsi >= 50 + params.rsiExtremeBand
      ? RSI_WORDS.overbought
      : features.rsi <= 50 - params.rsiExtremeBand
        ? RSI_WORDS.oversold
        : RSI_WORDS.neutral;
  const { macd, ma50, ma200 } = indicators;
  const macdValue = macd.ok
    ? `${MACD_WORDS[MACD_CROSS_WORDS[macd.cross] ?? sideOf(macd.histogram, 0)]} ${formatPrice(macd.histogram, pair.digits + 1)}`
    : indicatorShortText(macd.closedCandles, macd.required);
  return [
    [CARD_ROWS.pair, pairLabel(pair)],
    [CARD_ROWS.rsi, `${rsiWord} ${formatRsi(features.rsi)}`],
    [CARD_ROWS.macd, macdValue],
    [CARD_ROWS.ma50, maValue(ma50, pair)],
    [CARD_ROWS.ma200, maValue(ma200, pair)],
    [CARD_ROWS.trend, TREND_WORDS[features.trend]],
    [CARD_ROWS.volatility, `${VOLATILITY_WORDS.normal} ${formatAtrPct(features.atrPct)}%`],
    [CARD_ROWS.direction, CARD_DIRECTIONS[action]],
  ];
}

const sideOf = (value: number, reference: number) =>
  value > reference ? 'above' : value < reference ? 'below' : 'equal';

function maValue(ma: SignalIndicators['ma50'], pair: PairView): string {
  if (!ma.ok) return indicatorShortText(ma.closedCandles, ma.required);
  return `${MA_WORDS[sideOf(ma.lastClose, ma.value)]} ${formatPrice(ma.value, pair.digits)}`;
}

// Every label padded to the longest one, then a space and the value. The width is String#length,
// UTF-16 code units, as the caption limit counts them (bot-text-messages.ts measures the same).
// Inside <pre> the columns line up, and Telegram gives the block its copy button.
export function cardBlock(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)} ${value}`).join('\n');
}

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
  const ticks = atrTicksText(formatAtrTicks(f.atrTicks));
  const atr = `${volatility} — ATR${params.atrPeriod} ${formatAtrPct(f.atrPct)}% · ${ticks}`;
  return telegramHtml`${TEXTS.analysisTrend({ value: trend })}
${TEXTS.analysisMomentum({ value: momentum })}
${TEXTS.analysisVolatility({ value: atr })}
${TEXTS.analysisCandles({ count: String(f.closedCandles) })}
${TEXTS.analysisLastPrice({ price: formatPrice(f.lastClose, pair.digits) })}`;
}
