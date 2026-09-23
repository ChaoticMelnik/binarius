import { describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from './app';
import type { TradingRoutesDeps } from './trading/routes';

const ok = () => Promise.resolve();
const down = () => Promise.reject(new Error('down'));
const hang = () => new Promise<never>(() => {});
const throwsSync = () => {
  throw new Error('sync failure');
};

// the health route never touches the trading plugin's dependencies
const unusedTrading: TradingRoutesDeps = {
  db: {} as TradingRoutesDeps['db'],
  internalApiToken: 'internal-token-for-tests',
  onIntentQueued: () => {},
};

async function health(deps: Pick<AppDeps, 'checkPostgres' | 'checkRedis'>) {
  const app = buildApp({ ...deps, logLevel: 'silent', checkTimeoutMs: 20, trading: unusedTrading });
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    return { statusCode: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
}

describe('GET /health', () => {
  it('returns 200 when both dependencies respond', async () => {
    expect(await health({ checkPostgres: ok, checkRedis: ok })).toEqual({
      statusCode: 200,
      body: { status: 'ok', postgres: 'ok', redis: 'ok' },
    });
  });

  it('returns 503 with postgres marked when postgres fails', async () => {
    expect(await health({ checkPostgres: down, checkRedis: ok })).toEqual({
      statusCode: 503,
      body: { status: 'degraded', postgres: 'error', redis: 'ok' },
    });
  });

  it('returns 503 with redis marked when redis fails', async () => {
    expect(await health({ checkPostgres: ok, checkRedis: down })).toEqual({
      statusCode: 503,
      body: { status: 'degraded', postgres: 'ok', redis: 'error' },
    });
  });

  it('treats a synchronous throw as a failed check, not a server error', async () => {
    expect(await health({ checkPostgres: throwsSync, checkRedis: ok })).toEqual({
      statusCode: 503,
      body: { status: 'degraded', postgres: 'error', redis: 'ok' },
    });
  });

  it('times out a check that never settles', async () => {
    expect(await health({ checkPostgres: ok, checkRedis: hang })).toEqual({
      statusCode: 503,
      body: { status: 'degraded', postgres: 'ok', redis: 'error' },
    });
  });
});
