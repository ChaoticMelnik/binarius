import {
  safeParseBinaryPairs,
  safeParseBrokerError,
  safeParseBrokerUser,
  safeParseCandles,
  safeParseClosedTrade,
  safeParseOpenTrade,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS, until } from '@binarius/shared/testing';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockRequestRecord, MockRestEndpoint, MockScript } from './faults';
import { startMockBroker, type MockBroker } from './server';

const TOKEN = 'access-token-of-user-1';
const EURUSD = 101;

let broker: MockBroker;

beforeEach(async () => {
  broker = await startMockBroker();
  broker.users.register({ id: 1, accessToken: TOKEN });
});

afterEach(async () => {
  await broker.close();
});

interface CallOptions {
  method?: string;
  token?: string | null;
  authorization?: string;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
  signal?: AbortSignal;
}

async function call(path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  else if (token !== null) headers.authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers['content-type'] = options.contentType ?? 'application/json';
  const response = await fetch(`${broker.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
}

const tradeBody = (overrides: Record<string, unknown> = {}) => ({
  asset_id: EURUSD,
  amount: '10.00',
  action: 'up',
  duration: 60,
  is_demo: true,
  ...overrides,
});

const openTrade = (overrides: Record<string, unknown> = {}) =>
  call('/v1/broker/user/trades', { method: 'POST', body: tradeBody(overrides) });

function expectError(response: { status: number; body: unknown }, status: number, message: string) {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: { message, details: {} } });
  expect(safeParseBrokerError(response.body).success).toBe(true);
}

describe('GET /v1/broker/user', () => {
  it('answers the user in the shared contract shape with money as JSON numbers', async () => {
    const response = await call('/v1/broker/user');
    expect(response.status).toBe(200);
    expect(safeParseBrokerUser(response.body).success).toBe(true);
    expect(response.headers.get('x-ratelimit-limit')).toBe('600');
    const user = response.body as { min_trade_amount: unknown; demo: object; real: object };
    for (const value of [
      user.min_trade_amount,
      ...Object.values(user.demo),
      ...Object.values(user.real),
    ]) {
      expect(typeof value).toBe('number');
    }
  });
});

describe('bearer auth', () => {
  const protectedCalls: [string, () => CallOptions & { path: string }][] = [
    ['GET /user', () => ({ path: '/v1/broker/user' })],
    ['GET /user/trades', () => ({ path: '/v1/broker/user/trades' })],
    [
      'POST /user/trades',
      () => ({ path: '/v1/broker/user/trades', method: 'POST', body: tradeBody() }),
    ],
  ];

  it.each(protectedCalls)(
    '%s refuses a missing, malformed, unknown or revoked token',
    async (_name, make) => {
      const { path, ...options } = make();
      expectError(
        await call(path, { ...options, token: null }),
        401,
        'Authentication failed: Missing bearer token',
      );
      for (const authorization of [
        'Basic abc',
        'Bearer ',
        'Bearer    ',
        `bearer ${TOKEN}`,
        TOKEN,
      ]) {
        expectError(
          await call(path, { ...options, authorization }),
          401,
          'Authentication failed: Missing bearer token',
        );
      }
      expectError(
        await call(path, { ...options, token: 'nope' }),
        401,
        'Authentication failed: Invalid token',
      );
      broker.users.revokeToken(TOKEN);
      expectError(await call(path, options), 401, 'Authentication failed: Invalid token');
    },
  );

  it('checks the token before it reads the body', async () => {
    const response = await call('/v1/broker/user/trades', {
      method: 'POST',
      token: null,
      rawBody: '{not json',
    });
    expectError(response, 401, 'Authentication failed: Missing bearer token');
  });

  it('keeps pairs and chart public', async () => {
    expect((await call('/v1/broker/pairs/binary', { token: null })).status).toBe(200);
    const chart = await call(
      `/v1/broker/chart?interval=1m&asset_id=${EURUSD}&start_time=${Date.now() - 600_000}`,
      {
        token: null,
      },
    );
    expect(chart.status).toBe(200);
  });
});

describe('GET /v1/broker/pairs/binary', () => {
  it('answers the pairs in the shared contract shape', async () => {
    const response = await call('/v1/broker/pairs/binary');
    expect(response.status).toBe(200);
    expect(safeParseBinaryPairs(response.body).success).toBe(true);
    expect(response.body).toEqual(broker.pairs.list());
  });
});

describe('POST /v1/broker/user/trades', () => {
  it('opens a trade and answers it in the shared contract shape plus close_timestamp and symbol', async () => {
    const response = await openTrade({ duration: 120 });
    expect(response.status).toBe(200);
    expect(safeParseOpenTrade(response.body).success).toBe(true);
    // shared's schema drops both fields, so they are checked on the raw body
    const trade = response.body as {
      amount: unknown;
      potential_profit: unknown;
      open_timestamp: number;
      close_timestamp: number;
      symbol: string;
    };
    expect(trade).toMatchObject({ amount: 10, potential_profit: 8.5 });
    expect(trade.close_timestamp).toBe(trade.open_timestamp + 120_000);
    expect(trade.symbol).toBe('EUR/USD');
    expect(safeParseOpenTrade(response.body).data).not.toHaveProperty('close_timestamp');
    expect((await call('/v1/broker/user')).body).toMatchObject({
      demo: { available: 9990, held: 10, total: 10000 },
    });
  });

  it.each([
    ['asset_id', { asset_id: undefined }],
    ['amount', { amount: undefined }],
    ['is_demo', { is_demo: undefined }],
  ])('answers a missing %s as required', async (field, overrides) => {
    expectError(await openTrade(overrides), 400, `Validation failed: "${field}" is required`);
  });

  it.each([
    [{ amount: 10 }, 'amount'],
    [{ amount: '0' }, 'amount'],
    [{ amount: '0.00' }, 'amount'],
    [{ amount: '-1.00' }, 'amount'],
    [{ amount: '1.' }, 'amount'],
    [{ amount: '.5' }, 'amount'],
    [{ amount: null }, 'amount'],
    [{ action: 'sideways' }, 'action'],
    [{ action: 'UP' }, 'action'],
    [{ duration: 0 }, 'duration'],
    [{ asset_id: '101' }, 'asset_id'],
    [{ is_demo: 'true' }, 'is_demo'],
  ])('answers a present but wrong field as invalid (%j)', async (overrides, field) => {
    expectError(await openTrade(overrides), 400, `Validation failed: "${field}" is invalid`);
  });

  it('answers a body that is not an object as a missing asset_id', async () => {
    const response = await call('/v1/broker/user/trades', { method: 'POST', body: [1, 2] });
    expectError(response, 400, 'Validation failed: "asset_id" is required');
    // an array is not a body with keys: the journal records none
    expect(broker.rest.journal.at(-1)?.bodyKeys).toBeUndefined();
  });

  it('passes the store refusals through as 400', async () => {
    expectError(
      await openTrade({ amount: '1.001' }),
      400,
      'Validation failed: "amount" must have at most 2 decimal places',
    );
    expectError(await openTrade({ asset_id: 999 }), 400, 'Unknown asset');
    expectError(await openTrade({ asset_id: 404 }), 400, 'Asset is not available');
    expectError(await openTrade({ duration: 5 }), 400, 'Unsupported duration');
    expectError(await openTrade({ amount: '0.50' }), 400, 'Amount is below the minimum');
    expectError(await openTrade({ amount: '10000.01' }), 400, 'Insufficient balance');
  });

  it.each([
    ['broken JSON', '{"asset_id":', 'application/json'],
    ['an empty JSON body', '', 'application/json'],
    ['a text body', 'asset_id=101', 'text/plain'],
  ])('answers %s with the 400 envelope', async (_name, rawBody, contentType) => {
    const response = await call('/v1/broker/user/trades', { method: 'POST', rawBody, contentType });
    expectError(response, 400, 'Validation failed: body is not valid JSON');
  });
});

describe('a body over the size limit', () => {
  // Only the headers are sent: Fastify refuses on the declared Content-Length before it reads,
  // whereas uploading a real 1 MiB body races the early 413 against a reset socket.
  it('keeps its 413 instead of passing for invalid JSON', async () => {
    const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest(`${broker.url}/v1/broker/user/trades`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': String(1_048_576 + 1),
        },
      });
      request.on('error', reject);
      request.on('response', (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => {
          text += chunk;
        });
        incoming.on('end', () => {
          request.destroy();
          resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(text) as unknown });
        });
      });
      request.flushHeaders();
    });
    expectError(response, 413, 'Request failed');
  });
});

describe('GET /v1/broker/user/trades', () => {
  it('answers { trades } with open and closed trades in the shared shapes, symbol on both', async () => {
    const first = (await openTrade()).body as { id: number };
    await openTrade({ is_demo: false, amount: '1.00' }).then((r) => expect(r.status).toBe(400));
    await openTrade();
    broker.trades.settle(first.id, { outcome: 'win' });

    const response = await call('/v1/broker/user/trades');
    expect(response.status).toBe(200);
    const { trades } = response.body as { trades: Record<string, unknown>[] };
    expect(trades.map((trade) => trade.id)).toEqual([2, 1]);
    const [open, closed] = trades;
    expect(safeParseOpenTrade(open).success).toBe(true);
    expect(safeParseClosedTrade(closed).success).toBe(true);
    expect(open?.symbol).toBe('EUR/USD');
    expect(closed?.symbol).toBe('EUR/USD');
    expect(closed?.profit).toBe(8.5);
  });

  it('filters by status and is_demo and pages with limit and offset', async () => {
    for (let i = 0; i < 3; i += 1) await openTrade();
    broker.trades.settle(1, { outcome: 'loss' });
    const ids = async (query: string) =>
      (
        (await call(`/v1/broker/user/trades?${query}`)).body as { trades: { id: number }[] }
      ).trades.map((trade) => trade.id);
    expect(await ids('status=open')).toEqual([3, 2]);
    expect(await ids('status=closed')).toEqual([1]);
    expect(await ids('is_demo=false')).toEqual([]);
    expect(await ids('is_demo=true&limit=1&offset=1')).toEqual([2]);
  });

  it('answers 20 trades without a limit', async () => {
    broker.users.register({ id: 2, accessToken: 'rich', demo: { available: '1000' } });
    for (let i = 0; i < 21; i += 1) {
      const response = await call('/v1/broker/user/trades', {
        method: 'POST',
        token: 'rich',
        body: tradeBody({ amount: '1' }),
      });
      expect(response.status).toBe(200);
    }
    const response = await call('/v1/broker/user/trades', { token: 'rich' });
    expect((response.body as { trades: unknown[] }).trades).toHaveLength(20);
  });

  it.each([
    ['status=pending', 'Validation failed: "status" must be one of [open, closed]'],
    ['status=open&status=closed', 'Validation failed: "status" must be one of [open, closed]'],
    ['is_demo=1', 'Validation failed: "is_demo" must be one of [true, false]'],
    ['limit=0', 'Validation failed: "limit" must be a positive integer'],
    ['limit=abc', 'Validation failed: "limit" must be a positive integer'],
    ['offset=-1', 'Validation failed: "offset" must be a non-negative integer'],
  ])('refuses %s', async (query, message) => {
    expectError(await call(`/v1/broker/user/trades?${query}`), 400, message);
  });
});

describe('GET /v1/broker/chart', () => {
  const now = Date.now();

  it('answers candles the shared contract parses', async () => {
    const response = await call(
      `/v1/broker/chart?interval=1m&asset_id=${EURUSD}&start_time=${now - 3_600_000}&limit=10`,
    );
    expect(response.status).toBe(200);
    expect(safeParseCandles(response.body).success).toBe(true);
    expect(response.body).toHaveLength(10);
  });

  it('answers 100 candles without a limit', async () => {
    const response = await call(
      `/v1/broker/chart?interval=1m&asset_id=${EURUSD}&start_time=${now - 86_400_000}`,
    );
    expect(response.body).toHaveLength(100);
  });

  it.each([
    [
      'interval=60',
      'Unsupported interval 60; expected "250ms" / "5s" / "1m" / "1h" / "1d" / "1w" / "1M" forms',
    ],
    ['interval=1m&asset_id=abc', 'Unknown asset'],
    [`interval=1m&asset_id=${EURUSD}`, 'Validation failed: "start_time" (ms epoch) is required'],
  ])('refuses %s with the live text', async (query, message) => {
    expectError(await call(`/v1/broker/chart?${query}`), 400, message);
  });

  it.each(['interval=0m', 'interval=500ms', 'start_time=1790000000'])(
    'answers [] for %s',
    async (override) => {
      const query = new URLSearchParams({
        interval: '1m',
        asset_id: String(EURUSD),
        start_time: String(now - 600_000),
      });
      const [key = '', value = ''] = override.split('=');
      query.set(key, value);
      const response = await call(`/v1/broker/chart?${query.toString()}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    },
  );
});

describe('unknown paths', () => {
  it('answers the live 404 shape', async () => {
    const response = await call('/broker/user?x=1');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 404,
      message: `Sorry, the ${new URL(broker.url).host}/broker/user HTTP method GET resource you are looking for was not found.`,
    });
  });

  it('does not answer HEAD on a protected route', async () => {
    const response = await call('/v1/broker/user', { method: 'HEAD', token: null });
    expect(response.status).toBe(404);
  });
});

describe('x-ratelimit headers', () => {
  it('are on every response: 200, 400, 401, 404 and a scripted 429', async () => {
    await broker.close();
    // with a limit of 1 every response reads 0 remaining, whichever window it falls in
    broker = await startMockBroker({ rateLimit: 1 });
    broker.users.register({ id: 1, accessToken: TOKEN });
    broker.rest.failNext('pairs', { status: 429 });
    const before = Math.floor(Date.now() / 1000);
    const responses = [
      await call('/v1/broker/user'),
      await openTrade({ asset_id: 999 }),
      await call('/v1/broker/user', { token: null }),
      await call('/nowhere'),
      await call('/v1/broker/pairs/binary'),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 400, 401, 404, 429]);
    for (const response of responses) {
      expect(response.headers.get('x-ratelimit-limit')).toBe('1');
      expect(response.headers.get('x-ratelimit-remaining')).toBe('0');
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      expect(Number.isInteger(reset)).toBe(true);
      expect(reset).toBeGreaterThan(before);
      expect(reset).toBeLessThanOrEqual(before + 61);
    }
  });
});

describe('failNext', () => {
  it('answers a scripted 429 before auth, with Retry-After only when asked, once', async () => {
    broker.rest.failNext('user', { status: 429, retryAfterSec: 3 });
    broker.rest.failNext('user', { status: 429 });
    const first = await call('/v1/broker/user', { token: null });
    expectError(first, 429, 'Too many requests');
    expect(first.headers.get('retry-after')).toBe('3');
    const second = await call('/v1/broker/user', { token: null });
    expectError(second, 429, 'Too many requests');
    expect(second.headers.get('retry-after')).toBeNull();
    expectError(
      await call('/v1/broker/user', { token: null }),
      401,
      'Authentication failed: Missing bearer token',
    );
  });

  it('plays a queue in order and answers the default texts for 5xx', async () => {
    for (const status of [500, 502, 503, 504, 418]) broker.rest.failNext('pairs', { status });
    const texts: [number, string][] = [
      [500, 'Internal error'],
      [502, 'Service unavailable'],
      [503, 'Service unavailable'],
      [504, 'Service unavailable'],
      [418, 'Request failed'],
    ];
    for (const [status, message] of texts)
      expectError(await call('/v1/broker/pairs/binary'), status, message);
    expect((await call('/v1/broker/pairs/binary')).status).toBe(200);
  });

  it('sends a scripted body and headers as given, a 200 included', async () => {
    broker.rest.failNext('user', {
      status: 200,
      body: { id: 'not a user' },
      headers: { 'x-test': 'yes' },
    });
    const response = await call('/v1/broker/user');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'not a user' });
    expect(response.headers.get('x-test')).toBe('yes');
    expect(safeParseBrokerUser(response.body).success).toBe(false);
  });

  it('keeps a script to its endpoint: POST and GET on /user/trades are separate', async () => {
    broker.rest.failNext('openTrade', { status: 503 });
    expect((await call('/v1/broker/user/trades')).status).toBe(200);
    expect((await openTrade()).status).toBe(503);
    expect((await openTrade()).status).toBe(200);
  });

  it('scripts the public chart without a token', async () => {
    broker.rest.failNext('chart', { status: 502 });
    expectError(await call('/v1/broker/chart', { token: null }), 502, 'Service unavailable');
  });

  it('delays and then handles the request as usual, auth included', async () => {
    broker.rest.failNext('user', { delayMs: 150 });
    const started = Date.now();
    const response = await call('/v1/broker/user', { token: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expectError(response, 401, 'Authentication failed: Missing bearer token');
    // one-shot: the next request is not scripted (proved by the journal, not a time ceiling)
    expect((await call('/v1/broker/user')).status).toBe(200);
    expect(broker.rest.journal.map((record) => record.scripted)).toEqual([true, false]);
  });

  it('survives a client that gave up during the delay', async () => {
    broker.rest.failNext('user', { delayMs: 200 });
    await expect(call('/v1/broker/user', { signal: AbortSignal.timeout(30) })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await call('/v1/broker/user')).status).toBe(200);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Every branch of onRequest x every state of the token: the status, the journal record and the
// rate-limit headers, each read at the moment docs/mock-broker.md -> Journal defines.
describe('observation matrix', () => {
  type Branch = 'plain' | 'answer' | 'delay' | 'hang' | 'delayClose';
  type TokenCase = 'none' | 'known' | 'unknown' | 'revokedDuring' | 'registeredDuring';
  const LATER = 'registered-during-the-wait';
  const presented: Record<TokenCase, string | null> = {
    none: null,
    known: TOKEN,
    unknown: 'never-issued',
    revokedDuring: TOKEN,
    registeredDuring: LATER,
  };
  const scripts: Record<Exclude<Branch, 'plain'>, MockScript> = {
    answer: { status: 429, retryAfterSec: 1 },
    delay: { delayMs: 200 },
    hang: { hang: true },
    delayClose: { delayMs: 3_000 },
  };

  type Expected = { status: number; message?: string } | 'no answer';
  const cells: [Branch, TokenCase, Expected, MockRequestRecord['bearer']][] = [
    [
      'plain',
      'none',
      { status: 401, message: 'Authentication failed: Missing bearer token' },
      'none',
    ],
    ['plain', 'known', { status: 200 }, 'known'],
    [
      'plain',
      'unknown',
      { status: 401, message: 'Authentication failed: Invalid token' },
      'unknown',
    ],
    ['answer', 'none', { status: 429, message: 'Too many requests' }, 'none'],
    ['answer', 'known', { status: 429, message: 'Too many requests' }, 'known'],
    ['answer', 'unknown', { status: 429, message: 'Too many requests' }, 'unknown'],
    [
      'delay',
      'none',
      { status: 401, message: 'Authentication failed: Missing bearer token' },
      'none',
    ],
    ['delay', 'known', { status: 200 }, 'known'],
    [
      'delay',
      'unknown',
      { status: 401, message: 'Authentication failed: Invalid token' },
      'unknown',
    ],
    [
      'delay',
      'revokedDuring',
      { status: 401, message: 'Authentication failed: Invalid token' },
      'unknown',
    ],
    ['delay', 'registeredDuring', { status: 200 }, 'known'],
    ['hang', 'none', { status: 503, message: 'Connection closed by fixture' }, 'none'],
    ['hang', 'known', { status: 503, message: 'Connection closed by fixture' }, 'known'],
    ['hang', 'unknown', { status: 503, message: 'Connection closed by fixture' }, 'unknown'],
    ['hang', 'revokedDuring', { status: 503, message: 'Connection closed by fixture' }, 'unknown'],
    ['hang', 'registeredDuring', { status: 503, message: 'Connection closed by fixture' }, 'known'],
    ['delayClose', 'none', 'no answer', 'none'],
    ['delayClose', 'known', 'no answer', 'known'],
    ['delayClose', 'revokedDuring', 'no answer', 'unknown'],
  ];

  it.each(cells)('%s with token %s', async (branch, tokenCase, expected, bearer) => {
    if (branch !== 'plain') broker.rest.failNext('user', scripts[branch]);
    const settled = call('/v1/broker/user', { token: presented[tokenCase] }).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );

    const waits = branch === 'delay' || branch === 'hang' || branch === 'delayClose';
    if (waits) {
      await until('the request to arrive', () =>
        branch === 'hang' ? broker.rest.pendingHangs === 1 : broker.rest.journal.length === 1,
      );
      expect(broker.rest.journal[0]?.bearer).toBe('pending');
      if (branch === 'hang') expect(broker.rest.pendingHangs).toBe(1);
      if (tokenCase === 'revokedDuring') broker.users.revokeToken(TOKEN);
      if (tokenCase === 'registeredDuring') broker.users.register({ id: 2, accessToken: LATER });
    }
    if (branch === 'hang' || branch === 'delayClose') {
      const started = Date.now();
      await broker.close();
      expect(Date.now() - started).toBeLessThan(UNIT_WAIT_CEILING_MS);
    }
    const outcome = await settled;
    if (branch !== 'hang' && branch !== 'delayClose') await broker.close();

    expect(broker.rest.journal).toHaveLength(1);
    expect(broker.rest.journal[0]).toMatchObject({
      endpoint: 'user',
      scripted: branch !== 'plain',
      bearer,
    });
    expect(broker.rest.journal.filter((record) => record.bearer === 'pending')).toEqual([]);

    if (expected === 'no answer') {
      expect('error' in outcome).toBe(true);
    } else {
      if (!('response' in outcome)) throw outcome.error;
      const { response } = outcome;
      if (expected.message === undefined) expect(response.status).toBe(expected.status);
      else expectError(response, expected.status, expected.message);
      expect(response.headers.get('x-ratelimit-limit')).toBe('600');
      expect(response.headers.get('x-ratelimit-remaining')).toBe('599');
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      expect(reset * 1000).toBeGreaterThan(Date.now() - 1_000);
      expect(reset * 1000).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(response.headers.get('retry-after')).toBe(branch === 'answer' ? '1' : null);
    }
    broker = await startMockBroker();
  });

  it.each([
    ['after', 'known'],
    ['before', 'unknown'],
  ] as const)(
    'observes an aborted hang when it is aborted (token revoked %s the abort)',
    async (when, bearer) => {
      broker.rest.failNext('user', { hang: true });
      const controller = new AbortController();
      const pending = call('/v1/broker/user', { signal: controller.signal });
      await until('the fixture to hold the request', () => broker.rest.pendingHangs === 1);
      if (when === 'before') broker.users.revokeToken(TOKEN);
      controller.abort();
      await expect(pending).rejects.toThrow();
      await until('the hang to end', () => broker.rest.pendingHangs === 0);
      if (when === 'after') broker.users.revokeToken(TOKEN);
      expect(broker.rest.journal[0]).toMatchObject({ scripted: true, bearer });
      // the aborted request took no place in the rate window
      const next = await call('/v1/broker/pairs/binary');
      expect(next.headers.get('x-ratelimit-remaining')).toBe('599');
    },
  );

  it('runs nothing more for a delayed request once close() has cut it', async () => {
    broker.rest.failNext('user', { delayMs: 300 });
    const pending = call('/v1/broker/user').catch(() => undefined);
    await until('the request to arrive', () => broker.rest.journal.length === 1);
    await broker.close();
    expect(broker.rest.journal[0]?.bearer).toBe('known');
    broker.users.revokeToken(TOKEN);
    await sleep(400);
    expect(broker.rest.journal[0]?.bearer).toBe('known');
    await pending;
    broker = await startMockBroker();
  });

  it('journals the bearer of an immediately scripted request to a public endpoint', async () => {
    broker.rest.failNext('pairs', { status: 503 });
    expect((await call('/v1/broker/pairs/binary')).status).toBe(503);
    expect(broker.rest.journal[0]).toMatchObject({
      endpoint: 'pairs',
      scripted: true,
      bearer: 'known',
    });
  });

  it('records bodyKeys only where the body is read: unscripted and after a delay, not for a script', async () => {
    await openTrade();
    broker.rest.failNext('openTrade', { delayMs: 10 });
    await openTrade();
    broker.rest.failNext('openTrade', { status: 503 });
    await openTrade();
    const keys = ['action', 'amount', 'asset_id', 'duration', 'is_demo'];
    expect(broker.rest.journal.map((record) => record.bodyKeys)).toEqual([keys, keys, undefined]);
  });
});

describe('journal', () => {
  it('records each request without the token value or body values', async () => {
    await openTrade();
    await call('/v1/broker/user/trades?status=open&limit=5', { token: 'unknown-token' });
    broker.rest.failNext('chart', { status: 500 });
    await call('/v1/broker/chart?interval=1m', { token: null });

    expect(broker.rest.journal).toEqual([
      {
        method: 'POST',
        path: '/v1/broker/user/trades',
        endpoint: 'openTrade',
        query: {},
        bearer: 'known',
        bodyKeys: ['action', 'amount', 'asset_id', 'duration', 'is_demo'],
        scripted: false,
      },
      {
        method: 'GET',
        path: '/v1/broker/user/trades',
        endpoint: 'tradesList',
        query: { status: 'open', limit: '5' },
        bearer: 'unknown',
        scripted: false,
      },
      {
        method: 'GET',
        path: '/v1/broker/chart',
        endpoint: 'chart',
        query: { interval: '1m' },
        bearer: 'none',
        scripted: true,
      },
    ]);
    const serialized = JSON.stringify(broker.rest.journal);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('unknown-token');
    expect(serialized).not.toContain('10.00');

    broker.rest.clearJournal();
    expect(broker.rest.journal).toEqual([]);
  });
});

describe('failures inside the fixture', () => {
  it('answers 500 with the envelope when a handler throws', async () => {
    vi.spyOn(broker.state, 'getUser').mockImplementation(() => {
      throw new Error('boom');
    });
    expectError(await call('/v1/broker/user'), 500, 'Internal error');
  });
});

describe('an onChange listener that throws', () => {
  it('does not turn a committed trade into a 500, and close() reports the error', async () => {
    const failure = new Error('socket gone');
    broker.state.onChange(() => {
      throw failure;
    });
    const response = await openTrade();
    expect(response.status).toBe(200);
    expect(broker.trades.list(1)).toHaveLength(1);
    expect(broker.state.listenerErrors).toEqual([failure]);

    const closing = broker.close();
    await expect(closing).rejects.toBeInstanceOf(AggregateError);
    await expect(closing).rejects.toMatchObject({ errors: [failure] });
    expect(broker.state.listenerErrors).toEqual([]);
    broker = await startMockBroker();
  });

  it('lets close() resolve once the test cleared the errors', async () => {
    broker.state.onChange(() => {
      throw new Error('expected');
    });
    await openTrade();
    broker.state.clearListenerErrors();
    await expect(broker.close()).resolves.toBeUndefined();
    broker = await startMockBroker();
  });
});

describe('the facade', () => {
  it('lists every trade of a user and settles through the store', async () => {
    for (let i = 0; i < 3; i += 1) await openTrade();
    expect(broker.trades.list(1).map((trade) => trade.id)).toEqual([3, 2, 1]);
    const closed = broker.trades.settle(2, { outcome: 'loss' });
    expect(closed.profit).toBe(-10);
    expect(broker.users.get(1).demo).toEqual({ available: 9970, held: 20, total: 9990 });
    expect(broker.priceAt(EURUSD, 1_790_000_000_000)).toBe(
      broker.state.priceAt(EURUSD, 1_790_000_000_000),
    );
  });

  const endpoints: MockRestEndpoint[] = ['user', 'pairs', 'tradesList', 'openTrade', 'chart'];
  it.each(endpoints)('scripts endpoint %s', async (endpoint) => {
    broker.rest.failNext(endpoint, { status: 503 });
    const paths: Record<MockRestEndpoint, () => Promise<{ status: number }>> = {
      user: () => call('/v1/broker/user'),
      pairs: () => call('/v1/broker/pairs/binary'),
      tradesList: () => call('/v1/broker/user/trades'),
      openTrade: () => openTrade(),
      chart: () => call('/v1/broker/chart'),
    };
    expect((await paths[endpoint]()).status).toBe(503);
  });
});
