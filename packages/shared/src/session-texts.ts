import { formatPrice, formatUsd } from './bot-text-format';
import type { PairLabel } from './catalog';
import type { BotHtmlTexts, BotPlainTexts, BotStaticHtmlKey } from './bot-texts';
import type { DecimalString } from './money';
import { SessionTradeResult } from './session-steps';
import { decimalLessThan } from './stake';
import { telegramHtml, type TelegramHtml } from './telegram-html';
import { TradeMode } from './trading';
import {
  SESSION_NO_SIGNAL_TIMEOUT_MS,
  TradingSessionStopReason,
  type TradingSessionView,
} from './trading-session';

// The session's words that both the bot's status message and the backend's session notices print
// (#464, docs/bot-session.md): one source, so the summary the backend sends cannot drift from the
// status message's final lines. Every builder takes the catalog it prints with, so each side's
// overrides apply (Rule 30).

// A session's stop reasons but completed, by key (#284). kill_switch reads the single
// trade's own refusal of the closed switch; no_signal_timeout's line carries the limit (#509).
export const SESSION_STOP_LINES = {
  [TradingSessionStopReason.ManualReview]: 'sessionStopManualReview',
  [TradingSessionStopReason.RejectedTwice]: 'sessionStopRejectedTwice',
  [TradingSessionStopReason.Timeout]: 'sessionStopTimeout',
  [TradingSessionStopReason.StakeStop]: 'sessionStopStakeStop',
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
  'mode' | 'stopReason' | 'trades' | 'balance'
>;

// a hole holding an array is joined without a separator, so the newlines are written here
export const joinHtmlLines = ([first, ...rest]: readonly TelegramHtml[]): TelegramHtml =>
  rest.reduce(
    (joined, line) => telegramHtml`${joined}
${line}`,
    first ?? telegramHtml``,
  );

// A settled trade of a session as its message prints it (#464). `outcome` is the figure after
// «→», computed by SQL (Rule 2): the payout of a win, the loss of a loss, the stake of a tie. The
// prices are the broker trade's; `digits` the pair's, null when the catalog could not say.
export interface SessionTradeNotice {
  amount: DecimalString;
  outcome: DecimalString;
  result: SessionTradeResult;
  openPrice: number;
  closePrice: number;
  digits: number | null;
  cycle: number;
  step: number;
  // the session's base stake; null when the settings could not be read
  baseStake: DecimalString | null;
}

const priceOf = (value: number, digits: number | null): string =>
  digits === null ? String(value) : formatPrice(value, digits);

export function createSessionTexts({ html, plain }: { html: BotHtmlTexts; plain: BotPlainTexts }) {
  // «сделка», «сделки» or «сделок» after the number
  const pluralTrades = (count: number): string => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return plain.sessionTradeOne;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return plain.sessionTradeFew;
    return plain.sessionTradeMany;
  };
  const tradesCount = (count: number): string => `${String(count)} ${pluralTrades(count)}`;

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

  // A stopped session's closing lines: the completion line, or the stop reason and the total, then
  // the result and the balance. The status message adds its live-trade lines after them; the
  // summary the backend sends is these lines under the pair (#464).
  const sessionClosingLines = (view: SessionClosingView): TelegramHtml[] => {
    if (view.stopReason === TradingSessionStopReason.Completed) {
      return [html.sessionCompleted({ result: resultOf(view.trades) }), ...outcomeLines(view)];
    }
    const lines: TelegramHtml[] = [];
    if (view.stopReason === TradingSessionStopReason.NoSignalTimeout) {
      lines.push(
        html.sessionStopNoSignalTimeout({
          noSignalMinutes: String(SESSION_NO_SIGNAL_TIMEOUT_MS / 60_000),
        }),
      );
    } else if (view.stopReason !== null) {
      lines.push(html[SESSION_STOP_LINES[view.stopReason]]);
    }
    if (view.trades.settled > 0) lines.push(html.sessionTotal({ result: resultOf(view.trades) }));
    lines.push(...outcomeLines(view));
    return lines;
  };

  // The summary message (#464): the pair, then the closing lines.
  const sessionSummaryText = (
    label: PairLabel | null,
    assetId: number,
    view: SessionClosingView,
  ): TelegramHtml =>
    joinHtmlLines([
      html.sessionSummarySymbol({ symbol: sessionAssetLabel(label, assetId) }),
      ...sessionClosingLines(view),
    ]);

  // A trade's message (#464): the adaptive line first when the trade's stake is above the base
  // stake, then the cycle and step and the trade in a code block.
  const sessionTradeText = (trade: SessionTradeNotice): TelegramHtml => {
    const body = html[SESSION_TRADE_LINES[trade.result]]({
      cycle: String(trade.cycle),
      step: String(trade.step),
      stake: trade.amount,
      outcome: trade.outcome,
      openPrice: priceOf(trade.openPrice, trade.digits),
      closePrice: priceOf(trade.closePrice, trade.digits),
    });
    return trade.baseStake !== null && decimalLessThan(trade.baseStake, trade.amount)
      ? joinHtmlLines([html.sessionAdaptiveStake, body])
      : body;
  };

  return {
    pluralTrades,
    tradesCount,
    scoreOf,
    resultOf,
    sessionAssetLabel,
    sessionClosingLines,
    sessionSummaryText,
    sessionTradeText,
  };
}
export type SessionTexts = ReturnType<typeof createSessionTexts>;
