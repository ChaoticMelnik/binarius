import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { buildApp, withoutSecrets, type AppDeps } from './app';
import type { AuthRoutesDeps } from './auth/routes';
import type { TradingRoutesDeps } from './trading/routes';

const ok = () => Promise.resolve();
const down = () => Promise.reject(new Error('down'));
const hang = () => new Promise<never>(() => {});
const throwsSync = () => {
  throw new Error('sync failure');
};

// the health and error-handler routes never touch the plugins' dependencies
const unusedTrading: TradingRoutesDeps = {
  db: {} as TradingRoutesDeps['db'],
  internalApiToken: 'internal-token-for-tests',
  onIntentQueued: () => {},
};

const unusedAuth: AuthRoutesDeps = {
  db: {} as AuthRoutesDeps['db'],
  cipher: {} as AuthRoutesDeps['cipher'],
  broker: {} as AuthRoutesDeps['broker'],
  internalApiToken: 'internal-token-for-tests',
  authorizeUrl: 'https://binodex.app/oauth/authorize',
  clientId: 'client-id',
  redirectUri: 'https://bot.example/oauth/callback',
  partnerRef: 'partner-ref',
};

async function health(deps: Pick<AppDeps, 'checkPostgres' | 'checkRedis'>) {
  const app = buildApp({
    ...deps,
    logLevel: 'silent',
    checkTimeoutMs: 20,
    trading: unusedTrading,
    auth: unusedAuth,
  });
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

// what this app keeps out of its logs is only provable by reading them
function captureLogs() {
  const lines: string[] = [];
  return {
    text: () => lines.join('\n'),
    // the line a case is about, parsed: asserting the exact shape of `err` is what pins
    // errorLogFields, since a raw error would serialize with message, stack and its own fields
    entry(msg: string): Record<string, unknown> {
      const found = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((parsed) => parsed.msg === msg);
      if (found === undefined) throw new Error(`no log line said ${msg}`);
      return found;
    },
    write: (line: string) => void lines.push(line),
  };
}

describe('what reaches the log', () => {
  async function withLogs(
    run: (app: ReturnType<typeof buildApp>, logs: ReturnType<typeof captureLogs>) => Promise<void>,
    overrides: Partial<AppDeps> = {},
  ) {
    const logs = captureLogs();
    const app = buildApp({
      checkPostgres: ok,
      checkRedis: ok,
      logLevel: 'info',
      checkTimeoutMs: 20,
      trading: unusedTrading,
      auth: unusedAuth,
      logDestination: logs,
      ...overrides,
    });
    app.get('/drizzle', async () => {
      throw new DrizzleQueryError(
        'select secret_column from users where id = $1',
        ['BOUND-VALUE'],
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          detail: 'Key (email)=(victim@example.test) already exists.',
        }),
      );
    });
    try {
      await run(app, logs);
    } finally {
      await app.close();
    }
  }

  it('logs a database failure by its SQLSTATE, not by its parameters or its message', async () => {
    await withLogs(async (app, logs) => {
      expect((await app.inject({ method: 'GET', url: '/drizzle' })).statusCode).toBe(500);
      const entry = logs.entry('unhandled request error');
      // exact shapes, not just absences: a raw error would bring message, stack and its own
      // fields along, and this is what says it did not
      expect(entry.err).toEqual({ name: 'Error' });
      // the diagnostic that makes a 500 actionable, and the only thing kept from the cause
      expect(entry.cause).toEqual({ name: 'Error', code: '23505' });
      expect(entry.query).toBe('select secret_column from users where id = $1');
      // nothing that carries a value: drizzle puts the parameters on a field AND inside the
      // message, and pg puts the offending row in `detail`
      const text = logs.text();
      expect(text).not.toContain('BOUND-VALUE');
      expect(text).not.toContain('params:');
      expect(text).not.toContain('duplicate key value');
      expect(text).not.toContain('victim@example.test');
    });
  });

  it('keeps an authorization code and a state out of the access log and the 404 log', async () => {
    await withLogs(async (app, logs) => {
      const response = await app.inject({
        method: 'GET',
        url: '/oauth/callback?code=CODE-SECRET&state=STATE-SECRET',
      });
      expect(response.statusCode).toBe(404);
      const text = logs.text();
      expect(text).toContain('route not found');
      expect(text).not.toContain('CODE-SECRET');
      expect(text).not.toContain('STATE-SECRET');
      // Fastify's own not-found line would have carried the whole url
      expect(text).not.toContain('Route GET:/oauth/callback');
    });
  });

  // the path our own error handler delegates to: `reply.send(error)` re-enters Fastify, whose
  // own logger would write the error whole, message and stack included
  it('logs a refused request by identity, keeping its status and code', async () => {
    await withLogs(async (app, logs) => {
      app.get('/four', async () => {
        throw Object.assign(new Error('4xx message with MARKER-SECRET inside'), {
          statusCode: 400,
          code: 'FST_ERR_PROBE',
        });
      });
      const response = await app.inject({ method: 'GET', url: '/four' });
      // the response is unchanged: a 4xx still tells the caller what was wrong, message included
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        statusCode: 400,
        code: 'FST_ERR_PROBE',
        message: '4xx message with MARKER-SECRET inside',
      });

      const entry = logs.entry('request refused');
      expect(entry.err).toEqual({ name: 'Error', code: 'FST_ERR_PROBE' });
      // the operational field the original line carried
      expect(entry.res).toMatchObject({ statusCode: 400 });
      const text = logs.text();
      expect(text).not.toContain('MARKER-SECRET');
      expect(text).not.toContain('    at ');
    });
  });

  it('reports a failed dependency check by name and code only', async () => {
    await withLogs(
      async (app, logs) => {
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(503);
        // the whole shape, so a raw error's message and stack cannot slip back in
        expect(logs.entry('postgres check failed').err).toEqual({
          name: 'Error',
          code: 'ECONNREFUSED',
        });
        expect(logs.text()).not.toContain('LEAKY-DSN');
      },
      {
        checkPostgres: () =>
          Promise.reject(
            Object.assign(new Error('connection to LEAKY-DSN failed'), { code: 'ECONNREFUSED' }),
          ),
      },
    );
  });
});

describe('request logging', () => {
  // the broker chooses how it delivers the code; if it ever ignores response_mode=web_message
  // the code arrives as a query parameter, and an unexpected delivery lands on a 404
  it.each([
    ['/oauth/callback?code=SECRET&state=ALSO-SECRET', ['SECRET', 'ALSO-SECRET']],
    ['/oauth/callback?code=SECRET', ['SECRET']],
    ['/oauth/callback?state=ALSO-SECRET&next=%2Fhome', ['ALSO-SECRET']],
  ])('strips the secrets from %s', (url, secrets) => {
    const stripped = withoutSecrets(url);
    for (const secret of secrets) expect(stripped).not.toContain(secret);
    expect(stripped).toContain('redacted');
  });

  it('leaves a url that carries no secret exactly as it was', () => {
    expect(withoutSecrets('/health')).toBe('/health');
    expect(withoutSecrets('/trading/intents?limit=10')).toBe('/trading/intents?limit=10');
  });

  it('answers an unknown route without echoing what it carried', async () => {
    const app = buildApp({
      checkPostgres: ok,
      checkRedis: ok,
      logLevel: 'silent',
      checkTimeoutMs: 20,
      trading: unusedTrading,
      auth: unusedAuth,
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/oauth/callback?code=SECRET&state=ALSO-SECRET',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found' });
      expect(response.body).not.toContain('SECRET');
    } finally {
      await app.close();
    }
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
      auth: unusedAuth,
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
