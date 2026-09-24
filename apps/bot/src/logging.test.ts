import pino from 'pino';
import { BotError } from 'grammy';
import type { ApiError, Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { LOG_REDACT_PATHS, UserStatus } from '@binarius/shared';
import type { BackendClient } from './backend-client';
import { createBot } from './bot';
import { TEXTS } from './texts';

// What reaches the log is only provable by reading the log, so this suite runs the real pino
// configuration from index.ts into a sink and asserts on the lines themselves.

const TOKEN = '123456:AA-SECRET-TOKEN-0000000000000000';

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Binarius',
  username: 'binarius_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const UPDATE_ID = 90_210;
const update: Update = {
  update_id: UPDATE_ID,
  message: {
    message_id: 1,
    date: 1,
    chat: { id: 4242, type: 'private', first_name: 'Ada' },
    from: { id: 4242, is_bot: false, first_name: 'Ada' },
    text: '/start',
    entities: [{ type: 'bot_command', offset: 0, length: 6 }],
  },
} as unknown as Update;

const backend: BackendClient = {
  recordStart: () =>
    Promise.resolve({
      telegramUserId: '4242',
      status: UserStatus.Active,
      acquisitionSource: null,
      acquiredAt: null,
      hasActiveBrokerAccount: false,
    }),
  startLogin: vi.fn(),
};

async function linesFrom(sendMessage: ApiError | Error): Promise<string[]> {
  const lines: string[] = [];
  const logger = pino(
    { level: 'info', redact: [...LOG_REDACT_PATHS] },
    { write: (line: string) => void lines.push(line) },
  );
  const bot = createBot({ token: TOKEN, backend, logger, botInfo: BOT_INFO });
  bot.api.config.use((() => {
    if (sendMessage instanceof Error) throw sendMessage;
    return Promise.resolve(sendMessage);
  }) as Parameters<typeof bot.api.config.use>[0]);

  // handleUpdate rethrows the BotError instead of routing it: grammY only hands it to the
  // installed handler on the polling path (bot.js → handleUpdates). The handler under test is
  // the one createBot installed, reached the same way the loop reaches it, with the real error.
  const thrown = await bot.handleUpdate(update).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(BotError);
  await (bot as unknown as { errorHandler(error: BotError): Promise<void> }).errorHandler(
    thrown as BotError,
  );
  return lines;
}

describe('what the bot writes about a failed update', () => {
  it('names the error and the method, and carries nothing from the payload or the description', async () => {
    const [line = ''] = await linesFrom({
      ok: false,
      error_code: 403,
      description: 'Forbidden: SECRET-DESC bot was blocked by the user',
    });
    const logged = JSON.parse(line) as Record<string, unknown>;

    expect(logged).toMatchObject({
      err: { name: 'GrammyError' },
      method: 'sendMessage',
      telegramErrorCode: 403,
      updateId: UPDATE_ID,
      msg: 'update handler failed',
    });
    expect(logged.err).not.toHaveProperty('message');
    expect(logged.err).not.toHaveProperty('stack');
    expect(line).not.toContain('SECRET-DESC');
    // the payload of the refused call is the message we were sending
    expect(line).not.toContain(TEXTS.welcome.slice(0, 30));
    expect(line).not.toContain(TOKEN);
  });

  // the bot token sits in every Bot API URL, so a transport error that quotes the URL carries it
  it('keeps the token out of the line when the error message contains it', async () => {
    const [line = ''] = await linesFrom(
      new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`),
    );
    const logged = JSON.parse(line) as Record<string, unknown>;

    expect(logged).toMatchObject({ err: { name: 'Error' }, updateId: UPDATE_ID });
    expect(logged.err).not.toHaveProperty('message');
    expect(logged.err).not.toHaveProperty('stack');
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('SECRET-TOKEN');
  });
});
