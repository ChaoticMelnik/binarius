import {
  analysisUnusedPayloadSchema,
  BUY_CALLBACK_DATA,
  ButtonRole,
  callbackButton,
  commandRetryCallbackData,
  cycleDoorCallbackData,
  DEMO_CALLBACK_DATA,
  demoAnalysisCallbackData,
  helpLinksCaption,
  keyboardOf,
  MENU_CALLBACK_DATA,
  MODE_CALLBACK_DATA,
  NotificationKind,
  realModeByDepositPayloadSchema,
  referralRewardedPayloadSchema,
  sessionIdlePayloadSchema,
  tokenNudgePayloadSchema,
  TradeMode,
  webAppButton,
  weeklySummaryPayloadSchema,
  type BotKeyboard,
  type BotLanguage,
  type BotStaticHtmlKey,
  type TelegramHtml,
} from '@binarius/shared';
import { demoKeyboard, type ClientPushMessage } from '../auth/client-push';
import { clientLabelsOf, clientSessionTextsOf, clientTextsOf } from '../auth/texts';
import { helpLinksConfigured, helpLinksKeyboard, type HelpLinks } from './help-links';

type Payload = Record<string, unknown>;

// What a message reads besides its payload: the cashier's Mini App URL (cashierUrlOf, undefined
// without https), the help push's links from the env (#879), the user's mode and language at the
// claim. Every kind is written in that language (#686, #633).
export interface MailingContext {
  cashierUrl: string | undefined;
  helpLinks: HelpLinks;
  tradingMode: TradeMode;
  language: BotLanguage;
}

// The pictures a mailing sends (#879): the engine holds each one's file and file_id
// (MailingEngineDeps.photos), so a message names its picture only.
export type MailingPhoto = 'help_banner';

// A mailing with a picture: its caption carries the text (ClientPush.sendMailingPhoto).
export interface MailingPhotoMessage {
  photo: MailingPhoto;
  caption: TelegramHtml;
  reply_markup: BotKeyboard;
}

export type MailingMessage = ClientPushMessage | MailingPhotoMessage;

// The first-session chain leads into the demo (#320's entry), the path to a session.
const chainStep =
  (key: BotStaticHtmlKey) =>
  (_payload: Payload, { language }: MailingContext): ClientPushMessage => ({
    text: clientTextsOf(language)[key],
    reply_markup: demoKeyboard(language),
  });

// The analysis reminder (#484): a fresh analysis of the pair and duration the user analysed, since
// the signal shown then is stale. A payload that does not parse throws, which the sender settles
// as `mailing not built`.
function analysisUnused(payload: Payload, { language }: MailingContext): ClientPushMessage {
  const { assetId, durationSec } = analysisUnusedPayloadSchema.parse(payload);
  return {
    text: clientTextsOf(language).analysisUnusedReminder,
    // the reminder's one step forward (#475): green, its own row
    reply_markup: keyboardOf([
      callbackButton(
        ButtonRole.Forward,
        clientLabelsOf(language).newAnalysisButton,
        demoAnalysisCallbackData(assetId, durationSec),
      ),
    ]),
  };
}

// The inviter's reward (#576): the amount is the ledger row's, carried as text (rule 2); the
// button opens /invite as a new message, as the bot's own retry of the command does.
function referralRewarded(payload: Payload, { language }: MailingContext): ClientPushMessage {
  const { tokens } = referralRewardedPayloadSchema.parse(payload);
  return {
    text: clientTextsOf(language).referralRewarded({ rewardTokens: tokens }),
    reply_markup: keyboardOf([
      callbackButton(
        ButtonRole.Secondary,
        clientLabelsOf(language).inviteMoreButton,
        commandRetryCallbackData('invite'),
      ),
    ]),
  };
}

// The entry into trading, labelled as the status card labels it in the user's mode (#121): the
// path is the same, DEMO_CALLBACK_DATA.
const entryButton = ({ tradingMode, language }: MailingContext) => {
  const labels = clientLabelsOf(language);
  return callbackButton(
    ButtonRole.Forward,
    tradingMode === TradeMode.Real ? labels.tradeButton : labels.demoButton,
    DEMO_CALLBACK_DATA,
  );
};

// The cashier (#27), or the entry without https, then the token purchase (#117), each on its own
// row: the purchase is the one secondary button there (#475). Without the cashier: the entry alone.
const tokenKeyboard = (cashier: boolean, context: MailingContext) => {
  const labels = clientLabelsOf(context.language);
  const first =
    cashier && context.cashierUrl !== undefined
      ? webAppButton(ButtonRole.Forward, labels.depositButton, context.cashierUrl)
      : entryButton(context);
  return keyboardOf(
    cashier
      ? [first, callbackButton(ButtonRole.Secondary, labels.buyButton, BUY_CALLBACK_DATA)]
      : [first],
  );
};

// The low-token nudge (#123, docs/mailing.md → The low-token nudge): the threshold's balance from
// the payload. 50 %: the entry. 80 % and 100 %: the cashier keyboard. A payload that does not parse
// throws (`mailing not built`).
const tokenNudge =
  (key: 'tokensHalfUsed' | 'tokensLow' | 'tokensOut', cashier: boolean) =>
  (payload: Payload, context: MailingContext): ClientPushMessage => {
    const { tokens } = tokenNudgePayloadSchema.parse(payload);
    return {
      text: clientTextsOf(context.language)[key]({ nudgeTokens: tokens }),
      reply_markup: tokenKeyboard(cashier, context),
    };
  };

// The entry into trading alone, for the scenarios whose button is the way in.
const entryOnly =
  (key: BotStaticHtmlKey) =>
  (_payload: Payload, context: MailingContext): ClientPushMessage => ({
    text: clientTextsOf(context.language)[key],
    reply_markup: keyboardOf([entryButton(context)]),
  });

// The last session's result and «🔁 Запустить снова»: the cycle's door of its pair and duration
// (the amount screen in demo, after the pair's signal check), or the entry when the session's
// settings did not name them. A payload that does not parse throws (`mailing not built`).
// Retention (#124, docs/mailing.md → Retention): the result is the session messages' own («5
// сделок — 3 в плюс, 2 в минус»), from the payload's counts, in the user's language.
function sessionIdle(payload: Payload, context: MailingContext): ClientPushMessage {
  const { assetId, durationSec, ...score } = sessionIdlePayloadSchema.parse(payload);
  const { language } = context;
  return {
    text: clientTextsOf(language).sessionIdleReminder({
      result: clientSessionTextsOf(language).resultOf(score),
    }),
    reply_markup: keyboardOf([
      assetId === null || durationSec === null
        ? entryButton(context)
        : callbackButton(
            ButtonRole.Forward,
            clientLabelsOf(language).sessionRelaunchButton,
            cycleDoorCallbackData(assetId, durationSec),
          ),
    ]),
  };
}

function weeklySummary(payload: Payload, context: MailingContext): ClientPushMessage {
  const score = weeklySummaryPayloadSchema.parse(payload);
  const { language } = context;
  return {
    text: clientTextsOf(language).weeklySummary({
      result: clientSessionTextsOf(language).resultOf(score),
    }),
    reply_markup: keyboardOf([entryButton(context)]),
  };
}

// The second push about no tokens: tokens_out's keyboard; its payload is empty.
const tokensOutStill = (_payload: Payload, context: MailingContext): ClientPushMessage => ({
  text: clientTextsOf(context.language).tokensOutStill,
  reply_markup: tokenKeyboard(true, context),
});

// The switch to real after a deposit (#686, docs/mailing.md → The real-mode notification): the
// stake from the payload (text, rule 2; null names the broker's minimum in words), the mode
// screen and the menu in one row — a lone navigation button is refused (lone_button). A payload
// that does not parse throws (`mailing not built`).
function realModeByDeposit(payload: Payload, { language }: MailingContext): ClientPushMessage {
  const { stake } = realModeByDepositPayloadSchema.parse(payload);
  const labels = clientLabelsOf(language);
  return {
    text: clientTextsOf(language).realModeByDeposit({ stake }),
    reply_markup: keyboardOf([
      callbackButton(ButtonRole.Nav, labels.settingsModeButton, MODE_CALLBACK_DATA),
      callbackButton(ButtonRole.Nav, labels.menuButton, MENU_CALLBACK_DATA),
    ]),
  };
}

// The help push (#879, docs/mailing.md → The help push): the banner, a caption line and a button
// per link the env sets. Without a single link the engine neither plans nor takes the kind; the
// throw (`mailing not built`) keeps a message without a keyboard from going out all the same.
function helpLinks(_payload: Payload, context: MailingContext): MailingPhotoMessage {
  const { helpLinks: links, language } = context;
  if (!helpLinksConfigured(links)) throw new Error('the help push has no link');
  return {
    photo: 'help_banner',
    caption: helpLinksCaption(clientTextsOf(language), {
      channel: links.channelUrl !== undefined,
      reviews: links.reviewsUrl !== undefined,
      manager: links.managerUrl !== undefined,
    }),
    reply_markup: helpLinksKeyboard(context),
  };
}

// What each kind sends (docs/mailing.md), built from the job's payload when the job is sent so a
// text override reaches it. One entry per kind: a kind added to NotificationKind without a message
// does not compile.
const MAILING_MESSAGES = {
  [NotificationKind.FirstSession1h]: chainStep('firstSessionReminder1h'),
  [NotificationKind.FirstSession24h]: chainStep('firstSessionReminder24h'),
  [NotificationKind.FirstSession72h]: chainStep('firstSessionReminder72h'),
  [NotificationKind.AnalysisUnused]: analysisUnused,
  [NotificationKind.ReferralRewarded]: referralRewarded,
  [NotificationKind.TokensHalf]: tokenNudge('tokensHalfUsed', false),
  [NotificationKind.TokensLow]: tokenNudge('tokensLow', true),
  [NotificationKind.TokensOut]: tokenNudge('tokensOut', true),
  [NotificationKind.RealModeByDeposit]: realModeByDeposit,
  [NotificationKind.Inactive3d]: entryOnly('inactiveReminder'),
  [NotificationKind.SessionIdle24h]: sessionIdle,
  [NotificationKind.WeeklySummary]: weeklySummary,
  [NotificationKind.TokensOut2d]: tokensOutStill,
  [NotificationKind.HelpLinks]: helpLinks,
} as const satisfies Record<
  NotificationKind,
  (payload: Payload, context: MailingContext) => MailingMessage
>;

export function mailingMessage(
  kind: NotificationKind,
  payload: Payload,
  context: MailingContext,
): MailingMessage {
  return MAILING_MESSAGES[kind](payload, context);
}
