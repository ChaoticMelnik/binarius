import { formatPrice, formatUsd } from './bot-text-format';
import type { PairLabel } from './catalog';
import type { BotHtmlTexts, BotPlainTexts, BotStaticHtmlKey } from './bot-texts';
import type { DecimalString } from './money';
import { SessionTradeResult } from './session-steps';
import { telegramHtml, type TelegramHtml } from './telegram-html';
import { TradeMode } from './trading';
import {
  SESSION_NO_SIGNAL_CANDLES,
  sessionSignalCandleMs,
  TradingSessionStopReason,
  type TradingSessionView,
} from './trading-session';

// The session's words that both the bot's session message and the backend's session notices
// print (#464, docs/bot-session.md): one source, so the summary the backend sends cannot drift
// from the session message's end line (#536). Every builder takes the catalog it prints with, so
// each side's overrides apply (Rule 30).

// A session's stop reasons but completed, by key (#284). kill_switch reads the single
// trade's own refusal of the closed switch; no_signal_timeout's line carries the limit in candles
// of the session's interval (#509, #637), so stopLine builds it from the view's settings.
export const SESSION_STOP_LINES = {
  [TradingSessionStopReason.ManualReview]: 'sessionStopManualReview',
  [TradingSessionStopReason.RejectedTwice]: 'sessionStopRejectedTwice',
  [TradingSessionStopReason.Timeout]: 'sessionStopTimeout',
  [TradingSessionStopReason.StakeStop]: 'sessionStopStakeStop',
  [TradingSessionStopReason.MaxStepsExceeded]: 'sessionStopMaxSteps',
  [TradingSessionStopReason.MaxStakeExceeded]: 'sessionStopMaxStake',
  [TradingSessionStopReason.MaxSessionLossExceeded]: 'sessionStopMaxSessionLoss',
  [TradingSessionStopReason.SessionDurationExceeded]: 'sessionStopSessionDuration',
  [TradingSessionStopReason.AccountUnavailable]: 'sessionStopAccountUnavailable',
  [TradingSessionStopReason.PairUnavailable]: 'sessionStopPairUnavailable',
  [TradingSessionStopReason.BalanceUnavailable]: 'sessionStopBalanceUnavailable',
  [TradingSessionStopReason.InvalidSettings]: 'sessionStopInvalidSettings',
  [TradingSessionStopReason.UserStopped]: 'sessionStopUserStopped',
  [TradingSessionStopReason.KillSwitch]: 'tradingPaused',
} as const satisfies Record<
  Exclude<
    TradingSessionStopReason,
    typeof TradingSessionStopReason.Completed | typeof TradingSessionStopReason.NoSignalTimeout
  >,
  BotStaticHtmlKey
>;

const SESSION_BALANCE_LINES = {
  [TradeMode.Demo]: 'sessionBalanceDemo',
  [TradeMode.Real]: 'sessionBalanceReal',
} as const satisfies Record<TradeMode, keyof BotHtmlTexts>;

const SESSION_TRADE_LINES = {
  [SessionTradeResult.Won]: 'sessionTradeWon',
  [SessionTradeResult.Lost]: 'sessionTradeLost',
  [SessionTradeResult.Tied]: 'sessionTradeTied',
} as const satisfies Record<SessionTradeResult, keyof BotHtmlTexts>;

export type SessionScore = Pick<TradingSessionView['trades'], 'won' | 'lost' | 'tied'>;
// what a stopped session's closing lines print of its view
export type SessionClosingView = Pick<
  TradingSessionView,
  'mode' | 'stopReason' | 'trades' | 'cycles' | 'balance' | 'settings'
>;

// a hole holding an array is joined without a separator, so the newlines are written here
export const joinHtmlLines = ([first, ...rest]: readonly TelegramHtml[]): TelegramHtml =>
  rest.reduce(
    (joined, line) => telegramHtml`${joined}
${line}`,
    first ?? telegramHtml``,
  );

// A settled trade of a session as its message prints it (#464). `outcome` is the figure after
// «→», the broker trade's profit (#539): positive for a win, negative for a loss, zero for a tie,
// so the lines of a session add up to its result. The prices are the broker trade's; `digits` the
// pair's, null when the catalog could not say.
export interface SessionTradeNotice {
  amount: DecimalString;
  outcome: DecimalString;
  result: SessionTradeResult;
  openPrice: number;
  closePrice: number;
  digits: number | null;
  cycle: number;
  step: number;
}

// The Russian plural form after a number: one for 1, 21, …; few for 2-4, 22-24, …; many
// otherwise. A form, not its text: only the text printed is read from the catalog (Rule 30).
const PluralForm = { One: 0, Few: 1, Many: 2 } as const;
type PluralForm = (typeof PluralForm)[keyof typeof PluralForm];
function pluralFormOf(count: number): PluralForm {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return PluralForm.One;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return PluralForm.Few;
  return PluralForm.Many;
}

const priceOf = (value: number, digits: number | null): string =>
  digits === null ? String(value) : formatPrice(value, digits);

export function createSessionTexts({ html, plain }: { html: BotHtmlTexts; plain: BotPlainTexts }) {
  // «сделка», «сделки» or «сделок» after the number
  const pluralTrades = (count: number): string => {
    const form = pluralFormOf(count);
    if (form === PluralForm.One) return plain.sessionTradeOne;
    return form === PluralForm.Few ? plain.sessionTradeFew : plain.sessionTradeMany;
  };
  const tradesCount = (count: number): string => `${String(count)} ${pluralTrades(count)}`;
  // «цикл», «цикла» or «циклов» after the number (#552)
  const pluralCycles = (count: number): string => {
    const form = pluralFormOf(count);
    if (form === PluralForm.One) return plain.sessionCycleOne;
    return form === PluralForm.Few ? plain.sessionCycleFew : plain.sessionCycleMany;
  };
  const cyclesCount = (count: number): string => `${String(count)} ${pluralCycles(count)}`;
  // «свеча», «свечи» or «свечей» after the number (#637)
  const pluralCandles = (count: number): string => {
    const form = pluralFormOf(count);
    if (form === PluralForm.One) return plain.sessionCandleOne;
    return form === PluralForm.Few ? plain.sessionCandleFew : plain.sessionCandleMany;
  };
  const candlesCount = (count: number): string => `${String(count)} ${pluralCandles(count)}`;

  // «3 в плюс, 1 в минус», with «в ноль» only when a trade tied
  const scoreOf = ({ won, lost, tied }: SessionScore): string =>
    [
      plain.sessionWon({ count: String(won) }),
      plain.sessionLost({ count: String(lost) }),
      ...(tied > 0 ? [plain.sessionTied({ count: String(tied) })] : []),
    ].join(', ');
  const resultOf = (trades: TradingSessionView['trades']): string =>
    `${tradesCount(trades.settled)} — ${scoreOf(trades)}`;

  // the session's pair label, or the asset's id when the catalog could not say
  const sessionAssetLabel = (label: PairLabel | null, assetId: number): string =>
    label ?? plain.intentAssetFallback({ assetId: String(assetId) });

  // A stopped session's result and the balance after it (#337): nothing before the first closed
  // trade. The balance is the snapshot's in the session's mode, with its age when the backend
  // could not read it after the last trade.
  const outcomeLines = ({ mode, trades, balance }: SessionClosingView): TelegramHtml[] => {
    if (trades.settled === 0) return [];
    const lines = [html.sessionResult({ profit: trades.profit })];
    if (balance !== null) {
      lines.push(html[SESSION_BALANCE_LINES[mode]]({ amount: formatUsd(balance.available) }));
      if (!balance.current) lines.push(html.statusStale({ age: balance.ageSec }));
    }
    return lines;
  };

  // The stopped session's first line (#536): the completed line with its result, or the stop
  // reason; undefined with no reason, which the CHECKs refuse and the view's schema allows.
  const stopLine = ({
    stopReason,
    trades,
    cycles,
    settings,
  }: Pick<SessionClosingView, 'stopReason' | 'trades' | 'cycles' | 'settings'>):
    TelegramHtml | undefined => {
    if (stopReason === TradingSessionStopReason.Completed) {
      return html.sessionCompleted({
        cycles: cyclesCount(cycles.closed),
        result: resultOf(trades),
      });
    }
    if (stopReason === TradingSessionStopReason.NoSignalTimeout) {
      // settings that do not parse name no candle, so the line goes without the figure (#637)
      if (settings === null) return html.sessionStopNoSignalTimeoutNoSettings;
      return html.sessionStopNoSignalTimeout({
        noSignalCandles: candlesCount(SESSION_NO_SIGNAL_CANDLES),
        candleSec: String(sessionSignalCandleMs(settings.durationSec) / 1000),
      });
    }
    return stopReason === null ? undefined : html[SESSION_STOP_LINES[stopReason]];
  };

  // A stopped session's closing lines: the completion line, or the stop reason and the total, then
  // the result and the balance; the session's summary is these lines under the pair (#464, #537).
  const sessionClosingLines = (view: SessionClosingView): TelegramHtml[] => {
    const first = stopLine(view);
    const lines: TelegramHtml[] = first === undefined ? [] : [first];
    if (view.stopReason !== TradingSessionStopReason.Completed && view.trades.settled > 0) {
      lines.push(html.sessionTotal({ result: resultOf(view.trades) }));
    }
    lines.push(...outcomeLines(view));
    return lines;
  };

  // What the session message ends on once its session stopped, and the first line of the reply to
  // the stop (#536): the summary's (#464) first line under its pair, the same text.
  const sessionEndLine = (
    view: Pick<SessionClosingView, 'stopReason' | 'trades' | 'cycles' | 'settings'>,
  ): TelegramHtml => stopLine(view) ?? html.sessionStatusUnavailable;

  // The session's summary (#464, #537): the pair, then the closing lines - the bot's caption under
  // its card, and the backend's fallback text.
  const sessionSummaryText = (
    label: PairLabel | null,
    assetId: number,
    view: SessionClosingView,
  ): TelegramHtml =>
    joinHtmlLines([
      html.sessionSummarySymbol({ symbol: sessionAssetLabel(label, assetId) }),
      ...sessionClosingLines(view),
    ]);

  // A cycle's message (#551): the blocks of its trades in their order, a blank line apart, each
  // the cycle and step and the trade in a code block; the adaptive line stands once, alone, above
  // the block of step 2, wherever that block is printed. The sender splits a cycle into more
  // messages by length only between blocks, never inside one.
  const sessionCycleText = (trades: readonly SessionTradeNotice[]): TelegramHtml => {
    const parts: TelegramHtml[] = [];
    for (const trade of trades) {
      if (trade.step === 2) parts.push(html.sessionAdaptiveStake);
      parts.push(
        html[SESSION_TRADE_LINES[trade.result]]({
          cycle: String(trade.cycle),
          step: String(trade.step),
          stake: trade.amount,
          outcome: trade.outcome,
          openPrice: priceOf(trade.openPrice, trade.digits),
          closePrice: priceOf(trade.closePrice, trade.digits),
        }),
      );
    }
    return joinHtmlLines(parts.flatMap((part, i) => (i === 0 ? [part] : [telegramHtml``, part])));
  };

  return {
    pluralTrades,
    tradesCount,
    pluralCycles,
    cyclesCount,
    candlesCount,
    scoreOf,
    resultOf,
    sessionAssetLabel,
    sessionEndLine,
    sessionSummaryText,
    sessionCycleText,
  };
}
export type SessionTexts = ReturnType<typeof createSessionTexts>;
