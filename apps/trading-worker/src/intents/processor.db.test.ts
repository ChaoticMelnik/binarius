import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TradeIntentFailureReason,
  type CreateTradeIntentRequest,
  type DecimalString,
} from '@binarius/shared';
import {
  brokerAccounts,
  createTradeIntent,
  findTradeIntent,
  markIntentUnknown,
  outboxEvents,
  takeIntent,
  tokenLedger,
  tradeIntents,
  users,
} from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import type { SubmitResult, TradeExecutor } from './executor';
import { notConfiguredExecutor } from './executor';
import { InvalidJobError, processIntentJob, type ProcessorDeps } from './processor';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'DATABASE_URL is required for apps/trading-worker integration tests (see README)',
  );
}

const logger = pino({ level: 'silent' });
let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

let seq = 0;
async function newIntent() {
  const n = ++seq;
  const telegramUserId = BigInt(500_000 + n);
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

const executorOf = (
  result: SubmitResult | (() => Promise<SubmitResult>),
): TradeExecutor & { calls: number } => {
  const executor = {
    calls: 0,
    submit: async () => {
      executor.calls += 1;
      return typeof result === 'function' ? result() : result;
    },
  };
  return executor;
};

const deps = (
  executor: TradeExecutor,
  config: Partial<ProcessorDeps['config']> = {},
): ProcessorDeps => ({
  db: tmp.db,
  executor,
  logger,
  config: { intentMaxAgeMs: 60_000, submitAckTimeoutMs: 200, staleSubmittingMs: 60_000, ...config },
});

const statusOf = async (id: string) => (await findTradeIntent(tmp.db, id))!;
const reservedOf = async (userId: string) =>
  (await tmp.db.select({ v: users.tokenReserved }).from(users).where(eq(users.id, userId)))[0]!.v;
const ledgerKinds = async (intentId: string) =>
  (
    await tmp.db
      .select({ kind: tokenLedger.kind })
      .from(tokenLedger)
      .where(eq(tokenLedger.intentId, intentId))
  ).map((r) => r.kind);
const topicsOf = async (intentId: string) =>
  (
    await tmp.db
      .select({ topic: outboxEvents.topic })
      .from(outboxEvents)
      .where(eq(outboxEvents.intentId, intentId))
  )
    .map((r) => r.topic)
    .sort();

describe('processIntentJob', () => {
  it('rejects a malformed payload and a missing intent as invalid jobs', async () => {
    await expect(
      processIntentJob(deps(notConfiguredExecutor), { intentId: 'nope' }),
    ).rejects.toBeInstanceOf(InvalidJobError);
    await expect(processIntentJob(deps(notConfiguredExecutor), null)).rejects.toBeInstanceOf(
      InvalidJobError,
    );
    await expect(
      processIntentJob(deps(notConfiguredExecutor), {
        intentId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toBeInstanceOf(InvalidJobError);
  });

  it('records an accepted outcome with the transport, bumping the version per transition', async () => {
    const { intentId, version } = await newIntent();
    const executor = executorOf({ outcome: 'accepted', transport: 'socket' });
    expect(await processIntentJob(deps(executor), { intentId })).toBe('accepted');
    const row = await statusOf(intentId);
    expect(row).toMatchObject({
      status: 'accepted',
      transport: 'socket',
      version: version + 2,
      tokensReserved: 1n,
    });
    expect(row.submittedAt).toBeInstanceOf(Date);
    expect(executor.calls).toBe(1);
  });

  it('records a rejection and releases the token', async () => {
    const { intentId, userId } = await newIntent();
    expect(await processIntentJob(deps(notConfiguredExecutor), { intentId })).toBe('rejected');
    expect(await statusOf(intentId)).toMatchObject({
      status: 'rejected',
      lastError: 'executor_not_configured',
      tokensReserved: 0n,
    });
    expect(await reservedOf(userId)).toBe(0n);
    expect(await ledgerKinds(intentId)).toEqual(['reserve', 'release']);
  });

  it('records an unknown outcome with a reconciliation row and keeps the reserve', async () => {
    const { intentId, userId } = await newIntent();
    expect(
      await processIntentJob(
        deps(
          executorOf({
            outcome: 'unknown',
            reason: TradeIntentFailureReason.BrokerRejected,
            detail: 'no ack',
          }),
        ),
        { intentId },
      ),
    ).toBe('unknown');
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'broker_rejected',
      tokensReserved: 1n,
    });
    expect(await reservedOf(userId)).toBe(1n);
    expect(await topicsOf(intentId)).toEqual(['trading-intents', 'trading-reconciliation']);
  });

  it('treats an executor throw as unknown', async () => {
    const { intentId } = await newIntent();
    const executor = executorOf(() => Promise.reject(new Error('socket exploded')));
    expect(await processIntentJob(deps(executor), { intentId })).toBe('unknown');
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'executor_error',
    });
  });

  it('times out a cooperative executor through the signal', async () => {
    const { intentId } = await newIntent();
    let aborted = false;
    const executor: TradeExecutor = {
      submit: (_intent, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    };
    const started = Date.now();
    expect(await processIntentJob(deps(executor, { submitAckTimeoutMs: 50 }), { intentId })).toBe(
      'unknown',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(aborted).toBe(true);
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'executor_timeout',
    });
  });

  it('times out an executor that ignores the signal', async () => {
    const { intentId } = await newIntent();
    const executor: TradeExecutor = { submit: () => new Promise(() => {}) };
    const started = Date.now();
    expect(await processIntentJob(deps(executor, { submitAckTimeoutMs: 50 }), { intentId })).toBe(
      'unknown',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'executor_timeout',
    });
  });

  it('expires an old intent on the database clock without calling the executor', async () => {
    const { intentId, userId } = await newIntent();
    await tmp.db
      .update(tradeIntents)
      .set({ createdAt: sql`now() - interval '2 minutes'` })
      .where(eq(tradeIntents.id, intentId));
    const executor = executorOf({ outcome: 'accepted' });
    expect(await processIntentJob(deps(executor), { intentId })).toBe('expired');
    expect(executor.calls).toBe(0);
    expect(await statusOf(intentId)).toMatchObject({
      status: 'rejected',
      lastError: 'expired',
      tokensReserved: 0n,
    });
    expect(await reservedOf(userId)).toBe(0n);
  });

  it('makes a duplicate delivery of a finished intent a no-op', async () => {
    const { intentId } = await newIntent();
    const executor = executorOf({ outcome: 'accepted' });
    expect(await processIntentJob(deps(executor), { intentId })).toBe('accepted');
    expect(await processIntentJob(deps(executor), { intentId })).toBe('noop');
    expect(executor.calls).toBe(1);
  });

  it('marks a stale submitting intent unknown on redelivery and leaves a fresh one alone', async () => {
    const { intentId, version } = await newIntent();
    const taken = (await takeIntent(tmp.db, {
      id: intentId,
      expectedVersion: version,
      maxAgeMs: 60_000,
    }))!;
    const executor = executorOf({ outcome: 'accepted' });
    expect(await processIntentJob(deps(executor), { intentId })).toBe('noop');
    expect((await statusOf(intentId)).status).toBe('submitting');

    await tmp.db
      .update(tradeIntents)
      .set({ submittedAt: sql`now() - interval '2 minutes'` })
      .where(eq(tradeIntents.id, intentId));
    expect(await processIntentJob(deps(executor), { intentId })).toBe('stale_unknown');
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'stale_submitting',
      version: taken.version + 1,
    });
    expect(await topicsOf(intentId)).toEqual(['trading-intents', 'trading-reconciliation']);
    expect(executor.calls).toBe(0);
  });

  it('drops a late outcome once the sweeper has moved the intent on', async () => {
    const { intentId } = await newIntent();
    const executor: TradeExecutor = {
      submit: async (intent) => {
        // the sweeper strikes while the broker is answering
        await tmp.db.transaction((tx) =>
          markIntentUnknown(tx, {
            id: intent.id,
            reason: TradeIntentFailureReason.StaleSubmitting,
          }),
        );
        return { outcome: 'accepted' };
      },
    };
    expect(await processIntentJob(deps(executor), { intentId })).toBe('noop');
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'stale_submitting',
    });
  });
});
