import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BrokerSocketEvent,
  SIGNAL_SCAN_INTERVALS,
  logOptions,
  toBinaryPair,
  type BinaryPair,
  type BinaryPairWire,
  type PairsCatalogView,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import { hashToken } from '@binarius/db';
import {
  encodeSocketPayload,
  MockSocketPayload,
  startMockBroker,
  type MockBroker,
} from '@binarius/mock-broker';
import {
  BrokerEventType,
  BrokerSocketState,
  createBrokerSocketClient,
  type BrokerEvent,
  type BrokerSocketClient,
  type BrokerSocketStateChange,
} from '@binarius/broker-socket';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import {
  createMarketDataManager,
  type MarketDataAccount,
  type MarketDataConfig,
  type MarketDataManager,
} from './manager';
import { createCandleRing, type CandleRing } from './ring';
import { createPendingRequests } from './source';

const TOKEN_1 = 'SECRET-token-of-user-1';
const TOKEN_2 = 'SECRET-token-of-user-2';
const ACC1: MarketDataAccount = { id: '00000000-0000-4000-8000-000000000001', brokerUserId: '1' };
const ACC2: MarketDataAccount = { id: '00000000-0000-4000-8000-000000000002', brokerUserId: '2' };
const ACC3: MarketDataAccount = { id: '00000000-0000-4000-8000-000000000003', brokerUserId: '3' };
const ACC4: MarketDataAccount = { id: '00000000-0000-4000-8000-000000000004', brokerUserId: '4' };
const TOKENS: Record<string, string> = {
  [ACC1.id]: TOKEN_1,
  [ACC2.id]: TOKEN_2,
  [ACC3.id]: 'SECRET-token-of-user-3',
};

// 45 pairs, ids not ascending: two price.subscribe chunks of 40
const PAIR_WIRES: BinaryPairWire[] = Array.from({ length: 45 }, (_, k) => ({
  id: 500 + ((k * 7) % 45),
  symbol: `P${k}`,
  is_otc: false,
  type: 'currency',
  digits: 5,
  payout: 80,
  max_payout: 90,
  min_timeframe: 5,
  max_timeframe: 3600,
  scheduled_until: 0,
}));
const PAIRS: BinaryPair[] = PAIR_WIRES.map(toBinaryPair);
const IDS = PAIRS.map((pair) => pair.id).sort((a, b) => a - b);

// the client's waits shortened as in socket.test.ts; the chain of socket-config.ts holds
const TIMING = {
  connectTimeoutMs: 1_000,
  authTimeoutMs: 200,
  reconnectDelayMs: 20,
  reconnectDelayMaxMs: 40,
  jitter: 0,
};
const CONFIG: MarketDataConfig = {
  // the tests call tick() and report() themselves
  tickMs: 3_600_000,
  logMs: 3_600_000,
  failoverGraceMs: 10_000,
  accountRetryMs: 3_600_000,
};
// a negative wait past a 300 ms grace: a failover that was going to happen has happened
const QUIET_MS = 400;
const pastGrace = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

type LogEntry = Record<string, unknown> & { level: number; msg: string };

interface Line {
  accounts: number;
  held: number;
  active: {
    accountId: string;
    socketState: string;
    connection?: number;
    subscriptions?: number;
  } | null;
  reserve: { accountId: string; socketState: string } | null;
  ticks: number;
  unknownAsset: number;
  skippedDigits: number;
  holes: number;
  failovers: number;
  pairs: number;
  [key: string]: unknown;
}

// every line any test wrote, for M11
const allLines: string[] = [];

interface FakeClient extends BrokerSocketClient {
  starts: string[];
  stops: number;
  subscribeCalls: number[][];
  fire(state: BrokerSocketState): void;
  hear(event: BrokerEvent): void;
}

// the worker's fakeClients (session-manager.test.ts) with a subscription registry; throwOnStart
// throws as the client does on invalid credentials, before any state change (start: 1-based)
function fakeClients(
  readyOnStart: (index: number) => boolean = () => true,
  throwOnStart: (index: number, start: number) => boolean = () => false,
) {
  const made: FakeClient[] = [];
  const openClient = (): BrokerSocketClient => {
    const index = made.length;
    const stateListeners = new Set<(change: BrokerSocketStateChange) => void>();
    const eventListeners = new Set<(event: BrokerEvent) => void>();
    const registry = new Set<number>();
    let state: BrokerSocketState = BrokerSocketState.Idle;
    let connections = 0;
    const publish = (to: BrokerSocketState) => {
      const change = { from: state, to };
      state = to;
      if (to === BrokerSocketState.Ready) connections += 1;
      for (const listener of [...stateListeners]) listener(change);
    };
    const client: FakeClient = {
      starts: [],
      stops: 0,
      subscribeCalls: [],
      fire: publish,
      hear(event) {
        for (const listener of [...eventListeners]) listener(event);
      },
      start(credentials) {
        client.starts.push(credentials.accessToken);
        if (throwOnStart(index, client.starts.length)) {
          throw new TypeError('broker socket credentials are invalid');
        }
        connections = 0;
        publish(readyOnStart(index) ? BrokerSocketState.Ready : BrokerSocketState.Authenticating);
      },
      stop() {
        client.stops += 1;
        publish(BrokerSocketState.Idle);
      },
      subscribe(ids) {
        client.subscribeCalls.push([...ids]);
        for (const id of ids) registry.add(id);
      },
      subscriptions: () => [...registry].sort((a, b) => a - b),
      openTrade: () => Promise.reject(new Error('not used')),
      get state() {
        return state;
      },
      get connections() {
        return connections;
      },
      onEvent(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onState(listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
    };
    made.push(client);
    return client;
  };
  return { made, openClient };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface TokenCall {
  accountId: string;
  options: AccessTokenOptions;
}

interface Harness {
  manager: MarketDataManager;
  ring: CandleRing;
  calls: TokenCall[];
  // per account: replaces the default answer (the account's token)
  answers: Map<string, (options: AccessTokenOptions) => Promise<AccessTokenResult>>;
  catalog: { view: PairsCatalogView | undefined };
  accounts: { list: MarketDataAccount[] };
  // the real clients opened on the mock broker, with every subscribe() call
  clients: { client: BrokerSocketClient; subscribeCalls: number[][] }[];
  lines: string[];
  logs(msg: string): LogEntry[];
  // report() now, and the line it wrote
  line(): Line;
}

let broker: MockBroker | undefined;
const managers: MarketDataManager[] = [];

const freshView = (pairs: BinaryPair[] = PAIRS): PairsCatalogView => ({
  pairs,
  fetchedAt: Date.now(),
  ageMs: 0,
  fresh: true,
});

async function withBroker(): Promise<MockBroker> {
  broker = await startMockBroker({
    socketPayload: MockSocketPayload.Bytes,
    pairs: PAIR_WIRES,
  });
  broker.users.register({ id: 1, accessToken: TOKEN_1 });
  broker.users.register({ id: 2, accessToken: TOKEN_2 });
  return broker;
}

function harness(
  options: {
    accounts?: MarketDataAccount[];
    config?: Partial<MarketDataConfig>;
    openClient?: (label: string) => BrokerSocketClient;
    view?: PairsCatalogView | undefined;
    timing?: Partial<typeof TIMING>;
    listAccounts?: () => Promise<readonly MarketDataAccount[]>;
  } = {},
): Harness {
  const lines: string[] = [];
  const logger = pino(logOptions('debug'), {
    write: (line: string) => {
      lines.push(line);
      allLines.push(line);
    },
  });
  const ring = createCandleRing({
    capacity: 300,
    skewMarginMs: 2_000,
    intervals: SIGNAL_SCAN_INTERVALS,
  });
  const calls: TokenCall[] = [];
  const answers = new Map<string, (options: AccessTokenOptions) => Promise<AccessTokenResult>>();
  const catalog = { view: 'view' in options ? options.view : freshView() };
  const accounts = { list: options.accounts ?? [ACC1, ACC2] };
  const clients: Harness['clients'] = [];
  const openReal = (label: string): BrokerSocketClient => {
    if (broker === undefined) throw new Error('no mock broker in this test');
    const client = createBrokerSocketClient({
      url: broker.url,
      logger: logger.child({ socket: label }),
      timing: { ...TIMING, ...options.timing },
    });
    const subscribeCalls: number[][] = [];
    const subscribe = client.subscribe.bind(client);
    client.subscribe = (ids) => {
      subscribeCalls.push([...ids]);
      subscribe(ids);
    };
    clients.push({ client, subscribeCalls });
    return client;
  };
  const manager = createMarketDataManager({
    listAccounts: options.listAccounts ?? (() => Promise.resolve(accounts.list)),
    accessToken: (accountId, tokenOptions) => {
      calls.push({ accountId, options: tokenOptions });
      const answer = answers.get(accountId);
      if (answer !== undefined) return answer(tokenOptions);
      return Promise.resolve({ ok: true, accessToken: TOKENS[accountId] ?? 'SECRET-unknown' });
    },
    catalog: { read: () => catalog.view },
    openClient: options.openClient ?? openReal,
    ring,
    requests: createPendingRequests(288),
    logger,
    config: { ...CONFIG, ...options.config },
  });
  managers.push(manager);
  const parsed = (msg: string) =>
    lines.map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry.msg === msg);
  return {
    manager,
    ring,
    calls,
    answers,
    catalog,
    accounts,
    clients,
    lines,
    logs: parsed,
    line() {
      manager.report();
      const written = parsed('market data').at(-1);
      if (written === undefined) throw new Error('no market data line');
      return written as unknown as Line;
    },
  };
}

// each subscribe() call's ids, sorted: the catalog's order is not the ids'
const subscribed = (client: FakeClient | undefined) =>
  client?.subscribeCalls.map((ids) => [...ids].sort((a, b) => a - b));

// lets the work started inside an event handler run to its end
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const socketsOf = (userId: number) =>
  (broker?.socket.sockets() ?? []).filter((socket) => socket.userId === userId);

const bothReady = (h: Harness) =>
  until('the active and the reserve ready', () => {
    const line = h.line();
    return line.active?.socketState === 'ready' && line.reserve?.socketState === 'ready';
  });

const SERVICE = { mayRefresh: true, serviceOnly: true };

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  await broker?.close();
  broker = undefined;
});

describe('the market data manager on the mock broker (#404)', () => {
  it('M1 starts the active subscribed to the fresh catalog and a reserve subscribed to nothing', async () => {
    const mock = await withBroker();
    const h = harness();
    await h.manager.tick();
    await bothReady(h);
    await until('the active subscribed', () => socketsOf(1)[0]?.subscriptions.length === 45);

    expect(socketsOf(1)).toHaveLength(1);
    expect(socketsOf(1)[0]?.subscriptions).toEqual(IDS);
    expect(socketsOf(2)).toHaveLength(1);
    expect(socketsOf(2)[0]?.subscriptions).toEqual([]);
    const events = (userId: number) =>
      mock.socket.journal
        .filter((record) => record.socketId === (userId === 1 ? socketsOf(1) : socketsOf(2))[0]?.id)
        .map((record) => record.event);
    expect(events(1).filter((event) => event === BrokerSocketEvent.UserAuth)).toHaveLength(1);
    expect(events(1).filter((event) => event === BrokerSocketEvent.PriceSubscribe)).toHaveLength(
      Math.ceil(45 / 40),
    );
    expect(events(2).filter((event) => event === BrokerSocketEvent.UserAuth)).toHaveLength(1);
    expect(events(2).filter((event) => event === BrokerSocketEvent.PriceSubscribe)).toEqual([]);
    expect(h.calls).toEqual([
      { accountId: ACC1.id, options: SERVICE },
      { accountId: ACC2.id, options: SERVICE },
    ]);
    expect(h.clients[1]?.subscribeCalls).toEqual([]);
    expect(h.line().active).toEqual({
      accountId: ACC1.id,
      socketState: 'ready',
      connection: 1,
      subscriptions: 45,
    });
  });

  it('M2 builds candles of both intervals from the active socket only', async () => {
    const mock = await withBroker();
    const h = harness();
    await h.manager.tick();
    await bothReady(h);
    await until('subscribed', () => socketsOf(1)[0]?.subscriptions.length === 45);
    h.line();
    // one price per subscription of each socket: the reserve has none
    expect(mock.socket.pushPrices(Date.now())).toBe(45);
    await until('every pair ticked', () => h.ring.counters().pairs === 45);
    for (const interval of SIGNAL_SCAN_INTERVALS) {
      expect(h.ring.read(IDS[0] ?? 0, interval, Date.now()).forming).toBeDefined();
    }
    expect(h.line()).toMatchObject({ ticks: 45, pairs: 45, unknownAsset: 0 });
  });

  it('M3 switches to the ready reserve within the event that ended the active, and marks the holes', async () => {
    const mock = await withBroker();
    const h = harness();
    await h.manager.tick();
    await bothReady(h);
    await until('subscribed', () => socketsOf(1)[0]?.subscriptions.length === 45);
    const before = Date.now();
    mock.socket.pushPrices(before);
    await until('every pair ticked', () => h.ring.counters().pairs === 45);

    const [active, reserve] = h.clients;
    let subscribedAtDrop: number[] | undefined;
    // registered after the manager's listener: it sees the state the manager left
    active?.client.onState((change) => {
      if (change.to === BrokerSocketState.DisconnectedByServer) {
        subscribedAtDrop = reserve?.client.subscriptions();
      }
    });
    mock.socket.disconnect({ userId: 1 });
    await until('the failover', () => h.logs('market data failover').length === 1);
    expect(subscribedAtDrop).toEqual(IDS);
    expect(h.logs('market data failover')[0]).toMatchObject({
      from: ACC1.id,
      to: ACC2.id,
      reason: BrokerSocketState.DisconnectedByServer,
    });
    // the old client is stopped: one subscribed socket
    await until('the old socket closed', () => socketsOf(1).length === 0);
    await until('the reserve subscribed', () => socketsOf(2)[0]?.subscriptions.length === 45);

    const after = Math.max(Date.now(), before + 1);
    mock.socket.pushPrices(after);
    await until('the holes', () => h.ring.counters().holes === 45);
    const touched = Math.floor(before / 5_000) * 5_000;
    const window = h.ring.read(IDS[0] ?? 0, '5s', after);
    expect(window.candles.map((candle) => candle.timestamp)).not.toContain(touched);
    expect(window.forming?.timestamp).not.toBe(touched);

    const line = h.line();
    expect(line).toMatchObject({ held: 1, reserve: null, failovers: 1 });
    expect(line.active).toMatchObject({
      accountId: ACC2.id,
      socketState: 'ready',
      subscriptions: 45,
    });
  });

  it('M4 waits out a reconnection shorter than the grace on the same client', async () => {
    const mock = await withBroker();
    const h = harness({ config: { failoverGraceMs: 300 } });
    await h.manager.tick();
    await bothReady(h);
    await until('subscribed', () => socketsOf(1)[0]?.subscriptions.length === 45);
    mock.socket.pushPrices(Date.now());
    await until('every pair ticked', () => h.ring.counters().pairs === 45);

    mock.socket.cutTransport({ userId: 1 });
    await until('the active back', () => h.clients[0]?.client.connections === 2);
    await until('subscribed again', () => socketsOf(1)[0]?.subscriptions.length === 45);
    await pastGrace();
    expect(h.logs('market data failover')).toEqual([]);
    expect(h.clients).toHaveLength(2);
    expect(socketsOf(2)[0]?.subscriptions).toEqual([]);
    mock.socket.pushPrices(Date.now());
    await until('the holes', () => h.ring.counters().holes === 45);
    expect(h.line()).toMatchObject({ failovers: 0, held: 0 });
  });

  it('M5 switches at once when the reconnection is refused by the server, and holds the account back', async () => {
    const mock = await withBroker();
    const h = harness();
    await h.manager.tick();
    await bothReady(h);
    mock.socket.failNext('connect', { error: { message: 'refused' } });
    mock.socket.cutTransport({ userId: 1 });
    await until('the failover', () => h.logs('market data failover').length === 1);
    expect(h.logs('market data failover')[0]).toMatchObject({
      to: ACC2.id,
      reason: BrokerSocketState.DisconnectedByServer,
    });
    expect(h.line()).toMatchObject({ held: 1, reserve: null });
  });

  it('M5b switches when the grace runs out, and keeps the account as the first reserve', async () => {
    const mock = await withBroker();
    const h = harness({ config: { failoverGraceMs: 1 } });
    await h.manager.tick();
    await bothReady(h);
    // the grace (1 ms) ends before the client's first reconnection (20 ms)
    mock.socket.cutTransport({ userId: 1 });
    await until('the failover', () => h.logs('market data failover').length === 1);
    expect(h.logs('market data failover')[0]).toMatchObject({
      from: ACC1.id,
      to: ACC2.id,
      reason: 'reconnect_timeout',
    });
    await until('a reserve on account 1', () => {
      const line = h.line();
      return line.reserve?.accountId === ACC1.id && line.reserve.socketState === 'ready';
    });
    expect(h.line()).toMatchObject({ held: 0 });
    expect(h.clients).toHaveLength(3);
    expect(h.clients[2]?.subscribeCalls).toEqual([]);
  });

  it('M6 drops a client that reports another user, holds its account back and switches', async () => {
    const mock = await withBroker();
    const h = harness();
    await h.manager.tick();
    await bothReady(h);
    mock.socket.emitRaw(
      { userId: 1 },
      BrokerSocketEvent.UserData,
      encodeSocketPayload(mock.users.get(2), MockSocketPayload.Bytes),
    );
    await until('the failover', () => h.logs('market data failover').length === 1);
    expect(h.logs('market data failover')[0]).toMatchObject({
      to: ACC2.id,
      reason: 'foreign_user',
    });
    const [foreign] = h.logs('market data foreign user');
    expect(foreign).toMatchObject({ role: 'active', accountId: ACC1.id });
    expect(Object.keys(foreign ?? {})).not.toContain('received');
    await until('the old socket closed', () => socketsOf(1).length === 0);
    expect(h.line()).toMatchObject({ held: 1, reserve: null });
  });

  it('M8 runs on one account without a reserve, and restarts on it after the hold-back', async () => {
    const mock = await withBroker();
    const h = harness({ accounts: [ACC1], config: { accountRetryMs: 300 } });
    await h.manager.tick();
    await until('the active ready', () => h.line().active?.socketState === 'ready');
    expect(h.line().reserve).toBeNull();
    mock.socket.disconnect({ userId: 1 });
    await until('the failover', () => h.logs('market data failover').length === 1);
    expect(h.logs('market data failover')[0]).toMatchObject({ from: ACC1.id, to: null });
    expect(h.line()).toMatchObject({ active: null, reserve: null });
    await until('the active back after the hold-back', async () => {
      await h.manager.tick();
      return h.line().active?.socketState === 'ready';
    });
    expect(h.clients).toHaveLength(2);
    await until('subscribed', () => socketsOf(1)[0]?.subscriptions.length === 45);
  });

  it('M8b opens no socket without a service account and warns once', async () => {
    await withBroker();
    const h = harness({ accounts: [] });
    await h.manager.tick();
    await h.manager.tick();
    expect(h.logs('market data: no working service account')).toHaveLength(1);
    expect(h.line()).toMatchObject({ accounts: 0, active: null, reserve: null });
    expect(h.clients).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('M9 subscribes nothing on a stale catalog, warns once, and subscribes on the first fresh tick', async () => {
    await withBroker();
    const h = harness({ view: undefined });
    await h.manager.tick();
    await bothReady(h);
    await h.manager.tick();
    expect(h.logs('market data catalog not fresh')).toHaveLength(1);
    expect(h.clients[0]?.subscribeCalls).toEqual([]);
    expect(socketsOf(1)[0]?.subscriptions).toEqual([]);

    h.catalog.view = freshView();
    await h.manager.tick();
    await until('subscribed', () => socketsOf(1)[0]?.subscriptions.length === 45);
    expect(h.clients[0]?.subscribeCalls).toHaveLength(1);
  });

  it('M9b subscribes only the new pairs when the catalog grows', async () => {
    await withBroker();
    const h = harness({ view: freshView(PAIRS.slice(0, 30)) });
    await h.manager.tick();
    await bothReady(h);
    await until('subscribed', () => socketsOf(1)[0]?.subscriptions.length === 30);
    h.catalog.view = freshView();
    await h.manager.tick();
    await until('the new pairs', () => socketsOf(1)[0]?.subscriptions.length === 45);
    const calls = h.clients[0]?.subscribeCalls ?? [];
    expect(calls).toHaveLength(2);
    expect([...(calls[1] ?? [])].sort((a, b) => a - b)).toEqual(
      PAIRS.slice(30)
        .map((pair) => pair.id)
        .sort((a, b) => a - b),
    );
  });

  it.each(['connecting', 'ready', 'grace', 'hold-back'] as const)(
    'M10 stops in %s: no socket, no timer and no line after',
    async (phase) => {
      const mock = await withBroker();
      // the first reconnection (200 ms) comes before the grace ends (300 ms)
      const h = harness({
        config: { failoverGraceMs: 300 },
        timing: { reconnectDelayMs: 200, reconnectDelayMaxMs: 400 },
      });
      await h.manager.tick();
      if (phase !== 'connecting') await bothReady(h);
      if (phase === 'grace') {
        mock.socket.cutTransport({ userId: 1 });
        await until(
          'the active reconnecting',
          () => h.clients[0]?.client.state === BrokerSocketState.Reconnecting,
        );
      }
      if (phase === 'hold-back') {
        mock.socket.disconnect({ userId: 2 });
        await until('the reserve held back', () => h.line().held === 1);
      }
      const written = h.lines.length;
      await h.manager.stop();
      h.manager.report();
      await until('no socket', () => mock.socket.sockets().length === 0);
      await pastGrace();
      expect(
        h.lines.slice(written).map((line) => (JSON.parse(line) as LogEntry).msg),
      ).not.toContain('market data failover');
      expect(
        h.lines.slice(written).map((line) => (JSON.parse(line) as LogEntry).msg),
      ).not.toContain('market data');
      expect(mock.socket.sockets()).toEqual([]);
      for (const { client } of h.clients) expect(client.state).toBe(BrokerSocketState.Idle);
    },
  );

  it('M12 counts a price of a pair outside the catalog and builds nothing for it', async () => {
    const mock = await withBroker();
    const h = harness();
    await h.manager.tick();
    await bothReady(h);
    h.line();
    let heard = false;
    // registered after the manager's listener: the price is counted when this one runs
    h.clients[0]?.client.onEvent((event) => {
      if (event.type === BrokerEventType.PriceUpdate) heard = true;
    });
    mock.socket.emitRaw(
      { userId: 1 },
      BrokerSocketEvent.PriceUpdate,
      encodeSocketPayload([999, 1.1, Date.now()], MockSocketPayload.Bytes),
    );
    await until('the price heard', () => heard);
    expect(h.line().unknownAsset).toBe(1);
    expect(h.ring.counters().pairs).toBe(0);
  });

  it('M12b leaves out a catalog pair whose digits a builder would refuse', async () => {
    await withBroker();
    const [odd, ...rest] = PAIRS as [BinaryPair, ...BinaryPair[]];
    const h = harness({ view: freshView([{ ...odd, digits: 99 }, ...rest]) });
    await h.manager.tick();
    await bothReady(h);
    await until('subscribed', () => socketsOf(1)[0]?.subscriptions.length === 44);
    expect(socketsOf(1)[0]?.subscriptions).not.toContain(odd.id);
    expect(h.line()).toMatchObject({ skippedDigits: 1 });
  });

  it('M13 logs a throwing token read by name and code, holds the account back and goes on', async () => {
    await withBroker();
    const h = harness();
    h.answers.set(ACC1.id, () =>
      Promise.reject(Object.assign(new Error('SECRET-in-a-message'), { code: 'ECONNRESET' })),
    );
    await h.manager.tick();
    const [threw] = h.logs('market data token threw');
    expect(threw).toMatchObject({
      role: 'active',
      accountId: ACC1.id,
      err: { name: 'Error', code: 'ECONNRESET' },
    });
    expect(JSON.stringify(threw)).not.toContain('SECRET');
    await until('the active on account 2', () => h.line().active?.socketState === 'ready');
    expect(h.line()).toMatchObject({ held: 1, active: { accountId: ACC2.id }, reserve: null });
  });

  it('M13b logs a failed tick by name and code and keeps the timer', async () => {
    await withBroker();
    let fail = true;
    const h = harness({
      listAccounts: () =>
        fail
          ? Promise.reject(Object.assign(new Error('SECRET-in-a-message'), { code: '57014' }))
          : Promise.resolve([ACC1]),
    });
    await h.manager.tick();
    expect(h.logs('market data tick failed')).toEqual([
      expect.objectContaining({ err: { name: 'Error', code: '57014' } }),
    ]);
    fail = false;
    await h.manager.tick();
    await until('the active ready', () => h.line().active?.socketState === 'ready');
  });

  it('M14 ends the tick on the broker rate limit', async () => {
    await withBroker();
    const h = harness();
    h.answers.set(ACC1.id, () => Promise.resolve({ ok: false, reason: 'refresh_rate_limited' }));
    await h.manager.tick();
    expect(h.calls.map((call) => call.accountId)).toEqual([ACC1.id]);
    expect(h.line()).toMatchObject({ held: 1, active: null, reserve: null });
    expect(h.clients).toEqual([]);
  });
});

describe('the market data manager and a refused token (#404, decision 7a)', () => {
  const tickAll = async (h: Harness) => {
    await h.manager.tick();
    return h;
  };

  it.each([
    ['one account', [ACC1], () => true],
    ['a reserve not ready', [ACC1, ACC2], (index: number) => index === 0],
  ] as const)(
    'M7 exchanges the token in place without a ready reserve: %s',
    async (_label, accounts, ready) => {
      const fakes = fakeClients(ready);
      const h = await tickAll(harness({ accounts: [...accounts], openClient: fakes.openClient }));
      const [active] = fakes.made;
      const made = fakes.made.length;
      const subscriptions = active?.subscriptions();
      h.answers.set(ACC1.id, () => Promise.resolve({ ok: true, accessToken: 'SECRET-token-1b' }));
      active?.fire(BrokerSocketState.TokenExpired);
      await until('the new token', () => active?.starts.length === 2);
      expect(active?.starts).toEqual([TOKEN_1, 'SECRET-token-1b']);
      expect(h.calls.at(-1)).toEqual({
        accountId: ACC1.id,
        options: { ...SERVICE, refusedToken: hashToken(TOKEN_1) },
      });
      expect(fakes.made).toHaveLength(made);
      expect(active?.subscriptions()).toEqual(subscriptions);
      expect(h.line()).toMatchObject({
        failovers: 0,
        held: 0,
        active: { accountId: ACC1.id, socketState: 'ready' },
      });
      expect(fakes.made[1]?.stops ?? 0).toBe(0);
    },
  );

  it('M7b holds the only account back when the exchange is refused', async () => {
    const fakes = fakeClients();
    const h = await tickAll(
      harness({
        accounts: [ACC1],
        openClient: fakes.openClient,
        config: { accountRetryMs: 3_600_000 },
      }),
    );
    const [active] = fakes.made;
    // only the exchange is refused: a start without the hold-back would get a token and a client
    h.answers.set(ACC1.id, (options) =>
      Promise.resolve(
        options.refusedToken === undefined
          ? { ok: true, accessToken: 'SECRET-token-1c' }
          : { ok: false, reason: 'not_service' },
      ),
    );
    active?.fire(BrokerSocketState.AuthFailed);
    await until('dropped', () => active?.stops === 1);
    expect(h.line()).toMatchObject({ held: 1, active: null, reserve: null });
    expect(h.calls).toHaveLength(2);
    const calls = h.calls.length;
    await h.manager.tick();
    expect(h.calls).toHaveLength(calls);
    expect(fakes.made).toHaveLength(1);
  });

  it.each([BrokerSocketState.TokenExpired, BrokerSocketState.AuthFailed])(
    'M7c switches to the ready reserve at once on %s and reports the token by the next reserve',
    async (state) => {
      const fakes = fakeClients();
      const h = await tickAll(harness({ openClient: fakes.openClient }));
      const [active, reserve] = fakes.made;
      const exchange = deferred<AccessTokenResult>();
      h.answers.set(ACC1.id, () => exchange.promise);
      active?.fire(state);
      expect(reserve?.subscriptions()).toEqual(IDS);
      expect(active?.stops).toBe(1);
      expect(fakes.made).toHaveLength(2);
      expect(h.logs('market data failover')).toEqual([
        expect.objectContaining({ from: ACC1.id, to: ACC2.id, reason: state }),
      ]);
      expect(h.line()).toMatchObject({ failovers: 1, active: { accountId: ACC2.id } });

      exchange.resolve({ ok: true, accessToken: 'SECRET-token-1b' });
      await until('the new reserve', () => h.line().reserve?.socketState === 'ready');
      const [, , next] = fakes.made;
      expect(next?.starts).toEqual(['SECRET-token-1b']);
      expect(next?.subscribeCalls).toEqual([]);
      expect(h.line()).toMatchObject({
        held: 0,
        reserve: { accountId: ACC1.id, socketState: 'ready' },
      });
      expect(h.calls.filter((call) => call.accountId === ACC1.id)).toEqual([
        { accountId: ACC1.id, options: SERVICE },
        { accountId: ACC1.id, options: { ...SERVICE, refusedToken: hashToken(TOKEN_1) } },
      ]);
    },
  );

  it('M7c holds the account back on a rate-limited exchange and tries no other', async () => {
    const fakes = fakeClients();
    const h = await tickAll(
      harness({ accounts: [ACC1, ACC2, ACC3], openClient: fakes.openClient }),
    );
    h.answers.set(ACC1.id, () => Promise.resolve({ ok: false, reason: 'refresh_rate_limited' }));
    fakes.made[0]?.fire(BrokerSocketState.TokenExpired);
    await until('the exchange answered', () => h.logs('market data token refused').length === 1);
    expect(h.calls.map((call) => call.accountId)).not.toContain(ACC3.id);
    expect(fakes.made).toHaveLength(2);
    expect(h.line()).toMatchObject({ held: 1, active: { accountId: ACC2.id }, reserve: null });
  });

  it('M7d exchanges the token of the reserve in place, with no subscription and no failover', async () => {
    const fakes = fakeClients();
    const h = await tickAll(harness({ openClient: fakes.openClient }));
    const [active, reserve] = fakes.made;
    h.answers.set(ACC2.id, () => Promise.resolve({ ok: true, accessToken: 'SECRET-token-2b' }));
    reserve?.fire(BrokerSocketState.TokenExpired);
    await until('the new token', () => reserve?.starts.length === 2);
    expect(reserve?.starts).toEqual([TOKEN_2, 'SECRET-token-2b']);
    expect(reserve?.subscribeCalls).toEqual([]);
    expect(active?.stops).toBe(0);
    expect(active?.starts).toEqual([TOKEN_1]);
    expect(h.line()).toMatchObject({ failovers: 0, active: { accountId: ACC1.id } });
  });

  it('M10 opens nothing for a reserve start still waiting on its token at stop()', async () => {
    const fakes = fakeClients();
    const h = await tickAll(harness({ openClient: fakes.openClient }));
    const exchange = deferred<AccessTokenResult>();
    h.answers.set(ACC1.id, () => exchange.promise);
    fakes.made[0]?.fire(BrokerSocketState.TokenExpired);
    const stopped = h.manager.stop();
    exchange.resolve({ ok: true, accessToken: 'SECRET-token-1b' });
    await stopped;
    expect(fakes.made).toHaveLength(2);
    for (const client of fakes.made) expect(client.stops).toBeGreaterThanOrEqual(1);
    const written = h.lines.length;
    h.manager.report();
    expect(h.lines).toHaveLength(written);
  });

  it('M15 takes prices on the active before any user.data', async () => {
    const fakes = fakeClients();
    const h = await tickAll(harness({ openClient: fakes.openClient }));
    const [active, reserve] = fakes.made;
    const now = Date.now();
    active?.hear({
      type: BrokerEventType.PriceUpdate,
      update: { assetId: IDS[0] ?? 0, price: 1.1, timestamp: now },
    });
    reserve?.hear({
      type: BrokerEventType.PriceUpdate,
      update: { assetId: IDS[1] ?? 0, price: 1.1, timestamp: now },
    });
    expect(h.ring.counters().pairs).toBe(1);
    expect(h.ring.read(IDS[0] ?? 0, '5s', now).forming).toBeDefined();
    expect(h.ring.read(IDS[1] ?? 0, '5s', now).forming).toBeUndefined();
  });

  it('M16 hands the refused token to the token service only as its hash, never to a client or a log', async () => {
    const fakes = fakeClients();
    const h = await tickAll(harness({ accounts: [ACC1], openClient: fakes.openClient }));
    h.answers.set(ACC1.id, () => Promise.resolve({ ok: true, accessToken: 'SECRET-token-1b' }));
    fakes.made[0]?.fire(BrokerSocketState.TokenExpired);
    await until('the new token', () => fakes.made[0]?.starts.length === 2);
    const hash = hashToken(TOKEN_1);
    expect(fakes.made.flatMap((client) => client.starts)).not.toContain(hash);
    expect(h.lines.join('\n')).not.toContain(hash);
    expect(h.lines.join('\n')).not.toContain('SECRET');
  });
});

describe('the market data manager and an empty active slot (#404, I1)', () => {
  it('M17a promotes a reserve that becomes ready after the switch left the active slot empty', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    const reserveToken = deferred<AccessTokenResult>();
    h.answers.set(ACC2.id, () => reserveToken.promise);
    const ticked = h.manager.tick();
    await until('the reserve start waits', () => h.calls.length === 2);
    const [active] = fakes.made;
    active?.fire(BrokerSocketState.DisconnectedByServer);
    expect(h.logs('market data failover')).toEqual([
      expect.objectContaining({ from: ACC1.id, to: null }),
    ]);
    expect(active?.stops).toBe(1);

    reserveToken.resolve({ ok: true, accessToken: TOKEN_2 });
    await ticked;
    const [, promoted] = fakes.made;
    expect(subscribed(promoted)).toEqual([IDS]);
    expect(h.logs('market data reserve promoted')).toEqual([
      expect.objectContaining({ to: ACC2.id }),
    ]);
    expect(h.line()).toMatchObject({
      active: { accountId: ACC2.id, socketState: 'ready', subscriptions: 45 },
      reserve: null,
      failovers: 1,
    });
    await h.manager.tick();
    await h.manager.tick();
    expect(h.logs('market data: no working service account')).toEqual([]);
    expect(fakes.made).toHaveLength(2);
  });

  it('M17b promotes the reserve started with the refused token when the new active fails too', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    await h.manager.tick();
    const [first, second] = fakes.made;
    const exchange = deferred<AccessTokenResult>();
    h.answers.set(ACC1.id, () => exchange.promise);
    first?.fire(BrokerSocketState.TokenExpired);
    second?.fire(BrokerSocketState.DisconnectedByServer);
    expect(h.logs('market data failover')).toEqual([
      expect.objectContaining({ from: ACC1.id, to: ACC2.id }),
      expect.objectContaining({ from: ACC2.id, to: null }),
    ]);

    exchange.resolve({ ok: true, accessToken: 'SECRET-token-1b' });
    await until('the promotion', () => h.logs('market data reserve promoted').length === 1);
    const [, , third] = fakes.made;
    expect(subscribed(third)).toEqual([IDS]);
    expect(third?.starts).toEqual(['SECRET-token-1b']);
    expect(h.logs('market data reserve promoted')[0]).toMatchObject({ to: ACC1.id });
    expect(h.calls.filter((call) => call.accountId === ACC1.id)).toEqual([
      { accountId: ACC1.id, options: SERVICE },
      { accountId: ACC1.id, options: { ...SERVICE, refusedToken: hashToken(TOKEN_1) } },
    ]);
    expect(h.line()).toMatchObject({
      failovers: 2,
      active: { accountId: ACC1.id, socketState: 'ready' },
    });
  });

  it.each([
    ['the active start finds no client', [ACC1, ACC2, ACC3], 'not_service'],
    [
      'the broker rate limit ends the active start',
      [ACC1, ACC2, ACC3, ACC4],
      'refresh_rate_limited',
    ],
  ] as const)(
    'M17c keeps a reserve that is not ready at the switch and promotes it when %s',
    async (_label, accounts, reason) => {
      // the reserve (client 1) stays authenticating until it is fired ready
      const fakes = fakeClients((index) => index !== 1);
      const h = harness({ accounts: [...accounts], openClient: fakes.openClient });
      await h.manager.tick();
      const [active, reserve] = fakes.made;
      const answer = deferred<AccessTokenResult>();
      h.answers.set(ACC3.id, () => answer.promise);
      active?.fire(BrokerSocketState.DisconnectedByServer);
      expect(reserve?.stops).toBe(0);
      expect(h.calls.at(-1)?.accountId).toBe(ACC3.id);

      reserve?.fire(BrokerSocketState.Ready);
      expect(reserve?.subscribeCalls).toEqual([]);
      expect(h.line().active).toMatchObject({ accountId: ACC3.id, socketState: 'starting' });

      answer.resolve({ ok: false, reason });
      await until('the promotion', () => h.logs('market data reserve promoted').length === 1);
      await settled();
      expect(subscribed(reserve)).toEqual([IDS]);
      expect(h.logs('market data reserve promoted')[0]).toMatchObject({ to: ACC2.id });
      expect(h.calls.map((call) => call.accountId)).not.toContain(ACC4.id);
      expect(fakes.made).toHaveLength(2);
      expect(h.line()).toMatchObject({
        active: { accountId: ACC2.id, socketState: 'ready' },
        reserve: null,
      });
    },
  );

  it('M17d keeps a reserve exchanging its token at the switch and promotes it after the exchange', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    await h.manager.tick();
    const [active, reserve] = fakes.made;
    const exchange = deferred<AccessTokenResult>();
    h.answers.set(ACC2.id, () => exchange.promise);
    reserve?.fire(BrokerSocketState.TokenExpired);
    active?.fire(BrokerSocketState.DisconnectedByServer);
    expect(reserve?.stops).toBe(0);
    expect(h.line()).toMatchObject({
      active: null,
      reserve: { accountId: ACC2.id, socketState: 'refreshing' },
    });

    exchange.resolve({ ok: true, accessToken: 'SECRET-token-2b' });
    await until('the promotion', () => h.logs('market data reserve promoted').length === 1);
    expect(reserve?.starts).toEqual([TOKEN_2, 'SECRET-token-2b']);
    expect(subscribed(reserve)).toEqual([IDS]);
    expect(fakes.made).toHaveLength(2);
    expect(h.line()).toMatchObject({ active: { accountId: ACC2.id, socketState: 'ready' } });
  });

  it('M17e starts the active and a new reserve at once on a switch with no reserve', async () => {
    const fakes = fakeClients();
    const h = harness({ accounts: [ACC1, ACC2, ACC3, ACC4], openClient: fakes.openClient });
    await h.manager.tick();
    const [active, reserve] = fakes.made;
    reserve?.fire(BrokerSocketState.DisconnectedByServer);
    expect(h.line().reserve).toBeNull();
    const before = h.calls.length;
    active?.fire(BrokerSocketState.DisconnectedByServer);
    expect(h.calls.slice(before).map((call) => call.accountId)).toEqual([ACC3.id, ACC4.id]);
    await until('the new pair of clients', () => fakes.made.length === 4);
    const [, , nextActive, nextReserve] = fakes.made;
    expect(subscribed(nextActive)).toEqual([IDS]);
    expect(nextReserve?.subscribeCalls).toEqual([]);
    expect(h.line()).toMatchObject({
      active: { accountId: ACC3.id, socketState: 'ready' },
      reserve: { accountId: ACC4.id, socketState: 'ready' },
    });
  });
});

describe('the market data manager and a throwing client start (#404, I3)', () => {
  it('M18a holds an account back whose client throws on the tick, and goes on to the next', async () => {
    const fakes = fakeClients(undefined, (index) => index === 0);
    const h = harness({ accounts: [ACC1, ACC2, ACC3], openClient: fakes.openClient });
    await h.manager.tick();
    const [threw] = h.logs('market data socket start threw');
    expect(threw).toMatchObject({
      role: 'active',
      accountId: ACC1.id,
      err: { name: 'TypeError' },
    });
    expect(Object.keys((threw?.err as object | undefined) ?? {})).not.toContain('message');
    expect(h.logs('market data tick failed')).toEqual([]);
    const [broken, active] = fakes.made;
    expect(broken?.stops).toBe(1);
    // detached: its events reach no handler
    broken?.fire(BrokerSocketState.DisconnectedByServer);
    expect(h.logs('market data failover')).toEqual([]);
    expect(subscribed(active)).toEqual([IDS]);
    expect(h.line()).toMatchObject({
      held: 1,
      active: { accountId: ACC2.id, socketState: 'ready' },
      reserve: { accountId: ACC3.id, socketState: 'ready' },
    });
  });

  it('M18b holds an account back whose client throws in a reserve start after a switch', async () => {
    const fakes = fakeClients(undefined, (index) => index === 2);
    const h = harness({ accounts: [ACC1, ACC2, ACC3], openClient: fakes.openClient });
    await h.manager.tick();
    fakes.made[0]?.fire(BrokerSocketState.DisconnectedByServer);
    await until('the reserve start', () => fakes.made.length === 3);
    await settled();
    expect(h.logs('market data socket start threw')).toEqual([
      expect.objectContaining({ role: 'reserve', accountId: ACC3.id }),
    ]);
    expect(h.logs('market data work failed')).toEqual([]);
    expect(h.line()).toMatchObject({
      held: 2,
      active: { accountId: ACC2.id, socketState: 'ready' },
      reserve: null,
    });
  });

  it('M18c fails the account over when the client throws on the start after an exchange', async () => {
    const fakes = fakeClients(undefined, (index, start) => index === 0 && start === 2);
    const h = harness({ accounts: [ACC1], openClient: fakes.openClient });
    await h.manager.tick();
    h.answers.set(ACC1.id, () => Promise.resolve({ ok: true, accessToken: 'SECRET-token-1b' }));
    fakes.made[0]?.fire(BrokerSocketState.TokenExpired);
    await until('the second start', () => fakes.made[0]?.starts.length === 2);
    await settled();
    expect(h.logs('market data socket start threw')).toEqual([
      expect.objectContaining({ role: 'active', accountId: ACC1.id }),
    ]);
    expect(h.logs('market data failover')).toEqual([
      expect.objectContaining({ from: ACC1.id, to: null, reason: 'token_refused' }),
    ]);
    expect(h.line()).toMatchObject({ held: 1, active: null, reserve: null });
  });
});

// docs/market-data.md -> The log: every message the manager writes is in the table, and every
// row of the table but the backstop was written by some case above
const DOCUMENTED = [
  ...readFileSync(
    fileURLToPath(new URL('../../../../docs/market-data.md', import.meta.url)),
    'utf8',
  ).matchAll(/^\| `(market data[^`]*)` \|/gm),
].map((match) => match[1]);

// track()'s catch: every work catches its own throws (I3), so no case reaches it
const UNREACHABLE = ['market data work failed'];

describe('the market data log (#404)', () => {
  afterAll(() => {
    allLines.length = 0;
  });

  // reads the lines of every case above (allLines): alone (-t M11) or shuffled it fails falsely,
  // never passes falsely; vitest.config.ts pins the order
  it('M11 writes the documented messages, the line with its fields, and no token, URL or payload', () => {
    const entries = allLines.map((line) => JSON.parse(line) as LogEntry);
    const written = new Set(
      entries.map((entry) => entry.msg).filter((msg) => msg.startsWith('market data')),
    );
    const documented = new Set(DOCUMENTED);
    expect([...written].filter((msg) => !documented.has(msg))).toEqual([]);
    expect([...documented].filter((msg) => msg !== undefined && !written.has(msg))).toEqual(
      UNREACHABLE,
    );
    const line = entries.find((entry) => entry.msg === 'market data' && entry.active !== null);
    const own = Object.keys(line ?? {}).filter(
      (key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key),
    );
    expect(own.sort()).toEqual(
      [
        'accounts',
        'held',
        'active',
        'reserve',
        'ticks',
        'ticksPerSec',
        'late',
        'invalid',
        'skewed',
        'holed',
        'unknownAsset',
        'skippedDigits',
        'holes',
        'lateClose',
        'failovers',
        'watermarkLagMs',
        'closed',
        'pairs',
        'pending',
      ].sort(),
    );
    const text = allLines.join('\n');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('"price"');
  });
});
