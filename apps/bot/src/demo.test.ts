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
  SignalKind,
  TradeAction,
  TradeMode,
  type PairsCatalogResponse,
  type PairView,
  DEMO_CALLBACK_DATA,
} from '@binarius/shared';
import { analysisScreen, analysisUnavailableScreen } from './analysis';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  ANALYSIS_MORE_PATTERN,
  analysisMoreCallbackData,
  analysisMoreDataOf,
  DEMO_GROUPS_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  demoLaunchCallbackData,
  demoSignalsCallbackData,
  launchStakeCallbackData,
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
import { sessionCardKeyboard } from './trading-session';
import {
  ACCESS_VIEW,
  BOT_INFO,
  PAIR_15S_ONLY,
  PAIR_CLOSED,
  PAIR_EURUSD,
  PAIR_MINUTE_ONLY,
  PAIR_OTHER_TYPE,
  PAIR_SHORT,
  PAIRS_RESPONSE,
  SIGNAL_DATA_REFUSAL,
  SIGNAL_DECIDED,
  SIGNAL_DECISION,
  SIGNAL_FEATURES,
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
  sessionView,
  SESSION_VIEW,
  signalsResponse,
  signalDecided,
  type ApiCall,
  stubSessionTracker,
  stubTracker,
} from './testing';
import {
  DEMO_DURATION_LABELS,
  demoDurationsScreen,
  demoPairsScreen,
  demoSummary,
  LABELS,
  launchText,
  sessionStartButtonLabel,
  signalButtonLabel,
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
    readSignals?: BackendClient['readSignals'];
    evaluateSignal?: BackendClient['evaluateSignal'];
    readTradingAccess?: BackendClient['readTradingAccess'];
    dialog?: LoginDialogState;
    dialogClock?: { at: number };
  } = {},
) {
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
  const readSignals = vi.fn(options.readSignals ?? (() => Promise.resolve(signalsOf())));
  const evaluateSignal = vi.fn<BackendClient['evaluateSignal']>(
    options.evaluateSignal ?? (() => Promise.resolve(SIGNAL_DECIDED)),
  );
  const readTradingAccess = vi.fn<BackendClient['readTradingAccess']>(
    options.readTradingAccess ?? (() => Promise.resolve(ACCESS_VIEW)),
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
      readSignals,
      evaluateSignal,
      readTradingAccess,
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
  return {
    bot,
    readPairs,
    readSignals,
    evaluateSignal,
    readTradingAccess,
    logger,
    loginDialog,
    press,
    ...api,
  };
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

// GET /trading/signals: the 15s list in the route's order, the 5s list empty
const signalsOf = (...signals: [number, TradeAction][]) => signalsResponse(NOW, { '15s': signals });

const MANUAL = button(LABELS.demoManualButton, DEMO_GROUPS_CALLBACK_DATA);
const BACK_DURATIONS = button(LABELS.demoBackDurationsButton, DEMO_SIGNALS_CALLBACK_DATA);
// «🔄 Обновить», «↩️ Длительность» and the manual choice under a list of that duration (#382)
const listFooter = (durationSec: 5 | 15) => [
  [button(LABELS.demoSignalsRefreshButton, demoSignalsCallbackData(durationSec))],
  [BACK_DURATIONS],
  [MANUAL],
];

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
// a message whose text is a caption: a photo, the session's summary card (#318)
const NO_TEXT: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: there is no text in the message to edit',
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

describe('the duration screen (#382)', () => {
  const ROWS = [
    [
      button(DEMO_DURATION_LABELS[15], demoSignalsCallbackData(15)),
      button(DEMO_DURATION_LABELS[5], demoSignalsCallbackData(5)),
    ],
    [MANUAL],
  ];

  it('sends the durations, 15 s first, as a new message and reads nothing', async () => {
    const { press, calls, readPairs, readSignals } = setup();
    await press(DEMO_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoChooseDurationMain.value);
    expect(plainTextOf(TEXTS.demoChooseDurationMain)).toBe(
      '📡 Сигналы сейчас\nВыбери длительность сделки — бот покажет пары, у которых есть сигнал для неё.',
    );
    expect(rowsOf(sent)).toEqual(ROWS);
    expect(rowsOf(sent)[0]?.map((b) => b.text)).toEqual(['⏱ 15 с', '⏱ 5 с']);
    expect(readSignals).not.toHaveBeenCalled();
    expect(readPairs).not.toHaveBeenCalled();
  });

  it('edits it in place on «↩️ Длительность» and on every old `demo:sig` button', async () => {
    const { press, calls, readPairs, readSignals } = setup();
    await press(DEMO_SIGNALS_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoChooseDurationMain.value);
    expect(rowsOf(edited)).toEqual(ROWS);
    expect(readSignals).not.toHaveBeenCalled();
    expect(readPairs).not.toHaveBeenCalled();
  });

  it('sends it anew when the message to edit is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(DEMO_SIGNALS_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(ROWS);
  });
});

describe('the signals screen', () => {
  // the route's order, not the catalog's; a closed pair, one that refuses 15 s, one the catalog
  // does not list and one paying below the cycle floor (US10Y at 70 %, #379) have no button
  const ROUTE = signalsOf(
    [PAIR_SHORT.id, TradeAction.Down],
    [PAIR_CLOSED.id, TradeAction.Up],
    [PAIR_EURUSD.id, TradeAction.Up],
    [PAIR_MINUTE_ONLY.id, TradeAction.Up],
    [999, TradeAction.Down],
    [PAIR_OTHER_TYPE.id, TradeAction.Down],
  );
  const ROWS = [
    [button('BTC/USD OTC · ⬇️ · 90%', demoLaunchCallbackData(PAIR_SHORT.id, 15))],
    [button('EUR/USD OTC · ⬆️ · 85%', demoLaunchCallbackData(PAIR_EURUSD.id, 15))],
    ...listFooter(15),
  ];
  const LIST_15 = demoSignalsCallbackData(15);

  it('edits the pairs with a signal for the duration in place, joined with the catalog', async () => {
    const { press, calls, readPairs, readSignals } = setup({
      readSignals: () => Promise.resolve(ROUTE),
    });
    await press(LIST_15);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoSignalsHeader({ label: '⏱ 15 с' }).value);
    expect(plainTextOf(TEXTS.demoSignalsHeader({ label: '⏱ 15 с' }))).toBe(
      '📡 Сигналы сейчас · ⏱ 15 с\nВыбери пару — бот запустит цикл сделок. Сигнал держится одну свечу (⏱ 15 с); перед каждой сделкой бот проверяет его заново.',
    );
    expect(rowsOf(edited)).toEqual(ROWS);
    expect(readSignals).toHaveBeenCalledTimes(1);
    expect(readPairs).toHaveBeenCalledTimes(1);
  });

  it('labels a pair by its symbol, the arrow of the direction and the payout', () => {
    expect(signalButtonLabel('EUR/USD OTC', TradeAction.Up, 85)).toBe('EUR/USD OTC · ⬆️ · 85%');
    expect(signalButtonLabel('EUR/USD OTC', TradeAction.Down, 85)).toBe('EUR/USD OTC · ⬇️ · 85%');
  });

  // a pair with a signal on one interval only appears on that duration's list; a pair that
  // refuses 5 s has no button on the 5 s list
  describe('per duration (#382)', () => {
    const BOTH = signalsResponse(NOW, {
      '15s': [
        [PAIR_EURUSD.id, TradeAction.Up],
        [PAIR_15S_ONLY.id, TradeAction.Down],
      ],
      '5s': [
        [PAIR_SHORT.id, TradeAction.Down],
        [PAIR_MINUTE_ONLY.id, TradeAction.Up],
        [PAIR_15S_ONLY.id, TradeAction.Up],
      ],
    });
    const CATALOG = catalogOf(PAIR_EURUSD, PAIR_SHORT, PAIR_MINUTE_ONLY, PAIR_15S_ONLY);

    it('joins the 5s list on `demo:sig:5`', async () => {
      const { press, calls } = setup({
        readSignals: () => Promise.resolve(BOTH),
        readPairs: CATALOG,
      });
      await press(demoSignalsCallbackData(5));

      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }).value);
      expect(rowsOf(edited)).toEqual([
        [button('BTC/USD OTC · ⬇️ · 90%', demoLaunchCallbackData(PAIR_SHORT.id, 5))],
        ...listFooter(5),
      ]);
    });

    // #379: the 5 s list joins through checkDemoCycle too
    it('lists no pair paying below the cycle floor on the 5s list', async () => {
      const { press, calls } = setup({
        readSignals: () =>
          Promise.resolve(
            signalsResponse(NOW, {
              '5s': [
                [PAIR_OTHER_TYPE.id, TradeAction.Down],
                [PAIR_SHORT.id, TradeAction.Down],
              ],
            }),
          ),
        readPairs: catalogOf(PAIR_OTHER_TYPE, PAIR_SHORT),
      });
      await press(demoSignalsCallbackData(5));

      expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
        [button('BTC/USD OTC · ⬇️ · 90%', demoLaunchCallbackData(PAIR_SHORT.id, 5))],
        ...listFooter(5),
      ]);
    });

    it('joins the 15s list on `demo:sig:15`', async () => {
      const { press, calls } = setup({
        readSignals: () => Promise.resolve(BOTH),
        readPairs: CATALOG,
      });
      await press(LIST_15);

      expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
        [button('EUR/USD OTC · ⬆️ · 85%', demoLaunchCallbackData(PAIR_EURUSD.id, 15))],
        [button('NZD/USD OTC · ⬇️ · 83%', demoLaunchCallbackData(PAIR_15S_ONLY.id, 15))],
        ...listFooter(15),
      ]);
    });
  });

  it('sends the screen anew when the message to refresh is gone', async () => {
    const { press, calls, apiErrors } = setup({ readSignals: () => Promise.resolve(ROUTE) });
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(LIST_15);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(ROWS);
  });

  it('names the duration when no signal is left after the join, with the refresh, the durations and the manual choice', async () => {
    const { press, calls } = setup({
      readSignals: () => Promise.resolve(signalsOf([PAIR_CLOSED.id, TradeAction.Up])),
    });
    await press(LIST_15);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoSignalsEmpty({ label: '⏱ 15 с' }).value);
    expect(plainTextOf(TEXTS.demoSignalsEmpty({ label: '⏱ 5 с' }))).toBe(
      '📡 Для ⏱ 5 с сигналов сейчас нет — обнови через несколько секунд, выбери другую длительность или пару вручную.',
    );
    expect(rowsOf(edited)).toEqual(listFooter(15));
  });

  it('draws no list from a catalog the backend does not call fresh', async () => {
    const { press, calls, logger } = setup({
      readSignals: () => Promise.resolve(ROUTE),
      readPairs: () => Promise.resolve(pairsResponse({ fresh: false })),
    });
    await press(LIST_15);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoCatalogStale.value);
    expect(rowsOf(edited)).toEqual([[button(LABELS.demoRetryButton, LIST_15)], [MANUAL]]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says the service is unavailable and warns by name and code when the signals are not read', async () => {
    const { press, calls, logger } = setup({
      readSignals: () =>
        Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 500 })),
    });
    await press(LIST_15);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(edited)).toEqual([[button(LABELS.demoRetryButton, LIST_15)], [MANUAL]]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['trading signals not read']);
    expect(logger.warn.mock.calls[0]?.[0]).toEqual({
      err: { name: 'BackendError', code: BackendErrorCode.HttpStatus },
      backendStatus: 500,
      backendReason: undefined,
    });
  });

  it("reads a body without the duration's list as unavailable, never as an empty list, and warns once", async () => {
    const only15 = signalsOf([PAIR_SHORT.id, TradeAction.Down]);
    const { press, calls, logger } = setup({
      readSignals: () =>
        Promise.resolve({ ...only15, lists: only15.lists.filter((l) => l.interval === '15s') }),
    });
    await press(demoSignalsCallbackData(5));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(edited)).toEqual([
      [button(LABELS.demoRetryButton, demoSignalsCallbackData(5))],
      [MANUAL],
    ]);
    expect(logger.warn.mock.calls).toEqual([[{ interval: '5s' }, 'trading signals list missing']]);
  });
});

describe('the launch screen', () => {
  const LAUNCH = demoLaunchCallbackData(PAIR_EURUSD.id, 15);
  const LAUNCH_ROWS = [
    [button(LABELS.launchCycleButton, sessionStartCallbackData(PAIR_EURUSD.id, 15))],
    [button(LABELS.stakeChangeButton, launchStakeCallbackData(PAIR_EURUSD.id, 15))],
    [button(LABELS.backToListButton, demoSignalsCallbackData(15))],
  ];

  it('shows the pair at 15 s, the amount in effect and the cycle, in place of the list', async () => {
    const { press, calls, readSignals, evaluateSignal } = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ demoStake: decimalStringSchema.parse('2.5') })),
    });
    await press(LAUNCH);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(
      launchText({
        firstName: USER.first_name,
        durationSec: 15,
        symbol: PAIR_EURUSD.symbol,
        amount: decimalStringSchema.parse('2.5'),
        trades: 5,
      }).value,
    );
    expect(
      plainTextOf(
        launchText({
          firstName: USER.first_name,
          durationSec: 15,
          symbol: 'EUR/USD OTC',
          amount: decimalStringSchema.parse('2.5'),
          trades: 5,
        }),
      ),
    ).toBe(
      '🎯 EUR/USD OTC · ⏱ 15 с\n💵 Ставка: $2.50\n🤖 Бот проведёт 5 сделок подряд и перед каждой проверит сигнал. Это демо: деньги не нужны.',
    );
    expect(rowsOf(edited)).toEqual(LAUNCH_ROWS);
    // the signal is not read again: the cycle asks for it before each trade
    expect(readSignals).not.toHaveBeenCalled();
    expect(evaluateSignal).not.toHaveBeenCalled();
  });

  it('keeps the 5 s of its data in the session, the picker, the way back and the subject (#382)', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ demoStake: decimalStringSchema.parse('2.5') })),
    });
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5));

    const edited = payloadOf(calls, 'editMessageText');
    expect(rowsOf(edited)).toEqual([
      [button(LABELS.launchCycleButton, `demo:sess:${String(PAIR_EURUSD.id)}:5`)],
      [button(LABELS.stakeChangeButton, `stk:o:p:${String(PAIR_EURUSD.id)}:5`)],
      [button(LABELS.backToListButton, 'demo:sig:5')],
    ]);
    expect(
      plainTextOf(
        launchText({
          firstName: USER.first_name,
          durationSec: 5,
          symbol: 'EUR/USD OTC',
          amount: decimalStringSchema.parse('2.5'),
          trades: 5,
        }),
      ),
    ).toBe(
      '🎯 EUR/USD OTC · ⏱ 5 с\n💵 Ставка: $2.50\n🤖 Бот проведёт 5 сделок подряд и перед каждой проверит сигнал. Это демо: деньги не нужны.',
    );
    expect(edited?.text).toContain('EUR/USD OTC · ⏱ 5 с');
  });

  // #121: cycles are demo only; in real mode the launch leads to the pair's analysis, whose «➕ Ещё»
  // opens the single real trade
  it('shows a user in real mode the single trade in place of the cycle and the picker', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await press(LAUNCH);
    const edited = payloadOf(calls, 'editMessageText');
    expect(rowsOf(edited)).toEqual([
      [button(LABELS.modeAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 15))],
      [button(LABELS.backToListButton, demoSignalsCallbackData(15))],
    ]);
    expect(plainTextOf(TEXTS.launchRealMode)).toBe(
      '💼 Циклы — только в демо; в реальном режиме — разовая сделка по анализу.',
    );
    expect(edited?.text).toContain(TEXTS.launchRealMode.value);
    expect(edited?.text).not.toContain('Бот проведёт');
    // decision 22: no stake line in real mode
    expect(plainTextOf(edited?.text as string)).toBe(
      `🎯 ${PAIR_EURUSD.symbol} · ⏱ 15 с\n${plainTextOf(TEXTS.launchRealMode)}`,
    );
  });

  it('keeps the demo launch when access cannot say the mode', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(LAUNCH);
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual(LAUNCH_ROWS);
  });

  it('starts a 15 s session of the pair from «🚀 Запустить цикл»', () => {
    const data = LAUNCH_ROWS[0]?.[0]?.callback_data ?? '';
    expect(sessionStartDataOf(SESSION_START_PATTERN.exec(data) ?? '')).toEqual({
      assetId: PAIR_EURUSD.id,
      durationSec: 15,
    });
  });

  it('draws the stake line without an amount and warns when access is not read', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(LAUNCH);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(
      launchText({
        firstName: USER.first_name,
        durationSec: 15,
        symbol: PAIR_EURUSD.symbol,
        amount: null,
        trades: 5,
      }).value,
    );
    expect(edited?.text).toContain(
      TEXTS.launchStakeMinimum({ firstName: USER.first_name, stake: null }).value,
    );
    expect(rowsOf(edited)).toEqual(LAUNCH_ROWS);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'trading access not read for the stake label',
    ]);
  });

  it('refuses a pair that closed after the list was drawn', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_CLOSED.id, 15));

    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      TEXTS.demoPairClosed({ symbol: PAIR_CLOSED.symbol }).value,
    );
  });

  it('refuses a pair that does not take the duration', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_MINUTE_ONLY.id, 15));

    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      TEXTS.demoDurationUnsupported({ symbol: PAIR_MINUTE_ONLY.symbol }).value,
    );
  });

  // #379: no cycle on a pair paying less than the floor at either duration of the list; the
  // manual path still trades it once
  it.each([15, 5] as const)(
    'refuses a pair paying below the cycle floor at %i s, with its list and the manual choice',
    async (durationSec) => {
      const { press, calls } = setup();
      await press(demoLaunchCallbackData(PAIR_OTHER_TYPE.id, durationSec));

      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(
        TEXTS.demoPayoutTooLow({
          symbol: 'US10Y',
          payout: '70',
          payoutFloor: '80',
          breakEven: '58.8',
        }).value,
      );
      expect(
        plainTextOf(
          TEXTS.demoPayoutTooLow({
            symbol: 'US10Y',
            payout: '70',
            payoutFloor: '80',
            breakEven: '58.8',
          }),
        ),
      ).toBe(
        '🚫 US10Y: выплата 70% — ниже 80%, цикл на этой паре не запускается. Безубыточность при такой выплате — 58.8% верных прогнозов.',
      );
      expect(rowsOf(edited)).toEqual([
        [button(LABELS.backToListButton, demoSignalsCallbackData(durationSec))],
        [MANUAL],
      ]);
    },
  );

  it.each([15, 5] as const)(
    'launches a pair paying exactly 80 percent at %i s',
    async (durationSec) => {
      const { press, calls } = setup({
        readPairs: () =>
          Promise.resolve(pairsResponse({ pairs: [{ ...PAIR_EURUSD, payout: 80 }] })),
      });
      await press(demoLaunchCallbackData(PAIR_EURUSD.id, durationSec));

      expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
        [button(LABELS.launchCycleButton, sessionStartCallbackData(PAIR_EURUSD.id, durationSec))],
        [button(LABELS.stakeChangeButton, launchStakeCallbackData(PAIR_EURUSD.id, durationSec))],
        [button(LABELS.backToListButton, demoSignalsCallbackData(durationSec))],
      ]);
    },
  );

  it('only stops the spinner on an id the backend would refuse', async () => {
    const { press, calls, readPairs } = setup();
    await press('demo:l:0:15');

    expect(methods(calls)).toEqual(['answerCallbackQuery']);
    expect(readPairs).not.toHaveBeenCalled();
  });

  it('keeps its data inside the Bot API 64 bytes', () => {
    const MAX_ID = 2_147_483_647;
    expect(Buffer.byteLength(demoLaunchCallbackData(MAX_ID, 15))).toBe(20);
    expect(Buffer.byteLength(launchStakeCallbackData(MAX_ID, 15))).toBe(21);
    expect(Buffer.byteLength(demoSignalsCallbackData(15))).toBe(11);
    expect(Buffer.byteLength(DEMO_SIGNALS_CALLBACK_DATA)).toBe(8);
  });
});

describe('the types screen', () => {
  it('edits the message to the types present, each with its count of open pairs', async () => {
    const { press, calls, readPairs } = setup();
    await press(DEMO_GROUPS_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const sent = payloadOf(calls, 'editMessageText');
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
    await press(DEMO_GROUPS_CALLBACK_DATA);

    const sent = payloadOf(calls, 'editMessageText');
    expect(sent?.text).toBe(TEXTS.demoCatalogUnavailable.value);
    expect(rowsOf(sent)).toEqual([[button(LABELS.demoRetryButton, DEMO_GROUPS_CALLBACK_DATA)]]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says the service is unavailable, offers the retry and warns when the read fails', async () => {
    const { press, calls, logger } = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(DEMO_GROUPS_CALLBACK_DATA);

    const sent = payloadOf(calls, 'editMessageText');
    expect(sent?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(sent)).toEqual([[button(LABELS.demoRetryButton, DEMO_GROUPS_CALLBACK_DATA)]]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['demo catalog not read']);
  });

  it('reads an empty catalog as unavailable, with the retry on the types', async () => {
    const { press, calls } = setup({ readPairs: catalogOf() });
    await press(DEMO_GROUPS_CALLBACK_DATA);

    const sent = payloadOf(calls, 'editMessageText');
    expect(sent?.text).toBe(TEXTS.demoCatalogUnavailable.value);
    expect(rowsOf(sent)).toEqual([[button(LABELS.demoRetryButton, DEMO_GROUPS_CALLBACK_DATA)]]);
  });

  // #313: only the pairs that accept 5 or 15 s are listed
  it('gives no button to a type whose pairs all refuse the demo durations', async () => {
    const minuteStock = { ...PAIR_MINUTE_ONLY, id: 606, symbol: 'AAPL', type: 'stock' };
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_EURUSD, minuteStock) });
    await press(DEMO_GROUPS_CALLBACK_DATA);
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
      [button('💱 Валюты · 1', demoPageCallbackData('currency', 0))],
    ]);
  });

  it('says there is no pair for short trades when no pair accepts them, with the retry', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_MINUTE_ONLY) });
    await press(DEMO_GROUPS_CALLBACK_DATA);

    const sent = payloadOf(calls, 'editMessageText');
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
    await press(DEMO_GROUPS_CALLBACK_DATA);

    expect(payloadOf(calls, 'editMessageText')?.text).toBe(TEXTS.demoGroups.value);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'answering the callback query failed',
    ]);
  });

  it('ignores the press outside a private chat', async () => {
    const { press, calls, readPairs, readSignals } = setup();
    for (const data of [
      DEMO_CALLBACK_DATA,
      DEMO_SIGNALS_CALLBACK_DATA,
      demoSignalsCallbackData(15),
      demoLaunchCallbackData(101, 15),
      DEMO_GROUPS_CALLBACK_DATA,
      demoAssetCallbackData(101),
    ]) {
      await press(data, 'group');
    }
    expect(calls).toEqual([]);
    expect(readPairs).not.toHaveBeenCalled();
    expect(readSignals).not.toHaveBeenCalled();
  });
});

describe('the types and their pages', () => {
  it('says a type with pairs but none open is closed by the schedule', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_CLOSED) });
    await press(DEMO_GROUPS_CALLBACK_DATA);
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
      [button('💱 Валюты · 0', demoPageCallbackData('currency', 0))],
    ]);

    await press(demoPageCallbackData('currency', 0));
    const edited = calls.filter((call) => call.method === 'editMessageText').at(-1)?.payload;
    expect(edited?.text).toBe(TEXTS.demoGroupClosed({ group: '💱 Валюты' }).value);
    expect(rowsOf(edited)).toEqual([[BACK_GROUPS]]);
  });

  // #313 review m1: a type whose pairs all refuse the durations has no button, yet an old
  // «💱 Валюты» button or «↩️ Активы» from a pair that admits none still reach its page
  it('says there is no pair for short trades on the page of a type whose pairs all refuse them', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_MINUTE_ONLY) });
    await press(demoAssetCallbackData(PAIR_MINUTE_ONLY.id));
    const back = rowsOf(payloadOf(calls, 'editMessageText'))[0]?.[0];
    expect(back).toEqual(button(LABELS.demoBackPairsButton, demoPageCallbackData('currency', 0)));

    await press(back?.callback_data ?? '');
    const edited = calls.filter((call) => call.method === 'editMessageText').at(-1)?.payload;
    expect(edited?.text).toBe(TEXTS.demoNoShortPairs.value);
    expect(rowsOf(edited)).toEqual([[BACK_GROUPS]]);
  });

  it('reads an empty catalog as unavailable on an old page button too', async () => {
    const { press, calls } = setup({ readPairs: catalogOf() });
    await press(demoPageCallbackData('currency', 0));
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoCatalogUnavailable.value);
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
    expect(edited?.text).toBe(TEXTS.demoNoDuration({ symbol: PAIR_SHORT.symbol }).value);
    expect(rowsOf(edited)).toEqual([
      [button(LABELS.demoBackPairsButton, demoPageCallbackData('cryptocurrency', 0)), BACK_GROUPS],
    ]);
  });

  it('checks the pair again: one closed since its page was drawn is refused', async () => {
    const { press, calls } = setup();
    await press(demoAssetCallbackData(PAIR_CLOSED.id));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoPairClosed({ symbol: PAIR_CLOSED.symbol }).value);
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
      TEXTS.demoPairClosed({ symbol: PAIR_EURUSD.symbol }).value,
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
    expect(edited?.text).toBe(TEXTS.demoDurationUnsupported({ symbol: PAIR_EURUSD.symbol }).value);
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
  const MORE = button(
    LABELS.analysisMoreButton,
    analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, true),
  );

  it('fingerprints the canonical amount, so a spelling never decides a mismatch', () => {
    expect(stakeFingerprint(decimalStringSchema.parse('5.00000000'), TradeMode.Demo)).toBe(
      stakeFingerprint(decimalStringSchema.parse('5'), TradeMode.Demo),
    );
    expect(stakeFingerprint(decimalStringSchema.parse('5'), TradeMode.Demo)).not.toBe(
      stakeFingerprint(decimalStringSchema.parse('5.01'), TradeMode.Demo),
    );
    expect(stakeFingerprint(null, TradeMode.Demo)).toMatch(/^[0-9a-f]{6}$/);
  });

  // #121: a button drawn in one mode never matches a press in the other
  it('fingerprints the mode with the amount', () => {
    const one = decimalStringSchema.parse('1');
    expect(stakeFingerprint(one, TradeMode.Demo)).not.toBe(stakeFingerprint(one, TradeMode.Real));
    expect(stakeFingerprint(one, TradeMode.Real)).toBe(
      stakeFingerprint(decimalStringSchema.parse('1.00000000'), TradeMode.Real),
    );
  });
  const resultOf = (response = SIGNAL_DECIDED) =>
    analysisScreen({ pair: PAIR_EURUSD, durationSec: 5, response }).text.value;
  const edits = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'editMessageText');

  // #360: the session first, the single trade behind «➕ Ещё»; the amount is read at the expansion
  it('reads the catalog, shows «⏳», asks for the signal, then shows it with the session first', async () => {
    const { press, calls, readPairs, evaluateSignal, readTradingAccess } = setup();
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'editMessageText']);
    const [waiting, result] = edits(calls);
    expect(waiting?.payload.text).toBe(TEXTS.analyzing({ subject: 'EUR/USD OTC · ⏱ 5 с' }).value);
    // without a keyboard the edit removes the summary's, so «📊 Анализ» cannot be pressed twice
    expect(waiting?.payload.reply_markup).toBeUndefined();
    expect(result?.payload.text).toBe(resultOf());
    expect(rowsOf(result?.payload)).toEqual([
      [SESSION],
      [MORE],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
    expect(readPairs).toHaveBeenCalledTimes(1);
    expect(evaluateSignal.mock.calls).toEqual([[PAIR_EURUSD.id, '5s']]);
    // the user's mode decides the session row (#121)
    expect(readTradingAccess.mock.calls).toEqual([['4242']]);
  });

  // #121: cycles are demo only, so a user in real mode gets «➕ Ещё» and no session row
  it('draws no session row for a user in real mode', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await press(DATA);
    expect(rowsOf(edits(calls).at(-1)?.payload)).toEqual([
      [MORE],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
  });

  it('draws the session row when access cannot say the mode, and warns', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(DATA);
    expect(rowsOf(edits(calls).at(-1)?.payload)[0]).toEqual([SESSION]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'trading access not read for the stake label',
    ]);
  });

  it('carries the direction of the signal in «➕ Ещё»', async () => {
    const { press, calls } = setup({
      evaluateSignal: () =>
        Promise.resolve(
          signalDecided({
            kind: SignalKind.Signal,
            version: SIGNAL_DECISION.version,
            action: TradeAction.Down,
            features: SIGNAL_FEATURES,
          }),
        ),
    });
    await press(DATA);
    expect(rowsOf(edits(calls).at(-1)?.payload)[1]).toEqual([
      button(
        LABELS.analysisMoreButton,
        analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Down, true),
      ),
    ]);
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
      TEXTS.demoPairClosed({ symbol: PAIR_CLOSED.symbol }).value,
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
  ] as const)('offers the session first at %i s on a signal: %s', async (durationSec, shown) => {
    const { press, calls } = setup();
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, durationSec));
    const session = button(
      sessionStartButtonLabel(5),
      sessionStartCallbackData(PAIR_EURUSD.id, durationSec),
    );
    const rows = rowsOf(edits(calls).at(-1)?.payload);
    expect(rows.some((row) => row.length === 1 && row[0]?.text === session.text)).toBe(shown);
    if (shown) expect(rows[0]).toEqual([session]);
  });

  // #379: the analysis and the single trade stay on a pair below the floor; the session does not
  it('offers no session on a pair paying below the cycle floor, and says why', async () => {
    const low = { ...PAIR_EURUSD, payout: 79 };
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ pairs: [low] })),
    });
    await press(DATA);
    const result = edits(calls).at(-1)?.payload;
    expect(result?.text).toBe(
      analysisScreen({ pair: low, durationSec: 5, response: SIGNAL_DECIDED }).text.value,
    );
    expect(plainTextOf(TEXTS.analysisCycleUnavailable({ payoutFloor: '80' }))).toBe(
      '🚫 Цикл на этой паре не запускается: выплата ниже 80%.',
    );
    // the note closes the payout block, before the disclaimer
    expect(
      plainTextOf(analysisScreen({ pair: low, durationSec: 5, response: SIGNAL_DECIDED }).text),
    ).toContain('верных прогнозов.\n🚫 Цикл на этой паре не запускается: выплата ниже 80%.\n\n⚠️');
    expect(rowsOf(result)).toEqual([
      [
        button(
          LABELS.analysisMoreButton,
          analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, false),
        ),
      ],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
  });

  it('offers the session first on a pair paying exactly the cycle floor, with no note', async () => {
    const floor = { ...PAIR_EURUSD, payout: 80 };
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ pairs: [floor] })),
    });
    await press(DATA);
    const result = edits(calls).at(-1)?.payload;
    expect(result?.text).not.toContain('Цикл на этой паре не запускается');
    expect(rowsOf(result)).toEqual([
      [SESSION],
      [MORE],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
  });

  // #379: a refusal below the floor draws no session row either; the note is the last line
  it.each([
    ['a rule refusal', 79, false, SIGNAL_NO_SIGNAL],
    ['a rule refusal', 80, true, SIGNAL_NO_SIGNAL],
    ['a data refusal', 79, false, SIGNAL_DATA_REFUSAL],
    ['a data refusal', 80, true, SIGNAL_DATA_REFUSAL],
  ] as const)(
    'on %s at %i percent offers the session: %s',
    async (_case, payout, offered, response) => {
      const pair = { ...PAIR_EURUSD, payout };
      const { press, calls } = setup({
        readPairs: () => Promise.resolve(pairsResponse({ pairs: [pair] })),
        evaluateSignal: () => Promise.resolve(response),
      });
      await press(DATA);
      const result = edits(calls).at(-1)?.payload;
      expect(result?.text).toBe(analysisScreen({ pair, durationSec: 5, response }).text.value);
      const note = plainTextOf(TEXTS.analysisCycleUnavailable({ payoutFloor: '80' }));
      const text = plainTextOf(analysisScreen({ pair, durationSec: 5, response }).text);
      if (offered) expect(text).not.toContain(note);
      else expect(text.endsWith(`\n${note}`)).toBe(true);
      expect(rowsOf(result)).toEqual([
        ...(offered ? [[SESSION]] : []),
        [REPEAT],
        [BACK_EURUSD_DURATIONS, BACK_GROUPS],
      ]);
    },
  );

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

  // the guard of the #313 addendum: every duration of the set fits DEFAULT_SESSION_TRADES, so
  // the count is passed in to reach it
  it('starts nothing when the session does not fit the hour', () => {
    const match = SESSION_START_PATTERN.exec(sessionStartCallbackData(PAIR_EURUSD.id, 15)) ?? '';
    expect(sessionStartDataOf(match, 100)).toBeUndefined();
    expect(sessionStartDataOf(match)).toEqual({ assetId: PAIR_EURUSD.id, durationSec: 15 });
  });

  // #360: no signal still offers the session, which waits for a signal itself; candles not read
  // offer none, since its first trade would wait on the same failure
  it.each([
    ['a rule refusal', SIGNAL_NO_SIGNAL, true],
    ['a data refusal', SIGNAL_DATA_REFUSAL, true],
    ['the broker rate-limiting the candles', SIGNAL_FETCH_FAILED, false],
  ])(
    'shows %s with no «➕ Ещё», the session row only where the candles were read, and no warning',
    async (_case, response, session) => {
      const { press, calls, logger } = setup({ evaluateSignal: () => Promise.resolve(response) });
      await press(DATA);

      const result = edits(calls).at(-1)?.payload;
      expect(result?.text).toBe(resultOf(response));
      expect(rowsOf(result)).toEqual([
        ...(session ? [[SESSION]] : []),
        [REPEAT],
        [BACK_EURUSD_DURATIONS, BACK_GROUPS],
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('says under a rule refusal that the session waits for a signal itself', async () => {
    const { press, calls } = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
    await press(DATA);
    expect(edits(calls).at(-1)?.payload.text).toContain(
      'Без сигнала разовую сделку бот не предлагает. Автосессия дождётся сигнала сама — или повтори анализ позже.',
    );
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

    const result = edits(calls).at(-1)?.payload;
    expect(result?.text).toBe(analysisUnavailableScreen(PAIR_EURUSD, 5).text.value);
    expect(rowsOf(result)).toEqual([[REPEAT], [BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
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
    expect(waiting?.payload.text).toBe(TEXTS.analyzing({ subject: 'EUR/USD OTC · ⏱ 5 с' }).value);
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

// #360: «➕ Ещё» draws the single trade's row in place of the collapsed keyboard
describe('«➕ Ещё» under the analysis', () => {
  const DATA = analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, true);
  const REPEAT = button(LABELS.repeatAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
  const SESSION = button('🚀 Сессия из 5 сделок', sessionStartCallbackData(PAIR_EURUSD.id, 5));
  const STAKE_MENU = button(LABELS.stakeMenuButton, stakeMenuCallbackData(PAIR_EURUSD.id, 5));
  const expandedOf = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'editMessageReplyMarkup');
  const stakeRowOf = (calls: readonly ApiCall[]) => rowsOf(expandedOf(calls).at(-1)?.payload)[1];
  const stakeOf = (data: string | undefined) =>
    stakeDataOf(STAKE_CALLBACK_PATTERN.exec(data ?? '') ?? '');
  const NOT_MODIFIED_MARKUP: ApiError = {
    ok: false,
    error_code: 400,
    description:
      'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
  };

  it('reads access and edits only the keyboard of the pressed message: the stake row joins it', async () => {
    const { press, calls, readPairs, evaluateSignal, readTradingAccess } = setup();
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    const [edit] = expandedOf(calls);
    expect(edit?.payload.text).toBeUndefined();
    const [[session], [stake, menu], ...rest] = rowsOf(edit?.payload);
    expect(session).toEqual(SESSION);
    // the amount the press trades: no saved stake, so the broker's minimum (#297)
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Up, '1.00000000'));
    expect(stake?.text).toContain('$1.00');
    expect(menu).toEqual(STAKE_MENU);
    // the nonce is drawn per expansion (#127); everything before it is the pressed pair
    expect(stakeOf(stake?.callback_data)).toEqual({
      assetId: PAIR_EURUSD.id,
      durationSec: 5,
      action: TradeAction.Up,
      nonce: expect.stringMatching(/^[0-9a-f]{12}$/),
      fingerprint: STAKE_FINGERPRINT,
    });
    expect(rest).toEqual([[REPEAT], [BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
    expect(readTradingAccess.mock.calls).toEqual([[String(USER.id)]]);
    expect(readPairs).not.toHaveBeenCalled();
    expect(evaluateSignal).not.toHaveBeenCalled();
  });

  // #121: the single real trade at the broker's minimum, marked REAL, alone in its row; no
  // session row and no «💵 Сумма»
  it('draws a user in real mode the REAL stake button at the minimum and nothing else', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            tradingMode: TradeMode.Real,
            demoStake: decimalStringSchema.parse('2.5'),
          }),
        ),
    });
    await press(DATA);
    const rows = rowsOf(expandedOf(calls).at(-1)?.payload);
    const [[stake], ...rest] = rows;
    expect(rows[0]).toHaveLength(1);
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Up, '1.00000000', TradeMode.Real));
    expect(stake?.text).toBe('🚀 Открыть сделку: ⬆️ Вверх · $1.00 · REAL');
    expect(stakeOf(stake?.callback_data)?.fingerprint).toBe(
      stakeFingerprint(decimalStringSchema.parse('1'), TradeMode.Real),
    );
    expect(rest).toEqual([[REPEAT], [BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
  });

  it('draws the direction the button carries', async () => {
    const { press, calls } = setup();
    await press(analysisMoreCallbackData(PAIR_EURUSD.id, 15, TradeAction.Down, true));
    const stake = rowsOf(expandedOf(calls)[0]?.payload)[1]?.[0];
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Down, '1.00000000'));
    expect(stakeOf(stake?.callback_data)).toMatchObject({
      durationSec: 15,
      action: TradeAction.Down,
    });
  });

  // #127: two expansions are two buttons, and the nonce lets the second open a trade of its own
  it('draws a new nonce on every expansion, and nothing else changes', async () => {
    const { press, calls } = setup();
    await press(DATA);
    await press(DATA);
    const stakes = expandedOf(calls).map((call) => rowsOf(call.payload)[1]?.[0]?.callback_data);
    expect(stakes).toHaveLength(2);
    const [first, second] = stakes.map(stakeOf);
    expect(first?.nonce).toMatch(/^[0-9a-f]{12}$/);
    expect(first?.nonce).not.toBe(second?.nonce);
    expect({ ...first, nonce: '' }).toEqual({ ...second, nonce: '' });
  });

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
    expect(stakeOf(stake?.callback_data)?.fingerprint).toBe(
      stakeFingerprint(decimalStringSchema.parse('2.5'), TradeMode.Demo),
    );
    expect(stakeOf(stake?.callback_data)?.fingerprint).not.toBe(STAKE_FINGERPRINT);
    expect(menu).toEqual(STAKE_MENU);
  });

  it('drops the amount, not the button, when access cannot say it', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(DATA);
    const [stake, menu] = stakeRowOf(calls) ?? [];
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Up));
    expect(stakeOf(stake?.callback_data)?.fingerprint).toBe(stakeFingerprint(null, TradeMode.Demo));
    expect(menu).toEqual(STAKE_MENU);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'trading access not read for the stake label',
    ]);
  });

  it('draws no amount without a broker snapshot, and logs nothing', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ broker: null, brokerUnavailable: 'refreshing' })),
    });
    await press(DATA);
    const stake = stakeRowOf(calls)?.[0];
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Up));
    expect(stakeOf(stake?.callback_data)?.fingerprint).toBe(stakeFingerprint(null, TradeMode.Demo));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is done when Telegram says the keyboard already shows this', async () => {
    const { press, calls, logger, apiErrors } = setup();
    apiErrors.set('editMessageReplyMarkup', NOT_MODIFIED_MARKUP);
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(logger.info.mock.calls.map((call) => call[1])).toEqual([
      'the analysis keyboard already shows this',
    ]);
  });

  it('sends nothing when the message is gone: there is no analysis to expand', async () => {
    const { press, calls, logger, apiErrors } = setup();
    apiErrors.set('editMessageReplyMarkup', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'the analysis keyboard was not expanded',
    ]);
  });

  it('sends nothing more when the edit fails in transport', async () => {
    const { press, calls, logger, apiErrors } = setup();
    apiErrors.set(
      'editMessageReplyMarkup',
      new HttpError(
        "Network request for 'editMessageReplyMarkup' failed!",
        new Error('The operation was aborted due to timeout'),
      ),
    );
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(logger.error.mock.calls.map((call) => call[1])).toEqual([
      'the analysis keyboard edit failed in transport, sending nothing more',
    ]);
  });

  it('hands any other refusal to bot.catch with nothing sent', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageReplyMarkup', {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    const thrown = await rejectionOf(press(DATA));

    expect(thrown).toBeInstanceOf(BotError);
    expect((thrown as BotError).error).toBeInstanceOf(GrammyError);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
  });

  it('keeps the longest datum inside the Bot API limit and reads it back', () => {
    const longest = Math.max(...DEMO_DURATIONS_SEC) as (typeof DEMO_DURATIONS_SEC)[number];
    const data = analysisMoreCallbackData(2_147_483_647, longest, TradeAction.Down, false);
    expect(data).toBe('demo:more:2147483647:15:down:n');
    expect(Buffer.byteLength(data, 'utf8')).toBe(30);
    expect(analysisMoreDataOf(ANALYSIS_MORE_PATTERN.exec(data) ?? '')).toEqual({
      assetId: 2_147_483_647,
      durationSec: 15,
      action: TradeAction.Down,
      payoutAccepted: false,
    });
  });

  // #379: the floor's verdict travels in the datum, taken at the render
  it.each([
    ['s', true],
    ['n', false],
    // a button #360 drew before #379: its row stays, the press meets the route's 409
    [undefined, true],
  ] as const)(
    'reads the token %s as payoutAccepted %s and draws the session row by it',
    async (token, accepted) => {
      const { press, calls } = setup();
      await press(
        `demo:more:${String(PAIR_EURUSD.id)}:5:up${token === undefined ? '' : `:${token}`}`,
      );
      const rows = rowsOf(expandedOf(calls).at(-1)?.payload);
      expect(rows.some((row) => row.some((b) => b.text === SESSION.text))).toBe(accepted);
      if (accepted) expect(rows[0]).toEqual([SESSION]);
      else expect(rows[0]?.[1]).toEqual(STAKE_MENU);
    },
  );

  it('does nothing outside a private chat', async () => {
    const { press, calls, readTradingAccess } = setup();
    await press(DATA, 'group');
    expect(calls).toEqual([]);
    expect(readTradingAccess).not.toHaveBeenCalled();
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
    'demo:l:0:5',
    'demo:more:0:5:up',
    'demo:more:2147483648:15:down',
  ])('stops the spinner on %s and sends nothing', async (data) => {
    const { press, calls, readPairs, readTradingAccess } = setup();
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery']);
    expect(readPairs).not.toHaveBeenCalled();
    expect(readTradingAccess).not.toHaveBeenCalled();
  });

  // a duration outside DEMO_DURATIONS_SEC matches no pattern (#125 review m5)
  it.each([
    'demo:d:101:120',
    'demo:an:101:120',
    'demo:stake:101:120:up:0123456789ab',
    'demo:stake:101:5:sideways:0123456789ab',
    'demo:stake:101:5:up',
    'demo:sess:101:120',
    'demo:sig:60',
    'demo:sig:',
    'demo:l:101:60',
    'demo:more:101:60:up',
    'demo:more:101:5:flat',
    'demo:more:101:5',
    'demo:more:101:5:up:x',
    'demo:more:101:5:up:',
    'stk:o:a:101:120',
    'stk:o:p:101:60',
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

  // #382: the launch screen and its picker carried no duration (every such screen was 15 s)
  it.each(['demo:l:101', 'stk:o:p:101', 'stk:s:2.5:p:101', 'stk:z:p:101', 'stk:c:p:101'])(
    '%s from before #382: stops the spinner, removes the keyboard, sends nothing',
    async (data) => {
      const { press, calls, readPairs, readSignals, logger } = setup();
      await press(data);
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
      expect(payloadOf(calls, 'editMessageReplyMarkup')?.reply_markup).toBeUndefined();
      expect(readPairs).not.toHaveBeenCalled();
      expect(readSignals).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each(LEGACY)('%s: stops the spinner, removes the keyboard, sends nothing', async (data) => {
    const { press, calls, readPairs, evaluateSignal, logger } = setup();
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(payloadOf(calls, 'editMessageReplyMarkup')?.reply_markup).toBeUndefined();
    expect(readPairs).not.toHaveBeenCalled();
    expect(evaluateSignal).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // the demo's and the picker's legacy handlers share the line, so it names the pressed data
  it.each(['demo:an:101:300', 'stk:o:a:101:300'])(
    '%s: logs a refused removal at info with the pressed data and sends nothing',
    async (data) => {
      const { press, calls, apiErrors, logger } = setup();
      apiErrors.set('editMessageReplyMarkup', {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      });
      await press(data);
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
      expect(logger.info.mock.calls.map((call) => call[1])).toEqual([
        'the keyboard of an old button was not removed',
      ]);
      expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
        method: 'editMessageReplyMarkup',
        telegramErrorCode: 400,
        callbackData: data,
      });
    },
  );

  it('logs a refused answer at warn with the pressed data and still removes the keyboard', async () => {
    const { press, calls, apiErrors, logger } = setup();
    apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: query is too old and response timeout expired',
    });
    await press('demo:d:101:300');
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'answering the callback query failed',
    ]);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'answerCallbackQuery',
      callbackData: 'demo:d:101:300',
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

// #318: the summary card is a photo, so a button under it that edits the pressed message is
// refused with «there is no text in the message to edit»; the screen then goes as a new message.
describe('a press under the session card (a photo)', () => {
  const editsOf = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'editMessageText');
  const sendsOf = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'sendMessage');
  // the card's buttons that edit the pressed message: «🔁 Ещё сессия» replies (K7 in
  // trading-session.test.ts) and «🏠 В меню» replies too
  const editingButtons = (durationSec: number) =>
    sessionCardKeyboard(sessionView({ settings: { ...SESSION_VIEW.settings!, durationSec } }))
      .inline_keyboard.flat()
      .map((key) => ('callback_data' in key ? key.callback_data : undefined))
      .filter(
        (data): data is string =>
          data !== undefined && data.startsWith('demo:') && !data.startsWith('demo:sess:'),
      );
  const pressOnPhoto = async (data: string, options: Parameters<typeof setup>[0] = {}) => {
    const scene = setup(options);
    scene.apiErrors.set('editMessageText', NO_TEXT);
    await scene.press(data);
    expect(scene.logger.warn.mock.calls.map((call) => call[1])).toContain(
      'the demo screen was not edited, sending it anew',
    );
    expect(scene.logger.error).not.toHaveBeenCalled();
    return scene;
  };

  it('pins the buttons this covers; a button added to the card needs its press here', () => {
    expect(editingButtons(15)).toEqual([
      demoAnalysisCallbackData(PAIR_EURUSD.id, 15),
      demoSignalsCallbackData(15),
    ]);
    expect(editingButtons(60)).toEqual([DEMO_SIGNALS_CALLBACK_DATA]);
  });

  it('C1 «📡 К сигналам» sends the signals of the duration as a new message', async () => {
    const { calls, logger } = await pressOnPhoto(demoSignalsCallbackData(15));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoSignalsEmpty({ label: '⏱ 15 с' }).value);
    expect(rowsOf(sent)).toEqual(listFooter(15));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'editMessageText',
      telegramErrorCode: 400,
    });
  });

  it('C2 «📡 К сигналам» on a duration no longer offered sends the duration screen anew', async () => {
    const { calls } = await pressOnPhoto(DEMO_SIGNALS_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoChooseDurationMain.value);
    expect(rowsOf(sent)).toEqual(rowsOf(payloadOf(calls, 'editMessageText')));
  });

  it('C3 «📊 Новый анализ» sends «⏳» anew, asks for the signal once, and sends the result after it', async () => {
    const { calls, evaluateSignal } = await pressOnPhoto(
      demoAnalysisCallbackData(PAIR_EURUSD.id, 15),
    );
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendMessage',
      'sendMessage',
    ]);
    expect(editsOf(calls)).toHaveLength(1);
    expect(evaluateSignal).toHaveBeenCalledTimes(1);
    const [waiting, result] = sendsOf(calls);
    expect(waiting?.payload.text).toBe(TEXTS.analyzing({ subject: 'EUR/USD OTC · ⏱ 15 с' }).value);
    expect(waiting?.payload.reply_markup).toBeUndefined();
    expect(result?.payload.text).toBe(
      analysisScreen({ pair: PAIR_EURUSD, durationSec: 15, response: SIGNAL_DECIDED }).text.value,
    );
    expect(rowsOf(result?.payload).flat()).toContainEqual(
      button(LABELS.repeatAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 15)),
    );
  });

  it('C4 «📊 Новый анализ» with the catalog unreadable sends the failure screen anew', async () => {
    const { calls, evaluateSignal } = await pressOnPhoto(
      demoAnalysisCallbackData(PAIR_EURUSD.id, 15),
      { readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)) },
    );
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    const edited = payloadOf(calls, 'editMessageText');
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(edited?.text);
    expect(sent?.reply_markup).toEqual(edited?.reply_markup);
    expect(evaluateSignal).not.toHaveBeenCalled();
  });
});
