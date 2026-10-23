import {
  analysisUnusedPayloadSchema,
  BUY_CALLBACK_DATA,
  ButtonRole,
  callbackButton,
  commandRetryCallbackData,
  createSessionTexts,
  cycleDoorCallbackData,
  DEMO_CALLBACK_DATA,
  demoAnalysisCallbackData,
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
  type BotLanguage,
} from '@binarius/shared';
import { demoKeyboard, type ClientPushMessage } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS, clientLabelsOf, clientTextsOf } from '../auth/texts';

type Payload = Record<string, unknown>;

// What a message reads besides its payload: the cashier's Mini App URL (cashierUrlOf, undefined
// without https), the user's mode and language at the claim. Only real_mode_by_deposit reads the
// language so far (#686; the others are Russian until #633).
export interface MailingContext {
  cashierUrl: string | undefined;
  tradingMode: TradeMode;
  language: BotLanguage;
}

// The first-session chain leads into the demo (#320's entry), the path to a session.
const chainStep = (text: () => ClientPushMessage['text']) => (): ClientPushMessage => ({
  text: text(),
  reply_markup: demoKeyboard(),
});

// The analysis reminder (#484): a fresh analysis of the pair and duration the user analysed, since
// the signal shown then is stale. A payload that does not parse throws, which the sender settles
// as `mailing not built`.
function analysisUnused(payload: Payload): ClientPushMessage {
  const { assetId, durationSec } = analysisUnusedPayloadSchema.parse(payload);
  return {
    text: CLIENT_TEXTS.analysisUnusedReminder,
    // the reminder's one step forward (#475): green, its own row
    reply_markup: keyboardOf([
      callbackButton(
        ButtonRole.Forward,
        CLIENT_LABELS.newAnalysisButton,
        demoAnalysisCallbackData(assetId, durationSec),
      ),
    ]),
  };
}

// The inviter's reward (#576): the amount is the ledger row's, carried as text (rule 2); the
// button opens /invite as a new message, as the bot's own retry of the command does.
function referralRewarded(payload: Payload): ClientPushMessage {
  const { tokens } = referralRewardedPayloadSchema.parse(payload);
  return {
    text: CLIENT_TEXTS.referralRewarded({ rewardTokens: tokens }),
    reply_markup: keyboardOf([
      callbackButton(
        ButtonRole.Secondary,
        CLIENT_LABELS.inviteMoreButton,
        commandRetryCallbackData('invite'),
      ),
    ]),
  };
}

// The entry into trading, labelled as the status card labels it in the user's mode (#121): the
// path is the same, DEMO_CALLBACK_DATA.
const entryButton = (tradingMode: TradeMode) =>
  callbackButton(
    ButtonRole.Forward,
    tradingMode === TradeMode.Real ? CLIENT_LABELS.tradeButton : CLIENT_LABELS.demoButton,
    DEMO_CALLBACK_DATA,
  );

// The cashier (#27), or the entry without https, then the token purchase (#117), each on its own
// row: the purchase is the one secondary button there (#475). Without the cashier: the entry alone.
const tokenKeyboard = (cashier: boolean, { cashierUrl, tradingMode }: MailingContext) => {
  const first =
    cashier && cashierUrl !== undefined
      ? webAppButton(ButtonRole.Forward, CLIENT_LABELS.depositButton, cashierUrl)
      : entryButton(tradingMode);
  return keyboardOf(
    cashier
      ? [first, callbackButton(ButtonRole.Secondary, CLIENT_LABELS.buyButton, BUY_CALLBACK_DATA)]
      : [first],
  );
};

// The low-token nudge (#123, docs/mailing.md → The low-token nudge): the threshold's balance from
// the payload. 50 %: the entry. 80 % and 100 %: the cashier keyboard. A payload that does not parse
// throws (`mailing not built`).
const tokenNudge =
  (text: (vars: { nudgeTokens: string }) => ClientPushMessage['text'], cashier: boolean) =>
  (payload: Payload, context: MailingContext): ClientPushMessage => {
    const { tokens } = tokenNudgePayloadSchema.parse(payload);
    return {
      text: text({ nudgeTokens: tokens }),
      reply_markup: tokenKeyboard(cashier, context),
    };
  };

// Retention (#124, docs/mailing.md → Retention). The result is the session messages' own
// («5 сделок — 3 в плюс, 2 в минус»), from the payload's counts.
const sessionTexts = createSessionTexts({ html: CLIENT_TEXTS, plain: CLIENT_LABELS });

// The entry into trading alone, for the scenarios whose button is the way in.
const entryOnly =
  (text: () => ClientPushMessage['text']) =>
  (_payload: Payload, { tradingMode }: MailingContext): ClientPushMessage => ({
    text: text(),
    reply_markup: keyboardOf([entryButton(tradingMode)]),
  });

// The last session's result and «🔁 Запустить снова»: the cycle's door of its pair and duration
// (the amount screen in demo, after the pair's signal check), or the entry when the session's
// settings did not name them. A payload that does not parse throws (`mailing not built`).
function sessionIdle(payload: Payload, { tradingMode }: MailingContext): ClientPushMessage {
  const { assetId, durationSec, ...score } = sessionIdlePayloadSchema.parse(payload);
  return {
    text: CLIENT_TEXTS.sessionIdleReminder({ result: sessionTexts.resultOf(score) }),
    reply_markup: keyboardOf([
      assetId === null || durationSec === null
        ? entryButton(tradingMode)
        : callbackButton(
            ButtonRole.Forward,
            CLIENT_LABELS.sessionRelaunchButton,
            cycleDoorCallbackData(assetId, durationSec),
          ),
    ]),
  };
}

function weeklySummary(payload: Payload, { tradingMode }: MailingContext): ClientPushMessage {
  const score = weeklySummaryPayloadSchema.parse(payload);
  return {
    text: CLIENT_TEXTS.weeklySummary({ result: sessionTexts.resultOf(score) }),
    reply_markup: keyboardOf([entryButton(tradingMode)]),
  };
}

// The second push about no tokens: tokens_out's keyboard; its payload is empty.
const tokensOutStill = (_payload: Payload, context: MailingContext): ClientPushMessage => ({
  text: CLIENT_TEXTS.tokensOutStill,
  reply_markup: tokenKeyboard(true, context),
});

// The switch to real after a deposit (#686, docs/mailing.md → The real-mode notification): the
// stake from the payload (text, rule 2; null names the broker's minimum in words), the mode
// screen and the menu in one row — a lone navigation button is refused (lone_button). In the
// user's language. A payload that does not parse throws (`mailing not built`).
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

// What each kind sends (docs/mailing.md), built from the job's payload when the job is sent so a
// text override reaches it. One entry per kind: a kind added to NotificationKind without a message
// does not compile.
const MAILING_MESSAGES = {
  [NotificationKind.FirstSession1h]: chainStep(() => CLIENT_TEXTS.firstSessionReminder1h),
  [NotificationKind.FirstSession24h]: chainStep(() => CLIENT_TEXTS.firstSessionReminder24h),
  [NotificationKind.FirstSession72h]: chainStep(() => CLIENT_TEXTS.firstSessionReminder72h),
  [NotificationKind.AnalysisUnused]: analysisUnused,
  [NotificationKind.ReferralRewarded]: referralRewarded,
  [NotificationKind.TokensHalf]: tokenNudge((vars) => CLIENT_TEXTS.tokensHalfUsed(vars), false),
  [NotificationKind.TokensLow]: tokenNudge((vars) => CLIENT_TEXTS.tokensLow(vars), true),
  [NotificationKind.TokensOut]: tokenNudge((vars) => CLIENT_TEXTS.tokensOut(vars), true),
  [NotificationKind.RealModeByDeposit]: realModeByDeposit,
  [NotificationKind.Inactive3d]: entryOnly(() => CLIENT_TEXTS.inactiveReminder),
  [NotificationKind.SessionIdle24h]: sessionIdle,
  [NotificationKind.WeeklySummary]: weeklySummary,
  [NotificationKind.TokensOut2d]: tokensOutStill,
} as const satisfies Record<
  NotificationKind,
  (payload: Payload, context: MailingContext) => ClientPushMessage
>;

export function mailingMessage(
  kind: NotificationKind,
  payload: Payload,
  context: MailingContext,
): ClientPushMessage {
  return MAILING_MESSAGES[kind](payload, context);
}
