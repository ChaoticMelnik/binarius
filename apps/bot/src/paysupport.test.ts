import { describe, expect, it, vi } from 'vitest';
import {
  BOT_TEXT_SOURCES_EN,
  BotLanguage,
  MENU_CALLBACK_DATA,
  PAYSUPPORT_LIST_CALLBACK,
  paysupportRefundCallbackData,
  StarsRefundErrorCode,
  supportUrl,
  type StarPaymentView,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import { runWithLanguage, type UserLanguages } from './language';
import {
  BOT_INFO,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  inlineRows,
  inlineStyles,
  sentPayload,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  USER,
  userLanguagesWith,
  type ApiCall,
  stubShownSignals,
} from './testing';
import { LABELS, paysupportListLabel, paysupportRefundLabel, paysupportText, TEXTS } from './texts';

// /paysupport in the bot (#118, docs/stars.md → /paysupport).
const MENU_ROW = [{ text: LABELS.menuButton, callback_data: MENU_CALLBACK_DATA }];
const SUPPORT_ROW = [{ text: LABELS.supportButton, url: supportUrl() }];
// #475: the way back and the menu in one row
const BACK_TO_LIST_ROWS = [
  [{ text: paysupportListLabel(), callback_data: PAYSUPPORT_LIST_CALLBACK }, ...MENU_ROW],
];

const payment = (n: number, patch: Partial<StarPaymentView> = {}): StarPaymentView => ({
  id: `6c1f6a2e-3b7d-4c55-9a51-2f6b8e7d9a1${String(n)}`,
  paidAt: 1_790_000_000 - n * 86_400,
  packageCode: 'p50',
  totalAmount: 100,
  status: 'paid',
  requested: false,
  ...patch,
});
const PAYMENTS = [
  payment(0),
  payment(1, { status: 'held' }),
  payment(2, { requested: true }),
  payment(3, { status: 'refunded', requested: true }),
];

function setup(patch: Partial<BackendClient> = {}, languages?: UserLanguages) {
  const logger = fakeLogger();
  const backend = fakeBackend({
    listStarsPayments: vi.fn(() => Promise.resolve(PAYMENTS)),
    requestStarsRefund: vi.fn(() => Promise.resolve('requested' as const)),
    ...patch,
  });
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
    shownSignals: stubShownSignals(),
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

describe('/paysupport', () => {
  it.each([
    ['/paysupport', textUpdate('/paysupport')],
    ['the list button', callbackUpdate(PAYSUPPORT_LIST_CALLBACK)],
  ])(
    'B1 %s lists the payments, a refund button for each one still open, support and the menu',
    async (_label, update) => {
      const { bot, api, backend } = setup();
      await bot.handleUpdate(update);
      expect(backend.listStarsPayments).toHaveBeenCalledWith(String(USER.id));
      const message = sentPayload(api.calls, 'sendMessage');
      expect(message?.text).toBe(paysupportText(PAYMENTS).value);
      expect(inlineRows(message)).toEqual([
        [
          {
            text: paysupportRefundLabel(PAYMENTS[0]!.paidAt),
            callback_data: paysupportRefundCallbackData(PAYMENTS[0]!.id),
          },
        ],
        [
          {
            text: paysupportRefundLabel(PAYMENTS[1]!.paidAt),
            callback_data: paysupportRefundCallbackData(PAYMENTS[1]!.id),
          },
        ],
        [...SUPPORT_ROW, ...MENU_ROW],
      ]);
      // #475: a refund request is a step forward, green on its own row
      expect(inlineStyles(message)).toEqual([['success'], ['success'], [null, null]]);
    },
  );

  it('B1 writes each line by its state, the date in Moscow time', () => {
    expect(paysupportText(PAYMENTS).value).toBe(
      [
        TEXTS.paysupportScreen.value,
        '',
        '✅ 21.09.2026 17:13 — 100 ⭐, оплачено',
        '⏳ 20.09.2026 17:13 — 100 ⭐, на проверке',
        '📨 19.09.2026 17:13 — 100 ⭐, заявка на возврат принята',
        '↩️ 18.09.2026 17:13 — 100 ⭐, возвращено',
      ].join('\n'),
    );
    expect(paysupportRefundLabel(1_790_000_000)).toBe('↩️ Нужен возврат: 21.09.2026 17:13');
  });

  it('B2 answers no payment with the support chat and the menu', async () => {
    const { bot, api } = setup({ listStarsPayments: vi.fn(() => Promise.resolve([])) });
    await bot.handleUpdate(textUpdate('/paysupport'));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.paysupportEmpty.value);
    expect(inlineRows(message)).toEqual([[...SUPPORT_ROW, ...MENU_ROW]]);
  });

  it('B3 answers a failed read with a retry of the list, a read', async () => {
    const { bot, api } = setup({ listStarsPayments: vi.fn(unreachable) });
    await bot.handleUpdate(textUpdate('/paysupport'));
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.unavailable.value);
    expect(inlineRows(message)).toEqual([
      [{ text: LABELS.demoRetryButton, callback_data: PAYSUPPORT_LIST_CALLBACK }, ...MENU_ROW],
    ]);
  });
});

describe('«Нужен возврат»', () => {
  const press = callbackUpdate(paysupportRefundCallbackData(PAYMENTS[0]!.id));

  it('B4 records the request for the presser and says so, with the list and the menu', async () => {
    const { bot, api, backend } = setup();
    await bot.handleUpdate(press);
    expect(backend.requestStarsRefund).toHaveBeenCalledWith(String(USER.id), PAYMENTS[0]!.id);
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.paysupportRequested.value);
    expect(inlineRows(message)).toEqual(BACK_TO_LIST_ROWS);
  });

  it('B5 answers a repeated press as a request already made', async () => {
    const { bot, api } = setup({
      requestStarsRefund: vi.fn(() => Promise.resolve('already_requested' as const)),
    });
    await bot.handleUpdate(press);
    expect(sentPayload(api.calls, 'sendMessage')?.text).toBe(
      TEXTS.paysupportAlreadyRequested.value,
    );
  });

  it.each([
    [409, StarsRefundErrorCode.AlreadyRefunded, () => TEXTS.paysupportAlreadyRefunded],
    [404, StarsRefundErrorCode.PaymentNotFound, () => TEXTS.paysupportNotFound],
  ])('B6 answers %i %s with its text', async (status, reason, text) => {
    const { bot, api } = setup({ requestStarsRefund: vi.fn(refused(status, reason)) });
    await bot.handleUpdate(press);
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(text().value);
    expect(inlineRows(message)).toEqual(BACK_TO_LIST_ROWS);
  });

  // captureApi throws on a «🔄 Повторить» that carries a write, so the scene itself is the check
  it('B7 answers an unknown outcome with the list, never with the press again', async () => {
    const { bot, api, logger } = setup({ requestStarsRefund: vi.fn(unreachable) });
    await bot.handleUpdate(press);
    const message = sentPayload(api.calls, 'sendMessage');
    expect(message?.text).toBe(TEXTS.unavailable.value);
    expect(inlineRows(message)).toEqual(BACK_TO_LIST_ROWS);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ name: 'BackendError' }) as unknown,
      }),
      'stars refund request not recorded',
    );
  });

  it('answers an id that is not a uuid without asking the backend', async () => {
    const { bot, api, backend } = setup();
    await bot.handleUpdate(callbackUpdate(`ps:r:${'-'.repeat(36)}`));
    expect(backend.requestStarsRefund).not.toHaveBeenCalled();
    expect(sentPayload(api.calls, 'sendMessage')?.text).toBe(TEXTS.paysupportNotFound.value);
  });

  // B8: every answer of both handlers carries the menu
  it.each([
    ['the list', {}, textUpdate('/paysupport')],
    [
      'the empty list',
      { listStarsPayments: vi.fn(() => Promise.resolve([])) },
      textUpdate('/paysupport'),
    ],
    ['a failed list', { listStarsPayments: vi.fn(unreachable) }, textUpdate('/paysupport')],
    ['a request', {}, press],
    ['a failed request', { requestStarsRefund: vi.fn(unreachable) }, press],
  ] as const)('B8 puts the menu under %s', async (_label, patch, update) => {
    const { bot, api } = setup(patch);
    await bot.handleUpdate(update);
    expect(inlineRows(sentPayload(api.calls, 'sendMessage')).at(-1)?.at(-1)).toEqual(MENU_ROW[0]);
  });

  it('ignores the press in a group', async () => {
    const { bot, api, backend } = setup();
    await bot.handleUpdate(callbackUpdate(paysupportRefundCallbackData(PAYMENTS[0]!.id), 'group'));
    expect(backend.requestStarsRefund).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });
});

// #633: /paysupport of a user whose language is English, through the language middleware
describe('/paysupport in English (#633)', () => {
  const CYRILLIC = /[А-Яа-яЁё]/u;
  const english = () => setup({}, userLanguagesWith(USER.id, BotLanguage.En));
  const en = <T>(run: () => T): T => runWithLanguage(BotLanguage.En, run);
  const textsOf = (calls: readonly ApiCall[]): string[] =>
    calls.flatMap((call) => [
      ...[call.payload.text].filter((text): text is string => typeof text === 'string'),
      ...inlineRows(call.payload)
        .flat()
        .map((key) => (key as { text: string }).text),
    ]);

  it('EN-10 the list, the refund and list buttons and the request answer are English', async () => {
    const list = english();
    await list.bot.handleUpdate(textUpdate('/paysupport'));
    const message = sentPayload(list.api.calls, 'sendMessage');
    expect(message?.text).toBe(en(() => paysupportText(PAYMENTS).value));
    expect(inlineRows(message)[0]?.[0]).toMatchObject({
      text: en(() => paysupportRefundLabel(PAYMENTS[0]!.paidAt)),
    });

    const refund = english();
    await refund.bot.handleUpdate(callbackUpdate(paysupportRefundCallbackData(PAYMENTS[0]!.id)));
    const answer = sentPayload(refund.api.calls, 'sendMessage');
    expect(answer?.text).toBe(BOT_TEXT_SOURCES_EN.paysupportRequested);
    expect(inlineRows(answer)[0]?.[0]).toMatchObject({
      text: BOT_TEXT_SOURCES_EN.paysupportListButton,
    });

    const texts = textsOf([...list.api.calls, ...refund.api.calls]);
    expect(texts.length).toBeGreaterThan(4);
    for (const text of texts) expect(text).not.toMatch(CYRILLIC);
  });
});
