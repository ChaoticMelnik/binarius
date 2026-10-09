import { BotTextGroup, type BotPlainTexts, type BotTextKeyOfGroup } from './bot-texts';

// The client bot's command menu (#301): the names are code, the descriptions are the `commands`
// group's texts, so an override of one reaches the menu the bot publishes at start, the backend's
// publish (apps/backend/src/bot-texts/publish.ts) and /help alike. The order is the menu's and
// /help's. The next command is one more pair here and one more key in the catalog.
export type BotCommandKey = BotTextKeyOfGroup<typeof BotTextGroup.Commands>;

export const BOT_COMMANDS = [
  { command: 'start', key: 'startCommand' },
  { command: 'menu', key: 'menuCommand' },
  { command: 'account', key: 'accountCommand' },
  { command: 'settings', key: 'settingsCommand' },
  { command: 'help', key: 'helpCommand' },
  { command: 'support', key: 'supportCommand' },
] as const satisfies readonly { command: string; key: BotCommandKey }[];

// Private chats only: the bot ignores every other chat type (bot.chatType('private') in
// apps/bot/src/bot.ts), so a menu there would offer commands nothing answers.
export const BOT_COMMAND_SCOPE = { type: 'all_private_chats' } as const;

// structurally grammY's BotCommand; this package does not depend on grammY
export const botCommandsOf = (
  plain: Pick<BotPlainTexts, BotCommandKey>,
): { command: string; description: string }[] =>
  BOT_COMMANDS.map(({ command, key }) => ({ command, description: plain[key] }));
