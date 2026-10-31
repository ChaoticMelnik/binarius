import type { BotHtmlTexts } from './bot-texts';
import { joinHtmlLines } from './session-texts';
import { telegramHtml, type TelegramHtml } from './telegram-html';

// The help push's caption (#879, docs/mailing.md → The help push): the title, an empty line, then
// one line per link the backend's env sets. Here, not in the backend, so the bot's test holds the
// description in bot-text-messages.ts equal to this assembly (Rule 30).
export type HelpLinksCaptionTexts = Pick<
  BotHtmlTexts,
  'helpLinksTitle' | 'helpLinksChannel' | 'helpLinksReviews' | 'helpLinksManager'
>;

export interface HelpLinksPresent {
  channel: boolean;
  reviews: boolean;
  manager: boolean;
}

export function helpLinksCaption(
  html: HelpLinksCaptionTexts,
  present: HelpLinksPresent,
): TelegramHtml {
  const lines = [
    ...(present.channel ? [html.helpLinksChannel] : []),
    ...(present.reviews ? [html.helpLinksReviews] : []),
    ...(present.manager ? [html.helpLinksManager] : []),
  ];
  return lines.length === 0
    ? html.helpLinksTitle
    : joinHtmlLines([html.helpLinksTitle, telegramHtml``, ...lines]);
}
