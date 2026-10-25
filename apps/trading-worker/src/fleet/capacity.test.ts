import { logOptions } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionStats } from '../broker/session-manager';
import { createCapacityReporter, liveViewOf, type CapacityReporter } from './capacity';

const reporters: CapacityReporter[] = [];
afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.stop();
});

function harness({ sockets = true }: { sockets?: boolean } = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(logOptions('debug'), {
    write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const stats: SessionStats = { running: 3, starting: 1, owned: 6, cappedOut: 2, shed: 4 };
  let clock = 10_000;
  const reporter = createCapacityReporter({
    ownerId: 'me',
    registry: {
      live: () => ['a', 'me'],
      liveView: liveViewOf(['a', 'me']),
      lastAnsweredAt: () => 7_500,
    },
    ...(sockets ? { sessions: { stats: () => ({ ...stats }) } } : {}),
    cap: 5,
    logger,
    intervalMs: 20,
    monotonicNow: () => clock,
  });
  reporters.push(reporter);
  return {
    reporter,
    stats,
    advance: (ms: number) => (clock += ms),
    capacity: () => lines.filter((line) => line.msg === 'worker capacity'),
  };
}

describe('the capacity line (#94)', () => {
  it('C1 one line per interval with every field, the shed count as a delta', async () => {
    const h = harness();
    h.reporter.start();
    expect(h.capacity()).toEqual([]);
    await until('the first line', () => h.capacity().length > 0);
    const [first] = h.capacity();
    expect(first).toMatchObject({
      level: 30,
      ownerId: 'me',
      live: 2,
      liveView: liveViewOf(['a', 'me']),
      heartbeatAgeMs: 2_500,
      sockets: true,
      owned: 6,
      sessions: 3,
      starting: 1,
      cap: 5,
      cappedOut: 2,
      shed: 0,
    });
    expect(first!.rssMb).toBeGreaterThan(0);
    expect(Number.isFinite(first!.eventLoopLagP99Ms)).toBe(true);
    h.stats.shed = 7;
    h.reporter.report();
    expect(h.capacity().at(-1)).toMatchObject({ shed: 3 });

    const off = harness({ sockets: false });
    off.reporter.report();
    const line = off.capacity()[0]!;
    expect(line).toMatchObject({ sockets: false, live: 2 });
    expect(line).not.toHaveProperty('cap');
    expect(line).not.toHaveProperty('owned');
  });

  it('C2 liveViewOf is equal for equal sets and differs when a member differs', () => {
    expect(liveViewOf(['a', 'b'])).toBe(liveViewOf(['a', 'b']));
    expect(liveViewOf(['a', 'b'])).not.toBe(liveViewOf(['a', 'c']));
    expect(liveViewOf(['a', 'b'])).not.toBe(liveViewOf(['a']));
    expect(liveViewOf(['a', 'b'])).toMatch(/^[0-9a-f]{8}$/);
  });
});
