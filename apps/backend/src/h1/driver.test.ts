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
  sessionStakeParams,
  type BinaryPair,
  type H1SessionSettings,
  type ShownSignalStart,
  type PairsCatalogView,
  SessionStakeStrategy,
} from '@binarius/shared';
import {
  TradeIntentError,
  TradingSessionNotActiveError,
  type ActiveH1Session,
  type CreateSessionIntentInput,
  type CreateTradeIntentResult,
  type SessionHistory,
  type SessionBalanceRead,
  type SessionHistoryIntent,
  type SignalDecisionInput,
  type TradeIntentRow,
} from '@binarius/db';
import { createH1Detector, replayH1Entry } from '@binarius/signal';
import { createStakeSizer, sessionTradeOf } from '@binarius/stake';
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
const MAX_AGE_MS = 1_600;

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
    cycles: 5,
    stake: { baseStake: decimalStringSchema.parse('1.5'), stakeScale: 2 },
    strategy: SessionStakeStrategy.Martingale,
  });
  if (!built.success || built.data.version !== 5) throw new Error('H1 fixture settings');
  return { ...built.data, ...patch } as H1SessionSettings;
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

function scriptedSeries(digits: { value: number | undefined }) {
  const prices = new Map<number, Map<number, number>>();
  const closedUntil = new Map<number, number>();
  const closedAt = new Map<number, number>();
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
    digitsOf: () => digits.value,
    lastClosed(assetId) {
      const second = closedUntil.get(assetId);
      return second === undefined
        ? undefined
        : { assetId, second, closedBy: 'tick', closedAtMs: closedAt.get(assetId)! };
    },
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
      closedAt.set(assetId, closedAtMs);
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
  // the session's balance in the one read (#775, #874): undefined is no snapshot; onRead runs at
  // each read
  balance: { read: SessionBalanceRead | undefined; onRead?: () => void };
  creates: CreateSessionIntentInput[];
  records: SignalDecisionInput[];
  stops: { id: string; reason: string }[];
  wakes: { n: number };
  catalog: { view: PairsCatalogView | undefined };
  streaming: { on: boolean };
  // the next createIntent answers: a result, a throw, or a pending promise the test resolves
  answers: (() => Promise<CreateTradeIntentResult>)[];
  // the next record() calls that throw (a refused INSERT)
  recordFailures: { n: number };
  // the pair's digits as the series knows them; undefined before its first tick
  digits: { value: number | undefined };
  // the next sessions.stop answers: undefined (another writer stopped it first) or a throw
  stopAnswers: (() => Promise<unknown>)[];
  historyReads: { n: number };
  // the next sessions.list answers, before the listed sessions
  listAnswers: (() => Promise<ActiveH1Session[]>)[];
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
  const digits: { value: number | undefined } = { value: 5 };
  const series = scriptedSeries(digits);
  const lines: string[] = [];
  const logger = pino(logOptions('debug'), { write: (line: string) => lines.push(line) });
  const listed = options.sessions ?? [sessionOf('s1')];
  const histories = new Map<string, SessionHistory | undefined>();
  const creates: CreateSessionIntentInput[] = [];
  const records: SignalDecisionInput[] = [];
  const stops: { id: string; reason: string }[] = [];
  const wakes = { n: 0 };
  const answers: (() => Promise<CreateTradeIntentResult>)[] = [];
  const recordFailures = { n: 0 };
  const stopAnswers: (() => Promise<unknown>)[] = [];
  const historyReads = { n: 0 };
  const listAnswers: (() => Promise<ActiveH1Session[]>)[] = [];
  const balance: { read: SessionBalanceRead | undefined; onRead?: () => void } = {
    read: {
      available: decimalStringSchema.parse('1000'),
      minTradeAmount: decimalStringSchema.parse('1'),
      awaitsBalance: false,
    },
  };
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
    balance,
    creates,
    records,
    stops,
    wakes,
    catalog,
    streaming,
    answers,
    recordFailures,
    digits,
    stopAnswers,
    historyReads,
    listAnswers,
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
      list: () => listAnswers.shift()?.() ?? Promise.resolve([...h.listed]),
      read: (id) => {
        historyReads.n += 1;
        balance.onRead?.();
        const history = histories.has(id) ? histories.get(id) : emptyHistory();
        return Promise.resolve(
          history === undefined ? undefined : { history, balance: balance.read },
        );
      },
      createIntent: (input) => {
        creates.push(input);
        const answer = answers.shift();
        return answer === undefined
          ? Promise.resolve(created(`intent-${creates.length}`))
          : answer();
      },
      stop: (id, reason) => {
        stops.push({ id, reason });
        return stopAnswers.shift()?.() ?? Promise.resolve({ id });
      },
      record: (input) => {
        records.push(input);
        if (recordFailures.n > 0) {
          recordFailures.n -= 1;
          return Promise.reject(Object.assign(new Error('refused'), { code: '23514' }));
        }
        return Promise.resolve();
      },
    },
    wake: () => void (wakes.n += 1),
    logger,
    now: () => clock.now,
    config: {
      scanMs: 5_000,
      tickMs: 100,
      logMs: 60_000,
      submitBudgetMs: BUDGET_MS,
      startMaxAgeMs: MAX_AGE_MS,
    },
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
  it('H1-DR1: a signal becomes an intent held to closedAt + 1 s, the deadline the hold + budget, its row, then a wake', async () => {
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
      amount: '1.50',
      action: 'up',
      durationSec: 5,
      // #836: the closed second (F + 300) + entryDelaySec, then the budget from the hold's end
      submitNotBeforeAt: new Date(F + 1_300),
      submitDeadlineAt: new Date(F + 1_300 + BUDGET_MS),
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

  it("H1-DR15: the driver's tick alone advances the series by the clock (#830)", async () => {
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
      shown: 0,
      lagMsP50: 320,
      lagMsP95: 320,
    });
  });
});

// #775: the session is a regular one - the sizer's stake, the repeat step, the waiting row
const settledStep = (action: 'up' | 'down', amount: string, profit: string) => ({
  action,
  amount: decimalStringSchema.parse(amount),
  profit: decimalStringSchema.parse(profit),
});
// the stake the orchestrator's sizer gives over the same history and the harness's balance
const sizerStake = (history: SessionHistory, settings = h1Settings(), payout = 96) => {
  const decision = createStakeSizer(sessionStakeParams(settings)).next({
    history: history.intents.map(sessionTradeOf),
    payout,
    minTradeAmount: decimalStringSchema.parse('1'),
    available: decimalStringSchema.parse('1000'),
    sessionStartedAtMs: T,
    nowMs: T,
  });
  if (decision.kind !== 'stake') throw new Error('fixture: the sizer stops');
  return decision.amount;
};
const lostStep1 = emptyHistory([settledStep('down', '1.50', '-1.50')]);
const fixedSettings = () => {
  const built = buildH1SessionSettings({
    assetId: A,
    cycles: 5,
    stake: { baseStake: decimalStringSchema.parse('1.5'), stakeScale: 2 },
    strategy: SessionStakeStrategy.Fixed,
  });
  if (!built.success) throw new Error('fixture: fixed H1 settings');
  return built.data;
};

describe('the H1 driver sizes and repeats as a regular session (#775)', () => {
  it("H1-DR21: the signal's intent carries the sizer's stake: after two losses the raise, the signal's direction", async () => {
    const h = await harness();
    const history = emptyHistory([
      settledStep('down', '1.50', '-1.50'),
      settledStep('down', '3.07', '-3.07'),
    ]);
    h.histories.set('s1', history);
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    const expected = sizerStake(history);
    expect(expected).not.toBe('1.50');
    expect(h.creates[0]).toMatchObject({ step: 3, action: 'up', amount: expected });
    expect(h.creates[0]!.decision).toMatchObject({ version: 'h1', action: 'up' });
  });

  it("H1-DR22: a sizer stop creates nothing and stops nothing: the orchestrator's stop", async () => {
    const h = await harness();
    h.histories.set(
      's1',
      emptyHistory([
        settledStep('down', '1.50', '-1.50'),
        settledStep('down', '3.07', '-3.07'),
        settledStep('down', '6.34', '-6.34'),
        settledStep('down', '13.00', '-13.00'),
      ]),
    );
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.stops).toEqual([]);
    expect(h.line()).toMatchObject({ skippedLimits: { max_steps_exceeded: 1 }, intents: 0 });
  });

  it('H1-DR23: no balance snapshot skips with balance_unavailable', async () => {
    const h = await harness();
    h.balance.read = undefined;
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.line()).toMatchObject({ skippedLimits: { balance_unavailable: 1 } });
  });

  it('H1-DR24: a settlement the balance has not caught up with holds; otherwise the stop skips', async () => {
    const held = await harness();
    held.balance.read = {
      available: decimalStringSchema.parse('0.50'),
      minTradeAmount: decimalStringSchema.parse('1'),
      awaitsBalance: true,
    };
    held.feed(A, T, ramp(1));
    await flush();
    expect(held.creates).toEqual([]);
    expect(held.line()).toMatchObject({ heldBalance: 1, skippedLimits: {} });
    const skipped = await harness();
    skipped.balance.read = { ...held.balance.read, awaitsBalance: false };
    skipped.feed(A, T, ramp(1));
    await flush();
    expect(skipped.creates).toEqual([]);
    expect(skipped.line()).toMatchObject({
      heldBalance: 0,
      skippedLimits: { insufficient_balance: 1 },
    });
  });

  it('H1-DR24b: a repeat held for the balance is retried on the next closed second', async () => {
    const h = await harness();
    h.feed(A, T, flat(300));
    h.histories.set('s1', lostStep1);
    const enough = h.balance.read;
    h.balance.read = {
      available: decimalStringSchema.parse('0.50'),
      minTradeAmount: decimalStringSchema.parse('1'),
      awaitsBalance: true,
    };
    h.driver.notice('s1');
    await flush();
    expect(h.creates).toEqual([]);
    h.balance.read = enough;
    h.series.closeSecond(A, F, 1.1);
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.decision).toMatchObject({
      version: 'h1-repeat',
      source: { kind: 'settlement', trigger: 'tick' },
    });
    expect(h.line()).toMatchObject({ heldBalance: 1, repeatPending: 1, repeats: 1 });
  });

  it('H1-DR25: a notice after a lost Шаг 1 creates Шаг 2 at once: its direction, the raise, no window', async () => {
    const h = await harness();
    h.feed(A, T, flat(300));
    h.histories.set('s1', lostStep1);
    const noticedAt = clock.now;
    h.driver.notice('s1');
    await flush();
    expect(h.creates).toHaveLength(1);
    const input = h.creates[0]!;
    expect(input).toMatchObject({
      step: 2,
      action: 'down',
      amount: sizerStake(lostStep1),
      durationSec: 5,
    });
    expect('submitDeadlineAt' in input).toBe(false);
    expect('submitNotBeforeAt' in input).toBe(false);
    expect(input.decision).toEqual({
      context: 'session',
      tradingSessionId: 's1',
      brokerAccountId: 'acc-s1',
      step: 2,
      assetId: A,
      interval: null,
      version: 'h1-repeat',
      decidedAtMs: noticedAt,
      takenAtMs: noticedAt,
      kind: 'signal',
      action: 'down',
      payout: 96,
      digits: null,
      params: { rule: 'repeat_step_2', strategy: 'martingale' },
      decision: {
        kind: 'signal',
        version: 'h1-repeat',
        action: 'down',
        after: { intentId: 'h-0', action: 'down', profit: '-1.50' },
      },
      source: { kind: 'settlement', trigger: 'notice' },
      series: [],
      lastTick: null,
      outcome: 'intent',
      detail: null,
      ticksUntilMs: null,
    });
    expect(h.wakes.n).toBe(1);
    // one trade at a time: the seconds before the repeat's creation + 6 s are held
    h.histories.set('s1', emptyHistory([settledStep('down', '1.50', '-1.50'), {}]));
    await h.feedSettled(A, F, ramp(7).slice(300));
    await flush();
    expect(h.creates.map((one) => one.decision!.decidedAtMs)).toEqual([noticedAt, F + 6_000]);
    expect(h.line()).toMatchObject({ repeats: 1, intents: 2, held: 6 });
  });

  it('H1-DR25b: a tie at Шаг 1 repeats with the base stake in its direction', async () => {
    const h = await harness();
    h.histories.set('s1', emptyHistory([settledStep('up', '1.50', '0.00000000')]));
    h.driver.notice('s1');
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({ step: 2, action: 'up', amount: '1.50' });
    expect(h.creates[0]!.decision).toMatchObject({ version: 'h1-repeat' });
  });

  it('H1-DR25c: a notice after a win does nothing', async () => {
    const h = await harness();
    h.histories.set('s1', emptyHistory([settledStep('down', '1.50', '1.44')]));
    h.driver.notice('s1');
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.line()).toMatchObject({ noticeIdle: 1, repeats: 0 });
  });

  it('H1-DR25d: after a lost Шаг 2 nothing repeats; the next signal opens Шаг 3 in its direction', async () => {
    const h = await harness();
    const history = emptyHistory([
      settledStep('down', '1.50', '-1.50'),
      settledStep('down', '3.07', '-3.07'),
    ]);
    h.histories.set('s1', history);
    h.driver.notice('s1');
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.line()).toMatchObject({ noticeIdle: 1 });
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({ step: 3, action: 'up' });
    expect(h.creates[0]!.decision).toMatchObject({ version: 'h1' });
  });

  it('H1-DR26: a notice while a run is in flight runs once more after it', async () => {
    const h = await harness();
    let resolve!: (result: CreateTradeIntentResult) => void;
    h.answers.push(() => new Promise((done) => (resolve = done)));
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    // Шаг 1 settles lost while its creation's answer is still on the way
    h.histories.set('s1', emptyHistory([settledStep('up', '1.50', '-1.50')]));
    h.driver.notice('s1');
    resolve(created());
    await flush();
    await flush();
    expect(h.creates).toHaveLength(2);
    expect(h.creates[1]).toMatchObject({ step: 2, action: 'up' });
    expect(h.creates[1]!.decision).toMatchObject({
      version: 'h1-repeat',
      source: { trigger: 'notice' },
    });
  });

  it("H1-DR27: a signal while the repeat is due creates the repeat, not the signal's step", async () => {
    const h = await harness();
    h.histories.set('s1', lostStep1);
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({ step: 2, action: 'down', amount: sizerStake(lostStep1) });
    expect('submitDeadlineAt' in h.creates[0]!).toBe(false);
    expect('submitNotBeforeAt' in h.creates[0]!).toBe(false);
    expect(h.creates[0]!.decision).toMatchObject({
      version: 'h1-repeat',
      source: { kind: 'settlement', trigger: 'signal' },
    });
  });

  it('H1-DR28: under fixed nothing ever repeats: the signal opens the next trade', async () => {
    const h = await harness({ sessions: [sessionOf('s1', fixedSettings())] });
    h.histories.set('s1', lostStep1);
    h.driver.notice('s1');
    await flush();
    expect(h.creates).toEqual([]);
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({ step: 2, action: 'up', amount: '1.50' });
    expect(h.creates[0]!.submitDeadlineAt).toBeInstanceOf(Date);
    expect(h.creates[0]!.submitNotBeforeAt).toEqual(new Date(F + 1_300));
    expect(h.creates[0]!.decision).toMatchObject({ version: 'h1' });
  });

  it('H1-DR29: a waiting period writes one no_signal row; an intent or a notice opens the next one', async () => {
    const h = await harness();
    await h.feedSettled(A, T, flat(303));
    await flush();
    expect(h.records).toHaveLength(1);
    const row = h.records[0]!;
    expect(row).toMatchObject({
      context: 'session',
      tradingSessionId: 's1',
      step: 1,
      version: 'h1',
      kind: 'no_signal',
      action: null,
      outcome: 'no_signal',
      detail: null,
      decidedAtMs: F,
      params: { set: 'session' },
    });
    expect(row.series).toHaveLength(301);
    // the shadow's shape: the export's replay decides it again to itself
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
    // an intent opens the next period: a signal at F + 3 s, then the level holds; F + 4 s … F + 9 s
    // are held by the cadence, F + 10 s waits again
    await h.feedSettled(A, F + 3_000, [1.1001, ...flat(7, 1.1001)]);
    await flush();
    expect(h.creates.map((one) => one.decision!.decidedAtMs)).toEqual([F + 3_000]);
    expect(h.records.map((one) => one.decidedAtMs)).toEqual([F, F + 10_000]);
    // so does a notice
    h.driver.notice('s1');
    await flush();
    await h.feedSettled(A, F + 11_000, flat(2, 1.1001));
    await flush();
    expect(h.records.map((one) => one.decidedAtMs)).toEqual([F, F + 10_000, F + 11_000]);
    expect(h.line()).toMatchObject({ waitingRows: 3 });
  });

  it('H1-DR30: no waiting row while the cadence holds or an intent is live; a refused row is retried after scanMs', async () => {
    const held = await harness();
    // a signal at F, then the level holds: no move, no signal
    await held.feedSettled(A, T, [...ramp(1), ...flat(7, 1.1001)]);
    await flush();
    expect(held.creates).toHaveLength(1);
    expect(held.records.map((one) => one.decidedAtMs)).toEqual([F + 7_000]);

    const live = await harness();
    live.histories.set('s1', emptyHistory([{ status: TradeIntentStatus.Accepted, profit: null }]));
    await live.feedSettled(A, T, flat(303));
    await flush();
    expect(live.records).toEqual([]);

    const refused = await harness();
    refused.recordFailures.n = 1;
    await refused.feedSettled(A, T, flat(306));
    await flush();
    // F refused; F + 1 s … F + 4 s inside scanMs (5 s) try nothing; F + 5 s writes it
    expect(refused.records.map((one) => one.decidedAtMs)).toEqual([F, F + 5_000]);
    expect(refused.line()).toMatchObject({ failed: 1, waitingRows: 1 });
  });

  it("H1-DR31: a refused repeat writes the repeat's refused row and keeps the session", async () => {
    const h = await harness();
    h.histories.set('s1', lostStep1);
    h.answers.push(() =>
      Promise.reject(new TradeIntentError(TradeIntentErrorCode.ActiveIntentExists)),
    );
    h.driver.notice('s1');
    await flush();
    expect(h.stops).toEqual([]);
    expect(h.records).toEqual([
      expect.objectContaining({
        version: 'h1-repeat',
        step: 2,
        action: 'down',
        outcome: 'refused',
        detail: 'active_intent_exists',
        source: { kind: 'settlement', trigger: 'notice' },
      }),
    ]);
    expect(h.line()).toMatchObject({ refused: 1, sessions: 1 });
  });
});

// #775, review round 1: the no-signal limit is the driver's, counted on the seconds the detector
// decided no_signal on a full window. The cases add the session after the warm-up T … F − 1 (but
// H1-DR32), so only the seconds from F decide
const expiredHistory = (history = emptyHistory()): SessionHistory => ({
  ...history,
  waitExpired: true,
});
const decided = (records: SignalDecisionInput[]) => records.map((one) => one.decidedAtMs);
const STOPPED = [{ id: 's1', reason: 'no_signal_timeout' }];

async function warmed(history: SessionHistory = expiredHistory()) {
  const h = await harness({ sessions: [] });
  h.feed(A, T, flat(300));
  h.histories.set('s1', history);
  h.listed.push(sessionOf('s1'));
  await h.driver.scan();
  return h;
}

describe('the no-signal limit of an H1 session is the driver’s (#775, review round 1)', () => {
  it('H1-DR32: a cold series after a restart: the warm-up neither counts nor stops; the 100th decided second stops', async () => {
    const h = await harness();
    h.histories.set('s1', expiredHistory());
    await h.feedSettled(A, T, flat(300));
    expect(h.stops).toEqual([]);
    expect(h.records).toEqual([]);
    await h.feedSettled(A, F, flat(99));
    expect(h.stops).toEqual([]);
    expect(decided(h.records)).toEqual([F]);
    await h.feedSettled(A, F + 99_000, flat(1));
    expect(h.stops).toEqual(STOPPED);
    expect(decided(h.records)).toEqual([F, F + 99_000]);
    // the waiting row's own shape is H1-DR29's
    expect(h.records.map((one) => one.step)).toEqual([1, 1]);
    expect(h.records[1]).toMatchObject({ outcome: 'no_signal', kind: 'no_signal' });
    await h.feedSettled(A, F + 100_000, flat(11));
    expect(h.stops).toEqual(STOPPED);
    expect(h.records).toHaveLength(2);
    expect(h.line()).toMatchObject({ warming: 300, noSignalStops: 1, sessions: 0 });
  });

  it.each([
    ['(a) the source down', 0, (h: Harness, on: boolean): void => void (h.streaming.on = !on)],
    [
      '(b) the catalog stale',
      0,
      (h: Harness, on: boolean): void =>
        void (h.catalog.view = { pairs: [pairOf(A)], fetchedAt: T, ageMs: 0, fresh: !on }),
    ],
    [
      '(c) the pair not listed',
      0,
      (h: Harness, on: boolean): void =>
        void (h.catalog.view = {
          pairs: on ? [pairOf(B)] : [pairOf(A)],
          fetchedAt: T,
          ageMs: 0,
          fresh: true,
        }),
    ],
    [
      '(d) the digits unknown',
      0,
      (h: Harness, on: boolean): void => void (h.digits.value = on ? undefined : 5),
    ],
    // the first three priced seconds still miss the close at f − 3 s: no_price too
    ['(e) a hole in the prices (no_price)', 3, null],
  ] as const)('H1-DR33: %s does not count', async (_name, extra, condition) => {
    const h = await warmed();
    condition?.(h, true);
    await h.feedSettled(A, F, condition === null ? flat(150, NaN) : flat(150));
    expect(h.stops).toEqual([]);
    expect(h.records).toEqual([]);
    condition?.(h, false);
    const first = F + (150 + extra) * 1_000;
    await h.feedSettled(A, F + 150_000, flat(extra + 99));
    expect(h.stops).toEqual([]);
    expect(decided(h.records)).toEqual([first]);
    await h.feedSettled(A, first + 99_000, flat(1));
    expect(h.stops).toEqual(STOPPED);
    expect(decided(h.records)).toEqual([first, first + 99_000]);
  });

  it('H1-DR34: a notice and an intent reset the count', async () => {
    const noticed = await warmed();
    await noticed.feedSettled(A, F, flat(60));
    noticed.driver.notice('s1');
    await flush();
    await noticed.feedSettled(A, F + 60_000, flat(99));
    expect(noticed.stops).toEqual([]);
    await noticed.feedSettled(A, F + 159_000, flat(1));
    expect(noticed.stops).toEqual(STOPPED);
    expect(decided(noticed.records)).toEqual([F, F + 60_000, F + 159_000]);

    const traded = await warmed();
    await traded.feedSettled(A, F, flat(60));
    // a signal at F + 60 s, then the level holds: F + 61 s … F + 66 s are held by the cadence
    await traded.feedSettled(A, F + 60_000, flat(7 + 99, 1.1001));
    expect(decided(traded.creates.map((one) => one.decision!))).toEqual([F + 60_000]);
    expect(traded.stops).toEqual([]);
    await traded.feedSettled(A, F + 166_000, flat(1, 1.1001));
    expect(traded.stops).toEqual(STOPPED);
  });

  it("H1-DR35: the database's wait is a conjunct: no stop while it has not expired", async () => {
    const h = await warmed(emptyHistory());
    await h.feedSettled(A, F, flat(130));
    expect(h.stops).toEqual([]);
    expect(decided(h.records)).toEqual([F]);
    // F, then every counted second from the 100th (F + 99 s … F + 129 s) reads the history
    expect(h.historyReads.n).toBe(1 + 31);
    h.histories.set('s1', expiredHistory());
    await h.feedSettled(A, F + 130_000, flat(1));
    expect(h.stops).toEqual(STOPPED);
    expect(decided(h.records)).toEqual([F, F + 130_000]);
  });

  it('H1-DR35b: no stop before the waiting row: refused rows are retried every scanMs', async () => {
    const h = await warmed();
    h.recordFailures.n = 1_000;
    await h.feedSettled(A, F, flat(150));
    expect(h.stops).toEqual([]);
    const tries = Array.from({ length: 30 }, (_, i) => F + i * 5_000);
    expect(decided(h.records)).toEqual(tries);
    expect(h.line()).toMatchObject({ failed: 30, waitingRows: 0, noSignalStops: 0 });
  });

  it("H1-DR36: the stop's endings: already stopped forgets with the row; a throw keeps the session and tries again", async () => {
    const raced = await warmed();
    raced.stopAnswers.push(() => Promise.resolve(undefined));
    await raced.feedSettled(A, F, flat(100));
    expect(raced.stops).toEqual(STOPPED);
    expect(decided(raced.records)).toEqual([F, F + 99_000]);
    expect(raced.logs('h1 driver session already stopped')).toEqual([
      expect.objectContaining({ sessionId: 's1', code: 'no_signal' }),
    ]);
    expect(raced.line()).toMatchObject({ sessions: 0 });

    const failing = await warmed();
    failing.stopAnswers.push(() => Promise.reject(new Error('connection reset')));
    await failing.feedSettled(A, F, flat(100));
    expect(failing.stops).toEqual(STOPPED);
    expect(decided(failing.records)).toEqual([F]);
    expect(failing.line()).toMatchObject({ errors: 1, sessions: 1, noSignalStops: 0 });
    await failing.feedSettled(A, F + 100_000, flat(1));
    expect(failing.stops).toEqual([...STOPPED, ...STOPPED]);
    expect(decided(failing.records)).toEqual([F, F + 100_000]);
    expect(failing.line()).toMatchObject({ sessions: 0, noSignalStops: 1 });
  });

  it('H1-DR37: a due repeat writes no waiting row: the next second creates Шаг 2 (m1)', async () => {
    const h = await warmed(lostStep1);
    await h.feedSettled(A, F, flat(1));
    expect(h.creates).toEqual([]);
    await h.feedSettled(A, F + 1_000, flat(1));
    expect(h.creates).toHaveLength(1);
    // the repeat by its source; its version and missing deadline are H1-DR25's and H1-DR27's
    expect(h.creates[0]).toMatchObject({ step: 2, action: 'down' });
    expect(h.creates[0]!.decision).toMatchObject({
      source: { kind: 'settlement', trigger: 'tick' },
    });
    expect(h.records).toEqual([]);
  });

  it('H1-DR37b: a due repeat beats the stop', async () => {
    const h = await warmed();
    await h.feedSettled(A, F, flat(99));
    h.histories.set('s1', expiredHistory(lostStep1));
    await h.feedSettled(A, F + 99_000, flat(1));
    expect(h.stops).toEqual([]);
    expect(h.creates).toEqual([]);
    await h.feedSettled(A, F + 100_000, flat(1));
    expect(h.stops).toEqual([]);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.decision).toMatchObject({
      source: { kind: 'settlement', trigger: 'tick' },
    });
  });

  it('H1-DR38: a pending repeat is retried while the digits are unknown (m2)', async () => {
    const h = await warmed(lostStep1);
    h.digits.value = undefined;
    const fresh = h.catalog.view;
    // the repeat is held by the pair (a stale catalog), then retried on the next closed second
    h.catalog.view = { pairs: [pairOf(A)], fetchedAt: T, ageMs: 90_000, fresh: false };
    h.driver.notice('s1');
    await flush();
    expect(h.creates).toEqual([]);
    h.catalog.view = fresh;
    await h.feedSettled(A, F, flat(1));
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({ step: 2, action: 'down' });
    expect(h.creates[0]!.decision).toMatchObject({
      source: { kind: 'settlement', trigger: 'tick' },
    });
    expect(h.line()).toMatchObject({ decisions: 0, repeatPending: 1 });
  });
});

describe("the H1 start's reading and hand-over (#796)", () => {
  const readingAt = (h: Harness, settings = h1Settings()) => {
    const reading = h.driver.current(A, settings);
    if (reading.kind !== 'decision') throw new Error(`no reading: ${reading.reason}`);
    return reading.facts;
  };
  const startOf = (h: Harness) => ({ facts: readingAt(h), pair: { payout: 96, symbol: `P${A}` } });

  it('H1-DR39: current() decides on the newest closed second while it is current; otherwise it says why not', async () => {
    const h = await harness({ sessions: [] });
    expect(h.driver.current(A, h1Settings())).toEqual({ kind: 'unavailable', reason: 'no_series' });
    h.feed(A, T, flat(300));
    expect(h.driver.current(A, h1Settings())).toEqual({ kind: 'unavailable', reason: 'warming' });
    h.series.closeSecond(A, F, 1.1001);
    const closes = [...flat(300), 1.1001];
    expect(h.driver.current(A, h1Settings())).toEqual({
      kind: 'decision',
      facts: {
        assetId: A,
        f: F,
        takenAtMs: F + 320,
        decision: createH1Detector(H1_R1_PARAMS).decide({ closes, at: 300 }),
        digits: 5,
        closedBy: 'tick',
        closedAtMs: F + 300,
        series: closes,
        lastTick: { price: 1.1001, timestamp: F - 100, receivedAtMs: F - 60 },
      },
    });
    expect(readingAt(h).decision).toMatchObject({ kind: 'signal', action: 'up' });
    expect(h.driver.current(B, h1Settings())).toEqual({ kind: 'unavailable', reason: 'no_series' });
    clock.now = F + MAX_AGE_MS;
    expect(h.driver.current(A, h1Settings()).kind).toBe('decision');
    clock.now = F + MAX_AGE_MS + 1;
    expect(h.driver.current(A, h1Settings())).toEqual({ kind: 'unavailable', reason: 'stale' });
    clock.now = F + 320;
    h.digits.value = undefined;
    expect(h.driver.current(A, h1Settings())).toEqual({ kind: 'unavailable', reason: 'no_digits' });
    h.digits.value = 5;
    h.streaming.on = false;
    expect(h.driver.current(A, h1Settings())).toEqual({
      kind: 'unavailable',
      reason: 'source_down',
    });
    // a reading touches no session and no counter
    expect(h.line()).toMatchObject({ sessions: 0, decisions: 0, signals: 0 });
  });

  it('H1-DR40: adopt with a signal creates Шаг 1 at once on the reading: its hold and deadline, its row, a wake', async () => {
    const h = await harness({ sessions: [] });
    h.feed(A, T, ramp(1));
    const start = startOf(h);
    h.driver.adopt(sessionOf('s1'), start);
    // the clock moves between the reading and the intent's write: the hold is the reading's
    // second's (#836), and the deadline runs from it while it is still ahead
    clock.now += 300;
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      sessionId: 's1',
      step: 1,
      action: 'up',
      amount: '1.50',
      submitNotBeforeAt: new Date(F + 1_300),
      submitDeadlineAt: new Date(F + 1_300 + BUDGET_MS),
    });
    expect(h.creates[0]!.decision).toEqual({
      context: 'session',
      tradingSessionId: 's1',
      brokerAccountId: 'acc-s1',
      step: 1,
      assetId: A,
      interval: null,
      version: 'h1',
      decidedAtMs: F,
      takenAtMs: start.facts.takenAtMs,
      kind: 'signal',
      action: 'up',
      payout: 96,
      digits: 5,
      params: { set: 'session', ...H1_R1_PARAMS, entryDelaySec: 1, expirySec: 5 },
      decision: start.facts.decision,
      source: { kind: 'ticks', symbol: `P${A}`, closedBy: 'tick', closedAtMs: F + 300 },
      series: start.facts.series,
      lastTick: start.facts.lastTick,
      outcome: 'intent',
      detail: null,
      ticksUntilMs: null,
    });
    expect(h.wakes.n).toBe(1);
    expect(h.line()).toMatchObject({ sessions: 1, decisions: 1, signals: 1, intents: 1 });
  });

  it('H1-DR40b: a scan whose list predates the hand-over keeps the adopted session', async () => {
    const h = await harness({ sessions: [] });
    h.feed(A, T, ramp(1));
    let resolve!: (list: ActiveH1Session[]) => void;
    h.listAnswers.push(() => new Promise((done) => (resolve = done)));
    const scanning = h.driver.scan();
    h.driver.adopt(sessionOf('s1'), startOf(h));
    resolve([]);
    await scanning;
    await flush();
    expect(h.creates).toHaveLength(1);
    h.series.closeSecond(A, F + 1_000, 1.1002);
    await flush();
    expect(h.line()).toMatchObject({ sessions: 1, held: 1 });
    // a later scan that does not list it drops it, as any session
    await h.driver.scan();
    expect(h.line()).toMatchObject({ sessions: 0 });
  });

  it('H1-DR41: adopt with a no-signal reading writes the waiting row at once and counts the second', async () => {
    const h = await harness({ sessions: [] });
    h.histories.set('s1', expiredHistory());
    h.feed(A, T, flat(301));
    const start = startOf(h);
    expect(start.facts.decision).toMatchObject({ kind: 'no_signal', reason: 'no_volatility' });
    h.driver.adopt(sessionOf('s1'), start);
    await flush();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      context: 'session',
      step: 1,
      outcome: 'no_signal',
      decidedAtMs: F,
    });
    await h.feedSettled(A, F + 1_000, flat(98));
    expect(h.stops).toEqual([]);
    await h.feedSettled(A, F + 99_000, flat(1));
    expect(h.stops).toEqual(STOPPED);
  });

  it('H1-DR42: adopt without a reading tracks the session at once: the next closed second decides', async () => {
    const h = await harness({ sessions: [] });
    h.feed(A, T, flat(300));
    h.driver.adopt(sessionOf('s1'));
    await flush();
    expect(h.creates).toEqual([]);
    h.series.closeSecond(A, F, 1.1001);
    await flush();
    expect(h.creates.map((input) => input.decision!.decidedAtMs)).toEqual([F]);
    expect(h.line()).toMatchObject({ sessions: 1, decisions: 1 });
  });

  it('H1-DR43: adopt of a session a scan already tracks reuses its state: the cadence and a run in flight hold', async () => {
    const decided = await harness();
    decided.feed(A, T, ramp(1));
    await flush();
    expect(decided.creates).toHaveLength(1);
    decided.driver.adopt(sessionOf('s1'), startOf(decided));
    await flush();
    expect(decided.creates).toHaveLength(1);
    expect(decided.line()).toMatchObject({ sessions: 1, held: 1, decisions: 1 });

    const busy = await harness();
    let resolve!: (result: CreateTradeIntentResult) => void;
    busy.answers.push(() => new Promise((done) => (resolve = done)));
    busy.feed(A, T, ramp(1));
    await flush();
    busy.driver.adopt(sessionOf('s1'), startOf(busy));
    await flush();
    expect(busy.creates).toHaveLength(1);
    expect(busy.line()).toMatchObject({ skippedLive: 1, decisions: 1 });
    resolve(created());
    await flush();
  });

  it('H1-DR44: invalid settings are warned and not traded; a stopped driver adopts nothing', async () => {
    const h = await harness({ sessions: [] });
    h.feed(A, T, ramp(1));
    const start = startOf(h);
    h.driver.adopt(sessionOf('bad', { version: 5 }), start);
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.logs('h1 driver session skipped')).toEqual([
      expect.objectContaining({ sessionId: 'bad', reason: 'invalidSettings' }),
    ]);
    await h.driver.stop();
    h.driver.adopt(sessionOf('s1'), start);
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.logs('h1 driver session skipped')).toHaveLength(1);
  });
});

describe('the shown start of an H1 session (#829)', () => {
  const shownOf = (patch: Partial<ShownSignalStart> = {}): ShownSignalStart => ({
    action: 'down',
    second: T + 290_000,
    decidedAt: T + 290_400,
    shownAtMs: T + 291_000,
    source: 'list',
    ...patch,
  });
  // the start's pair: 95 against the catalog's 96, so the row's payout is the plan's
  const shownStart = (shown = shownOf()) => ({ shown, pair: { payout: 95, symbol: `P${A}` } });

  it("H1-DR45: adopt with a shown direction creates Шаг 1 at once: its action, the sizer's stake, no window, the h1-start row; then takenAt + 6 s", async () => {
    const h = await harness({ sessions: [] });
    h.feed(A, T, flat(300));
    const takenAtMs = clock.now;
    h.driver.adopt(sessionOf('s1'), shownStart());
    await flush();
    expect(h.creates).toHaveLength(1);
    const input = h.creates[0]!;
    expect(input).toMatchObject({
      sessionId: 's1',
      step: 1,
      action: 'down',
      amount: sizerStake(emptyHistory(), h1Settings(), 95),
      durationSec: 5,
    });
    expect('submitDeadlineAt' in input).toBe(false);
    // #836: the shown decision's moment + entryDelaySec, long behind here
    expect(input.submitNotBeforeAt).toEqual(new Date(T + 291_400));
    expect(input.decision).toEqual({
      context: 'session',
      tradingSessionId: 's1',
      brokerAccountId: 'acc-s1',
      step: 1,
      assetId: A,
      interval: null,
      version: 'h1-start',
      decidedAtMs: T + 290_000,
      takenAtMs,
      kind: 'signal',
      action: 'down',
      payout: 95,
      digits: null,
      params: { rule: 'shown_signal', ...H1_R1_PARAMS },
      decision: {
        kind: 'signal',
        version: 'h1-start',
        action: 'down',
        shown: { second: T + 290_000, decidedAt: T + 290_400, source: 'list' },
      },
      source: { kind: 'shown', source: 'list', shownAtMs: T + 291_000 },
      series: [],
      lastTick: null,
      outcome: 'intent',
      detail: null,
      ticksUntilMs: null,
    });
    expect(h.wakes.n).toBe(1);
    expect(h.line()).toMatchObject({ shown: 1, intents: 1, signals: 0, decisions: 0 });
    // one trade at a time: the seconds before takenAt + 6 s are held (takenAt = F - 680 ms)
    h.histories.set('s1', emptyHistory([{}]));
    await h.feedSettled(A, F, ramp(7).slice(300));
    await flush();
    expect(h.creates.map((one) => one.decision!.decidedAtMs)).toEqual([T + 290_000, F + 6_000]);
    expect(h.line()).toMatchObject({ shown: 1, intents: 2, held: 6 });
  });

  it('H1-DR46: a shown start while a run is in flight is skipped; inside the cadence it is held', async () => {
    const h = await harness();
    let resolve!: (result: CreateTradeIntentResult) => void;
    h.answers.push(() => new Promise((done) => (resolve = done)));
    h.feed(A, T, ramp(1));
    await flush();
    h.driver.adopt(sessionOf('s1'), shownStart());
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.line()).toMatchObject({ skippedLive: 1, shown: 0 });
    resolve(created());
    await flush();
    h.driver.adopt(sessionOf('s1'), shownStart());
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.line()).toMatchObject({ held: 1, shown: 0, intents: 1 });
  });

  it('H1-DR47: a stop refusal of the shown Шаг 1 stops the session with its h1-start refused row; a reschedule refusal keeps it', async () => {
    const h = await harness({ sessions: [] });
    clock.now = T + 299_000;
    h.answers.push(() => Promise.reject(new TradeIntentError(TradeIntentErrorCode.AccountHalted)));
    h.driver.adopt(sessionOf('s1'), shownStart());
    await flush();
    expect(h.stops).toEqual([{ id: 's1', reason: 'manual_review' }]);
    expect(h.records).toEqual([
      expect.objectContaining({
        version: 'h1-start',
        context: 'session',
        step: 1,
        outcome: 'refused',
        detail: 'account_halted',
        decidedAtMs: T + 290_000,
        source: { kind: 'shown', source: 'list', shownAtMs: T + 291_000 },
      }),
    ]);
    expect(h.line()).toMatchObject({ refused: 1, stops: 1, shown: 0, sessions: 0 });

    const kept = await harness({ sessions: [] });
    kept.answers.push(() =>
      Promise.reject(new TradeIntentError(TradeIntentErrorCode.ActiveIntentExists)),
    );
    kept.driver.adopt(sessionOf('s2'), shownStart(shownOf({ source: 'analysis' })));
    await flush();
    expect(kept.stops).toEqual([]);
    expect(kept.records).toEqual([
      expect.objectContaining({
        version: 'h1-start',
        outcome: 'refused',
        detail: 'active_intent_exists',
        tradingSessionId: 's2',
      }),
    ]);
    expect(kept.line()).toMatchObject({ refused: 1, stops: 0, sessions: 1 });
  });

  it('H1-DR48: a gone session, invalid settings and a stopped driver: a shown start creates nothing', async () => {
    const h = await harness({ sessions: [] });
    clock.now = T + 299_000;
    h.histories.set('s1', undefined);
    h.driver.adopt(sessionOf('s1'), shownStart());
    await flush();
    h.histories.delete('s1');
    h.driver.adopt(sessionOf('s1'), shownStart());
    h.driver.adopt(sessionOf('bad', { version: 5 }), shownStart());
    await flush();
    expect(h.creates).toEqual([]);
    expect(h.line()).toMatchObject({ gone: 1, shown: 0, invalidSettings: 1 });
    await h.driver.stop();
    h.driver.adopt(sessionOf('s3'), shownStart());
    await flush();
    expect(h.creates).toEqual([]);
  });

  it('H1-DR49: a replayed shown step holds the cadence, counts replayed and wakes nothing', async () => {
    const h = await harness({ sessions: [] });
    clock.now = T + 299_000;
    h.answers.push(() => Promise.resolve({ ...created(), created: false }));
    h.driver.adopt(sessionOf('s1'), shownStart());
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.wakes.n).toBe(0);
    h.driver.adopt(sessionOf('s1'), shownStart());
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.line()).toMatchObject({ replayed: 1, shown: 0, intents: 0, held: 1 });
  });

  it("H1-DR50: a due repeat beats the shown plan: Шаг 2 in the lost trade's direction, version h1-repeat", async () => {
    const h = await harness({ sessions: [] });
    clock.now = T + 299_000;
    h.histories.set('s1', lostStep1);
    h.driver.adopt(sessionOf('s1'), shownStart(shownOf({ action: 'up' })));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({ step: 2, action: 'down', amount: sizerStake(lostStep1) });
    expect(h.creates[0]!.decision).toMatchObject({
      version: 'h1-repeat',
      source: { kind: 'settlement', trigger: 'signal' },
    });
    expect(h.line()).toMatchObject({ repeats: 1, shown: 0 });
  });
});

// #836, docs/h1.md -> The entry: no H1 intent is taken before its second + entryDelaySec
describe('the entry hold of an H1 intent (#836)', () => {
  const readingAt = (h: Harness) => {
    const reading = h.driver.current(A, h1Settings());
    if (reading.kind !== 'decision') throw new Error(`no reading: ${reading.reason}`);
    return reading.facts;
  };

  it("H1-DR51: a start on an old reading holds to the second's close + 1 s; the deadline runs from the reading's taken_at, not from the creation", async () => {
    const h = await harness({ sessions: [] });
    h.feed(A, T, ramp(1));
    // the second closed at F + 300; the reading is taken 1.5 s after F, past the hold, and the
    // creation comes 1.5 s after the reading
    clock.now = F + 1_500;
    h.balance.onRead = () => {
      clock.now += 1_500;
    };
    h.driver.adopt(sessionOf('s1'), { facts: readingAt(h), pair: { payout: 96, symbol: `P${A}` } });
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      submitNotBeforeAt: new Date(F + 1_300),
      submitDeadlineAt: new Date(F + 1_500 + BUDGET_MS),
    });
  });

  it('H1-DR55: the deadline runs from the decision, not from a slow creation', async () => {
    const h = await harness();
    // the second closes at F + 300, its decision is taken at F + 320; the creation comes after a
    // balance read that takes 1.5 s
    h.balance.onRead = () => {
      clock.now += 1_500;
    };
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      submitNotBeforeAt: new Date(F + 1_300),
      submitDeadlineAt: new Date(F + 1_300 + BUDGET_MS),
    });
  });

  it('H1-DR52: a shown direction decided a moment ago is held to its decision + 1 s, with no deadline', async () => {
    const h = await harness({ sessions: [] });
    h.feed(A, T, flat(300));
    const decidedAt = clock.now - 400;
    h.driver.adopt(sessionOf('s1'), {
      shown: {
        action: 'up',
        second: decidedAt - 600,
        decidedAt,
        shownAtMs: decidedAt + 100,
        source: 'list',
      },
      pair: { payout: 95, symbol: `P${A}` },
    });
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.submitNotBeforeAt).toEqual(new Date(decidedAt + 1_000));
    expect('submitDeadlineAt' in h.creates[0]!).toBe(false);
  });

  it('H1-DR53: the repeat step has neither a hold nor a deadline', async () => {
    const h = await harness();
    h.feed(A, T, flat(300));
    h.histories.set('s1', lostStep1);
    h.driver.notice('s1');
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.decision).toMatchObject({ version: 'h1-repeat' });
    expect('submitNotBeforeAt' in h.creates[0]!).toBe(false);
    expect('submitDeadlineAt' in h.creates[0]!).toBe(false);
  });

  it("H1-DR54: the hold is the session's entryDelaySec, not a constant", async () => {
    const base = h1Settings();
    const settings = { ...base, signal: { ...base.signal, entryDelaySec: 2 } };
    const h = await harness({ sessions: [sessionOf('s1', settings)] });
    h.feed(A, T, ramp(1));
    await flush();
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      submitNotBeforeAt: new Date(F + 2_300),
      submitDeadlineAt: new Date(F + 2_300 + BUDGET_MS),
    });
  });
});
