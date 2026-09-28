import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_UPDATES, runBot, type PollingLoop } from './lifecycle';
import { fakeLogger, type FakeLogger } from './testing';
import { POLLING_BATCH_LIMIT, POLLING_TIMEOUT_S } from './timing';

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

    expect(fake.options[0]).toMatchObject({
      timeout: POLLING_TIMEOUT_S,
      // one update per getUpdates, so the drain waits for at most one handler and bot.stop()
      // confirms exactly the update in flight
      limit: POLLING_BATCH_LIMIT,
      allowed_updates: ALLOWED_UPDATES,
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
