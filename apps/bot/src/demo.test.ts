import { BotError, GrammyError, HttpError, InputFile } from 'grammy';
import type { ApiError } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { until } from '@binarius/shared/testing';
import {
  BOT_TEXT_SOURCES_EN,
  BotLanguage,
  ButtonRole,
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
  demoAnalysisCallbackData,
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
  demoAssetCallbackData,
  demoPageCallbackData,
  SESSION_START_PATTERN,
  sessionStartCallbackData,
  sessionStartDataOf,
  SIGNALS_LIST_SIZE,
  SIGNALS_MIN_SIZE,
  signalsShown,
  STAKE_CALLBACK_PATTERN,
  stakeCallbackData,
  stakeDataOf,
  stakeFingerprint,
  stakeMenuCallbackData,
} from './demo';
import { DEMO_DURATIONS_SEC } from './demo-catalog';
import { runWithLanguage, type UserLanguages } from './language';
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
  SIGNAL_CANDLE_ONLY,
  SIGNAL_FETCH_FAILED,
  SIGNAL_H1_ONLY,
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
  animationAnswer,
  SCAN_FILE_ID,
  SCAN_MESSAGE_ID,
  pairsResponse,
  photoAnswer,
  animationCallbackUpdate,
  EMPTY_SCAN_SUMMARY,
  photoCallbackUpdate,
  rejectionOf,
  sessionView,
  SESSION_VIEW,
  signalsResponse,
  signalDecided,
  type ApiCall,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  userLanguagesWith,
  inlineRoles,
  inlineRows,
  inlineStyles,
  stubShownSignals,
  detachedWork,
} from './testing';
import {
  DEMO_DURATION_LABELS,
  demoPairsScreen,
  demoSummary,
  groupButtonLabel,
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
    languages?: UserLanguages;
  } = {},
) {
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
  // the pair of the doors has a signal by default (#664: a door reads the list)
  const readSignals = vi.fn(
    options.readSignals ?? (() => Promise.resolve(signalsOf([PAIR_EURUSD.id, TradeAction.Up]))),
  );
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
  const signalWaiter = stubSignalWaiter();
  const shownSignals = stubShownSignals();
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter,
    shownSignals,
    detached: detachedWork(),
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
    ...(options.languages === undefined ? {} : { languages: options.languages }),
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  api.answers.set('sendAnimation', animationAnswer(SCAN_MESSAGE_ID, SCAN_FILE_ID));
  api.answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, ['card-small', CARD_FILE_ID]));
  // «⏳» become the card answers with the card's sizes (#875); an animation's edit answers `true`
  api.answers.set('editMessageMedia', (payload, signal) =>
    (payload.media as { type?: unknown } | undefined)?.type === 'photo'
      ? photoAnswer(Number(payload.message_id), ['card-small', CARD_FILE_ID])(payload, signal)
      : true,
  );
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
    signalWaiter,
    shownSignals,
    press,
    pressOnPhoto,
    ...api,
  };
}

// the file_id the card's sendPhoto answers with, its largest size (#482)
const CARD_FILE_ID = 'card-file-id';

const methods = (calls: readonly ApiCall[]) => calls.map((call) => call.method);
// the analysis card (#482) as the last photo sent or edited in (#875: «⏳» becomes it), read as a
// sendPhoto's payload: its photo, caption and parse mode out of the edit's media
const isCardCall = (call: ApiCall) =>
  call.method === 'sendPhoto' ||
  (call.method === 'editMessageMedia' &&
    (call.payload.media as { type?: unknown } | undefined)?.type === 'photo');
const cardCallsOf = (calls: readonly ApiCall[]) =>
  calls.filter(isCardCall).map(({ method, payload }) => {
    if (method === 'sendPhoto') return payload;
    const media = payload.media as { media: unknown; caption: unknown; parse_mode: unknown };
    return {
      ...payload,
      photo: media.media,
      caption: media.caption,
      parse_mode: media.parse_mode,
    } as Record<string, unknown>;
  });
const cardOf = (calls: readonly ApiCall[]) => cardCallsOf(calls).at(-1);
const payloadOf = (calls: readonly ApiCall[], method: string) =>
  calls.find((call) => call.method === method)?.payload;
const rowsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  inlineRows(payload) as Button[][];
const button = (text: string, callback_data: string): Button => ({ text, callback_data });

const catalogOf = (...pairs: PairView[]): (() => Promise<PairsCatalogResponse>) => {
  return () => Promise.resolve(pairsResponse({ pairs }));
};

// GET /trading/signals: the 5s list in the route's order
const signalsOf = (...signals: [number, TradeAction][]) => signalsResponse(NOW, { '5s': signals });

const MANUAL = button(LABELS.demoManualButton, DEMO_GROUPS_CALLBACK_DATA);
const MENU = button(LABELS.menuButton, MENU_CALLBACK_DATA);
const REFRESH = button(LABELS.demoSignalsRefreshButton, DEMO_SIGNALS_CALLBACK_DATA);
// «🔄 Обновить» · «🧭 Вручную» · «🏠 В меню» in one row under the list (#419, #685, #475)
const LIST_FOOTER = [[REFRESH, MANUAL, MENU]];
// the list's refusals: «🔄 Повторить» with `data` beside the manual choice and the menu
const retryFooter = (data: string) => [[button(LABELS.demoRetryButton, data), MANUAL, MENU]];

const BACK_GROUPS = button(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
const BACK_EURUSD_PAGE = button(LABELS.demoBackPairsButton, demoPageCallbackData('currency', 0));
const BACK_EURUSD_PAIR = button(LABELS.demoBackPairButton, demoAssetCallbackData(PAIR_EURUSD.id));

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
// the wait's animation refused for its file (#859): no edit refusal, no 429 or 403
const ANIMATION_REFUSED: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: wrong file identifier/HTTP URL specified',
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

describe('the entry (#685)', () => {
  const ROUTE = signalsOf([PAIR_EURUSD.id, TradeAction.Up]);
  const ROWS = [
    [button('EUR/USD ⬆️ 85%', demoLaunchCallbackData(PAIR_EURUSD.id, 5))],
    ...LIST_FOOTER,
  ];

  it("the card's button sends the list as a new message and reads signals and pairs", async () => {
    const { press, calls, readPairs, readSignals } = setup({
      readSignals: () => Promise.resolve(ROUTE),
    });
    await press(DEMO_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }).value);
    expect(rowsOf(sent)).toEqual(ROWS);
    expect(readSignals).toHaveBeenCalledTimes(1);
    expect(readPairs).toHaveBeenCalledTimes(1);
  });

  it.each([DEMO_SIGNALS_CALLBACK_DATA, 'demo:sig:5', 'demo:sig:15'])(
    '%s edits the list in place',
    async (data) => {
      const { press, calls } = setup({ readSignals: () => Promise.resolve(ROUTE) });
      await press(data);

      expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }).value);
      expect(rowsOf(edited)).toEqual(ROWS);
    },
  );

  it("the card's retry under a failed read is the card's button again", async () => {
    const { press, calls } = setup({ readSignals: () => Promise.reject(new Error('down')) });
    await press(DEMO_CALLBACK_DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(retryFooter(DEMO_CALLBACK_DATA));
  });
});

describe('the signals screen', () => {
  // by type (#460): EUR/USD's currency before BTC/USD's cryptocurrency, though the route sends
  // BTC/USD first and it pays more; a closed pair, one that refuses 5 s and one the catalog does
  // not list have no button; US10Y at 70 % follows as the tail of a list shorter than five (#631)
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
      button('EUR/USD ⬆️ 85%', demoLaunchCallbackData(PAIR_EURUSD.id, 5)),
      button('BTC/USD ⬇️ 90%', demoLaunchCallbackData(PAIR_SHORT.id, 5)),
    ],
    [button('US10Y ⬇️ 70%', demoLaunchCallbackData(PAIR_OTHER_TYPE.id, 5))],
    ...LIST_FOOTER,
  ];
  const LIST = DEMO_SIGNALS_CALLBACK_DATA;

  it('edits the pairs with a signal in place, joined with the catalog', async () => {
    const { press, calls, readPairs, readSignals } = setup({
      readSignals: () => Promise.resolve(ROUTE),
    });
    await press(LIST);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }).value);
    expect(plainTextOf(TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }))).toBe(
      '📡 Сигналы сейчас · ⏱ 5 с\nВыбери пару. Сигнал H1 живёт секунду, поэтому список меняется каждую секунду, а сделки идут по свежему сигналу.',
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
        route.map((assetId) => ({ assetId, action: TradeAction.Up, second: NOW, decidedAt: NOW })),
        pairsResponse({ pairs: [...pairs] }),
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

    // #631: a pair paying 70 % is no longer one the launch would refuse; it follows as the tail
    it('L4 a pair the launch would refuse takes no place', () => {
      const pairs = [
        pairOf(1, 'currency', 99, { scheduledUntil: PAIR_CLOSED.scheduledUntil }),
        pairOf(2, 'currency', 95),
        pairOf(3, 'currency', 94),
        pairOf(4, 'currency', 70),
        pairOf(5, 'stock', 81),
      ];
      expect(shownIds([1, 2, 3, 4, 5], pairs)).toEqual([2, 3, 5, 4]);
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

    // #631: at least SIGNALS_MIN_SIZE pairs when that many have a signal; the pairs paying less
    // than MIN_CYCLE_PAYOUT_PCT fill the list after #460's choice, best payout first
    it('pins the floor of the list at five, inside its ceiling', () => {
      expect(SIGNALS_MIN_SIZE).toBe(5);
      expect(SIGNALS_MIN_SIZE).toBeLessThanOrEqual(SIGNALS_LIST_SIZE);
    });

    it('L6 three pairs at or above 80 % keep their groups, two below follow them as the tail', () => {
      const pairs = [
        pairOf(1, 'currency', 90),
        pairOf(2, 'currency', 85),
        pairOf(3, 'stock', 82),
        pairOf(4, 'cryptocurrency', 79),
        pairOf(5, 'currency', 75),
        pairOf(6, 'index', 70),
        pairOf(7, 'stock', 60),
      ];
      expect(shownIds([7, 6, 5, 4, 3, 2, 1], pairs)).toEqual([1, 2, 3, 4, 5]);
    });

    it('L7 fills up to five and no further; five or more at or above 80 % take no tail', () => {
      const low = Array.from({ length: 10 }, (_, i) => pairOf(101 + i, 'currency', 70 - i));
      const above = (n: number) =>
        Array.from({ length: n }, (_, i) => pairOf(1 + i, BROKER_TYPE[i % 6] ?? 'currency', 90));
      const ids = (pairs: readonly PairView[]) => pairs.map((p) => p.id);
      const three = [...above(3), ...low];
      expect(shownIds(ids(three), three)).toEqual([1, 2, 3, 101, 102]);
      const five = [...above(5), ...low];
      expect(shownIds(ids(five), five)).toEqual([1, 2, 3, 4, 5]);
      const seven = [...above(7), ...low];
      expect(shownIds(ids(seven), seven)).toEqual([1, 7, 2, 3, 4, 5, 6]);
    });

    it('L8 the tail goes by payout, then id; a pair the launch would refuse takes no place in it', () => {
      const pairs = [
        pairOf(10, 'currency', 70),
        pairOf(9, 'index', 75),
        pairOf(8, 'stock', 75),
        pairOf(11, 'currency', 78, { scheduledUntil: PAIR_CLOSED.scheduledUntil }),
        pairOf(12, 'currency', 77, { minTimeframe: 60 }),
      ];
      expect(shownIds([10, 9, 8, 11, 12, 13], pairs)).toEqual([8, 9, 10]);
    });

    it('L9 fewer than five signals show as many as there are', () => {
      expect(shownIds([1, 2], [pairOf(1, 'currency', 60), pairOf(2, 'stock', 79)])).toEqual([2, 1]);
      const mixed = [pairOf(1, 'currency', 90), pairOf(2, 'stock', 85), pairOf(3, 'index', 50)];
      expect(shownIds([3, 2, 1], mixed)).toEqual([1, 2, 3]);
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
      await press(LIST);

      const buttons = rowsOf(payloadOf(calls, 'editMessageText')).flat();
      expect(buttons.slice(-3)).toEqual(LIST_FOOTER.flat());
      expect(buttons.slice(0, -3).map((b) => b.callback_data)).toEqual(
        SIX_SHOWN.map((id) => demoLaunchCallbackData(id, 5)),
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
      await press(LIST);
      return rowsOf(payloadOf(calls, 'editMessageText'));
    };
    const pairButton = (id: number, payout: number) =>
      button(`S${String(id)} ⬆️ ${String(payout)}%`, demoLaunchCallbackData(id, 5));

    it('T2 an odd number of pairs leaves the last one alone in its row', async () => {
      const pairs = [
        pairOf(1, 'currency', 90),
        pairOf(2, 'currency', 88),
        pairOf(3, 'currency', 85),
      ];
      expect(await screenRows(pairs, [3, 1, 2])).toEqual([
        [pairButton(1, 90), pairButton(2, 88)],
        [pairButton(3, 85)],
        ...LIST_FOOTER,
      ]);
    });

    it('T2b a row holds two types when the fill puts them side by side', async () => {
      const few = [pairOf(1, 'currency', 85), pairOf(2, 'currency', 90), pairOf(3, 'currency', 88)];
      const crypto = pairOf(4, 'cryptocurrency', 95);
      expect(await screenRows([...few, crypto], [4, 1, 2, 3])).toEqual([
        [pairButton(2, 90), pairButton(3, 88)],
        [pairButton(1, 85), pairButton(4, 95)],
        ...LIST_FOOTER,
      ]);
    });

    // #631: the tail goes on in the same two a row, after the groups
    it('T2d the tail follows the groups two a row', async () => {
      const pairs = [
        pairOf(1, 'currency', 90),
        pairOf(2, 'stock', 85),
        pairOf(3, 'index', 81),
        pairOf(4, 'currency', 79),
        pairOf(5, 'stock', 70),
      ];
      expect(await screenRows(pairs, [5, 4, 3, 2, 1])).toEqual([
        [pairButton(1, 90), pairButton(2, 85)],
        [pairButton(3, 81), pairButton(4, 79)],
        [pairButton(5, 70)],
        ...LIST_FOOTER,
      ]);
    });

    it('T2c a full list is six rows of two above the footer', async () => {
      const rows = await screenRows(
        SIX,
        SIX.map((p) => p.id),
      );
      expect(rows).toHaveLength(SIGNALS_LIST_SIZE / 2 + 1);
      expect(rows.slice(0, 6).map((row) => row.length)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(rows.slice(-1)).toEqual(LIST_FOOTER);
    });
  });

  it('labels a pair by its symbol, the arrow of the direction and the payout', () => {
    expect(signalButtonLabel(pairLabel(PAIR_EURUSD), TradeAction.Up, 85)).toBe('EUR/USD ⬆️ 85%');
    expect(signalButtonLabel(pairLabel(PAIR_EURUSD), TradeAction.Down, 85)).toBe('EUR/USD ⬇️ 85%');
  });

  // a pair that refuses 5 s has no button on the list; a list of another interval in the body
  // (an older backend's `15s`) is not read (#685)
  describe('the 5s list (#382, #685)', () => {
    const BOTH = signalsResponse(NOW, {
      '5s': [
        [PAIR_SHORT.id, TradeAction.Down],
        [PAIR_MINUTE_ONLY.id, TradeAction.Up],
        [PAIR_15S_ONLY.id, TradeAction.Up],
      ],
    });
    const WITH_15S = {
      ...BOTH,
      lists: [
        {
          interval: '15s' as const,
          scanned: 1,
          summary: EMPTY_SCAN_SUMMARY,
          signals: [
            { ...BOTH.lists[0]!.signals[0]!, assetId: PAIR_EURUSD.id, action: TradeAction.Up },
          ],
        },
        ...BOTH.lists,
      ],
    };
    const CATALOG = catalogOf(PAIR_EURUSD, PAIR_SHORT, PAIR_MINUTE_ONLY, PAIR_15S_ONLY);

    it.each([BOTH, WITH_15S])('joins the 5s list only', async (response) => {
      const { press, calls } = setup({
        readSignals: () => Promise.resolve(response),
        readPairs: CATALOG,
      });
      await press(LIST);

      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }).value);
      expect(rowsOf(edited)).toEqual([
        [button('BTC/USD ⬇️ 90%', demoLaunchCallbackData(PAIR_SHORT.id, 5))],
        ...LIST_FOOTER,
      ]);
    });

    // #631: the 5 s list fills up to five with a pair paying below 80 % too (#379 left it out)
    it('lists a pair paying below 80 % after the others on the 5s list', async () => {
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
      await press(LIST);

      expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
        [
          button('BTC/USD ⬇️ 90%', demoLaunchCallbackData(PAIR_SHORT.id, 5)),
          button('US10Y ⬇️ 70%', demoLaunchCallbackData(PAIR_OTHER_TYPE.id, 5)),
        ],
        ...LIST_FOOTER,
      ]);
    });
  });

  it('sends the screen anew when the message to refresh is gone', async () => {
    const { press, calls, apiErrors } = setup({ readSignals: () => Promise.resolve(ROUTE) });
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(LIST);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(ROWS);
  });

  it('the footer: refresh · manual · menu in one row, under a full list', async () => {
    const full = setup({ readSignals: () => Promise.resolve(ROUTE) });
    await full.press(LIST);
    const edited = payloadOf(full.calls, 'editMessageText');
    expect(rowsOf(edited).slice(-1)).toEqual([[REFRESH, MANUAL, MENU]]);
    // #475: each pair green or red by its signal, the refresh blue, manual and menu no colour
    expect(inlineRoles(edited)).toEqual([
      [ButtonRole.Up, ButtonRole.Down],
      [ButtonRole.Down],
      [ButtonRole.Secondary, ButtonRole.Nav, ButtonRole.Nav],
    ]);
    expect(inlineStyles(edited)).toEqual([
      ['success', 'danger'],
      ['danger'],
      ['primary', null, null],
    ]);
  });

  // #664: the wait for the signals, edited into the list by signal-wait.ts
  describe('the wait for signals (#664)', () => {
    // #859: the wait is the scanner's animation, its caption the backend's summary
    const SCANNING = () =>
      Promise.resolve(
        signalsResponse(
          NOW,
          { '5s': [[PAIR_CLOSED.id, TradeAction.Up]] },
          {
            scanned: 115,
            summary: {
              streaming: true,
              scanning: PAIR_EURUSD.id,
              closeness: [{ assetId: PAIR_EURUSD.id, pct: 82 }],
            },
          },
        ),
      );
    const SCAN_CAPTION = [
      '🛰 Сканирую рынок · 115 пар · 6\u00a0900 проверок в минуту',
      `Сейчас: ${pairLabel(PAIR_EURUSD)}`,
      '✅ Котировки  ✅ Движение цены  ⏳ Отбор сигнала',
      `Ближе всего к сигналу: ${pairLabel(PAIR_EURUSD)} 82 %`,
    ].join('\n');
    const mediaOf = (payload: Record<string, unknown> | undefined) =>
      payload?.media as { type: string; caption: string; parse_mode: string } | undefined;

    it("W-media1 an empty list becomes the scanner's animation in place, its caption the summary, manual and menu", async () => {
      const { press, calls, signalWaiter } = setup({ readSignals: SCANNING });
      await press(LIST);
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageMedia']);
      const edited = payloadOf(calls, 'editMessageMedia');
      expect(mediaOf(edited)).toMatchObject({ type: 'animation', parse_mode: 'HTML' });
      expect(plainTextOf(mediaOf(edited)?.caption ?? '')).toBe(SCAN_CAPTION);
      expect(rowsOf(edited)).toEqual([[MANUAL, MENU]]);
      expect(signalWaiter.waitList.mock.calls[0]?.[0]).toMatchObject({
        chatId: USER.id,
        telegramUserId: USER.id,
        media: 'animation',
        scanned: true,
        shown: false,
      });
    });

    it('W-media1 the status card’s button sends the animation as a new message', async () => {
      const { press, calls, signalWaiter } = setup({ readSignals: SCANNING });
      await press(DEMO_CALLBACK_DATA);
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendAnimation']);
      expect(plainTextOf(payloadOf(calls, 'sendAnimation')?.caption as string)).toBe(SCAN_CAPTION);
      expect(signalWaiter.waitList.mock.calls[0]?.[0]).toMatchObject({
        messageId: SCAN_MESSAGE_ID,
        media: 'animation',
      });
    });

    it('W-media2 a gone message gets the animation as a new message', async () => {
      const { press, calls, apiErrors, signalWaiter } = setup({ readSignals: SCANNING });
      apiErrors.set('editMessageMedia', EDIT_GONE);
      await press(LIST);
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageMedia', 'sendAnimation']);
      expect(signalWaiter.waitList.mock.calls[0]?.[0]).toMatchObject({
        messageId: SCAN_MESSAGE_ID,
        media: 'animation',
      });
    });

    it('W-media3 an animation refused for its file is forgotten and the wait goes as text', async () => {
      const { press, calls, apiErrors, answers, signalWaiter, logger } = setup({
        readSignals: SCANNING,
      });
      answers.set('sendAnimation', animationAnswer(SCAN_MESSAGE_ID, SCAN_FILE_ID));
      // a first send brings the file_id, so the refused edit names it
      await press(DEMO_CALLBACK_DATA);
      calls.length = 0;
      signalWaiter.waitList.mockClear();
      apiErrors.set('editMessageMedia', ANIMATION_REFUSED);
      await press(LIST);
      expect(methods(calls)).toEqual([
        'answerCallbackQuery',
        'editMessageMedia',
        'editMessageText',
      ]);
      expect(mediaOf(payloadOf(calls, 'editMessageMedia'))).toMatchObject({ media: SCAN_FILE_ID });
      expect(plainTextOf(payloadOf(calls, 'editMessageText')?.text as string)).toBe(SCAN_CAPTION);
      expect(signalWaiter.waitList.mock.calls[0]?.[0]).toMatchObject({ media: 'text' });
      expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
        'the scan animation was refused, sending the text',
      ]);
      // the next one uploads the file again: a file, not the forgotten id
      await press(DEMO_CALLBACK_DATA);
      const sent = calls.filter((call) => call.method === 'sendAnimation');
      expect(sent.map((call) => typeof call.payload.animation)).toEqual(['object']);
    });

    it('W-media4 a press under the animation draws the next screen as a new message, no edit', async () => {
      const { bot, calls } = setup({ readSignals: SCANNING });
      await bot.handleUpdate(animationCallbackUpdate(LIST));
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendAnimation']);
      calls.length = 0;
      await bot.handleUpdate(animationCallbackUpdate(DEMO_GROUPS_CALLBACK_DATA));
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    });

    it('a list with pairs is registered as shown, on the message it landed on', async () => {
      const { press, signalWaiter } = setup({ readSignals: () => Promise.resolve(ROUTE) });
      await press(LIST);
      expect(signalWaiter.waitList.mock.calls[0]?.[0]).toMatchObject({ shown: true });
    });

    it('the status card’s button registers the list it sends as a new message', async () => {
      const { press, signalWaiter } = setup();
      await press(DEMO_CALLBACK_DATA);
      expect(signalWaiter.waitList.mock.calls[0]?.[0]).toMatchObject({
        messageId: TEXT_CARD_MESSAGE_ID,
        shown: true,
      });
    });

    it('a refusal of the reads is no wait', async () => {
      const { press, signalWaiter } = setup({
        readSignals: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      });
      await press(LIST);
      expect(signalWaiter.waitList).not.toHaveBeenCalled();
    });

    it('a press elsewhere and a command end the wait, a plain text does not', async () => {
      const { bot, press, signalWaiter } = setup();
      await press(MENU_CALLBACK_DATA);
      expect(signalWaiter.leave).toHaveBeenCalledWith(USER.id);
      signalWaiter.leave.mockClear();
      await bot.handleUpdate(textUpdate('hello'));
      expect(signalWaiter.leave).not.toHaveBeenCalled();
      await bot.handleUpdate(textUpdate('/help'));
      expect(signalWaiter.leave).toHaveBeenCalledWith(USER.id);
    });
  });

  it('draws no list from a catalog the backend does not call fresh', async () => {
    const { press, calls, logger } = setup({
      readSignals: () => Promise.resolve(ROUTE),
      readPairs: () => Promise.resolve(pairsResponse({ fresh: false })),
    });
    await press(LIST);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.demoCatalogStale.value);
    expect(rowsOf(edited)).toEqual(retryFooter(LIST));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says the service is unavailable and warns by name and code when the signals are not read', async () => {
    const { press, calls, logger } = setup({
      readSignals: () =>
        Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 500 })),
    });
    await press(LIST);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(edited)).toEqual(retryFooter(LIST));
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
        Promise.resolve({
          ...only15,
          lists: only15.lists.map((l) => ({ ...l, interval: '15s' as const })),
        }),
    });
    await press(LIST);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(edited)).toEqual(retryFooter(LIST));
    expect(logger.warn.mock.calls).toEqual([[{ interval: '5s' }, 'trading signals list missing']]);
  });
});

// #476: in demo a pair of the list, the analysis's session row, the offer under a finished trade
// and «🔁 Ещё сессия» open the amount screen; in real the launch screen stays (#327)
describe('the amount screen (#476)', () => {
  const LAUNCH = demoLaunchCallbackData(PAIR_EURUSD.id, 5);
  const amount = (value: string, label: string, back: 'l' | 'a' = 'l', durationSec: 5 = 5) =>
    button(label, cycleStakeCallbackData(PAIR_EURUSD.id, durationSec, value, back));
  const CUSTOM = button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 5, 'l'));
  const BACK_LIST = button(LABELS.backToListButton, DEMO_SIGNALS_CALLBACK_DATA);
  const BACK_ANALYSIS = button(
    LABELS.stakeBackAnalysisButton,
    demoAnalysisCallbackData(PAIR_EURUSD.id, 5),
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

  it('shows the pair at 5 s, the cycle and the amounts in place of the list, without «🚀 Запустить цикл» (D-screen)', async () => {
    const { press, calls, readSignals, evaluateSignal } = setup();
    await press(LAUNCH);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = payloadOf(calls, 'editMessageText');
    expect(plainTextOf(edited?.text as string)).toBe(
      `🎯 ${pairLabel(PAIR_EURUSD)} · ⏱ 5 с\n🤖 Бот проведёт 5 циклов подряд и перед каждой сделкой проверит сигнал. Это демо: деньги не нужны.\n\nВыбери сумму сделки 👇`,
    );
    expect(rowsOf(edited)).toEqual(DEFAULT_ROWS);
    const labels = rowsOf(edited)
      .flat()
      .map((key) => key.text);
    expect(labels).not.toContain(LABELS.launchCycleButton);
    expect(labels).not.toContain(LABELS.stakeChangeButton);
    expect(labels).not.toContain(LABELS.stakeResetButton);
    // #828: the list's door was drawn on a shown H1 signal: no list is read again
    expect(readSignals).not.toHaveBeenCalled();
    expect(evaluateSignal).not.toHaveBeenCalled();
  });

  // #664, #828: the door drawn without a signal (`n`) reads the H1 list at its press; a pair not in
  // it waits for its signal, with the other pairs that have one now. The doors of the list and the
  // analysis card read none
  describe("the pair's signal at the press (#509, #664, #828)", () => {
    const DOOR_N = demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n');
    const WAIT_TEXT = TEXTS.pairWaiting({ symbol: pairLabel(PAIR_EURUSD), label: '⏱ 5 с' }).value;
    const ALTERNATIVES = signalsOf(
      [PAIR_SHORT.id, TradeAction.Down],
      [PAIR_OTHER_TYPE.id, TradeAction.Up],
    );
    // #859: the pair's scanner lines once the list was read; no closeness of its own here
    const NO_MOVE = `🛰 <b>Сканирую ${pairLabel(PAIR_EURUSD)}</b> · жду движение цены`;
    const stages = (moves: string) => `✅ Котировки  ${moves} Движение цены  ⏳ Отбор сигнала`;
    const captionOf = (calls: readonly ApiCall[]) =>
      payloadOf(calls, 'sendAnimation')?.caption as string | undefined;

    it('W-door1 the door n on a pair absent from the list waits: the other pairs two a row, manual and menu; no evaluateSignal', async () => {
      const { press, calls, evaluateSignal, signalWaiter } = setup({
        readSignals: () => Promise.resolve(ALTERNATIVES),
      });
      await press(DOOR_N);
      const edited = payloadOf(calls, 'sendAnimation');
      expect(edited?.caption).toBe(
        `${WAIT_TEXT}\n\n${NO_MOVE}\n${stages('✅')}\n\n${TEXTS.pairWaitingAlternatives.value}`,
      );
      expect(rowsOf(edited)).toEqual([
        [
          button('BTC/USD ⬇️ 90%', demoLaunchCallbackData(PAIR_SHORT.id, 5)),
          button('US10Y ⬆️ 70%', demoLaunchCallbackData(PAIR_OTHER_TYPE.id, 5)),
        ],
        [MANUAL, MENU],
      ]);
      expect(evaluateSignal).not.toHaveBeenCalled();
      const request = signalWaiter.waitPair.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        assetId: PAIR_EURUSD.id,
        origin: 'door',
        back: 'a',
        media: 'animation',
        scanned: true,
      });
      const alternatives = request?.alternatives;
      expect(Array.isArray(alternatives) ? alternatives.map(({ pair }) => pair.id) : []).toEqual([
        PAIR_SHORT.id,
        PAIR_OTHER_TYPE.id,
      ]);
    });

    it('W-door2 the door n waits without alternatives when the signals are not read or the list is missing, one warn', async () => {
      for (const [readSignals, line] of [
        [
          () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
          'trading signals not read',
        ],
        [
          () =>
            Promise.resolve({
              ...ALTERNATIVES,
              lists: ALTERNATIVES.lists.map((l) => ({ ...l, interval: '15s' as const })),
            }),
          'trading signals list missing',
        ],
      ] as const) {
        const { press, calls, logger, signalWaiter } = setup({ readSignals });
        await press(DOOR_N);
        const edited = payloadOf(calls, 'sendAnimation');
        // no list read: no scanner lines, the wait's first poll draws them
        expect(edited?.caption).toBe(WAIT_TEXT);
        expect(rowsOf(edited)).toEqual([[MANUAL, MENU]]);
        expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([line]);
        expect(signalWaiter.waitPair.mock.calls[0]?.[0]).toMatchObject({
          alternatives: 'done',
          scanned: false,
        });
      }
    });

    it('W-door3 a pair in the list opens the amounts in demo and the launch in real by the door n', async () => {
      const demo = setup();
      await demo.press(DOOR_N);
      expect(payloadOf(demo.calls, 'sendMessage')?.text).toContain('Выбери сумму сделки 👇');
      expect(demo.signalWaiter.waitPair).not.toHaveBeenCalled();
      const real = setup({
        readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
      });
      await real.press(DOOR_N);
      expect(rowsOf(payloadOf(real.calls, 'sendMessage'))[0]?.[0]?.callback_data).toBe(
        sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5, true),
      );
    });

    // #828: a signal lives a second; the list's and the card's doors open the next step at once
    it.each([
      ['the list', LAUNCH, 'editMessageText'],
      ['the analysis card', demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'), 'editMessageText'],
    ] as const)(
      'W-door3′ the door of %s opens the next step with the pair out of the list, reading no list',
      async (_door, data, method) => {
        for (const mode of [TradeMode.Demo, TradeMode.Real]) {
          const { press, calls, readSignals, signalWaiter } = setup({
            readSignals: () => Promise.resolve(ALTERNATIVES),
            readTradingAccess: () => Promise.resolve(accessView({ tradingMode: mode })),
          });
          await press(data);
          expect(readSignals).not.toHaveBeenCalled();
          expect(signalWaiter.waitPair).not.toHaveBeenCalled();
          const shown = payloadOf(calls, method);
          if (mode === TradeMode.Demo) {
            expect(shown?.text).toContain('Выбери сумму сделки 👇');
          } else {
            expect(rowsOf(shown)[0]?.[0]?.callback_data).toBe(
              sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5, true),
            );
          }
        }
      },
    );

    it('W-door4 a door under a trade or a session answers the wait as a new message and registers it', async () => {
      const { press, calls, signalWaiter } = setup({
        readSignals: () => Promise.resolve(signalsOf()),
      });
      await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n'));
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendAnimation']);
      expect(captionOf(calls)).toBe(`${WAIT_TEXT}\n\n${NO_MOVE}\n${stages('⏳')}`);
      expect(signalWaiter.waitPair.mock.calls[0]?.[0]).toMatchObject({
        messageId: SCAN_MESSAGE_ID,
        back: 'a',
        alternatives: 'done',
        media: 'animation',
      });
    });

    it("W-media5 the door's wait prints its own pair's closeness to the threshold", async () => {
      const { press, calls } = setup({
        readSignals: () =>
          Promise.resolve(
            signalsResponse(
              NOW,
              {},
              {
                scanned: 3,
                summary: {
                  streaming: false,
                  scanning: PAIR_SHORT.id,
                  closeness: [
                    { assetId: PAIR_SHORT.id, pct: 90 },
                    { assetId: PAIR_EURUSD.id, pct: 47 },
                  ],
                },
              },
            ),
          ),
      });
      await press(DOOR_N);
      expect(plainTextOf(captionOf(calls) ?? '')).toBe(
        [
          plainTextOf(WAIT_TEXT),
          '',
          `🛰 Сканирую ${pairLabel(PAIR_EURUSD)} · движение 47 % от порога сигнала`,
          '⏳ Котировки  ✅ Движение цены  ⏳ Отбор сигнала',
        ].join('\n'),
      );
    });

    it("W-media5 the door's animation refused for its file: the wait goes as a text message", async () => {
      const { press, calls, apiErrors, signalWaiter } = setup({
        readSignals: () => Promise.resolve(signalsOf()),
      });
      apiErrors.set('sendAnimation', ANIMATION_REFUSED);
      await press(DOOR_N);
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendAnimation', 'sendMessage']);
      expect(payloadOf(calls, 'sendMessage')?.text).toBe(
        `${WAIT_TEXT}\n\n${NO_MOVE}\n${stages('⏳')}`,
      );
      expect(signalWaiter.waitPair.mock.calls[0]?.[0]).toMatchObject({
        messageId: TEXT_CARD_MESSAGE_ID,
        media: 'text',
      });
    });

    it.each([
      [
        'the pair in the list',
        () => Promise.resolve(signalsOf([PAIR_EURUSD.id, TradeAction.Up])),
        LAUNCH,
      ],
      ['the pair not in it', () => Promise.resolve(ALTERNATIVES), LAUNCH],
      ['the list not read', () => Promise.reject(new Error('down')), LAUNCH],
      [
        'the analysis door',
        () => Promise.resolve(signalsOf()),
        demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'),
      ],
      [
        'a new message',
        () => Promise.resolve(signalsOf()),
        demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n'),
      ],
    ] as const)('W-door5 says no «нет сигнала» with %s', async (_case, readSignals, data) => {
      for (const mode of [TradeMode.Demo, TradeMode.Real]) {
        const { press, calls } = setup({
          readSignals,
          readTradingAccess: () => Promise.resolve(accessView({ tradingMode: mode })),
        });
        await press(data);
        for (const call of calls) {
          expect(String(call.payload.text ?? call.payload.caption ?? '')).not.toMatch(
            /нет сигнала|сигнала нет/i,
          );
        }
      }
    });

    // #631: no payout refusal stands before the signal (#379 refused a pair below 80 % first)
    it('a pair paying 79 % meets the signal check like any other', async () => {
      const { press, calls } = setup({
        readPairs: () =>
          Promise.resolve(pairsResponse({ pairs: [{ ...PAIR_EURUSD, payout: 79 }] })),
        readSignals: () => Promise.resolve(signalsOf()),
      });
      await press(DOOR_N);
      expect(captionOf(calls)?.startsWith(WAIT_TEXT)).toBe(true);
    });
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
    expect(rowsOf(edited)).toEqual([[button(LABELS.demoRetryButton, LAUNCH), BACK_LIST]]);
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
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n'));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual([
      [
        button(LABELS.demoRetryButton, demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a')),
        BACK_ANALYSIS,
      ],
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
      expect(rowsOf(edited).at(-1)?.at(-1)).toEqual(BACK_LIST);
      expect(
        rowsOf(edited)
          .flat()
          .some((key) => key.callback_data?.startsWith('demo:sa:')),
      ).toBe(false);
    },
  );

  it('edits the analysis in place into the screen, its way back the analysis (`a`)', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
      [amount('1', '$1.00 ✅', 'a'), amount('2', '$2.00', 'a'), amount('5', '$5.00', 'a')],
      [amount('10', '$10.00 · риск', 'a')],
      [
        button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 5, 'a')),
        BACK_ANALYSIS,
      ],
    ]);
  });

  it('sends the screen as a new message under a trade or a session, which stays (D-n)', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n'));
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
    await demo.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
    expect(rowsOf(cardOf(demo.calls))[0]).toEqual([
      button('🚀 Сессия из 5 циклов', `demo:l:${String(PAIR_EURUSD.id)}:5:a`),
    ]);
    const real = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await real.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
    expect(rowsOf(cardOf(real.calls))[0]).toEqual([
      button(
        '🚀 Сессия из 5 циклов · REAL',
        sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
      ),
    ]);
  });

  // T-back: the typed amount's prompt has «↩️ Назад» to this screen, which ends the step
  it('ends the typed amount step left open, and only that step (T-back)', async () => {
    const cycle = setup({
      dialog: { step: 'cycleStake', assetId: PAIR_EURUSD.id, durationSec: 5, back: 'l' },
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
          sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5, true),
        ),
      ],
      [
        button(LABELS.stakeChangeButton, `stk:o:r:p:${String(PAIR_EURUSD.id)}:5`),
        button(LABELS.backToListButton, DEMO_SIGNALS_CALLBACK_DATA),
      ],
    ]);
    // #475: the cycle green on its own row, the stake blue beside the way back
    expect(inlineStyles(edited)).toEqual([['success'], ['primary', null]]);
    expect(plainTextOf(edited?.text as string)).toBe(
      `🎯 ${pairLabel(PAIR_EURUSD)} · ⏱ 5 с\n💵 Ставка: $3.00\n🤖 Бот проведёт 5 циклов подряд и перед каждой сделкой проверит сигнал. Реальный режим: сделки идут на реальные деньги.`,
    );
  });

  it('refuses a pair that closed after the list was drawn', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_CLOSED.id, 5));

    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      TEXTS.demoPairClosed({ symbol: pairLabel(PAIR_CLOSED) }).value,
    );
  });

  it('refuses a pair that does not take the duration', async () => {
    const { press, calls } = setup();
    await press(demoLaunchCallbackData(PAIR_MINUTE_ONLY.id, 5));

    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      TEXTS.demoDurationUnsupported({ symbol: pairLabel(PAIR_MINUTE_ONLY), label: '⏱ 5 с' }).value,
    );
  });

  // #631: a pair paying below 80 % opens its cycle like any other (#379 refused it)
  it.each([5] as const)(
    'offers the amounts on US10Y paying 70 percent at %i s',
    async (durationSec) => {
      const { press, calls } = setup({
        readSignals: () => Promise.resolve(signalsOf([PAIR_OTHER_TYPE.id, TradeAction.Up])),
      });
      await press(demoLaunchCallbackData(PAIR_OTHER_TYPE.id, durationSec));

      expect(rowsOf(payloadOf(calls, 'editMessageText'))[0]).toEqual([
        button('$1.00 ✅', cycleStakeCallbackData(PAIR_OTHER_TYPE.id, durationSec, '1', 'l')),
        button('$2.00', cycleStakeCallbackData(PAIR_OTHER_TYPE.id, durationSec, '2', 'l')),
        button('$5.00', cycleStakeCallbackData(PAIR_OTHER_TYPE.id, durationSec, '5', 'l')),
      ]);
    },
  );

  // #327: in real mode the launch screen, at 70 % as at any payout
  it('draws the real launch screen on US10Y paying 70 percent for a user in real mode', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
      readSignals: () => Promise.resolve(signalsOf([PAIR_OTHER_TYPE.id, TradeAction.Up])),
    });
    await press(demoLaunchCallbackData(PAIR_OTHER_TYPE.id, 5));
    expect(rowsOf(payloadOf(calls, 'editMessageText'))[0]?.[0]?.callback_data).toBe(
      sessionStartCallbackData(TradeMode.Real, PAIR_OTHER_TYPE.id, 5, true),
    );
  });

  it.each([5] as const)(
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

  it.each(['demo:l:0:5', 'demo:l:0:5:a', 'demo:l:0:5:n'])(
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
    expect(Buffer.byteLength(demoLaunchCallbackData(MAX_ID, 5))).toBe(19);
    expect(Buffer.byteLength(demoLaunchCallbackData(MAX_ID, 5, 'n'))).toBe(21);
    expect(Buffer.byteLength(cycleStakeCallbackData(MAX_ID, 5, '999999999999.99999999', 'a'))).toBe(
      44,
    );
    expect(Buffer.byteLength(cycleCustomCallbackData(MAX_ID, 5, 'a'))).toBe(22);
    expect(Buffer.byteLength(launchStakeCallbackData(TradeMode.Real, MAX_ID, 5))).toBe(22);
    expect(Buffer.byteLength(DEMO_SIGNALS_CALLBACK_DATA)).toBe(8);
  });

  it('draws the `l` origin without a token, as the list did before #476', () => {
    expect(demoLaunchCallbackData(101, 5)).toBe('demo:l:101:5');
    expect(demoLaunchCallbackData(101, 5, 'l')).toBe('demo:l:101:5');
    expect(demoLaunchCallbackData(101, 5, 'a')).toBe('demo:l:101:5:a');
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
        button('💠 Крипта · 1', demoPageCallbackData('cryptocurrency', 0)),
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

  // #313, #685: only the pairs that accept 5 s are listed
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
      'demo:sig:15',
      demoLaunchCallbackData(101, 5),
      'demo:l:101:15',
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

  // #428: the live catalog lists a symbol twice, a regular pair and an OTC one; #631: the twins
  // share the label, so they go by id and differ by payout
  it('labels the OTC twin as its regular pair and lists them by id', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_EURUSD_REGULAR, PAIR_EURUSD) });
    await press(demoPageCallbackData('currency', 0));
    expect(rowsOf(payloadOf(calls, 'editMessageText'))[0]).toEqual([
      button('EUR/USD 85%', demoAssetCallbackData(PAIR_EURUSD.id)),
      button('EUR/USD 54%', demoAssetCallbackData(PAIR_EURUSD_REGULAR.id)),
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

// the manual path's pair (#685): its summary at 5 s, no duration to choose
describe("a pair's summary", () => {
  const SUMMARY_ROWS = [
    [button(LABELS.demoAnalysisButton, demoAnalysisCallbackData(101, 5))],
    [BACK_EURUSD_PAGE, BACK_GROUPS],
  ];

  it('a pair opens its summary at 5 s with analysis, assets and types', async () => {
    const { press, calls, readPairs } = setup();
    await press(demoAssetCallbackData(PAIR_EURUSD.id));

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(demoSummary(PAIR_EURUSD, 5).value);
    expect(plainTextOf(edited?.text as string)).toContain('⏱ Длительность: ⏱ 5 с');
    expect(rowsOf(edited)).toEqual(SUMMARY_ROWS);
    expect(readPairs).toHaveBeenCalledTimes(1);
  });

  it('`demo:d:<id>:5` of an old button opens the same summary', async () => {
    const { press, calls } = setup();
    await press(`demo:d:${String(PAIR_EURUSD.id)}:5`);

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(demoSummary(PAIR_EURUSD, 5).value);
    expect(rowsOf(edited)).toEqual(SUMMARY_ROWS);
  });

  it("leads back to the pair's own page", async () => {
    const narrow = { ...PAIR_EURUSD, symbol: 'ZAR/USD', minTimeframe: 5, maxTimeframe: 900 };
    const { press, calls } = setup({ readPairs: catalogOf(...MANY, narrow) });
    await press(demoAssetCallbackData(narrow.id));

    // «ZAR/USD» sorts after P00 … P24, so it is the second item of page 2
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual([
      [button(LABELS.demoAnalysisButton, demoAnalysisCallbackData(narrow.id, 5))],
      [button(LABELS.demoBackPairsButton, demoPageCallbackData('currency', 2)), BACK_GROUPS],
    ]);
  });

  // an old pair button of a pair the pages no longer list (#313, #685): the way back is page 0
  it('a pair that does not take 5 s says so with the way back to its page', async () => {
    const { press, calls } = setup({
      readPairs: catalogOf({ ...PAIR_SHORT, minTimeframe: 15, maxTimeframe: 3600 }),
    });
    await press(demoAssetCallbackData(PAIR_SHORT.id));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(
      TEXTS.demoDurationUnsupported({ symbol: pairLabel(PAIR_SHORT), label: '⏱ 5 с' }).value,
    );
    expect(plainTextOf(edited?.text as string)).toBe(
      `❌ ${pairLabel(PAIR_SHORT)} не принимает сделки на ⏱ 5 с. Выбери другой актив.`,
    );
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

  // the acceptance criterion: the check runs on the catalog read at the press
  it('refuses «📊 Анализ» for a pair that closed after the summary was drawn', async () => {
    const closing = { ...PAIR_EURUSD, scheduledUntil: NOW + 60_000 };
    const reads = [catalogOf(PAIR_EURUSD), catalogOf(closing)];
    const { press, calls, readPairs, evaluateSignal } = setup({
      readPairs: () => (reads.shift() ?? catalogOf())(),
    });
    await press(demoAssetCallbackData(PAIR_EURUSD.id));
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));

    const edits = calls.filter((call) => call.method === 'editMessageText');
    expect(edits.map((call) => call.payload.text)).toEqual([
      demoSummary(PAIR_EURUSD, 5).value,
      TEXTS.demoPairClosed({ symbol: pairLabel(PAIR_EURUSD) }).value,
    ]);
    expect(evaluateSignal).not.toHaveBeenCalled();
    expect(readPairs).toHaveBeenCalledTimes(2);
  });

  it.each([demoAssetCallbackData(PAIR_EURUSD.id), `demo:d:${String(PAIR_EURUSD.id)}:5`])(
    'shows no «📊 Анализ» on a catalog the backend does not call fresh, the retry the press: %s',
    async (data) => {
      const { press, calls } = setup({
        readPairs: () => Promise.resolve(pairsResponse({ ageMs: 90_000, fresh: false })),
      });
      await press(data);

      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(TEXTS.demoCatalogStale.value);
      expect(rowsOf(edited)).toEqual([[button(LABELS.demoRetryButton, data)]]);
    },
  );

  it('refuses a pair gone from the catalog', async () => {
    const { press, calls } = setup({ readPairs: catalogOf(PAIR_SHORT) });
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));

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
  const SESSION = button('🚀 Сессия из 5 циклов', demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'));
  const MORE = button(
    LABELS.analysisMoreButton,
    analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, TradeMode.Demo),
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
  // the wait for a signal under the analysis (#664)
  const WAIT_ROWS = [[MANUAL, MENU]];
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
  // the wait (#859): «⏳» turned into the scanner's animation, or one sent anew
  const waitOf = (calls: readonly ApiCall[]) =>
    calls.filter((call) => ['editMessageMedia', 'sendAnimation'].includes(call.method)).at(-1)
      ?.payload;
  const captionOf = (payload: Record<string, unknown> | undefined) =>
    (payload?.media as { caption?: unknown } | undefined)?.caption ?? payload?.caption;
  // the amounts of #476 under a demo card (#482), their way back the analysis, then «✏️ Ввести»
  const amountOf = (value: string, label: string, durationSec: 5 = 5) =>
    button(label, cycleStakeCallbackData(PAIR_EURUSD.id, durationSec, value, 'a'));
  const AMOUNTS = [
    [amountOf('1', '$1.00 ✅'), amountOf('2', '$2.00'), amountOf('5', '$5.00')],
    [amountOf('10', '$10.00 · риск')],
  ];
  // #475: «✏️ Ввести» joins the actions under the amounts; «🔄 Заново» and the way back a row of
  // three
  const CUSTOM = button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 5, 'a'));
  const TAIL_ROW = [REPEAT, BACK_EURUSD_PAIR, BACK_GROUPS];
  const pressed = (scene: ReturnType<typeof setup>, data = DATA) => {
    const update = callbackUpdate(data);
    return {
      run: () => scene.bot.handleUpdate(update),
      messageId: (update.callback_query?.message as { message_id: number }).message_id,
    };
  };

  // #482, #875: a signal is a card that «⏳» becomes; in demo the amounts first, the single trade
  // behind «➕ Ещё»; the amount is read at the expansion
  it('AN2 reads the catalog, shows «⏳», asks for the signal, then edits «⏳» into the card', async () => {
    const scene = setup();
    const { calls, readPairs, evaluateSignal, readTradingAccess } = scene;
    const press = pressed(scene);
    await press.run();

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'editMessageMedia']);
    const [waiting] = edits(calls);
    expect(waiting?.payload.text).toBe(TEXTS.analyzing({ subject: 'EUR/USD · ⏱ 5 с' }).value);
    // without a keyboard the edit removes the summary's, so «📊 Анализ» cannot be pressed twice
    expect(waiting?.payload.reply_markup).toBeUndefined();
    const card = cardOf(calls);
    expect(card?.caption).toBe(resultOf(SIGNAL_DECIDED, true));
    expect(card?.parse_mode).toBe('HTML');
    expect(card?.photo).toBeInstanceOf(InputFile);
    expect((card?.photo as InputFile).filename).toBe('setup-bull.png');
    expect(rowsOf(card)).toEqual([...AMOUNTS, [CUSTOM, MORE], TAIL_ROW]);
    expect(card).toMatchObject({ chat_id: USER.id, message_id: press.messageId });
    expect(readPairs).toHaveBeenCalledTimes(1);
    // the analysis of this user and duration, which the backend records for the reminder (#484)
    expect(evaluateSignal.mock.calls).toEqual([
      [PAIR_EURUSD.id, '5s', { telegramUserId: '4242', durationSec: 5 }],
    ]);
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
          '🚀 Сессия из 5 циклов · REAL',
          sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
        ),
      ],
      [
        button(
          LABELS.analysisMoreButton,
          analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, TradeMode.Real),
        ),
        REPEAT,
      ],
      [BACK_EURUSD_PAIR, BACK_GROUPS],
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
      CUSTOM,
      button(
        LABELS.analysisMoreButton,
        analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Down, TradeMode.Demo),
      ),
    ]);
    // the bear's picture for a signal down (#482)
    expect((cardOf(calls)?.photo as InputFile).filename).toBe('setup-bear.png');
  });

  // #313: a short trade's analysis runs on its own sub-minute candle, never on 1m
  it.each([[5, '5s']] as const)(
    'asks for the candles of a %i s trade at %s',
    async (durationSec, interval) => {
      const { press, evaluateSignal } = setup();
      await press(demoAnalysisCallbackData(PAIR_EURUSD.id, durationSec));
      expect(evaluateSignal.mock.calls).toEqual([
        [PAIR_EURUSD.id, interval, { telegramUserId: '4242', durationSec }],
      ]);
    },
  );

  it('covers every demo duration in the table above', () => {
    expect(DEMO_DURATIONS_SEC).toEqual([5]);
  });

  // the acceptance criterion: the screen is built from the pair read at this press
  it('prints the payout of the catalog read at this press, not the one the summary showed', async () => {
    const reads = [catalogOf(PAIR_EURUSD), catalogOf({ ...PAIR_EURUSD, payout: 70 })];
    const { press, calls } = setup({ readPairs: () => (reads.shift() ?? catalogOf())() });
    await press(demoAssetCallbackData(PAIR_EURUSD.id));
    await press(DATA);

    const result = cardOf(calls)?.caption;
    expect(result).toBe(
      analysisScreen({
        mode: TradeMode.Demo,
        pair: { ...PAIR_EURUSD, payout: 70 },
        durationSec: 5,
        response: SIGNAL_DECIDED,
        // the amounts are drawn at 70 % as at any payout (#631)
        chooseAmount: true,
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
        stakeCallbackData(2_147_483_647, 5, TradeAction.Down, 'f'.repeat(12), 'f'.repeat(6)),
      ),
    ).toBe(48);
  });

  it("carries stake data #127's request schema accepts", () => {
    for (const action of Object.values(TradeAction)) {
      const data = stakeCallbackData(2_147_483_647, 5, action, 'ffffffffffff', 'a0b1c2');
      const match = STAKE_CALLBACK_PATTERN.exec(data);
      expect(match, data).not.toBeNull();
      const parsed = stakeDataOf(match as RegExpMatchArray);
      expect(parsed).toEqual({
        assetId: 2_147_483_647,
        durationSec: 5,
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

  // #284: a session of five fits the worker's hour at the demo's duration (#313, #685); #509: a
  // rule refusal offers none
  it.each([[5, false]] as const)(
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

  // #482: the amounts and «Выбери сумму…» over them; #631: below 80 % as at it, with no note (#379
  // withheld the session and said why)
  it.each([79, 80])(
    'draws the amounts on a pair paying %i percent, with no note',
    async (payout) => {
      const pair = { ...PAIR_EURUSD, payout };
      const { press, calls } = setup({
        readPairs: () => Promise.resolve(pairsResponse({ pairs: [pair] })),
      });
      await press(DATA);
      const result = cardOf(calls);
      expect(result?.caption).toBe(
        analysisScreen({
          mode: TradeMode.Demo,
          pair,
          durationSec: 5,
          response: SIGNAL_DECIDED,
          chooseAmount: true,
        }).text.value,
      );
      expect(plainTextOf(result?.caption as string).endsWith('\n\nВыбери сумму сделки 👇')).toBe(
        true,
      );
      expect(rowsOf(result)).toEqual([...AMOUNTS, [CUSTOM, MORE], TAIL_ROW]);
    },
  );

  // #327: in real mode the session row starts the real session, at 79 % as at any payout (#631)
  it('draws the real session row on a pair paying 79 percent', async () => {
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ pairs: [{ ...PAIR_EURUSD, payout: 79 }] })),
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await press(DATA);
    expect(rowsOf(cardOf(calls))[0]?.[0]?.callback_data).toBe(
      sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
    );
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
      [MORE, REPEAT],
      [BACK_EURUSD_PAIR, BACK_GROUPS],
    ]);
    expect(cardOf(calls)?.caption).toBe(resultOf());
  });

  // #509: no refusal draws the session row, below 80 % or at it; #631: no note under either (#379
  // closed a refusal below 80 % with one)
  it.each([
    ['a rule refusal', 79, SIGNAL_NO_SIGNAL],
    ['a rule refusal', 80, SIGNAL_NO_SIGNAL],
    ['a data refusal', 79, SIGNAL_DATA_REFUSAL],
    ['a data refusal', 80, SIGNAL_DATA_REFUSAL],
  ] as const)('on %s at %i percent offers no session', async (_case, payout, response) => {
    const pair = { ...PAIR_EURUSD, payout };
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ pairs: [pair] })),
      evaluateSignal: () => Promise.resolve(response),
    });
    await press(DATA);
    const result = waitOf(calls);
    expect(captionOf(result)).toBe(
      analysisScreen({ mode: TradeMode.Demo, pair, durationSec: 5, response, chooseAmount: true })
        .text.value,
    );
    expect(rowsOf(result)).toEqual(WAIT_ROWS);
  });

  it('keeps the longest session datum inside the Bot API limit and reads it back', () => {
    // the demo datum is byte for byte the one before #327
    expect(sessionStartCallbackData(TradeMode.Demo, 2_147_483_647, 5)).toBe(
      'demo:sess:2147483647:5',
    );
    const plain = sessionStartCallbackData(TradeMode.Real, 2_147_483_647, 5);
    expect(plain).toBe('real:sess:2147483647:5');
    expect(sessionStartDataOf(SESSION_START_PATTERN.exec(plain) ?? '')).toEqual({
      mode: TradeMode.Real,
      assetId: 2_147_483_647,
      durationSec: 5,
      launch: false,
    });
    // #418: the launch screen's, with its token, is the longest
    const data = sessionStartCallbackData(TradeMode.Real, 2_147_483_647, 5, true);
    expect(data).toBe('real:sess:2147483647:5:l');
    expect(Buffer.byteLength(data, 'utf8')).toBe(24);
    expect(sessionStartDataOf(SESSION_START_PATTERN.exec(data) ?? '')).toEqual({
      mode: TradeMode.Real,
      assetId: 2_147_483_647,
      durationSec: 5,
      launch: true,
    });
    expect(SESSION_START_PATTERN.exec(`bogus:sess:${String(PAIR_EURUSD.id)}:5`)).toBeNull();
    // a datum with a duration the demo no longer offers is not a session datum: the legacy
    // handler takes it (#313, #685)
    expect(SESSION_START_PATTERN.exec(`demo:sess:${String(PAIR_EURUSD.id)}:300`)).toBeNull();
    expect(SESSION_START_PATTERN.exec(`demo:sess:${String(PAIR_EURUSD.id)}:15`)).toBeNull();
  });

  // the guard of the #313 addendum: every duration of the set fits DEFAULT_SESSION_CYCLES, so
  // the count is passed in to reach it; the bot counts martingale's worst case (#552):
  // 7 × 4 × (5 + 120) s ≤ 1 h, 8 × 4 × 125 s > 1 h
  it('starts nothing when the session does not fit the hour', () => {
    const match =
      SESSION_START_PATTERN.exec(sessionStartCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5)) ?? '';
    expect(sessionStartDataOf(match, 8)).toBeUndefined();
    expect(sessionStartDataOf(match, 7)).toBeDefined();
    expect(sessionStartDataOf(match)).toEqual({
      mode: TradeMode.Demo,
      assetId: PAIR_EURUSD.id,
      durationSec: 5,
      launch: false,
    });
  });

  // #664, #828: no H1 signal is the wait for one, in place of «⏳», whatever the candles said; its
  // card comes from signal-wait.ts. A rate-limited candle fetch is no warning
  it.each([
    ['a rule refusal', SIGNAL_NO_SIGNAL],
    ['a data refusal', SIGNAL_DATA_REFUSAL],
    ['a candle signal without an H1 one', SIGNAL_CANDLE_ONLY],
    ['a rate-limited candle fetch', SIGNAL_FETCH_FAILED],
  ])(
    'W-an1 on %s draws the wait in place of «⏳», manual and menu only, registered as the analysis',
    async (_case, response) => {
      const { press, calls, logger, signalWaiter } = setup({
        evaluateSignal: () => Promise.resolve(response),
      });
      await press(DATA);
      // #859: «⏳» becomes the scanner's animation by its id; the analysis read no list
      expect(methods(calls)).toEqual([
        'answerCallbackQuery',
        'editMessageText',
        'editMessageMedia',
      ]);
      const result = waitOf(calls);
      expect(result?.media).toMatchObject({ type: 'animation', parse_mode: 'HTML' });
      expect(captionOf(result)).toBe(resultOf(response));
      expect(String(captionOf(result))).not.toMatch(/нет сигнала|сигнала нет/i);
      expect(rowsOf(result)).toEqual(WAIT_ROWS);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(signalWaiter.waitPair).toHaveBeenCalledTimes(1);
      expect(signalWaiter.waitPair.mock.calls[0]?.[0]).toMatchObject({
        chatId: USER.id,
        assetId: PAIR_EURUSD.id,
        origin: 'analysis',
        back: 'a',
        alternatives: 'pending',
        media: 'animation',
        scanned: false,
      });
      expect(signalWaiter.waitPair.mock.calls[0]?.[0].base.value).toBe(resultOf(response));
    },
  );

  it('waits on any other candle failure without an H1 signal and warns with the code', async () => {
    const response = {
      outcome: SignalFeedOutcome.FetchFailed,
      code: BrokerRestErrorCode.Unavailable,
      h1: null,
    } as const;
    const { press, calls, logger, signalWaiter } = setup({
      evaluateSignal: () => Promise.resolve(response),
    });
    await press(DATA);

    const result = waitOf(calls);
    expect(captionOf(result)).toBe(resultOf(response));
    expect(rowsOf(result)).toEqual(WAIT_ROWS);
    expect(signalWaiter.waitPair).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls).toEqual([
      [{ signalCode: BrokerRestErrorCode.Unavailable }, 'signal not evaluated'],
    ]);
  });

  // #828: the card is H1's: its title, picture and «➕ Ещё» direction, over a candle refusal
  it('W-an2 draws the H1 card down over a candle no_signal, its stake button down', async () => {
    const { press, calls, signalWaiter } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_H1_ONLY),
    });
    await press(DATA);
    const card = cardOf(calls);
    expect(String(card?.caption)).toContain('Сильный сигнал на падение');
    expect(signalWaiter.waitPair).not.toHaveBeenCalled();
    const more = rowsOf(card)
      .flat()
      .find((key) => key.callback_data?.startsWith('demo:more:'));
    expect(more?.callback_data).toContain(':down');
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
    expect(rowsOf(result)).toEqual([[REPEAT, BACK_EURUSD_PAIR, BACK_GROUPS]]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['signal not evaluated']);
  });

  // #482: a gone summary gets no «⏳» anew, which would cost the call the card's delete needs
  it('sends no «⏳» anew when the summary is gone, and the result after it as a new message', async () => {
    const { press, calls, apiErrors, evaluateSignal, signalWaiter } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendAnimation']);
    const result = payloadOf(calls, 'sendAnimation');
    expect(result?.caption).toBe(resultOf(SIGNAL_NO_SIGNAL));
    expect(rowsOf(result)).toEqual(WAIT_ROWS);
    expect(evaluateSignal).toHaveBeenCalledTimes(1);
    // W-an2: the wait is on the new message
    expect(signalWaiter.waitPair.mock.calls[0]?.[0]).toMatchObject({
      messageId: SCAN_MESSAGE_ID,
      media: 'animation',
    });
  });

  it('sends the card with no «⏳» to delete when the summary is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendPhoto']);
    expect(
      calls.some(
        (call) =>
          call.payload.text === TEXTS.analyzing({ subject: 'EUR/USD · ⏱ 5 с' }).value &&
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

  it("W-media6 sends the wait's animation anew with its keyboard when its edit is refused as gone", async () => {
    const { press, calls, apiErrors, signalWaiter } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
    apiErrors.set('editMessageMedia', EDIT_GONE);
    await press(DATA);

    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageMedia',
      'sendAnimation',
    ]);
    const sent = payloadOf(calls, 'sendAnimation');
    expect(sent?.caption).toBe(resultOf(SIGNAL_NO_SIGNAL));
    expect(sent?.reply_markup).toEqual(payloadOf(calls, 'editMessageMedia')?.reply_markup);
    expect(signalWaiter.waitPair.mock.calls[0]?.[0]).toMatchObject({ messageId: SCAN_MESSAGE_ID });
  });

  it('W-media6 an animation refused for its file: «⏳» becomes the wait as text, a gone one nothing more', async () => {
    const refused = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
    refused.apiErrors.set('editMessageMedia', ANIMATION_REFUSED);
    await refused.press(DATA);
    expect(methods(refused.calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageMedia',
      'editMessageText',
    ]);
    expect(edits(refused.calls).at(-1)?.payload.text).toBe(resultOf(SIGNAL_NO_SIGNAL));
    expect(refused.signalWaiter.waitPair.mock.calls[0]?.[0]).toMatchObject({ media: 'text' });

    const gone = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
    gone.apiErrors.set('editMessageMedia', ANIMATION_REFUSED);
    failFromSecondCall(gone, 'editMessageText', EDIT_GONE);
    await gone.press(DATA);
    expect(methods(gone.calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageMedia',
      'editMessageText',
    ]);
    expect(gone.signalWaiter.waitPair).not.toHaveBeenCalled();
  });

  it('is done when Telegram says the message already shows the wait', async () => {
    const { press, calls, apiErrors, signalWaiter } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
    apiErrors.set('editMessageMedia', EDIT_NOT_MODIFIED);
    await press(DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'editMessageMedia']);
    expect(signalWaiter.waitPair).toHaveBeenCalledTimes(1);
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
  const DATA = analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, TradeMode.Demo);
  const REPEAT = button(LABELS.repeatAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
  // in demo the session row opens the amount screen in place (#476)
  const SESSION = button('🚀 Сессия из 5 циклов', demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'));
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
  // «💵 Сумма»: under the stake button since #475, which takes a row of its own
  const menuOf = (calls: readonly ApiCall[]) =>
    rowsOf(expandedOf(calls).at(-1)?.payload)
      .flat()
      .find((key) => key.text === LABELS.stakeMenuButton);
  // the card's amounts stay above the stake row in demo (#482)
  const amountOf = (value: string, label: string) =>
    button(label, cycleStakeCallbackData(PAIR_EURUSD.id, 5, value, 'a'));
  const AMOUNTS = [
    [amountOf('1', '$1.00 ✅'), amountOf('2', '$2.00'), amountOf('5', '$5.00')],
    [amountOf('10', '$10.00 · риск')],
  ];
  // #475: «✏️ Ввести» joins the actions under the amounts; «🔄 Заново» and the way back a row of
  // three
  const CUSTOM = button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 5, 'a'));
  const TAIL_ROW = [REPEAT, BACK_EURUSD_PAIR, BACK_GROUPS];
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
    // [В2] the amounts stay, the stake button below them on its own row (#475), then «✏️ Ввести»
    // and «💵 Сумма»
    expect(rows.slice(0, AMOUNTS.length)).toEqual(AMOUNTS);
    const [[stake], [custom, menu], ...rest] = rows.slice(AMOUNTS.length);
    expect(custom).toEqual(CUSTOM);
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
    expect(rest).toEqual([TAIL_ROW]);
    // #475: the trade of a ⬆️ signal green, its own row
    expect(inlineRoles(edit?.payload)[AMOUNTS.length]).toEqual([ButtonRole.Forward]);
    expect(inlineStyles(edit?.payload)[AMOUNTS.length]).toEqual(['success']);
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
      await press(analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, TradeMode.Real));
      const rows = rowsOf(expandedOf(calls).at(-1)?.payload);
      const [session, [stake], [menu, repeat], ...rest] = rows;
      expect(session).toEqual([
        button(
          '🚀 Сессия из 5 циклов · REAL',
          sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
        ),
      ]);
      expect(rows[1]).toHaveLength(1);
      expect(repeat).toEqual(REPEAT);
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
      expect(rest).toEqual([[BACK_EURUSD_PAIR, BACK_GROUPS]]);
    },
  );

  it('draws the direction the button carries', async () => {
    const { press, calls } = setup();
    await press(analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Down, TradeMode.Demo));
    const stake = stakeRowOf(calls)?.[0];
    expect(stake?.text).toBe(stakeButtonLabel(TradeAction.Down, '1.00000000'));
    // #475: the trade of a ⬇️ signal red, still on its own row
    expect(stakeRowOf(calls)).toHaveLength(1);
    const edit = expandedOf(calls).at(-1)?.payload;
    const row = rowsOf(edit).findIndex((keys) =>
      keys.some((key) => key.callback_data === stake?.callback_data),
    );
    expect(inlineRoles(edit)[row]).toEqual([ButtonRole.ForwardDown]);
    expect(inlineStyles(edit)[row]).toEqual(['danger']);
    expect(stakeOf(stake?.callback_data)).toMatchObject({
      durationSec: 5,
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
    const [stake] = stakeRowOf(calls) ?? [];
    const menu = menuOf(calls);
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
    const [stake] = stakeRowOf(calls) ?? [];
    const menu = menuOf(calls);
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
    const data = analysisMoreCallbackData(2_147_483_647, longest, TradeAction.Down, TradeMode.Real);
    expect(data).toBe('demo:more:2147483647:5:down:r');
    expect(Buffer.byteLength(data, 'utf8')).toBe(29);
    expect(analysisMoreDataOf(ANALYSIS_MORE_PATTERN.exec(data) ?? '')).toEqual({
      assetId: 2_147_483_647,
      durationSec: 5,
      action: TradeAction.Down,
      renderedMode: TradeMode.Real,
    });
  });

  // Plan 5 (decision 26): «➕ Ещё» draws a stake button only in the mode its analysis was drawn in
  describe('the mode token', () => {
    const datum = (token: string) => `demo:more:${PAIR_EURUSD.id}:5:up${token}`;
    const realAccess = () => Promise.resolve(accessView({ tradingMode: TradeMode.Real }));
    const datas = (calls: readonly ApiCall[]) =>
      rowsOf(expandedOf(calls).at(-1)?.payload)
        .flat()
        .map((b) => b.callback_data ?? '');
    const TAIL = [[REPEAT, BACK_EURUSD_PAIR, BACK_GROUPS]];

    it('marks a real analysis :r and a demo one :d', async () => {
      const real = setup({ readTradingAccess: realAccess });
      await real.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
      const demo = setup();
      await demo.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
      const moreOf = (calls: readonly ApiCall[]) =>
        rowsOf(cardOf(calls))
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

  // #631: the payout floor's token of a datum #379 to #631 drew (`s`/`n`) is read by nobody; in
  // demo the amounts stand where the session row would (#482), whatever the token
  it.each(['', ':s', ':n', ':d', ':s:d', ':n:d'])(
    'draws the amounts for the old or new datum ending %j',
    async (tail) => {
      const { press, calls } = setup();
      await press(`demo:more:${String(PAIR_EURUSD.id)}:5:up${tail}`);
      const rows = rowsOf(expandedOf(calls).at(-1)?.payload);
      expect(rows.some((row) => row.some((b) => b.text === SESSION.text))).toBe(false);
      expect(rows.slice(0, AMOUNTS.length)).toEqual(AMOUNTS);
    },
  );

  // in real the session row, whatever the token (#379 drew none for `n`)
  it.each([':r', ':s:r', ':n:r'])(
    'in real draws the session row for the datum ending %j',
    async (tail) => {
      const { press, calls } = setup({
        readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
      });
      await press(`demo:more:${String(PAIR_EURUSD.id)}:5:up${tail}`);
      const rows = rowsOf(expandedOf(calls).at(-1)?.payload);
      expect(rows.some((row) => row.some((b) => b.callback_data?.startsWith('real:sess:')))).toBe(
        true,
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
    'demo:d:0:5',
    'demo:an:2147483648:5',
    'demo:l:0:5',
    'demo:more:0:5:up',
    'demo:more:2147483648:5:down',
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
    'demo:sig:120',
    'demo:sig:',
    'demo:l:101:120',
    'demo:more:101:120:up',
    'demo:more:101:5:flat',
    'demo:more:101:5',
    'demo:more:101:5:up:x',
    'demo:more:101:5:up:',
    'stk:o:a:101:120',
    'stk:o:p:101:120',
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

// #313, #685: every shape with a duration the demo no longer offers - 15 s until #685, the set
// before #313 - leads to the signals list as a new message; the pressed keyboard stays
describe('a button with a duration the demo no longer offers (#313, #685)', () => {
  const ROUTE = signalsOf([PAIR_EURUSD.id, TradeAction.Up]);
  const LIST_ROWS = [
    [button('EUR/USD ⬆️ 85%', demoLaunchCallbackData(PAIR_EURUSD.id, 5))],
    ...LIST_FOOTER,
  ];
  const SHAPES = (sec: number) =>
    [
      `demo:d:101:${String(sec)}`,
      `demo:an:101:${String(sec)}`,
      `demo:l:101:${String(sec)}`,
      `demo:l:101:${String(sec)}:a`,
      `demo:l:101:${String(sec)}:n`,
      `demo:sa:101:${String(sec)}:5:l`,
      `demo:sc:101:${String(sec)}:a`,
      `demo:more:101:${String(sec)}:up`,
      `demo:more:101:${String(sec)}:up:n:r`,
      `demo:stake:101:${String(sec)}:up:0123456789ab`,
      `demo:stake:101:${String(sec)}:down:0123456789ab:a0b1c2`,
      `demo:sess:101:${String(sec)}`,
      `real:sess:101:${String(sec)}:l`,
    ] as const;
  const LEGACY = [
    ...[15, 60, 300, 900, 1800, 3600].flatMap(SHAPES),
    // #382: the launch screen carried no duration
    'demo:l:101',
  ];

  it.each(LEGACY)(
    '%s: the 5 s list as a new message, the pressed keyboard untouched',
    async (data) => {
      const { press, calls, readPairs, readSignals, evaluateSignal, logger } = setup({
        readSignals: () => Promise.resolve(ROUTE),
      });
      await press(data);

      expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
      const sent = payloadOf(calls, 'sendMessage');
      expect(sent?.text).toBe(TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }).value);
      expect(rowsOf(sent)).toEqual(LIST_ROWS);
      expect(readSignals).toHaveBeenCalledTimes(1);
      expect(readPairs).toHaveBeenCalledTimes(1);
      expect(evaluateSignal).not.toHaveBeenCalled();
      expect(logger.info.mock.calls).toEqual([[{ callbackData: data }, 'legacy duration button']]);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a catalog read that failed', { readPairs: () => Promise.reject(new Error('down')) }],
    ['signals not read', { readSignals: () => Promise.reject(new Error('down')) }],
  ] as const)(
    'a legacy write datum under %s: «🔄 Повторить» carries demo:sig',
    async (_label, options) => {
      const { press, calls } = setup(options);
      await press('demo:stake:101:15:up:0123456789ab:a0b1c2');

      expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
      expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(
        retryFooter(DEMO_SIGNALS_CALLBACK_DATA),
      );
    },
  );

  it('logs a refused answer at warn and still sends the list', async () => {
    const { press, calls, apiErrors, logger } = setup();
    apiErrors.set('answerCallbackQuery', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: query is too old and response timeout expired',
    });
    await press('demo:d:101:300');
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'answering the callback query failed',
    ]);
  });

  // a mode-less picker button (#326) keeps #313's handling: its keyboard goes, nothing is sent
  it.each([
    'stk:o:p:101',
    'stk:s:2.5:p:101',
    'stk:z:p:101',
    'stk:c:p:101',
    'stk:o:a:101:300',
    'stk:o:a:101:15',
    'stk:s:2.5:a:101:60',
    'stk:z:a:101:900',
    'stk:c:a:101:3600',
  ])('%s: stops the spinner, removes the keyboard, sends nothing', async (data) => {
    const { press, calls, readPairs, readSignals, logger } = setup();
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(payloadOf(calls, 'editMessageReplyMarkup')?.reply_markup).toBeUndefined();
    expect(readPairs).not.toHaveBeenCalled();
    expect(readSignals).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stk:o:a:101:300: logs a refused removal at info with the pressed data and sends nothing', async () => {
    const { press, calls, apiErrors, logger } = setup();
    apiErrors.set('editMessageReplyMarkup', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message is not modified',
    });
    await press('stk:o:a:101:300');
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(logger.info.mock.calls.map((call) => call[1])).toEqual([
      'the keyboard of an old button was not removed',
    ]);
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
      method: 'editMessageReplyMarkup',
      telegramErrorCode: 400,
      callbackData: 'stk:o:a:101:300',
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

// #318: the summary card is a photo, so a button under it that would edit the pressed message
// tries no edit: the press carries the photo, and the screen goes as a new message at once (#761),
// as «⏳» under «📊 Анализ» does (#482). Since #858 the card's only such button is «📡 Сигналы»;
// `demo:an` under a photo is the analysis card's «🔄 Заново» and a card sent before #858.
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
    await scene.pressOnPhoto(data);
    expect(scene.logger.warn.mock.calls.map((call) => call[1])).not.toContain(
      'the demo screen was not edited, sending it anew',
    );
    expect(scene.logger.error).not.toHaveBeenCalled();
    return scene;
  };

  // #685: a session of any duration ends on the one list; #858: no analysis
  it('pins the buttons this covers; a button added to the card needs its press here', () => {
    for (const durationSec of [5, 15, 60]) {
      expect(editingButtons(durationSec)).toEqual([DEMO_SIGNALS_CALLBACK_DATA]);
    }
  });

  it('C1 «📡 Сигналы» sends the signals list as a new message, no edit tried', async () => {
    const { calls, signalWaiter } = await pressOnPhoto(DEMO_SIGNALS_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    // #664: the list's 30 s run on the new message
    expect(signalWaiter.waitList.mock.calls[0]?.[0]).toMatchObject({
      messageId: TEXT_CARD_MESSAGE_ID,
      shown: true,
    });
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }).value);
    expect(rowsOf(sent).slice(-1)).toEqual(LIST_FOOTER);
  });

  it('C2 a legacy button under the card sends the list as a new message, no edit tried', async () => {
    const scene = setup();
    await scene.pressOnPhoto('demo:an:101:15');
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(scene.calls, 'sendMessage')?.text).toBe(
      TEXTS.demoSignalsHeader({ label: '⏱ 5 с' }).value,
    );
  });

  // #482: under a photo «⏳» goes as a new message at once, with no edit tried first; #875: the
  // card is that «⏳» edited by its id
  it('C3 «📊 Анализ» sends «⏳» as a new message, then edits it into the card by its id', async () => {
    const { pressOnPhoto: press, calls, evaluateSignal } = setup();
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'editMessageMedia']);
    expect(evaluateSignal).toHaveBeenCalledTimes(1);
    const waiting = payloadOf(calls, 'sendMessage');
    expect(waiting?.text).toBe(TEXTS.analyzing({ subject: 'EUR/USD · ⏱ 5 с' }).value);
    expect(waiting?.reply_markup).toBeUndefined();
    const card = cardOf(calls);
    expect(card?.caption).toBe(
      analysisScreen({
        mode: TradeMode.Demo,
        pair: PAIR_EURUSD,
        durationSec: 5,
        response: SIGNAL_DECIDED,
        chooseAmount: true,
      }).text.value,
    );
    expect(rowsOf(card).flat()).toContainEqual(
      button(LABELS.repeatAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5)),
    );
    expect(card).toMatchObject({ chat_id: USER.id, message_id: TEXT_CARD_MESSAGE_ID });
  });

  it("C3b the wait under a photo becomes the scanner's animation in place of the new «⏳», by its id", async () => {
    const { pressOnPhoto: press, calls } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'editMessageMedia']);
    const edited = payloadOf(calls, 'editMessageMedia');
    expect(edited).toMatchObject({ chat_id: USER.id, message_id: TEXT_CARD_MESSAGE_ID });
    expect((edited?.media as { caption?: unknown }).caption).toBe(
      analysisScreen({
        mode: TradeMode.Demo,
        pair: PAIR_EURUSD,
        durationSec: 5,
        response: SIGNAL_NO_SIGNAL,
        chooseAmount: true,
      }).text.value,
    );
  });

  it('C3c sends that wait anew when the new «⏳» is gone, and nothing when it fails in transport', async () => {
    const gone = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
    gone.apiErrors.set('editMessageMedia', EDIT_GONE);
    await gone.pressOnPhoto(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
    expect(methods(gone.calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'editMessageMedia',
      'sendAnimation',
    ]);
    const transport = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL) });
    transport.apiErrors.set('editMessageMedia', TRANSPORT('editMessageMedia'));
    await transport.pressOnPhoto(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
    expect(methods(transport.calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'editMessageMedia',
    ]);
    expect(transport.signalWaiter.waitPair).not.toHaveBeenCalled();
  });

  it('C3d asks for no signal when the new «⏳» fails in transport', async () => {
    const { pressOnPhoto: press, calls, apiErrors, evaluateSignal, logger } = setup();
    apiErrors.set('sendMessage', TRANSPORT('sendMessage'));
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(evaluateSignal).not.toHaveBeenCalled();
    expect(logger.error.mock.calls.map((call) => call[1])).toEqual([
      'the analysis «⏳» failed in transport, sending nothing more',
    ]);
  });

  it('C4 «📊 Анализ» with the catalog unreadable sends the failure screen anew, no edit tried', async () => {
    const options = {
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    };
    const { calls, evaluateSignal } = await pressOnPhoto(
      demoAnalysisCallbackData(PAIR_EURUSD.id, 5),
      options,
    );
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    // the same screen a text message gets in place
    const inText = setup(options);
    await inText.press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
    const edited = payloadOf(inText.calls, 'editMessageText');
    const sent = payloadOf(calls, 'sendMessage');
    expect(edited).toBeDefined();
    expect(sent?.text).toBe(edited?.text);
    expect(sent?.reply_markup).toEqual(edited?.reply_markup);
    expect(evaluateSignal).not.toHaveBeenCalled();
  });
});

// #761: the analysis card (#482) is a photo too, so its buttons that would edit the pressed
// message send their screen as a new message at once, with no edit tried and no warn
describe('a press under the analysis card (a photo, #761)', () => {
  const ANALYSIS = demoAnalysisCallbackData(PAIR_EURUSD.id, 5);
  const MORE = analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, TradeMode.Demo);
  const callbackData = (payload: Record<string, unknown> | undefined) =>
    rowsOf(payload)
      .flat()
      .map((key) => key.callback_data)
      .filter((data): data is string => data !== undefined);
  // «🔄 Заново» tries no edit already (#482), «➕ Ещё» edits only the keyboard, an amount's wait
  // is cycle-stake.test.ts's, a trade answers and a session starts as new messages
  const editing = (data: readonly string[]) =>
    data.filter(
      (datum) =>
        !['demo:an:', 'demo:more:', 'demo:sa:', 'demo:stake:', 'real:stake:'].some((prefix) =>
          datum.startsWith(prefix),
        ) &&
        !datum.startsWith('demo:sess:') &&
        !datum.startsWith('real:sess:'),
    );
  const cardData = async (options: Parameters<typeof setup>[0] = {}) => {
    const scene = setup(options);
    await scene.press(ANALYSIS);
    const card = callbackData(cardOf(scene.calls));
    const before = scene.calls.length;
    await scene.pressOnPhoto(MORE);
    const expanded = callbackData(payloadOf(scene.calls.slice(before), 'editMessageReplyMarkup'));
    return { card, expanded };
  };
  const pressBoth = async (data: string, options: Parameters<typeof setup>[0] = {}) => {
    const photo = setup(options);
    await photo.pressOnPhoto(data);
    const text = setup(options);
    await text.press(data);
    return { photo, text };
  };

  it('P-pin pins the buttons this covers; a button added to the card needs its press here', async () => {
    const withAmounts = await cardData();
    expect(new Set(editing([...withAmounts.card, ...withAmounts.expanded]))).toEqual(
      new Set([
        cycleCustomCallbackData(PAIR_EURUSD.id, 5, 'a'),
        demoAssetCallbackData(PAIR_EURUSD.id),
        DEMO_GROUPS_CALLBACK_DATA,
        stakeMenuCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5),
      ]),
    );
    // no snapshot to draw the amounts from: the session row opens the amount screen
    const withoutAmounts = await cardData({
      readTradingAccess: () =>
        Promise.resolve(accessView({ broker: null, brokerUnavailable: 'refreshing' })),
    });
    expect(new Set(editing([...withoutAmounts.card, ...withoutAmounts.expanded]))).toEqual(
      new Set([
        demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'),
        demoAssetCallbackData(PAIR_EURUSD.id),
        DEMO_GROUPS_CALLBACK_DATA,
        stakeMenuCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5),
      ]),
    );
  });

  // #828: the card was drawn on an H1 signal; its session row reads no list
  it('P-door the session row with the pair out of the list sends the amount screen all the same, no wait', async () => {
    const { pressOnPhoto, calls, signalWaiter, readSignals, logger } = setup({
      readSignals: () => Promise.resolve(signalsOf()),
    });
    await pressOnPhoto(demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(calls, 'sendMessage')?.text).toContain('Выбери сумму сделки 👇');
    expect(readSignals).not.toHaveBeenCalled();
    expect(signalWaiter.waitPair).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('P-door the session row with the pair in the list sends the amount screen as a new message', async () => {
    const { photo, text } = await pressBoth(demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'));
    expect(methods(photo.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(photo.calls, 'sendMessage');
    const edited = payloadOf(text.calls, 'editMessageText');
    expect(sent?.text).toContain('Выбери сумму сделки 👇');
    expect(sent?.text).toBe(edited?.text);
    expect(sent?.reply_markup).toEqual(edited?.reply_markup);
    expect(photo.signalWaiter.waitPair).not.toHaveBeenCalled();
    expect(photo.logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['P-asset «↩️ К паре»', demoAssetCallbackData(PAIR_EURUSD.id)],
    ['P-groups «↩️ Типы»', DEMO_GROUPS_CALLBACK_DATA],
  ])('%s sends the screen a text message gets in place as a new message', async (_name, data) => {
    const { photo, text } = await pressBoth(data);
    expect(methods(photo.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(photo.calls, 'sendMessage');
    const edited = payloadOf(text.calls, 'editMessageText');
    expect(edited).toBeDefined();
    expect(sent?.text).toBe(edited?.text);
    expect(sent?.reply_markup).toEqual(edited?.reply_markup);
    expect(photo.logger.warn).not.toHaveBeenCalled();
    expect(photo.logger.error).not.toHaveBeenCalled();
  });

  it('P-text-unchanged the same buttons under a text message edit it in place', async () => {
    for (const data of [
      demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a'),
      demoAssetCallbackData(PAIR_EURUSD.id),
      DEMO_GROUPS_CALLBACK_DATA,
    ]) {
      const { press, calls } = setup();
      await press(data);
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    }
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
  const photos = (calls: readonly ApiCall[]) => cardCallsOf(calls).map((payload) => payload.photo);
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
    [button(LABELS.repeatAnalysisButton, DATA), BACK_EURUSD_PAIR, BACK_GROUPS],
  ];
  const RATE_LIMITED: ApiError = {
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 3',
    parameters: { retry_after: 3 },
  };

  // #875: «⏳» goes before the access read answers; the card waits for it
  it('AN1 shows «⏳» while the access read is still on its way', async () => {
    let answer: (() => void) | undefined;
    const { press, calls } = setup({
      readTradingAccess: () =>
        new Promise((resolve) => {
          answer = () => resolve(ACCESS_VIEW);
        }),
    });
    const pressing = press(DATA);
    await until('«⏳»', () => methods(calls).includes('editMessageText'));
    expect(calls.find((call) => call.method === 'editMessageText')?.payload.text).toBe(
      TEXTS.analyzing({ subject: 'EUR/USD · ⏱ 5 с' }).value,
    );
    expect(methods(calls)).not.toContain('editMessageMedia');
    answer?.();
    await pressing;
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'editMessageMedia']);
  });

  it('AN3 uploads each picture once, then sends it by the file_id Telegram answered with', async () => {
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

  it('AN4 forgets a file_id refused on the edit, sends the caption as text in place of «⏳», and uploads next time', async () => {
    const { press, calls, apiErrors, logger } = setup();
    await press(DATA);
    apiErrors.set('editMessageMedia', PHOTO_REFUSED);
    const before = calls.length;
    await press(DATA);
    const second = calls.slice(before);
    expect(methods(second)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageMedia',
      'editMessageText',
    ]);
    expect((second[2]?.payload.media as { media?: unknown }).media).toBe(CARD_FILE_ID);
    // [В1] the same caption and the same keyboard, the amounts and «Выбери сумму…» with them
    const text = second[3]?.payload;
    expect(text?.text).toBe(card());
    expect(text?.reply_markup).toEqual(second[2]?.payload.reply_markup);
    expect(
      rowsOf(text)
        .flat()
        .some((key) => key.callback_data?.startsWith('demo:sa:')),
    ).toBe(true);
    expect(logger.warn.mock.calls).toEqual([
      [
        expect.objectContaining({ telegramErrorCode: 400, byFileId: true }),
        'the analysis card photo was refused, sending its text',
      ],
    ]);
    apiErrors.delete('editMessageMedia');
    await press(DATA);
    expect(photos(calls).map(fileName)).toEqual(['setup-bull.png', CARD_FILE_ID, 'setup-bull.png']);
  });

  it('AN4b a 429 on the edit sends the text in place of «⏳» and keeps the file_id', async () => {
    const { press, calls, apiErrors } = setup();
    await press(DATA);
    apiErrors.set('editMessageMedia', RATE_LIMITED);
    await press(DATA);
    apiErrors.delete('editMessageMedia');
    await press(DATA);
    expect(photos(calls).map(fileName)).toEqual(['setup-bull.png', CARD_FILE_ID, CARD_FILE_ID]);
    expect(calls.filter((call) => call.method === 'editMessageText').at(-1)?.payload.text).toBe(
      TEXTS.analyzing({ subject: 'EUR/USD · ⏱ 5 с' }).value,
    );
  });

  it('AN5 a «⏳» gone by the card sends the card as a new message; refused, nothing more', async () => {
    const sent = setup();
    sent.apiErrors.set('editMessageMedia', EDIT_GONE);
    await sent.press(DATA);
    expect(methods(sent.calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageMedia',
      'sendPhoto',
    ]);
    expect(cardOf(sent.calls)?.caption).toBe(card());
    expect(sent.logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'the analysis «⏳» is gone, the card goes as a new message',
    ]);
    const refused = setup();
    refused.apiErrors.set('editMessageMedia', EDIT_GONE);
    refused.apiErrors.set('sendPhoto', PHOTO_REFUSED);
    await refused.press(DATA);
    expect(methods(refused.calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageMedia',
      'sendPhoto',
    ]);
    expect(refused.logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'the analysis «⏳» is gone, the card goes as a new message',
      'the analysis card photo was refused',
    ]);
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
    apiErrors.set('editMessageMedia', PHOTO_REFUSED);
    failFromSecondCall({ apiErrors, ...api }, 'editMessageText', EDIT_GONE);
    await press(DATA);
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageMedia',
      'editMessageText',
    ]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'the analysis card photo was refused, sending its text',
      'the analysis «⏳» was not edited after the card',
    ]);
  });

  it('remembers nothing when the answer lists no size, and uploads again', async () => {
    const { press, calls, answers, logger } = setup();
    answers.set('editMessageMedia', photoAnswer(CARD_MESSAGE_ID, []));
    await press(DATA);
    await press(DATA);
    expect(photos(calls).map(fileName)).toEqual(['setup-bull.png', 'setup-bull.png']);
    expect(logger.warn.mock.calls).toContainEqual([
      { reason: 'no_file_id' },
      'the setup card picture is not remembered',
    ]);
  });

  it('AN6 says the analysis is unavailable in «⏳» when the edit into the card fails in transport', async () => {
    const { press, calls, apiErrors, logger } = setup();
    apiErrors.set('editMessageMedia', TRANSPORT('editMessageMedia'));
    await press(DATA);
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'editMessageMedia',
      'editMessageText',
    ]);
    const edited = calls.at(-1)?.payload;
    expect(edited?.text).toBe(analysisUnavailableScreen(PAIR_EURUSD, 5).text.value);
    expect(rowsOf(edited)).toEqual(UNAVAILABLE_ROWS);
    expect(logger.error.mock.calls).toEqual([
      [
        expect.objectContaining({ method: 'editMessageMedia' }),
        'the analysis card failed in transport',
      ],
    ]);
  });

  it('sends nothing more when the photo fails in transport and no «⏳» stands', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    apiErrors.set('sendPhoto', TRANSPORT('sendPhoto'));
    await press(DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendPhoto']);
  });

  it('AN7 a refused catalog shows its refusal and no «⏳», whatever the access read does', async () => {
    const { press, calls, readTradingAccess } = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      readTradingAccess: () => new Promise(() => undefined),
    });
    await press(DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(calls.at(-1)?.payload.text).not.toBe(
      TEXTS.analyzing({ subject: 'EUR/USD · ⏱ 5 с' }).value,
    );
    expect(readTradingAccess).toHaveBeenCalledTimes(1);
  });

  it('hands an edit into the card that fails for a reason the transport cannot produce to bot.catch', async () => {
    const { press, calls, answers } = setup();
    answers.set('editMessageMedia', () => {
      throw new TypeError('sentinel');
    });
    const thrown = await rejectionOf(press(DATA));
    expect(thrown).toBeInstanceOf(BotError);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'editMessageMedia']);
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

// #632: the demo path of a user whose language is English, answered through the language
// middleware as production answers it; every text, caption and button label it sends is English
describe('the demo path in English (#632)', () => {
  const en = <T>(run: () => T): T => runWithLanguage(BotLanguage.En, run);
  const english = (options: Parameters<typeof setup>[0] = {}) =>
    setup({ ...options, languages: userLanguagesWith(USER.id, BotLanguage.En) });
  const CYRILLIC = /[А-Яа-яЁё]/u;
  const textsOf = (calls: readonly ApiCall[]): string[] =>
    calls.flatMap((call) => [
      ...[call.payload.text, call.payload.caption].filter(
        (text): text is string => typeof text === 'string',
      ),
      ...inlineRows(call.payload)
        .flat()
        .map((key) => key.text),
    ]);
  const expectEnglish = (calls: readonly ApiCall[]) => {
    const texts = textsOf(calls);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).not.toMatch(CYRILLIC);
  };
  // a one-key screen's plain text, from the English catalog
  const sourceOf = (source: string | undefined, vars: Record<string, string> = {}) =>
    Object.entries(vars)
      .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), source ?? '')
      .replace(/<\/?b>/g, '');

  it('EN-1 the entry sends the signals screen in English with the English footer', async () => {
    const { press, calls } = english();
    await press(DEMO_CALLBACK_DATA);

    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(
      en(() => TEXTS.demoSignalsHeader({ label: DEMO_DURATION_LABELS[5] }).value),
    );
    expect(plainTextOf(sent?.text as string)).toBe(
      sourceOf(BOT_TEXT_SOURCES_EN.demoSignalsHeader, { label: '⏱ 5 s' }),
    );
    expect(
      rowsOf(sent)
        .at(-1)
        ?.map((key) => key.text),
    ).toEqual([
      BOT_TEXT_SOURCES_EN.demoSignalsRefreshButton,
      BOT_TEXT_SOURCES_EN.demoManualButton,
      BOT_TEXT_SOURCES_EN.menuButton,
    ]);
    expectEnglish(calls);
  });

  it('EN-2 the types and a page of a type in English: the type words, «Page 1 of 1»', async () => {
    const { press, calls } = english();
    await press(DEMO_GROUPS_CALLBACK_DATA);
    const types = payloadOf(calls, 'editMessageText');
    expect(types?.text).toBe(BOT_TEXT_SOURCES_EN.demoGroups);
    expect(rowsOf(types)[0]?.[0]).toEqual(
      button(
        en(() => groupButtonLabel('currency', 1)),
        demoPageCallbackData('currency', 0),
      ),
    );
    expect(rowsOf(types)[0]?.[0]?.text).toBe(`${BOT_TEXT_SOURCES_EN.demoGroupCurrency} · 1`);

    await press(demoPageCallbackData('currency', 0));
    const page = calls.filter((call) => call.method === 'editMessageText').at(-1)?.payload;
    expect(page?.text).toBe(en(() => demoPairsScreen('currency', 0, 1).value));
    expect(plainTextOf(page?.text as string)).toMatch(/\nPage 1 of 1$/);
    expectEnglish(calls);
  });

  it("EN-3 a pair's summary in English", async () => {
    const { press, calls } = english();
    await press(demoAssetCallbackData(PAIR_EURUSD.id));

    const edited = payloadOf(calls, 'editMessageText');
    expect(edited?.text).toBe(en(() => demoSummary(PAIR_EURUSD, 5).value));
    expect(plainTextOf(edited?.text as string)).toContain('⏱ Duration: ⏱ 5 s');
    expectEnglish(calls);
  });

  it('EN-4 the amount screen in English: the cycle of 5 cycles and the risk mark', async () => {
    const { press, calls } = english();
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5));

    const edited = payloadOf(calls, 'editMessageText');
    expect(plainTextOf(edited?.text as string)).toBe(
      `🎯 ${pairLabel(PAIR_EURUSD)} · ⏱ 5 s
🤖 The bot will run 5 cycles in a row and check the signal before each trade. It is a demo: no money needed.

${BOT_TEXT_SOURCES_EN.cycleStakeChoose}`,
    );
    const labels = rowsOf(edited)
      .flat()
      .map((key) => key.text);
    expect(labels).toContain('$10.00 · risk');
    expect(labels).toContain(BOT_TEXT_SOURCES_EN.stakeCustomButton);
    expectEnglish(calls);
  });

  it('EN-5 the analysis card and its single trade in English', async () => {
    const { press, calls } = english();
    await press(demoAnalysisCallbackData(PAIR_EURUSD.id, 5));

    const card = cardOf(calls);
    expect(card?.caption).toBe(
      en(
        () =>
          analysisScreen({
            mode: TradeMode.Demo,
            pair: PAIR_EURUSD,
            durationSec: 5,
            response: SIGNAL_DECIDED,
            chooseAmount: true,
          }).text.value,
      ),
    );
    expect(plainTextOf(card?.caption as string)).toContain(
      BOT_TEXT_SOURCES_EN.analysisCardUp.replace(/<\/?b>/g, ''),
    );

    await press(analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, TradeMode.Demo));
    const expanded = calls.filter((call) => call.method === 'editMessageReplyMarkup').at(-1);
    expect(
      rowsOf(expanded?.payload)
        .flat()
        .map((key) => key.text),
    ).toContain('🚀 Open a trade: ⬆️ Up · $1.00');
    expectEnglish(calls);
  });
});

// #829: the screens record the directions they showed, once they are on their way, from the
// backend's answers; the doors record nothing
describe('the record of the shown directions (#829)', () => {
  const ROUTE = signalsOf([PAIR_EURUSD.id, TradeAction.Up], [PAIR_SHORT.id, TradeAction.Down]);
  const LISTED = [
    { assetId: PAIR_EURUSD.id, action: 'up', second: NOW - 900, decidedAt: NOW - 500 },
    { assetId: PAIR_SHORT.id, action: 'down', second: NOW - 900, decidedAt: NOW - 500 },
  ];
  const ANALYSIS = demoAnalysisCallbackData(PAIR_EURUSD.id, 5);
  const PHOTO_REFUSED: ApiError = {
    ok: false,
    error_code: 400,
    description: 'Bad Request: wrong file identifier/HTTP URL specified',
  };
  const SEND_REFUSED: ApiError = {
    ok: false,
    error_code: 403,
    description: 'Forbidden: bot was blocked by the user',
  };

  it.each([
    ["the card's button", DEMO_CALLBACK_DATA, 'sendMessage'],
    ['the list', DEMO_SIGNALS_CALLBACK_DATA, 'editMessageText'],
    ['a legacy datum', 'demo:l:101', 'sendMessage'],
  ] as const)(
    'W-shown1 %s records the drawn pairs as a list, after the screen went out',
    async (_name, data, method) => {
      const { press, shownSignals } = setup({ readSignals: () => Promise.resolve(ROUTE) });
      await press(data);
      expect(shownSignals.remember.mock.calls).toEqual([[USER.id, 'list', NOW, LISTED]]);
      const refused = setup({ readSignals: () => Promise.resolve(ROUTE) });
      refused.apiErrors.set(method, SEND_REFUSED);
      await refused.press(data).catch(() => undefined);
      expect(refused.shownSignals.remember).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['the reads failed', { readSignals: () => Promise.reject(new Error('down')) }],
    [
      'no 5s list',
      {
        readSignals: () =>
          Promise.resolve({
            ...ROUTE,
            lists: ROUTE.lists.filter((list) => list.interval !== '5s'),
          }),
      },
    ],
    ['a stale catalog', { readPairs: () => Promise.resolve(pairsResponse({ fresh: false })) }],
  ] as const)('W-shown2 a refused list (%s) records nothing', async (_name, options) => {
    const { press, shownSignals } = setup({
      readSignals: () => Promise.resolve(ROUTE),
      ...options,
    });
    await press(DEMO_SIGNALS_CALLBACK_DATA);
    expect(shownSignals.remember).not.toHaveBeenCalled();
  });

  it("W-shown3 the analysis card records its answer's h1 as the analysis; its text too; a failed photo not", async () => {
    const h1 = { assetId: PAIR_EURUSD.id, action: 'down', second: 1_790_000_044_000 };
    const photo = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_H1_ONLY) });
    await photo.press(ANALYSIS);
    expect(photo.shownSignals.remember.mock.calls).toEqual([
      [USER.id, 'analysis', NOW, [{ ...h1, decidedAt: 1_790_000_044_320 }]],
    ]);
    const text = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_H1_ONLY) });
    text.apiErrors.set('editMessageMedia', PHOTO_REFUSED);
    await text.press(ANALYSIS);
    expect(text.shownSignals.remember.mock.calls).toEqual(photo.shownSignals.remember.mock.calls);
    const lost = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_H1_ONLY) });
    lost.apiErrors.set('editMessageMedia', TRANSPORT('editMessageMedia'));
    await lost.press(ANALYSIS);
    expect(lost.shownSignals.remember).not.toHaveBeenCalled();
    const unedited = setup({ evaluateSignal: () => Promise.resolve(SIGNAL_H1_ONLY) });
    unedited.apiErrors.set('editMessageMedia', PHOTO_REFUSED);
    failFromSecondCall(unedited, 'editMessageText', EDIT_GONE);
    await unedited.press(ANALYSIS);
    expect(unedited.shownSignals.remember).not.toHaveBeenCalled();
  });

  it.each([
    ['l', demoLaunchCallbackData(PAIR_EURUSD.id, 5)],
    ['a', demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'a')],
    ['n with the pair in the list', demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n')],
  ] as const)('W-shown4 the door %s records nothing', async (_name, data) => {
    const { press, shownSignals } = setup({ readSignals: () => Promise.resolve(ROUTE) });
    await press(data);
    expect(shownSignals.remember).not.toHaveBeenCalled();
  });

  it('W-shown5 the analysis without an H1 signal (the wait) records nothing', async () => {
    const { press, shownSignals, signalWaiter } = setup({
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
    });
    await press(ANALYSIS);
    expect(signalWaiter.waitPair).toHaveBeenCalledTimes(1);
    expect(shownSignals.remember).not.toHaveBeenCalled();
  });

  it("W-shown6 the door n's wait records the other pairs' buttons as a list, after the screen went out", async () => {
    const others = signalsOf([PAIR_SHORT.id, TradeAction.Down]);
    const door = demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n');
    const { press, shownSignals } = setup({ readSignals: () => Promise.resolve(others) });
    await press(door);
    expect(shownSignals.remember.mock.calls).toEqual([[USER.id, 'list', NOW, [LISTED[1]]]]);
    // the wait goes as the scanner's animation (#859)
    const refused = setup({ readSignals: () => Promise.resolve(others) });
    refused.apiErrors.set('sendAnimation', SEND_REFUSED);
    await refused.press(door).catch(() => undefined);
    expect(refused.shownSignals.remember).not.toHaveBeenCalled();
  });
});
