import { createBrokerRestClient } from '@binarius/broker-rest';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import {
  DEFAULT_SIGNAL_PARAMS,
  createCachedSignalFeed,
  createSignalFeed,
  replaySignalJournalEntry,
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
import { unusedAdminDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import type { UsersRoutesDeps } from '../users/routes';
import type { TradingRoutesDeps } from './routes';
import type { SignalRoutesDeps } from './signal-routes';
import {
  fakeCatalog,
  fakeSignalFeed,
  PAIRS_TEST_TOKEN,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSessionDeps,
  unusedSignalsDeps,
} from './testing';

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
    fetch: { startTime: facts.startTime, limit: 60, rows: 60, durationMs: 12 },
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
): FastifyInstance {
  lines = [];
  app = buildApp({
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
    },
    signals: unusedSignalsDeps(),
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
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
    });
    expect(safeParseTradingSignalResponse(body).success).toBe(true);
    expect(calls).toStrictEqual([{ assetId: 101, interval: '1m', digits: 5 }]);
  });

  it.each([
    {
      evaluation: { code: 'rate_limited', status: 429, retryAfterSec: 7 },
      body: { outcome: 'fetch_failed', code: 'rate_limited', retryAfterSec: 7 },
    },
    {
      evaluation: { code: 'unavailable', status: 503 },
      body: { outcome: 'fetch_failed', code: 'unavailable' },
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
    const body = first.json<{ outcome: string; decision: unknown }>();
    expect(body.outcome).toBe('decided');
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
    });
    expect(parsedLines().filter((line) => line.msg === 'signal fetch failed')).toHaveLength(1);
    expect(broker.rest.journal.filter((entry) => entry.endpoint === 'chart')).toHaveLength(2);
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
