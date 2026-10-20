import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  H1_R1_PARAMS,
  h1ShadowEntrySchema,
  logOptions,
  toBinaryPair,
  tradeOutcomeOf,
  TradeAction,
  type BinaryPair,
  type PairsCatalogView,
} from '@binarius/shared';
import type { SignalDecisionInput } from '@binarius/db';
import { createH1Detector, DEFAULT_H1_PARAMS, replayH1Entry } from '@binarius/signal';
import { createSecondSeries, type ClosedSecond } from '../market-data/seconds';
import { createH1Shadow, type H1Shadow, type H1ShadowDeps } from './shadow';

// The H1 shadow (#669, docs/h1.md -> The shadow). A scripted series closes seconds in order; T is
// the first second, F = T + 300 s the first one with a full 301-second window.
const T = 1_760_000_000_000;
const F = T + 300_000;
const A = 101;
const B = 202;
const CAPACITY_SEC = 320;

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

// The series' contract on the axis the shadow reads: seconds close in order, a window is complete
// only over closed seconds the series holds, NaN is a second without a price.
function scriptedSeries() {
  const prices = new Map<number, Map<number, number>>();
  const closedUntil = new Map<number, number>();
  const firstHeld = new Map<number, number>();
  const listeners = new Set<(closed: ClosedSecond) => void>();
  const advanced: number[] = [];
  const held = (assetId: number, second: number) =>
    second >= (firstHeld.get(assetId) ?? Infinity) && second <= (closedUntil.get(assetId) ?? -1);
  const close = (assetId: number, second: number) =>
    held(assetId, second) ? (prices.get(assetId)?.get(second) ?? NaN) : NaN;
  const api: H1ShadowDeps['series'] = {
    onClosed(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    advance: (nowMs) => void advanced.push(nowMs),
    window(assetId, f, lengthSec) {
      const closes = new Float64Array(lengthSec);
      let complete = true;
      for (let i = 0; i < lengthSec; i++) {
        const second = f - (lengthSec - 1 - i) * 1_000;
        closes[i] = close(assetId, second);
        if (!held(assetId, second)) complete = false;
      }
      return { closes, complete };
    },
    close,
    lastTickOf(assetId, f) {
      const price = close(assetId, f);
      return Number.isNaN(price) ? undefined : { price, timestamp: f - 100, receivedAtMs: f - 60 };
    },
    digitsOf: () => 5,
  };
  return {
    api,
    advanced,
    listeners,
    prices,
    // closes `second` at `price` and announces it
    closeSecond(
      assetId: number,
      second: number,
      price: number,
      closedBy: 'tick' | 'clock' = 'tick',
      closedAtMs = second + 300,
    ) {
      if (!firstHeld.has(assetId)) firstHeld.set(assetId, second);
      const own = prices.get(assetId) ?? new Map<number, number>();
      own.set(second, price);
      prices.set(assetId, own);
      closedUntil.set(assetId, second);
      clock.now = closedAtMs + 20;
      for (const listener of listeners) listener({ assetId, second, closedBy, closedAtMs });
    },
  };
}

const clock = { now: T };

interface Harness {
  shadow: H1Shadow;
  series: ReturnType<typeof scriptedSeries>;
  records: SignalDecisionInput[];
  lines: string[];
  catalog: { view: PairsCatalogView | undefined; throws: boolean };
  streaming: { on: boolean };
  // closes consecutive seconds from `from`
  feed(assetId: number, from: number, prices: readonly number[]): void;
  line(): Record<string, unknown>;
  logs(msg: string): Record<string, unknown>[];
}

const shadows: H1Shadow[] = [];
afterEach(async () => {
  for (const shadow of shadows.splice(0)) await shadow.stop();
  vi.useRealTimers();
});

function harness(
  options: {
    pairs?: BinaryPair[];
    record?: H1ShadowDeps['record'];
    series?: H1ShadowDeps['series'];
  } = {},
): Harness {
  const series = scriptedSeries();
  const records: SignalDecisionInput[] = [];
  const lines: string[] = [];
  const logger = pino(logOptions('debug'), { write: (line: string) => lines.push(line) });
  const catalog = {
    view: {
      pairs: options.pairs ?? [pairOf(A), pairOf(B)],
      fetchedAt: T,
      ageMs: 0,
      fresh: true,
    } as PairsCatalogView | undefined,
    throws: false,
  };
  const streaming = { on: true };
  const shadow = createH1Shadow({
    series: options.series ?? series.api,
    catalog: {
      read: () => {
        if (catalog.throws) throw new TypeError('catalog broke');
        return catalog.view;
      },
    },
    streaming: () => streaming.on,
    record:
      options.record ??
      ((input) => {
        records.push(input);
        return Promise.resolve();
      }),
    logger,
    now: () => clock.now,
    config: { tickMs: 100, logMs: 60_000, capacitySec: CAPACITY_SEC },
  });
  shadow.start();
  shadows.push(shadow);
  const parsed = (msg: string) =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === msg);
  return {
    shadow,
    series,
    records,
    lines,
    catalog,
    streaming,
    feed(assetId, from, prices) {
      prices.forEach((price, i) => series.closeSecond(assetId, from + i * 1_000, price));
    },
    line() {
      shadow.report();
      const written = parsed('h1 shadow').at(-1);
      if (written === undefined) throw new Error('no h1 shadow line');
      return written;
    },
    logs: parsed,
  };
}

const flat = (n: number, price = 1.1) => Array<number>(n).fill(price);
// 300 flat seconds from T, the jump at F that both sets signal on, then `after` from F + 1 s
const spike = (after: readonly number[]) => [...flat(300), 1.1002, ...after];
// after the jump: the prices X1 reads (F + 1 .. F + 7), then flat
const AFTER = [1.1003, 1.1004, 1.1004, 1.1004, 1.1004, 1.1006, 1.1001];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const rowsAt = (records: readonly SignalDecisionInput[], f: number) =>
  records.filter((record) => record.decidedAtMs === f);
const setOf = (record: SignalDecisionInput) => (record.params as { set: string }).set;
const decisionsOf = (line: Record<string, unknown>, set: string) =>
  (line.sets as Record<string, { decisions: number; signals: number }>)[set];

describe('the H1 shadow (#669)', () => {
  it('H-X1: a signal becomes one row of every column once f + 7 s is closed', async () => {
    const h = harness();
    h.feed(A, T, spike(AFTER.slice(0, 6)));
    await flush();
    expect(h.records).toEqual([]);
    h.series.closeSecond(A, F + 7_000, AFTER[6]!);
    await flush();
    const rows = rowsAt(h.records, F);
    expect(rows.map(setOf)).toEqual(['r1', 'h1']);
    const r1 = rows[0]!;
    const closes = [...flat(300), 1.1002];
    expect(r1).toEqual({
      context: 'shadow',
      tradingSessionId: null,
      brokerAccountId: null,
      step: null,
      assetId: A,
      interval: null,
      version: 'h1',
      decidedAtMs: F,
      takenAtMs: F + 320,
      kind: 'signal',
      action: 'up',
      payout: 96,
      digits: 5,
      params: { set: 'r1', ...H1_R1_PARAMS, entryDelaySec: 1, expirySec: 5 },
      decision: createH1Detector(H1_R1_PARAMS).decide({ closes, at: 300 }),
      source: { kind: 'ticks', symbol: `P${A}`, closedBy: 'tick', closedAtMs: F + 300 },
      series: closes,
      lastTick: { price: 1.1002, timestamp: F - 100, receivedAtMs: F - 60 },
      outcome: 'shadow',
      detail: null,
      result: {
        entries: [
          { entryDelaySec: 1, entryPrice: 1.1003, exitPrice: 1.1006, outcome: 'win' },
          { entryDelaySec: 2, entryPrice: 1.1004, exitPrice: 1.1001, outcome: 'loss' },
        ],
      },
      ticksUntilMs: F + 7_000,
    });
    expect(rows[1]).toMatchObject({
      params: { set: 'h1', ...DEFAULT_H1_PARAMS, entryDelaySec: 2, expirySec: 5 },
      result: r1.result,
      ticksUntilMs: F + 7_000,
    });
  });

  it('H-X2: on the real series and ten minutes of ticks every row decides again to itself', async () => {
    const real = createSecondSeries({ capacitySec: CAPACITY_SEC, closeMarginMs: 500 });
    const h = harness({ series: real });
    let state = 7;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    let price = 1.1;
    for (let ms = 0; ms < 600_000; ms += 250 + Math.floor(next() * 500)) {
      price += (next() - 0.5) * 0.0002 + (next() < 0.01 ? 0.002 : 0);
      clock.now = T + ms + 40 + Math.floor(next() * 200);
      real.push(A, 5, { price, timestamp: T + ms }, clock.now);
      if (next() < 0.1) real.advance(clock.now);
    }
    await flush();
    expect(h.records.length).toBeGreaterThan(5);
    expect(new Set(h.records.map(setOf))).toEqual(new Set(['r1', 'h1']));
    for (const record of h.records) {
      const entry = h1ShadowEntrySchema.parse(
        JSON.parse(
          JSON.stringify({
            assetId: record.assetId,
            interval: record.interval,
            digits: record.digits,
            nowMs: record.decidedAtMs,
            source: record.source,
            version: record.version,
            params: record.params,
            series: record.series,
            decision: record.decision,
          }),
        ),
      );
      expect(replayH1Entry(entry)).toEqual(record.decision);
    }
  });

  it('H-X3: a no_signal writes no row and is counted by its reason', async () => {
    const h = harness();
    h.feed(A, T, flat(310));
    await flush();
    expect(h.records).toEqual([]);
    const line = h.line();
    expect(decisionsOf(line, 'r1')).toEqual({
      decisions: 10,
      signals: 0,
      rows: 0,
      unpriced: 0,
      noSignal: { no_volatility: 10 },
    });
  });

  it('H-X4: each set decides again after its own entry + expiry + 1 s; the outcome is written first', async () => {
    const h = harness();
    h.feed(A, T, spike(flat(10, 1.1002)));
    await flush();
    const line = h.line();
    // R1 decides at F, then from F + 7 s; the reference at F, then from F + 8 s (through F + 10 s)
    expect(decisionsOf(line, 'r1')).toMatchObject({ decisions: 5, signals: 1 });
    expect(decisionsOf(line, 'h1')).toMatchObject({ decisions: 4, signals: 1 });
    expect(rowsAt(h.records, F).map(setOf)).toEqual(['r1', 'h1']);
  });

  it('H-X5: an entry without a price is unpriced, the other entry keeps its outcome', async () => {
    const h = harness();
    h.feed(A, T, spike([1.1003, 1.1004, 1.1004, 1.1004, 1.1004, NaN, 1.1005]));
    await flush();
    expect(rowsAt(h.records, F)[0]!.result).toEqual({
      entries: [
        { entryDelaySec: 1, entryPrice: null, exitPrice: null, outcome: 'unpriced' },
        { entryDelaySec: 2, entryPrice: 1.1004, exitPrice: 1.1005, outcome: 'win' },
      ],
    });
    expect(decisionsOf(h.line(), 'r1')).toMatchObject({ rows: 1, unpriced: 1 });
  });

  it('H-X6: an exit at the entry price is a tie, by tradeOutcomeOf', async () => {
    const h = harness();
    h.feed(A, T, spike([1.1003, 1.1004, 1.1004, 1.1004, 1.1004, 1.1003, 1.1004]));
    await flush();
    const entries = (rowsAt(h.records, F)[0]!.result as { entries: { outcome: string }[] }).entries;
    expect(entries.map((entry) => entry.outcome)).toEqual([
      tradeOutcomeOf(TradeAction.Up, 1.1003, 1.1003),
      tradeOutcomeOf(TradeAction.Up, 1.1004, 1.1004),
    ]);
    expect(entries.map((entry) => entry.outcome)).toEqual(['tie', 'tie']);
  });

  it.each<[string, Partial<BinaryPair> | 'absent']>([
    ['a payout below 94', { payout: 93 }],
    ['a pair closed by its schedule', { scheduledUntil: F + 60_000 }],
    ['a pair that does not take a 5 s trade', { minTimeframe: 15 }],
    ['a pair not in the catalog', 'absent'],
  ])('H-X7: %s is not decided on', async (_label, patch) => {
    const h = harness({
      pairs: patch === 'absent' ? [pairOf(B)] : [pairOf(A, patch), pairOf(B)],
    });
    h.feed(A, T, spike(AFTER));
    h.feed(B, T, spike(AFTER));
    await flush();
    expect(h.records.filter((record) => record.assetId === A)).toEqual([]);
    expect(rowsAt(h.records, F).filter((record) => record.assetId === B)).toHaveLength(2);
    expect(h.line().ineligible).toBe(308);
  });

  it('H-X7: a pair that leaves the catalog after its signal still gets its row, at the payout it had', async () => {
    const h = harness();
    h.feed(A, T, spike(AFTER.slice(0, 3)));
    h.catalog.view = { ...h.catalog.view!, pairs: [pairOf(B)] };
    h.feed(A, F + 4_000, AFTER.slice(3));
    await flush();
    expect(rowsAt(h.records, F).map((record) => record.payout)).toEqual([96, 96]);
  });

  it('H-X8: without a fresh catalog nothing is decided, one warn a streak', async () => {
    const h = harness();
    h.catalog.view = { ...h.catalog.view!, fresh: false, ageMs: 200_000 };
    h.feed(A, T, spike(AFTER));
    await flush();
    expect(h.records).toEqual([]);
    expect(h.logs('h1 shadow skipped: no fresh catalog')).toHaveLength(1);
    expect(h.line().catalogStale).toBe(308);
  });

  it('H-X9: while the data socket does not stream nothing is decided', async () => {
    const h = harness();
    h.streaming.on = false;
    h.feed(A, T, spike(AFTER));
    await flush();
    expect(h.records).toEqual([]);
    expect(h.line()).toMatchObject({ sourceDown: 308 });
    expect(decisionsOf(h.line(), 'r1')).toMatchObject({ decisions: 0 });
  });

  it('H-X10: the first decision is on the first full window', async () => {
    const h = harness();
    h.feed(A, T, flat(300));
    await flush();
    const line = h.line();
    expect(decisionsOf(line, 'r1')).toMatchObject({ decisions: 0 });
    expect(line.warming).toBe(600);
    h.series.closeSecond(A, F, 1.1002);
    expect(decisionsOf(h.line(), 'r1')).toMatchObject({ decisions: 1, signals: 1 });
  });

  it('H-X11: a refused row is warned with its error name and counted; the next row is still written', async () => {
    let calls = 0;
    const written: SignalDecisionInput[] = [];
    const h = harness({
      record: (input) => {
        calls += 1;
        if (calls === 1)
          return Promise.reject(Object.assign(new Error('SECRET-msg'), { code: '23514' }));
        written.push(input);
        return Promise.resolve();
      },
    });
    h.feed(A, T, spike(AFTER));
    await flush();
    expect(written.map(setOf)).toEqual(['h1']);
    const [warn] = h.logs('h1 shadow decision not recorded');
    expect(warn).toMatchObject({ assetId: A, set: 'r1', err: { name: 'Error', code: '23514' } });
    expect(h.lines.join('\n')).not.toContain('SECRET-msg');
    expect(h.line().failed).toBe(1);
  });

  it('H-X12: a throw inside a decision is warned, never thrown into the series', () => {
    const h = harness();
    h.catalog.throws = true;
    expect(() => h.feed(A, T, flat(3))).not.toThrow();
    expect(h.logs('h1 shadow decision failed')).toHaveLength(3);
    expect(h.logs('h1 shadow decision failed')[0]).toMatchObject({
      assetId: A,
      err: { name: 'TypeError' },
    });
    expect(h.line().errors).toBe(3);
  });

  it('H-X13: the h1 shadow line carries both sets, the skips, the queue and the lag', async () => {
    const h = harness();
    h.feed(A, T, spike(flat(7, 1.1002)));
    await flush();
    const line = h.line();
    const own = Object.keys(line).filter(
      (key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key),
    );
    expect(own.sort()).toEqual(
      [
        'sets',
        'warming',
        'ineligible',
        'sourceDown',
        'catalogStale',
        'pending',
        'inflight',
        'failed',
        'dropped',
        'errors',
        'lagMsP50',
        'lagMsP95',
      ].sort(),
    );
    expect(Object.keys(line.sets as object)).toEqual(['r1', 'h1']);
    expect(decisionsOf(line, 'r1')).toMatchObject({ signals: 1, rows: 1 });
    expect(line).toMatchObject({ lagMsP50: 320, lagMsP95: 320, pending: 0 });
    // the period's lag is reset by the line
    expect(h.line()).toMatchObject({ lagMsP50: null, lagMsP95: null });
  });

  it('H-X14: stop() waits for the rows in flight and drops the pending outcomes', async () => {
    const releases: (() => void)[] = [];
    const h = harness({
      record: () => new Promise<void>((resolve) => releases.push(resolve)),
    });
    // A's two rows are in flight; B's two outcomes, from a jump at F + 3 s, are pending
    h.feed(A, T, spike(flat(7, 1.1002)));
    h.feed(B, T, [...flat(303), 1.1002, ...flat(3, 1.1002)]);
    await flush();
    expect(releases).toHaveLength(2);
    const stopping = h.shadow.stop();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);
    for (const release of releases) release();
    await stopping;
    expect(h.logs('h1 shadow stopped')).toEqual([expect.objectContaining({ pending: 2 })]);
    h.series.closeSecond(A, F + 20_000, 1.2);
    expect(h.series.listeners.size).toBe(0);
  });

  it('H-X15: the interval drives the clock rule of the series', async () => {
    vi.useFakeTimers();
    const h = harness();
    clock.now = T + 5_000;
    vi.advanceTimersByTime(350);
    expect(h.series.advanced).toEqual([T + 5_000, T + 5_000, T + 5_000]);
    await h.shadow.stop();
    vi.advanceTimersByTime(500);
    expect(h.series.advanced).toHaveLength(3);
  });

  it('H-X16: the row holds the window as the detector read it', async () => {
    const h = harness();
    h.feed(A, T, spike(AFTER.slice(0, 3)));
    h.series.prices.get(A)!.set(F - 1_000, 9);
    h.feed(A, F + 4_000, AFTER.slice(3));
    await flush();
    const row = rowsAt(h.records, F)[0]!;
    expect(row.series).toEqual([...flat(300), 1.1002]);
  });

  it('H-X17: two pairs keep their own cadence and outcomes', async () => {
    const h = harness();
    const a = spike(AFTER);
    const b = [...flat(302), 2.2, ...AFTER.map((price) => price + 1.1)];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i < a.length) h.series.closeSecond(A, T + i * 1_000, a[i]!);
      if (i < b.length) h.series.closeSecond(B, T + i * 1_000, b[i]!);
    }
    await flush();
    expect(rowsAt(h.records, F).map((record) => record.assetId)).toEqual([A, A]);
    expect(rowsAt(h.records, F + 2_000).map((record) => record.assetId)).toEqual([B, B]);
  });

  it('H-X18: an outcome whose seconds stopped closing is dropped by age, without a row', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.feed(A, T, spike(AFTER.slice(0, 2)));
    clock.now = F + 7_000 + CAPACITY_SEC * 1_000 + 1;
    vi.advanceTimersByTime(100);
    expect(h.line()).toMatchObject({ pending: 0, dropped: 2 });
    h.feed(A, F + 3_000, AFTER.slice(2));
    await h.shadow.stop();
    expect(h.records).toEqual([]);
  });
});
