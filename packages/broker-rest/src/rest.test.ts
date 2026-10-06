import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  errorLogFields,
  isClosedTrade,
  isDecimalString,
  logOptions,
  type DecimalString,
  type OpenTradeRequest,
} from '@binarius/shared';
import {
  LIVE_MESSAGES,
  MAX_CHART_LIMIT,
  MockTradeOutcome,
  MockTradeStatus,
  startMockBroker,
  type MockBroker,
  type MockRestEndpoint,
} from '@binarius/mock-broker';
import {
  BROKER_REST_ENDPOINTS,
  BrokerRestError,
  BrokerRestErrorCode,
  createBrokerRestClient,
  MAX_DETAIL_LENGTH,
  MAX_ERROR_BODY_BYTES,
  MAX_SUCCESS_BODY_BYTES,
  TradeListStatus,
  type BrokerRestClient,
} from './rest';

const TOKEN = 'SECRET-ACCESS-TOKEN';
const auth = { accessToken: TOKEN };
const openRequest: OpenTradeRequest = {
  assetId: 101,
  amount: '10.00' as DecimalString,
  action: 'up',
  durationSec: 60,
  isDemo: true,
};
const chartRequest = () => ({
  assetId: 101,
  interval: '1m',
  limit: 3,
  startTime: Date.now() - 10 * 60_000,
});

let broker: MockBroker;
let client: BrokerRestClient;

beforeEach(async () => {
  broker = await startMockBroker();
  broker.users.register({ id: 1, accessToken: TOKEN });
  client = createBrokerRestClient({ baseUrl: broker.url });
});

afterEach(async () => {
  await broker.close();
});

async function caught(promise: Promise<unknown>): Promise<BrokerRestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrokerRestError) return error;
    throw error;
  }
  throw new Error('the call resolved');
}

// one call per endpoint, so the status table below runs against every row
const calls: Record<MockRestEndpoint, (c: BrokerRestClient) => Promise<unknown>> = {
  user: (c) => c.getUser(auth),
  pairs: (c) => c.listPairs(),
  tradesList: (c) => c.listTrades(auth),
  openTrade: (c) => c.openTrade(auth, openRequest),
  chart: (c) => c.getChart(chartRequest()),
};
const endpoints = Object.keys(calls) as MockRestEndpoint[];

describe('the endpoint table', () => {
  it('has the mock broker endpoints as its keys', () => {
    expectTypeOf<keyof typeof BROKER_REST_ENDPOINTS>().toEqualTypeOf<MockRestEndpoint>();
    expect(Object.keys(BROKER_REST_ENDPOINTS).sort()).toEqual([...endpoints].sort());
  });

  it.each(endpoints)('sends %s to its own route with its own bearer rule', async (endpoint) => {
    await calls[endpoint](client);
    expect(broker.rest.journal).toHaveLength(1);
    expect(broker.rest.journal[0]).toMatchObject({
      endpoint,
      method: BROKER_REST_ENDPOINTS[endpoint].method,
      bearer: BROKER_REST_ENDPOINTS[endpoint].bearer ? 'known' : 'none',
    });
  });

  it('spells the trade statuses the way the broker does', () => {
    expect(Object.values(TradeListStatus).sort()).toEqual(Object.values(MockTradeStatus).sort());
  });

  it('types the error code by the code table', () => {
    expectTypeOf<BrokerRestError['code']>().toEqualTypeOf<BrokerRestErrorCode>();
  });
});

describe('happy paths', () => {
  it('reads the user with every money field as a decimal string', async () => {
    const user = await client.getUser(auth);
    expect(user.id).toBe('1');
    const money = [user.minTradeAmount, ...Object.values(user.real), ...Object.values(user.demo)];
    expect(money).toHaveLength(7);
    expect(money.every(isDecimalString)).toBe(true);
    expect(user.demo.available).toBe('10000');
  });

  it('lists the pairs mapped from the broker list', async () => {
    const pairs = await client.listPairs();
    expect(pairs.map((pair) => pair.id)).toEqual(broker.pairs.list().map((pair) => pair.id));
    expect(pairs[0]).toMatchObject({ minTimeframe: 60, maxPayout: 90 });
  });

  it('opens a trade with the request body the broker validates', async () => {
    const trade = await client.openTrade(auth, openRequest);
    expect(trade).toMatchObject({ assetId: 101, action: 'up', amount: '10', isDemo: true });
    expect(isDecimalString(trade.potentialProfit)).toBe(true);
    expect(broker.rest.journal[0]?.bodyKeys).toEqual([
      'action',
      'amount',
      'asset_id',
      'duration',
      'is_demo',
    ]);
  });

  it('lists an open and a settled trade, newest first', async () => {
    expect(await client.listTrades(auth)).toEqual([]);
    const first = await client.openTrade(auth, openRequest);
    await client.openTrade(auth, openRequest);
    broker.trades.settle(Number(first.id), { outcome: MockTradeOutcome.Win });
    const [newest, oldest] = await client.listTrades(auth);
    expect(newest && isClosedTrade(newest)).toBe(false);
    expect(oldest && isClosedTrade(oldest)).toBe(true);
    expect(oldest?.id).toBe(first.id);
  });

  it('sends only the filters it was given, and false as false', async () => {
    await client.openTrade(auth, openRequest);
    await client.listTrades(auth, {});
    const closed = await client.listTrades(auth, {
      status: TradeListStatus.Closed,
      isDemo: false,
      limit: 5,
      offset: 0,
    });
    expect(closed).toEqual([]);
    expect(broker.rest.journal[1]?.query).toEqual({});
    expect(broker.rest.journal[2]?.query).toEqual({
      status: 'closed',
      is_demo: 'false',
      limit: '5',
      offset: '0',
    });
  });

  it('reads candles with all four chart parameters on the query', async () => {
    const request = chartRequest();
    const candles = await client.getChart(request);
    expect(candles).toHaveLength(3);
    expect(Object.keys(candles[0] ?? {}).sort()).toEqual([
      'close',
      'high',
      'low',
      'open',
      'timestamp',
    ]);
    expect(broker.rest.journal[0]?.query).toEqual({
      asset_id: '101',
      interval: '1m',
      limit: '3',
      start_time: String(request.startTime),
    });
  });

  it('passes the empty answer to a start_time in seconds through', async () => {
    const candles = await client.getChart({
      ...chartRequest(),
      startTime: Math.floor(Date.now() / 1000),
    });
    expect(candles).toEqual([]);
  });
});

describe('status classification', () => {
  const statusCases: [number, BrokerRestErrorCode][] = [
    [401, BrokerRestErrorCode.Unauthorized],
    [429, BrokerRestErrorCode.RateLimited],
    [400, BrokerRestErrorCode.Rejected],
    [404, BrokerRestErrorCode.Rejected],
    [418, BrokerRestErrorCode.Rejected],
    [500, BrokerRestErrorCode.Unavailable],
    [502, BrokerRestErrorCode.Unavailable],
    [503, BrokerRestErrorCode.Unavailable],
  ];
  const matrix = endpoints.flatMap((endpoint) =>
    statusCases.map(([status, code]) => [endpoint, status, code] as const),
  );

  it.each(matrix)('%s answering %i is %s', async (endpoint, status, code) => {
    broker.rest.failNext(endpoint, { status });
    const error = await caught(calls[endpoint](client));
    expect(error).toBeInstanceOf(BrokerRestError);
    expect(error.name).toBe('BrokerRestError');
    expect(error.message).toBe(code);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(broker.rest.journal).toHaveLength(1);
  });

  it.each(endpoints)('%s answering a redirect is a contract violation', async (endpoint) => {
    broker.rest.failNext(endpoint, {
      status: 302,
      headers: { location: 'http://127.0.0.1:1/elsewhere' },
    });
    const error = await caught(calls[endpoint](client));
    expect(error).toMatchObject({ code: BrokerRestErrorCode.ContractViolation, status: 302 });
    expect(broker.rest.journal).toHaveLength(1);
  });

  it.each(endpoints)(
    '%s answering 200 off the contract is a contract violation',
    async (endpoint) => {
      broker.rest.failNext(endpoint, { status: 200, body: { unexpected: true } });
      const error = await caught(calls[endpoint](client));
      expect(error).toMatchObject({ code: BrokerRestErrorCode.ContractViolation, status: 200 });
    },
  );

  it('reads a 200 that is not JSON as a contract violation', async () => {
    broker.rest.failNext('user', {
      status: 200,
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    const error = await caught(client.getUser(auth));
    expect(error).toMatchObject({ code: BrokerRestErrorCode.ContractViolation, status: 200 });
  });

  it('reads an empty 200 as a contract violation', async () => {
    broker.rest.failNext('pairs', { status: 200 });
    const error = await caught(client.listPairs());
    expect(error.code).toBe(BrokerRestErrorCode.ContractViolation);
  });

  it('refuses an unknown token as unauthorized', async () => {
    const error = await caught(client.getUser({ accessToken: 'SECRET-UNKNOWN' }));
    expect(error).toMatchObject({
      code: BrokerRestErrorCode.Unauthorized,
      status: 401,
      detail: LIVE_MESSAGES.invalidToken,
    });
  });

  it('takes an integer Retry-After and leaves it out when absent', async () => {
    broker.rest.failNext('user', { status: 429, retryAfterSec: 2 });
    expect((await caught(client.getUser(auth))).retryAfterSec).toBe(2);
    broker.rest.failNext('user', { status: 429 });
    const error = await caught(client.getUser(auth));
    expect(error.code).toBe(BrokerRestErrorCode.RateLimited);
    expect(error).not.toHaveProperty('retryAfterSec');
  });

  it('ignores an HTTP-date Retry-After', async () => {
    broker.rest.failNext('user', {
      status: 429,
      headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    });
    expect(await caught(client.getUser(auth))).not.toHaveProperty('retryAfterSec');
  });

  it('refuses a business rule as rejected with the broker text', async () => {
    const error = await caught(
      client.openTrade(auth, { ...openRequest, amount: '20000.00' as DecimalString }),
    );
    expect(error).toMatchObject({
      code: BrokerRestErrorCode.Rejected,
      status: 400,
      detail: 'Insufficient balance',
    });
  });

  it('rejects an interval the live broker does not take, with its text', async () => {
    const error = await caught(client.getChart({ ...chartRequest(), interval: '60' }));
    expect(error).toMatchObject({
      code: BrokerRestErrorCode.Rejected,
      status: 400,
      detail: LIVE_MESSAGES.unsupportedInterval('60'),
    });
  });
});

describe('detail', () => {
  it('is the envelope message, cut to MAX_DETAIL_LENGTH', async () => {
    broker.rest.failNext('user', { status: 400, body: { error: { message: 'x'.repeat(1000) } } });
    const error = await caught(client.getUser(auth));
    expect(error.detail).toBe('x'.repeat(MAX_DETAIL_LENGTH));
  });

  it('never carries the envelope details', async () => {
    broker.rest.failNext('openTrade', {
      status: 400,
      body: { error: { message: 'bad amount', details: { amount: 'SECRET-ECHO' } } },
    });
    const error = await caught(client.openTrade(auth, openRequest));
    expect(error.detail).toBe('bad amount');
    expect(JSON.stringify(error)).not.toContain('SECRET-ECHO');
  });

  it('is absent for a body that is not a JSON envelope', async () => {
    // a parseable envelope under another content type: only the content-type check keeps it out
    broker.rest.failNext('user', {
      status: 400,
      body: JSON.stringify({ error: { message: 'plain refusal' } }),
      headers: { 'content-type': 'text/plain' },
    });
    const plain = await caught(client.getUser(auth));
    expect(plain.code).toBe(BrokerRestErrorCode.Rejected);
    expect(plain).not.toHaveProperty('detail');

    broker.rest.failNext('user', { status: 500, body: { message: 'not an envelope' } });
    expect(await caught(client.getUser(auth))).not.toHaveProperty('detail');
  });

  it('is absent for an envelope longer than MAX_ERROR_BODY_BYTES', async () => {
    broker.rest.failNext('user', {
      status: 400,
      body: { error: { message: 'y'.repeat(MAX_ERROR_BODY_BYTES) } },
    });
    const error = await caught(client.getUser(auth));
    expect(error.code).toBe(BrokerRestErrorCode.Rejected);
    expect(error).not.toHaveProperty('detail');
  });

  it('is never taken from a 2xx body', async () => {
    broker.rest.failNext('user', { status: 200, body: { error: { message: 'from a 200' } } });
    expect(await caught(client.getUser(auth))).not.toHaveProperty('detail');
  });
});

describe('transport', () => {
  it('gives up after its own timeout as unavailable', async () => {
    const quick = createBrokerRestClient({ baseUrl: broker.url, timeoutMs: 50 });
    broker.rest.failNext('pairs', { delayMs: 2000 });
    const started = Date.now();
    const error = await caught(quick.listPairs());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error.code).toBe(BrokerRestErrorCode.Unavailable);
    expect(error).not.toHaveProperty('status');
    expect(broker.rest.journal).toHaveLength(1);
  });

  it('stops at the caller abort as aborted and releases the request', async () => {
    broker.rest.failNext('user', { hang: true });
    const controller = new AbortController();
    const pending = caught(client.getUser(auth, { signal: controller.signal }));
    await vi.waitFor(() => expect(broker.rest.pendingHangs).toBe(1));
    controller.abort();
    expect((await pending).code).toBe(BrokerRestErrorCode.Aborted);
    await vi.waitFor(() => expect(broker.rest.pendingHangs).toBe(0));
  });

  it('reads its own timeout as unavailable while a caller signal is still pending', async () => {
    const quick = createBrokerRestClient({ baseUrl: broker.url, timeoutMs: 50 });
    broker.rest.failNext('user', { hang: true });
    const controller = new AbortController();
    const error = await caught(quick.getUser(auth, { signal: controller.signal }));
    expect(controller.signal.aborted).toBe(false);
    expect(error.code).toBe(BrokerRestErrorCode.Unavailable);
  });

  it('sends nothing for a signal that is already aborted', async () => {
    const error = await caught(client.listPairs({ signal: AbortSignal.abort() }));
    expect(error.code).toBe(BrokerRestErrorCode.Aborted);
    expect(broker.rest.journal).toHaveLength(0);
  });

  it('reads an unreachable host as unavailable', async () => {
    const closed = await startMockBroker();
    await closed.close();
    const error = await caught(createBrokerRestClient({ baseUrl: closed.url }).listPairs());
    expect(error.code).toBe(BrokerRestErrorCode.Unavailable);
  });

  describe('a 2xx body cut mid-flight', () => {
    let server: Server;
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('is unavailable, not a contract violation', async () => {
      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        response.write('[{"id":1');
        setTimeout(() => response.socket?.destroy(), 20);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const cut = createBrokerRestClient({ baseUrl: `http://127.0.0.1:${port}` });
      const error = await caught(cut.listPairs());
      expect(error).toMatchObject({ code: BrokerRestErrorCode.Unavailable, status: 200 });
    });
  });
});

describe('body size', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server === undefined) return;
    const closing = server;
    server = undefined;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('refuses a 2xx body over MAX_SUCCESS_BODY_BYTES as a contract violation', async () => {
    // valid JSON of valid pairs, padded with whitespace: only the size can refuse it
    const pairs = JSON.stringify(broker.pairs.list());
    const padding = ' '.repeat(64 * 1024);
    const baseUrl = await serve((_request, response) => {
      response.on('error', () => undefined);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(pairs);
      let written = Buffer.byteLength(pairs);
      while (written <= MAX_SUCCESS_BODY_BYTES) {
        response.write(padding);
        written += padding.length;
      }
      response.end();
    });
    const error = await caught(createBrokerRestClient({ baseUrl }).listPairs());
    expect(error).toMatchObject({ code: BrokerRestErrorCode.ContractViolation, status: 200 });
  });

  it('stops reading an error body at MAX_ERROR_BODY_BYTES, even one without an end', async () => {
    const chunk = 'x'.repeat(4096);
    const baseUrl = await serve((_request, response) => {
      response.on('error', () => undefined);
      response.writeHead(429, { 'content-type': 'application/json' });
      response.write('{"error":{"message":"');
      const pump = () => {
        while (!response.destroyed && response.write(chunk));
        if (!response.destroyed) response.once('drain', pump);
      };
      pump();
    });
    const patient = createBrokerRestClient({ baseUrl, timeoutMs: 60_000 });
    const error = await caught(patient.listPairs());
    expect(error.code).toBe(BrokerRestErrorCode.RateLimited);
    expect(error).not.toHaveProperty('detail');
  }, 2_000);

  it('leaves the longest chart far below MAX_SUCCESS_BODY_BYTES', () => {
    const row = [9999999999999, 99999.99999, 99999.99999, 99999.99999, 99999.99999, 999999999.99];
    const body = JSON.stringify(Array.from({ length: MAX_CHART_LIMIT }, () => row));
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_SUCCESS_BODY_BYTES / 4);
  });
});

describe('secrecy', () => {
  async function oneOfEach(): Promise<BrokerRestError[]> {
    const errors: BrokerRestError[] = [];
    errors.push(await caught(client.getUser({ accessToken: 'SECRET-UNKNOWN' })));
    broker.rest.failNext('user', { status: 429, retryAfterSec: 1 });
    errors.push(await caught(client.getUser(auth)));
    errors.push(await caught(client.getChart({ ...chartRequest(), interval: '60' })));
    broker.rest.failNext('openTrade', { status: 503 });
    errors.push(await caught(client.openTrade(auth, openRequest)));
    broker.rest.failNext('tradesList', { status: 302, headers: { location: broker.url } });
    errors.push(await caught(client.listTrades(auth)));
    errors.push(await caught(client.getUser(auth, { signal: AbortSignal.abort() })));
    return errors;
  }

  it('carries no token and no URL on any error', async () => {
    const errors = await oneOfEach();
    expect(new Set(errors.map((error) => error.code))).toEqual(
      new Set(Object.values(BrokerRestErrorCode)),
    );
    for (const error of errors) {
      const own = Object.getOwnPropertyNames(error).map((key) =>
        String((error as unknown as Record<string, unknown>)[key]),
      );
      const text = [JSON.stringify(error), error.message, error.stack ?? '', ...own].join('\n');
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain(broker.url);
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('logs as name, code and the named fields only', async () => {
    const errors = await oneOfEach();
    const lines: string[] = [];
    const logger = pino(logOptions('info'), { write: (line: string) => void lines.push(line) });
    for (const error of errors) {
      logger.warn(
        {
          ...errorLogFields(error),
          status: error.status,
          retryAfterSec: error.retryAfterSec,
          detail: error.detail,
        },
        'broker rest call failed',
      );
    }
    expect(lines).toHaveLength(errors.length);
    lines.forEach((line, index) => {
      expect(line).not.toContain('SECRET');
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record.err).toEqual({ name: 'BrokerRestError', code: errors[index]?.code });
      expect(record).not.toHaveProperty('cause');
      expect(record.msg).toBe('broker rest call failed');
    });
    const rateLimited = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
    expect(rateLimited).toMatchObject({ status: 429, retryAfterSec: 1 });
    const rejected = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>;
    expect(rejected.detail).toBe(LIVE_MESSAGES.unsupportedInterval('60'));
  });
});
