import type { BotLanguage } from './bot-language';
import type { BotHtmlTexts, BotPlainTexts } from './bot-texts';
import type { DailySummaryPayload } from './mailing';
import { createSessionTexts, joinHtmlLines } from './session-texts';
import { telegramHtml, type TelegramHtml } from './telegram-html';

// The daily summary card's caption (#881, docs/mailing.md → The daily summary): the title with the
// day, an empty line, the demo line, the real line and the line about the button. Here, not in the
// backend, so the bot's test holds the description in bot-text-messages.ts equal to this assembly
// (Rule 30).

// 'YYYY-MM-DD' (the payload's day) as 'dd.mm.yyyy', by the digits: no Intl, no time zone
export const formatDay = (day: string): string => {
  const [year, month, date] = day.split('-');
  return `${date ?? ''}.${month ?? ''}.${year ?? ''}`;
};

export function dailySummaryCaption(
  { html, plain, language }: { html: BotHtmlTexts; plain: BotPlainTexts; language: BotLanguage },
  { day, demo, real }: DailySummaryPayload,
): TelegramHtml {
  const { resultOf } = createSessionTexts({ html, plain, language });
  return joinHtmlLines([
    html.dailySummaryTitle({ date: formatDay(day) }),
    telegramHtml``,
    html.dailySummaryDemo({ result: resultOf(demo), profit: demo.profit }),
    html.dailySummaryReal({ result: resultOf(real), profit: real.profit }),
    html.dailySummaryEntry,
  ]);
}
