import { InlineKeyboard } from 'grammy';
import {
  BOT_TEXT_LIMIT,
  createSessionTexts,
  DEMO_SIGNALS_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  pairLabel,
  plainTextOf,
  sessionStopCallbackData,
  SessionStakeStrategy,
  sessionStakeParams,
  sessionTradeSteps,
  TradingSessionStopReason,
  type PairLabel,
  type PairsCatalogView,
  type SessionTradeNotice,
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

// the pair's label (pairLabel, #428, #631) and digits from the catalog the routes read; null each when
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

// What the claimed trade's turn sends (#551, docs/bot-session.md → The state): a new
// message showing the trades from `from` to the claimed one, or the edit of the session's cycle
// message to the trades from its own `from`. `split` marks a new message the cycle message had no
// room for.
export type SessionCycleNotice =
  | { kind: 'send'; text: TelegramHtml; from: number; split: boolean }
  | { kind: 'edit'; messageId: number; text: TelegramHtml; from: number };

// The claimed trade (the last of `trades`) in its cycle's message. Its cycle and step come from
// the session's trades up to it, by the session's own strategy (#450; settings that cannot be read
// count as fixed, so every trade is a cycle of its own and a new message). The cycle message is
// edited when it shows this trade's cycle; otherwise a new message shows the cycle so far. A text
// longer than BOT_TEXT_LIMIT (Telegram's limit less the width spacer the seam appends, #506),
// measured as Telegram counts it after parsing the entities (as telegramTextProblems does), opens
// a new message from the claimed trade, so a cycle splits only between blocks.
export function sessionCycleMessage(
  { trades, cycleMessage }: ClaimedSessionTrade,
  settings: TradingSessionSettings | null,
  digits: number | null,
): SessionCycleNotice {
  const strategy =
    settings === null ? SessionStakeStrategy.Fixed : sessionStakeParams(settings).strategy;
  const positions = sessionTradeSteps(
    trades.map((row) => row.result),
    strategy,
  );
  const blocks = trades.map((row, index): SessionTradeNotice => {
    const position = positions[index];
    if (position === undefined) throw new Error('a claimed trade has no position in its session');
    return {
      amount: row.amount,
      outcome: row.outcome,
      result: row.result,
      openPrice: row.openPrice,
      closePrice: row.closePrice,
      digits,
      cycle: position.cycle,
      step: position.step,
    };
  });
  const last = blocks.at(-1);
  if (last === undefined) throw new Error('a claim carries no trade');
  const claimed = blocks.length - 1;
  const render = (from: number) => notices.sessionCycleText(blocks.slice(from));
  const fits = (text: TelegramHtml) => plainTextOf(text).length <= BOT_TEXT_LIMIT;
  const splitFromClaimed = (): SessionCycleNotice => ({
    kind: 'send',
    text: render(claimed),
    from: claimed,
    split: true,
  });
  const sendFrom = (from: number): SessionCycleNotice => {
    const text = render(from);
    return fits(text) ? { kind: 'send', text, from, split: false } : splitFromClaimed();
  };

  // the step is the trade's number in its cycle, so the cycle starts that many trades back
  const cycleStart = claimed - (last.step - 1);
  const shown = cycleMessage === null ? undefined : blocks[cycleMessage.from];
  if (cycleMessage === null || cycleMessage.from > claimed || shown?.cycle !== last.cycle) {
    return sendFrom(cycleStart);
  }
  const text = render(cycleMessage.from);
  if (!fits(text)) return splitFromClaimed();
  return { kind: 'edit', messageId: cycleMessage.messageId, text, from: cycleMessage.from };
}

// The finished session's summary, with sound and the menu as its next step; a session the
// no-signal limit stopped gets «🔀 Выбрать другую пару» above it, the signals list (`demo:sig`,
// #509, #685). A summary is sent with a settled trade or for that stop, whose attempt had read the
// settings, so the last intent names the asset when the settings could not be read.
export function sessionSummaryMessage(
  view: TradingSessionView,
  label: PairLabel | null,
): ClientPushMessage {
  const assetId = view.settings?.assetId ?? view.lastIntent?.assetId;
  if (assetId === undefined) throw new Error('a summarized session names no asset');
  const keyboard = new InlineKeyboard();
  if (view.stopReason === TradingSessionStopReason.NoSignalTimeout) {
    keyboard.text(CLIENT_LABELS.otherPairButton, DEMO_SIGNALS_CALLBACK_DATA).row();
  }
  return {
    text: notices.sessionSummaryText(label, assetId, view),
    reply_markup: keyboard.text(CLIENT_LABELS.menuButton, MENU_CALLBACK_DATA),
  };
}

// The waiting message (#536, docs/bot-session.md → The waiting message): the wait for the next
// signal, with the one button that stops the session; `:w` tells the bot to delete it on a press.
export const sessionWaitingMessage = (sessionId: string): ClientPushMessage => ({
  text: CLIENT_TEXTS.sessionWaitingSignal,
  reply_markup: new InlineKeyboard().text(
    CLIENT_LABELS.sessionStopButton,
    sessionStopCallbackData(sessionId, { waiting: true }),
  ),
});
