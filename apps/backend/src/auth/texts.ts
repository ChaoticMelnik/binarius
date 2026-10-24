import {
  BotLanguage,
  createBotTexts,
  createSessionTexts,
  defaultBotTextSource,
  enBotTextSource,
  type BotHtmlTexts,
  type BotPlainTexts,
  type BotTextKey,
  type BotTextSource,
  type SessionTexts,
} from '@binarius/shared';

// What the backend says to a Telegram user on its own, in the client bot's voice: the push after
// the OAuth callback, the deposit and Stars pushes, the mailings and the session notices
// (client-push.ts, mailing/messages.ts, trading/session-notice-messages.ts). The texts are the bot
// texts catalog's (docs/bot-texts.md), in the recipient's language (#508, #633): there is no set
// without a language, so no text can go out in Russian to everyone unnoticed. Russian is the
// catalog read through `active` at the moment a message is built, staff overrides included;
// English is the static source, which overrides do not reach (Rule 30).
let active: BotTextSource<BotTextKey> = defaultBotTextSource;
export const setBotTextSource = (source: BotTextSource<BotTextKey>): void => {
  active = source;
};

// annotated: the inferred type of the whole catalog is past what tsc serializes into a .d.ts
interface ClientTexts {
  html: BotHtmlTexts;
  plain: BotPlainTexts;
  session: SessionTexts;
}
const textsOf = (language: BotLanguage, source: BotTextSource<BotTextKey>): ClientTexts => {
  const { html, plain } = createBotTexts(source);
  return { html, plain, session: createSessionTexts({ html, plain, language }) };
};
const TEXTS: Record<BotLanguage, ClientTexts> = {
  [BotLanguage.Ru]: textsOf(BotLanguage.Ru, { sourceOf: (key) => active.sourceOf(key) }),
  [BotLanguage.En]: textsOf(BotLanguage.En, enBotTextSource),
};

export const clientTextsOf = (language: BotLanguage): BotHtmlTexts => TEXTS[language].html;
export const clientLabelsOf = (language: BotLanguage): BotPlainTexts => TEXTS[language].plain;
export const clientSessionTextsOf = (language: BotLanguage): SessionTexts =>
  TEXTS[language].session;
