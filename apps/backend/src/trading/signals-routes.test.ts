import { safeParseTradingSignalsResponse, TRADING_SIGNALS_PATH } from '@binarius/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import { SCAN_INTERVAL_MS, type ScanEntry, type ScanSnapshot } from '../signal/scanner';
import type { UsersRoutesDeps } from '../users/routes';
import type { TradingRoutesDeps } from './routes';
import {
  PAIRS_TEST_TOKEN,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSessionDeps,
  unusedSignalDeps,
} from './testing';

// a 15 s boundary; the candle before it closed at B
const B = 1_760_000_010_000;
const CLOSED = B - SCAN_INTERVAL_MS;
const NOW = B + 2_000;

const signal = (lastCandleTimestamp: number): ScanEntry => ({
  kind: 'signal',
  action: 'down',
  lastCandleTimestamp,
  decidedAtMs: B + 500,
});

let app: FastifyInstance | undefined;

function appWith(snapshot: ScanSnapshot, now = NOW): FastifyInstance {
  let read = 0;
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
      accessToken: unusedAccessTokenDeps(),
    },
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: {
      scanner: {
        snapshot: () => {
          read += 1;
          return snapshot;
        },
      },
      internalApiToken: PAIRS_TEST_TOKEN,
      now: () => now,
    },
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
  });
  Object.defineProperty(app, 'snapshotReads', { get: () => read });
  return app;
}

// null sends no authorization header at all
const get = (target: FastifyInstance, token: string | null = PAIRS_TEST_TOKEN) =>
  target.inject({
    method: 'GET',
    url: TRADING_SIGNALS_PATH,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /trading/signals', () => {
  it.each([null, 'wrong-token'])(
    'R1 refuses bearer %s with 401 before the snapshot',
    async (token) => {
      const target = appWith({ scanned: [1], entries: new Map([[1, signal(CLOSED)]]) });
      const response = await get(target, token);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
      expect((target as unknown as { snapshotReads: number }).snapshotReads).toBe(0);
    },
  );

  it('R2 serves the fresh signals with their age, and the answer parses with the schema (R4)', async () => {
    const response = await get(
      appWith({
        scanned: [1, 2],
        entries: new Map([
          [1, signal(CLOSED)],
          [2, signal(CLOSED)],
        ]),
      }),
    );
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(safeParseTradingSignalsResponse(body).success).toBe(true);
    expect(body).toEqual({
      asOf: NOW,
      interval: '15s',
      scanned: 2,
      signals: [1, 2].map((assetId) => ({
        assetId,
        action: 'down',
        lastCandleTimestamp: CLOSED,
        decidedAt: B + 500,
        ageMs: 2_000,
      })),
    });
  });

  it('R3 a signal on the candle before the last closed one is not served', async () => {
    const response = await get(
      appWith(
        { scanned: [1], entries: new Map([[1, signal(CLOSED)]]) },
        B + SCAN_INTERVAL_MS + 100,
      ),
    );
    expect(response.json()).toMatchObject({ scanned: 1, signals: [] });
  });

  it('R5 a no_signal and a pair without an entry (a failed fetch) never appear', async () => {
    const response = await get(
      appWith({
        scanned: [1, 2, 3],
        entries: new Map<number, ScanEntry>([
          [1, { kind: 'no_signal', lastCandleTimestamp: CLOSED, decidedAtMs: B + 500 }],
          [3, signal(CLOSED)],
        ]),
      }),
    );
    expect(response.json()).toMatchObject({
      scanned: 3,
      signals: [expect.objectContaining({ assetId: 3 })],
    });
    expect((response.json() as { signals: unknown[] }).signals).toHaveLength(1);
  });
});
