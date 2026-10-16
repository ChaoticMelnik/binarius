import { InlineKeyboard } from 'grammy';
import {
  createSessionTexts,
  DEMO_SIGNALS_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  pairLabel,
  SessionStakeStrategy,
  sessionStakeParams,
  sessionTradeSteps,
  signalsCallbackDataFor,
  TradingSessionStopReason,
  type PairLabel,
  type PairsCatalogView,
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

// the pair's label (pairLabel, #428) and digits from the catalog the routes read; null each when
// it cannot say
export function pairOf(
  catalog: PairsCatalogView | undefined,
  assetId: number,
): { label: PairLabel | null; digits: number | null } {
  const pair = catalog?.pairs.find((candidate) => candidate.id === assetId);
  return {
    label: pair === undefined ? null : pairLabel(pair),
    digits: pair?.digits ?? null,
  };
}

// A settled trade's message: its cycle and step over the session's trades up to it, by the
// session's own strategy (#450; settings that cannot be read count as fixed), the adaptive line
// above step 2 (#551).
export function sessionTradeMessage(
  { trades }: ClaimedSessionTrade,
  settings: TradingSessionSettings | null,
  digits: number | null,
): TelegramHtml {
  const strategy =
    settings === null ? SessionStakeStrategy.Fixed : sessionStakeParams(settings).strategy;
  const trade = trades.at(-1);
  const position = sessionTradeSteps(
    trades.map((row) => row.result),
    strategy,
  ).at(-1);
  if (trade === undefined || position === undefined) {
    throw new Error('a claimed trade has no position in its session');
  }
  return notices.sessionCycleText([
    {
      amount: trade.amount,
      outcome: trade.outcome,
      result: trade.result,
      openPrice: trade.openPrice,
      closePrice: trade.closePrice,
      digits,
      cycle: position.cycle,
      step: position.step,
    },
  ]);
}

// The finished session's summary, with sound and the menu as its next step; a session the
// no-signal limit stopped gets «🔀 Выбрать другую пару» above it, the signals of its duration
// (#509). A summary is sent with a settled trade or for that stop, whose attempt had read the
// settings, so the last intent names the asset when the settings could not be read.
export function sessionSummaryMessage(
  view: TradingSessionView,
  label: PairLabel | null,
): ClientPushMessage {
  const assetId = view.settings?.assetId ?? view.lastIntent?.assetId;
  if (assetId === undefined) throw new Error('a summarized session names no asset');
  const keyboard = new InlineKeyboard();
  if (view.stopReason === TradingSessionStopReason.NoSignalTimeout) {
    keyboard
      .text(
        CLIENT_LABELS.otherPairButton,
        view.settings === null
          ? DEMO_SIGNALS_CALLBACK_DATA
          : signalsCallbackDataFor(view.settings.durationSec),
      )
      .row();
  }
  return {
    text: notices.sessionSummaryText(label, assetId, view),
    reply_markup: keyboard.text(CLIENT_LABELS.menuButton, MENU_CALLBACK_DATA),
  };
}
