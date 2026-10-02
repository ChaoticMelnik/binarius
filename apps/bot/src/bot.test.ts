import { createServer, type Server } from 'node:http';
import { BotError, HttpError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmCallbackData,
  OAuthErrorCode,
  UserStatus,
  type UserStartView,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { CONNECT_CALLBACK_DATA, OAUTH_CALLBACK_DATA, RESEND_CALLBACK_DATA, createBot } from './bot';
import { LOGIN_DIALOG_TTL_MS, createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  BOT_INFO,
  CODE,
  CODE_SENT,
  CONFIRMED,
  EMAIL,
  LOGIN,
  PENDING_ACCOUNT_ID,
  USER,
  captureApi,
  closeServer,
  callbackUpdate,
  fakeLogger,
  inlineButtons,
  listen,
  rejectionOf,
  sentPayload,
  startUpdate,
  textUpdate,
  userView,
} from './testing';
import { TEXTS } from './texts';

function setup(
  options: {
    user?: UserStartView;
    recordStart?: BackendClient['recordStart'];
    startLogin?: BackendClient['startLogin'];
    confirmLogin?: BackendClient['confirmLogin'];
    sendEmailCode?: BackendClient['sendEmailCode'];
    emailLogin?: BackendClient['emailLogin'];
    welcomeVideoFileId?: string;
    dialog?: LoginDialogState;
    now?: () => number;
  } = {},
) {
  const backend: BackendClient = {
    recordStart: options.recordStart ?? vi.fn(() => Promise.resolve(options.user ?? userView())),
    startLogin: options.startLogin ?? vi.fn(() => Promise.resolve(LOGIN)),
    confirmLogin: options.confirmLogin ?? vi.fn(() => Promise.resolve(CONFIRMED)),
    sendEmailCode: options.sendEmailCode ?? vi.fn(() => Promise.resolve(CODE_SENT)),
    emailLogin: options.emailLogin ?? vi.fn(() => Promise.resolve(CONFIRMED)),
  };
  const logger = fakeLogger();
  const dialog = createLoginDialog(options.now === undefined ? {} : { now: options.now });
  if (options.dialog !== undefined) dialog.set(USER.id, options.dialog);
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend,
    logger,
    botInfo: BOT_INFO,
    loginDialog: dialog,
    ...(options.welcomeVideoFileId === undefined
      ? {}
      : { welcomeVideoFileId: options.welcomeVideoFileId }),
  });
  const { calls, apiErrors, answers } = captureApi(bot);
  return { bot, backend, calls, logger, apiErrors, answers, dialog };
}

const refused = (status: number, reason?: string) =>
  vi.fn(() => Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status, reason })));

// the first call answers with the refusal, every later one succeeds: what a test needs to show
// that the step the refusal left behind takes the next message
const refusedOnce = <T>(status: number, reason: string | undefined, then: T) =>
  vi
    .fn(() => Promise.resolve(then))
    .mockRejectedValueOnce(new BackendError(BackendErrorCode.HttpStatus, { status, reason }));

const unreachable = () =>
  vi.fn(() => Promise.reject(new BackendError(BackendErrorCode.Unreachable)));

const ON_CODE_STEP: LoginDialogState = { step: 'code', email: EMAIL };

const CODE_STEP_BUTTONS = [
  { text: TEXTS.resendButton, callback_data: RESEND_CALLBACK_DATA },
  { text: TEXTS.changeEmailButton, callback_data: CONNECT_CALLBACK_DATA },
];

const sentTexts = (calls: readonly { method: string; payload: Record<string, unknown> }[]) =>
  calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload.text);

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
    // the email login first, the browser second
    expect(inlineButtons(message)).toEqual([
      { text: TEXTS.connectButton, callback_data: CONNECT_CALLBACK_DATA },
      { text: TEXTS.oauthButton, callback_data: OAUTH_CALLBACK_DATA },
    ]);
    // Bot API: callback_data is 1-64 bytes
    for (const data of [CONNECT_CALLBACK_DATA, OAUTH_CALLBACK_DATA, RESEND_CALLBACK_DATA]) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
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

  it('drops a language tag the request schema would refuse', async () => {
    const { bot, backend } = setup();
    // matches LANGUAGE_CODE_PATTERN but is 38 characters, past the schema's max of 35: letting
    // it through would make /users/start answer 400 and the whole /start read as an outage
    const tag = 'en-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa';
    expect(tag).toHaveLength(38);
    await bot.handleUpdate(startUpdate('/start', 'private', { ...USER, language_code: tag }));
    expect(backend.recordStart).toHaveBeenCalledWith({
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

  it('sends the Telegram id as the name when nothing survives the schema', async () => {
    const { bot, backend } = setup();
    // Bot API promises first_name is non-empty, not that it is non-empty after a trim
    await bot.handleUpdate(
      startUpdate('/start', 'private', { id: 7, is_bot: false, first_name: '   ' }),
    );
    expect(backend.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: '7', displayName: '7' }),
    );
  });

  it('shows a blocked user no CTA', async () => {
    const { bot, calls } = setup({ user: userView({ status: UserStatus.Blocked }) });
    await bot.handleUpdate(startUpdate('/start'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.blocked);
    expect(message?.reply_markup).toBeUndefined();
  });

  it('greets a user who already has an active account without the CTA', async () => {
    const { bot, calls } = setup({ user: userView({ hasActiveBrokerAccount: true }) });
    await bot.handleUpdate(startUpdate('/start'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.welcomeBack);
    expect(message?.reply_markup).toBeUndefined();
  });

  it('offers to confirm a link that waits for it, one button per link', async () => {
    const other = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const { bot, calls } = setup({
      user: userView({
        pendingBrokerAccounts: [
          { id: PENDING_ACCOUNT_ID, email: 'ada@example.test' },
          { id: other, email: null },
        ],
      }),
    });
    await bot.handleUpdate(startUpdate('/start'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.confirmPrompt);
    expect(message?.parse_mode).toBeUndefined();
    expect(inlineButtons(message)).toEqual([
      { text: 'Подтвердить: ada@example.test', callback_data: `confirm:${PENDING_ACCOUNT_ID}` },
      { text: 'Подтвердить привязку', callback_data: `confirm:${other}` },
    ]);
  });

  // a link the owner of this Telegram account did not make must not hide behind "welcome back"
  it('puts a waiting link before the welcome back', async () => {
    const { bot, calls } = setup({
      user: userView({
        hasActiveBrokerAccount: true,
        pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email: null }],
      }),
    });
    await bot.handleUpdate(startUpdate('/start'));
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.confirmPrompt);
  });

  it('shows a blocked user no confirm button either', async () => {
    const { bot, calls } = setup({
      user: userView({
        status: UserStatus.Blocked,
        pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email: null }],
      }),
    });
    await bot.handleUpdate(startUpdate('/start'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.blocked);
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

  it('sends no second welcome when the video call fails in transport', async () => {
    const { bot, calls, logger, apiErrors } = setup({ welcomeVideoFileId: 'BAACAgIAAxkB' });
    // grammY's own timeoutSeconds abort and a dropped socket both arrive as HttpError, and
    // Telegram may well have delivered the video: a text welcome here would be the second one
    apiErrors.set(
      'sendVideo',
      new HttpError(
        "Network request for 'sendVideo' failed!",
        new Error('The operation was aborted due to timeout'),
      ),
    );

    await bot.handleUpdate(startUpdate('/start'));
    expect(sentPayload(calls, 'sendMessage')).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    // the method is only known here, so this is where the line is written
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
      err: { name: 'HttpError' },
      method: 'sendVideo',
      transportError: { name: 'Error' },
    });
  });

  it('lets anything that is neither a refusal nor the transport reach bot.catch', async () => {
    const { bot, calls, logger, answers } = setup({ welcomeVideoFileId: 'BAACAgIAAxkB' });
    // not through apiErrors: its type no longer admits a failure the transport cannot produce,
    // and this branch exists precisely for the ones it cannot
    answers.set('sendVideo', () => {
      throw new TypeError('sentinel');
    });

    const thrown = await rejectionOf(bot.handleUpdate(startUpdate('/start')));
    expect(thrown).toBeInstanceOf(BotError);
    expect(sentPayload(calls, 'sendMessage')).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('the oauth button', () => {
  it('answers the query and opens the Mini App login page in a web_app button', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA));

    expect(backend.startLogin).toHaveBeenCalledWith('4242');
    expect(calls.map((call) => call.method)).toContain('answerCallbackQuery');
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.loginLink);
    expect(inlineButtons(message)).toEqual([
      { text: TEXTS.loginButton, web_app: { url: LOGIN.miniAppUrl } },
    ]);
  });

  // the backend sends no Mini App URL for an http redirect: Telegram refuses one in web_app
  it('falls back to the authorize link as a url button when there is no Mini App url', async () => {
    const { authorizeUrl, state, expiresAt } = LOGIN;
    const { bot, calls } = setup({
      startLogin: vi.fn(() => Promise.resolve({ authorizeUrl, state, expiresAt })),
    });
    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA));

    expect(inlineButtons(sentPayload(calls, 'sendMessage'))).toEqual([
      { text: TEXTS.loginButton, url: LOGIN.authorizeUrl },
    ]);
  });

  it('still sends the link when answering the query fails', async () => {
    const { bot, calls, logger, apiErrors } = setup();
    apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: query is too old',
    });

    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA));
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
    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA));
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
    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA));
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ backendStatus: 500 });
  });

  it('ignores the callback outside a private chat', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA, 'group'));
    expect(backend.startLogin).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('the confirm button', () => {
  const update = () => callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID));

  // CONFIRMED carries 7 tokens, not the real pack: the text must be the backend's number
  it('confirms as the user who pressed it and reports the pack the backend paid', async () => {
    const { bot, backend, calls, logger } = setup();
    await bot.handleUpdate(update());

    expect(backend.confirmLogin).toHaveBeenCalledWith('4242', PENDING_ACCOUNT_ID);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.linkedWithBonus('7'));
    expect(message?.text).toContain(': 7.');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['not_partner_client' as const, TEXTS.linkedNoBonusNotPartner],
    ['already_granted' as const, TEXTS.linkedNoBonusAlready],
  ])('says why no pack was paid (%s)', async (reason, text) => {
    const { bot, calls } = setup({
      confirmLogin: vi.fn(() =>
        Promise.resolve({ ...CONFIRMED, grant: { granted: false as const, reason } }),
      ),
    });
    await bot.handleUpdate(update());
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(text);
  });

  it.each([
    [404, OAuthErrorCode.BrokerAccountNotFound, TEXTS.confirmNotFound],
    [409, OAuthErrorCode.AccountNotPending, TEXTS.confirmAlreadyDone],
    [409, OAuthErrorCode.UserBlocked, TEXTS.blocked],
  ])('answers a %i %s with its own text and no warning', async (status, reason, text) => {
    const { bot, calls, logger } = setup({
      confirmLogin: vi.fn(() =>
        Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status, reason })),
      ),
    });
    await bot.handleUpdate(update());
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(text);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('shows the generic text and warns for any other backend failure', async () => {
    const { bot, calls, logger } = setup({
      confirmLogin: vi.fn(() =>
        Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 500 })),
      ),
    });
    await bot.handleUpdate(update());
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      err: { name: 'BackendError' },
      backendStatus: 500,
    });
  });

  it('still reports the outcome when answering the query fails', async () => {
    const { bot, calls, logger, apiErrors } = setup();
    apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: query is too old',
    });
    await bot.handleUpdate(update());
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.linkedWithBonus('7'));
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ method: 'answerCallbackQuery' });
  });

  it('stops the spinner and calls nothing for data that is not a uuid', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(`confirm:${'-'.repeat(36)}`));
    expect(backend.confirmLogin).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery']);
  });

  it('ignores the callback outside a private chat', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID), 'group'));
    expect(backend.confirmLogin).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('the connect button', () => {
  it('answers the query and asks for the address without calling the backend', async () => {
    const { bot, backend, calls, dialog } = setup();
    await bot.handleUpdate(callbackUpdate(CONNECT_CALLBACK_DATA));

    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.emailPrompt);
    expect(message?.reply_markup).toBeUndefined();
    expect(dialog.get(USER.id)).toEqual({ step: 'email' });
    expect(backend.startLogin).not.toHaveBeenCalled();
    expect(backend.sendEmailCode).not.toHaveBeenCalled();
  });

  it('still asks when answering the query fails', async () => {
    const { bot, calls, logger, apiErrors } = setup();
    apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: query is too old',
    });
    await bot.handleUpdate(callbackUpdate(CONNECT_CALLBACK_DATA));
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.emailPrompt);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ method: 'answerCallbackQuery' });
  });

  // «Изменить адрес» carries the same data
  it('takes a user waiting for a code back to the address', async () => {
    const { bot, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(callbackUpdate(CONNECT_CALLBACK_DATA));
    expect(dialog.get(USER.id)).toEqual({ step: 'email' });
  });

  it('ignores the callback outside a private chat', async () => {
    const { bot, calls, dialog } = setup();
    await bot.handleUpdate(callbackUpdate(CONNECT_CALLBACK_DATA, 'group'));
    expect(calls).toEqual([]);
    expect(dialog.get(USER.id)).toBeUndefined();
  });
});

describe('the address step', () => {
  const ON_EMAIL_STEP: LoginDialogState = { step: 'email' };

  it('asks for a code to the trimmed address and shows the address back with the buttons', async () => {
    const { bot, backend, calls, dialog, logger } = setup({ dialog: ON_EMAIL_STEP });
    await bot.handleUpdate(textUpdate(`  ${EMAIL} `));

    expect(backend.sendEmailCode).toHaveBeenCalledWith('4242', EMAIL);
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.codeSent(EMAIL));
    expect(message?.text).toContain(EMAIL);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual({ step: 'code', email: EMAIL });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('answers text that is not an address at once, without calling the backend', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_EMAIL_STEP });
    await bot.handleUpdate(textUpdate('ada at example'));

    expect(backend.sendEmailCode).not.toHaveBeenCalled();
    expect(sentTexts(calls)).toEqual([TEXTS.emailInvalid]);
    expect(dialog.get(USER.id)).toEqual(ON_EMAIL_STEP);
  });

  it('stays on the address when the broker refuses it', async () => {
    const { bot, calls, dialog, logger } = setup({
      dialog: ON_EMAIL_STEP,
      sendEmailCode: refused(400, OAuthErrorCode.InvalidEmail),
    });
    await bot.handleUpdate(textUpdate(EMAIL));
    expect(sentTexts(calls)).toEqual([TEXTS.emailRefused]);
    expect(dialog.get(USER.id)).toEqual(ON_EMAIL_STEP);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [429, OAuthErrorCode.TooManyAttempts, TEXTS.tooManyCodeRequests],
    [409, OAuthErrorCode.UserBlocked, TEXTS.blocked],
  ])('ends the dialog on a %i %s', async (status, reason, text) => {
    const sendEmailCode = refusedOnce(status, reason, CODE_SENT);
    const { bot, calls, dialog, logger } = setup({ dialog: ON_EMAIL_STEP, sendEmailCode });
    await bot.handleUpdate(textUpdate(EMAIL));
    expect(sentTexts(calls)).toEqual([text]);
    expect(dialog.get(USER.id)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();

    await bot.handleUpdate(textUpdate(EMAIL));
    expect(sendEmailCode).toHaveBeenCalledOnce();
  });

  // the route's ceiling across all users: nothing of this user's was spent
  it('keeps the address step on the route ceiling, and takes the address again', async () => {
    const sendEmailCode = refusedOnce(429, OAuthErrorCode.TooManyRequests, CODE_SENT);
    const { bot, calls, dialog, logger } = setup({ dialog: ON_EMAIL_STEP, sendEmailCode });
    await bot.handleUpdate(textUpdate(EMAIL));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.sendCodeBusy);
    expect(message?.reply_markup).toBeUndefined();
    expect(dialog.get(USER.id)).toEqual(ON_EMAIL_STEP);
    expect(logger.warn).not.toHaveBeenCalled();

    await bot.handleUpdate(textUpdate(EMAIL));
    expect(sendEmailCode).toHaveBeenCalledTimes(2);
    expect(sentTexts(calls)).toEqual([TEXTS.sendCodeBusy, TEXTS.codeSent(EMAIL)]);
  });

  // the owner's answer 2a of the round 1 fixes: a kept step keeps its clock
  it('does not give a step kept after a refusal a new lifetime', async () => {
    let at = 0;
    const { bot, dialog } = setup({
      dialog: ON_EMAIL_STEP,
      now: () => at,
      sendEmailCode: refused(429, OAuthErrorCode.TooManyRequests),
    });
    at = LOGIN_DIALOG_TTL_MS - 1;
    await bot.handleUpdate(textUpdate(EMAIL));
    at = LOGIN_DIALOG_TTL_MS;
    expect(dialog.get(USER.id)).toBeUndefined();
  });

  // every other 4xx comes before the broker (apps/backend/src/auth/routes.ts), so no letter went
  // out; 415 with no reason stands for a 4xx of Fastify's own, whose body has no error code
  it.each([
    [400, 'validation'],
    [401, 'unauthorized'],
    [404, 'not_found'],
    [415, undefined],
  ])(
    'keeps the address step on a %i %s before the letter, and takes the address again',
    async (status, reason) => {
      const sendEmailCode = refusedOnce(status, reason, CODE_SENT);
      const { bot, calls, dialog, logger } = setup({ dialog: ON_EMAIL_STEP, sendEmailCode });
      await bot.handleUpdate(textUpdate(EMAIL));
      const message = sentPayload(calls, 'sendMessage');
      expect(message?.text).toBe(TEXTS.unavailable);
      expect(message?.reply_markup).toBeUndefined();
      expect(dialog.get(USER.id)).toEqual(ON_EMAIL_STEP);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ backendStatus: status }),
        'email code not sent',
      );

      await bot.handleUpdate(textUpdate(EMAIL));
      expect(sendEmailCode).toHaveBeenCalledTimes(2);
      expect(sentTexts(calls)).toEqual([TEXTS.unavailable, TEXTS.codeSent(EMAIL)]);
    },
  );

  it('does not give the step kept after a refusal before the letter a new lifetime', async () => {
    let at = 0;
    const { bot, dialog } = setup({
      dialog: ON_EMAIL_STEP,
      now: () => at,
      sendEmailCode: refused(401, 'unauthorized'),
    });
    at = LOGIN_DIALOG_TTL_MS - 1;
    await bot.handleUpdate(textUpdate(EMAIL));
    at = LOGIN_DIALOG_TTL_MS;
    expect(dialog.get(USER.id)).toBeUndefined();
  });

  // a failure that is not the backend's answer at all: nothing says the letter did not go out
  it('moves to the code step and warns when the client fails with something else', async () => {
    const { bot, calls, dialog, logger } = setup({
      dialog: ON_EMAIL_STEP,
      sendEmailCode: vi.fn(() => Promise.reject(new TypeError('boom'))),
    });
    await bot.handleUpdate(textUpdate(EMAIL));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.codeSentUnknown(EMAIL));
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual({ step: 'code', email: EMAIL });
    expect(logger.warn.mock.calls[0]?.[1]).toBe('email code not sent');
  });

  // the letter may have gone out although its answer did not come back
  it.each([
    ['unreachable', unreachable()],
    ['a 500', refused(500)],
    ['a 502 broker_unavailable', refused(502, OAuthErrorCode.BrokerUnavailable)],
    ['a 502 broker_contract_violation', refused(502, OAuthErrorCode.BrokerContractViolation)],
  ])('moves to the code step and warns when the backend is %s', async (_label, sendEmailCode) => {
    const { bot, backend, calls, dialog, logger } = setup({
      dialog: ON_EMAIL_STEP,
      sendEmailCode,
    });
    await bot.handleUpdate(textUpdate(EMAIL));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.codeSentUnknown(EMAIL));
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual({ step: 'code', email: EMAIL });
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'BackendError' } });

    await bot.handleUpdate(textUpdate(CODE));
    expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
  });
});

describe('the code step', () => {
  it('logs in with the address of the dialog and reports the pack the backend paid', async () => {
    const { bot, backend, calls, dialog, logger } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(textUpdate(` ${CODE} `));

    expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
    expect(sentTexts(calls)).toEqual([TEXTS.linkedWithBonus('7')]);
    expect(dialog.get(USER.id)).toBeUndefined();
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says why no pack was paid', async () => {
    const { bot, calls } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: vi.fn(() =>
        Promise.resolve({
          ...CONFIRMED,
          grant: { granted: false as const, reason: 'not_partner_client' as const },
        }),
      ),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([TEXTS.linkedNoBonusNotPartner]);
  });

  it('answers a code the schema refuses at once, keeping the step', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(textUpdate('c'.repeat(65)));

    expect(backend.emailLogin).not.toHaveBeenCalled();
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.codeInvalid);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
  });

  it.each([
    [429, OAuthErrorCode.TooManyAttempts, TEXTS.tooManyCodeAttempts],
    [409, OAuthErrorCode.UserBlocked, TEXTS.blocked],
    [409, OAuthErrorCode.BrokerAccountTaken, TEXTS.accountTaken],
  ])('ends the dialog on a definite %i %s without a recheck', async (status, reason, text) => {
    const emailLogin = refusedOnce(status, reason, CONFIRMED);
    const { bot, backend, calls, dialog, logger } = setup({ dialog: ON_CODE_STEP, emailLogin });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([text]);
    expect(dialog.get(USER.id)).toBeUndefined();
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();

    await bot.handleUpdate(textUpdate(CODE));
    expect(emailLogin).toHaveBeenCalledOnce();
  });

  // refused by the route's ceiling before the broker saw the code, so the code is still good
  it('keeps the code step on the route ceiling, without a recheck, and takes the code again', async () => {
    const emailLogin = refusedOnce(429, OAuthErrorCode.TooManyRequests, CONFIRMED);
    const { bot, backend, calls, dialog, logger } = setup({ dialog: ON_CODE_STEP, emailLogin });
    await bot.handleUpdate(textUpdate(CODE));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.loginBusy);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();

    await bot.handleUpdate(textUpdate(CODE));
    expect(emailLogin).toHaveBeenLastCalledWith('4242', EMAIL, CODE);
    expect(sentTexts(calls)).toEqual([TEXTS.loginBusy, TEXTS.linkedWithBonus('7')]);
  });

  it('rechecks an invalid code and keeps the step when no account is active', async () => {
    const { bot, backend, calls, dialog, logger } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: refused(400, OAuthErrorCode.InvalidCode),
    });
    await bot.handleUpdate(textUpdate(CODE));

    // the same request /start sends, without a payload
    expect(backend.recordStart).toHaveBeenCalledWith({
      telegramUserId: '4242',
      displayName: 'Ada Lovelace',
    });
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.codeInvalid);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid code', refused(400, OAuthErrorCode.InvalidCode)],
    ['an unreachable backend', unreachable()],
    ['a broker outage', refused(502, OAuthErrorCode.BrokerUnavailable)],
  ])('reports the account connected after %s when it is active', async (_label, emailLogin) => {
    const { bot, calls, dialog } = setup({
      dialog: ON_CODE_STEP,
      emailLogin,
      user: userView({ hasActiveBrokerAccount: true }),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([TEXTS.linkedActive]);
    expect(dialog.get(USER.id)).toBeUndefined();
  });

  it('shows the blocked text when the recheck finds the user blocked', async () => {
    const { bot, calls, dialog } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: unreachable(),
      user: userView({ status: UserStatus.Blocked }),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([TEXTS.blocked]);
    expect(dialog.get(USER.id)).toBeUndefined();
  });

  it('keeps the step and warns when the login fails and no account is active', async () => {
    const { bot, calls, dialog, logger } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: refused(500),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([TEXTS.unavailable]);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['email login failed']);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ backendStatus: 500 });
  });

  // without the state, "wrong code" would be a guess
  it('says the service is unavailable, not that the code is wrong, when the recheck fails', async () => {
    const { bot, calls, dialog, logger } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: refused(400, OAuthErrorCode.InvalidCode),
      recordStart: unreachable(),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([TEXTS.unavailable]);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'email login outcome not rechecked',
    ]);
  });

  // the owner's answer 4b: on this step everything typed is a code
  it('sends an address typed on the code step as a code', async () => {
    const { bot, backend, calls } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: refused(400, OAuthErrorCode.InvalidCode),
    });
    await bot.handleUpdate(textUpdate('other@example.test'));
    expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, 'other@example.test');
    expect(sentTexts(calls)).toEqual([TEXTS.codeInvalid]);
  });

  // the criterion added to #171 after the review of PR #172
  it('reports the account connected when the answer to a login that went through was lost', async () => {
    const emailLogin = vi
      .fn<BackendClient['emailLogin']>()
      .mockRejectedValueOnce(new BackendError(BackendErrorCode.Unreachable))
      .mockRejectedValueOnce(
        new BackendError(BackendErrorCode.HttpStatus, {
          status: 400,
          reason: OAuthErrorCode.InvalidCode,
        }),
      );
    const recordStart = vi
      .fn<BackendClient['recordStart']>()
      .mockResolvedValueOnce(userView())
      .mockResolvedValueOnce(userView({ hasActiveBrokerAccount: true }));
    const { bot, calls, dialog } = setup({ dialog: ON_CODE_STEP, emailLogin, recordStart });

    await bot.handleUpdate(textUpdate(CODE));
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    await bot.handleUpdate(textUpdate(CODE));

    expect(sentTexts(calls)).toEqual([TEXTS.unavailable, TEXTS.linkedActive]);
    expect(dialog.get(USER.id)).toBeUndefined();
  });
});

describe('the resend button', () => {
  it('sends a new code to the address of the dialog', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));

    expect(backend.sendEmailCode).toHaveBeenCalledWith('4242', EMAIL);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.codeSent(EMAIL));
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
  });

  it('says the request no longer holds when there is no dialog', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
    expect(backend.sendEmailCode).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(sentTexts(calls)).toEqual([TEXTS.codeRequestStale]);
  });

  it('asks for the address when there is none yet', async () => {
    const { bot, backend, calls } = setup({ dialog: { step: 'email' } });
    await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
    expect(backend.sendEmailCode).not.toHaveBeenCalled();
    expect(sentTexts(calls)).toEqual([TEXTS.emailPrompt]);
  });

  // the code already sent stays good whichever limit refused a new one
  it.each([OAuthErrorCode.TooManyAttempts, OAuthErrorCode.TooManyRequests])(
    'keeps the code step when a new code is refused with %s, and takes the old code',
    async (reason) => {
      const { bot, backend, calls, dialog, logger } = setup({
        dialog: ON_CODE_STEP,
        sendEmailCode: refused(429, reason),
      });
      await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
      const message = sentPayload(calls, 'sendMessage');
      expect(message?.text).toBe(TEXTS.resendRefused);
      expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
      expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
      expect(logger.warn).not.toHaveBeenCalled();

      await bot.handleUpdate(textUpdate(CODE));
      expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
    },
  );

  // refused before the letter (apps/backend/src/auth/routes.ts): the code already sent stays good
  it.each([
    [400, 'validation'],
    [401, 'unauthorized'],
    [404, 'not_found'],
    [415, undefined],
  ])(
    'keeps the code step on a %i %s before the letter, and takes the old code',
    async (status, reason) => {
      const { bot, backend, calls, dialog, logger } = setup({
        dialog: ON_CODE_STEP,
        sendEmailCode: refused(status, reason),
      });
      await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
      const message = sentPayload(calls, 'sendMessage');
      expect(message?.text).toBe(TEXTS.unavailable);
      expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
      expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ backendStatus: status }),
        'email code not sent',
      );

      await bot.handleUpdate(textUpdate(CODE));
      expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
    },
  );

  it('says the outcome is unknown and stays on the code step when the backend fails', async () => {
    const { bot, calls, dialog, logger } = setup({
      dialog: ON_CODE_STEP,
      sendEmailCode: unreachable(),
    });
    await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.codeSentUnknown(EMAIL));
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(logger.warn.mock.calls[0]?.[1]).toBe('email code not sent');
  });

  it('still sends the code when answering the query fails', async () => {
    const { bot, backend, calls, logger, apiErrors } = setup({ dialog: ON_CODE_STEP });
    apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: query is too old',
    });
    await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
    expect(backend.sendEmailCode).toHaveBeenCalledOnce();
    expect(sentTexts(calls)).toEqual([TEXTS.codeSent(EMAIL)]);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ method: 'answerCallbackQuery' });
  });
});

describe('text outside the dialog', () => {
  it('ignores text from a user who is not in a dialog', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(textUpdate(EMAIL));
    expect(calls).toEqual([]);
    expect(backend.sendEmailCode).not.toHaveBeenCalled();
    expect(backend.emailLogin).not.toHaveBeenCalled();
  });

  it('ignores a command in the middle of the dialog and keeps the step', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(textUpdate('/help'));
    expect(calls).toEqual([]);
    expect(backend.emailLogin).not.toHaveBeenCalled();
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
  });

  it('ignores text in a group, even from a user in a dialog', async () => {
    const { bot, backend, calls } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(textUpdate(CODE, 'group'));
    expect(calls).toEqual([]);
    expect(backend.emailLogin).not.toHaveBeenCalled();
  });

  // the owner's answer 3c: /start answers as usual and the dialog lives on
  it('answers /start in the middle of the dialog without ending it', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(startUpdate('/start'));
    expect(sentTexts(calls)).toEqual([TEXTS.welcome]);
    expect(backend.emailLogin).not.toHaveBeenCalled();
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);

    await bot.handleUpdate(textUpdate(CODE));
    expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
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
      // no handler runs in this test: the call under test is bot.api.sendMessage itself
      backend: {
        recordStart: vi.fn(() => Promise.reject(new Error('unused'))),
        startLogin: vi.fn(() => Promise.reject(new Error('unused'))),
        confirmLogin: vi.fn(() => Promise.reject(new Error('unused'))),
        sendEmailCode: vi.fn(() => Promise.reject(new Error('unused'))),
        emailLogin: vi.fn(() => Promise.reject(new Error('unused'))),
      },
      logger: fakeLogger(),
      botInfo: BOT_INFO,
      apiRoot,
      telegramApiTimeoutMs: 300,
    });

    const at = Date.now();
    const error = await rejectionOf(bot.api.sendMessage(1, 'x'));
    expect(error).toBeInstanceOf(HttpError);
    // the lower bound is what says the configured 300 ms ended the call; the upper bound
    // rules out grammY's 500 second default
    const elapsed = Date.now() - at;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2_000);
  });
});
