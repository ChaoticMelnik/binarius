import type { BotCommand, BotCommandScope } from 'grammy/types';
import { LABELS } from './texts';

// The one list of commands shown in Telegram's menu; the next command is one more element here.
export const BOT_COMMANDS = [
  { command: 'start', description: LABELS.startCommand },
] as const satisfies readonly BotCommand[];

// Private chats only: the bot ignores every other chat type (bot.chatType('private') in bot.ts),
// so a menu there would offer commands nothing answers.
export const BOT_COMMAND_SCOPE = {
  type: 'all_private_chats',
} as const satisfies BotCommandScope;
