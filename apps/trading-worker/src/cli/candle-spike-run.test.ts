import { BrokerRestError } from '@binarius/broker-rest';
import {
  BrokerRestErrorCode,
  decimalStringSchema,
  type BinaryPair,
  type BrokerUser,
  type Candle,
  type ChartRequest,
} from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { BrokerEventType, type BrokerEvent } from '../broker/events';
import {
  BrokerSocketState,
  type BrokerSocketClient,
  type BrokerSocketStateChange,
} from '../broker/socket';
import { exitCodeOf } from './candle-spike';
import { renderReport } from './candle-spike-report';
import {
  choosePairs,
  RAW_PROBE_IDS,
  runSpike,
  type IntervalResult,
  type RawSocket,
  type SpikeDeps,
  type SpikeOptions,
  type SpikeReportInput,
  type SpikeRun,
} from './candle-spike-run';

const d = (value: string) => decimalStringSchema.parse(value);
const BROKER_USER_ID = 'SECRET-user-7';
const ACCESS_TOKEN = 'SECRET-token';
const T0 = 1_760_000_000_000;
const TICK_EVERY_MS = 250;
// ticks never fall on a candle boundary
const TICK_OFFSET_MS = 100;
const DIGITS = 5;

const pair = (id: number, fields: Partial<BinaryPair> = {}): BinaryPair => ({
  id,
  symbol: `PAIR${id}`,
  type: 'currency',
  digits: DIGITS,
  payout: 85,
  maxPayout: 90,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
  ...fields,
});

const user = (id: string): BrokerUser => ({
  id,
  level: { code: 'standard', rank: 1 },
  minTradeAmount: d('1.00'),
  real: { available: d('0'), held: d('0'), total: d('0') },
  demo: { available: d('100.00'), held: d('0'), total: d('100.00') },
});

// one price path per asset, read by the socket's ticks and by the chart stub alike
const priceAt = (assetId: number, t: number) =>
  Number(
    (
      1 +
      assetId / 1000 +
      0.0006 * Math.sin((t - T0) / 9_000) +
      0.00004 * Math.sin((t - T0) / 1_300 + assetId)
    ).toFixed(DIGITS),
  );

const tickTimes = (from: number, to: number) => {
  const times: number[] = [];
  const first = Math.ceil((from - TICK_OFFSET_MS) / TICK_EVERY_MS) * TICK_EVERY_MS + TICK_OFFSET_MS;
  for (let t = first; t < to; t += TICK_EVERY_MS) times.push(t);
  return times;
};

// The broker's chart: rows by start [b, b + step) (the 1s rows labelled by their end, so the row
// labelled s holds [s - 1000, s)), open = the previous bucket's close except the answer's first
// row, whose open is the first tick inside the window (docs/signal-stand.md -> The cache).
function chart(request: ChartRequest, clock: number, skip: (row: number) => boolean): Candle[] {
  const step = request.interval === '1s' ? 1_000 : request.interval === '5s' ? 5_000 : 15_000;
  const shift = request.interval === '1s' ? 1_000 : 0;
  const rows: Candle[] = [];
  for (let i = 0; i < request.limit; i++) {
    const label = request.startTime + i * step;
    const start = label - shift;
    if (start + step > clock) break;
    if (skip(label)) continue;
    const prices = tickTimes(start, start + step).map((t) => priceAt(request.assetId, t));
    const previous = tickTimes(start - step, start).map((t) => priceAt(request.assetId, t));
    const open = rows.length === 0 ? prices[0]! : previous.at(-1)!;
    rows.push({
      timestamp: label,
      open,
      high: Math.max(open, ...prices),
      low: Math.min(open, ...prices),
      close: prices.at(-1)!,
    });
  }
  return rows;
}

interface FakeClient extends BrokerSocketClient {
  fire(to: BrokerSocketState, reason?: string): void;
  hear(event: BrokerEvent): void;
}

interface Options {
  catalog?: BinaryPair[];
  socketCatalog?: BinaryPair[];
  burst?: BrokerEvent[];
  ready?: boolean;
  // ids the broker sends ticks for
  ticking?: (assetId: number) => boolean;
  // no ticks in [fromMs, toMs): reconnecting at fromMs, ready again at toMs
  drop?: { fromMs: number; toMs: number };
  getChart?: (request: ChartRequest, h: Harness) => Promise<Candle[]>;
  skipRow?: (request: ChartRequest, label: number) => boolean;
  rawAuth?: 'success' | 'error' | 'silent';
  options?: Partial<SpikeOptions>;
  onSleep?: (h: Harness) => void;
}

interface Harness {
  client: FakeClient;
  clock: number;
  subscribed: Set<number>;
  sleeps: number[];
  lines: string[];
  chartCalls: ChartRequest[];
  rawEmits: { event: string; payload: unknown }[];
  rawDisconnected: boolean;
  stop: AbortController;
  run(): Promise<SpikeRun>;
}

const CATALOG = [pair(101), pair(102, { payout: 90 }), pair(103, { type: 'stock' })];

function harness(o: Options = {}): Harness {
  const catalog = o.catalog ?? CATALOG;
  const h = {
    clock: T0,
    subscribed: new Set<number>(),
    sleeps: [],
    lines: [],
    chartCalls: [],
    rawEmits: [],
    rawDisconnected: false,
    stop: new AbortController(),
  } as unknown as Harness;

  const stateListeners = new Set<(change: BrokerSocketStateChange) => void>();
  const eventListeners = new Set<(event: BrokerEvent) => void>();
  let state: BrokerSocketState = BrokerSocketState.Idle;
  const client: FakeClient = {
    fire(to, reason) {
      const change = reason === undefined ? { from: state, to } : { from: state, to, reason };
      state = to;
      for (const listener of [...stateListeners]) listener(change);
    },
    hear(event) {
      for (const listener of [...eventListeners]) listener(event);
    },
    start() {
      if (o.ready !== false) client.fire(BrokerSocketState.Ready);
      const burst = o.burst ?? [
        { type: BrokerEventType.UserData, user: user(BROKER_USER_ID) },
        { type: BrokerEventType.AssetsList, pairs: o.socketCatalog ?? catalog },
      ];
      for (const event of burst) client.hear(event);
    },
    stop: () => undefined,
    subscribe: (ids) => ids.forEach((id) => h.subscribed.add(id)),
    subscriptions: () => [...h.subscribed].sort((a, b) => a - b),
    openTrade: () => Promise.reject(new Error('the spike sends no command')),
    get state() {
      return state;
    },
    connections: 1,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
  h.client = client;

  const raw = {
    handlers: new Map<string, (...args: unknown[]) => void>(),
    any: undefined as ((event: string, ...args: unknown[]) => void) | undefined,
    connected: false,
  };
  let rawOpen = false;
  const rawSocket: RawSocket = {
    on: (event, listener) => raw.handlers.set(event, listener),
    onAny: (listener) => {
      raw.any = listener;
    },
    emit(event, payload) {
      h.rawEmits.push({ event, payload });
      if (event === 'user.auth') {
        if (o.rawAuth === 'error') raw.handlers.get('user.auth.error')?.({ message: 'no' });
        if ((o.rawAuth ?? 'success') === 'success') raw.handlers.get('user.auth.success')?.();
      }
      if (event === 'price.subscribe') {
        const ids = (payload as { assets: number[] }).assets;
        raw.any?.('price.subscribed', ids);
        for (const id of ids.slice(0, 3)) {
          raw.any?.('price.update', [id, priceAt(id, h.clock), h.clock]);
        }
      }
    },
    disconnect() {
      h.rawDisconnected = true;
      raw.handlers.get('disconnect')?.('io client disconnect');
    },
  };

  const ticking = o.ticking ?? (() => true);
  const advance = (to: number) => {
    for (const t of tickTimes(h.clock, to)) {
      if (o.drop !== undefined && t >= o.drop.fromMs && state === BrokerSocketState.Ready) {
        if (t < o.drop.toMs) client.fire(BrokerSocketState.Reconnecting, 'transport close');
      }
      if (o.drop !== undefined && t >= o.drop.toMs && state === BrokerSocketState.Reconnecting) {
        client.fire(BrokerSocketState.Ready);
      }
      h.clock = t;
      if (state !== BrokerSocketState.Ready) continue;
      for (const id of [...h.subscribed].sort((a, b) => a - b)) {
        if (!ticking(id)) continue;
        client.hear({
          type: BrokerEventType.PriceUpdate,
          update: { assetId: id, price: priceAt(id, t), timestamp: t },
        });
      }
    }
    h.clock = to;
  };

  const deps: SpikeDeps = {
    openClient: () => client,
    openRawSocket: () => {
      rawOpen = true;
      return rawSocket;
    },
    rest: {
      listPairs: () => Promise.resolve(catalog),
      getChart(request) {
        h.chartCalls.push(request);
        if (o.getChart !== undefined) return o.getChart(request, h);
        return Promise.resolve(
          chart(request, h.clock, (label) => o.skipRow?.(request, label) ?? false),
        );
      },
    },
    credentials: { brokerUserId: BROKER_USER_ID, accessToken: ACCESS_TOKEN },
    now: () => h.clock,
    sleep(ms) {
      h.sleeps.push(ms);
      if (rawOpen && !raw.connected) {
        raw.connected = true;
        raw.handlers.get('connect')?.();
      }
      advance(h.clock + ms);
      o.onSleep?.(h);
      return Promise.resolve();
    },
    say: (line) => h.lines.push(line),
    sample: () => ({ cpuMicros: (h.clock - T0) * 100, rssBytes: 50 * 1024 * 1024 }),
    stop: h.stop.signal,
    timing: {
      readyTimeoutMs: 1_000,
      capacityWindowMs: 2_000,
      rawProbeWindowMs: 1_000,
      restPaceMs: 10,
      progressEveryMs: 300_000,
      sampleEveryMs: 60_000,
    },
    options: { minutes: 3, pairs: 10, subscribeAll: true, ...o.options },
  };
  h.run = () => runSpike(deps);
  return h;
}

async function ran(
  h: Harness,
): Promise<SpikeReportInput & { compared: number; windowCompleted: boolean }> {
  const result = await h.run();
  if (result.kind !== 'ran') throw new Error(`expected a run, got ${result.what}`);
  return { ...result.report, compared: result.compared, windowCompleted: result.windowCompleted };
}

const interval = (report: SpikeReportInput, id: number, name: string): IntervalResult =>
  report.pairs.find((p) => p.pair.id === id)!.intervals.find((i) => i.interval === name)!;

describe('runSpike setup', () => {
  it('R1 a user.data of another user: setup failed, nothing subscribed', async () => {
    const h = harness({
      burst: [
        { type: BrokerEventType.UserData, user: user('8') },
        { type: BrokerEventType.AssetsList, pairs: CATALOG },
      ],
    });
    expect(await h.run()).toEqual({ kind: 'setup_failed', what: 'user.data of another user' });
    expect(h.subscribed.size).toBe(0);
  });

  it('R1b no ready within the timeout: setup failed', async () => {
    const h = harness({ ready: false });
    expect(await h.run()).toEqual({ kind: 'setup_failed', what: 'not within 1000 ms: ready' });
  });

  it('E2 SPIKE_ASSET_IDS: an unknown id or digits out of range fail by index before any socket', async () => {
    const unknown = harness({ options: { assetIds: [101, 999] } });
    expect(await unknown.run()).toEqual({ kind: 'setup_failed', what: 'unknown asset id 1' });
    const wide = harness({
      catalog: [...CATALOG, pair(104, { digits: 11 })],
      options: { assetIds: [104] },
    });
    expect(await wide.run()).toEqual({
      kind: 'setup_failed',
      what: 'asset id 0 has digits out of range',
    });
    expect(wide.client.state).toBe(BrokerSocketState.Idle);
  });
});

describe('runSpike phase A', () => {
  it('R2 coverage per 40-id chunk, and one raw message of 41 ids', async () => {
    const catalog = Array.from({ length: 90 }, (_, i) => pair(1_000 + i));
    const h = harness({ catalog, ticking: (id) => id < 1_040, options: { minutes: 1 } });
    const report = await ran(h);

    expect(report.capacity.chunks).toEqual([
      { size: 40, withTicks: 40 },
      { size: 40, withTicks: 0 },
      { size: 10, withTicks: 0 },
    ]);
    expect([report.capacity.subscribed, report.capacity.withTicks]).toEqual([90, 40]);
    const subscribes = h.rawEmits.filter((emit) => emit.event === 'price.subscribe');
    expect(subscribes).toHaveLength(1);
    expect((subscribes[0]!.payload as { assets: number[] }).assets).toHaveLength(RAW_PROBE_IDS);
    expect(report.raw).toEqual({
      outcome: 'ran',
      echoIds: 41,
      events: ['price.subscribed', 'price.update'],
      idsWithTicks: 3,
      disconnectedByServer: false,
    });
    expect(h.rawDisconnected).toBe(true);
  });

  it('the raw probe refused at user.auth: a row, and the run goes on', async () => {
    const catalog = Array.from({ length: 45 }, (_, i) => pair(1_000 + i));
    const report = await ran(harness({ catalog, rawAuth: 'error', options: { minutes: 1 } }));
    expect(report.raw.outcome).toBe('auth_failed');
    expect(report.compared).toBeGreaterThan(0);
  });
});

describe('runSpike phase B and the comparison', () => {
  it('R3 the broker convention: one step early, the first row dropped, open/close exact', async () => {
    // the broker has no 5s row before pair 102's first wanted one: its answer starts at the range
    const h = harness({
      options: { minutes: 6 },
      skipRow: (request, label) =>
        request.assetId === 102 && request.interval === '5s' && label < request.startTime + 5_000,
    });
    const report = await ran(h);

    for (const id of [101, 102, 103]) {
      for (const name of ['5s', '15s']) {
        const result = interval(report, id, name);
        expect(result.candles!.compared).toBeGreaterThan(0);
        expect(result.candles!.openEq).toBe(result.candles!.compared);
        expect(result.candles!.closeEq).toBe(result.candles!.compared);
        expect(result.candles!.restOnly).toBe(0);
        expect(result.aggregation!.allEq).toBe(result.aggregation!.compared);
      }
    }
    // the first row of 102's answer is in the range and dropped
    expect(interval(report, 102, '5s').candles!.ticksOnly).toBe(1);
    expect(interval(report, 101, '5s').candles!.ticksOnly).toBe(0);

    const r5 = interval(report, 101, '5s');
    const n5 = (r5.range!.lastMs - r5.range!.firstMs) / 5_000 + 1;
    expect(r5.aggregation!.compared).toBe(n5);
    const calls = h.chartCalls.filter((call) => call.assetId === 101);
    expect(calls.map((call) => [call.interval, call.startTime - r5.range!.firstMs])).toEqual([
      ['1s', 0],
      ['5s', -5_000],
      ['15s', expect.any(Number)],
    ]);
    expect(calls[0]!.limit).toBe(6 * 60 + 6);
    expect(calls[1]!.limit).toBe(n5 + 3);
    expect(r5.decisions!.compared).toBeGreaterThan(0);
    expect(r5.decisions!.differ).toBe(0);
    expect(report.compared).toBeGreaterThan(0);
    expect(report.windowCompleted).toBe(true);
    expect(
      exitCodeOf({ kind: 'ran', report, compared: report.compared, windowCompleted: true }),
    ).toBe(0);
  });

  it('R4 a drop mid-run is one hole; the candles around it are counted apart', async () => {
    const fromMs = T0 + 2_000 + 1_000 + 60_000;
    const h = harness({ options: { minutes: 3 }, drop: { fromMs, toMs: fromMs + 20_000 } });
    const report = await ran(h);

    expect(report.stateChanges.map((change) => [change.from, change.to])).toEqual([
      ['ready', 'reconnecting'],
      ['reconnecting', 'ready'],
    ]);
    expect(report.holes).toHaveLength(1);
    const [hole] = report.holes;
    expect(hole!.backAt! - hole!.leftAt).toBeGreaterThanOrEqual(19_000);
    expect(hole!.span.toMs - hole!.span.fromMs).toBeGreaterThan(19_000);
    expect(report.stateChanges[0]!.watermark).toBe(hole!.span.fromMs);
    const result = interval(report, 101, '5s').candles!;
    expect(result.inHole).toBeGreaterThanOrEqual(4);
    expect(result.restOnly).toBe(0);
  });

  it('R5 a 429 is retried once after Retry-After, then the series is rest_unavailable', async () => {
    const limited = (times: number) => {
      let left = times;
      return harness({
        getChart: (request, h) => {
          if (request.assetId === 102 && request.interval === '15s' && left > 0) {
            left -= 1;
            return Promise.reject(
              new BrokerRestError(BrokerRestErrorCode.RateLimited, { retryAfterSec: 7 }),
            );
          }
          return Promise.resolve(chart(request, h.clock, () => false));
        },
      });
    };

    const once = limited(1);
    const recovered = await ran(once);
    expect(once.sleeps).toContain(7_000);
    expect(interval(recovered, 102, '15s').rest).toEqual({ ok: true });

    const twice = limited(2);
    const report = await ran(twice);
    expect(twice.chartCalls.filter((c) => c.assetId === 102 && c.interval === '15s')).toHaveLength(
      2,
    );
    expect(interval(report, 102, '15s')).toMatchObject({
      rest: { ok: false, code: 'rate_limited' },
    });
    expect(interval(report, 102, '15s').candles).toBeUndefined();
    expect(interval(report, 102, '5s').candles!.compared).toBeGreaterThan(0);
    expect(interval(report, 101, '15s').candles!.compared).toBeGreaterThan(0);
  });

  it('R6 SIGINT in phase B: the fetch and the comparison run on the candles so far', async () => {
    const stopAt = T0 + 2_000 + 1_000 + 90_000;
    const h = harness({
      options: { minutes: 3 },
      onSleep: (harnessed) => {
        if (harnessed.clock >= stopAt) harnessed.stop.abort();
      },
    });
    const report = await ran(h);

    expect(report.interrupted).toBe(true);
    expect(report.windowCompleted).toBe(false);
    expect(report.phaseBMs).toBeLessThan(100_000);
    expect(h.chartCalls.length).toBe(9);
    expect(report.compared).toBeGreaterThan(0);
    expect(renderReport(report)).toContain('interrupted');
    expect(
      exitCodeOf({ kind: 'ran', report, compared: report.compared, windowCompleted: false }),
    ).toBe(1);
  });

  it('R7 nothing compared: exit 1', async () => {
    const h = harness({
      getChart: () => Promise.reject(new BrokerRestError(BrokerRestErrorCode.Unavailable)),
    });
    const result = await h.run();
    expect(result.kind === 'ran' && [result.compared, result.windowCompleted]).toEqual([0, true]);
    expect(exitCodeOf(result)).toBe(1);
    expect(exitCodeOf({ kind: 'setup_failed', what: 'x' })).toBe(1);
  });

  it('R9 the report: no secret, MA200 on 15s not measured, the summary block', async () => {
    const report = await ran(harness({ options: { minutes: 6 } }));
    const text = renderReport(report);
    expect(text).not.toContain('SECRET-');
    expect(text).toContain('## Summary (for #404)');
    expect(text).toMatch(/MA200 не измерено/);
    expect(text).toContain('subscription cap: none observed up to 3 ids');
  });
});

describe('choosePairs', () => {
  it('R8 one pair per type group in order, round after round, by payout, above the floor', () => {
    const catalog = [
      pair(1, { payout: 85 }),
      pair(2, { payout: 92 }),
      pair(3, { payout: 81 }),
      pair(4, { type: 'cryptocurrency', payout: 88 }),
      pair(5, { type: 'stock', payout: 80 }),
      pair(6, { payout: 95, scheduledUntil: T0 + 60_000 }),
      pair(7, { payout: 79 }),
      pair(8, { payout: 99, digits: 11 }),
    ];
    const choice = choosePairs(catalog, T0, 4);
    expect(choice.chosen.map((p) => [p.id, p.group])).toEqual([
      [2, 'currency'],
      [5, 'stock'],
      [4, 'cryptocurrency'],
      [1, 'currency'],
    ]);
    expect(choice.skippedDigits).toBe(1);
    expect(choice.emptyGroups).toEqual(['commodity', 'index', 'other']);
  });
});
