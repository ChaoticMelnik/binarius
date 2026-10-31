import { GrammyError, HttpError } from 'grammy';
import {
  editRefusal,
  errorLogFields,
  isTradingSessionFinished,
  type PairLabel,
  type TelegramHtml,
  type TradeAction,
  TradingSessionStatus,
  type TradingSessionView,
  telegramErrorFields,
  type BotLanguage,
} from '@binarius/shared';
import {
  BackendError,
  BackendErrorCode,
  backendErrorFields,
  type BackendClient,
} from './backend-client';
import type { Logger } from './logging';
import { runWithLanguage } from './language';
import { sessionStatusText, TEXTS } from './texts';

// The session's message follows its session (#284, docs/bot-session.md): the bot polls GET
// /trading/sessions/:id and edits the message when its drawing changes: its text (the session's
// stop, #536) or its picture (the signal's direction turns, #568, by editMessageMedia) - then sends
// the session's summary in one message (#318, #537). In-process memory,
// like the intent tracker; the first poll of a message records its id with the backend (#567), at
// once after its send, as the session's first message waits for the record (#911), so after a
// restart the bot's resumer (session-resume.ts) tracks the session again on it, the
// recovered entries' first polls paced in slots and a message drawn in this process remembered.

// The answer GET /trading/sessions/:id gives for an id that is missing or not this user's.
export const SESSION_NOT_FOUND = 'not_found';

// the intent tracker's bound: the oldest entry goes first; the recovery pass (#567) tracks its
// session again from the backend's list
const SESSION_TRACKER_MAX_ENTRIES = 10_000;

// Where following a session ends: stopped, and its last trade can no longer move the counters. A
// stopped session whose trade is still open is followed until that trade settles; a last trade in
// manual_review has edges left, so such an entry runs to the deadline. The backend refreshes the
// balance for the same predicate (#337), so the two cannot drift.
export const sessionTrackingDone = isTradingSessionFinished;

// What the session message shows of its view: the text and the picture (the signal's direction;
// null - a text message), never a keyboard (#536; an H1 session's too, #775). The edit draws
// exactly this and the render key is made of all of it, so nothing the edit draws can change
// unseen by the key (#568: equal overrides of the two signal lines must not hide a turn of
// direction, which a text-only key did; session-tracker.test.ts Q1).
export interface SessionDrawing {
  text: TelegramHtml;
  picture: TradeAction | null;
}

// the one derivation of the picture from a view
const sessionPicture = (
  view: Pick<TradingSessionView, 'signalAction'> | null,
): TradeAction | null => view?.signalAction ?? null;

export const sessionDrawing = (
  label: PairLabel | null,
  view: TradingSessionView,
): SessionDrawing => ({ text: sessionStatusText(label, view), picture: sessionPicture(view) });

// The one choice of the session message's kind (#568, docs/bot-session.md → The session message):
// a drawing with a picture is drawn by editMessageMedia, which turns a text message into a photo
// too; without one it is the text of #536.
export const sessionEditMethod = (
  picture: TradeAction | null,
): 'editMessageText' | 'editMessageMedia' =>
  picture === null ? 'editMessageText' : 'editMessageMedia';

export interface SessionTrackRequest {
  sessionId: string;
  telegramUserId: string;
  // the status message the edits go to (#567: its first poll, at once, records it with the backend)
  messageId: number;
  // the pair's label as the catalog gave it at the press, or null
  label: PairLabel | null;
  // the language of the user's texts (#508): the polls, their edits and the summary run
  // outside any update; a recovered session's comes from the backend's list
  language: BotLanguage;
  // what the message shows now, or null when nothing of it was read yet (a recovered session)
  view: TradingSessionView | null;
  // when the entry's deadline starts, epoch ms: the session's started_at for a recovered one;
  // now() by default
  startedAt?: number;
  // the first poll, at once (#911), records messageId with the backend (#567) and reads the view
  // from that answer; false when the backend has it already (a recovered session)
  record: boolean;
  // draws the drawing on the session message, without a keyboard (#536), or under the menu alone
  // once the session is gone (#350)
  edit: (drawing: SessionDrawing, end?: 'not_found') => Promise<unknown>;
  // sends the session's summary under the final status (#318, #537): called once, as the entry
  // ends on a done view whose final edit landed and whose notices the backend closed (#464); it
  // handles its own failures
  summary: (view: TradingSessionView) => Promise<void>;
}

export interface SessionTracker {
  // An id already tracked moves to the new message: the next change is drawn there and the old
  // message is not edited again, but for an attempt already in flight, which keeps the target it
  // started with. The deadline keeps counting from the first track. An entry with a view to record
  // (a press) polls at once, the poll being the record (#911); one with a view and nothing to
  // record polls first after firstPollMs; one with no view (a recovered session) takes the next
  // slot of resumeGapMs, no sooner than firstPollMs. A no-op after stop().
  track(request: SessionTrackRequest): void;
  // clears every timer, refuses new entries, and waits for the attempts in flight
  stop(): Promise<void>;
  size(): number;
  // the session has an entry
  has(sessionId: string): boolean;
}

export interface SessionTrackerOptions {
  backend: Pick<BackendClient, 'readSession' | 'recordSessionMessage' | 'forgetSessionMessage'>;
  logger: Logger;
  firstPollMs: number;
  pollMs: number;
  deadlineMs: number;
  // the gap between the first polls of two entries tracked with no view (recovered ones, #567)
  resumeGapMs: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry extends SessionTrackRequest {
  startedAt: number;
  // the drawing on screen (finalOf's key); '' while nothing this process drew on the message is
  // remembered, so the first good read of a stopped session draws (mayDraw)
  rendered: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  readFailures: number;
  editFailures: number;
}

// What the message shows of the view, and its key: the whole drawing, its text and its picture
// (#536, #568), so the edit happens only when either changes - the session's stop, a pair's label,
// an override of the catalog's texts (#570), a turn of the signal's direction - and never because
// of a counter the message does not print. The picture holds no newline, so the key is unambiguous.
const finalOf = (
  label: PairLabel | null,
  view: TradingSessionView,
): { key: string; drawing: SessionDrawing } => {
  const drawing = sessionDrawing(label, view);
  return { key: `${drawing.picture ?? ''}\n${drawing.text.value}`, drawing };
};

// The summary waits for the done view's drawing on screen and the backend's closed notices (#464,
// #537: every trade's message sent, the waiting message gone)
const summaryDue = (entry: Entry, view: TradingSessionView, key: string): boolean =>
  sessionTrackingDone(view) && entry.rendered === key && view.noticesDone;

// A message this process did not draw (a recovered entry, nothing remembered) may be one sent
// before #536, with its «🔄»/«⏹» (owner's answer 5): it is drawn only once its session stopped,
// so a running session keeps the old buttons until then. A #536 message prints nothing that
// changes while its session runs.
const mayDraw = (entry: Entry, view: TradingSessionView): boolean =>
  entry.rendered !== '' || view.status === TradingSessionStatus.Stopped;

export function createSessionTracker({
  backend,
  logger,
  firstPollMs,
  pollMs,
  deadlineMs,
  resumeGapMs,
  maxEntries = SESSION_TRACKER_MAX_ENTRIES,
  now = Date.now,
}: SessionTrackerOptions): SessionTracker {
  const entries = new Map<string, Entry>();
  // what an ended entry last drew on its message, so a recovered entry of it edits only on a change.
  // Only this process's own draws enter it (finish() skips an entry with nothing rendered): such a
  // message is a #536 one, without the old buttons mayDraw protects, so a memory hit may edit a
  // running session's message (#587 finding 2, refuted by Y6)
  const drawn = new Map<string, { messageId: number; rendered: string }>();
  let nextResumeAt = Number.NEGATIVE_INFINITY;
  // every attempt under way, a replaced or evicted entry's included, so stop() waits for all
  const inFlight = new Set<Promise<void>>();
  let stopping = false;

  const live = (entry: Entry): boolean => !stopping && entries.get(entry.sessionId) === entry;
  // Still the entry of its id: not replaced by a retarget, evicted or finished. stop() clears the
  // map only after the drain, so during it an attempt in flight still counts as current.
  const current = (entry: Entry): boolean => entries.get(entry.sessionId) === entry;

  // A lost message leaves no memory (remember false): the next edit has to find the loss again.
  const finish = (entry: Entry, remember = true): void => {
    clearTimeout(entry.timer);
    if (entries.get(entry.sessionId) !== entry) return;
    entries.delete(entry.sessionId);
    if (!remember || entry.rendered === '') return;
    drawn.delete(entry.sessionId);
    drawn.set(entry.sessionId, { messageId: entry.messageId, rendered: entry.rendered });
    if (drawn.size > maxEntries) {
      const oldest = drawn.keys().next().value;
      if (oldest !== undefined) drawn.delete(oldest);
    }
  };

  // An entry with no view reads on its first poll after a restart, and edits only a stopped
  // session's message (mayDraw: the bot cannot know what is on screen). A pass hands up to
  // TRACKED_SESSIONS_MAX of them at once, so their first polls go in slots resumeGapMs apart, no
  // sooner than firstPollMs. The slots are timers: stop() clears them like any other
  // (docs/bot-session.md → Rate and timing).
  const resumeSlot = (): number => {
    const t = now();
    const at = Math.max(t + firstPollMs, nextResumeAt);
    nextResumeAt = at + resumeGapMs;
    return at - t;
  };

  const failed = (entry: Entry, error: unknown): void => {
    logger.error(
      { ...errorLogFields(error), sessionId: entry.sessionId },
      'trading session tracking failed',
    );
    finish(entry);
  };

  // A lost message is reported once per refusal, not retried: the row stays in the recovery list,
  // so the next pass tracks it again and its edit is refused again (docs/bot-session.md → A lost
  // message). The answer is not read: false is another message recorded, or none.
  const lost = async (entry: Entry): Promise<void> => {
    try {
      await backend.forgetSessionMessage(entry.sessionId, entry.telegramUserId, entry.messageId);
    } catch (error) {
      logger.warn(
        { ...errorLogFields(error), ...backendErrorFields(error), sessionId: entry.sessionId },
        'trading session message not forgotten',
      );
    }
  };

  const arm = (entry: Entry, delayMs: number): void => {
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      const run = runWithLanguage(entry.language, () => attempt(entry))
        .catch((error: unknown) => {
          failed(entry, error);
        })
        .finally(() => {
          inFlight.delete(run);
        });
      inFlight.add(run);
    }, delayMs);
  };

  // Shown or edited is rendered. Gone or any 403 means the message is lost for good (the backend
  // counts any 403 as the user unreachable, Rule 19): the entry ends and, for an edit drawn from a
  // view, the backend is told to forget the message, so the session leaves the recovery list; the
  // 404 edit has no session to forget. Any other Telegram refusal or a transport failure is
  // retried on the next poll, logged once per entry; anything else is a bug and stops the entry.
  async function editTo(
    entry: Entry,
    drawing: SessionDrawing,
    key: string,
    end?: 'not_found',
  ): Promise<boolean> {
    try {
      await entry.edit(drawing, end);
      entry.rendered = key;
      return true;
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') {
        entry.rendered = key;
        return true;
      }
      if (error instanceof GrammyError || error instanceof HttpError) {
        const lostForGood =
          refusal === 'gone' || (error instanceof GrammyError && error.error_code === 403);
        if (lostForGood || entry.editFailures === 0) {
          logger.warn(
            {
              ...errorLogFields(error),
              ...telegramErrorFields(error, sessionEditMethod(drawing.picture)),
              sessionId: entry.sessionId,
            },
            'trading session message not edited',
          );
        }
        entry.editFailures += 1;
        if (!lostForGood) return true;
        finish(entry, false);
        if (end === undefined) await lost(entry);
        return false;
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
          await editTo(
            entry,
            { text: TEXTS.sessionStatusUnavailable, picture: sessionPicture(entry.view) },
            SESSION_NOT_FOUND,
            'not_found',
          );
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
    const { key, drawing } = finalOf(entry.label, view);
    if (key !== entry.rendered && mayDraw(entry, view)) {
      const goOn = await editTo(entry, drawing, key);
      if (!goOn) return;
    }
    // The summary goes once, then the entry ends, whatever it did: a claim the backend committed
    // answers 409 the second time, so a retry could only lose it (docs/bot-session.md). It waits
    // for the backend's closed notices (#464), so it never comes before a trade's message: a done
    // session without them is polled on, with no edit while its drawing stays the same.
    if (summaryDue(entry, view, key)) {
      await entry.summary(view);
      finish(entry);
      return;
    }
    await next(entry);
  }

  // Re-arm, or past the deadline stop, with one last edit, not retried, only when the last view's
  // drawing is not on screen yet (the poll's own edit failed, or a read failed after the last good
  // one); then the summary of a done session once that drawing is shown and the notices are closed
  // (no summary otherwise: it would come before a trade's message; the backend's fallback sends it
  // then, #537). An entry that never
  // read a view ends with no edit: it has nothing to draw.
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
    const { key, drawing } = finalOf(entry.label, view);
    if (entry.rendered !== key && mayDraw(entry, view)) await editTo(entry, drawing, key);
    if (summaryDue(entry, view, key)) {
      await entry.summary(view);
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
      const memo = drawn.get(request.sessionId);
      drawn.delete(request.sessionId);
      const { view } = request;
      const entry: Entry = {
        ...request,
        startedAt: previous?.startedAt ?? request.startedAt ?? now(),
        rendered:
          view !== null
            ? runWithLanguage(request.language, () => finalOf(request.label, view).key)
            : memo?.messageId === request.messageId
              ? memo.rendered
              : '',
        timer: undefined,
        readFailures: 0,
        editFailures: 0,
      };
      entries.set(request.sessionId, entry);
      arm(entry, request.view === null ? resumeSlot() : request.record ? 0 : firstPollMs);
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
