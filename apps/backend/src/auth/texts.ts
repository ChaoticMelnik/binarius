import {
  BOT_TEXT_DEFAULT_SOURCES,
  BotLanguage,
  createBotTexts,
  createSessionTexts,
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
// without a language, so no text can go out in Russian to everyone unnoticed. Each language is
// read through `active` at the moment a message is built, that language's staff overrides
// included (#634, Rule 30).
let active: Readonly<Record<BotLanguage, BotTextSource<BotTextKey>>> = BOT_TEXT_DEFAULT_SOURCES;
export const setBotTextSources = (
  sources: Readonly<Record<BotLanguage, BotTextSource<BotTextKey>>>,
): void => {
  active = sources;
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
const liveTextsOf = (language: BotLanguage): ClientTexts =>
  textsOf(language, { sourceOf: (key) => active[language].sourceOf(key) });
const TEXTS: Record<BotLanguage, ClientTexts> = {
  [BotLanguage.Ru]: liveTextsOf(BotLanguage.Ru),
  [BotLanguage.En]: liveTextsOf(BotLanguage.En),
};

export const clientTextsOf = (language: BotLanguage): BotHtmlTexts => TEXTS[language].html;
export const clientLabelsOf = (language: BotLanguage): BotPlainTexts => TEXTS[language].plain;
export const clientSessionTextsOf = (language: BotLanguage): SessionTexts =>
  TEXTS[language].session;
