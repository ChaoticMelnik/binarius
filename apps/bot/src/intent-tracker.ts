import { GrammyError, HttpError } from 'grammy';
import {
  errorLogFields,
  TRADE_INTENT_TRANSITIONS,
  TradeIntentStatus,
  type TelegramHtml,
  type TradeIntentFailureReason,
  type TradeIntentView,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import { telegramErrorFields, type Logger } from './logging';
import { editRefusal } from './screen';
import { intentStatusText, TEXTS } from './texts';

// The demo trade's status message follows its intent (#127, docs/bot-demo-trade.md): after the
// stake press the bot polls GET /trading/intents/:id and edits the message as the status moves.
// In-process memory by the owner's decision, like the login dialog: a restart leaves each message
// at its last state, and its «🔄 Обновить статус» button is the recovery.

// The answer GET /trading/intents/:id gives for an id that is missing or not this user's.
export const INTENT_NOT_FOUND = 'not_found';

// The terminal statuses — no outgoing edge in the shared graph, the derivation of
// TERMINAL_TRADE_INTENT_STATUSES in packages/db — plus accepted, where this issue's interest ends:
// the trade's close and result are #90/#101/#29.
export const TRACKER_STOP_STATUSES: ReadonlySet<TradeIntentStatus> = new Set([
  ...Object.values(TradeIntentStatus).filter(
    (status) => TRADE_INTENT_TRANSITIONS[status].length === 0,
  ),
  TradeIntentStatus.Accepted,
]);

// the login dialog's bound: the oldest entry goes first, its message keeping the refresh button
export const INTENT_TRACKER_MAX_ENTRIES = 10_000;

// Why the tracker's last edit is not a status (#350): the intent is gone (nothing left to read, so
// only the menu), or the deadline passed on a status that can still move (its refresh and the
// menu).
export type TrackEnd = 'not_found' | 'deadline';

export interface IntentTrackRequest {
  intentId: string;
  telegramUserId: string;
  // the pair's symbol as the catalog spelled it at the press
  symbol: string;
  // what the message shows now
  view: TradeIntentView;
  // edits the status message; the keyboard follows the view (#350: the end of the path once
  // tracking stops), or `end` when the tracker gives up on it
  edit: (text: TelegramHtml, view: TradeIntentView, end?: TrackEnd) => Promise<unknown>;
}

export interface IntentTracker {
  // a no-op for an id already tracked, and after stop()
  track(request: IntentTrackRequest): void;
  // clears every timer, refuses new entries, and waits for the attempts in flight
  stop(): Promise<void>;
  size(): number;
}

export interface IntentTrackerOptions {
  backend: Pick<BackendClient, 'readIntent'>;
  logger: Logger;
  firstPollMs: number;
  pollMs: number;
  deadlineMs: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry extends IntentTrackRequest {
  startedAt: number;
  // the status (and for rejected the reason) on screen
  rendered: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  readFailures: number;
  editFailures: number;
}

const renderKey = ({
  status,
  lastError,
}: {
  status: TradeIntentStatus;
  lastError: TradeIntentFailureReason | null;
}): string => (status === TradeIntentStatus.Rejected ? `${status}:${String(lastError)}` : status);

export function createIntentTracker({
  backend,
  logger,
  firstPollMs,
  pollMs,
  deadlineMs,
  maxEntries = INTENT_TRACKER_MAX_ENTRIES,
  now = Date.now,
}: IntentTrackerOptions): IntentTracker {
  const entries = new Map<string, Entry>();
  // every attempt under way, an evicted entry's included, so stop() waits for all of them
  const inFlight = new Set<Promise<void>>();
  let stopping = false;

  const live = (entry: Entry): boolean => !stopping && entries.get(entry.intentId) === entry;

  const finish = (entry: Entry): void => {
    clearTimeout(entry.timer);
    if (entries.get(entry.intentId) === entry) entries.delete(entry.intentId);
  };

  const arm = (entry: Entry, delayMs: number): void => {
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      // the row «anything thrown → error, stop» holds for the whole attempt, not only around the
      // read and the edit, so a run always resolves and stop() always drains
      const run = attempt(entry)
        .catch((error: unknown) => {
          logger.error(
            { ...errorLogFields(error), intentId: entry.intentId },
            'trade intent tracking failed',
          );
          finish(entry);
        })
        .finally(() => {
          inFlight.delete(run);
        });
      inFlight.add(run);
    }, delayMs);
  };

  // Every way an edit ends: shown or edited is rendered; gone stops the entry (the user deleted
  // the message); any other refusal or a transport failure is retried on the next poll, until the
  // deadline, since the status is not recorded as rendered — logged once per entry, the later
  // ones only counted; anything else is a bug and stops the entry.
  async function editTo(
    entry: Entry,
    text: TelegramHtml,
    key: string,
    end?: TrackEnd,
  ): Promise<boolean> {
    try {
      await entry.edit(text, entry.view, end);
      entry.rendered = key;
      return true;
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') {
        entry.rendered = key;
        return true;
      }
      if (error instanceof GrammyError || error instanceof HttpError) {
        if (refusal === 'gone' || entry.editFailures === 0) {
          logger.warn(
            {
              ...errorLogFields(error),
              ...telegramErrorFields(error, 'editMessageText'),
              intentId: entry.intentId,
            },
            'trade intent message not edited',
          );
        }
        entry.editFailures += 1;
        if (refusal === 'gone') finish(entry);
        return refusal !== 'gone';
      }
      logger.error(
        { ...errorLogFields(error), intentId: entry.intentId },
        'trade intent tracking failed',
      );
      finish(entry);
      return false;
    }
  }

  async function attempt(entry: Entry): Promise<void> {
    let view: TradeIntentView;
    try {
      view = await backend.readIntent(entry.intentId, entry.telegramUserId);
    } catch (error) {
      if (!(error instanceof BackendError)) {
        logger.error(
          { ...errorLogFields(error), intentId: entry.intentId },
          'trade intent tracking failed',
        );
        finish(entry);
        return;
      }
      const notFound =
        error.code === BackendErrorCode.HttpStatus && error.reason === INTENT_NOT_FOUND;
      // a missing or foreign id stops the entry: polling cannot fix it. Any other failure is
      // logged once per entry and retried until the deadline.
      if (notFound || entry.readFailures === 0) {
        logger.warn(
          { ...errorLogFields(error), ...backendErrorFields(error), intentId: entry.intentId },
          'trade intent status not read',
        );
      }
      entry.readFailures += 1;
      if (notFound) {
        // not retried: polling cannot fix a missing or foreign id; a failed edit leaves the last
        // real status on screen, and the refresh button answers the same on its own
        await editTo(entry, TEXTS.intentStatusUnavailable, INTENT_NOT_FOUND, 'not_found');
        finish(entry);
        return;
      }
      await next(entry);
      return;
    }
    // An entry evicted or finished while its read was in flight renders nothing. During stop()
    // the attempt in flight still renders what it read: stop() waits for exactly that, so the
    // message does not lag behind the poll that was paid for.
    if (!live(entry) && !stopping) return;
    entry.view = view;
    const key = renderKey(view);
    if (key !== entry.rendered) {
      const goOn = await editTo(entry, intentStatusText(entry.symbol, view), key);
      if (!goOn) return;
    }
    // a stop status ends the entry only once its edit has landed; otherwise the next poll
    // edits it again
    if (TRACKER_STOP_STATUSES.has(view.status) && entry.rendered === key) {
      finish(entry);
      return;
    }
    await next(entry);
  }

  // Re-arm, or past the deadline one last edit and stop. The deadline is the bound that ends
  // every entry, landed or not — an edit the chat always refuses (a 403 once the user blocked the
  // bot) would otherwise be retried for ever — so this edit is the one not retried: the hint for
  // a live status, the status itself for a stop status whose edit never landed.
  async function next(entry: Entry): Promise<void> {
    if (!live(entry)) return;
    if (now() - entry.startedAt < deadlineMs) {
      arm(entry, pollMs);
      return;
    }
    const stopped = TRACKER_STOP_STATUSES.has(entry.view.status);
    await editTo(
      entry,
      intentStatusText(entry.symbol, entry.view, stopped ? {} : { deadline: true }),
      stopped ? renderKey(entry.view) : 'deadline',
      stopped ? undefined : 'deadline',
    );
    finish(entry);
  }

  return {
    track(request) {
      if (stopping || entries.has(request.intentId)) return;
      if (entries.size >= maxEntries) {
        const oldest = entries.values().next().value;
        if (oldest !== undefined) finish(oldest);
      }
      const entry: Entry = {
        ...request,
        startedAt: now(),
        rendered: renderKey(request.view),
        timer: undefined,
        readFailures: 0,
        editFailures: 0,
      };
      entries.set(request.intentId, entry);
      arm(entry, firstPollMs);
    },
    async stop() {
      stopping = true;
      for (const entry of entries.values()) clearTimeout(entry.timer);
      await Promise.all(inFlight);
      entries.clear();
    },
    size: () => entries.size,
  };
}
