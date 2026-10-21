import { GrammyError, HttpError, type Api } from 'grammy';
import {
  editRefusal,
  errorLogFields,
  intervalForDuration,
  SignalFeedOutcome,
  SignalKind,
  telegramErrorFields,
  type BotKeyboard,
  type BotLanguage,
  type PairsCatalogResponse,
  type PairView,
  type TelegramHtml,
  type TradeAction,
  type TradingAccessResponse,
  type TradingSignalResponse,
  type TradingSignalsResponse,
} from '@binarius/shared';
import { backendErrorFields, type BackendClient } from './backend-client';
import {
  checkDemoTrade,
  DEMO_DURATION_SEC,
  readDemoCatalog,
  type DemoTradeCheck,
} from './demo-catalog';
import type { CycleBack, DemoScreen, ShownSignal } from './demo';
import { runWithLanguage } from './language';
import type { Logger } from './logging';
import { editMessagePhotoByIdHtml, editMessageTextByIdHtml } from './send';
import type { SetupCardPhotos } from './setup-card';

// The wait for a signal (#664, docs/bot-demo.md → The wait for a signal). After the user chose a
// pair the bot never says «сигнала нет»: the screen waits, and the bot edits the same message once
// a signal comes. One entry per user, in this process's memory; any button and any command end it
// (bot.ts, beside endInputStep). One poll of GET /trading/signals and GET /trading/pairs serves
// every entry, once a candle of the demo's duration (timing.ts → SIGNAL_WAIT_POLL_MS), and a pair
// has a signal now when it is in the scanner's fresh list and the catalog takes the trade — the
// one definition of the list, the doors and the waits. The buttons of pairs stand listTtlMs (30 s),
// an entry at most maxMs; the edits go at the pace of editGapMs, and a 429 pauses them for its
// retry_after. stop() turns the waiting messages into the start of trading inside its window.

type WaitApi = Pick<Api, 'editMessageText' | 'editMessageMedia'>;

// where the wait for a pair started: the pair's door (`demo:l`), the analysis without a signal, a
// session start refused for want of one (409 no_signal)
export type WaitOrigin = 'door' | 'analysis' | 'start';

// the other pairs' buttons under the wait for a pair: to be drawn by the first poll, standing since
// a time, or gone for good
export type WaitAlternatives = 'pending' | 'shown' | 'done';

interface WaitTarget {
  api: WaitApi;
  chatId: number;
  messageId: number;
  telegramUserId: number;
  // the user's language (#508): the edits run outside any update
  language: BotLanguage;
  // what the message shows now, the render key's start
  drawn: DemoScreen;
}

export interface ListWaitRequest extends WaitTarget {
  // the list has pairs (true: it expires) or waits for its first one
  shown: boolean;
}

export interface PairWaitRequest extends WaitTarget {
  firstName: string;
  assetId: number;
  back: CycleBack;
  origin: WaitOrigin;
  // the waiting text without the alternatives' line
  base: TelegramHtml;
  alternatives: WaitAlternatives;
}

// What the waits draw, demo.ts's screens (createSignalWaitScreens). Every call runs in the entry's
// language.
export interface SignalWaitScreens {
  // the signals screen, and how many pairs it lists; undefined without the demo's list
  list(
    signals: TradingSignalsResponse,
    catalog: PairsCatalogResponse,
    nowMs: number,
  ): { screen: DemoScreen; listed: number } | undefined;
  // the start of trading: the list expired, the bound, the stop
  expired(): DemoScreen;
  // the wait for a pair, with the other pairs' buttons when there are some
  waiting(base: TelegramHtml, alternatives: readonly ShownSignal[]): DemoScreen;
  // the pairs with a signal now, in the list's order; the wait leaves the chosen pair out
  alternatives(
    signals: TradingSignalsResponse['lists'][number]['signals'],
    catalog: PairsCatalogResponse,
    nowMs: number,
  ): ShownSignal[];
  // the next step on the chosen pair's signal: the amount screen in demo, the launch in real; a
  // failed access read (null) the amount screen's own «недоступно»
  nextStep(
    step: { assetId: number; back: CycleBack; firstName: string },
    pair: PairView,
    access: TradingAccessResponse | null,
  ): DemoScreen;
  // the pair closed, gone or not taking the demo's duration by the fresh catalog
  refusal(
    check: Exclude<DemoTradeCheck, { ok: true }>,
    catalog: PairsCatalogResponse,
    nowMs: number,
  ): DemoScreen;
  // the analysis's card on a signal (#482); undefined without one
  card(
    pair: PairView,
    response: TradingSignalResponse,
    access: TradingAccessResponse | null,
  ): { text: TelegramHtml; keyboard: BotKeyboard; action: TradeAction } | undefined;
  photos: Pick<SetupCardPhotos, 'photo' | 'remember' | 'forget'>;
}

export interface SignalWaiter {
  attach(screens: SignalWaitScreens): void;
  // A new entry replaces the user's previous one: its message is not edited again, but for an
  // edit already in flight. A no-op after stop().
  waitList(request: ListWaitRequest): void;
  waitPair(request: PairWaitRequest): void;
  leave(telegramUserId: number): void;
  has(telegramUserId: number): boolean;
  size(): number;
  // no more polls, the tick in flight waited for, the waiting messages edited inside the window
  stop(): Promise<void>;
}

export interface SignalWaiterOptions {
  backend: Pick<
    BackendClient,
    'readSignals' | 'readPairs' | 'readTradingAccess' | 'evaluateSignal'
  >;
  logger: Logger;
  pollMs: number;
  pollOffsetMs: number;
  listTtlMs: number;
  maxMs: number;
  editGapMs: number;
  editFailuresMax: number;
  shutdownBudgetMs: number;
  maxEntries?: number;
  now?: () => number;
}

// the trackers' bound: past it the oldest entry ends without an edit
const SIGNAL_WAIT_MAX_ENTRIES = 10_000;

type Entry =
  | (WaitTarget & { kind: 'list'; startedAt: number; shownAt: number | undefined } & Common)
  | (WaitTarget & {
      kind: 'pair';
      startedAt: number;
      pair: Omit<PairWaitRequest, keyof WaitTarget | 'alternatives'> & {
        alternatives: 'pending' | 'done' | { shownAt: number };
      };
    } & Common);

interface Common {
  rendered: string;
  editFailures: number;
  // the warn lines already written for this entry
  warned: Set<string>;
}

// The whole screen: the alternatives' removal changes only the keyboard, the list's first pairs
// only the buttons when two texts are equal (overrides).
export const renderKey = (screen: DemoScreen): string =>
  `${screen.text.value}\n${JSON.stringify(screen.keyboard.inline_keyboard)}`;

// the reads of one tick: the demo's list and the catalog, undefined where a read failed
interface Snapshot {
  signals: TradingSignalsResponse | undefined;
  list: TradingSignalsResponse['lists'][number] | undefined;
  catalog: PairsCatalogResponse | undefined;
}

type EditOutcome = 'drawn' | 'ended' | 'paused' | 'kept';

export function createSignalWaiter({
  backend,
  logger,
  pollMs,
  pollOffsetMs,
  listTtlMs,
  maxMs,
  editGapMs,
  editFailuresMax,
  shutdownBudgetMs,
  maxEntries = SIGNAL_WAIT_MAX_ENTRIES,
  now = Date.now,
}: SignalWaiterOptions): SignalWaiter {
  const entries = new Map<number, Entry>();
  let attachedScreens: SignalWaitScreens | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | undefined;
  let stopped = false;
  let pausedUntil = 0;
  let lastEditAt = Number.NEGATIVE_INFINITY;
  let readsFailing = false;
  const interval = intervalForDuration(DEMO_DURATION_SEC);

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // the next candle's boundary plus the offset, by the bot's clock
  function schedule(): void {
    if (stopped || timer !== undefined || entries.size === 0) return;
    const at = now();
    const next = (Math.floor((at - pollOffsetMs) / pollMs) + 1) * pollMs + pollOffsetMs;
    timer = setTimeout(onTimer, next - at);
  }

  function onTimer(): void {
    timer = undefined;
    // a tick that finds the previous one in flight is skipped: its entries are counted again on
    // the next snapshot
    if (inflight === undefined) {
      inflight = tick()
        .catch((error: unknown) => {
          logger.error(errorLogFields(error), 'signal wait tick failed');
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    schedule();
  }

  function register(entry: Entry): void {
    if (stopped) return;
    entries.delete(entry.telegramUserId);
    entries.set(entry.telegramUserId, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    schedule();
  }

  function end(entry: Entry): void {
    if (entries.get(entry.telegramUserId) === entry) entries.delete(entry.telegramUserId);
    if (entries.size === 0 && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  const live = (entry: Entry) => !stopped && entries.get(entry.telegramUserId) === entry;

  // the entry in a log line, without the user's id or the pair's symbol (Rule 8)
  const entryFields = (entry: Entry) => ({
    kind: entry.kind,
    ...(entry.kind === 'pair' ? { origin: entry.pair.origin } : {}),
  });

  function common(drawn: DemoScreen): Common {
    return { rendered: renderKey(drawn), editFailures: 0, warned: new Set() };
  }

  function attached(): SignalWaitScreens {
    if (attachedScreens === undefined) {
      throw new Error('the signal waiter has no screens attached');
    }
    return attachedScreens;
  }

  async function readSnapshot(): Promise<Snapshot> {
    const [signals, read] = await Promise.all([
      backend.readSignals().then(
        (value) => value,
        (error: unknown) => {
          if (!readsFailing) {
            logger.warn(
              { ...errorLogFields(error), ...backendErrorFields(error) },
              'signal wait reads failed',
            );
          }
          return undefined;
        },
      ),
      readDemoCatalog(backend),
    ]);
    const list = signals?.lists.find((candidate) => candidate.interval === interval);
    const catalog = read.ok ? read.catalog : undefined;
    const failed = list === undefined || catalog === undefined;
    if (failed && !readsFailing && signals !== undefined) {
      logger.warn(
        read.ok
          ? { interval }
          : read.reason === 'backend_failed'
            ? { ...errorLogFields(read.error), ...backendErrorFields(read.error) }
            : { catalogReason: read.reason },
        'signal wait reads failed',
      );
    }
    readsFailing = failed;
    return { signals, list, catalog };
  }

  async function tick(): Promise<void> {
    if (now() < pausedUntil) return;
    const snapshot = await readSnapshot();
    const nowMs = now();
    for (const entry of [...entries.values()]) {
      if (!live(entry)) continue;
      let outcome: EditOutcome;
      // a screen that throws (an override, Rule 30) ends its own entry as drawn: a fallback screen
      // from the same catalog could throw the same way, and a retry would throw on every tick
      try {
        outcome = await runWithLanguage(entry.language, () => advance(entry, snapshot, nowMs));
      } catch (error) {
        logger.error(
          { ...errorLogFields(error), ...entryFields(entry) },
          'signal wait entry failed',
        );
        end(entry);
        continue;
      }
      if (outcome === 'paused' || stopped) break;
    }
  }

  async function advance(entry: Entry, snapshot: Snapshot, nowMs: number): Promise<EditOutcome> {
    const screens = attached();
    if (nowMs - entry.startedAt >= maxMs) return finish(entry, screens.expired());
    if (entry.kind === 'list') {
      if (entry.shownAt !== undefined) {
        return nowMs - entry.shownAt >= listTtlMs ? finish(entry, screens.expired()) : 'kept';
      }
      const { signals, catalog } = snapshot;
      if (signals === undefined || catalog === undefined) return 'kept';
      const drawn = screens.list(signals, catalog, nowMs);
      if (drawn === undefined || drawn.listed === 0) return 'kept';
      const outcome = await edit(entry, drawn.screen);
      if (outcome === 'drawn') entry.shownAt = now();
      return outcome;
    }
    const { pair } = entry;
    const { list, catalog } = snapshot;
    if (list !== undefined && catalog !== undefined) {
      const check = checkDemoTrade(catalog, pair.assetId, DEMO_DURATION_SEC, nowMs);
      if (!check.ok) return finish(entry, screens.refusal(check, catalog, nowMs));
      if (list.signals.some((signal) => signal.assetId === pair.assetId)) {
        const resolved = await resolve(entry, check.pair);
        if (resolved !== undefined) return resolved;
        if (!live(entry)) return 'ended';
      }
      if (pair.alternatives === 'pending') {
        // the pair is in the list when the analysis found no signal by its own read
        const others = list.signals.filter((signal) => signal.assetId !== pair.assetId);
        const alternatives = screens.alternatives(others, catalog, nowMs);
        if (alternatives.length === 0) {
          pair.alternatives = 'done';
          return 'kept';
        }
        const outcome = await edit(entry, screens.waiting(pair.base, alternatives));
        if (outcome === 'drawn') pair.alternatives = { shownAt: now() };
        return outcome;
      }
    }
    const { alternatives } = pair;
    if (typeof alternatives === 'object' && nowMs - alternatives.shownAt >= listTtlMs) {
      const outcome = await edit(entry, screens.waiting(pair.base, []));
      if (outcome === 'drawn') pair.alternatives = 'done';
      return outcome;
    }
    return 'kept';
  }

  // The chosen pair has a signal: the next step by a fresh access read, or for the analysis its
  // card. undefined when the analysis found no signal after all: the entry stays.
  async function resolve(
    entry: Extract<Entry, { kind: 'pair' }>,
    pairView: PairView,
  ): Promise<EditOutcome | undefined> {
    const screens = attached();
    const { pair } = entry;
    const telegramUserId = String(entry.telegramUserId);
    if (pair.origin !== 'analysis') {
      const access = await readAccess(telegramUserId);
      if (!live(entry)) return 'ended';
      return finish(
        entry,
        screens.nextStep(
          { assetId: pair.assetId, back: pair.back, firstName: pair.firstName },
          pairView,
          access,
        ),
      );
    }
    let response: TradingSignalResponse;
    try {
      response = await backend.evaluateSignal(pair.assetId, interval, {
        telegramUserId,
        durationSec: DEMO_DURATION_SEC,
      });
    } catch (error) {
      warnOnce(entry, 'signal wait analysis not evaluated', {
        ...errorLogFields(error),
        ...backendErrorFields(error),
      });
      return undefined;
    }
    if (response.outcome === SignalFeedOutcome.FetchFailed) {
      warnOnce(entry, 'signal wait analysis not evaluated', { signalCode: response.code });
      return undefined;
    }
    if (response.decision.kind !== SignalKind.Signal) return undefined;
    const access = await readAccess(telegramUserId);
    const card = screens.card(pairView, response, access);
    if (card === undefined || !live(entry)) return undefined;
    return drawCard(entry, card);
  }

  async function readAccess(telegramUserId: string): Promise<TradingAccessResponse | null> {
    try {
      return await backend.readTradingAccess(telegramUserId);
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error) },
        'trading access not read for the signal wait',
      );
      return null;
    }
  }

  // The card as a photo in place of the text (editMessageMedia, #568); a photo Telegram refuses
  // forgets its file_id and the caption goes as the text, under the same keyboard.
  async function drawCard(
    entry: Entry,
    card: { text: TelegramHtml; keyboard: BotKeyboard; action: TradeAction },
  ): Promise<EditOutcome> {
    const { photos } = attached();
    await pace();
    if (!live(entry)) return 'ended';
    try {
      const result = await editMessagePhotoByIdHtml(
        entry.api,
        entry.chatId,
        entry.messageId,
        photos.photo(card.action),
        card.text,
        { reply_markup: card.keyboard },
      );
      photos.remember(card.action, result);
      end(entry);
      return 'drawn';
    } catch (error) {
      if (error instanceof GrammyError && error.error_code !== 429 && error.error_code !== 403) {
        const refusal = editRefusal(error);
        if (refusal === 'shown') {
          end(entry);
          return 'drawn';
        }
        if (refusal !== 'gone') {
          photos.forget(card.action);
          logger.warn(
            { ...errorLogFields(error), ...telegramErrorFields(error), kind: entry.kind },
            'the signal wait card photo was refused, sending its text',
          );
          return finish(entry, { text: card.text, keyboard: card.keyboard });
        }
      }
      const outcome = refused(entry, error, 'editMessageMedia');
      if (outcome === 'ended') end(entry);
      return outcome;
    }
  }

  // an edit that ends the entry once it is on screen, or once the message is gone for good
  async function finish(entry: Entry, screen: DemoScreen): Promise<EditOutcome> {
    const outcome = await edit(entry, screen);
    if (outcome === 'drawn' || outcome === 'ended') end(entry);
    return outcome;
  }

  async function pace(): Promise<void> {
    const wait = lastEditAt + editGapMs - now();
    if (wait > 0) await sleep(wait);
    lastEditAt = now();
  }

  async function edit(entry: Entry, screen: DemoScreen): Promise<EditOutcome> {
    const key = renderKey(screen);
    if (key === entry.rendered) return 'drawn';
    await pace();
    if (!live(entry)) return 'ended';
    try {
      await editMessageTextByIdHtml(entry.api, entry.chatId, entry.messageId, screen.text, {
        reply_markup: screen.keyboard,
      });
    } catch (error) {
      const outcome = refused(entry, error, 'editMessageText');
      if (outcome === 'drawn') entry.rendered = key;
      if (outcome === 'ended') end(entry);
      return outcome;
    }
    entry.rendered = key;
    entry.editFailures = 0;
    return 'drawn';
  }

  // A refused edit, by what it means for the entry: already shown is drawn; a message gone or a
  // user who blocked the bot ends it; a 429 pauses every edit for its retry_after; any other
  // refusal or a transport failure is retried by the next ticks, editFailuresMax times; anything
  // else is a bug, logged, and ends it.
  function refused(entry: Entry, error: unknown, method: string): EditOutcome {
    const fields = {
      ...errorLogFields(error),
      ...telegramErrorFields(error, method),
      ...entryFields(entry),
    };
    if (error instanceof GrammyError) {
      const refusal = editRefusal(error);
      if (refusal === 'shown') return 'drawn';
      if (refusal === 'gone' || error.error_code === 403) {
        logger.info(fields, 'signal wait message not edited');
        return 'ended';
      }
      if (error.error_code === 429) {
        pausedUntil = now() + (error.parameters.retry_after ?? 1) * 1000;
        logger.warn(fields, 'signal wait message not edited');
        return 'paused';
      }
    } else if (!(error instanceof HttpError)) {
      logger.error(fields, 'signal wait message not edited');
      return 'ended';
    }
    entry.editFailures += 1;
    logger.warn(fields, 'signal wait message not edited');
    return entry.editFailures >= editFailuresMax ? 'ended' : 'kept';
  }

  function warnOnce(entry: Entry, message: string, fields: Record<string, unknown>): void {
    if (entry.warned.has(message)) return;
    entry.warned.add(message);
    logger.warn(fields, message);
  }

  // The stop's edits: one launched every editGapMs, none after the window or after a 429 of the
  // stop itself; a 429 of the last tick is waited out inside the window. The launched ones are
  // awaited.
  async function drainEdits(remaining: Entry[]): Promise<void> {
    const deadline = now() + shutdownBudgetMs;
    if (pausedUntil > now()) {
      if (pausedUntil >= deadline) return;
      await sleep(pausedUntil - now());
    }
    const launched: Promise<void>[] = [];
    let limited = false;
    for (const entry of remaining) {
      if (limited || now() >= deadline) break;
      launched.push(
        runWithLanguage(entry.language, async () => {
          try {
            const screen = attached().expired();
            if (renderKey(screen) === entry.rendered) return;
            await editMessageTextByIdHtml(entry.api, entry.chatId, entry.messageId, screen.text, {
              reply_markup: screen.keyboard,
            });
          } catch (error) {
            if (error instanceof GrammyError && error.error_code === 429) limited = true;
            logger.warn(
              {
                ...errorLogFields(error),
                ...telegramErrorFields(error, 'editMessageText'),
                kind: entry.kind,
              },
              'signal wait message not edited at the stop',
            );
          }
        }),
      );
      await sleep(editGapMs);
    }
    await Promise.allSettled(launched);
  }

  return {
    attach(next) {
      attachedScreens = next;
    },
    waitList(request) {
      register({
        ...request,
        kind: 'list',
        startedAt: now(),
        shownAt: request.shown ? now() : undefined,
        ...common(request.drawn),
      });
    },
    waitPair({ firstName, assetId, back, origin, base, alternatives, ...target }) {
      register({
        ...target,
        kind: 'pair',
        startedAt: now(),
        pair: {
          firstName,
          assetId,
          back,
          origin,
          base,
          alternatives: alternatives === 'shown' ? { shownAt: now() } : alternatives,
        },
        ...common(target.drawn),
      });
    },
    leave(telegramUserId) {
      const entry = entries.get(telegramUserId);
      if (entry !== undefined) end(entry);
    },
    has: (telegramUserId) => entries.has(telegramUserId),
    size: () => entries.size,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const remaining = [...entries.values()];
      entries.clear();
      await Promise.all([inflight, remaining.length > 0 ? drainEdits(remaining) : undefined]);
    },
  };
}
