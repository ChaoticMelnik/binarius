import type pino from 'pino';
import { errorLogFields, TradingSwitchSource, tradingSwitchReasonSchema } from '@binarius/shared';
import { createFailureWindow, tripsAt } from './window';

// The circuit breaker (#96, docs/runbook-broker-outage.md): when the broker stops answering, it
// closes the global trading switch through stopTrading, demo and real together. It never opens
// anything; only an operator reopens (trading_switch_open_source_check). Two signals, one window
// each, the same thresholds: REST submits left without an answer, and broker sessions lost. Per
// process: with one worker that is the whole system (several are #94).

export type BreakerSignal = 'rest' | 'socket';

export interface CircuitBreakerConfig {
  windowMs: number;
  minFailures: number;
  failurePercent: number;
}

export interface CircuitBreakerDeps {
  stopTrading: (input: {
    source: typeof TradingSwitchSource.CircuitBreaker;
    reason: string;
  }) => Promise<{ changed: boolean }>;
  logger: Pick<pino.Logger, 'error'>;
  config: CircuitBreakerConfig;
  // the sessions running now: the socket share's denominator, so a session dropped after its loss
  // does not shrink it below the losses
  runningSessions?: () => number;
  now?: () => number;
}

export interface CircuitBreaker {
  // one submit: failed when the broker left it without an answer
  rest(intentId: string, failed: boolean): void;
  // one session lost (a confirmed loss, not our own drop)
  socketLost(accountId: string): void;
  // no trip starts after it; awaits the one in flight
  stop(): Promise<void>;
}

const reasonOf = (signal: BreakerSignal, failures: number, total: number, windowMs: number) => {
  const seconds = Math.round(windowMs / 1000);
  return signal === 'rest'
    ? `Автостоп: брокер не отвечает (REST: ${failures} из ${total} отправок без ответа за ${seconds} с)`
    : `Автостоп: потеряна связь с брокером (сокеты: ${failures} из ${total} сессий за ${seconds} с)`;
};

export function createCircuitBreaker(deps: CircuitBreakerDeps): CircuitBreaker {
  const { config, logger } = deps;
  const now = deps.now ?? Date.now;
  const windows = {
    rest: createFailureWindow(config.windowMs),
    socket: createFailureWindow(config.windowMs),
  };
  let tripping: Promise<void> | undefined;
  let stopped = false;

  async function trip(signal: BreakerSignal, failures: number, total: number) {
    const reason = tradingSwitchReasonSchema.parse(
      reasonOf(signal, failures, total, config.windowMs),
    );
    try {
      const { changed } = await deps.stopTrading({
        source: TradingSwitchSource.CircuitBreaker,
        reason,
      });
      logger.error(
        { signal, failures, total, windowMs: config.windowMs, changed },
        'circuit breaker tripped',
      );
      // a storm that goes on does not call stopTrading on every event; the switch is closed
      windows[signal].clear();
    } catch (error) {
      // the window stays: the next failure tries again
      logger.error({ signal, ...errorLogFields(error) }, 'circuit breaker trip failed');
    }
  }

  function evaluate(signal: BreakerSignal) {
    if (stopped || tripping !== undefined) return;
    const stats = windows[signal].stats(now());
    const total =
      signal === 'socket' ? Math.max(stats.total, deps.runningSessions?.() ?? 0) : stats.total;
    if (!tripsAt({ failures: stats.failures, total }, config)) return;
    tripping = trip(signal, stats.failures, total).finally(() => {
      tripping = undefined;
    });
  }

  return {
    rest(intentId, failed) {
      windows.rest.record(intentId, failed, now());
      if (failed) evaluate('rest');
    },
    socketLost(accountId) {
      windows.socket.record(accountId, true, now());
      evaluate('socket');
    },
    async stop() {
      stopped = true;
      await tripping;
    },
  };
}
