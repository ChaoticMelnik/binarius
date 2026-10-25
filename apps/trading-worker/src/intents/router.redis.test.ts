import { randomBytes, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logOptions } from '@binarius/shared';
import type { TradeIntentRow } from '@binarius/db';
import { createIntentRouter, INTENT_DIRECT_JOB, ownIntentQueueName } from './router';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || redisUrl === '') {
  throw new Error('REDIS_URL is required for apps/trading-worker integration tests (see README)');
}

const prefix = `test-${randomBytes(4).toString('hex')}`;
const CONFIG = { recoveryDelayMs: 60_000, stopBudgetMs: 2_000 };
let redis: Redis;
const opened: Queue[] = [];

beforeAll(() => {
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
});
afterAll(async () => {
  for (const queue of opened) await queue.obliterate({ force: true });
  await Promise.all(opened.map((queue) => queue.close()));
  await redis.quit();
});

const queue = (name: string) => {
  const q = new Queue(name, { connection: redis, prefix });
  opened.push(q);
  return q;
};

// the router reads the intent's id and account only
const intentOf = (accountId: string) =>
  ({ id: randomUUID(), brokerAccountId: accountId }) as TradeIntentRow;

function harness(connection: Redis = redis) {
  const me = randomUUID();
  const other = randomUUID();
  const owners = new Map<string, string>();
  const lines: Record<string, unknown>[] = [];
  const logger = pino(logOptions('debug'), {
    write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const router = createIntentRouter({
    ownerId: me,
    registry: { ownerOf: (id) => owners.get(id) },
    connection,
    prefix,
    logger,
    config: CONFIG,
  });
  return {
    me,
    other,
    owners,
    router,
    own: queue(ownIntentQueueName(me)),
    theirs: queue(ownIntentQueueName(other)),
    logs: (msg: string) => lines.filter((line) => line.msg === msg),
  };
}

const counts = async (q: Queue) => {
  const all = await q.getJobCounts();
  return Object.values(all).reduce((sum, n) => sum + n, 0);
};

describe('the intent router (#347)', () => {
  it('R1 without an owner in the view: processes here, adds nothing', async () => {
    const h = harness();
    expect(await h.router.forward(intentOf(randomUUID()))).toBe(false);
    expect(await counts(h.own)).toBe(0);
    expect(await counts(queue(ownIntentQueueName('undefined')))).toBe(0);
    await h.router.stop();
  });

  it('R2 an account we own: processes here, adds nothing', async () => {
    const h = harness();
    const account = randomUUID();
    h.owners.set(account, h.me);
    expect(await h.router.forward(intentOf(account))).toBe(false);
    expect(await counts(h.own)).toBe(0);
    await h.router.stop();
  });

  it("R3 another owner: the job in the owner's queue, the delayed insurance in ours, one line", async () => {
    const h = harness();
    const account = randomUUID();
    h.owners.set(account, h.other);
    const intent = intentOf(account);
    expect(await h.router.forward(intent)).toBe(true);
    const sent = (await h.theirs.getJob(intent.id))!;
    expect(sent.name).toBe('intent');
    expect(sent.data).toEqual({ intentId: intent.id });
    expect(await sent.getState()).toBe('waiting');
    expect(sent.opts).toMatchObject({ attempts: 1, removeOnComplete: true, removeOnFail: true });
    const insurance = (await h.own.getJob(intent.id))!;
    expect(insurance.data).toEqual({ intentId: intent.id });
    expect(await insurance.getState()).toBe('delayed');
    expect(insurance.opts.delay).toBe(CONFIG.recoveryDelayMs);
    expect(h.logs('intent forwarded')).toEqual([
      expect.objectContaining({
        level: 30,
        intentId: intent.id,
        accountId: account,
        owner: h.other,
      }),
    ]);
    await h.router.stop();
  });

  it('R4 the same intent forwarded twice: one job in each queue', async () => {
    const h = harness();
    const account = randomUUID();
    h.owners.set(account, h.other);
    const intent = intentOf(account);
    expect(await h.router.forward(intent)).toBe(true);
    expect(await h.router.forward(intent)).toBe(true);
    expect(await counts(h.theirs)).toBe(1);
    expect(await counts(h.own)).toBe(1);
    await h.router.stop();
  });

  it('R5 a forward on a closed connection: processes here, logs, adds nothing', async () => {
    const closed = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const h = harness(closed);
    await closed.quit();
    const account = randomUUID();
    h.owners.set(account, h.other);
    expect(await h.router.forward(intentOf(account))).toBe(false);
    expect(h.logs('intent forward failed, processing here')).toEqual([
      expect.objectContaining({ level: 40, owner: h.other, err: expect.any(Object) }),
    ]);
    expect(h.logs('intent forwarded')).toEqual([]);
    expect(await counts(h.theirs)).toBe(0);
    expect(await counts(h.own)).toBe(0);
    await h.router.stop();
  });

  it('R6 stop() requeues our queue to the shared one as direct jobs and deletes it', async () => {
    const h = harness();
    const shared = queue('trading-intents');
    const waiting = randomUUID();
    const delayed = randomUUID();
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: true };
    await h.own.add('intent', { intentId: waiting }, { ...opts, jobId: waiting });
    await h.own.add('intent', { intentId: delayed }, { ...opts, jobId: delayed, delay: 60_000 });
    await h.router.stop();
    for (const intentId of [waiting, delayed]) {
      const job = (await shared.getJob(intentId))!;
      expect(job.name).toBe(INTENT_DIRECT_JOB);
      expect(job.data).toEqual({ intentId });
      expect(await job.getState()).toBe('waiting');
    }
    expect(await counts(h.own)).toBe(0);
    expect(h.logs('intent router stop failed')).toEqual([]);
  });

  it('R7 stop() on a closed connection resolves and logs', async () => {
    const closed = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const h = harness(closed);
    await closed.quit();
    await expect(h.router.stop()).resolves.toBeUndefined();
    expect(h.logs('intent router stop failed')).toEqual([
      expect.objectContaining({ level: 50, err: expect.any(Object) }),
    ]);
  });
});
