import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildH1SessionSettings,
  decimalStringSchema,
  logOptions,
  SessionStakeStrategy,
  toBinaryPair,
  type BinaryPair,
  type PairsCatalogView,
} from '@binarius/shared';
import type { ClosedSecond } from '../market-data/seconds';
import { createH1Scanner, H1_SCANNER_PARAMS, type H1Scanner, type H1ScannerDeps } from './scanner';

// The H1 scanner (#828, docs/h1.md -> The scanner and the signals list). A scripted series closes
// seconds in order; T is the first second, F = T + 300 s the first one with a full 301-second
// window. A ramp from F on signals up on every second, a falling one down; a flat tail after a
// noisy window is a below_threshold no_signal.
const T = 1_760_000_000_000;
const F = T + 300_000;
const A = 101;
const B = 202;
const MAX_AGE_MS = 1_600;
// a second closes 300 ms after its end label; the clock reads 20 ms after the close
const CLOSE_LAG_MS = 300;
const READ_LAG_MS = 20;

const pairOf = (id: number, patch: Partial<BinaryPair> = {}): BinaryPair => ({
  ...toBinaryPair({
    id,
    symbol: `P${id}`,
    is_otc: false,
    type: 'currency',
    digits: 5,
    payout: 96,
    max_payout: 96,
    min_timeframe: 5,
    max_timeframe: 3600,
    scheduled_until: 0,
  }),
  ...patch,
});

const flat = (n: number, price = 1.1) => Array<number>(n).fill(price);
const ramp = (n: number, step = 0.0001) => [
  ...flat(300),
  ...Array.from({ length: n }, (_, i) => 1.1 + (i + 1) * step),
];
// 300 seconds alternating by 2 pips, then a flat close at F: sd > 0, the 3-second move 0
const quiet = () => [
  ...Array.from({ length: 297 }, (_, i) => (i % 2 === 0 ? 1.1 : 1.1002)),
  ...flat(4),
];

interface Harness {
  scanner: H1Scanner;
  clock: { now: number };
  catalog: { view: PairsCatalogView | undefined };
  streaming: { on: boolean };
  listeners: Set<(closed: ClosedSecond) => void>;
  windows: { at: number[] };
  feed(assetId: number, from: number, prices: readonly number[]): void;
  line(): Record<string, unknown>;
  logs(msg: string): Record<string, unknown>[];
}

const scanners: H1Scanner[] = [];
afterEach(() => {
  for (const scanner of scanners.splice(0)) scanner.stop();
});

function harness(
  options: { pairs?: BinaryPair[]; deps?: Partial<H1ScannerDeps>; start?: boolean } = {},
): Harness {
  const prices = new Map<number, Map<number, number>>();
  const listeners = new Set<(closed: ClosedSecond) => void>();
  const clock = { now: T };
  const windows = { at: [] as number[] };
  const catalog = {
    view: {
      pairs: options.pairs ?? [pairOf(A), pairOf(B)],
      fetchedAt: T,
      ageMs: 0,
      fresh: true,
    } as PairsCatalogView | undefined,
  };
  const streaming = { on: true };
  const lines: string[] = [];
  const logger = pino(logOptions('debug'), { write: (line: string) => lines.push(line) });
  const series: H1ScannerDeps['series'] = {
    onClosed(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    window(assetId, f, lengthSec) {
      windows.at.push(f);
      const own = prices.get(assetId);
      const closes = new Float64Array(lengthSec);
      let complete = true;
      for (let i = 0; i < lengthSec; i++) {
        const price = own?.get(f - (lengthSec - 1 - i) * 1_000);
        closes[i] = price ?? NaN;
        if (price === undefined) complete = false;
      }
      return { closes, complete };
    },
  };
  const scanner = createH1Scanner({
    series,
    catalog: { read: () => catalog.view },
    streaming: () => streaming.on,
    logger,
    now: () => clock.now,
    config: { logMs: 60_000, maxAgeMs: MAX_AGE_MS },
    ...options.deps,
  });
  scanners.push(scanner);
  if (options.start !== false) scanner.start();
  const parsed = (msg: string) =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === msg);
  return {
    scanner,
    clock,
    catalog,
    streaming,
    listeners,
    windows,
    feed(assetId, from, list) {
      list.forEach((price, i) => {
        const second = from + i * 1_000;
        const own = prices.get(assetId) ?? new Map<number, number>();
        own.set(second, price);
        prices.set(assetId, own);
        const closedAtMs = second + CLOSE_LAG_MS;
        clock.now = closedAtMs + READ_LAG_MS;
        for (const listener of listeners) {
          listener({ assetId, second, closedBy: 'tick', closedAtMs });
        }
      });
    },
    line() {
      scanner.report();
      const written = parsed('h1 scanner').at(-1);
      if (written === undefined) throw new Error('no h1 scanner line');
      return written;
    },
    logs: parsed,
  };
}

const AGE = CLOSE_LAG_MS + READ_LAG_MS;

describe('the H1 scanner (#828)', () => {
  it('H1-SC1 lists a signal of a closed second with its second, decision time and age', () => {
    const h = harness();
    h.feed(A, T, ramp(1));
    expect(h.scanner.fresh(h.clock.now)).toEqual({
      scanned: 1,
      signals: [{ assetId: A, action: 'up', second: F, decidedAt: F + AGE, ageMs: AGE }],
    });
    // the age at the read, not at the decision
    expect(h.scanner.fresh(F + 900).signals[0]?.ageMs).toBe(900);
  });

  it('H1-SC1 lists a falling ramp as down', () => {
    const h = harness();
    h.feed(B, T, ramp(1, -0.0001));
    expect(h.scanner.fresh(h.clock.now).signals).toEqual([
      { assetId: B, action: 'down', second: F, decidedAt: F + AGE, ageMs: AGE },
    ]);
  });

  it('H1-SC2 a no_signal second is not listed, counted by reason', () => {
    const h = harness();
    h.feed(A, T, quiet());
    expect(h.scanner.fresh(h.clock.now)).toEqual({ scanned: 1, signals: [] });
    expect(h.scanner.current(A, h.clock.now)).toBeNull();
    const line = h.line();
    expect(line.decisions).toBe(1);
    expect(line.signals).toBe(0);
    expect(line.noSignal).toEqual({ below_threshold: 1 });
  });

  it('H1-SC3 the next closed second replaces the entry: signal, then no_signal, then gone', () => {
    const h = harness();
    // F signals up; F + 1 s and on are flat: the 3-second move still spans the step for two
    // seconds, then it is 0
    h.feed(A, T, ramp(1));
    expect(h.scanner.fresh(h.clock.now).signals.map((s) => s.second)).toEqual([F]);
    h.feed(A, F + 1_000, flat(1, 1.1001));
    expect(h.scanner.fresh(h.clock.now).signals.map((s) => s.second)).toEqual([F + 1_000]);
    h.feed(A, F + 2_000, flat(3, 1.1001));
    expect(h.scanner.fresh(h.clock.now)).toEqual({ scanned: 1, signals: [] });
    expect(h.line()).toMatchObject({ decisions: 5, signals: 3 });
  });

  it('H1-SC4 a second older than maxAgeMs is not listed; exactly at it, it is', () => {
    const h = harness();
    h.feed(A, T, ramp(1));
    expect(h.scanner.fresh(F + MAX_AGE_MS)).toEqual({
      scanned: 1,
      signals: [{ assetId: A, action: 'up', second: F, decidedAt: F + AGE, ageMs: MAX_AGE_MS }],
    });
    expect(h.scanner.fresh(F + MAX_AGE_MS + 1)).toEqual({ scanned: 0, signals: [] });
    expect(h.scanner.current(A, F + MAX_AGE_MS)?.action).toBe('up');
    expect(h.scanner.current(A, F + MAX_AGE_MS + 1)).toBeNull();
  });

  it('H1-SC5 a closed second with the source down deletes every entry', () => {
    const h = harness();
    h.feed(A, T, ramp(1));
    h.feed(B, T, ramp(1));
    expect(h.scanner.fresh(h.clock.now).signals).toHaveLength(2);
    h.streaming.on = false;
    h.feed(A, F + 1_000, [1.1002]);
    expect(h.scanner.fresh(F + 1_100)).toEqual({ scanned: 0, signals: [] });
    expect(h.line().sourceDown).toBe(1);
  });

  it('H1-SC6 a stale catalog keeps the entries and warns once a streak', () => {
    const h = harness();
    h.feed(A, T, ramp(1));
    h.catalog.view = { ...h.catalog.view!, fresh: false, ageMs: 90_000 };
    h.feed(A, F + 1_000, [1.1002, 1.1003]);
    // the entry of F is kept and ages out by the serving rule
    expect(h.scanner.fresh(F + 1_000).signals.map((s) => s.second)).toEqual([F]);
    expect(h.logs('h1 scanner skipped: no fresh catalog')).toHaveLength(1);
    h.catalog.view = { ...h.catalog.view, fresh: true, ageMs: 0 };
    h.feed(A, F + 3_000, [1.1004]);
    h.catalog.view = { ...h.catalog.view, fresh: false, ageMs: 90_000 };
    h.feed(A, F + 4_000, [1.1005]);
    expect(h.logs('h1 scanner skipped: no fresh catalog')).toHaveLength(2);
    expect(h.line().catalogStale).toBe(3);
  });

  it.each([
    ['closed by its schedule', [pairOf(A, { scheduledUntil: F + 3_600_000 }), pairOf(B)]],
    ['not taking 5 s', [pairOf(A, { minTimeframe: 15 }), pairOf(B)]],
    ['gone from the catalog', [pairOf(B)]],
  ])('H1-SC7 a pair %s at its next second loses its entry', (_name, pairs) => {
    const h = harness();
    h.feed(A, T, ramp(1));
    expect(h.scanner.fresh(h.clock.now).signals).toHaveLength(1);
    h.catalog.view = { ...h.catalog.view!, pairs };
    h.feed(A, F + 1_000, [1.1002]);
    expect(h.scanner.fresh(F + 1_000)).toEqual({ scanned: 0, signals: [] });
    expect(h.line().ineligible).toBe(1);
  });

  it('H1-SC8 a pair paying 79 % is decided and listed: no payout floor', () => {
    const h = harness({ pairs: [pairOf(A, { payout: 79 })] });
    h.feed(A, T, ramp(1));
    expect(h.scanner.fresh(h.clock.now).signals.map((s) => s.assetId)).toEqual([A]);
  });

  it('H1-SC9 an incomplete window is warming and keeps no entry', () => {
    const h = harness();
    h.feed(A, T, ramp(1));
    // a reset: the series restarts at F + 10 s, the window lacks the 300 seconds before it
    h.feed(A, F + 10_000, [1.2]);
    expect(h.scanner.fresh(h.clock.now)).toEqual({ scanned: 0, signals: [] });
    expect(h.line().warming).toBeGreaterThanOrEqual(1);
    const fresh = harness();
    fresh.feed(A, T, flat(10));
    expect(fresh.scanner.fresh(fresh.clock.now)).toEqual({ scanned: 0, signals: [] });
    expect(fresh.line()).toMatchObject({ warming: 10, decisions: 0 });
  });

  it('H1-SC10 current() is the listed item of the pair, null for no_signal, absent or stale', () => {
    const h = harness();
    h.feed(A, T, ramp(1));
    h.feed(B, T, quiet());
    const now = h.clock.now;
    const listed = h.scanner.fresh(now).signals.find((s) => s.assetId === A);
    expect(h.scanner.current(A, now)).toEqual({
      action: listed?.action,
      second: listed?.second,
      decidedAt: listed?.decidedAt,
      ageMs: listed?.ageMs,
    });
    expect(h.scanner.current(B, now)).toBeNull();
    expect(h.scanner.current(303, now)).toBeNull();
    expect(h.scanner.current(A, F + MAX_AGE_MS + 1)).toBeNull();
  });

  it("H1-SC11 decides with the H1 session's parameters (K-H1b)", () => {
    const built = buildH1SessionSettings({
      assetId: A,
      cycles: 5,
      stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 2 },
      strategy: SessionStakeStrategy.Martingale,
    });
    if (!built.success || built.data.version !== 5) throw new Error('H1 settings');
    expect({ ...H1_SCANNER_PARAMS }).toEqual(built.data.signal.params);
    // the window it reads is sdWindowSec + 1 closes ending at the closed second
    const h = harness();
    h.feed(A, T, ramp(1));
    expect(h.windows.at.at(-1)).toBe(F);
  });

  it('H1-SC12 a throw inside the decision is counted and warned; the handler returns', () => {
    const h = harness({
      deps: {
        catalog: {
          read: () => {
            throw new Error('catalog read broke');
          },
        },
      },
    });
    expect(() => h.feed(A, T, [1.1])).not.toThrow();
    expect(h.line().errors).toBe(1);
    expect(h.logs('h1 scanner decision failed')).toHaveLength(1);
  });

  it('H1-SC13 the line carries the totals and the lag percentiles of the period', () => {
    const h = harness();
    h.feed(A, T, ramp(2));
    h.feed(B, T, quiet());
    h.clock.now = F + 1_000 + 500;
    expect(h.line()).toMatchObject({
      pairs: 2,
      current: 2,
      listed: 1,
      decisions: 3,
      signals: 2,
      noSignal: { below_threshold: 1 },
      warming: 600,
      ineligible: 0,
      sourceDown: 0,
      catalogStale: 0,
      errors: 0,
      lagMsP50: AGE,
      lagMsP95: AGE,
    });
    // the lag is the period's: the next line has none
    expect(h.line()).toMatchObject({ lagMsP50: null, lagMsP95: null, decisions: 3 });
  });

  it('H1-SC14 stop() unsubscribes and clears; a second after it changes nothing', () => {
    const h = harness();
    h.feed(A, T, ramp(1));
    h.scanner.stop();
    expect(h.listeners.size).toBe(0);
    expect(h.scanner.fresh(h.clock.now)).toEqual({ scanned: 0, signals: [] });
    h.feed(A, F + 1_000, [1.1002]);
    expect(h.scanner.fresh(h.clock.now)).toEqual({ scanned: 0, signals: [] });
  });

  it('decides nothing before start()', () => {
    const h = harness({ start: false });
    h.feed(A, T, ramp(1));
    expect(h.listeners.size).toBe(0);
    expect(h.scanner.fresh(h.clock.now)).toEqual({ scanned: 0, signals: [] });
  });
});
