import { GrammyError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TradeIntentStatus,
  TradingSessionStatus,
  TradingSessionStopReason,
  type DecimalString,
  type TelegramHtml,
  type TradingSessionView,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import {
  createSessionTracker,
  SESSION_NOT_FOUND,
  sessionTrackingDone,
  type SessionTrackRequest,
} from './session-tracker';
import {
  fakeLogger,
  intentView,
  PAIR_EURUSD,
  SESSION_ID,
  SESSION_VIEW,
  sessionView,
  USER,
} from './testing';
import { sessionStatusText, TEXTS } from './texts';
import {
  SESSION_TRACK_DEADLINE_MS,
  SESSION_TRACK_FIRST_POLL_MS,
  SESSION_TRACK_POLL_MS,
} from './timing';

const FIRST = SESSION_TRACK_FIRST_POLL_MS;
const POLL = SESSION_TRACK_POLL_MS;
const DEADLINE = SESSION_TRACK_DEADLINE_MS;
const SYMBOL = PAIR_EURUSD.symbol;

const GONE = () =>
  new GrammyError(
    `Call to 'editMessageText' failed!`,
    { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
    'editMessageText',
    {},
  );

type Answer = TradingSessionView | Error | (() => Promise<TradingSessionView>);

// readSession answers the script in order and repeats its last entry
function setup({ script, maxEntries }: { script: Answer[]; maxEntries?: number }) {
  const logger = fakeLogger();
  let index = 0;
  const readSession = vi.fn<BackendClient['readSession']>(() => {
    const answer = script[Math.min(index, script.length - 1)];
    index += 1;
    if (typeof answer === 'function') return answer();
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer as TradingSessionView);
  });
  const tracker = createSessionTracker({
    backend: { readSession },
    logger,
    firstPollMs: FIRST,
    pollMs: POLL,
    deadlineMs: DEADLINE,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
  const target = () => {
    const edits: TelegramHtml[] = [];
    const edit = vi.fn<SessionTrackRequest['edit']>((text) => {
      edits.push(text);
      return Promise.resolve(true);
    });
    return { edits, edit };
  };
  const request = (patch: Partial<SessionTrackRequest> = {}): SessionTrackRequest => ({
    sessionId: SESSION_ID,
    telegramUserId: String(USER.id),
    symbol: SYMBOL,
    view: SESSION_VIEW,
    edit: target().edit,
    ...patch,
  });
  return { tracker, readSession, logger, request, target };
}

const shown = (view: TradingSessionView, deadline = false) =>
  sessionStatusText(SYMBOL, view, { deadline }).value;
const texts = (edits: readonly TelegramHtml[]) => edits.map((text) => text.value);

const live = (status: TradeIntentStatus) => intentView({ status });
const money = (value: string) => value as DecimalString;
const trading = sessionView({ lastIntent: live(TradeIntentStatus.Accepted) });
const stoppedWith = (lastIntent: TradingSessionView['lastIntent']) =>
  sessionView({
    status: TradingSessionStatus.Stopped,
    stopReason: TradingSessionStopReason.UserStopped,
    endedAt: '2026-10-07T10:05:00.000Z',
    lastIntent,
  });
const settledOne = {
  trades: { ...SESSION_VIEW.trades, settled: 1, won: 1 },
};
const stoppedOpen = stoppedWith(live(TradeIntentStatus.Accepted));
const stoppedClosed = sessionView({
  ...stoppedOpen,
  ...settledOne,
  lastIntent: live(TradeIntentStatus.Settled),
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the session tracker', () => {
  it('ends only on a stopped session whose last trade can no longer move', () => {
    expect(sessionTrackingDone(SESSION_VIEW)).toBe(false);
    expect(sessionTrackingDone(stoppedWith(null))).toBe(true);
    expect(sessionTrackingDone(stoppedClosed)).toBe(true);
    expect(sessionTrackingDone(stoppedWith(live(TradeIntentStatus.Rejected)))).toBe(true);
    expect(sessionTrackingDone(stoppedOpen)).toBe(false);
    expect(sessionTrackingDone(stoppedWith(live(TradeIntentStatus.ManualReview)))).toBe(false);
  });

  it('edits only when what the message prints changes', async () => {
    const { tracker, readSession, request, target } = setup({
      script: [SESSION_VIEW, trading, trading, stoppedClosed],
    });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(readSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readSession).toHaveBeenCalledWith(SESSION_ID, String(USER.id));
    expect(edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL * 2);
    expect(texts(edits)).toEqual([shown(trading)]);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(texts(edits)).toEqual([shown(trading), shown(stoppedClosed)]);
    expect(tracker.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(readSession).toHaveBeenCalledTimes(4);
  });

  // #337: a session on manual review is followed to the deadline and shows its balance's age
  it('K1 edits when the balance changes and not when only its age moves', async () => {
    const onReview = (available: string, ageSec: number) =>
      sessionView({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.ManualReview,
        endedAt: '2026-10-07T10:05:00.000Z',
        trades: { ...SESSION_VIEW.trades, settled: 1, won: 1, profit: money('0.85') },
        lastIntent: live(TradeIntentStatus.ManualReview),
        balance: { available: money(available), ageSec, current: false },
      });
    const older = onReview('10000', 50);
    const moved = onReview('10000.85', 50);
    const { tracker, request, target } = setup({
      script: [onReview('10000', 5), older, moved],
    });
    const { edits, edit } = target();
    tracker.track(request({ view: onReview('10000', 5), edit }));
    await vi.advanceTimersByTimeAsync(FIRST + POLL);
    expect(edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(texts(edits)).toEqual([shown(moved)]);
  });

  it('hands the edit the view it draws, so the keyboard can follow it', async () => {
    const { tracker, request, target } = setup({ script: [stoppedClosed] });
    const { edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(edit.mock.calls[0]?.[1]).toEqual(stoppedClosed);
  });

  it('finishes on a stopped session whose last trade settled', async () => {
    const { tracker, readSession, request } = setup({ script: [stoppedClosed] });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(tracker.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  it('keeps following a stopped session until its open trade settles', async () => {
    const { tracker, readSession, request, target } = setup({
      script: [stoppedOpen, stoppedOpen, stoppedClosed],
    });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(tracker.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(tracker.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(texts(edits)).toEqual([shown(stoppedOpen), shown(stoppedClosed)]);
    expect(tracker.size()).toBe(0);
    expect(readSession).toHaveBeenCalledTimes(3);
  });

  it('moves a tracked session to the new message and leaves the old one alone', async () => {
    const { tracker, request, target } = setup({ script: [trading, stoppedClosed] });
    const old = target();
    const fresh = target();
    tracker.track(request({ edit: old.edit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(texts(old.edits)).toEqual([shown(trading)]);
    tracker.track(request({ edit: fresh.edit, view: trading }));
    expect(tracker.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(texts(fresh.edits)).toEqual([shown(stoppedClosed)]);
    expect(texts(old.edits)).toEqual([shown(trading)]);
  });

  it('keeps the first deadline when a session moves to a new message', async () => {
    const { tracker, request, target } = setup({ script: [trading] });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(DEADLINE - FIRST);
    const fresh = target();
    tracker.track(request({ edit: fresh.edit, view: trading }));
    await vi.advanceTimersByTimeAsync(FIRST + POLL);
    expect(texts(fresh.edits)).toEqual([shown(trading, true)]);
    expect(tracker.size()).toBe(0);
  });

  // Review m2: the read in flight belongs to the replaced entry, which renders nothing; and after
  // a full poll the old entry is still silent, so it is not polling on.
  it('draws nothing on the old message from a read in flight when the session moves', async () => {
    let release: (view: TradingSessionView) => void = () => {};
    const slow = () =>
      new Promise<TradingSessionView>((resolve) => {
        release = resolve;
      });
    const { tracker, readSession, request, target } = setup({
      script: [slow, stoppedOpen, stoppedClosed],
    });
    const old = target();
    const fresh = target();
    tracker.track(request({ edit: old.edit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    tracker.track(request({ edit: fresh.edit }));
    release(trading);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(old.edits).toEqual([]);
    expect(texts(fresh.edits)).toEqual([shown(stoppedOpen), shown(stoppedClosed)]);
    // the old entry's one read and the new entry's two: nothing polls for the old message
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(readSession).toHaveBeenCalledTimes(3);
  });

  // the one edit the contract allows: it was already sent when the session moved
  it('lets an edit already in flight land on the old message, and nothing after it', async () => {
    let finishEdit: () => void = () => {};
    const { tracker, readSession, request, target } = setup({
      script: [trading, stoppedOpen, stoppedClosed],
    });
    const old = target();
    const heldEdit = vi.fn<SessionTrackRequest['edit']>((text) => {
      old.edits.push(text);
      return new Promise((resolve) => {
        finishEdit = () => resolve(true);
      });
    });
    const fresh = target();
    tracker.track(request({ edit: heldEdit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(texts(old.edits)).toEqual([shown(trading)]);
    tracker.track(request({ edit: fresh.edit, view: trading }));
    finishEdit();
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(texts(old.edits)).toEqual([shown(trading)]);
    expect(texts(fresh.edits)).toEqual([shown(stoppedOpen), shown(stoppedClosed)]);
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(readSession).toHaveBeenCalledTimes(3);
  });

  // review m3: a replaced entry's 404 is not drawn on the old message either
  it('draws no 404 on the old message when the session moved during the read', async () => {
    let fail: (error: Error) => void = () => {};
    const slow = () =>
      new Promise<TradingSessionView>((_resolve, reject) => {
        fail = reject;
      });
    const { tracker, request, target } = setup({ script: [slow, trading] });
    const old = target();
    const fresh = target();
    tracker.track(request({ edit: old.edit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    tracker.track(request({ edit: fresh.edit }));
    fail(new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: SESSION_NOT_FOUND }));
    await vi.advanceTimersByTimeAsync(0);
    expect(old.edits).toEqual([]);
    expect(tracker.size()).toBe(1);
  });

  // review m3: stop() drains the replaced entry's read, which still draws nothing
  it('draws nothing on the old message from a read stop() drains after the session moved', async () => {
    let release: (view: TradingSessionView) => void = () => {};
    const slow = () =>
      new Promise<TradingSessionView>((resolve) => {
        release = resolve;
      });
    const { tracker, request, target } = setup({ script: [slow] });
    const old = target();
    tracker.track(request({ edit: old.edit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    tracker.track(request({ edit: target().edit }));
    const stopping = tracker.stop();
    release(trading);
    await stopping;
    expect(old.edits).toEqual([]);
  });

  // review Major 1: a session stopped on manual review is not «ещё идёт» at the deadline
  it('gives a stopped session its plain final status at the deadline', async () => {
    const reviewed = sessionView({
      ...stoppedWith(live(TradeIntentStatus.ManualReview)),
      stopReason: TradingSessionStopReason.ManualReview,
    });
    const { tracker, request, target } = setup({ script: [reviewed] });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(DEADLINE + POLL);
    expect(tracker.size()).toBe(0);
    expect(edits.at(-1)?.value).toBe(shown(reviewed));
    expect(edits.at(-1)?.value).not.toContain(TEXTS.sessionDeadline.value);
  });

  it('points at the refresh button past the deadline for a live session', async () => {
    const { tracker, request, target } = setup({ script: [SESSION_VIEW] });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(DEADLINE + POLL);
    expect(texts(edits)).toEqual([shown(SESSION_VIEW, true)]);
    expect(edits[0]?.value).toContain(TEXTS.sessionDeadline.value);
    expect(tracker.size()).toBe(0);
  });

  it('says the status is unavailable on a 404 and stops', async () => {
    const { tracker, readSession, request, target, logger } = setup({
      script: [
        new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: SESSION_NOT_FOUND }),
      ],
    });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(texts(edits)).toEqual([TEXTS.sessionStatusUnavailable.value]);
    // #350: the session is gone, so its keyboard is the menu only
    expect(edit.mock.calls.map((call) => call[2])).toEqual(['not_found']);
    expect(readSession).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs a failed read once and retries it', async () => {
    const failure = new BackendError(BackendErrorCode.HttpStatus, { status: 500 });
    const { tracker, readSession, request, target, logger } = setup({
      script: [failure, failure, stoppedClosed],
    });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(readSession).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
      'trading session status not read',
    ]);
    expect(texts(edits)).toEqual([shown(stoppedClosed)]);
  });

  it('stops when the message is gone', async () => {
    const { tracker, readSession, request } = setup({ script: [trading] });
    tracker.track(request({ edit: () => Promise.reject(GONE()) }));
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(tracker.size()).toBe(0);
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  it('logs and stops on a throw that is not the backend or Telegram', async () => {
    const { tracker, request, logger } = setup({ script: [new TypeError('bug')] });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(tracker.size()).toBe(0);
    expect(logger.error.mock.calls.map((call) => call[1])).toEqual([
      'trading session tracking failed',
    ]);
  });

  it('drains the attempt in flight on stop and refuses new entries after it', async () => {
    let release: (view: TradingSessionView) => void = () => {};
    const slow = () =>
      new Promise<TradingSessionView>((resolve) => {
        release = resolve;
      });
    const { tracker, readSession, request, target } = setup({ script: [slow] });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    let stopped = false;
    const stopping = tracker.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release(trading);
    await stopping;
    expect(texts(edits)).toEqual([shown(trading)]);
    tracker.track(request({ sessionId: '00000000-0000-4000-8000-000000000000' }));
    expect(tracker.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry at the bound', async () => {
    const { tracker, readSession, request } = setup({ script: [SESSION_VIEW], maxEntries: 2 });
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    for (const sessionId of ids) tracker.track(request({ sessionId }));
    expect(tracker.size()).toBe(2);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(readSession.mock.calls.map((call) => call[0])).toEqual(ids.slice(1));
  });
});
