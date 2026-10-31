import {
  ButtonRole,
  DEMO_TO_REAL_CHAIN,
  keyboardOf,
  NotificationKind,
  urlButton,
  type BotButton,
  type BotKeyboard,
} from '@binarius/shared';
import { clientLabelsOf } from '../auth/texts';
import { sharedFile } from '../package-root';
import type { MailingContext } from './messages';

// The help push's links (#879, docs/mailing.md → The help push), from the backend's env
// (HELP_CHANNEL_URL, HELP_REVIEWS_URL, HELP_MANAGER_URL): https each, undefined when not set.
export interface HelpLinks {
  channelUrl: string | undefined;
  reviewsUrl: string | undefined;
  managerUrl: string | undefined;
}

// the banner's PNG (tooling/help-banner.ts renders it from help-banner.svg beside it)
export const HELP_BANNER_PATH = sharedFile('assets', 'help-banner.png');

export const helpLinksConfigured = ({ channelUrl, reviewsUrl, managerUrl }: HelpLinks): boolean =>
  channelUrl !== undefined || reviewsUrl !== undefined || managerUrl !== undefined;

const DEMO_TO_REAL_KINDS: readonly NotificationKind[] = DEMO_TO_REAL_CHAIN.map((step) => step.kind);

// The kinds this process plans and claims: without a single link the help push has nothing to
// say, and without the cashier (cashierUrlOf, https only) the demo-to-real chain (#880) has no
// button to lead to, so neither is planned nor taken, and a job planned before waits for them
// (docs/mailing.md → The help push, The demo-to-real chain).
export const enabledKinds = ({
  helpLinks,
  cashierUrl,
}: {
  helpLinks: HelpLinks;
  cashierUrl: string | undefined;
}): NotificationKind[] =>
  Object.values(NotificationKind).filter((kind) => {
    if (kind === NotificationKind.HelpLinks) return helpLinksConfigured(helpLinks);
    return !DEMO_TO_REAL_KINDS.includes(kind) || cashierUrl !== undefined;
  });

type ButtonContext = Pick<MailingContext, 'helpLinks' | 'language'>;

// «💬 Написать менеджеру», the mailing kinds' shared button (#879, #880): a url button on its own
// green row (its label is too wide for a row of two), in the recipient's language; undefined
// without HELP_MANAGER_URL, so a kind puts it in its keyboard only when there is one.
export const managerButton = ({ helpLinks, language }: ButtonContext): BotButton | undefined =>
  helpLinks.managerUrl === undefined
    ? undefined
    : urlButton(ButtonRole.Forward, clientLabelsOf(language).managerButton, helpLinks.managerUrl);

// The help push's keyboard: the channel and the reviews in one row, the manager under them; a link
// that is not set has no button.
export function helpLinksKeyboard(context: ButtonContext): BotKeyboard {
  const { helpLinks, language } = context;
  const labels = clientLabelsOf(language);
  const buttons = [
    helpLinks.channelUrl === undefined
      ? undefined
      : urlButton(ButtonRole.Nav, labels.helpChannelButton, helpLinks.channelUrl),
    helpLinks.reviewsUrl === undefined
      ? undefined
      : urlButton(ButtonRole.Nav, labels.helpReviewsButton, helpLinks.reviewsUrl),
    managerButton(context),
  ].filter((button) => button !== undefined);
  return keyboardOf(buttons);
}
