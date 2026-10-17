import { InlineKeyboard } from 'grammy';
import {
  analysisUnusedPayloadSchema,
  commandRetryCallbackData,
  demoAnalysisCallbackData,
  NotificationKind,
  referralRewardedPayloadSchema,
} from '@binarius/shared';
import { demoKeyboard, type ClientPushMessage } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';

type Payload = Record<string, unknown>;

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
    reply_markup: new InlineKeyboard().text(
      CLIENT_LABELS.newAnalysisButton,
      demoAnalysisCallbackData(assetId, durationSec),
    ),
  };
}

// The inviter's reward (#576): the amount is the ledger row's, carried as text (rule 2); the
// button opens /invite as a new message, as the bot's own retry of the command does.
function referralRewarded(payload: Payload): ClientPushMessage {
  const { tokens } = referralRewardedPayloadSchema.parse(payload);
  return {
    text: CLIENT_TEXTS.referralRewarded({ rewardTokens: tokens }),
    reply_markup: new InlineKeyboard().text(
      CLIENT_LABELS.inviteMoreButton,
      commandRetryCallbackData('invite'),
    ),
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
} as const satisfies Record<NotificationKind, (payload: Payload) => ClientPushMessage>;

export function mailingMessage(kind: NotificationKind, payload: Payload): ClientPushMessage {
  return MAILING_MESSAGES[kind](payload);
}
