import { describe, expect, it } from 'vitest';
import type { BackendClient } from './backend-client';
import { createBot } from './bot';
import { BOT_COMMANDS, BOT_COMMAND_SCOPE } from './commands';
import { ACCOUNT_VIEW, BOT_INFO, USER_VIEW, captureApi, fakeLogger, textUpdate } from './testing';

// Bot API limits of BotCommand (setMyCommands): a command is 1-32 lowercase English letters,
// digits and underscores, a description 1-256 characters counted in UTF-16 code units, which is
// what String#length returns — the same unit texts.test.ts counts in — and a list holds at most
// 100 commands. A list outside them is refused by Telegram at every start, and the refusal is
// only a warn line, so it is caught here instead.
const COMMAND_PATTERN = /^[a-z0-9_]{1,32}$/;
const DESCRIPTION_LIMIT = 256;
const LIST_LIMIT = 100;

describe('the command menu', () => {
  it.each(BOT_COMMANDS.map((entry) => [entry.command, entry] as const))(
    'keeps /%s inside the Bot API limits',
    (_command, entry) => {
      expect(entry.command).toMatch(COMMAND_PATTERN);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    },
  );

  it('lists each command once and no more than Telegram takes', () => {
    const commands = BOT_COMMANDS.map((entry) => entry.command);
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands.length).toBeLessThanOrEqual(LIST_LIMIT);
  });

  // a literal: a scope widened to `default` by mistake would show the menu in groups the bot
  // ignores, and should be a red test rather than a silent change
  it('shows the menu in private chats only', () => {
    expect(BOT_COMMAND_SCOPE).toEqual({ type: 'all_private_chats' });
  });

  // grammY keeps no registry of handlers, so the only way to know a listed command is answered
  // is to send it
  it.each(BOT_COMMANDS.map((entry) => entry.command))('answers /%s', async (command) => {
    const backend: BackendClient = {
      recordStart: () => Promise.resolve(USER_VIEW),
      readAccount: () => Promise.resolve(ACCOUNT_VIEW),
      startLogin: () => Promise.reject(new Error('not used here')),
      confirmLogin: () => Promise.reject(new Error('not used here')),
      sendEmailCode: () => Promise.reject(new Error('not used here')),
      emailLogin: () => Promise.reject(new Error('not used here')),
      recordChatMember: () => Promise.reject(new Error('not used here')),
      setNotificationLevel: () => Promise.reject(new Error('not used here')),
      readTradingAccess: () => Promise.reject(new Error('not used here')),
      readPairs: () => Promise.reject(new Error('not used here')),
      evaluateSignal: () => Promise.reject(new Error('not used here')),
    };
    const bot = createBot({
      token: '123456:AA-bot-token',
      backend,
      logger: fakeLogger(),
      botInfo: BOT_INFO,
    });
    const api = captureApi(bot);

    await bot.handleUpdate(textUpdate(`/${command}`));

    expect(api.calls.map((call) => call.method)).toContain('sendMessage');
  });
});
