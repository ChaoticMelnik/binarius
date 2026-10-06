import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TradeIntentFailureReason, type OpenTrade } from '@binarius/shared';
import { openTradeFor } from '@binarius/shared/testing';
import {
  brokerTrades,
  findTradeIntent,
  markIntentUnknown,
  outboxEvents,
  takeIntent,
  tokenLedger,
  tradeIntents,
  users,
  type TradeIntentRow,
} from '@binarius/db';
import { createTempDatabase, seedQueuedIntent, type TempDatabase } from '@binarius/db/testing';
import type { SubmitResult, TradeExecutor } from './executor';
import { notConfiguredExecutor, realTradingGate } from './executor';
import { InvalidJobError, processIntentJob, type ProcessorDeps } from './processor';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}

const logger = pino({ level: 'silent' });
const MAX_AGE_MS = 60_000;
let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

async function newIntent() {
  const seed = await seedQueuedIntent(tmp.db);
  return { intentId: seed.intent.id, userId: seed.userId, version: seed.intent.version };
}

const executorOf = (
  result: SubmitResult | ((intent: TradeIntentRow) => SubmitResult | Promise<SubmitResult>),
): TradeExecutor & { calls: number } => {
  const executor = {
    calls: 0,
    submit: async (intent: TradeIntentRow) => {
      executor.calls += 1;
      return typeof result === 'function' ? result(intent) : result;
    },
  };
  return executor;
};

// the broker's open trade for the very intent submitted, as an executor hands it over (#17)
const acceptingExecutor = (patch: Partial<OpenTrade> = {}) =>
  executorOf((intent) => ({
    outcome: 'accepted',
    transport: 'socket',
    trade: openTradeFor(intent, patch),
  }));

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
const tradesOf = (intentId: string) =>
  tmp.db.select().from(brokerTrades).where(eq(brokerTrades.intentId, intentId));
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
    const executor = acceptingExecutor();
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
    expect(await tradesOf(intentId)).toMatchObject([{ intentId, status: 'open' }]);
  });

  it('turns an accepted trade that does not match the intent into unknown', async () => {
    const { intentId, userId } = await newIntent();
    const lines: string[] = [];
    const capturing = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    const executor = acceptingExecutor({ id: 'bt-mismatch', assetId: 92 });
    expect(await processIntentJob({ ...deps(executor), logger: capturing }, { intentId })).toBe(
      'unknown',
    );
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'trade_mismatch',
      tokensReserved: 1n,
    });
    expect(await reservedOf(userId)).toBe(1n);
    expect(await topicsOf(intentId)).toEqual(['trading-intents', 'trading-reconciliation']);
    expect(await tradesOf(intentId)).toEqual([]);
    const warned = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const mismatch = warned.find((entry) => entry.mismatch !== undefined);
    expect(mismatch).toMatchObject({ intentId, brokerTradeId: 'bt-mismatch', mismatch: 'asset' });
    const recorded = warned.find((entry) => entry.msg === 'intent outcome recorded');
    expect(recorded).toMatchObject({ intentId, outcome: 'unknown', status: 'unknown' });
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

  // backend created it with the grant on; this worker runs with it off (#134)
  it('rejects a real intent at the grant gate and releases the token', async () => {
    const seed = await seedQueuedIntent(tmp.db, { mode: 'real' }, { realTradingEnabled: true });
    const intentId = seed.intent.id;
    const inner = acceptingExecutor();
    const gated = realTradingGate(inner, { realTradingEnabled: false });
    expect(await processIntentJob(deps(gated), { intentId })).toBe('rejected');
    const row = await statusOf(intentId);
    expect(row).toMatchObject({
      status: 'rejected',
      lastError: 'real_trading_disabled',
      tokensReserved: 0n,
    });
    expect(row.submittedAt).toBeInstanceOf(Date);
    expect(await reservedOf(seed.userId)).toBe(0n);
    expect(await ledgerKinds(intentId)).toEqual(['reserve', 'release']);
    expect(inner.calls).toBe(0);
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

  it('treats an executor throw as unknown and logs only its name and code', async () => {
    const { intentId } = await newIntent();
    const lines: string[] = [];
    const capturing = pino({ level: 'error' }, { write: (line: string) => void lines.push(line) });
    const thrown = Object.assign(new Error('401 from https://broker/api?token=SECRET-TOKEN'), {
      code: 'EAUTH',
    });
    const executor = executorOf(() => Promise.reject(thrown));
    expect(await processIntentJob({ ...deps(executor), logger: capturing }, { intentId })).toBe(
      'unknown',
    );
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'executor_error',
    });
    const line = lines.find((l) => l.includes('trade executor threw'));
    expect(line).toBeDefined();
    expect(line).toContain('"code":"EAUTH"');
    expect(line).toContain('"name":"Error"');
    expect(line).not.toContain('SECRET-TOKEN');
    expect(line).not.toContain('stack');
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
    const executor = acceptingExecutor();
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
    const executor = acceptingExecutor();
    expect(await processIntentJob(deps(executor), { intentId })).toBe('accepted');
    expect(await processIntentJob(deps(executor), { intentId })).toBe('noop');
    expect(executor.calls).toBe(1);
  });

  it('marks a stale submitting intent unknown on redelivery and leaves a fresh one alone', async () => {
    const { intentId, version } = await newIntent();
    const taken = (await takeIntent(tmp.db, {
      id: intentId,
      expectedVersion: version,
      maxAgeMs: MAX_AGE_MS,
    }))!;
    const executor = acceptingExecutor();
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
        return { outcome: 'accepted', transport: 'socket', trade: openTradeFor(intent) };
      },
    };
    expect(await processIntentJob(deps(executor), { intentId })).toBe('noop');
    expect(await statusOf(intentId)).toMatchObject({
      status: 'unknown',
      lastError: 'stale_submitting',
    });
  });
});
