import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateTradeIntentRequest, DecimalString } from '@binarius/shared';
import { brokerAccounts, createTradeIntent, findTradeIntent, users } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { deadLetter, startIntentConsumer, type DeadLetter, type IntentConsumer } from './consumer';
import { InvalidJobError, processIntentJob } from './processor';

const baseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'DATABASE_URL is required for apps/trading-worker integration tests (see README)',
  );
}
if (redisUrl === undefined || redisUrl === '') {
  throw new Error('REDIS_URL is required for apps/trading-worker integration tests (see README)');
}

const prefix = `test-${randomBytes(4).toString('hex')}`;
const logger = pino({ level: 'silent' });
let tmp: TempDatabase;
let redis: Redis;
let intents: Queue;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  intents = new Queue('trading-intents', { connection: redis, prefix });
});
afterAll(async () => {
  const dlq = new Queue('trading-intents-dead-letter', { connection: redis, prefix });
  await intents.obliterate({ force: true });
  await dlq.obliterate({ force: true });
  await Promise.all([intents.close(), dlq.close()]);
  await redis.quit();
  await tmp.drop();
});

let seq = 0;
async function newIntent() {
  const n = ++seq;
  const telegramUserId = BigInt(300_000 + n);
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
  return intent.id;
}

// resolves with the job's terminal event so the test can look at the database afterwards
function settled(consumer: IntentConsumer, jobId: string): Promise<'completed' | 'failed'> {
  return new Promise((resolve) => {
    consumer.worker.on('completed', (job) => {
      if (job.id === jobId) resolve('completed');
    });
    consumer.worker.on('failed', (job) => {
      if (job?.id === jobId) resolve('failed');
    });
  });
}

async function withConsumer<T>(
  processor: (payload: unknown) => Promise<never> | ReturnType<typeof processIntentJob>,
  run: (consumer: IntentConsumer) => Promise<T>,
): Promise<T> {
  const consumer = startIntentConsumer({
    connection: redis,
    processor,
    logger,
    concurrency: 2,
    prefix,
  });
  try {
    await consumer.worker.waitUntilReady();
    return await run(consumer);
  } finally {
    await consumer.worker.close();
    await consumer.dlq.close();
  }
}

const dlqEntries = async (): Promise<DeadLetter[]> => {
  const dlq = new Queue<DeadLetter>('trading-intents-dead-letter', { connection: redis, prefix });
  try {
    const jobs = await dlq.getJobs([
      'waiting',
      'delayed',
      'completed',
      'failed',
      'active',
      'prioritized',
    ]);
    return jobs.map((job) => job.data);
  } finally {
    await dlq.close();
  }
};

describe('startIntentConsumer', () => {
  it('processes a queued intent end to end with the default executor', async () => {
    const intentId = await newIntent();
    const outcome = await withConsumer(
      (payload) =>
        processIntentJob(
          {
            db: tmp.db,
            executor: { submit: async () => ({ outcome: 'accepted', transport: 'socket' }) },
            logger,
            config: { intentMaxAgeMs: 60_000, submitAckTimeoutMs: 500, staleSubmittingMs: 60_000 },
          },
          payload,
        ),
      async (consumer) => {
        const done = settled(consumer, intentId);
        await intents.add(
          'intent',
          { intentId },
          { jobId: intentId, attempts: 1, removeOnComplete: true, removeOnFail: true },
        );
        return done;
      },
    );
    expect(outcome).toBe('completed');
    expect(await findTradeIntent(tmp.db, intentId)).toMatchObject({
      status: 'accepted',
      transport: 'socket',
    });
  });

  it('dead-letters a failing job with codes only', async () => {
    const intentId = await newIntent();
    const outcome = await withConsumer(
      () => Promise.reject(new Error('database gone: postgres://user:secret@host/db')),
      async (consumer) => {
        const done = settled(consumer, intentId);
        await intents.add(
          'intent',
          { intentId },
          { jobId: intentId, attempts: 1, removeOnComplete: true, removeOnFail: true },
        );
        await done;
        // the failed listener runs after the event; give it a beat to reach the dlq
        await new Promise((resolve) => setTimeout(resolve, 100));
        return done;
      },
    );
    expect(outcome).toBe('failed');
    const entries = (await dlqEntries()).filter((entry) => entry.intentId === intentId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ intentId, reason: 'processing_failed' });
    expect(JSON.stringify(entries[0])).not.toContain('secret');
    // the job is gone from the intents queue (removeOnFail) and the intent is untouched
    expect(await intents.getJob(intentId)).toBeUndefined();
    expect((await findTradeIntent(tmp.db, intentId))?.status).toBe('queued');
  });

  it('dead-letters a malformed payload without an intent id', async () => {
    const jobId = `bogus-${randomBytes(4).toString('hex')}`;
    await withConsumer(
      () => Promise.reject(new InvalidJobError('nope')),
      async (consumer) => {
        const done = settled(consumer, jobId);
        await intents.add('intent', { garbage: true }, { jobId, attempts: 1, removeOnFail: true });
        await done;
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    );
    const entries = (await dlqEntries()).filter((entry) => entry.reason === 'invalid_job');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every((entry) => entry.intentId === null)).toBe(true);
  });
});

describe('deadLetter', () => {
  it('survives a sink that rejects and never throws', async () => {
    const messages: string[] = [];
    const sink = { add: () => Promise.reject(new Error('redis gone')) };
    const quiet = pino({ level: 'error' }, { write: (line: string) => void messages.push(line) });
    await expect(deadLetter(sink, quiet, undefined, new Error('boom'))).resolves.toBeUndefined();
    expect(messages.some((line) => line.includes('dlq_publish_failed'))).toBe(true);
  });
});
