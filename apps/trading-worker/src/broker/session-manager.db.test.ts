import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import {
  applyBalanceEvent,
  brokerBalanceSnapshots,
  brokerTrades,
  createTradeIntent,
  findTradeIntent,
  listSessionCandidates,
  rejectIntent,
  settleClosedTrades,
  startReconciling,
  tokenLedger,
  upsertBalanceSnapshot,
  users,
} from '@binarius/db';
import {
  createTempDatabase,
  intentRequest,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import {
  MockSocketPayload,
  MockTradeOutcome,
  startMockBroker,
  type MockBroker,
} from '@binarius/mock-broker';
import {
  BrokerSocketEvent,
  logOptions,
  TokenLedgerKind,
  TradeIntentFailureReason,
  TradeIntentStatus,
  type DecimalString,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import { processIntentJob, type ProcessorDeps } from '../intents/processor';
import { createTradeCommandExecutor } from '../intents/trade-command-executor';
import type { AccessTokenOutcome } from './access-token';
import { BrokerEventType, type BrokerEvent } from './events';
import type { SessionManagerConfig } from './session-config';
import {
  createBrokerSessionManager,
  type BrokerSessionManager,
  type SessionWriters,
} from './session-manager';
import { BrokerSocketState } from './socket';

// The end-to-end scenario of #101 on the mock broker: connect → auth → subscribe → price → open
// success/fail → close → balance, through the production composition (the session manager as
// the executor's TradeSessionSource, processIntentJob) and the
// production writers. Every oracle is the persisted state.

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}

const BROKER_USER = 7;
const TOKEN = 'SECRET-TOKEN-of-user-7';
const EURUSD = 101;
const TIMING = {
  connectTimeoutMs: 1_000,
  authTimeoutMs: 200,
  reconnectDelayMs: 20,
  reconnectDelayMaxMs: 40,
  jitter: 0,
};
const CONFIG: SessionManagerConfig = {
  tickMs: 1_000,
  idleGraceMs: 200,
  retryMs: 300,
  refusalRetryMs: 1_500,
  maxSessions: 10,
  startConcurrency: 4,
  stopBudgetMs: 500,
  watchWindowMs: 600_000,
  // long enough that no lease is renewed or fenced unless a case shortens them
  leaseTtlMs: 30_000,
  leaseRenewMs: 6_000,
  leaseRenewTimeoutMs: 3_000,
  leaseFenceMs: 25_000,
  lossGraceMs: 2_000,
};
// a negative wait, past the longest reconnection delay of TIMING
const QUIET_MS = 100;
const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

type LogEntry = Record<string, unknown> & { level: number; msg: string };

let tmp: TempDatabase;
let broker: MockBroker;
let manager: BrokerSessionManager;
let telegramUserId: string;
let userId: string;
let accountId: string;
const lines: string[] = [];
const logger = pino(logOptions('debug'), { write: (line: string) => void lines.push(line) });
const logs = (msg: string) =>
  lines.map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry.msg === msg);
const heard: BrokerEvent[] = [];
let writesInFlight = 0;
let tokenCalls = 0;

const counted =
  <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    writesInFlight += 1;
    try {
      return await write(...args);
    } finally {
      writesInFlight -= 1;
    }
  };

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
  broker.users.register({ id: BROKER_USER, accessToken: TOKEN, demo: { available: '100.00' } });
  const user = await seedUser(tmp.db);
  telegramUserId = user.telegramUserId;
  userId = user.userId;
  accountId = await seedBrokerAccount(tmp.db, user.userId, { brokerUserId: String(BROKER_USER) });
  const db = tmp.db;
  const writers: SessionWriters = {
    snapshot: counted((id, brokerUser, modes) =>
      upsertBalanceSnapshot(db, {
        brokerAccountId: id,
        user: brokerUser,
        requested: false,
        eventAt: modes,
      }),
    ),
    balanceEvent: counted((id, mode, balance) =>
      applyBalanceEvent(db, { brokerAccountId: id, mode, balance }),
    ),
    closedTrades: counted((id, trades) => settleClosedTrades(db, { brokerAccountId: id, trades })),
  };
  manager = createBrokerSessionManager({
    url: broker.url,
    deadLetters: { add: () => Promise.resolve() },
    leases: {
      acquire: () => Promise.resolve(true),
      renew: (ids) => Promise.resolve([...ids]),
      release: () => Promise.resolve(0),
    },
    candidates: (options) => listSessionCandidates(db, options),
    tokens: {
      accessToken: (): Promise<AccessTokenOutcome> => {
        tokenCalls += 1;
        return Promise.resolve({ ok: true, accessToken: TOKEN });
      },
    },
    writers,
    logger,
    config: CONFIG,
    timing: TIMING,
  });
});

afterAll(async () => {
  await manager.stop();
  await broker.close();
  await tmp.drop();
});

const executor = () =>
  createTradeCommandExecutor({
    sessions: manager,
    rest: createBrokerRestClient({ baseUrl: broker.url }),
    tokens: { accessToken: () => Promise.resolve({ ok: true, accessToken: TOKEN }) },
    logger,
  });

const deps = (submitAckTimeoutMs = 5_000): ProcessorDeps => ({
  db: tmp.db,
  executor: executor(),
  logger,
  config: { intentMaxAgeMs: 60_000, submitAckTimeoutMs, staleSubmittingMs: 60_000 },
});

async function newIntent(patch: Parameters<typeof intentRequest>[1] = {}) {
  const { intent } = await createTradeIntent(
    tmp.db,
    intentRequest(telegramUserId, { assetId: EURUSD, amount: '1.50' as DecimalString, ...patch }),
  );
  return intent;
}

async function snapshot() {
  const [row] = await tmp.db
    .select()
    .from(brokerBalanceSnapshots)
    .where(eq(brokerBalanceSnapshots.brokerAccountId, accountId));
  return row;
}

const intentOf = async (id: string) => (await findTradeIntent(tmp.db, id))!;
const client = () => manager.clientFor(accountId);
const userRow = async () => (await tmp.db.select().from(users).where(eq(users.id, userId)))[0]!;

describe('the session scenario on the mock broker', () => {
  let firstIntentId = '';
  let opened: { intentId: string; brokerTradeId: string } | undefined;

  it('E1 connect → auth: an account in work gets a session, and user.data is its snapshot', async () => {
    firstIntentId = (await newIntent()).id;
    await manager.tick();
    await until('the snapshot', async () => (await snapshot()) !== undefined);
    expect(await snapshot()).toMatchObject({
      demoAvailable: '100.00000000',
      demoHeld: '0.00000000',
      demoTotal: '100.00000000',
      realAvailable: '0.00000000',
      realTotal: '0.00000000',
      minTradeAmount: '1.00000000',
      demoEventAt: expect.any(Date),
      realEventAt: expect.any(Date),
      restObservedAt: expect.any(Date),
      lastRefreshError: null,
      lastRequestedAt: null,
    });
    expect(client()?.state).toBe(BrokerSocketState.Ready);
    expect(
      broker.socket.journal.filter((record) => record.event === BrokerSocketEvent.UserAuth),
    ).toEqual([expect.objectContaining({ userId: BROKER_USER, outcome: 'handled' })]);
    client()!.onEvent((event) => heard.push(event));
  });

  it('E2 subscribe → price: the subscription reaches the broker and a price comes back', async () => {
    client()!.subscribe([EURUSD]);
    await until(
      'the subscription',
      () => broker.socket.sockets()[0]?.subscriptions.includes(EURUSD) === true,
    );
    expect(broker.socket.pushPrice(EURUSD)).toBe(1);
    await until('a price', () => heard.some((event) => event.type === BrokerEventType.PriceUpdate));
  });

  it('E3 open success: accepted over the socket, and update_balance moves the demo amounts', async () => {
    const before = (await snapshot())!;
    const queued = firstIntentId;
    expect(await processIntentJob(deps(), { intentId: queued })).toBe('accepted');
    const row = await intentOf(queued);
    expect(row).toMatchObject({ status: 'accepted', transport: 'socket' });
    const [trade] = await tmp.db
      .select()
      .from(brokerTrades)
      .where(eq(brokerTrades.intentId, queued));
    expect(trade).toMatchObject({ status: 'open' });
    opened = { intentId: queued, brokerTradeId: trade!.brokerTradeId };
    await until('the balance event', async () => (await snapshot())!.demoHeld === '1.50000000');
    const after = (await snapshot())!;
    expect(after).toMatchObject({
      demoAvailable: '98.50000000',
      demoHeld: '1.50000000',
      demoTotal: '100.00000000',
      realAvailable: before.realAvailable,
      realEventAt: before.realEventAt,
      restObservedAt: before.restObservedAt,
    });
    expect(after.demoEventAt!.getTime()).toBeGreaterThanOrEqual(before.demoEventAt!.getTime());
  });

  it('E4 close → balance: close_trade.success settles the intent, update_balance the amounts', async () => {
    const { intentId, brokerTradeId } = opened!;
    const tokensBefore = (await userRow()).tokenBalance;
    const closed = broker.trades.settle(Number(brokerTradeId), { outcome: MockTradeOutcome.Win });
    await until(
      'settled',
      async () => (await intentOf(intentId)).status === TradeIntentStatus.Settled,
    );
    const ledger = await tmp.db
      .select({ kind: tokenLedger.kind })
      .from(tokenLedger)
      .where(and(eq(tokenLedger.intentId, intentId), eq(tokenLedger.kind, TokenLedgerKind.Settle)));
    expect(ledger).toHaveLength(1);
    expect((await userRow()).tokenBalance).toBe(tokensBefore - 1n);
    const [trade] = await tmp.db
      .select()
      .from(brokerTrades)
      .where(eq(brokerTrades.intentId, intentId));
    expect(trade).toMatchObject({ status: 'closed', profit: expect.any(String) });
    expect(logs('intent settled from close_trade.success')).toEqual([
      expect.objectContaining({ accountId, intentId, brokerTradeId }),
    ]);
    const expected = cents(100) + toCents(String(closed.profit));
    await until(
      'the balance after the close',
      async () => (await snapshot())!.demoHeld === '0.00000000',
    );
    expect(toCents((await snapshot())!.demoAvailable)).toBe(expected);
  });

  it('E5 open fail: below the minimum is rejected by the broker, the reserve released', async () => {
    const before = (await snapshot())!;
    const intent = await newIntent({ amount: '0.50' as DecimalString });
    expect(await processIntentJob(deps(), { intentId: intent.id })).toBe('rejected');
    expect(await intentOf(intent.id)).toMatchObject({
      status: 'rejected',
      lastError: TradeIntentFailureReason.BrokerRejected,
    });
    expect(logs('trade command refused')).toEqual([
      expect.objectContaining({ intentId: intent.id, transport: 'socket' }),
    ]);
    expect((await userRow()).tokenReserved).toBe(0n);
    await quiet();
    expect(await snapshot()).toEqual(before);
  });

  it('E6 a late answer after the deadline: the connection is replaced, the next intent gets its own answer', async () => {
    const late = await newIntent({ durationSec: 1 });
    broker.socket.failNext('openTrade', { delayMs: 600 });
    expect(await processIntentJob(deps(300), { intentId: late.id })).toBe('unknown');
    expect(await intentOf(late.id)).toMatchObject({
      status: 'unknown',
      lastError: TradeIntentFailureReason.ExecutorTimeout,
    });
    const unknown = await intentOf(late.id);
    const reconciling = await startReconciling(tmp.db, {
      id: late.id,
      expectedVersion: unknown.version,
    });
    await tmp.db.transaction((tx) =>
      rejectIntent(tx, {
        id: late.id,
        from: TradeIntentStatus.Reconciling,
        expectedVersion: reconciling!.version,
        reason: TradeIntentFailureReason.ReconciliationNotFound,
      }),
    );
    // the next intent goes over the socket only once the new connection's user.data verified it
    await until(
      'the new connection, verified',
      () => client()?.connections === 2 && manager.sessionFor(accountId) !== undefined,
    );
    const heardBefore = heard.length;
    const next = await newIntent();
    expect(await processIntentJob(deps(), { intentId: next.id })).toBe('accepted');
    expect(await intentOf(next.id)).toMatchObject({ status: 'accepted', transport: 'socket' });
    const [trade] = await tmp.db
      .select()
      .from(brokerTrades)
      .where(eq(brokerTrades.intentId, next.id));
    expect(trade).toBeDefined();
    opened = { intentId: next.id, brokerTradeId: trade!.brokerTradeId };
    expect(heard.slice(heardBefore).map((event) => event.type)).not.toContain(
      BrokerEventType.OpenTradeFail,
    );
  });

  it('E8 idle: once no intent is open and the bot asked nothing, the session closes', async () => {
    broker.trades.settle(Number(opened!.brokerTradeId), { outcome: MockTradeOutcome.Loss });
    await until(
      'settled',
      async () => (await intentOf(opened!.intentId)).status === TradeIntentStatus.Settled,
    );
    await until('the idle close', async () => {
      await manager.tick();
      return client() === undefined;
    });
    await until('no socket', () => broker.socket.sockets().length === 0);
    expect(logs('broker session closed')).toEqual([
      expect.objectContaining({ accountId, reason: 'idle' }),
    ]);
  });

  it('E7 token expiry with the same token: dropped, one user.auth per retryMs, then nothing', async () => {
    await newIntent();
    await manager.tick();
    await until('ready', () => client()?.state === BrokerSocketState.Ready);
    const auths = () =>
      broker.socket.journal.filter((record) => record.event === BrokerSocketEvent.UserAuth).length;
    const authsBefore = auths();
    broker.users.revokeToken(TOKEN);
    await until('the drop', () => logs('broker session token unchanged').length === 1);
    expect(client()).toBeUndefined();
    await until('the retry refused', async () => {
      await manager.tick();
      return logs('broker session token unchanged').length === 2;
    });
    expect(auths()).toBe(authsBefore + 1);
    expect(logs('broker session token unchanged').map((entry) => entry.sessionState)).toEqual([
      BrokerSocketState.TokenExpired,
      BrokerSocketState.AuthFailed,
    ]);
    await manager.tick();
    await quiet();
    expect(auths()).toBe(authsBefore + 1);
    expect(tokenCalls).toBeGreaterThanOrEqual(3);
  });

  it('E9 stop() leaves no socket and no write in flight; no line carries a secret', async () => {
    await manager.stop();
    expect(broker.socket.sockets()).toEqual([]);
    expect(writesInFlight).toBe(0);
    expect(manager.size).toBe(0);
    for (const line of lines) expect(line).not.toContain('SECRET');
    expect(logs('broker session write failed')).toEqual([]);
    expect(logs('balance snapshot not written')).toEqual([]);
  });
});

const cents = (units: number) => BigInt(units) * 100n;
function toCents(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}
