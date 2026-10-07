import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { MockSocketPayload, startMockBroker } from '@binarius/mock-broker';
import { TradeIntentFailureReason, type OpenTrade } from '@binarius/shared';
import { INTEGRATION_WAIT_CEILING_MS, openTradeFor } from '@binarius/shared/testing';
import {
  brokerTrades,
  findTradeIntent,
  markIntentUnknown,
  openTrading,
  outboxEvents,
  takeIntent,
  tokenLedger,
  tradeIntents,
  users,
  type TradeIntentRow,
} from '@binarius/db';
import {
  closeTradingSwitch,
  createTempDatabase,
  seedQueuedIntent,
  type TempDatabase,
} from '@binarius/db/testing';
import { noTradeSessions } from '../broker/trade-session';
import type { SubmitResult, TradeExecutor } from './executor';
import { InvalidJobError, processIntentJob, type ProcessorDeps } from './processor';
import { createTradeCommandExecutor } from './trade-command-executor';

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

// a refusal before anything reaches a broker; rows may hold the code
const rejectingExecutor = () =>
  executorOf({ outcome: 'rejected', reason: TradeIntentFailureReason.ExecutorNotConfigured });

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

describe('processIntentJob: the global trading switch (#144)', () => {
  afterEach(() => openTrading(tmp.db));

  const capture = () => {
    const lines: string[] = [];
    const sink = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    return {
      sink,
      entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  };

  it('W1 rejects a queued intent while closed, releases the token, never calls the executor', async () => {
    const { intentId, userId } = await newIntent();
    await closeTradingSwitch(tmp.db);
    const executor = acceptingExecutor();
    const log = capture();
    expect(await processIntentJob({ ...deps(executor), logger: log.sink }, { intentId })).toBe(
      'rejected',
    );
    expect(executor.calls).toBe(0);
    const row = await statusOf(intentId);
    expect(row).toMatchObject({
      status: 'rejected',
      lastError: 'trading_paused',
      tokensReserved: 0n,
    });
    expect(row.submittedAt).toBeNull();
    expect(await reservedOf(userId)).toBe(0n);
    expect(await ledgerKinds(intentId)).toEqual(['reserve', 'release']);
    expect(log.entries()).toContainEqual(
      expect.objectContaining({ level: 40, intentId, msg: 'intent rejected: trading paused' }),
    );
  });

  it('W2 an expired intent while closed keeps its own reason', async () => {
    const { intentId } = await newIntent();
    await tmp.db
      .update(tradeIntents)
      .set({ createdAt: sql`now() - interval '2 minutes'` })
      .where(eq(tradeIntents.id, intentId));
    await closeTradingSwitch(tmp.db);
    expect(await processIntentJob(deps(acceptingExecutor()), { intentId })).toBe('expired');
    expect((await statusOf(intentId)).lastError).toBe('expired');
  });

  it('W3 submits as usual while open', async () => {
    const { intentId } = await newIntent();
    expect(await processIntentJob(deps(acceptingExecutor()), { intentId })).toBe('accepted');
  });

  // The take refused while closed, then the switch reopened before the rejection: the intent is
  // still rejected, never left queued with its job consumed. The db wrapper reopens the switch
  // on the first transaction the processor opens after the refused take.
  it('W5 a switch reopened between the refused take and the rejection still rejects', async () => {
    const { intentId } = await newIntent();
    await closeTradingSwitch(tmp.db);
    let reopened = false;
    const db = new Proxy(tmp.db, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property === 'transaction') {
          return async (...args: Parameters<typeof target.transaction>) => {
            if (!reopened) {
              reopened = true;
              await openTrading(target);
            }
            return target.transaction(...args);
          };
        }
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const executor = acceptingExecutor();
    expect(await processIntentJob({ ...deps(executor), db }, { intentId })).toBe('rejected');
    expect(reopened).toBe(true);
    expect(executor.calls).toBe(0);
    expect(await statusOf(intentId)).toMatchObject({
      status: 'rejected',
      lastError: 'trading_paused',
    });
  });

  // the window (docs/kill-switch.md): an intent taken before the switch closed is finished
  it('W4 closed after the take: the outcome is persisted as usual', async () => {
    const { intentId } = await newIntent();
    const executor = executorOf(async (intent) => {
      await closeTradingSwitch(tmp.db);
      return { outcome: 'accepted', transport: 'socket', trade: openTradeFor(intent) };
    });
    expect(await processIntentJob(deps(executor), { intentId })).toBe('accepted');
    expect((await statusOf(intentId)).status).toBe('accepted');
  });
});

describe('processIntentJob', () => {
  it('rejects a malformed payload and a missing intent as invalid jobs', async () => {
    await expect(
      processIntentJob(deps(rejectingExecutor()), { intentId: 'nope' }),
    ).rejects.toBeInstanceOf(InvalidJobError);
    await expect(processIntentJob(deps(rejectingExecutor()), null)).rejects.toBeInstanceOf(
      InvalidJobError,
    );
    await expect(
      processIntentJob(deps(rejectingExecutor()), {
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

  it('opens the trade over REST through the production composition', async () => {
    const broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
    try {
      broker.users.register({ id: 1, accessToken: 'SECRET-TOKEN-of-user-1' });
      // 101 is a pair of the fixture; the seed's default asset is not
      const seed = await seedQueuedIntent(tmp.db, { assetId: 101 });
      const executor = createTradeCommandExecutor({
        sessions: noTradeSessions,
        rest: createBrokerRestClient({ baseUrl: broker.url }),
        tokens: {
          accessToken: async () => ({ ok: true, accessToken: 'SECRET-TOKEN-of-user-1' }),
        },
        logger,
      });
      expect(
        await processIntentJob(deps(executor, { submitAckTimeoutMs: 5_000 }), {
          intentId: seed.intent.id,
        }),
      ).toBe('accepted');
      expect(await statusOf(seed.intent.id)).toMatchObject({
        status: 'accepted',
        transport: 'rest_fallback',
      });
      const [opened] = broker.trades.list(1);
      // '10' went out and came back; the row matched it to '10.00000000' by value
      expect(await tradesOf(seed.intent.id)).toMatchObject([
        { brokerTradeId: String(opened?.id), amount: '10.00000000', assetId: 101 },
      ]);
    } finally {
      await broker.close();
    }
  });

  // #313: the demo's 5 and 15 s trades on 202, the mock pair whose min_timeframe is 5
  it.each([5, 15])(
    'opens a %i s trade over REST on a pair that accepts it',
    async (durationSec) => {
      const broker = await startMockBroker({ socketPayload: MockSocketPayload.Bytes });
      try {
        broker.users.register({ id: 1, accessToken: 'SECRET-TOKEN-of-user-1' });
        const seed = await seedQueuedIntent(tmp.db, { assetId: 202, durationSec });
        const executor = createTradeCommandExecutor({
          sessions: noTradeSessions,
          rest: createBrokerRestClient({ baseUrl: broker.url }),
          tokens: {
            accessToken: async () => ({ ok: true, accessToken: 'SECRET-TOKEN-of-user-1' }),
          },
          logger,
        });
        expect(
          await processIntentJob(deps(executor, { submitAckTimeoutMs: 5_000 }), {
            intentId: seed.intent.id,
          }),
        ).toBe('accepted');
        const [opened] = broker.trades.list(1);
        expect(opened && opened.close_timestamp - opened.open_timestamp).toBe(durationSec * 1000);
        expect(await tradesOf(seed.intent.id)).toMatchObject([{ assetId: 202 }]);
      } finally {
        await broker.close();
      }
    },
  );

  it('records a rejection and releases the token', async () => {
    const { intentId, userId } = await newIntent();
    expect(await processIntentJob(deps(rejectingExecutor()), { intentId })).toBe('rejected');
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
    expect(Date.now() - started).toBeLessThan(INTEGRATION_WAIT_CEILING_MS);
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
    expect(Date.now() - started).toBeLessThan(INTEGRATION_WAIT_CEILING_MS);
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
