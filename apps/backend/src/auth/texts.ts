import {
  createBotTexts,
  defaultBotTextSource,
  type BotTextKey,
  type BotTextSource,
} from '@binarius/shared';

// What the backend says to a Telegram user on its own, in the client bot's voice: the push after
// the OAuth callback and the mailings (client-push.ts, mailing/messages.ts). The texts are the bot
// texts catalog's (docs/bot-texts.md), read through `active` at the moment a message is built.
let active: BotTextSource<BotTextKey> = defaultBotTextSource;
export const setBotTextSource = (source: BotTextSource<BotTextKey>): void => {
  active = source;
};
const { html, plain } = createBotTexts({ sourceOf: (key) => active.sourceOf(key) });

export const CLIENT_TEXTS = html;
export const CLIENT_LABELS = plain;
