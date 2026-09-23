import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateTradeIntentRequest, DecimalString } from '@binarius/shared';
import {
  OutboxTopic,
  brokerAccounts,
  createTradeIntent,
  findTradeIntent,
  outboxEvents,
  takeIntent,
  tokenLedger,
  users,
} from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
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

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  intentsQueue = new Queue(OutboxTopic.TradingIntents, { connection: redis, prefix });
});
afterAll(async () => {
  const reconciliation = new Queue(OutboxTopic.TradingReconciliation, {
    connection: redis,
    prefix,
  });
  await intentsQueue.obliterate({ force: true });
  await reconciliation.obliterate({ force: true });
  await Promise.all([intentsQueue.close(), reconciliation.close()]);
  await redis.quit();
  await tmp.drop();
});

let seq = 0;
async function newIntent() {
  // captured once: concurrent callers must not share the counter mid-flight
  const n = ++seq;
  const telegramUserId = BigInt(600_000 + n);
  const [user] = await tmp.db
    .insert(users)
    .values({ telegramUserId, tokenBalance: 5n })
    .returning({ id: users.id });
  await tmp.db.insert(brokerAccounts).values({
    userId: user!.id,
    brokerUserId: `broker-${n}`,
    accessTokenEnc: Buffer.from('enc'),
    refreshTokenEnc: Buffer.from('enc'),
    tokenKeyId: 'k1',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  });
  const request: CreateTradeIntentRequest = {
    telegramUserId: telegramUserId.toString(),
    mode: 'demo',
    assetId: 91,
    amount: '10.00' as DecimalString,
    action: 'up',
    durationSec: 60,
    clientRequestId: `req-${n}`,
  };
  const { intent } = await createTradeIntent(tmp.db, request);
  return { intentId: intent.id, userId: user!.id, version: intent.version };
}

const outboxOf = async (intentId: string) =>
  (await tmp.db.select().from(outboxEvents).where(eq(outboxEvents.intentId, intentId)))[0]!;

const reservedOf = async (userId: string) =>
  (await tmp.db.select({ v: users.tokenReserved }).from(users).where(eq(users.id, userId)))[0]!.v;

const makeDue = (intentId: string) =>
  tmp.db
    .update(outboxEvents)
    .set({ availableAt: sql`now()` })
    .where(eq(outboxEvents.intentId, intentId));

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

  it('counts a hanging add as a failure once the deadline passes', async () => {
    const jobs = fakeJobs(() => new Promise(() => {}));
    const { intentId } = await newIntent();
    const started = Date.now();
    expect(await publisher(jobs, { publishTimeoutMs: 50 }).tick()).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await outboxOf(intentId)).toMatchObject({ status: 'pending', attempts: 1 });
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
      await new Promise((resolve) => setTimeout(resolve, 20));
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
      expect(await p.tick()).toBe(1);
      expect(await intentsQueue.getJob(lost.intentId)).toBeDefined();
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
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { intentId } = await newIntent();
      p.wake();
      const deadline = Date.now() + 2_000;
      while ((await outboxOf(intentId)).status !== 'published' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await outboxOf(intentId)).status).toBe('published');
    } finally {
      await p.stop();
      await jobs.close();
    }
  });

  it('stop waits for the in-flight row', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobs = fakeJobs(() => gate);
    const { intentId } = await newIntent();
    const p = publisher(jobs, { pollMs: 60_000, publishTimeoutMs: 5_000 });
    p.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    let stopped = false;
    const stopping = p.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect((await outboxOf(intentId)).status).toBe('published');
  });
});
