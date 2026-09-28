import { EventEmitter } from 'node:events';
import { HttpError } from 'grammy';
import type { ApiError, Update } from 'grammy/types';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BackendClient } from './backend-client';
import { createBot } from './bot';
import { runBot, type PollingLoop } from './lifecycle';
import {
  BOT_INFO,
  USER_VIEW,
  captureApi,
  fakeLogger,
  startUpdate,
  type FakeLogger,
} from './testing';

// `bot.start()` resolves only once the polling loop has ended, which is what makes the drain
// interesting: the fake reproduces that rather than resolving straight away.
function fakeBot() {
  let resolveStart: () => void = () => {};
  let rejectStart: (error: unknown) => void = () => {};
  let resolveStop: () => void = () => {};
  let rejectStop: (error: unknown) => void = () => {};
  const started = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });
  const stopCalls: number[] = [];
  const options: Parameters<PollingLoop['start']>[0][] = [];
  const bot: PollingLoop = {
    start: (startOptions) => {
      options.push(startOptions);
      return started;
    },
    stop: () => {
      stopCalls.push(Date.now());
      return stopped;
    },
  };
  return { bot, options, stopCalls, resolveStart, rejectStart, resolveStop, rejectStop };
}

// The signal source is a real EventEmitter rather than a hand-written double: `process` is one,
// so `on`/`once`/`emit`/`listenerCount` here are the very implementations production runs, and a
// double cannot quietly model `once` as `on` again.
const signals = () => new EventEmitter();

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// pino takes either (message) or (fields, message), so the message is the last argument
const errorMessages = (log: FakeLogger): unknown[] =>
  log.error.mock.calls.map((call) => call[call.length - 1]);

const BUDGET_LINE = 'shutdown: polling did not stop within the budget, exiting anyway';
const STEP_LINE = 'shutdown: a drain step failed, exiting anyway';

describe('runBot', () => {
  it('starts long polling with this project’s own timeout, batch size and update filter', () => {
    const fake = fakeBot();
    const signalSource = signals();
    runBot({ bot: fake.bot, logger: fakeLogger(), exit: vi.fn(), signalSource });

    // Literals on purpose. These constants are what runBot passes, so an assertion written
    // against them proves the keys are there and nothing at all about the values — one update
    // per getUpdates is what makes the drain wait for at most one handler and bot.stop()
    // confirm exactly the update in flight, and timing.ts pins the constant to 1 at import.
    expect(fake.options[0]).toMatchObject({
      timeout: 5,
      limit: 1,
      allowed_updates: ['message', 'callback_query'],
    });
    expect(signalSource.listenerCount('SIGTERM')).toBe(1);
    expect(signalSource.listenerCount('SIGINT')).toBe(1);
    fake.resolveStart();
  });

  it('exits non-zero when polling never starts', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    runBot({ bot: fake.bot, logger: log, exit, signalSource: signals() });

    fake.rejectStart(Object.assign(new Error('Unauthorized'), { name: 'GrammyError' }));
    await settle();
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'GrammyError' } });
  });

  it('stops once however many signals arrive, and exits 0 when the drain finishes', async () => {
    const fake = fakeBot();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({ bot: fake.bot, logger: fakeLogger(), exit, signalSource });

    signalSource.emit('SIGTERM');
    // Half of "a second signal is ignored" is that there still is a listener to ignore it with:
    // registered with `once`, the handler is gone by now, and in production Node would answer
    // the second SIGTERM with its default action and kill the drain. An EventEmitter cannot
    // model that half — it has no default action — so the premise itself is what is asserted.
    expect(
      signalSource.listenerCount('SIGTERM'),
      'the SIGTERM handler must survive the first signal (`on`, not `once`), or the second one ' +
        'kills the drain instead of being ignored',
    ).toBe(1);
    signalSource.emit('SIGTERM');
    signalSource.emit('SIGINT');
    expect(fake.stopCalls).toHaveLength(1);

    fake.resolveStop();
    fake.resolveStart();
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('waits for the polling loop itself, not only for stop()', async () => {
    const fake = fakeBot();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({ bot: fake.bot, logger: fakeLogger(), exit, signalSource });

    signalSource.emit('SIGTERM');
    fake.resolveStop();
    await settle();
    expect(exit).not.toHaveBeenCalled();

    // the real loop resolves after stop() has aborted its getUpdates
    fake.resolveStart();
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when the drain overruns its budget, and blames the budget', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({ bot: fake.bot, logger: log, exit, shutdownBudgetMs: 20, signalSource });

    signalSource.emit('SIGTERM');
    await settle();
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual([BUDGET_LINE]);

    fake.resolveStop();
    fake.resolveStart();
  });

  it('lets the drain own the exit code when polling rejects after the signal', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({ bot: fake.bot, logger: log, exit, signalSource });

    signalSource.emit('SIGTERM');
    fake.resolveStop();
    // without the stopping guard this handler would exit(1) on its own and kill the middleware
    // closeAll is still waiting for, then closeAll would exit a second time
    fake.rejectStart(Object.assign(new Error('polling died'), { name: 'GrammyError' }));
    await settle();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: polling loop failed', STEP_LINE]);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'GrammyError' } });
  });

  it('names bot.stop() when that is the step that failed', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({ bot: fake.bot, logger: log, exit, signalSource });

    signalSource.emit('SIGTERM');
    fake.rejectStop(Object.assign(new Error('stop died'), { name: 'GrammyError' }));
    fake.resolveStart();
    await settle();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorMessages(log)).toEqual(['shutdown: bot.stop() failed', STEP_LINE]);
  });

  it('reports the failed step and the overrun separately when both happen', async () => {
    const fake = fakeBot();
    const log = fakeLogger();
    const exit = vi.fn();
    const signalSource = signals();
    runBot({ bot: fake.bot, logger: log, exit, shutdownBudgetMs: 20, signalSource });

    signalSource.emit('SIGTERM');
    fake.rejectStop(Object.assign(new Error('stop died'), { name: 'GrammyError' }));
    await settle();
    await settle();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    // the step logged itself when it failed; the closing line answers only for the budget
    expect(errorMessages(log)).toEqual(['shutdown: bot.stop() failed', BUDGET_LINE]);

    fake.resolveStart();
  });
});

// The premises fakeBot encodes — start() resolving only when the loop ends, stop() cutting an
// idle getUpdates short, a stop() that rejects, an init that fails without a retry, onStart,
// and a throwing handler reaching bot.catch — are assertions about grammY, and a fake cannot
// check any of them. These scenes run runBot over a real Bot whose only replacement is the
// transport, so each premise is read off the library instead of off our model of it.

const TOKEN = '123456:AA-bot-token';

// bot.stop() confirms the offset with getUpdates({ offset, limit: 1 }) — neither a timeout nor
// the polling AbortSignal, which is what tells it apart from a long poll (grammY bot.js)
const isLongPoll = (payload: Record<string, unknown>): boolean => payload.timeout !== undefined;

const transportFailure = (method: string): HttpError =>
  new HttpError(`Network request for '${method}' failed!`, new Error('The operation was aborted'));

// Half of grammY's 3 s sleep after a failed getUpdates. A scene that has to wait this long is
// one where a sleep entered the drain, not one where the runner was busy: the fixed 40 ms this
// used to be would have made a loaded CI runner look like the same failure.
const WAIT_CEILING_MS = 1_500;

async function waitFor(what: string, done: () => boolean): Promise<void> {
  const until = Date.now() + WAIT_CEILING_MS;
  while (!done()) {
    if (Date.now() > until) {
      throw new Error(
        `${what} did not happen within ${WAIT_CEILING_MS} ms — half of the 3 s grammY sleeps ` +
          'after a failed getUpdates. Read this as a sleep that entered the path, not as a ' +
          'slow runner.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface SceneOptions {
  recordStart?: BackendClient['recordStart'];
  withBotInfo?: boolean;
  confirmFails?: boolean;
  // registered before runBot on purpose: bot.start() issues getMe and deleteWebhook
  // synchronously, so a failure programmed after the call returns arrives too late
  apiErrors?: readonly (readonly [string, ApiError | HttpError])[];
}

const running: { signalSource: EventEmitter; exit: Mock }[] = [];

afterEach(async () => {
  // a scene left polling holds a promise that never settles; the drain is how it is put down
  for (const scene of running.splice(0)) {
    if (scene.exit.mock.calls.length === 0) scene.signalSource.emit('SIGTERM');
  }
  await settle();
});

function scene(options: SceneOptions = {}) {
  const log = fakeLogger();
  const exit = vi.fn();
  const signalSource = new EventEmitter();
  const events: string[] = [];
  log.info.mockImplementation((...args: unknown[]) => {
    events.push(`info:${String(args[args.length - 1])}`);
  });

  const backend: BackendClient = {
    recordStart: options.recordStart ?? (() => Promise.resolve(USER_VIEW)),
    startLogin: () => Promise.reject(new Error('not used by these scenes')),
  };
  const bot = createBot({
    token: TOKEN,
    backend,
    logger: log,
    ...(options.withBotInfo === false ? {} : { botInfo: BOT_INFO }),
  });
  const api = captureApi(bot);
  for (const [method, failure] of options.apiErrors ?? []) api.apiErrors.set(method, failure);

  const getUpdates = (long: boolean) =>
    api.calls.filter((call) => call.method === 'getUpdates' && isLongPoll(call.payload) === long);
  const longPolls = () => getUpdates(true);

  let pending: { resolve: (updates: Update[]) => void } | undefined;
  api.answers.set('deleteWebhook', () => {
    events.push('deleteWebhook');
    return true;
  });
  api.answers.set('getUpdates', (payload, signal) => {
    if (!isLongPoll(payload)) {
      if (options.confirmFails === true) throw transportFailure('getUpdates');
      return [];
    }
    events.push(`getUpdates#${longPolls().length}`);
    return new Promise<Update[]>((resolve, reject) => {
      pending = { resolve };
      // what the real transport does with an aborted request
      signal?.addEventListener('abort', () => reject(transportFailure('getUpdates')));
    });
  });

  runBot({ bot, logger: log, exit, signalSource });
  running.push({ signalSource, exit });

  return {
    api,
    log,
    exit,
    events,
    signalSource,
    longPolls,
    confirmations: () => getUpdates(false),
    methods: () => api.calls.map((call) => call.method),
    deliver: (updates: Update[]) => pending?.resolve(updates),
    firstPoll: () => waitFor('the first long poll', () => longPolls().length >= 1),
    drained: () => waitFor('the drain to finish', () => exit.mock.calls.length >= 1),
  };
}

describe('runBot over the real grammY Bot the fake above stands in for', () => {
  it('waits for the handler in flight, and a second signal does not cut it short', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const s = scene({
      recordStart: () => {
        calls += 1;
        return held.then(() => USER_VIEW);
      },
    });
    await s.firstPoll();

    const update = startUpdate('/start');
    s.deliver([update]);
    await waitFor('the handler to reach the backend', () => calls === 1);

    s.signalSource.emit('SIGTERM');
    await waitFor('bot.stop() to confirm the offset', () => s.confirmations().length === 1);
    expect(s.confirmations()[0]?.payload).toEqual({ offset: update.update_id + 1, limit: 1 });
    expect(s.exit).not.toHaveBeenCalled();

    s.signalSource.emit('SIGTERM');
    await settle();
    expect(s.exit).not.toHaveBeenCalled();

    release();
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[0]]);
    expect(s.methods()).toContain('sendMessage');
  });

  it('ends an idle long poll at once rather than sleeping through the backoff', async () => {
    const s = scene();
    await s.firstPoll();

    s.signalSource.emit('SIGTERM');
    // the ceiling inside waitFor is the assertion: grammY skips its 3 s sleep because the poll
    // was cancelled by a stop(), and a drain that waited it out would not finish in half of it
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[0]]);
    expect(errorMessages(s.log)).toEqual([]);
  });

  it('blames bot.stop() when the confirming getUpdates fails, and still settles the loop', async () => {
    const s = scene({ confirmFails: true });
    await s.firstPoll();

    s.signalSource.emit('SIGTERM');
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[1]]);
    // the step line rather than the budget line is what says the polling loop itself settled
    expect(errorMessages(s.log)).toEqual(['shutdown: bot.stop() failed', STEP_LINE]);
    expect(s.log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'HttpError' } });
  });

  it('exits non-zero when the token is refused, and asks getMe exactly once', async () => {
    const s = scene({
      withBotInfo: false,
      apiErrors: [['getMe', { ok: false, error_code: 401, description: 'Unauthorized' }]],
    });
    await waitFor('the process to give up', () => s.exit.mock.calls.length >= 1);

    expect(s.exit.mock.calls).toEqual([[1]]);
    expect(errorMessages(s.log)).toEqual(['long polling stopped with an error']);
    expect(s.log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'GrammyError' } });
    // grammY retries neither getMe nor a 401 on the way in, so the exit is immediate
    expect(s.methods().filter((method) => method === 'getMe')).toHaveLength(1);
    expect(s.longPolls()).toHaveLength(0);
  });

  it('logs that the bot started, after the webhook is dropped and before a first poll for one update on this project’s terms', async () => {
    const s = scene();
    await s.firstPoll();

    expect(s.events).toEqual(['deleteWebhook', 'info:bot started', 'getUpdates#1']);
    // The premise the fake above stands on: the options object runBot hands start() is what
    // grammY puts in getUpdates. Only the first poll — after one succeeds grammY stops sending
    // allowed_updates, because Telegram keeps the last setting (out/bot.js, loop()).
    expect(s.longPolls()[0]?.payload).toMatchObject({
      limit: 1,
      timeout: 5,
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('hands a handler that throws to bot.catch and goes on polling', async () => {
    const s = scene({ apiErrors: [['sendMessage', transportFailure('sendMessage')]] });
    await s.firstPoll();

    const update = startUpdate('/start');
    s.deliver([update]);
    await waitFor('the loop to ask for the next update', () => s.longPolls().length >= 2);

    expect(errorMessages(s.log)).toEqual(['update handler failed']);
    expect(s.log.error.mock.calls[0]?.[0]).toMatchObject({
      err: { name: 'HttpError' },
      updateId: update.update_id,
    });

    s.signalSource.emit('SIGTERM');
    await s.drained();
    expect(s.exit.mock.calls).toEqual([[0]]);
  });
});
