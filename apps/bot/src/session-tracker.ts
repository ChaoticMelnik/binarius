import { GrammyError, HttpError } from 'grammy';
import {
  errorLogFields,
  TradingSessionStatus,
  type TelegramHtml,
  type TradingSessionView,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import { telegramErrorFields, type Logger } from './logging';
import { editRefusal } from './screen';
import { sessionIntentLive, sessionStatusText, TEXTS } from './texts';

// The demo session's status message follows its session (#284, docs/bot-session.md): the bot
// polls GET /trading/sessions/:id and edits the message as the session moves. In-process memory,
// like the intent tracker: a restart leaves each message at its last state, and its «🔄 Обновить»
// is the recovery — a refresh of a live session tracks it again on that message.

// The answer GET /trading/sessions/:id gives for an id that is missing or not this user's.
export const SESSION_NOT_FOUND = 'not_found';

// the intent tracker's bound: the oldest entry goes first, its message keeping the refresh button
const SESSION_TRACKER_MAX_ENTRIES = 10_000;

// Where following a session ends: stopped, and its last trade can no longer move the counters. A
// stopped session whose trade is still open is followed until that trade settles; a last trade in
// manual_review has edges left, so such an entry runs to the deadline.
export const sessionTrackingDone = (view: Pick<TradingSessionView, 'status' | 'lastIntent'>) =>
  view.status === TradingSessionStatus.Stopped && !sessionIntentLive(view.lastIntent);

export interface SessionTrackRequest {
  sessionId: string;
  telegramUserId: string;
  // the pair's symbol as the catalog spelled it at the press, or null
  symbol: string | null;
  // what the message shows now
  view: TradingSessionView;
  // edits the status message; the keyboard follows the view (no stop button once it stopped)
  edit: (text: TelegramHtml, view: TradingSessionView) => Promise<unknown>;
}

export interface SessionTracker {
  // An id already tracked moves to the new message: the next change is drawn there and the old
  // message is not edited again, but for an attempt already in flight, which keeps the target it
  // started with. The deadline keeps counting from the first track. A no-op after stop().
  track(request: SessionTrackRequest): void;
  // clears every timer, refuses new entries, and waits for the attempts in flight
  stop(): Promise<void>;
  size(): number;
}

export interface SessionTrackerOptions {
  backend: Pick<BackendClient, 'readSession'>;
  logger: Logger;
  firstPollMs: number;
  pollMs: number;
  deadlineMs: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry extends SessionTrackRequest {
  startedAt: number;
  // what is on screen, as renderKey spells it
  rendered: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  readFailures: number;
  editFailures: number;
}

// Every field the message prints from the view; the edit happens only when one of them changes.
const renderKey = ({ status, stopReason, trades, lastIntent }: TradingSessionView): string =>
  [
    status,
    stopReason,
    trades.planned,
    trades.settled,
    trades.won,
    trades.lost,
    trades.tied,
    lastIntent?.id,
    lastIntent?.status,
    lastIntent?.lastError,
  ]
    .map(String)
    .join('|');

export function createSessionTracker({
  backend,
  logger,
  firstPollMs,
  pollMs,
  deadlineMs,
  maxEntries = SESSION_TRACKER_MAX_ENTRIES,
  now = Date.now,
}: SessionTrackerOptions): SessionTracker {
  const entries = new Map<string, Entry>();
  // every attempt under way, a replaced or evicted entry's included, so stop() waits for all
  const inFlight = new Set<Promise<void>>();
  let stopping = false;

  const live = (entry: Entry): boolean => !stopping && entries.get(entry.sessionId) === entry;
  // Still the entry of its id: not replaced by a retarget, evicted or finished. stop() clears the
  // map only after the drain, so during it an attempt in flight still counts as current.
  const current = (entry: Entry): boolean => entries.get(entry.sessionId) === entry;

  const finish = (entry: Entry): void => {
    clearTimeout(entry.timer);
    if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
  };

  const failed = (entry: Entry, error: unknown): void => {
    logger.error(
      { ...errorLogFields(error), sessionId: entry.sessionId },
      'trading session tracking failed',
    );
    finish(entry);
  };

  const arm = (entry: Entry, delayMs: number): void => {
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      const run = attempt(entry)
        .catch((error: unknown) => {
          failed(entry, error);
        })
        .finally(() => {
          inFlight.delete(run);
        });
      inFlight.add(run);
    }, delayMs);
  };

  // As in the intent tracker: shown or edited is rendered; gone stops the entry; any other
  // Telegram refusal or a transport failure is retried on the next poll, logged once per entry;
  // anything else is a bug and stops the entry.
  async function editTo(entry: Entry, text: TelegramHtml, key: string): Promise<boolean> {
    try {
      await entry.edit(text, entry.view);
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
              sessionId: entry.sessionId,
            },
            'trading session message not edited',
          );
        }
        entry.editFailures += 1;
        if (refusal === 'gone') finish(entry);
        return refusal !== 'gone';
      }
      failed(entry, error);
      return false;
    }
  }

  async function attempt(entry: Entry): Promise<void> {
    let view: TradingSessionView;
    try {
      view = await backend.readSession(entry.sessionId, entry.telegramUserId);
    } catch (error) {
      if (!(error instanceof BackendError)) {
        failed(entry, error);
        return;
      }
      const notFound =
        error.code === BackendErrorCode.HttpStatus && error.reason === SESSION_NOT_FOUND;
      if (notFound || entry.readFailures === 0) {
        logger.warn(
          { ...errorLogFields(error), ...backendErrorFields(error), sessionId: entry.sessionId },
          'trading session status not read',
        );
      }
      entry.readFailures += 1;
      if (notFound) {
        // polling cannot fix a missing or foreign id; a replaced entry leaves the old message be
        if (current(entry)) await editTo(entry, TEXTS.sessionStatusUnavailable, SESSION_NOT_FOUND);
        finish(entry);
        return;
      }
      await next(entry);
      return;
    }
    // A replaced, evicted or finished entry renders nothing, during stop() too; a current entry's
    // attempt that stop() drains still renders what it read, as in the intent tracker. An edit
    // already sent when the session moved can still land: the one edit the contract allows.
    if (!current(entry)) return;
    entry.view = view;
    const key = renderKey(view);
    if (key !== entry.rendered) {
      const goOn = await editTo(entry, sessionStatusText(entry.symbol, view), key);
      if (!goOn) return;
    }
    if (sessionTrackingDone(view) && entry.rendered === key) {
      finish(entry);
      return;
    }
    await next(entry);
  }

  // Re-arm, or past the deadline one last edit, not retried, and stop: the hint for a session
  // still followed, the final status for a done one whose edit never landed.
  async function next(entry: Entry): Promise<void> {
    if (!live(entry)) return;
    if (now() - entry.startedAt < deadlineMs) {
      arm(entry, pollMs);
      return;
    }
    const done = sessionTrackingDone(entry.view);
    await editTo(
      entry,
      sessionStatusText(entry.symbol, entry.view, done ? {} : { deadline: true }),
      done ? renderKey(entry.view) : 'deadline',
    );
    finish(entry);
  }

  return {
    track(request) {
      if (stopping) return;
      const previous = entries.get(request.sessionId);
      if (previous !== undefined) finish(previous);
      else if (entries.size >= maxEntries) {
        const oldest = entries.values().next().value;
        if (oldest !== undefined) finish(oldest);
      }
      const entry: Entry = {
        ...request,
        startedAt: previous?.startedAt ?? now(),
        rendered: renderKey(request.view),
        timer: undefined,
        readFailures: 0,
        editFailures: 0,
      };
      entries.set(request.sessionId, entry);
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
