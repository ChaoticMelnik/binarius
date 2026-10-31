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
  type WaitMedia,
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
import {
  SIGNAL_WAIT_FANOUT_ENTRIES,
  SIGNAL_WAIT_FANOUT_MS,
  SIGNAL_WAIT_POLL_MS,
  SIGNAL_WAIT_POLL_OFFSET_MS,
} from './timing';

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

const SHORT_SHOWN: ShownSignal = {
  pair: PAIR_SHORT,
  action: TradeAction.Up,
  second: 1,
  decidedAt: 1,
};

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
    captionMs?: number;
    captionEditsPerTick?: number;
    // the pace (#869): the scenes that do not name it run one edit every GAP, no gap of a chat
    editBurst?: number;
    chatGapMs?: number;
    resolveConcurrency?: number;
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
        // without a pair the scanner's caption, which moves with every answer (#859)
        screen: screen(ids === '' ? `scan:${String(signals.asOf)}` : `list:${ids}`),
        listed: list.signals.length,
        shown: shownOf(list.signals, catalog),
      };
    }),
    expired: () => screen('expired'),
    waiting: vi.fn((base: TelegramHtml, alternatives: readonly ShownSignal[]) =>
      screen(`${base.value}|${alternatives.map(({ pair }) => pair.id).join(',')}`),
    ),
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
    media: { file: vi.fn((kind: string) => `${kind}-id`), remember: vi.fn(), forget: vi.fn() },
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
    editsPerSecond: 1000 / GAP,
    editBurst: options.editBurst ?? 1,
    chatGapMs: options.chatGapMs ?? 0,
    resolveConcurrency: options.resolveConcurrency ?? 10,
    // the captions' redraw (#859) stays out of the scenes that do not name it
    captionMs: options.captionMs ?? 3_600_000,
    captionEditsPerTick: options.captionEditsPerTick ?? 2,
    editFailuresMax: 3,
    shutdownBudgetMs: options.shutdownBudgetMs ?? 20_000,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
  waiter.attach(screens);
  const editMessageText = vi.fn<(...args: unknown[]) => Promise<true>>(() => Promise.resolve(true));
  const editMessageMedia = vi.fn<(...args: unknown[]) => Promise<true>>(() =>
    Promise.resolve(true),
  );
  const editMessageCaption = vi.fn<(...args: unknown[]) => Promise<true>>(() =>
    Promise.resolve(true),
  );
  const api = {
    editMessageText,
    editMessageMedia,
    editMessageCaption,
  } as unknown as ListWaitRequest['api'];
  const target = (user = 7) => ({
    api,
    chatId: user,
    messageId: user * 10,
    telegramUserId: user,
    language: BotLanguage.Ru,
    drawn: screen('drawn'),
    media: 'text' as WaitMedia,
    scanned: true,
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
    editMessageCaption,
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
    expect(renderKey(pair(ButtonRole.Up), 'text')).not.toBe(
      renderKey(pair(ButtonRole.Down), 'text'),
    );
    expect(renderKey(pair(ButtonRole.Up), 'text')).toBe(renderKey(pair(ButtonRole.Up), 'text'));
  });

  // #859: the end of a wait may change the media alone, its caption kept
  it('W23 the same screen as the animation and as the still are two drawings', () => {
    const drawn = screen('list');
    expect(renderKey(drawn, 'animation')).not.toBe(renderKey(drawn, 'still'));
    expect(renderKey(drawn, 'still')).not.toBe(renderKey(drawn, 'text'));
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
    waiter.waitPair(pair({ alternatives: [SHORT_SHOWN] }));
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

  it('W10 pauses every edit on a 429 and resumes no sooner than its retry_after', async () => {
    const { waiter, list, target, at, editMessageText, setListed } = setup();
    editMessageText.mockRejectedValueOnce(LIMITED(7));
    waiter.waitList(list(target(1)));
    waiter.waitList(list(target(2)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([1]);
    // paused until FIRST_TICK + 7 s: the next tick is skipped, the waiting edit holds its turn
    await at(FIRST_TICK + POLL);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    await at(FIRST_TICK + 7_000 - 1);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    await at(FIRST_TICK + 7_000);
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    await at(FIRST_TICK + 2 * POLL + 1_000);
    expect(editMessageText.mock.calls.map((call) => call[0])).toEqual([1, 2, 1]);
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

  // #869: the token bucket — the burst at once, then one every GAP — and the ticks go on while the
  // edits are in flight, an entry being edited left alone
  it('W11 sends a burst of edits at once, then one every editGapMs, and polls on while they run', async () => {
    const { waiter, list, target, at, editMessageText, setListed, backend } = setup({
      editBurst: 5,
    });
    const times: number[] = [];
    editMessageText.mockImplementation(() => {
      times.push(Date.now() - FIRST_TICK);
      return Promise.resolve(true);
    });
    for (let user = 1; user <= 30; user += 1) waiter.waitList(list(target(user)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + POLL);
    expect(backend.readSignals).toHaveBeenCalledTimes(2);
    await at(FIRST_TICK + 7_000);
    expect(times).toEqual([
      0,
      0,
      0,
      0,
      0,
      ...Array.from({ length: 25 }, (_, index) => (index + 1) * GAP),
    ]);
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

// #859: the wait is the scanner's animation; its caption is redrawn last, at most once in
// captionMs and captionEditsPerTick a tick; whatever ends it shows the still. The production poll:
// T0 = 12 345, ticks at 12 600, 13 600, …; CAPTION = 4 s after the registration is 16 345, so the
// first caption goes at the tick of 16 600.
const CAPTION = 4_000;
const captionSetup = (options: { captionEditsPerTick?: number } = {}) =>
  setup({
    pollMs: SIGNAL_WAIT_POLL_MS,
    pollOffsetMs: SIGNAL_WAIT_POLL_OFFSET_MS,
    captionMs: CAPTION,
    ...options,
  });
const animation = { media: 'animation' as WaitMedia };
const chatsOf = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((call) => call[0]);
const captionOf = (call: unknown[] | undefined) => (call?.[2] as { caption?: string }).caption;

describe('the live wait (#859)', () => {
  it('W31 a list on the animation goes onto the still with the list as its caption, recorded once there', async () => {
    const {
      waiter,
      list,
      at,
      setListed,
      editMessageMedia,
      editMessageText,
      shownSignals,
      screens,
    } = setup();
    waiter.waitList(list({ ...animation, drawn: screen(`list:${PAIR_EURUSD.id}`) }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK);
    expect(editMessageMedia.mock.calls).toEqual([
      [
        7,
        70,
        {
          type: 'photo',
          media: 'still-id',
          caption: `list:${PAIR_EURUSD.id}`,
          parse_mode: 'HTML',
        },
        { reply_markup: screen('k').keyboard },
      ],
    ]);
    expect(editMessageText).not.toHaveBeenCalled();
    expect(screens.media.remember).toHaveBeenCalledWith('still', true);
    expect(shownSignals.remember).toHaveBeenCalledTimes(1);
    expect(waiter.has(7)).toBe(true);
  });

  it('W24 redraws a caption no sooner than captionMs after the screen was drawn', async () => {
    const { waiter, list, at, editMessageCaption } = captionSetup();
    waiter.waitList(list(animation));
    await at(15_600);
    expect(editMessageCaption).not.toHaveBeenCalled();
    await at(16_600);
    expect(editMessageCaption).toHaveBeenCalledTimes(1);
    expect(captionOf(editMessageCaption.mock.calls[0])).toBe('scan:16100');
    await at(19_600);
    expect(editMessageCaption).toHaveBeenCalledTimes(1);
    await at(20_600);
    expect(editMessageCaption).toHaveBeenCalledTimes(2);
  });

  it('W25 redraws at most captionEditsPerTick captions a tick, the longest waiting first', async () => {
    const { waiter, list, target, at, editMessageCaption } = captionSetup();
    for (const user of [1, 2, 3]) {
      waiter.waitList(list({ ...target(user), ...animation }));
      await vi.advanceTimersByTimeAsync(50);
    }
    await at(16_600 + 2 * GAP);
    expect(chatsOf(editMessageCaption)).toEqual([1, 2]);
    await at(17_600 + GAP);
    expect(chatsOf(editMessageCaption)).toEqual([1, 2, 3]);
  });

  it('W26 draws what ends a wait before any caption of the same tick', async () => {
    const { waiter, pair, target, at, editMessageCaption, editMessageMedia, setListed } =
      captionSetup();
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    waiter.waitPair(pair({ ...target(1), ...animation, assetId: PAIR_SHORT.id }));
    await at(16_000);
    waiter.waitPair(pair({ ...target(2), ...animation }));
    await at(16_600 + 2 * GAP);
    expect(chatsOf(editMessageMedia)).toEqual([2]);
    expect(chatsOf(editMessageCaption)).toEqual([1]);
    expect(editMessageMedia.mock.invocationCallOrder[0]).toBeLessThan(
      editMessageCaption.mock.invocationCallOrder[0]!,
    );
  });

  it('W27 a caption redraw edits the caption of a media message and the text of a text one', async () => {
    const { waiter, list, target, at, editMessageCaption, editMessageText, editMessageMedia } =
      captionSetup();
    waiter.waitList(list({ ...target(1), ...animation }));
    waiter.waitList(list(target(2)));
    await at(16_600 + 2 * GAP);
    expect(chatsOf(editMessageCaption)).toEqual([1]);
    expect(chatsOf(editMessageText)).toEqual([2]);
    expect(editMessageMedia).not.toHaveBeenCalled();
  });

  it('W28 leaving an animation turns it into the still with the start of trading, once; a text stays', async () => {
    const { waiter, list, target, editMessageMedia, editMessageText, editMessageCaption } = setup();
    waiter.waitList(list({ ...target(1), ...animation }));
    waiter.waitList(list(target(2)));
    waiter.leave(1);
    waiter.leave(2);
    waiter.leave(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(editMessageMedia.mock.calls).toEqual([
      [
        1,
        10,
        { type: 'photo', media: 'still-id', caption: 'expired', parse_mode: 'HTML' },
        { reply_markup: screen('k').keyboard },
      ],
    ]);
    expect(editMessageText).not.toHaveBeenCalled();
    expect(editMessageCaption).not.toHaveBeenCalled();
  });

  it('W29 a refused media edit forgets the file and puts the same screen into the caption, a slot later', async () => {
    const { waiter, list, at, setListed, editMessageMedia, editMessageCaption, screens, logger } =
      setup();
    const times: number[] = [];
    editMessageMedia.mockImplementationOnce(() => {
      times.push(Date.now());
      return Promise.reject(OTHER());
    });
    editMessageCaption.mockImplementationOnce(() => {
      times.push(Date.now());
      return Promise.resolve(true);
    });
    waiter.waitList(list(animation));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(screens.media.forget).toHaveBeenCalledWith('still');
    expect(captionOf(editMessageCaption.mock.calls[0])).toBe(`list:${PAIR_EURUSD.id}`);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(GAP);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'the scan media was refused, editing the caption',
    ]);
    // the list stands on the animation: its expiry tries the still again, the file uploaded anew
    await at(FIRST_TICK + TTL + POLL);
    expect(captionOf(editMessageMedia.mock.calls[1])).toBe('expired');
    expect(editMessageCaption).toHaveBeenCalledTimes(1);
  });

  it('W30 a 429 of the tick leaves the captions until its retry_after', async () => {
    const { waiter, pair, target, at, editMessageCaption, editMessageMedia, setListed } =
      captionSetup();
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    editMessageMedia.mockRejectedValueOnce(LIMITED(3));
    waiter.waitPair(pair({ ...target(1), ...animation, assetId: PAIR_SHORT.id }));
    await at(16_000);
    waiter.waitPair(pair({ ...target(2), ...animation }));
    await at(18_600 + GAP);
    expect(editMessageCaption).not.toHaveBeenCalled();
    await at(19_600 + 2 * GAP);
    expect(chatsOf(editMessageMedia)).toEqual([2, 2]);
    expect(chatsOf(editMessageCaption)).toEqual([1]);
  });

  it('W32 a list on the still expires into its caption', async () => {
    const { waiter, list, at, editMessageCaption, editMessageMedia } = setup();
    waiter.waitList(list({ media: 'still', shown: true }));
    await at(46_000);
    expect(captionOf(editMessageCaption.mock.calls[0])).toBe('expired');
    expect(editMessageMedia).not.toHaveBeenCalled();
    expect(waiter.has(7)).toBe(false);
  });

  it('W33 at the stop an animation becomes the still with the start of trading', async () => {
    const { waiter, list, target, editMessageMedia, editMessageText } = setup();
    waiter.waitList(list({ ...target(1), ...animation }));
    waiter.waitList(list(target(2)));
    const stopped = waiter.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(chatsOf(editMessageMedia)).toEqual([1]);
    expect(captionOf(editMessageMedia.mock.calls[0])).toBe('expired');
    expect(chatsOf(editMessageText)).toEqual([2]);
  });

  it('W34 the stop waits for a freeze in flight', async () => {
    const { waiter, list, editMessageMedia } = setup();
    let release!: (value: true) => void;
    editMessageMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    waiter.waitList(list(animation));
    waiter.leave(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
    let done = false;
    void waiter.stop().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('W6g a card photo refused for its file under the animation goes onto the still with the card as its caption', async () => {
    const { waiter, pair, at, setListed, editMessageMedia, editMessageCaption, screens } = setup();
    editMessageMedia.mockRejectedValueOnce(OTHER());
    waiter.waitPair(pair({ ...animation, origin: 'analysis' }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 1_000);
    expect(screens.photos.forget).toHaveBeenCalledWith(TradeAction.Up);
    expect(editMessageMedia.mock.calls[1]?.slice(2)).toEqual([
      { type: 'photo', media: 'still-id', caption: 'card', parse_mode: 'HTML' },
      { reply_markup: keyboardOf([callbackButton(ButtonRole.Nav, 'c', 'c')]) },
    ]);
    expect(editMessageCaption).not.toHaveBeenCalled();
    expect(waiter.has(7)).toBe(false);
  });

  it("W35 a screen drawn without the scanner's lines gets them on the first poll", async () => {
    const { waiter, pair, at, editMessageCaption, screens } = captionSetup();
    waiter.waitPair(pair({ ...animation, scanned: false, origin: 'analysis' }));
    await at(12_600);
    expect(editMessageCaption).toHaveBeenCalledTimes(1);
    expect(vi.mocked(screens.waiting).mock.calls[0]?.[2]).toMatchObject({
      list: { interval: '5s' },
      pair: { id: PAIR_EURUSD.id },
    });
  });

  it('W36 a caption is not redrawn without a fresh read', async () => {
    const { waiter, pair, at, editMessageCaption, backend } = captionSetup();
    backend.readSignals.mockRejectedValue(new Error('down'));
    waiter.waitPair(pair(animation));
    await at(17_600);
    expect(editMessageCaption).not.toHaveBeenCalled();
  });

  // the freezes of the waits left on the animation: one at a time, at the shared pace, none in a
  // 429's pause, a 429 of their own retried after its retry_after
  it('W37 a freeze waits out the pause of a 429 of the tick and goes once after its retry_after', async () => {
    const { waiter, list, target, at, setListed, editMessageText, editMessageMedia } = setup();
    editMessageText.mockRejectedValueOnce(LIMITED(3));
    waiter.waitList(list(target(1)));
    waiter.waitList(list({ ...target(2), ...animation }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 500);
    waiter.leave(2);
    await at(FIRST_TICK + 2_900);
    expect(editMessageMedia).not.toHaveBeenCalled();
    await at(FIRST_TICK + 3_000 + GAP);
    expect(chatsOf(editMessageMedia)).toEqual([2]);
    expect(captionOf(editMessageMedia.mock.calls[0])).toBe('expired');
    await at(FIRST_TICK + 4_000);
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
  });

  // #869: the tick's signal edits go before the freeze; its 429 pauses the pace for every edit
  it('W38 a 429 of a freeze pauses the pace, and the freeze goes again after its retry_after', async () => {
    const { waiter, list, target, at, setListed, editMessageText, editMessageMedia } = setup();
    editMessageMedia.mockRejectedValueOnce(LIMITED(3));
    for (const user of [2, 3, 4]) waiter.waitList(list(target(user)));
    waiter.waitList(list({ ...target(1), ...animation }));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 50);
    waiter.leave(1);
    await at(FIRST_TICK + 3_000);
    expect(chatsOf(editMessageText)).toEqual([2, 3, 4]);
    expect(chatsOf(editMessageMedia)).toEqual([1]);
    // the freeze's slot came at +600 ms, its pause ends at +3 600 ms
    await at(FIRST_TICK + 3_600 - 1);
    expect(chatsOf(editMessageMedia)).toEqual([1]);
    await at(FIRST_TICK + 3_600);
    expect(chatsOf(editMessageMedia)).toEqual([1, 1]);
    expect(captionOf(editMessageMedia.mock.calls[1])).toBe('expired');
  });

  it('W39 a freeze refused for its file forgets the still, a gone one ends quietly, neither tried again', async () => {
    const { waiter, list, target, editMessageMedia, screens, logger } = setup();
    editMessageMedia.mockRejectedValueOnce(OTHER()).mockRejectedValueOnce(GONE());
    for (const user of [1, 2]) waiter.waitList(list({ ...target(user), ...animation }));
    waiter.leave(1);
    waiter.leave(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chatsOf(editMessageMedia)).toEqual([1, 2]);
    expect(vi.mocked(screens.media.forget).mock.calls).toEqual([['still']]);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'signal wait message not frozen',
    ]);
    expect(logger.info.mock.calls.map((call) => call[1])).toEqual([
      'signal wait message not frozen',
    ]);
  });

  it('W40 the freezes go one at a time at the shared pace, never more than a slot before the tick', async () => {
    const { waiter, list, target, at, setListed, editMessageText, editMessageMedia } = setup();
    const times: number[] = [];
    let retriedAt = 0;
    editMessageMedia.mockImplementation(() => {
      times.push(Date.now());
      return Promise.resolve(true);
    });
    editMessageText.mockRejectedValueOnce(LIMITED(4)).mockImplementation(() => {
      retriedAt = Date.now();
      times.push(retriedAt);
      return Promise.resolve(true);
    });
    waiter.waitList(list(target(20)));
    for (let user = 1; user <= 10; user += 1) {
      waiter.waitList(list({ ...target(user), ...animation }));
    }
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 500);
    for (let user = 1; user <= 10; user += 1) waiter.leave(user);
    await at(FIRST_TICK + 7_000);
    expect(times).toHaveLength(11);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(GAP);
    }
    expect(retriedAt).toBeLessThanOrEqual(FIRST_TICK + POLL + 2 * GAP);
  });

  it.each([
    [3, [2], ['expired']],
    [30, [], []],
  ])(
    'W41 the stop wakes a freeze waiting out a %i s pause, its drain edits %j',
    async (seconds, frozen, expired) => {
      const { waiter, list, target, at, setListed, editMessageText, editMessageMedia, texts } =
        setup();
      editMessageText.mockRejectedValueOnce(LIMITED(seconds));
      waiter.waitList(list(target(1)));
      waiter.waitList(list({ ...target(2), ...animation }));
      setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
      await at(FIRST_TICK + 200);
      waiter.leave(2);
      await at(FIRST_TICK + 500);
      let done = false;
      void waiter.stop().then(() => {
        done = true;
      });
      await at(FIRST_TICK + 500 + 20_000 + 1_000);
      expect(done).toBe(true);
      expect(chatsOf(editMessageMedia)).toEqual(frozen);
      expect(texts()).toEqual([`list:${PAIR_EURUSD.id}`, ...expired]);
    },
  );
});

// #869: the tick decides for every entry first, resolves the signals side by side, and paces the
// edits through the token bucket — signal edits first, a chat at most once a second
describe('the fan-out and the pace (#869)', () => {
  it('W42 sends the signal edits of 20 waiting users within the fan-out bound, at most 10 access reads at once, Telegram answering in 2 s', async () => {
    const { waiter, pair, target, at, setListed, backend, editMessageText } = setup({
      editBurst: 5,
      chatGapMs: 1_000,
      resolveConcurrency: 10,
    });
    let reading = 0;
    let mostReading = 0;
    backend.readTradingAccess.mockImplementation(() => {
      reading += 1;
      mostReading = Math.max(mostReading, reading);
      return new Promise((resolve) => {
        setTimeout(() => {
          reading -= 1;
          resolve(accessView());
        }, 300);
      });
    });
    const sentAt: number[] = [];
    editMessageText.mockImplementation(() => {
      sentAt.push(Date.now() - FIRST_TICK);
      return new Promise((resolve) => setTimeout(() => resolve(true), 2_000));
    });
    for (let user = 1; user <= SIGNAL_WAIT_FANOUT_ENTRIES; user += 1) {
      waiter.waitPair(pair(target(user)));
    }
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + SIGNAL_WAIT_FANOUT_MS);
    expect(sentAt).toHaveLength(SIGNAL_WAIT_FANOUT_ENTRIES);
    expect(Math.max(...sentAt)).toBeLessThanOrEqual(SIGNAL_WAIT_FANOUT_MS);
    expect(mostReading).toBe(10);
    await at(FIRST_TICK + 2 * SIGNAL_WAIT_FANOUT_MS);
    expect(waiter.size()).toBe(0);
  });

  it('W43 a signal edit goes before the TTL edits of an earlier tick still waiting for their slots', async () => {
    const { waiter, list, pair, target, at, setListed, editMessageText, texts } = setup({
      pollMs: 1_000,
      pollOffsetMs: 600,
    });
    for (let user = 1; user <= 10; user += 1)
      waiter.waitList(list({ ...target(user), shown: true }));
    waiter.waitPair(pair(target(99)));
    // the lists expire on the tick at 42 600 ms, ten edits one every GAP
    await at(42_700);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(46_000);
    const order = texts();
    expect(order).toHaveLength(11);
    const signalAt = order.findIndex((text) => text.startsWith('next:'));
    expect(signalAt).toBeGreaterThanOrEqual(5);
    expect(signalAt).toBeLessThan(7);
    expect(order.slice(signalAt + 1).every((text) => text === 'expired')).toBe(true);
  });

  it('W44 polls every second while an edit is in flight and never edits the busy entry twice', async () => {
    const { waiter, pair, at, setListed, backend, editMessageText } = setup({
      pollMs: 1_000,
      pollOffsetMs: 600,
    });
    let release = (): void => {};
    editMessageText.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(true);
        }),
    );
    waiter.waitPair(pair({ alternatives: 'pending' }));
    setListed([[PAIR_SHORT.id, TradeAction.Up]]);
    await at(13_600);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    await at(16_600);
    expect(backend.readSignals).toHaveBeenCalledTimes(5);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    release();
    await at(17_600);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(waiter.has(7)).toBe(true);
  });

  it('W45 edits a chat at most once a second: the card’s text after its refused photo, the new wait after the old one’s freeze', async () => {
    const card = setup({ editBurst: 5, chatGapMs: 1_000 });
    const mediaAt: number[] = [];
    const textAt: number[] = [];
    card.editMessageMedia.mockImplementation(() => {
      mediaAt.push(Date.now());
      return Promise.reject(OTHER());
    });
    card.editMessageText.mockImplementation(() => {
      textAt.push(Date.now());
      return Promise.resolve(true);
    });
    card.waiter.waitPair(card.pair({ origin: 'analysis' }));
    card.setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await card.at(FIRST_TICK + 2_000);
    expect(mediaAt).toEqual([FIRST_TICK]);
    expect(textAt).toEqual([FIRST_TICK + 1_000]);
    expect(card.waiter.has(7)).toBe(false);

    vi.setSystemTime(T0);
    const user = setup({ editBurst: 5, chatGapMs: 1_000 });
    const frozenAt: number[] = [];
    const drawnAt: number[] = [];
    user.editMessageMedia.mockImplementation(() => {
      frozenAt.push(Date.now());
      return Promise.resolve(true);
    });
    user.editMessageText.mockImplementation(() => {
      drawnAt.push(Date.now());
      return Promise.resolve(true);
    });
    user.waiter.waitList(user.list({ ...user.target(7), ...animation }));
    await user.at(FIRST_TICK - 100);
    user.waiter.leave(7);
    user.waiter.waitList(user.list(user.target(7)));
    user.setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await user.at(FIRST_TICK + 2_000);
    expect(frozenAt).toEqual([FIRST_TICK - 100]);
    expect(drawnAt).toEqual([FIRST_TICK + 900]);
  });

  it('W46 a 429 of one signal edit holds the others until its retry_after, and its entry stays', async () => {
    const { waiter, list, target, at, setListed, editMessageText } = setup();
    const sentAt: [unknown, number][] = [];
    editMessageText
      .mockImplementationOnce((chat) => {
        sentAt.push([chat, Date.now() - FIRST_TICK]);
        return Promise.reject(LIMITED(2));
      })
      .mockImplementation((chat) => {
        sentAt.push([chat, Date.now() - FIRST_TICK]);
        return Promise.resolve(true);
      });
    for (const user of [1, 2, 3]) waiter.waitList(list(target(user)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 2_500);
    expect(sentAt).toEqual([
      [1, 0],
      [2, 2_000],
      [3, 2_200],
    ]);
    expect(waiter.has(1)).toBe(true);
    await at(FIRST_TICK + POLL);
    expect(sentAt[3]).toEqual([1, POLL]);
  });

  it('W47 at the stop the edits waiting for a slot send nothing, and the drain edits every entry inside its window', async () => {
    const { waiter, list, target, at, setListed, texts } = setup({ shutdownBudgetMs: 2_000 });
    for (let user = 1; user <= 5; user += 1) waiter.waitList(list(target(user)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 50);
    expect(texts()).toEqual([`list:${String(PAIR_EURUSD.id)}`]);
    let done = false;
    void waiter.stop().then(() => {
      done = true;
    });
    await at(FIRST_TICK + 50 + 2_000);
    expect(done).toBe(true);
    expect(texts()).toEqual([
      `list:${String(PAIR_EURUSD.id)}`,
      'expired',
      'expired',
      'expired',
      'expired',
      'expired',
    ]);
  });

  it('W48 the drain draws an entry whose edit got its slot before the stop only after that edit, and never over a drawn card', async () => {
    const { waiter, list, pair, target, at, setListed, editMessageText, editMessageMedia } = setup({
      editBurst: 5,
    });
    let answerCard = (): void => {};
    let answerList = (): void => {};
    editMessageMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerCard = () => resolve(true);
        }),
    );
    editMessageText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerList = () => resolve(true);
        }),
    );
    const textsTo = (chat: number) =>
      editMessageText.mock.calls
        .filter((call) => call[0] === chat)
        .map((call) => (call[2] as string).replace(/\n⠀.*$/s, ''));
    waiter.waitPair(pair({ ...target(1), origin: 'analysis' }));
    waiter.waitList(list(target(2)));
    setListed([[PAIR_EURUSD.id, TradeAction.Up]]);
    await at(FIRST_TICK + 50);
    expect(editMessageMedia.mock.calls.map((call) => call[0])).toEqual([1]);
    expect(textsTo(2)).toEqual([`list:${String(PAIR_EURUSD.id)}`]);

    let done = false;
    void waiter.stop().then(() => {
      done = true;
    });
    await at(FIRST_TICK + 1_000);
    expect(textsTo(1)).toEqual([]);
    expect(textsTo(2)).toEqual([`list:${String(PAIR_EURUSD.id)}`]);

    answerCard();
    await at(FIRST_TICK + 2_000);
    answerList();
    await at(FIRST_TICK + 3_000);
    expect(textsTo(1)).toEqual([]);
    expect(editMessageMedia).toHaveBeenCalledTimes(1);
    expect(textsTo(2)).toEqual([`list:${String(PAIR_EURUSD.id)}`, 'expired']);
    expect(done).toBe(true);
  });
});
