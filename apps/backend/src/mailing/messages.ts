import { InlineKeyboard } from 'grammy';
import { DEMO_CALLBACK_DATA, NotificationKind } from '@binarius/shared';
import type { ClientPushMessage } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';

// What each kind sends (docs/mailing.md → The first-session chain), built when the job is sent so
// a text override reaches it. The chain leads into the demo (#320's entry), the path to a session.
const demoButton = () => new InlineKeyboard().text(CLIENT_LABELS.demoButton, DEMO_CALLBACK_DATA);

// One entry per kind: a kind added to NotificationKind without a message does not compile.
export const MAILING_MESSAGES = {
  [NotificationKind.FirstSession1h]: () => ({
    text: CLIENT_TEXTS.firstSessionReminder1h,
    reply_markup: demoButton(),
  }),
  [NotificationKind.FirstSession24h]: () => ({
    text: CLIENT_TEXTS.firstSessionReminder24h,
    reply_markup: demoButton(),
  }),
  [NotificationKind.FirstSession72h]: () => ({
    text: CLIENT_TEXTS.firstSessionReminder72h,
    reply_markup: demoButton(),
  }),
} as const satisfies Record<
  NotificationKind,
  (payload: Record<string, unknown>) => ClientPushMessage
>;

export function mailingMessage(
  kind: NotificationKind,
  payload: Record<string, unknown>,
): ClientPushMessage {
  const build: (payload: Record<string, unknown>) => ClientPushMessage = MAILING_MESSAGES[kind];
  return build(payload);
}
