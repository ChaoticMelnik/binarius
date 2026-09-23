import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TradeIntentFailureReason } from '@binarius/shared';
import {
  OutboxTopic,
  findTradeIntent,
  markIntentUnknown,
  outboxEvents,
  takeIntent,
  tokenLedger,
  users,
} from '@binarius/db';
import { createTempDatabase, seedQueuedIntent, type TempDatabase } from '@binarius/db/testing';
import { createBullmqPublisher, type JobPublisher } from './bullmq';
import { OutboxPublisher, backoffMs, type PublisherConfig } from './publisher';

// Real Postgres and Redis (README → Database): the BullMQ dedupe, job presence and the
// per-row transaction are what these tests are about, so neither is faked here.
const baseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for apps/backend integration tests (see README)');
}
if (redisUrl === undefined || redisUrl === '') {
  throw new Error('REDIS_URL is required for apps/backend integration tests (see README)');
}

const prefix = `test-${randomBytes(4).toString('hex')}`;
const logger = Fastify({ logger: false }).log;
let tmp: TempDatabase;
let redis: Redis;
let intentsQueue: Queue;
let reconciliationQueue: Queue;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  intentsQueue = new Queue(OutboxTopic.TradingIntents, { connection: redis, prefix });
  reconciliationQueue = new Queue(OutboxTopic.TradingReconciliation, { connection: redis, prefix });
});
afterAll(async () => {
  await intentsQueue.obliterate({ force: true });
  await reconciliationQueue.obliterate({ force: true });
  await Promise.all([intentsQueue.close(), reconciliationQueue.close()]);
  await redis.quit();
  await tmp.drop();
});

const newIntent = async () => {
  const seed = await seedQueuedIntent(tmp.db);
  return { intentId: seed.intent.id, userId: seed.userId, version: seed.intent.version };
};

// an unknown intent with its reconciliation outbox row (the trading-intents row is parked)
async function unknownIntent() {
  const { intentId, version } = await newIntent();
  const taken = (await takeIntent(tmp.db, {
    id: intentId,
    expectedVersion: version,
    maxAgeMs: 60_000,
  }))!;
  await tmp.db.transaction((tx) =>
    markIntentUnknown(tx, {
      id: intentId,
      reason: TradeIntentFailureReason.ExecutorTimeout,
      expectedVersion: taken.version,
    }),
  );
  await tmp.db
    .update(outboxEvents)
    .set({ status: 'failed' })
    .where(
      and(eq(outboxEvents.intentId, intentId), eq(outboxEvents.topic, OutboxTopic.TradingIntents)),
    );
  return intentId;
}

const outboxOf = async (intentId: string, topic: OutboxTopic = OutboxTopic.TradingIntents) =>
  (
    await tmp.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.intentId, intentId), eq(outboxEvents.topic, topic)))
  )[0]!;

const reservedOf = async (userId: string) =>
  (await tmp.db.select({ v: users.tokenReserved }).from(users).where(eq(users.id, userId)))[0]!.v;

const makeDue = (intentId: string, topic: OutboxTopic = OutboxTopic.TradingIntents) =>
  tmp.db
    .update(outboxEvents)
    .set({ availableAt: sql`now()` })
    .where(and(eq(outboxEvents.intentId, intentId), eq(outboxEvents.topic, topic)));

// the row becomes due again after its backoff; parking it keeps later ticks from counting it
const park = (intentId: string) =>
  tmp.db.update(outboxEvents).set({ status: 'failed' }).where(eq(outboxEvents.intentId, intentId));

interface FakeJobs extends JobPublisher {
  calls: string[];
}

function fakeJobs(
  add: (topic: string, intentId: string) => Promise<void>,
  has = async () => true,
): FakeJobs {
  const calls: string[] = [];
  return {
    calls,
    add: (topic, intentId) => {
      calls.push(intentId);
      return add(topic, intentId);
    },
    has: () => has(),
    close: async () => {},
  };
}

const publisher = (jobs: JobPublisher, config: Partial<PublisherConfig> = {}) =>
  new OutboxPublisher({ db: tmp.db, jobs, logger, config });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('backoffMs', () => {
  it('doubles from one second and caps at sixteen', () => {
    expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 16000]);
  });
});

describe('OutboxPublisher.tick', () => {
  it('publishes a pending row as a job keyed by the intent id', async () => {
    const jobs = createBullmqPublisher(redis, { prefix });
    const { intentId } = await newIntent();
    try {
      expect(await publisher(jobs).tick()).toBe(1);
      const row = await outboxOf(intentId);
      expect(row).toMatchObject({ status: 'published', attempts: 0, lastError: null });
      expect(row.publishedAt).toBeInstanceOf(Date);
      const job = await intentsQueue.getJob(intentId);
      expect(job?.data).toEqual({ intentId });
      expect(job?.opts).toMatchObject({ attempts: 1, removeOnComplete: true, removeOnFail: true });
      expect(await publisher(jobs).tick()).toBe(0);
    } finally {
      await jobs.close();
    }
  });

  it('treats a job that already exists as published', async () => {
    const jobs = createBullmqPublisher(redis, { prefix });
    const { intentId } = await newIntent();
    try {
      await intentsQueue.add('intent', { intentId }, { jobId: intentId });
      expect(await publisher(jobs).tick()).toBe(1);
      expect((await outboxOf(intentId)).status).toBe('published');
    } finally {
      await jobs.close();
    }
  });

  it('backs off after a failed add and rejects the intent with the last attempt', async () => {
    const jobs = fakeJobs(() => Promise.reject(new Error('redis down')));
    const { intentId, userId } = await newIntent();
    const p = publisher(jobs, { maxAttempts: 3 });

    expect(await p.tick()).toBe(1);
    let row = await outboxOf(intentId);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastError: 'publish_failed' });
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now() + 500);
    expect(await p.tick()).toBe(0);

    await makeDue(intentId);
    expect(await p.tick()).toBe(1);
    expect((await outboxOf(intentId)).attempts).toBe(2);
    expect((await findTradeIntent(tmp.db, intentId))?.status).toBe('queued');

    await makeDue(intentId);
    expect(await p.tick()).toBe(1);
    row = await outboxOf(intentId);
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    const intent = await findTradeIntent(tmp.db, intentId);
    expect(intent).toMatchObject({
      status: 'rejected',
      lastError: 'publish_failed',
      tokensReserved: 0n,
    });
    expect(await reservedOf(userId)).toBe(0n);
    expect(
      (
        await tmp.db
          .select({ kind: tokenLedger.kind })
          .from(tokenLedger)
          .where(eq(tokenLedger.intentId, intentId))
      ).map((r) => r.kind),
    ).toEqual(['reserve', 'release']);
    expect(jobs.calls).toEqual([intentId, intentId, intentId]);
  });

  it('never gives up on a reconciliation row', async () => {
    const jobs = fakeJobs(() => Promise.reject(new Error('redis down')));
    const intentId = await unknownIntent();
    const p = publisher(jobs, { maxAttempts: 2 });
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await makeDue(intentId, OutboxTopic.TradingReconciliation);
      expect(await p.tick()).toBe(1);
      expect(await outboxOf(intentId, OutboxTopic.TradingReconciliation)).toMatchObject({
        status: 'pending',
        attempts: attempt,
        lastError: 'publish_failed',
      });
    }
    expect((await findTradeIntent(tmp.db, intentId))?.status).toBe('unknown');
    await park(intentId);
  });

  it('counts a hanging add as a failure once the deadline passes', async () => {
    const jobs = fakeJobs(() => new Promise(() => {}));
    const { intentId } = await newIntent();
    const started = Date.now();
    expect(await publisher(jobs, { publishTimeoutMs: 50 }).tick()).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await outboxOf(intentId)).toMatchObject({ status: 'pending', attempts: 1 });
    await park(intentId);
  });

  it('fails the row but leaves an intent the worker already took alone', async () => {
    const jobs = fakeJobs(() => Promise.reject(new Error('redis down')));
    const { intentId, userId, version } = await newIntent();
    expect(
      await takeIntent(tmp.db, { id: intentId, expectedVersion: version, maxAgeMs: 60_000 }),
    ).toBeDefined();
    expect(await publisher(jobs, { maxAttempts: 1 }).tick()).toBe(1);
    expect((await outboxOf(intentId)).status).toBe('failed');
    expect((await findTradeIntent(tmp.db, intentId))?.status).toBe('submitting');
    expect(await reservedOf(userId)).toBe(1n);
  });

  it('lets two publishers share one database without publishing a row twice', async () => {
    const calls: string[] = [];
    const slow = fakeJobs(async (_topic, intentId) => {
      calls.push(intentId);
      await sleep(20);
    });
    const ids = await Promise.all(Array.from({ length: 6 }, () => newIntent()));
    const [a, b] = [publisher(slow), publisher(slow)];
    const [first, second] = await Promise.all([a.tick(), b.tick()]);
    expect(first + second).toBe(6);
    expect([...calls].sort()).toEqual(ids.map((i) => i.intentId).sort());
    for (const { intentId } of ids) expect((await outboxOf(intentId)).status).toBe('published');
  });
});

describe('OutboxPublisher.sweep', () => {
  it('re-pends a published row whose job vanished and leaves a live job alone', async () => {
    const jobs = createBullmqPublisher(redis, { prefix });
    const lost = await newIntent();
    const live = await newIntent();
    const p = publisher(jobs, { staleQueuedMs: 0 });
    try {
      expect(await p.tick()).toBe(2);
      await (await intentsQueue.getJob(lost.intentId))!.remove();
      // rows earlier tests published through fake job publishers have no job either, so the
      // count is at least one; the two rows below are what this case is about
      expect(await p.sweep()).toBeGreaterThanOrEqual(1);
      expect(await outboxOf(lost.intentId)).toMatchObject({ status: 'pending', attempts: 1 });
      expect(await outboxOf(live.intentId)).toMatchObject({ status: 'published', attempts: 0 });
      // the next pass publishes it again under the same job id
      await makeDue(lost.intentId);
      expect(await p.tick()).toBeGreaterThanOrEqual(1);
      expect(await intentsQueue.getJob(lost.intentId)).toBeDefined();
    } finally {
      await jobs.close();
    }
  });

  it('re-pends a lost reconciliation job for an unknown intent', async () => {
    const jobs = createBullmqPublisher(redis, { prefix });
    const intentId = await unknownIntent();
    const p = publisher(jobs, { staleQueuedMs: 0 });
    try {
      expect(await p.tick()).toBeGreaterThanOrEqual(1);
      expect(await outboxOf(intentId, OutboxTopic.TradingReconciliation)).toMatchObject({
        status: 'published',
      });
      await (await reconciliationQueue.getJob(intentId))!.remove();
      expect(await p.sweep()).toBeGreaterThanOrEqual(1);
      expect(await outboxOf(intentId, OutboxTopic.TradingReconciliation)).toMatchObject({
        status: 'pending',
        attempts: 1,
      });
    } finally {
      await jobs.close();
    }
  });
});

describe('OutboxPublisher loop', () => {
  it('publishes on wake without waiting for the poll interval', async () => {
    const jobs = createBullmqPublisher(redis, { prefix });
    const p = publisher(jobs, { pollMs: 60_000 });
    p.start();
    try {
      await sleep(20);
      const { intentId } = await newIntent();
      p.wake();
      const deadline = Date.now() + 2_000;
      while ((await outboxOf(intentId)).status !== 'published' && Date.now() < deadline) {
        await sleep(10);
      }
      expect((await outboxOf(intentId)).status).toBe('published');
    } finally {
      await p.stop();
      await jobs.close();
    }
  });

  it('stop waits for the row in flight and leaves the rest of the batch pending', async () => {
    const slow = fakeJobs(async () => {
      await sleep(150);
    });
    const ids = await Promise.all(Array.from({ length: 5 }, () => newIntent()));
    const p = publisher(slow, { pollMs: 60_000, publishTimeoutMs: 5_000 });
    p.start();
    await sleep(50);
    const started = Date.now();
    await p.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    const statuses = await Promise.all(
      ids.map(async ({ intentId }) => (await outboxOf(intentId)).status),
    );
    expect(statuses.filter((s) => s === 'published').length).toBeLessThanOrEqual(2);
    expect(statuses.filter((s) => s === 'pending').length).toBeGreaterThanOrEqual(3);
    // a fresh start picks the rest up
    p.start();
    await sleep(10);
    await p.stop();
    for (const { intentId } of ids) await park(intentId);
  });

  it('tick and sweep run directly, without start()', async () => {
    const jobs = fakeJobs(async () => {});
    const { intentId } = await newIntent();
    const p = publisher(jobs);
    expect(await p.tick()).toBeGreaterThanOrEqual(1);
    expect((await outboxOf(intentId)).status).toBe('published');
    expect(await p.sweep()).toBeGreaterThanOrEqual(0);
  });
});

describe('OutboxPublisher shutdown semantics', () => {
  it('stop waits out an add that hangs until its deadline and leaves the row pending', async () => {
    let entered: () => void = () => {};
    const enteredAdd = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hanging = fakeJobs(() => {
      entered();
      return new Promise(() => {});
    });
    const { intentId } = await newIntent();
    const p = publisher(hanging, { pollMs: 60_000, publishTimeoutMs: 200 });
    p.start();
    await enteredAdd;
    const started = Date.now();
    await p.stop();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1_000);
    expect(await outboxOf(intentId)).toMatchObject({ status: 'pending', attempts: 1 });

    // stopping was cleared: a direct tick handles the row again once it is due
    await makeDue(intentId);
    expect(await p.tick()).toBeGreaterThanOrEqual(1);
    expect((await outboxOf(intentId)).attempts).toBe(2);
    await park(intentId);
  });

  it('ignores start() while a stop() is still draining', async () => {
    const slow = fakeJobs(async () => {
      await sleep(100);
    });
    const first = await newIntent();
    const p = publisher(slow, { pollMs: 60_000 });
    p.start();
    await sleep(20);
    const stopping = p.stop();
    p.start();
    await stopping;
    expect((await outboxOf(first.intentId)).status).toBe('published');

    // no loop is alive after the stop: a wake publishes nothing
    const second = await newIntent();
    p.wake();
    await sleep(200);
    expect((await outboxOf(second.intentId)).status).toBe('pending');
    expect(await p.tick()).toBeGreaterThanOrEqual(1);
    expect((await outboxOf(second.intentId)).status).toBe('published');
  });

  it('logs reconciliation delivery failures at info until the fifth attempt', async () => {
    const lines: { level: number; msg: string; attempts?: number; topic?: string }[] = [];
    const capturing = Fastify({
      logger: {
        level: 'info',
        stream: {
          write: (line: string) => {
            lines.push(JSON.parse(line) as (typeof lines)[number]);
          },
        },
      },
    }).log;
    const failing = fakeJobs(() => Promise.reject(new Error('redis down')));
    const intentId = await unknownIntent();
    const p = new OutboxPublisher({ db: tmp.db, jobs: failing, logger: capturing });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await makeDue(intentId, OutboxTopic.TradingReconciliation);
      expect(await p.tick()).toBe(1);
    }
    const failures = lines.filter((l) => l.msg === 'outbox publish failed');
    expect(failures.map((l) => [l.attempts, l.level])).toEqual([
      [1, 30],
      [2, 30],
      [3, 30],
      [4, 30],
      [5, 40],
    ]);
    expect(lines.filter((l) => l.msg.includes('keeps failing'))).toHaveLength(0);
    await park(intentId);
  });
});
