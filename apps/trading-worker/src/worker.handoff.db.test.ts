import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  brokerBalanceSnapshots,
  brokerTrades,
  createDb,
  createTradeIntent,
  OutboxStatus,
  OutboxTopic,
  outboxEvents,
  tradeIntents,
  tradingSessions,
  upsertBalanceSnapshot,
} from '@binarius/db';
import {
  createTempDatabase,
  intentRequest,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  sessionSettings,
  type TempDatabase,
} from '@binarius/db/testing';
import {
  MockSocketPayload,
  MockTradeOutcome,
  startMockBroker,
  type MockBroker,
} from '@binarius/mock-broker';
import {
  AccessTokenRefusal,
  logOptions,
  SESSION_MAX_DURATION_MS,
  TradeAction,
  TradeIntentStatus,
  TradeTransport,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BrokerUser,
  type DecimalString,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import type { Env } from './env';
import { eurUsd, signalAnswer } from './trading-session/testing';
import { createWorker, type ShutdownResult, type TradingWorker, type WorkerTuning } from './worker';

// #95: the deploy's overlap, in one process. Two worker compositions (createWorker, the production
// wiring) share one Postgres, one Redis prefix and one mock broker; the old one shuts down while
// the new one runs, as scripts/deploy-worker.sh does with two containers. Every oracle is the
// persisted state, the mock broker's trades and sockets, or the worker's own log lines.

const baseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}
if (redisUrl === undefined || redisUrl === '') {
  throw new Error('REDIS_URL is required for apps/trading-worker integration tests (see README)');
}

const EURUSD = 101;
const prefix = `test-${randomBytes(4).toString('hex')}`;

// production's order and chains, with the waits a test can afford; the lease itself keeps
// production's TTL and fence, so no lease lapses inside a case
const TUNING: Partial<WorkerTuning> = {
  sessions: {
    tickMs: 100,
    idleGraceMs: 60_000,
    retryMs: 300,
    refusalRetryMs: 1_500,
    maxSessions: 50,
    startConcurrency: 4,
    stopBudgetMs: 1_000,
    watchWindowMs: 600_000,
    leaseTtlMs: 30_000,
    leaseRenewMs: 6_000,
    leaseRenewTimeoutMs: 3_000,
    leaseFenceMs: 25_000,
    lossGraceMs: 2_000,
  },
  socketTiming: {
    connectTimeoutMs: 1_000,
    authTimeoutMs: 500,
    reconnectDelayMs: 20,
    reconnectDelayMaxMs: 40,
    jitter: 0,
  },
  orchestrator: {
    tickMs: 100,
    batchSize: 50,
    attemptTimeoutMs: 2_000,
    retryMs: 1_000,
    candleSlackMs: 0,
    maxDurationMs: SESSION_MAX_DURATION_MS,
  },
  // above the held submit of H3 (HELD_REST_MS): the sweeper never overtakes a call still in flight
  staleSubmittingMs: 3_000,
  sweepIntervalMs: 100,
  reconcileTickMs: 100,
  reconcileRetryMs: 1_000,
  catchupTickMs: 1_000,
  catchupGraceMs: 10_000,
  phase1BudgetMs: 10_000,
  phase2BudgetMs: 4_000,
};
// a phase 1 that cannot outlast a held submit
const DIRTY_PHASE1_MS = 200;
const HELD_SOCKET_MS = 800;
const HELD_REST_MS = 1_500;

let tmp: TempDatabase;
let broker: MockBroker;
let publisher: Redis;
const queues = new Map<OutboxTopic, Queue>();
const accessTokens = new Map<string, string>();
let brokerUserSeq = 70_000;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
  publisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
  for (const topic of Object.values(OutboxTopic)) {
    queues.set(topic, new Queue(topic, { connection: publisher, prefix }));
  }
});

interface Running {
  name: string;
  worker: TradingWorker;
  pool: Pool;
  redis: Redis;
  lines: Record<string, unknown>[];
  result?: ShutdownResult;
}
const running: Running[] = [];

// a worker that a case left running (a failed assertion) is shut down before the next case
afterEach(async () => {
  for (const w of running.splice(0)) {
    if (w.result === undefined) await w.worker.shutdown('SIGTERM');
  }
});

afterAll(async () => {
  for (const queue of queues.values()) await queue.obliterate({ force: true });
  const deadLetters = new Queue('trading-intents-dead-letter', { connection: publisher, prefix });
  await deadLetters.obliterate({ force: true });
  await Promise.all([...queues.values(), deadLetters].map((queue) => queue.close()));
  await publisher.quit();
  await broker.close();
  await tmp.drop();
});

function envOf(sockets: boolean): Env {
  return {
    databaseUrl: tmp.url,
    redisUrl: redisUrl!,
    logLevel: 'debug',
    intentMaxAgeMs: 60_000,
    submitAckTimeoutMs: 5_000,
    workerConcurrency: 4,
    backendUrl: 'http://127.0.0.1:9',
    internalApiToken: 'unused-the-sources-are-stubbed',
    brokerApiBaseUrl: broker.url,
    brokerWsUrl: sockets ? broker.url : undefined,
    // no trip inside a case: the switch is not what this file tests
    circuitBreaker: { windowMs: 60_000, minFailures: 1_000, failurePercent: 100 },
  };
}

// one container of the deploy: its own pool, Redis connection and log sink
function startWorker(
  name: string,
  { sockets, tuning = {} }: { sockets: boolean; tuning?: Partial<WorkerTuning> },
): Running {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(logOptions('debug'), {
    write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const pool = new Pool({ connectionString: tmp.url });
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const worker = createWorker({
    env: envOf(sockets),
    db: createDb(pool),
    pool,
    redis,
    logger,
    testing: {
      tuning: { ...TUNING, ...tuning },
      queuePrefix: prefix,
      tokens: {
        accessToken: (accountId) => {
          const accessToken = accessTokens.get(accountId);
          return Promise.resolve(
            accessToken === undefined
              ? { ok: false, reason: AccessTokenRefusal.AccountNotFound }
              : { ok: true, accessToken },
          );
        },
      },
      signals: {
        evaluate: () => Promise.resolve({ ok: true, response: signalAnswer(TradeAction.Up) }),
      },
      pairs: {
        read: () =>
          Promise.resolve({
            ok: true,
            catalog: { pairs: [eurUsd()], fetchedAt: Date.now(), ageMs: 0, fresh: true },
          }),
      },
    },
  });
  const entry: Running = { name, worker, pool, redis, lines };
  running.push(entry);
  worker.start();
  return entry;
}

async function shutdown(w: Running, signal = 'SIGTERM'): Promise<ShutdownResult> {
  w.result = await w.worker.shutdown(signal);
  return w.result;
}

const logsOf = (w: Running, msg: string) => w.lines.filter((line) => line.msg === msg);
const recordedBy = (w: Running) =>
  new Set(logsOf(w, 'intent outcome recorded').map((line) => line.intentId as string));

// the backend's outbox publisher, by hand: every pending row becomes the job it would add
// (apps/backend/src/outbox/bullmq.ts: the intent id as job id, one attempt); `only` keeps a case
// to its own rows, so a failed case's leftovers cannot change the next one's count
async function publishPending(only?: readonly string[]): Promise<number> {
  const pending = eq(outboxEvents.status, OutboxStatus.Pending);
  const rows = await tmp.db
    .select({ id: outboxEvents.id, intentId: outboxEvents.intentId, topic: outboxEvents.topic })
    .from(outboxEvents)
    .where(only === undefined ? pending : and(pending, inArray(outboxEvents.intentId, [...only])));
  for (const row of rows) {
    await queues
      .get(row.topic)!
      .add(
        'intent',
        { intentId: row.intentId },
        { jobId: row.intentId, attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
    await tmp.db
      .update(outboxEvents)
      .set({ status: OutboxStatus.Published })
      .where(eq(outboxEvents.id, row.id));
  }
  return rows.length;
}

interface Account {
  brokerUserId: number;
  brokerAccountId: string;
  telegramUserId: string;
}

async function seedAccount({ snapshot = false } = {}): Promise<Account> {
  const brokerUserId = ++brokerUserSeq;
  const accessToken = `handoff-token-${brokerUserId}`;
  broker.users.register({ id: brokerUserId, accessToken, demo: { available: '10000.00' } });
  const user = await seedUser(tmp.db, { balance: 20n });
  const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId, {
    brokerUserId: String(brokerUserId),
  });
  accessTokens.set(brokerAccountId, accessToken);
  if (snapshot) {
    const balance = {
      available: '10000.00' as DecimalString,
      held: '0.00' as DecimalString,
      total: '10000.00' as DecimalString,
    };
    const brokerUser: BrokerUser = {
      id: String(brokerUserId),
      level: { code: 'standard', rank: 1 },
      minTradeAmount: '1.00' as DecimalString,
      real: {
        available: '0.00' as DecimalString,
        held: '0.00' as DecimalString,
        total: '0.00' as DecimalString,
      },
      demo: balance,
    };
    await upsertBalanceSnapshot(tmp.db, { brokerAccountId, user: brokerUser, requested: false });
  }
  return { brokerUserId, brokerAccountId, telegramUserId: user.telegramUserId };
}

async function newIntent(account: Account): Promise<string> {
  const { intent } = await createTradeIntent(
    tmp.db,
    intentRequest(account.telegramUserId, { assetId: EURUSD, amount: '1.50' as DecimalString }),
  );
  return intent.id;
}

const intentRows = (ids: readonly string[]) =>
  tmp.db.select().from(tradeIntents).where(inArray(tradeIntents.id, ids));
const statusOf = async (id: string) => (await intentRows([id]))[0]!.status;
const allIn = async (ids: readonly string[], statuses: readonly string[]) =>
  (await intentRows(ids)).every((row) => statuses.includes(row.status));
const OPEN_OR_SETTLED: readonly string[] = [TradeIntentStatus.Accepted, TradeIntentStatus.Settled];

// a socket that a session verified: the mock sets the user on user.auth and sends user.data right
// after, on the same connection, so any later event reaches the worker behind it
const socketsOf = (brokerUserId: number) =>
  broker.socket.sockets().filter((socket) => socket.userId === brokerUserId);

// H2's oracle: at every poll, at most one connected socket per broker user
function watchSockets() {
  let worst = 0;
  let polls = 0;
  const poll = () => {
    polls += 1;
    const perUser = new Map<number, number>();
    for (const socket of broker.socket.sockets()) {
      if (socket.userId === undefined) continue;
      perUser.set(socket.userId, (perUser.get(socket.userId) ?? 0) + 1);
    }
    for (const count of perUser.values()) worst = Math.max(worst, count);
  };
  const timer = setInterval(poll, 2);
  return {
    stop: () => {
      clearInterval(timer);
      poll();
      return { worst, polls };
    },
  };
}

const snapshotted = async (accounts: readonly Account[]) => {
  const rows = await tmp.db
    .select({ id: brokerBalanceSnapshots.brokerAccountId })
    .from(brokerBalanceSnapshots)
    .where(
      inArray(
        brokerBalanceSnapshots.brokerAccountId,
        accounts.map((account) => account.brokerAccountId),
      ),
    );
  return rows.length === accounts.length;
};

describe.each([
  { sockets: true, transport: TradeTransport.Socket },
  { sockets: false, transport: TradeTransport.RestFallback },
])('the handoff, transport $transport', ({ sockets, transport }) => {
  it(`H1${sockets ? '/H2' : ''} a stream of intents across the handoff: every one accepted once, none lost`, async () => {
    const accounts = await Promise.all([1, 2, 3, 4].map(() => seedAccount()));
    const [first, second, third, fourth] = accounts as [Account, Account, Account, Account];
    const watch = watchSockets();
    const a = startWorker('A', { sockets });

    // A's two jobs are held at the broker when the deploy stops it
    const early = [await newIntent(first), await newIntent(second)];
    if (sockets) {
      // in work → A's sessions open; user.data verified them once the snapshot is written
      await until("A's sessions", () => snapshotted([first, second]));
      broker.socket.failNext('openTrade', { delayMs: HELD_SOCKET_MS });
      broker.socket.failNext('openTrade', { delayMs: HELD_SOCKET_MS });
    } else {
      broker.rest.failNext('openTrade', { delayMs: HELD_REST_MS });
      broker.rest.failNext('openTrade', { delayMs: HELD_REST_MS });
    }
    expect(await publishPending(early)).toBe(2);
    await until('A took both', () => allIn(early, [TradeIntentStatus.Submitting]));

    // the new container is ready, then the old one gets SIGTERM; the rest of the stream follows
    const b = startWorker('B', { sockets });
    expect(logsOf(b, 'trading-worker started')).toHaveLength(1);
    const late = [await newIntent(third), await newIntent(fourth)];
    const stopping = shutdown(a);
    expect(await publishPending(late)).toBe(2);
    expect(await stopping).toBe('clean');

    const all = [...early, ...late];
    await until('every intent accepted', () => allIn(all, OPEN_OR_SETTLED));
    const rows = await intentRows(all);
    for (const row of rows) expect(row.lastError).toBeNull();
    // A finished what it had taken, over its own transport; B took everything after
    expect([...recordedBy(a)].sort()).toEqual([...early].sort());
    for (const id of late) expect(recordedBy(b).has(id)).toBe(true);
    for (const row of rows.filter((r) => early.includes(r.id))) {
      expect(row.transport).toBe(transport);
    }
    expect(
      logsOf(a, 'shutdown: active jobs did not finish within the budget, exiting without cleanup'),
    ).toEqual([]);
    for (const account of accounts) {
      expect(broker.trades.list(account.brokerUserId)).toHaveLength(1);
    }
    const linked = await tmp.db
      .select({ intentId: brokerTrades.intentId })
      .from(brokerTrades)
      .where(inArray(brokerTrades.intentId, all));
    expect(linked.map((row) => row.intentId).sort()).toEqual([...all].sort());

    if (sockets) {
      // B opens a session for every account in work once A's leases are gone
      await until("B's sessions for every account in work", () =>
        accounts.every((account) => socketsOf(account.brokerUserId).length === 1),
      );
      const { worst, polls } = watch.stop();
      expect(polls).toBeGreaterThan(0);
      expect(worst).toBe(1);
    } else {
      watch.stop();
      expect(broker.socket.sockets()).toEqual([]);
    }
    expect(await shutdown(b)).toBe('clean');
  });
});

describe('a deploy whose old worker overruns its drain', () => {
  it('W1 a drain past the budget is dirty, and phase 2 does not run', async () => {
    const account = await seedAccount();
    const w = startWorker('W1', { sockets: false, tuning: { phase1BudgetMs: DIRTY_PHASE1_MS } });
    const intentId = await newIntent(account);
    broker.rest.failNext('openTrade', { delayMs: HELD_REST_MS });
    await publishPending();
    await until(
      'the submit held at the broker',
      async () => (await statusOf(intentId)) === TradeIntentStatus.Submitting,
    );
    expect(await shutdown(w)).toBe('dirty');
    expect(w.redis.status).toBe('ready');
    expect(w.pool.ending).toBe(false);
    expect(
      logsOf(w, 'shutdown: active jobs did not finish within the budget, exiting without cleanup'),
    ).toHaveLength(1);
    // in-process the held call still ends; the process would have exited instead
    await until('the held submit recorded', async () =>
      OPEN_OR_SETTLED.includes(await statusOf(intentId)),
    );
    await w.redis.quit();
    await w.pool.end();
  });

  it('W2 a drain within the budget is clean and closes the connections', async () => {
    const w = startWorker('W2', { sockets: false });
    expect(await shutdown(w)).toBe('clean');
    expect(w.pool.ended).toBe(true);
    // quit() resolves on the server's OK; the status moves on the socket's close
    await until('redis closed', () => w.redis.status === 'end');
    expect(logsOf(w, 'shutting down')).toEqual([expect.objectContaining({ signal: 'SIGTERM' })]);
  });

  it('H3 the old worker dies with a submit in flight: the new one resolves it, one trade', async () => {
    const account = await seedAccount();
    const a = startWorker('A', { sockets: false, tuning: { phase1BudgetMs: DIRTY_PHASE1_MS } });
    const intentId = await newIntent(account);
    broker.rest.failNext('openTrade', { delayMs: HELD_REST_MS });
    await publishPending();
    await until(
      'the submit held at the broker',
      async () => (await statusOf(intentId)) === TradeIntentStatus.Submitting,
    );
    const b = startWorker('B', { sockets: false });
    expect(await shutdown(a)).toBe('dirty');
    // the exit: whatever A's held call brings back can no longer be written
    if (!a.pool.ending) await a.pool.end();

    await until('the intent resolved through reconciliation', async () => {
      await publishPending();
      return OPEN_OR_SETTLED.includes(await statusOf(intentId));
    });
    expect(recordedBy(a).has(intentId)).toBe(false);
    expect(logsOf(b, 'stale submitting intents marked unknown').length).toBeGreaterThan(0);
    expect(broker.trades.list(account.brokerUserId)).toHaveLength(1);
    const [trade] = await tmp.db
      .select()
      .from(brokerTrades)
      .where(eq(brokerTrades.intentId, intentId));
    expect(trade?.brokerTradeId).toBe(String(broker.trades.list(account.brokerUserId)[0]!.id));
    expect(await shutdown(b)).toBe('clean');
    await a.redis.quit();
  });
});

describe('a demo session across the handoff', () => {
  it('H4 every step once: the steps equal the trades at the broker', async () => {
    const account = await seedAccount({ snapshot: true });
    const session = await seedTradingSession(tmp.db, account.brokerAccountId, {
      settings: sessionSettings({ trades: 3 }),
    });
    const stepsOf = () =>
      tmp.db
        .select()
        .from(tradeIntents)
        .where(eq(tradeIntents.tradingSessionId, session.id))
        .orderBy(asc(tradeIntents.createdAt));
    const openStep = async (step: number) => {
      const rows = await stepsOf();
      return rows.length === step && rows[step - 1]!.status === TradeIntentStatus.Accepted;
    };
    const settleStep = async (step: number) => {
      const intent = (await stepsOf())[step - 1]!;
      const [trade] = await tmp.db
        .select()
        .from(brokerTrades)
        .where(eq(brokerTrades.intentId, intent.id));
      broker.trades.settle(Number(trade!.brokerTradeId), { outcome: MockTradeOutcome.Win });
      await until(
        `step ${step} settled`,
        async () => (await statusOf(intent.id)) === TradeIntentStatus.Settled,
      );
    };
    const watch = watchSockets();

    const a = startWorker('A', { sockets: true });
    await until('step 1 open over A', async () => {
      await publishPending();
      return (await openStep(1)) && socketsOf(account.brokerUserId).length === 1;
    });
    await settleStep(1);

    // B starts while A still runs the session; A stops with step 2 in work or about to be
    const b = startWorker('B', { sockets: true });
    await until('step 2 open', async () => {
      await publishPending();
      return openStep(2);
    });
    const aSocket = socketsOf(account.brokerUserId)[0]?.id;
    expect(await shutdown(a)).toBe('clean');
    await until("B's session", () => {
      const now = socketsOf(account.brokerUserId);
      return now.length === 1 && now[0]!.id !== aSocket;
    });
    await settleStep(2);
    await until('step 3 open over B', async () => {
      await publishPending();
      return openStep(3);
    });
    await settleStep(3);
    await until('the session completed', async () => {
      const [row] = await tmp.db
        .select()
        .from(tradingSessions)
        .where(eq(tradingSessions.id, session.id));
      return row!.status === TradingSessionStatus.Stopped;
    });

    const [row] = await tmp.db
      .select()
      .from(tradingSessions)
      .where(and(eq(tradingSessions.id, session.id)));
    expect(row!.stopReason).toBe(TradingSessionStopReason.Completed);
    const steps = await stepsOf();
    expect(steps.map((intent) => intent.clientRequestId)).toEqual([
      `session:${session.id}:1`,
      `session:${session.id}:2`,
      `session:${session.id}:3`,
    ]);
    expect(steps.every((intent) => intent.status === TradeIntentStatus.Settled)).toBe(true);
    expect(broker.trades.list(account.brokerUserId)).toHaveLength(steps.length);
    expect(watch.stop().worst).toBe(1);
    expect(await shutdown(b)).toBe('clean');
  });
});

describe('the readiness line', () => {
  it('H5 start() logs it once, with the text scripts/deploy-worker.sh waits for', async () => {
    const w = startWorker('H5', { sockets: false });
    expect(logsOf(w, 'trading-worker started')).toEqual([
      expect.objectContaining({ concurrency: 4, sessions: false }),
    ]);
    const script = readFileSync(
      new URL('../../../scripts/deploy-worker.sh', import.meta.url),
      'utf8',
    );
    expect(script).toContain('"msg":"trading-worker started"');
    expect(await shutdown(w)).toBe('clean');
    expect(logsOf(w, 'trading-worker started')).toHaveLength(1);
  });
});
