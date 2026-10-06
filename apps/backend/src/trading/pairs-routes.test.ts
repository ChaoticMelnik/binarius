import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  safeParsePairsCatalogResponse,
  toPairsCatalogResponse,
  TRADING_PAIRS_PATH,
  type BinaryPair,
  type PairsCatalogView,
} from '@binarius/shared';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import type { TradingRoutesDeps } from './routes';
import type { UsersRoutesDeps } from '../users/routes';
import { fakeCatalog, PAIRS_TEST_TOKEN, unusedBalanceDeps } from './testing';

const pair: BinaryPair = {
  id: 101,
  symbol: 'EUR/USD',
  isOtc: true,
  type: 'currency',
  digits: 5,
  payout: 82,
  maxPayout: 90,
  minTimeframe: 30,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};

let app: FastifyInstance | undefined;

function appWith(view: PairsCatalogView | undefined): FastifyInstance {
  app = buildApp({
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 20,
    trading: {
      db: {} as TradingRoutesDeps['db'],
      internalApiToken: PAIRS_TEST_TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      realTradingEnabled: false,
    },
    pairs: { catalog: fakeCatalog(view), internalApiToken: PAIRS_TEST_TOKEN },
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
  });
  return app;
}

// null sends no authorization header at all
const get = (target: FastifyInstance, token: string | null = PAIRS_TEST_TOKEN) =>
  target.inject({
    method: 'GET',
    url: TRADING_PAIRS_PATH,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /trading/pairs', () => {
  it.each([null, 'wrong-token'])('refuses bearer %s with 401', async (token) => {
    const response = await get(appWith({ pairs: [pair], fetchedAt: 1, ageMs: 0 }), token);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('answers 503 catalog_unavailable when the cache has no usable snapshot', async () => {
    const response = await get(appWith(undefined));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'catalog_unavailable' });
  });

  it('answers the snapshot through the allowlist', async () => {
    const withoutOtc: BinaryPair = { ...pair };
    delete withoutOtc.isOtc;
    const future = { ...pair, id: 102, spread: 3 } as BinaryPair;
    const view = { pairs: [pair, withoutOtc, future], fetchedAt: 1_790_000_000_000, ageMs: 1_200 };
    const response = await get(appWith(view));
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(safeParsePairsCatalogResponse(body).success).toBe(true);
    expect(body).toEqual(toPairsCatalogResponse(view));
    const [, second, third] = (body as { pairs: Record<string, unknown>[] }).pairs;
    expect(second).not.toHaveProperty('isOtc');
    expect(third).not.toHaveProperty('spread');
  });
});
