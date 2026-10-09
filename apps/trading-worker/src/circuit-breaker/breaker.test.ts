import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { logOptions, TRADING_SWITCH_REASON_MAX, tradingSwitchReasonSchema } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import { createCircuitBreaker, type CircuitBreakerDeps } from './breaker';

const CONFIG = { windowMs: 120_000, minFailures: 10, failurePercent: 50 };

function harness(overrides: Partial<CircuitBreakerDeps> = {}) {
  const lines: Record<string, unknown>[] = [];
  const stops: { source: string; reason: string }[] = [];
  let clock = 1_000;
  const breaker = createCircuitBreaker({
    stopTrading: async (input) => {
      stops.push(input);
      return { changed: true };
    },
    logger: pino(logOptions('info'), {
      write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    config: CONFIG,
    now: () => clock,
    ...overrides,
  });
  return {
    breaker,
    stops,
    lines,
    logs: (msg: string) => lines.filter((line) => line.msg === msg),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the circuit breaker (#96)', () => {
  it('B1 trips once through stopTrading as the breaker, with a reason the switch takes', async () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) h.breaker.rest(`ok${i}`, false);
    for (let i = 0; i < 10; i += 1) h.breaker.rest(`lost${i}`, true);
    await until('the trip', () => h.logs('circuit breaker tripped').length === 1);
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0]!.source).toBe('circuit_breaker');
    expect(h.stops[0]!.reason).toBe(
      'Автостоп: брокер не отвечает (REST: 10 из 20 отправок без ответа за 120 с)',
    );
    expect(tradingSwitchReasonSchema.safeParse(h.stops[0]!.reason).success).toBe(true);
    expect(h.logs('circuit breaker tripped')[0]).toMatchObject({
      level: 50,
      signal: 'rest',
      failures: 10,
      total: 20,
      windowMs: 120_000,
      changed: true,
    });
  });

  it('B2 trips once under a burst while the first trip is in flight', async () => {
    let release: () => void = () => undefined;
    const stops: unknown[] = [];
    const h = harness({
      stopTrading: (input) => {
        stops.push(input);
        return new Promise((resolve) => {
          release = () => resolve({ changed: true });
        });
      },
    });
    for (let i = 0; i < 30; i += 1) h.breaker.rest(`lost${i}`, true);
    await settle();
    expect(stops).toHaveLength(1);
    release();
    await until('the trip', () => h.logs('circuit breaker tripped').length === 1);
  });

  it('B3 clears the window after a trip, so the next storm counts from zero', async () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) h.breaker.rest(`a${i}`, true);
    await until('the first trip', () => h.stops.length === 1);
    await settle();
    for (let i = 0; i < 9; i += 1) h.breaker.rest(`b${i}`, true);
    await settle();
    expect(h.stops).toHaveLength(1);
    h.breaker.rest('b9', true);
    await until('the second trip', () => h.stops.length === 2);
  });

  it('B4 logs a stopTrading that throws and tries again on the next failure', async () => {
    let calls = 0;
    const h = harness({
      stopTrading: async () => {
        calls += 1;
        if (calls === 1) throw new Error('database down');
        return { changed: true };
      },
    });
    for (let i = 0; i < 10; i += 1) h.breaker.rest(`a${i}`, true);
    await until('the failed trip', () => h.logs('circuit breaker trip failed').length === 1);
    expect(h.logs('circuit breaker trip failed')[0]).toMatchObject({
      signal: 'rest',
      err: { name: 'Error' },
    });
    h.breaker.rest('a10', true);
    await until('the retried trip', () => h.logs('circuit breaker tripped').length === 1);
    expect(calls).toBe(2);
  });

  it('B5 answered events never trip', async () => {
    const h = harness();
    for (let i = 0; i < 100; i += 1) h.breaker.rest(`ok${i}`, false);
    await settle();
    expect(h.stops).toEqual([]);
  });

  it('B6 the reason stays within the switch bound at the largest counts', () => {
    const reason = `Автостоп: потеряна связь с брокером (сокеты: ${Number.MAX_SAFE_INTEGER} из ${Number.MAX_SAFE_INTEGER} сессий за ${Number.MAX_SAFE_INTEGER} с)`;
    expect([...reason].length).toBeLessThanOrEqual(TRADING_SWITCH_REASON_MAX);
  });

  // every session in work during the window is a key with its latest state: dropping a lost or a
  // fenced session does not shrink the share's denominator
  it('counts the socket share against every session in work during the window', async () => {
    const h = harness();
    for (let i = 0; i < 30; i += 1) h.breaker.socketReady(`acc-${i}`);
    // 10 of 30 closed by the server: a third, under half
    for (let i = 0; i < 10; i += 1) h.breaker.socketLost(`acc-${i}`);
    await settle();
    expect(h.stops).toEqual([]);
    // five more: 15 of 30
    for (let i = 10; i < 15; i += 1) h.breaker.socketLost(`acc-${i}`);
    await until('the trip', () => h.stops.length === 1);
    expect(h.stops[0]!.reason).toBe(
      'Автостоп: потеряна связь с брокером (сокеты: 15 из 30 сессий за 120 с)',
    );
  });

  it('does not trip when we dropped most sessions ourselves and a few of the rest are lost', async () => {
    const h = harness();
    // 100 in work; 80 fenced by our own database stall report nothing more, yet stay counted
    for (let i = 0; i < 100; i += 1) h.breaker.socketReady(`acc-${i}`);
    for (let i = 80; i < 90; i += 1) h.breaker.socketLost(`acc-${i}`);
    await settle();
    expect(h.stops).toEqual([]);
  });

  it('a session ready again is an answer, not a loss', async () => {
    const h = harness();
    for (let i = 0; i < 9; i += 1) h.breaker.socketLost(`acc-${i}`);
    for (let i = 0; i < 9; i += 1) h.breaker.socketReady(`acc-${i}`);
    h.breaker.socketLost('acc-9');
    await settle();
    expect(h.stops).toEqual([]);
  });

  it('starts no trip after stop(), and stop() waits for the one in flight', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const h = harness({
      stopTrading: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve({ changed: true });
        });
      },
    });
    for (let i = 0; i < 10; i += 1) h.breaker.rest(`a${i}`, true);
    let stopped = false;
    const stopping = h.breaker.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    release();
    await stopping;
    // a whole new storm after stop(): enough to trip, and nothing starts
    for (let i = 0; i < 10; i += 1) h.breaker.rest(`later${i}`, true);
    await settle();
    expect(calls).toBe(1);
  });
});
