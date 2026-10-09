import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findTradeIntent, OutboxTopic } from '@binarius/db';
import { openTradeFor, until } from '@binarius/shared/testing';
import {
  createTempDatabase,
  seedQueuedIntent,
  seedUnknownIntent,
  type TempDatabase,
} from '@binarius/db/testing';
import {
  deadLetterSessionWrite,
  type DeadLetter,
  type JobDeadLetter,
  type SessionDeadLetter,
} from '../dead-letter';
import { deadLetter, startIntentConsumer, type IntentConsumer } from './consumer';
import { InvalidJobError, processIntentJob } from './processor';
import { processReconciliationJob } from './reconciliation';

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

const prefix = `test-${randomBytes(4).toString('hex')}`;
const logger = pino({ level: 'silent' });
let tmp: TempDatabase;
let redis: Redis;
let intents: Queue;
let reconciliations: Queue;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  intents = new Queue('trading-intents', { connection: redis, prefix });
  reconciliations = new Queue('trading-reconciliation', { connection: redis, prefix });
});
afterAll(async () => {
  const dlq = new Queue('trading-intents-dead-letter', { connection: redis, prefix });
  await intents.obliterate({ force: true });
  await reconciliations.obliterate({ force: true });
  await dlq.obliterate({ force: true });
  await Promise.all([intents.close(), reconciliations.close(), dlq.close()]);
  await redis.quit();
  await tmp.drop();
});

const newIntent = async () => (await seedQueuedIntent(tmp.db)).intent.id;

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
  processor: (payload: unknown) => Promise<string>,
  run: (consumer: IntentConsumer) => Promise<T>,
  topic: OutboxTopic = OutboxTopic.TradingIntents,
): Promise<T> {
  const consumer = startIntentConsumer({
    topic,
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

const allDlqEntries = async (): Promise<DeadLetter[]> => {
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
const dlqEntries = async (): Promise<JobDeadLetter[]> =>
  (await allDlqEntries()).filter((entry): entry is JobDeadLetter => entry.source === 'intent_job');

describe('startIntentConsumer', () => {
  it('processes a queued intent end to end with the default executor', async () => {
    const intentId = await newIntent();
    const outcome = await withConsumer(
      (payload) =>
        processIntentJob(
          {
            db: tmp.db,
            executor: {
              submit: async (intent) => ({
                outcome: 'accepted',
                transport: 'socket',
                trade: openTradeFor(intent),
              }),
            },
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
        // the failed listener runs after the event: the drain waits for its dlq write
        await consumer.worker.close();
        await consumer.drainDeadLetters();
        return done;
      },
    );
    expect(outcome).toBe('failed');
    const entries = (await dlqEntries()).filter((entry) => entry.intentId === intentId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'intent_job',
      intentId,
      topic: 'trading-intents',
      reason: 'processing_failed',
    });
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
        await consumer.worker.close();
        await consumer.drainDeadLetters();
      },
    );
    const entries = (await dlqEntries()).filter((entry) => entry.reason === 'invalid_job');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every((entry) => entry.intentId === null)).toBe(true);
  });
});

describe('startIntentConsumer on trading-reconciliation (#89)', () => {
  const jobOptions = (jobId: string) => ({
    jobId,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });

  it('hands an unknown intent to the pass', async () => {
    const intentId = (await seedUnknownIntent(tmp.db)).intent.id;
    const outcome = await withConsumer(
      (payload) => processReconciliationJob({ db: tmp.db, logger }, payload),
      async (consumer) => {
        const done = settled(consumer, intentId);
        await reconciliations.add('intent', { intentId }, jobOptions(intentId));
        return done;
      },
      OutboxTopic.TradingReconciliation,
    );
    expect(outcome).toBe('completed');
    expect((await findTradeIntent(tmp.db, intentId))?.status).toBe('reconciling');
  });

  it('dead-letters a failing reconciliation job with its topic, the intent still unknown', async () => {
    const intentId = (await seedUnknownIntent(tmp.db)).intent.id;
    const outcome = await withConsumer(
      () => Promise.reject(new Error('database gone')),
      async (consumer) => {
        const done = settled(consumer, intentId);
        await reconciliations.add('intent', { intentId }, jobOptions(intentId));
        await done;
        await consumer.worker.close();
        await consumer.drainDeadLetters();
        return done;
      },
      OutboxTopic.TradingReconciliation,
    );
    expect(outcome).toBe('failed');
    const entries = (await dlqEntries()).filter((entry) => entry.intentId === intentId);
    expect(entries).toEqual([
      expect.objectContaining({
        source: 'intent_job',
        intentId,
        topic: 'trading-reconciliation',
        reason: 'processing_failed',
      }),
    ]);
    expect((await findTradeIntent(tmp.db, intentId))?.status).toBe('unknown');
  });
});

describe('drainDeadLetters', () => {
  it('lets shutdown wait for a dead-letter write started by a job that failed during close', async () => {
    const intentId = await newIntent();
    let started = false;
    const consumer = startIntentConsumer({
      topic: OutboxTopic.TradingIntents,
      connection: redis,
      // fails only once the drain is under way, so the failed event fires inside close()
      processor: () => {
        started = true;
        return new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('late')), 150),
        );
      },
      logger,
      concurrency: 1,
      prefix,
    });
    await consumer.worker.waitUntilReady();
    await intents.add('intent', { intentId }, { jobId: intentId, attempts: 1, removeOnFail: true });
    await until('the job to start', () => started);
    await consumer.worker.close();
    await consumer.drainDeadLetters();
    try {
      const entries = (await dlqEntries()).filter((entry) => entry.intentId === intentId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ reason: 'processing_failed' });
    } finally {
      await consumer.dlq.close();
    }
  });
});

describe('deadLetter', () => {
  it('survives a sink that rejects and never throws', async () => {
    const messages: string[] = [];
    const sink = { add: () => Promise.reject(new Error('redis gone')) };
    const quiet = pino({ level: 'error' }, { write: (line: string) => void messages.push(line) });
    await expect(
      deadLetter(sink, quiet, OutboxTopic.TradingIntents, undefined, new Error('boom')),
    ).resolves.toBeUndefined();
    expect(messages.some((line) => line.includes('dlq_publish_failed'))).toBe(true);
  });
});

describe('deadLetterSessionWrite (#92)', () => {
  it('writes one session entry per account, source and hour into the shared queue, ids only', async () => {
    const dlq = new Queue<DeadLetter>('trading-intents-dead-letter', { connection: redis, prefix });
    const accountId = `acc-${randomBytes(4).toString('hex')}`;
    const write = (brokerTradeIds: string[]) =>
      deadLetterSessionWrite(
        dlq,
        pino({ level: 'silent' }),
        { source: 'close_trade_success', accountId, mode: 'demo', brokerTradeIds },
        1_000,
      );
    try {
      await write(['bt-1', 'bt-2']);
      // the same account, source and hour: BullMQ keeps the first entry
      await write(['bt-3']);
    } finally {
      await dlq.close();
    }
    const entries = (await allDlqEntries()).filter(
      (entry): entry is SessionDeadLetter =>
        entry.source !== 'intent_job' && entry.accountId === accountId,
    );
    expect(entries).toEqual([
      {
        source: 'close_trade_success',
        accountId,
        mode: 'demo',
        brokerTradeIds: ['bt-1', 'bt-2'],
        reason: 'processing_failed',
        failedAt: expect.any(String),
      },
    ]);
  });

  it('survives a sink that rejects and never throws', async () => {
    const messages: Record<string, unknown>[] = [];
    const quiet = pino(
      { level: 'error' },
      { write: (line: string) => void messages.push(JSON.parse(line) as Record<string, unknown>) },
    );
    await expect(
      deadLetterSessionWrite(
        { add: () => Promise.reject(new Error('redis gone')) },
        quiet,
        { source: 'user_data', accountId: 'acc-1', mode: null, brokerTradeIds: [] },
        1_000,
      ),
    ).resolves.toBeUndefined();
    expect(messages).toEqual([
      expect.objectContaining({ msg: 'dlq_publish_failed', accountId: 'acc-1', source: 'user_data' }),
    ]);
  });

  it('logs a write that fails after its timeout once, not twice', async () => {
    const messages: Record<string, unknown>[] = [];
    const quiet = pino(
      { level: 'error' },
      { write: (line: string) => void messages.push(JSON.parse(line) as Record<string, unknown>) },
    );
    let fail: (error: Error) => void = () => undefined;
    const late = new Promise<unknown>((_resolve, reject) => {
      fail = reject;
    });
    await deadLetterSessionWrite(
      { add: () => late },
      quiet,
      { source: 'user_data', accountId: 'acc-3', mode: null, brokerTradeIds: [] },
      20,
    );
    fail(new Error('connection closed'));
    await late.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(messages.filter((m) => m.msg === 'dlq_publish_failed')).toEqual([
      expect.objectContaining({ reason: 'timeout' }),
    ]);
  });

  // a Redis that is down holds the command instead of failing it (maxRetriesPerRequest: null)
  it('gives up waiting after its timeout and says so', async () => {
    const messages: Record<string, unknown>[] = [];
    const quiet = pino(
      { level: 'error' },
      { write: (line: string) => void messages.push(JSON.parse(line) as Record<string, unknown>) },
    );
    await deadLetterSessionWrite(
      { add: () => new Promise(() => undefined) },
      quiet,
      { source: 'update_balance', accountId: 'acc-2', mode: 'demo', brokerTradeIds: [] },
      50,
    );
    // the sink never answers, so returning at all is the timeout's doing
    expect(messages).toEqual([
      expect.objectContaining({ msg: 'dlq_publish_failed', accountId: 'acc-2', reason: 'timeout' }),
    ]);
  });
});
