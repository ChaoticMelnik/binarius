import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BrokerSocketEvent,
  SIGNAL_CHART_INTERVAL_MS,
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
import { createBrokerRestClient } from '@binarius/broker-rest';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import { createScanPacer } from '../signal/pacer';
import { createCandleBackfill, type CandleBackfill } from './backfill';
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
  reserveReadyMs: 3_600_000,
  accountRetryMs: 3_600_000,
};
// a negative wait past a 300 ms grace and every case's reserve budget: a failover, promotion or
// rotation that was going to happen has happened
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
  label: string;
  starts: string[];
  stops: number;
  subscribeCalls: number[][];
  fire(state: BrokerSocketState): void;
  hear(event: BrokerEvent): void;
}

// the worker's fakeClients (session-manager.test.ts) with a subscription registry. The state after
// start() is per account and per start of that account (1-based), so a broken account breaks again
// on its next client; throwOnStart throws as the client does on invalid credentials
function fakeClients(
  stateOnStart: (label: string, start: number) => BrokerSocketState = () => BrokerSocketState.Ready,
  throwOnStart: (label: string) => boolean = () => false,
) {
  const made: FakeClient[] = [];
  const openClient = (label: string): BrokerSocketClient => {
    const start = made.filter((client) => client.label === label).length + 1;
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
      label,
      starts: [],
      stops: 0,
      subscribeCalls: [],
      fire: publish,
      hear(event) {
        for (const listener of [...eventListeners]) listener(event);
      },
      start(credentials) {
        client.starts.push(credentials.accessToken);
        if (throwOnStart(label)) throw new TypeError('broker socket credentials are invalid');
        publish(stateOnStart(label, start));
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
  // the real backfill with the option, over the mock broker's REST
  backfill: CandleBackfill | undefined;
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
const backfills: CandleBackfill[] = [];

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
    backfill?: boolean;
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
  const requests = createPendingRequests(288);
  const backfill =
    options.backfill === true
      ? createCandleBackfill({
          ring,
          requests,
          catalog: { read: () => catalog.view },
          rest: {
            getChart: (request, callOptions) => {
              if (broker === undefined) throw new Error('no mock broker in this test');
              return createBrokerRestClient({ baseUrl: broker.url }).getChart(request, callOptions);
            },
          },
          // the bucket fills in a millisecond: every poll finds an overflow token
          pacer: createScanPacer({
            perMinute: 6_000_000,
            capacity: 1,
            backoffMinMs: 15_000,
            backoffMaxMs: 120_000,
            now: Date.now,
          }),
          streaming: () => manager.streaming(),
          logger,
          config: {
            scanMs: 3_600_000,
            pollMs: 3_600_000,
            retryMs: 15_000,
            attempts: 3,
            budgetMs: 3_000,
            // fewer rounds of the 90 GETs inside the wait ceiling
            concurrency: 8,
            slackMs: 500,
            candles: 300,
          },
        })
      : undefined;
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
    requests,
    backfill: backfill ?? {
      counters: () => ({ queued: 0, fetched: 0, filled: 0, failed: 0, rateLimited: 0, spare: 0 }),
    },
    logger,
    config: { ...CONFIG, ...options.config },
  });
  managers.push(manager);
  if (backfill !== undefined) backfills.push(backfill);
  const parsed = (msg: string) =>
    lines.map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry.msg === msg);
  return {
    manager,
    ring,
    backfill,
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
const reporting = (token: string) => ({ ...SERVICE, refusedToken: hashToken(token) });

// one client at a time: with a short grace, a reserve ready before a slow fresh active is promoted
async function startInOrder(h: Harness) {
  h.accounts.list = [ACC1];
  await h.manager.tick();
  await until('the active ready', () => h.line().active?.socketState === 'ready');
  h.accounts.list = [ACC1, ACC2];
  await h.manager.tick();
  await bothReady(h);
}

// S1, S2: at most two live clients, exactly the ones in the slots, never one account in both
function expectSafe(h: Harness, made: FakeClient[]) {
  const { active, reserve } = h.line();
  const live = made.filter((client) => client.starts.length > client.stops);
  const held = [active, reserve].filter((slot) => slot !== null && slot.socketState !== 'starting');
  expect(live.length).toBeLessThanOrEqual(2);
  expect(live.map((client) => client.label).sort()).toEqual(
    held.map((slot) => slot?.accountId).sort(),
  );
  if (active !== null && reserve !== null) expect(active.accountId).not.toBe(reserve.accountId);
}

// `market data <what>` written once so far, with these fields
function once(h: Harness, what: string, fields: Record<string, unknown>) {
  const entries = h.logs(`market data ${what}`);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject(fields);
}

const readyOn = (slot: Line['active'] | Line['reserve'], account: MarketDataAccount) =>
  slot?.accountId === account.id && slot.socketState === 'ready';

const price = (assetId: number | undefined, timestamp: number): BrokerEvent => ({
  type: BrokerEventType.PriceUpdate,
  update: { assetId: assetId ?? 0, price: 1.1, timestamp },
});

afterEach(async () => {
  for (const backfill of backfills.splice(0)) await backfill.stop();
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
    once(h, 'failover', { from: ACC1.id, reason: BrokerSocketState.DisconnectedByServer });
    once(h, 'reserve promoted', { to: ACC2.id });
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
    await startInOrder(h);
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
    once(h, 'failover', { from: ACC1.id, reason: BrokerSocketState.DisconnectedByServer });
    once(h, 'reserve promoted', { to: ACC2.id });
    expect(h.line()).toMatchObject({ held: 1, reserve: null });
  });

  it('M5b switches when the grace runs out, and keeps the account as the first reserve', async () => {
    const mock = await withBroker();
    const h = harness({ config: { failoverGraceMs: 1 } });
    await startInOrder(h);
    // the grace (1 ms) ends before the client's first reconnection (20 ms)
    mock.socket.cutTransport({ userId: 1 });
    await until('the failover', () => h.logs('market data failover').length === 1);
    once(h, 'failover', { from: ACC1.id, reason: 'not_ready', heldBack: false });
    once(h, 'reserve promoted', { to: ACC2.id });
    await until('a reserve on account 1', () => readyOn(h.line().reserve, ACC1));
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
    once(h, 'failover', { from: ACC1.id, reason: 'foreign_user' });
    once(h, 'reserve promoted', { to: ACC2.id });
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
    once(h, 'failover', { from: ACC1.id });
    expect(h.logs('market data reserve promoted')).toEqual([]);
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
      if (phase === 'connecting') await h.manager.tick();
      else await startInOrder(h);
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
      const calls = h.calls.length;
      h.manager.report();
      await h.manager.tick();
      await until('no socket', () => mock.socket.sockets().length === 0);
      await pastGrace();
      expect(h.calls).toHaveLength(calls);
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
    expect(h.logs('market data: no working service account')).toEqual([]);
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

  it('M14 holds only the rate-limited account', async () => {
    await withBroker();
    const h = harness();
    h.answers.set(ACC1.id, () => Promise.resolve({ ok: false, reason: 'refresh_rate_limited' }));
    await h.manager.tick();
    expect(h.calls.map((call) => call.accountId)).toEqual([ACC1.id, ACC2.id]);
    await until('the active on account 2', () => h.line().active?.socketState === 'ready');
    expect(h.line()).toMatchObject({ held: 1, active: { accountId: ACC2.id }, reserve: null });
  });
});

const { Connecting, Authenticating, Ready, Reconnecting, TokenExpired, AuthFailed } =
  BrokerSocketState;
const DISCONNECTED = BrokerSocketState.DisconnectedByServer;
const by =
  (states: Record<string, BrokerSocketState>) =>
  (label: string): BrokerSocketState =>
    states[label] ?? Ready;

describe('the market data manager and a refused token (#404, decision 7a)', () => {
  it.each([
    [TokenExpired, [ACC1]],
    [AuthFailed, [ACC1]],
    [TokenExpired, [ACC1, ACC2]],
    [AuthFailed, [ACC1, ACC2]],
  ] as const)(
    'M7 restarts the account with the refused token on %s without a ready reserve (%#)',
    async (state, accounts) => {
      // the reserve, when there is one, stays authenticating
      const fakes = fakeClients(by({ [ACC2.id]: Authenticating }));
      const h = harness({ accounts: [...accounts], openClient: fakes.openClient });
      await h.manager.tick();
      h.answers.set(ACC1.id, () => Promise.resolve({ ok: true, accessToken: 'SECRET-token-1b' }));
      fakes.made[0]?.fire(state);
      expect(fakes.made[0]?.stops).toBe(1);
      once(h, 'failover', { from: ACC1.id, reason: state, heldBack: false });
      expect(h.calls.at(-1)).toEqual({ accountId: ACC1.id, options: reporting(TOKEN_1) });
      await settled();
      const next = fakes.made.at(-1);
      expect(next?.label).toBe(ACC1.id);
      expect(next?.starts).toEqual(['SECRET-token-1b']);
      expect(subscribed(next)).toEqual([IDS]);
      expect(h.line()).toMatchObject({
        held: 0,
        active: { accountId: ACC1.id, socketState: 'ready' },
      });
      expect(fakes.made.find((client) => client.label === ACC2.id)?.stops ?? 0).toBe(0);
      expectSafe(h, fakes.made);
    },
  );

  it('M7b holds the only account back when the start after a refusal is refused', async () => {
    const fakes = fakeClients();
    const h = harness({ accounts: [ACC1], openClient: fakes.openClient });
    await h.manager.tick();
    // only the reporting start is refused: a start without the hold-back would get a client
    h.answers.set(ACC1.id, (options) =>
      Promise.resolve(
        options.refusedToken === undefined
          ? { ok: true, accessToken: 'SECRET-token-1c' }
          : { ok: false, reason: 'not_service' },
      ),
    );
    fakes.made[0]?.fire(AuthFailed);
    await settled();
    once(h, 'token refused', { role: 'active', accountId: ACC1.id, reason: 'not_service' });
    expect(h.line()).toMatchObject({ held: 1, active: null, reserve: null });
    const calls = h.calls.length;
    await h.manager.tick();
    expect(h.calls).toHaveLength(calls);
    expect(fakes.made).toHaveLength(1);
    expectSafe(h, fakes.made);
  });

  it.each([TokenExpired, AuthFailed])(
    'M7c promotes the ready reserve at once on %s and reports the token once, by the next start on the account',
    async (state) => {
      const fakes = fakeClients();
      const h = harness({ openClient: fakes.openClient });
      await h.manager.tick();
      const [active, reserve] = fakes.made;
      const answer = deferred<AccessTokenResult>();
      h.answers.set(ACC1.id, () => answer.promise);
      active?.fire(state);
      expect(subscribed(reserve)).toEqual([IDS]);
      expect(active?.stops).toBe(1);
      once(h, 'failover', { from: ACC1.id, reason: state, heldBack: false });
      expect(h.calls.filter((call) => call.accountId === ACC1.id)).toEqual([
        { accountId: ACC1.id, options: SERVICE },
        { accountId: ACC1.id, options: reporting(TOKEN_1) },
      ]);

      answer.resolve({ ok: true, accessToken: 'SECRET-token-1b' });
      await settled();
      expect(fakes.made[2]?.starts).toEqual(['SECRET-token-1b']);
      expect(fakes.made[2]?.subscribeCalls).toEqual([]);
      expect(h.line()).toMatchObject({
        held: 0,
        active: { accountId: ACC2.id },
        reserve: { accountId: ACC1.id, socketState: 'ready' },
      });
      h.answers.delete(ACC1.id);
      h.accounts.list = [ACC2];
      await h.manager.tick();
      expect(h.line().reserve).toBeNull();
      h.accounts.list = [ACC1, ACC2];
      await h.manager.tick();
      expect(h.calls.at(-1)).toEqual({ accountId: ACC1.id, options: SERVICE });
      expectSafe(h, fakes.made);
    },
  );

  it('M7d restarts the reserve with the refused token, with no subscription and no failover', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    await h.manager.tick();
    const [active, reserve] = fakes.made;
    h.answers.set(ACC2.id, () => Promise.resolve({ ok: true, accessToken: 'SECRET-token-2b' }));
    reserve?.fire(TokenExpired);
    once(h, 'reserve stopped', { accountId: ACC2.id, reason: TokenExpired, heldBack: false });
    expect(h.calls.at(-1)).toEqual({ accountId: ACC2.id, options: reporting(TOKEN_2) });
    await settled();
    expect(fakes.made[2]?.starts).toEqual(['SECRET-token-2b']);
    expect(fakes.made[2]?.subscribeCalls).toEqual([]);
    expect(active?.stops).toBe(0);
    expect(h.line()).toMatchObject({
      failovers: 0,
      active: { accountId: ACC1.id },
      reserve: { accountId: ACC2.id, socketState: 'ready' },
    });
    expectSafe(h, fakes.made);
  });

  it('M7e holds the account back on its second token refusal within the retry window', async () => {
    const fakes = fakeClients();
    const h = harness({
      accounts: [ACC1],
      openClient: fakes.openClient,
      config: { accountRetryMs: 200 },
    });
    await h.manager.tick();
    const tokens = ['SECRET-token-1b', 'SECRET-token-1c'];
    h.answers.set(ACC1.id, () =>
      Promise.resolve({ ok: true, accessToken: tokens.shift() ?? 'SECRET-token-1d' }),
    );
    fakes.made[0]?.fire(TokenExpired);
    await settled();
    expect(fakes.made).toHaveLength(2);
    const calls = h.calls.length;
    fakes.made[1]?.fire(TokenExpired);
    expect(h.logs('market data failover').map((entry) => entry.heldBack)).toEqual([false, true]);
    await settled();
    expect(h.calls).toHaveLength(calls);
    await until('the start after the hold-back', async () => {
      await h.manager.tick();
      return h.calls.length > calls;
    });
    expect(h.calls.at(-1)).toEqual({ accountId: ACC1.id, options: reporting('SECRET-token-1b') });
    expectSafe(h, fakes.made);
  });

  it.each(['token', 'list'] as const)(
    'M10b opens nothing and asks for no token after stop() with the %s read in flight',
    async (inFlight) => {
      const fakes = fakeClients();
      const list = deferred<readonly MarketDataAccount[]>();
      const h = harness({
        accounts: [ACC1],
        openClient: fakes.openClient,
        ...(inFlight === 'list' ? { listAccounts: () => list.promise } : {}),
      });
      const answer = deferred<AccessTokenResult>();
      h.answers.set(ACC1.id, () => answer.promise);
      void h.manager.tick();
      await settled();
      const stopped = h.manager.stop();
      list.resolve([ACC1]);
      answer.resolve({ ok: true, accessToken: TOKEN_1 });
      await stopped;
      await settled();
      expect(fakes.made).toEqual([]);
      expect(h.calls).toHaveLength(inFlight === 'token' ? 1 : 0);
    },
  );

  it('M15 takes prices on the active only, before any user.data', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    await h.manager.tick();
    const [active, reserve] = fakes.made;
    const now = Date.now();
    active?.hear(price(IDS[0], now));
    reserve?.hear(price(IDS[1], now));
    expect(h.ring.counters().pairs).toBe(1);
    expect(h.ring.read(IDS[0] ?? 0, '5s', now).forming).toBeDefined();
    expect(h.ring.read(IDS[1] ?? 0, '5s', now).forming).toBeUndefined();
    expectSafe(h, fakes.made);
  });

  it('M16 hands the refused token to the token service only as its hash, never to a client or a log', async () => {
    const fakes = fakeClients();
    const h = harness({ accounts: [ACC1], openClient: fakes.openClient });
    await h.manager.tick();
    h.answers.set(ACC1.id, () => Promise.resolve({ ok: true, accessToken: 'SECRET-token-1b' }));
    fakes.made[0]?.fire(TokenExpired);
    await settled();
    expect(fakes.made[1]?.starts).toEqual(['SECRET-token-1b']);
    const hash = hashToken(TOKEN_1);
    expect(fakes.made.flatMap((client) => client.starts)).not.toContain(hash);
    expect(h.lines.join('\n')).not.toContain(hash);
    expect(h.lines.join('\n')).not.toContain('SECRET');
  });
});

describe('the market data manager against the account list (#404, R1)', () => {
  it('M19a evicts a ready active whose account left the list, without a hold-back, and marks the holes', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    await h.manager.tick();
    const [active, reserve] = fakes.made;
    const before = Date.now();
    active?.hear(price(IDS[0], before));
    h.accounts.list = [ACC2];
    await h.manager.tick();
    expect(active?.stops).toBe(1);
    once(h, 'failover', { from: ACC1.id, reason: 'not_working', heldBack: false });
    expect(subscribed(reserve)).toEqual([IDS]);
    expect(h.line()).toMatchObject({ held: 0, active: { accountId: ACC2.id }, reserve: null });
    reserve?.hear(price(IDS[0], before + 1));
    expect(h.ring.counters().holes).toBe(1);
    h.accounts.list = [ACC1, ACC2];
    await h.manager.tick();
    expect(h.line().reserve).toMatchObject({ accountId: ACC1.id, socketState: 'ready' });
    expectSafe(h, fakes.made);
  });

  it.each([Ready, Connecting])(
    'M19b stops a reserve in %s whose account left the list, and leaves the active',
    async (state) => {
      const fakes = fakeClients(by({ [ACC2.id]: state }));
      const h = harness({ openClient: fakes.openClient });
      await h.manager.tick();
      h.accounts.list = [ACC1];
      await h.manager.tick();
      expect(fakes.made[1]?.stops).toBe(1);
      once(h, 'reserve stopped', { accountId: ACC2.id, reason: 'not_working', heldBack: false });
      expect(fakes.made[0]?.stops).toBe(0);
      expect(h.line()).toMatchObject({ failovers: 0, held: 0, reserve: null });
      expectSafe(h, fakes.made);
    },
  );

  it('M19c drops an active start whose account left the list, and its late answer opens nothing', async () => {
    const fakes = fakeClients(by({ [ACC2.id]: Authenticating }));
    const h = harness({ openClient: fakes.openClient });
    await h.manager.tick();
    const answer = deferred<AccessTokenResult>();
    h.answers.set(ACC1.id, () => answer.promise);
    fakes.made[0]?.fire(TokenExpired);
    fakes.made[1]?.fire(Ready);
    expect(h.line().active).toMatchObject({ accountId: ACC1.id, socketState: 'starting' });
    h.accounts.list = [ACC2];
    await h.manager.tick();
    expect(h.logs('market data failover').map((entry) => entry.reason)).toEqual([
      TokenExpired,
      'not_working',
    ]);
    expect(subscribed(fakes.made[1])).toEqual([IDS]);
    answer.resolve({ ok: true, accessToken: 'SECRET-token-1b' });
    await settled();
    expect(fakes.made).toHaveLength(2);
    expect(h.line()).toMatchObject({ active: { accountId: ACC2.id }, reserve: null });
    expectSafe(h, fakes.made);
  });
});

describe('the market data manager and a slot out of ready (#404, R2, R3)', () => {
  it('M20 rotates a reserve not ready past its budget to the next account, held back', async () => {
    const fakes = fakeClients(by({ [ACC2.id]: Authenticating }));
    const h = harness({
      accounts: [ACC1, ACC2, ACC3],
      openClient: fakes.openClient,
      config: { reserveReadyMs: 50 },
    });
    await h.manager.tick();
    await until('the reserve on account 3', () => readyOn(h.line().reserve, ACC3));
    expect(fakes.made[1]?.stops).toBe(1);
    once(h, 'reserve stopped', { accountId: ACC2.id, reason: 'not_ready', heldBack: true });
    expect(h.logs('market data reserve promoted')).toEqual([]);
    expect(fakes.made[2]?.subscribeCalls).toEqual([]);
    expect(h.line()).toMatchObject({ held: 1, active: { accountId: ACC1.id } });
    expectSafe(h, fakes.made);
  });

  it('M20b keeps a reserve past its budget that no other account can replace, and promotes it once ready', async () => {
    const fakes = fakeClients(by({ [ACC2.id]: Authenticating }));
    const h = harness({ openClient: fakes.openClient, config: { reserveReadyMs: 50 } });
    await h.manager.tick();
    const [active, reserve] = fakes.made;
    active?.fire(DISCONNECTED);
    expect(h.line()).toMatchObject({ held: 1, active: null });
    await pastGrace();
    expect(reserve?.stops).toBe(0);
    expect(h.logs('market data: no working service account')).toEqual([]);
    reserve?.fire(Ready);
    expect(subscribed(reserve)).toEqual([IDS]);
    expect(h.line().active).toMatchObject({ accountId: ACC2.id, socketState: 'ready' });
    expectSafe(h, fakes.made);
  });

  it('M21 reaches a ready pair from one tick, past accounts that never get ready', async () => {
    const fakes = fakeClients(by({ [ACC1.id]: Connecting, [ACC2.id]: Authenticating }));
    const h = harness({
      accounts: [ACC1, ACC2, ACC3, ACC4],
      openClient: fakes.openClient,
      config: { failoverGraceMs: 50, reserveReadyMs: 50 },
    });
    await h.manager.tick();
    // only the timers of R7 move it from here
    await until('the active on account 3 and the reserve on account 4', () => {
      const { active, reserve } = h.line();
      return readyOn(active, ACC3) && readyOn(reserve, ACC4);
    });
    expect(h.line().held).toBe(2);
    expectSafe(h, fakes.made);
  });

  it.each([Connecting, Authenticating, Ready, Reconnecting])(
    'M22 promotes a ready reserve at once when the server ends the active in %s',
    async (state) => {
      const fakes = fakeClients(by({ [ACC1.id]: state === Reconnecting ? Ready : state }));
      const h = harness({ openClient: fakes.openClient });
      await h.manager.tick();
      const [active, reserve] = fakes.made;
      if (state === Reconnecting) active?.fire(Reconnecting);
      expect(reserve?.subscribeCalls).toEqual([]);
      active?.fire(DISCONNECTED);
      expect(subscribed(reserve)).toEqual([IDS]);
      expect(h.line()).toMatchObject({ held: 1, active: { accountId: ACC2.id }, reserve: null });
      expectSafe(h, fakes.made);
    },
  );

  it.each(['starting', Connecting, Authenticating, Reconnecting] as const)(
    'M23 promotes a ready reserve over an active %s past the grace, and starts the reserve on the old account',
    async (state) => {
      const stuck = state === Connecting || state === Authenticating;
      const fakes = fakeClients((label, start) =>
        label === ACC1.id && start === 1 && stuck ? state : Ready,
      );
      const h = harness({ openClient: fakes.openClient, config: { failoverGraceMs: 50 } });
      const answer = deferred<AccessTokenResult>();
      if (state === 'starting') h.answers.set(ACC1.id, () => answer.promise);
      void h.manager.tick();
      await settled();
      if (state === Reconnecting) fakes.made[0]?.fire(Reconnecting);
      const reserve = fakes.made.find((client) => client.label === ACC2.id);
      expect(reserve?.subscribeCalls).toEqual([]);
      await until('the promotion', () => h.logs('market data reserve promoted').length === 1);
      once(h, 'failover', { from: ACC1.id, reason: 'not_ready', heldBack: false });
      expect(subscribed(reserve)).toEqual([IDS]);
      answer.resolve({ ok: true, accessToken: TOKEN_1 });
      await until('the reserve on account 1', () => readyOn(h.line().reserve, ACC1));
      const old = fakes.made.filter((client) => client.label === ACC1.id);
      // a start in flight opens no client of its own: its answer goes to the new reserve only
      expect(old).toHaveLength(state === 'starting' ? 1 : 2);
      expect(old.map((client) => client.stops)).toEqual(state === 'starting' ? [0] : [1, 0]);
      expectSafe(h, fakes.made);
    },
  );

  it('M24 promotes the reserve the moment it turns ready when the active is past the grace', async () => {
    const fakes = fakeClients(by({ [ACC1.id]: Connecting, [ACC2.id]: Authenticating }));
    const h = harness({ openClient: fakes.openClient, config: { failoverGraceMs: 50 } });
    await h.manager.tick();
    await pastGrace();
    expect(h.logs('market data reserve promoted')).toEqual([]);
    fakes.made[1]?.fire(Ready);
    expect(subscribed(fakes.made[1])).toEqual([IDS]);
    expect(h.line().active).toMatchObject({ accountId: ACC2.id, socketState: 'ready' });
    expectSafe(h, fakes.made);
  });
});

describe('the market data manager and a throwing client start (#404, L6)', () => {
  it.each(['active', 'reserve'] as const)(
    'M25 holds back an account whose client throws at its start as the %s, and goes on',
    async (role) => {
      // the active on the first tick, or the reserve after a promotion
      const thrower = role === 'active' ? ACC1 : ACC3;
      const fakes = fakeClients(undefined, (label) => label === thrower.id);
      const h = harness({ accounts: [ACC1, ACC2, ACC3], openClient: fakes.openClient });
      await h.manager.tick();
      if (role === 'reserve') fakes.made[0]?.fire(DISCONNECTED);
      await settled();
      const [threw] = h.logs('market data socket start threw');
      expect(threw).toMatchObject({ role, accountId: thrower.id, err: { name: 'TypeError' } });
      expect(Object.keys((threw?.err as object | undefined) ?? {})).not.toContain('message');
      expect(h.logs('market data tick failed')).toEqual([]);
      const broken = fakes.made.find((client) => client.label === thrower.id);
      expect(broken?.stops).toBe(1);
      const disconnects = h.logs('market data socket disconnected by server').length;
      // detached: its events reach no handler
      broken?.fire(DISCONNECTED);
      expect(h.logs('market data socket disconnected by server')).toHaveLength(disconnects);
      expect(h.line()).toMatchObject({
        held: role === 'active' ? 1 : 2,
        active: { accountId: role === 'active' ? ACC3.id : ACC2.id, socketState: 'ready' },
      });
      expectSafe(h, fakes.made);
    },
  );
});

describe('the market data manager and the backfill (#590)', () => {
  // acceptance 1: the candles the failover dropped come back by native 5s and 15s GETs
  it('M26 refills the hole of a failover from the mock broker, and leaves the tick-built candles', async () => {
    const mock = await withBroker();
    const h = harness({ backfill: true });
    await h.manager.tick();
    await bothReady(h);
    await until('subscribed', () => socketsOf(1)[0]?.subscriptions.length === 45);
    // in the past, inside the ticks' skew bound: the buckets are closed by the clock already
    const t1 = Math.floor(Date.now() / 15_000) * 15_000 - 30_000;
    mock.socket.pushPrices(t1);
    await until('every pair ticked', () => h.ring.counters().pairs === 45);
    mock.socket.disconnect({ userId: 1 });
    await until('the reserve subscribed', () => socketsOf(2)[0]?.subscriptions.length === 45);
    mock.socket.pushPrices(t1 + 15_000);
    await until('the holes', () => h.ring.counters().holes === 45);
    // the hole's tail bucket is not built: a candle past it
    const t4 = t1 + 20_000;
    mock.socket.pushPrices(t4);
    await until(
      'the next candle',
      () => h.ring.read(IDS[0] ?? 0, '5s', Date.now()).candles.length > 0,
    );
    const id = IDS[0] ?? 0;
    const tickBuilt = h.ring.read(id, '5s', Date.now()).candles;
    expect(tickBuilt.map((candle) => candle.timestamp)).toEqual([t4]);
    for (const interval of SIGNAL_SCAN_INTERVALS) {
      expect(h.ring.read(id, interval, Date.now()).gaps).toContain(t1);
    }

    // the buckets closed by the clock before the first GET; one closing later is the next GET's,
    // after the element's hold-back
    const cut = Date.now() - 2_000;
    const pending = () =>
      IDS.flatMap((assetId) =>
        SIGNAL_SCAN_INTERVALS.map((interval) =>
          h.ring
            .read(assetId, interval, Date.now())
            .gaps.filter((bucket) => bucket + SIGNAL_CHART_INTERVAL_MS[interval] <= cut),
        ),
      ).filter((gaps) => gaps.length > 0).length;
    await until('every window refilled', async () => {
      await h.backfill?.tick();
      return pending() === 0;
    });
    const after = h.ring.read(id, '5s', Date.now()).candles;
    expect(after.map((candle) => candle.timestamp)).toContain(t1);
    expect(after.find((candle) => candle.timestamp === t4)).toEqual(tickBuilt[0]);
    expect(h.backfill?.counters()).toMatchObject({ fetched: 90, failed: 0, rateLimited: 0 });
    expect(h.line().backfill).toMatchObject({ fetched: 90, failed: 0, queued: 0 });
  });

  it('M27 streams only while the active is ready', async () => {
    const fakes = fakeClients(() => Connecting);
    const h = harness({ accounts: [ACC1], openClient: fakes.openClient });
    expect(h.manager.streaming()).toBe(false);
    await h.manager.tick();
    expect(h.line().active).toMatchObject({ socketState: Connecting });
    expect(h.manager.streaming()).toBe(false);
    fakes.made[0]?.fire(Ready);
    expect(h.manager.streaming()).toBe(true);
    fakes.made[0]?.fire(Reconnecting);
    expect(h.manager.streaming()).toBe(false);
    fakes.made[0]?.fire(Ready);
    expect(h.manager.streaming()).toBe(true);
    await h.manager.stop();
    expect(h.manager.streaming()).toBe(false);
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

// the backstop of track() and of the deadline timer: every work catches its own throws (S5); the
// backfill's backstop likewise (backfill.test.ts B17)
const UNREACHABLE = ['market data work failed', 'market data backfill tick failed'];
// written by backfill.test.ts, which checks them against the same table (B17)
const BACKFILL_WRITTEN = ['market data backfill gave up', 'market data backfill threw'];

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
    expect([...documented].filter((msg) => msg !== undefined && !written.has(msg)).sort()).toEqual(
      [...UNREACHABLE, ...BACKFILL_WRITTEN].sort(),
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
        'backfill',
      ].sort(),
    );
    expect(Object.keys((line?.backfill as object | undefined) ?? {}).sort()).toEqual(
      ['queued', 'fetched', 'filled', 'failed', 'rateLimited', 'spare'].sort(),
    );
    const text = allLines.join('\n');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('"price"');
  });
});
