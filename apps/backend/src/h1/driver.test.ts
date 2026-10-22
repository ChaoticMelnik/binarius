import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildH1SessionSettings,
  decimalStringSchema,
  H1_R1_PARAMS,
  h1ShadowEntrySchema,
  logOptions,
  toBinaryPair,
  TradeIntentErrorCode,
  TradeIntentStatus,
  type BinaryPair,
  type H1SessionSettings,
  type PairsCatalogView,
} from '@binarius/shared';
import {
  TradeIntentError,
  TradingSessionNotActiveError,
  type ActiveH1Session,
  type CreateSessionIntentInput,
  type CreateTradeIntentResult,
  type SessionHistory,
  type SessionHistoryIntent,
  type SignalDecisionInput,
  type TradeIntentRow,
} from '@binarius/db';
import { createH1Detector, replayH1Entry } from '@binarius/signal';
import type { ClosedSecond } from '../market-data/seconds';
import { createH1Driver, type H1Driver, type H1DriverDeps } from './driver';

// The H1 driver (#707, docs/h1.md -> The driver). A scripted series closes seconds in order; T is
// the first second, F = T + 300 s the first one with a full 301-second window. A ramp from F on
// signals up on every second (each 3-second move stands far above the flat window's RMS).
const T = 1_760_000_000_000;
const F = T + 300_000;
const A = 101;
const B = 202;
const BUDGET_MS = 700;

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

function h1Settings(patch: Partial<H1SessionSettings> = {}): H1SessionSettings {
  const built = buildH1SessionSettings({
    assetId: A,
    trades: 50,
    stake: { baseStake: decimalStringSchema.parse('1.5'), stakeScale: 2 },
    maxLossMultiplier: 20,
  });
  if (!built.success || built.data.version !== 4) throw new Error('H1 fixture settings');
  return { ...built.data, ...patch };
}

const sessionOf = (id: string, settings: unknown = h1Settings()): ActiveH1Session => ({
  id,
  brokerAccountId: `acc-${id}`,
  mode: 'demo',
  telegramUserId: '1001',
  settings,
  startedAt: new Date(T),
});

const clock = { now: T };

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
  const api: H1DriverDeps['series'] = {
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
    lastTickOf(assetId, f) {
      const price = close(assetId, f);
      return Number.isNaN(price) ? undefined : { price, timestamp: f - 100, receivedAtMs: f - 60 };
    },
    digitsOf: () => 5,
  };
  return {
    api,
    advanced,
    closeSecond(assetId: number, second: number, price: number) {
      if (!firstHeld.has(assetId)) firstHeld.set(assetId, second);
      const own = prices.get(assetId) ?? new Map<number, number>();
      own.set(second, price);
      prices.set(assetId, own);
      closedUntil.set(assetId, second);
      const closedAtMs = second + 300;
      clock.now = closedAtMs + 20;
      for (const listener of listeners) {
        listener({ assetId, second, closedBy: 'tick', closedAtMs });
      }
    },
  };
}

const emptyHistory = (intents: Partial<SessionHistoryIntent>[] = []): SessionHistory => ({
  telegramUserId: '1001',
  expired: false,
  waitExpired: false,
  lossLimitReached: false,
  intents: intents.map((intent, i) => ({
    id: `h-${i}`,
    action: 'up',
    status: TradeIntentStatus.Settled,
    amount: decimalStringSchema.parse('1.5'),
    profit: decimalStringSchema.parse('1.38'),
    lastError: null,
    ...intent,
  })),
});

interface Harness {
  driver: H1Driver;
  series: ReturnType<typeof scriptedSeries>;
  listed: ActiveH1Session[];
  histories: Map<string, SessionHistory | undefined>;
  creates: CreateSessionIntentInput[];
  records: SignalDecisionInput[];
  stops: { id: string; reason: string }[];
  wakes: { n: number };
  catalog: { view: PairsCatalogView | undefined };
  streaming: { on: boolean };
  // the next createIntent answers: a result, a throw, or a pending promise the test resolves
  answers: (() => Promise<CreateTradeIntentResult>)[];
  feed(assetId: number, from: number, prices: readonly number[]): void;
  // as feed, letting each second from F on finish its trade before the next one closes
  feedSettled(assetId: number, from: number, prices: readonly number[]): Promise<void>;
  line(): Record<string, unknown>;
  logs(msg: string): Record<string, unknown>[];
}

const drivers: H1Driver[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.stop();
  vi.useRealTimers();
});

const created = (id = 'intent-1'): CreateTradeIntentResult => ({
  intent: { id } as TradeIntentRow,
  created: true,
});

async function harness(
  options: { sessions?: ActiveH1Session[]; pairs?: BinaryPair[]; start?: boolean } = {},
): Promise<Harness> {
  const series = scriptedSeries();
  const lines: string[] = [];
  const logger = pino(logOptions('debug'), { write: (line: string) => lines.push(line) });
  const listed = options.sessions ?? [sessionOf('s1')];
  const histories = new Map<string, SessionHistory | undefined>();
  const creates: CreateSessionIntentInput[] = [];
  const records: SignalDecisionInput[] = [];
  const stops: { id: string; reason: string }[] = [];
  const wakes = { n: 0 };
  const answers: (() => Promise<CreateTradeIntentResult>)[] = [];
  const catalog = {
    view: {
      pairs: options.pairs ?? [pairOf(A), pairOf(B)],
      fetchedAt: T,
      ageMs: 0,
      fresh: true,
    } as PairsCatalogView | undefined,
  };
  const streaming = { on: true };
  const h: Harness = {
    driver: undefined as unknown as H1Driver,
    series,
    listed,
    histories,
    creates,
    records,
    stops,
    wakes,
    catalog,
    streaming,
    answers,
    feed(assetId, from, prices) {
      prices.forEach((price, i) => series.closeSecond(assetId, from + i * 1_000, price));
    },
    async feedSettled(assetId, from, prices) {
      for (const [i, price] of prices.entries()) {
        const second = from + i * 1_000;
        series.closeSecond(assetId, second, price);
        if (second >= F) await flush();
      }
    },
    line() {
      h.driver.report();
      const written = parsed('h1 driver').at(-1);
      if (written === undefined) throw new Error('no h1 driver line');
      return written;
    },
    logs: (msg) => parsed(msg),
  };
  const parsed = (msg: string) =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === msg);
  h.driver = createH1Driver({
    series: series.api,
    catalog: { read: () => catalog.view },
    streaming: () => streaming.on,
    sessions: {
      list: () => Promise.resolve([...h.listed]),
      history: (id) => Promise.resolve(histories.has(id) ? histories.get(id) : emptyHistory()),
      createIntent: (input) => {
        creates.push(input);
        const answer = answers.shift();
        return answer === undefined
          ? Promise.resolve(created(`intent-${creates.length}`))
          : answer();
      },
      stop: (id, reason) => {
        stops.push({ id, reason });
        return Promise.resolve({ id });
      },
      record: (input) => {
        records.push(input);
        return Promise.resolve();
      },
    },
    wake: () => void (wakes.n += 1),
    logger,
    now: () => clock.now,
    config: { scanMs: 5_000, tickMs: 100, logMs: 60_000, submitBudgetMs: BUDGET_MS },
  });
  drivers.push(h.driver);
  if (options.start !== false) {
    h.driver.start();
    await h.driver.scan();
  }
  return h;
}

const flat = (n: number, price = 1.1) => Array<number>(n).fill(price);
// 300 flat seconds from T, then a ramp of `n` seconds from F: every ramp second signals up
const ramp = (n: number) => [
  ...flat(300),
  ...Array.from({ length: n }, (_, i) => 1.1 + (i + 1) * 0.0001),
];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the H1 driver (#707)', () => {
  it('H1-DR1: a signal becomes an intent with the deadline taken_at + budget, its row, then a wake', async () => {
    const h = await harness();
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    const input = h.creates[0]!;
    const takenAtMs = F + 320;
    const closes = [...flat(300), 1.1001];
    expect(input).toEqual({
      sessionId: 's1',
      step: 1,
      telegramUserId: '1001',
      brokerAccountId: 'acc-s1',
      mode: 'demo',
      assetId: A,
      amount: '1.5',
      action: 'up',
      durationSec: 5,
      submitDeadlineAt: new Date(takenAtMs + BUDGET_MS),
      decision: {
        context: 'session',
        tradingSessionId: 's1',
        brokerAccountId: 'acc-s1',
        step: 1,
        assetId: A,
        interval: null,
        version: 'h1',
        decidedAtMs: F,
        takenAtMs,
        kind: 'signal',
        action: 'up',
        payout: 96,
        digits: 5,
        params: { set: 'session', ...H1_R1_PARAMS, entryDelaySec: 1, expirySec: 5 },
        decision: createH1Detector(H1_R1_PARAMS).decide({ closes, at: 300 }),
        source: { kind: 'ticks', symbol: `P${A}`, closedBy: 'tick', closedAtMs: F + 300 },
        series: closes,
        lastTick: { price: 1.1001, timestamp: F - 100, receivedAtMs: F - 60 },
        outcome: 'intent',
        detail: null,
        ticksUntilMs: null,
      },
    });
    expect(h.wakes.n).toBe(1);
    expect(h.records).toEqual([]);
  });

  it("H1-DR2: the row is the shadow's shape: it parses as an entry and decides again to itself", async () => {
    const h = await harness();
    h.feed(A, T, ramp(1));
    await flush();
    const row = h.creates[0]!.decision!;
    const entry = h1ShadowEntrySchema.parse({
      assetId: row.assetId,
      interval: row.interval,
      digits: row.digits,
      nowMs: row.decidedAtMs,
      source: row.source,
      version: row.version,
      params: row.params,
      series: row.series,
      decision: row.decision,
    });
    expect(replayH1Entry(entry)).toEqual(row.decision);
  });

  it('H1-DR3: one trade at a time: the seconds before f + 7 s are held, f + 7 s decides again', async () => {
    const h = await harness();
    await h.feedSettled(A, T, ramp(8));
    await flush();
    expect(h.creates.map((input) => input.decision!.decidedAtMs)).toEqual([F, F + 7_000]);
    expect(h.line()).toMatchObject({ held: 6, signals: 2, intents: 2 });
  });

  it('H1-DR4: a live intent of the session skips the signal without an intent', async () => {
    const h = await harness();
    h.histories.set('s1', emptyHistory([{ status: TradeIntentStatus.Accepted, profit: null }]));
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.line()).toMatchObject({ signals: 1, skippedLive: 1, intents: 0 });
  });

  it('H1-DR5: while a creation is in flight the next signal of the session is skipped', async () => {
    const h = await harness();
    let resolve!: (result: CreateTradeIntentResult) => void;
    h.answers.push(() => new Promise((done) => (resolve = done)));
    h.feed(A, T, ramp(3));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.line()).toMatchObject({ signals: 1, skippedLive: 2 });
    resolve(created());
    await flush();
    expect(h.wakes.n).toBe(1);
  });

  it.each([
    ['completed', emptyHistory(Array.from({ length: 50 }, () => ({})))],
    [
      'max_loss',
      { ...emptyHistory([{ profit: decimalStringSchema.parse('-1.5') }]), lossLimitReached: true },
    ],
    [
      'rejected_twice',
      emptyHistory([
        {},
        { status: TradeIntentStatus.Rejected, profit: null, lastError: 'entry_window_missed' },
        { status: TradeIntentStatus.Rejected, profit: null },
      ]),
    ],
    ['expired', { ...emptyHistory(), expired: true }],
  ] as const)(
    'H1-DR6: %s skips without an intent: the orchestrator stops it',
    async (reason, history) => {
      const h = await harness();
      h.histories.set('s1', history);
      h.feed(A, T, ramp(1));
      await flush();
      expect(h.creates).toEqual([]);
      expect(h.stops).toEqual([]);
      expect(h.line()).toMatchObject({ skippedLimits: { [reason]: 1 }, intents: 0 });
    },
  );

  it('H1-DR7: the payout is not read: a pair at 90 % still trades', async () => {
    const h = await harness({ pairs: [pairOf(A, { payout: 90 })] });
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.decision!.payout).toBe(90);
  });

  it.each([
    ['not in the catalog', [pairOf(B)]],
    ['closed until later', [pairOf(A, { scheduledUntil: F + 3_600_000 })]],
    ['refusing 5 s', [pairOf(A, { minTimeframe: 15 })]],
  ] as const)('H1-DR8: a pair %s is ineligible', async (_name, pairs) => {
    const h = await harness({ pairs: [...pairs] });
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.line()).toMatchObject({ decisions: 0 });
  });

  it('H1-DR9: no stream or no fresh catalog decides nothing; the stale catalog warns once', async () => {
    const h = await harness();
    h.streaming.on = false;
    h.feed(A, T, ramp(1));
    h.streaming.on = true;
    h.catalog.view = { pairs: [pairOf(A)], fetchedAt: T, ageMs: 90_000, fresh: false };
    h.series.closeSecond(A, F + 1_000, 1.1002);
    h.series.closeSecond(A, F + 2_000, 1.1003);
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.line()).toMatchObject({ sourceDown: 301, catalogStale: 2, decisions: 0 });
    expect(h.logs('h1 driver skipped: no fresh catalog')).toHaveLength(1);
  });

  it('H1-DR10: a stop refusal stops the session, writes its refused row and forgets it', async () => {
    const h = await harness();
    h.answers.push(() => Promise.reject(new TradeIntentError(TradeIntentErrorCode.AccountHalted)));
    h.feed(A, T, ramp(9));
    await flush();
    expect(h.stops).toEqual([{ id: 's1', reason: 'manual_review' }]);
    expect(h.records).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        detail: 'account_halted',
        step: 1,
        decidedAtMs: F,
      }),
    ]);
    expect(h.creates).toHaveLength(1);
    expect(h.line()).toMatchObject({ refused: 1, stops: 1, sessions: 0 });
    // a scan that still lists it (the stop's commit raced the read) does not take it back
    await h.driver.scan();
    h.series.closeSecond(A, F + 9_000, 1.2);
    await flush();
    expect(h.creates).toHaveLength(1);
  });

  it('H1-DR11: a reschedule refusal keeps the session: its row, no stop, the next signal tries again', async () => {
    const h = await harness();
    h.answers.push(() =>
      Promise.reject(new TradeIntentError(TradeIntentErrorCode.ActiveIntentExists)),
    );
    await h.feedSettled(A, T, ramp(2));
    await flush();
    expect(h.stops).toEqual([]);
    expect(h.records).toEqual([
      expect.objectContaining({ outcome: 'refused', detail: 'active_intent_exists' }),
    ]);
    expect(h.creates.map((input) => input.decision!.decidedAtMs)).toEqual([F, F + 1_000]);
  });

  it('H1-DR12: a replayed step holds the cadence and wakes nothing', async () => {
    const h = await harness();
    h.answers.push(() => Promise.resolve({ ...created(), created: false }));
    await h.feedSettled(A, T, ramp(3));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.wakes.n).toBe(0);
    expect(h.line()).toMatchObject({ replayed: 1, intents: 0, held: 2 });
  });

  it('H1-DR13: a refused decision INSERT still counts the intent and wakes, with a warn', async () => {
    const h = await harness();
    h.answers.push(() =>
      Promise.resolve({
        ...created(),
        decisionError: Object.assign(new Error('x'), { code: '23514' }),
      }),
    );
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.wakes.n).toBe(1);
    expect(h.logs('h1 driver decision not recorded')).toEqual([
      expect.objectContaining({ reason: 'insert_refused', sessionId: 's1' }),
    ]);
  });

  it('H1-DR14: settings it cannot decide on are skipped with one warn', async () => {
    const wide = h1Settings({
      signal: { ...h1Settings().signal, params: { ...H1_R1_PARAMS, moveSec: 6 } },
    });
    const h = await harness({ sessions: [sessionOf('s1', wide), sessionOf('s2', { version: 9 })] });
    await h.driver.scan();
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.logs('h1 driver session skipped')).toEqual([
      expect.objectContaining({ sessionId: 's1', reason: 'invalidSettings' }),
      expect.objectContaining({ sessionId: 's2', reason: 'invalidSettings' }),
    ]);
    expect(h.line()).toMatchObject({ sessions: 0, invalidSettings: 2 });
  });

  it("H1-DR15: the tick advances the series by the clock (H1_SHADOW=off leaves it the driver's)", async () => {
    vi.useFakeTimers();
    const h = await harness();
    clock.now = T + 5_000;
    vi.advanceTimersByTime(250);
    expect(h.series.advanced).toEqual([T + 5_000, T + 5_000]);
  });

  it('H1-DR16: stop() waits for the creation in flight and wakes nothing after it', async () => {
    const h = await harness();
    let resolve!: (result: CreateTradeIntentResult) => void;
    h.answers.push(() => new Promise((done) => (resolve = done)));
    h.feed(A, T, ramp(1));
    await flush();
    let stopped = false;
    const stopping = h.driver.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);
    resolve(created());
    await stopping;
    expect(stopped).toBe(true);
    expect(h.wakes.n).toBe(0);
  });

  it('H1-DR17: a session gone or no longer active is forgotten', async () => {
    const h = await harness({
      sessions: [sessionOf('s1'), sessionOf('s2', h1Settings({ assetId: B }))],
    });
    h.histories.set('s1', undefined);
    h.answers.push(() => Promise.reject(new TradingSessionNotActiveError('s2')));
    h.feed(A, T, ramp(1));
    h.feed(B, T, ramp(1));
    await flush();
    expect(h.creates.map((input) => input.sessionId)).toEqual(['s2']);
    expect(h.line()).toMatchObject({ gone: 2, sessions: 0 });
  });

  it('H1-DR18: a scan adds a new session and drops one no longer listed', async () => {
    const h = await harness({ sessions: [] });
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toEqual([]);
    h.listed.push(sessionOf('s1'));
    await h.driver.scan();
    h.series.closeSecond(A, F + 1_000, 1.1002);
    await flush();
    expect(h.creates.map((input) => input.decision!.decidedAtMs)).toEqual([F + 1_000]);
    h.listed.splice(0);
    await h.driver.scan();
    h.series.closeSecond(A, F + 8_000, 1.1009);
    await flush();
    expect(h.creates).toHaveLength(1);
  });

  it('H1-DR19: two sessions on one pair decide independently', async () => {
    const h = await harness({ sessions: [sessionOf('s1'), sessionOf('s2')] });
    let resolve!: (result: CreateTradeIntentResult) => void;
    h.answers.push(() => new Promise((done) => (resolve = done)));
    await h.feedSettled(A, T, ramp(2));
    await flush();
    // s1's creation is in flight; s2 created at F and is held at F + 1 s
    expect(h.creates.map((input) => [input.sessionId, input.decision!.decidedAtMs])).toEqual([
      ['s1', F],
      ['s2', F],
    ]);
    resolve(created());
    await flush();
    expect(h.line()).toMatchObject({ skippedLive: 1, held: 1, intents: 2 });
  });

  it('H1-DR20: the line counts decisions, no-signals by reason and the lag', async () => {
    const h = await harness();
    h.feed(A, T, [...flat(301)]);
    await flush();
    expect(h.line()).toMatchObject({
      sessions: 1,
      decisions: 1,
      signals: 0,
      noSignal: { no_volatility: 1 },
      warming: 300,
      lagMsP50: 320,
      lagMsP95: 320,
    });
  });
});
