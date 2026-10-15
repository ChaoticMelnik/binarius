import { BotError, GrammyError, HttpError, InputFile } from 'grammy';
import type { ApiError } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import {
  pairLabel,
  BrokerBalanceUnavailableReason,
  BrokerRestErrorCode,
  createTradeIntentRequestSchema,
  decimalStringSchema,
  PAIR_TYPE_GROUPS,
  PairsCatalogErrorCode,
  plainTextOf,
  SignalFeedOutcome,
  SignalKind,
  TradeAction,
  TradeMode,
  type PairsCatalogResponse,
  type PairView,
  UserStatus,
  DEMO_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  demoSignalsCallbackData,
} from '@binarius/shared';
import { analysisScreen, analysisUnavailableScreen } from './analysis';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  ANALYSIS_MORE_PATTERN,
  analysisMoreCallbackData,
  analysisMoreDataOf,
  cycleCustomCallbackData,
  cycleStakeCallbackData,
  DEMO_GROUPS_CALLBACK_DATA,
  demoLaunchCallbackData,
  effectiveStake,
  launchStakeCallbackData,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  demoDurationCallbackData,
  demoPageCallbackData,
  SESSION_START_PATTERN,
  sessionStartCallbackData,
  sessionStartDataOf,
  SIGNALS_LIST_SIZE,
  signalsShown,
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
  CASHIER_URL,
  PAIR_15S_ONLY,
  PAIR_CLOSED,
  PAIR_EURUSD,
  PAIR_EURUSD_REGULAR,
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
  CARD_MESSAGE_ID,
  USER,
  accessView,
  brokerBalance,
  callbackUpdate,
  captureApi,
  fakeBackend,
  failFromSecondCall,
  fakeLogger,
  messageAnswer,
  pairsResponse,
  photoAnswer,
  photoCallbackUpdate,
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
  api.answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, ['card-small', CARD_FILE_ID]));
  const press = (data: string, chatType?: string) =>
    bot.handleUpdate(callbackUpdate(data, chatType));
  const pressOnPhoto = (data: string) => bot.handleUpdate(photoCallbackUpdate(data));
  return {
    bot,
    readPairs,
    readSignals,
    evaluateSignal,
    readTradingAccess,
    logger,
    loginDialog,
    press,
    pressOnPhoto,
    ...api,
  };
}

// the file_id the card's sendPhoto answers with, its largest size (#482)
const CARD_FILE_ID = 'card-file-id';

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
// «🔄 Обновить» and «↩️ Длительность» in one row, the manual choice in its own, under a list of
// that duration (#382, #419)
const listFooter = (durationSec: 5 | 15) => [
  [button(LABELS.demoSignalsRefreshButton, demoSignalsCallbackData(durationSec)), BACK_DURATIONS],
  [MANUAL],
];

const BACK_GROUPS = button(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
const BACK_EURUSD_PAGE = button(LABELS.demoBackPairsButton, demoPageCallbackData('currency', 0));
const BACK_EURUSD_DURATIONS = button(
  LABELS.demoBackDurationsButton,
  demoAssetCallbackData(PAIR_EURUSD.id),
);

const TRANSPORT = (method: string) =>
  new HttpError(
    `Network request for '${method}' failed!`,
    new Error('The operation was aborted due to timeout'),
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
  isOtc: false,
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
  // by type (#460): EUR/USD's currency before BTC/USD's cryptocurrency, though the route sends
  // BTC/USD first and it pays more; a closed pair, one that refuses 15 s, one the catalog does not
  // list and one paying below the cycle floor (US10Y at 70 %, #379) have no button
  const ROUTE = signalsOf(
    [PAIR_SHORT.id, TradeAction.Down],
    [PAIR_CLOSED.id, TradeAction.Up],
    [PAIR_EURUSD.id, TradeAction.Up],
    [PAIR_MINUTE_ONLY.id, TradeAction.Up],
    [999, TradeAction.Down],
    [PAIR_OTHER_TYPE.id, TradeAction.Down],
  );
  const ROWS = [
    [
      button('EUR/USD OTC ⬆️ 85%', demoLaunchCallbackData(PAIR_EURUSD.id, 15)),
      button('BTC/USD OTC ⬇️ 90%', demoLaunchCallbackData(PAIR_SHORT.id, 15)),
    ],
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
      '📡 Сигналы сейчас · ⏱ 15 с\nВыбери пару. Сигнал держится одну свечу (⏱ 15 с), поэтому перед сделкой бот проверяет его заново.',
    );
    expect(rowsOf(edited)).toEqual(ROWS);
    expect(readSignals).toHaveBeenCalledTimes(1);
    expect(readPairs).toHaveBeenCalledTimes(1);
  });

  // #460: up to two pairs of each type, the free places filled by payout, grouped by type. The
  // lists compare pairs, not rows, so a layout of two buttons a row (#419) leaves them standing.
  describe('the choice of pairs (#460)', () => {
    // a broker type for each group; `bond` is one the broker does not list, so `other`
    const BROKER_TYPE = ['currency', 'commodity', 'stock', 'cryptocurrency', 'index', 'bond'];
    const pairOf = (id: number, type: string, payout: number, patch: Partial<PairView> = {}) => ({
      ...PAIR_EURUSD,
      id,
      symbol: `S${id}`,
      isOtc: false,
      type,
      payout,
      ...patch,
    });
    const shownIds = (route: readonly number[], pairs: readonly PairView[]) =>
      signalsShown(
        route.map((assetId) => ({ assetId, action: TradeAction.Up })),
        pairsResponse({ pairs: [...pairs] }),
        15,
        NOW,
      ).map(({ pair }) => pair.id);
    const shuffle = <T>(items: readonly T[]): T[] =>
      items
        .map((item, i) => ({ item, key: (i * 7 + 3) % items.length }))
        .sort((a, b) => a.key - b.key)
        .map(({ item }) => item);

    // three of each group, currencies paying the most, the payout falling group by group
    const SIX = BROKER_TYPE.flatMap((type, g) =>
      [0, 1, 2].map((j) => pairOf(100 * (g + 1) + j, type, 95 - 2 * g - j)),
    );
    const SIX_SHOWN = BROKER_TYPE.flatMap((_, g) => [100 * (g + 1), 100 * (g + 1) + 1]);

    it('L1 takes two of every type, the types in their screen order, the best payout first', () => {
      expect(SIGNALS_LIST_SIZE).toBe(2 * PAIR_TYPE_GROUPS.length);
      expect(
        shownIds(
          SIX.map((p) => p.id),
          SIX,
        ),
      ).toEqual(SIX_SHOWN);
    });

    it('L2 fills the places a type leaves free with the best pairs of the others', () => {
      const currencies = Array.from({ length: 15 }, (_, i) => pairOf(1 + i, 'currency', 96 - i));
      const stock = pairOf(50, 'stock', 80);
      expect(shownIds([stock.id, ...currencies.map((p) => p.id)], [...currencies, stock])).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 50,
      ]);
      const few = [pairOf(1, 'currency', 85), pairOf(2, 'currency', 90), pairOf(3, 'currency', 88)];
      const crypto = pairOf(4, 'cryptocurrency', 95);
      expect(shownIds([4, 1, 2, 3], [...few, crypto])).toEqual([2, 3, 1, 4]);
    });

    it("L3 does not depend on the route's order or the catalog's", () => {
      const ids = SIX.map((p) => p.id);
      expect(shownIds([...ids].reverse(), shuffle(SIX))).toEqual(SIX_SHOWN);
      expect(shownIds(shuffle(ids), [...SIX].reverse())).toEqual(SIX_SHOWN);
    });

    it('L4 a pair the launch would refuse takes no place', () => {
      const pairs = [
        pairOf(1, 'currency', 99, { scheduledUntil: PAIR_CLOSED.scheduledUntil }),
        pairOf(2, 'currency', 95),
        pairOf(3, 'currency', 94),
        pairOf(4, 'currency', 70),
        pairOf(5, 'stock', 81),
      ];
      expect(shownIds([1, 2, 3, 4, 5], pairs)).toEqual([2, 3, 5]);
      // on a full list too: the closed best currency leaves its place to the third one
      const closedBest = SIX.map((p) =>
        p.id === 100 ? { ...p, scheduledUntil: PAIR_CLOSED.scheduledUntil } : p,
      );
      expect(
        shownIds(
          SIX.map((p) => p.id),
          closedBest,
        ),
      ).toEqual([101, 102, ...SIX_SHOWN.slice(2)]);
    });

    it('L5 an equal payout goes by id, inside a type and in the fill', () => {
      const ties = Array.from({ length: 13 }, (_, i) => pairOf(13 - i, 'currency', 85));
      expect(shownIds(shuffle(ties.map((p) => p.id)), ties)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      const two = [pairOf(9, 'stock', 85), pairOf(7, 'stock', 85), pairOf(8, 'stock', 85)];
      expect(shownIds([9, 8, 1, 7], [...two, pairOf(1, 'index', 80)])).toEqual([7, 8, 9, 1]);
    });

    it('draws the chosen pairs on the screen, in their order, above the footer', async () => {
      const { press, calls } = setup({
        readSignals: () =>
          Promise.resolve(
            signalsOf(
              ...[...SIX].reverse().map((p): [number, TradeAction] => [p.id, TradeAction.Up]),
            ),
          ),
        readPairs: catalogOf(...SIX),
      });
      await press(LIST_15);

      const buttons = rowsOf(payloadOf(calls, 'editMessageText')).flat();
      expect(buttons.slice(-3)).toEqual(listFooter(15).flat());
      expect(buttons.slice(0, -3).map((b) => b.callback_data)).toEqual(
        SIX_SHOWN.map((id) => demoLaunchCallbackData(id, 15)),
      );
    });

    // #419: two pairs a row in the list's order, across the types, the last alone when odd
    const screenRows = async (pairs: readonly PairView[], route: readonly number[]) => {
      const { press, calls } = setup({
        readSignals: () =>
          Promise.resolve(
            signalsOf(...route.map((id): [number, TradeAction] => [id, TradeAction.Up])),
          ),
        readPairs: catalogOf(...pairs),
      });
      await press(LIST_15);
      return rowsOf(payloadOf(calls, 'editMessageText'));
    };
    const pairButton = (id: number, payout: number) =>
      button(`S${String(id)} ⬆️ ${String(payout)}%`, demoLaunchCallbackData(id, 15));

    it('T2 an odd number of pairs leaves the last one alone in its row', async () => {
      const pairs = [
        pairOf(1, 'currency', 90),
        pairOf(2, 'currency', 88),
        pairOf(3, 'currency', 85),
      ];
      expect(await screenRows(pairs, [3, 1, 2])).toEqual([
        [pairButton(1, 90), pairButton(2, 88)],
        [pairButton(3, 85)],
        ...listFooter(15),
      ]);
    });

    it('T2b a row holds two types when the fill puts them side by side', async () => {
      const few = [pairOf(1, 'currency', 85), pairOf(2, 'currency', 90), pairOf(3, 'currency', 88)];
      const crypto = pairOf(4, 'cryptocurrency', 95);
      expect(await screenRows([...few, crypto], [4, 1, 2, 3])).toEqual([
        [pairButton(2, 90), pairButton(3, 88)],
        [pairButton(1, 85), pairButton(4, 95)],
        ...listFooter(15),
      ]);
    });

    it('T2c a full list is six rows of two above the footer', async () => {
      const rows = await screenRows(
        SIX,
        SIX.map((p) => p.id),
      );
      expect(rows).toHaveLength(SIGNALS_LIST_SIZE / 2 + 2);
      expect(rows.slice(0, 6).map((row) => row.length)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(rows.slice(-2)).toEqual(listFooter(15));
    });
  });

  it('labels a pair by its symbol, the arrow of the direction and the payout', () => {
    expect(signalButtonLabel(pairLabel(PAIR_EURUSD), TradeAction.Up, 85)).toBe(
      'EUR/USD OTC ⬆️ 85%',
    );
    expect(signalButtonLabel(pairLabel(PAIR_EURUSD), TradeAction.Down, 85)).toBe(
      'EUR/USD OTC ⬇️ 85%',
    );
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
        [button('BTC/USD OTC ⬇️ 90%', demoLaunchCallbackData(PAIR_SHORT.id, 5))],
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
        [button('BTC/USD OTC ⬇️ 90%', demoLaunchCallbackData(PAIR_SHORT.id, 5))],
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
        [
          button('EUR/USD OTC ⬆️ 85%', demoLaunchCallbackData(PAIR_EURUSD.id, 15)),
          button('NZD/USD OTC ⬇️ 83%', demoLaunchCallbackData(PAIR_15S_ONLY.id, 15)),
        ],
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

// #476: in demo a pair of the list, the analysis's session row, the offer under a finished trade
// and «🔁 Ещё сессия» open the amount screen; in real the launch screen stays (#327)
describe('the amount screen (#476)', () => {
  const LAUNCH = demoLaunchCallbackData(PAIR_EURUSD.id, 15);
  const amount = (value: string, label: string, back: 'l' | 'a' = 'l', durationSec: 5 | 15 = 15) =>
    button(label, cycleStakeCallbackData(PAIR_EURUSD.id, durationSec, value, back));
  const CUSTOM = button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 15, 'l'));
  const BACK_LIST = button(LABELS.backToListButton, demoSignalsCallbackData(15));
  const BACK_ANALYSIS = button(
    LABELS.stakeBackAnalysisButton,
    demoAnalysisCallbackData(PAIR_EURUSD.id, 15),
  );
  const DEFAULT_ROWS = [
    [amount('1', '$1.00 ✅'), amount('2', '$2.00'), amount('5', '$5.00')],
    [amount('10', '$10.00 · риск')],
    [CUSTOM, BACK_LIST],
  ];
  const withStake = (demoStake: string | null) =>
    setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            demoStake: demoStake === null ? null : decimalStringSchema.parse(demoStake),
          }),
        ),
    });
  const shownRows = async (demoStake: string | null) => {
    const { press, calls } = withStake(demoStake);
    await press(LAUNCH);
    return rowsOf(payloadOf(calls, 'editMessageText'));
  };

  it('shows the pair at 15 s, the cycle and the amounts in place of the list, without «🚀 Запустить цикл» (D-screen)', async () => {
    const { press, calls, readSignals, evaluateSignal } = setup();
    await press(LAUNCH);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = payloadOf(calls, 'editMessageText');
    expect(plainTextOf(edited?.text as string)).toBe(
      `🎯 ${pairLabel(PAIR_EURUSD)} · ⏱ 15 с\n🤖 Бот проведёт 5 сделок подряд и перед каждой проверит сигнал. Это демо: деньги не нужны.\n\nВыбери сумму сделки 👇`,
    );
    expect(rowsOf(edited)).toEqual(DEFAULT_ROWS);
    const labels = rowsOf(edited)
      .flat()
      .map((key) => key.text);
    expect(labels).not.toContain(LABELS.launchCycleButton);
    expect(labels).not.toContain(LABELS.stakeChangeButton);
    expect(labels).not.toContain(LABELS.stakeResetButton);
    // #509: the pair's own signal is read at the press, the list is not read again
    expect(readSignals).not.toHaveBeenCalled();
    expect(evaluateSignal.mock.calls).toEqual([[PAIR_EURUSD.id, '15s']]);
  });

  // #509: every cycle door reads the pair's signal at its press; none opens on a pair without one
  describe("the pair's signal at the press (#509)", () => {
    const OTHER_PAIR = (durationSec: 5 | 15) => [
      [button(LABELS.otherPairButton, demoSignalsCallbackData(durationSec))],
      [button(LABELS.menuButton, MENU_CALLBACK_DATA)],
    ];
    const UNAVAILABLE = (data: string) => [
      [button(LABELS.demoRetryButton, data)],
      [button(LABELS.menuButton, MENU_CALLBACK_DATA)],
    ];

    it('L-sig1 no signal refuses with «🔀 Выбрать другую пару» and the menu, no amounts', async () => {
      const { press, calls } = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
      await press(LAUNCH);
      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(TEXTS.sessionNoSignal.value);
      expect(rowsOf(edited)).toEqual(OTHER_PAIR(15));
    });

    it('L-sig2 a fetch_failed signal is «недоступно» with the same press again, never the amounts', async () => {
      const { press, calls, logger } = setup({
        evaluateSignal: () => Promise.resolve(SIGNAL_FETCH_FAILED),
      });
      await press(LAUNCH);
      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(TEXTS.sessionSignalUnavailable.value);
      expect(rowsOf(edited)).toEqual(UNAVAILABLE(LAUNCH));
      // rate_limited is the broker's ordinary answer
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('L-sig3 a signal read that throws is the same «недоступно», logged', async () => {
      const { press, calls, logger } = setup({
        evaluateSignal: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      });
      await press(LAUNCH);
      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(TEXTS.sessionSignalUnavailable.value);
      expect(rowsOf(edited)).toEqual(UNAVAILABLE(LAUNCH));
      expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
        'launch signal not evaluated',
      ]);
    });

    it('L-sig4/L-sig5 a signal opens the amounts; the read is for the duration of the press', async () => {
      const { press, calls, evaluateSignal } = setup();
      await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5));
      expect(payloadOf(calls, 'editMessageText')?.text).toContain('Выбери сумму сделки 👇');
      expect(evaluateSignal.mock.calls).toEqual([[PAIR_EURUSD.id, '5s']]);
    });

    it('L-sig6 a door under a trade or a session answers the refusal as a new message', async () => {
      const { press, calls } = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
      await press(demoLaunchCallbackData(PAIR_EURUSD.id, 15, 'n'));
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
      const sent = payloadOf(calls, 'sendMessage');
      expect(sent?.text).toBe(TEXTS.sessionNoSignal.value);
      expect(rowsOf(sent)).toEqual(OTHER_PAIR(15));
    });

    it('a pair below the floor keeps its own refusal before the signal', async () => {
      const { press, calls } = setup({
        readPairs: () =>
          Promise.resolve(pairsResponse({ pairs: [{ ...PAIR_EURUSD, payout: 79 }] })),
        evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
      });
      await press(LAUNCH);
      expect(payloadOf(calls, 'editMessageText')?.text).not.toBe(TEXTS.sessionNoSignal.value);
    });
  });

  it('keeps the 5 s of its data in the amounts, the custom amount, the way back and the subject (#382)', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5));
    const edited = payloadOf(calls, 'editMessageText');
    expect(rowsOf(edited)).toEqual([
      [amount('1', '$1.00 ✅', 'l', 5), amount('2', '$2.00', 'l', 5), amount('5', '$5.00', 'l', 5)],
      [amount('10', '$10.00 · риск', 'l', 5)],
      [
        button(LABELS.stakeCustomButton, `demo:sc:${String(PAIR_EURUSD.id)}:5:l`),
        button(LABELS.backToListButton, 'demo:sig:5'),
      ],
    ]);
    expect(edited?.text).toContain('EUR/USD OTC · ⏱ 5 с');
  });

  it('marks the broker minimum when no demo stake is saved (D-null)', async () => {
    expect((await shownRows(null))[0]?.[0]).toEqual(amount('1', '$1.00 ✅'));
  });

  it('labels $10 «· риск» in a row of its own (D-risky)', async () => {
    expect((await shownRows(null))[1]).toEqual([amount('10', '$10.00 · риск')]);
  });

  it('marks a saved preset once, without a second button (D-saved-preset)', async () => {
    const rows = await shownRows('5.00000000');
    expect(rows).toEqual([
      [amount('1', '$1.00'), amount('2', '$2.00'), amount('5', '$5.00 ✅')],
      [amount('10', '$10.00 · риск')],
      [CUSTOM, BACK_LIST],
    ]);
  });

  it('gives a saved custom amount within bounds its own ✅ button, in order (D-saved-custom)', async () => {
    expect(await shownRows('7')).toEqual([
      [amount('1', '$1.00'), amount('2', '$2.00'), amount('5', '$5.00')],
      [amount('7', '$7.00 ✅')],
      [amount('10', '$10.00 · риск')],
      [CUSTOM, BACK_LIST],
    ]);
  });

  it('puts a saved risky amount among the risky ones (D-risky-saved)', async () => {
    expect(await shownRows('15')).toEqual([
      [amount('1', '$1.00'), amount('2', '$2.00'), amount('5', '$5.00')],
      [amount('10', '$10.00 · риск'), amount('15', '$15.00 ✅ · риск')],
      [CUSTOM, BACK_LIST],
    ]);
  });

  it('draws no button and no ✅ for a saved amount above the balance (D-saved-out)', async () => {
    const rows = await shownRows('20000');
    expect(rows).toEqual([
      [amount('1', '$1.00'), amount('2', '$2.00'), amount('5', '$5.00')],
      [amount('10', '$10.00 · риск')],
      [CUSTOM, BACK_LIST],
    ]);
  });

  it('says the balance is below the minimum and offers only the way back (D-empty)', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            broker: brokerBalance({
              demo: {
                available: decimalStringSchema.parse('0.5'),
                held: decimalStringSchema.parse('0'),
                total: decimalStringSchema.parse('0.5'),
              },
            }),
          }),
        ),
    });
    await press(LAUNCH);
    const edited = payloadOf(calls, 'editMessageText');
    expect(plainTextOf(edited?.text as string)).toMatch(
      /\n\nНа демо-счёте недостаточно средств даже для минимальной ставки\.$/,
    );
    expect(rowsOf(edited)).toEqual([[BACK_LIST]]);
  });

  it('says the access read failed, with a retry of the screen and the way back, and warns (D-access)', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(LAUNCH);
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(edited)).toEqual([[button(LABELS.demoRetryButton, LAUNCH)], [BACK_LIST]]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'trading access not read for the amount screen',
    ]);
  });

  // the manager's answer to the implementer's clarify (2026-10-15): the refusal of a screen sent
  // as a new message is edited in place by its retry
  it('retries a failed read under a trade in place, with `a` (D-access-n)', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 15, 'n'));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual([
      [button(LABELS.demoRetryButton, demoLaunchCallbackData(PAIR_EURUSD.id, 15, 'a'))],
      [BACK_ANALYSIS],
    ]);
  });

  it.each([
    ['a blocked user', accessView({ status: UserStatus.Blocked }), TEXTS.blocked],
    [
      'no account',
      accessView({ broker: null, brokerUnavailable: BrokerBalanceUnavailableReason.NoAccount }),
      TEXTS.accountNone,
    ],
    [
      'an ambiguous account',
      accessView({
        broker: null,
        brokerUnavailable: BrokerBalanceUnavailableReason.AmbiguousAccount,
      }),
      TEXTS.statusAmbiguous,
    ],
    [
      'no balance snapshot',
      accessView({
        broker: null,
        brokerUnavailable: BrokerBalanceUnavailableReason.BrokerUnavailable,
      }),
      TEXTS.stakeBalanceMissing,
    ],
  ])(
    'refuses %s as the picker does, then the way back (D-refusals)',
    async (_label, access, text) => {
      const { press, calls } = setup({ readTradingAccess: () => Promise.resolve(access) });
      await press(LAUNCH);
      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(text.value);
      expect(rowsOf(edited).at(-1)).toEqual([BACK_LIST]);
      expect(
        rowsOf(edited)
          .flat()
          .some((key) => key.callback_data?.startsWith('demo:sa:')),
      ).toBe(false);
    },
  );

  it('edits the analysis in place into the screen, its way back the analysis (`a`)', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 15, 'a'));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
      [amount('1', '$1.00 ✅', 'a'), amount('2', '$2.00', 'a'), amount('5', '$5.00', 'a')],
      [amount('10', '$10.00 · риск', 'a')],
      [
        button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 15, 'a')),
        BACK_ANALYSIS,
      ],
    ]);
  });

  it('sends the screen as a new message under a trade or a session, which stays (D-n)', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 15, 'n'));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toContain('Выбери сумму сделки 👇');
    // its own presses edit it: the back token `a`
    expect(rowsOf(sent)[0]?.[0]).toEqual(amount('1', '$1.00 ✅', 'a'));
    expect(rowsOf(sent).at(-1)?.at(-1)).toEqual(BACK_ANALYSIS);
  });

  // door «analysis row opens the amount screen» (#476)
  // in demo a signal's card draws the amounts themselves (#482); the row stays where they cannot
  // be drawn (no snapshot), and since #509 never under a refusal
  it('is what the analysis session row opens in demo; in real the row starts at once', async () => {
    const demo = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ broker: null, brokerUnavailable: 'refreshing' })),
    });
    await demo.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));
    expect(rowsOf(payloadOf(demo.calls, 'sendPhoto'))[0]).toEqual([
      button('🚀 Сессия из 5 сделок', `demo:l:${String(PAIR_EURUSD.id)}:15:a`),
    ]);
    const real = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await real.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));
    expect(rowsOf(payloadOf(real.calls, 'sendPhoto'))[0]).toEqual([
      button(
        '🚀 Сессия из 5 сделок · REAL',
        sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 15),
      ),
    ]);
  });

  // T-back: the typed amount's prompt has «↩️ Назад» to this screen, which ends the step
  it('ends the typed amount step left open, and only that step (T-back)', async () => {
    const cycle = setup({
      dialog: { step: 'cycleStake', assetId: PAIR_EURUSD.id, durationSec: 15, back: 'l' },
    });
    await cycle.press(LAUNCH);
    expect(cycle.loginDialog.get(USER.id)).toBeUndefined();
    const login = setup({ dialog: { step: 'email' } });
    await login.press(LAUNCH);
    expect(login.loginDialog.get(USER.id)).toEqual({ step: 'email' });
  });

  // #327 (manager's decision 1): the launch drawn by the mode, a real cycle at the real stake
  it('shows a user in real mode the real cycle, its stake and the real picker', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            tradingMode: TradeMode.Real,
            demoStake: decimalStringSchema.parse('2.5'),
            realStake: decimalStringSchema.parse('3'),
          }),
        ),
    });
    await press(LAUNCH);
    const edited = payloadOf(calls, 'editMessageText');
    expect(rowsOf(edited)).toEqual([
      [
        button(
          '🚀 Запустить цикл · REAL',
          sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 15, true),
        ),
      ],
      [button(LABELS.stakeChangeButton, `stk:o:r:p:${String(PAIR_EURUSD.id)}:15`)],
      [button(LABELS.backToListButton, demoSignalsCallbackData(15))],
    ]);
    expect(plainTextOf(edited?.text as string)).toBe(
      `🎯 ${pairLabel(PAIR_EURUSD)} · ⏱ 15 с\n💵 Ставка: $3.00\n🤖 Бот проведёт 5 сделок подряд и перед каждой проверит сигнал. Реальный режим: сделки идут на реальные деньги.`,
    );
  });

  it('refuses a pair that closed after the list was drawn', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_CLOSED.id, 15));

    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      TEXTS.demoPairClosed({ symbol: pairLabel(PAIR_CLOSED) }).value,
    );
  });

  it('refuses a pair that does not take the duration', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_MINUTE_ONLY.id, 15));

    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      TEXTS.demoDurationUnsupported({ symbol: pairLabel(PAIR_MINUTE_ONLY) }).value,
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

  // #327: the floor is the session's, and a real session meets it too
  it('refuses a pair below the cycle floor for a user in real mode as in demo', async () => {
    const real = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await real.press(demoLaunchCallbackData(PAIR_OTHER_TYPE.id, 15));
    const demo = setup();
    await demo.press(demoLaunchCallbackData(PAIR_OTHER_TYPE.id, 15));
    const realEdit = payloadOf(real.calls, 'editMessageText');
    expect(realEdit?.text).toBe(payloadOf(demo.calls, 'editMessageText')?.text);
    expect(realEdit?.text).toContain('цикл на этой паре не запускается');
    expect(rowsOf(realEdit)).toEqual([
      [button(LABELS.backToListButton, demoSignalsCallbackData(15))],
      [MANUAL],
    ]);
  });

  it.each([15, 5] as const)(
    'offers the amounts on a pair paying exactly 80 percent at %i s',
    async (durationSec) => {
      const { press, calls } = setup({
        readPairs: () =>
          Promise.resolve(pairsResponse({ pairs: [{ ...PAIR_EURUSD, payout: 80 }] })),
      });
      await press(demoLaunchCallbackData(PAIR_EURUSD.id, durationSec));

      expect(rowsOf(payloadOf(calls, 'editMessageText'))[0]).toEqual([
        amount('1', '$1.00 ✅', 'l', durationSec),
        amount('2', '$2.00', 'l', durationSec),
        amount('5', '$5.00', 'l', durationSec),
      ]);
    },
  );

  it.each(['demo:l:0:15', 'demo:l:0:15:a', 'demo:l:0:15:n'])(
    'only stops the spinner on an id the backend would refuse: %s',
    async (data) => {
      const { press, calls, readPairs } = setup();
      await press(data);

      expect(methods(calls)).toEqual(['answerCallbackQuery']);
      expect(readPairs).not.toHaveBeenCalled();
    },
  );

  it('keeps its data inside the Bot API 64 bytes', () => {
    const MAX_ID = 2_147_483_647;
    expect(Buffer.byteLength(demoLaunchCallbackData(MAX_ID, 15))).toBe(20);
    expect(Buffer.byteLength(demoLaunchCallbackData(MAX_ID, 15, 'n'))).toBe(22);
    expect(
      Buffer.byteLength(cycleStakeCallbackData(MAX_ID, 15, '999999999999.99999999', 'a')),
    ).toBe(45);
    expect(Buffer.byteLength(cycleCustomCallbackData(MAX_ID, 15, 'a'))).toBe(23);
    expect(Buffer.byteLength(launchStakeCallbackData(TradeMode.Real, MAX_ID, 15))).toBe(23);
    expect(Buffer.byteLength(demoSignalsCallbackData(15))).toBe(11);
    expect(Buffer.byteLength(DEMO_SIGNALS_CALLBACK_DATA)).toBe(8);
  });

  it('draws the `l` origin without a token, as the list did before #476', () => {
    expect(demoLaunchCallbackData(101, 15)).toBe('demo:l:101:15');
    expect(demoLaunchCallbackData(101, 15, 'l')).toBe('demo:l:101:15');
    expect(demoLaunchCallbackData(101, 15, 'a')).toBe('demo:l:101:15:a');
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
      button('P00 85%', demoAssetCallbackData(1000)),
      button('P01 85%', demoAssetCallbackData(1001)),
    ]);
    expect(rows.flat().map((entry) => entry.text)).not.toContain('GBP/USD 80%');
    expect(rows[6]).toEqual([
      BACK_GROUPS,
      button(LABELS.demoNextButton, demoPageCallbackData('currency', 1)),
    ]);
  });

  // #428: the live catalog lists a symbol twice, a regular pair and an OTC one
  it('labels the OTC twin by its flag and lists the regular pair right before it', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_EURUSD, PAIR_EURUSD_REGULAR) });
    await press(demoPageCallbackData('currency', 0));
    expect(rowsOf(payloadOf(calls, 'editMessageText'))[0]).toEqual([
      button('EUR/USD 54%', demoAssetCallbackData(PAIR_EURUSD_REGULAR.id)),
      button('EUR/USD OTC 85%', demoAssetCallbackData(PAIR_EURUSD.id)),
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
      [button('P24 85%', demoAssetCallbackData(1024))],
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
    const narrow = { ...PAIR_EURUSD, symbol: 'ZAR/USD', minTimeframe: 10, maxTimeframe: 900 };
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
    expect(edited?.text).toBe(TEXTS.demoNoDuration({ symbol: pairLabel(PAIR_SHORT) }).value);
    expect(rowsOf(edited)).toEqual([
      [button(LABELS.demoBackPairsButton, demoPageCallbackData('cryptocurrency', 0)), BACK_GROUPS],
    ]);
  });

  it('checks the pair again: one closed since its page was drawn is refused', async () => {
    const { press, calls } = setup();
    await press(demoAssetCallbackData(PAIR_CLOSED.id));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoPairClosed({ symbol: pairLabel(PAIR_CLOSED) }).value);
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
      TEXTS.demoPairClosed({ symbol: pairLabel(PAIR_EURUSD) }).value,
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
    expect(edited?.text).toBe(
      TEXTS.demoDurationUnsupported({ symbol: pairLabel(PAIR_EURUSD) }).value,
    );
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
  // in demo the session row opens the amount screen in place (#476)
  const SESSION = button('🚀 Сессия из 5 сделок', demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'));
  const MORE = button(
    LABELS.analysisMoreButton,
    analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, true, TradeMode.Demo),
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
  const resultOf = (response = SIGNAL_DECIDED, chooseAmount = false) =>
    analysisScreen({
      mode: TradeMode.Demo,
      pair: PAIR_EURUSD,
      durationSec: 5,
      response,
      chooseAmount,
    }).text.value;
  const edits = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'editMessageText');
  const cardOf = (calls: readonly ApiCall[]) => payloadOf(calls, 'sendPhoto');
  // the amounts of #476 under a demo card (#482), their way back the analysis, then «✏️ Своя сумма»
  const amountOf = (value: string, label: string, durationSec: 5 | 15 = 5) =>
    button(label, cycleStakeCallbackData(PAIR_EURUSD.id, durationSec, value, 'a'));
  const AMOUNTS = [
    [amountOf('1', '$1.00 ✅'), amountOf('2', '$2.00'), amountOf('5', '$5.00')],
    [amountOf('10', '$10.00 · риск')],
    [button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 5, 'a'))],
  ];
  const pressed = (scene: ReturnType<typeof setup>, data = DATA) => {
    const update = callbackUpdate(data);
    return {
      run: () => scene.bot.handleUpdate(update),
      messageId: (update.callback_query?.message as { message_id: number }).message_id,
    };
  };

  // #482: a signal is a card under «⏳», which goes once the card is there; in demo the amounts
  // first, the single trade behind «➕ Ещё»; the amount is read at the expansion
  it('reads the catalog, shows «⏳», asks for the signal, then sends the card and deletes «⏳»', async () => {
    const scene = setup();
    const { calls, readPairs, evaluateSignal, readTradingAccess } = scene;
    const press = pressed(scene);
    await press.run();

    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendPhoto',
      'deleteMessage',
    ]);
    const [waiting] = edits(calls);
    expect(waiting?.payload.text).toBe(TEXTS.analyzing({ subject: 'EUR/USD OTC · ⏱ 5 с' }).value);
    // without a keyboard the edit removes the summary's, so «📊 Анализ» cannot be pressed twice
    expect(waiting?.payload.reply_markup).toBeUndefined();
    const card = cardOf(calls);
    expect(card?.caption).toBe(resultOf(SIGNAL_DECIDED, true));
    expect(card?.parse_mode).toBe('HTML');
    expect(card?.photo).toBeInstanceOf(InputFile);
    expect((card?.photo as InputFile).filename).toBe('setup-bull.png');
    expect(rowsOf(card)).toEqual([
      ...AMOUNTS,
      [MORE],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
    expect(payloadOf(calls, 'deleteMessage')).toEqual({
      chat_id: USER.id,
      message_id: press.messageId,
    });
    expect(readPairs).toHaveBeenCalledTimes(1);
    expect(evaluateSignal.mock.calls).toEqual([[PAIR_EURUSD.id, '5s']]);
    // the user's mode decides the session row (#121)
    expect(readTradingAccess.mock.calls).toEqual([['4242']]);
  });

  // #327: a user in real mode gets the session row marked REAL, with the real mode in its data
  it('draws the real session row for a user in real mode', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await press(DATA);
    expect(rowsOf(cardOf(calls))).toEqual([
      [
        button(
          '🚀 Сессия из 5 сделок · REAL',
          sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
        ),
      ],
      [
        button(
          LABELS.analysisMoreButton,
          analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, true, TradeMode.Real),
        ),
      ],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
    expect(rowsOf(cardOf(calls))[0]?.[0]?.callback_data).toBe(
      `real:sess:${String(PAIR_EURUSD.id)}:5`,
    );
    expect(cardOf(calls)?.caption).not.toContain('Выбери сумму');
  });

  // Plan 5 (decision 26): the text speaks of the user's mode
  it('ends a real analysis with the real disclaimer and no demo wording', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await press(DATA);
    const text = cardOf(calls)?.caption as string;
    expect(text).toContain(TEXTS.analysisDisclaimerReal.value);
    expect(text).not.toContain('Это демо');
  });

  // no amounts without an access read (#482): the row's press reads it again on the amount screen
  it('draws the session row when access cannot say the mode, and warns', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(DATA);
    expect(rowsOf(cardOf(calls))[0]).toEqual([SESSION]);
    expect(cardOf(calls)?.caption).toBe(resultOf());
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
    expect(rowsOf(cardOf(calls))[AMOUNTS.length]).toEqual([
      button(
        LABELS.analysisMoreButton,
        analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Down, true, TradeMode.Demo),
      ),
    ]);
    // the bear's picture for a signal down (#482)
    expect((cardOf(calls)?.photo as InputFile).filename).toBe('setup-bear.png');
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

    const result = cardOf(calls)?.caption;
    expect(result).toBe(
      analysisScreen({
        mode: TradeMode.Demo,
        pair: { ...PAIR_EURUSD, payout: 70 },
        durationSec: 5,
        response: SIGNAL_DECIDED,
        chooseAmount: false,
      }).text.value,
    );
    expect(result).toContain('Выплата: 70%');
  });

  it('asks for no signal and shows no «⏳» on a closed pair', async () => {
    const { press, calls, evaluateSignal } = setup({ readPairs: catalogOf(PAIR_CLOSED) });
    await press(demoAnalysisCallbackData(PAIR_CLOSED.id, 5));

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      TEXTS.demoPairClosed({ symbol: pairLabel(PAIR_CLOSED) }).value,
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

  // #284: a session of five fits the worker's hour at every duration of the set (#313); #509: a
  // rule refusal offers none at either
  it.each([
    [5, false],
    [15, false],
  ] as const)(
    'offers the session first at %i s on a rule refusal: %s',
    async (durationSec, shown) => {
      const { press, calls } = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
      await press(demoAnalysisCallbackData(PAIR_EURUSD.id, durationSec));
      const session = button(
        sessionStartButtonLabel(5, TradeMode.Demo),
        demoLaunchCallbackData(PAIR_EURUSD.id, durationSec, 'a'),
      );
      const rows = rowsOf(edits(calls).at(-1)?.payload);
      expect(rows.some((row) => row.length === 1 && row[0]?.text === session.text)).toBe(shown);
      if (shown) expect(rows[0]).toEqual([session]);
    },
  );

  // #379: the analysis and the single trade stay on a pair below the floor; the session does not
  it('offers no session on a pair paying below the cycle floor, and says why', async () => {
    const low = { ...PAIR_EURUSD, payout: 79 };
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ pairs: [low] })),
    });
    await press(DATA);
    const result = cardOf(calls);
    expect(result?.caption).toBe(
      analysisScreen({
        mode: TradeMode.Demo,
        pair: low,
        durationSec: 5,
        response: SIGNAL_DECIDED,
        chooseAmount: false,
      }).text.value,
    );
    expect(plainTextOf(TEXTS.analysisCycleUnavailable({ payoutFloor: '80' }))).toBe(
      '🚫 Цикл на этой паре не запускается: выплата ниже 80%.',
    );
    // the note closes the payout block, before the disclaimer
    expect(
      plainTextOf(
        analysisScreen({
          mode: TradeMode.Demo,
          pair: low,
          durationSec: 5,
          response: SIGNAL_DECIDED,
          chooseAmount: false,
        }).text,
      ),
    ).toContain('верных прогнозов.\n🚫 Цикл на этой паре не запускается: выплата ниже 80%.\n\n⚠️');
    expect(rowsOf(result)).toEqual([
      [
        button(
          LABELS.analysisMoreButton,
          analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, false, TradeMode.Demo),
        ),
      ],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
  });

  // #482: the amounts at the floor, «Выбери сумму…» over them; none below it (above)
  it('draws the amounts on a pair paying exactly the cycle floor, with no note', async () => {
    const floor = { ...PAIR_EURUSD, payout: 80 };
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ pairs: [floor] })),
    });
    await press(DATA);
    const result = cardOf(calls);
    expect(result?.caption).not.toContain('Цикл на этой паре не запускается');
    expect(plainTextOf(result?.caption as string).endsWith('\n\nВыбери сумму сделки 👇')).toBe(
      true,
    );
    expect(rowsOf(result)).toEqual([
      ...AMOUNTS,
      [MORE],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
  });

  // #482: the amounts need a snapshot to be drawn from; the session row's press says why not
  it.each([
    ['no broker snapshot', accessView({ broker: null, brokerUnavailable: 'refreshing' })],
    ['a blocked user', accessView({ status: UserStatus.Blocked })],
    [
      'a balance below the minimum',
      accessView({
        broker: brokerBalance({
          demo: { ...brokerBalance().demo, available: decimalStringSchema.parse('0.5') },
        }),
      }),
    ],
  ])('draws the session row and no «Выбери сумму…» for %s', async (_case, access) => {
    const { press, calls } = setup({ readTradingAccess: () => Promise.resolve(access) });
    await press(DATA);
    expect(rowsOf(cardOf(calls))).toEqual([
      [SESSION],
      [MORE],
      [REPEAT],
      [BACK_EURUSD_DURATIONS, BACK_GROUPS],
    ]);
    expect(cardOf(calls)?.caption).toBe(resultOf());
  });

  // #379: a refusal below the floor carries the note as its last line; #509: no refusal draws the
  // session row, at the floor or below it
  it.each([
    ['a rule refusal', 79, false, SIGNAL_NO_SIGNAL],
    ['a rule refusal', 80, false, SIGNAL_NO_SIGNAL],
    ['a data refusal', 79, false, SIGNAL_DATA_REFUSAL],
    ['a data refusal', 80, false, SIGNAL_DATA_REFUSAL],
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
      expect(result?.text).toBe(
        analysisScreen({ mode: TradeMode.Demo, pair, durationSec: 5, response, chooseAmount: true })
          .text.value,
      );
      const note = plainTextOf(TEXTS.analysisCycleUnavailable({ payoutFloor: '80' }));
      const text = plainTextOf(
        analysisScreen({ mode: TradeMode.Demo, pair, durationSec: 5, response, chooseAmount: true })
          .text,
      );
      if (payout >= 80) expect(text).not.toContain(note);
      else expect(text.endsWith(`\n${note}`)).toBe(true);
      expect(rowsOf(result)).toEqual([
        ...(offered ? [[SESSION]] : []),
        [REPEAT],
        [BACK_EURUSD_DURATIONS, BACK_GROUPS],
      ]);
    },
  );

  it('keeps the longest session datum inside the Bot API limit and reads it back', () => {
    // the demo datum is byte for byte the one before #327
    expect(sessionStartCallbackData(TradeMode.Demo, 2_147_483_647, 15)).toBe(
      'demo:sess:2147483647:15',
    );
    const plain = sessionStartCallbackData(TradeMode.Real, 2_147_483_647, 15);
    expect(plain).toBe('real:sess:2147483647:15');
    expect(sessionStartDataOf(SESSION_START_PATTERN.exec(plain) ?? '')).toEqual({
      mode: TradeMode.Real,
      assetId: 2_147_483_647,
      durationSec: 15,
      launch: false,
    });
    // #418: the launch screen's, with its token, is the longest
    const data = sessionStartCallbackData(TradeMode.Real, 2_147_483_647, 15, true);
    expect(data).toBe('real:sess:2147483647:15:l');
    expect(Buffer.byteLength(data, 'utf8')).toBe(25);
    expect(sessionStartDataOf(SESSION_START_PATTERN.exec(data) ?? '')).toEqual({
      mode: TradeMode.Real,
      assetId: 2_147_483_647,
      durationSec: 15,
      launch: true,
    });
    expect(SESSION_START_PATTERN.exec(`bogus:sess:${String(PAIR_EURUSD.id)}:15`)).toBeNull();
    // a datum from before #313 is not a session datum: the legacy handler takes it
    expect(SESSION_START_PATTERN.exec(`demo:sess:${String(PAIR_EURUSD.id)}:300`)).toBeNull();
  });

  // the guard of the #313 addendum: every duration of the set fits DEFAULT_SESSION_TRADES, so
  // the count is passed in to reach it
  it('starts nothing when the session does not fit the hour', () => {
    const match =
      SESSION_START_PATTERN.exec(sessionStartCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 15)) ??
      '';
    expect(sessionStartDataOf(match, 100)).toBeUndefined();
    expect(sessionStartDataOf(match)).toEqual({
      mode: TradeMode.Demo,
      assetId: PAIR_EURUSD.id,
      durationSec: 15,
      launch: false,
    });
  });

  // #509: no signal offers no session either (before it the session waited for one itself);
  // candles not read offer none, as before
  it.each([
    ['a rule refusal', SIGNAL_NO_SIGNAL, false],
    ['a data refusal', SIGNAL_DATA_REFUSAL, false],
    ['the broker rate-limiting the candles', SIGNAL_FETCH_FAILED, false],
  ])(
    'shows %s with no «➕ Ещё», no session row and no warning',
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

  it('says under a rule refusal that no trade and no session are offered without a signal', async () => {
    const { press, calls } = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
    await press(DATA);
    expect(edits(calls).at(-1)?.payload.text).toContain(
      'Без сигнала бот не предлагает ни сделку, ни сессию. Повтори анализ позже или выбери другую пару.',
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

  // #482: a gone summary gets no «⏳» anew, which would cost the call the card's delete needs
  it('sends no «⏳» anew when the summary is gone, and the result after it as a new message', async () => {
    const { press, calls, apiErrors, evaluateSignal } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    const result = payloadOf(calls, 'sendMessage');
    expect(result?.text).toBe(resultOf(SIGNAL_NO_SIGNAL));
    expect(rowsOf(result)[0]).toEqual([REPEAT]);
    expect(evaluateSignal).toHaveBeenCalledTimes(1);
  });

  it('sends the card with no «⏳» to delete when the summary is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendPhoto']);
    expect(
      calls.some(
        (call) =>
          call.payload.text === TEXTS.analyzing({ subject: 'EUR/USD OTC · ⏱ 5 с' }).value &&
          call.method === 'sendMessage',
      ),
    ).toBe(false);
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
    const { press, calls, ...api } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
    failFromSecondCall(api, 'editMessageText', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageText',
      'sendMessage',
    ]);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(resultOf(SIGNAL_NO_SIGNAL));
    expect(sent?.reply_markup).toEqual(edits(calls)[1]?.payload.reply_markup);
  });

  it('is done when Telegram says the message already shows the result', async () => {
    const { press, calls, apiErrors } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
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
  const DATA = analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, true, TradeMode.Demo);
  const REPEAT = button(LABELS.repeatAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
  // in demo the session row opens the amount screen in place (#476)
  const SESSION = button('🚀 Сессия из 5 сделок', demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'));
  const STAKE_MENU = button(
    LABELS.stakeMenuButton,
    stakeMenuCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5),
  );
  const expandedOf = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'editMessageReplyMarkup');
  const stakeRowIn = (rows: Button[][]) =>
    rows.find((row) => row.some((key) => key.callback_data?.startsWith('demo:stake:')));
  const stakeRowOf = (calls: readonly ApiCall[]) =>
    stakeRowIn(rowsOf(expandedOf(calls).at(-1)?.payload));
  // the card's amounts stay above the stake row in demo (#482)
  const amountOf = (value: string, label: string) =>
    button(label, cycleStakeCallbackData(PAIR_EURUSD.id, 5, value, 'a'));
  const AMOUNTS = [
    [amountOf('1', '$1.00 ✅'), amountOf('2', '$2.00'), amountOf('5', '$5.00')],
    [amountOf('10', '$10.00 · риск')],
    [button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 5, 'a'))],
  ];
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
    const rows = rowsOf(edit?.payload);
    // [В2] the amounts stay, the stake row below them
    expect(rows.slice(0, AMOUNTS.length)).toEqual(AMOUNTS);
    const [[stake, menu], ...rest] = rows.slice(AMOUNTS.length);
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

  // #121: the single real trade, marked REAL, under the real session row (#327). #326: at the
  // saved real stake, with «💵 Сумма» opening the real picker
  it.each([
    ['the minimum without a saved real stake', null, '1.00000000', '$1.00'],
    ['the saved real stake', decimalStringSchema.parse('5'), '5', '$5.00'],
  ])(
    'draws a user in real mode the REAL stake button at %s and «💵 Сумма» of the real mode',
    async (_case, realStake, amount, shown) => {
      const { press, calls } = setup({
        readTradingAccess: () =>
          Promise.resolve(
            accessView({
              tradingMode: TradeMode.Real,
              demoStake: decimalStringSchema.parse('2.5'),
              realStake,
            }),
          ),
      });
      await press(
        analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, true, TradeMode.Real),
      );
      const rows = rowsOf(expandedOf(calls).at(-1)?.payload);
      const [session, [stake, menu], ...rest] = rows;
      expect(session).toEqual([
        button(
          '🚀 Сессия из 5 сделок · REAL',
          sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
        ),
      ]);
      expect(rows[1]).toHaveLength(2);
      expect(stake?.text).toBe(
        stakeButtonLabel(TradeAction.Up, decimalStringSchema.parse(amount), TradeMode.Real),
      );
      expect(stake?.text).toBe(`🚀 Открыть сделку: ⬆️ Вверх · ${shown} · REAL`);
      expect(stakeOf(stake?.callback_data)?.fingerprint).toBe(
        stakeFingerprint(decimalStringSchema.parse(amount), TradeMode.Real),
      );
      expect(menu).toEqual(
        button(LABELS.stakeMenuButton, stakeMenuCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5)),
      );
      expect(menu?.callback_data).toBe(`stk:o:r:a:${PAIR_EURUSD.id}:5`);
      expect(rest).toEqual([[REPEAT], [BACK_EURUSD_DURATIONS, BACK_GROUPS]]);
    },
  );

  it('draws the direction the button carries', async () => {
    const { press, calls } = setup();
    await press(
      analysisMoreCallbackData(PAIR_EURUSD.id, 15, TradeAction.Down, true, TradeMode.Demo),
    );
    const stake = stakeRowOf(calls)?.[0];
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
    const stakes = expandedOf(calls).map(
      (call) => stakeRowIn(rowsOf(call.payload))?.[0]?.callback_data,
    );
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
    // no amounts without a snapshot (#482): the session row, whose press says why
    expect(rowsOf(expandedOf(calls).at(-1)?.payload)[0]).toEqual([SESSION]);
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
    const data = analysisMoreCallbackData(
      2_147_483_647,
      longest,
      TradeAction.Down,
      false,
      TradeMode.Real,
    );
    expect(data).toBe('demo:more:2147483647:15:down:n:r');
    expect(Buffer.byteLength(data, 'utf8')).toBe(32);
    expect(analysisMoreDataOf(ANALYSIS_MORE_PATTERN.exec(data) ?? '')).toEqual({
      assetId: 2_147_483_647,
      durationSec: 15,
      action: TradeAction.Down,
      payoutAccepted: false,
      renderedMode: TradeMode.Real,
    });
  });

  // Plan 5 (decision 26): «➕ Ещё» draws a stake button only in the mode its analysis was drawn in
  describe('the mode token', () => {
    const datum = (token: string) => `demo:more:${PAIR_EURUSD.id}:5:up:s${token}`;
    const realAccess = () => Promise.resolve(accessView({ tradingMode: TradeMode.Real }));
    const datas = (calls: readonly ApiCall[]) =>
      rowsOf(expandedOf(calls).at(-1)?.payload)
        .flat()
        .map((b) => b.callback_data ?? '');
    const TAIL = [[REPEAT], [BACK_EURUSD_DURATIONS, BACK_GROUPS]];

    it('marks a real analysis :r and a demo one :d', async () => {
      const real = setup({ readTradingAccess: realAccess });
      await real.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
      const demo = setup();
      await demo.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
      const moreOf = (calls: readonly ApiCall[]) =>
        rowsOf(payloadOf(calls, 'sendPhoto'))
          .flat()
          .find((b) => b.text === LABELS.analysisMoreButton)?.callback_data;
      expect(moreOf(real.calls)).toBe(datum(':r'));
      expect(moreOf(demo.calls)).toBe(datum(':d'));
    });

    it('draws the REAL row for :r read in real', async () => {
      const { press, calls } = setup({ readTradingAccess: realAccess });
      await press(datum(':r'));
      expect(datas(calls).some((d) => d.startsWith('demo:stake:'))).toBe(true);
    });

    it.each([
      ['a demo analysis read in real', ':d', realAccess],
      ['a real analysis read in demo', ':r', () => Promise.resolve(ACCESS_VIEW)],
      [
        'a real analysis whose read failed',
        ':r',
        () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      ],
    ])('draws only the tail for %s', async (_case, token, readTradingAccess) => {
      const { press, calls } = setup({ readTradingAccess });
      await press(datum(token));
      expect(rowsOf(expandedOf(calls).at(-1)?.payload)).toEqual(TAIL);
    });

    it('reads a datum from before #121 as demo', async () => {
      const { press, calls } = setup();
      await press(datum(''));
      expect(datas(calls).some((d) => d.startsWith('demo:stake:'))).toBe(true);
      expect(datas(calls).some((d) => d.startsWith('demo:sa:'))).toBe(true);
    });
  });

  // #379: the floor's verdict travels in the datum, taken at the render; in demo the amounts
  // stand where the session row would (#482)
  it.each([
    ['s', true],
    ['n', false],
    // a button #360 drew before #379: its row stays, the press meets the route's 409
    [undefined, true],
  ] as const)(
    'reads the token %s as payoutAccepted %s and draws the amounts by it',
    async (token, accepted) => {
      const { press, calls } = setup();
      await press(
        `demo:more:${String(PAIR_EURUSD.id)}:5:up${token === undefined ? '' : `:${token}`}`,
      );
      const rows = rowsOf(expandedOf(calls).at(-1)?.payload);
      expect(rows.some((row) => row.some((b) => b.text === SESSION.text))).toBe(false);
      if (accepted) expect(rows.slice(0, AMOUNTS.length)).toEqual(AMOUNTS);
      else expect(rows[0]?.[1]).toEqual(STAKE_MENU);
    },
  );

  // the session row's rules for a real token: below the floor no row at all (#379)
  it.each([
    ['s', true],
    ['n', false],
  ] as const)(
    'in real reads the token %s as payoutAccepted %s and draws the session row by it',
    async (token, accepted) => {
      const { press, calls } = setup({
        readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
      });
      await press(`demo:more:${String(PAIR_EURUSD.id)}:5:up:${token}:r`);
      const rows = rowsOf(expandedOf(calls).at(-1)?.payload);
      expect(rows.some((row) => row.some((b) => b.callback_data?.startsWith('real:sess:')))).toBe(
        accepted,
      );
      expect(rows.flat().some((b) => b.callback_data?.startsWith('demo:sa:'))).toBe(false);
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
    // #418: only the one launch token, in its own case
    'demo:sess:101:5:x',
    'real:sess:101:5:L',
    'demo:sess:101:5:l:l',
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
    `demo:sess:101:${String(sec)}:l`,
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
// «📊 Новый анализ» tries no edit (#482): the press carries the photo, and «⏳» goes at once.
describe('a press under the session card (a photo)', () => {
  // the card's buttons that edit the pressed message: «🔁 Ещё сессия» replies (K7 in
  // trading-session.test.ts; in demo its amount screen, `:n`, #476) and «🏠 В меню» replies too
  const editingButtons = (durationSec: number) =>
    sessionCardKeyboard(
      sessionView({ settings: { ...SESSION_VIEW.settings!, durationSec } }),
      CASHIER_URL,
    )
      .inline_keyboard.flat()
      .map((key) => ('callback_data' in key ? key.callback_data : undefined))
      .filter(
        (data): data is string =>
          data !== undefined &&
          data.startsWith('demo:') &&
          !data.startsWith('demo:sess:') &&
          !(data.startsWith('demo:l:') && data.endsWith(':n')),
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

  // #482: under a photo «⏳» goes as a new message at once, with no edit tried first
  it('C3 «📊 Новый анализ» sends «⏳» as a new message, then the card under it, and deletes «⏳»', async () => {
    const { pressOnPhoto: press, calls, evaluateSignal } = setup();
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'sendPhoto',
      'deleteMessage',
    ]);
    expect(evaluateSignal).toHaveBeenCalledTimes(1);
    const waiting = payloadOf(calls, 'sendMessage');
    expect(waiting?.text).toBe(TEXTS.analyzing({ subject: 'EUR/USD OTC · ⏱ 15 с' }).value);
    expect(waiting?.reply_markup).toBeUndefined();
    const card = payloadOf(calls, 'sendPhoto');
    expect(card?.caption).toBe(
      analysisScreen({
        mode: TradeMode.Demo,
        pair: PAIR_EURUSD,
        durationSec: 15,
        response: SIGNAL_DECIDED,
        chooseAmount: true,
      }).text.value,
    );
    expect(rowsOf(card).flat()).toContainEqual(
      button(LABELS.repeatAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 15)),
    );
    expect(payloadOf(calls, 'deleteMessage')).toEqual({
      chat_id: USER.id,
      message_id: TEXT_CARD_MESSAGE_ID,
    });
  });

  it('C3b a text result under a photo goes in place of the new «⏳», by its id', async () => {
    const { pressOnPhoto: press, calls } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'editMessageText']);
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited).toMatchObject({ chat_id: USER.id, message_id: TEXT_CARD_MESSAGE_ID });
    expect(edited?.text).toBe(
      analysisScreen({
        mode: TradeMode.Demo,
        pair: PAIR_EURUSD,
        durationSec: 15,
        response: SIGNAL_NO_SIGNAL,
        chooseAmount: true,
      }).text.value,
    );
  });

  it('C3c sends that result anew when the new «⏳» is gone, and nothing when it fails in transport', async () => {
    const gone = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
    gone.apiErrors.set('editMessageText', EDIT_GONE);
    await gone.pressOnPhoto(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));
    expect(methods(gone.calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'editMessageText',
      'sendMessage',
    ]);
    const transport = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
    transport.apiErrors.set('editMessageText', TRANSPORT('editMessageText'));
    await transport.pressOnPhoto(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));
    expect(methods(transport.calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'editMessageText',
    ]);
  });

  it('C3d asks for no signal when the new «⏳» fails in transport', async () => {
    const { pressOnPhoto: press, calls, apiErrors, evaluateSignal, logger } = setup();
    apiErrors.set('sendMessage', TRANSPORT('sendMessage'));
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 15));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(evaluateSignal).not.toHaveBeenCalled();
    expect(logger.error.mock.calls.map((call) => call[1])).toEqual([
      'the analysis «⏳» failed in transport, sending nothing more',
    ]);
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

// #482: the signal's card — its picture, the file_id, and every outcome of the photo and «⏳»
describe('the analysis card', () => {
  const DATA = demoAnalysisCallbackData(PAIR_EURUSD.id, 5);
  const DOWN = signalDecided({
    kind: SignalKind.Signal,
    version: SIGNAL_DECISION.version,
    action: TradeAction.Down,
    features: SIGNAL_FEATURES,
  });
  const PHOTO_REFUSED: ApiError = {
    ok: false,
    error_code: 400,
    description: 'Bad Request: wrong file identifier/HTTP URL specified',
  };
  const photos = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'sendPhoto').map((call) => call.payload.photo);
  const fileName = (photo: unknown) => (photo instanceof InputFile ? photo.filename : photo);
  const card = (chooseAmount = true) =>
    analysisScreen({
      mode: TradeMode.Demo,
      pair: PAIR_EURUSD,
      durationSec: 5,
      response: SIGNAL_DECIDED,
      chooseAmount,
    }).text.value;
  const UNAVAILABLE_ROWS = [
    [button(LABELS.repeatAnalysisButton, DATA)],
    [BACK_EURUSD_DURATIONS, BACK_GROUPS],
  ];

  it('uploads each picture once, then sends it by the file_id Telegram answered with', async () => {
    const responses = [SIGNAL_DECIDED, DOWN, SIGNAL_DECIDED, DOWN];
    const { press, calls } = setup({
      evaluateSignal: () => Promise.resolve(responses.shift() ?? SIGNAL_DECIDED),
    });
    for (let index = 0; index < 4; index += 1) await press(DATA);
    expect(photos(calls).map(fileName)).toEqual([
      'setup-bull.png',
      'setup-bear.png',
      CARD_FILE_ID,
      CARD_FILE_ID,
    ]);
  });

  it('forgets a refused file_id, sends the caption as text in place of «⏳», and uploads next time', async () => {
    const { press, calls, apiErrors, logger } = setup();
    await press(DATA);
    apiErrors.set('sendPhoto', PHOTO_REFUSED);
    const before = calls.length;
    await press(DATA);
    const second = calls.slice(before);
    expect(methods(second)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendPhoto',
      'editMessageText',
    ]);
    expect(second[2]?.payload.photo).toBe(CARD_FILE_ID);
    // [В1] the same caption and the same keyboard, the amounts and «Выбери сумму…» with them
    const text = second[3]?.payload;
    expect(text?.text).toBe(card());
    expect(text?.reply_markup).toEqual(second[2]?.payload.reply_markup);
    expect(
      rowsOf(text)
        .flat()
        .some((key) => key.callback_data?.startsWith('demo:sa:')),
    ).toBe(true);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'the analysis card photo was refused, sending its text',
    ]);
    apiErrors.delete('sendPhoto');
    await press(DATA);
    expect(photos(calls).map(fileName)).toEqual(['setup-bull.png', CARD_FILE_ID, 'setup-bull.png']);
  });

  it('sends the text card as a new message when the photo is refused and no «⏳» stands', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    apiErrors.set('sendPhoto', PHOTO_REFUSED);
    await press(DATA);
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendPhoto',
      'sendMessage',
    ]);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(card());
  });

  it('logs a refused edit of «⏳» into the text card and does nothing more', async () => {
    const { press, calls, apiErrors, logger, ...api } = setup();
    apiErrors.set('sendPhoto', PHOTO_REFUSED);
    failFromSecondCall({ apiErrors, ...api }, 'editMessageText', EDIT_GONE);
    await press(DATA);
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendPhoto',
      'editMessageText',
    ]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'the analysis card photo was refused, sending its text',
      'the analysis «⏳» was not edited after the card',
    ]);
  });

  it('remembers nothing when the answer lists no size, and uploads again', async () => {
    const { press, calls, answers, logger } = setup();
    answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, []));
    await press(DATA);
    await press(DATA);
    expect(photos(calls).map(fileName)).toEqual(['setup-bull.png', 'setup-bull.png']);
    expect(logger.warn.mock.calls).toContainEqual([
      { reason: 'no_file_id' },
      'the analysis card picture is not remembered',
    ]);
  });

  it('says the analysis is unavailable in «⏳» when the photo fails in transport', async () => {
    const { press, calls, apiErrors, logger } = setup();
    apiErrors.set('sendPhoto', TRANSPORT('sendPhoto'));
    await press(DATA);
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendPhoto',
      'editMessageText',
    ]);
    const edited = calls.at(-1)?.payload;
    expect(edited?.text).toBe(analysisUnavailableScreen(PAIR_EURUSD, 5).text.value);
    expect(rowsOf(edited)).toEqual(UNAVAILABLE_ROWS);
    expect(logger.error.mock.calls.map((call) => call[1])).toEqual([
      'the analysis card failed in transport',
    ]);
  });

  it('sends nothing more when the photo fails in transport and no «⏳» stands', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    apiErrors.set('sendPhoto', TRANSPORT('sendPhoto'));
    await press(DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendPhoto']);
  });

  it.each([
    [
      'gone',
      { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' },
      'info',
      'the analysis «⏳» was already gone',
    ],
    [
      'forbidden',
      { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" },
      'warn',
      'the analysis «⏳» was not deleted',
    ],
    ['in transport', TRANSPORT('deleteMessage'), 'warn', 'the analysis «⏳» was not deleted'],
  ] as const)(
    'logs a delete of «⏳» refused as %s once, and does nothing more',
    async (_case, failure, level, message) => {
      const { press, calls, apiErrors, logger } = setup();
      apiErrors.set('deleteMessage', failure);
      await press(DATA);
      expect(methods(calls)).toEqual([
        'answerCallbackQuery',
        'editMessageText',
        'sendPhoto',
        'deleteMessage',
      ]);
      expect(logger[level].mock.calls.map((call) => call[1])).toEqual([message]);
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it('hands a photo call that fails for a reason the transport cannot produce to bot.catch', async () => {
    const { press, calls, answers } = setup();
    answers.set('sendPhoto', () => {
      throw new TypeError('sentinel');
    });
    const thrown = await rejectionOf(press(DATA));
    expect(thrown).toBeInstanceOf(BotError);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendPhoto']);
  });
});

// #297, #326: the amount a stake press trades, in the user's mode
describe('effectiveStake', () => {
  const d = (value: string) => decimalStringSchema.parse(value);
  const saved = { demoStake: d('2.5'), realStake: d('7') };

  it.each([
    [TradeMode.Demo, saved, '2.5'],
    [TradeMode.Real, saved, '7'],
    [TradeMode.Demo, { demoStake: null, realStake: d('7') }, '1.00000000'],
    [TradeMode.Real, { demoStake: d('2.5'), realStake: null }, '1.00000000'],
  ])('in %s mode with %o trades %s', (tradingMode, stakes, amount) => {
    expect(effectiveStake(accessView({ tradingMode, ...stakes }))).toBe(amount);
  });

  it('is null without a broker snapshot', () => {
    expect(
      effectiveStake(accessView({ tradingMode: TradeMode.Real, ...saved, broker: null })),
    ).toBeNull();
  });
});
