import { DrizzleQueryError } from 'drizzle-orm/errors';
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

describe('error handler', () => {
  async function withApp(run: (app: ReturnType<typeof buildApp>) => Promise<void>) {
    const app = buildApp({
      checkPostgres: ok,
      checkRedis: ok,
      logLevel: 'silent',
      checkTimeoutMs: 20,
      trading: unusedTrading,
    });
    app.get('/drizzle', async () => {
      throw new DrizzleQueryError(
        'select secret_column from users where id = $1',
        ['p1'],
        new Error('relation missing'),
      );
    });
    app.get('/throttled', async () => {
      throw Object.assign(new Error('slow down'), {
        statusCode: 429,
        headers: { 'retry-after': '1' },
      });
    });
    app.post('/echo', async (request) => request.body);
    app.get('/status-only', async () => {
      // not a Fastify error: only `status`, no `statusCode`
      throw Object.assign(new Error('gone'), { status: 404 });
    });
    app.get('/redirectish', async () => {
      throw Object.assign(new Error('nope'), { statusCode: 302 });
    });
    app.get('/fractional', async () => {
      throw Object.assign(new Error('nope'), { statusCode: 4.5 });
    });
    try {
      await run(app);
    } finally {
      await app.close();
    }
  }

  it('hides the query text and parameters of a database error behind an opaque 500', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/drizzle' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal' });
      expect(response.body).not.toContain('secret_column');
      expect(response.body).not.toContain('p1');
    });
  });

  it('keeps status, headers and message of a thrown 4xx error', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/throttled' });
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.json()).toMatchObject({ statusCode: 429, message: 'slow down' });
    });
  });

  it.each(['/status-only', '/redirectish', '/fractional'])(
    'treats %s as an internal error rather than a client error',
    async (url) => {
      await withApp(async (app) => {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: 'internal' });
      });
    },
  );

  it('leaves body-parsing failures as 400 with their default shape', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{not json',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    });
  });
});
