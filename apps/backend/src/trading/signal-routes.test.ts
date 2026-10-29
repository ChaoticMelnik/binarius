import { createBrokerRestClient } from '@binarius/broker-rest';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import {
  DEFAULT_SIGNAL_PARAMS,
  createCachedSignalFeed,
  createSignalFeed,
  replaySignalJournalEntry,
  type CandleWindow,
  type SignalEvaluation,
  type SignalJournalEntry,
} from '@binarius/signal';
import {
  SIGNAL_ALGORITHM_VERSION,
  SIGNAL_CHART_INTERVAL_MS,
  TRADING_SIGNAL_PATH,
  safeParseTradingSignalResponse,
  type BinaryPair,
  type PairsCatalogView,
} from '@binarius/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { unusedAdminDeps, unusedPaymentsDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import type { UsersRoutesDeps } from '../users/routes';
import type { TradingRoutesDeps } from './routes';
import { createScanPacer } from '../signal/pacer';
import type { SignalRoutesDeps } from './signal-routes';
import {
  fakeCatalog,
  fakeSignalFeed,
  PAIRS_TEST_TOKEN,
  recordingLastAnalysis,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSessionDeps,
  unusedSignalsDeps,
} from './testing';
import { unusedDepositDeps } from '../deposit/testing';

const I = SIGNAL_CHART_INTERVAL_MS['1m'];
const B = Math.floor(1_760_000_000_000 / I) * I;
const T = B + 40_000;

const facts = {
  assetId: 101,
  interval: '1m' as const,
  intervalMs: I,
  nowMs: T,
  startTime: B - 59 * I,
  limit: 60,
};

// the mock broker's two pairs with their digits (packages/mock-broker/src/state.ts)
const catalogPair = (id: number, digits: number): BinaryPair => ({
  id,
  symbol: `PAIR${id}`,
  type: 'currency',
  digits,
  payout: 85,
  maxPayout: 90,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
});
const catalogOf = (fresh = true): PairsCatalogView => ({
  pairs: [catalogPair(101, 5), catalogPair(202, 2)],
  fetchedAt: T - 1_000,
  ageMs: 1_000,
  fresh,
});

const decidedEvaluation: SignalEvaluation = {
  outcome: 'decided',
  entry: {
    ...facts,
    digits: 5,
    source: { kind: 'rest', startTime: facts.startTime, limit: 60, rows: 60, durationMs: 12 },
    version: SIGNAL_ALGORITHM_VERSION,
    params: DEFAULT_SIGNAL_PARAMS,
    series: [[B, 1.1, 1.2, 1.0, 1.15]],
    decision: {
      kind: 'no_signal',
      version: SIGNAL_ALGORITHM_VERSION,
      reason: 'insufficient_candles',
      detail: { closedCandles: 1, required: 50 },
    },
  },
};

let app: FastifyInstance | undefined;
let lines: string[] = [];
const parsedLines = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

function appWith(
  feed: SignalRoutesDeps['feed'],
  // null: the cache holds no snapshot
  catalog: PairsCatalogView | null = catalogOf(),
  lastAnalysis: SignalRoutesDeps['lastAnalysis'] = recordingLastAnalysis().lastAnalysis,
  h1: SignalRoutesDeps['h1'] = undefined,
): FastifyInstance {
  lines = [];
  app = buildApp({
    deposit: unusedDepositDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'info',
    checkTimeoutMs: 20,
    trading: {
      db: {} as TradingRoutesDeps['db'],
      internalApiToken: PAIRS_TEST_TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
      demoOnly: false,
    },
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: {
      feed,
      catalog: fakeCatalog(catalog ?? undefined),
      internalApiToken: PAIRS_TEST_TOKEN,
      lastAnalysis,
      h1,
      now: () => T,
    },
    signals: unusedSignalsDeps(),
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
    payments: unusedPaymentsDeps(),
    logDestination: { write: (line: string) => void lines.push(line) },
  });
  return app;
}

// null sends no authorization header at all
const post = (target: FastifyInstance, body: unknown, token: string | null = PAIRS_TEST_TOKEN) =>
  target.inject({
    method: 'POST',
    url: TRADING_SIGNAL_PATH,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });

let broker: MockBroker | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await broker?.close();
  broker = undefined;
});

describe('POST /trading/signal', () => {
  it.each([null, 'wrong-token'])('R1 refuses bearer %s with 401 before the feed', async (token) => {
    const { feed, calls } = fakeSignalFeed(decidedEvaluation);
    const response = await post(appWith(feed), { assetId: 101, interval: '1m' }, token);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  // #313: the demo's 5 and 15 s trades ask their own sub-minute candle
  it.each(['5s', '15s'])('R3b passes a %s request to the feed', async (interval) => {
    const { feed, calls } = fakeSignalFeed(decidedEvaluation);
    const response = await post(appWith(feed), { assetId: 202, interval });
    expect(response.statusCode).toBe(200);
    expect(calls).toStrictEqual([{ assetId: 202, interval, digits: 2 }]);
  });

  it.each([
    { assetId: 101 },
    { assetId: 101, interval: '2m' },
    { assetId: 0, interval: '1m' },
    { assetId: '101', interval: '1m' },
    { assetId: 2 ** 31, interval: '1m' },
  ])('R2 refuses %j with 400 validation before the feed', async (body) => {
    const { feed, calls } = fakeSignalFeed(decidedEvaluation);
    const response = await post(appWith(feed), body);
    expect(response.statusCode).toBe(400);
    const json = response.json<{ error: string; issues: unknown[] }>();
    expect(json.error).toBe('validation');
    expect(json.issues.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it('R3 answers a decision with its params, and nothing else from the entry', async () => {
    const { feed, calls } = fakeSignalFeed(decidedEvaluation);
    const response = await post(appWith(feed), { assetId: 101, interval: '1m', extra: true });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toStrictEqual({
      outcome: 'decided',
      params: DEFAULT_SIGNAL_PARAMS,
      decision: decidedEvaluation.outcome === 'decided' && decidedEvaluation.entry.decision,
      h1: null,
    });
    expect(safeParseTradingSignalResponse(body).success).toBe(true);
    expect(calls).toStrictEqual([{ assetId: 101, interval: '1m', digits: 5 }]);
  });

  // #482: the card's indicators ride next to the decision; a response without them stays valid
  it('R3b answers the indicators of a decision as the feed gave them', async () => {
    const indicators = {
      macd: { ok: true, macd: 0.0012, signal: 0.0009, histogram: 0.0003, cross: 'up' },
      ma50: { ok: true, value: 1.1, lastClose: 1.15 },
      ma200: { ok: false, closedCandles: 117, required: 200 },
    } as const;
    const { feed } = fakeSignalFeed({ ...decidedEvaluation, indicators } as SignalEvaluation);
    const response = await post(appWith(feed), { assetId: 101, interval: '1m' });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({ outcome: 'decided', indicators });
    expect(safeParseTradingSignalResponse(body).success).toBe(true);
    expect(
      safeParseTradingSignalResponse({
        ...(body as object),
        indicators: { ...indicators, ma200: { ok: false, closedCandles: 117 } },
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      evaluation: { code: 'rate_limited', status: 429, retryAfterSec: 7 },
      body: { outcome: 'fetch_failed', code: 'rate_limited', retryAfterSec: 7, h1: null },
    },
    {
      evaluation: { code: 'unavailable', status: 503 },
      body: { outcome: 'fetch_failed', code: 'unavailable', h1: null },
    },
  ] as const)('R4 answers fetch_failed $evaluation.code with 200', async ({ evaluation, body }) => {
    const { feed } = fakeSignalFeed({ outcome: 'fetch_failed', request: facts, ...evaluation });
    const response = await post(appWith(feed), { assetId: 101, interval: '1m' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual(body);
    expect(safeParseTradingSignalResponse(response.json()).success).toBe(true);
  });

  it('R5 a throw of the feed is the opaque 500, logged by name', async () => {
    const { feed } = fakeSignalFeed(() =>
      Promise.reject(new RangeError('signal input: nowMs must be finite, got NaN')),
    );
    const response = await post(appWith(feed), { assetId: 101, interval: '1m' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toStrictEqual({ error: 'internal' });
    const errors = parsedLines().filter((line) => line.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: 'unhandled request error',
      err: { name: 'RangeError' },
    });
    expect(lines.join('\n')).not.toContain('nowMs must be finite');
  });

  it('R6 on the mock broker: two requests in one candle make one chart GET and one journal line', async () => {
    broker = await startMockBroker();
    const now = () => T;
    const logger = {
      info: (fields: object, message: string) => app?.log.info(fields, message),
      warn: (fields: object, message: string) => app?.log.warn(fields, message),
    };
    const feed = createCachedSignalFeed(
      createSignalFeed({ rest: createBrokerRestClient({ baseUrl: broker.url }), logger, now }),
      { fetchBudgetMs: 3_000, maxTtlMs: 30_000, now },
    );
    const target = appWith(feed);

    const first = await post(target, { assetId: 101, interval: '1m' });
    const second = await post(target, { assetId: 101, interval: '1m' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const body = first.json<{ outcome: string; decision: unknown; indicators?: unknown }>();
    expect(body.outcome).toBe('decided');
    expect(body.indicators).toMatchObject({
      macd: { ok: true },
      ma50: { ok: true },
      ma200: { ok: true },
    });
    expect(second.json()).toStrictEqual(body);
    expect(broker.rest.journal.filter((entry) => entry.endpoint === 'chart')).toHaveLength(1);

    const decisions = parsedLines().filter((line) => line.msg === 'signal decision');
    expect(decisions).toHaveLength(1);
    const { signal } = decisions[0] as { signal: SignalJournalEntry };
    expect(replaySignalJournalEntry(signal)).toStrictEqual(body.decision);

    broker.rest.failNext('chart', { status: 429, retryAfterSec: 7 });
    const limited = await post(target, { assetId: 101, interval: '5m' });
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toStrictEqual({
      outcome: 'fetch_failed',
      code: 'rate_limited',
      retryAfterSec: 7,
      h1: null,
    });
    expect(parsedLines().filter((line) => line.msg === 'signal fetch failed')).toHaveLength(1);
    expect(broker.rest.journal.filter((entry) => entry.endpoint === 'chart')).toHaveLength(2);
  });

  // #405: a decision from the source writes no line; the route's first answer of it does
  it('R16 a decision from the source is journalled once, when POST /trading/signal answers it', async () => {
    const I15 = SIGNAL_CHART_INTERVAL_MS['15s'];
    const boundary = Math.floor(T / I15) * I15;
    const startTime = boundary - 299 * I15;
    const window: CandleWindow = {
      candles: Array.from({ length: 299 }, (_, k) => {
        const open = 1.1 + (k % 7) * 0.0001;
        const close = open + 0.0002;
        return {
          timestamp: startTime + k * I15,
          open,
          high: close + 0.0001,
          low: open - 0.0001,
          close,
        };
      }),
      closedUntil: boundary,
      startTime,
      gaps: [],
    };
    const now = () => T;
    const logger = {
      info: (fields: object, message: string) => app?.log.info(fields, message),
      warn: (fields: object, message: string) => app?.log.warn(fields, message),
    };
    const feed = createCachedSignalFeed(
      createSignalFeed({
        rest: {
          getChart: () => {
            throw new Error('no GET while the source has a window');
          },
        },
        source: { read: () => window, request: () => {} },
        logger,
        now,
      }),
      { fetchBudgetMs: 3_000, maxTtlMs: 30_000, now },
    );
    const target = appWith(feed);
    const scanned = feed.fromSource({ assetId: 101, interval: '15s', digits: 5 });
    expect(scanned?.outcome).toBe('decided');
    expect(parsedLines().filter((line) => line.msg === 'signal decision')).toHaveLength(0);

    const first = await post(target, { assetId: 101, interval: '15s' });
    const second = await post(target, { assetId: 101, interval: '15s' });
    expect(first.statusCode).toBe(200);
    const body = first.json<{ outcome: string; decision: unknown }>();
    expect(body.outcome).toBe('decided');
    expect(second.json()).toStrictEqual(body);
    const decisions = parsedLines().filter((line) => line.msg === 'signal decision');
    expect(decisions).toHaveLength(1);
    const { signal } = decisions[0] as { signal: SignalJournalEntry };
    expect(signal.source).toStrictEqual({
      kind: 'socket',
      startTime,
      closedUntil: boundary,
      gaps: 0,
    });
    expect(replaySignalJournalEntry(signal)).toStrictEqual(body.decision);
  });

  it('R18 without a source an empty pacer answers rate_limited in 1 s and sends no GET', async () => {
    broker = await startMockBroker();
    const now = () => T;
    const pacer = createScanPacer({
      perMinute: 25,
      capacity: 1,
      backoffMinMs: 15_000,
      backoffMaxMs: 120_000,
      now,
    });
    expect(pacer.tryTake()).toBe(true);
    const feed = createCachedSignalFeed(
      createSignalFeed({
        rest: createBrokerRestClient({ baseUrl: broker.url }),
        pacer,
        logger: {
          info: (fields: object, message: string) => app?.log.info(fields, message),
          warn: (fields: object, message: string) => app?.log.warn(fields, message),
        },
        now,
      }),
      { fetchBudgetMs: 3_000, maxTtlMs: 30_000, now },
    );
    const response = await post(appWith(feed), { assetId: 101, interval: '15s' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      outcome: 'fetch_failed',
      code: 'rate_limited',
      retryAfterSec: 1,
      h1: null,
    });
    expect(broker.rest.journal.filter((entry) => entry.endpoint === 'chart')).toHaveLength(0);
    expect(
      parsedLines().filter((line) => line.msg === 'signal fetch refused: no token'),
    ).toHaveLength(1);
    expect(parsedLines().filter((line) => line.msg === 'signal decision')).toHaveLength(0);
  });

  // #379: the pair's digits come from the pairs cache, looked up before any chart GET
  it.each([
    ['no snapshot', null],
    ['a stale snapshot', catalogOf(false)],
  ])('R7 %s is 503 catalog_unavailable and the feed is not called', async (_, catalog) => {
    const { feed, calls } = fakeSignalFeed(decidedEvaluation);
    const response = await post(appWith(feed, catalog), { assetId: 101, interval: '1m' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toStrictEqual({ error: 'catalog_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('R8 an id the catalog does not list is 409 pair_unknown and the feed is not called', async () => {
    const { feed, calls } = fakeSignalFeed(decidedEvaluation);
    const response = await post(appWith(feed), { assetId: 303, interval: '1m' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ error: 'pair_unknown' });
    expect(calls).toHaveLength(0);
  });

  it('R9 the feed receives the digits of the catalog pair the request names', async () => {
    const { feed, calls } = fakeSignalFeed(decidedEvaluation);
    const target = appWith(feed);
    await post(target, { assetId: 101, interval: '15s' });
    await post(target, { assetId: 202, interval: '15s' });
    expect(calls).toStrictEqual([
      { assetId: 101, interval: '15s', digits: 5 },
      { assetId: 202, interval: '15s', digits: 2 },
    ]);
  });
});

// #484: the analysis card's request records the user's last analysis for the reminder; since
// #828 by the pair's H1 signal, the direction the card shows
describe('POST /trading/signal with analysis', () => {
  const signalEvaluation = {
    ...decidedEvaluation,
    entry: {
      ...(decidedEvaluation.outcome === 'decided' ? decidedEvaluation.entry : {}),
      decision: { kind: 'signal', version: SIGNAL_ALGORITHM_VERSION, action: 'up' },
    },
  } as unknown as SignalEvaluation;
  const analysis = { telegramUserId: '7001', durationSec: 15 };
  const body = { assetId: 101, interval: '15s', analysis };
  const H1_SIGNAL = {
    action: 'down',
    second: T - 1_000,
    decidedAt: T - 700,
    ageMs: 1_000,
  } as const;
  // an H1 scanner port that answers `answer` for pair 101 only and records its reads
  const h1Of = (answer: typeof H1_SIGNAL | null) => {
    const reads: [number, number][] = [];
    const h1: NonNullable<SignalRoutesDeps['h1']> = {
      current: (assetId, nowMs) => {
        reads.push([assetId, nowMs]);
        return assetId === 101 ? answer : null;
      },
    };
    return { h1, reads };
  };

  it('R10 an H1 signal records the pair and duration once, after the feed, though the candles say no_signal', async () => {
    const order: string[] = [];
    const { feed } = fakeSignalFeed(() => {
      order.push('feed');
      return Promise.resolve(decidedEvaluation);
    });
    const { lastAnalysis, calls } = recordingLastAnalysis(() => {
      order.push('set');
      return Promise.resolve(true);
    });
    const target = appWith(feed, catalogOf(), lastAnalysis, h1Of(H1_SIGNAL).h1);
    const response = await post(target, body);
    expect(response.statusCode).toBe(200);
    expect(calls).toStrictEqual([[7001n, { assetId: 101, durationSec: 15 }]]);
    expect(order).toStrictEqual(['feed', 'set']);
    expect(response.json()).toMatchObject({ outcome: 'decided', h1: H1_SIGNAL });
    const without = await post(target, { assetId: 101, interval: '15s' });
    expect(response.json()).toStrictEqual(without.json());
  });

  it('R11 no H1 signal records none, though the candles signal', async () => {
    const { feed } = fakeSignalFeed(signalEvaluation);
    const { lastAnalysis, calls } = recordingLastAnalysis();
    const response = await post(appWith(feed, catalogOf(), lastAnalysis, h1Of(null).h1), body);
    expect(response.statusCode).toBe(200);
    expect(calls).toStrictEqual([[7001n, null]]);
    expect(response.json()).toMatchObject({ outcome: 'decided', h1: null });
  });

  it('R12 fetch_failed with an H1 signal records it and answers h1', async () => {
    const { feed } = fakeSignalFeed({
      outcome: 'fetch_failed',
      request: facts,
      code: 'unavailable',
      status: 503,
    });
    const { lastAnalysis, calls } = recordingLastAnalysis();
    const response = await post(appWith(feed, catalogOf(), lastAnalysis, h1Of(H1_SIGNAL).h1), body);
    expect(response.statusCode).toBe(200);
    expect(calls).toStrictEqual([[7001n, { assetId: 101, durationSec: 15 }]]);
    expect(response.json()).toStrictEqual({
      outcome: 'fetch_failed',
      code: 'unavailable',
      h1: H1_SIGNAL,
    });
    expect(safeParseTradingSignalResponse(response.json()).success).toBe(true);
  });

  it('R13 a request without analysis records nothing', async () => {
    const { feed } = fakeSignalFeed(signalEvaluation);
    const { lastAnalysis, calls } = recordingLastAnalysis();
    const response = await post(appWith(feed, catalogOf(), lastAnalysis, h1Of(H1_SIGNAL).h1), {
      assetId: 101,
      interval: '15s',
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('R22 without the data socket (no scanner) h1 is null and the analysis records none', async () => {
    const { feed } = fakeSignalFeed(signalEvaluation);
    const { lastAnalysis, calls } = recordingLastAnalysis();
    const response = await post(appWith(feed, catalogOf(), lastAnalysis), body);
    expect(response.json()).toMatchObject({ outcome: 'decided', h1: null });
    expect(calls).toStrictEqual([[7001n, null]]);
  });

  it('R23 h1 is read after the feed answered, of the requested pair, at the clock of the answer', async () => {
    const order: string[] = [];
    const { h1, reads } = h1Of(H1_SIGNAL);
    const { feed } = fakeSignalFeed(() => {
      order.push(`feed after ${reads.length} reads`);
      return Promise.resolve(decidedEvaluation);
    });
    const response = await post(appWith(feed, catalogOf(), undefined, h1), body);
    expect(order).toStrictEqual(['feed after 0 reads']);
    expect(reads).toStrictEqual([[101, T]]);
    expect(response.json()).toMatchObject({ h1: H1_SIGNAL });
  });

  it('R14 an unknown user is a 200 with the decision and no error line', async () => {
    const { feed } = fakeSignalFeed(signalEvaluation);
    const { lastAnalysis, calls } = recordingLastAnalysis(() => Promise.resolve(false));
    const response = await post(appWith(feed, catalogOf(), lastAnalysis), body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'decided' });
    expect(calls).toHaveLength(1);
    expect(parsedLines().filter((line) => (line.level as number) >= 40)).toHaveLength(0);
  });

  it('R15 a failed record is logged by name and code, and the decision is answered', async () => {
    const { feed } = fakeSignalFeed(signalEvaluation);
    const failure = Object.assign(new Error('connection to 10.0.0.5 lost: secret detail'), {
      code: '57P01',
    });
    const { lastAnalysis } = recordingLastAnalysis(() => Promise.reject(failure));
    const response = await post(appWith(feed, catalogOf(), lastAnalysis), body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'decided' });
    const warned = parsedLines().filter((line) => line.msg === 'last analysis not recorded');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 40, err: { name: 'Error', code: '57P01' } });
    expect(lines.join('\n')).not.toContain('secret detail');
  });

  it.each([
    { telegramUserId: '0', durationSec: 15 },
    { telegramUserId: 7001, durationSec: 15 },
    { telegramUserId: '7001', durationSec: 0 },
    { telegramUserId: '7001', durationSec: '15' },
    { telegramUserId: '7001' },
  ])('R16 refuses analysis %j with 400 before the feed', async (bad) => {
    const { feed, calls } = fakeSignalFeed(signalEvaluation);
    const record = recordingLastAnalysis();
    const response = await post(appWith(feed, catalogOf(), record.lastAnalysis), {
      assetId: 101,
      interval: '15s',
      analysis: bad,
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    expect(record.calls).toHaveLength(0);
  });

  it.each([
    ['503 catalog_unavailable', null, 101],
    ['409 pair_unknown', catalogOf(), 303],
  ] as const)('R17 %s records nothing', async (_, catalog, assetId) => {
    const { feed } = fakeSignalFeed(signalEvaluation);
    const { lastAnalysis, calls } = recordingLastAnalysis();
    const response = await post(appWith(feed, catalog, lastAnalysis), { ...body, assetId });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
  });
});
