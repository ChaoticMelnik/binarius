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

export interface IntentTrackRequest {
  intentId: string;
  telegramUserId: string;
  // the pair's symbol as the catalog spelled it at the press
  symbol: string;
  // what the message shows now
  view: TradeIntentView;
  // edits the status message, keeping its keyboard
  edit: (text: TelegramHtml) => Promise<unknown>;
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
      const run = attempt(entry).finally(() => {
        inFlight.delete(run);
      });
      inFlight.add(run);
    }, delayMs);
  };

  // Every way an edit ends: shown or edited is rendered; gone stops the entry (the user deleted
  // the message); any other refusal or a transport failure is retried by the next poll, since
  // the status is not recorded as rendered; anything else is a bug and stops the entry.
  async function editTo(entry: Entry, text: TelegramHtml, key: string): Promise<boolean> {
    try {
      await entry.edit(text);
      entry.rendered = key;
      return true;
    } catch (error) {
      const refusal = error instanceof GrammyError ? editRefusal(error) : undefined;
      if (refusal === 'shown') {
        entry.rendered = key;
        return true;
      }
      if (refusal === 'gone' || error instanceof GrammyError || error instanceof HttpError) {
        logger.warn(
          {
            ...errorLogFields(error),
            ...telegramErrorFields(error, 'editMessageText'),
            intentId: entry.intentId,
          },
          'trade intent message not edited',
        );
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
        await editTo(entry, TEXTS.intentStatusUnavailable, INTENT_NOT_FOUND);
        finish(entry);
        return;
      }
      await next(entry);
      return;
    }
    if (!live(entry) && !stopping) return;
    entry.view = view;
    const key = renderKey(view);
    if (key !== entry.rendered) {
      const goOn = await editTo(entry, intentStatusText(entry.symbol, view), key);
      if (!goOn) return;
    }
    if (TRACKER_STOP_STATUSES.has(view.status)) {
      finish(entry);
      return;
    }
    await next(entry);
  }

  // re-arm, or past the deadline one last edit with the hint and stop
  async function next(entry: Entry): Promise<void> {
    if (!live(entry)) return;
    if (now() - entry.startedAt < deadlineMs) {
      arm(entry, pollMs);
      return;
    }
    await editTo(entry, intentStatusText(entry.symbol, entry.view, { deadline: true }), 'deadline');
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
