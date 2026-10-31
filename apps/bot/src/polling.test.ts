import { BotError, GrammyError, HttpError, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_UPDATES } from './lifecycle';
import { createPollingLoop, updateKey, type PollingBot } from './polling';
import { fakeLogger } from './testing';

// #869: the polling loop over a fake Bot on fake timers — the order of one user's updates, the
// capacity, the offset, the stop and the retries, each read off the calls the loop makes.

const A = 101;
const B = 202;
const RETRY_MS = 3_000;

const message = (updateId: number, userId: number): Update =>
  ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: userId, type: 'private', first_name: 'u' },
      from: { id: userId, is_bot: false, first_name: 'u' },
      text: 'x',
    },
  }) as unknown as Update;

const refusal = (error_code: number, retry_after?: number) =>
  new GrammyError(
    'refused',
    {
      ok: false,
      error_code,
      description: 'refused',
      ...(retry_after === undefined ? {} : { parameters: { retry_after } }),
    },
    'getUpdates',
    {},
  );
const transportFailure = () => new HttpError('Network request failed', new Error('aborted'));

interface Poll {
  payload: Record<string, unknown>;
  signal: AbortSignal | undefined;
  resolve(updates: Update[]): void;
  reject(error: unknown): void;
}

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await vi.advanceTimersByTimeAsync(0);
};

function setup({ concurrency = 8 }: { concurrency?: number } = {}) {
  const events: string[] = [];
  const polls: Poll[] = [];
  const confirmations: Record<string, unknown>[] = [];
  const held = new Set<number>();
  const failing = new Set<number>();
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  const handled: number[] = [];
  const logger = fakeLogger();
  const errorHandler = vi.fn<(error: BotError) => void>();
  const bot = {
    init: vi.fn(() => {
      events.push('init');
      return Promise.resolve();
    }),
    handleUpdate: vi.fn((update: Update) => {
      const id = update.update_id;
      started.push(id);
      if (failing.has(id)) {
        return Promise.reject(new BotError(new Error('handler failed'), {} as Context));
      }
      if (!held.has(id)) {
        handled.push(id);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        releases.set(id, () => {
          handled.push(id);
          resolve();
        });
      });
    }),
    errorHandler,
    api: {
      deleteWebhook: vi.fn(() => {
        events.push('deleteWebhook');
        return Promise.resolve(true);
      }),
      getUpdates: vi.fn((payload: Record<string, unknown>, signal?: AbortSignal) => {
        if (payload.timeout === undefined) {
          confirmations.push(payload);
          return Promise.resolve([]);
        }
        events.push('getUpdates');
        return new Promise<Update[]>((resolve, reject) => {
          polls.push({ payload, signal, resolve, reject });
          signal?.addEventListener('abort', () => reject(transportFailure()));
        });
      }),
    },
  };
  const loop = createPollingLoop({
    bot: bot as unknown as PollingBot,
    concurrency,
    retryMs: RETRY_MS,
    logger,
  });
  let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
  let rejection: unknown;
  const start = (onStart?: () => Promise<void>) => {
    const promise = loop.start({
      timeout: 5,
      allowed_updates: ALLOWED_UPDATES,
      onStart: async () => {
        events.push('onStart');
        await onStart?.();
      },
    });
    promise.then(
      () => {
        settled = 'resolved';
      },
      (error: unknown) => {
        settled = 'rejected';
        rejection = error;
      },
    );
    return promise;
  };
  const last = (): Poll => {
    const poll = polls[polls.length - 1];
    if (poll === undefined) throw new Error('no long poll yet');
    return poll;
  };
  return {
    loop,
    bot,
    events,
    polls,
    confirmations,
    held,
    failing,
    started,
    handled,
    logger,
    errorHandler,
    start,
    last,
    release: (id: number) => releases.get(id)?.(),
    settled: () => settled,
    rejection: () => rejection,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPollingLoop (#869)', () => {
  it('P1 starts with getMe, deleteWebhook and onStart, then polls the whole capacity; the next poll confirms the batch without allowed_updates', async () => {
    const s = setup();
    void s.start();
    await flush();

    expect(s.events).toEqual(['init', 'deleteWebhook', 'onStart', 'getUpdates']);
    expect(s.last().payload).toEqual({
      offset: 0,
      limit: 8,
      timeout: 5,
      allowed_updates: ALLOWED_UPDATES,
    });

    s.last().resolve([message(7, A), message(9, B)]);
    await flush();
    expect(s.polls).toHaveLength(2);
    // the two updates were still in work when the next poll went: it asks for what is free
    expect(s.last().payload).toEqual({ offset: 10, limit: 6, timeout: 5 });
    expect(s.handled).toEqual([7, 9]);
  });

  it('P2 handles user B while user A’s handler is held', async () => {
    const s = setup();
    void s.start();
    await flush();
    s.held.add(1);

    s.last().resolve([message(1, A), message(2, B)]);
    await flush();
    expect(s.started).toEqual([1, 2]);
    expect(s.handled).toEqual([2]);

    s.release(1);
    await flush();
    expect(s.handled).toEqual([2, 1]);
  });

  it('P3 runs one user’s updates in their order: A2 starts once A1 is done, A3 right away after both', async () => {
    const s = setup();
    void s.start();
    await flush();
    s.held.add(1);

    s.last().resolve([message(1, A), message(2, A)]);
    await flush();
    expect(s.started).toEqual([1]);

    s.release(1);
    await flush();
    expect(s.started).toEqual([1, 2]);
    expect(s.handled).toEqual([1, 2]);

    s.last().resolve([message(3, A)]);
    await flush();
    expect(s.started).toEqual([1, 2, 3]);
  });

  it('P4 sends no poll while the capacity is full, then asks only for the free slots', async () => {
    const s = setup({ concurrency: 2 });
    void s.start();
    await flush();
    expect(s.last().payload.limit).toBe(2);
    s.held.add(1);
    s.held.add(2);

    s.last().resolve([message(1, A), message(2, B)]);
    await flush();
    expect(s.polls).toHaveLength(1);

    s.release(1);
    await flush();
    expect(s.polls).toHaveLength(2);
    expect(s.last().payload).toEqual({ offset: 3, limit: 1, timeout: 5 });
  });

  it('P5 stops: aborts the long poll, confirms past the last fetched update at once, and settles start() after the held handler and the update behind it', async () => {
    const s = setup();
    void s.start();
    await flush();
    s.held.add(1);

    s.last().resolve([message(1, A), message(2, A), message(3, B)]);
    await flush();
    const open = s.last();
    expect(s.handled).toEqual([3]);

    await s.loop.stop();
    await flush();
    expect(open.signal?.aborted).toBe(true);
    expect(s.confirmations).toEqual([{ offset: 4, limit: 1 }]);
    expect(s.settled()).toBe('pending');

    s.release(1);
    await flush();
    expect(s.handled).toEqual([3, 1, 2]);
    expect(s.settled()).toBe('resolved');
    expect(s.polls).toHaveLength(2);
    expect(s.bot.handleUpdate).toHaveBeenCalledTimes(3);
  });

  it('P6 drains a stop during onStart without a first poll', async () => {
    const s = setup();
    let release = (): void => {};
    void s.start(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await flush();

    await s.loop.stop();
    expect(s.confirmations).toEqual([{ offset: 0, limit: 1 }]);
    expect(s.settled()).toBe('pending');

    release();
    await flush();
    expect(s.settled()).toBe('resolved');
    expect(s.polls).toEqual([]);
  });

  it.each([401, 409])('P7 rejects start() on a %i of getUpdates', async (code) => {
    const s = setup();
    void s.start();
    await flush();

    s.last().reject(refusal(code));
    await flush();
    expect(s.settled()).toBe('rejected');
    expect(s.rejection()).toMatchObject({ error_code: code });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.polls).toHaveLength(1);
  });

  it('P7 sleeps retryMs after a transport failure, a 429’s retry_after, and a stop cuts the sleep short', async () => {
    const s = setup();
    void s.start();
    await flush();

    s.last().reject(transportFailure());
    await flush();
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(s.polls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.polls).toHaveLength(2);

    s.last().reject(refusal(429, 7));
    await flush();
    await vi.advanceTimersByTimeAsync(6_999);
    expect(s.polls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.polls).toHaveLength(3);

    s.last().reject(refusal(429, 600));
    await flush();
    await s.loop.stop();
    await flush();
    expect(s.settled()).toBe('resolved');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.polls).toHaveLength(3);
  });

  it('P8 hands a throwing handler to errorHandler and goes on; a throwing errorHandler is logged and polling goes on', async () => {
    const s = setup();
    void s.start();
    await flush();
    s.failing.add(1);

    s.last().resolve([message(1, A)]);
    await flush();
    expect(s.errorHandler).toHaveBeenCalledTimes(1);
    expect(s.errorHandler.mock.calls[0]?.[0]).toBeInstanceOf(BotError);
    expect(s.polls).toHaveLength(2);

    s.errorHandler.mockImplementation(() => {
      throw new Error('bot.catch threw');
    });
    s.failing.add(2);
    s.last().resolve([message(2, A)]);
    await flush();
    expect(s.logger.error).toHaveBeenCalledWith(
      { err: { name: 'Error' }, updateId: 2 },
      'bot.catch failed',
    );
    expect(s.polls).toHaveLength(3);
    expect(s.settled()).toBe('pending');
  });

  it('P9 keys every allowed update kind by from, else chat, else runs it alone', async () => {
    const from = { id: A, is_bot: false, first_name: 'u' };
    for (const kind of ALLOWED_UPDATES) {
      expect(updateKey({ update_id: 1, [kind]: { from } } as unknown as Update)).toBe(
        `from:${String(A)}`,
      );
    }
    expect(
      updateKey({ update_id: 1, message_reaction_count: { chat: { id: B } } } as unknown as Update),
    ).toBe(`chat:${String(B)}`);
    const keyless = (updateId: number) =>
      ({ update_id: updateId, poll: { id: 'p' } }) as unknown as Update;
    expect(updateKey(keyless(1))).toBeUndefined();

    const s = setup();
    void s.start();
    await flush();
    s.held.add(1);
    s.held.add(2);
    s.last().resolve([keyless(1), keyless(2)]);
    await flush();
    expect(s.started).toEqual([1, 2]);
  });

  it('P10 ends an idle long poll at the stop without a retry sleep', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const s = setup();
    void s.start();
    await flush();

    await s.loop.stop();
    await flush();
    expect(s.settled()).toBe('resolved');
    expect(timers.mock.calls.filter(([, ms]) => ms === RETRY_MS)).toEqual([]);
    expect(s.confirmations).toEqual([{ offset: 0, limit: 1 }]);
  });

  it('P11 at full capacity polls again right after the first handler ends', async () => {
    const s = setup({ concurrency: 1 });
    void s.start();
    await flush();
    s.held.add(1);

    s.last().resolve([message(1, A)]);
    await flush();
    expect(s.polls).toHaveLength(1);

    s.release(1);
    await flush();
    expect(s.polls).toHaveLength(2);
    expect(s.last().payload).toEqual({ offset: 2, limit: 1, timeout: 5 });
  });
});
