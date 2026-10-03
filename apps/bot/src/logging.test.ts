import { EventEmitter } from 'node:events';
import pino from 'pino';
import { BotError, HttpError } from 'grammy';
import type { ApiError, Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmCallbackData,
  logOptions,
  NotificationLevel,
  UNNAMED_ERROR_MESSAGE,
  type LogLevel,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { OAUTH_CALLBACK_DATA, createBot, levelCallbackData } from './bot';
import { runBot, type PollingLoop } from './lifecycle';
import { createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  ACCOUNT_VIEW,
  BOT_INFO,
  CARD_MESSAGE_ID,
  CODE_SENT,
  CONFIRMED,
  LOGIN,
  PENDING_ACCOUNT_ID,
  USER,
  USER_VIEW,
  captureApi,
  callbackUpdate,
  messageAnswer,
  rejectionOf,
  startUpdate,
  textUpdate,
  type ApiAnswer,
  type ApiCall,
} from './testing';
import { settingsText, TEXTS } from './texts';

// What reaches the log is only provable by reading the log, so this suite runs the real pino
// configuration from index.ts into a sink and asserts on the lines themselves.

const TOKEN = '123456:AA-SECRET-TOKEN-0000000000000000';
const INTERNAL_TOKEN = 'SECRET-INTERNAL-BEARER-0000';

const sink = (level: LogLevel = 'info') => {
  const lines: string[] = [];
  const logger = pino(logOptions(level), { write: (line: string) => void lines.push(line) });
  return { lines, logger };
};

const parsed = (line = ''): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>;

const lineWith = (lines: readonly string[], msg: string): Record<string, unknown> | undefined =>
  lines.map(parsed).find((entry) => entry.msg === msg);

interface Scenario {
  update: Update;
  recordStart?: BackendClient['recordStart'];
  readAccount?: BackendClient['readAccount'];
  startLogin?: BackendClient['startLogin'];
  confirmLogin?: BackendClient['confirmLogin'];
  sendEmailCode?: BackendClient['sendEmailCode'];
  emailLogin?: BackendClient['emailLogin'];
  setNotificationLevel?: BackendClient['setNotificationLevel'];
  welcomeVideoFileId?: string;
  apiErrors?: readonly (readonly [string, ApiError | HttpError])[];
  answers?: readonly (readonly [string, ApiAnswer])[];
  dialog?: LoginDialogState;
  level?: LogLevel;
}

async function linesFrom(scenario: Scenario): Promise<{ lines: string[]; calls: ApiCall[] }> {
  const { lines, logger } = sink(scenario.level);
  const backend: BackendClient = {
    recordStart: scenario.recordStart ?? (() => Promise.resolve(USER_VIEW)),
    readAccount: scenario.readAccount ?? (() => Promise.resolve(ACCOUNT_VIEW)),
    startLogin: scenario.startLogin ?? (() => Promise.resolve(LOGIN)),
    confirmLogin: scenario.confirmLogin ?? (() => Promise.resolve(CONFIRMED)),
    sendEmailCode: scenario.sendEmailCode ?? (() => Promise.resolve(CODE_SENT)),
    emailLogin: scenario.emailLogin ?? (() => Promise.resolve(CONFIRMED)),
    recordChatMember: () => Promise.reject(new Error('not used by these scenes')),
    setNotificationLevel:
      scenario.setNotificationLevel ?? ((_telegramUserId, level) => Promise.resolve({ level })),
  };
  const loginDialog = createLoginDialog();
  if (scenario.dialog !== undefined) loginDialog.set(USER.id, scenario.dialog);
  const bot = createBot({
    token: TOKEN,
    backend,
    logger,
    botInfo: BOT_INFO,
    loginDialog,
    ...(scenario.welcomeVideoFileId === undefined
      ? {}
      : { welcomeVideoFileId: scenario.welcomeVideoFileId }),
  });
  const api = captureApi(bot);
  for (const [method, failure] of scenario.apiErrors ?? []) api.apiErrors.set(method, failure);
  for (const [method, answer] of scenario.answers ?? []) api.answers.set(method, answer);

  // handleUpdate rethrows the BotError instead of routing it: grammY only hands it to the
  // installed handler on the polling path (bot.js → handleUpdates). The handler under test is
  // the one createBot installed, reached the same way the loop reaches it, with the real error.
  const thrown = await rejectionOf(bot.handleUpdate(scenario.update));
  if (thrown !== undefined) {
    expect(thrown).toBeInstanceOf(BotError);
    await (bot as unknown as { errorHandler(error: BotError): Promise<void> }).errorHandler(
      thrown as BotError,
    );
  }
  return { lines, calls: api.calls };
}

describe('what the bot writes about a failed update', () => {
  it('names the error and the method, and carries nothing from the payload or the description', async () => {
    const update = startUpdate('/start');
    const { lines } = await linesFrom({
      update,
      apiErrors: [
        [
          'sendMessage',
          {
            ok: false,
            error_code: 403,
            description: 'Forbidden: SECRET-DESC bot was blocked by the user',
          },
        ],
      ],
    });
    const logged = parsed(lines[0]);

    expect(logged).toMatchObject({
      err: { name: 'GrammyError' },
      method: 'sendMessage',
      telegramErrorCode: 403,
      updateId: update.update_id,
      msg: 'update handler failed',
    });
    expect(logged.err).not.toHaveProperty('message');
    expect(logged.err).not.toHaveProperty('stack');
    expect(lines[0]).not.toContain('SECRET-DESC');
    // the payload of the refused call is the message we were sending
    expect(lines[0]).not.toContain(TEXTS.welcome.value.slice(0, 30));
    expect(lines[0]).not.toContain(TOKEN);
  });

  // the bot token sits in every Bot API URL, so a transport error that quotes the URL carries it
  it('keeps the token out of the line when the error message contains it', async () => {
    const update = startUpdate('/start');
    const { lines } = await linesFrom({
      update,
      apiErrors: [
        [
          'sendMessage',
          new HttpError(
            "Network request for 'sendMessage' failed!",
            new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`),
          ),
        ],
      ],
    });
    const logged = parsed(lines[0]);

    expect(logged).toMatchObject({
      err: { name: 'HttpError' },
      transportError: { name: 'Error' },
      updateId: update.update_id,
    });
    expect(logged.err).not.toHaveProperty('message');
    expect(logged.err).not.toHaveProperty('stack');
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain('SECRET-TOKEN');
  });
});

// The two branches that hold the internal bearer while they fail. The property was argued at
// the source before; these read it off the emitted line instead.
describe('what the bot writes about a failed backend call', () => {
  it('names the BackendError and its code without the cause’s message', async () => {
    const { lines } = await linesFrom({
      update: startUpdate('/start'),
      recordStart: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.Unreachable, {
            cause: new Error(
              `fetch to http://backend:3000/users/start with Bearer ${INTERNAL_TOKEN} failed`,
            ),
          }),
        ),
    });
    const logged = lineWith(lines, '/start not recorded');

    expect(logged).toMatchObject({
      err: { name: 'BackendError', code: BackendErrorCode.Unreachable },
      cause: { name: 'Error' },
    });
    expect(logged?.err).not.toHaveProperty('message');
    expect(logged?.cause).not.toHaveProperty('message');
    expect(lines.join('')).not.toContain(INTERNAL_TOKEN);
  });

  it('carries the backend status when the login cannot be started', async () => {
    const { lines } = await linesFrom({
      update: callbackUpdate(OAUTH_CALLBACK_DATA),
      startLogin: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 500,
            cause: new Error(`Bearer ${INTERNAL_TOKEN}`),
          }),
        ),
    });
    const logged = lineWith(lines, 'login not started');

    expect(logged).toMatchObject({
      err: { name: 'BackendError', code: BackendErrorCode.HttpStatus },
      backendStatus: 500,
    });
    expect(lines.join('')).not.toContain(INTERNAL_TOKEN);
  });

  it('names the error, its code, the status and the reason when /account cannot be read', async () => {
    const { lines } = await linesFrom({
      update: textUpdate('/account'),
      readAccount: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 404,
            reason: 'not_found',
            cause: new Error(`SECRET-ADDRESS@example.test with Bearer ${INTERNAL_TOKEN}`),
          }),
        ),
    });
    const logged = lineWith(lines, '/account not read');

    expect(logged).toMatchObject({
      err: { name: 'BackendError', code: BackendErrorCode.HttpStatus },
      cause: { name: 'Error' },
      backendStatus: 404,
      backendReason: 'not_found',
    });
    expect(lines.join('')).not.toContain(INTERNAL_TOKEN);
    expect(lines.join('')).not.toContain('SECRET-ADDRESS');
  });

  it('carries the backend status when the login cannot be confirmed', async () => {
    const { lines } = await linesFrom({
      update: callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID)),
      confirmLogin: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 500,
            cause: new Error(`Bearer ${INTERNAL_TOKEN}`),
          }),
        ),
    });
    const logged = lineWith(lines, 'login not confirmed');

    expect(logged).toMatchObject({
      err: { name: 'BackendError', code: BackendErrorCode.HttpStatus },
      backendStatus: 500,
    });
    expect(lines.join('')).not.toContain(INTERNAL_TOKEN);
  });
});

// Trace, the lowest level: a line production would filter out still must not carry the address
// or the code, so the level cannot be what hides one.
describe('what the bot writes during the email dialog', () => {
  const ADDRESS = 'SECRET-ADDRESS@example.test';
  const CODE = 'SECRET-CODE-123';
  const ON_CODE_STEP: LoginDialogState = { step: 'code', email: ADDRESS };
  // what a transport failure could quote: the request it was making
  const leakyCause = () =>
    new Error(
      `POST /auth/binodex/email/login {"email":"${ADDRESS}","code":"${CODE}"} with Bearer ${INTERNAL_TOKEN}`,
    );

  const expectNoSecrets = (lines: readonly string[]): void => {
    const all = lines.join('');
    expect(all).not.toContain(ADDRESS);
    expect(all).not.toContain('SECRET-ADDRESS');
    expect(all).not.toContain(CODE);
    expect(all).not.toContain(INTERNAL_TOKEN);
  };

  it('names an unreachable send-code by identity, without the address', async () => {
    const { lines, calls } = await linesFrom({
      level: 'trace',
      update: textUpdate(ADDRESS),
      dialog: { step: 'email' },
      sendEmailCode: () =>
        Promise.reject(new BackendError(BackendErrorCode.Unreachable, { cause: leakyCause() })),
    });

    expect(lineWith(lines, 'email code not sent')).toMatchObject({
      level: 40,
      err: { name: 'BackendError', code: BackendErrorCode.Unreachable },
      cause: { name: 'Error' },
    });
    expectNoSecrets(lines);
    // the reply does carry the address back to the user; the log, read above, does not
    expect(calls.find((call) => call.method === 'sendMessage')?.payload.text).toBe(
      TEXTS.codeSentUnknown(ADDRESS).value,
    );
  });

  it('names a send-code the backend refused by status, without the address', async () => {
    const { lines, calls } = await linesFrom({
      level: 'trace',
      update: textUpdate(ADDRESS),
      dialog: { step: 'email' },
      sendEmailCode: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 401,
            reason: 'unauthorized',
            cause: leakyCause(),
          }),
        ),
    });

    expect(lineWith(lines, 'email code not sent')).toMatchObject({
      level: 40,
      err: { name: 'BackendError', code: BackendErrorCode.HttpStatus },
      backendStatus: 401,
      backendReason: 'unauthorized',
    });
    expectNoSecrets(lines);
    // unlike the unreachable case above, the reply carries no address, so the check above is
    // against the cause the error drags along, not against the message sent back
    expect(calls.find((call) => call.method === 'sendMessage')?.payload.text).toBe(
      TEXTS.unavailable.value,
    );
  });

  it('names a failed login by status and reason, without the address or the code', async () => {
    const { lines } = await linesFrom({
      level: 'trace',
      update: textUpdate(CODE),
      dialog: ON_CODE_STEP,
      emailLogin: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 502,
            reason: 'broker_unavailable',
            cause: leakyCause(),
          }),
        ),
    });

    expect(lineWith(lines, 'email login failed')).toMatchObject({
      err: { name: 'BackendError', code: BackendErrorCode.HttpStatus },
      backendStatus: 502,
      backendReason: 'broker_unavailable',
    });
    expectNoSecrets(lines);
  });

  it('names a failed recheck after an invalid code, without the address or the code', async () => {
    const { lines } = await linesFrom({
      level: 'trace',
      update: textUpdate(CODE),
      dialog: ON_CODE_STEP,
      emailLogin: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, { status: 400, reason: 'invalid_code' }),
        ),
      recordStart: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, { status: 500, cause: leakyCause() }),
        ),
    });

    expect(lineWith(lines, 'email login outcome not rechecked')).toMatchObject({
      err: { name: 'BackendError', code: BackendErrorCode.HttpStatus },
      backendStatus: 500,
    });
    // the invalid code itself is the user's mistake, not something to warn about
    expect(lineWith(lines, 'email login failed')).toBeUndefined();
    expectNoSecrets(lines);
  });

  it('sends a failure of the reply on the code step to bot.catch by identity alone', async () => {
    const update = textUpdate(CODE);
    const { lines } = await linesFrom({
      level: 'trace',
      update,
      dialog: ON_CODE_STEP,
      answers: [
        [
          // the reply to a login that went through is the account card
          'sendPhoto',
          () => {
            throw new TypeError(`cannot send to ${ADDRESS} after ${CODE}`);
          },
        ],
      ],
    });

    expect(lineWith(lines, 'update handler failed')).toMatchObject({
      err: { name: 'TypeError' },
      updateId: update.update_id,
    });
    expectNoSecrets(lines);
  });
});

describe('what the bot writes about the welcome video', () => {
  it('names the method and the code of a refusal, and nothing of the description', async () => {
    const { lines, calls } = await linesFrom({
      update: startUpdate('/start'),
      welcomeVideoFileId: 'not-a-file-id',
      apiErrors: [
        [
          'sendVideo',
          {
            ok: false,
            error_code: 400,
            description: 'Bad Request: SECRET-DESC wrong file identifier',
          },
        ],
      ],
    });
    const logged = lineWith(lines, 'the welcome video was refused, sending the text instead');

    expect(logged).toMatchObject({
      err: { name: 'GrammyError' },
      method: 'sendVideo',
      telegramErrorCode: 400,
    });
    expect(lines.join('')).not.toContain('SECRET-DESC');
    expect(calls.map((call) => call.method)).toEqual(['sendVideo', 'sendMessage']);
  });

  it('reports a transport failure by identity and method, sends nothing more, drops the token', async () => {
    const update = startUpdate('/start');
    const { lines, calls } = await linesFrom({
      update,
      welcomeVideoFileId: 'BAACAgIAAxkB',
      apiErrors: [
        [
          'sendVideo',
          // what grammY throws when its own timeoutSeconds aborts the call or the socket
          // dies: no method of its own, and a wrapped error whose message quotes the URL the
          // token sits in
          new HttpError(
            "Network request for 'sendVideo' failed!",
            new Error(`request to https://api.telegram.org/bot${TOKEN}/sendVideo failed`),
          ),
        ],
      ],
    });
    const logged = lineWith(
      lines,
      'the welcome video call failed in transport, sending nothing more',
    );

    expect(logged).toMatchObject({
      err: { name: 'HttpError' },
      method: 'sendVideo',
      transportError: { name: 'Error' },
      updateId: update.update_id,
    });
    expect(logged).not.toHaveProperty('telegramErrorCode');
    expect(logged?.err).not.toHaveProperty('message');
    // it is answered where the method is known, so it never reaches bot.catch
    expect(lineWith(lines, 'update handler failed')).toBeUndefined();
    // delivery is unknown, so the text welcome is not sent after it
    expect(calls.map((call) => call.method)).toEqual(['sendVideo']);
    expect(lines.join('')).not.toContain(TOKEN);
    expect(lines.join('')).not.toContain('SECRET-TOKEN');
  });

  it('still sends anything else to bot.catch, without a method it does not know', async () => {
    const update = startUpdate('/start');
    const { lines, calls } = await linesFrom({
      update,
      welcomeVideoFileId: 'BAACAgIAAxkB',
      answers: [
        [
          'sendVideo',
          () => {
            throw new TypeError('sentinel');
          },
        ],
      ],
    });
    const logged = lineWith(lines, 'update handler failed');

    expect(logged).toMatchObject({ err: { name: 'TypeError' }, updateId: update.update_id });
    expect(logged).not.toHaveProperty('method');
    expect(logged).not.toHaveProperty('transportError');
    expect(
      lineWith(lines, 'the welcome video call failed in transport, sending nothing more'),
    ).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['sendVideo']);
  });
});

// #120: the /settings message is re-rendered by an edit after a press
describe('what the bot writes about the settings edit', () => {
  const update = () => callbackUpdate(levelCallbackData(NotificationLevel.Off));

  it('names the method and the code of a refused edit, and nothing of the text', async () => {
    const { lines, calls } = await linesFrom({
      update: update(),
      level: 'trace',
      apiErrors: [
        [
          'editMessageText',
          {
            ok: false,
            error_code: 400,
            description: 'Bad Request: message to edit not found SECRET-DESC',
          },
        ],
      ],
    });
    const logged = lineWith(lines, 'the settings message was not edited, sending it anew');

    expect(logged).toMatchObject({
      level: 40,
      err: { name: 'GrammyError' },
      method: 'editMessageText',
      telegramErrorCode: 400,
    });
    expect(lines.join('')).not.toContain('SECRET-DESC');
    expect(lines.join('')).not.toContain('Сейчас выбрано');
    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendMessage',
    ]);
    expect(calls[2]?.payload.text).toBe(settingsText(NotificationLevel.Off).value);
  });

  it('writes the not-modified refusal at info with the method and code, not its text', async () => {
    const { lines, calls } = await linesFrom({
      update: update(),
      level: 'trace',
      apiErrors: [
        [
          'editMessageText',
          {
            ok: false,
            error_code: 400,
            description: 'Bad Request: message is not modified SECRET-DESC',
          },
        ],
      ],
    });
    expect(lineWith(lines, 'the settings message already shows this level')).toMatchObject({
      level: 30,
      method: 'editMessageText',
      telegramErrorCode: 400,
    });
    expect(lines.join('')).not.toContain('SECRET-DESC');
    expect(lines.join('')).not.toContain('Сейчас выбрано');
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
  });

  it('reports a transport failure by identity and method, sends nothing more, drops the token', async () => {
    const pressed = update();
    const { lines, calls } = await linesFrom({
      update: pressed,
      level: 'trace',
      apiErrors: [
        [
          'editMessageText',
          new HttpError(
            "Network request for 'editMessageText' failed!",
            new Error(`request to https://api.telegram.org/bot${TOKEN}/editMessageText failed`),
          ),
        ],
      ],
    });
    const logged = lineWith(lines, 'the settings edit failed in transport, sending nothing more');

    expect(logged).toMatchObject({
      level: 50,
      err: { name: 'HttpError' },
      method: 'editMessageText',
      transportError: { name: 'Error' },
      updateId: pressed.update_id,
    });
    expect(logged?.err).not.toHaveProperty('message');
    expect(lineWith(lines, 'update handler failed')).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(lines.join('')).not.toContain(TOKEN);
    expect(lines.join('')).not.toContain('SECRET-TOKEN');
    expect(lines.join('')).not.toContain('Сейчас выбрано');
  });

  it('names a failed set by status, without the Telegram id', async () => {
    const { lines } = await linesFrom({
      update: update(),
      level: 'trace',
      setNotificationLevel: () =>
        Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 503 })),
    });
    expect(lineWith(lines, 'notification level not set')).toMatchObject({
      level: 40,
      err: { name: 'BackendError' },
      backendStatus: 503,
    });
    // time and pid are numbers that could hold 4242 by chance; every other field is searched
    const fields = lines.map((line) =>
      JSON.stringify({ ...parsed(line), time: undefined, pid: undefined }),
    );
    expect(fields.join('')).not.toContain(String(USER.id));
  });
});

// The card's caption holds the account's address and the update holds the code typed, so every
// line about the card is read at trace and searched for both.
describe('what the bot writes about the account card', () => {
  const ADDRESS = 'SECRET-ADDRESS@example.test';
  const CODE = 'SECRET-CODE-123';
  const onCodeStep = (scene: Pick<Scenario, 'apiErrors'>): Scenario => ({
    update: textUpdate(CODE),
    dialog: { step: 'code', email: ADDRESS },
    emailLogin: () =>
      Promise.resolve({ ...CONFIRMED, account: { ...CONFIRMED.account, email: ADDRESS } }),
    answers: [
      ['sendPhoto', messageAnswer(CARD_MESSAGE_ID)],
      ['sendMessage', messageAnswer(CARD_MESSAGE_ID)],
    ],
    level: 'trace',
    ...scene,
  });
  const refusal = (description: string): ApiError => ({
    ok: false,
    error_code: 400,
    description: `Bad Request: SECRET-DESC ${description}`,
  });

  const expectNoSecrets = (lines: readonly string[]): void => {
    const all = lines.join('');
    expect(all).not.toContain('SECRET-ADDRESS');
    expect(all).not.toContain(CODE);
    expect(all).not.toContain('SECRET-DESC');
    expect(all).not.toContain('SECRET-TOKEN');
  };

  it('names the method and the code of a refused photo, and nothing of the caption', async () => {
    const { lines, calls } = await linesFrom(
      onCodeStep({ apiErrors: [['sendPhoto', refusal('IMAGE_PROCESS_FAILED')]] }),
    );
    expect(
      lineWith(lines, 'the account card photo was refused, sending the text instead'),
    ).toMatchObject({ err: { name: 'GrammyError' }, method: 'sendPhoto', telegramErrorCode: 400 });
    expect(calls.map((call) => call.method)).toEqual([
      'sendPhoto',
      'sendMessage',
      'unpinAllChatMessages',
      'pinChatMessage',
    ]);
    expectNoSecrets(lines);
  });

  it('reports a transport failure of the photo by identity and method, and drops the token', async () => {
    const update = textUpdate(CODE);
    const { lines, calls } = await linesFrom({
      ...onCodeStep({
        apiErrors: [
          [
            'sendPhoto',
            new HttpError(
              "Network request for 'sendPhoto' failed!",
              new Error(`request to https://api.telegram.org/bot${TOKEN}/sendPhoto failed`),
            ),
          ],
        ],
      }),
      update,
    });
    const logged = lineWith(
      lines,
      'the account card call failed in transport, sending nothing more',
    );
    expect(logged).toMatchObject({
      level: 50,
      err: { name: 'HttpError' },
      method: 'sendPhoto',
      transportError: { name: 'Error' },
      updateId: update.update_id,
    });
    expect(logged?.err).not.toHaveProperty('message');
    expect(lineWith(lines, 'update handler failed')).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['sendPhoto']);
    expectNoSecrets(lines);
  });

  it.each([
    ['unpinAllChatMessages', 'the old pins were not cleared'],
    ['pinChatMessage', 'the account card was not pinned'],
  ])('names a refused %s by method and code at warn', async (method, msg) => {
    const { lines } = await linesFrom(
      onCodeStep({ apiErrors: [[method, refusal('not enough rights')]] }),
    );
    expect(lineWith(lines, msg)).toMatchObject({
      level: 40,
      err: { name: 'GrammyError' },
      method,
      telegramErrorCode: 400,
    });
    expectNoSecrets(lines);
  });
});

describe('what the bot writes when a drain step fails', () => {
  it('names the step and the error, and keeps the token out of the line', async () => {
    const { lines, logger } = sink();
    const signalSource = new EventEmitter();
    const bot: PollingLoop = {
      start: () => Promise.resolve(),
      stop: () =>
        Promise.reject(
          new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`),
        ),
      api: {
        setMyCommands: () => Promise.resolve(true as const),
        setMyDescription: () => Promise.resolve(true as const),
        setMyShortDescription: () => Promise.resolve(true as const),
      },
    };
    runBot({
      bot,
      logger,
      exit: vi.fn(),
      signals: ['SIGTERM'],
      signalSource,
    });
    signalSource.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const logged = lineWith(lines, 'shutdown: bot.stop() failed');
    expect(logged).toMatchObject({ err: { name: 'Error' } });
    expect(logged?.err).not.toHaveProperty('message');
    expect(lines.join('')).not.toContain(TOKEN);
    expect(lines.join('')).not.toContain('SECRET-TOKEN');
  });
});

// The transport path — grammY surfacing the HttpError out of a profile call inside onStart — is
// read off the library by the lifecycle scenes; what reaches the log does not depend on it, so
// this runs the same fake PollingLoop as the drain test above.
describe('what the bot writes when a part of the profile is not registered', () => {
  const resolved = () => Promise.resolve(true as const);
  const leaking = (method: string) => () =>
    Promise.reject(
      new HttpError(
        `Network request for '${method}' failed!`,
        new Error(`request to https://api.telegram.org/bot${TOKEN}/${method} failed`),
      ),
    );

  it.each([
    ['setMyCommands', 'bot commands not registered'],
    ['setMyDescription', 'bot description not registered'],
    ['setMyShortDescription', 'bot short description not registered'],
  ] as const)(
    'names the error and the method at warn when %s fails, and keeps the token out of the line',
    async (method, message) => {
      const { lines, logger } = sink();
      const bot: PollingLoop = {
        start: async (options) => {
          await options.onStart?.(BOT_INFO);
        },
        stop: () => Promise.resolve(),
        api: {
          setMyCommands: resolved,
          setMyDescription: resolved,
          setMyShortDescription: resolved,
          [method]: leaking(method),
        },
      };
      runBot({
        bot,
        logger,
        exit: vi.fn(),
        signals: ['SIGTERM'],
        signalSource: new EventEmitter(),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const logged = lineWith(lines, message);
      expect(logged).toMatchObject({
        level: 40,
        err: { name: 'HttpError' },
        method,
        transportError: { name: 'Error' },
      });
      expect(logged?.err).not.toHaveProperty('message');
      expect(logged).not.toHaveProperty('description');
      expect(logged).not.toHaveProperty('payload');
      expect(lines.join('')).not.toContain(TOKEN);
      expect(lines.join('')).not.toContain('SECRET-TOKEN');
      expect(lineWith(lines, 'long polling stopped with an error')).toBeUndefined();
    },
  );
});

// the logger's own whitelist, for an error that reaches it positionally: pino would otherwise
// write the error whole and copy its message into `msg`
describe('what the bot writes about an error logged positionally', () => {
  it('names the error, writes a fixed message, and keeps the token out of the line', () => {
    const { lines, logger } = sink();
    const failure = Object.assign(
      new Error(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`),
      { code: 'ECONNRESET' },
    );
    logger.error(failure);

    expect(parsed(lines[0])).toMatchObject({
      msg: UNNAMED_ERROR_MESSAGE,
      err: { name: 'Error', code: 'ECONNRESET' },
    });
    expect(parsed(lines[0]).err).toStrictEqual({ name: 'Error', code: 'ECONNRESET' });
    expect(lines.join('')).not.toContain('SECRET-TOKEN');
  });
});
