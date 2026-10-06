import {
  LIVE_MESSAGES,
  MockSocketOutcome,
  MockSocketPayload,
  OBSERVED_EXTRA_EVENTS,
  startMockBroker,
  type MockBroker,
  type MockSocketRecord,
} from '@binarius/mock-broker';
import { BrokerSocketEvent, logOptions, MAX_PRICE_SUBSCRIPTION_ASSETS } from '@binarius/shared';
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
  type BrokerSocketStateChange,
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

// the signature of #205's until(); the body is this repository's current wait
async function waitFor(what: string, condition: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(condition(), what).toBe(true), { timeout: 1000, interval: 5 });
}

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

let broker: MockBroker;
const clients: BrokerSocketClient[] = [];
const extraBrokers: MockBroker[] = [];

function harness(overrides: Partial<BrokerSocketClientOptions> = {}): Harness {
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
  waitFor(
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

beforeEach(async () => {
  broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
  broker.users.register({ id: 1, accessToken: TOKEN });
  broker.users.register({ id: 2, accessToken: OTHER_TOKEN });
});

afterEach(async () => {
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
      broker = await startMockBroker({ socketPayload: form });
      extraBrokers.push(broker);
      broker.users.register({ id: 1, accessToken: TOKEN });
      const h = harness();
      h.client.subscribe([AAPL, EURUSD]);
      h.client.start(CREDENTIALS);
      expect(h.client.state).toBe(BrokerSocketState.Connecting);
      await ready(h);

      await waitFor(
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
      await waitFor('the burst', () => typesOf(h.events).includes(BrokerEventType.AssetsList));
      expect(typesOf(h.events)).toEqual([
        BrokerEventType.AuthSuccess,
        BrokerEventType.UserData,
        BrokerEventType.AssetsList,
      ]);

      expect(broker.socket.pushPrice(EURUSD, 1_790_000_000_000)).toBe(1);
      await waitFor('a price', () => typesOf(h.events).includes(BrokerEventType.PriceUpdate));
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
    await waitFor(
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
    await waitFor(
      'BTCUSD on the socket',
      () => broker.socket.sockets()[0]?.subscriptions.length === 2,
    );
    expect(bySocket().map(shape)).toEqual([[AUTH, SUBSCRIBE, SUBSCRIBE]]);
    expect(h.client.subscriptions()).toEqual([EURUSD, BTCUSD]);
  });

  it('holds a subscribe made while authenticating for the next pass; a hung auth reconnects', async () => {
    broker.socket.failNext('auth', { silent: true });
    const emitted: string[][] = [];
    const h = harness({
      // the seam records what the client emits, per socket
      openSocket: (url, options) => {
        const socket: BrokerSocket = io(url, options);
        const sent: string[] = [];
        emitted.push(sent);
        const emit = socket.emit.bind(socket) as (
          event: string,
          ...args: unknown[]
        ) => BrokerSocket;
        vi.spyOn(socket, 'emit').mockImplementation(((event: string, ...args: unknown[]) => {
          sent.push(event);
          return emit(event, ...args);
        }) as BrokerSocket['emit']);
        return socket;
      },
    });
    h.client.start(CREDENTIALS);
    await waitFor('authenticating', () => h.client.state === BrokerSocketState.Authenticating);
    h.client.subscribe([EURUSD]);

    await ready(h);
    await waitFor(
      'the pass on the socket',
      () => broker.socket.sockets()[0]?.subscriptions.length === 1,
    );
    expect(emitted).toEqual([
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

  it('disarms the auth timer once authenticated', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    await new Promise((resolve) => setTimeout(resolve, TIMING.authTimeoutMs));
    await quiet();
    expect(h.client.connections).toBe(1);
    expect(h.client.state).toBe(BrokerSocketState.Ready);
    expect(h.logs('broker socket auth timeout')).toEqual([]);
  });

  it('ignores a second user.auth.success on one connection', async () => {
    const h = harness();
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await ready(h);
    await waitFor('the pass', () => subscribeRecords() === 1);
    expect(broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.UserAuthSuccess, null)).toBe(1);
    await waitFor(
      'the second auth_success',
      () => typesOf(h.events).filter((type) => type === BrokerEventType.AuthSuccess).length === 2,
    );
    expect(h.client.connections).toBe(1);
    expect(bySocket().map(shape)).toEqual([[AUTH, SUBSCRIBE]]);
  });
});

describe('reconnection', () => {
  it('re-authenticates and resends every subscription exactly once after a transport drop', async () => {
    const ids = range(1, MAX_PRICE_SUBSCRIPTION_ASSETS + 5);
    const h = harness();
    h.client.subscribe(ids);
    h.client.start(CREDENTIALS);
    await ready(h);
    await waitFor(
      'the first pass',
      () => broker.socket.sockets()[0]?.subscriptions.length === ids.length,
    );

    expect(broker.socket.cutTransport({ userId: 1 })).toBe(1);
    await waitFor('reconnecting', () => h.client.state === BrokerSocketState.Reconnecting);
    // made while disconnected: socket.io would buffer an emit and flush it ahead of user.auth
    h.client.subscribe([5_000]);
    await ready(h, 2);
    await waitFor(
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
    await waitFor('three connect errors', () => h.logs('broker socket connect error').length >= 3);
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
    await waitFor('auth_failed', () => h.client.state === BrokerSocketState.AuthFailed);
    await waitFor('the socket gone', () => broker.socket.sockets().length === 0);
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
    await waitFor('auth_failed', () => h.client.state === BrokerSocketState.AuthFailed);
    const [line] = h.logs('broker socket auth failed');
    expect(line?.detail).toBe('x'.repeat(200));
    await waitFor('the socket gone', () => broker.socket.sockets().length === 0);
  });

  it('token_expired stays when the server then drops the socket', async () => {
    const h = harness();
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.users.revokeToken(TOKEN);
    await waitFor('token_expired', () => h.client.state === BrokerSocketState.TokenExpired);
    await waitFor('the socket gone', () => broker.socket.sockets().length === 0);
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
      await waitFor(
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
    await waitFor('the socket gone', () => broker.socket.sockets().length === 0);
    h.client.start(CREDENTIALS);
    await ready(h);
    await waitFor('the second pass', () => subscribeRecords() === 2);
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
        Buffer.from('{"SECRET-a":1}'),
      );
    }
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, Buffer.from('not json'));
    broker.socket.emitRaw({ userId: 1 }, 'user.unheard.of', { secret: 'SECRET-b' });
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.UserData);
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, [EURUSD, 1, 2], 'SECRET-c');
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, [EURUSD, 1, 3], 'SECRET-d');
    await waitFor(
      'the last frame',
      () => h.events.filter((e) => e.type === BrokerEventType.PriceUpdate).length === 2,
    );

    const problems = h.logs('broker event problem');
    expect(problems.map(({ level, problem }) => [level, problem])).toEqual([
      [
        LEVEL.warn,
        expect.objectContaining({ event: 'price.update', kind: BrokerEventProblemKind.Schema }),
      ],
      [LEVEL.warn, { event: 'price.update', kind: BrokerEventProblemKind.Decode }],
      [LEVEL.warn, { event: 'user.unheard.of', kind: BrokerEventProblemKind.UnknownEvent }],
      [LEVEL.warn, { event: 'user.data', kind: BrokerEventProblemKind.MissingPayload }],
    ]);
    expect(h.logs('broker event with extra arguments')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, event: 'price.update', extraArgs: 1 }),
    ]);
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
    await waitFor('the first warning', () => h.logs('broker event problem').length === 1);
    broker.socket.cutTransport({ userId: 1 });
    await ready(h, 2);
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, 'SECRET');
    await waitFor('the second warning', () => h.logs('broker event problem').length === 2);
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
    await waitFor('subscribed', () => broker.socket.sockets()[0]?.subscriptions.length === 1);
    broker.socket.pushPrice(EURUSD, 1_000);
    broker.socket.pushPrice(EURUSD, 2_000);
    await waitFor(
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

describe('logs', () => {
  it('never carry the token, a payload value or the URL, and name every path they cover', async () => {
    const h = harness();
    h.client.onEvent(() => {
      throw new Error(`listener saw ${TOKEN}`);
    });
    h.client.subscribe([EURUSD]);
    h.client.start(CREDENTIALS);
    await ready(h);
    broker.socket.emitRaw(
      { userId: 1 },
      BrokerSocketEvent.PriceUpdate,
      Buffer.from(`["${TOKEN}"]`),
    );
    // an event name is logged (cut to MAX_EVENT_NAME_LENGTH, events.ts): only payloads are secret
    broker.socket.emitRaw({ userId: 1 }, 'user.unheard.of', TOKEN);
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.PriceUpdate, [EURUSD, 1, 1], TOKEN);
    broker.socket.cutTransport({ userId: 1 });
    await ready(h, 2);
    broker.users.revokeToken(TOKEN);
    await waitFor('token_expired', () => h.client.state === BrokerSocketState.TokenExpired);

    broker.socket.failNext('auth', { silent: true });
    broker.socket.failNext('auth', { error: { message: 'refused' } });
    h.client.start({ brokerUserId: '2', accessToken: OTHER_TOKEN });
    await waitFor('auth_failed', () => h.client.state === BrokerSocketState.AuthFailed);
    broker.socket.failNext('auth', { disconnect: true });
    h.client.start({ brokerUserId: '2', accessToken: OTHER_TOKEN });
    await waitFor(
      'disconnected_by_server',
      () => h.client.state === BrokerSocketState.DisconnectedByServer,
    );

    const dead = await startMockBroker();
    const deadUrl = dead.url;
    await dead.close();
    const d = harness({ url: deadUrl });
    d.client.start({ brokerUserId: '1', accessToken: TOKEN });
    await waitFor('a connect error', () => d.logs('broker socket connect error').length >= 1);
    d.client.stop();

    const lines = [...h.lines, ...d.lines];
    for (const line of lines) {
      expect(line).not.toContain('SECRET');
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
    ]) {
      expect(messages, msg).toContain(msg);
    }
  });
});
