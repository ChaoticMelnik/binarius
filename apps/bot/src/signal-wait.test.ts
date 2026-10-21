import { GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BotLanguage,
  SignalFeedOutcome,
  SignalKind,
  telegramHtml,
  TradeAction,
  TradeMode,
  type BrokerRestErrorCode,
  type TelegramHtml,
  type TradingSignalsResponse,
} from '@binarius/shared';
import type { BackendClient } from './backend-client';
import type { DemoScreen } from './demo';
import { currentLanguage } from './language';
import {
  createSignalWaiter,
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
  SIGNAL_CARD,
  SIGNAL_NO_SIGNAL,
  signalsResponse,
} from './testing';

// The wait for a signal (#664, signal-wait.ts) on fake timers: one tick at each candle's boundary
// plus the offset, by the bot's clock, from a start that is not on a boundary.
const T0 = 12_345;
const FIRST_TICK = 16_000;
const POLL = 5_000;
const TTL = 30_000;
const GAP = 200;

const screen = (text: string, button = 'k'): DemoScreen => ({
  text: telegramHtml`${text}`,
  keyboard: new InlineKeyboard().text(button, button),
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
const TRANSPORT = () => new HttpError("Network request for 'editMessageText' failed!", new Error());

function setup(options: { maxMs?: number; shutdownBudgetMs?: number; maxEntries?: number } = {}) {
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
    list: vi.fn((signals: TradingSignalsResponse) => {
      languages.push(currentLanguage());
      const list = signals.lists.find((candidate) => candidate.interval === '5s');
      if (list === undefined) return undefined;
      const ids = list.signals.map((signal) => signal.assetId).join(',');
      return { screen: screen(`list:${ids}`), listed: list.signals.length };
    }),
    expired: () => screen('expired'),
    waiting: (base: TelegramHtml, alternatives) =>
      screen(`${base.value}|${alternatives.map(({ pair }) => pair.id).join(',')}`),
    alternatives: (signals, catalog) =>
      signals.flatMap((signal) => {
        const pair = catalog.pairs.find((listedPair) => listedPair.id === signal.assetId);
        return pair === undefined ? [] : [{ pair, action: signal.action }];
      }),
    nextStep: (step, pair, access) =>
      screen(`next:${pair.id}:${access?.tradingMode ?? 'none'}:${step.back}`),
    refusal: (check) => screen(`refusal:${check.reason}`),
    card: (_pair, response) =>
      response.outcome === SignalFeedOutcome.Decided && response.decision.kind === SignalKind.Signal
        ? {
            text: telegramHtml`card`,
            keyboard: new InlineKeyboard().text('c', 'c'),
            action: response.decision.action,
          }
        : undefined,
    photos: { photo: vi.fn(() => 'file-id'), remember: vi.fn(), forget: vi.fn() },
  };
  const logger = fakeLogger();
  const waiter = createSignalWaiter({
    backend,
    logger,
    pollMs: POLL,
    pollOffsetMs: 1_000,
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
    });
    await at(FIRST_TICK + 3 * POLL);
    expect(waiter.has(7)).toBe(true);
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
    waiter.waitPair(pair({ origin: 'start', alternatives: 'pending' }));
    await at(FIRST_TICK);
    expect(texts()).toEqual([`base|${PAIR_SHORT.id}`]);
    await at(FIRST_TICK + 25_000);
    expect(texts()).toHaveLength(1);
    await at(FIRST_TICK + TTL);
    expect(texts()).toEqual([`base|${PAIR_SHORT.id}`, 'base|']);
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
});
