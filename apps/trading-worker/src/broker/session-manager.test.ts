import {
  hashToken,
  type BalanceEventWrite,
  type BalanceSnapshotWrite,
  type ClosedTradeOutcome,
  type SessionCandidate,
} from '@binarius/db';
import { MockSocketPayload, startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { AccessTokenRefusal, BrokerSocketEvent, logOptions, TradeMode } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import pino from 'pino';
import { io } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccessTokenUnavailable,
  type AccessTokenOptions,
  type AccessTokenOutcome,
} from './access-token';
import type { DeadLetter, DeadLetterSink } from '../dead-letter';
import type { BrokerEvent } from './events';
import type { SessionManagerConfig } from './session-config';
import {
  createBrokerSessionManager,
  type BrokerSessionManager,
  type SessionLeases,
  type SessionLossObserver,
  type SessionWriters,
} from './session-manager';
import {
  BrokerSocketState,
  createBrokerSocketClient,
  type BrokerSocket,
  type BrokerSocketClient,
  type BrokerSocketClientOptions,
  type BrokerSocketOptions,
  type BrokerSocketStateChange,
} from './socket';

const TIMING = {
  connectTimeoutMs: 1_000,
  authTimeoutMs: 200,
  reconnectDelayMs: 20,
  reconnectDelayMaxMs: 40,
  jitter: 0,
};
const CONFIG: SessionManagerConfig = {
  tickMs: 1_000,
  idleGraceMs: 150,
  retryMs: 300,
  refusalRetryMs: 1_500,
  maxSessions: 10,
  startConcurrency: 4,
  stopBudgetMs: 150,
  watchWindowMs: 600_000,
  // long enough that no lease is renewed or fenced unless a case shortens them
  leaseTtlMs: 30_000,
  leaseRenewMs: 6_000,
  leaseRenewTimeoutMs: 3_000,
  leaseFenceMs: 25_000,
};
// a negative wait, past the longest reconnection delay of TIMING
const QUIET_MS = 100;
const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));
// a duration: a hold-back of CONFIG.retryMs has to run out
const outlastRetry = () => new Promise((resolve) => setTimeout(resolve, CONFIG.retryMs + 100));

const USERS = [1, 2, 3, 4, 5, 6, 7, 8];
const tokenOf = (user: number) => `SECRET-TOKEN-of-user-${user}`;
const candidate = (user: number): SessionCandidate => ({
  id: `acc-${user}`,
  brokerUserId: String(user),
});
const userOf = (accountId: string) => Number(accountId.replace('acc-', ''));

type LogEntry = Record<string, unknown> & { level: number; msg: string };
const LEVEL = { debug: 20, info: 30, warn: 40, error: 50 } as const;

type Write =
  | { kind: 'snapshot'; accountId: string; userId: string; modes: readonly TradeMode[] }
  | { kind: 'balance'; accountId: string; mode: TradeMode; available: string }
  | { kind: 'closed'; accountId: string; ids: string[] };

const grant = (accountId: string): Promise<AccessTokenOutcome> =>
  Promise.resolve({ ok: true, accessToken: tokenOf(userOf(accountId)) });

// every line any harness of this file wrote: the log scan at the end reads them all
const allLines: string[] = [];

let broker: MockBroker;
const managers: BrokerSessionManager[] = [];

beforeEach(async () => {
  broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
  for (const user of USERS) broker.users.register({ id: user, accessToken: tokenOf(user) });
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  await broker.close();
});

interface HarnessOptions {
  config?: Partial<SessionManagerConfig>;
  tokens?: (accountId: string, options: AccessTokenOptions) => Promise<AccessTokenOutcome>;
  writers?: (writes: Write[]) => SessionWriters;
  openClient?: (options: BrokerSocketClientOptions) => BrokerSocketClient;
  deadLetters?: DeadLetterSink;
  leases?: Partial<SessionLeases>;
  monotonicNow?: () => number;
  lossObserver?: SessionLossObserver;
}

function recordingWriters(writes: Write[]): SessionWriters {
  return {
    snapshot: (accountId, user, modes) => {
      writes.push({ kind: 'snapshot', accountId, userId: user.id, modes });
      return Promise.resolve<BalanceSnapshotWrite>({ written: true });
    },
    balanceEvent: (accountId, mode, balance) => {
      writes.push({ kind: 'balance', accountId, mode, available: balance.available });
      return Promise.resolve<BalanceEventWrite>({ written: true });
    },
    closedTrades: (accountId, trades) => {
      writes.push({ kind: 'closed', accountId, ids: trades.map((trade) => trade.id) });
      return Promise.resolve<ClosedTradeOutcome[]>(
        trades.map((trade) => ({ brokerTradeId: trade.id, result: 'not_ours' })),
      );
    },
  };
}

function harness(options: HarnessOptions = {}) {
  const lines: string[] = [];
  const logger = pino(logOptions('debug'), {
    write: (line: string) => {
      lines.push(line);
      allLines.push(line);
    },
  });
  const state = { candidates: [] as SessionCandidate[], failCandidates: false };
  const candidateCalls: (readonly string[])[] = [];
  const tokenCalls: { accountId: string; options: AccessTokenOptions }[] = [];
  const writes: Write[] = [];
  const deadLetters: DeadLetter[] = [];
  // every lease granted and renewed unless a case says otherwise; each call recorded
  const leaseCalls: { op: 'acquire' | 'renew' | 'release'; ids: string[] }[] = [];
  const leases: SessionLeases = {
    acquire: (accountId, ttlMs) => {
      leaseCalls.push({ op: 'acquire', ids: [accountId] });
      return options.leases?.acquire?.(accountId, ttlMs) ?? Promise.resolve(true);
    },
    renew: (accountIds, ttlMs) => {
      leaseCalls.push({ op: 'renew', ids: [...accountIds] });
      return options.leases?.renew?.(accountIds, ttlMs) ?? Promise.resolve([...accountIds]);
    },
    release: () => {
      leaseCalls.push({ op: 'release', ids: [] });
      return options.leases?.release?.() ?? Promise.resolve(0);
    },
  };
  const manager = createBrokerSessionManager({
    url: broker.url,
    leases,
    ...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
    ...(options.lossObserver === undefined ? {} : { lossObserver: options.lossObserver }),
    deadLetters: options.deadLetters ?? {
      add: (_name, entry) => {
        deadLetters.push(entry);
        return Promise.resolve();
      },
    },
    candidates: ({ exclude }) => {
      candidateCalls.push(exclude);
      if (state.failCandidates) return Promise.reject(new Error('database down'));
      return Promise.resolve(state.candidates.filter((c) => !exclude.includes(c.id)));
    },
    tokens: {
      accessToken: (accountId, tokenOptions = {}) => {
        tokenCalls.push({ accountId, options: tokenOptions });
        return (options.tokens ?? grant)(accountId, tokenOptions);
      },
    },
    writers: (options.writers ?? recordingWriters)(writes),
    logger,
    config: { ...CONFIG, ...options.config },
    timing: TIMING,
    ...(options.openClient === undefined ? {} : { openClient: options.openClient }),
  });
  managers.push(manager);
  return {
    manager,
    state,
    candidateCalls,
    tokenCalls,
    writes,
    deadLetters,
    leaseCalls,
    lines,
    logs: (msg: string) =>
      lines.map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry.msg === msg),
  };
}

type Harness = ReturnType<typeof harness>;

const readyFor = (h: Harness, accountId: string, connections = 1) =>
  until(
    `${accountId} ready after ${connections} auth(s)`,
    () =>
      h.manager.clientFor(accountId)?.state === BrokerSocketState.Ready &&
      h.manager.clientFor(accountId)?.connections === connections,
  );

// ticks until the condition holds: for what a hold-back or the idle grace has to let through
const tickUntil = (h: Harness, what: string, condition: () => boolean) =>
  until(what, async () => {
    await h.manager.tick();
    return condition();
  });

const authsOf = (user: number) =>
  broker.socket.journal.filter(
    (record) => record.event === BrokerSocketEvent.UserAuth && record.userId === user,
  ).length;
const authRecords = () =>
  broker.socket.journal.filter((record) => record.event === BrokerSocketEvent.UserAuth).length;

// a promise the test resolves by hand: a token fetch or a write that is still in flight
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function track<T>(promise: Promise<T>) {
  const tracked = { settled: false, promise };
  void promise.then(() => {
    tracked.settled = true;
  });
  return tracked;
}

// The openSocket seam over the real socket: while `hold` is set, the events named in `names`
// (user.data unless a test adds more) are kept back until release(), which hands them to the
// client one after another in the same turn — a test can put an event in front of user.data, or
// deliver two events as one burst.
function holdUserData() {
  const gate = {
    hold: false,
    names: new Set<string>([BrokerSocketEvent.UserData]),
    held: [] as (() => void)[],
  };
  const openSocket = (url: string, options: BrokerSocketOptions): BrokerSocket => {
    const socket: BrokerSocket = io(url, options);
    const onAny = socket.onAny.bind(socket);
    socket.onAny = (listener) =>
      onAny((name: string, ...args: unknown[]) => {
        if (gate.hold && gate.names.has(name)) {
          gate.held.push(() => listener(name, ...args));
          return;
        }
        listener(name, ...args);
      });
    return socket;
  };
  return {
    gate,
    openClient: (options: BrokerSocketClientOptions) =>
      createBrokerSocketClient({ ...options, openSocket }),
    release() {
      gate.hold = false;
      for (const deliver of gate.held.splice(0)) deliver();
    },
  };
}

// A client double for the token cycle: it records start() and stop() and lets the test publish a
// state change the way the real client does.
interface FakeClient extends BrokerSocketClient {
  starts: string[];
  stops: number;
  fire(to: BrokerSocketState): void;
  hear(event: BrokerEvent): void;
}

function fakeClients({ readyOnStart = true }: { readyOnStart?: boolean } = {}) {
  const made: FakeClient[] = [];
  const openClient = (): BrokerSocketClient => {
    const stateListeners = new Set<(change: BrokerSocketStateChange) => void>();
    const eventListeners = new Set<(event: BrokerEvent) => void>();
    let state: BrokerSocketState = BrokerSocketState.Idle;
    const publish = (to: BrokerSocketState) => {
      const change = { from: state, to };
      state = to;
      for (const listener of [...stateListeners]) listener(change);
    };
    const client: FakeClient = {
      starts: [],
      stops: 0,
      fire: publish,
      hear(event) {
        for (const listener of [...eventListeners]) listener(event);
      },
      start(credentials) {
        client.starts.push(credentials.accessToken);
        publish(readyOnStart ? BrokerSocketState.Ready : BrokerSocketState.Authenticating);
      },
      stop() {
        client.stops += 1;
        publish(BrokerSocketState.Idle);
      },
      subscribe: () => undefined,
      subscriptions: () => [],
      openTrade: () => Promise.reject(new Error('not used')),
      get state() {
        return state;
      },
      connections: 1,
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

const userWire = (id: number) => ({
  id,
  level: { code: 'standard', rank: 1 },
  min_trade_amount: '1.00',
  real: { available: '0', held: '0', total: '0' },
  demo: { available: '100.00', held: '0', total: '100.00' },
});
// the user.data of broker user 1, as the normalizer hands it over
const USER_1 = {
  id: '1',
  level: { code: 'standard', rank: 1 },
  minTradeAmount: '1.00',
  real: { available: '0', held: '0', total: '0' },
  demo: { available: '100.00', held: '0', total: '100.00' },
} as Extract<BrokerEvent, { type: 'user_data' }>['user'];
const balanceWire = (available: string) => ({ available, held: '0', total: available });
const closedWire = (id: number) => ({
  id,
  asset_id: 101,
  action: 'up',
  amount: '1.50',
  payout: 85,
  open_price: 1.1,
  open_timestamp: 1_790_028_496_624,
  is_demo: true,
  close_price: 1.2,
  close_timestamp: 1_790_028_556_624,
  profit: '1.27',
});

describe('sessions', () => {
  it('U1 one client per candidate, one user.auth each, and a token never exchanged', async () => {
    const h = harness();
    h.state.candidates = [candidate(1), candidate(2)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    await readyFor(h, 'acc-2');
    await h.manager.tick();
    await quiet();
    expect(h.manager.size).toBe(2);
    expect(broker.socket.sockets()).toHaveLength(2);
    expect(authsOf(1)).toBe(1);
    expect(authsOf(2)).toBe(1);
    expect(h.tokenCalls.map(({ accountId, options }) => [accountId, options.mayRefresh])).toEqual([
      ['acc-1', false],
      ['acc-2', false],
    ]);
  });

  it('U2 closes a session idleGraceMs after its account left the candidates, not before', async () => {
    const h = harness();
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    h.state.candidates = [];
    await h.manager.tick();
    expect(h.manager.clientFor('acc-1')).toBeDefined();
    expect(broker.socket.sockets()).toHaveLength(1);
    await tickUntil(h, 'the idle close', () => h.manager.clientFor('acc-1') === undefined);
    await until('no socket', () => broker.socket.sockets().length === 0);
    expect(h.logs('broker session closed')).toEqual([
      expect.objectContaining({ level: LEVEL.info, accountId: 'acc-1', reason: 'idle' }),
    ]);
  });

  it('U3 holds at most maxSessions, warns once per tick, and starts the next one when a slot frees', async () => {
    const h = harness({ config: { maxSessions: 2 } });
    h.state.candidates = [candidate(1), candidate(2), candidate(3)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    await readyFor(h, 'acc-2');
    await h.manager.tick();
    await quiet();
    expect(h.manager.size).toBe(2);
    expect(broker.socket.sockets()).toHaveLength(2);
    expect(h.manager.clientFor('acc-3')).toBeUndefined();
    expect(h.logs('broker sessions capped')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, candidates: 3, cap: 2 }),
      expect.objectContaining({ level: LEVEL.warn, candidates: 3, cap: 2 }),
    ]);
    h.state.candidates = [candidate(2), candidate(3)];
    await tickUntil(h, 'acc-3 started', () => h.manager.clientFor('acc-3') !== undefined);
    await readyFor(h, 'acc-3');
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
  });

  it('U3b counts a starting session against the cap', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<AccessTokenOutcome>>>();
    const h = harness({
      config: { maxSessions: 2 },
      tokens: (accountId) => {
        const token = deferred<AccessTokenOutcome>();
        pending.set(accountId, token);
        return token.promise;
      },
    });
    h.state.candidates = [candidate(1), candidate(2), candidate(3)];
    await h.manager.tick();
    await h.manager.tick();
    expect(h.manager.size).toBe(2);
    expect([...pending.keys()]).toEqual(['acc-1', 'acc-2']);
    for (const [accountId, token] of pending) token.resolve(await grant(accountId));
    await readyFor(h, 'acc-1');
    await readyFor(h, 'acc-2');
    await h.manager.tick();
    await quiet();
    expect(broker.socket.sockets()).toHaveLength(2);
  });
});

describe('the token', () => {
  it('U4 a durable refusal: no client, one token call until refusalRetryMs, the warn', async () => {
    const h = harness({
      tokens: () => Promise.resolve({ ok: false, reason: AccessTokenRefusal.AccountRevoked }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the refusal', () => h.logs('broker session token refused').length === 1);
    expect(h.logs('broker session token refused')).toEqual([
      expect.objectContaining({
        level: LEVEL.warn,
        accountId: 'acc-1',
        refusal: 'account_revoked',
      }),
    ]);
    await outlastRetry();
    await h.manager.tick();
    expect(h.tokenCalls).toHaveLength(1);
    expect(h.candidateCalls.at(-1)).toEqual(['acc-1']);
    expect(h.manager.size).toBe(0);
    expect(broker.socket.sockets()).toEqual([]);
    await tickUntil(
      h,
      'the second call after the refusal hold-back',
      () => h.tokenCalls.length === 2,
    );
  });

  it.each([
    [AccessTokenUnavailable.BackendUnreachable, 'broker session token unavailable'],
    [AccessTokenUnavailable.BackendStatus, 'broker session token unavailable'],
    [AccessTokenRefusal.RefreshNeeded, 'broker session waits for a token exchange'],
    // #275: unreachable with mayRefresh: false, temporary if it ever comes
    [AccessTokenRefusal.RefreshRateLimited, 'broker session token unavailable'],
  ])('U5 %s: held back retryMs, then asked again', async (reason, msg) => {
    const h = harness({ tokens: () => Promise.resolve({ ok: false, reason }) });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the answer', () => h.logs(msg).length === 1);
    await h.manager.tick();
    expect(h.tokenCalls).toHaveLength(1);
    expect(h.candidateCalls.at(-1)).toEqual(['acc-1']);
    await tickUntil(h, 'the second call', () => h.tokenCalls.length === 2);
    expect(h.manager.size).toBe(0);
  });

  it('U6 token_expired with the same token: dropped, held back, one user.auth per retryMs', async () => {
    const h = harness();
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    broker.users.revokeToken(tokenOf(1));
    await until('the unchanged token', () => h.logs('broker session token unchanged').length === 1);
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
    // the start asks without a fingerprint, the fetch after token_expired with the refused one's
    expect(h.tokenCalls.map(({ options }) => [options.mayRefresh, options.refusedToken])).toEqual([
      [false, undefined],
      [false, hashToken(tokenOf(1))],
    ]);
    await until('no socket', () => broker.socket.sockets().length === 0);
    await h.manager.tick();
    expect(authsOf(1)).toBe(1);
    // the hold-back over: one fresh start, refused by the broker, dropped again
    await tickUntil(
      h,
      'the second unchanged token',
      () => h.logs('broker session token unchanged').length === 2,
    );
    expect(authRecords()).toBe(2);
    expect(h.logs('broker session token unchanged').map((entry) => entry.sessionState)).toEqual([
      BrokerSocketState.TokenExpired,
      BrokerSocketState.AuthFailed,
    ]);
    await h.manager.tick();
    await quiet();
    expect(authRecords()).toBe(2);
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
  });

  it('U6b token_expired with a new token restarts the same client at once', async () => {
    const fakes = fakeClients();
    let issued = 0;
    const h = harness({
      openClient: fakes.openClient,
      tokens: () => Promise.resolve({ ok: true, accessToken: `SECRET-${(issued += 1)}` }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the client', () => fakes.made.length === 1);
    const client = fakes.made[0]!;
    client.fire(BrokerSocketState.TokenExpired);
    await until('the restart', () => client.starts.length === 2);
    expect(client.starts).toEqual(['SECRET-1', 'SECRET-2']);
    expect(h.tokenCalls).toHaveLength(2);
    expect(h.manager.clientFor('acc-1')).toBe(client);
    expect(fakes.made).toHaveLength(1);
    expect(client.stops).toBe(0);
  });

  it('U7 auth_failed with the same token: dropped and held back like token_expired', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the client', () => fakes.made.length === 1);
    const client = fakes.made[0]!;
    client.fire(BrokerSocketState.AuthFailed);
    await until('the drop', () => h.manager.clientFor('acc-1') === undefined);
    expect(client.stops).toBe(1);
    expect(h.logs('broker session token unchanged')).toEqual([
      expect.objectContaining({
        level: LEVEL.warn,
        accountId: 'acc-1',
        sessionState: 'auth_failed',
      }),
    ]);
    expect(h.tokenCalls.map(({ options }) => [options.mayRefresh, options.refusedToken])).toEqual([
      [false, undefined],
      [false, hashToken(tokenOf(1))],
    ]);
    await h.manager.tick();
    expect(fakes.made).toHaveLength(1);
    await tickUntil(h, 'a new client after the hold-back', () => fakes.made.length === 2);
  });

  it('U6c a backend that marks the refused token: the session waits and restarts with the exchanged token', async () => {
    const fakes = fakeClients();
    let exchanged = false;
    const h = harness({
      openClient: fakes.openClient,
      tokens: (_accountId, options) => {
        if (options?.refusedToken === hashToken('SECRET-1')) {
          exchanged = true;
          return Promise.resolve({ ok: false, reason: AccessTokenRefusal.RefreshNeeded });
        }
        return Promise.resolve({ ok: true, accessToken: exchanged ? 'SECRET-2' : 'SECRET-1' });
      },
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the client', () => fakes.made.length === 1);
    fakes.made[0]!.fire(BrokerSocketState.TokenExpired);
    await until(
      'the wait for an exchange',
      () => h.logs('broker session waits for a token exchange').length === 1,
    );
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
    expect(h.logs('broker session token unchanged')).toEqual([]);
    await h.manager.tick();
    expect(fakes.made).toHaveLength(1);
    await tickUntil(h, 'a new client after the hold-back', () => fakes.made.length === 2);
    expect(fakes.made[1]!.starts).toEqual(['SECRET-2']);
  });

  it('U8 disconnected_by_server: dropped and restarted only after retryMs', async () => {
    const h = harness();
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    broker.socket.disconnect({ userId: 1 });
    await until('the drop', () => h.manager.clientFor('acc-1') === undefined);
    expect(h.logs('broker session closed')).toEqual([
      expect.objectContaining({ accountId: 'acc-1', reason: 'disconnected_by_server' }),
    ]);
    await h.manager.tick();
    expect(h.tokenCalls).toHaveLength(1);
    await tickUntil(h, 'the restart', () => h.tokenCalls.length === 2);
    await readyFor(h, 'acc-1');
  });
});

describe('the identity gate and the writers', () => {
  it('U9 writes nothing before the connection user.data, then every event in order', async () => {
    const gated = holdUserData();
    gated.gate.hold = true;
    const h = harness({
      openClient: gated.openClient,
      writers: (writes) => ({
        ...recordingWriters(writes),
        closedTrades: (accountId, trades) => {
          writes.push({ kind: 'closed', accountId, ids: trades.map((trade) => trade.id) });
          return Promise.resolve<ClosedTradeOutcome[]>([
            { brokerTradeId: '71', result: 'settled', intentId: 'intent-71' },
            { brokerTradeId: '72', result: 'not_ours' },
          ]);
        },
      }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    const heard: BrokerEvent[] = [];
    h.manager.clientFor('acc-1')!.onEvent((event) => heard.push(event));
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('1.00'));
    await until('the early balance', () => heard.length === 1);
    expect(h.writes).toEqual([]);
    expect(h.logs('broker session event before user.data')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, accountId: 'acc-1', type: 'balance_update' }),
    ]);

    gated.release();
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('2.00'));
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.close_trade.success', {
      trades: [closedWire(71), closedWire(72)],
    });
    await until('three writes', () => h.writes.length === 3);
    expect(h.writes).toEqual([
      {
        kind: 'snapshot',
        accountId: 'acc-1',
        userId: '1',
        modes: [TradeMode.Demo, TradeMode.Real],
      },
      { kind: 'balance', accountId: 'acc-1', mode: TradeMode.Demo, available: '2.00' },
      { kind: 'closed', accountId: 'acc-1', ids: ['71', '72'] },
    ]);
    await until(
      'the settled line',
      () => h.logs('intent settled from close_trade.success').length > 0,
    );
    expect(h.logs('intent settled from close_trade.success')).toEqual([
      expect.objectContaining({ accountId: 'acc-1', intentId: 'intent-71', brokerTradeId: '71' }),
    ]);
    expect(h.logs('closed trade not applied')).toEqual([
      expect.objectContaining({
        level: LEVEL.debug,
        accountId: 'acc-1',
        brokerTradeId: '72',
        result: 'not_ours',
      }),
    ]);
  });

  it('U9b a user.data of another broker user stops the session in the handler; nothing more is written', async () => {
    const gated = holdUserData();
    const h = harness({ openClient: gated.openClient });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    await until('the first snapshot', () => h.writes.length === 1);
    // the foreign user.data and a balance after it, in one burst on the verified connection
    gated.gate.names.add('user.demo.update_balance');
    gated.gate.hold = true;
    broker.socket.emitRaw({ userId: 1 }, BrokerSocketEvent.UserData, userWire(2));
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('3.00'));
    await until('both held', () => gated.gate.held.length === 2);
    gated.release();
    await until('the mismatch', () => h.logs('broker session user mismatch').length === 1);
    expect(h.logs('broker session user mismatch')).toEqual([
      expect.objectContaining({
        level: LEVEL.error,
        accountId: 'acc-1',
        expected: '1',
        received: '2',
      }),
    ]);
    await until('no socket', () => broker.socket.sockets().length === 0);
    await quiet();
    expect(h.writes.map(({ kind }) => kind)).toEqual(['snapshot']);
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
    await outlastRetry();
    await h.manager.tick();
    expect(h.tokenCalls).toHaveLength(1);
  });

  it('U9c a reconnect re-arms the gate until the new connection user.data', async () => {
    const gated = holdUserData();
    const h = harness({ openClient: gated.openClient });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    await until('the first snapshot', () => h.writes.length === 1);
    gated.gate.hold = true;
    broker.socket.cutTransport({ userId: 1 });
    await readyFor(h, 'acc-1', 2);
    const heard: BrokerEvent[] = [];
    h.manager.clientFor('acc-1')!.onEvent((event) => heard.push(event));
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('4.00'));
    await until('the balance on the new connection', () => heard.length === 1);
    expect(h.writes.map(({ kind }) => kind)).toEqual(['snapshot']);
    expect(h.logs('broker session event before user.data')).toHaveLength(1);
    gated.release();
    await until('the second snapshot', () => h.writes.length === 2);
  });

  it('U10 a writer that throws: the error line, and the next write still runs', async () => {
    const h = harness({
      writers: (writes) => ({
        ...recordingWriters(writes),
        snapshot: () => Promise.reject(new Error('connection terminated')),
      }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    await until('the failed write', () => h.logs('broker session write failed').length === 1);
    expect(h.logs('broker session write failed')).toEqual([
      expect.objectContaining({ level: LEVEL.error, accountId: 'acc-1', source: 'user_data' }),
    ]);
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('5.00'));
    await until('the balance write', () => h.writes.length === 1);
    expect(h.deadLetters).toEqual([
      {
        source: 'user_data',
        accountId: 'acc-1',
        mode: null,
        brokerTradeIds: [],
        reason: 'processing_failed',
        failedAt: expect.any(String),
      },
    ]);
  });

  it('U10b every throwing writer leaves its event in the dead-letter queue, ids only (#92)', async () => {
    const h = harness({
      writers: (writes) => ({
        ...recordingWriters(writes),
        balanceEvent: () => Promise.reject(new Error('connection terminated')),
        closedTrades: () => Promise.reject(new Error('connection terminated')),
      }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('5.00'));
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.close_trade.success', {
      trades: [closedWire(71), closedWire(72)],
    });
    await until('two dead letters', () => h.deadLetters.length === 2);
    expect(h.deadLetters).toEqual([
      expect.objectContaining({
        source: 'update_balance',
        accountId: 'acc-1',
        mode: 'demo',
        brokerTradeIds: [],
      }),
      expect.objectContaining({
        source: 'close_trade_success',
        accountId: 'acc-1',
        mode: 'demo',
        brokerTradeIds: ['71', '72'],
      }),
    ]);
    const text = JSON.stringify(h.deadLetters);
    for (const amount of ['5.00', '1.50', '1.27']) expect(text).not.toContain(amount);
    // the log line carries the trade ids too: the hour's later dead letters are not written
    expect(h.logs('broker session write failed')).toEqual([
      expect.not.objectContaining({ brokerTradeIds: expect.anything() }),
      expect.objectContaining({ source: 'close_trade_success', brokerTradeIds: ['71', '72'] }),
    ]);
  });

  it('warns once per connection and source when a balance is not written', async () => {
    const h = harness({
      writers: (writes) => ({
        ...recordingWriters(writes),
        balanceEvent: () => Promise.resolve({ written: false, reason: 'no_snapshot' }),
      }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('1.00'));
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('2.00'));
    await until('the warn', () => h.logs('balance snapshot not written').length === 1);
    await quiet();
    expect(h.logs('balance snapshot not written')).toEqual([
      expect.objectContaining({
        accountId: 'acc-1',
        source: 'update_balance',
        reason: 'no_snapshot',
      }),
    ]);
  });
});

describe('sessionFor, stop() and the tick', () => {
  it('U11 sessionFor is the running client only', async () => {
    const token = deferred<AccessTokenOutcome>();
    const h = harness({ tokens: () => token.promise });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    expect(h.manager.size).toBe(1);
    expect(h.manager.sessionFor('acc-1')).toBeUndefined();
    expect(h.manager.sessionFor('acc-unknown')).toBeUndefined();
    token.resolve(await grant('acc-1'));
    await until('running', () => h.manager.sessionFor('acc-1') !== undefined);
    expect(h.manager.sessionFor('acc-1')).toBe(h.manager.clientFor('acc-1'));
  });

  it('U11b sessionFor hands out a connection only once its user.data matched the account', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the client', () => fakes.made.length === 1);
    const client = fakes.made[0]!;
    expect(client.state).toBe(BrokerSocketState.Ready);
    expect(h.manager.clientFor('acc-1')).toBe(client);
    expect(h.manager.sessionFor('acc-1')).toBeUndefined();
    const user = USER_1;
    client.hear({ type: 'user_data', user });
    expect(h.manager.sessionFor('acc-1')).toBe(client);
    client.fire(BrokerSocketState.Reconnecting);
    expect(h.manager.sessionFor('acc-1')).toBeUndefined();
    client.fire(BrokerSocketState.Authenticating);
    client.fire(BrokerSocketState.Ready);
    expect(h.manager.sessionFor('acc-1')).toBeUndefined();
    client.hear({ type: 'user_data', user });
    expect(h.manager.sessionFor('acc-1')).toBe(client);
  });

  it.each([BrokerSocketState.TokenExpired, BrokerSocketState.AuthFailed])(
    'U11c %s: no session while the refresh runs, and none until the new connection is verified',
    async (terminal) => {
      const fakes = fakeClients();
      const tokens: ((outcome: AccessTokenOutcome) => void)[] = [];
      const h = harness({
        openClient: fakes.openClient,
        tokens: () => {
          const token = deferred<AccessTokenOutcome>();
          tokens.push(token.resolve);
          return token.promise;
        },
      });
      h.state.candidates = [candidate(1)];
      await h.manager.tick();
      await until('the first fetch', () => tokens.length === 1);
      tokens[0]!({ ok: true, accessToken: 'SECRET-1' });
      await until('the client', () => fakes.made.length === 1);
      const client = fakes.made[0]!;
      client.hear({ type: 'user_data', user: USER_1 });
      expect(h.manager.sessionFor('acc-1')).toBe(client);

      client.fire(terminal);
      expect(h.manager.sessionFor('acc-1')).toBeUndefined();
      expect(h.manager.clientFor('acc-1')).toBe(client);
      await until('the refresh fetch', () => tokens.length === 2);
      tokens[1]!({ ok: true, accessToken: 'SECRET-2' });
      await until('the restart', () => client.starts.length === 2);
      client.fire(BrokerSocketState.Authenticating);
      client.fire(BrokerSocketState.Ready);
      expect(h.manager.sessionFor('acc-1')).toBeUndefined();
      client.hear({ type: 'user_data', user: USER_1 });
      expect(h.manager.sessionFor('acc-1')).toBe(client);
    },
  );

  it.each([
    ['manager.stop()', (h: Harness) => h.manager.stop()],
    ['a direct client.stop()', (h: Harness) => h.manager.clientFor('acc-1')!.stop()],
  ])(
    'U11d a listener that re-enters sessionFor on idle after %s gets no session',
    async (_label, stop) => {
      const fakes = fakeClients();
      const h = harness({ openClient: fakes.openClient });
      h.state.candidates = [candidate(1)];
      await h.manager.tick();
      await until('the client', () => fakes.made.length === 1);
      const client = fakes.made[0]!;
      client.hear({ type: 'user_data', user: USER_1 });
      expect(h.manager.sessionFor('acc-1')).toBe(client);
      const seenOnIdle: unknown[] = [];
      client.onState((change) => {
        if (change.to === BrokerSocketState.Idle) seenOnIdle.push(h.manager.sessionFor('acc-1'));
      });
      await stop(h);
      expect(seenOnIdle).toEqual([undefined]);
      expect(h.manager.sessionFor('acc-1')).toBeUndefined();
    },
  );

  it('U17a a token source that throws: the start failed line by name, dropped, held back', async () => {
    const h = harness({
      tokens: () => Promise.reject(new TypeError(`token source broke on ${tokenOf(1)}`)),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the line', () => h.logs('broker session start failed').length === 1);
    expect(h.logs('broker session start failed')).toEqual([
      expect.objectContaining({
        level: LEVEL.error,
        accountId: 'acc-1',
        err: expect.objectContaining({ name: 'TypeError' }),
      }),
    ]);
    expect(h.manager.size).toBe(0);
    await h.manager.tick();
    expect(h.tokenCalls).toHaveLength(1);
    expect(h.candidateCalls.at(-1)).toEqual(['acc-1']);
    await tickUntil(h, 'the retry after the hold-back', () => h.tokenCalls.length === 2);
  });

  it('U17b a client whose start() throws on the refresh path: the same line, dropped, held back', async () => {
    const fakes = fakeClients();
    let issued = 0;
    const h = harness({
      openClient: fakes.openClient,
      tokens: () => Promise.resolve({ ok: true, accessToken: `SECRET-${(issued += 1)}` }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the client', () => fakes.made.length === 1);
    const client = fakes.made[0]!;
    client.start = () => {
      throw new Error('start refused');
    };
    client.fire(BrokerSocketState.TokenExpired);
    await until('the line', () => h.logs('broker session start failed').length === 1);
    expect(h.logs('broker session start failed')).toEqual([
      expect.objectContaining({
        level: LEVEL.error,
        accountId: 'acc-1',
        err: expect.objectContaining({ name: 'Error' }),
      }),
    ]);
    expect(h.manager.size).toBe(0);
    expect(client.stops).toBe(1);
    await h.manager.tick();
    expect(fakes.made).toHaveLength(1);
    await tickUntil(h, 'a new client after the hold-back', () => fakes.made.length === 2);
  });

  it('U12 stop() closes every socket, aborts a token fetch, drops the queued writes and keeps its budget', async () => {
    const write = deferred<BalanceSnapshotWrite>();
    let signal: AbortSignal | undefined;
    const h = harness({
      tokens: (accountId, options) => {
        if (accountId === 'acc-1') return grant(accountId);
        signal = options.signal;
        return new Promise((resolve) => {
          options.signal?.addEventListener('abort', () =>
            resolve({ ok: false, reason: AccessTokenUnavailable.BackendUnreachable }),
          );
        });
      },
      writers: (writes) => ({
        ...recordingWriters(writes),
        snapshot: () => write.promise,
      }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    const heard: BrokerEvent[] = [];
    h.manager.clientFor('acc-1')!.onEvent((event) => heard.push(event));
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('1.00'));
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('2.00'));
    await until('both balances heard', () => heard.length === 2);
    h.state.candidates = [candidate(1), candidate(2)];
    await h.manager.tick();
    await until('the second fetch', () => signal !== undefined);

    const stopping = track(h.manager.stop());
    await until('stop() returned within its budget', () => stopping.settled);
    expect(signal?.aborted).toBe(true);
    expect(h.logs('broker session writes dropped at stop')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, dropped: 2 }),
    ]);
    expect(h.logs('broker session stop budget exceeded')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, pending: 1 }),
    ]);
    expect(h.logs('broker session token unavailable')).toEqual([]);
    await until('no socket', () => broker.socket.sockets().length === 0);
    expect(h.writes).toEqual([]);
    expect(h.manager.size).toBe(0);
  });

  it('U10c a dead-letter write that never answers holds the account queue for its timeout only (#92)', async () => {
    let added = 0;
    const h = harness({
      writers: (writes) => ({
        ...recordingWriters(writes),
        snapshot: () => Promise.reject(new Error('connection terminated')),
      }),
      deadLetters: {
        add: () => {
          added += 1;
          return new Promise(() => undefined);
        },
      },
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    await until('the dead-letter write', () => added === 1);
    broker.socket.emitRaw({ userId: 1 }, 'user.demo.update_balance', balanceWire('5.00'));
    await until('the balance write after the timeout', () => h.writes.length === 1);
    expect(h.logs('dlq_publish_failed')).toEqual([
      expect.objectContaining({ accountId: 'acc-1', source: 'user_data', reason: 'timeout' }),
    ]);
  });

  it('U12c stop() waits for a dead-letter write in flight (#92)', async () => {
    const sink = deferred<unknown>();
    let added = 0;
    const h = harness({
      config: { stopBudgetMs: 2_000 },
      writers: (writes) => ({
        ...recordingWriters(writes),
        snapshot: () => Promise.reject(new Error('connection terminated')),
      }),
      deadLetters: {
        add: () => {
          added += 1;
          return sink.promise;
        },
      },
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    await until('the dead-letter write in flight', () => added === 1);
    const stopping = track(h.manager.stop());
    await quiet();
    expect(stopping.settled).toBe(false);
    sink.resolve(undefined);
    await until('stop() returned', () => stopping.settled);
  });

  it('U12b stop() waits for the write in flight when it ends within the budget', async () => {
    const write = deferred<BalanceSnapshotWrite>();
    let snapshots = 0;
    const h = harness({
      config: { stopBudgetMs: 2_000 },
      writers: (writes) => ({
        ...recordingWriters(writes),
        snapshot: () => {
          snapshots += 1;
          return write.promise;
        },
      }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await readyFor(h, 'acc-1');
    await until('the write in flight', () => snapshots === 1);
    const stopping = track(h.manager.stop());
    await quiet();
    expect(stopping.settled).toBe(false);
    write.resolve({ written: true });
    await until('stop() returned', () => stopping.settled);
    expect(h.logs('broker session stop budget exceeded')).toEqual([]);
  });

  it('U13 ticks are single-flight, and a failing scan keeps the sessions', async () => {
    const h = harness();
    h.state.candidates = [candidate(1)];
    const first = h.manager.tick();
    const second = h.manager.tick();
    expect(second).toBe(first);
    await first;
    expect(h.candidateCalls).toHaveLength(1);
    await readyFor(h, 'acc-1');
    h.state.failCandidates = true;
    await h.manager.tick();
    expect(h.logs('broker session tick failed')).toEqual([
      expect.objectContaining({
        level: LEVEL.error,
        err: expect.objectContaining({ name: 'Error' }),
      }),
    ]);
    expect(h.manager.clientFor('acc-1')?.state).toBe(BrokerSocketState.Ready);
    expect(broker.socket.sockets()).toHaveLength(1);
  });

  it('U15 a tick returns while the starts it queued are pending', async () => {
    const tokens: { accountId: string; resolve: (outcome: AccessTokenOutcome) => void }[] = [];
    const h = harness({
      tokens: (accountId) => {
        const token = deferred<AccessTokenOutcome>();
        tokens.push({ accountId, resolve: token.resolve });
        return token.promise;
      },
    });
    h.state.candidates = USERS.map(candidate);
    const ticked = track(h.manager.tick());
    await until('the tick returned', () => ticked.settled);
    expect(h.logs('broker session tick')).toEqual([
      expect.objectContaining({ candidates: 8, sessions: 0, starting: 4, queued: 4 }),
    ]);
    for (let started = 0; started < USERS.length; started += 1) {
      await until(`fetch ${started + 1}`, () => tokens.length > started);
      const { accountId, resolve } = tokens[started]!;
      resolve(await grant(accountId));
    }
    await until('8 sockets', () => broker.socket.sockets().length === 8);
  });

  it('U16 a candidate that left the set while starting gets no socket', async () => {
    const token = deferred<AccessTokenOutcome>();
    const h = harness({ tokens: () => token.promise });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    expect(h.manager.size).toBe(1);
    h.state.candidates = [];
    await h.manager.tick();
    expect(h.manager.size).toBe(0);
    token.resolve(await grant('acc-1'));
    await quiet();
    expect(broker.socket.sockets()).toEqual([]);
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
  });
});

describe('the lease (#93)', () => {
  // short enough to run: the fence 200 ms after an acquire or a renewal is sent
  const LEASE = { leaseRenewMs: 50, leaseFenceMs: 200, leaseTtlMs: 250 };
  const leaseOps = (h: Harness) => h.leaseCalls.map((call) => call.op);
  async function verifiedSession(h: Harness, fakes: ReturnType<typeof fakeClients>) {
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the client', () => fakes.made.length === 1);
    const client = fakes.made[0]!;
    client.hear({ type: 'user_data', user: USER_1 });
    expect(h.manager.sessionFor('acc-1')).toBe(client);
    return client;
  }

  it('L1 a busy account costs no token fetch and no client, and is held back', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient, leases: { acquire: async () => false } });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the busy line', () => h.logs('broker session lease busy').length === 1);
    expect(h.tokenCalls).toEqual([]);
    expect(fakes.made).toEqual([]);
    expect(h.manager.size).toBe(0);
    await h.manager.tick();
    expect(leaseOps(h)).toEqual(['acquire']);
  });

  it('L2 an acquire that throws is a failed start, no client', async () => {
    const fakes = fakeClients();
    const h = harness({
      openClient: fakes.openClient,
      leases: { acquire: () => Promise.reject(new Error('database down')) },
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the failed start', () => h.logs('broker session start failed').length === 1);
    expect(h.tokenCalls).toEqual([]);
    expect(fakes.made).toEqual([]);
  });

  it('L3 takes the lease before the token', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient });
    await verifiedSession(h, fakes);
    expect(leaseOps(h)).toEqual(['acquire']);
    expect(h.tokenCalls).toHaveLength(1);
  });

  it('L4 a renewal without the account drops it at once, not after the idle grace', async () => {
    const fakes = fakeClients();
    const h = harness({ openClient: fakes.openClient, leases: { renew: async () => [] } });
    const client = await verifiedSession(h, fakes);
    await h.manager.renewLeases();
    expect(client.stops).toBe(1);
    expect(h.manager.sessionFor('acc-1')).toBeUndefined();
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
    expect(h.logs('broker session lease lost')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, accountId: 'acc-1' }),
    ]);
  });

  it('L5 sessionFor refuses past the fence even before the fence timer ran', async () => {
    const fakes = fakeClients();
    let offset = 0;
    const h = harness({
      openClient: fakes.openClient,
      monotonicNow: () => performance.now() + offset,
    });
    const client = await verifiedSession(h, fakes);
    // the clock past the fence (25 s in CONFIG); the timer, armed in real time, has not run
    offset = CONFIG.leaseFenceMs + 1;
    expect(h.manager.sessionFor('acc-1')).toBeUndefined();
    expect(h.manager.clientFor('acc-1')).toBe(client);
  });

  it('L6 a renewal that never answers: the fence closes the socket, and its later events write nothing', async () => {
    const fakes = fakeClients();
    const h = harness({
      openClient: fakes.openClient,
      config: LEASE,
      leases: { renew: () => new Promise(() => undefined) },
    });
    const client = await verifiedSession(h, fakes);
    void h.manager.renewLeases();
    await until('the fence', () => h.logs('broker session lease fenced').length === 1);
    expect(client.stops).toBe(1);
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
    const writes = h.writes.length;
    client.hear({ type: 'user_data', user: USER_1 });
    await quiet();
    expect(h.writes).toHaveLength(writes);
  });

  it('L7 one failed renewal fences nothing, and the next answer moves the fence', async () => {
    const fakes = fakeClients();
    let renewals = 0;
    let offset = 0;
    const h = harness({
      openClient: fakes.openClient,
      monotonicNow: () => performance.now() + offset,
      leases: {
        renew: async (ids) => {
          renewals += 1;
          if (renewals === 1) throw new Error('database down');
          return [...ids];
        },
      },
    });
    const client = await verifiedSession(h, fakes);
    await h.manager.renewLeases();
    expect(h.logs('broker session lease renewal failed')).toHaveLength(1);
    expect(h.manager.sessionFor('acc-1')).toBe(client);
    // the second renewal is sent 15 s in, so it holds until 40 s: past the acquire's 25 s
    offset = 15_000;
    await h.manager.renewLeases();
    offset = CONFIG.leaseFenceMs + 5_000;
    expect(h.manager.sessionFor('acc-1')).toBe(client);
    expect(client.stops).toBe(0);
  });

  it('L8 stop() closes every socket before it releases, and a hanging release ends at the budget', async () => {
    const fakes = fakeClients();
    const order: string[] = [];
    const h = harness({
      openClient: fakes.openClient,
      leases: {
        release: () => {
          order.push(`release after ${fakes.made[0]!.stops} stop(s)`);
          return new Promise(() => undefined);
        },
      },
    });
    await verifiedSession(h, fakes);
    await h.manager.stop();
    expect(order).toEqual(['release after 1 stop(s)']);
    expect(h.logs('broker session stop budget exceeded')).toHaveLength(1);
  });

  it('L8b a release that throws is logged, and stop() still returns', async () => {
    const fakes = fakeClients();
    const h = harness({
      openClient: fakes.openClient,
      leases: { release: () => Promise.reject(new Error('database down')) },
    });
    await verifiedSession(h, fakes);
    await h.manager.stop();
    expect(h.logs('broker session lease release failed')).toEqual([
      expect.objectContaining({ level: LEVEL.error, err: expect.objectContaining({ name: 'Error' }) }),
    ]);
  });

  // the same lease moves from the starting entry to the running one: a renewal answered across
  // that handoff must still move the fence
  it('L12 a renewal sent while the session was starting moves the running session fence', async () => {
    const fakes = fakeClients();
    let offset = 0;
    const token = deferred<AccessTokenOutcome>();
    let answer: (ids: string[]) => void = () => undefined;
    const h = harness({
      openClient: fakes.openClient,
      monotonicNow: () => performance.now() + offset,
      tokens: () => token.promise,
      leases: { renew: () => new Promise<string[]>((resolve) => (answer = resolve)) },
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the token fetch', () => h.tokenCalls.length === 1);
    // sent 15 s in, while starting: it holds until 40 s
    offset = 15_000;
    const renewal = h.manager.renewLeases();
    await until('the renewal sent', () => h.leaseCalls.some((c) => c.op === 'renew'));
    token.resolve(await grant('acc-1'));
    await until('the client', () => fakes.made.length === 1);
    fakes.made[0]!.hear({ type: 'user_data', user: USER_1 });
    answer(['acc-1']);
    await renewal;
    // past the acquire's 25 s, inside the renewal's 40 s
    offset = CONFIG.leaseFenceMs + 5_000;
    expect(h.manager.sessionFor('acc-1')).toBe(fakes.made[0]);
  });

  it('L13 a renewal that hangs counts as failed at its timeout, and the next one is sent', async () => {
    const fakes = fakeClients();
    const h = harness({
      openClient: fakes.openClient,
      config: { leaseRenewTimeoutMs: 50 },
      leases: { renew: () => new Promise(() => undefined) },
    });
    await verifiedSession(h, fakes);
    await h.manager.renewLeases();
    expect(h.logs('broker session lease renewal timed out')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, leases: 1 }),
    ]);
    await h.manager.renewLeases();
    expect(h.leaseCalls.filter((c) => c.op === 'renew')).toHaveLength(2);
    expect(h.manager.clientFor('acc-1')).toBe(fakes.made[0]);
  });

  it('L14 an acquire that hangs past its timeout starts nothing, and the account is held back', async () => {
    const fakes = fakeClients();
    const h = harness({
      openClient: fakes.openClient,
      config: { leaseRenewTimeoutMs: 50 },
      leases: { acquire: () => new Promise(() => undefined) },
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the timeout', () => h.logs('broker session lease acquire timed out').length === 1);
    expect(h.tokenCalls).toEqual([]);
    expect(fakes.made).toEqual([]);
    expect(h.manager.size).toBe(0);
  });

  // an event-loop stall can deliver the token answer before the overdue fence timer runs
  it('L15 a token answered past the fence opens no socket', async () => {
    const fakes = fakeClients();
    let offset = 0;
    const token = deferred<AccessTokenOutcome>();
    const h = harness({
      openClient: fakes.openClient,
      monotonicNow: () => performance.now() + offset,
      tokens: () => token.promise,
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the token fetch', () => h.tokenCalls.length === 1);
    offset = CONFIG.leaseFenceMs + 1;
    token.resolve(await grant('acc-1'));
    await until('the fence', () => h.logs('broker session lease fenced').length === 1);
    expect(fakes.made).toEqual([]);
    expect(h.manager.size).toBe(0);
  });

  it('L16 a token refreshed past the fence restarts no socket', async () => {
    const fakes = fakeClients();
    let offset = 0;
    let issued = 0;
    const h = harness({
      openClient: fakes.openClient,
      monotonicNow: () => performance.now() + offset,
      tokens: () => Promise.resolve({ ok: true, accessToken: `SECRET-${(issued += 1)}` }),
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the client', () => fakes.made.length === 1);
    const client = fakes.made[0]!;
    offset = CONFIG.leaseFenceMs + 1;
    client.fire(BrokerSocketState.TokenExpired);
    await until('the fence', () => h.logs('broker session lease fenced').length === 1);
    expect(client.starts).toEqual(['SECRET-1']);
    expect(h.manager.clientFor('acc-1')).toBeUndefined();
  });

  it('L9 a renewal answer leaves alone an entry started after it was sent', async () => {
    const fakes = fakeClients();
    let answer: (ids: string[]) => void = () => undefined;
    const h = harness({
      openClient: fakes.openClient,
      leases: { renew: () => new Promise<string[]>((resolve) => (answer = resolve)) },
    });
    await verifiedSession(h, fakes);
    const renewal = h.manager.renewLeases();
    h.state.candidates = [candidate(1), candidate(2)];
    await h.manager.tick();
    await until('the second client', () => fakes.made.length === 2);
    answer(['acc-1']);
    await renewal;
    expect(h.manager.clientFor('acc-2')).toBe(fakes.made[1]);
    expect(h.logs('broker session lease lost')).toEqual([]);
  });

  it('L10 an acquire still in flight is not renewed, and is once it answered', async () => {
    const fakes = fakeClients();
    let grantLease: (granted: boolean) => void = () => undefined;
    const h = harness({
      openClient: fakes.openClient,
      leases: { acquire: () => new Promise<boolean>((resolve) => (grantLease = resolve)) },
    });
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the acquire in flight', () => leaseOps(h).includes('acquire'));
    await h.manager.renewLeases();
    expect(leaseOps(h)).toEqual(['acquire']);
    grantLease(true);
    await until('the client', () => fakes.made.length === 1);
    await h.manager.renewLeases();
    expect(h.leaseCalls.at(-1)).toEqual({ op: 'renew', ids: ['acc-1'] });
    expect(h.manager.clientFor('acc-1')).toBe(fakes.made[0]);
  });

  it('L11 a renewal answer for a dropped entry does not touch the entry that replaced it', async () => {
    const fakes = fakeClients();
    let answer: (ids: string[]) => void = () => undefined;
    let renewals = 0;
    const h = harness({
      openClient: fakes.openClient,
      leases: {
        renew: (ids) => {
          renewals += 1;
          return renewals === 1
            ? new Promise<string[]>((resolve) => (answer = resolve))
            : Promise.resolve([...ids]);
        },
      },
    });
    const first = await verifiedSession(h, fakes);
    const renewal = h.manager.renewLeases();
    first.fire(BrokerSocketState.DisconnectedByServer);
    await tickUntil(h, 'a new client after the hold-back', () => fakes.made.length === 2);
    answer([]);
    await renewal;
    expect(h.manager.clientFor('acc-1')).toBe(fakes.made[1]);
    expect(h.logs('broker session lease lost')).toEqual([]);
  });
});

describe('the socket loss signal (#96)', () => {
  const GRACE = 60;
  function observed(fakes: ReturnType<typeof fakeClients>, config: Partial<SessionManagerConfig> = {}) {
    const lost: string[] = [];
    const h = harness({
      openClient: fakes.openClient,
      config,
      lossObserver: { lost: (accountId) => lost.push(accountId), graceMs: GRACE },
    });
    return { h, lost };
  }
  async function started(h: Harness, fakes: ReturnType<typeof fakeClients>) {
    h.state.candidates = [candidate(1)];
    await h.manager.tick();
    await until('the client', () => fakes.made.length === 1);
    return fakes.made[0]!;
  }
  // the next tick reads Date.now() against the moment the session left ready
  const pastGrace = () => {
    const mark = Date.now();
    return until('past the grace', () => Date.now() > mark + GRACE);
  };

  it('S1 a reconnect within the grace is not a loss', async () => {
    const fakes = fakeClients();
    const { h, lost } = observed(fakes);
    const client = await started(h, fakes);
    client.fire(BrokerSocketState.Reconnecting);
    client.fire(BrokerSocketState.Ready);
    await pastGrace();
    await h.manager.tick();
    expect(lost).toEqual([]);
  });

  it('S2 a session still not ready after the grace is one loss, not one per tick', async () => {
    const fakes = fakeClients();
    const { h, lost } = observed(fakes);
    const client = await started(h, fakes);
    client.fire(BrokerSocketState.Reconnecting);
    await h.manager.tick();
    expect(lost).toEqual([]);
    await pastGrace();
    await h.manager.tick();
    await h.manager.tick();
    expect(lost).toEqual(['acc-1']);
    expect(h.manager.running).toBe(1);
  });

  it('S3 disconnected_by_server after ready is a loss at once', async () => {
    const fakes = fakeClients();
    const { h, lost } = observed(fakes);
    const client = await started(h, fakes);
    client.fire(BrokerSocketState.DisconnectedByServer);
    expect(lost).toEqual(['acc-1']);
    expect(h.manager.running).toBe(0);
  });

  // the token refresh it starts may outlast the grace: the session must not count meanwhile
  it.each([BrokerSocketState.TokenExpired, BrokerSocketState.AuthFailed])(
    'S4 %s is credentials, not a loss, however long the refresh takes',
    async (state) => {
      const fakes = fakeClients();
      const refreshed = deferred<AccessTokenOutcome>();
      let fetches = 0;
      const lost: string[] = [];
      const h = harness({
        openClient: fakes.openClient,
        tokens: (accountId) => {
          fetches += 1;
          return fetches === 1 ? grant(accountId) : refreshed.promise;
        },
        lossObserver: { lost: (accountId) => lost.push(accountId), graceMs: GRACE },
      });
      const client = await started(h, fakes);
      client.fire(BrokerSocketState.Reconnecting);
      client.fire(state);
      await pastGrace();
      await h.manager.tick();
      expect(lost).toEqual([]);
    },
  );

  it('S5 our own idle drop is not a loss', async () => {
    const fakes = fakeClients();
    const { h, lost } = observed(fakes, { idleGraceMs: 20 });
    await started(h, fakes);
    h.state.candidates = [];
    await h.manager.tick();
    await tickUntil(h, 'the idle drop', () => h.manager.size === 0);
    await pastGrace();
    await h.manager.tick();
    expect(lost).toEqual([]);
  });

  it('S6 a session that never reached ready is not a loss', async () => {
    const fakes = fakeClients({ readyOnStart: false });
    const { h, lost } = observed(fakes);
    const client = await started(h, fakes);
    client.fire(BrokerSocketState.Reconnecting);
    await pastGrace();
    await h.manager.tick();
    client.fire(BrokerSocketState.DisconnectedByServer);
    expect(lost).toEqual([]);
  });
});

// last in the file: it reads the lines every case above wrote
describe('logs', () => {
  it('U14 never carry a token, an amount or the URL, and name every path the cases covered', () => {
    const host = broker.url.replace('http://', '').split(':')[0]!;
    const port = broker.url.split(':').at(-1)!;
    for (const line of allLines) {
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain('1.27');
      expect(line).not.toContain(`${host}:${port}`);
    }
    const messages = new Set(allLines.map((line) => (JSON.parse(line) as LogEntry).msg));
    for (const msg of [
      'broker session tick',
      'broker session tick failed',
      'broker sessions capped',
      'broker session closed',
      'broker session token refused',
      'broker session token unavailable',
      'broker session waits for a token exchange',
      'broker session token unchanged',
      'broker session user mismatch',
      'broker session event before user.data',
      'broker session write failed',
      'balance snapshot not written',
      'intent settled from close_trade.success',
      'closed trade not applied',
      'broker session writes dropped at stop',
      'broker session stop budget exceeded',
      'broker session start failed',
      'broker session lease busy',
      'broker session lease lost',
      'broker session lease fenced',
      'broker session lease renewal failed',
      'broker session lease release failed',
      'broker session lease renewal timed out',
      'broker session lease acquire timed out',
    ]) {
      expect(messages, msg).toContain(msg);
    }
  });
});
