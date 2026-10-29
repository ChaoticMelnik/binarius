import pino from 'pino';
import {
  safeParseTradingSignalsResponse,
  toBinaryPair,
  TRADING_SIGNALS_PATH,
  type PairsCatalogView,
} from '@binarius/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { unusedAdminDeps, unusedPaymentsDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import { createH1Scanner, EMPTY_H1_SCANNER_LIST, type H1Scanner } from '../h1/scanner';
import type { ClosedSecond } from '../market-data/seconds';
import type { UsersRoutesDeps } from '../users/routes';
import type { TradingRoutesDeps } from './routes';
import type { SignalsRoutesDeps } from './signals-routes';
import {
  PAIRS_TEST_TOKEN,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSessionDeps,
  unusedSignalDeps,
} from './testing';
import { unusedDepositDeps } from '../deposit/testing';

// The H1 scanner's list (#828): a real scanner on a scripted series. T is the first second, F the
// first one with a full window; a ramp signals on F, a flat tail after noise is a no_signal.
const T = 1_760_000_000_000;
const F = T + 300_000;
const MAX_AGE_MS = 1_600;

const pairOf = (id: number) =>
  toBinaryPair({
    id,
    symbol: `P${id}`,
    is_otc: false,
    type: 'currency',
    digits: 5,
    payout: 90,
    max_payout: 90,
    min_timeframe: 5,
    max_timeframe: 3600,
    scheduled_until: 0,
  });

const flat = (n: number, price = 1.1) => Array<number>(n).fill(price);
const up = [...flat(300), 1.1001];
const down = [...flat(300), 1.0999];
const quiet = [...Array.from({ length: 297 }, (_, i) => (i % 2 === 0 ? 1.1 : 1.1002)), ...flat(4)];

function scripted(pairs: number[]) {
  const prices = new Map<number, Map<number, number>>();
  const listeners = new Set<(closed: ClosedSecond) => void>();
  const clock = { now: T };
  const view: PairsCatalogView = { pairs: pairs.map(pairOf), fetchedAt: T, ageMs: 0, fresh: true };
  const scanner = createH1Scanner({
    series: {
      onClosed(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      window(assetId, f, lengthSec) {
        const own = prices.get(assetId);
        const closes = new Float64Array(lengthSec);
        let complete = true;
        for (let i = 0; i < lengthSec; i++) {
          const price = own?.get(f - (lengthSec - 1 - i) * 1_000);
          closes[i] = price ?? NaN;
          if (price === undefined) complete = false;
        }
        return { closes, complete };
      },
    },
    catalog: { read: () => view },
    streaming: () => true,
    logger: pino({ level: 'silent' }),
    now: () => clock.now,
    config: { logMs: 60_000, maxAgeMs: MAX_AGE_MS },
  });
  scanner.start();
  return {
    scanner,
    feed(assetId: number, list: readonly number[]) {
      const own = prices.get(assetId) ?? new Map<number, number>();
      prices.set(assetId, own);
      list.forEach((price, i) => {
        const second = T + i * 1_000;
        own.set(second, price);
        clock.now = second + 300;
        for (const listener of listeners) {
          listener({ assetId, second, closedBy: 'tick', closedAtMs: second + 300 });
        }
      });
    },
  };
}

let app: FastifyInstance | undefined;
const scanners: H1Scanner[] = [];

function appWith(scanner: SignalsRoutesDeps['scanner'], now: number): FastifyInstance {
  app = buildApp({
    deposit: unusedDepositDeps(),
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
    signals: { scanner, internalApiToken: PAIRS_TEST_TOKEN, now: () => now },
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
    payments: unusedPaymentsDeps(),
  });
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
  for (const scanner of scanners.splice(0)) scanner.stop();
});

const fed = (feeds: [number, readonly number[]][]) => {
  const s = scripted(feeds.map(([assetId]) => assetId));
  scanners.push(s.scanner);
  for (const [assetId, list] of feeds) s.feed(assetId, list);
  return s.scanner;
};

describe('GET /trading/signals (#828: the H1 scanner)', () => {
  it.each([null, 'wrong-token'])('R1 refuses bearer %s with 401 before the list', async (token) => {
    let reads = 0;
    const target = appWith(
      {
        fresh: () => {
          reads += 1;
          return EMPTY_H1_SCANNER_LIST;
        },
      },
      F + 500,
    );
    const response = await get(target, token);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(reads).toBe(0);
  });

  it("R2 serves the one list of the H1 trade's interval, and the answer parses (R4)", async () => {
    const response = await get(
      appWith(
        fed([
          [1, up],
          [2, down],
          [3, quiet],
        ]),
        F + 900,
      ),
    );
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(safeParseTradingSignalsResponse(body).success).toBe(true);
    expect(body).toEqual({
      asOf: F + 900,
      lists: [
        {
          interval: '5s',
          scanned: 3,
          // floor((F + 900) / 1000) % 3 = 2: the third pair by assetId; the quiet pair's move is 0
          summary: { streaming: true, scanning: 3, closeness: [{ assetId: 3, pct: 0 }] },
          signals: [
            { assetId: 1, action: 'up', second: F, decidedAt: F + 300, ageMs: 900 },
            { assetId: 2, action: 'down', second: F, decidedAt: F + 300, ageMs: 900 },
          ],
        },
      ],
    });
  });

  it('R3 a second older than the bound is not served; at the bound it is', async () => {
    const scanner = fed([[1, up]]);
    expect((await get(appWith(scanner, F + MAX_AGE_MS))).json()).toMatchObject({
      lists: [{ scanned: 1, signals: [{ assetId: 1, ageMs: MAX_AGE_MS }] }],
    });
    await app?.close();
    expect((await get(appWith(scanner, F + MAX_AGE_MS + 1))).json()).toMatchObject({
      lists: [{ scanned: 0, signals: [] }],
    });
  });

  it('R5 a no_signal and a pair without an entry never appear', async () => {
    // pair 4 is in the catalog, but its series never filled a window
    const scanner = fed([
      [3, quiet],
      [4, flat(10)],
    ]);
    expect((await get(appWith(scanner, F + 500))).json()).toEqual({
      asOf: F + 500,
      lists: [
        {
          interval: '5s',
          scanned: 1,
          summary: { streaming: true, scanning: 3, closeness: [{ assetId: 3, pct: 0 }] },
          signals: [],
        },
      ],
    });
  });

  it('R6 without the data socket (no scanner) the list and its summary are empty', async () => {
    expect((await get(appWith(undefined, F))).json()).toEqual({
      asOf: F,
      lists: [
        {
          interval: '5s',
          scanned: 0,
          summary: { streaming: false, scanning: null, closeness: [] },
          signals: [],
        },
      ],
    });
  });

  it("R7 the scanner's summary goes on the wire by its named fields (#859)", async () => {
    const summary = {
      streaming: false,
      scanning: 7,
      closeness: [
        { assetId: 7, pct: 82 },
        { assetId: 5, pct: 71 },
      ],
    };
    const body: unknown = (
      await get(appWith({ fresh: () => ({ scanned: 2, signals: [], summary }) }, F))
    ).json();
    expect(safeParseTradingSignalsResponse(body).data?.lists[0]?.summary).toEqual(summary);
  });
});
