import {
  openTradeRequestWireSchema,
  type BinaryPairWire,
  type BrokerUserWire,
} from '@binarius/shared';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { buildCandles, validateChartQuery } from './chart';
import {
  FaultQueue,
  RateWindow,
  scriptedMessage,
  type MockRequestRecord,
  type MockRestEndpoint,
  type MockScript,
} from './faults';
import { brokerError, FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import {
  createBrokerState,
  MockTradeStatus,
  type BrokerState,
  type MockBrokerOptions,
  type MockClosedTradeWire,
  type MockSettleInput,
  type MockTradeFilter,
  type MockTradeWire,
} from './state';

export interface MockBroker {
  // http://127.0.0.1:<port>, without the /v1/broker prefix
  url: string;
  // the store behind the routes, for a Socket.IO layer on the same server (#104)
  state: BrokerState;
  users: {
    register: BrokerState['registerUser'];
    revokeToken(token: string): void;
    get(id: number): BrokerUserWire;
  };
  pairs: {
    list(): BinaryPairWire[];
    update(id: number, patch: { payout?: number; scheduled_until?: number }): void;
  };
  trades: {
    list(userId: number): MockTradeWire[];
    settle(tradeId: number, input: MockSettleInput): MockClosedTradeWire;
  };
  rest: {
    failNext(endpoint: MockRestEndpoint, script: MockScript): void;
    journal: readonly MockRequestRecord[];
    clearJournal(): void;
  };
  priceAt(assetId: number, atMs: number): number;
  close(): Promise<void>;
}

const ROUTES: Record<MockRestEndpoint, { method: 'GET' | 'POST'; url: string; auth: boolean }> = {
  user: { method: 'GET', url: '/v1/broker/user', auth: true },
  pairs: { method: 'GET', url: '/v1/broker/pairs/binary', auth: false },
  tradesList: { method: 'GET', url: '/v1/broker/user/trades', auth: true },
  openTrade: { method: 'POST', url: '/v1/broker/user/trades', auth: true },
  chart: { method: 'GET', url: '/v1/broker/chart', auth: false },
};

// a body that is not JSON: broken, empty, or another content type (Fastify answers that one 415)
const INVALID_BODY_CODES = new Set([
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  'FST_ERR_CTP_INVALID_MEDIA_TYPE',
]);
const DEFAULT_TRADES_LIMIT = 20;
const TRADE_STATUSES = Object.values(MockTradeStatus);
const BOOLEANS = ['true', 'false'];

// the scheme is case-sensitive here; whether the live broker accepts "bearer" is not known.
// Node trims a header value, so "Bearer " with nothing after it arrives as "Bearer" and is missing
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

function flatQuery(query: unknown): Record<string, string> {
  if (query === null || typeof query !== 'object') return {};
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String).join(',') : String(value),
    ]),
  );
}

// a repeated parameter arrives as an array; it is no valid value of anything here
function param(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : '';
}

function parseTradeFilter(
  query: Record<string, unknown>,
): { ok: true; filter: MockTradeFilter } | { ok: false; message: string } {
  const status = param(query, 'status');
  const matchedStatus = TRADE_STATUSES.find((value) => value === status);
  if (status !== undefined && matchedStatus === undefined) {
    return { ok: false, message: FIXTURE_MESSAGES.oneOf('status', TRADE_STATUSES) };
  }
  const isDemo = param(query, 'is_demo');
  if (isDemo !== undefined && !BOOLEANS.includes(isDemo)) {
    return { ok: false, message: FIXTURE_MESSAGES.oneOf('is_demo', BOOLEANS) };
  }
  const limit = param(query, 'limit');
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) {
    return { ok: false, message: FIXTURE_MESSAGES.positiveInteger('limit') };
  }
  const offset = param(query, 'offset');
  if (offset !== undefined && !/^\d+$/.test(offset)) {
    return { ok: false, message: FIXTURE_MESSAGES.nonNegativeInteger('offset') };
  }
  return {
    ok: true,
    filter: {
      ...(matchedStatus === undefined ? {} : { status: matchedStatus }),
      ...(isDemo === undefined ? {} : { isDemo: isDemo === 'true' }),
      limit: limit === undefined ? DEFAULT_TRADES_LIMIT : Number(limit),
      offset: offset === undefined ? 0 : Number(offset),
    },
  };
}

interface RequestContext {
  record: MockRequestRecord;
  userId?: number;
}

export async function startMockBroker(options: MockBrokerOptions = {}): Promise<MockBroker> {
  const state = createBrokerState(options);
  const faults = new FaultQueue();
  const rate = new RateWindow(state.rateLimit);
  const journal: MockRequestRecord[] = [];
  const contexts = new WeakMap<FastifyRequest, RequestContext>();
  const hanging = new Set<{ reply: FastifyReply; release: () => void }>();

  // close() waits for every in-flight request: a hanging one is answered first (below), a delayed
  // one is cut off by forceCloseConnections (both checked against Fastify 5.12.5)
  const app = Fastify({ logger: false, forceCloseConnections: true, exposeHeadRoutes: false });

  // JSON only: a text body is refused like a broken one, not read as an empty object
  app.removeContentTypeParser('text/plain');

  const endpointOf = (request: FastifyRequest): MockRestEndpoint | undefined =>
    (Object.keys(ROUTES) as MockRestEndpoint[]).find(
      (endpoint) =>
        ROUTES[endpoint].method === request.method &&
        ROUTES[endpoint].url === request.routeOptions.url,
    );

  const userIdOf = (request: FastifyRequest): number => {
    const userId = contexts.get(request)?.userId;
    if (userId === undefined) throw new Error('an authenticated route ran without a user');
    return userId;
  };

  function sendScripted(reply: FastifyReply, script: { status: number } & MockScript) {
    reply.code(script.status);
    if ('headers' in script && script.headers !== undefined) reply.headers(script.headers);
    if ('retryAfterSec' in script && script.retryAfterSec !== undefined) {
      reply.header('retry-after', String(script.retryAfterSec));
    }
    const body = 'body' in script ? script.body : undefined;
    if (body !== undefined) return reply.send(body);
    return script.status >= 400
      ? reply.send(brokerError(scriptedMessage(script.status)))
      : reply.send();
  }

  // called at the moment the fixture answers or starts handling, never on arrival: a delayed
  // request must not report a window it arrived in
  function applyRateHeaders(reply: FastifyReply) {
    const window = rate.hit(Date.now());
    reply.header('x-ratelimit-limit', String(window.limit));
    reply.header('x-ratelimit-remaining', String(window.remaining));
    reply.header('x-ratelimit-reset', String(window.reset));
  }

  // runs before the body is parsed: a script and auth both come first, as on the live broker
  app.addHook('onRequest', async (request, reply) => {
    const endpoint = endpointOf(request);
    const script = endpoint === undefined ? undefined : faults.shift(endpoint);
    // pushed on arrival so the journal keeps arrival order; bearer is filled in once auth runs
    const record: MockRequestRecord = {
      method: request.method,
      path: request.url.split('?')[0] ?? request.url,
      ...(endpoint === undefined ? {} : { endpoint }),
      query: flatQuery(request.query),
      bearer: 'none',
      scripted: script !== undefined,
    };
    journal.push(record);
    contexts.set(request, { record });

    if (script !== undefined) {
      if ('hang' in script) {
        await new Promise<void>((release) => hanging.add({ reply, release }));
        return reply;
      }
      if ('delayMs' in script) {
        await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      } else {
        applyRateHeaders(reply);
        return sendScripted(reply, script);
      }
    }

    // From here the request is handled as if it arrived only now: a token revoked or a user
    // registered during a delay counts, which is what a client's race tests rely on (#98).
    applyRateHeaders(reply);
    const token = bearerOf(request.headers.authorization);
    const userId = token === undefined ? undefined : state.authenticate(token);
    record.bearer = token === undefined ? 'none' : userId === undefined ? 'unknown' : 'known';
    contexts.set(request, { record, ...(userId === undefined ? {} : { userId }) });

    if (endpoint !== undefined && ROUTES[endpoint].auth) {
      if (token === undefined) {
        return reply.code(401).send(brokerError(LIVE_MESSAGES.missingBearer));
      }
      if (userId === undefined) {
        return reply.code(401).send(brokerError(LIVE_MESSAGES.invalidToken));
      }
    }
  });

  app.addHook('preHandler', async (request) => {
    const record = contexts.get(request)?.record;
    const body = request.body;
    if (record !== undefined && body !== null && typeof body === 'object' && !Array.isArray(body)) {
      record.bodyKeys = Object.keys(body).sort();
    }
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: 404,
      message: LIVE_MESSAGES.notFound(
        request.host,
        request.url.split('?')[0] ?? request.url,
        request.method,
      ),
    }),
  );

  app.setErrorHandler((error, _request, reply) => {
    const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
    if (typeof code === 'string' && INVALID_BODY_CODES.has(code)) {
      return reply.code(400).send(brokerError(FIXTURE_MESSAGES.invalidJson));
    }
    // any other client error Fastify raises keeps its status (a body over bodyLimit is a 413)
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(brokerError(FIXTURE_MESSAGES.requestFailed));
    }
    return reply.code(500).send(brokerError(FIXTURE_MESSAGES.internal));
  });

  app.get(ROUTES.user.url, async (request) => state.getUser(userIdOf(request)));

  app.get(ROUTES.pairs.url, async () => state.listPairs());

  app.get(ROUTES.tradesList.url, async (request, reply) => {
    const parsed = parseTradeFilter(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send(brokerError(parsed.message));
    return { trades: state.listTrades(userIdOf(request), parsed.filter) };
  });

  app.post(ROUTES.openTrade.url, async (request, reply) => {
    const body = request.body;
    const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const parsed = openTradeRequestWireSchema.safeParse(input);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'asset_id');
      return reply.code(400).send(brokerError(FIXTURE_MESSAGES.required(field)));
    }
    const result = state.openTrade(userIdOf(request), parsed.data);
    if (!result.ok) return reply.code(400).send(brokerError(result.message));
    return result.trade;
  });

  app.get(ROUTES.chart.url, async (request, reply) => {
    const query = validateChartQuery(request.query as Record<string, unknown>, state.findPair);
    if (!query.ok) return reply.code(400).send(brokerError(query.message));
    if (query.empty) return [];
    return buildCandles(query.pair, query.stepMs, query.startTime, query.limit, Date.now());
  });

  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  return {
    url,
    state,
    users: {
      register: (seed) => state.registerUser(seed),
      revokeToken: (token) => state.revokeToken(token),
      get: (id) => state.getUser(id),
    },
    pairs: {
      list: () => state.listPairs(),
      update: (id, patch) => state.updatePair(id, patch),
    },
    trades: {
      list: (userId) => state.listTrades(userId, { limit: Number.POSITIVE_INFINITY, offset: 0 }),
      settle: (tradeId, input) => state.settle(tradeId, input),
    },
    rest: {
      failNext: (endpoint, script) => faults.push(endpoint, script),
      journal,
      clearJournal: () => {
        journal.length = 0;
      },
    },
    priceAt: (assetId, atMs) => state.priceAt(assetId, atMs),
    async close() {
      for (const entry of hanging) {
        applyRateHeaders(entry.reply);
        entry.reply.code(503).send(brokerError(FIXTURE_MESSAGES.closedByFixture));
        entry.release();
      }
      hanging.clear();
      await app.close();
    },
  };
}
