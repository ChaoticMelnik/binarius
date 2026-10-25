import { randomBytes, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '@binarius/shared/testing';
import { logOptions } from '@binarius/shared';
import type { TradeIntentRow } from '@binarius/db';
import { createIntentRouter, INTENT_DIRECT_JOB, ownIntentQueueName } from './router';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || redisUrl === '') {
  throw new Error('REDIS_URL is required for apps/trading-worker integration tests (see README)');
}

const prefix = `test-${randomBytes(4).toString('hex')}`;
const CONFIG = { recoveryDelayMs: 60_000, stopBudgetMs: 2_000, drainPollMs: 20, drainTailMs: 300 };
const OPTS = { attempts: 1, removeOnComplete: true, removeOnFail: true };
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
    // the deregister long done, the cut far off: the drain runs only its tail
    stopNow: () =>
      router.stop({ deregistered: Promise.resolve(), notAfter: performance.now() + 5_000 }),
    keysOfOwn: async () => {
      const [, keys] = await redis.scan(
        0,
        'MATCH',
        `${prefix}:${ownIntentQueueName(me)}:*`,
        'COUNT',
        10_000,
      );
      return keys;
    },
    lines,
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
    await h.stopNow();
  });

  it('R2 an account we own: processes here, adds nothing', async () => {
    const h = harness();
    const account = randomUUID();
    h.owners.set(account, h.me);
    expect(await h.router.forward(intentOf(account))).toBe(false);
    expect(await counts(h.own)).toBe(0);
    await h.stopNow();
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
    await h.stopNow();
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
    await h.stopNow();
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
    await h.stopNow();
  });

  it('R6 stop() moves our queue to the shared one as direct jobs and deletes it', async () => {
    const h = harness();
    const shared = queue('trading-intents');
    const waiting = randomUUID();
    const delayed = randomUUID();
    await h.own.add('intent', { intentId: waiting }, { ...OPTS, jobId: waiting });
    await h.own.add('intent', { intentId: delayed }, { ...OPTS, jobId: delayed, delay: 60_000 });
    await h.stopNow();
    for (const [intentId, state] of [
      [waiting, 'waiting'],
      [delayed, 'delayed'],
    ] as const) {
      const job = (await shared.getJob(`${intentId}-direct`))!;
      expect(job.name).toBe(INTENT_DIRECT_JOB);
      expect(job.data).toEqual({ intentId });
      expect(await job.getState()).toBe(state);
    }
    expect(await h.keysOfOwn()).toEqual([]);
    expect(h.logs('intent router stop failed')).toEqual([]);
  });

  it('R7 stop() on a closed connection resolves and logs', async () => {
    const closed = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const h = harness(closed);
    await closed.quit();
    await expect(h.stopNow()).resolves.toBeUndefined();
    expect(h.logs('intent router stop failed')).toEqual([
      expect.objectContaining({ level: 50, err: expect.any(Object) }),
    ]);
  });

  it('R8 stop() drains our queue until the tail after the deregister, then deletes it', async () => {
    const h = harness();
    const shared = queue('trading-intents');
    let deregister!: () => void;
    const deregistered = new Promise<void>((resolve) => {
      deregister = resolve;
    });
    const stopped = h.router.stop({ deregistered, notAfter: performance.now() + 10_000 });
    let resolvedAt: number | undefined;
    void stopped.then(() => {
      resolvedAt = performance.now();
    });
    // past the drain's first pass: a forward a peer makes while it still names us
    await sleep(5 * CONFIG.drainPollMs);
    const first = randomUUID();
    const addedAt = performance.now();
    await h.own.add('intent', { intentId: first }, { ...OPTS, jobId: first });
    await until(
      'the first job moved',
      async () =>
        (await shared.getJob(`${first}-direct`)) !== undefined && (await counts(h.own)) === 0,
    );
    expect(performance.now() - addedAt).toBeLessThan(CONFIG.drainTailMs - 50);
    expect(resolvedAt).toBeUndefined();

    deregister();
    const deregisteredAt = performance.now();
    // inside the tail: a peer whose view still lists us
    await sleep(CONFIG.drainTailMs / 3);
    const second = randomUUID();
    await h.own.add('intent', { intentId: second }, { ...OPTS, jobId: second });
    await stopped;
    expect(resolvedAt! - deregisteredAt).toBeGreaterThanOrEqual(
      CONFIG.drainTailMs - CONFIG.drainPollMs,
    );
    const moved = (await shared.getJob(`${second}-direct`))!;
    expect(moved.name).toBe(INTENT_DIRECT_JOB);
    expect(await h.keysOfOwn()).toEqual([]);
  });

  it('R9 stop() cuts the drain at notAfter when the deregister never settles', async () => {
    const h = harness();
    const shared = queue('trading-intents');
    const startedAt = performance.now();
    const notAfter = startedAt + 300;
    const stopped = h.router.stop({ deregistered: new Promise(() => {}), notAfter });
    await sleep(100);
    const intentId = randomUUID();
    await h.own.add('intent', { intentId }, { ...OPTS, jobId: intentId });
    await stopped;
    expect(performance.now()).toBeLessThan(notAfter + CONFIG.stopBudgetMs);
    expect(await shared.getJob(`${intentId}-direct`)).toBeDefined();
    expect(await h.keysOfOwn()).toEqual([]);
    expect(h.logs('intent router drain cut by the shutdown budget')).toEqual([
      expect.objectContaining({ level: 40 }),
    ]);
    expect(h.logs('intent router stop timed out')).toEqual([]);
  });

  it('R10 a moved insurance keeps what is left of its delay; an immediate job stays immediate', async () => {
    const h = harness();
    const shared = queue('trading-intents');
    const insurance = randomUUID();
    const immediate = randomUUID();
    await h.own.add(
      'intent',
      { intentId: insurance },
      { ...OPTS, jobId: insurance, delay: 10_000 },
    );
    await h.own.add('intent', { intentId: immediate }, { ...OPTS, jobId: immediate });
    await h.stopNow();
    const delayed = (await shared.getJob(`${insurance}-direct`))!;
    expect(await delayed.getState()).toBe('delayed');
    expect(delayed.delay).toBeGreaterThan(8_000);
    expect(delayed.delay).toBeLessThanOrEqual(10_000);
    const now = (await shared.getJob(`${immediate}-direct`))!;
    expect(await now.getState()).toBe('waiting');
    expect(now.delay).toBe(0);
  });

  it("R11 a move beside the forwarder's shared job of the same intent still lands", async () => {
    const h = harness();
    const shared = queue('trading-intents');
    const intentId = randomUUID();
    await shared.add('intent', { intentId }, { ...OPTS, jobId: intentId });
    await h.own.add('intent', { intentId }, { ...OPTS, jobId: intentId });
    await h.stopNow();
    expect((await shared.getJob(intentId))!.name).toBe('intent');
    expect((await shared.getJob(`${intentId}-direct`))!.name).toBe(INTENT_DIRECT_JOB);
  });
});
