import type { BotCommand, BotCommandScope } from 'grammy/types';
import { LABELS } from './texts';

// The one list of commands shown in Telegram's menu; the next command is one more element here.
export const BOT_COMMANDS = [
  { command: 'start', description: LABELS.startCommand },
  { command: 'menu', description: LABELS.menuCommand },
  { command: 'account', description: LABELS.accountCommand },
  { command: 'settings', description: LABELS.settingsCommand },
  { command: 'help', description: LABELS.helpCommand },
  { command: 'support', description: LABELS.supportCommand },
] as const satisfies readonly BotCommand[];

// Private chats only: the bot ignores every other chat type (bot.chatType('private') in bot.ts),
// so a menu there would offer commands nothing answers.
export const BOT_COMMAND_SCOPE = {
  type: 'all_private_chats',
} as const satisfies BotCommandScope;
