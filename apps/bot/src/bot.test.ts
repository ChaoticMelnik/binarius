import { createServer, type Server } from 'node:http';
import { HttpError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthErrorCode,
  UserStatus,
  type StartLoginResponse,
  type UserStartView,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { CONNECT_CALLBACK_DATA, createBot } from './bot';
import {
  BOT_INFO,
  USER,
  captureApi,
  closeServer,
  connectUpdate,
  fakeLogger,
  inlineButtons,
  listen,
  sentPayload,
  startUpdate,
} from './testing';
import { TEXTS } from './texts';

const view = (patch: Partial<UserStartView> = {}): UserStartView => ({
  telegramUserId: String(USER.id),
  status: UserStatus.Active,
  acquisitionSource: null,
  acquiredAt: null,
  hasActiveBrokerAccount: false,
  ...patch,
});

const LOGIN: StartLoginResponse = {
  authorizeUrl: 'https://binodex.app/oauth/authorize?state=abc',
  state: 'abc',
  expiresAt: '2026-09-24T10:10:00.000Z',
};

function setup(
  options: {
    user?: UserStartView;
    recordStart?: BackendClient['recordStart'];
    startLogin?: BackendClient['startLogin'];
    welcomeVideoFileId?: string;
  } = {},
) {
  const backend: BackendClient = {
    recordStart: options.recordStart ?? vi.fn(() => Promise.resolve(options.user ?? view())),
    startLogin: options.startLogin ?? vi.fn(() => Promise.resolve(LOGIN)),
  };
  const logger = fakeLogger();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend,
    logger,
    botInfo: BOT_INFO,
    ...(options.welcomeVideoFileId === undefined
      ? {}
      : { welcomeVideoFileId: options.welcomeVideoFileId }),
  });
  const { calls, apiErrors } = captureApi(bot);
  return { bot, backend, calls, logger, apiErrors };
}

describe('/start', () => {
  it('greets a new user with the CTA and records the start without optional fields', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(startUpdate('/start'));

    expect(backend.recordStart).toHaveBeenCalledWith({
      telegramUserId: '4242',
      displayName: 'Ada Lovelace',
    });
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.welcome);
    const [button] = inlineButtons(message);
    expect(button).toMatchObject({
      text: TEXTS.connectButton,
      callback_data: CONNECT_CALLBACK_DATA,
    });
    // Bot API: callback_data is 1-64 bytes
    expect(Buffer.byteLength(CONNECT_CALLBACK_DATA, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('passes a payload that matches the pattern', async () => {
    const { bot, backend } = setup();
    await bot.handleUpdate(startUpdate('/start src_ab-CD9'));
    expect(backend.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({ startPayload: 'src_ab-CD9' }),
    );
  });

  it.each([
    ['too long', `/start ${'a'.repeat(65)}`],
    ['with a space', '/start a b'],
    ['with a plus', '/start a+b'],
    ['empty', '/start '],
  ])('treats a payload %s as no payload at all', async (_label, text) => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(startUpdate(text));
    expect(backend.recordStart).toHaveBeenCalledWith({
      telegramUserId: '4242',
      displayName: 'Ada Lovelace',
    });
    // still the ordinary welcome: a link the user did not compose is not their mistake
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.welcome);
  });

  it('sends a language code only when Telegram gives a usable one', async () => {
    const usable = setup();
    await usable.bot.handleUpdate(
      startUpdate('/start', 'private', { ...USER, language_code: 'en-US' }),
    );
    expect(usable.backend.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({ languageCode: 'en-US' }),
    );

    const unusable = setup();
    await unusable.bot.handleUpdate(
      startUpdate('/start', 'private', { ...USER, language_code: 'not a tag' }),
    );
    expect(unusable.backend.recordStart).toHaveBeenCalledWith({
      telegramUserId: '4242',
      displayName: 'Ada Lovelace',
    });
  });

  it('joins the name from what Telegram supplies', async () => {
    const { bot, backend } = setup();
    await bot.handleUpdate(
      startUpdate('/start', 'private', { id: 7, is_bot: false, first_name: 'Ada' }),
    );
    expect(backend.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: '7', displayName: 'Ada' }),
    );
  });

  it('shows a blocked user no CTA', async () => {
    const { bot, calls } = setup({ user: view({ status: UserStatus.Blocked }) });
    await bot.handleUpdate(startUpdate('/start'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.blocked);
    expect(message?.reply_markup).toBeUndefined();
  });

  it('greets a user who already has an active account without the CTA', async () => {
    const { bot, calls } = setup({ user: view({ hasActiveBrokerAccount: true }) });
    await bot.handleUpdate(startUpdate('/start'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.welcomeBack);
    expect(message?.reply_markup).toBeUndefined();
  });

  it('tells the user to come back later when the backend is unreachable', async () => {
    const { bot, calls, logger } = setup({
      recordStart: vi.fn(() => Promise.reject(new BackendError(BackendErrorCode.Unreachable))),
    });
    await bot.handleUpdate(startUpdate('/start'));
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'BackendError' } });
  });

  it('ignores /start outside a private chat', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(startUpdate('/start', 'group'));
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('the welcome video', () => {
  it('sends the welcome as a caption when a file id is configured', async () => {
    const { bot, calls } = setup({ welcomeVideoFileId: 'BAACAgIAAxkB' });
    await bot.handleUpdate(startUpdate('/start'));
    const video = sentPayload(calls, 'sendVideo');
    expect(video).toMatchObject({ video: 'BAACAgIAAxkB', caption: TEXTS.welcome });
    expect(inlineButtons(video)[0]).toMatchObject({ callback_data: CONNECT_CALLBACK_DATA });
    expect(sentPayload(calls, 'sendMessage')).toBeUndefined();
  });

  it('falls back to the text when Telegram refuses the file id', async () => {
    const { bot, calls, logger, apiErrors } = setup({ welcomeVideoFileId: 'not-a-file-id' });
    apiErrors.set('sendVideo', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: wrong file identifier/HTTP URL specified',
    });

    await bot.handleUpdate(startUpdate('/start'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.welcome);
    expect(inlineButtons(message)[0]).toMatchObject({ callback_data: CONNECT_CALLBACK_DATA });
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      err: { name: 'GrammyError' },
      method: 'sendVideo',
      telegramErrorCode: 400,
    });
  });
});

describe('the connect button', () => {
  it('answers the query and sends the authorize link as a url button', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(connectUpdate(CONNECT_CALLBACK_DATA));

    expect(backend.startLogin).toHaveBeenCalledWith('4242');
    expect(calls.map((call) => call.method)).toContain('answerCallbackQuery');
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.loginLink);
    expect(inlineButtons(message)[0]).toMatchObject({
      text: TEXTS.loginButton,
      url: LOGIN.authorizeUrl,
    });
  });

  it('still sends the link when answering the query fails', async () => {
    const { bot, calls, logger, apiErrors } = setup();
    apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: query is too old',
    });

    await bot.handleUpdate(connectUpdate(CONNECT_CALLBACK_DATA));
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.loginLink);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ method: 'answerCallbackQuery' });
  });

  it('shows the blocked text when the backend refuses a blocked user', async () => {
    const { bot, calls } = setup({
      startLogin: vi.fn(() =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 409,
            reason: OAuthErrorCode.UserBlocked,
          }),
        ),
      ),
    });
    await bot.handleUpdate(connectUpdate(CONNECT_CALLBACK_DATA));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.blocked);
    expect(message?.reply_markup).toBeUndefined();
  });

  it('shows the generic text for any other backend failure', async () => {
    const { bot, calls, logger } = setup({
      startLogin: vi.fn(() =>
        Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 500 })),
      ),
    });
    await bot.handleUpdate(connectUpdate(CONNECT_CALLBACK_DATA));
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ backendStatus: 500 });
  });

  it('ignores the callback outside a private chat', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(connectUpdate(CONNECT_CALLBACK_DATA, 'group'));
    expect(backend.startLogin).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('the Bot API timeout', () => {
  let server: Server | undefined;
  afterEach(async () => {
    const running = server;
    server = undefined;
    await closeServer(running);
  });

  it('is the configured one, not grammY’s 500 second default', async () => {
    // a server that accepts the connection and then says nothing: only the client's own
    // timeout can end this call
    const started = createServer(() => {});
    server = started;
    const apiRoot = await listen(started);

    const bot = createBot({
      token: '123456:AA-bot-token',
      backend: { recordStart: vi.fn(), startLogin: vi.fn() } as unknown as BackendClient,
      logger: fakeLogger(),
      botInfo: BOT_INFO,
      apiRoot,
      telegramApiTimeoutMs: 300,
    });

    const at = Date.now();
    const error = await bot.api.sendMessage(1, 'x').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(Date.now() - at).toBeLessThan(5_000);
  });
});
