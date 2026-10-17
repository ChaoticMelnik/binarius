import {
  LIVE_MESSAGES,
  MockSocketOutcome,
  MockSocketPayload,
  OBSERVED_EXTRA_EVENTS,
  startMockBroker,
  type MockBroker,
  type MockSocketRecord,
} from '@binarius/mock-broker';
import {
  BrokerSocketEvent,
  decimalStringSchema,
  logOptions,
  MAX_PRICE_SUBSCRIPTION_ASSETS,
  TradeAction,
  TradeMode,
  type SocketOpenTradeRequest,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import pino from 'pino';
import { io } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerEventProblemKind, BrokerEventType, type BrokerEvent } from './events';
import {
  BrokerSocketState,
  createBrokerSocketClient,
  IGNORED_BROKER_EVENTS,
  type BrokerSocket,
  type BrokerSocketClient,
  type BrokerSocketClientOptions,
  type BrokerSocketOptions,
  type BrokerSocketStateChange,
  type SocketOpenTradeResult,
} from './socket';

const TOKEN = 'SECRET-TOKEN-of-user-1';
const OTHER_TOKEN = 'SECRET-TOKEN-of-user-2';
const CREDENTIALS = { brokerUserId: '1', accessToken: TOKEN };
const EURUSD = 101;
const AAPL = 202;
const BTCUSD = 303;

// every wait shortened; the chain of socket-config.ts holds for it
const TIMING = {
  connectTimeoutMs: 1_000,
  authTimeoutMs: 200,
  reconnectDelayMs: 20,
  reconnectDelayMaxMs: 40,
  jitter: 0,
};
// a negative wait: longer than the longest reconnection delay, so a reconnection that was going
// to happen has happened
const QUIET_MS = 100;

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

type LogEntry = Record<string, unknown> & { level: number; msg: string };

const LEVEL = { debug: 20, info: 30, warn: 40 } as const;

interface Harness {
  client: BrokerSocketClient;
  events: BrokerEvent[];
  states: BrokerSocketStateChange[];
  lines: string[];
  logs(msg: string): LogEntry[];
}

interface Emit {
  event: string;
  args: unknown[];
}

// the openSocket seam wrapping io(): every emit the client makes, per socket, in order
function recordEmits() {
  const sockets: Emit[][] = [];
  const openSocket = (url: string, options: BrokerSocketOptions): BrokerSocket => {
    const socket: BrokerSocket = io(url, options);
    const sent: Emit[] = [];
    sockets.push(sent);
    const emit = socket.emit.bind(socket) as (event: string, ...args: unknown[]) => BrokerSocket;
    vi.spyOn(socket, 'emit').mockImplementation(((event: string, ...args: unknown[]) => {
      sent.push({ event, args });
      return emit(event, ...args);
    }) as BrokerSocket['emit']);
    return socket;
  };
  return { sockets, openSocket };
}

let broker: MockBroker;
const clients: BrokerSocketClient[] = [];
const extraBrokers: MockBroker[] = [];

// `before` registers its listeners ahead of the harness's recorders
function harness(
  overrides: Partial<BrokerSocketClientOptions> = {},
  before?: (client: BrokerSocketClient) => void,
): Harness {
  const lines: string[] = [];
  // the worker's own options at the most verbose level, so every line the client can write is
  // read
  const logger = pino(logOptions('debug'), { write: (line: string) => void lines.push(line) });
  const client = createBrokerSocketClient({
    url: broker.url,
    logger,
    timing: TIMING,
    ...overrides,
  });
  clients.push(client);
  before?.(client);
  const events: BrokerEvent[] = [];
  const states: BrokerSocketStateChange[] = [];
  client.onEvent((event) => events.push(event));
  client.onState((change) => states.push(change));
  return {
    client,
    events,
    states,
    lines,
    logs: (msg) =>
      lines.map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry.msg === msg),
  };
}

const ready = (h: Harness, connections = 1) =>
  until(
    `ready after ${connections} auth(s)`,
    () => h.client.state === BrokerSocketState.Ready && h.client.connections === connections,
  );

// the journal grouped by socket, in connection order
function bySocket(target: MockBroker = broker): MockSocketRecord[][] {
  const groups = new Map<string, MockSocketRecord[]>();
  for (const record of target.socket.journal) {
    const group = groups.get(record.socketId) ?? [];
    group.push(record);
    groups.set(record.socketId, group);
  }
  return [...groups.values()];
}

const shape = (records: MockSocketRecord[]) =>
  records.map(({ event, argc, outcome }) => ({ event, argc, outcome }));

const AUTH = { event: BrokerSocketEvent.UserAuth, argc: 1, outcome: MockSocketOutcome.Handled };
const SUBSCRIBE = {
  event: BrokerSocketEvent.PriceSubscribe,
  argc: 1,
  outcome: MockSocketOutcome.Handled,
};

const subscribeRecords = () =>
  broker.socket.journal.filter((record) => record.event === BrokerSocketEvent.PriceSubscribe)
    .length;

const typesOf = (events: BrokerEvent[]) => events.map((event) => event.type);

// an amount no other value of the fixture spells, so a log line carrying it is found
const AMOUNT = decimalStringSchema.parse('13.37');
const REQUEST: SocketOpenTradeRequest = {
  assetId: EURUSD,
  amount: AMOUNT,
  action: TradeAction.Up,
  durationSec: 60,
};
const DEMO_OPEN_TRADE = 'user.demo.open_trade';

const openTradeRecords = () =>
  broker.socket.journal.filter((record) => record.event.endsWith('.open_trade'));

// a user.demo.open_trade.success payload; the default carries REQUEST's terms
const successWire = (overrides: Record<string, unknown>) => ({
  id: 9001,
  asset_id: EURUSD,
  action: TradeAction.Up,
  amount: AMOUNT,
  payout: 85,
  open_price: 1.1,
  open_timestamp: 1_790_028_496_624,
  is_demo: true,
  potential_profit: '11.36',
  ...overrides,
});

// the command's promise with a flag that says whether it has answered yet
function track(promise: Promise<SocketOpenTradeResult>) {
  const tracked = { settled: false, promise };
  void promise.then(() => {
    tracked.settled = true;
  });
  return tracked;
}

beforeEach(async () => {
  broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
  broker.users.register({ id: 1, accessToken: TOKEN });
  broker.users.register({ id: 2, accessToken: OTHER_TOKEN });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.stop();
  for (const extra of extraBrokers.splice(0)) await extra.close();
  await broker.close();
});

it('ignores exactly the extra events the live broker was seen sending', () => {
  expect(IGNORED_BROKER_EVENTS).toEqual(new Set(Object.values(OBSERVED_EXTRA_EVENTS)));
});

describe('handshake', () => {
  it.each(Object.values(MockSocketPayload))(
    'authenticates, sends the registry once and delivers the burst (%s payloads)',
    async (form) => {
      extraBrokers.push(broker);
      broker = await startMockBroker({ socketPayload: form });
      broker.users.register({ id: 1, accessToken: TOKEN });
      const h = harness();
      h.client.subscribe([AAPL, EURUSD]);
      h.client.start(CREDENTIALS);
      expect(h.client.state).toBe(BrokerSocketState.Connecting);
      await ready(h);

      await until(
        'subscriptions on the socket',
        () => broker.socket.sockets()[0]?.subscriptions.length === 2,
      );
      expect(bySocket().map(shape)).toEqual([[AUTH, SUBSCRIBE]]);
      expect(broker.socket.sockets()[0]?.subscriptions).toEqual(h.client.subscriptions());
      expect(h.states.map(({ to }) => to)).toEqual([
        BrokerSocketState.Connecting,
        BrokerSocketState.Authenticating,
        BrokerSocketState.Ready,
      ]);
      await until('the burst', () => typesOf(h.events).includes(BrokerEventType.AssetsList));
      expect(typesOf(h.events)).toEqual([
        BrokerEventType.AuthSuccess,
        BrokerEventType.UserData,
        BrokerEventType.AssetsList,
      ]);

      expect(broker.socket.pushPrice(EURUSD, 1_790_000_000_000)).toBe(1);
      await until('a price', () => typesOf(h.events).includes(BrokerEventType.PriceUpdate));
      expect(h.events.at(-1)).toEqual({
        type: BrokerEventType.PriceUpdate,
        update: {
          assetId: EURUSD,
          price: broker.priceAt(EURUSD, 1_790_000_000_000),
          timestamp: 1_790_000_000_000,
        },
      });
      expect(h.logs('broker event problem')).toEqual([]);
      expect(h.logs('broker event with extra arguments')).toEqual([]);
    },
  );

  it('sends a pass above the contract maximum in chunks of at most 40', async () => {
    const ids = range(1, 2 * MAX_PRICE_SUBSCRIPTION_ASSETS + 5);
    const h = harness();
    h.client.subscribe(ids);
    h.client.start(CREDENTIALS);
    await ready(h);
    await until(
      'every id on the socket',
      () => broker.socket.sockets()[0]?.subscriptions.length === ids.length,
    );
    expect(bySocket().map(shape)).toEqual([[AUTH, SUBSCRIBE, SUBSCRIBE, SUBSCRIBE]]);
    expect(broker.socket.sockets()[0]?.subscriptions).toEqual(ids);
  });

  it('sends only the new ids of a subscribe while ready, and nothing for a repeat', async () => {
    const h = harness();
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await ready(h);
    h.client.subscribe([EURUSD]);
    h.client.subscribe([EURUSD, BTCUSD]);
    h.client.subscribe([]);
    await until(
      'BTCUSD on the socket',
      () => broker.socket.sockets()[0]?.subscriptions.length === 2,
    );
    expect(bySocket().map(shape)).toEqual([[AUTH, SUBSCRIBE, SUBSCRIBE]]);
    expect(h.client.subscriptions()).toEqual([EURUSD, BTCUSD]);
  });

  it('holds a subscribe made while authenticating for the next pass; a hung auth reconnects', async () => {
    broker.socket.failNext('auth', { silent: true });
    const recorded = recordEmits();
    const h = harness({ openSocket: recorded.openSocket });
    h.client.start(CREDENTIALS);
    await until('authenticating', () => h.client.state === BrokerSocketState.Authenticating);
    h.client.subscribe([EURUSD]);

    await ready(h);
    await until(
      'the pass on the socket',
      () => broker.socket.sockets()[0]?.subscriptions.length === 1,
    );
    expect(recorded.sockets.map((sent) => sent.map(({ event }) => event))).toEqual([
      [BrokerSocketEvent.UserAuth, BrokerSocketEvent.UserAuth, BrokerSocketEvent.PriceSubscribe],
    ]);
    const [hung, live] = bySocket();
    expect(shape(hung ?? [])).toEqual([
      { event: BrokerSocketEvent.UserAuth, argc: 1, outcome: MockSocketOutcome.Scripted },
    ]);
    expect(shape(live ?? [])).toEqual([AUTH, SUBSCRIBE]);
    expect(h.states.map(({ to, reason }) => ({ to, reason }))).toEqual([
      { to: BrokerSocketState.Connecting, reason: undefined },
      { to: BrokerSocketState.Authenticating, reason: undefined },
      { to: BrokerSocketState.Reconnecting, reason: 'forced close' },
      { to: BrokerSocketState.Authenticating, reason: undefined },
      { to: BrokerSocketState.Ready, reason: undefined },
    ]);
    expect(h.logs('broker socket auth timeout')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, connection: 1 }),
    ]);
    expect(h.logs('broker socket disconnected')).toEqual([
      expect.objectContaining({ reason: 'forced close', connection: 1, authTimeouts: 1 }),
    ]);
    expect(h.logs('broker socket ready')).toEqual([
      expect.objectContaining({ level: LEVEL.info, connection: 2, attempt: 1, subscriptions: 1 }),
    ]);
  });

  it('sends a subscribe made by a ready listener once, after the pass', async () => {
    const recorded = recordEmits();
    const h = harness({ openSocket: recorded.openSocket });
    h.client.subscribe([EURUSD]);
    h.client.onState(({ to }) => {
      if (to === BrokerSocketState.Ready) h.client.subscribe([BTCUSD]);
    });
    h.client.start(CREDENTIALS);
    await ready(h);
    await until(
      'both ids on the socket',
      () => broker.socket.sockets()[0]?.subscriptions.length === 2,
    );
    const subscribes = (recorded.sockets[0] ?? []).filter(
      ({ event }) => event === BrokerSocketEvent.PriceSubscribe,
    );
    expect(subscribes.map(({ args }) => args)).toEqual([
      [{ assets: [EURUSD] }],
      [{ assets: [BTCUSD] }],
    ]);
    expect(broker.socket.sockets()[0]?.subscriptions).toEqual(h.client.subscriptions());
  });

  it('clears the auth timer once authenticated', async () => {
    const armed: unknown[] = [];
    const setTimer = globalThis.setTimeout;
    // the client's only timer with this delay; socket.io's own use other delays
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      const handle = setTimer(handler, delay);
      if (delay === TIMING.authTimeoutMs) armed.push(handle);
      return handle;
    }) as typeof setTimeout);
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    expect(armed).toHaveLength(1);
    expect(cleared).toHaveBeenCalledWith(armed[0]);
  });

  it('ignores a second user.auth.success on one connection', async () => {
    const h = harness();
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await ready(h);
    await until('the pass', () => subscribeRecords() === 1);
    expect(broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.UserAuthSuccess, null)).toBe(1);
    await until(
      'the second auth_success',
      () => typesOf(h.events).filter((type) => type === BrokerEventType.AuthSuccess).length === 2,
    );
    expect(h.client.connections).toBe(1);
    expect(bySocket().map(shape)).toEqual([[AUTH, SUBSCRIBE]]);
  });
});

describe('reconnection', () => {
  it('flushes nothing from a dead connection into the next one before user.auth', async () => {
    const opened: BrokerSocket[] = [];
    const h = harness({
      openSocket: (url, options) => {
        const socket: BrokerSocket = io(url, options);
        opened.push(socket);
        return socket;
      },
    });
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await ready(h);
    await until('the first pass', () => subscribeRecords() === 1);
    // the ping deadline has passed and engine.io has not closed yet: socket.io buffers the emit
    // instead of sending it, and engine.io schedules the `ping timeout` close
    const engine = opened[0]?.io.engine as unknown as { _pingTimeoutTime: number };
    engine._pingTimeoutTime = 1;
    h.client.subscribe([BTCUSD]);
    await ready(h, 2);
    await until('the second pass', () => broker.socket.sockets()[0]?.subscriptions.length === 2);

    expect(h.states.find(({ to }) => to === BrokerSocketState.Reconnecting)?.reason).toBe(
      'ping timeout',
    );
    expect(bySocket().map(shape)).toEqual([
      [AUTH, SUBSCRIBE],
      [AUTH, SUBSCRIBE],
    ]);
    expect(broker.socket.sockets()[0]?.subscriptions).toEqual(h.client.subscriptions());
  });

  it('re-authenticates and resends every subscription exactly once after a transport drop', async () => {
    const ids = range(1, MAX_PRICE_SUBSCRIPTION_ASSETS + 5);
    const h = harness();
    h.client.subscribe(ids);
    h.client.start(CREDENTIALS);
    await ready(h);
    await until(
      'the first pass',
      () => broker.socket.sockets()[0]?.subscriptions.length === ids.length,
    );

    expect(broker.socket.cutTransport({ userId: 1 })).toBe(1);
    await until('reconnecting', () => h.client.state === BrokerSocketState.Reconnecting);
    // made while disconnected: socket.io would buffer an emit and flush it ahead of user.auth
    h.client.subscribe([5_000]);
    await ready(h, 2);
    await until(
      'the second pass',
      () => broker.socket.sockets()[0]?.subscriptions.length === ids.length + 1,
    );

    expect(bySocket().map(shape)).toEqual([
      [AUTH, SUBSCRIBE, SUBSCRIBE],
      [AUTH, SUBSCRIBE, SUBSCRIBE],
    ]);
    expect(broker.socket.sockets()).toHaveLength(1);
    expect(broker.socket.sockets()[0]?.subscriptions).toEqual(h.client.subscriptions());
    expect(h.states.map(({ to, reason }) => ({ to, reason })).slice(3)).toEqual([
      { to: BrokerSocketState.Reconnecting, reason: 'transport close' },
      { to: BrokerSocketState.Authenticating, reason: undefined },
      { to: BrokerSocketState.Ready, reason: undefined },
    ]);
    expect(
      h.logs('broker socket ready').map(({ connection, attempt }) => ({ connection, attempt })),
    ).toEqual([
      { connection: 1, attempt: 0 },
      { connection: 2, attempt: 1 },
    ]);
  });

  it('keeps retrying a dead host, warns once per outage, and stop() ends the attempts', async () => {
    const dead = await startMockBroker();
    const { url } = dead;
    await dead.close();
    const h = harness({ url });
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await until('three connect errors', () => h.logs('broker socket connect error').length >= 3);
    expect(h.client.state).toBe(BrokerSocketState.Connecting);
    const errors = h.logs('broker socket connect error');
    expect(errors.map(({ level }) => level)).toEqual([
      LEVEL.warn,
      ...errors.slice(1).map(() => LEVEL.debug),
    ]);
    expect(errors[0]).toEqual(
      expect.objectContaining({ attempt: 0, err: expect.objectContaining({ name: 'Error' }) }),
    );
    expect(errors[1]).toEqual(expect.objectContaining({ attempt: 1 }));

    h.client.stop();
    expect(h.client.state).toBe(BrokerSocketState.Idle);
    const seen = h.logs('broker socket connect error').length;
    await quiet();
    expect(h.logs('broker socket connect error')).toHaveLength(seen);
  });
});

describe('terminal states', () => {
  it('auth_failed on user.auth.error: the socket is closed and not reopened until start()', async () => {
    const h = harness();
    h.client.start({ brokerUserId: '1', accessToken: 'SECRET-WRONG-TOKEN' });
    await until('auth_failed', () => h.client.state === BrokerSocketState.AuthFailed);
    await until('the socket gone', () => broker.socket.sockets().length === 0);
    await quiet();
    expect(bySocket().map(shape)).toEqual([
      [{ event: BrokerSocketEvent.UserAuth, argc: 1, outcome: MockSocketOutcome.AuthFailed }],
    ]);
    expect(h.client.state).toBe(BrokerSocketState.AuthFailed);
    expect(h.client.connections).toBe(0);
    expect(h.logs('broker socket auth failed')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, detail: LIVE_MESSAGES.invalidToken }),
    ]);
    expect(typesOf(h.events)).toEqual([BrokerEventType.AuthError]);

    h.client.start(CREDENTIALS);
    await ready(h);
  });

  it('auth_failed on user.auth.error after ready, with the broker text cut to the detail length', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.UserAuthError, {
      message: 'x'.repeat(500),
    });
    await until('auth_failed', () => h.client.state === BrokerSocketState.AuthFailed);
    const [line] = h.logs('broker socket auth failed');
    expect(line?.detail).toBe('x'.repeat(200));
    await until('the socket gone', () => broker.socket.sockets().length === 0);
  });

  it('token_expired stays when the server then drops the socket', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.users.revokeToken(TOKEN);
    await until('token_expired', () => h.client.state === BrokerSocketState.TokenExpired);
    await until('the socket gone', () => broker.socket.sockets().length === 0);
    await quiet();
    expect(h.client.state).toBe(BrokerSocketState.TokenExpired);
    expect(h.states.at(-1)).toEqual({
      from: BrokerSocketState.Ready,
      to: BrokerSocketState.TokenExpired,
      reason: 'token_expired',
    });
    expect(h.logs('broker socket token expired')).toHaveLength(1);
    expect(bySocket()).toHaveLength(1);
  });

  it.each([
    ['while ready', false],
    ['during the handshake', true],
  ])(
    'disconnected_by_server on a server DISCONNECT %s, without reconnecting',
    async (_name, early) => {
      const h = harness();
      if (early) broker.socket.failNext('auth', { disconnect: true });
      h.client.start(CREDENTIALS);
      if (!early) {
        await ready(h);
        expect(broker.socket.disconnect({ userId: 1 })).toBe(1);
      }
      await until(
        'disconnected_by_server',
        () => h.client.state === BrokerSocketState.DisconnectedByServer,
      );
      await quiet();
      expect(bySocket()).toHaveLength(1);
      expect(broker.socket.sockets()).toEqual([]);
      expect(h.states.at(-1)?.reason).toBe('io server disconnect');
      expect(h.logs('broker socket disconnected by server')).toHaveLength(1);

      h.client.start(CREDENTIALS);
      await ready(h);
      expect(bySocket()).toHaveLength(2);
    },
  );
});

describe('a CONNECT_ERROR from the server', () => {
  it.each([
    ['on the first connection', false],
    ['on a reconnection', true],
  ])('is disconnected_by_server %s, without reconnecting', async (_name, reconnect) => {
    const refusal = { error: { message: 'SECRET-refusal' } };
    const h = harness();
    if (!reconnect) broker.socket.failNext('connect', refusal);
    h.client.start(CREDENTIALS);
    if (reconnect) {
      await ready(h);
      broker.socket.failNext('connect', refusal);
      expect(broker.socket.cutTransport({ userId: 1 })).toBe(1);
    }
    await until(
      'disconnected_by_server',
      () => h.client.state === BrokerSocketState.DisconnectedByServer,
    );
    expect(h.states.at(-1)).toEqual({
      from: reconnect ? BrokerSocketState.Reconnecting : BrokerSocketState.Connecting,
      to: BrokerSocketState.DisconnectedByServer,
      reason: 'connect_error',
    });
    await quiet();
    expect(broker.socket.sockets()).toEqual([]);
    expect(bySocket()).toHaveLength(reconnect ? 1 : 0);
    expect(h.logs('broker socket disconnected by server')).toEqual([
      expect.objectContaining({
        level: LEVEL.warn,
        reason: 'connect_error',
        err: { name: 'Error' },
      }),
    ]);
    for (const line of h.lines) expect(line).not.toContain('SECRET');

    h.client.start(CREDENTIALS);
    await ready(h);
  });
});

describe('listeners', () => {
  it('a restart on auth_failed is seen in causal order by a later listener', async () => {
    let restarted = false;
    const h = harness({}, (client) =>
      client.onState(({ to }) => {
        if (to !== BrokerSocketState.AuthFailed || restarted) return;
        restarted = true;
        client.start(CREDENTIALS);
      }),
    );
    h.client.start({ brokerUserId: '1', accessToken: 'SECRET-WRONG-TOKEN' });
    await ready(h);
    expect(h.states.map(({ to }) => to)).toEqual([
      BrokerSocketState.Connecting,
      BrokerSocketState.Authenticating,
      BrokerSocketState.AuthFailed,
      BrokerSocketState.Connecting,
      BrokerSocketState.Authenticating,
      BrokerSocketState.Ready,
    ]);
    expect(h.states.at(-1)?.to).toBe(h.client.state);
  });

  it('a stop() on ready is seen last by a later listener', async () => {
    const h = harness({}, (client) =>
      client.onState(({ to }) => {
        if (to === BrokerSocketState.Ready) client.stop();
      }),
    );
    h.client.start(CREDENTIALS);
    await until('idle again', () => h.states.at(-1)?.to === BrokerSocketState.Idle);
    expect(h.states.map(({ to }) => to)).toEqual([
      BrokerSocketState.Connecting,
      BrokerSocketState.Authenticating,
      BrokerSocketState.Ready,
      BrokerSocketState.Idle,
    ]);
    expect(h.client.state).toBe(BrokerSocketState.Idle);
  });

  it('an event listener that restarts the client ends the delivery of the old event', async () => {
    let restarted = false;
    const h = harness({}, (client) =>
      client.onEvent((event) => {
        if (event.type !== BrokerEventType.AuthSuccess || restarted) return;
        restarted = true;
        client.stop();
        client.start(CREDENTIALS);
      }),
    );
    h.client.start(CREDENTIALS);
    await until('the second auth', () => bySocket().length === 2);
    await ready(h);
    await quiet();
    expect(typesOf(h.events).filter((type) => type === BrokerEventType.AuthSuccess)).toHaveLength(
      1,
    );
    expect(h.client.connections).toBe(1);
    expect(broker.socket.sockets()).toHaveLength(1);
    expect(bySocket()).toHaveLength(2);
  });
});

describe('openSocket seam', () => {
  it('refuses a start() made from inside openSocket and leaves no socket', async () => {
    const ref: { client?: BrokerSocketClient } = {};
    let reentered = false;
    const h = harness({
      openSocket: (url, options) => {
        if (!reentered) {
          reentered = true;
          ref.client?.start(CREDENTIALS);
        }
        return io(url, options);
      },
    });
    ref.client = h.client;
    expect(() => h.client.start(CREDENTIALS)).toThrow('broker socket client already started');
    expect(h.client.state).toBe(BrokerSocketState.Idle);
    await quiet();
    expect(broker.socket.sockets()).toEqual([]);
    expect(broker.socket.journal).toEqual([]);
  });

  it('is connecting when it calls connect()', () => {
    const seen: string[] = [];
    const ref: { client?: BrokerSocketClient } = {};
    const h = harness({
      openSocket: (url, options) => {
        const socket: BrokerSocket = io(url, options);
        const connect = socket.connect.bind(socket);
        vi.spyOn(socket, 'connect').mockImplementation(() => {
          seen.push(ref.client?.state ?? 'none');
          return connect();
        });
        return socket;
      },
    });
    ref.client = h.client;
    h.client.start(CREDENTIALS);
    expect(seen).toEqual([BrokerSocketState.Connecting]);
  });

  it('a stop() from inside the user.auth emit ends the session cleanly', async () => {
    const ref: { client?: BrokerSocketClient } = {};
    const h = harness({
      openSocket: (url, options) => {
        const socket: BrokerSocket = io(url, options);
        const emit = socket.emit.bind(socket) as (
          event: string,
          ...args: unknown[]
        ) => BrokerSocket;
        vi.spyOn(socket, 'emit').mockImplementation(((event: string, ...args: unknown[]) => {
          if (event === BrokerSocketEvent.UserAuth) {
            ref.client?.stop();
            return socket;
          }
          return emit(event, ...args);
        }) as BrokerSocket['emit']);
        return socket;
      },
    });
    ref.client = h.client;
    h.client.start(CREDENTIALS);
    await until('idle', () => h.states.at(-1)?.to === BrokerSocketState.Idle);
    await new Promise((resolve) => setTimeout(resolve, TIMING.authTimeoutMs));
    await quiet();
    expect(h.client.state).toBe(BrokerSocketState.Idle);
    expect(h.states.map(({ to }) => to)).toEqual([
      BrokerSocketState.Connecting,
      BrokerSocketState.Idle,
    ]);
    expect(h.logs('broker socket auth timeout')).toEqual([]);
    expect(broker.socket.sockets()).toEqual([]);
    ref.client = undefined;
    h.client.start(CREDENTIALS);
    await until('authenticating again', () => h.client.state === BrokerSocketState.Authenticating);
  });
});

describe('listeners that end the session', () => {
  it('a restart on auth_failed gets one live socket, and the old auth_error is not dispatched', async () => {
    const h = harness();
    let restarted = false;
    h.client.onState(({ to }) => {
      if (to !== BrokerSocketState.AuthFailed || restarted) return;
      restarted = true;
      h.client.start(CREDENTIALS);
    });
    h.client.start({ brokerUserId: '1', accessToken: 'SECRET-WRONG-TOKEN' });
    await ready(h);
    expect(h.client.connections).toBe(1);
    await quiet();
    expect(broker.socket.sockets()).toHaveLength(1);
    expect(bySocket()).toHaveLength(2);
    expect(typesOf(h.events)).not.toContain(BrokerEventType.AuthError);
  });

  it('a stop() on connecting leaves no socket on the broker', async () => {
    const h = harness();
    h.client.onState(({ to }) => {
      if (to === BrokerSocketState.Connecting) h.client.stop();
    });
    h.client.start(CREDENTIALS);
    await quiet();
    expect(h.states.map(({ to }) => to)).toEqual([
      BrokerSocketState.Connecting,
      BrokerSocketState.Idle,
    ]);
    expect(broker.socket.sockets()).toEqual([]);
    expect(broker.socket.journal).toEqual([]);
  });
});

describe('start() and stop()', () => {
  it('refuses a second start while live and invalid credentials without quoting them', async () => {
    const h = harness();
    expect(() => h.client.start({ brokerUserId: '1', accessToken: '' })).toThrow(TypeError);
    expect(h.client.state).toBe(BrokerSocketState.Idle);
    h.client.start(CREDENTIALS);
    expect(() => h.client.start(CREDENTIALS)).toThrow('broker socket client already started');
    await ready(h);
    expect(() => h.client.start(CREDENTIALS)).toThrow('broker socket client already started');
  });

  it('stop() closes the socket at once, keeps the registry and allows a new start', async () => {
    const h = harness();
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await ready(h);
    h.client.stop();
    expect(h.client.state).toBe(BrokerSocketState.Idle);
    expect(h.logs('broker socket disconnected')).toEqual([
      expect.objectContaining({ reason: 'io client disconnect', connection: 1 }),
    ]);
    h.client.stop();
    await until('the socket gone', () => broker.socket.sockets().length === 0);
    h.client.start(CREDENTIALS);
    await ready(h);
    await until('the second pass', () => subscribeRecords() === 2);
    expect(h.client.subscriptions()).toEqual([EURUSD]);
    expect(bySocket().map(shape)).toEqual([
      [AUTH, SUBSCRIBE],
      [AUTH, SUBSCRIBE],
    ]);
  });
});

describe('events and problems', () => {
  it('warns once per event and kind per connection, and counts every problem', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    for (let i = 0; i < 5; i += 1) {
      broker.socket.emitRaw(
        { userId: 1 },
        BrokerSocketEvent.PriceUpdate,
        Buffer.from('{"token":"SECRET-a"}'),
      );
    }
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, Buffer.from('not json'));
    broker.socket.emitRaw({ userId: 1 }, 'user.unheard.of', { secret: 'SECRET-b' });
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.UserData);
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, [EURUSD, 1, 2], 'SECRET-c');
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, [EURUSD, 1, 3], 'SECRET-d');
    await until(
      'the last frame',
      () => h.events.filter((e) => e.type === BrokerEventType.PriceUpdate).length === 2,
    );

    const problems = h.logs('broker event problem');
    expect(problems.map(({ level, problem }) => [level, problem])).toEqual([
      [
        LEVEL.warn,
        // #354: the refused payload's shape reaches the line, its value does not
        expect.objectContaining({
          event: 'price.update',
          kind: BrokerEventProblemKind.Schema,
          shape: '{token: string}',
        }),
      ],
      [LEVEL.warn, { event: 'price.update', kind: BrokerEventProblemKind.Decode }],
      [LEVEL.warn, { event: 'user.unheard.of', kind: BrokerEventProblemKind.UnknownEvent }],
      [LEVEL.warn, { event: 'user.data', kind: BrokerEventProblemKind.MissingPayload }],
    ]);
    expect(h.logs('broker event with extra arguments')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, event: 'price.update', extraArgs: 1 }),
    ]);
    expect(h.lines.join('\n')).not.toContain('SECRET');
    expect(h.logs('broker event ignored').map(({ event }) => event)).toEqual(
      Object.values(OBSERVED_EXTRA_EVENTS).filter((name) => name !== 'price.subscribed'),
    );

    h.client.stop();
    expect(h.logs('broker socket disconnected')).toEqual([
      expect.objectContaining({
        problems: { unknown_event: 1, missing_payload: 1, decode: 1, schema: 5 },
        extraArgs: 3,
        ignored: 6,
        authTimeouts: 0,
      }),
    ]);
  });

  it('starts the warn-once set afresh on a new connection', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, 'SECRET');
    await until('the first warning', () => h.logs('broker event problem').length === 1);
    broker.socket.cutTransport({ userId: 1 });
    await ready(h, 2);
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, 'SECRET');
    await until('the second warning', () => h.logs('broker event problem').length === 2);
  });

  it('runs every listener when one throws, and warns once per event type per connection', async () => {
    const h = harness();
    h.client.onEvent((event) => {
      if (event.type === BrokerEventType.PriceUpdate) throw new Error('SECRET-listener');
    });
    const after: BrokerEvent[] = [];
    h.client.onEvent((event) => after.push(event));
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await ready(h);
    await until('subscribed', () => broker.socket.sockets()[0]?.subscriptions.length === 1);
    broker.socket.pushPrice(EURUSD, 1_000);
    broker.socket.pushPrice(EURUSD, 2_000);
    await until(
      'both prices',
      () => after.filter((e) => e.type === BrokerEventType.PriceUpdate).length === 2,
    );
    expect(h.logs('broker event listener threw')).toEqual([
      expect.objectContaining({
        level: LEVEL.warn,
        type: BrokerEventType.PriceUpdate,
        err: { name: 'Error' },
      }),
    ]);
  });
});

describe('openTrade', () => {
  it('emits the command once and answers with the trade of the open_trade.success', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    const result = await h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal);
    const [stored] = broker.trades.list(1);
    expect(result).toEqual({
      outcome: 'success',
      trade: expect.objectContaining({ id: String(stored?.id), assetId: EURUSD, amount: AMOUNT }),
    });
    // the fixture's update_balance came first and was not taken for the answer; listeners got both
    expect(typesOf(h.events)).toEqual(
      expect.arrayContaining([BrokerEventType.BalanceUpdate, BrokerEventType.OpenTradeSuccess]),
    );
    expect(shape(openTradeRecords())).toEqual([
      { event: DEMO_OPEN_TRADE, argc: 1, outcome: MockSocketOutcome.Handled },
    ]);
    expect(h.logs('broker socket open_trade sent')).toEqual([
      expect.objectContaining({ level: LEVEL.debug, mode: TradeMode.Demo, connection: 1 }),
    ]);
  });

  it('answers fail with the failures of the open_trade.fail, and nothing opens', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { fail: [{ message: 'refused', field: 'amount' }] });
    const result = await h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal);
    expect(result).toEqual({
      outcome: 'fail',
      failures: [{ message: 'refused', field: 'amount' }],
    });
    expect(broker.trades.list(1)).toEqual([]);
  });

  it('emits nothing unless ready: before start() and while authenticating', async () => {
    const h = harness();
    const signal = new AbortController().signal;
    expect(await h.client.openTrade(TradeMode.Demo, REQUEST, signal)).toEqual({
      outcome: 'not_sent',
      reason: 'not_ready',
      state: BrokerSocketState.Idle,
    });
    broker.socket.failNext('auth', { silent: true });
    h.client.start(CREDENTIALS);
    await until('authenticating', () => h.client.state === BrokerSocketState.Authenticating);
    expect(await h.client.openTrade(TradeMode.Demo, REQUEST, signal)).toEqual({
      outcome: 'not_sent',
      reason: 'not_ready',
      state: BrokerSocketState.Authenticating,
    });
    await ready(h);
    expect(openTradeRecords()).toEqual([]);
  });

  it('emits nothing for a signal already aborted', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    expect(await h.client.openTrade(TradeMode.Demo, REQUEST, AbortSignal.abort())).toEqual({
      outcome: 'not_sent',
      reason: 'aborted',
      state: BrokerSocketState.Ready,
    });
    await quiet();
    expect(openTradeRecords()).toEqual([]);
  });

  it('answers unknown when the transport drops after the emit, and never emits it again', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { silent: true });
    const command = track(
      h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal),
    );
    await until('the command on the broker', () => openTradeRecords().length === 1);
    expect(broker.socket.cutTransport({ userId: 1 })).toBe(1);
    await until('the command answered', () => command.settled);
    expect(await command.promise).toEqual({
      outcome: 'unknown',
      reason: 'state_changed',
      state: BrokerSocketState.Reconnecting,
    });
    await ready(h, 2);
    await quiet();
    expect(openTradeRecords()).toHaveLength(1);
    expect(broker.trades.list(1)).toEqual([]);
  });

  it('answers unknown when the server drops the socket before the answer, the trade open', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { disconnect: true, open: true });
    const result = await h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal);
    expect(result).toEqual({
      outcome: 'unknown',
      reason: 'state_changed',
      state: BrokerSocketState.DisconnectedByServer,
    });
    expect(broker.trades.list(1)).toHaveLength(1);
  });

  it('answers unknown on stop() while waiting', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { silent: true });
    const command = h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal);
    await until('the command on the broker', () => openTradeRecords().length === 1);
    h.client.stop();
    expect(await command).toEqual({
      outcome: 'unknown',
      reason: 'state_changed',
      state: BrokerSocketState.Idle,
    });
  });

  it('answers unknown on abort while waiting; the dropped connection never carries the late answer', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { delayMs: 50 });
    const controller = new AbortController();
    const command = h.client.openTrade(TradeMode.Demo, REQUEST, controller.signal);
    await until('the command on the broker', () => openTradeRecords().length === 1);
    controller.abort();
    expect(await command).toEqual({
      outcome: 'unknown',
      reason: 'aborted',
      state: BrokerSocketState.Ready,
    });
    await ready(h, 2);
    // the order opened at the broker all the same: the half of m4 reconciliation handles
    await until('the late trade at the broker', () => broker.trades.list(1).length === 1);
    broker.socket.failNext('openTrade', { fail: [{ message: 'second' }] });
    expect(await h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal)).toEqual(
      { outcome: 'fail', failures: [{ message: 'second' }] },
    );
    expect(typesOf(h.events)).not.toContain(BrokerEventType.OpenTradeSuccess);
  });

  it('answers unknown on its own timer when the broker is silent, and drops the connection', async () => {
    const h = harness({ timing: { ...TIMING, commandTimeoutMs: 60 } });
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { delayMs: 200 });
    const signal = new AbortController().signal;
    expect(await h.client.openTrade(TradeMode.Demo, REQUEST, signal)).toEqual({
      outcome: 'unknown',
      reason: 'timeout',
      state: BrokerSocketState.Ready,
    });
    expect(signal.aborted).toBe(false);
    await ready(h, 2);
    expect(h.states.map(({ to, reason }) => ({ to, reason })).slice(3)).toEqual([
      { to: BrokerSocketState.Reconnecting, reason: 'forced close' },
      { to: BrokerSocketState.Authenticating, reason: undefined },
      { to: BrokerSocketState.Ready, reason: undefined },
    ]);
    expect(h.logs('broker socket connection tainted')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, connection: 1 }),
    ]);
    expect(openTradeRecords()).toHaveLength(1);
    broker.socket.failNext('openTrade', { fail: [{ message: 'second' }] });
    expect(await h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal)).toEqual(
      { outcome: 'fail', failures: [{ message: 'second' }] },
    );
  });

  it('clears the command timer once answered', async () => {
    const armed: unknown[] = [];
    const setTimer = globalThis.setTimeout;
    const commandTimeoutMs = 4_321;
    // the client's only timer with this delay; socket.io's own use other delays
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      const handle = setTimer(handler, delay);
      if (delay === commandTimeoutMs) armed.push(handle);
      return handle;
    }) as typeof setTimeout);
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const h = harness({ timing: { ...TIMING, commandTimeoutMs } });
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { fail: [{ message: 'refused' }] });
    expect(await h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal)).toEqual(
      { outcome: 'fail', failures: [{ message: 'refused' }] },
    );
    expect(armed).toHaveLength(1);
    expect(cleared).toHaveBeenCalledWith(armed[0]);
  });

  describe('a command that ended without its answer', () => {
    // the real socket, its engine.close() recorded and not run: a broker slow to notice the drop,
    // so a late answer of the aborted command can still arrive on its connection
    function keepConnectionOpen() {
      const closes: number[] = [];
      const openSocket = (url: string, options: BrokerSocketOptions): BrokerSocket => {
        const socket: BrokerSocket = io(url, options);
        socket.io.on('open', () => {
          socket.io.engine.close = () => {
            closes.push(Date.now());
            return socket.io.engine;
          };
        });
        return socket;
      };
      return { closes, openSocket };
    }

    it('a late fail of the aborted command never answers the next one (m4)', async () => {
      const kept = keepConnectionOpen();
      const h = harness({ openSocket: kept.openSocket });
      h.client.start(CREDENTIALS);
      await ready(h);
      // EUR/USD min_timeframe is 60: the store refuses the first command once its delay is over
      broker.socket.failNext('openTrade', { delayMs: 50 });
      broker.socket.failNext('openTrade', { silent: true });
      const controller = new AbortController();
      const first = h.client.openTrade(
        TradeMode.Demo,
        { ...REQUEST, durationSec: 1 },
        controller.signal,
      );
      await until('the command on the broker', () => openTradeRecords().length === 1);
      controller.abort();
      expect(await first).toEqual({
        outcome: 'unknown',
        reason: 'aborted',
        state: BrokerSocketState.Ready,
      });
      const second = track(
        h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal),
      );
      await until('the late fail', () => typesOf(h.events).includes(BrokerEventType.OpenTradeFail));
      await until('the second command answered', () => second.settled);
      expect(await second.promise).toEqual({
        outcome: 'not_sent',
        reason: 'not_ready',
        state: BrokerSocketState.Ready,
      });
      expect(openTradeRecords()).toHaveLength(1);
      expect(kept.closes).toHaveLength(1);
      expect(h.logs('broker socket connection tainted')).toEqual([
        expect.objectContaining({ level: LEVEL.warn, connection: 1 }),
      ]);
    });

    it('a late fail of the timed-out command never answers the next one', async () => {
      const kept = keepConnectionOpen();
      const h = harness({
        openSocket: kept.openSocket,
        timing: { ...TIMING, commandTimeoutMs: 60 },
      });
      h.client.start(CREDENTIALS);
      await ready(h);
      // EUR/USD min_timeframe is 60: the store refuses the first command once its delay is over
      broker.socket.failNext('openTrade', { delayMs: 200 });
      broker.socket.failNext('openTrade', { silent: true });
      expect(
        await h.client.openTrade(
          TradeMode.Demo,
          { ...REQUEST, durationSec: 1 },
          new AbortController().signal,
        ),
      ).toEqual({ outcome: 'unknown', reason: 'timeout', state: BrokerSocketState.Ready });
      const second = track(
        h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal),
      );
      await until('the late fail', () => typesOf(h.events).includes(BrokerEventType.OpenTradeFail));
      await until('the second command answered', () => second.settled);
      expect(await second.promise).toEqual({
        outcome: 'not_sent',
        reason: 'not_ready',
        state: BrokerSocketState.Ready,
      });
      expect(openTradeRecords()).toHaveLength(1);
      expect(kept.closes).toHaveLength(1);
    });

    it('drops the tainted connection; the next one answers its own command', async () => {
      const h = harness();
      h.client.start(CREDENTIALS);
      await ready(h);
      broker.socket.failNext('openTrade', { delayMs: 50 });
      const controller = new AbortController();
      const first = h.client.openTrade(
        TradeMode.Demo,
        { ...REQUEST, durationSec: 1 },
        controller.signal,
      );
      await until('the command on the broker', () => openTradeRecords().length === 1);
      controller.abort();
      await first;
      await ready(h, 2);
      expect(h.states.map(({ to, reason }) => ({ to, reason })).slice(2)).toEqual([
        { to: BrokerSocketState.Ready, reason: undefined },
        { to: BrokerSocketState.Reconnecting, reason: 'forced close' },
        { to: BrokerSocketState.Authenticating, reason: undefined },
        { to: BrokerSocketState.Ready, reason: undefined },
      ]);
      const sockets = bySocket();
      expect(sockets).toHaveLength(2);
      for (const records of sockets) {
        expect(
          records.filter((record) => record.event === BrokerSocketEvent.UserAuth),
        ).toHaveLength(1);
      }
      broker.socket.failNext('openTrade', { fail: [{ message: 'second' }] });
      expect(
        await h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal),
      ).toEqual({ outcome: 'fail', failures: [{ message: 'second' }] });
      expect(h.logs('broker socket connection tainted')).toEqual([
        expect.objectContaining({ level: LEVEL.warn, connection: 1 }),
      ]);
    });
  });

  describe('a success is the answer only with the command terms', () => {
    it.each([
      ['asset', { asset_id: AAPL }],
      ['action', { action: TradeAction.Down }],
      ['amount', { amount: '13.38' }],
    ])(
      'keeps waiting on a success with another %s, and warns without values',
      async (field, wire) => {
        const h = harness();
        h.client.start(CREDENTIALS);
        await ready(h);
        broker.socket.failNext('openTrade', { silent: true });
        const command = track(
          h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal),
        );
        await until('the command on the broker', () => openTradeRecords().length === 1);
        broker.socket.emitRaw({ userId: 1 }, 'user.demo.open_trade.success', successWire(wire));
        await until('the foreign success', () =>
          typesOf(h.events).includes(BrokerEventType.OpenTradeSuccess),
        );
        expect(command.settled).toBe(false);
        expect(h.logs('broker socket open_trade answer mismatch')).toEqual([
          expect.objectContaining({
            level: LEVEL.warn,
            connection: 1,
            mode: TradeMode.Demo,
            field,
          }),
        ]);
        broker.socket.emitRaw({ userId: 1 }, 'user.demo.open_trade.success', successWire({}));
        expect(await command.promise).toEqual({
          outcome: 'success',
          trade: expect.objectContaining({ id: '9001', assetId: EURUSD, amount: AMOUNT }),
        });
      },
    );

    it('takes a success whose amount differs only in its spelling', async () => {
      const h = harness();
      h.client.start(CREDENTIALS);
      await ready(h);
      broker.socket.failNext('openTrade', { silent: true });
      const command = h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal);
      await until('the command on the broker', () => openTradeRecords().length === 1);
      broker.socket.emitRaw(
        { userId: 1 },
        'user.demo.open_trade.success',
        successWire({ amount: '13.3700' }),
      );
      expect(await command).toEqual(expect.objectContaining({ outcome: 'success' }));
      expect(h.logs('broker socket open_trade answer mismatch')).toEqual([]);
    });
  });

  it('is not answered by the other mode, only by its own', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { delayMs: 50 });
    const command = track(
      h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal),
    );
    await until('the command on the broker', () => openTradeRecords().length === 1);
    expect(
      broker.socket.emitRaw({ userId: 1 }, 'user.real.open_trade.fail', [{ message: 'real' }]),
    ).toBe(1);
    await until('the real fail', () => typesOf(h.events).includes(BrokerEventType.OpenTradeFail));
    expect(command.settled).toBe(false);
    expect(await command.promise).toEqual(expect.objectContaining({ outcome: 'success' }));
  });

  it('throws on a second command while one is waiting', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.failNext('openTrade', { delayMs: 20 });
    const first = h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal);
    expect(() => h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal)).toThrow(
      'broker socket open_trade already pending',
    );
    expect(await first).toEqual(expect.objectContaining({ outcome: 'success' }));
    expect(openTradeRecords()).toHaveLength(1);
  });
});

describe('logs', () => {
  it('never carry the token, a payload value or the URL, and name every path they cover', async () => {
    const h = harness();
    h.client.onEvent(() => {
      throw new Error(`listener saw ${TOKEN}`);
    });
    h.client.onState(() => {
      throw new Error(`state listener saw ${TOKEN}`);
    });
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await ready(h);
    expect(await h.client.openTrade(TradeMode.Demo, REQUEST, new AbortController().signal)).toEqual(
      expect.objectContaining({ outcome: 'success' }),
    );
    broker.socket.failNext('openTrade', { silent: true });
    const controller = new AbortController();
    const foreign = h.client.openTrade(TradeMode.Demo, REQUEST, controller.signal);
    await until('the second command on the broker', () => openTradeRecords().length === 2);
    broker.socket.emitRaw(
      { userId: 1 },
      'user.demo.open_trade.success',
      successWire({ asset_id: AAPL }),
    );
    await until(
      'the mismatch',
      () => h.logs('broker socket open_trade answer mismatch').length > 0,
    );
    controller.abort();
    await foreign;
    await ready(h, 2);
    broker.socket.emitRaw(
      { userId: 1 },
      BrokerSocketEvent.PriceUpdate,
      Buffer.from(`["${TOKEN}"]`),
    );
    // an event name is logged (cut to MAX_EVENT_NAME_LENGTH, events.ts): only payloads are secret
    broker.socket.emitRaw({ userId: 1 }, 'user.unheard.of', TOKEN);
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, [EURUSD, 1, 1], TOKEN);
    broker.socket.cutTransport({ userId: 1 });
    await ready(h, 3);
    broker.users.revokeToken(TOKEN);
    await until('token_expired', () => h.client.state === BrokerSocketState.TokenExpired);

    broker.socket.failNext('auth', { silent: true });
    broker.socket.failNext('auth', { error: { message: 'refused' } });
    h.client.start({ brokerUserId: '2', accessToken: OTHER_TOKEN });
    await until('auth_failed', () => h.client.state === BrokerSocketState.AuthFailed);
    broker.socket.failNext('auth', { disconnect: true });
    h.client.start({ brokerUserId: '2', accessToken: OTHER_TOKEN });
    await until(
      'disconnected_by_server',
      () => h.client.state === BrokerSocketState.DisconnectedByServer,
    );

    const dead = await startMockBroker();
    const deadUrl = dead.url;
    await dead.close();
    const d = harness({ url: deadUrl });
    d.client.start({ brokerUserId: '1', accessToken: TOKEN });
    await until('a connect error', () => d.logs('broker socket connect error').length >= 1);
    d.client.stop();

    const lines = [...h.lines, ...d.lines];
    for (const line of lines) {
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain(AMOUNT);
      expect(line).not.toContain(broker.url.replace('http://', ''));
      expect(line).not.toContain(deadUrl.replace('http://', ''));
    }
    const messages = new Set(lines.map((line) => (JSON.parse(line) as LogEntry).msg));
    for (const msg of [
      'broker socket state',
      'broker socket ready',
      'broker socket disconnected',
      'broker socket connect error',
      'broker socket auth timeout',
      'broker socket auth failed',
      'broker socket token expired',
      'broker socket disconnected by server',
      'broker event problem',
      'broker event with extra arguments',
      'broker event ignored',
      'broker event listener threw',
      'broker socket state listener threw',
      'broker socket open_trade sent',
      'broker socket open_trade answer mismatch',
      'broker socket connection tainted',
    ]) {
      expect(messages, msg).toContain(msg);
    }
  });
});
