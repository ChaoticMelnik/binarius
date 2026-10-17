import { GrammyError, HttpError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pairLabel,
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
  SESSION_RESUME_GAP_MS,
  SESSION_TRACK_DEADLINE_MS,
  SESSION_TRACK_FIRST_POLL_MS,
  SESSION_TRACK_POLL_MS,
} from './timing';

const FIRST = SESSION_TRACK_FIRST_POLL_MS;
const POLL = SESSION_TRACK_POLL_MS;
const DEADLINE = SESSION_TRACK_DEADLINE_MS;
const GAP = SESSION_RESUME_GAP_MS;
const LABEL = pairLabel(PAIR_EURUSD);

const GONE = () =>
  new GrammyError(
    `Call to 'editMessageText' failed!`,
    { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
    'editMessageText',
    {},
  );

const FORBIDDEN = () =>
  new GrammyError(
    `Call to 'editMessageText' failed!`,
    { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    'editMessageText',
    {},
  );

type Answer = TradingSessionView | Error | (() => Promise<TradingSessionView>);

// readSession and recordSessionMessage answer the one script in order and repeat its last entry
function setup({
  script,
  maxEntries,
  forget = () => Promise.resolve(true),
}: {
  script: Answer[];
  maxEntries?: number;
  forget?: BackendClient['forgetSessionMessage'];
}) {
  const logger = fakeLogger();
  let index = 0;
  const answer = (): Promise<TradingSessionView> => {
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (typeof next === 'function') return next();
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(next as TradingSessionView);
  };
  const readSession = vi.fn<BackendClient['readSession']>(answer);
  const recordSessionMessage = vi.fn<BackendClient['recordSessionMessage']>(answer);
  const forgetSessionMessage = vi.fn<BackendClient['forgetSessionMessage']>(forget);
  const tracker = createSessionTracker({
    backend: { readSession, recordSessionMessage, forgetSessionMessage },
    logger,
    firstPollMs: FIRST,
    pollMs: POLL,
    deadlineMs: DEADLINE,
    resumeGapMs: GAP,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
  const target = () => {
    const edits: TelegramHtml[] = [];
    const edit = vi.fn<SessionTrackRequest['edit']>((...[text]) => {
      edits.push(text);
      return Promise.resolve(true);
    });
    return { edits, edit };
  };
  const request = (patch: Partial<SessionTrackRequest> = {}): SessionTrackRequest => ({
    sessionId: SESSION_ID,
    telegramUserId: String(USER.id),
    messageId: MESSAGE_ID,
    label: LABEL,
    view: SESSION_VIEW,
    record: false,
    edit: target().edit,
    card: vi.fn<SessionTrackRequest['card']>(() => Promise.resolve()),
    ...patch,
  });
  return {
    tracker,
    readSession,
    recordSessionMessage,
    forgetSessionMessage,
    logger,
    request,
    target,
  };
}

const MESSAGE_ID = 77;

const shown = (view: TradingSessionView) => sessionStatusText(LABEL, view).value;
const texts = (edits: readonly TelegramHtml[]) => edits.map((text) => text.value);

const live = (status: TradeIntentStatus) => intentView({ status });
const money = (value: string) => value as DecimalString;
const trading = sessionView({ lastIntent: live(TradeIntentStatus.Accepted) });
// the backend has sent its summary message (#464) unless a case says otherwise
const stoppedWith = (lastIntent: TradingSessionView['lastIntent']) =>
  sessionView({
    status: TradingSessionStatus.Stopped,
    stopReason: TradingSessionStopReason.UserStopped,
    endedAt: '2026-10-07T10:05:00.000Z',
    lastIntent,
    noticesDone: true,
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

  // #536: the message prints nothing of the trades, so it is edited once, when the session stops
  it('no edit while the text is the same: one edit when the session stops', async () => {
    const tradedOn = sessionView({ ...trading, ...settledOne });
    const { tracker, readSession, request, target } = setup({
      script: [SESSION_VIEW, trading, tradedOn, stoppedClosed],
    });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(readSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readSession).toHaveBeenCalledWith(SESSION_ID, String(USER.id));
    expect(edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL * 2);
    expect(edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(texts(edits)).toEqual([shown(stoppedClosed)]);
    expect(tracker.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(readSession).toHaveBeenCalledTimes(4);
  });

  // #536: the balance is the summary's (#464), not the session message's
  it('K1 a session on manual review: no edit when its balance or its age moves', async () => {
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
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(edits).toEqual([]);
    expect(shown(moved)).toBe(shown(older));
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
    // the same end line: the settle changes nothing it prints
    expect(texts(edits)).toEqual([shown(stoppedOpen)]);
    expect(tracker.size()).toBe(0);
    expect(readSession).toHaveBeenCalledTimes(3);
  });

  it('moves a tracked session to the new message and leaves the old one alone', async () => {
    const { tracker, request, target } = setup({ script: [stoppedOpen, stoppedClosed] });
    const old = target();
    const fresh = target();
    tracker.track(request({ edit: old.edit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(texts(old.edits)).toEqual([shown(stoppedOpen)]);
    // the new message was sent while the session ran
    tracker.track(request({ edit: fresh.edit, view: SESSION_VIEW }));
    expect(tracker.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(texts(fresh.edits)).toEqual([shown(stoppedClosed)]);
    expect(texts(old.edits)).toEqual([shown(stoppedOpen)]);
  });

  it('keeps the first deadline when a session moves to a new message', async () => {
    const { tracker, request, target } = setup({ script: [trading] });
    tracker.track(request());
    await vi.advanceTimersByTimeAsync(DEADLINE - FIRST);
    const fresh = target();
    tracker.track(request({ edit: fresh.edit, view: trading }));
    await vi.advanceTimersByTimeAsync(FIRST + POLL);
    // past the first deadline: ended, nothing to draw over the same text
    expect(fresh.edits).toEqual([]);
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
    release(stoppedOpen);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(old.edits).toEqual([]);
    expect(texts(fresh.edits)).toEqual([shown(stoppedOpen)]);
    // the old entry's one read and the new entry's two: nothing polls for the old message
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(readSession).toHaveBeenCalledTimes(3);
  });

  // the one edit the contract allows: it was already sent when the session moved
  it('lets an edit already in flight land on the old message, and nothing after it', async () => {
    let finishEdit: () => void = () => {};
    const { tracker, readSession, request, target } = setup({
      script: [stoppedOpen, stoppedClosed],
    });
    const old = target();
    const heldEdit = vi.fn<SessionTrackRequest['edit']>((...[text]) => {
      old.edits.push(text);
      return new Promise((resolve) => {
        finishEdit = () => resolve(true);
      });
    });
    const fresh = target();
    tracker.track(request({ edit: heldEdit }));
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(texts(old.edits)).toEqual([shown(stoppedOpen)]);
    tracker.track(request({ edit: fresh.edit, view: SESSION_VIEW }));
    finishEdit();
    await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
    expect(texts(old.edits)).toEqual([shown(stoppedOpen)]);
    expect(texts(fresh.edits)).toEqual([shown(stoppedClosed)]);
    await vi.advanceTimersByTimeAsync(POLL * 3);
    expect(readSession).toHaveBeenCalledTimes(2);
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
  });

  // #536: no hint and no button past the deadline: the text on screen is the live one already
  it('ends a live session at the deadline with no edit', async () => {
    const { tracker, request, target } = setup({ script: [SESSION_VIEW] });
    const { edits, edit } = target();
    tracker.track(request({ edit }));
    await vi.advanceTimersByTimeAsync(DEADLINE + POLL);
    expect(edits).toEqual([]);
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
    const { tracker, readSession, request } = setup({ script: [stoppedOpen] });
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
    release(stoppedOpen);
    await stopping;
    expect(texts(edits)).toEqual([shown(stoppedOpen)]);
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

  describe('the summary card (#318)', () => {
    const TRANSIENT = () =>
      new GrammyError(
        `Call to 'editMessageText' failed!`,
        { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1' },
        'editMessageText',
        {},
      );
    const cardSpy = () => vi.fn<SessionTrackRequest['card']>(() => Promise.resolve());

    it('C1 sends the card once, after the final edit, with the final view', async () => {
      const order: string[] = [];
      const { tracker, request } = setup({ script: [trading, stoppedOpen, stoppedClosed] });
      const card = vi.fn<SessionTrackRequest['card']>(() => {
        order.push('card');
        return Promise.resolve();
      });
      const edit = vi.fn<SessionTrackRequest['edit']>(() => {
        order.push('edit');
        return Promise.resolve(true);
      });
      tracker.track(request({ edit, card }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(card).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(POLL * 3);
      expect(card).toHaveBeenCalledTimes(1);
      expect(card).toHaveBeenCalledWith(stoppedClosed);
      expect(order).toEqual(['edit', 'card']);
      expect(tracker.size()).toBe(0);
    });

    it('C2 a session already done when tracked (a refresh) gets its card on the first poll', async () => {
      const { tracker, request, target } = setup({ script: [stoppedClosed] });
      const { edits, edit } = target();
      const card = cardSpy();
      tracker.track(request({ view: stoppedClosed, edit, card }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(edits).toEqual([]);
      expect(card).toHaveBeenCalledTimes(1);
      expect(tracker.size()).toBe(0);
    });

    it('C3 waits for the final edit to land: no card while it fails, one once it lands', async () => {
      const { tracker, request, forgetSessionMessage } = setup({ script: [stoppedClosed] });
      let failures = 2;
      const edit = vi.fn<SessionTrackRequest['edit']>(() =>
        failures-- > 0 ? Promise.reject(TRANSIENT()) : Promise.resolve(true),
      );
      const card = cardSpy();
      tracker.track(request({ edit, card }));
      await vi.advanceTimersByTimeAsync(FIRST + POLL);
      expect(edit).toHaveBeenCalledTimes(2);
      expect(card).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(POLL * 3);
      expect(card).toHaveBeenCalledTimes(1);
      expect(tracker.size()).toBe(0);
      expect(forgetSessionMessage).not.toHaveBeenCalled();
    });

    it('C4 a session not done sends no card, through the deadline', async () => {
      const reviewed = sessionView({
        ...stoppedWith(live(TradeIntentStatus.ManualReview)),
        stopReason: TradingSessionStopReason.ManualReview,
      });
      for (const view of [trading, stoppedOpen, reviewed]) {
        const { tracker, request } = setup({ script: [view] });
        const card = cardSpy();
        tracker.track(request({ card }));
        await vi.advanceTimersByTimeAsync(DEADLINE + POLL);
        expect(tracker.size()).toBe(0);
        expect(card).not.toHaveBeenCalled();
      }
    });

    // the poll past the deadline fails its edit too; the deadline's own last edit then lands
    it('C5 at the deadline, a done session whose last edit lands there gets its card', async () => {
      const { tracker, request, forgetSessionMessage } = setup({ script: [stoppedClosed] });
      const started = Date.now();
      let late = 0;
      const edit = vi.fn<SessionTrackRequest['edit']>(() => {
        if (Date.now() - started < DEADLINE) return Promise.reject(TRANSIENT());
        late += 1;
        return late === 1 ? Promise.reject(TRANSIENT()) : Promise.resolve(true);
      });
      const card = cardSpy();
      tracker.track(request({ edit, card }));
      await vi.advanceTimersByTimeAsync(DEADLINE - POLL);
      expect(card).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(POLL * 3);
      expect(late).toBe(2);
      expect(card).toHaveBeenCalledTimes(1);
      expect(tracker.size()).toBe(0);
      expect(forgetSessionMessage).not.toHaveBeenCalled();
    });

    it('C6 a card that throws still ends the entry, logged as a tracking failure', async () => {
      const { tracker, request, logger } = setup({ script: [stoppedClosed] });
      const card = vi.fn<SessionTrackRequest['card']>(() => Promise.reject(new TypeError('bug')));
      tracker.track(request({ card }));
      await vi.advanceTimersByTimeAsync(FIRST + POLL * 3);
      expect(card).toHaveBeenCalledTimes(1);
      expect(tracker.size()).toBe(0);
      expect(logger.error.mock.calls.map((call) => call[1])).toEqual([
        'trading session tracking failed',
      ]);
    });

    // #464: the card comes after the backend's summary message, never before it
    const unsent = sessionView({ ...stoppedClosed, noticesDone: false });

    it('C8 a done session whose summary message is not sent yet keeps polling, with no card and no edit', async () => {
      const { tracker, request, readSession, target } = setup({
        script: [unsent, unsent, stoppedClosed],
      });
      const { edits, edit } = target();
      const card = cardSpy();
      tracker.track(request({ view: unsent, edit, card }));
      await vi.advanceTimersByTimeAsync(FIRST + POLL);
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(card).not.toHaveBeenCalled();
      expect(tracker.size()).toBe(1);
      expect(edits).toEqual([]);
      await vi.advanceTimersByTimeAsync(POLL);
      expect(card).toHaveBeenCalledTimes(1);
      expect(card).toHaveBeenCalledWith(stoppedClosed);
      expect(tracker.size()).toBe(0);
    });

    it('C9 at the deadline, a done session without its summary message gets its final edit and no card', async () => {
      const { tracker, request, target } = setup({ script: [unsent] });
      const { edits, edit } = target();
      const card = cardSpy();
      tracker.track(request({ edit, card }));
      await vi.advanceTimersByTimeAsync(DEADLINE + POLL);
      // the poll's edit only: the deadline does not draw the same final status again
      expect(texts(edits)).toEqual([shown(unsent)]);
      expect(card).not.toHaveBeenCalled();
      expect(tracker.size()).toBe(0);
    });

    it('C7 stop() waits for the card in flight', async () => {
      let release: () => void = () => {};
      const card = vi.fn<SessionTrackRequest['card']>(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { tracker, request } = setup({ script: [stoppedClosed] });
      tracker.track(request({ card }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(card).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = tracker.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(stopped).toBe(true);
    });
  });

  describe('the status message recorded and recovered (#567)', () => {
    const FAILURE = () => new BackendError(BackendErrorCode.HttpStatus, { status: 500 });
    const NOT_FOUND = () =>
      new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: SESSION_NOT_FOUND });

    it('P1 the first poll records the message and reads its view; the next one only reads', async () => {
      const { tracker, readSession, recordSessionMessage, request, target } = setup({
        script: [trading, stoppedClosed],
      });
      const { edits, edit } = target();
      tracker.track(request({ record: true, edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(recordSessionMessage.mock.calls).toEqual([
        [SESSION_ID, String(USER.id), MESSAGE_ID, undefined],
      ]);
      expect(readSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(POLL);
      expect(recordSessionMessage).toHaveBeenCalledTimes(1);
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(texts(edits)).toEqual([shown(stoppedClosed)]);
    });

    it('P8 a record names the message it replaces; the next poll only reads', async () => {
      const { tracker, readSession, recordSessionMessage, request } = setup({ script: [trading] });
      tracker.track(request({ record: true, replacesMessageId: 76 }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(recordSessionMessage.mock.calls).toEqual([
        [SESSION_ID, String(USER.id), MESSAGE_ID, 76],
      ]);
      expect(readSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(POLL);
      expect(readSession).toHaveBeenCalledTimes(1);
    });

    it('P2 a failed record is asked again on the next poll, logged once', async () => {
      const { tracker, readSession, recordSessionMessage, request, logger } = setup({
        script: [FAILURE(), FAILURE(), trading],
      });
      tracker.track(request({ record: true }));
      await vi.advanceTimersByTimeAsync(FIRST + POLL * 3);
      expect(recordSessionMessage).toHaveBeenCalledTimes(3);
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
        'trading session status not read',
      ]);
    });

    it("P4 the deadline counts from the request's startedAt", async () => {
      const { tracker, readSession, request } = setup({ script: [SESSION_VIEW] });
      tracker.track(request({ view: null, startedAt: Date.now() - DEADLINE + FIRST + POLL }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(tracker.size()).toBe(1);
      await vi.advanceTimersByTimeAsync(POLL * 3);
      expect(tracker.size()).toBe(0);
      expect(readSession).toHaveBeenCalledTimes(2);
    });

    it('P5 has() answers for a tracked session only', async () => {
      const { tracker, request } = setup({ script: [stoppedClosed] });
      expect(tracker.has(SESSION_ID)).toBe(false);
      tracker.track(request());
      expect(tracker.has(SESSION_ID)).toBe(true);
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(tracker.has(SESSION_ID)).toBe(false);
    });

    it('P6 a 404 on the record says the status is unavailable and stops', async () => {
      const { tracker, readSession, recordSessionMessage, request, target } = setup({
        script: [NOT_FOUND()],
      });
      const { edits, edit } = target();
      tracker.track(request({ record: true, edit }));
      await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
      expect(texts(edits)).toEqual([TEXTS.sessionStatusUnavailable.value]);
      expect(recordSessionMessage).toHaveBeenCalledTimes(1);
      expect(readSession).not.toHaveBeenCalled();
      expect(tracker.size()).toBe(0);
    });

    // a recovered session past the deadline: the first poll draws the final text, at most once
    const past = () => Date.now() - DEADLINE - 1;
    const reviewed = sessionView({
      ...stoppedWith(live(TradeIntentStatus.ManualReview)),
      stopReason: TradingSessionStopReason.ManualReview,
    });
    const unsent = sessionView({ ...stoppedClosed, noticesDone: false });

    it('P7a past the deadline, an active session on a screen this process did not draw: no edit, and it ends', async () => {
      const { tracker, readSession, request, target } = setup({ script: [SESSION_VIEW] });
      const { edits, edit } = target();
      tracker.track(request({ view: null, startedAt: past(), edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(edits).toEqual([]);
      expect(tracker.size()).toBe(0);
      await vi.advanceTimersByTimeAsync(POLL * 3);
      expect(readSession).toHaveBeenCalledTimes(1);
    });

    it('P7b past the deadline, a stopped session on review is drawn once, with no hint', async () => {
      const { tracker, request, target } = setup({ script: [reviewed] });
      const { edits, edit } = target();
      tracker.track(request({ view: null, startedAt: past(), edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(edits)).toEqual([shown(reviewed)]);
      expect(tracker.size()).toBe(0);
    });

    it('P7c past the deadline, a done session without its summary message is drawn once, no card', async () => {
      const { tracker, request, target } = setup({ script: [unsent] });
      const { edits, edit } = target();
      const card = vi.fn<SessionTrackRequest['card']>(() => Promise.resolve());
      tracker.track(request({ view: null, startedAt: past(), edit, card }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(edits)).toEqual([shown(unsent)]);
      expect(card).not.toHaveBeenCalled();
      expect(tracker.size()).toBe(0);
    });

    it('P7d past the deadline, a done session with its summary message gets one edit and its card', async () => {
      const { tracker, request, target } = setup({ script: [stoppedClosed] });
      const { edits, edit } = target();
      const card = vi.fn<SessionTrackRequest['card']>(() => Promise.resolve());
      tracker.track(request({ view: null, startedAt: past(), edit, card }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(edits)).toEqual([shown(stoppedClosed)]);
      expect(card.mock.calls).toEqual([[stoppedClosed]]);
      expect(tracker.size()).toBe(0);
    });

    it('P7e past the deadline, a failed first read ends the entry with no edit and no error', async () => {
      const { tracker, request, target, logger } = setup({ script: [FAILURE()] });
      const { edits, edit } = target();
      tracker.track(request({ view: null, startedAt: past(), edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(edits).toEqual([]);
      expect(tracker.size()).toBe(0);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('P7f a 404 for an entry with no view draws the unavailable text with no view', async () => {
      const { tracker, request, target } = setup({ script: [NOT_FOUND()] });
      const { edits, edit } = target();
      tracker.track(request({ view: null, startedAt: past(), edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(edits)).toEqual([TEXTS.sessionStatusUnavailable.value]);
      expect(edit.mock.calls.map((call) => call.slice(1))).toEqual([[null, 'not_found']]);
      expect(tracker.size()).toBe(0);
    });
  });

  // A recovered entry draws only a stopped session (#536, mayDraw): its message may be one sent
  // before #536, whose «🔄»/«⏹» stay while the session runs (owner's answer 5)
  describe('a message sent before #536 (#536)', () => {
    const recovered = { view: null, record: false } as const;

    it('R1 a running session is read, not drawn, until it stops; then one edit with its view', async () => {
      const { tracker, readSession, request, target } = setup({
        script: [SESSION_VIEW, trading, stoppedClosed],
      });
      const { edits, edit } = target();
      tracker.track(request({ ...recovered, edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(edits).toEqual([]);
      await vi.advanceTimersByTimeAsync(POLL);
      expect(edits).toEqual([]);
      await vi.advanceTimersByTimeAsync(POLL);
      expect(texts(edits)).toEqual([shown(stoppedClosed)]);
      expect(edit.mock.calls.map((call) => call.slice(1))).toEqual([[stoppedClosed]]);
    });

    it('R2 a stopped session is drawn on the first poll', async () => {
      const { tracker, request, target } = setup({ script: [stoppedOpen] });
      const { edits, edit } = target();
      tracker.track(request({ ...recovered, edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(edits)).toEqual([shown(stoppedOpen)]);
      expect(tracker.size()).toBe(1);
    });
  });

  // Telegram refused the edit for good (#567 review round 1, Major 1): the backend forgets the
  // message, so the session leaves the recovery list instead of being tracked on every pass
  describe('a lost status message (#567)', () => {
    const recovered = { view: null, record: false } as const;

    it('K-lost1 a gone edit on the first poll reports the message lost once and ends', async () => {
      const { tracker, readSession, forgetSessionMessage, request } = setup({
        script: [stoppedClosed],
      });
      const card = vi.fn<SessionTrackRequest['card']>(() => Promise.resolve());
      tracker.track(request({ ...recovered, edit: () => Promise.reject(GONE()), card }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(forgetSessionMessage.mock.calls).toEqual([[SESSION_ID, String(USER.id), MESSAGE_ID]]);
      expect(tracker.size()).toBe(0);
      await vi.advanceTimersByTimeAsync(POLL * 3);
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(card).not.toHaveBeenCalled();
    });

    it('K-lost2 a 403 edit is lost the same way, not retried', async () => {
      const { tracker, readSession, forgetSessionMessage, request } = setup({
        script: [stoppedClosed],
      });
      const edit = vi.fn<SessionTrackRequest['edit']>(() => Promise.reject(FORBIDDEN()));
      tracker.track(request({ ...recovered, edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(forgetSessionMessage.mock.calls).toEqual([[SESSION_ID, String(USER.id), MESSAGE_ID]]);
      expect(tracker.size()).toBe(0);
      await vi.advanceTimersByTimeAsync(POLL * 3);
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(edit).toHaveBeenCalledTimes(1);
    });

    it('K-lost3 a failed report is one warn, no tracking failure, and the entry ends', async () => {
      const { tracker, forgetSessionMessage, request, logger } = setup({
        script: [stoppedClosed],
        forget: () =>
          Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 500 })),
      });
      tracker.track(request({ ...recovered, edit: () => Promise.reject(GONE()) }));
      await vi.advanceTimersByTimeAsync(FIRST + POLL * 3);
      expect(forgetSessionMessage).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([
        'trading session message not edited',
        'trading session message not forgotten',
      ]);
      expect(logger.error).not.toHaveBeenCalled();
      expect(tracker.size()).toBe(0);
    });

    it('K-lost4 a gone edit of the unavailable text on a 404 reports nothing', async () => {
      const { tracker, forgetSessionMessage, request } = setup({
        script: [
          new BackendError(BackendErrorCode.HttpStatus, { status: 404, reason: SESSION_NOT_FOUND }),
        ],
      });
      tracker.track(request({ ...recovered, edit: () => Promise.reject(GONE()) }));
      await vi.advanceTimersByTimeAsync(FIRST + POLL * 2);
      expect(forgetSessionMessage).not.toHaveBeenCalled();
      expect(tracker.size()).toBe(0);
    });

    // the poll past the deadline fails its edit as a transport error; the deadline's own last edit
    // (next()) is the one refused with 403
    it("K-lost5 a pressed entry's last edit at the deadline refused with 403 reports the loss once", async () => {
      const { tracker, forgetSessionMessage, request } = setup({ script: [stoppedClosed] });
      const started = Date.now();
      let late = 0;
      const card = vi.fn<SessionTrackRequest['card']>(() => Promise.resolve());
      const edit = vi.fn<SessionTrackRequest['edit']>(() => {
        if (Date.now() - started < DEADLINE) {
          return Promise.reject(new HttpError('network', new Error('reset')));
        }
        late += 1;
        return Promise.reject(
          late === 1 ? new HttpError('network', new Error('reset')) : FORBIDDEN(),
        );
      });
      tracker.track(request({ record: true, edit, card }));
      await vi.advanceTimersByTimeAsync(DEADLINE - POLL);
      expect(forgetSessionMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(POLL * 3);
      expect(late).toBe(2);
      expect(forgetSessionMessage.mock.calls).toEqual([[SESSION_ID, String(USER.id), MESSAGE_ID]]);
      expect(card).not.toHaveBeenCalled();
      expect(tracker.size()).toBe(0);
    });
  });

  // A pass hands the tracker up to TRACKED_SESSIONS_MAX recovered entries at once (#567 review
  // round 2, Major 1): their first polls go in slots GAP apart, so a restart is no burst
  describe('the recovered entries paced (#567)', () => {
    // a stopped session whose trade is still open: drawn once, and followed on (mayDraw, #536)
    const idOf = (i: number) => `00000000-0000-4000-8000-00000000010${i}`;
    const recovered = (i: number) => ({ sessionId: idOf(i), view: null, record: false }) as const;
    const readsOf = (readSession: { mock: { calls: unknown[][] } }, id: string) =>
      readSession.mock.calls.filter((call) => call[0] === id).length;

    it('W1 five recovered entries tracked at once edit one a slot, never two in one GAP', async () => {
      const { tracker, readSession, request, target } = setup({ script: [stoppedOpen] });
      const { edits, edit } = target();
      for (let i = 0; i < 5; i += 1) tracker.track(request({ ...recovered(i), edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(edits).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(GAP - 1);
      expect(edits).toHaveLength(1);
      for (let slot = 2; slot <= 5; slot += 1) {
        await vi.advanceTimersByTimeAsync(1);
        expect(edits).toHaveLength(slot);
        await vi.advanceTimersByTimeAsync(GAP - 1);
        expect(edits).toHaveLength(slot);
      }
      expect(readSession).toHaveBeenCalledTimes(5);
    });

    it('W2 a pressed entry tracked after recovered ones polls at FIRST, not after the slots', async () => {
      const { tracker, recordSessionMessage, request } = setup({ script: [stoppedOpen] });
      for (let i = 0; i < 3; i += 1) tracker.track(request(recovered(i)));
      tracker.track(request({ sessionId: idOf(9), record: true }));
      await vi.advanceTimersByTimeAsync(FIRST - 1);
      expect(recordSessionMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recordSessionMessage).toHaveBeenCalledTimes(1);
    });

    it('W3 the slots carry over between calls, and an idle pacer adds no wait', async () => {
      const { tracker, readSession, request } = setup({ script: [stoppedOpen] });
      tracker.track(request(recovered(0)));
      tracker.track(request(recovered(1)));
      tracker.track(request(recovered(2)));
      await vi.advanceTimersByTimeAsync(FIRST + 2 * GAP - 1);
      expect(readsOf(readSession, idOf(2))).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(readsOf(readSession, idOf(2))).toBe(1);
      await vi.advanceTimersByTimeAsync(POLL);
      tracker.track(request(recovered(3)));
      await vi.advanceTimersByTimeAsync(FIRST - 1);
      expect(readsOf(readSession, idOf(3))).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(readsOf(readSession, idOf(3))).toBe(1);
    });

    it('W4 a press on a recovered entry waiting for its slot polls at FIRST, and the slot polls nothing', async () => {
      const { tracker, readSession, recordSessionMessage, request } = setup({
        script: [stoppedOpen],
      });
      for (let i = 0; i < 3; i += 1) tracker.track(request(recovered(i)));
      tracker.track(request({ sessionId: idOf(2), record: true }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(recordSessionMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3 * GAP);
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(readsOf(readSession, idOf(2))).toBe(0);
    });

    it('W5 stop() clears the pending slots', async () => {
      const { tracker, readSession, request } = setup({ script: [stoppedOpen] });
      for (let i = 0; i < 3; i += 1) tracker.track(request(recovered(i)));
      await tracker.stop();
      await vi.advanceTimersByTimeAsync(FIRST + 3 * GAP);
      expect(readSession).not.toHaveBeenCalled();
    });
  });

  // What this process drew on a message is remembered (#567 review round 2, Major 1): a recovered
  // entry of it edits only when what it prints changed, so a stuck session costs a pass one read
  describe('what was drawn remembered (#567)', () => {
    const past = () => Date.now() - DEADLINE - 1;
    const reviewed = sessionView({
      ...stoppedWith(live(TradeIntentStatus.ManualReview)),
      stopReason: TradingSessionStopReason.ManualReview,
    });
    // what it prints changed: another stop reason (an old text on screen, #536)
    const moved = sessionView({ ...reviewed, stopReason: TradingSessionStopReason.UserStopped });
    const recovered = { view: null, record: false } as const;

    it('Y1 a stuck session recovered again on its message reads once more and does not edit', async () => {
      const { tracker, readSession, request, target } = setup({ script: [reviewed] });
      const first = target();
      tracker.track(request({ ...recovered, startedAt: past(), edit: first.edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(first.edits).toHaveLength(1);
      expect(tracker.size()).toBe(0);
      const second = target();
      tracker.track(request({ ...recovered, startedAt: past(), edit: second.edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(second.edits).toEqual([]);
      expect(tracker.size()).toBe(0);
    });

    it('Y2 the same, when what it prints changed, edits once', async () => {
      const { tracker, request, target } = setup({ script: [reviewed, moved] });
      tracker.track(request({ ...recovered, startedAt: past(), edit: target().edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      const second = target();
      tracker.track(request({ ...recovered, startedAt: past(), edit: second.edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(second.edits)).toEqual([shown(moved)]);
    });

    it("Y3 a recovered entry on another message does not use the first message's memory", async () => {
      const { tracker, request, target } = setup({ script: [reviewed] });
      tracker.track(request({ ...recovered, startedAt: past(), edit: target().edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      const second = target();
      tracker.track(
        request({ ...recovered, messageId: MESSAGE_ID + 1, startedAt: past(), edit: second.edit }),
      );
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(second.edits)).toEqual([shown(reviewed)]);
    });

    // #570 Minor 1: the key is the printed text, so a label the memory did not draw is drawn
    it('Y5 a recovered entry with another label than the one drawn edits once', async () => {
      const { tracker, request, target } = setup({ script: [reviewed] });
      tracker.track(request({ ...recovered, startedAt: past(), edit: target().edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      const second = target();
      tracker.track(request({ ...recovered, label: null, startedAt: past(), edit: second.edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(second.edits)).toEqual([sessionStatusText(null, reviewed).value]);
      expect(texts(second.edits)).not.toEqual([shown(reviewed)]);
    });

    it('Y4 a lost message leaves no memory: the next entry of it edits again', async () => {
      const { tracker, forgetSessionMessage, request, target } = setup({
        script: [stoppedOpen],
      });
      tracker.track(request({ view: SESSION_VIEW, edit: () => Promise.reject(FORBIDDEN()) }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(forgetSessionMessage).toHaveBeenCalledTimes(1);
      expect(tracker.size()).toBe(0);
      const second = target();
      tracker.track(request({ ...recovered, edit: second.edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(second.edits)).toEqual([shown(stoppedOpen)]);
    });

    // #587 finding 2: only this process's own draws enter the memory, so a recovered entry that
    // only read leaves nothing that would let mayDraw edit a running session's message
    it('Y6 an entry this process did not draw leaves no memory: a running session recovered again with another label is not drawn; drawn once at the stop', async () => {
      const { tracker, readSession, request, target } = setup({
        script: [SESSION_VIEW, SESSION_VIEW, stoppedClosed],
      });
      const first = target();
      tracker.track(request({ ...recovered, startedAt: past(), edit: first.edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(first.edits).toEqual([]);
      expect(tracker.size()).toBe(0);
      const second = target();
      tracker.track(request({ ...recovered, label: null, startedAt: past(), edit: second.edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(readSession).toHaveBeenCalledTimes(2);
      expect(second.edits).toEqual([]);
      const third = target();
      tracker.track(request({ ...recovered, label: null, edit: third.edit }));
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(texts(third.edits)).toEqual([sessionStatusText(null, stoppedClosed).value]);
    });
  });
});
