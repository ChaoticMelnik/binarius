import { InlineKeyboard } from 'grammy';
import {
  createSessionTexts,
  MENU_CALLBACK_DATA,
  sessionTradeSteps,
  type PairsCatalogView,
  type SessionStakeStrategy,
  type TelegramHtml,
  type TradingSessionSettings,
  type TradingSessionView,
} from '@binarius/shared';
import type { ClaimedSessionTrade } from '@binarius/db';
import type { ClientPushMessage } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';

// What the session notices say (#464, docs/bot-session.md → Trade messages), in the client bot's
// voice through the catalog (Rule 30): the shared builders of session-texts.ts, so the summary's
// lines are the bot's status message's own. Built when sent, so an override reaches them.
const notices = createSessionTexts({ html: CLIENT_TEXTS, plain: CLIENT_LABELS });

// Settings v1 carry no strategy: every session is fixed (Rule 23). #450 passes the session's.
const SESSION_STAKE_STRATEGY: SessionStakeStrategy = 'fixed';

// the pair's symbol and digits from the catalog the routes read; null each when it cannot say
export function pairOf(
  catalog: PairsCatalogView | undefined,
  assetId: number,
): { symbol: string | null; digits: number | null } {
  const pair = catalog?.pairs.find((candidate) => candidate.id === assetId);
  return { symbol: pair?.symbol ?? null, digits: pair?.digits ?? null };
}

// A settled trade's message: its cycle and step over the session's trades up to it, and the
// adaptive line when its stake is above the session's base stake.
export function sessionTradeMessage(
  { trade, results }: ClaimedSessionTrade,
  settings: TradingSessionSettings | null,
  digits: number | null,
): TelegramHtml {
  const position = sessionTradeSteps(results, SESSION_STAKE_STRATEGY).at(-1);
  if (position === undefined) throw new Error('a claimed trade has no position in its session');
  return notices.sessionTradeText({
    amount: trade.amount,
    outcome: trade.outcome,
    result: trade.result,
    openPrice: trade.openPrice,
    closePrice: trade.closePrice,
    digits,
    cycle: position.cycle,
    step: position.step,
    baseStake: settings?.stake.baseStake ?? null,
  });
}

// The finished session's summary, with sound and the menu as its next step. A summary is sent
// only with a settled trade, so the last intent names the asset when the settings could not be
// read.
export function sessionSummaryMessage(
  view: TradingSessionView,
  symbol: string | null,
): ClientPushMessage {
  const assetId = view.settings?.assetId ?? view.lastIntent?.assetId;
  if (assetId === undefined) throw new Error('a summarized session names no asset');
  return {
    text: notices.sessionSummaryText(symbol, assetId, view),
    reply_markup: new InlineKeyboard().text(CLIENT_LABELS.menuButton, MENU_CALLBACK_DATA),
  };
}
