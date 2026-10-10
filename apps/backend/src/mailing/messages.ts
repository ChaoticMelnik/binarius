import { NotificationKind } from '@binarius/shared';
import { demoKeyboard, type ClientPushMessage } from '../auth/client-push';
import { CLIENT_TEXTS } from '../auth/texts';

// What each kind sends (docs/mailing.md → The first-session chain), built when the job is sent so
// a text override reaches it. The chain leads into the demo (#320's entry), the path to a session.
// One entry per kind: a kind added to NotificationKind without a message does not compile.
const MAILING_MESSAGES = {
  [NotificationKind.FirstSession1h]: () => CLIENT_TEXTS.firstSessionReminder1h,
  [NotificationKind.FirstSession24h]: () => CLIENT_TEXTS.firstSessionReminder24h,
  [NotificationKind.FirstSession72h]: () => CLIENT_TEXTS.firstSessionReminder72h,
} as const satisfies Record<NotificationKind, () => ClientPushMessage['text']>;

export function mailingMessage(kind: NotificationKind): ClientPushMessage {
  return { text: MAILING_MESSAGES[kind](), reply_markup: demoKeyboard() };
}
