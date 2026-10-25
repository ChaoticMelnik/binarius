import { GrammyError, HttpError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BotLanguage,
  ButtonRole,
  callbackButton,
  keyboardOf,
  InvalidTelegramTemplate,
  SignalFeedOutcome,
  telegramHtml,
  TradeAction,
  TradeMode,
  type BrokerRestErrorCode,
  type PairsCatalogResponse,
  type TelegramHtml,
  type TradingSignalsResponse,
} from '@binarius/shared';
import type { BackendClient } from './backend-client';
import type { DemoScreen, ShownSignal } from './demo';
import { currentLanguage } from './language';
import {
  createSignalWaiter,
  renderKey,
  type ListWaitRequest,
  type PairWaitRequest,
  type SignalWaitScreens,
} from './signal-wait';
import {
  accessView,
  fakeLogger,
  PAIR_CLOSED,
  PAIR_EURUSD,
  PAIR_SHORT,
  PAIRS_RESPONSE,
  SIGNAL_CANDLE_ONLY,
  SIGNAL_CARD,
  SIGNAL_FETCH_FAILED_H1,
  SIGNAL_H1_ONLY,
  SIGNAL_NO_SIGNAL,
  signalsResponse,
  stubShownSignals,
} from './testing';
import { SIGNAL_WAIT_POLL_MS, SIGNAL_WAIT_POLL_OFFSET_MS } from './timing';

// The wait for a signal (#664, signal-wait.ts) on fake timers: one tick at each candle's boundary
// plus the offset, by the bot's clock, from a start that is not on a boundary.
const T0 = 12_345;
const FIRST_TICK = 16_000;
const POLL = 5_000;
const TTL = 30_000;
const GAP = 200;

const screen = (text: string, button = 'k'): DemoScreen => ({
  text: telegramHtml`${text}`,
  keyboard: keyboardOf([callbackButton(ButtonRole.Nav, button, button)]),
});

const refusal = (error_code: number, description: string, retry_after?: number) =>
  new GrammyError(
    `Call to 'editMessageText' failed!`,
    {
      ok: false,
      error_code,
      description,
      ...(retry_after === undefined ? {} : { parameters: { retry_after } }),
    },
    'editMessageText',
    {},
  );
const GONE = () => refusal(400, 'Bad Request: message to edit not found');
const BLOCKED = () => refusal(403, 'Forbidden: bot was blocked by the user');
const LIMITED = (seconds: number) => refusal(429, 'Too Many Requests: retry after', seconds);
const OTHER = () => refusal(400, 'Bad Request: something else');
const NOT_MODIFIED = () =>
  refusal(400, 'Bad Request: message is not modified: specified new message content is the same');
const TRANSPORT = () => new HttpError("Network request for 'editMessageText' failed!", new Error());

// the listed pairs the catalog has, with their signals' second and decision time (#829)
const shownOf = (
  signals: TradingSignalsResponse['lists'][number]['signals'],
  catalog: PairsCatalogResponse,
): ShownSignal[] =>
  signals.flatMap(({ assetId, action, second, decidedAt }) => {
    const pair = catalog.pairs.find((listedPair) => listedPair.id === assetId);
    return pair === undefined ? [] : [{ pair, action, second, decidedAt }];
  });

function setup(
  options: {
    maxMs?: number;
    shutdownBudgetMs?: number;
    maxEntries?: number;
    pollMs?: number;
    pollOffsetMs?: number;
  } = {},
) {
  let listed: (readonly [number, TradeAction])[] = [];
  const backend = {
    readSignals: vi.fn<BackendClient['readSignals']>(() =>
      Promise.resolve(signalsResponse(Date.now(), { '5s': listed })),
    ),
    readPairs: vi.fn<BackendClient['readPairs']>(() => Promise.resolve(PAIRS_RESPONSE)),
    readTradingAccess: vi.fn<BackendClient['readTradingAccess']>(() =>
      Promise.resolve(accessView()),
    ),
    evaluateSignal: vi.fn<BackendClient['evaluateSignal']>(() => Promise.resolve(SIGNAL_CARD)),
  };
  const languages: string[] = [];
  const screens: SignalWaitScreens = {
    list: vi.fn((signals: TradingSignalsResponse, catalog: PairsCatalogResponse) => {
      languages.push(currentLanguage());
      const list = signals.lists.find((candidate) => candidate.interval === '5s');
      if (list === undefined) return undefined;
      const ids = list.signals.map((signal) => signal.assetId).join(',');
      return {
        screen: screen(`list:${ids}`),
        listed: list.signals.length,
        shown: shownOf(list.signals, catalog),
      };
    }),
    expired: () => screen('expired'),
    waiting: (base: TelegramHtml, alternatives) =>
      screen(`${base.value}|${alternatives.map(({ pair }) => pair.id).join(',')}`),
    alternatives: shownOf,
    nextStep: (step, pair, access) =>
      screen(`next:${pair.id}:${access?.tradingMode ?? 'none'}:${step.back}`),
    refusal: (check) => screen(`refusal:${check.reason}`),
    card: (_pair, response) =>
      response.h1 !== null
        ? {
            text: telegramHtml`card`,
            keyboard: keyboardOf([callbackButton(ButtonRole.Nav, 'c', 'c')]),
            action: response.h1.action,
          }
        : undefined,
    photos: { photo: vi.fn(() => 'file-id'), remember: vi.fn(), forget: vi.fn() },
  };
  const logger = fakeLogger();
  const shownSignals = stubShownSignals();
  const waiter = createSignalWaiter({
    backend,
    logger,
    shownSignals,
    pollMs: options.pollMs ?? POLL,
    pollOffsetMs: options.pollOffsetMs ?? 1_000,
    listTtlMs: TTL,
    maxMs: options.maxMs ?? 3_600_000,
    editGapMs: GAP,
    editFailuresMax: 3,
    shutdownBudgetMs: options.shutdownBudgetMs ?? 20_000,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
  waiter.attach(screens);
  const editMessageText = vi.fn<(...args: unknown[]) => Promise<true>>(() => Promise.resolve(true));
  const editMessageMedia = vi.fn<(...args: unknown[]) => Promise<true>>(() =>
    Promise.resolve(true),
  );
  const api = { editMessageText, editMessageMedia } as unknown as ListWaitRequest['api'];
  const target = (user = 7) => ({
    api,
    chatId: user,
    messageId: user * 10,
    telegramUserId: user,
    language: BotLanguage.Ru,
    drawn: screen('drawn'),
  });
  const list = (patch: Partial<ListWaitRequest> = {}): ListWaitRequest => ({
    ...target(),
    shown: false,
    ...patch,
  });
  const pair = (patch: Partial<PairWaitRequest> = {}): PairWaitRequest => ({
    ...target(),
    firstName: 'Ann',
    assetId: PAIR_EURUSD.id,
    back: 'l',
    origin: 'door',
    base: telegramHtml`base`,
    alternatives: 'done',
    ...patch,
  });
  const texts = () =>
    editMessageText.mock.calls.map((call) => (call[2] as string).replace(/\n⠀.*$/s, ''));
  const at = (ms: number) => vi.advanceTimersByTimeAsync(ms - Date.now());
  return {
    waiter,
    backend,
    screens,
    shownSignals,
    logger,
    languages,
    editMessageText,
    editMessageMedia,
    target,
    list,
    pair,
    texts,
    at,
    setListed: (next: (readonly [number, TradeAction])[]) => {
      listed = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

// #475: the colour is part of what the user sees, so a pair whose signal turned is drawn again
describe('renderKey (#475)', () => {
  it('W-key: the same pair green and red are two drawings', () => {
    const pair = (role: ButtonRole) => ({
      text: telegramHtml`list`,
      keyboard: keyboardOf({
        buttons: [callbackButton(role, 'EUR/USD 85%', 'demo:l:1:5')],
        perRow: 2,
      }),
    });
    expect(renderKey(pair(ButtonRole.Up))).not.toBe(renderKey(pair(ButtonRole.Down)));
    expect(renderKey(pair(ButtonRole.Up))).toBe(renderKey(pair(ButtonRole.Up)));
  });
});

describe('the wait for a signal', () => {
  it('W1 arms no timer without an entry, and the first one on the boundary plus the offset', async () => {
    const { waiter, backend, list, at } = setup();
    await at(T0 + 60_000);
    expect(backend.readSignals).not.toHaveBeenCalled();
    vi.setSystemTime(T0);
    waiter.waitList(list());
    await at(FIRST_TICK - 1);
    expect(backend.readSignals).not.toHaveBeenCalled();
    await at(FIRST_TICK);
    expect(backend.readSignals).toHaveBeenCalledTimes(1);
    await at(FIRST_TICK + POLL);
    expect(backend.readSignals).toHaveBeenCalledTimes(2);
  });

  // #828: an H1 signal lives a second, so the production poll is once a second, 600 ms past f
  it('W18 polls every second at the production period, 600 ms after the second', async () => {
    const { waiter, backend, list, at } = setup({
      pollMs: SIGNAL_WAIT_POLL_MS,
      pollOffsetMs: SIGNAL_WAIT_POLL_OFFSET_MS,
    });
    waiter.waitList(list());
    // T0 = 12 345: the first poll at 12 600, then one a second
    await at(12_599);
    expect(backend.readSignals).not.toHaveBeenCalled();
    await at(12_600);
    expect(backend.readSignals).toHaveBeenCalledTimes(1);
    await at(17_600);
    expect(backend.readSignals).toHaveBeenCalledTimes(6);
  });

  it('W2 reads the signals and the catalog once a tick for every entry', async () => {
    const { waiter, backend, list, target, at } = setup();
    for (const user of [1, 2, 3]) waiter.waitList(list(target(user)));
    await at(FIRST_TICK);
    expect(backend.readSignals).toHaveBeenCalledTimes(1);
    expect(backend.readPairs).toHaveBeenCalledTimes(1);
  });

  it('W3 edits the waiting list into the list once a pair has a signal, in the entry’s language', async () => {
    const { waiter, list, at, texts, editMessageText, setListed, languages } = setup();
    waiter.waitList(list({ language: BotLanguage.En }));
    await at(FIRST_TICK);
    expect(editMessageText).not.toHaveBeenCalled();
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + POLL);
    expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`]);
    expect(editMessageText.mock.calls[0]?.slice(0, 2)).toEqual([7, 70]);
    expect(new Set(languages)).toEqual(new Set([BotLanguage.En]));
    expect(waiter.has(7)).toBe(true);
  });

  it('W4 turns a list with pairs into the start of trading 30 s after it was drawn, and ends', async () => {
    const { waiter, list, at, texts } = setup();
    waiter.waitList(list({ shown: true }));
    // the last tick before T0 + 30 s
    await at(41_000);
    expect(texts()).toEqual([]);
    await at(46_000);
    expect(texts()).toEqual(['expired']);
    expect(waiter.has(7)).toBe(false);
  });

  it('W4b counts the 30 s of a list drawn by the wait from its edit, not from the entry', async () => {
    const { waiter, list, at, texts, setListed } = setup();
    waiter.waitList(list());
    await at(26_000);
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(31_000);
    expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`]);
    await at(56_000);
    expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`]);
    await at(61_000);
    expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`, 'expired']);
  });

  it('W5 opens the next step by one fresh access read once the pair is in the list: demo, then real', async () => {
    for (const mode of [TradeMode.Demo, TradeMode.Real]) {
      vi.setSystemTime(T0);
      const { waiter, pair, at, texts, backend, setListed } = setup();
      backend.readTradingAccess.mockResolvedValue(accessView({ tradingMode: mode }));
      waiter.waitPair(pair({ back: 'a' }));
      setListed([[PAIR_EURUSD.id, TradeAction.Down]]);
      await at(FIRST_TICK);
      expect(texts()).toEqual([`next:${PAIR_EURUSD.id}:${mode}:a`]);
      expect(backend.readTradingAccess).toHaveBeenCalledTimes(1);
      expect(backend.evaluateSignal).not.toHaveBeenCalled();
      expect(waiter.has(7)).toBe(false);
    }
  });

  it('W5b refuses a pair the fresh catalog closed, listed or not, and ends', async () => {
    for (const listed of [true, false]) {
      vi.setSystemTime(T0);
      const { waiter, pair, at, texts, backend, setListed } = setup();
      waiter.waitPair(pair({ assetId: PAIR_CLOSED.id }));
      setListed(listed ? [[PAIR_CLOSED.id, TradeAction.Up]] : []);
      await at(FIRST_TICK);
      expect(texts()).toEqual(['refusal:pair_closed']);
      expect(backend.readTradingAccess).not.toHaveBeenCalled();
      expect(waiter.has(7)).toBe(false);
    }
  });

  it('W5c refuses a pair the catalog no longer lists', async () => {
    const { waiter, pair, at, texts } = setup();
    waiter.waitPair(pair({ assetId: 999_999 }));
    await at(FIRST_TICK);
    expect(texts()).toEqual(['refusal:pair_missing']);
  });

  it('W5d opens the next step without access when its read failed, and ends', async () => {
    const { waiter, pair, at, texts, backend, setListed, logger } = setup();
    backend.readTradingAccess.mockRejectedValue(new Error('down'));
    waiter.waitPair(pair());
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    expect(texts()).toEqual([`next:${PAIR_EURUSD.id}:none:l`]);
    expect(waiter.has(7)).toBe(false);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'trading access not read for the signal wait',
    ]);
  });

  it('W6 turns the analysis into its card by editMessageMedia, the analysis recorded', async () => {
    const { waiter, pair, at, backend, setListed, editMessageMedia, editMessageText, screens } =
      setup();
    waiter.waitPair(pair({ origin: 'analysis', back: 'a', alternatives: 'pending' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    expect(backend.evaluateSignal).toHaveBeenCalledWith(PAIR_EURUSD.id, '5s', {
      telegramUserId: '7',
      durationSec: 5,
    });
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
    expect(editMessageMedia.mock.calls[0]?.slice(0, 3)).toEqual([
      7,
      70,
      { type: 'photo', media: 'file-id', caption: 'card', parse_mode: 'HTML' },
    ]);
    expect(editMessageText).not.toHaveBeenCalled();
    expect(screens.photos.remember).toHaveBeenCalledWith(TradeAction.Up, true);
    expect(waiter.has(7)).toBe(false);
  });

  it('W6b sends the card’s caption as text when the photo is refused, forgetting its file id', async () => {
    const { waiter, pair, at, setListed, editMessageMedia, texts, screens } = setup();
    editMessageMedia.mockRejectedValueOnce(OTHER());
    waiter.waitPair(pair({ origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
    expect(screens.photos.forget).toHaveBeenCalledWith(TradeAction.Up);
    expect(texts()).toEqual(['card']);
    expect(waiter.has(7)).toBe(false);
  });

  it('W6c keeps the analysis waiting when the signal is gone by its own read, one warn on a failure', async () => {
    const { waiter, pair, at, setListed, backend, editMessageMedia, logger } = setup();
    backend.evaluateSignal.mockResolvedValueOnce(SIGNAL_NO_SIGNAL);
    backend.evaluateSignal.mockRejectedValue(new Error('down'));
    waiter.waitPair(pair({ origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 2 * POLL);
    expect(backend.evaluateSignal).toHaveBeenCalledTimes(3);
    expect(editMessageMedia).not.toHaveBeenCalled();
    expect(waiter.has(7)).toBe(true);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'signal wait analysis not evaluated',
    ]);
    backend.evaluateSignal.mockResolvedValue({
      outcome: SignalFeedOutcome.FetchFailed,
      code: 'unavailable' as BrokerRestErrorCode,
      h1: null,
    });
    await at(FIRST_TICK + 3 * POLL);
    expect(waiter.has(7)).toBe(true);
  });

  // #828: the analysis resolves by the answer's H1 signal, never by the candle decision
  it('W6f keeps the analysis waiting on a candle signal without an H1 one; an H1 signal over a candle refusal or a failed fetch draws the card', async () => {
    const { waiter, pair, at, setListed, backend, editMessageMedia, screens } = setup();
    backend.evaluateSignal.mockResolvedValueOnce(SIGNAL_CANDLE_ONLY);
    waiter.waitPair(pair({ origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    expect(editMessageMedia).not.toHaveBeenCalled();
    expect(waiter.has(7)).toBe(true);
    backend.evaluateSignal.mockResolvedValueOnce(SIGNAL_H1_ONLY);
    await at(FIRST_TICK + POLL);
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
    expect(screens.photos.remember).toHaveBeenCalledWith(TradeAction.Down, true);
    expect(waiter.has(7)).toBe(false);

    const failed = setup();
    failed.backend.evaluateSignal.mockResolvedValueOnce(SIGNAL_FETCH_FAILED_H1);
    failed.waiter.waitPair(failed.pair({ origin: 'analysis' }));
    failed.setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await failed.at(FIRST_TICK + 2 * POLL);
    expect(failed.editMessageMedia).toHaveBeenCalledTimes(1);
    expect(failed.waiter.has(7)).toBe(false);
  });

  it('W6d draws the other pairs under the analysis whose own read finds no signal, never the chosen pair', async () => {
    const { waiter, pair, at, setListed, backend, texts, editMessageMedia } = setup();
    backend.evaluateSignal.mockResolvedValue(SIGNAL_NO_SIGNAL);
    waiter.waitPair(pair({ origin: 'analysis', alternatives: 'pending' }));
    setListed([
      [PAIR_EURUSD.id, TradeAction.Up],
      [PAIR_SHORT.id, TradeAction.Down],
    ]);
    await at(FIRST_TICK);
    expect(texts()).toEqual([`base|${PAIR_SHORT.id}`]);
    expect(editMessageMedia).not.toHaveBeenCalled();
    expect(waiter.has(7)).toBe(true);
  });

  it('W6e ends the analysis on «message is not modified» of its photo, nothing forgotten or sent again', async () => {
    const { waiter, pair, at, setListed, editMessageMedia, editMessageText, screens } = setup();
    editMessageMedia.mockRejectedValueOnce(NOT_MODIFIED());
    waiter.waitPair(pair({ origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
    expect(screens.photos.forget).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(waiter.has(7)).toBe(false);
  });

  it('W7 takes the alternatives away 30 s after the door drew them, and keeps waiting', async () => {
    const { waiter, pair, at, texts } = setup();
    waiter.waitPair(pair({ alternatives: 'shown' }));
    await at(41_000);
    expect(texts()).toEqual([]);
    await at(46_000);
    expect(texts()).toEqual(['base|']);
    await at(81_000);
    expect(texts()).toEqual(['base|']);
    expect(waiter.has(7)).toBe(true);
  });

  it('W7b draws pending alternatives on the first poll with some, and takes them away 30 s later', async () => {
    const { waiter, pair, at, texts, setListed } = setup();
    setListed([[PAIR_SHORT.id, TradeAction.Up]]);
    waiter.waitPair(pair({ origin: 'door', alternatives: 'pending' }));
    await at(FIRST_TICK);
    expect(texts()).toEqual([`base|${PAIR_SHORT.id}`]);
    await at(FIRST_TICK + 25_000);
    expect(texts()).toHaveLength(1);
    await at(FIRST_TICK + TTL);
    expect(texts()).toEqual([`base|${PAIR_SHORT.id}`, 'base|']);
  });

  // #829: what the wait draws is recorded for the start once it is on screen
  it('W19 a list drawn by the wait records its pairs once the edit is on screen', async () => {
    const { waiter, list, at, setListed, shownSignals } = setup();
    setListed([[PAIR_EURUSD.id, TradeAction.Down]]);
    waiter.waitList(list());
    await at(FIRST_TICK);
    expect(shownSignals.remember.mock.calls).toEqual([
      [
        7,
        'list',
        FIRST_TICK,
        [
          {
            assetId: PAIR_EURUSD.id,
            action: 'down',
            second: FIRST_TICK - 900,
            decidedAt: FIRST_TICK - 500,
          },
        ],
      ],
    ]);
  });

  it.each([
    ['a 429', () => LIMITED(1)],
    ['a message gone', GONE],
  ])('W19b a list edit refused by %s records nothing', async (_name, failure) => {
    const { waiter, list, at, setListed, shownSignals, editMessageText } = setup();
    editMessageText.mockRejectedValueOnce(failure());
    setListed([[PAIR_EURUSD.id, TradeAction.Down]]);
    waiter.waitList(list());
    await at(FIRST_TICK);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(shownSignals.remember).not.toHaveBeenCalled();
  });

  const CARD_RECORD = [
    {
      assetId: PAIR_EURUSD.id,
      action: 'up',
      second: 1_790_000_044_000,
      decidedAt: 1_790_000_044_320,
    },
  ];

  it("W20 a card drawn by the wait records the answer's h1 as the analysis, not the list's item", async () => {
    const { waiter, pair, at, setListed, editMessageMedia, shownSignals } = setup();
    waiter.waitPair(pair({ origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
    expect(shownSignals.remember.mock.calls).toEqual([[7, 'analysis', FIRST_TICK, CARD_RECORD]]);
  });

  it("W20b the card's text fallback records it too", async () => {
    const { waiter, pair, at, setListed, editMessageMedia, texts, shownSignals } = setup();
    editMessageMedia.mockRejectedValueOnce(OTHER());
    waiter.waitPair(pair({ origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(texts()).toEqual(['card']);
    expect(shownSignals.remember.mock.calls).toEqual([
      [7, 'analysis', expect.any(Number), CARD_RECORD],
    ]);
  });

  it('W20c a card edit paused by a 429 records nothing', async () => {
    const { waiter, pair, at, setListed, editMessageMedia, shownSignals } = setup();
    editMessageMedia.mockRejectedValueOnce(LIMITED(1));
    waiter.waitPair(pair({ origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
    expect(shownSignals.remember).not.toHaveBeenCalled();
  });

  it('W21 an analysis whose own read has no H1 signal records nothing', async () => {
    const { waiter, pair, at, setListed, backend, shownSignals } = setup();
    backend.evaluateSignal.mockResolvedValue(SIGNAL_CANDLE_ONLY);
    waiter.waitPair(pair({ origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + POLL);
    expect(backend.evaluateSignal).toHaveBeenCalledTimes(2);
    expect(shownSignals.remember).not.toHaveBeenCalled();
    expect(waiter.has(7)).toBe(true);
  });

  it("W22 the other pairs' buttons the wait draws are recorded as a list once on screen", async () => {
    const { waiter, pair, at, setListed, shownSignals } = setup();
    setListed([[PAIR_SHORT.id, TradeAction.Up]]);
    waiter.waitPair(pair({ origin: 'door', alternatives: 'pending' }));
    await at(FIRST_TICK);
    expect(shownSignals.remember.mock.calls).toEqual([
      [
        7,
        'list',
        FIRST_TICK,
        [
          {
            assetId: PAIR_SHORT.id,
            action: 'up',
            second: FIRST_TICK - 900,
            decidedAt: FIRST_TICK - 500,
          },
        ],
      ],
    ]);
  });

  it("W22b the other pairs' buttons refused by their edit are not recorded", async () => {
    const { waiter, pair, at, setListed, shownSignals, editMessageText } = setup();
    editMessageText.mockRejectedValueOnce(GONE());
    setListed([[PAIR_SHORT.id, TradeAction.Up]]);
    waiter.waitPair(pair({ origin: 'door', alternatives: 'pending' }));
    await at(FIRST_TICK);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(shownSignals.remember).not.toHaveBeenCalled();
  });

  it('W7c waits for the pair alone once the first poll found no other pair', async () => {
    const { waiter, pair, at, texts, setListed } = setup();
    waiter.waitPair(pair({ alternatives: 'pending' }));
    await at(FIRST_TICK);
    setListed([[PAIR_SHORT.id, TradeAction.Up]]);
    await at(FIRST_TICK + 4 * POLL);
    expect(texts()).toEqual([]);
  });

  it('W8 edits nothing once the user left the screen', async () => {
    const { waiter, list, at, setListed, editMessageText } = setup();
    waiter.waitList(list());
    waiter.leave(7);
    expect(waiter.has(7)).toBe(false);
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + POLL);
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it('W8b moves the wait to the newest message of the user, the old one left as it is', async () => {
    const { waiter, list, pair, at, setListed, editMessageText } = setup();
    waiter.waitList(list({ messageId: 1 }));
    waiter.waitPair(pair({ messageId: 2, alternatives: 'pending' }));
    expect(waiter.size()).toBe(1);
    setListed([[PAIR_SHORT.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    expect(editMessageText.mock.calls.map((call) => call[1])).toEqual([2]);
  });

  it('W9 ends an entry nobody left after the bound with the start of trading', async () => {
    const { waiter, pair, at, texts } = setup({ maxMs: 60_000 });
    waiter.waitPair(pair());
    await at(T0 + 59_000);
    expect(texts()).toEqual([]);
    await at(T0 + 65_000);
    expect(texts()).toEqual(['expired']);
    expect(waiter.has(7)).toBe(false);
  });

  it('W10 stops the tick’s edits on a 429 and resumes no sooner than its retry_after', async () => {
    const { waiter, list, target, at, editMessageText, setListed } = setup();
    editMessageText.mockRejectedValueOnce(LIMITED(7));
    waiter.waitList(list(target(1)));
    waiter.waitList(list(target(2)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([1]);
    // paused until FIRST_TICK + 7 s: the next tick is skipped
    await at(FIRST_TICK + POLL);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    await at(FIRST_TICK + 2 * POLL + 1_000);
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([1, 1, 2]);
  });

  it('W10b ends an entry whose message is gone or whose user blocked the bot, sending nothing', async () => {
    const { waiter, list, target, at, editMessageText, setListed, logger } = setup();
    editMessageText.mockRejectedValueOnce(GONE()).mockRejectedValueOnce(BLOCKED());
    waiter.waitList(list(target(1)));
    waiter.waitList(list(target(2)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(waiter.size()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info.mock.calls.map((call) => call[1])).toEqual([
      'signal wait message not edited',
      'signal wait message not edited',
    ]);
  });

  it('W10c retries a refused or failed edit on the next ticks, three times, logging the method and the entry’s kind', async () => {
    const { waiter, pair, at, editMessageText, setListed, logger } = setup();
    editMessageText
      .mockRejectedValueOnce(TRANSPORT())
      .mockRejectedValueOnce(OTHER())
      .mockRejectedValueOnce(TRANSPORT());
    waiter.waitPair(pair({ alternatives: 'pending' }));
    setListed([[PAIR_SHORT.id, TradeAction.Up]]);
    await at(FIRST_TICK + POLL);
    expect(waiter.has(7)).toBe(true);
    await at(FIRST_TICK + 2 * POLL);
    expect(editMessageText).toHaveBeenCalledTimes(3);
    expect(waiter.has(7)).toBe(false);
    const fields = logger.warn.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(fields[1]).toMatchObject({
      method: 'editMessageText',
      telegramErrorCode: 400,
      kind: 'pair',
      origin: 'door',
    });
    for (const field of fields) {
      expect(field).not.toHaveProperty('telegramUserId');
      expect(JSON.stringify(field)).not.toContain('something else');
    }
  });

  it('W11 paces the edits of a tick editGapMs apart and skips a tick while they run', async () => {
    const { waiter, list, target, at, editMessageText, setListed, backend } = setup();
    const times: number[] = [];
    editMessageText.mockImplementation(() => {
      times.push(Date.now());
      return Promise.resolve(true);
    });
    for (let user = 1; user <= 30; user += 1) waiter.waitList(list(target(user)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + POLL);
    expect(backend.readSignals).toHaveBeenCalledTimes(1);
    await at(FIRST_TICK + 7_000);
    expect(times).toHaveLength(30);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(GAP);
    }
  });

  it('W12 at the stop polls no more and turns the waiting messages into the start of trading inside its window', async () => {
    const { waiter, list, target, at, editMessageText, backend } = setup({
      shutdownBudgetMs: 1_000,
    });
    for (let user = 1; user <= 10; user += 1) waiter.waitList(list(target(user)));
    const stopped = waiter.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(editMessageText).toHaveBeenCalledTimes(5);
    expect(waiter.size()).toBe(0);
    await at(FIRST_TICK + POLL);
    expect(backend.readSignals).not.toHaveBeenCalled();
    waiter.waitList(list());
    expect(waiter.size()).toBe(0);
  });

  it('W12b launches no stop edit after a 429', async () => {
    const { waiter, list, target, editMessageText } = setup();
    editMessageText.mockRejectedValueOnce(LIMITED(30));
    for (let user = 1; user <= 5; user += 1) waiter.waitList(list(target(user)));
    const stopped = waiter.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

  it('W12c starts the stop edits no sooner than a 429 of the last tick', async () => {
    const { waiter, list, at, texts, editMessageText, setListed } = setup();
    editMessageText.mockRejectedValueOnce(LIMITED(3));
    waiter.waitList(list());
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`]);
    await at(FIRST_TICK + 500);
    const stopped = waiter.stop();
    await at(FIRST_TICK + 2_900);
    expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`]);
    await at(FIRST_TICK + 4_000);
    await stopped;
    expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`, 'expired']);
  });

  it('W12d launches no stop edit while a 429 of the last tick outlasts the window', async () => {
    const { waiter, list, at, texts, editMessageText, setListed } = setup();
    editMessageText.mockRejectedValueOnce(LIMITED(30));
    waiter.waitList(list());
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    await at(FIRST_TICK + 500);
    const stopped = waiter.stop();
    await at(FIRST_TICK + 25_000);
    await stopped;
    expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`]);
  });

  it('W13 ends the oldest entry without an edit past maxEntries', async () => {
    const { waiter, list, target } = setup({ maxEntries: 2 });
    for (const user of [1, 2, 3]) waiter.waitList(list(target(user)));
    expect(waiter.has(1)).toBe(false);
    expect(waiter.size()).toBe(2);
  });

  it('W14 edits only when the screen differs, its keyboard included', async () => {
    const { waiter, list, target, at, editMessageText, setListed } = setup();
    const ids = `list:${PAIR_EURUSD.id}`;
    waiter.waitList(list({ ...target(1), drawn: screen(ids) }));
    waiter.waitList(list({ ...target(2), drawn: screen(ids, 'other') }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([2]);
  });

  it('W15 changes nothing on failed reads but the clock’s, one warn for the series', async () => {
    const { waiter, list, pair, target, at, backend, texts, logger } = setup();
    backend.readSignals.mockRejectedValue(new Error('down'));
    waiter.waitList(list({ ...target(1), shown: true }));
    waiter.waitPair(pair(target(2)));
    await at(FIRST_TICK + 2 * POLL);
    expect(texts()).toEqual([]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['signal wait reads failed']);
    await at(46_000);
    expect(texts()).toEqual(['expired']);
    expect(waiter.has(2)).toBe(true);
  });

  it('W16 ends an entry whose screen throws, logs it, and goes on with the others', async () => {
    const { waiter, list, target, at, editMessageText, setListed, screens, logger } = setup();
    vi.mocked(screens.list).mockImplementationOnce(() => {
      throw new InvalidTelegramTemplate('bad override');
    });
    waiter.waitList(list(target(1)));
    waiter.waitList(list(target(2)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([2]);
    expect(waiter.has(1)).toBe(false);
    expect(logger.error.mock.calls).toEqual([
      [{ err: { name: 'InvalidTelegramTemplate' }, kind: 'list' }, 'signal wait entry failed'],
    ]);
    await at(FIRST_TICK + POLL + 1_000);
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([2]);
    const stopped = waiter.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
  });

  it('W16b logs a tick that throws outside its entries, and the stop it is drained by resolves', async () => {
    const { waiter, list, at, backend, logger } = setup();
    let release!: (value: PairsCatalogResponse) => void;
    backend.readPairs.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    waiter.waitList(list());
    await at(FIRST_TICK);
    const stopped = waiter.stop();
    // a body the client's parser would never let through: readDemoCatalog throws on it
    release(undefined as unknown as PairsCatalogResponse);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(logger.error.mock.calls.map((call) => call[1])).toEqual(['signal wait tick failed']);
  });

  it('W17 logs a stop edit whose screen throws and edits the other messages', async () => {
    const { waiter, list, target, editMessageText, screens, logger } = setup();
    let calls = 0;
    screens.expired = () => {
      calls += 1;
      if (calls === 1) throw new InvalidTelegramTemplate('bad override');
      return screen('expired');
    };
    waiter.waitList(list(target(1)));
    waiter.waitList(list(target(2)));
    const stopped = waiter.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([2]);
    expect(logger.warn.mock.calls).toEqual([
      [
        { err: { name: 'InvalidTelegramTemplate' }, method: 'editMessageText', kind: 'list' },
        'signal wait message not edited at the stop',
      ],
    ]);
  });
});
