import { HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import {
  BOT_TEXT_SOURCES_EN,
  BotLanguage,
  BUY_CALLBACK_DATA,
  buyPackageCallbackData,
  CONNECT_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  STAR_PACKAGES,
  StarsErrorCode,
  StarsPreCheckoutRefusal,
  supportUrl,
  UserErrorCode,
  UserStatus,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import { runWithLanguage, type UserLanguages } from './language';
import {
  accountView,
  BOT_INFO,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  inlineRows,
  LINK_ACTIVE,
  LINK_PENDING,
  preCheckoutUpdate,
  sentPayload,
  STARS_INVOICE,
  STARS_PAYLOAD,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  successfulPaymentUpdate,
  textUpdate,
  USER,
  userLanguagesWith,
  type ApiCall,
} from './testing';
import {
  buyPackageLabel,
  LABELS,
  starsInvoiceDescription,
  starsInvoiceTitle,
  starsPayLabel,
  starsPreCheckoutError,
  TEXTS,
} from './texts';

// The Stars purchase in the bot (#117, docs/stars.md).
const MENU_ROW = [{ text: LABELS.menuButton, callback_data: MENU_CALLBACK_DATA }];
const CONNECT_ROWS = [[{ text: LABELS.connectButton, callback_data: CONNECT_CALLBACK_DATA }]];
const PACKAGE_ROWS = [
  ...STAR_PACKAGES.map((pack) => [
    { text: buyPackageLabel(pack), callback_data: buyPackageCallbackData(pack.code) },
  ]),
  MENU_ROW,
];
const SUPPORT_MENU_ROWS = [[{ text: LABELS.supportButton, url: supportUrl() }, ...MENU_ROW]];

function setup(patch: Partial<BackendClient> = {}, languages?: UserLanguages) {
  const logger = fakeLogger();
  const backend = fakeBackend({
    readAccount: vi.fn(() => Promise.resolve(accountView({ accounts: [LINK_ACTIVE] }))),
    createStarsInvoice: vi.fn(() => Promise.resolve(STARS_INVOICE)),
    checkStarsPreCheckout: vi.fn(() => Promise.resolve({ ok: true as const })),
    reportStarsPaid: vi.fn(() =>
      Promise.resolve({ outcome: 'credited' as const, tokens: '150', balance: '162' }),
    ),
    ...patch,
  });
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
    token: '123456:AA-bot-token',
    backend,
    logger,
    botInfo: BOT_INFO,
    ...(languages === undefined ? {} : { languages }),
  });
  return { bot, backend, logger, api: captureApi(bot) };
}

const refused = (status: number, reason: string) => () =>
  Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status, reason }));
const unreachable = () => Promise.reject(new BackendError(BackendErrorCode.Unreachable));

describe('/buy and «⭐ Купить»', () => {
  it.each([
    ['/buy', textUpdate('/buy')],
    ['the button', callbackUpdate(BUY_CALLBACK_DATA)],
  ])('%s shows a button per package, then the menu', async (_label, update) => {
    const { bot, api, backend } = setup();
    await bot.handleUpdate(update);
    expect(backend.readAccount).toHaveBeenCalledWith(String(USER.id));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.buyScreen.value);
    expect(inlineRows(message)).toEqual(PACKAGE_ROWS);
    expect(PACKAGE_ROWS.slice(0, 3).map((row) => row[0]!.text)).toEqual([
      '🪙 50 токенов — 100 ⭐',
      '🪙 150 токенов — 250 ⭐',
      '🪙 500 токенов — 750 ⭐',
    ]);
  });

  // S7: only a user with an active account sees the packages
  it.each([
    ['no link at all', () => Promise.resolve(accountView())],
    [
      'a link waiting for confirmation',
      () => Promise.resolve(accountView({ accounts: [LINK_PENDING] })),
    ],
    ['no users row yet', refused(404, UserErrorCode.UserNotFound)],
  ])('S7 offers the connect button, not the packages, to a user with %s', async (_label, read) => {
    const { bot, api } = setup({ readAccount: vi.fn(read) });
    await bot.handleUpdate(textUpdate('/buy'));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.buyNeedsAccount.value);
    expect(inlineRows(message)).toEqual(CONNECT_ROWS);
  });

  it('S7 keeps the purchase off the welcome', async () => {
    const { bot, api } = setup({
      recordStart: vi.fn(() =>
        Promise.resolve({
          telegramUserId: String(USER.id),
          status: UserStatus.Active,
          acquisitionSource: null,
          acquiredAt: null,
          hasActiveBrokerAccount: false,
          pendingBrokerAccounts: [],
          notificationLevel: 'all' as const,
          demoStake: null,
          realStake: null,
          language: 'ru' as const,
        }),
      ),
    });
    await bot.handleUpdate(textUpdate('/start'));
    const buttons = inlineRows(sentPayload(api.calls, 'sendMessage')).flat() as {
      callback_data?: string;
    }[];
    expect(buttons.some((button) => button.callback_data === BUY_CALLBACK_DATA)).toBe(false);
  });

  it('tells a blocked user to write to support', async () => {
    const { bot, api } = setup({
      readAccount: vi.fn(() =>
        Promise.resolve(accountView({ status: UserStatus.Blocked, accounts: [LINK_ACTIVE] })),
      ),
    });
    await bot.handleUpdate(textUpdate('/buy'));
    expect(sentPayload(api.calls, 'sendMessage')?.text).toBe(TEXTS.blocked.value);
  });

  it('offers the button again when the read fails', async () => {
    const { bot, api, logger } = setup({ readAccount: vi.fn(unreachable) });
    await bot.handleUpdate(textUpdate('/buy'));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.unavailable.value);
    expect(inlineRows(message)).toEqual([
      [{ text: LABELS.demoRetryButton, callback_data: BUY_CALLBACK_DATA }, ...MENU_ROW],
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('a package', () => {
  it('sends the invoice in Stars with the pay button first, then the menu', async () => {
    const { bot, api, backend } = setup();
    await bot.handleUpdate(callbackUpdate(buyPackageCallbackData('p150')));
    expect(backend.createStarsInvoice).toHaveBeenCalledWith(String(USER.id), 'p150');
    expect(api.calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendInvoice']);
    const invoice = sentPayload(api.calls, 'sendInvoice');
    expect(invoice).toMatchObject({
      title: starsInvoiceTitle(),
      description: starsInvoiceDescription('150'),
      payload: STARS_PAYLOAD,
      currency: 'XTR',
      prices: [{ label: starsInvoiceTitle(), amount: 250 }],
    });
    expect(invoice).not.toHaveProperty('provider_token');
    expect(invoice).not.toHaveProperty('start_parameter');
    expect(invoice).not.toHaveProperty('parse_mode');
    expect(inlineRows(invoice)).toEqual([[{ text: starsPayLabel(250), pay: true }], MENU_ROW]);
  });

  it.each([
    [
      StarsErrorCode.UserBlocked,
      TEXTS.blocked,
      [[{ text: LABELS.supportButton, url: supportUrl() }]],
    ],
    [StarsErrorCode.NoActiveAccount, TEXTS.buyNeedsAccount, CONNECT_ROWS],
    [StarsErrorCode.UserNotFound, TEXTS.buyNeedsAccount, CONNECT_ROWS],
    [StarsErrorCode.PackageUnknown, TEXTS.buyPackageGone, PACKAGE_ROWS],
  ] as const)('answers the refusal %s with its text and next step', async (reason, text, rows) => {
    const { bot, api, logger } = setup({ createStarsInvoice: vi.fn(refused(409, reason)) });
    await bot.handleUpdate(callbackUpdate(buyPackageCallbackData('p150')));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(text.value);
    expect(inlineRows(message)).toEqual(rows);
    expect(sentPayload(api.calls, 'sendInvoice')).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // the invoice is a read: pressing the same package again is the retry
  it('offers the same package again when the backend fails', async () => {
    const { bot, api } = setup({ createStarsInvoice: vi.fn(unreachable) });
    await bot.handleUpdate(callbackUpdate(buyPackageCallbackData('p150')));
    expect(inlineRows(sentPayload(api.calls, 'sendMessage'))).toEqual([
      [
        { text: LABELS.demoRetryButton, callback_data: buyPackageCallbackData('p150') },
        ...MENU_ROW,
      ],
    ]);
  });
});

// S4 on the bot's side: Telegram charges only after `ok: true`
describe('the pre-checkout query', () => {
  it('answers yes when the backend says yes, with what Telegram asked about', async () => {
    const { bot, api, backend } = setup();
    await bot.handleUpdate(preCheckoutUpdate());
    expect(backend.checkStarsPreCheckout).toHaveBeenCalledWith({
      telegramUserId: String(USER.id),
      invoicePayload: STARS_PAYLOAD,
      currency: 'XTR',
      totalAmount: 250,
    });
    expect(api.calls).toEqual([
      {
        method: 'answerPreCheckoutQuery',
        payload: expect.objectContaining({ ok: true }) as unknown,
      },
    ]);
    expect(sentPayload(api.calls, 'answerPreCheckoutQuery')).not.toHaveProperty('error_message');
  });

  it('refuses with the refusal text when the backend refuses', async () => {
    const { bot, api } = setup({
      checkStarsPreCheckout: vi.fn(() =>
        Promise.resolve({ ok: false as const, reason: StarsPreCheckoutRefusal.Amount }),
      ),
    });
    await bot.handleUpdate(preCheckoutUpdate());
    expect(sentPayload(api.calls, 'answerPreCheckoutQuery')).toMatchObject({
      ok: false,
      error_message: starsPreCheckoutError(false),
    });
  });

  it.each([
    ['times out', unreachable],
    [
      'answers outside the contract',
      () => Promise.reject(new BackendError(BackendErrorCode.ContractViolation)),
    ],
    ['answers 500', refused(500, 'internal')],
  ])('refuses, never says yes, when the backend %s', async (_label, check) => {
    const { bot, api, logger } = setup({ checkStarsPreCheckout: vi.fn(check) });
    await bot.handleUpdate(preCheckoutUpdate());
    expect(sentPayload(api.calls, 'answerPreCheckoutQuery')).toMatchObject({
      ok: false,
      error_message: starsPreCheckoutError(true),
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs an answer Telegram did not take, by the method only', async () => {
    const { bot, api, logger } = setup();
    api.apiErrors.set(
      'answerPreCheckoutQuery',
      new HttpError("Network request for 'answerPreCheckoutQuery' failed!", new Error('timeout')),
    );
    await bot.handleUpdate(preCheckoutUpdate());
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ method: 'answerPreCheckoutQuery' });
  });
});

describe('successful_payment', () => {
  it('reports the payment and tells the credit, with the menu', async () => {
    const { bot, api, backend } = setup();
    await bot.handleUpdate(successfulPaymentUpdate());
    expect(backend.reportStarsPaid).toHaveBeenCalledWith({
      telegramUserId: String(USER.id),
      telegramPaymentChargeId: 'charge-1',
      providerPaymentChargeId: '',
      invoicePayload: STARS_PAYLOAD,
      currency: 'XTR',
      totalAmount: 250,
      paidAt: 1_790_000_000,
    });
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(
      TEXTS.starsCredited({ purchasedTokens: '150', tokenBalance: '162' }).value,
    );
    expect(message?.text).toBe('⭐ Начислено 150 токенов. Баланс: 162');
    expect(inlineRows(message)).toEqual([MENU_ROW]);
  });

  it('tells a repeated delivery the same credit', async () => {
    const { bot, api } = setup({
      reportStarsPaid: vi.fn(() =>
        Promise.resolve({ outcome: 'already_credited' as const, tokens: '150', balance: '162' }),
      ),
    });
    await bot.handleUpdate(successfulPaymentUpdate());
    expect(sentPayload(api.calls, 'sendMessage')?.text).toBe(
      TEXTS.starsCredited({ purchasedTokens: '150', tokenBalance: '162' }).value,
    );
  });

  it.each([
    ['a held payment', vi.fn(() => Promise.resolve({ outcome: 'held' as const }))],
    ['a payload the backend cannot own', vi.fn(refused(409, StarsErrorCode.PayloadUnknown))],
  ])('sends %s to support', async (_label, report) => {
    const { bot, api } = setup({ reportStarsPaid: report });
    await bot.handleUpdate(successfulPaymentUpdate());
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.starsHeld.value);
    expect(inlineRows(message)).toEqual(SUPPORT_MENU_ROWS);
  });

  // the reconciler settles it: never a failure text, never a guess
  it.each([
    ['times out', unreachable],
    ['answers 500', refused(500, 'internal')],
    [
      'answers outside the contract',
      () => Promise.reject(new BackendError(BackendErrorCode.ContractViolation)),
    ],
  ])('promises the tokens within minutes when the backend %s', async (_label, report) => {
    const { bot, api, logger } = setup({ reportStarsPaid: vi.fn(report) });
    await bot.handleUpdate(successfulPaymentUpdate());
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.starsPending.value);
    expect(inlineRows(message)).toEqual([MENU_ROW]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('ignores a payment message outside a private chat', async () => {
    const { bot, api, backend } = setup();
    await bot.handleUpdate(successfulPaymentUpdate('group'));
    expect(backend.reportStarsPaid).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });
});

// #633: the purchase of a user whose language is English, through the language middleware
describe('the purchase in English (#633)', () => {
  const CYRILLIC = /[А-Яа-яЁё]/u;
  const english = (patch: Partial<BackendClient> = {}) =>
    setup(patch, userLanguagesWith(USER.id, BotLanguage.En));
  const en = <T>(run: () => T): T => runWithLanguage(BotLanguage.En, run);
  const textsOf = (calls: readonly ApiCall[]): string[] =>
    calls.flatMap((call) => [
      ...[
        call.payload.text,
        call.payload.title,
        call.payload.description,
        call.payload.error_message,
      ].filter((text): text is string => typeof text === 'string'),
      ...inlineRows(call.payload)
        .flat()
        .map((key) => (key as { text: string }).text),
    ]);
  const expectEnglish = (calls: readonly ApiCall[]) => {
    const texts = textsOf(calls);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).not.toMatch(CYRILLIC);
  };

  it('EN-9 /buy, the invoice, a failed pre-checkout and the credit are English', async () => {
    const screen = english();
    await screen.bot.handleUpdate(textUpdate('/buy'));
    const message = sentPayload(screen.api.calls, 'sendMessage');
    expect(message?.text).toBe(BOT_TEXT_SOURCES_EN.buyScreen);
    expect(inlineRows(message)[0]).toEqual([
      {
        text: en(() => buyPackageLabel(STAR_PACKAGES[0]!)),
        callback_data: buyPackageCallbackData(STAR_PACKAGES[0]!.code),
      },
    ]);
    expectEnglish(screen.api.calls);

    const pack = english();
    await pack.bot.handleUpdate(callbackUpdate(buyPackageCallbackData('p150')));
    const invoice = sentPayload(pack.api.calls, 'sendInvoice');
    expect(invoice).toMatchObject({
      title: BOT_TEXT_SOURCES_EN.starsInvoiceTitle,
      description: '150 tokens for auto-trading in Binarius',
      prices: [{ label: BOT_TEXT_SOURCES_EN.starsInvoiceTitle, amount: 250 }],
    });
    expect(inlineRows(invoice)[0]).toEqual([{ text: '⭐ Pay 250', pay: true }]);
    expectEnglish(pack.api.calls);

    const failed = english({ checkStarsPreCheckout: vi.fn(unreachable) });
    await failed.bot.handleUpdate(preCheckoutUpdate());
    expect(sentPayload(failed.api.calls, 'answerPreCheckoutQuery')).toMatchObject({
      ok: false,
      error_message: BOT_TEXT_SOURCES_EN.starsPreCheckoutFailed,
    });
    expectEnglish(failed.api.calls);

    const paid = english();
    await paid.bot.handleUpdate(successfulPaymentUpdate());
    expect(sentPayload(paid.api.calls, 'sendMessage')?.text).toBe(
      '⭐ Tokens credited: 150. Balance: 162',
    );
    expectEnglish(paid.api.calls);
  });
});
