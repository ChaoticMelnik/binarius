import type { BotHtmlTexts, BotPlainTexts } from './bot-texts';
import type { BotLanguage } from './bot-language';
import type { DemoToRealPayload } from './mailing';
import { createSessionTexts, joinHtmlLines, pluralWordOf } from './session-texts';
import { telegramHtml, type TelegramHtml } from './telegram-html';

// The demo-to-real chain's text (#880, docs/mailing.md → The demo-to-real chain): the step's intro,
// an empty line, the user's demo facts, the bonus line of the active deposit_bonus version (none
// without one), the risk and the cashier's button. Here, not in the backend, so the bot's test
// holds the description in bot-text-messages.ts equal to this assembly (Rule 30).
export type DemoToRealIntroKey = 'demoToRealIntro1h' | 'demoToRealIntro24h' | 'demoToRealIntro72h';

export type DemoToRealFacts = Omit<DemoToRealPayload, 'bonus'>;
export type DemoToRealBonus = NonNullable<DemoToRealPayload['bonus']>;

// a minimum of zero has no «from» in the line
const NO_MINIMUM = /^0+(\.0+)?$/;

export function demoToRealText(
  { html, plain, language }: { html: BotHtmlTexts; plain: BotPlainTexts; language: BotLanguage },
  {
    intro,
    facts,
    bonus,
  }: { intro: DemoToRealIntroKey; facts: DemoToRealFacts; bonus: DemoToRealBonus | null },
): TelegramHtml {
  const { sessions, profit, ...score } = facts;
  const word = pluralWordOf(language, sessions, [
    plain.demoSessionOne,
    plain.demoSessionFew,
    plain.demoSessionMany,
  ]);
  const lines = [
    html[intro],
    telegramHtml``,
    html.demoToRealFacts({
      sessions: `${String(sessions)} ${word}`,
      result: createSessionTexts({ html, plain, language }).resultOf(score),
      profit,
    }),
  ];
  if (bonus !== null) {
    lines.push(
      NO_MINIMUM.test(bonus.minAmountUsd)
        ? html.demoToRealBonusAnyAmount({
            tokensPerUsd: bonus.tokensPerUsd,
            maxTokens: bonus.maxTokens,
          })
        : html.demoToRealBonus(bonus),
    );
  }
  lines.push(html.demoToRealRisk, html.demoToRealDeposit);
  return joinHtmlLines(lines);
}
