import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logOptions, toBinaryPair, type BinaryPair } from '@binarius/shared';
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
import { BROKER_REST_TIMEOUT_MS, createBrokerRestClient, type BrokerRestClient } from './rest';

const START_CLOCK = 1_790_000_000_000;

let broker: MockBroker;
let client: BrokerRestClient;
let clock: number;
let lines: string[];
let catalogs: PairsCatalog[];

const logger = () => pino(logOptions('info'), { write: (line: string) => void lines.push(line) });

function catalogOf(overrides: Partial<PairsCatalogDeps> = {}): PairsCatalog {
  const catalog = createPairsCatalog({
    client,
    ttlMs: DEFAULT_BROKER_PAIRS_TTL_MS,
    logger: logger(),
    now: () => clock,
    ...overrides,
  });
  catalogs.push(catalog);
  return catalog;
}

const pairsRequests = () => broker.rest.journal.filter((record) => record.endpoint === 'pairs');
const brokerPairs = (): BinaryPair[] => broker.pairs.list().map(toBinaryPair);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

beforeEach(async () => {
  broker = await startMockBroker();
  client = createBrokerRestClient({ baseUrl: broker.url });
  clock = START_CLOCK;
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
    expect(catalog.read()).toEqual({ pairs: [], fetchedAt: START_CLOCK, ageMs: 0 });
  });

  it('reports age 0 when the clock went back', async () => {
    const catalog = catalogOf();
    await catalog.refresh();
    clock -= 10_000;
    expect(catalog.read()?.ageMs).toBe(0);
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
    { script: { status: 200, body: 'not json' }, code: 'contract_violation', fields: { status: 200 } },
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
    expect(catalog.read()).toEqual({ pairs: brokerPairs(), fetchedAt: clock, ageMs: 0 });
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
    await waitFor(() => broker.rest.pendingHangs === 1);
    expect(pairsRequests()).toHaveLength(2);
    catalog.stop();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    await waitFor(() => broker.rest.pendingHangs === 0);
    expect(lines).toEqual([]);
    expect(catalog.read()).toEqual(before);
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
    const catalog = catalogOf({ ttlMs: 20, now: Date.now });
    catalog.start();
    await waitFor(() => pairsRequests().length >= 3);
    const [first] = broker.pairs.list();
    if (first === undefined) throw new Error('the mock broker has no pairs');
    broker.pairs.update(first.id, { payout: first.payout + 1 });
    await waitFor(
      () => catalog.read()?.pairs.find((pair) => pair.id === first.id)?.payout === first.payout + 1,
    );
    catalog.stop();
    await sleep(30);
    const settled = pairsRequests().length;
    await sleep(100);
    expect(pairsRequests()).toHaveLength(settled);
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
    const windowMs = 500;
    const catalog = catalogOf({ client: counting, ttlMs });
    catalog.start();
    catalog.start();
    await sleep(windowMs);
    // a late timer only ticks less; two intervals would give about twice windowMs / ttlMs
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(windowMs / ttlMs + 2);
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

describe('constants', () => {
  it('order the REST timeout, the TTL range and the stale ceiling', () => {
    expect(BROKER_REST_TIMEOUT_MS).toBeLessThan(MIN_BROKER_PAIRS_TTL_MS);
    expect(MIN_BROKER_PAIRS_TTL_MS).toBeLessThanOrEqual(DEFAULT_BROKER_PAIRS_TTL_MS);
    expect(DEFAULT_BROKER_PAIRS_TTL_MS).toBeLessThanOrEqual(MAX_BROKER_PAIRS_TTL_MS);
    expect(MAX_BROKER_PAIRS_TTL_MS).toBeLessThan(BROKER_PAIRS_MAX_STALE_MS);
    expect(PAIRS_CATALOG_CHAIN_HOLDS).toBe(true);
  });
});
