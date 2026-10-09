import { describe, expect, it } from 'vitest';
import { BOT_COMMANDS, BOT_COMMAND_SCOPE, botCommandsOf } from './bot-commands';
import { BotTextGroup, botTextKeysOf, createBotTexts, defaultBotTextSource } from './bot-texts';

// Bot API limits of BotCommand (setMyCommands): a command is 1-32 lowercase English letters,
// digits and underscores, a description 1-256 characters counted in UTF-16 code units, which is
// what String#length returns, and a list holds at most 100 commands. A list outside them is
// refused by Telegram at every publish, so it is caught here instead. An override of a
// description is held to the same 256 by its catalog entry's limit.
const COMMAND_PATTERN = /^[a-z0-9_]{1,32}$/;
const DESCRIPTION_LIMIT = 256;
const LIST_LIMIT = 100;

describe('BOT_COMMANDS', () => {
  it('C1 lists every key of the commands group once, and nothing else', () => {
    const keys = BOT_COMMANDS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(botTextKeysOf(BotTextGroup.Commands)));
  });

  it('C2 reads the descriptions from the texts it is given', () => {
    const { plain } = createBotTexts({
      sourceOf: (key) => (key === 'startCommand' ? 'Поехали' : defaultBotTextSource.sourceOf(key)),
    });
    const menu = botCommandsOf(plain);
    expect(menu[0]).toEqual({ command: 'start', description: 'Поехали' });
    expect(menu.slice(1)).toEqual(
      botCommandsOf(createBotTexts(defaultBotTextSource).plain).slice(1),
    );
  });

  it('C3 keeps the menu inside the Bot API limits', () => {
    const menu = botCommandsOf(createBotTexts(defaultBotTextSource).plain);
    for (const { command, description } of menu) {
      expect(command).toMatch(COMMAND_PATTERN);
      expect(description.trim().length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    }
    const commands = menu.map((entry) => entry.command);
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands.length).toBeLessThanOrEqual(LIST_LIMIT);
    // a literal: a scope widened to `default` by mistake would show the menu in groups the bot
    // ignores, and should be a red test rather than a silent change
    expect(BOT_COMMAND_SCOPE).toEqual({ type: 'all_private_chats' });
  });
});
