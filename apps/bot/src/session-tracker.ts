import { GrammyError, HttpError } from 'grammy';
import {
  editRefusal,
  errorLogFields,
  isTradingSessionFinished,
  TradingSessionStatus,
  type PairLabel,
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
import { sessionStatusText, TEXTS } from './texts';

// The session's status message follows its session (#284, docs/bot-session.md): the bot
// polls GET /trading/sessions/:id and edits the message as the session moves. In-process memory,
// like the intent tracker; the first poll of a message records its id with the backend (#567), so
// after a restart the bot's resumer (session-resume.ts) tracks the session again on it.

// The answer GET /trading/sessions/:id gives for an id that is missing or not this user's.
export const SESSION_NOT_FOUND = 'not_found';

// the intent tracker's bound: the oldest entry goes first, its message keeping the refresh button
const SESSION_TRACKER_MAX_ENTRIES = 10_000;

// Where following a session ends: stopped, and its last trade can no longer move the counters. A
// stopped session whose trade is still open is followed until that trade settles; a last trade in
// manual_review has edges left, so such an entry runs to the deadline. The backend refreshes the
// balance for the same predicate (#337), so the two cannot drift.
export const sessionTrackingDone = isTradingSessionFinished;

// what an edit draws for: the view it shows, or none once the session is gone (#350)
export type SessionEditArgs =
  [view: TradingSessionView, end?: undefined] | [view: null, end: 'not_found'];

export interface SessionTrackRequest {
  sessionId: string;
  telegramUserId: string;
  // the status message the edits go to (#567: its first poll records it with the backend)
  messageId: number;
  // the pair's label as the catalog gave it at the press, or null
  label: PairLabel | null;
  // what the message shows now, or null when nothing of it was read yet (a recovered session)
  view: TradingSessionView | null;
  // when the entry's deadline starts, epoch ms: the session's started_at for a recovered one;
  // now() by default
  startedAt?: number;
  // the first poll records messageId with the backend (#567) and reads the view from that answer;
  // false when the backend has it already (a recovered session)
  record: boolean;
  // edits the status message; the keyboard follows the view (no stop button once it stopped),
  // or only the menu once the session is gone (#350)
  edit: (text: TelegramHtml, ...rest: SessionEditArgs) => Promise<unknown>;
  // sends the summary card under the final status (#318): called once, as the entry ends on a
  // done view whose final edit landed and whose summary message the backend sent (#464); it
  // handles its own failures
  card: (view: TradingSessionView) => Promise<void>;
}

export interface SessionTracker {
  // An id already tracked moves to the new message: the next change is drawn there and the old
  // message is not edited again, but for an attempt already in flight, which keeps the target it
  // started with. The deadline keeps counting from the first track. A no-op after stop().
  track(request: SessionTrackRequest): void;
  // clears every timer, refuses new entries, and waits for the attempts in flight
  stop(): Promise<void>;
  size(): number;
  // the session has an entry
  has(sessionId: string): boolean;
}

export interface SessionTrackerOptions {
  backend: Pick<BackendClient, 'readSession' | 'recordSessionMessage'>;
  logger: Logger;
  firstPollMs: number;
  pollMs: number;
  deadlineMs: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry extends SessionTrackRequest {
  startedAt: number;
  // what is on screen, as finalOf's key spells it; '' while nothing was read, so the first good
  // read draws
  rendered: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  readFailures: number;
  editFailures: number;
}

// Every field the message prints from the view; the edit happens only when one of them changes.
// The balance's age is left out: it moves every poll, and a manual_review session would be edited
// every poll to the deadline; the age line is as of the edit that drew it (#337).
const renderKey = ({
  status,
  stopReason,
  trades,
  lastIntent,
  balance,
}: TradingSessionView): string =>
  [
    status,
    stopReason,
    trades.planned,
    trades.settled,
    trades.won,
    trades.lost,
    trades.tied,
    trades.profit,
    balance?.available,
    balance?.current,
    lastIntent?.id,
    lastIntent?.status,
    lastIntent?.lastError,
  ]
    .map(String)
    .join('|');

// What the message ends on: the view's status, with the deadline hint once past the deadline
// under a session not stopped. The hint follows sessionStatusText's own rule (none under a
// stopped session), so a stopped session's key past the deadline is its plain key and a text
// already on screen is not drawn again.
const finalOf = (
  label: PairLabel | null,
  view: TradingSessionView,
  past: boolean,
): { key: string; text: TelegramHtml } => {
  const hinted = past && view.status !== TradingSessionStatus.Stopped;
  return {
    key: renderKey(view) + (hinted ? '|deadline' : ''),
    text: sessionStatusText(label, view, { deadline: hinted }),
  };
};

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
  async function editTo(
    entry: Entry,
    text: TelegramHtml,
    key: string,
    ...args: SessionEditArgs
  ): Promise<boolean> {
    try {
      await entry.edit(text, ...args);
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
      view = entry.record
        ? await backend.recordSessionMessage(entry.sessionId, entry.telegramUserId, entry.messageId)
        : await backend.readSession(entry.sessionId, entry.telegramUserId);
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
        if (current(entry)) {
          await editTo(entry, TEXTS.sessionStatusUnavailable, SESSION_NOT_FOUND, null, 'not_found');
        }
        finish(entry);
        return;
      }
      await next(entry);
      return;
    }
    // A replaced, evicted or finished entry renders nothing, during stop() too; a current entry's
    // attempt that stop() drains still renders what it read, as in the intent tracker. An edit
    // already sent when the session moved can still land: the one edit the contract allows.
    // an answer means the backend has the id: a later poll only reads; a failed one asks again
    entry.record = false;
    if (!current(entry)) return;
    entry.view = view;
    const { key, text } = finalOf(entry.label, view, now() - entry.startedAt >= deadlineMs);
    if (key !== entry.rendered) {
      const goOn = await editTo(entry, text, key, view);
      if (!goOn) return;
    }
    // The card goes once, then the entry ends, whatever the card did: a claim the backend
    // committed answers 409 the second time, so a retry could only lose it (docs/bot-session.md).
    // It waits for the backend's summary message (#464), so it never comes before it: a done
    // session without it is polled on, with no edit while nothing it prints changes.
    if (sessionTrackingDone(view) && entry.rendered === key && view.noticesDone) {
      await entry.card(view);
      finish(entry);
      return;
    }
    await next(entry);
  }

  // Re-arm, or past the deadline stop, with one last edit, not retried, only when the final text
  // is not on screen yet (the poll's own edit failed, or a read failed after the last good one):
  // the hint for a session not stopped, the final status otherwise; then the card of a done
  // session once that text is shown and the summary message went out (no card otherwise: it
  // would come before the summary or without it). An entry that never read a view ends with no
  // edit: it has nothing to draw.
  async function next(entry: Entry): Promise<void> {
    if (!live(entry)) return;
    if (now() - entry.startedAt < deadlineMs) {
      arm(entry, pollMs);
      return;
    }
    const view = entry.view;
    if (view === null) {
      finish(entry);
      return;
    }
    const { key, text } = finalOf(entry.label, view, true);
    if (entry.rendered !== key) await editTo(entry, text, key, view);
    if (sessionTrackingDone(view) && entry.rendered === key && view.noticesDone) {
      await entry.card(view);
    }
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
        startedAt: previous?.startedAt ?? request.startedAt ?? now(),
        rendered: request.view === null ? '' : renderKey(request.view),
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
    has: (sessionId) => entries.has(sessionId),
  };
}
