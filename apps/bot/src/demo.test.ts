import { BotError, GrammyError, HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import {
  BrokerRestErrorCode,
  createTradeIntentRequestSchema,
  decimalStringSchema,
  PairsCatalogErrorCode,
  plainTextOf,
  SignalFeedOutcome,
  TradeAction,
  type PairsCatalogResponse,
  type PairView,
} from '@binarius/shared';
import { analysisScreen, analysisUnavailableScreen } from './analysis';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  DEMO_CALLBACK_DATA,
  DEMO_GROUPS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  demoDurationCallbackData,
  demoPageCallbackData,
  SESSION_START_PATTERN,
  sessionStartCallbackData,
  sessionStartDataOf,
  STAKE_CALLBACK_PATTERN,
  stakeCallbackData,
  stakeDataOf,
  stakeFingerprint,
  stakeMenuCallbackData,
} from './demo';
import { DEMO_DURATIONS_SEC } from './demo-catalog';
import { LOGIN_DIALOG_TTL_MS, createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  ACCESS_VIEW,
  BOT_INFO,
  PAIR_CLOSED,
  PAIR_EURUSD,
  PAIR_MINUTE_ONLY,
  PAIR_OTHER_TYPE,
  PAIR_SHORT,
  PAIRS_RESPONSE,
  SIGNAL_DATA_REFUSAL,
  SIGNAL_DECIDED,
  SIGNAL_FETCH_FAILED,
  SIGNAL_NO_SIGNAL,
  STAKE_FINGERPRINT,
  TEXT_CARD_MESSAGE_ID,
  USER,
  accessView,
  callbackUpdate,
  captureApi,
  fakeBackend,
  failFromSecondCall,
  fakeLogger,
  messageAnswer,
  pairsResponse,
  rejectionOf,
  type ApiCall,
  stubSessionTracker,
  stubTracker,
} from './testing';
import {
  demoDurationsScreen,
  demoPairsScreen,
  demoSummary,
  LABELS,
  sessionStartButtonLabel,
  stakeButtonLabel,
  TEXTS,
} from './texts';

// The demo's screens through createBot, so the private-chat filter and the mounting are what is
// tested, with the catalog read programmed per scene.

const NOW = 1_790_000_000_000;

interface Button {
  text: string;
  callback_data?: string;
}

function setup(
  options: {
    readPairs?: BackendClient['readPairs'];
    evaluateSignal?: BackendClient['evaluateSignal'];
    readTradingAccess?: BackendClient['readTradingAccess'];
    dialog?: LoginDialogState;
    dialogClock?: { at: number };
  } = {},
) {
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
  const evaluateSignal = vi.fn<BackendClient['evaluateSignal']>(
    options.evaluateSignal ?? (() => Promise.resolve(SIGNAL_DECIDED)),
  );
  const logger = fakeLogger();
  const clock = options.dialogClock;
  const loginDialog = createLoginDialog(clock === undefined ? {} : { now: () => clock.at });
  if (options.dialog !== undefined) loginDialog.set(USER.id, options.dialog);
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    token: '123456:AA-bot-token',
    backend: fakeBackend({
      readPairs,
      evaluateSignal,
      readTradingAccess: options.readTradingAccess ?? (() => Promise.resolve(ACCESS_VIEW)),
    }),
    logger,
    botInfo: BOT_INFO,
    loginDialog,
    now: () => NOW,
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  const press = (data: string, chatType?: string) =>
    bot.handleUpdate(callbackUpdate(data, chatType));
  return { bot, readPairs, evaluateSignal, logger, loginDialog, press, ...api };
}

const methods = (calls: readonly ApiCall[]) => calls.map((call) => call.method);
const payloadOf = (calls: readonly ApiCall[], method: string) =>
  calls.find((call) => call.method === method)?.payload;
const rowsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  (payload?.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? [];
const button = (text: string, callback_data: string): Button => ({ text, callback_data });

const catalogOf = (...pairs: PairView[]): (() => Promise<PairsCatalogResponse>) => {
  return () => Promise.resolve(pairsResponse({ pairs }));
};

const BACK_GROUPS = button(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
const BACK_EURUSD_PAGE = button(LABELS.demoBackPairsButton, demoPageCallbackData('currency', 0));
const BACK_EURUSD_DURATIONS = button(
  LABELS.demoBackDurationsButton,
  demoAssetCallbackData(PAIR_EURUSD.id),
);

const EDIT_GONE: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message to edit not found',
};
const EDIT_NOT_MODIFIED: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message is not modified: specified new message content is the same',
};

// 25 open currency pairs, P00 … P24, listed in reverse so the sort is what orders them
const MANY = Array.from({ length: 25 }, (_, index): PairView => ({
  ...PAIR_EURUSD,
  id: 1000 + index,
  symbol: `P${String(index).padStart(2, '0')}`,
})).reverse();

describe('the demo button', () => {
  it('sends the types present as a new message, each with its count of open pairs', async () => {
    const { press, calls, readPairs } = setup();
    await press(DEMO_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoGroups.value);
    // GBP/USD is closed and AUD/CAD accepts no demo duration (#313), so the currencies count one;
    // no commodity, stock or index in the catalog
    expect(rowsOf(sent)).toEqual([
      [
        button('💱 Валюты · 1', demoPageCallbackData('currency', 0)),
        button('💠 Криптовалюты · 1', demoPageCallbackData('cryptocurrency', 0)),
      ],
      [button('📁 Другие · 1', demoPageCallbackData('other', 0))],
    ]);
    expect(readPairs).toHaveBeenCalledTimes(1);
  });

  it('says the catalog is unavailable and offers the same press again on a 503', async () => {
    const { press, calls, logger } = setup({
      readPairs: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 503,
            reason: PairsCatalogErrorCode.Unavailable,
          }),
        ),
    });
    await press(DEMO_CALLBACK_DATA);

    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoCatalogUnavailable.value);
    expect(rowsOf(sent)).toEqual([[button(LABELS.demoRetryButton, DEMO_CALLBACK_DATA)]]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says the service is unavailable, offers the retry and warns when the read fails', async () => {
    const { press, calls, logger } = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(DEMO_CALLBACK_DATA);

    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(sent)).toEqual([[button(LABELS.demoRetryButton, DEMO_CALLBACK_DATA)]]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['demo catalog not read']);
  });

  it('reads an empty catalog as unavailable, with the retry on the types', async () => {
    const { press, calls } = setup({ readPairs: catalogOf() });
    await press(DEMO_CALLBACK_DATA);

    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoCatalogUnavailable.value);
    expect(rowsOf(sent)).toEqual([[button(LABELS.demoRetryButton, DEMO_GROUPS_CALLBACK_DATA)]]);
  });

  // #313: only the pairs that accept 5 or 15 s are listed
  it('gives no button to a type whose pairs all refuse the demo durations', async () => {
    const minuteStock = { ...PAIR_MINUTE_ONLY, id: 606, symbol: 'AAPL', type: 'stock' };
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_EURUSD, minuteStock) });
    await press(DEMO_CALLBACK_DATA);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual([
      [button('💱 Валюты · 1', demoPageCallbackData('currency', 0))],
    ]);
  });

  it('says there is no pair for short trades when no pair accepts them, with the retry', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_MINUTE_ONLY) });
    await press(DEMO_CALLBACK_DATA);

    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoNoShortPairs.value);
    expect(plainTextOf(TEXTS.demoNoShortPairs)).toBe('Сейчас нет активов для коротких сделок.');
    expect(rowsOf(sent)).toEqual([[button(LABELS.demoRetryButton, DEMO_GROUPS_CALLBACK_DATA)]]);
  });

  it('still sends the types when answering the query is refused', async () => {
    const { press, calls, logger, apiErrors } = setup();
    apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: query is too old and response timeout expired',
    });
    await press(DEMO_CALLBACK_DATA);

    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.demoGroups.value);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'answering the callback query failed',
    ]);
  });

  it('ignores the press outside a private chat', async () => {
    const { press, calls, readPairs } = setup();
    for (const data of [
      DEMO_CALLBACK_DATA,
      DEMO_GROUPS_CALLBACK_DATA,
      demoAssetCallbackData(101),
    ]) {
      await press(data, 'group');
    }
    expect(calls).toEqual([]);
    expect(readPairs).not.toHaveBeenCalled();
  });
});

describe('the types and their pages', () => {
  it('edits the message back to the types', async () => {
    const { press, calls } = setup();
    await press(DEMO_GROUPS_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(TEXTS.demoGroups.value);
  });

  it('says a type with pairs but none open is closed by the schedule', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_CLOSED) });
    await press(DEMO_CALLBACK_DATA);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual([
      [button('💱 Валюты · 0', demoPageCallbackData('currency', 0))],
    ]);

    await press(demoPageCallbackData('currency', 0));
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoGroupClosed('💱 Валюты').value);
    expect(rowsOf(edited)).toEqual([[BACK_GROUPS]]);
  });

  it('lists twelve open pairs a page in two columns, sorted, the closed ones hidden', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(...MANY, PAIR_CLOSED) });
    await press(demoPageCallbackData('currency', 0));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(demoPairsScreen('currency', 0, 3).value);
    const rows = rowsOf(edited);
    expect(rows).toHaveLength(7);
    expect(rows.slice(0, 6).every((row) => row.length === 2)).toBe(true);
    expect(rows[0]).toEqual([
      button('P00 · 85%', demoAssetCallbackData(1000)),
      button('P01 · 85%', demoAssetCallbackData(1001)),
    ]);
    expect(rows.flat().map((entry) => entry.text)).not.toContain('GBP/USD · 80%');
    expect(rows[6]).toEqual([
      BACK_GROUPS,
      button(LABELS.demoNextButton, demoPageCallbackData('currency', 1)),
    ]);
  });

  it('offers «◀️» and «▶️» only where a page exists', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(...MANY) });
    await press(demoPageCallbackData('currency', 1));
    await press(demoPageCallbackData('currency', 2));
    const [middle, last] = calls.filter((call) => call.method === 'editMessageText');

    expect(rowsOf(middle?.payload).at(-1)).toEqual([
      button(LABELS.demoPrevButton, demoPageCallbackData('currency', 0)),
      BACK_GROUPS,
      button(LABELS.demoNextButton, demoPageCallbackData('currency', 2)),
    ]);
    expect(rowsOf(last?.payload)).toEqual([
      [button('P24 · 85%', demoAssetCallbackData(1024))],
      [button(LABELS.demoPrevButton, demoPageCallbackData('currency', 1)), BACK_GROUPS],
    ]);
  });

  it('clamps a page beyond the end to the last one', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(...MANY) });
    await press(demoPageCallbackData('currency', 9999));
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(demoPairsScreen('currency', 2, 3).value);
  });
});

describe('a pair and its durations', () => {
  it('shows exactly «⏱ 5 с» and «⏱ 15 с» in one row, then the way back', async () => {
    const { press, calls } = setup();
    await press(demoAssetCallbackData(PAIR_EURUSD.id));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(demoDurationsScreen(PAIR_EURUSD).value);
    expect(rowsOf(edited)).toEqual([
      [
        button('⏱ 5 с', demoDurationCallbackData(101, 5)),
        button('⏱ 15 с', demoDurationCallbackData(101, 15)),
      ],
      [BACK_EURUSD_PAGE, BACK_GROUPS],
    ]);
  });

  it('leaves out the durations outside the pair range, and leads back to its page', async () => {
    const narrow = { ...PAIR_EURUSD, symbol: 'ZAR/USD OTC', minTimeframe: 10, maxTimeframe: 900 };
    const { press, calls } = setup({ readPairs: catalogOf(...MANY, narrow) });
    await press(demoAssetCallbackData(narrow.id));

    // «ZAR/USD OTC» sorts after P00 … P24, so it is the second item of page 2
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
      [button('⏱ 15 с', demoDurationCallbackData(101, 15))],
      [button(LABELS.demoBackPairsButton, demoPageCallbackData('currency', 2)), BACK_GROUPS],
    ]);
  });

  // an old pair button of a pair the pages no longer list (#313): the way back is page 0
  it('says so when the pair admits none of the durations', async () => {
    const { press, calls } = setup({
      readPairs: catalogOf({ ...PAIR_SHORT, minTimeframe: 30, maxTimeframe: 3600 }),
    });
    await press(demoAssetCallbackData(PAIR_SHORT.id));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoNoDuration(PAIR_SHORT.symbol).value);
    expect(rowsOf(edited)).toEqual([
      [button(LABELS.demoBackPairsButton, demoPageCallbackData('cryptocurrency', 0)), BACK_GROUPS],
    ]);
  });

  it('checks the pair again: one closed since its page was drawn is refused', async () => {
    const { press, calls } = setup();
    await press(demoAssetCallbackData(PAIR_CLOSED.id));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoPairClosed(PAIR_CLOSED.symbol).value);
    expect(rowsOf(edited)).toEqual([[BACK_EURUSD_PAGE, BACK_GROUPS]]);
  });

  it('groups a broker type outside the five under «📁 Другие»', async () => {
    const { press, calls } = setup();
    await press(demoAssetCallbackData(PAIR_OTHER_TYPE.id));
    expect(rowsOf(payloadOf(calls, 'editMessageText')).at(-1)?.[0]).toEqual(
      button(LABELS.demoBackPairsButton, demoPageCallbackData('other', 0)),
    );
  });
});

describe('the summary and «📊 Анализ»', () => {
  it('shows the summary with «📊 Анализ» and the way back', async () => {
    const { press, calls } = setup();
    await press(demoDurationCallbackData(PAIR_EURUSD.id, 15));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(demoSummary(PAIR_EURUSD, 15).value);
    expect(rowsOf(edited)).toEqual([
      [button(LABELS.demoAnalysisButton, demoAnalysisCallbackData(101, 15))],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
  });

  // the acceptance criterion: the check runs on the catalog read at the press
  it('refuses «📊 Анализ» for a pair that closed after the summary was drawn', async () => {
    const closing = { ...PAIR_EURUSD, scheduledUntil: NOW + 60_000 };
    const reads = [catalogOf(PAIR_EURUSD), catalogOf(closing)];
    const { press, calls, readPairs, evaluateSignal } = setup({
      readPairs: () => (reads.shift() ?? catalogOf())(),
    });
    await press(demoDurationCallbackData(PAIR_EURUSD.id, 15));
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));

    const edits = calls.filter((call) => call.method === 'editMessageText');
    expect(edits.map((call) => call.payload.text)).toEqual([
      demoSummary(PAIR_EURUSD, 15).value,
      TEXTS.demoPairClosed(PAIR_EURUSD.symbol).value,
    ]);
    expect(evaluateSignal).not.toHaveBeenCalled();
    expect(readPairs).toHaveBeenCalledTimes(2);
  });

  it('shows no «📊 Анализ» on a catalog the backend does not call fresh', async () => {
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ ageMs: 90_000, fresh: false })),
    });
    const data = demoDurationCallbackData(PAIR_EURUSD.id, 15);
    await press(data);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoCatalogStale.value);
    expect(rowsOf(edited)).toEqual([[button(LABELS.demoRetryButton, data)]]);
  });

  it('refuses an old duration button the pair no longer admits', async () => {
    const { press, calls } = setup({ readPairs: catalogOf({ ...PAIR_EURUSD, maxTimeframe: 10 }) });
    await press(demoDurationCallbackData(PAIR_EURUSD.id, 15));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoDurationUnsupported(PAIR_EURUSD.symbol).value);
    expect(rowsOf(edited)).toEqual([[BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
  });

  it('refuses a pair gone from the catalog', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_SHORT) });
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoPairMissing.value);
    expect(rowsOf(edited)).toEqual([[BACK_GROUPS]]);
  });
});

// #126
describe('the analysis', () => {
  const DATA = demoAnalysisCallbackData(PAIR_EURUSD.id, 5);
  const REPEAT = button(LABELS.repeatAnalysisButton, DATA);
  const SESSION = button('🚀 Сессия из 5 сделок', sessionStartCallbackData(PAIR_EURUSD.id, 5));
  const STAKE_MENU = button(LABELS.stakeMenuButton, stakeMenuCallbackData(PAIR_EURUSD.id, 5));
  const stakeRowOf = (calls: readonly ApiCall[]) => rowsOf(edits(calls).at(-1)?.payload)[0];

  // #297: the label and the fingerprint are the amount the press would trade
  it('labels the stake button with the saved stake and fingerprints it', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ demoStake: decimalStringSchema.parse('2.5') })),
    });
    await press(DATA);
    const [stake, menu] = stakeRowOf(calls) ?? [];
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Up, '2.5'));
    expect(stake?.text).toContain('$2.50');
    const match = STAKE_CALLBACK_PATTERN.exec(stake?.callback_data ?? '');
    expect(stakeDataOf(match ?? '')?.fingerprint).toBe(
      stakeFingerprint(decimalStringSchema.parse('2.5')),
    );
    expect(stakeDataOf(match ?? '')?.fingerprint).not.toBe(STAKE_FINGERPRINT);
    expect(menu).toEqual(STAKE_MENU);
  });

  it('drops the amount, not the button, when access cannot say it', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(DATA);
    const [stake, menu] = stakeRowOf(calls) ?? [];
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Up));
    const match = STAKE_CALLBACK_PATTERN.exec(stake?.callback_data ?? '');
    expect(stakeDataOf(match ?? '')?.fingerprint).toBe(stakeFingerprint(null));
    expect(menu).toEqual(STAKE_MENU);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'trading access not read for the stake label',
    ]);
  });

  it('draws no amount without a broker snapshot', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ broker: null, brokerUnavailable: 'refreshing' })),
    });
    await press(DATA);
    expect(stakeRowOf(calls)?.[0]?.text).toBe(stakeButtonLabel(TradeAction.Up));
  });

  it('fingerprints the canonical amount, so a spelling never decides a mismatch', () => {
    expect(stakeFingerprint(decimalStringSchema.parse('5.00000000'))).toBe(
      stakeFingerprint(decimalStringSchema.parse('5')),
    );
    expect(stakeFingerprint(decimalStringSchema.parse('5'))).not.toBe(
      stakeFingerprint(decimalStringSchema.parse('5.01')),
    );
    expect(stakeFingerprint(null)).toMatch(/^[0-9a-f]{6}$/);
  });
  const resultOf = (response = SIGNAL_DECIDED) =>
    analysisScreen({ pair: PAIR_EURUSD, durationSec: 5, response }).text.value;
  const edits = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'editMessageText');

  it('reads the catalog, shows «⏳», asks for the signal, then shows it with the stake button', async () => {
    const { press, calls, readPairs, evaluateSignal } = setup();
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'editMessageText']);
    const [waiting, result] = edits(calls);
    expect(waiting?.payload.text).toBe(TEXTS.analyzing('EUR/USD OTC · ⏱ 5 с').value);
    // without a keyboard the edit removes the summary's, so «📊 Анализ» cannot be pressed twice
    expect(waiting?.payload.reply_markup).toBeUndefined();
    expect(result?.payload.text).toBe(resultOf());
    const [[stake, menu], ...rest] = rowsOf(result?.payload);
    // the amount the press trades: no saved stake, so the broker's minimum (#297)
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Up, '1.00000000'));
    expect(stake?.text).toContain('$1.00');
    expect(menu).toEqual(STAKE_MENU);
    // the nonce is drawn per render (#127); everything before it is the pressed pair
    const match = STAKE_CALLBACK_PATTERN.exec(stake?.callback_data ?? '');
    expect(stakeDataOf(match ?? '')).toEqual({
      assetId: PAIR_EURUSD.id,
      durationSec: 5,
      action: TradeAction.Up,
      nonce: expect.stringMatching(/^[0-9a-f]{12}$/),
      fingerprint: STAKE_FINGERPRINT,
    });
    expect(rest).toEqual([[SESSION], [REPEAT], [BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
    expect(readPairs).toHaveBeenCalledTimes(1);
    expect(evaluateSignal.mock.calls).toEqual([[PAIR_EURUSD.id, '5s']]);
  });

  // #313: a short trade's analysis runs on its own sub-minute candle, never on 1m
  it.each([
    [5, '5s'],
    [15, '15s'],
  ] as const)('asks for the candles of a %i s trade at %s', async (durationSec, interval) => {
    const { press, evaluateSignal } = setup();
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, durationSec));
    expect(evaluateSignal.mock.calls).toEqual([[PAIR_EURUSD.id, interval]]);
  });

  it('covers every demo duration in the table above', () => {
    expect(DEMO_DURATIONS_SEC).toEqual([5, 15]);
  });

  // the acceptance criterion: the screen is built from the pair read at this press
  it('prints the payout of the catalog read at this press, not the one the summary showed', async () => {
    const reads = [catalogOf(PAIR_EURUSD), catalogOf({ ...PAIR_EURUSD, payout: 70 })];
    const { press, calls } = setup({ readPairs: () => (reads.shift() ?? catalogOf())() });
    await press(demoDurationCallbackData(PAIR_EURUSD.id, 5));
    await press(DATA);

    const result = edits(calls).at(-1)?.payload.text;
    expect(result).toBe(
      analysisScreen({
        pair: { ...PAIR_EURUSD, payout: 70 },
        durationSec: 5,
        response: SIGNAL_DECIDED,
      }).text.value,
    );
    expect(result).toContain('Выплата: 70%');
  });

  it('asks for no signal and shows no «⏳» on a closed pair', async () => {
    const { press, calls, evaluateSignal } = setup({ readPairs: catalogOf(PAIR_CLOSED) });
    await press(demoAnalysisCallbackData(PAIR_CLOSED.id, 5));

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      TEXTS.demoPairClosed(PAIR_CLOSED.symbol).value,
    );
    expect(evaluateSignal).not.toHaveBeenCalled();
  });

  it('asks for no signal and shows no «⏳» on a catalog the backend does not call fresh', async () => {
    const { press, calls, evaluateSignal } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ ageMs: 90_000, fresh: false })),
    });
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(TEXTS.demoCatalogStale.value);
    expect(evaluateSignal).not.toHaveBeenCalled();
  });

  // #127: «🔄 Повторить анализ» re-renders the same message, so the nonce is what tells two
  // renders' buttons apart and lets the second one open a trade of its own
  it('draws a new nonce on every render, and nothing else changes', async () => {
    const { press, calls } = setup();
    await press(DATA);
    await press(DATA);
    const stakes = edits(calls)
      .map((call) => rowsOf(call.payload)[0]?.[0]?.callback_data)
      .filter((data): data is string => data?.startsWith('demo:stake:') === true);
    expect(stakes).toHaveLength(2);
    const [first, second] = stakes.map((data) =>
      stakeDataOf(STAKE_CALLBACK_PATTERN.exec(data) ?? ''),
    );
    expect(first?.nonce).not.toBe(second?.nonce);
    expect({ ...first, nonce: '' }).toEqual({ ...second, nonce: '' });
  });

  it.each(['0123456789a', '0123456789AB', 'AbCdEf012345', 'ASNFZ4mrze8=', '0123456789abc'])(
    'refuses the nonce %s',
    (nonce) => {
      expect(STAKE_CALLBACK_PATTERN.exec(`demo:stake:101:5:up:${nonce}`)).toBeNull();
    },
  );

  // a button from before #297 has no fingerprint: matched, so its press is refused with a text
  // rather than left spinning; a malformed one is not matched
  it('reads a stake datum with and without a fingerprint, and refuses a malformed one', () => {
    const old = stakeDataOf(STAKE_CALLBACK_PATTERN.exec('demo:stake:101:5:up:0123456789ab') ?? '');
    expect(old).toMatchObject({ nonce: '0123456789ab', fingerprint: undefined });
    for (const fingerprint of ['a0b1c', 'A0B1C2', 'a0b1c2d']) {
      expect(
        STAKE_CALLBACK_PATTERN.exec(`demo:stake:101:5:up:0123456789ab:${fingerprint}`),
      ).toBeNull();
    }
    expect(
      Buffer.byteLength(
        stakeCallbackData(2_147_483_647, 15, TradeAction.Down, 'f'.repeat(12), 'f'.repeat(6)),
      ),
    ).toBe(49);
  });

  it("carries stake data #127's request schema accepts", () => {
    for (const action of Object.values(TradeAction)) {
      const data = stakeCallbackData(2_147_483_647, 15, action, 'ffffffffffff', 'a0b1c2');
      const match = STAKE_CALLBACK_PATTERN.exec(data);
      expect(match, data).not.toBeNull();
      const parsed = stakeDataOf(match as RegExpMatchArray);
      expect(parsed).toEqual({
        assetId: 2_147_483_647,
        durationSec: 15,
        action,
        nonce: 'ffffffffffff',
        fingerprint: 'a0b1c2',
      });
      const shape = createTradeIntentRequestSchema.shape;
      expect(shape.assetId.safeParse(parsed?.assetId).success).toBe(true);
      expect(shape.durationSec.safeParse(parsed?.durationSec).success).toBe(true);
      expect(shape.action.safeParse(parsed?.action).success).toBe(true);
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  // #284: a session of five fits the worker's hour at every duration of the set (#313)
  it.each([
    [5, true],
    [15, true],
  ] as const)('offers the session at %i s on a signal: %s', async (durationSec, shown) => {
    const { press, calls } = setup();
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, durationSec));
    const session = button(
      sessionStartButtonLabel(5),
      sessionStartCallbackData(PAIR_EURUSD.id, durationSec),
    );
    const rows = rowsOf(edits(calls).at(-1)?.payload);
    expect(rows.some((row) => row.length === 1 && row[0]?.text === session.text)).toBe(shown);
    if (shown) expect(rows[1]).toEqual([session]);
  });

  it('keeps the longest session datum inside the Bot API limit and reads it back', () => {
    const data = sessionStartCallbackData(2_147_483_647, 15);
    expect(data).toBe('demo:sess:2147483647:15');
    expect(Buffer.byteLength(data, 'utf8')).toBe(23);
    expect(sessionStartDataOf(SESSION_START_PATTERN.exec(data) ?? '')).toEqual({
      assetId: 2_147_483_647,
      durationSec: 15,
    });
    // a datum from before #313 is not a session datum: the legacy handler takes it
    expect(SESSION_START_PATTERN.exec(`demo:sess:${String(PAIR_EURUSD.id)}:300`)).toBeNull();
  });

  it.each([
    ['a rule refusal', SIGNAL_NO_SIGNAL],
    ['a data refusal', SIGNAL_DATA_REFUSAL],
    ['the broker rate-limiting the candles', SIGNAL_FETCH_FAILED],
  ])('shows %s with no stake button and no warning', async (_case, response) => {
    const { press, calls, logger } = setup({ evaluateSignal: () => Promise.resolve(response) });
    await press(DATA);

    const result = edits(calls).at(-1)?.payload;
    expect(result?.text).toBe(resultOf(response));
    expect(rowsOf(result)).toEqual([[REPEAT], [BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says the candles are unavailable and warns with the code on any other broker failure', async () => {
    const { press, calls, logger } = setup({
      evaluateSignal: () =>
        Promise.resolve({
          outcome: SignalFeedOutcome.FetchFailed,
          code: BrokerRestErrorCode.Unavailable,
        }),
    });
    await press(DATA);

    expect(edits(calls).at(-1)?.payload.text).toBe(
      analysisUnavailableScreen(PAIR_EURUSD, 5).text.value,
    );
    expect(logger.warn.mock.calls).toEqual([
      [{ signalCode: BrokerRestErrorCode.Unavailable }, 'signal not evaluated'],
    ]);
  });

  it.each([
    ['unreachable', new BackendError(BackendErrorCode.Unreachable)],
    ['a 500', new BackendError(BackendErrorCode.HttpStatus, { status: 500 })],
    ['a broken body', new BackendError(BackendErrorCode.ContractViolation)],
  ])('says the analysis is unavailable and warns when the call is %s', async (_case, error) => {
    const { press, calls, logger } = setup({ evaluateSignal: () => Promise.reject(error) });
    await press(DATA);

    const result = edits(calls).at(-1)?.payload;
    expect(result?.text).toBe(analysisUnavailableScreen(PAIR_EURUSD, 5).text.value);
    expect(rowsOf(result)).toEqual([[REPEAT], [BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['signal not evaluated']);
  });

  it('sends «⏳» anew when the summary is gone, and the result after it as a new message', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendMessage',
      'sendMessage',
    ]);
    const [waiting, result] = calls.filter((call) => call.method === 'sendMessage');
    expect(waiting?.payload.text).toBe(TEXTS.analyzing('EUR/USD OTC · ⏱ 5 с').value);
    expect(result?.payload.text).toBe(resultOf());
    expect(rowsOf(result?.payload)[2]).toEqual([REPEAT]);
  });

  it('asks for no signal and sends nothing more when «⏳» fails in transport', async () => {
    const { press, calls, apiErrors, evaluateSignal } = setup();
    apiErrors.set(
      'editMessageText',
      new HttpError(
        "Network request for 'editMessageText' failed!",
        new Error('The operation was aborted due to timeout'),
      ),
    );
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(evaluateSignal).not.toHaveBeenCalled();
  });

  it('sends the result anew with its keyboard when its edit is refused as gone', async () => {
    const { press, calls, ...api } = setup();
    failFromSecondCall(api, 'editMessageText', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageText',
      'sendMessage',
    ]);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(resultOf());
    expect(sent?.reply_markup).toEqual(edits(calls)[1]?.payload.reply_markup);
  });

  it('is done when Telegram says the message already shows the result', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_NOT_MODIFIED);
    await press(DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'editMessageText']);
  });

  it('does nothing outside a private chat', async () => {
    const { press, calls, readPairs } = setup();
    await press(DATA, 'group');
    expect(calls).toEqual([]);
    expect(readPairs).not.toHaveBeenCalled();
  });
});

describe('the edit of a demo screen', () => {
  const data = demoAssetCallbackData(PAIR_EURUSD.id);

  it('is done when Telegram says the message already shows it', async () => {
    const { press, calls, logger, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_NOT_MODIFIED);
    await press(data);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(logger.info.mock.calls.map((call) => call[1])).toEqual([
      'the demo screen already shows this',
    ]);
  });

  it('sends the screen anew with the same keyboard when the message is gone', async () => {
    const { press, calls, logger, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(data);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    const edited = payloadOf(calls, 'editMessageText');
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(edited?.text);
    expect(sent?.reply_markup).toEqual(edited?.reply_markup);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'the demo screen was not edited, sending it anew',
    ]);
  });

  it('sends nothing more when the edit fails in transport', async () => {
    const { press, calls, logger, apiErrors } = setup();
    apiErrors.set(
      'editMessageText',
      new HttpError(
        "Network request for 'editMessageText' failed!",
        new Error('The operation was aborted due to timeout'),
      ),
    );
    await press(data);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(logger.error.mock.calls.map((call) => call[1])).toEqual([
      'the demo screen edit failed in transport, sending nothing more',
    ]);
  });

  it('hands any other refusal to bot.catch with nothing sent', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    const thrown = await rejectionOf(press(data));

    expect(thrown).toBeInstanceOf(BotError);
    expect((thrown as BotError).error).toBeInstanceOf(GrammyError);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
  });
});

describe('demo data the bot did not draw', () => {
  it.each([
    'demo:a:0',
    'demo:a:2147483648',
    'demo:t:bond:0',
    'demo:d:0:15',
    'demo:an:2147483648:15',
  ])('stops the spinner on %s and sends nothing', async (data) => {
    const { press, calls, readPairs } = setup();
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery']);
    expect(readPairs).not.toHaveBeenCalled();
  });

  // a duration outside DEMO_DURATIONS_SEC matches no pattern (#125 review m5)
  it.each([
    'demo:d:101:120',
    'demo:an:101:120',
    'demo:stake:101:120:up:0123456789ab',
    'demo:stake:101:5:sideways:0123456789ab',
    'demo:stake:101:5:up',
    'demo:sess:101:120',
    'stk:o:a:101:120',
    'stk:o:s:300',
    'demo:t:currency:-1',
    'demo:x',
  ])('does not answer %s at all: no demo pattern matches it', async (data) => {
    const { press, calls, readPairs, evaluateSignal } = setup();
    await press(data);
    expect(calls).toEqual([]);
    expect(readPairs).not.toHaveBeenCalled();
    expect(evaluateSignal).not.toHaveBeenCalled();
  });
});

// #313: the durations of before (60/300/900/1800/3600) in every shape that carries one
describe('a button with a duration the demo no longer offers', () => {
  const LEGACY = [60, 300, 900, 1800, 3600].flatMap((sec) => [
    `demo:d:101:${String(sec)}`,
    `demo:an:101:${String(sec)}`,
    `demo:stake:101:${String(sec)}:up:0123456789ab`,
    `demo:stake:101:${String(sec)}:down:0123456789ab:a0b1c2`,
    `demo:sess:101:${String(sec)}`,
    `stk:o:a:101:${String(sec)}`,
    `stk:s:2.5:a:101:${String(sec)}`,
    `stk:z:a:101:${String(sec)}`,
    `stk:c:a:101:${String(sec)}`,
  ]);

  it.each(LEGACY)('%s: stops the spinner, removes the keyboard, sends nothing', async (data) => {
    const { press, calls, readPairs, evaluateSignal, logger } = setup();
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(payloadOf(calls, 'editMessageReplyMarkup')?.reply_markup).toBeUndefined();
    expect(readPairs).not.toHaveBeenCalled();
    expect(evaluateSignal).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a refused removal at info and sends nothing', async () => {
    const { press, calls, apiErrors, logger } = setup();
    apiErrors.set('editMessageReplyMarkup', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message is not modified',
    });
    await press('demo:an:101:300');
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(logger.info.mock.calls.map((call) => call[1])).toEqual([
      'the keyboard of an old button was not removed',
    ]);
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
      method: 'editMessageReplyMarkup',
      telegramErrorCode: 400,
    });
  });
});

describe('the demo and the email dialog', () => {
  it('leaves the code step and its clock as they were', async () => {
    const step: LoginDialogState = { step: 'code', email: 'ada@example.test' };
    const dialogClock = { at: NOW };
    const { press, loginDialog } = setup({ dialog: step, dialogClock });

    dialogClock.at = NOW + LOGIN_DIALOG_TTL_MS - 1;
    await press(DEMO_GROUPS_CALLBACK_DATA);
    await press(demoAssetCallbackData(PAIR_EURUSD.id));
    expect(loginDialog.get(USER.id)).toEqual(step);

    // a press that touched the dialog would have restarted its lifetime
    dialogClock.at = NOW + LOGIN_DIALOG_TTL_MS;
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });
});
