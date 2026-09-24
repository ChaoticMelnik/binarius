import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_UPDATES, runBot, type PollingLoop } from './lifecycle';
import { POLLING_TIMEOUT_S } from './timing';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

// `bot.start()` resolves only once the polling loop has ended, which is what makes the drain
// interesting: the fake reproduces that rather than resolving straight away.
function fakeBot() {
  let resolveStart: () => void = () => {};
  let rejectStart: (error: unknown) => void = () => {};
  let resolveStop: () => void = () => {};
  const started = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
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
  return { bot, options, stopCalls, resolveStart, rejectStart, resolveStop };
}

class FakeSignals {
  private handlers = new Map<NodeJS.Signals, () => void>();
  once(signal: NodeJS.Signals, handler: () => void): unknown {
    this.handlers.set(signal, handler);
    return this;
  }
  emit(signal: NodeJS.Signals): void {
    this.handlers.get(signal)?.();
  }
  has(signal: NodeJS.Signals): boolean {
    return this.handlers.has(signal);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('runBot', () => {
  it('starts long polling with this project’s own timeout and update filter', () => {
    const fake = fakeBot();
    const signalSource = new FakeSignals();
    runBot({ bot: fake.bot, logger: logger(), exit: vi.fn(), signalSource });

    expect(fake.options[0]).toMatchObject({
      timeout: POLLING_TIMEOUT_S,
      allowed_updates: ALLOWED_UPDATES,
    });
    expect(signalSource.has('SIGTERM')).toBe(true);
    expect(signalSource.has('SIGINT')).toBe(true);
    fake.resolveStart();
  });

  it('exits non-zero when polling never starts', async () => {
    const fake = fakeBot();
    const log = logger();
    const exit = vi.fn();
    runBot({ bot: fake.bot, logger: log, exit, signalSource: new FakeSignals() });

    fake.rejectStart(Object.assign(new Error('Unauthorized'), { name: 'GrammyError' }));
    await settle();
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ err: { name: 'GrammyError' } });
  });

  it('stops once however many signals arrive, and exits 0 when the drain finishes', async () => {
    const fake = fakeBot();
    const exit = vi.fn();
    const signalSource = new FakeSignals();
    runBot({ bot: fake.bot, logger: logger(), exit, signalSource });

    signalSource.emit('SIGTERM');
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
    const signalSource = new FakeSignals();
    runBot({ bot: fake.bot, logger: logger(), exit, signalSource });

    signalSource.emit('SIGTERM');
    fake.resolveStop();
    await settle();
    expect(exit).not.toHaveBeenCalled();

    // the real loop resolves after stop() has aborted its getUpdates
    fake.resolveStart();
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when the drain overruns its budget', async () => {
    const fake = fakeBot();
    const log = logger();
    const exit = vi.fn();
    const signalSource = new FakeSignals();
    runBot({
      bot: fake.bot,
      logger: log,
      exit,
      shutdownBudgetMs: 20,
      signalSource,
    });

    signalSource.emit('SIGTERM');
    await settle();
    await settle();
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalled();

    fake.resolveStop();
    fake.resolveStart();
  });
});
