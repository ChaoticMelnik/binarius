import {
  safeParseTradingSignalsResponse,
  SIGNAL_CHART_INTERVAL_MS,
  TRADING_SIGNALS_PATH,
} from '@binarius/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import type { ScanEntry, ScanSnapshot } from '../signal/scanner';
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

// a 15 s boundary, so a 5 s one too; the candle before it opened at CLOSED (15s) or CLOSED_5S (5s)
const B = 1_760_000_010_000;
const CLOSED = B - SIGNAL_CHART_INTERVAL_MS['15s'];
const CLOSED_5S = B - SIGNAL_CHART_INTERVAL_MS['5s'];
const NOW = B + 2_000;

const signal = (lastCandleTimestamp: number): ScanEntry => ({
  kind: 'signal',
  action: 'down',
  lastCandleTimestamp,
  decidedAtMs: B + 500,
});

let app: FastifyInstance | undefined;

const of15s = (scanned: number[], entries: [number, ScanEntry][]): ScanSnapshot => ({
  interval: '15s',
  scanned,
  entries: new Map(entries),
});

function appWith(snapshots: ScanSnapshot[], now = NOW): FastifyInstance {
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
      demoOnly: false,
    },
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: {
      scanners: snapshots.map((snapshot) => ({
        snapshot: () => {
          read += 1;
          return snapshot;
        },
      })),
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
      const target = appWith([of15s([1], [[1, signal(CLOSED)]])]);
      const response = await get(target, token);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
      expect((target as unknown as { snapshotReads: number }).snapshotReads).toBe(0);
    },
  );

  it('R2 serves one list per interval in SIGNAL_SCAN_INTERVALS order, each fresh on its own candle, and the answer parses (R4)', async () => {
    const response = await get(
      // the scanners in the reverse order: the lists still come 15s first
      appWith([
        {
          interval: '5s',
          scanned: [3, 4],
          entries: new Map([
            [3, signal(CLOSED_5S)],
            // a 15 s-old candle is not the 5 s candle that closed last
            [4, signal(CLOSED)],
          ]),
        },
        of15s(
          [1, 2],
          [
            [1, signal(CLOSED)],
            [2, signal(CLOSED)],
          ],
        ),
      ]),
    );
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(safeParseTradingSignalsResponse(body).success).toBe(true);
    const item = (assetId: number, lastCandleTimestamp: number) => ({
      assetId,
      action: 'down',
      lastCandleTimestamp,
      decidedAt: B + 500,
      ageMs: 2_000,
    });
    expect(body).toEqual({
      asOf: NOW,
      lists: [
        { interval: '15s', scanned: 2, signals: [item(1, CLOSED), item(2, CLOSED)] },
        { interval: '5s', scanned: 2, signals: [item(3, CLOSED_5S)] },
      ],
    });
  });

  it('R3 a signal on the candle before the last closed one is not served', async () => {
    const response = await get(
      appWith([of15s([1], [[1, signal(CLOSED)]])], B + SIGNAL_CHART_INTERVAL_MS['15s'] + 100),
    );
    expect(response.json()).toMatchObject({ lists: [{ scanned: 1, signals: [] }] });
  });

  it('R5 a no_signal and a pair without an entry (a failed fetch) never appear', async () => {
    const response = await get(
      appWith([
        of15s(
          [1, 2, 3],
          [
            [1, { kind: 'no_signal', lastCandleTimestamp: CLOSED, decidedAtMs: B + 500 }],
            [3, signal(CLOSED)],
          ],
        ),
      ]),
    );
    const { lists } = response.json() as { lists: { scanned: number; signals: unknown[] }[] };
    expect(lists).toMatchObject([
      { scanned: 3, signals: [expect.objectContaining({ assetId: 3 })] },
    ]);
    expect(lists[0]?.signals).toHaveLength(1);
  });
});
