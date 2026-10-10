import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { BotError, GrammyError, HttpError, InputFile } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrokerBalanceUnavailableReason,
  confirmCallbackData,
  decimalStringSchema,
  type BotTextKey,
  defaultBotTextSource,
  NotificationLevel,
  OAuthErrorCode,
  plainTextOf,
  telegramHtmlProblems,
  TradeMode,
  UserErrorCode,
  UserStatus,
  type LinkedAccountView,
  type UserStartView,
  CONNECT_CALLBACK_DATA,
  DEMO_CALLBACK_DATA,
  COMMAND_RETRY_PATTERN,
  commandRetryCallbackData,
  MENU_CALLBACK_DATA,
  RETRY_COMMANDS,
  supportUrl,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import { ACCOUNT_CARD_PHOTO_PATH } from './assets';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import {
  LEVEL_CURRENT_CALLBACK_DATA,
  OAUTH_CALLBACK_DATA,
  RESEND_CALLBACK_DATA,
  createBot,
  levelCallbackData,
} from './bot';

import { LOGIN_DIALOG_TTL_MS, createLoginDialog, type LoginDialogState } from './login-dialog';
import { SETTINGS_CALLBACK_DATA } from './stake-picker';
import { INVITE_CALLBACK_DATA } from './keyboards';
import {
  ACCESS_VIEW,
  ACCOUNT_VIEW,
  REFERRAL_VIEW,
  BOT_INFO,
  CARD_MESSAGE_ID,
  CODE,
  CODE_SENT,
  CONFIRMED,
  EMAIL,
  LINK_ACTIVE,
  LINK_PENDING,
  LINK_REVOKED,
  PENDING_ACCOUNT_ID,
  TEXT_CARD_MESSAGE_ID,
  USER,
  captureApi,
  closeServer,
  callbackUpdate,
  channelPostUpdate,
  chatMemberUpdate,
  fakeLogger,
  inlineButtons,
  inlineRows,
  listen,
  messageAnswer,
  rejectionOf,
  sentPayload,
  startUpdate,
  textUpdate,
  accessView,
  accountView,
  brokerBalance,
  userView,
  stubSessionTracker,
  stubTracker,
  stubText,
  stubTextSource,
} from './testing';
import {
  accountCard,
  currentLevelLabel,
  helpText,
  LABELS,
  levelLabel,
  setBotTextSource,
  settingsText,
  statusCard,
  TEXTS,
  botCommands,
  userContextOf,
  type AccountCardInput,
} from './texts';

// a card line whose default holds none of its variables
const CARD_CONTEXT = { firstName: 'Ada', email: null };

// Every message and caption the bot sends is Telegram HTML: checked on every send any test in
// this file captures, not on one of them.
const capturedCalls: { method: string; payload: Record<string, unknown> }[][] = [];
afterEach(() => {
  const sends = capturedCalls
    .splice(0)
    .flat()
    .filter((call) =>
      ['sendMessage', 'sendVideo', 'sendPhoto', 'editMessageText'].includes(call.method),
    );
  for (const call of sends) expect(call.payload.parse_mode, call.method).toBe('HTML');
});

function setup(
  options: {
    user?: UserStartView;
    recordStart?: BackendClient['recordStart'];
    readAccount?: BackendClient['readAccount'];
    readReferral?: BackendClient['readReferral'];
    confirmLogin?: BackendClient['confirmLogin'];
    sendEmailCode?: BackendClient['sendEmailCode'];
    emailLogin?: BackendClient['emailLogin'];
    recordChatMember?: BackendClient['recordChatMember'];
    setNotificationLevel?: BackendClient['setNotificationLevel'];
    readTradingAccess?: BackendClient['readTradingAccess'];
    welcomeVideoFileId?: string;
    dialog?: LoginDialogState;
    now?: () => number;
  } = {},
) {
  const backend: BackendClient = {
    recordStart: options.recordStart ?? vi.fn(() => Promise.resolve(options.user ?? userView())),
    readAccount: options.readAccount ?? vi.fn(() => Promise.resolve(ACCOUNT_VIEW)),
    readReferral: options.readReferral ?? vi.fn(() => Promise.resolve(REFERRAL_VIEW)),
    confirmLogin: options.confirmLogin ?? vi.fn(() => Promise.resolve(CONFIRMED)),
    sendEmailCode: options.sendEmailCode ?? vi.fn(() => Promise.resolve(CODE_SENT)),
    emailLogin: options.emailLogin ?? vi.fn(() => Promise.resolve(CONFIRMED)),
    recordChatMember: options.recordChatMember ?? vi.fn(() => Promise.resolve({ recorded: true })),
    setNotificationLevel:
      options.setNotificationLevel ??
      vi.fn((_telegramUserId: string, level: NotificationLevel) =>
        Promise.resolve({ level, demoStake: null }),
      ),
    readTradingAccess: options.readTradingAccess ?? vi.fn(() => Promise.resolve(ACCESS_VIEW)),
    readPairs: vi.fn(() => Promise.reject(new Error('not used here'))),
    readSignals: vi.fn(() => Promise.reject(new Error('not used here'))),
    evaluateSignal: vi.fn(() => Promise.reject(new Error('not used here'))),
    createIntent: vi.fn(() => Promise.reject(new Error('not used here'))),
    readIntent: vi.fn(() => Promise.reject(new Error('not used here'))),
    startSession: vi.fn(() => Promise.reject(new Error('not used here'))),
    readSession: vi.fn(() => Promise.reject(new Error('not used here'))),
    stopSession: vi.fn(() => Promise.reject(new Error('not used here'))),
    claimSessionSummary: vi.fn(() => Promise.reject(new Error('not used here'))),
    stopSessions: vi.fn(() => Promise.reject(new Error('not used here'))),
    setDemoStake: vi.fn(() => Promise.reject(new Error('not used here'))),
    readBotTexts: vi.fn(() => Promise.reject(new Error('not used here'))),
  };
  const logger = fakeLogger();
  const dialog = createLoginDialog(options.now === undefined ? {} : { now: options.now });
  if (options.dialog !== undefined) dialog.set(USER.id, options.dialog);
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    token: '123456:AA-bot-token',
    backend,
    logger,
    botInfo: BOT_INFO,
    loginDialog: dialog,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.welcomeVideoFileId === undefined
      ? {}
      : { welcomeVideoFileId: options.welcomeVideoFileId }),
  });
  const { calls, apiErrors, answers } = captureApi(bot);
  answers.set('sendPhoto', messageAnswer(CARD_MESSAGE_ID));
  answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  capturedCalls.push(calls);
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

// the next steps (#350, docs/bot-navigation.md)
const MENU_BUTTONS = [{ text: LABELS.menuButton, callback_data: MENU_CALLBACK_DATA }];
const SUPPORT_BUTTONS = [{ text: LABELS.supportButton, url: supportUrl() }];
const DEMO_AND_MENU_BUTTONS = [
  { text: LABELS.demoButton, callback_data: DEMO_CALLBACK_DATA },
  ...MENU_BUTTONS,
];
const retryButtons = (data: string) => [
  { text: LABELS.demoRetryButton, callback_data: data },
  ...MENU_BUTTONS,
];

const CODE_STEP_BUTTONS = [
  { text: LABELS.resendButton, callback_data: RESEND_CALLBACK_DATA },
  { text: LABELS.changeEmailButton, callback_data: CONNECT_CALLBACK_DATA },
];

// what the user reads, in order: message texts and the account card's caption
const sentTexts = (calls: readonly { method: string; payload: Record<string, unknown> }[]) =>
  calls
    .filter((call) => call.method === 'sendMessage' || call.method === 'sendPhoto')
    .map((call) => call.payload.text ?? call.payload.caption);

// the card CONFIRMED produces for USER, with a field replaced where a scene needs it
const cardOf = (patch: Partial<AccountCardInput> = {}) =>
  accountCard({
    firstName: USER.first_name,
    email: CONFIRMED.account.email,
    grant: CONFIRMED.grant,
    ...patch,
  }).value;
const RECHECK_CARD = cardOf({ email: null, grant: null });

describe('/start', () => {
  it('greets a new user with the CTA and records the start without optional fields', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(startUpdate('/start'));

    expect(backend.recordStart).toHaveBeenCalledWith({
      telegramUserId: '4242',
      displayName: 'Ada Lovelace',
    });
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.welcome.value);
    // the email login only: the site sign-in is hidden since #314
    expect(inlineButtons(message)).toEqual([
      { text: LABELS.connectButton, callback_data: CONNECT_CALLBACK_DATA },
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
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.welcome.value);
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

  it('shows a blocked user no CTA but the support', async () => {
    const { bot, calls } = setup({ user: userView({ status: UserStatus.Blocked }) });
    await bot.handleUpdate(startUpdate('/start'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.blocked.value);
    expect(inlineButtons(message)).toEqual(SUPPORT_BUTTONS);
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
    expect(message?.text).toBe(TEXTS.confirmPrompt.value);
    expect(inlineButtons(message)).toEqual([
      { text: '✅ Подтвердить: ada@example.test', callback_data: `confirm:${PENDING_ACCOUNT_ID}` },
      { text: '✅ Подтвердить привязку', callback_data: `confirm:${other}` },
    ]);
  });

  // a label is not parsed by Telegram, so the broker's email goes into the button unescaped
  it('puts a broker email with markup characters into the button as it is', async () => {
    const email = 'a&b<c>_*@example.test';
    const { bot, calls } = setup({
      user: userView({ pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email }] }),
    });
    await bot.handleUpdate(startUpdate('/start'));
    expect(inlineButtons(sentPayload(calls, 'sendMessage'))).toEqual([
      { text: `✅ Подтвердить: ${email}`, callback_data: `confirm:${PENDING_ACCOUNT_ID}` },
    ]);
  });

  // a link the owner of this Telegram account did not make must not hide behind the status card
  it('puts a waiting link before the status card', async () => {
    const { bot, backend, calls } = setup({
      user: userView({
        hasActiveBrokerAccount: true,
        pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email: null }],
      }),
    });
    await bot.handleUpdate(startUpdate('/start'));
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.confirmPrompt.value);
    expect(backend.readTradingAccess).not.toHaveBeenCalled();
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
    expect(message?.text).toBe(TEXTS.blocked.value);
    expect(inlineButtons(message)).toEqual(SUPPORT_BUTTONS);
  });

  it('tells the user to come back later when the backend is unreachable', async () => {
    const { bot, calls, logger } = setup({
      recordStart: vi.fn(() => Promise.reject(new BackendError(BackendErrorCode.Unreachable))),
    });
    await bot.handleUpdate(startUpdate('/start'));
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'BackendError' } });
  });

  it('ignores /start outside a private chat', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(startUpdate('/start', 'group'));
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('the status card', () => {
  const ACTIVE = userView({ hasActiveBrokerAccount: true });
  // the demo, then the invite in a row of its own (#115)
  const CARD_ROWS = [
    [{ text: LABELS.demoButton, callback_data: DEMO_CALLBACK_DATA }],
    [{ text: LABELS.inviteButton, callback_data: INVITE_CALLBACK_DATA }],
  ];
  // in real mode the entry reads «🚀 Торговать» (#121)
  const REAL_CARD_ROWS = [
    [{ text: LABELS.tradeButton, callback_data: DEMO_CALLBACK_DATA }],
    [{ text: LABELS.inviteButton, callback_data: INVITE_CALLBACK_DATA }],
  ];
  // the line's default holds none of its variables
  const NO_SNAPSHOT = () =>
    TEXTS.statusNoSnapshot(userContextOf(USER.first_name, TradeMode.Demo, ACCESS_VIEW));
  const cardFor = (access = ACCESS_VIEW) =>
    statusCard({
      firstName: USER.first_name,
      mode: access.tradingMode,
      tokens: access.tokens,
      broker: access.broker,
      brokerUnavailable: access.brokerUnavailable,
      demoStake: access.demoStake,
    }).value;
  const PHOTO_REFUSED = {
    ok: false as const,
    error_code: 400,
    description: 'Bad Request: IMAGE_PROCESS_FAILED',
  };
  const home = async (options: Parameters<typeof setup>[0] = {}, text = '/start') => {
    const scene = setup({ user: ACTIVE, ...options });
    await scene.bot.handleUpdate(textUpdate(text));
    return scene;
  };

  it.each(['/start', '/menu'])(
    'sends %s the card as the photo with the demo button and pins it',
    async (text) => {
      const { backend, calls, logger } = await home({}, text);
      expect(calls.map((call) => call.method)).toEqual([
        'sendPhoto',
        'unpinAllChatMessages',
        'pinChatMessage',
      ]);
      const photo = sentPayload(calls, 'sendPhoto');
      expect(photo?.caption).toBe(cardFor());
      expect(photo?.photo).toBeInstanceOf(InputFile);
      expect(inlineRows(photo)).toEqual(CARD_ROWS);
      expect(sentPayload(calls, 'pinChatMessage')).toMatchObject({
        message_id: CARD_MESSAGE_ID,
        disable_notification: true,
      });
      expect(backend.readTradingAccess).toHaveBeenCalledWith('4242');
      expect(vi.mocked(backend.recordStart).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(backend.readTradingAccess).mock.invocationCallOrder[0] ?? 0,
      );
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  // #121: the header, the hint and the buttons follow the user's mode
  it('draws the card of a user in real mode with REAL, its hint and its buttons', async () => {
    const real = accessView({ tradingMode: TradeMode.Real });
    const { calls } = await home({ readTradingAccess: () => Promise.resolve(real) });
    const photo = sentPayload(calls, 'sendPhoto');
    expect(photo?.caption).toBe(cardFor(real));
    expect(photo?.caption).toContain('REAL');
    expect(photo?.caption).toContain(
      plainTextOf(TEXTS.statusHintReal(userContextOf(USER.first_name, TradeMode.Real, real))),
    );
    expect(photo?.caption).not.toContain(
      plainTextOf(TEXTS.statusHint(userContextOf(USER.first_name, TradeMode.Demo, real))),
    );
    expect(inlineRows(photo)).toEqual(REAL_CARD_ROWS);
  });

  it('sends the card as text with the same button and pins it when the photo is refused', async () => {
    const scene = setup({ user: ACTIVE });
    scene.apiErrors.set('sendPhoto', PHOTO_REFUSED);
    await scene.bot.handleUpdate(startUpdate('/start'));
    const { calls, logger } = scene;
    expect(calls.map((call) => call.method)).toEqual([
      'sendPhoto',
      'sendMessage',
      'unpinAllChatMessages',
      'pinChatMessage',
    ]);
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(cardFor());
    expect(inlineRows(message)).toEqual(CARD_ROWS);
    expect(sentPayload(calls, 'pinChatMessage')?.message_id).toBe(TEXT_CARD_MESSAGE_ID);
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'sendPhoto', telegramErrorCode: 400 }),
        'the status card photo was refused, sending the text instead',
      ],
    ]);
  });

  it('sends nothing more and pins nothing when the photo fails in transport', async () => {
    const scene = setup({ user: ACTIVE });
    scene.apiErrors.set(
      'sendPhoto',
      new HttpError("Network request for 'sendPhoto' failed!", new Error('socket hang up')),
    );
    await scene.bot.handleUpdate(startUpdate('/start'));
    expect(scene.calls.map((call) => call.method)).toEqual(['sendPhoto']);
    expect(scene.logger.error.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'sendPhoto' }),
        'the status card photo call failed in transport, sending nothing more',
      ],
    ]);
  });

  it('names the status card when the pin is refused', async () => {
    const scene = setup({ user: ACTIVE });
    scene.apiErrors.set('pinChatMessage', {
      ok: false as const,
      error_code: 400,
      description: 'Bad Request: not enough rights to manage pinned messages in the chat',
    });
    await scene.bot.handleUpdate(startUpdate('/start'));
    expect(scene.logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'pinChatMessage', telegramErrorCode: 400 }),
        'the status card was not pinned',
      ],
    ]);
  });

  it('shows the blocked text and no card when the access finds the user blocked', async () => {
    const { calls } = await home({
      readTradingAccess: vi.fn(() =>
        Promise.resolve(
          accessView({
            status: UserStatus.Blocked,
            broker: null,
            brokerUnavailable: BrokerBalanceUnavailableReason.UserBlocked,
          }),
        ),
      ),
    });
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.blocked.value);
    expect(inlineButtons(sentPayload(calls, 'sendMessage'))).toEqual(SUPPORT_BUTTONS);
  });

  it('shows the not-connected text and the connect button when no account is active any more', async () => {
    const { calls } = await home({
      readTradingAccess: vi.fn(() =>
        Promise.resolve(
          accessView({ broker: null, brokerUnavailable: BrokerBalanceUnavailableReason.NoAccount }),
        ),
      ),
    });
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.accountNone.value);
    expect(inlineButtons(message)).toEqual([
      { text: LABELS.connectButton, callback_data: CONNECT_CALLBACK_DATA },
    ]);
  });

  it.each([
    [BrokerBalanceUnavailableReason.AmbiguousAccount, TEXTS.statusAmbiguous],
    [BrokerBalanceUnavailableReason.BrokerUnavailable, NO_SNAPSHOT()],
    [BrokerBalanceUnavailableReason.Refreshing, NO_SNAPSHOT()],
  ])('shows $0.00 and the status line for %s', async (reason, line) => {
    const access = accessView({ broker: null, brokerUnavailable: reason });
    const { calls } = await home({ readTradingAccess: vi.fn(() => Promise.resolve(access)) });
    const caption = String(sentPayload(calls, 'sendPhoto')?.caption);
    expect(caption).toBe(cardFor(access));
    expect(plainTextOf(caption)).toMatch(/^💵 Реальный баланс: \$0\.00$/m);
    expect(plainTextOf(caption)).toContain(plainTextOf(line));
  });

  it('says how old a stale snapshot is', async () => {
    const access = accessView({
      broker: brokerBalance({ restSnapshotAgeSec: 200, balanceEventAgeSec: 130, fresh: false }),
    });
    const { calls } = await home({ readTradingAccess: vi.fn(() => Promise.resolve(access)) });
    expect(plainTextOf(String(sentPayload(calls, 'sendPhoto')?.caption))).toContain(
      plainTextOf(TEXTS.statusStale({ age: 130 })),
    );
  });

  it.each([
    [
      'unreachable',
      vi.fn(() => Promise.reject(new BackendError(BackendErrorCode.Unreachable))),
      {},
    ],
    [
      'answering 404 user_not_found',
      refused(404, UserErrorCode.UserNotFound),
      { backendStatus: 404, backendReason: UserErrorCode.UserNotFound },
    ],
    ['answering 500', refused(500), { backendStatus: 500 }],
  ])(
    'says the service is unavailable and warns when the access is %s',
    async (_label, read, fields) => {
      const { calls, logger } = await home({ readTradingAccess: read });
      expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
      expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
      expect(logger.warn.mock.calls).toEqual([
        [
          expect.objectContaining({
            err: expect.objectContaining({ name: 'BackendError' }),
            ...fields,
          }),
          'trading access not read',
        ],
      ]);
    },
  );
});

describe('/menu', () => {
  it('sends /users/start without a payload, even with trailing text', async () => {
    const { bot, backend } = setup();
    await bot.handleUpdate(textUpdate('/menu src_ab-CD9'));
    expect(backend.recordStart).toHaveBeenCalledWith({
      telegramUserId: '4242',
      displayName: 'Ada Lovelace',
    });
  });

  it('greets a user without an account with the welcome and its button', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(textUpdate('/menu'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.welcome.value);
    expect(inlineButtons(message)).toEqual([
      { text: LABELS.connectButton, callback_data: CONNECT_CALLBACK_DATA },
    ]);
    expect(backend.readTradingAccess).not.toHaveBeenCalled();
  });

  it('sends the welcome video when one is configured', async () => {
    const { bot, calls } = setup({ welcomeVideoFileId: 'video-file-id' });
    await bot.handleUpdate(textUpdate('/menu'));
    expect(sentPayload(calls, 'sendVideo')?.caption).toBe(TEXTS.welcome.value);
  });

  it('shows a blocked user the blocked text', async () => {
    const { bot, calls } = setup({ user: userView({ status: UserStatus.Blocked }) });
    await bot.handleUpdate(textUpdate('/menu'));
    expect(sentTexts(calls)).toEqual([TEXTS.blocked.value]);
  });

  it('puts a waiting link first', async () => {
    const { bot, calls } = setup({
      user: userView({
        hasActiveBrokerAccount: true,
        pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email: null }],
      }),
    });
    await bot.handleUpdate(textUpdate('/menu'));
    expect(sentTexts(calls)).toEqual([TEXTS.confirmPrompt.value]);
  });

  it('says the service is unavailable and names /menu when /users/start fails', async () => {
    const { bot, calls, logger } = setup({ recordStart: unreachable() });
    await bot.handleUpdate(textUpdate('/menu'));
    expect(sentTexts(calls)).toEqual([TEXTS.unavailable.value]);
    expect(logger.warn.mock.calls[0]?.[1]).toBe('/menu not recorded');
  });

  it.each(['group', 'supergroup'])('ignores the command in a %s', async (chatType) => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(textUpdate('/menu', chatType));
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('answers /menu in the middle of the dialog without ending it', async () => {
    const { bot, backend, calls, dialog } = setup({
      user: userView({ hasActiveBrokerAccount: true }),
      dialog: ON_CODE_STEP,
    });
    await bot.handleUpdate(textUpdate('/menu'));
    expect(calls.map((call) => call.method)[0]).toBe('sendPhoto');
    expect(backend.emailLogin).not.toHaveBeenCalled();
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);

    await bot.handleUpdate(textUpdate(CODE));
    expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
  });
});

describe('«🏠 В меню» (#350)', () => {
  it('answers the press and sends the status card as /menu does, without pinning it', async () => {
    const { bot, backend, calls } = setup({ user: userView({ hasActiveBrokerAccount: true }) });
    await bot.handleUpdate(callbackUpdate(MENU_CALLBACK_DATA));
    expect(backend.recordStart).toHaveBeenCalledWith({
      telegramUserId: '4242',
      displayName: 'Ada Lovelace',
    });
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendPhoto']);
    expect(inlineButtons(sentPayload(calls, 'sendPhoto'))).toEqual([
      { text: LABELS.demoButton, callback_data: DEMO_CALLBACK_DATA },
      { text: LABELS.inviteButton, callback_data: INVITE_CALLBACK_DATA },
    ]);
  });

  it('greets a user without an account with the welcome', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(callbackUpdate(MENU_CALLBACK_DATA));
    expect(sentTexts(calls)).toEqual([TEXTS.welcome.value]);
  });

  it('names the button in the warn line when /users/start fails', async () => {
    const { bot, logger } = setup({ recordStart: unreachable() });
    await bot.handleUpdate(callbackUpdate(MENU_CALLBACK_DATA));
    expect(logger.warn.mock.calls[0]?.[1]).toBe('the menu button not recorded');
  });

  it('ignores the press in a group', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(MENU_CALLBACK_DATA, 'group'));
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('«🔄 Повторить» of a command (#350)', () => {
  it('runs /account again', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(commandRetryCallbackData('account')));
    expect(backend.readAccount).toHaveBeenCalledWith('4242');
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(sentTexts(calls)).toEqual([TEXTS.accountNone.value]);
  });

  it('runs /settings again', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(commandRetryCallbackData('settings')));
    expect(backend.recordStart).toHaveBeenCalledTimes(1);
    expect(sentTexts(calls)).toEqual([
      settingsText(NotificationLevel.All, null, USER.first_name).value,
    ]);
  });

  it('keeps every command datum inside 64 bytes and matches no other command', () => {
    for (const command of RETRY_COMMANDS) {
      const data = commandRetryCallbackData(command);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(COMMAND_RETRY_PATTERN.exec(data)?.[1]).toBe(command);
    }
    expect(COMMAND_RETRY_PATTERN.test('cmd:start')).toBe(false);
    expect(Buffer.byteLength(MENU_CALLBACK_DATA)).toBe(4);
  });
});

// #350: every message the bot answers with carries its next step (docs/bot-navigation.md)
describe('the next step under every message', () => {
  const ACTIVE = userView({ hasActiveBrokerAccount: true });
  const HOME_RETRY = [{ text: LABELS.demoRetryButton, callback_data: MENU_CALLBACK_DATA }];
  const DEMO = [{ text: LABELS.demoButton, callback_data: DEMO_CALLBACK_DATA }];
  // the last message the scene sent, a photo's caption included
  const lastSent = (calls: readonly { method: string; payload: Record<string, unknown> }[]) =>
    calls.filter((call) => call.method === 'sendMessage' || call.method === 'sendPhoto').at(-1)
      ?.payload;

  it.each([
    [
      '/start failing offers the menu as its repeat',
      () => textUpdate('/start'),
      { recordStart: unreachable() },
      HOME_RETRY,
    ],
    [
      '/menu failing on the access read offers the menu as its repeat',
      () => textUpdate('/menu'),
      { user: ACTIVE, readTradingAccess: unreachable() },
      HOME_RETRY,
    ],
    [
      '/settings failing offers /settings again',
      () => textUpdate('/settings'),
      { recordStart: unreachable() },
      retryButtons(commandRetryCallbackData('settings')),
    ],
    [
      "the picker's way back failing offers the same read",
      () => callbackUpdate(SETTINGS_CALLBACK_DATA),
      { recordStart: unreachable() },
      retryButtons(SETTINGS_CALLBACK_DATA),
    ],
    [
      'a level not set offers the menu, not the write again',
      () => callbackUpdate(levelCallbackData(NotificationLevel.Off)),
      { setNotificationLevel: unreachable() },
      MENU_BUTTONS,
    ],
    [
      'a confirm refused offers the menu',
      () => callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID)),
      { confirmLogin: refused(409, OAuthErrorCode.AccountNotPending) },
      MENU_BUTTONS,
    ],
    [
      'a confirm refused for a blocked user offers the support',
      () => callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID)),
      { confirmLogin: refused(403, OAuthErrorCode.UserBlocked) },
      SUPPORT_BUTTONS,
    ],
    [
      'a confirm failing offers the menu',
      () => callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID)),
      { confirmLogin: unreachable() },
      MENU_BUTTONS,
    ],
    [
      'a confirm sends the account card with the demo',
      () => callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID)),
      {},
      DEMO,
    ],
    [
      'the resend without a code step offers the menu',
      () => callbackUpdate(RESEND_CALLBACK_DATA),
      {},
      MENU_BUTTONS,
    ],
    [
      'an address that is not one offers the menu',
      () => textUpdate('not an address'),
      { dialog: { step: 'email' } as LoginDialogState },
      MENU_BUTTONS,
    ],
    [
      'a code accepted sends the account card with the demo',
      () => textUpdate(CODE),
      { dialog: ON_CODE_STEP },
      DEMO,
    ],
    [
      'a recheck failing offers the menu',
      () => textUpdate(CODE),
      { dialog: ON_CODE_STEP, emailLogin: unreachable(), recordStart: unreachable() },
      MENU_BUTTONS,
    ],
    [
      'a recheck finding the user blocked offers the support',
      () => textUpdate(CODE),
      {
        dialog: ON_CODE_STEP,
        emailLogin: unreachable(),
        user: userView({ status: UserStatus.Blocked }),
      },
      SUPPORT_BUTTONS,
    ],
    [
      'a recheck finding an active account sends the card with the demo',
      () => textUpdate(CODE),
      { dialog: ON_CODE_STEP, emailLogin: unreachable(), user: ACTIVE },
      DEMO,
    ],
  ] as const)('%s', async (_label, update, options, buttons) => {
    const { bot, calls } = setup(options);
    await bot.handleUpdate(update());
    expect(inlineButtons(lastSent(calls))).toEqual(buttons);
  });
});

describe('/account', () => {
  const CONNECT_BUTTONS = [{ text: LABELS.connectButton, callback_data: CONNECT_CALLBACK_DATA }];
  const CONFIRM_BUTTON = {
    text: '✅ Подтвердить: new@example.test',
    callback_data: `confirm:${PENDING_ACCOUNT_ID}`,
  };
  const withAccounts = (...accounts: LinkedAccountView[]) =>
    vi.fn(() => Promise.resolve(accountView({ accounts })));
  const account = async (options: Parameters<typeof setup>[0] = {}, text = '/account') => {
    const scene = setup(options);
    await scene.bot.handleUpdate(textUpdate(text));
    const sends = scene.calls.filter((call) => call.method === 'sendMessage');
    return { ...scene, sends, message: sends[0]?.payload };
  };

  it('asks for the user’s own Telegram id and writes nothing', async () => {
    const { backend, sends } = await account();
    expect(backend.readAccount).toHaveBeenCalledWith('4242');
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
  });

  it('shows a user with no link the not-connected text and the connect button', async () => {
    const { message, logger } = await account({ readAccount: withAccounts() });
    expect(message?.text).toBe(TEXTS.accountNone.value);
    expect(inlineButtons(message)).toEqual(CONNECT_BUTTONS);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('answers a user the backend has no row for the same way, and logs nothing', async () => {
    const { message, logger } = await account({
      readAccount: refused(404, UserErrorCode.UserNotFound),
    });
    expect(message?.text).toBe(TEXTS.accountNone.value);
    expect(inlineButtons(message)).toEqual(CONNECT_BUTTONS);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('shows an active link with its address, the demo and the menu', async () => {
    const { message } = await account({ readAccount: withAccounts(LINK_ACTIVE) });
    expect(message?.text).toBe(`${TEXTS.accountConnected.value}\n\n✅ Подключён: ada@example.test`);
    expect(inlineButtons(message)).toEqual(DEMO_AND_MENU_BUTTONS);
  });

  it('offers to confirm a waiting link beside an active one, without the connect button', async () => {
    const { message } = await account({ readAccount: withAccounts(LINK_PENDING, LINK_ACTIVE) });
    expect(message?.text).toBe(
      `${TEXTS.accountConnected.value}\n\n⏳ Ждёт подтверждения: new@example.test\n✅ Подключён: ada@example.test`,
    );
    expect(inlineButtons(message)).toEqual([CONFIRM_BUTTON]);
  });

  it('shows a waiting link alone under the pending header, with confirm and connect button', async () => {
    const { message } = await account({ readAccount: withAccounts(LINK_PENDING) });
    expect(message?.text).toBe(
      `${TEXTS.accountPending.value}\n\n⏳ Ждёт подтверждения: new@example.test`,
    );
    expect(inlineButtons(message)).toEqual([CONFIRM_BUTTON, ...CONNECT_BUTTONS]);
  });

  it('shows revoked links under the revoked header, with the connect button', async () => {
    const { message } = await account({ readAccount: withAccounts(LINK_REVOKED) });
    expect(message?.text).toBe(
      `${TEXTS.accountRevoked.value}\n\n⚠️ Подключение отозвано: old@example.test`,
    );
    expect(inlineButtons(message)).toEqual(CONNECT_BUTTONS);
  });

  it('shows a revoked link beside an active one under the connected header, with the demo and the menu', async () => {
    const { message } = await account({ readAccount: withAccounts(LINK_ACTIVE, LINK_REVOKED) });
    expect(message?.text).toBe(
      `${TEXTS.accountConnected.value}\n\n✅ Подключён: ada@example.test\n⚠️ Подключение отозвано: old@example.test`,
    );
    expect(inlineButtons(message)).toEqual(DEMO_AND_MENU_BUTTONS);
  });

  it('says the address is unknown when the broker sent none', async () => {
    const { message } = await account({
      readAccount: withAccounts({ ...LINK_ACTIVE, email: null }, { ...LINK_PENDING, email: null }),
    });
    expect(message?.text).toBe(
      `${TEXTS.accountConnected.value}\n\n✅ Подключён: адрес неизвестен\n⏳ Ждёт подтверждения: адрес неизвестен`,
    );
    expect(inlineButtons(message)).toEqual([
      { text: '✅ Подтвердить привязку', callback_data: `confirm:${PENDING_ACCOUNT_ID}` },
    ]);
  });

  it('shows a blocked user only the blocked text, whatever links there are', async () => {
    const { message, sends } = await account({
      readAccount: vi.fn(() =>
        Promise.resolve(
          accountView({ status: UserStatus.Blocked, accounts: [LINK_PENDING, LINK_ACTIVE] }),
        ),
      ),
    });
    expect(sends).toHaveLength(1);
    expect(message?.text).toBe(TEXTS.blocked.value);
    expect(inlineButtons(message)).toEqual(SUPPORT_BUTTONS);
  });

  it.each([
    ['the backend is unreachable', new BackendError(BackendErrorCode.Unreachable), {}],
    [
      'the backend fails',
      new BackendError(BackendErrorCode.HttpStatus, { status: 500 }),
      { backendStatus: 500 },
    ],
    ['the body breaks the contract', new BackendError(BackendErrorCode.ContractViolation), {}],
    [
      'the backend has no such route',
      new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: 'not_found' }),
      { backendStatus: 404, backendReason: 'not_found' },
    ],
  ])('says the service is unavailable when %s, and warns', async (_label, error, fields) => {
    const { message, logger } = await account({ readAccount: vi.fn(() => Promise.reject(error)) });
    expect(message?.text).toBe(TEXTS.unavailable.value);
    expect(inlineButtons(message)).toEqual(retryButtons(commandRetryCallbackData('account')));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      err: { name: 'BackendError', code: error.code },
      ...fields,
    });
    expect(logger.warn.mock.calls[0]?.[1]).toBe('/account not read');
  });

  it('ignores /account in a group', async () => {
    const scene = setup();
    await scene.bot.handleUpdate(textUpdate('/account', 'group'));
    expect(scene.calls).toEqual([]);
    expect(scene.backend.readAccount).not.toHaveBeenCalled();
  });

  it('answers /account with trailing text as /account', async () => {
    const { backend, message } = await account({}, '/account please');
    expect(backend.readAccount).toHaveBeenCalledTimes(1);
    expect(message?.text).toBe(TEXTS.accountNone.value);
  });

  it('answers /account in the middle of the dialog without ending it', async () => {
    const { bot, backend, message, dialog } = await account({ dialog: ON_CODE_STEP });
    expect(message?.text).toBe(TEXTS.accountNone.value);
    expect(backend.emailLogin).not.toHaveBeenCalled();
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);

    await bot.handleUpdate(textUpdate(CODE));
    expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
  });
});

describe('the welcome video', () => {
  it('sends the welcome as a caption when a file id is configured', async () => {
    const { bot, calls } = setup({ welcomeVideoFileId: 'BAACAgIAAxkB' });
    await bot.handleUpdate(startUpdate('/start'));
    const video = sentPayload(calls, 'sendVideo');
    expect(video).toMatchObject({ video: 'BAACAgIAAxkB', caption: TEXTS.welcome.value });
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
    expect(message?.text).toBe(TEXTS.welcome.value);
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

  it('logs the transport failure of the text with its method and sends no second welcome', async () => {
    const { bot, calls, logger, apiErrors } = setup({ welcomeVideoFileId: 'not-a-file-id' });
    apiErrors.set('sendVideo', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: wrong file identifier/HTTP URL specified',
    });
    apiErrors.set(
      'sendMessage',
      new HttpError(
        "Network request for 'sendMessage' failed!",
        new Error('The operation was aborted due to timeout'),
      ),
    );
    const update = startUpdate('/start');

    await bot.handleUpdate(update);
    expect(calls.map((call) => call.method)).toEqual(['sendVideo', 'sendMessage']);
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'sendVideo', telegramErrorCode: 400 }),
        'the welcome video was refused, sending the text instead',
      ],
    ]);
    expect(logger.error.mock.calls).toEqual([
      [
        expect.objectContaining({
          err: expect.objectContaining({ name: 'HttpError' }),
          method: 'sendMessage',
          transportError: { name: 'Error' },
          updateId: update.update_id,
        }),
        'the text in place of the welcome video failed in transport, sending nothing more',
      ],
    ]);
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

// #314 hid the site sign-in; a button sent before that only loses its keyboard
describe('an old site sign-in button', () => {
  it('answers the query and removes the keyboard, sending nothing and calling no backend', async () => {
    const { bot, backend, calls, dialog, logger } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA));

    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
    ]);
    expect(sentPayload(calls, 'editMessageReplyMarkup')?.reply_markup).toBeUndefined();
    for (const method of Object.values(backend)) expect(method).not.toHaveBeenCalled();
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a refused removal at info and sends nothing', async () => {
    const { bot, calls, logger, apiErrors } = setup();
    apiErrors.set('editMessageReplyMarkup', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA));

    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
    ]);
    expect(logger.info.mock.calls.map((call) => call[1])).toEqual([
      'the keyboard of an old button was not removed',
    ]);
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ callbackData: OAUTH_CALLBACK_DATA });
  });

  it('ignores the callback outside a private chat', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(callbackUpdate(OAUTH_CALLBACK_DATA, 'group'));
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
    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'sendPhoto',
      'unpinAllChatMessages',
      'pinChatMessage',
    ]);
    const photo = sentPayload(calls, 'sendPhoto');
    expect(photo?.photo).toBeInstanceOf(InputFile);
    expect(photo?.caption).toBe(cardOf());
    expect(photo?.caption).toContain(': 7</blockquote>');
    expect(sentPayload(calls, 'pinChatMessage')).toMatchObject({
      message_id: CARD_MESSAGE_ID,
      disable_notification: true,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['not_partner_client' as const, TEXTS.cardBonusNotPartner(CARD_CONTEXT)],
    ['already_granted' as const, TEXTS.cardBonusAlready(CARD_CONTEXT)],
  ])('says why no pack was paid (%s)', async (reason, line) => {
    const grant = { granted: false as const, reason };
    const { bot, calls } = setup({
      confirmLogin: vi.fn(() => Promise.resolve({ ...CONFIRMED, grant })),
    });
    await bot.handleUpdate(update());
    const caption = sentPayload(calls, 'sendPhoto')?.caption;
    expect(caption).toBe(cardOf({ grant }));
    expect(caption).toContain(line.value);
  });

  // a link made through the site may carry no address
  it('leaves the address line out when the account has none', async () => {
    const { bot, calls } = setup({
      confirmLogin: vi.fn(() =>
        Promise.resolve({ ...CONFIRMED, account: { ...CONFIRMED.account, email: null } }),
      ),
    });
    await bot.handleUpdate(update());
    const caption = sentPayload(calls, 'sendPhoto')?.caption;
    expect(caption).toBe(cardOf({ email: null }));
    expect(caption).not.toContain('📧');
  });

  it.each([
    [404, OAuthErrorCode.BrokerAccountNotFound, TEXTS.confirmNotFound.value],
    [409, OAuthErrorCode.AccountNotPending, TEXTS.confirmAlreadyDone.value],
    [409, OAuthErrorCode.UserBlocked, TEXTS.blocked.value],
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
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
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
    expect(sentPayload(calls, 'sendPhoto')?.caption).toBe(cardOf());
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

describe('the account card', () => {
  const confirm = () => callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID));
  const PHOTO_REFUSED = {
    ok: false as const,
    error_code: 400,
    description: 'Bad Request: IMAGE_PROCESS_FAILED',
  };
  const PIN_REFUSED = {
    ok: false as const,
    error_code: 400,
    description: 'Bad Request: not enough rights to manage pinned messages in the chat',
  };

  it('sends the card as text and pins that message when Telegram refuses the photo', async () => {
    const { bot, calls, logger, apiErrors } = setup();
    apiErrors.set('sendPhoto', PHOTO_REFUSED);
    await bot.handleUpdate(confirm());

    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'sendPhoto',
      'sendMessage',
      'unpinAllChatMessages',
      'pinChatMessage',
    ]);
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(cardOf());
    expect(sentPayload(calls, 'pinChatMessage')).toMatchObject({
      message_id: TEXT_CARD_MESSAGE_ID,
      disable_notification: true,
    });
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'sendPhoto', telegramErrorCode: 400 }),
        'the account card photo was refused, sending the text instead',
      ],
    ]);
  });

  it('sends nothing more and pins nothing when the photo call fails in transport', async () => {
    const { bot, calls, logger, apiErrors, dialog } = setup({ dialog: ON_CODE_STEP });
    apiErrors.set(
      'sendPhoto',
      new HttpError(
        "Network request for 'sendPhoto' failed!",
        new Error('The operation was aborted due to timeout'),
      ),
    );
    await bot.handleUpdate(textUpdate(CODE));

    expect(calls.map((call) => call.method)).toEqual(['sendPhoto']);
    // the login is committed whatever became of the card
    expect(dialog.get(USER.id)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error.mock.calls).toEqual([
      [
        expect.objectContaining({
          err: expect.objectContaining({ name: 'HttpError' }),
          method: 'sendPhoto',
          transportError: { name: 'Error' },
        }),
        'the account card photo call failed in transport, sending nothing more',
      ],
    ]);
  });

  const TEXT_CARD_TIMED_OUT = new HttpError(
    "Network request for 'sendMessage' failed!",
    new Error('The operation was aborted due to timeout'),
  );
  const textCardFailure = (updateId: number) => [
    [
      expect.objectContaining({
        err: expect.objectContaining({ name: 'HttpError' }),
        method: 'sendMessage',
        transportError: { name: 'Error' },
        updateId,
      }),
      'the text in place of the account card photo failed in transport, sending nothing more',
    ],
  ];

  it('pins nothing and logs the method when the text card fails in transport', async () => {
    const { bot, calls, logger, apiErrors } = setup();
    apiErrors.set('sendPhoto', PHOTO_REFUSED);
    apiErrors.set('sendMessage', TEXT_CARD_TIMED_OUT);
    const update = confirm();
    await bot.handleUpdate(update);

    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'sendPhoto',
      'sendMessage',
    ]);
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'sendPhoto', telegramErrorCode: 400 }),
        'the account card photo was refused, sending the text instead',
      ],
    ]);
    expect(logger.error.mock.calls).toEqual(textCardFailure(update.update_id));
  });

  it('keeps the login committed when the text card fails in transport on the code step', async () => {
    const { bot, calls, logger, apiErrors, dialog } = setup({ dialog: ON_CODE_STEP });
    apiErrors.set('sendPhoto', PHOTO_REFUSED);
    apiErrors.set('sendMessage', TEXT_CARD_TIMED_OUT);
    const update = textUpdate(CODE);
    await bot.handleUpdate(update);

    expect(calls.map((call) => call.method)).toEqual(['sendPhoto', 'sendMessage']);
    // the login is committed whatever became of the card
    expect(dialog.get(USER.id)).toBeUndefined();
    expect(logger.error.mock.calls).toEqual(textCardFailure(update.update_id));
  });

  it('lets anything that is neither a refusal nor the transport reach bot.catch', async () => {
    const { bot, calls, logger, answers } = setup();
    answers.set('sendPhoto', () => {
      throw new TypeError('sentinel');
    });
    const thrown = await rejectionOf(bot.handleUpdate(confirm()));
    expect(thrown).toBeInstanceOf(BotError);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendPhoto']);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('lets a text card failing with anything but the transport reach bot.catch', async () => {
    const { bot, calls, logger, apiErrors, answers } = setup();
    apiErrors.set('sendPhoto', PHOTO_REFUSED);
    answers.set('sendMessage', () => {
      throw new TypeError('sentinel');
    });
    const thrown = await rejectionOf(bot.handleUpdate(confirm()));
    expect(thrown).toBeInstanceOf(BotError);
    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'sendPhoto',
      'sendMessage',
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  // two pinned cards are better than none
  it.each([
    ['refused', PIN_REFUSED],
    [
      'failing in transport',
      new HttpError(
        "Network request for 'unpinAllChatMessages' failed!",
        new Error('socket hang up'),
      ),
    ],
  ])('still pins the card with the old pins %s to clear', async (_label, failure) => {
    const { bot, calls, logger, apiErrors } = setup();
    apiErrors.set('unpinAllChatMessages', failure);
    await bot.handleUpdate(confirm());

    expect(calls.map((call) => call.method).slice(-2)).toEqual([
      'unpinAllChatMessages',
      'pinChatMessage',
    ]);
    expect(sentPayload(calls, 'pinChatMessage')?.message_id).toBe(CARD_MESSAGE_ID);
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'unpinAllChatMessages' }),
        'the old pins were not cleared',
      ],
    ]);
  });

  it('ends the dialog and sends nothing else when the pin is refused', async () => {
    const { bot, calls, logger, apiErrors, dialog } = setup({ dialog: ON_CODE_STEP });
    apiErrors.set('pinChatMessage', PIN_REFUSED);
    await bot.handleUpdate(textUpdate(CODE));

    expect(calls.map((call) => call.method)).toEqual([
      'sendPhoto',
      'unpinAllChatMessages',
      'pinChatMessage',
    ]);
    expect(dialog.get(USER.id)).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'pinChatMessage', telegramErrorCode: 400 }),
        'the account card was not pinned',
      ],
    ]);
  });

  it('shows a name made of markup characters as typed and greets a blank name without it', async () => {
    const named = setup({ dialog: ON_CODE_STEP });
    const hostile = { ...USER, first_name: '<b>&"Ada"</b>' };
    await named.bot.handleUpdate(textUpdate(CODE, 'private', hostile));
    const caption = sentPayload(named.calls, 'sendPhoto')?.caption;
    expect(caption).toBe(cardOf({ firstName: hostile.first_name }));
    expect(String(caption)).toContain('Привет, &lt;b&gt;&amp;&quot;Ada&quot;&lt;/b&gt;!');

    const blank = setup({ dialog: ON_CODE_STEP });
    await blank.bot.handleUpdate(textUpdate(CODE, 'private', { ...USER, first_name: '   ' }));
    expect(String(sentPayload(blank.calls, 'sendPhoto')?.caption)).toMatch(
      /^🎉 <b>Привет!<\/b>\n📧 /u,
    );
  });

  describe('through a real Bot API connection', () => {
    let server: Server | undefined;
    afterEach(async () => {
      const running = server;
      server = undefined;
      await closeServer(running);
    });

    const recordingServer = async () => {
      const bodies = new Map<string, Buffer>();
      const started = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const method = request.url?.split('/').pop() ?? '';
          bodies.set(method, Buffer.concat(chunks));
          const result =
            method === 'sendPhoto'
              ? { message_id: CARD_MESSAGE_ID, date: 1, chat: { id: USER.id, type: 'private' } }
              : true;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: true, result }));
        });
      });
      server = started;
      return { bodies, apiRoot: await listen(started) };
    };

    // Every other scene replaces the transport, so the file is never read there: this one lets
    // grammY upload it, which is what catches a wrong path in assets.ts.
    it('uploads the picture from assets.ts as the photo', async () => {
      const { bodies, apiRoot } = await recordingServer();
      const logger = fakeLogger();
      const bot = createBot({
        intentTracker: stubTracker(),
        sessionTracker: stubSessionTracker(),
        token: '123456:AA-bot-token',
        backend: {
          recordStart: vi.fn(() => Promise.reject(new Error('unused'))),
          readAccount: vi.fn(() => Promise.reject(new Error('unused'))),
          readReferral: vi.fn(() => Promise.reject(new Error('unused'))),
          confirmLogin: vi.fn(() => Promise.resolve(CONFIRMED)),
          sendEmailCode: vi.fn(() => Promise.reject(new Error('unused'))),
          emailLogin: vi.fn(() => Promise.reject(new Error('unused'))),
          recordChatMember: vi.fn(() => Promise.reject(new Error('unused'))),
          setNotificationLevel: vi.fn(() => Promise.reject(new Error('unused'))),
          readTradingAccess: vi.fn(() => Promise.reject(new Error('unused'))),
          readPairs: vi.fn(() => Promise.reject(new Error('unused'))),
          readSignals: vi.fn(() => Promise.reject(new Error('not used here'))),
          evaluateSignal: vi.fn(() => Promise.reject(new Error('unused'))),
          createIntent: vi.fn(() => Promise.reject(new Error('unused'))),
          readIntent: vi.fn(() => Promise.reject(new Error('unused'))),
          startSession: vi.fn(() => Promise.reject(new Error('unused'))),
          readSession: vi.fn(() => Promise.reject(new Error('unused'))),
          stopSession: vi.fn(() => Promise.reject(new Error('unused'))),
          claimSessionSummary: vi.fn(() => Promise.reject(new Error('unused'))),
          stopSessions: vi.fn(() => Promise.reject(new Error('unused'))),
          setDemoStake: vi.fn(() => Promise.reject(new Error('unused'))),
          readBotTexts: vi.fn(() => Promise.reject(new Error('unused'))),
        },
        logger,
        botInfo: BOT_INFO,
        apiRoot,
      });

      await bot.handleUpdate(confirm());

      expect([...bodies.keys()]).toEqual([
        'answerCallbackQuery',
        'sendPhoto',
        'unpinAllChatMessages',
        'pinChatMessage',
      ]);
      const picture = readFileSync(ACCOUNT_CARD_PHOTO_PATH);
      expect(bodies.get('sendPhoto')?.includes(picture)).toBe(true);
      expect(String(bodies.get('pinChatMessage'))).toContain(`"message_id":${CARD_MESSAGE_ID}`);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('uploads the same picture under the status card on /start (#24)', async () => {
      const { bodies, apiRoot } = await recordingServer();
      const logger = fakeLogger();
      const bot = createBot({
        intentTracker: stubTracker(),
        sessionTracker: stubSessionTracker(),
        token: '123456:AA-bot-token',
        backend: {
          recordStart: vi.fn(() => Promise.resolve(userView({ hasActiveBrokerAccount: true }))),
          readAccount: vi.fn(() => Promise.reject(new Error('unused'))),
          readReferral: vi.fn(() => Promise.reject(new Error('unused'))),
          confirmLogin: vi.fn(() => Promise.reject(new Error('unused'))),
          sendEmailCode: vi.fn(() => Promise.reject(new Error('unused'))),
          emailLogin: vi.fn(() => Promise.reject(new Error('unused'))),
          recordChatMember: vi.fn(() => Promise.reject(new Error('unused'))),
          setNotificationLevel: vi.fn(() => Promise.reject(new Error('unused'))),
          readTradingAccess: vi.fn(() => Promise.resolve(ACCESS_VIEW)),
          readPairs: vi.fn(() => Promise.reject(new Error('unused'))),
          readSignals: vi.fn(() => Promise.reject(new Error('not used here'))),
          evaluateSignal: vi.fn(() => Promise.reject(new Error('unused'))),
          createIntent: vi.fn(() => Promise.reject(new Error('unused'))),
          readIntent: vi.fn(() => Promise.reject(new Error('unused'))),
          startSession: vi.fn(() => Promise.reject(new Error('unused'))),
          readSession: vi.fn(() => Promise.reject(new Error('unused'))),
          stopSession: vi.fn(() => Promise.reject(new Error('unused'))),
          claimSessionSummary: vi.fn(() => Promise.reject(new Error('unused'))),
          stopSessions: vi.fn(() => Promise.reject(new Error('unused'))),
          setDemoStake: vi.fn(() => Promise.reject(new Error('unused'))),
          readBotTexts: vi.fn(() => Promise.reject(new Error('unused'))),
        },
        logger,
        botInfo: BOT_INFO,
        apiRoot,
      });

      await bot.handleUpdate(startUpdate('/start'));

      expect([...bodies.keys()]).toEqual(['sendPhoto', 'unpinAllChatMessages', 'pinChatMessage']);
      expect(bodies.get('sendPhoto')?.includes(readFileSync(ACCOUNT_CARD_PHOTO_PATH))).toBe(true);
      expect(String(bodies.get('pinChatMessage'))).toContain(`"message_id":${CARD_MESSAGE_ID}`);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});

describe('the connect button', () => {
  it('answers the query and asks for the address without calling the backend', async () => {
    const { bot, backend, calls, dialog } = setup();
    await bot.handleUpdate(callbackUpdate(CONNECT_CALLBACK_DATA));

    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.emailPrompt({ firstName: USER.first_name }).value);
    expect(inlineButtons(message)).toEqual(MENU_BUTTONS);
    expect(dialog.get(USER.id)).toEqual({ step: 'email' });
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
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(
      TEXTS.emailPrompt({ firstName: USER.first_name }).value,
    );
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ method: 'answerCallbackQuery' });
  });

  // «✏️ Изменить адрес» carries the same data
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
    expect(message?.text).toBe(TEXTS.codeSent({ email: EMAIL, firstName: USER.first_name }).value);
    expect(message?.text).toContain(EMAIL);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual({ step: 'code', email: EMAIL });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('answers text that is not an address at once, without calling the backend', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_EMAIL_STEP });
    await bot.handleUpdate(textUpdate('ada at example'));

    expect(backend.sendEmailCode).not.toHaveBeenCalled();
    expect(sentTexts(calls)).toEqual([TEXTS.emailInvalid.value]);
    expect(dialog.get(USER.id)).toEqual(ON_EMAIL_STEP);
  });

  it('stays on the address when the broker refuses it', async () => {
    const { bot, calls, dialog, logger } = setup({
      dialog: ON_EMAIL_STEP,
      sendEmailCode: refused(400, OAuthErrorCode.InvalidEmail),
    });
    await bot.handleUpdate(textUpdate(EMAIL));
    expect(sentTexts(calls)).toEqual([TEXTS.emailRefused.value]);
    expect(dialog.get(USER.id)).toEqual(ON_EMAIL_STEP);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [429, OAuthErrorCode.TooManyAttempts, TEXTS.tooManyCodeRequests.value],
    [409, OAuthErrorCode.UserBlocked, TEXTS.blocked.value],
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
    expect(message?.text).toBe(TEXTS.sendCodeBusy.value);
    expect(inlineButtons(message)).toEqual(MENU_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_EMAIL_STEP);
    expect(logger.warn).not.toHaveBeenCalled();

    await bot.handleUpdate(textUpdate(EMAIL));
    expect(sendEmailCode).toHaveBeenCalledTimes(2);
    expect(sentTexts(calls)).toEqual([
      TEXTS.sendCodeBusy.value,
      TEXTS.codeSent({ email: EMAIL, firstName: USER.first_name }).value,
    ]);
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
      expect(message?.text).toBe(TEXTS.unavailable.value);
      expect(inlineButtons(message)).toEqual(MENU_BUTTONS);
      expect(dialog.get(USER.id)).toEqual(ON_EMAIL_STEP);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ backendStatus: status }),
        'email code not sent',
      );

      await bot.handleUpdate(textUpdate(EMAIL));
      expect(sendEmailCode).toHaveBeenCalledTimes(2);
      expect(sentTexts(calls)).toEqual([
        TEXTS.unavailable.value,
        TEXTS.codeSent({ email: EMAIL, firstName: USER.first_name }).value,
      ]);
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
    expect(message?.text).toBe(
      TEXTS.codeSentUnknown({ email: EMAIL, firstName: USER.first_name }).value,
    );
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
    expect(message?.text).toBe(
      TEXTS.codeSentUnknown({ email: EMAIL, firstName: USER.first_name }).value,
    );
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
    expect(sentTexts(calls)).toEqual([cardOf()]);
    expect(calls.map((call) => call.method)).toEqual([
      'sendPhoto',
      'unpinAllChatMessages',
      'pinChatMessage',
    ]);
    expect(sentPayload(calls, 'pinChatMessage')?.message_id).toBe(CARD_MESSAGE_ID);
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
    expect(sentTexts(calls)).toEqual([
      cardOf({ grant: { granted: false, reason: 'not_partner_client' } }),
    ]);
  });

  // the broker's address for the account it issued the tokens for, which may be spelled
  // differently from what was typed
  it("shows the broker's address of the account, not the one typed", async () => {
    const account = { ...CONFIRMED.account, email: 'Ada.Lovelace@example.test' };
    const { bot, calls } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: vi.fn(() => Promise.resolve({ ...CONFIRMED, account })),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([cardOf({ email: account.email })]);
  });

  it('shows the address the code was redeemed for when the broker sent none', async () => {
    const { bot, calls } = setup({
      dialog: { step: 'code', email: 'typed@example.test' },
      emailLogin: vi.fn(() =>
        Promise.resolve({ ...CONFIRMED, account: { ...CONFIRMED.account, email: null } }),
      ),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([cardOf({ email: 'typed@example.test' })]);
  });

  it('answers a code the schema refuses at once, keeping the step', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(textUpdate('c'.repeat(65)));

    expect(backend.emailLogin).not.toHaveBeenCalled();
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.codeInvalid.value);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
  });

  it.each([
    [429, OAuthErrorCode.TooManyAttempts, TEXTS.tooManyCodeAttempts.value],
    [409, OAuthErrorCode.UserBlocked, TEXTS.blocked.value],
    [409, OAuthErrorCode.BrokerAccountTaken, TEXTS.accountTaken.value],
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
    expect(message?.text).toBe(TEXTS.loginBusy.value);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();

    await bot.handleUpdate(textUpdate(CODE));
    expect(emailLogin).toHaveBeenLastCalledWith('4242', EMAIL, CODE);
    expect(sentTexts(calls)).toEqual([TEXTS.loginBusy.value, cardOf()]);
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
    expect(message?.text).toBe(TEXTS.codeInvalid.value);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid code', refused(400, OAuthErrorCode.InvalidCode)],
    ['an unreachable backend', unreachable()],
    ['a broker outage', refused(502, OAuthErrorCode.BrokerUnavailable)],
  ])('sends the card after %s when an account is active', async (_label, emailLogin) => {
    const { bot, calls, dialog } = setup({
      dialog: ON_CODE_STEP,
      emailLogin,
      user: userView({ hasActiveBrokerAccount: true }),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([RECHECK_CARD]);
    expect(calls.map((call) => call.method)).toEqual([
      'sendPhoto',
      'unpinAllChatMessages',
      'pinChatMessage',
    ]);
    expect(sentPayload(calls, 'pinChatMessage')?.message_id).toBe(CARD_MESSAGE_ID);
    expect(dialog.get(USER.id)).toBeUndefined();
  });

  // The recheck knows that an account is active, not which one nor what was paid: a user who
  // already had one and typed a wrong code for another address lands here too (Plan Update,
  // #200), so neither the typed address nor a pack line may appear.
  it('puts neither the typed address nor a pack line on the card after a recheck', async () => {
    const { bot, calls } = setup({
      dialog: { step: 'code', email: 'other@example.test' },
      emailLogin: refused(400, OAuthErrorCode.InvalidCode),
      user: userView({ hasActiveBrokerAccount: true }),
    });
    await bot.handleUpdate(textUpdate(CODE));
    const caption = String(sentPayload(calls, 'sendPhoto')?.caption);
    expect(caption).toBe(RECHECK_CARD);
    expect(caption).not.toContain('other@example.test');
    expect(caption).not.toContain(CODE);
    expect(caption).not.toMatch(/📧|🎁|ℹ️/u);
  });

  it('shows the blocked text when the recheck finds the user blocked', async () => {
    const { bot, calls, dialog } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: unreachable(),
      user: userView({ status: UserStatus.Blocked }),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([TEXTS.blocked.value]);
    expect(dialog.get(USER.id)).toBeUndefined();
  });

  it('keeps the step and warns when the login fails and no account is active', async () => {
    const { bot, calls, dialog, logger } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: refused(500),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([TEXTS.unavailable.value]);
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
    expect(sentTexts(calls)).toEqual([TEXTS.unavailable.value]);
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
    expect(sentTexts(calls)).toEqual([TEXTS.codeInvalid.value]);
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

    expect(sentTexts(calls)).toEqual([TEXTS.unavailable.value, RECHECK_CARD]);
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
    expect(message?.text).toBe(TEXTS.codeSent({ email: EMAIL, firstName: USER.first_name }).value);
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
  });

  it('says the request no longer holds when there is no dialog', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
    expect(backend.sendEmailCode).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(sentTexts(calls)).toEqual([TEXTS.codeRequestStale.value]);
  });

  it('asks for the address when there is none yet', async () => {
    const { bot, backend, calls } = setup({ dialog: { step: 'email' } });
    await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
    expect(backend.sendEmailCode).not.toHaveBeenCalled();
    expect(sentTexts(calls)).toEqual([TEXTS.emailPrompt({ firstName: USER.first_name }).value]);
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
      expect(message?.text).toBe(TEXTS.resendRefused.value);
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
      expect(message?.text).toBe(TEXTS.unavailable.value);
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
    expect(message?.text).toBe(
      TEXTS.codeSentUnknown({ email: EMAIL, firstName: USER.first_name }).value,
    );
    expect(inlineButtons(message)).toEqual(CODE_STEP_BUTTONS);
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);
    expect(logger.warn.mock.calls[0]?.[1]).toBe('email code not sent');
  });

  // The address in a text is escaped once, on the wire, and reads back as typed. The address
  // schema refuses `<` and `&`, so a dialog started with one is the only way to put them in front
  // of the seam; that is the point here, not a path a user can take.
  const MARKUP_EMAIL = `a<b&c>_o'brien@example.test`;
  const ESCAPED_MARKUP_EMAIL = `a&lt;b&amp;c&gt;_o'brien@example.test`;

  it.each([
    ['codeSent', () => Promise.resolve(CODE_SENT)],
    ['codeSentUnknown', () => Promise.reject(new BackendError(BackendErrorCode.Unreachable))],
  ] as const)('escapes the address in %s on the wire', async (_key, sendEmailCode) => {
    const { bot, calls } = setup({
      dialog: { step: 'code', email: MARKUP_EMAIL },
      sendEmailCode: vi.fn(sendEmailCode),
    });
    await bot.handleUpdate(callbackUpdate(RESEND_CALLBACK_DATA));
    const text = String(sentPayload(calls, 'sendMessage')?.text);
    expect(text).toContain(ESCAPED_MARKUP_EMAIL);
    expect(plainTextOf(text)).toContain(MARKUP_EMAIL);
    expect(telegramHtmlProblems(text)).toEqual([]);
  });

  it('shows an address typed with an underscore, a quote and a plus as it is', async () => {
    const email = "ada_o'brien+x@example.test";
    const { bot, backend, calls } = setup({ dialog: { step: 'email' } });
    await bot.handleUpdate(textUpdate(email));
    expect(backend.sendEmailCode).toHaveBeenCalledWith('4242', email);
    const text = String(sentPayload(calls, 'sendMessage')?.text);
    expect(text).toBe(TEXTS.codeSent({ email: email, firstName: USER.first_name }).value);
    expect(plainTextOf(text)).toContain(email);
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
    expect(sentTexts(calls)).toEqual([
      TEXTS.codeSent({ email: EMAIL, firstName: USER.first_name }).value,
    ]);
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
    // a command nothing answers; the sample must not become a real command unnoticed
    expect(botCommands().map((entry) => entry.command)).not.toContain('unknown');
    const { bot, backend, calls, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(textUpdate('/unknown'));
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
    expect(sentTexts(calls)).toEqual([TEXTS.welcome.value]);
    expect(backend.emailLogin).not.toHaveBeenCalled();
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);

    await bot.handleUpdate(textUpdate(CODE));
    expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
  });
});

describe('a user blocking or unblocking the bot (#119)', () => {
  it.each(['kicked', 'member'] as const)(
    'forwards %s to the backend and sends nothing',
    async (status) => {
      const { bot, backend, calls, logger } = setup();
      await bot.handleUpdate(chatMemberUpdate(status));
      expect(backend.recordChatMember).toHaveBeenCalledTimes(1);
      expect(backend.recordChatMember).toHaveBeenCalledWith(String(USER.id), status);
      expect(calls).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each(['left', 'administrator'])('ignores a %s status', async (status) => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(chatMemberUpdate(status));
    expect(backend.recordChatMember).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('ignores the bot being removed from a group', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(chatMemberUpdate('kicked', { chatType: 'group' }));
    expect(backend.recordChatMember).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('logs a backend failure by its identity, sends nothing and does not throw', async () => {
    const { bot, calls, logger } = setup({
      recordChatMember: refused(500),
    });
    await expect(bot.handleUpdate(chatMemberUpdate('kicked'))).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]).toEqual([
      expect.objectContaining({
        err: { name: 'BackendError', code: BackendErrorCode.HttpStatus },
        backendStatus: 500,
        chatMember: 'kicked',
      }),
      'chat member status not recorded',
    ]);
  });
});

// #120
describe('/settings', () => {
  // the keyboard /settings shows when `current` is selected
  // the demo stake's picker under the levels (#297)
  const stakeRow = [{ text: LABELS.settingsStakeButton, callback_data: 'stk:o:s' }];
  const levelButtons = (current: NotificationLevel) =>
    Object.values(NotificationLevel).map((level) =>
      level === current
        ? { text: currentLevelLabel(level), callback_data: LEVEL_CURRENT_CALLBACK_DATA }
        : { text: levelLabel(level), callback_data: levelCallbackData(level) },
    );

  it.each(Object.values(NotificationLevel))(
    'shows the levels with %s marked, read through /users/start',
    async (notificationLevel) => {
      const { bot, backend, calls } = setup({ user: userView({ notificationLevel }) });
      await bot.handleUpdate(textUpdate('/settings'));

      expect(backend.recordStart).toHaveBeenCalledTimes(1);
      expect(backend.recordStart).toHaveBeenCalledWith({
        telegramUserId: '4242',
        displayName: 'Ada Lovelace',
      });
      const sends = calls.filter((call) => call.method === 'sendMessage');
      expect(sends).toHaveLength(1);
      expect(sends[0]?.payload.text).toBe(
        settingsText(notificationLevel, null, USER.first_name).value,
      );
      expect(
        (sends[0]?.payload.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard,
      ).toEqual([levelButtons(notificationLevel), stakeRow]);
    },
  );

  it('shows a blocked user the blocked text and the support', async () => {
    const { bot, calls } = setup({ user: userView({ status: UserStatus.Blocked }) });
    await bot.handleUpdate(textUpdate('/settings'));
    const message = sentPayload(calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.blocked.value);
    expect(inlineButtons(message)).toEqual(SUPPORT_BUTTONS);
  });

  it('says the service is unavailable when the backend cannot be reached', async () => {
    const { bot, calls, logger } = setup({ recordStart: unreachable() });
    await bot.handleUpdate(textUpdate('/settings'));
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(logger.warn.mock.calls[0]?.[1]).toBe('/settings not read');
  });

  it('ignores the command outside a private chat', async () => {
    const { bot, backend, calls } = setup();
    await bot.handleUpdate(textUpdate('/settings', 'group'));
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  describe('a level pressed', () => {
    const press = (level: string, chatType = 'private') =>
      callbackUpdate(
        level.startsWith('level:') ? level : levelCallbackData(level as never),
        chatType,
      );
    const QUERY_TOO_OLD = {
      ok: false as const,
      error_code: 400,
      description: 'Bad Request: query is too old',
    };
    const EDIT_REFUSED = {
      ok: false as const,
      error_code: 400,
      description: "Bad Request: message can't be edited",
    };

    it('sets the level and edits the pressed message in place', async () => {
      const { bot, backend, calls } = setup();
      const update = press(NotificationLevel.Off);
      await bot.handleUpdate(update);

      expect(backend.setNotificationLevel).toHaveBeenCalledWith('4242', NotificationLevel.Off);
      expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
      const edit = sentPayload(calls, 'editMessageText');
      const message = (update.callback_query as { message: { message_id: number } }).message;
      expect(edit).toMatchObject({
        chat_id: USER.id,
        message_id: message.message_id,
        text: settingsText(NotificationLevel.Off, null, USER.first_name).value,
        parse_mode: 'HTML',
      });
      expect((edit?.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard).toEqual([
        levelButtons(NotificationLevel.Off),
        stakeRow,
      ]);
    });

    it('renders the level the backend answered with', async () => {
      const { bot, calls } = setup({
        setNotificationLevel: vi.fn(() =>
          Promise.resolve({ level: NotificationLevel.Reduced, demoStake: null }),
        ),
      });
      await bot.handleUpdate(press(NotificationLevel.Off));
      expect(sentPayload(calls, 'editMessageText')?.text).toBe(
        settingsText(NotificationLevel.Reduced, null, USER.first_name).value,
      );
    });

    it('treats the not-modified refusal of a double press as done and sends nothing', async () => {
      const { bot, calls, logger, apiErrors } = setup();
      apiErrors.set('editMessageText', {
        ok: false,
        error_code: 400,
        description:
          'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
      });
      await bot.handleUpdate(press(NotificationLevel.Off));

      expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
        method: 'editMessageText',
        telegramErrorCode: 400,
      });
    });

    it.each([
      ["message can't be edited", EDIT_REFUSED],
      [
        'message to edit not found',
        {
          ok: false as const,
          error_code: 400,
          description: 'Bad Request: message to edit not found',
        },
      ],
      // a message whose text is a caption (a photo, the session card, #318)
      [
        'there is no text in the message to edit',
        {
          ok: false as const,
          error_code: 400,
          description: 'Bad Request: there is no text in the message to edit',
        },
      ],
    ])(
      'sends the same text and keyboard as a new message when the edit is refused: %s',
      async (_label, refusal) => {
        const { bot, calls, logger, apiErrors } = setup();
        apiErrors.set('editMessageText', refusal);
        await bot.handleUpdate(press(NotificationLevel.Reduced));

        const edit = sentPayload(calls, 'editMessageText');
        const message = sentPayload(calls, 'sendMessage');
        expect(message?.text).toBe(
          settingsText(NotificationLevel.Reduced, null, USER.first_name).value,
        );
        expect(message?.reply_markup).toEqual(edit?.reply_markup);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
          method: 'editMessageText',
          telegramErrorCode: 400,
        });
        expect(logger.error).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['a blocked user', 403, 'Forbidden: bot was blocked by the user'],
      ['an unparsable text', 400, "Bad Request: can't parse entities: unsupported start tag"],
      ['a non-400 refusal with the same words', 403, 'Forbidden: message is not modified'],
    ])(
      'lets an unlisted refusal of the edit (%s) reach bot.catch and sends nothing',
      async (_label, error_code, description) => {
        const { bot, calls, apiErrors } = setup();
        apiErrors.set('editMessageText', { ok: false, error_code, description });
        const thrown = await rejectionOf(bot.handleUpdate(press(NotificationLevel.Off)));
        expect(thrown).toBeInstanceOf(BotError);
        expect((thrown as BotError).error).toBeInstanceOf(GrammyError);
        expect(calls.map((call) => call.method)).not.toContain('sendMessage');
      },
    );

    it('sends nothing more when the edit fails in transport', async () => {
      const { bot, calls, logger, apiErrors } = setup();
      const update = press(NotificationLevel.Off);
      apiErrors.set(
        'editMessageText',
        new HttpError(
          "Network request for 'editMessageText' failed!",
          new Error('The operation was aborted due to timeout'),
        ),
      );
      await bot.handleUpdate(update);

      expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
        method: 'editMessageText',
        updateId: update.update_id,
      });
    });

    it('lets any other failure of the edit reach bot.catch', async () => {
      const { bot, calls, answers } = setup();
      answers.set('editMessageText', () => {
        throw new TypeError('sentinel');
      });
      const thrown = await rejectionOf(bot.handleUpdate(press(NotificationLevel.Off)));
      expect(thrown).toBeInstanceOf(BotError);
      expect((thrown as BotError).error).toBeInstanceOf(TypeError);
      expect(calls.map((call) => call.method)).not.toContain('sendMessage');
    });

    it('says the service is unavailable when the level is not set, and edits nothing', async () => {
      const { bot, calls, logger } = setup({
        setNotificationLevel: refused(500),
      });
      await bot.handleUpdate(press(NotificationLevel.Off));

      expect(sentPayload(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
      expect(calls.map((call) => call.method)).not.toContain('editMessageText');
      expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ backendStatus: 500 });
    });

    it('still edits the message when answering the query fails', async () => {
      const { bot, calls, logger, apiErrors } = setup();
      apiErrors.set('answerCallbackQuery', QUERY_TOO_OLD);
      await bot.handleUpdate(press(NotificationLevel.All));

      expect(sentPayload(calls, 'editMessageText')?.text).toBe(
        settingsText(NotificationLevel.All, null, USER.first_name).value,
      );
      expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ method: 'answerCallbackQuery' });
    });

    it('ignores the press outside a private chat', async () => {
      const { bot, backend, calls } = setup();
      await bot.handleUpdate(press(NotificationLevel.Off, 'group'));
      expect(backend.setNotificationLevel).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('does not answer data that names no level', async () => {
      const { bot, backend, calls } = setup();
      await bot.handleUpdate(callbackUpdate('level:daily'));
      expect(backend.setNotificationLevel).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('only stops the spinner when the selected level is pressed', async () => {
      const { bot, backend, calls } = setup();
      await bot.handleUpdate(callbackUpdate(LEVEL_CURRENT_CALLBACK_DATA));
      expect(backend.setNotificationLevel).not.toHaveBeenCalled();
      expect(backend.recordStart).not.toHaveBeenCalled();
      expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery']);
    });
  });
});

describe('/support', () => {
  it('sends the support text, its url button and the menu, without calling the backend', async () => {
    const { bot, backend, calls } = setup({ recordStart: unreachable() });
    await bot.handleUpdate(textUpdate('/support'));

    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(backend.readAccount).not.toHaveBeenCalled();
    const sends = calls.filter((call) => call.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.text).toBe(TEXTS.support.value);
    expect(inlineButtons(sends[0]?.payload)).toEqual([
      { text: LABELS.supportButton, url: 'https://t.me/dimmelya' },
      ...MENU_BUTTONS,
    ]);
  });

  it('ignores the command outside a private chat', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(textUpdate('/support', 'group'));
    expect(calls).toEqual([]);
  });
});

describe('/help', () => {
  const helpSends = async (text: string) => {
    const { bot, backend, calls } = setup({
      recordStart: unreachable(),
      readAccount: unreachable(),
    });
    await bot.handleUpdate(textUpdate(text));
    return { backend, sends: calls.filter((call) => call.method === 'sendMessage'), calls };
  };

  it('sends the help text once, with the menu and no backend call', async () => {
    const { backend, sends, calls } = await helpSends('/help');
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(sends[0]?.payload.text).toBe(helpText(botCommands()).value);
    expect(inlineButtons(sends[0]?.payload)).toEqual(MENU_BUTTONS);
    expect(backend.recordStart).not.toHaveBeenCalled();
    expect(backend.readAccount).not.toHaveBeenCalled();
  });

  // the acceptance criterion: a command in the menu but missing from the answer reddens this
  it('lists every command of the menu', async () => {
    const { sends } = await helpSends('/help');
    const lines = plainTextOf(String(sends[0]?.payload.text)).split('\n');
    for (const { command, description } of botCommands()) {
      expect(lines).toContain(`/${command} — ${description}`);
    }
  });

  it.each(['/help@binarius_bot', '/help please'])('answers %s the same way', async (text) => {
    const { sends } = await helpSends(text);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.text).toBe(helpText(botCommands()).value);
  });

  it.each(['group', 'supergroup'])('ignores the command in a %s', async (chatType) => {
    const { bot, calls } = setup();
    await bot.handleUpdate(textUpdate('/help', chatType));
    expect(calls).toEqual([]);
  });

  it('ignores the command posted in a channel', async () => {
    const { bot, calls } = setup();
    await bot.handleUpdate(channelPostUpdate('/help'));
    expect(calls).toEqual([]);
  });

  it('answers /help in the middle of the dialog without ending it', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(textUpdate('/help'));
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
    expect(backend.emailLogin).not.toHaveBeenCalled();
    expect(dialog.get(USER.id)).toEqual(ON_CODE_STEP);

    await bot.handleUpdate(textUpdate(CODE));
    expect(backend.emailLogin).toHaveBeenCalledWith('4242', EMAIL, CODE);
  });
});

describe('/stop (#122)', () => {
  it('B8 answers /stop in the middle of the dialog without ending it', async () => {
    const { bot, backend, calls, dialog } = setup({ dialog: ON_CODE_STEP });
    await bot.handleUpdate(textUpdate('/stop'));
    // the setup's stub refuses the stop, so the answer is the failure's: what matters is that the
    // command answered and the step stayed
    const sends = calls.filter((call) => call.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.payload.text).toBe(TEXTS.unavailable.value);
    expect(backend.stopSessions).toHaveBeenCalledWith('4242');
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
      intentTracker: stubTracker(),
      sessionTracker: stubSessionTracker(),
      token: '123456:AA-bot-token',
      // no handler runs in this test: the call under test is bot.api.sendMessage itself
      backend: {
        recordStart: vi.fn(() => Promise.reject(new Error('unused'))),
        readAccount: vi.fn(() => Promise.reject(new Error('unused'))),
        readReferral: vi.fn(() => Promise.reject(new Error('unused'))),
        confirmLogin: vi.fn(() => Promise.reject(new Error('unused'))),
        sendEmailCode: vi.fn(() => Promise.reject(new Error('unused'))),
        emailLogin: vi.fn(() => Promise.reject(new Error('unused'))),
        recordChatMember: vi.fn(() => Promise.reject(new Error('unused'))),
        setNotificationLevel: vi.fn(() => Promise.reject(new Error('unused'))),
        readTradingAccess: vi.fn(() => Promise.reject(new Error('unused'))),
        readPairs: vi.fn(() => Promise.reject(new Error('unused'))),
        readSignals: vi.fn(() => Promise.reject(new Error('not used here'))),
        evaluateSignal: vi.fn(() => Promise.reject(new Error('unused'))),
        createIntent: vi.fn(() => Promise.reject(new Error('unused'))),
        readIntent: vi.fn(() => Promise.reject(new Error('unused'))),
        startSession: vi.fn(() => Promise.reject(new Error('unused'))),
        readSession: vi.fn(() => Promise.reject(new Error('unused'))),
        stopSession: vi.fn(() => Promise.reject(new Error('unused'))),
        claimSessionSummary: vi.fn(() => Promise.reject(new Error('unused'))),
        stopSessions: vi.fn(() => Promise.reject(new Error('unused'))),
        setDemoStake: vi.fn(() => Promise.reject(new Error('unused'))),
        readBotTexts: vi.fn(() => Promise.reject(new Error('unused'))),
      },
      logger: fakeLogger(),
      botInfo: BOT_INFO,
      apiRoot,
      telegramApiTimeoutMs: 500,
    });

    const at = Date.now();
    const error = await rejectionOf(bot.api.sendMessage(1, 'x'));
    expect(error).toBeInstanceOf(HttpError);
    // the lower bound is what says the configured 500 ms ended the call; the upper bound
    // rules out grammY's 500 second default and a unit slip (500 ms read as 5 s)
    const elapsed = Date.now() - at;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(UNIT_WAIT_CEILING_MS);
  });
});

// Every text is read when it is sent, so a source swapped after the bot module loaded reaches
// each of these: one test per place that used to hold a text in a module constant (#240).
describe('the text source', () => {
  afterEach(() => setBotTextSource(defaultBotTextSource));

  it('answers /help from the source in place', async () => {
    setBotTextSource(stubTextSource('helpAbout'));
    const { bot, calls } = setup({ recordStart: unreachable(), readAccount: unreachable() });
    await bot.handleUpdate(textUpdate('/help'));
    expect(sentPayload(calls, 'sendMessage')?.text).toContain(stubText('helpAbout'));
  });

  it('H1 lists the command descriptions of the source in place (#301)', async () => {
    setBotTextSource(stubTextSource('startCommand'));
    const { bot, calls } = setup({ recordStart: unreachable(), readAccount: unreachable() });
    await bot.handleUpdate(textUpdate('/help'));
    const lines = plainTextOf(String(sentPayload(calls, 'sendMessage')?.text)).split('\n');
    expect(lines).toContain(`/start — ${stubText('startCommand')}`);
    expect(lines).toContain('/menu — Главное меню');
  });

  it('refuses a confirmation with the source in place', async () => {
    setBotTextSource(stubTextSource('confirmAlreadyDone'));
    const { bot, calls } = setup({ confirmLogin: refused(409, OAuthErrorCode.AccountNotPending) });
    await bot.handleUpdate(callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID)));
    expect(sentPayload(calls, 'sendMessage')?.text).toBe(stubText('confirmAlreadyDone'));
  });

  it('refuses an address with the source in place', async () => {
    setBotTextSource(stubTextSource('emailRefused'));
    const { bot, calls } = setup({
      dialog: { step: 'email' },
      sendEmailCode: refused(400, OAuthErrorCode.InvalidEmail),
    });
    await bot.handleUpdate(textUpdate(EMAIL));
    expect(sentTexts(calls)).toEqual([stubText('emailRefused')]);
  });

  it('refuses a code with the source in place', async () => {
    setBotTextSource(stubTextSource('tooManyCodeAttempts'));
    const { bot, calls } = setup({
      dialog: ON_CODE_STEP,
      emailLogin: refused(429, OAuthErrorCode.TooManyAttempts),
    });
    await bot.handleUpdate(textUpdate(CODE));
    expect(sentTexts(calls)).toEqual([stubText('tooManyCodeAttempts')]);
  });

  it('labels the /start buttons from the source in place', async () => {
    setBotTextSource(stubTextSource('connectButton'));
    const { bot, calls } = setup();
    await bot.handleUpdate(startUpdate('/start'));
    expect(inlineButtons(sentPayload(calls, 'sendMessage'))[0]?.text).toBe(
      stubText('connectButton'),
    );
  });
});

// #358: a text with several variables prints the user's values the handler already holds, and
// reads nothing more for them
describe('the variables of a text', () => {
  afterEach(() => setBotTextSource(defaultBotTextSource));
  const withTexts = (texts: Partial<Record<BotTextKey, string>>) => {
    setBotTextSource({ sourceOf: (key) => texts[key] ?? defaultBotTextSource.sourceOf(key) });
  };
  const backendCalls = (backend: BackendClient) =>
    Object.entries(backend)
      .filter(([, fn]) => vi.mocked(fn as () => unknown).mock.calls.length > 0)
      .map(([name]) => name);

  it('E1 puts the name, the tokens and the demo balance into the /menu card', async () => {
    withTexts({ statusTokens: '{firstName}, у тебя {tokens} токенов и {demoBalance} на демо' });
    const { bot, backend, calls } = setup({
      user: userView({ hasActiveBrokerAccount: true }),
      readTradingAccess: vi.fn(() =>
        Promise.resolve(accessView({ tokens: { balance: '15', reserved: '3', available: '12' } })),
      ),
    });
    await bot.handleUpdate(textUpdate('/menu'));
    expect(plainTextOf(String(sentPayload(calls, 'sendPhoto')?.caption))).toContain(
      'Ada, у тебя 12 токенов и $10 000.00 на демо',
    );
    expect(backendCalls(backend)).toEqual(['recordStart', 'readTradingAccess']);
  });

  it('E2 puts the name, the level and the stake into /settings', async () => {
    withTexts({ settings: '{firstName}: {level}, ставка {stake}' });
    const { bot, backend, calls } = setup({
      recordStart: vi.fn(() =>
        Promise.resolve(
          userView({
            notificationLevel: NotificationLevel.Reduced,
            demoStake: decimalStringSchema.parse('5'),
          }),
        ),
      ),
    });
    await bot.handleUpdate(textUpdate('/settings'));
    expect(plainTextOf(String(sentPayload(calls, 'sendMessage')?.text))).toMatch(
      /^Ada: 🔕 Реже, ставка \$5\.00\n/,
    );
    expect(backendCalls(backend)).toEqual(['recordStart']);
  });
});
