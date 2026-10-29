import {
  BOT_TEXT_LIMIT,
  ButtonRole,
  callbackButton,
  DEMO_SIGNALS_CALLBACK_DATA,
  keyboardOf,
  pairLabel,
  plainTextOf,
  sessionStopCallbackData,
  SessionStakeStrategy,
  sessionAdaptiveLines,
  sessionNextAdaptiveLine,
  sessionNextStep,
  sessionStakeParams,
  sessionTradeSteps,
  TradingSessionStopReason,
  type PairLabel,
  type PairsCatalogView,
  type SessionOpenNotice,
  type SessionTradeNotice,
  type TelegramHtml,
  type TradingSessionSettings,
  type TradingSessionView,
  type BotKeyboard,
  type BotLanguage,
  type ScanList,
  joinHtmlLines,
  telegramHtml,
} from '@binarius/shared';
import type { ClaimedSessionTrade, SessionOpenNoticeRow } from '@binarius/db';
import { menuButton, type ClientPushMessage } from '../auth/client-push';
import {
  clientLabelsOf,
  clientScanTextsOf,
  clientSessionTextsOf,
  clientTextsOf,
} from '../auth/texts';

// What the session notices say (#464, docs/bot-session.md → Trade messages), in the client bot's
// voice through the catalog (Rule 30) and in the session owner's language (#633): the shared
// builders of session-texts.ts, so the summary's lines are the bot's status message's own. The
// sets are built once a language and read their source when a message is assembled, so the
// overrides of either language reach them (#634).

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

// What the claimed block's turn sends (#551, #700, docs/bot-session.md → The state): a new
// message showing the blocks from `from` to the claimed one, or the edit of the session's cycle
// message to the blocks from its own `from`. `split` marks a new message the cycle message had no
// room for.
export type SessionCycleNotice =
  | { kind: 'send'; text: TelegramHtml; from: number; split: boolean }
  | { kind: 'edit'; messageId: number; text: TelegramHtml; from: number };

// The claimed block in its cycle's message: the last settled trade of `trades`, or the open trade
// below them all (#700). A block's cycle and step come from the session's trades before it, by the
// session's own strategy (#450; settings that cannot be read count as fixed, so every trade is a
// cycle of its own and a new message); the open trade's are those it settles at (sessionNextStep),
// and its index is the one it gets once settled. Each block carries its adaptive line's slot by the
// same history (sessionAdaptiveLines, #718), so the line stands once per cycle wherever the cycle
// is split. The cycle message is edited when it shows the
// claimed block's cycle; otherwise a new message shows the cycle so far. A text longer than
// BOT_TEXT_LIMIT (Telegram's limit less the width spacer the seam appends, #506), measured as
// Telegram counts it after parsing the entities (as telegramTextProblems does), opens a new message
// from the claimed block, so a cycle splits only between blocks.
export function sessionCycleMessage(
  {
    trades,
    open,
    cycleMessage,
  }: Pick<ClaimedSessionTrade, 'trades' | 'cycleMessage'> & { open?: SessionOpenNoticeRow },
  settings: TradingSessionSettings | null,
  digits: number | null,
  language: BotLanguage,
): SessionCycleNotice {
  const notices = clientSessionTextsOf(language);
  const strategy =
    settings === null ? SessionStakeStrategy.Fixed : sessionStakeParams(settings).strategy;
  const results = trades.map((row) => row.result);
  const positions = sessionTradeSteps(results, strategy);
  const lines = sessionAdaptiveLines(results, strategy);
  const blocks = trades.map((row, index): SessionTradeNotice => {
    const position = positions[index];
    const adaptiveLine = lines[index];
    if (position === undefined || adaptiveLine === undefined) {
      throw new Error('a claimed trade has no position in its session');
    }
    return {
      amount: row.amount,
      outcome: row.outcome,
      result: row.result,
      openPrice: row.openPrice,
      closePrice: row.closePrice,
      digits,
      cycle: position.cycle,
      step: position.step,
      adaptiveLine,
    };
  });
  const openBlock: SessionOpenNotice | undefined =
    open === undefined
      ? undefined
      : {
          amount: open.amount,
          action: open.action,
          openPrice: open.openPrice,
          digits,
          ...sessionNextStep(results, strategy),
          adaptiveLine: sessionNextAdaptiveLine(results, strategy),
        };
  const shown: { cycle: number; step: number }[] =
    openBlock === undefined ? blocks : [...blocks, openBlock];
  const last = shown.at(-1);
  if (last === undefined) throw new Error('a claim carries no trade');
  const claimed = shown.length - 1;
  const render = (from: number) => notices.sessionCycleText(blocks.slice(from), openBlock);
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

  // the step is the block's number in its cycle, so the cycle starts that many trades back
  const cycleStart = claimed - (last.step - 1);
  const first = cycleMessage === null ? undefined : shown[cycleMessage.from];
  if (cycleMessage === null || cycleMessage.from > claimed || first?.cycle !== last.cycle) {
    return sendFrom(cycleStart);
  }
  const text = render(cycleMessage.from);
  if (!fits(text)) return splitFromClaimed();
  return { kind: 'edit', messageId: cycleMessage.messageId, text, from: cycleMessage.from };
}

// The finished session's fallback text summary (#537: the bot sends the summary; this text only
// when it cannot, docs/bot-session.md → The fallback), with sound and the menu as its next step; a
// session the no-signal limit stopped gets «🔀 Выбрать другую пару» above it, the signals list
// (`demo:sig`, #509, #685). A summary is sent with a settled trade or for that stop, whose attempt
// had read the settings, so the last intent names the asset when the settings could not be read.
export function sessionSummaryMessage(
  view: TradingSessionView,
  label: PairLabel | null,
  language: BotLanguage,
): ClientPushMessage {
  const assetId = view.settings?.assetId ?? view.lastIntent?.assetId;
  if (assetId === undefined) throw new Error('a summarized session names no asset');
  const otherPair =
    view.stopReason === TradingSessionStopReason.NoSignalTimeout
      ? [
          callbackButton(
            ButtonRole.Forward,
            clientLabelsOf(language).otherPairButton,
            DEMO_SIGNALS_CALLBACK_DATA,
          ),
        ]
      : [];
  return {
    text: clientSessionTextsOf(language).sessionSummaryText(label, assetId, view),
    reply_markup: keyboardOf([...otherPair, menuButton(language)]),
  };
}

// The open trade's block carries the session's «⏹» (#722, docs/bot-session.md → Trade messages):
// `:c` tells the bot to answer with a new message and leave the cycle's blocks alone.
export const sessionCycleStopKeyboard = (sessionId: string, language: BotLanguage): BotKeyboard =>
  keyboardOf([
    callbackButton(
      ButtonRole.Danger,
      clientLabelsOf(language).sessionStopButton,
      sessionStopCallbackData(sessionId, { cycle: true }),
    ),
  ]);

// The waiting message's «⏹» (#536): `:w` tells the bot the press came under the waiting message.
// One keyboard for its send and every edit of its caption (#860).
export const sessionWaitingKeyboard = (sessionId: string, language: BotLanguage): BotKeyboard =>
  keyboardOf([
    callbackButton(
      ButtonRole.Danger,
      clientLabelsOf(language).sessionStopButton,
      sessionStopCallbackData(sessionId, { waiting: true }),
    ),
  ]);

// The session pair's scan (#860): the scanner's list as the sender read it, and the pair
export interface SessionWaitingScan {
  list: ScanList;
  pair: { assetId: number; symbol: string };
}

// The waiting message (#536, docs/bot-session.md → The waiting message): the wait for the next
// signal, with the one button that stops the session. Since #860 the caption under the scanner's
// animation: with the session pair's scan lines (scan-summary.ts → pairScanLines, the bot's wait's
// own), or the header alone when the pair cannot be named.
export const sessionWaitingMessage = (
  sessionId: string,
  language: BotLanguage,
  scan?: SessionWaitingScan,
): ClientPushMessage => {
  const header = clientTextsOf(language).sessionWaitingSignal;
  return {
    text:
      scan === undefined
        ? header
        : telegramHtml`${header}

${joinHtmlLines(clientScanTextsOf(language).pairScanLines(scan.list, scan.pair))}`,
    reply_markup: sessionWaitingKeyboard(sessionId, language),
  };
};
