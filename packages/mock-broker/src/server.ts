import {
  openTradeRequestWireSchema,
  type BinaryPairWire,
  type BrokerUserWire,
} from '@binarius/shared';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { buildCandles, validateChartQuery } from './chart';
import { assertSocketPayload, MockSocketPayload } from './encoding';
import {
  RateWindow,
  restFaultQueue,
  scriptedMessage,
  scriptKind,
  type MockAnswerScript,
  type MockRequestRecord,
  type MockRestEndpoint,
  type MockScript,
} from './faults';
import { brokerError, FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import { attachMockSocket, type MockSocket } from './socket';
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
  // http://127.0.0.1:<port>, without the /v1/broker prefix; also the Socket.IO URL
  // (io(url, { transports: ['websocket'] }))
  url: string;
  // the store behind the routes and the socket
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
    // hung requests still waiting for close(); one the client aborted is no longer counted
    readonly pendingHangs: number;
    journal: readonly MockRequestRecord[];
    clearJournal(): void;
  };
  socket: MockSocket;
  priceAt(assetId: number, atMs: number): number;
  // rejects with an AggregateError when an onChange listener threw and the test did not clear it
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

const pathOf = (request: FastifyRequest) => request.url.split('?')[0] ?? request.url;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

interface InFlight {
  request: FastifyRequest;
  reply: FastifyReply;
  record: MockRequestRecord;
}

interface Parked extends InFlight {
  release: () => void;
}

interface Delayed extends InFlight {
  timer: ReturnType<typeof setTimeout>;
  cut: () => void;
}

export async function startMockBroker(options: MockBrokerOptions = {}): Promise<MockBroker> {
  const socketPayload = options.socketPayload ?? MockSocketPayload.Object;
  assertSocketPayload(socketPayload);
  const state = createBrokerState(options);
  const faults = restFaultQueue();
  const rate = new RateWindow(state.rateLimit);
  const journal: MockRequestRecord[] = [];
  const contexts = new WeakMap<FastifyRequest, RequestContext>();
  const hanging = new Set<Parked>();
  const delayed = new Set<Delayed>();

  // close() waits for every in-flight request: it answers each hanging one and cuts each delayed
  // one first (below); forceCloseConnections then drops the sockets those leave open (both
  // checked against Fastify 5.12.5)
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

  function sendScripted(reply: FastifyReply, script: MockAnswerScript) {
    reply.code(script.status);
    if (script.headers !== undefined) reply.headers(script.headers);
    if (script.retryAfterSec !== undefined) {
      reply.header('retry-after', String(script.retryAfterSec));
    }
    if (script.body !== undefined) return reply.send(script.body);
    return script.status >= 400
      ? reply.send(brokerError(scriptedMessage(script.status)))
      : reply.send();
  }

  // The one writer of record.bearer, the request's user and the x-ratelimit-* headers, called
  // exactly once per request at the moment its branch defines (docs/mock-broker.md -> Journal):
  // when the fixture answers or starts handling. A request that leaves without an answer (an
  // aborted hang, a delay cut by close()) is observed with answer: false - no headers, and it
  // takes no place in the rate window.
  function observe({ request, reply, record }: InFlight, { answer }: { answer: boolean }) {
    if (answer) {
      const window = rate.hit(Date.now());
      reply.header('x-ratelimit-limit', String(window.limit));
      reply.header('x-ratelimit-remaining', String(window.remaining));
      reply.header('x-ratelimit-reset', String(window.reset));
    }
    const token = bearerOf(request.headers.authorization);
    const userId = token === undefined ? undefined : state.authenticate(token);
    record.bearer = token === undefined ? 'none' : userId === undefined ? 'unknown' : 'known';
    contexts.set(request, { record, ...(userId === undefined ? {} : { userId }) });
    return { token, userId };
  }

  function arrive(
    request: FastifyRequest,
    endpoint: MockRestEndpoint | undefined,
    scripted: boolean,
  ) {
    // pushed on arrival so the journal keeps arrival order; observe() settles bearer later
    const record: MockRequestRecord = {
      method: request.method,
      path: pathOf(request),
      ...(endpoint === undefined ? {} : { endpoint }),
      query: flatQuery(request.query),
      bearer: 'pending',
      scripted,
    };
    journal.push(record);
    return record;
  }

  // answered by close(); a client that gives up takes its entry with it
  function park(inFlight: InFlight) {
    return new Promise<void>((release) => {
      const entry: Parked = { ...inFlight, release };
      hanging.add(entry);
      inFlight.reply.raw.once('close', () => {
        if (!hanging.delete(entry)) return;
        observe(entry, { answer: false });
        release();
      });
    });
  }

  // 'cut' when close() came first: close() has observed the request, and nothing more runs for it
  function wait(inFlight: InFlight, delayMs: number) {
    return new Promise<'elapsed' | 'cut'>((resolve) => {
      const entry: Delayed = {
        ...inFlight,
        timer: setTimeout(() => {
          delayed.delete(entry);
          resolve('elapsed');
        }, delayMs),
        cut: () => resolve('cut'),
      };
      delayed.add(entry);
    });
  }

  function authorize(
    endpoint: MockRestEndpoint | undefined,
    { token, userId }: { token: string | undefined; userId: number | undefined },
    reply: FastifyReply,
  ) {
    if (endpoint === undefined || !ROUTES[endpoint].auth) return undefined;
    if (token === undefined) return reply.code(401).send(brokerError(LIVE_MESSAGES.missingBearer));
    if (userId === undefined) return reply.code(401).send(brokerError(LIVE_MESSAGES.invalidToken));
    return undefined;
  }

  // runs before the body is parsed: a script and auth both come first, as on the live broker
  app.addHook('onRequest', async (request, reply) => {
    const endpoint = endpointOf(request);
    const script = endpoint === undefined ? undefined : faults.shift(endpoint);
    const inFlight: InFlight = {
      request,
      reply,
      record: arrive(request, endpoint, script !== undefined),
    };
    const played = script === undefined ? undefined : scriptKind(script);
    switch (played?.kind) {
      case 'hang':
        await park(inFlight);
        return reply;
      case 'delay':
        if ((await wait(inFlight, played.delayMs)) === 'cut') return reply;
        break;
      case 'answer':
        observe(inFlight, { answer: true });
        return sendScripted(reply, played.script);
      case undefined:
        break;
    }
    return authorize(endpoint, observe(inFlight, { answer: true }), reply);
  });

  app.addHook('preHandler', async (request) => {
    const record = contexts.get(request)?.record;
    const body = request.body;
    if (record !== undefined && isPlainObject(body)) {
      record.bodyKeys = Object.keys(body).sort();
    }
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: 404,
      message: LIVE_MESSAGES.notFound(request.host, pathOf(request), request.method),
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
    const input: Record<string, unknown> = isPlainObject(body) ? body : {};
    const parsed = openTradeRequestWireSchema.safeParse(input);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'asset_id');
      const message =
        input[field] === undefined
          ? FIXTURE_MESSAGES.required(field)
          : FIXTURE_MESSAGES.invalid(field);
      return reply.code(400).send(brokerError(message));
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

  const socketLayer = attachMockSocket(app.server, state, socketPayload);
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
      get pendingHangs() {
        return hanging.size;
      },
      journal,
      clearJournal: () => {
        journal.length = 0;
      },
    },
    socket: socketLayer.socket,
    priceAt: (assetId, atMs) => state.priceAt(assetId, atMs),
    async close() {
      for (const entry of [...hanging]) {
        hanging.delete(entry);
        observe(entry, { answer: true });
        entry.reply.code(503).send(brokerError(FIXTURE_MESSAGES.closedByFixture));
        entry.release();
      }
      for (const entry of [...delayed]) {
        delayed.delete(entry);
        clearTimeout(entry.timer);
        observe(entry, { answer: false });
        entry.cut();
      }
      // before app.close(), which does not return while a WebSocket client is connected
      socketLayer.close();
      await app.close();
      if (state.listenerErrors.length > 0) {
        const errors = [...state.listenerErrors];
        state.clearListenerErrors();
        throw new AggregateError(errors, `${errors.length} onChange listener error(s)`);
      }
    },
  };
}
