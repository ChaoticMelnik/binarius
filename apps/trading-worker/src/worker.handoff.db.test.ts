import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import {
  brokerBalanceSnapshots,
  brokerSessionLeases,
  brokerTrades,
  createDb,
  createSessionIntent,
  createTradeIntent,
  deregisterWorkerProcess,
  heartbeatWorkerProcess,
  markIntentUnknown,
  setTradingMode,
  takeIntent,
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
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradeTransport,
  TradingSessionStatus,
  TradingSessionStopReason,
  type BrokerUser,
  type DecimalString,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import type { Env } from './env';
import { ownerOf } from './fleet/rendezvous';
import { INTENT_DIRECT_JOB, ownIntentQueueName } from './intents/router';
import { TEST_WORKER_TUNING, watchSockets } from './testing';
import { eurUsd, signalAnswer } from './trading-session/testing';
import { createWorker, type ShutdownResult, type TradingWorker, type WorkerTuning } from './worker';

// #95: the deploy's overlap, in one process. Two worker compositions (createWorker, the production
// wiring) share one Postgres, one Redis prefix and one mock broker; the old one shuts down while
// the new one runs, as scripts/deploy-worker.sh does with two containers. Every oracle is the
// persisted state, the mock broker's trades and sockets, or the worker's own log lines.
// H9 (#131) is a crash, not a deploy: the old worker dies dirty in the middle of a session's step.

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

// a phase 1 that cannot outlast a held submit
const DIRTY_PHASE1_MS = 200;
const HELD_SOCKET_MS = 800;
const HELD_REST_MS = 1_500;

let tmp: TempDatabase;
let broker: MockBroker;
let publisher: Redis;
const queues = new Map<OutboxTopic, Queue>();
// the per-process intent queues a case looked into (#347): obliterated with the others
const ownQueues = new Map<string, Queue>();
const ownQueueOf = (ownerId: string) => {
  let queue = ownQueues.get(ownerId);
  if (queue === undefined) {
    queue = new Queue(ownIntentQueueName(ownerId), { connection: publisher, prefix });
    ownQueues.set(ownerId, queue);
  }
  return queue;
};
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
const everStarted: Running[] = [];

// a worker that a case left running (a failed assertion) is shut down before the next case
afterEach(async () => {
  for (const w of running.splice(0)) {
    if (w.result === undefined) await w.worker.shutdown('SIGTERM');
  }
});

afterAll(async () => {
  // every process this file started: a dirty stop leaves its own queue behind
  for (const w of everStarted) ownQueueOf(idOf(w));
  for (const queue of [...queues.values(), ...ownQueues.values()]) {
    await queue.obliterate({ force: true });
  }
  const deadLetters = new Queue('trading-intents-dead-letter', { connection: publisher, prefix });
  await deadLetters.obliterate({ force: true });
  await Promise.all(
    [...queues.values(), ...ownQueues.values(), deadLetters].map((queue) => queue.close()),
  );
  await publisher.quit();
  await broker.close();
  await tmp.drop();
});

function envOf(sockets: boolean, demoOnly = false): Env {
  return {
    databaseUrl: tmp.url,
    redisUrl: redisUrl!,
    logLevel: 'debug',
    intentMaxAgeMs: 60_000,
    submitAckTimeoutMs: 5_000,
    workerConcurrency: 4,
    maxSessionsPerWorker: 50,
    backendUrl: 'http://127.0.0.1:9',
    internalApiToken: 'unused-the-sources-are-stubbed',
    brokerApiBaseUrl: broker.url,
    brokerWsUrl: sockets ? broker.url : undefined,
    // no trip inside a case: the switch is not what this file tests
    circuitBreaker: { windowMs: 60_000, minFailures: 1_000, failurePercent: 100 },
    demoOnly,
  };
}

// one container of the deploy: its own pool, Redis connection and log sink
function startWorker(
  name: string,
  {
    sockets,
    demoOnly = false,
    tuning = {},
  }: { sockets: boolean; demoOnly?: boolean; tuning?: Partial<WorkerTuning> },
): Running {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(logOptions('debug'), {
    write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const pool = new Pool({ connectionString: tmp.url });
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const worker = createWorker({
    env: envOf(sockets, demoOnly),
    db: createDb(pool),
    pool,
    redis,
    logger,
    testing: {
      tuning: { ...TEST_WORKER_TUNING, ...tuning },
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
  everStarted.push(entry);
  worker.start();
  return entry;
}

async function shutdown(w: Running, signal = 'SIGTERM'): Promise<ShutdownResult> {
  w.result = await w.worker.shutdown(signal);
  return w.result;
}

const logsOf = (w: Running, msg: string) => w.lines.filter((line) => line.msg === msg);
const idOf = (w: Running) => logsOf(w, 'trading-worker started')[0]!.ownerId as string;
const recordedBy = (w: Running) =>
  new Set(logsOf(w, 'intent outcome recorded').map((line) => line.intentId as string));

// the backend's outbox publisher, by hand: every pending row becomes the job it would add
// (apps/backend/src/outbox/bullmq.ts: the intent id as job id, one attempt); `only` keeps a case
// to its own rows, so a failed case's leftovers cannot change the next one's count
async function publishPending(only?: readonly string[], name = 'intent'): Promise<number> {
  const pending = eq(outboxEvents.status, OutboxStatus.Pending);
  const rows = await tmp.db
    .select({ id: outboxEvents.id, intentId: outboxEvents.intentId, topic: outboxEvents.topic })
    .from(outboxEvents)
    .where(only === undefined ? pending : and(pending, inArray(outboxEvents.intentId, [...only])));
  for (const row of rows) {
    await queues
      .get(row.topic)!
      .add(
        name,
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

// requested: the bot asked a moment ago, so the account is in work without an intent
async function seedAccount({
  snapshot = false,
  real = '0.00',
  requested = false,
} = {}): Promise<Account> {
  const brokerUserId = ++brokerUserSeq;
  const accessToken = `handoff-token-${brokerUserId}`;
  broker.users.register({
    id: brokerUserId,
    accessToken,
    demo: { available: '10000.00' },
    real: { available: real },
  });
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
        available: real as DecimalString,
        held: '0.00' as DecimalString,
        total: real as DecimalString,
      },
      demo: balance,
    };
    await upsertBalanceSnapshot(tmp.db, { brokerAccountId, user: brokerUser, requested });
  }
  return { brokerUserId, brokerAccountId, telegramUserId: user.telegramUserId };
}

async function newIntent(account: Account, mode: TradeMode = TradeMode.Demo): Promise<string> {
  // a real intent is created only for a user in real mode (#121)
  if (mode === TradeMode.Real) {
    await setTradingMode(tmp.db, BigInt(account.telegramUserId), TradeMode.Real);
  }
  const { intent } = await createTradeIntent(
    tmp.db,
    intentRequest(account.telegramUserId, {
      assetId: EURUSD,
      amount: '1.50' as DecimalString,
      mode,
    }),
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
    const watch = watchSockets(broker);
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
    await publishPending([intentId]);
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
    await publishPending([intentId]);
    await until(
      'the submit held at the broker',
      async () => (await statusOf(intentId)) === TradeIntentStatus.Submitting,
    );
    const b = startWorker('B', { sockets: false });
    expect(await shutdown(a)).toBe('dirty');
    // the exit: whatever A's held call brings back can no longer be written
    if (!a.pool.ending) await a.pool.end();

    await until('the intent resolved through reconciliation', async () => {
      await publishPending([intentId]);
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
    const watch = watchSockets(broker);

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
      expect.objectContaining({ concurrency: 4, sessions: false, demoOnly: false }),
    ]);
    const script = readFileSync(
      new URL('../../../scripts/deploy-worker.sh', import.meta.url),
      'utf8',
    );
    expect(script).toContain('"msg":"trading-worker started"');
    expect(await shutdown(w)).toBe('clean');
    expect(logsOf(w, 'trading-worker started')).toHaveLength(1);
  });

  it('H6b carries the process id with the sockets off too (#94)', async () => {
    const w = startWorker('H6b', { sockets: false });
    expect(logsOf(w, 'trading-worker started')[0]?.ownerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await shutdown(w)).toBe('clean');
  });

  it('H6 carries DEMO_ONLY from the env it was built with (#396)', async () => {
    const w = startWorker('H6', { sockets: false, demoOnly: true });
    expect(logsOf(w, 'trading-worker started')).toEqual([
      expect.objectContaining({ demoOnly: true }),
    ]);
    expect(await shutdown(w)).toBe('clean');
  });
});

// #396: the flag reaches the processor and the orchestrator through createWorker itself, not only
// the started line (H6)
describe('DEMO_ONLY across the composition (#396)', () => {
  it('H7 a flagged worker rejects a queued real intent before the broker', async () => {
    const w = startWorker('H7', { sockets: false, demoOnly: true });
    const account = await seedAccount();
    const id = await newIntent(account, TradeMode.Real);
    await publishPending([id]);
    await until('H7 rejected', async () => (await statusOf(id)) === TradeIntentStatus.Rejected);
    expect((await intentRows([id]))[0]).toMatchObject({
      lastError: TradeIntentFailureReason.DemoOnly,
      submittedAt: null,
    });
    expect(broker.trades.list(account.brokerUserId)).toEqual([]);
    expect(logsOf(w, 'intent rejected: demo only')).toEqual([
      expect.objectContaining({ intentId: id }),
    ]);
    expect(await shutdown(w)).toBe('clean');
  });

  it('H8 a flagged worker stops a real session at its first attempt, creating nothing', async () => {
    // a real balance: the sizer runs before the intent creation and would stop the session
    // stake_stop on an empty one
    const account = await seedAccount({ snapshot: true, real: '50.00' });
    const session = await seedTradingSession(tmp.db, account.brokerAccountId, {
      mode: TradeMode.Real,
      settings: sessionSettings({ trades: 3 }),
    });
    const sessionRow = async () =>
      (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, session.id)))[0]!;
    const w = startWorker('H8', { sockets: false, demoOnly: true });
    await until(
      'H8 stopped',
      async () => (await sessionRow()).status === TradingSessionStatus.Stopped,
    );
    expect((await sessionRow()).stopReason).toBe(TradingSessionStopReason.AccountUnavailable);
    expect(
      await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.tradingSessionId, session.id)),
    ).toEqual([]);
    expect(logsOf(w, 'trading session stopped')).toContainEqual(
      expect.objectContaining({ reason: 'account_unavailable', code: 'demo_only' }),
    );
    expect(broker.trades.list(account.brokerUserId)).toEqual([]);
    expect(await shutdown(w)).toBe('clean');
  });
});

describe('a demo session whose worker dies (#131)', () => {
  it('H9 the old worker dies with a session step in flight: one trade per step, the session completes', async () => {
    const account = await seedAccount({ snapshot: true });
    const session = await seedTradingSession(tmp.db, account.brokerAccountId, {
      settings: sessionSettings({ trades: 2 }),
    });
    const stepsOf = () =>
      tmp.db
        .select()
        .from(tradeIntents)
        .where(eq(tradeIntents.tradingSessionId, session.id))
        .orderBy(asc(tradeIntents.createdAt));
    // the catch-up settles a trade whose expiry is behind the database clock
    const settleStep = async (step: number) => {
      const intent = (await stepsOf())[step - 1]!;
      const [trade] = await tmp.db
        .select()
        .from(brokerTrades)
        .where(eq(brokerTrades.intentId, intent.id));
      broker.trades.settle(Number(trade!.brokerTradeId), { outcome: MockTradeOutcome.Win });
      await tmp.db
        .update(brokerTrades)
        .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint - 3600000` })
        .where(eq(brokerTrades.intentId, intent.id));
      await until(
        `step ${step} settled`,
        async () => (await statusOf(intent.id)) === TradeIntentStatus.Settled,
      );
    };

    // armed before A starts, or A's orchestrator may submit step 1 unheld
    broker.rest.failNext('openTrade', { delayMs: HELD_REST_MS });
    const a = startWorker('A', { sockets: false, tuning: { phase1BudgetMs: DIRTY_PHASE1_MS } });
    await until('step 1 held at the broker', async () => {
      await publishPending();
      const rows = await stepsOf();
      return rows.length === 1 && rows[0]!.status === TradeIntentStatus.Submitting;
    });
    const step1 = (await stepsOf())[0]!.id;
    const b = startWorker('B', { sockets: false });
    expect(await shutdown(a)).toBe('dirty');
    if (!a.pool.ending) await a.pool.end();

    await until('step 1 resolved through reconciliation', async () => {
      await publishPending([step1]);
      return OPEN_OR_SETTLED.includes(await statusOf(step1));
    });
    expect(recordedBy(a).has(step1)).toBe(false);
    expect(await stepsOf()).toHaveLength(1);
    await settleStep(1);
    await until('step 2 accepted over B', async () => {
      await publishPending();
      const rows = await stepsOf();
      return rows.length === 2 && rows[1]!.status === TradeIntentStatus.Accepted;
    });
    await settleStep(2);
    const sessionRow = async () =>
      (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, session.id)))[0]!;
    await until(
      'the session completed',
      async () => (await sessionRow()).status === TradingSessionStatus.Stopped,
    );
    expect((await sessionRow()).stopReason).toBe(TradingSessionStopReason.Completed);
    expect((await stepsOf()).map((i) => i.clientRequestId)).toEqual([
      `session:${session.id}:1`,
      `session:${session.id}:2`,
    ]);
    expect(broker.trades.list(account.brokerUserId)).toHaveLength(2);
    expect(await shutdown(b)).toBe('clean');
    await a.redis.quit();
  }, 60_000);
});

// #696: every write in the worker that ends an intent or halts its account wakes the orchestrator
// after its commit.
// The orchestrator's interval is far past each case's bound, so only a wake makes the next step
// in time; every bound is the host's clock.
describe('the wake through the composition (#696)', () => {
  const slow = (tickMs: number, retryMs: number): Partial<WorkerTuning> => ({
    orchestrator: { ...TEST_WORKER_TUNING.orchestrator!, tickMs, retryMs },
  });
  const stepsOf = (sessionId: string) =>
    tmp.db
      .select()
      .from(tradeIntents)
      .where(eq(tradeIntents.tradingSessionId, sessionId))
      .orderBy(asc(tradeIntents.createdAt));
  const tradeOf = async (intentId: string) =>
    (await tmp.db.select().from(brokerTrades).where(eq(brokerTrades.intentId, intentId)))[0]!;
  // a case's own steps only: a step another case left queued would take this case's fault
  const publishSteps = async (sessionId: string) =>
    publishPending((await stepsOf(sessionId)).map((row) => row.id));
  const sessionOf = async (id: string) =>
    (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, id)))[0]!;
  const wokenTicks = (w: Running) =>
    logsOf(w, 'trading session tick').filter((line) => (line.woken as number) >= 1);
  const settledAfter = async (intentId: string) => {
    await until(
      'the settle',
      async () => (await statusOf(intentId)) === TradeIntentStatus.Settled,
      { intervalMs: 2 },
    );
    return Date.now();
  };
  const ticked = (w: Running, count: number) =>
    until('the woken tick lines', () => wokenTicks(w).length >= count);

  // the next case's orchestrator scans every active session in this database
  afterEach(async () => {
    await tmp.db
      .update(tradingSessions)
      .set({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.UserStopped,
        endedAt: sql`now()`,
      })
      .where(eq(tradingSessions.status, TradingSessionStatus.Active));
  });

  it('H10 a settle over the socket makes the next step within a second', async () => {
    const account = await seedAccount({ snapshot: true });
    const session = await seedTradingSession(tmp.db, account.brokerAccountId, {
      settings: sessionSettings({ trades: 2 }),
    });
    const startedAt = Date.now();
    const w = startWorker('H10', { sockets: true, tuning: slow(10_000, 20_000) });
    await until('step 1 open over the socket', async () => {
      await publishSteps(session.id);
      const rows = await stepsOf(session.id);
      return (
        rows.length === 1 &&
        rows[0]!.status === TradeIntentStatus.Accepted &&
        socketsOf(account.brokerUserId).length === 1
      );
    });
    const step1 = (await stepsOf(session.id))[0]!;
    broker.trades.settle(Number((await tradeOf(step1.id)).brokerTradeId), {
      outcome: MockTradeOutcome.Win,
      closeTimestamp: Date.now(),
    });
    const settledAt = await settledAfter(step1.id);
    await until('step 2', async () => (await stepsOf(session.id)).length === 2, {
      intervalMs: 2,
    });
    // the timer could not have made it; the wake did, within a second of the settle
    expect(Date.now()).toBeLessThan(startedAt + 10_000);
    expect(Date.now() - settledAt).toBeLessThan(1_000);
    // the acceptance metric: the broker's close of step 1 to the creation of step 2
    const step2 = (await stepsOf(session.id))[1]!;
    const closedAt = (await tradeOf(step1.id)).closeTimestampMs!;
    expect(step2.createdAt.getTime() - closedAt).toBeLessThan(1_000);
    await ticked(w, 1);
    expect(wokenTicks(w)).toEqual([expect.objectContaining({ woken: 1, created: 1 })]);
    expect(await shutdown(w)).toBe('clean');
  });

  it("H11 a broker's rejection wakes it: two rejections stop the session in time", async () => {
    const account = await seedAccount({ snapshot: true });
    const session = await seedTradingSession(tmp.db, account.brokerAccountId, {
      settings: sessionSettings({ trades: 2 }),
    });
    broker.rest.failNext('openTrade', { status: 400 });
    broker.rest.failNext('openTrade', { status: 400 });
    const startedAt = Date.now();
    const w = startWorker('H11', { sockets: false, tuning: slow(10_000, 20_000) });
    await until('the session stopped', async () => {
      await publishSteps(session.id);
      return (await sessionOf(session.id)).status === TradingSessionStatus.Stopped;
    });
    expect(Date.now()).toBeLessThan(startedAt + 10_000);
    expect(await sessionOf(session.id)).toMatchObject({
      stopReason: TradingSessionStopReason.RejectedTwice,
    });
    expect((await stepsOf(session.id)).map((row) => row.status)).toEqual([
      TradeIntentStatus.Rejected,
      TradeIntentStatus.Rejected,
    ]);
    await ticked(w, 2);
    expect(wokenTicks(w)).toEqual([
      expect.objectContaining({ woken: 1, created: 1 }),
      expect.objectContaining({ woken: 1, stopped: 1 }),
    ]);
    expect(await shutdown(w)).toBe('clean');
  });

  it('H12 a settle by the catch-up makes the next step', async () => {
    const account = await seedAccount({ snapshot: true });
    const session = await seedTradingSession(tmp.db, account.brokerAccountId, {
      settings: sessionSettings({ trades: 2 }),
    });
    const startedAt = Date.now();
    const w = startWorker('H12', { sockets: false, tuning: slow(10_000, 20_000) });
    await until('step 1 accepted over REST', async () => {
      await publishSteps(session.id);
      const rows = await stepsOf(session.id);
      return rows.length === 1 && rows[0]!.status === TradeIntentStatus.Accepted;
    });
    const step1 = (await stepsOf(session.id))[0]!;
    broker.trades.settle(Number((await tradeOf(step1.id)).brokerTradeId), {
      outcome: MockTradeOutcome.Win,
    });
    // overdue for the catch-up: the trade's expiry an hour behind the database clock
    await tmp.db
      .update(brokerTrades)
      .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint - 3600000` })
      .where(eq(brokerTrades.intentId, step1.id));
    const settledAt = await settledAfter(step1.id);
    await until('step 2', async () => (await stepsOf(session.id)).length === 2, {
      intervalMs: 2,
    });
    expect(Date.now()).toBeLessThan(startedAt + 10_000);
    expect(Date.now() - settledAt).toBeLessThan(3_000);
    await ticked(w, 1);
    expect(wokenTicks(w)).toEqual([expect.objectContaining({ woken: 1, created: 1 })]);
    expect(await shutdown(w)).toBe('clean');
  });

  // narrowed from the plan's two workers (owner's answer): the dead worker's step is written here
  it('H13 a settle by the reconciliation pass makes the next step', async () => {
    const account = await seedAccount({ snapshot: true });
    const session = await seedTradingSession(tmp.db, account.brokerAccountId, {
      settings: sessionSettings({ trades: 2 }),
    });
    const terms = {
      assetId: EURUSD,
      amount: '1.00' as DecimalString,
      action: TradeAction.Up,
      durationSec: 60,
    };
    const { intent } = await createSessionIntent(tmp.db, {
      sessionId: session.id,
      step: 1,
      telegramUserId: account.telegramUserId,
      brokerAccountId: account.brokerAccountId,
      mode: TradeMode.Demo,
      ...terms,
      decision: null,
    });
    // a dead worker's take and its order at the broker, closed since; the sweeper's mark
    expect(
      await takeIntent(tmp.db, {
        id: intent.id,
        expectedVersion: intent.version,
        maxAgeMs: 60_000,
      }),
    ).toBeDefined();
    const trade = await createBrokerRestClient({ baseUrl: broker.url }).openTrade(
      { accessToken: accessTokens.get(account.brokerAccountId)! },
      { ...terms, isDemo: true },
    );
    broker.trades.settle(Number(trade.id), { outcome: MockTradeOutcome.Win });
    await tmp.db.transaction((tx) =>
      markIntentUnknown(tx, {
        id: intent.id,
        reason: TradeIntentFailureReason.StaleSubmitting,
        olderThanMs: 0,
      }),
    );
    const startedAt = Date.now();
    const w = startWorker('H13', { sockets: false, tuning: slow(20_000, 30_000) });
    await until('step 1 settled through the pass', async () => {
      await publishPending([intent.id]);
      return (await statusOf(intent.id)) === TradeIntentStatus.Settled;
    });
    const settledAt = Date.now();
    await until('step 2', async () => (await stepsOf(session.id)).length === 2, {
      intervalMs: 2,
    });
    expect(Date.now()).toBeLessThan(startedAt + 20_000);
    expect(Date.now() - settledAt).toBeLessThan(3_000);
    expect(logsOf(w, 'reconciliation outcome recorded')).toEqual([
      expect.objectContaining({ intentId: intent.id, status: TradeIntentStatus.Settled }),
    ]);
    await ticked(w, 1);
    expect(wokenTicks(w)).toEqual([expect.objectContaining({ woken: 1, created: 1 })]);
    expect(await shutdown(w)).toBe('clean');
  });
});

describe('the fleet across processes (#94)', () => {
  it('H14 a second worker takes the sockets rendezvous names it for; one socket per account throughout', async () => {
    const watch = watchSockets(broker);
    const a = startWorker('A', { sockets: true });
    const leaseOwners = async (accounts: readonly Account[]) =>
      new Map(
        (
          await tmp.db
            .select({ id: brokerSessionLeases.brokerAccountId, owner: brokerSessionLeases.ownerId })
            .from(brokerSessionLeases)
            .where(
              inArray(
                brokerSessionLeases.brokerAccountId,
                accounts.map((account) => account.brokerAccountId),
              ),
            )
        ).map((row) => [row.id, row.owner]),
      );
    // alone, A holds every account; seeded before B exists, so B's share is A's until it moves
    const accounts = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() => seedAccount({ snapshot: true, requested: true })),
    );
    await until('A holds every account', async () => {
      const owners = await leaseOwners(accounts);
      return accounts.every(
        (account) =>
          owners.get(account.brokerAccountId) === idOf(a) &&
          socketsOf(account.brokerUserId).length === 1,
      );
    });

    const b = startWorker('B', { sockets: true });
    const live = [idOf(a), idOf(b)];
    // the ids are random: one in 64 runs gives B none of the six, and a seventh is added then
    for (
      let n = 0;
      n < 10 && !accounts.some((x) => ownerOf(x.brokerAccountId, live) === live[1]);
      n += 1
    ) {
      accounts.push(await seedAccount({ snapshot: true, requested: true }));
    }
    await until('every account on the process rendezvous names', async () => {
      const owners = await leaseOwners(accounts);
      return accounts.every(
        (account) =>
          owners.get(account.brokerAccountId) === ownerOf(account.brokerAccountId, live) &&
          socketsOf(account.brokerUserId).length === 1,
      );
    });
    const capacityOf = (w: Running) => logsOf(w, 'worker capacity').at(-1);
    await until('both capacity lines see the two of them', () =>
      [a, b].every((w) => capacityOf(w)?.live === 2),
    );
    expect(capacityOf(a)!.liveView).toBe(capacityOf(b)!.liveView);
    expect(capacityOf(a)).toMatchObject({ ownerId: idOf(a), sockets: true, cap: 50 });
    expect(logsOf(a, 'broker session shed').length).toBeGreaterThan(0);

    expect(await shutdown(a)).toBe('clean');
    expect(await shutdown(b)).toBe('clean');
    const { worst, polls } = watch.stop();
    expect(polls).toBeGreaterThan(0);
    expect(worst).toBe(1);
  });
});

describe('intent routing to the owner (#347)', () => {
  const capacityOf = (w: Running) => logsOf(w, 'worker capacity').at(-1);

  it("H15 with two live workers every intent of B's accounts goes over B's socket", async () => {
    const watch = watchSockets(broker);
    const a = startWorker('A', { sockets: true });
    const b = startWorker('B', { sockets: true });
    await until('both see the two of them', () => [a, b].every((w) => capacityOf(w)?.live === 2));
    const live = [idOf(a), idOf(b)];
    const mine: Account[] = [];
    for (let n = 0; n < 64 && mine.length < 4; n += 1) {
      const account = await seedAccount({ snapshot: true, requested: true });
      if (ownerOf(account.brokerAccountId, live) === idOf(b)) mine.push(account);
    }
    expect(mine).toHaveLength(4);
    await until("B's sockets for its accounts", async () => {
      const owners = new Map(
        (
          await tmp.db
            .select({ id: brokerSessionLeases.brokerAccountId, owner: brokerSessionLeases.ownerId })
            .from(brokerSessionLeases)
            .where(
              inArray(
                brokerSessionLeases.brokerAccountId,
                mine.map((account) => account.brokerAccountId),
              ),
            )
        ).map((row) => [row.id, row.owner]),
      );
      return mine.every(
        (account) =>
          owners.get(account.brokerAccountId) === idOf(b) &&
          socketsOf(account.brokerUserId).length === 1,
      );
    });

    const ids: string[] = [];
    for (const account of mine) ids.push(await newIntent(account));
    expect(await publishPending(ids)).toBe(4);
    await until('every intent accepted', () => allIn(ids, OPEN_OR_SETTLED));
    for (const row of await intentRows(ids)) expect(row.transport).toBe(TradeTransport.Socket);
    for (const id of ids) expect(recordedBy(b).has(id)).toBe(true);
    for (const id of ids) expect(recordedBy(a).has(id)).toBe(false);
    // A's insurance for what it forwarded finds the intent done
    const forwarded = logsOf(a, 'intent forwarded').map((line) => line.intentId as string);
    for (const line of logsOf(a, 'intent forwarded')) expect(line.owner).toBe(idOf(b));
    await until("A's insurance is a no-op", () =>
      forwarded.every((id) =>
        logsOf(a, 'intent job is a no-op').some((line) => line.intentId === id),
      ),
    );
    for (const account of mine) {
      expect(broker.trades.list(account.brokerUserId)).toHaveLength(1);
    }

    expect(await shutdown(a)).toBe('clean');
    expect(await shutdown(b)).toBe('clean');
    const { worst } = watch.stop();
    expect(worst).toBe(1);
  });

  it('H16 a forward to a process that died: the forwarder takes the intent itself, once; a direct job is never forwarded', async () => {
    const a = startWorker('A', { sockets: false });
    // a crashed process: its row has not lapsed, nothing consumes its queue
    const dead = randomUUID();
    await heartbeatWorkerProcess(tmp.db, { ownerId: dead, ttlMs: 60_000, pruneAfterMs: 3_600_000 });
    try {
      await until('A sees the dead process', () => capacityOf(a)?.live === 2);
      const live = [idOf(a), dead];
      const deads: Account[] = [];
      for (let n = 0; n < 20 && deads.length < 2; n += 1) {
        const account = await seedAccount();
        if (ownerOf(account.brokerAccountId, live) === dead) deads.push(account);
      }
      expect(deads).toHaveLength(2);
      const [first, second] = deads as [Account, Account];

      const id = await newIntent(first);
      expect(await publishPending([id])).toBe(1);
      await until('A forwards it to the dead process', () =>
        logsOf(a, 'intent forwarded').some((line) => line.intentId === id && line.owner === dead),
      );
      expect(await statusOf(id)).toBe(TradeIntentStatus.Queued);
      expect(await (await ownQueueOf(dead).getJob(id))?.getState()).toBe('waiting');

      await until('the insurance took it', () => allIn([id], OPEN_OR_SETTLED));
      expect((await intentRows([id]))[0]!.transport).toBe(TradeTransport.RestFallback);
      expect(recordedBy(a).has(id)).toBe(true);
      expect(broker.trades.list(first.brokerUserId)).toHaveLength(1);
      // nobody consumed the dead queue
      expect(await (await ownQueueOf(dead).getJob(id))?.getState()).toBe('waiting');

      const direct = await newIntent(second);
      expect(await publishPending([direct], INTENT_DIRECT_JOB)).toBe(1);
      await until('the direct job is processed here', () => allIn([direct], OPEN_OR_SETTLED));
      expect(logsOf(a, 'intent forwarded').some((line) => line.intentId === direct)).toBe(false);
      expect(await ownQueueOf(dead).getJob(direct)).toBeUndefined();
      expect(broker.trades.list(second.brokerUserId)).toHaveLength(1);
    } finally {
      await deregisterWorkerProcess(tmp.db, { ownerId: dead });
    }
    expect(await shutdown(a)).toBe('clean');
  });

  it('H17 a clean stop requeues its own queue to the shared one as direct jobs and deletes it', async () => {
    const a = startWorker('A', { sockets: false });
    const account = await seedAccount();
    const intentId = await newIntent(account);
    // an insurance A will not reach before its stop
    await ownQueueOf(idOf(a)).add(
      'intent',
      { intentId },
      { jobId: intentId, attempts: 1, removeOnComplete: true, removeOnFail: true, delay: 60_000 },
    );
    expect(await shutdown(a)).toBe('clean');
    const requeued = (await queues.get(OutboxTopic.TradingIntents)!.getJob(`${intentId}-direct`))!;
    expect(requeued.name).toBe(INTENT_DIRECT_JOB);
    // what is left of the insurance's wait
    expect(await requeued.getState()).toBe('delayed');
    const counts = await ownQueueOf(idOf(a)).getJobCounts();
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    await requeued.remove();
  });

  it('H18 forwards that reach a stopping process before and after its deregister are taken at once, not at the insurance', async () => {
    // A drains for 1.5 s after its deregister; B heartbeats rarely, so it names A throughout the
    // case, and its insurance (15 s) lies past every wait below
    const a = startWorker('A', {
      sockets: false,
      tuning: { intentRouter: { ...TEST_WORKER_TUNING.intentRouter!, drainTailMs: 1_500 } },
    });
    const rowOfA = async () =>
      (await tmp.db.execute(sql`select 1 from worker_processes where owner_id = ${idOf(a)}`)).rows
        .length;
    // B's first heartbeat, the one view it keeps through the case, lists A
    await until("A's row", async () => (await rowOfA()) === 1);
    const b = startWorker('B', {
      sockets: false,
      tuning: {
        fleet: {
          ...TEST_WORKER_TUNING.fleet!,
          heartbeatMs: 20_000,
          liveFenceMs: 45_000,
          processTtlMs: 50_000,
        },
        intentRouter: { ...TEST_WORKER_TUNING.intentRouter!, recoveryDelayMs: 15_000 },
      },
    });
    await until('both see the two of them', () => [a, b].every((w) => capacityOf(w)?.live === 2));
    const live = [idOf(a), idOf(b)];
    const ofA: Account[] = [];
    for (let n = 0; n < 20 && ofA.length < 2; n += 1) {
      const account = await seedAccount();
      if (ownerOf(account.brokerAccountId, live) === idOf(a)) ofA.push(account);
    }
    expect(ofA).toHaveLength(2);
    const [first, second] = ofA as [Account, Account];
    const before = await newIntent(first);
    const after = await newIntent(second);

    let stopResult: ShutdownResult | undefined;
    const stopping = shutdown(a).then((result) => {
      stopResult = result;
      return result;
    });
    const firstAt = performance.now();
    expect(await publishPending([before])).toBe(1);
    await until('A deregistered', async () => (await rowOfA()) === 0);
    expect(stopResult).toBeUndefined();
    const secondAt = performance.now();
    expect(await publishPending([after])).toBe(1);

    for (const [id, at] of [
      [before, firstAt],
      [after, secondAt],
    ] as const) {
      await until(`${id} terminal`, () => allIn([id], OPEN_OR_SETTLED));
      expect(performance.now() - at).toBeLessThan(3_000);
      expect(logsOf(b, 'intent forwarded')).toContainEqual(
        expect.objectContaining({ intentId: id, owner: idOf(a) }),
      );
      expect(recordedBy(b).has(id)).toBe(true);
    }
    expect(await stopping).toBe('clean');
    const [, keys] = await publisher.scan(
      0,
      'MATCH',
      `${prefix}:${ownIntentQueueName(idOf(a))}:*`,
      'COUNT',
      10_000,
    );
    expect(keys).toEqual([]);
    for (const account of ofA) {
      expect(broker.trades.list(account.brokerUserId)).toHaveLength(1);
    }
    expect(await shutdown(b)).toBe('clean');
  });
});
