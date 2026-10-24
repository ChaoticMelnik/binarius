import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerRestErrorCode, logOptions, toBinaryPair, type BinaryPair } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import {
  BROKER_PAIRS_MAX_STALE_MS,
  createPairsCatalog,
  DEFAULT_BROKER_PAIRS_TTL_MS,
  MAX_BROKER_PAIRS_TTL_MS,
  MIN_BROKER_PAIRS_TTL_MS,
  PAIRS_CATALOG_CHAIN_HOLDS,
  type PairsCatalog,
  type PairsCatalogDeps,
} from './pairs-catalog';
import {
  BROKER_REST_TIMEOUT_MS,
  BrokerRestError,
  createBrokerRestClient,
  type BrokerRestClient,
} from './rest';

const START_CLOCK = 1_790_000_000_000;

let broker: MockBroker;
let client: BrokerRestClient;
let clock: number;
// how far the wall clock (now) is from the age clock; 0 unless a test moves the wall clock alone
let wallOffset: number;
let lines: string[];
let catalogs: PairsCatalog[];

const logger = () => pino(logOptions('info'), { write: (line: string) => void lines.push(line) });

function catalogOf(overrides: Partial<PairsCatalogDeps> = {}): PairsCatalog {
  const catalog = createPairsCatalog({
    client,
    ttlMs: DEFAULT_BROKER_PAIRS_TTL_MS,
    logger: logger(),
    now: () => clock + wallOffset,
    ageClock: () => clock,
    ...overrides,
  });
  catalogs.push(catalog);
  return catalog;
}

const pairsRequests = () => broker.rest.journal.filter((record) => record.endpoint === 'pairs');
const brokerPairs = (): BinaryPair[] => broker.pairs.list().map(toBinaryPair);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  broker = await startMockBroker();
  client = createBrokerRestClient({ baseUrl: broker.url });
  clock = START_CLOCK;
  wallOffset = 0;
  lines = [];
  catalogs = [];
});

afterEach(async () => {
  for (const catalog of catalogs) catalog.stop();
  vi.useRealTimers();
  await broker.close();
});

describe('refresh and read', () => {
  it('fetches the pairs once and stamps them with the clock after the answer', async () => {
    const stamping: Pick<BrokerRestClient, 'listPairs'> = {
      listPairs: async (options) => {
        const pairs = await client.listPairs(options);
        clock = START_CLOCK + 2_000;
        return pairs;
      },
    };
    const catalog = catalogOf({ client: stamping });
    expect(await catalog.refresh()).toBe(true);
    expect(pairsRequests()).toHaveLength(1);
    expect(catalog.read()).toEqual({
      pairs: brokerPairs(),
      fetchedAt: START_CLOCK + 2_000,
      ageMs: 0,
      fresh: true,
    });
    clock += 1_500;
    expect(catalog.read()?.ageMs).toBe(1_500);
  });

  it('has nothing before the first success, and nothing after a failed first refresh', async () => {
    const catalog = catalogOf();
    expect(catalog.read()).toBeUndefined();
    broker.rest.failNext('pairs', { status: 503 });
    expect(await catalog.refresh()).toBe(false);
    expect(catalog.read()).toBeUndefined();
  });

  it('serves an empty catalog as a snapshot, not as a failure', async () => {
    await broker.close();
    broker = await startMockBroker({ pairs: [] });
    client = createBrokerRestClient({ baseUrl: broker.url });
    const catalog = catalogOf();
    expect(await catalog.refresh()).toBe(true);
    expect(catalog.read()).toEqual({ pairs: [], fetchedAt: START_CLOCK, ageMs: 0, fresh: true });
  });

  it('is fresh until ttlMs + BROKER_REST_TIMEOUT_MS old, not one ms later', async () => {
    const catalog = catalogOf();
    await catalog.refresh();
    clock = START_CLOCK + DEFAULT_BROKER_PAIRS_TTL_MS + BROKER_REST_TIMEOUT_MS;
    expect(catalog.read()?.fresh).toBe(true);
    clock += 1;
    expect(catalog.read()).toMatchObject({ fresh: false, ageMs: clock - START_CLOCK });
  });

  it('measures fresh against its own ttlMs', async () => {
    const catalog = catalogOf({ ttlMs: MAX_BROKER_PAIRS_TTL_MS });
    await catalog.refresh();
    clock = START_CLOCK + MAX_BROKER_PAIRS_TTL_MS + BROKER_REST_TIMEOUT_MS;
    expect(catalog.read()?.fresh).toBe(true);
    clock += 1;
    expect(catalog.read()?.fresh).toBe(false);
  });

  it('measures the age on the monotonic clock, not the wall clock', async () => {
    const catalog = catalogOf();
    await catalog.refresh();
    wallOffset = -3_600_000;
    expect(catalog.read()).toMatchObject({ fetchedAt: START_CLOCK, ageMs: 0, fresh: true });
    clock += BROKER_PAIRS_MAX_STALE_MS + 1;
    expect(catalog.read()).toBeUndefined();
  });

  it('stamps fetchedAt on the wall clock and grows ageMs with the age clock only', async () => {
    wallOffset = 5_000;
    const catalog = catalogOf();
    await catalog.refresh();
    expect(catalog.read()).toMatchObject({ fetchedAt: START_CLOCK + 5_000, ageMs: 0 });
    wallOffset = 60_000;
    expect(catalog.read()).toMatchObject({ fetchedAt: START_CLOCK + 5_000, ageMs: 0 });
    clock += 1_200;
    expect(catalog.read()).toMatchObject({ fetchedAt: START_CLOCK + 5_000, ageMs: 1_200 });
  });

  it('measures ages in whole milliseconds on its default clock', async () => {
    const catalog = createPairsCatalog({
      client,
      ttlMs: DEFAULT_BROKER_PAIRS_TTL_MS,
      logger: logger(),
    });
    catalogs.push(catalog);
    await catalog.refresh();
    await until('the age clock moved', () => (catalog.read()?.ageMs ?? 0) > 0);
    expect(Number.isInteger(catalog.read()?.ageMs)).toBe(true);
  });
});

describe('pair ids', () => {
  const answering = (ids: number[]): Pick<BrokerRestClient, 'listPairs'> => {
    const [template] = brokerPairs();
    if (template === undefined) throw new Error('the mock broker has no pairs');
    return {
      listPairs: () =>
        Promise.resolve(ids.map((id, index) => ({ ...template, id, symbol: `P${index}` }))),
    };
  };
  const linesWith = (msg: string) =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.msg === msg);

  it('drops a non-positive, non-int4 or repeated id with one warn, keeping the first pair', async () => {
    const catalog = catalogOf({ client: answering([7, 0, -1, 7, 2147483648, 2.5, 9]) });
    expect(await catalog.refresh()).toBe(true);
    expect(catalog.read()?.pairs.map((pair) => [pair.id, pair.symbol])).toEqual([
      [7, 'P0'],
      [9, 'P6'],
    ]);
    expect(linesWith('pairs catalog dropped pairs with an unusable id')).toEqual([
      expect.objectContaining({ dropped: 5, ids: [0, -1, 7, 2147483648, 2.5] }),
    ]);
  });

  it('serves an answer whose every pair is dropped as an empty snapshot, not a failure', async () => {
    const catalog = catalogOf({ client: answering([0, -3]) });
    expect(await catalog.refresh()).toBe(true);
    expect(catalog.read()).toMatchObject({ pairs: [], fresh: true });
    expect(linesWith('pairs catalog refresh failed')).toEqual([]);
  });
});

describe('a failed refresh', () => {
  it.each([
    { script: { status: 503 }, code: 'unavailable', fields: { status: 503 } },
    {
      script: { status: 429, retryAfterSec: 7 },
      code: 'rate_limited',
      fields: { status: 429, retryAfterSec: 7 },
    },
    {
      script: { status: 400, body: { error: { message: 'x' } } },
      code: 'rejected',
      fields: { status: 400, detail: 'x' },
    },
    {
      script: { status: 200, body: 'not json' },
      code: 'contract_violation',
      fields: { status: 200 },
    },
  ])('keeps the snapshot and logs one warn line on $code', async ({ script, code, fields }) => {
    const catalog = catalogOf();
    await catalog.refresh();
    const before = catalog.read();
    clock += 1_000;
    broker.rest.failNext('pairs', script);
    expect(await catalog.refresh()).toBe(false);
    expect(catalog.read()).toEqual({ ...before, ageMs: 1_000 });
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 40,
      msg: 'pairs catalog refresh failed',
      err: { name: 'BrokerRestError', code },
      ...fields,
    });
    expect(line).not.toHaveProperty('cause');
    expect(lines[0]).not.toContain(broker.url);
  });

  it('serves the last snapshot up to BROKER_PAIRS_MAX_STALE_MS old and nothing after', async () => {
    const catalog = catalogOf();
    await catalog.refresh();
    clock = START_CLOCK + BROKER_PAIRS_MAX_STALE_MS;
    expect(catalog.read()?.ageMs).toBe(BROKER_PAIRS_MAX_STALE_MS);
    clock += 1;
    expect(catalog.read()).toBeUndefined();
    expect(await catalog.refresh()).toBe(true);
    expect(catalog.read()).toEqual({
      pairs: brokerPairs(),
      fetchedAt: clock,
      ageMs: 0,
      fresh: true,
    });
  });
});

describe('single flight and stop', () => {
  it('shares one request between overlapping refreshes, and stop() ends it unlogged', async () => {
    const catalog = catalogOf();
    await catalog.refresh();
    const before = catalog.read();
    broker.rest.failNext('pairs', { hang: true });
    const first = catalog.refresh();
    const second = catalog.refresh();
    expect(second).toBe(first);
    await until('the refresh to hang', () => broker.rest.pendingHangs === 1);
    expect(pairsRequests()).toHaveLength(2);
    catalog.stop();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    await until('the hang to end', () => broker.rest.pendingHangs === 0);
    expect(lines).toEqual([]);
    expect(catalog.read()).toEqual(before);
  });

  it('recovers from a listPairs that throws synchronously', async () => {
    let calls = 0;
    const throwingOnce: Pick<BrokerRestClient, 'listPairs'> = {
      listPairs: (options) => {
        calls += 1;
        if (calls === 1) throw new Error('sync');
        return client.listPairs(options);
      },
    };
    const catalog = catalogOf({ client: throwingOnce });
    expect(await catalog.refresh()).toBe(false);
    expect(lines).toHaveLength(1);
    expect(await catalog.refresh()).toBe(true);
    expect(calls).toBe(2);
    expect(catalog.read()?.pairs).toEqual(brokerPairs());
  });

  it('drops an answer that arrives after stop()', async () => {
    const answeringAfterStop: Pick<BrokerRestClient, 'listPairs'> = {
      listPairs: async () => {
        const pairs = await client.listPairs();
        catalog.stop();
        return pairs;
      },
    };
    const catalog = catalogOf({ client: answeringAfterStop });
    expect(await catalog.refresh()).toBe(false);
    expect(catalog.read()).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('makes no request once stopped', async () => {
    const catalog = catalogOf();
    catalog.stop();
    expect(await catalog.refresh()).toBe(false);
    expect(pairsRequests()).toHaveLength(0);
  });
});

describe('the timer', () => {
  it('refreshes every ttlMs over real HTTP and stops with stop()', async () => {
    // counted where the catalog calls the client, so the count at stop() is exact: the interval
    // callback reaches listPairs synchronously
    let calls = 0;
    const counting: Pick<BrokerRestClient, 'listPairs'> = {
      listPairs: (options) => {
        calls += 1;
        return client.listPairs(options);
      },
    };
    const catalog = catalogOf({ client: counting, ttlMs: 20, now: Date.now, ageClock: Date.now });
    catalog.start();
    await until('three refreshes', () => pairsRequests().length >= 3);
    const [first] = broker.pairs.list();
    if (first === undefined) throw new Error('the mock broker has no pairs');
    broker.pairs.update(first.id, { payout: first.payout + 1 });
    await until(
      'the new payout',
      () => catalog.read()?.pairs.find((pair) => pair.id === first.id)?.payout === first.payout + 1,
    );
    catalog.stop();
    const atStop = calls;
    await sleep(100);
    expect(calls).toBe(atStop);
  });

  it('does not tick faster after a second start(), and not at all after stop()', async () => {
    let calls = 0;
    const counting: Pick<BrokerRestClient, 'listPairs'> = {
      listPairs: () => {
        calls += 1;
        return Promise.resolve([]);
      },
    };
    const ttlMs = 50;
    const catalog = catalogOf({ client: counting, ttlMs });
    const started = Date.now();
    catalog.start();
    catalog.start();
    await until('three ticks', () => calls >= 3);
    // defence in depth only: one interval per start() is proven by the fake-timer case below
    expect(calls).toBeLessThanOrEqual((Date.now() - started) / ttlMs + 2);
    catalog.stop();
    const atStop = calls;
    await sleep(4 * ttlMs);
    expect(calls).toBe(atStop);
  });

  it('arms one interval however often start() is called, and none after stop()', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const running = catalogOf();
    running.start();
    running.start();
    expect(vi.getTimerCount()).toBe(1);
    running.stop();
    expect(vi.getTimerCount()).toBe(0);

    const stopped = catalogOf();
    stopped.stop();
    stopped.start();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// #481: a catalog that stopped refreshing is an error in the log
describe('the stale streak', () => {
  const TTL = DEFAULT_BROKER_PAIRS_TTL_MS;
  const PAIRS: BinaryPair[] = [];
  const seam = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });
  type Mode = 'ok' | 'fail' | 'hang';

  // a listPairs that ignores its signal when it hangs, as the pilot's did
  function scripted(modes: Mode[]): Pick<BrokerRestClient, 'listPairs'> {
    let call = 0;
    return {
      listPairs: () => {
        const mode = modes[Math.min(call, modes.length - 1)];
        call += 1;
        if (mode === 'ok') return Promise.resolve(PAIRS);
        if (mode === 'fail') {
          return Promise.reject(new BrokerRestError(BrokerRestErrorCode.Unavailable));
        }
        return new Promise<BinaryPair[]>(() => undefined);
      },
    };
  }

  // one interval tick, with the catalog's clock moved by the same period
  async function tick(catalog: PairsCatalog): Promise<void> {
    clock += TTL;
    vi.advanceTimersByTime(TTL);
    await Promise.race([catalog.refresh(), Promise.resolve()]);
    await Promise.resolve();
  }

  const staleLines = (log: ReturnType<typeof seam>) =>
    log.error.mock.calls.filter(([, message]) => message === 'pairs catalog is stale');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  it('reports a refresh that never settles once, and again BROKER_PAIRS_MAX_STALE_MS after the line', async () => {
    const log = seam();
    const catalog = catalogOf({
      client: scripted(['ok', 'hang']),
      logger: log,
      abandoned: () => 7,
    });
    expect(await catalog.refresh()).toBe(true);
    catalog.start();
    await tick(catalog); // 30 s: still fresh
    expect(staleLines(log)).toHaveLength(0);
    await tick(catalog); // 60 s: past ttl + the REST timeout
    expect(staleLines(log)).toEqual([
      [{ ageMs: 2 * TTL, failedRefreshes: 0, abandoned: 7 }, 'pairs catalog is stale'],
    ]);
    const firstLineAt = clock;
    while (clock + TTL < firstLineAt + BROKER_PAIRS_MAX_STALE_MS) await tick(catalog);
    expect(staleLines(log)).toHaveLength(1);
    await tick(catalog);
    expect(clock - firstLineAt).toBe(BROKER_PAIRS_MAX_STALE_MS);
    expect(staleLines(log)).toHaveLength(2);
    expect(staleLines(log)[1]?.[0]).toEqual({
      ageMs: 2 * TTL + BROKER_PAIRS_MAX_STALE_MS,
      failedRefreshes: 0,
      abandoned: 7,
    });
  });

  it('counts failed refreshes and logs the recovery once, with the replaced snapshot age', async () => {
    const log = seam();
    const catalog = catalogOf({
      client: scripted(['ok', 'fail', 'fail', 'fail', 'ok']),
      logger: log,
      abandoned: () => 0,
    });
    await catalog.refresh();
    catalog.start();
    await tick(catalog);
    await tick(catalog);
    expect(staleLines(log)).toEqual([
      [{ ageMs: 2 * TTL, failedRefreshes: 1, abandoned: 0 }, 'pairs catalog is stale'],
    ]);
    await tick(catalog);
    expect(log.info).not.toHaveBeenCalled();
    await tick(catalog);
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      { ageMs: 4 * TTL, failedRefreshes: 3 },
      'pairs catalog fresh again',
    );
    await tick(catalog);
    expect(log.info).toHaveBeenCalledOnce();
    expect(staleLines(log)).toHaveLength(1);
  });

  it('starts a new streak at once after a recovery', async () => {
    const log = seam();
    const catalog = catalogOf({
      client: scripted(['ok', 'fail', 'ok', 'fail']),
      logger: log,
      abandoned: () => 0,
    });
    await catalog.refresh();
    catalog.start();
    await tick(catalog);
    await tick(catalog); // stale, then the refresh succeeds
    expect(staleLines(log)).toHaveLength(1);
    expect(log.info).toHaveBeenCalledOnce();
    await tick(catalog);
    await tick(catalog); // stale again, well inside BROKER_PAIRS_MAX_STALE_MS of the first line
    expect(staleLines(log)).toHaveLength(2);
  });

  it('calls a failed warm-up stale, with ageMs null', async () => {
    const log = seam();
    const catalog = catalogOf({ client: scripted(['fail']), logger: log, abandoned: () => 0 });
    expect(await catalog.refresh()).toBe(false);
    catalog.start();
    await tick(catalog);
    expect(staleLines(log)).toEqual([
      [{ ageMs: null, failedRefreshes: 1, abandoned: 0 }, 'pairs catalog is stale'],
    ]);
  });

  it('reports nothing while the catalog refreshes on time', async () => {
    const log = seam();
    const catalog = catalogOf({ client: scripted(['ok']), logger: log });
    await catalog.refresh();
    catalog.start();
    for (let i = 0; i < 20; i += 1) await tick(catalog);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});

// The issue's acceptance test (#481): a fetch that never settles and ignores its signal no
// longer holds the single flight, so the next tick sends a new request.
describe('a broker fetch that never settles', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not block the next tick past the REST deadline', async () => {
    let fetches = 0;
    vi.stubGlobal('fetch', () => {
      fetches += 1;
      return new Promise<Response>(() => undefined);
    });
    const stuck = createBrokerRestClient({ baseUrl: broker.url, timeoutMs: 20 });
    const catalog = catalogOf({
      client: stuck,
      ttlMs: 50,
      now: Date.now,
      ageClock: Date.now,
      logger: seamLogger(),
    });
    catalog.start();
    await until('a second request', () => fetches >= 2);
    expect(fetches).toBeGreaterThanOrEqual(2);
  });
});

const seamLogger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

describe('constants', () => {
  it('order the REST timeout, the TTL range and the stale ceiling', () => {
    expect(BROKER_REST_TIMEOUT_MS).toBeLessThan(MIN_BROKER_PAIRS_TTL_MS);
    expect(MIN_BROKER_PAIRS_TTL_MS).toBeLessThanOrEqual(DEFAULT_BROKER_PAIRS_TTL_MS);
    expect(DEFAULT_BROKER_PAIRS_TTL_MS).toBeLessThanOrEqual(MAX_BROKER_PAIRS_TTL_MS);
    expect(MAX_BROKER_PAIRS_TTL_MS).toBeLessThan(BROKER_PAIRS_MAX_STALE_MS);
    expect(MAX_BROKER_PAIRS_TTL_MS + BROKER_REST_TIMEOUT_MS).toBeLessThan(
      BROKER_PAIRS_MAX_STALE_MS,
    );
    expect(PAIRS_CATALOG_CHAIN_HOLDS).toBe(true);
  });
});
