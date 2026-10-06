import { BotError, GrammyError, HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { PairsCatalogErrorCode, type PairsCatalogResponse, type PairView } from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  DEMO_CALLBACK_DATA,
  DEMO_GROUPS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  demoDurationCallbackData,
  demoPageCallbackData,
} from './demo';
import { LOGIN_DIALOG_TTL_MS, createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  BOT_INFO,
  PAIR_CLOSED,
  PAIR_EURUSD,
  PAIR_OTHER_TYPE,
  PAIR_SHORT,
  PAIRS_RESPONSE,
  TEXT_CARD_MESSAGE_ID,
  USER,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  messageAnswer,
  pairsResponse,
  rejectionOf,
  type ApiCall,
} from './testing';
import { demoDurationsScreen, demoPairsScreen, demoSummary, LABELS, TEXTS } from './texts';

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
    dialog?: LoginDialogState;
    dialogClock?: { at: number };
  } = {},
) {
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
  const logger = fakeLogger();
  const clock = options.dialogClock;
  const loginDialog = createLoginDialog(clock === undefined ? {} : { now: () => clock.at });
  if (options.dialog !== undefined) loginDialog.set(USER.id, options.dialog);
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ readPairs }),
    logger,
    botInfo: BOT_INFO,
    loginDialog,
    now: () => NOW,
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  const press = (data: string, chatType?: string) =>
    bot.handleUpdate(callbackUpdate(data, chatType));
  return { bot, readPairs, logger, loginDialog, press, ...api };
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
    // GBP/USD is closed, so the currencies count one; no commodity, stock or index in the catalog
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
  it('shows the durations the pair admits in rows of three, then the way back', async () => {
    const { press, calls } = setup();
    await press(demoAssetCallbackData(PAIR_EURUSD.id));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(demoDurationsScreen(PAIR_EURUSD).value);
    expect(rowsOf(edited)).toEqual([
      [
        button('⏱ 1 мин', demoDurationCallbackData(101, 60)),
        button('⏱ 5 мин', demoDurationCallbackData(101, 300)),
        button('⏱ 15 мин', demoDurationCallbackData(101, 900)),
      ],
      [
        button('⏱ 30 мин', demoDurationCallbackData(101, 1800)),
        button('⏱ 1 ч', demoDurationCallbackData(101, 3600)),
      ],
      [BACK_EURUSD_PAGE, BACK_GROUPS],
    ]);
  });

  it('leaves out the durations outside the pair range, and leads back to its page', async () => {
    const narrow = { ...PAIR_EURUSD, symbol: 'ZAR/USD OTC', minTimeframe: 120, maxTimeframe: 900 };
    const { press, calls } = setup({ readPairs: catalogOf(...MANY, narrow) });
    await press(demoAssetCallbackData(narrow.id));

    // «ZAR/USD OTC» sorts after P00 … P24, so it is the second item of page 2
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
      [
        button('⏱ 5 мин', demoDurationCallbackData(101, 300)),
        button('⏱ 15 мин', demoDurationCallbackData(101, 900)),
      ],
      [button(LABELS.demoBackPairsButton, demoPageCallbackData('currency', 2)), BACK_GROUPS],
    ]);
  });

  it('says so when the pair admits none of the durations', async () => {
    const { press, calls } = setup({
      readPairs: catalogOf({ ...PAIR_SHORT, minTimeframe: 5, maxTimeframe: 30 }),
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
    await press(demoDurationCallbackData(PAIR_EURUSD.id, 300));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(demoSummary(PAIR_EURUSD, 300).value);
    expect(rowsOf(edited)).toEqual([
      [button(LABELS.demoAnalysisButton, demoAnalysisCallbackData(101, 300))],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
  });

  it('shows the placeholder after «📊 Анализ» when the pair is still open', async () => {
    const { press, calls } = setup();
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 300));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoAnalysisSoon.value);
    expect(rowsOf(edited)).toEqual([[BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
  });

  // the acceptance criterion: the check runs on the catalog read at the press
  it('refuses «📊 Анализ» for a pair that closed after the summary was drawn', async () => {
    const closing = { ...PAIR_EURUSD, scheduledUntil: NOW + 60_000 };
    const reads = [catalogOf(PAIR_EURUSD), catalogOf(closing)];
    const { press, calls, readPairs } = setup({
      readPairs: () => (reads.shift() ?? catalogOf())(),
    });
    await press(demoDurationCallbackData(PAIR_EURUSD.id, 300));
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 300));

    const [summary, analysis] = calls.filter((call) => call.method === 'editMessageText');
    expect(summary?.payload.text).toBe(demoSummary(PAIR_EURUSD, 300).value);
    expect(analysis?.payload.text).toBe(TEXTS.demoPairClosed(PAIR_EURUSD.symbol).value);
    expect(calls.map((call) => call.payload.text)).not.toContain(TEXTS.demoAnalysisSoon.value);
    expect(readPairs).toHaveBeenCalledTimes(2);
  });

  it('shows no «📊 Анализ» on a catalog the backend does not call fresh', async () => {
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ ageMs: 90_000, fresh: false })),
    });
    const data = demoDurationCallbackData(PAIR_EURUSD.id, 300);
    await press(data);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoCatalogStale.value);
    expect(rowsOf(edited)).toEqual([[button(LABELS.demoRetryButton, data)]]);
  });

  it('refuses an old duration button the pair no longer admits', async () => {
    const { press, calls } = setup({ readPairs: catalogOf({ ...PAIR_EURUSD, maxTimeframe: 120 }) });
    await press(demoDurationCallbackData(PAIR_EURUSD.id, 300));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoDurationUnsupported(PAIR_EURUSD.symbol).value);
    expect(rowsOf(edited)).toEqual([[BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
  });

  it('refuses a pair gone from the catalog', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_SHORT) });
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 300));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoPairMissing.value);
    expect(rowsOf(edited)).toEqual([[BACK_GROUPS]]);
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
    'demo:d:0:300',
    'demo:an:2147483648:300',
  ])('stops the spinner on %s and sends nothing', async (data) => {
    const { press, calls, readPairs } = setup();
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery']);
    expect(readPairs).not.toHaveBeenCalled();
  });

  it.each(['demo:d:101:120', 'demo:t:currency:-1', 'demo:x'])(
    'does not answer %s at all: no demo pattern matches it',
    async (data) => {
      const { press, calls } = setup();
      await press(data);
      expect(calls).toEqual([]);
    },
  );
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
