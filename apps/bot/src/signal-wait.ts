import { GrammyError, HttpError, type Api } from 'grammy';
import {
  editRefusal,
  errorLogFields,
  fileRefusal,
  intervalForDuration,
  ShownSignalSource,
  SignalFeedOutcome,
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
import { shownRecordsOf, type CycleBack, type DemoScreen, type ShownSignal } from './demo';
import { createEditPacer, type EditPriority } from './edit-pacer';
import { runWithLanguage } from './language';
import type { Logger } from './logging';
import type { ScanMedia, ScanMediaKind } from './scan-media';
import {
  editMessageAnimationByIdHtml,
  editMessageCaptionByIdHtml,
  editMessagePhotoByIdHtml,
  editMessageTextByIdHtml,
} from './send';
import type { SetupCardPhotos } from './setup-card';
import type { ShownSignalRecord, ShownSignals } from './shown-signals';

// The wait for a signal (#664, docs/bot-demo.md → The wait for a signal). After the user chose a
// pair the bot never says «сигнала нет»: the screen waits, and the bot edits the same message once
// a signal comes. One entry per user, in this process's memory; any button and any command end it
// (bot.ts, beside endInputStep). One poll of GET /trading/signals and GET /trading/pairs serves
// every entry, once a second (timing.ts → SIGNAL_WAIT_POLL_MS: an H1 signal lives a second, #828),
// and a pair has a signal now when it is in the H1 scanner's list and the catalog takes the trade
// — the one definition of the list, the door `n` and the waits. The buttons of pairs stand listTtlMs (30 s),
// an entry at most maxMs. A tick decides for every entry on its reads first (decide), then runs the
// signal edits — the chosen pair's resolution, resolveConcurrency at once, and a list's first
// pairs — and after their reads the edits a TTL or a caption asks for; it does not wait for the
// edits, and an entry with one in flight is left to the next tick (#869). The edits go through one
// token bucket (edit-pacer.ts: editsPerSecond with a burst of editBurst, a chat once in chatGapMs,
// the signal edits first), and a 429 pauses them for its retry_after. stop() turns the waiting
// messages into the start of trading inside its window, one every editGapMs.
// A list, the other pairs' buttons or a card the wait drew records its directions for the start
// once the edit is on screen (#829), from the answers it read.
// The wait is a media message (#859, Rule 58): the scanner's animation under a caption that prints
// the poll's scanner summary, redrawn at most once in captionMs, after the tick's edits that end
// waits and at most captionEditsPerTick a tick; whatever ends the wait — a list, the next step, a
// refusal, the expiry, the stop, the user leaving — turns it into the still in one edit. A message
// the handler had to draw as text (the animation refused) stays text.

type WaitApi = Pick<Api, 'editMessageText' | 'editMessageMedia' | 'editMessageCaption'>;

// what the message is now: a text, the scanner's animation, or its still under a caption
export type WaitMedia = 'text' | ScanMediaKind;

// where the wait for a pair started: the pair's door drawn without a signal (`demo:l…:n`), the
// analysis without an H1 signal
export type WaitOrigin = 'door' | 'analysis';

// the other pairs' buttons under the wait for a pair: to be drawn by the first poll, the ones the
// handler drew, or gone for good
export type WaitAlternatives = 'pending' | readonly ShownSignal[] | 'done';

interface WaitTarget {
  api: WaitApi;
  chatId: number;
  messageId: number;
  telegramUserId: number;
  // the user's language (#508): the edits run outside any update
  language: BotLanguage;
  // what the message shows now, the render key's start
  drawn: DemoScreen;
  media: WaitMedia;
  // the drawn screen holds the scanner's lines: its caption is redrawn captionMs after the
  // registration, else on the first poll (#859)
  scanned: boolean;
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

// the poll's list and catalog, for the scanner's lines of a pair's wait (#859)
export interface PairScan {
  list: TradingSignalsResponse['lists'][number];
  pair: PairView;
}

// What the waits draw, demo.ts's screens (createSignalWaitScreens). Every call runs in the entry's
// language.
export interface SignalWaitScreens {
  // the signals screen, how many pairs it lists and their buttons, the scanner's caption without a
  // pair; undefined without the demo's list
  list(
    signals: TradingSignalsResponse,
    catalog: PairsCatalogResponse,
    nowMs: number,
  ): { screen: DemoScreen; listed: number; shown: ShownSignal[] } | undefined;
  // the start of trading: the list expired, the bound, the stop
  expired(): DemoScreen;
  // the wait for a pair, with the scanner's lines when the poll read them and the other pairs'
  // buttons when there are some
  waiting(
    base: TelegramHtml,
    alternatives: readonly ShownSignal[],
    scan: PairScan | undefined,
  ): DemoScreen;
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
  // the analysis's card on an H1 signal (#482, #828); undefined without one
  card(
    pair: PairView,
    response: TradingSignalResponse,
    access: TradingAccessResponse | null,
  ): { text: TelegramHtml; keyboard: BotKeyboard; action: TradeAction } | undefined;
  photos: Pick<SetupCardPhotos, 'photo' | 'remember' | 'forget'>;
  media: ScanMedia;
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
  // the directions the wait drew (#829), taken by the start
  shownSignals: Pick<ShownSignals, 'remember'>;
  pollMs: number;
  pollOffsetMs: number;
  listTtlMs: number;
  maxMs: number;
  // the stop's edits, one every editGapMs
  editGapMs: number;
  // the tick's and the freezes' edits (#869, edit-pacer.ts)
  editsPerSecond: number;
  editBurst: number;
  chatGapMs: number;
  // the signal edits' reads in flight at once
  resolveConcurrency: number;
  // the scanner's caption (#859): at most once in captionMs an entry, captionEditsPerTick a tick
  captionMs: number;
  captionEditsPerTick: number;
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
        // the drawn buttons stand while shown, so a caption redraw keeps the same snapshot
        alternatives: 'pending' | 'done' | { shownAt: number; shown: readonly ShownSignal[] };
      };
    } & Common);

interface Common {
  // an edit of the entry is launched and not finished: the next ticks leave the entry alone
  busy: boolean;
  // the launched edit while it runs, and whether it got its slot in the pace and has sent or is
  // sending: the stop's drain draws such an entry only after it, unless it drew the final screen
  edit: Promise<void> | undefined;
  slotted: boolean;
  final: boolean;
  rendered: string;
  // when the screen was last drawn or its caption last tried
  captionAt: number;
  editFailures: number;
  // the warn lines already written for this entry
  warned: Set<string>;
}

// The whole screen and its media: the alternatives' removal changes only the keyboard, the list's
// first pairs only the buttons when two texts are equal (overrides), the end of a wait only the
// media when its caption stays.
export const renderKey = (screen: DemoScreen, media: WaitMedia): string =>
  `${media}\n${screen.text.value}\n${JSON.stringify(screen.keyboard.inline_keyboard)}`;

// the reads of one tick: the demo's list and the catalog, undefined where a read failed
interface Snapshot {
  signals: TradingSignalsResponse | undefined;
  list: TradingSignalsResponse['lists'][number] | undefined;
  catalog: PairsCatalogResponse | undefined;
}

type EditOutcome = 'drawn' | 'ended' | 'paused' | 'kept';

type PairEntry = Extract<Entry, { kind: 'pair' }>;

// What a tick does with an entry, decided on its reads before any await: an edit that ends it, a
// list's first pairs, the chosen pair's signal, the other pairs' buttons drawn or taken down, or
// nothing.
type Decision =
  | { kind: 'finish'; screen: DemoScreen }
  | { kind: 'list'; screen: DemoScreen; shown: ShownSignal[] }
  | { kind: 'signal'; pair: PairView }
  | { kind: 'alternatives'; screen: DemoScreen; shown: ShownSignal[] }
  | { kind: 'alternatives-expired'; screen: DemoScreen }
  | { kind: 'kept' };

const KEPT: Decision = { kind: 'kept' };

// the signal edits go first, and only the chosen pair's resolution reads the backend
const priorityOf = (decision: Decision): EditPriority =>
  decision.kind === 'list' || decision.kind === 'signal' ? 'signal' : 'housekeeping';

export function createSignalWaiter({
  backend,
  logger,
  shownSignals,
  pollMs,
  pollOffsetMs,
  listTtlMs,
  maxMs,
  editGapMs,
  editsPerSecond,
  editBurst,
  chatGapMs,
  resolveConcurrency,
  captionMs,
  captionEditsPerTick,
  editFailuresMax,
  shutdownBudgetMs,
  maxEntries = SIGNAL_WAIT_MAX_ENTRIES,
  now = Date.now,
}: SignalWaiterOptions): SignalWaiter {
  const entries = new Map<number, Entry>();
  // the waits the users left on the animation whose still has not gone yet, frozen one at a time
  const leaving = new Set<Entry>();
  let freezing: Promise<void> = Promise.resolve();
  let attachedScreens: SignalWaitScreens | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | undefined;
  // the entries' edits launched by the ticks and not finished
  const launched = new Set<Promise<void>>();
  let stopped = false;
  let readsFailing = false;
  const pacer = createEditPacer({ editsPerSecond, burst: editBurst, chatGapMs, now });
  // the signal edits' reads in flight, at most resolveConcurrency
  let reading = 0;
  const readers: (() => void)[] = [];
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
    // a tick that finds the previous one's reads in flight is skipped: its entries are counted
    // again on the next snapshot
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

  function common({ drawn, media, scanned }: WaitTarget): Common {
    return {
      busy: false,
      edit: undefined,
      slotted: false,
      final: false,
      rendered: renderKey(drawn, media),
      captionAt: scanned ? now() : Number.NEGATIVE_INFINITY,
      editFailures: 0,
      warned: new Set(),
    };
  }

  // a screen that ends the wait shows the still; a waiting one keeps the entry's media. A text
  // stays a text.
  const endMedia = (entry: Entry): WaitMedia => (entry.media === 'text' ? 'text' : 'still');

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
    if (now() < pacer.pausedUntil()) return;
    const snapshot = await readSnapshot();
    const nowMs = now();
    const decided: { entry: Entry; decision: Decision }[] = [];
    for (const entry of [...entries.values()]) {
      if (!live(entry) || entry.busy) continue;
      // a screen that throws (an override, Rule 30) ends its own entry as drawn: a fallback screen
      // from the same catalog could throw the same way, and a retry would throw on every tick
      try {
        const decision = runWithLanguage(entry.language, () => decide(entry, snapshot, nowMs));
        if (decision.kind !== 'kept') decided.push({ entry, decision });
      } catch (error) {
        failed(entry, error);
      }
    }
    const signalReads = decided
      .filter(({ decision }) => priorityOf(decision) === 'signal')
      .map(({ entry, decision }) =>
        launch(entry, 'signal', decision.kind === 'signal', () =>
          apply(entry, decision, snapshot, nowMs),
        ),
      );
    // the housekeeping edits ask for their slots once the signal edits have asked for theirs
    await Promise.all(signalReads);
    for (const { entry, decision } of decided) {
      if (priorityOf(decision) === 'signal' || !live(entry)) continue;
      void launch(entry, 'housekeeping', false, () => apply(entry, decision, snapshot, nowMs));
    }
    refreshCaptions(snapshot, nowMs);
  }

  function failed(entry: Entry, error: unknown): void {
    logger.error({ ...errorLogFields(error), ...entryFields(entry) }, 'signal wait entry failed');
    end(entry);
  }

  // One edit of an entry outside the tick: the entry busy until it ends; for the signal edits a
  // read slot taken (`reads`) until the edit asks for its slot in the pace or ends. Resolves once
  // the reads are done; the edit itself is awaited by stop().
  function launch(
    entry: Entry,
    priority: EditPriority,
    reads: boolean,
    work: () => Promise<EditOutcome>,
  ): Promise<void> {
    entry.busy = true;
    let readsEnded = (): void => undefined;
    const readsDone = new Promise<void>((resolve) => {
      readsEnded = resolve;
    });
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (reads) {
        reading -= 1;
        readers.shift()?.();
      }
      readsEnded();
    };
    gates.set(entry, { priority, reached: release });
    const task: Promise<void> = (async () => {
      if (reads) {
        await readSlot();
        if (!live(entry)) return;
      }
      try {
        await runWithLanguage(entry.language, work);
      } catch (error) {
        failed(entry, error);
      }
    })().finally(() => {
      release();
      entry.busy = false;
      entry.edit = undefined;
      entry.slotted = false;
      gates.delete(entry);
      launched.delete(task);
    });
    entry.edit = task;
    launched.add(task);
    return readsDone;
  }

  // the gate of each launched edit: its priority in the pace, and the end of its reads
  const gates = new Map<Entry, { priority: EditPriority; reached: () => void }>();

  function readSlot(): Promise<void> {
    if (reading < resolveConcurrency) {
      reading += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      readers.push(() => {
        reading += 1;
        resolve();
      });
    });
  }

  // The scanner's caption, the last of a tick (#859): the waits not redrawn for captionMs and not
  // being edited, the longest waiting first, at most captionEditsPerTick.
  function refreshCaptions(snapshot: Snapshot, nowMs: number): void {
    const due = [...entries.values()]
      .filter(
        (entry) =>
          live(entry) && !entry.busy && waiting(entry) && nowMs - entry.captionAt >= captionMs,
      )
      .sort((a, b) => a.captionAt - b.captionAt)
      .slice(0, captionEditsPerTick);
    for (const entry of due) {
      void launch(entry, 'housekeeping', false, () => redraw(entry, snapshot, nowMs));
    }
  }

  // still waiting: a list without its pairs, or a pair
  const waiting = (entry: Entry) => entry.kind === 'pair' || entry.shownAt === undefined;

  // the waiting screen again, from this tick's reads; nothing to print without them
  async function redraw(entry: Entry, snapshot: Snapshot, nowMs: number): Promise<EditOutcome> {
    const { signals, list, catalog } = snapshot;
    if (signals === undefined || list === undefined || catalog === undefined) return 'kept';
    entry.captionAt = now();
    const screens = attached();
    if (entry.kind === 'list') {
      const drawn = screens.list(signals, catalog, nowMs);
      if (drawn === undefined || drawn.listed > 0) return 'kept';
      return edit(entry, drawn.screen, entry.media);
    }
    const check = checkDemoTrade(catalog, entry.pair.assetId, DEMO_DURATION_SEC, nowMs);
    if (!check.ok) return 'kept';
    return edit(
      entry,
      screens.waiting(entry.pair.base, shownAlternatives(entry), { list, pair: check.pair }),
      entry.media,
    );
  }

  const shownAlternatives = (entry: Extract<Entry, { kind: 'pair' }>): readonly ShownSignal[] =>
    typeof entry.pair.alternatives === 'object' ? entry.pair.alternatives.shown : [];

  function decide(entry: Entry, snapshot: Snapshot, nowMs: number): Decision {
    const screens = attached();
    if (nowMs - entry.startedAt >= maxMs) return { kind: 'finish', screen: screens.expired() };
    if (entry.kind === 'list') {
      if (entry.shownAt !== undefined) {
        return nowMs - entry.shownAt >= listTtlMs
          ? { kind: 'finish', screen: screens.expired() }
          : KEPT;
      }
      const { signals, catalog } = snapshot;
      if (signals === undefined || catalog === undefined) return KEPT;
      const drawn = screens.list(signals, catalog, nowMs);
      if (drawn === undefined || drawn.listed === 0) return KEPT;
      return { kind: 'list', screen: drawn.screen, shown: drawn.shown };
    }
    const { list, catalog } = snapshot;
    if (list !== undefined && catalog !== undefined) {
      const check = checkDemoTrade(catalog, entry.pair.assetId, DEMO_DURATION_SEC, nowMs);
      if (!check.ok) return { kind: 'finish', screen: screens.refusal(check, catalog, nowMs) };
      if (list.signals.some((signal) => signal.assetId === entry.pair.assetId)) {
        return { kind: 'signal', pair: check.pair };
      }
    }
    return decideAlternatives(entry, snapshot, nowMs);
  }

  // the other pairs' buttons of a pair's wait: drawn by the first poll that has some, taken down
  // listTtlMs after they were drawn
  function decideAlternatives(entry: PairEntry, snapshot: Snapshot, nowMs: number): Decision {
    const screens = attached();
    const { pair } = entry;
    const { list, catalog } = snapshot;
    const check =
      list === undefined || catalog === undefined
        ? undefined
        : checkDemoTrade(catalog, pair.assetId, DEMO_DURATION_SEC, nowMs);
    const scan = list !== undefined && check?.ok === true ? { list, pair: check.pair } : undefined;
    if (pair.alternatives === 'pending' && list !== undefined && catalog !== undefined) {
      if (scan === undefined) return KEPT;
      // the pair is in the list when the analysis found no signal by its own read
      const others = list.signals.filter((signal) => signal.assetId !== pair.assetId);
      const alternatives = screens.alternatives(others, catalog, nowMs);
      if (alternatives.length === 0) {
        pair.alternatives = 'done';
        return KEPT;
      }
      return {
        kind: 'alternatives',
        screen: screens.waiting(pair.base, alternatives, scan),
        shown: alternatives,
      };
    }
    const { alternatives } = pair;
    if (typeof alternatives === 'object' && nowMs - alternatives.shownAt >= listTtlMs) {
      return { kind: 'alternatives-expired', screen: screens.waiting(pair.base, [], scan) };
    }
    return KEPT;
  }

  async function apply(
    entry: Entry,
    decision: Decision,
    snapshot: Snapshot,
    nowMs: number,
  ): Promise<EditOutcome> {
    switch (decision.kind) {
      case 'finish':
        return finish(entry, decision.screen);
      case 'list': {
        const outcome = await edit(entry, decision.screen, endMedia(entry));
        if (outcome === 'drawn' && entry.kind === 'list') {
          entry.shownAt = now();
          remember(entry, ShownSignalSource.List, shownRecordsOf(decision.shown));
        }
        return outcome;
      }
      case 'signal': {
        if (entry.kind !== 'pair') return 'kept';
        const resolved = await resolve(entry, decision.pair);
        if (resolved !== undefined) return resolved;
        if (!live(entry)) return 'ended';
        return apply(entry, decideAlternatives(entry, snapshot, nowMs), snapshot, nowMs);
      }
      case 'alternatives': {
        const outcome = await edit(entry, decision.screen, entry.media);
        if (outcome === 'drawn' && entry.kind === 'pair') {
          entry.pair.alternatives = { shownAt: now(), shown: decision.shown };
          remember(entry, ShownSignalSource.List, shownRecordsOf(decision.shown));
        }
        return outcome;
      }
      case 'alternatives-expired': {
        const outcome = await edit(entry, decision.screen, entry.media);
        if (outcome === 'drawn' && entry.kind === 'pair') entry.pair.alternatives = 'done';
        return outcome;
      }
      case 'kept':
        return 'kept';
    }
  }

  // The chosen pair has a signal: the next step by a fresh access read, or for the analysis its
  // card. undefined when the analysis's answer has no H1 signal after all (a second boundary
  // crossed between the two reads): the entry stays.
  async function resolve(entry: PairEntry, pairView: PairView): Promise<EditOutcome | undefined> {
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
    }
    const { h1 } = response;
    if (h1 === null) return undefined;
    const access = await readAccess(telegramUserId);
    const card = screens.card(pairView, response, access);
    if (card === undefined || !live(entry)) return undefined;
    const outcome = await drawCard(entry, card);
    // the card's direction is the answer's h1, as the analysis draws it
    if (outcome === 'drawn') {
      remember(entry, ShownSignalSource.Analysis, [
        { assetId: pair.assetId, action: h1.action, second: h1.second, decidedAt: h1.decidedAt },
      ]);
    }
    return outcome;
  }

  function remember(
    entry: Entry,
    source: ShownSignalSource,
    records: readonly ShownSignalRecord[],
  ): void {
    shownSignals.remember(entry.telegramUserId, source, now(), records);
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
    const gated = await gate(entry);
    if (gated !== undefined) return gated;
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
      entry.final = true;
      end(entry);
      return 'drawn';
    } catch (error) {
      if (error instanceof GrammyError && editRefusal(error) === 'shown') {
        entry.final = true;
        end(entry);
        return 'drawn';
      }
      if (error instanceof GrammyError && fileRefusal(error)) {
        photos.forget(card.action);
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error), kind: entry.kind },
          'the signal wait card photo was refused, sending its text',
        );
        return finish(entry, { text: card.text, keyboard: card.keyboard });
      }
      const outcome = refused(entry, error, 'editMessageMedia');
      if (outcome === 'ended') end(entry);
      return outcome;
    }
  }

  // an edit that ends the entry once it is on screen, or once the message is gone for good; the
  // still unless `media` says otherwise
  async function finish(
    entry: Entry,
    screen: DemoScreen,
    media: WaitMedia = endMedia(entry),
  ): Promise<EditOutcome> {
    const outcome = await edit(entry, screen, media);
    if (outcome === 'drawn') entry.final = true;
    if (outcome === 'drawn' || outcome === 'ended') end(entry);
    return outcome;
  }

  // Before every edit of the wait: its slot in the pace, at its launch's priority (the end of the
  // launch's reads), then the entry still to be edited. A 429's pause is waited out inside the
  // pace; the stop closes it, and a waiting edit ends unsent.
  async function gate(entry: Entry): Promise<'ended' | undefined> {
    const launch = gates.get(entry);
    launch?.reached();
    const slot = await pacer.take(entry.chatId, launch?.priority ?? 'housekeeping', () =>
      live(entry),
    );
    if (slot !== 'slot' || !live(entry)) return 'ended';
    entry.slotted = true;
    return undefined;
  }

  function pauseFor(error: GrammyError): void {
    pacer.pause(now() + (error.parameters.retry_after ?? 1) * 1000);
  }

  // One edit of the message into `screen` as `media` (#859): a text as a text; the same media its
  // caption; another media the media itself, with the caption (methodOf names it for the log).
  async function send(entry: WaitTarget, screen: DemoScreen, media: WaitMedia): Promise<void> {
    const { api, chatId, messageId } = entry;
    const extra = { reply_markup: screen.keyboard };
    if (media === 'text') {
      await editMessageTextByIdHtml(api, chatId, messageId, screen.text, extra);
      return;
    }
    if (media === entry.media) {
      await editMessageCaptionByIdHtml(api, chatId, messageId, screen.text, extra);
      return;
    }
    const files = attached().media;
    const file = files.file(media);
    const result =
      media === 'animation'
        ? await editMessageAnimationByIdHtml(api, chatId, messageId, file, screen.text, extra)
        : await editMessagePhotoByIdHtml(api, chatId, messageId, file, screen.text, extra);
    files.remember(media, result);
  }

  // A media edit refused for the file (not gone, shown, a 403 or a 429: a bad file, a stale
  // file_id) forgets the id and draws the same screen without changing the media, once (#859).
  async function edit(entry: Entry, screen: DemoScreen, media: WaitMedia): Promise<EditOutcome> {
    const key = renderKey(screen, media);
    if (key === entry.rendered) return 'drawn';
    const gated = await gate(entry);
    if (gated !== undefined) return gated;
    let drawnAs = media;
    try {
      try {
        await send(entry, screen, media);
      } catch (error) {
        if (media === 'text' || !mediaRefused(entry, media, error)) throw error;
        attached().media.forget(media);
        logger.warn(
          { ...errorLogFields(error), ...telegramErrorFields(error), ...entryFields(entry) },
          'the scan media was refused, editing the caption',
        );
        const again = await gate(entry);
        if (again !== undefined) return again;
        drawnAs = entry.media;
        await send(entry, screen, drawnAs);
      }
    } catch (error) {
      const outcome = refused(entry, error, methodOf(entry, drawnAs));
      if (outcome === 'drawn') markDrawn(entry, renderKey(screen, drawnAs), drawnAs);
      if (outcome === 'ended') end(entry);
      return outcome;
    }
    markDrawn(entry, renderKey(screen, drawnAs), drawnAs);
    entry.editFailures = 0;
    return 'drawn';
  }

  const mediaRefused = (entry: Entry, media: ScanMediaKind, error: unknown): boolean =>
    media !== entry.media && error instanceof GrammyError && fileRefusal(error);

  function markDrawn(entry: Entry, key: string, media: WaitMedia): void {
    entry.rendered = key;
    entry.media = media;
    entry.captionAt = now();
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
        pauseFor(error);
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

  // The stop's edits: one launched every editGapMs, none after the window or inside a 429's pause
  // taken by the stop itself or by a freeze in flight; a 429 of the last tick is waited out inside
  // the window. The launched ones are awaited. An entry whose edit got its slot before the stop is
  // decided once that edit ends: skipped if it drew the final screen, else drawn as the others,
  // the window and the pause checked after the wait.
  async function drainEdits(remaining: Entry[]): Promise<void> {
    const deadline = now() + shutdownBudgetMs;
    if (pacer.pausedUntil() > now()) {
      if (pacer.pausedUntil() >= deadline) return;
      await sleep(pacer.pausedUntil() - now());
    }
    const sent: Promise<void>[] = [];
    for (const entry of remaining) {
      if (now() >= deadline || now() < pacer.pausedUntil()) break;
      sent.push(
        runWithLanguage(entry.language, async () => {
          if (entry.slotted) {
            await entry.edit;
            if (now() >= deadline || now() < pacer.pausedUntil()) return;
          }
          if (entry.final) return;
          try {
            const screen = attached().expired();
            const media = endMedia(entry);
            if (renderKey(screen, media) === entry.rendered) return;
            await send(entry, screen, media);
          } catch (error) {
            if (error instanceof GrammyError && error.error_code === 429) pauseFor(error);
            logger.warn(
              {
                ...errorLogFields(error),
                ...telegramErrorFields(error, methodOf(entry, endMedia(entry))),
                kind: entry.kind,
              },
              'signal wait message not edited at the stop',
            );
          }
        }),
      );
      await sleep(editGapMs);
    }
    await Promise.allSettled(sent);
  }

  const methodOf = (entry: WaitTarget, media: WaitMedia): string =>
    media === 'text'
      ? 'editMessageText'
      : media === entry.media
        ? 'editMessageCaption'
        : 'editMessageMedia';

  // The user left a wait on screen (a button, a command): its animation would loop on in the chat
  // with stale figures, so it becomes the still with the start of trading, one edit (#859). The
  // freezes go one at a time outside the tick, through the edits' shared pace at the housekeeping
  // priority, none in a 429's pause: a pause is waited out, a 429 of the freeze itself waits its
  // retry_after and tries again, another refusal is not retried. stop() closes the pace and takes
  // the queued ones into its drain.
  async function freeze(entry: Entry): Promise<void> {
    while (!stopped && leaving.has(entry)) {
      const slot = await pacer.take(
        entry.chatId,
        'housekeeping',
        () => !stopped && leaving.has(entry),
      );
      if (slot !== 'slot' || stopped || !leaving.has(entry)) return;
      leaving.delete(entry);
      await runWithLanguage(entry.language, () => sendStill(entry));
    }
  }

  // the freeze's edit; a 429 puts the entry back into the queue unless the stop came
  async function sendStill(entry: Entry): Promise<void> {
    const screen = attached().expired();
    if (renderKey(screen, 'still') === entry.rendered) return;
    try {
      await send(entry, screen, 'still');
    } catch (error) {
      const fields = {
        ...errorLogFields(error),
        ...telegramErrorFields(error, 'editMessageMedia'),
        ...entryFields(entry),
      };
      if (error instanceof GrammyError) {
        if (error.error_code === 429) {
          pauseFor(error);
          logger.warn(fields, 'signal wait message not frozen');
          if (!stopped) leaving.add(entry);
          return;
        }
        if (editRefusal(error) !== undefined || error.error_code === 403) {
          logger.info(fields, 'signal wait message not frozen');
          return;
        }
        if (fileRefusal(error)) attached().media.forget('still');
      }
      logger.warn(fields, 'signal wait message not frozen');
    }
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
        ...common(request),
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
          alternatives:
            typeof alternatives === 'object'
              ? { shownAt: now(), shown: alternatives }
              : alternatives,
        },
        ...common(target),
      });
    },
    leave(telegramUserId) {
      const entry = entries.get(telegramUserId);
      if (entry === undefined) return;
      end(entry);
      if (entry.media !== 'animation' || stopped) return;
      leaving.add(entry);
      freezing = freezing
        .then(() => freeze(entry))
        .catch((error: unknown) => {
          logger.error(errorLogFields(error), 'signal wait freeze failed');
        });
    },
    has: (telegramUserId) => entries.has(telegramUserId),
    size: () => entries.size,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pacer.close();
      const remaining = [...entries.values(), ...leaving];
      entries.clear();
      leaving.clear();
      await Promise.all([
        inflight,
        ...launched,
        remaining.length > 0 ? drainEdits(remaining) : undefined,
        freezing,
      ]);
    },
  };
}
