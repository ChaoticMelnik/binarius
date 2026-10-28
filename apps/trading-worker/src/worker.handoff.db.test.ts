import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
  buildH1SessionSettings,
  logOptions,
  SessionStakeStrategy,
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
import { eurUsd } from './trading-session/testing';
import { createWorker, type ShutdownResult, type TradingWorker, type WorkerTuning } from './worker';

// #95: the deploy's overlap, in one process. Two worker compositions (createWorker, the production
// wiring) share one Postgres, one Redis prefix and one mock broker; the old one shuts down while
// the new one runs, as scripts/deploy-worker.sh does with two containers. Every oracle is the
// persisted state, the mock broker's trades and sockets, or the worker's own log lines.
// H9′ (#131) is a crash, not a deploy: the old worker dies dirty in the middle of a session's step.
// A session's intents are the backend's H1 driver's (#707, #835): the cases create them as it does.

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
// the mock's AAPL takes the 5 s trades of an H1 session
const AAPL = 202;
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
      pairs: {
        read: () =>
          Promise.resolve({
            ok: true,
            catalog: {
              pairs: [eurUsd(), eurUsd({ id: AAPL, symbol: 'AAPL', minTimeframe: 5 })],
              fetchedAt: Date.now(),
              ageMs: 0,
              fresh: true,
            },
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

// an H1 session of one fixed cycle (settings v5) with its step 1 created as the driver creates it
async function seedH1Session(account: Account) {
  const settings = buildH1SessionSettings({
    assetId: AAPL,
    cycles: 1,
    stake: { baseStake: '1.00' as DecimalString, stakeScale: 2 },
    strategy: SessionStakeStrategy.Fixed,
  });
  if (!settings.success) throw new Error('H1 fixture settings do not parse');
  const session = await seedTradingSession(tmp.db, account.brokerAccountId, {
    settings: settings.data,
  });
  const { intent } = await createSessionIntent(tmp.db, {
    sessionId: session.id,
    step: 1,
    telegramUserId: account.telegramUserId,
    brokerAccountId: account.brokerAccountId,
    mode: TradeMode.Demo,
    ...H1_TERMS,
    decision: null,
  });
  return { session, intent };
}
const H1_TERMS = {
  assetId: AAPL,
  amount: '1.00' as DecimalString,
  action: TradeAction.Up,
  durationSec: 5,
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
    // A finished what it had taken, over its own transport, and every intent was recorded once.
    // A late one may be A's too: a fetch already parked in BullMQ's blocking pop takes a job until
    // close() has ended that connection, and B forwards to A's own queue while its view still names
    // A; the take's CAS (Rule 6) lets one worker record each intent
    const byA = recordedBy(a);
    const byB = recordedBy(b);
    for (const id of early) expect(byA.has(id)).toBe(true);
    expect([...byA].filter((id) => byB.has(id))).toEqual([]);
    expect([...byA, ...byB].sort()).toEqual([...all].sort());
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

// #396: the flag reaches the processor through createWorker itself, not only the started line (H6);
// the orchestrator creates no intent since #835, the driver's createSessionIntent refuses demo_only
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
});

describe('a demo session whose worker dies (#131)', () => {
  it('H9′ the old worker dies with a session step in flight: one trade, the session completes', async () => {
    const account = await seedAccount({ snapshot: true });
    const { session, intent } = await seedH1Session(account);
    const sessionRow = async () =>
      (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, session.id)))[0]!;

    // armed before A starts, or A may submit step 1 unheld
    broker.rest.failNext('openTrade', { delayMs: HELD_REST_MS });
    const a = startWorker('A', { sockets: false, tuning: { phase1BudgetMs: DIRTY_PHASE1_MS } });
    await until('step 1 held at the broker', async () => {
      await publishPending([intent.id]);
      return (await statusOf(intent.id)) === TradeIntentStatus.Submitting;
    });
    const b = startWorker('B', { sockets: false });
    expect(await shutdown(a)).toBe('dirty');
    if (!a.pool.ending) await a.pool.end();

    await until('step 1 resolved through reconciliation', async () => {
      await publishPending([intent.id]);
      return OPEN_OR_SETTLED.includes(await statusOf(intent.id));
    });
    expect(recordedBy(a).has(intent.id)).toBe(false);
    // the catch-up settles a trade whose expiry is behind the database clock
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
      'step 1 settled',
      async () => (await statusOf(intent.id)) === TradeIntentStatus.Settled,
    );
    // B's orchestrator completes the session after the settlement
    await until(
      'the session completed',
      async () => (await sessionRow()).status === TradingSessionStatus.Stopped,
    );
    expect((await sessionRow()).stopReason).toBe(TradingSessionStopReason.Completed);
    expect(
      await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.tradingSessionId, session.id)),
    ).toHaveLength(1);
    expect(broker.trades.list(account.brokerUserId)).toHaveLength(1);
    expect(await shutdown(b)).toBe('clean');
    await a.redis.quit();
  }, 60_000);
});

// #696: every write in the worker that ends an intent or halts its account wakes the orchestrator
// after its commit.
// The orchestrator's interval is far past each case's bound, so only a wake checks the session in
// time; every bound is the host's clock. Each session has one fixed cycle and its step 1 is created
// before the worker starts (as the driver would), so the scan never held it.
describe('the wake through the composition (#696)', () => {
  const slow = (tickMs: number, retryMs: number): Partial<WorkerTuning> => ({
    orchestrator: { ...TEST_WORKER_TUNING.orchestrator!, tickMs, retryMs },
  });
  const tradeOf = async (intentId: string) =>
    (await tmp.db.select().from(brokerTrades).where(eq(brokerTrades.intentId, intentId)))[0]!;
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
  const stopped = (sessionId: string) =>
    until(
      'the session stopped',
      async () => (await sessionOf(sessionId)).status === TradingSessionStatus.Stopped,
      { intervalMs: 2 },
    );
  const ticked = (w: Running, count: number) =>
    until('the woken tick lines', () => wokenTicks(w).length >= count);
  // the first tick of the interval ran: the step is published only after it, so its outcome's
  // wake is the one that reaches the session
  const firstTick = (w: Running) =>
    until('the first tick', () => logsOf(w, 'trading session tick').length >= 1);

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

  it('H10′ a settle over the socket completes the session within a second', async () => {
    const account = await seedAccount({ snapshot: true });
    const { session, intent } = await seedH1Session(account);
    const startedAt = Date.now();
    const w = startWorker('H10', { sockets: true, tuning: slow(10_000, 20_000) });
    await firstTick(w);
    await until('step 1 open over the socket', async () => {
      await publishPending([intent.id]);
      return (
        (await statusOf(intent.id)) === TradeIntentStatus.Accepted &&
        socketsOf(account.brokerUserId).length === 1
      );
    });
    broker.trades.settle(Number((await tradeOf(intent.id)).brokerTradeId), {
      outcome: MockTradeOutcome.Win,
      closeTimestamp: Date.now(),
    });
    const settledAt = await settledAfter(intent.id);
    await stopped(session.id);
    // the timer could not have made it; the wake did, within a second of the settle
    expect(Date.now()).toBeLessThan(startedAt + 10_000);
    expect(Date.now() - settledAt).toBeLessThan(1_000);
    // the acceptance metric: the broker's close of the last trade to the session's end
    const row = await sessionOf(session.id);
    expect(row.stopReason).toBe(TradingSessionStopReason.Completed);
    const closedAt = (await tradeOf(intent.id)).closeTimestampMs!;
    expect(row.endedAt!.getTime() - closedAt).toBeLessThan(1_000);
    await ticked(w, 1);
    expect(wokenTicks(w)).toEqual([expect.objectContaining({ woken: 1, stopped: 1 })]);
    expect(await shutdown(w)).toBe('clean');
  });

  it("H11′ a broker's rejection wakes it: the session is checked in time and held", async () => {
    const account = await seedAccount({ snapshot: true });
    const { session, intent } = await seedH1Session(account);
    broker.rest.failNext('openTrade', { status: 400 });
    const startedAt = Date.now();
    const w = startWorker('H11', { sockets: false, tuning: slow(10_000, 20_000) });
    await firstTick(w);
    await publishPending([intent.id]);
    await until(
      'the rejection',
      async () => (await statusOf(intent.id)) === TradeIntentStatus.Rejected,
    );
    await ticked(w, 1);
    expect(Date.now()).toBeLessThan(startedAt + 10_000);
    // one rejection is not two in a row: the woken attempt holds the session for the driver
    expect(wokenTicks(w)).toEqual([expect.objectContaining({ woken: 1, attempted: 1, held: 1 })]);
    expect(await sessionOf(session.id)).toMatchObject({
      status: TradingSessionStatus.Active,
      stopReason: null,
    });
    expect(await shutdown(w)).toBe('clean');
  });

  it('H12′ a settle by the catch-up completes the session', async () => {
    const account = await seedAccount({ snapshot: true });
    const { session, intent } = await seedH1Session(account);
    const startedAt = Date.now();
    const w = startWorker('H12', { sockets: false, tuning: slow(10_000, 20_000) });
    await firstTick(w);
    await until('step 1 accepted over REST', async () => {
      await publishPending([intent.id]);
      return (await statusOf(intent.id)) === TradeIntentStatus.Accepted;
    });
    broker.trades.settle(Number((await tradeOf(intent.id)).brokerTradeId), {
      outcome: MockTradeOutcome.Win,
    });
    // overdue for the catch-up: the trade's expiry an hour behind the database clock
    await tmp.db
      .update(brokerTrades)
      .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint - 3600000` })
      .where(eq(brokerTrades.intentId, intent.id));
    const settledAt = await settledAfter(intent.id);
    await stopped(session.id);
    expect(Date.now()).toBeLessThan(startedAt + 10_000);
    expect(Date.now() - settledAt).toBeLessThan(3_000);
    expect((await sessionOf(session.id)).stopReason).toBe(TradingSessionStopReason.Completed);
    await ticked(w, 1);
    expect(wokenTicks(w)).toEqual([expect.objectContaining({ woken: 1, stopped: 1 })]);
    expect(await shutdown(w)).toBe('clean');
  });

  // narrowed from the plan's two workers (owner's answer): the dead worker's step is written here
  it('H13′ a settle by the reconciliation pass completes the session', async () => {
    const account = await seedAccount({ snapshot: true });
    const { session, intent } = await seedH1Session(account);
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
      { ...H1_TERMS, isDemo: true },
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
    await stopped(session.id);
    expect(Date.now()).toBeLessThan(startedAt + 20_000);
    expect(Date.now() - settledAt).toBeLessThan(3_000);
    expect((await sessionOf(session.id)).stopReason).toBe(TradingSessionStopReason.Completed);
    expect(logsOf(w, 'reconciliation outcome recorded')).toEqual([
      expect.objectContaining({ intentId: intent.id, status: TradeIntentStatus.Settled }),
    ]);
    await ticked(w, 1);
    expect(wokenTicks(w)).toEqual([expect.objectContaining({ woken: 1, stopped: 1 })]);
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
