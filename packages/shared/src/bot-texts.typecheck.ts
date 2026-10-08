// Compiled by `tsc -b` (include: src) and imported by nothing, like telegram-html.typecheck.ts:
// the directives below are the oracle that the views' types follow each entry's kind and
// variables. If any of them starts compiling, tsc reports TS2578 and `pnpm check` fails.
import { BOT_TEXT_CATALOG, createBotTexts, defaultBotTextSource } from './bot-texts';
import type { DecimalString } from './money';
import { TradeMode } from './trading';
import { telegramHtml, type TelegramHtml } from './telegram-html';

const { html, plain, samples } = createBotTexts(defaultBotTextSource);
const amount = '5' as DecimalString;

export const staticHtml: TelegramHtml = html.welcome;
export const htmlWithContext: TelegramHtml = html.codeSent({
  email: 'ada@example.com',
  firstName: 'Ада',
});
export const unknownEmail: TelegramHtml = html.accountLineActive({ email: null });
export const staticPlain: string = plain.connectButton;
export const plainWithContext: string = plain.confirmButton({ email: 'ada@example.com' });
export const balances: TelegramHtml = html.statusTokens({
  firstName: 'Ада',
  tokens: '12',
  reservedTokens: '0',
  demoBalance: { amount, fresh: true },
  realBalance: null,
  mode: TradeMode.Demo,
  stake: null,
});
export const sample: TelegramHtml = samples.html.codeSent;
export const varsOfKey: readonly string[] = BOT_TEXT_CATALOG.statusTokens.vars;

// @ts-expect-error a text without variables is not a function (TS2349)
export const callStatic = html.welcome({});
// @ts-expect-error a plain key is not on the html view (TS2339)
export const plainOnHtml = html.connectButton;
// @ts-expect-error every variable of the key is passed (TS2345)
export const missingVariable = html.codeSent({ email: 'ada@example.com' });
// @ts-expect-error a variable the key does not have is refused (TS2353)
export const foreignVariable = html.accountLineActive({ email: null, tokens: '1' });
// @ts-expect-error a balance is data the formatter judges fresh or not, never text (TS2322)
export const balanceAsText = html.statusDemo({ ...balancesContext(), demoBalance: '$5.00' });
// @ts-expect-error a TelegramHtml value would nest unchecked html; nesting goes through declared fragments (TS2322)
export const htmlWithHtml = html.accountLineActive({ email: telegramHtml`адрес` });
// @ts-expect-error a plain text is never parsed, so it takes no TelegramHtml (TS2322)
export const htmlIntoPlain = plain.confirmButton({ email: telegramHtml`x` });
// @ts-expect-error a sample is the rendered text, not a function (TS2349)
export const callSample = samples.html.codeSent({});

function balancesContext() {
  return {
    amount: '$1.00',
    firstName: 'Ада',
    tokens: '12',
    reservedTokens: '0',
    demoBalance: null,
    realBalance: null,
    mode: TradeMode.Demo,
    stake: null,
  };
}
