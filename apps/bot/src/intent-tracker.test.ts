import { GrammyError, HttpError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TradeIntentFailureReason,
  TradeIntentStatus,
  type TelegramHtml,
  type TradeIntentView,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import {
  createIntentTracker,
  INTENT_NOT_FOUND,
  sessionOfferOf,
  TRACKER_STOP_STATUSES,
  type IntentTrackRequest,
} from './intent-tracker';
import { fakeLogger, INTENT_ID, intentView, PAIR_EURUSD, USER } from './testing';
import { intentStatusText, TEXTS } from './texts';
import {
  INTENT_TRACK_DEADLINE_MS,
  INTENT_TRACK_FIRST_POLL_MS,
  INTENT_TRACK_POLL_MS,
} from './timing';

const FIRST = INTENT_TRACK_FIRST_POLL_MS;
const POLL = INTENT_TRACK_POLL_MS;
const DEADLINE = INTENT_TRACK_DEADLINE_MS;
const SYMBOL = PAIR_EURUSD.symbol;

const editRefused = (description: string): GrammyError =>
  new GrammyError(
    `Call to 'editMessageText' failed!`,
    { ok: false, error_code: 400, description },
    'editMessageText',
    {},
  );
const NOT_MODIFIED = () =>
  editRefused(
    'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
  );
const GONE = () => editRefused('Bad Request: message to edit not found');
const FORBIDDEN = () =>
  new GrammyError(
    `Call to 'editMessageText' failed!`,
    { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    'editMessageText',
    {},
  );
const editTimedOut = () =>
  new HttpError("Network request for 'editMessageText' failed!", new Error('aborted'));

type Answer = TradeIntentView | Error;

// readIntent answers the script in order and repeats its last entry
function setup({
  script,
  maxEntries,
  now,
}: {
  script: Answer[];
  maxEntries?: number;
  now?: () => number;
}) {
  const logger = fakeLogger();
  let index = 0;
  const readIntent = vi.fn<BackendClient['readIntent']>(() => {
    const answer = script[Math.min(index, script.length - 1)];
    index += 1;
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer as TradeIntentView);
  });

  const edits: TelegramHtml[] = [];
  const edit = vi.fn<IntentTrackRequest['edit']>((text) => {
    edits.push(text);
    return Promise.resolve(true);
  });
  const tracker = createIntentTracker({
    backend: { readIntent },
    logger,
    firstPollMs: FIRST,
    pollMs: POLL,
    deadlineMs: DEADLINE,
    ...(maxEntries === undefined ? {} : { maxEntries }),
    ...(now === undefined ? {} : { now }),
  });
  const request = (patch: Partial<IntentTrackRequest> = {}): IntentTrackRequest => ({
    intentId: INTENT_ID,
    telegramUserId: String(USER.id),
    symbol: SYMBOL,
    payoutAccepted: true,
    view: intentView(),
    edit,
    ...patch,
  });
  return { tracker, readIntent, edit, edits, logger, request };
}

// the tail under the status: the hint at the deadline of a live status, the session offer under a
// stop status (#360), never both
const shown = (view: TradeIntentView, tail?: 'deadline' | 'offer') =>
  intentStatusText(SYMBOL, view, {
    deadline: tail === 'deadline',
    sessionOffer: tail === 'offer',
  }).value;
const OFFER = '🤖 Дальше бот может торговать сам';
const HINT = 'обрабатывается';

const submitting = intentView({ status: TradeIntentStatus.Submitting });
const accepted = intentView({ status: TradeIntentStatus.Accepted });
const unknown = intentView({ status: TradeIntentStatus.Unknown });
const notFound = () =>
  new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: INTENT_NOT_FOUND });
const unreachable = () => new BackendError(BackendErrorCode.Unreachable);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the intent tracker', () => {
  // the one place a status literal is written: the set the graph must derive
  it('stops at settled, rejected and accepted', () => {
    expect(new Set(TRACKER_STOP_STATUSES)).toEqual(new Set(['settled', 'rejected', 'accepted']));
  });

  it('follows queued → submitting → accepted, editing once per change, then stops', async () => {
    const { tracker, readIntent, edits, request } = setup({ script: [submitting, accepted] });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(readIntent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readIntent).toHaveBeenCalledWith(INTENT_ID, String(USER.id));
    expect(edits.map((text) => text.value)).toEqual([shown(submitting)]);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(edits.map((text) => text.value)).toEqual([shown(submitting), shown(accepted, 'offer')]);
    expect(edits[0]?.value).not.toContain(OFFER);
    expect(edits[1]?.value).toContain(OFFER);
    expect(tracker.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(readIntent).toHaveBeenCalledTimes(2);
  });

  it.each(Object.values(TradeIntentFailureReason).map((lastError) => [lastError] as const))(
    'renders a rejection for %s with its own line and stops',
    async (lastError) => {
      const rejected = intentView({ status: TradeIntentStatus.Rejected, lastError });
      const { tracker, edits, readIntent, request } = setup({ script: [rejected] });
      tracker.track(request());
      await vi.advanceTimersByTimeAsync(FIRST + POLL);
      expect(edits.map((text) => text.value)).toEqual([shown(rejected, 'offer')]);
      expect(readIntent).toHaveBeenCalledTimes(1);
      expect(tracker.size()).toBe(0);
    },
  );

  // #360: the line and the session row follow the status, never the moment
  it('offers the session on a stop status of a duration the demo still takes, and only then', () => {
    for (const status of TRACKER_STOP_STATUSES) {
      expect(sessionOfferOf({ status, durationSec: 5 }, true)).toBe(5);
      expect(sessionOfferOf({ status, durationSec: 15 }, true)).toBe(15);
      // a trade from before #313
      expect(sessionOfferOf({ status, durationSec: 60 }, true)).toBeUndefined();
    }
    for (const status of Object.values(TradeIntentStatus).filter(
      (status) => !TRACKER_STOP_STATUSES.has(status),
    )) {
      expect(sessionOfferOf({ status, durationSec: 5 }, true)).toBeUndefined();
    }
  });

  // #379: a pair paying below the cycle floor gets no offer on any stop status
  it('offers no session on a pair below the cycle floor', () => {
    for (const status of TRACKER_STOP_STATUSES) {
      expect(sessionOfferOf({ status, durationSec: 5 }, false)).toBeUndefined();
      expect(sessionOfferOf({ status, durationSec: 15 }, false)).toBeUndefined();
    }
  });

  it('edits a stop status without the offer when the pair paid below the floor at the press', async () => {
    const { tracker, edits, request } = setup({ script: [submitting, accepted] });
    tracker.track(request({ payoutAccepted: false }));
    await vi.advanceTimersByTimeAsync(FIRST + POLL);
    expect(edits.map((text) => text.value)).toEqual([shown(submitting), shown(accepted)]);
    expect(edits[1]?.value).not.toContain(OFFER);
    expect(tracker.size()).toBe(0);
  });

  it('ends a stop status at the deadline without the offer below the floor', async () => {
    const rejected = intentView({
      status: TradeIntentStatus.Rejected,
      lastError: TradeIntentFailureReason.ExecutorNotConfigured,
    });
    const { tracker, edit, request } = setup({ script: [rejected] });
    edit.mockImplementation(() => Promise.reject(FORBIDDEN()));
    tracker.track(request({ payoutAccepted: false }));
    await vi.advanceTimersByTimeAsync(DEADLINE + POLL);
    expect(tracker.size()).toBe(0);
    const texts = edit.mock.calls.map(([text]) => text.value);
    expect(new Set(texts)).toEqual(new Set([shown(rejected)]));
    expect(texts.at(-1)).not.toContain(OFFER);
  });

  it('edits nothing while the status stays the same, and keeps polling a live one', async () => {
    const { tracker, edits, readIntent, request } = setup({ script: [intentView(), unknown] });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(edits.map((text) => text.value)).toEqual([shown(unknown)]);
    expect(readIntent).toHaveBeenCalledTimes(4);
    expect(tracker.size()).toBe(1);
  });

  it('at the deadline edits once with the hint and polls no more', async () => {
    const { tracker, edits, edit, readIntent, request } = setup({ script: [unknown] });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(DEADLINE + POLL);
    expect(edits.map((text) => text.value)).toEqual([shown(unknown), shown(unknown, 'deadline')]);
    // a live status gets the hint and never the offer
    expect(edits.map((text) => text.value).join('\n')).not.toContain(OFFER);
    expect(edits[1]?.value).toContain(HINT);
    // #350: the deadline edit says so, so its keyboard adds the menu
    expect(edit.mock.calls.map((call) => call[2])).toEqual([undefined, 'deadline']);
    const polls = readIntent.mock.calls.length;
    expect(tracker.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(readIntent).toHaveBeenCalledTimes(polls);
  });

  it('on a 404 says the status is unavailable, warns once with the id, and stops', async () => {
    const { tracker, edits, edit, logger, readIntent, request } = setup({
      script: [notFound()],
    });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(edits.map((text) => text.value)).toEqual([TEXTS.intentStatusUnavailable.value]);
    expect(edits[0]?.value).not.toContain(OFFER);
    // #350: the intent is gone, so its keyboard is the menu only
    expect(edit.mock.calls.map((call) => call[2])).toEqual(['not_found']);
    expect(readIntent).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: INTENT_ID, backendStatus: 404 }),
      'trade intent status not read',
    );
    expect(tracker.size()).toBe(0);
  });

  it('retries a failed read, warning once per entry, and renders the view that follows', async () => {
    const { tracker, edits, logger, request } = setup({
      script: [unreachable(), unreachable(), accepted],
    });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(edits.map((text) => text.value)).toEqual([shown(accepted, 'offer')]);
    expect(tracker.size()).toBe(0);
  });

  it('treats «message is not modified» as shown and goes on', async () => {
    const { tracker, edit, readIntent, request } = setup({ script: [submitting, accepted] });
    edit.mockRejectedValueOnce(NOT_MODIFIED());
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST + POLL);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(readIntent).toHaveBeenCalledTimes(2);
    expect(tracker.size()).toBe(0);
  });

  it('stops with a warning when the message is gone', async () => {
    const { tracker, edit, logger, readIntent, request } = setup({ script: [submitting] });
    edit.mockRejectedValueOnce(GONE());
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(readIntent).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: INTENT_ID, method: 'editMessageText' }),
      'trade intent message not edited',
    );
    expect(tracker.size()).toBe(0);
  });

  it('retries an edit that failed in transport on the next poll', async () => {
    const { tracker, edit, logger, edits, request } = setup({ script: [submitting] });
    edit.mockRejectedValueOnce(editTimedOut());
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: INTENT_ID, method: 'editMessageText' }),
      'trade intent message not edited',
    );
    expect(edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(edits.map((text) => text.value)).toEqual([shown(submitting)]);
    expect(tracker.size()).toBe(1);
  });

  // review round 1, M1: a stop status ends the entry only once its edit has landed
  it('retries the edit of a stop status that failed in transport, then stops', async () => {
    const rejected = intentView({
      status: TradeIntentStatus.Rejected,
      lastError: TradeIntentFailureReason.ExecutorNotConfigured,
    });
    const { tracker, edit, readIntent, request } = setup({ script: [rejected] });
    edit.mockRejectedValueOnce(editTimedOut());
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(tracker.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(edit.mock.calls.map(([text]) => text.value)).toEqual([
      shown(rejected, 'offer'),
      shown(rejected, 'offer'),
    ]);
    expect(tracker.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(readIntent).toHaveBeenCalledTimes(2);
  });

  it('retries a stop status whose edit always fails until the deadline, ending with its own text', async () => {
    const rejected = intentView({
      status: TradeIntentStatus.Rejected,
      lastError: TradeIntentFailureReason.ExecutorNotConfigured,
    });
    const { tracker, edit, readIntent, logger, request } = setup({ script: [rejected] });
    edit.mockImplementation(() => Promise.reject(FORBIDDEN()));
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(DEADLINE + POLL);
    expect(tracker.size()).toBe(0);
    const polls = readIntent.mock.calls.length;
    expect(polls).toBeGreaterThan(DEADLINE / POLL - 2);
    const texts = edit.mock.calls.map(([text]) => text.value);
    expect(texts).toHaveLength(polls + 1);
    expect(new Set(texts)).toEqual(new Set([shown(rejected, 'offer')]));
    // the deadline edit of a stop status: its offer, not the hint
    expect(texts.at(-1)).not.toContain(HINT);
    expect(texts.at(-1)).toContain(OFFER);
    // #350: a stop status's last edit is its end of the path, not the deadline's (no second menu)
    expect(edit.mock.calls.at(-1)?.[2]).toBeUndefined();
    // one line per entry, the later failures only counted
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: INTENT_ID, telegramErrorCode: 403 }),
      'trade intent message not edited',
    );
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(readIntent).toHaveBeenCalledTimes(polls);
  });

  it('warns about a message that is gone even after an earlier edit failure', async () => {
    const { tracker, edit, logger, request } = setup({ script: [submitting] });
    edit.mockRejectedValueOnce(editTimedOut()).mockRejectedValueOnce(GONE());
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST + POLL);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(tracker.size()).toBe(0);
  });

  // review round 1, m1: a throw outside the read and the edit
  it('logs and stops the entry when the attempt itself throws, and stop() still resolves', async () => {
    let calls = 0;
    const now = () => {
      calls += 1;
      if (calls > 1) throw new TypeError('clock broke');
      return 0;
    };
    const { tracker, logger, request } = setup({ script: [submitting], now });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: INTENT_ID,
        err: expect.objectContaining({ name: 'TypeError' }),
      }),
      'trade intent tracking failed',
    );
    expect(tracker.size()).toBe(0);
    await expect(tracker.stop()).resolves.toBeUndefined();
  });

  it('stops with an error line on anything that is not a backend or Telegram failure', async () => {
    const { tracker, logger, readIntent, request } = setup({ script: [new TypeError('bug')] });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(readIntent).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: INTENT_ID }),
      'trade intent tracking failed',
    );
    expect(tracker.size()).toBe(0);
  });

  it('ignores a second track of the same id', async () => {
    const { tracker, readIntent, request } = setup({ script: [intentView()] });
    tracker.track(request());
    tracker.track(request());
    expect(tracker.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(readIntent).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest entry past its bound', async () => {
    const { tracker, readIntent, request } = setup({ script: [intentView()], maxEntries: 2 });
    const ids = ['a', 'b', 'c'].map((letter) => INTENT_ID.slice(0, -1) + letter);
    for (const intentId of ids) tracker.track(request({ intentId }));
    expect(tracker.size()).toBe(2);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(readIntent.mock.calls.map(([id]) => id)).toEqual(ids.slice(1));
  });

  it('on stop cancels the timers, lets the attempt in flight finish, and refuses new entries', async () => {
    const { tracker, readIntent, edits, request } = setup({ script: [submitting] });
    let release: () => void = () => {};
    readIntent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(submitting);
        }),
    );
    tracker.track(request());
    tracker.track(request({ intentId: INTENT_ID.slice(0, -1) + 'f' }));
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(readIntent).toHaveBeenCalledTimes(2);
    let stopped = false;
    const stopping = tracker.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(edits.map((text) => text.value)).toEqual([shown(submitting), shown(submitting)]);
    tracker.track(request({ intentId: INTENT_ID.slice(0, -1) + 'e' }));
    expect(tracker.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(readIntent).toHaveBeenCalledTimes(2);
  });
});
