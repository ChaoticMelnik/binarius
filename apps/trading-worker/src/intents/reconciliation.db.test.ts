import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TradeIntentStatus } from '@binarius/shared';
import { closedTradeFor, openTradeFor, until } from '@binarius/shared/testing';
import {
  brokerTrades,
  claimReconciling,
  findTradeIntent,
  millisecondsAgo,
  startReconciling,
  tokenLedger,
  tradeIntents,
  users,
  type TradeIntentRow,
} from '@binarius/db';
import { createTempDatabase, seedUnknownIntent, type TempDatabase } from '@binarius/db/testing';
import { InvalidJobError } from './processor';
import type { IntentReconciler, ReconcileResult } from './reconciler';
import {
  createReconciliationPass,
  processReconciliationJob,
  type ReconciliationPassConfig,
} from './reconciliation';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());
// Every case shares this database and a tick lists every reconciling intent in it, so a case's
// leftovers are leased far into the future (a future claim is simply fresh, never a candidate).
afterEach(async () => {
  await tmp.db
    .update(tradeIntents)
    .set({ reconcileClaimedAt: sql`now() + interval '1 day'` })
    .where(eq(tradeIntents.status, TradeIntentStatus.Reconciling));
});

const RETRY_MS = 60_000;
const silent = pino({ level: 'silent' });

function capture(level: pino.Level = 'info') {
  const lines: string[] = [];
  const logger = pino({ level }, { write: (line: string) => void lines.push(line) });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed, line: (msg: string) => parsed().find((l) => l.msg === msg) };
}

async function reconcilingIntent() {
  const seed = await seedUnknownIntent(tmp.db);
  const intent = (await startReconciling(tmp.db, {
    id: seed.intent.id,
    expectedVersion: seed.intent.version,
  }))!;
  return { ...seed, intent };
}

type Answer = (
  intent: TradeIntentRow,
  signal: AbortSignal,
) => ReconcileResult | Promise<ReconcileResult>;

// answers only for the intents it was given; the call log is keyed by intent id
function reconcilerOf(answers: Record<string, Answer>): IntentReconciler & { calls: string[] } {
  const reconciler = {
    calls: [] as string[],
    reconcile: async (intent: TradeIntentRow, signal: AbortSignal) => {
      const answer = answers[intent.id];
      if (answer === undefined)
        return { outcome: 'unavailable', reason: 'not_configured' } as const;
      reconciler.calls.push(intent.id);
      return answer(intent, signal);
    },
  };
  return reconciler;
}

const passOf = (
  reconciler: IntentReconciler,
  logger: pino.Logger = silent,
  config: Partial<ReconciliationPassConfig> = {},
) =>
  createReconciliationPass({
    db: tmp.db,
    reconciler,
    logger,
    config: {
      tickMs: 60_000,
      retryMs: RETRY_MS,
      attemptTimeoutMs: 1_000,
      batchSize: 50,
      ...config,
    },
  });

async function tickOnce(reconciler: IntentReconciler, logger: pino.Logger = silent, config = {}) {
  const pass = passOf(reconciler, logger, config);
  await pass.tick();
  await pass.stop();
}

const rowOf = async (id: string) => (await findTradeIntent(tmp.db, id))!;
const tradesOf = (intentId: string) =>
  tmp.db.select().from(brokerTrades).where(eq(brokerTrades.intentId, intentId));
const ledgerKinds = async (intentId: string) =>
  (
    await tmp.db
      .select({ kind: tokenLedger.kind })
      .from(tokenLedger)
      .where(eq(tokenLedger.intentId, intentId))
      .orderBy(tokenLedger.createdAt)
  ).map(({ kind }) => kind);
const userTokens = async (userId: string) =>
  (
    await tmp.db
      .select({ balance: users.tokenBalance, reserved: users.tokenReserved })
      .from(users)
      .where(eq(users.id, userId))
  )[0]!;
const ageClaim = (id: string, ms: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ reconcileClaimedAt: millisecondsAgo(ms) })
    .where(eq(tradeIntents.id, id));

describe('processReconciliationJob', () => {
  const job = (payload: unknown, wake: () => void = () => undefined) =>
    processReconciliationJob({ db: tmp.db, logger: silent, wake }, payload);

  it('moves an unknown intent to reconciling and wakes the pass once', async () => {
    const { intent } = await seedUnknownIntent(tmp.db);
    let wakes = 0;
    expect(await job({ intentId: intent.id }, () => (wakes += 1))).toBe('reconciling');
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'reconciling',
      version: intent.version + 1,
      reconcileClaimedAt: null,
    });
    expect(wakes).toBe(1);
  });

  it('is a no-op for an intent already reconciling, and for a second delivery', async () => {
    const { intent } = await seedUnknownIntent(tmp.db);
    expect(await job({ intentId: intent.id })).toBe('reconciling');
    let wakes = 0;
    expect(await job({ intentId: intent.id }, () => (wakes += 1))).toBe('noop');
    expect(await job({ intentId: intent.id }, () => (wakes += 1))).toBe('noop');
    expect(wakes).toBe(0);
    expect((await rowOf(intent.id)).version).toBe(intent.version + 1);
  });

  it('refuses a malformed payload and a missing intent', async () => {
    await expect(job({ intentId: 'nope' })).rejects.toBeInstanceOf(InvalidJobError);
    await expect(job({ intentId: '00000000-0000-4000-8000-000000000000' })).rejects.toBeInstanceOf(
      InvalidJobError,
    );
  });
});

describe('the reconciliation pass: outcomes', () => {
  it('accepts with an open trade found, keeping the reserve', async () => {
    const { intent, userId } = await reconcilingIntent();
    const open = openTradeFor(intent);
    await tickOnce(reconcilerOf({ [intent.id]: () => ({ outcome: 'found', trade: open }) }));
    const row = await rowOf(intent.id);
    expect(row).toMatchObject({
      status: 'accepted',
      version: intent.version + 2,
      transport: null,
      tokensReserved: 1n,
    });
    expect(row.reconcileClaimedAt).not.toBeNull();
    expect(await tradesOf(intent.id)).toMatchObject([{ brokerTradeId: open.id, status: 'open' }]);
    expect((await userTokens(userId)).reserved).toBe(1n);
  });

  // the cache-equals-ledger case is token-balance-ops.db.test.ts (seeded users carry no ledger)
  it('settles a closed trade found and debits the token', async () => {
    const { intent, userId } = await reconcilingIntent();
    const before = await userTokens(userId);
    const closed = closedTradeFor(openTradeFor(intent));
    await tickOnce(reconcilerOf({ [intent.id]: () => ({ outcome: 'found', trade: closed }) }));
    expect(await rowOf(intent.id)).toMatchObject({ status: 'settled', tokensReserved: 0n });
    expect(await ledgerKinds(intent.id)).toEqual(['reserve', 'settle']);
    expect(await userTokens(userId)).toEqual({
      balance: before.balance - 1n,
      reserved: before.reserved - 1n,
    });
    expect(await tradesOf(intent.id)).toMatchObject([
      { brokerTradeId: closed.id, status: 'closed', profit: '-10.00000000' },
    ]);
  });

  it('rejects and releases the reserve on not_found', async () => {
    const { intent, userId } = await reconcilingIntent();
    await tickOnce(reconcilerOf({ [intent.id]: () => ({ outcome: 'not_found' }) }));
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'rejected',
      lastError: 'reconciliation_not_found',
      tokensReserved: 0n,
    });
    expect(await ledgerKinds(intent.id)).toEqual(['reserve', 'release']);
    expect((await userTokens(userId)).reserved).toBe(0n);
  });

  it('parks the intent for manual review on ambiguous, reserve kept', async () => {
    const { intent } = await reconcilingIntent();
    await tickOnce(reconcilerOf({ [intent.id]: () => ({ outcome: 'ambiguous' }) }));
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'manual_review',
      lastError: 'reconciliation_ambiguous',
      tokensReserved: 1n,
    });
    expect(await ledgerKinds(intent.id)).toEqual(['reserve']);
  });

  it('writes nothing on unavailable and retries only once the lease lapsed', async () => {
    const { intent } = await reconcilingIntent();
    const log = capture('warn');
    const reconciler = reconcilerOf({
      [intent.id]: () => ({ outcome: 'unavailable', reason: 'not_configured' }),
    });
    await tickOnce(reconciler, log.logger);
    const row = await rowOf(intent.id);
    expect(row).toMatchObject({ status: 'reconciling', tokensReserved: 1n });
    expect(row.reconcileClaimedAt).not.toBeNull();
    const warned = log.line('reconciliation unavailable');
    expect(warned).toMatchObject({ intentId: intent.id, reason: 'not_configured' });
    expect(Object.keys(warned!).sort()).toEqual(
      ['hostname', 'intentId', 'level', 'msg', 'pid', 'reason', 'time'].sort(),
    );
    await tickOnce(reconciler);
    expect(reconciler.calls).toEqual([intent.id]);
    await ageClaim(intent.id, RETRY_MS + 1_000);
    await tickOnce(reconciler);
    expect(reconciler.calls).toEqual([intent.id, intent.id]);
  });

  it('logs a throwing reconciler by name only and leaves the intent reconciling', async () => {
    const { intent } = await reconcilingIntent();
    const log = capture('error');
    await tickOnce(
      reconcilerOf({
        [intent.id]: () => {
          throw new Error('token: secret-abc');
        },
      }),
      log.logger,
    );
    expect((await rowOf(intent.id)).status).toBe('reconciling');
    expect(log.line('reconciler threw')).toMatchObject({
      intentId: intent.id,
      err: { name: 'Error' },
    });
    expect(log.lines.join('\n')).not.toContain('secret');
  });

  it('ends an attempt at its deadline and drops the late answer', async () => {
    const { intent } = await reconcilingIntent();
    let late = false;
    const reconciler = reconcilerOf({
      [intent.id]: async (row) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        late = true;
        return { outcome: 'found', trade: openTradeFor(row) };
      },
    });
    const log = capture('warn');
    await tickOnce(reconciler, log.logger, { attemptTimeoutMs: 100 });
    expect(log.line('reconciliation unavailable')).toMatchObject({
      intentId: intent.id,
      reason: 'timeout',
    });
    await until('the late answer', () => late);
    const row = await rowOf(intent.id);
    expect(row).toMatchObject({ status: 'reconciling', version: intent.version + 1 });
    expect(await tradesOf(intent.id)).toEqual([]);
  });

  it('parks a mismatching trade for manual review with trade_mismatch', async () => {
    const { intent } = await reconcilingIntent();
    const other = openTradeFor(intent, { assetId: 92 });
    const log = capture('warn');
    await tickOnce(
      reconcilerOf({ [intent.id]: () => ({ outcome: 'found', trade: other }) }),
      log.logger,
    );
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'manual_review',
      lastError: 'trade_mismatch',
      tokensReserved: 1n,
    });
    expect(await tradesOf(intent.id)).toEqual([]);
    expect(
      log.line('reconciled trade does not match the intent; parked for manual review'),
    ).toMatchObject({ intentId: intent.id, brokerTradeId: other.id, mismatch: 'asset' });
  });
});

describe('the reconciliation pass: the order and the lease', () => {
  it('attempts never-claimed first, then lapsed claims, and none again within the lease', async () => {
    const a = await reconcilingIntent();
    await claimReconciling(tmp.db, { id: a.intent.id, retryMs: RETRY_MS });
    await ageClaim(a.intent.id, 120_000);
    const b = await reconcilingIntent();
    const unavailable: Answer = () => ({ outcome: 'unavailable', reason: 'broker_unavailable' });
    const reconciler = reconcilerOf({ [a.intent.id]: unavailable, [b.intent.id]: unavailable });
    await tickOnce(reconciler);
    expect(reconciler.calls).toEqual([b.intent.id, a.intent.id]);
    await tickOnce(reconciler);
    expect(reconciler.calls).toEqual([b.intent.id, a.intent.id]);
  });

  it('skips an intent another replica claimed first', async () => {
    const { intent } = await reconcilingIntent();
    const reconciler = reconcilerOf({ [intent.id]: () => ({ outcome: 'not_found' }) });
    const pass = passOf(reconciler);
    await claimReconciling(tmp.db, { id: intent.id, retryMs: RETRY_MS });
    await pass.tick();
    await pass.stop();
    expect(reconciler.calls).toEqual([]);
    expect((await rowOf(intent.id)).status).toBe('reconciling');
  });

  it('drops the outcome of an attempt whose lease was re-claimed meanwhile', async () => {
    const { intent } = await reconcilingIntent();
    const log = capture('info');
    await tickOnce(
      reconcilerOf({
        [intent.id]: async (row) => {
          await ageClaim(row.id, RETRY_MS + 1_000);
          await claimReconciling(tmp.db, { id: row.id, retryMs: RETRY_MS });
          return { outcome: 'found', trade: openTradeFor(row) };
        },
      }),
      log.logger,
    );
    expect(log.line('reconciliation outcome dropped')).toMatchObject({
      intentId: intent.id,
      outcome: 'found',
    });
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'reconciling',
      version: intent.version + 2,
    });
    expect(await tradesOf(intent.id)).toEqual([]);
  });

  it('ends the tick on rate_limited', async () => {
    const a = await reconcilingIntent();
    const b = await reconcilingIntent();
    const reconciler = reconcilerOf({
      [a.intent.id]: () => ({ outcome: 'unavailable', reason: 'rate_limited' }),
      [b.intent.id]: () => ({ outcome: 'not_found' }),
    });
    await tickOnce(reconciler);
    expect(reconciler.calls).toEqual([a.intent.id]);
    expect(await rowOf(b.intent.id)).toMatchObject({
      status: 'reconciling',
      reconcileClaimedAt: null,
    });
  });

  it('logs one summary line per tick with the count of every ending', async () => {
    const found = await reconcilingIntent();
    const missing = await reconcilingIntent();
    const ambiguous = await reconcilingIntent();
    const unavailable = await reconcilingIntent();
    const log = capture('info');
    await tickOnce(
      reconcilerOf({
        [found.intent.id]: (row) => ({ outcome: 'found', trade: openTradeFor(row) }),
        [missing.intent.id]: () => ({ outcome: 'not_found' }),
        [ambiguous.intent.id]: () => ({ outcome: 'ambiguous' }),
        [unavailable.intent.id]: () => ({ outcome: 'unavailable', reason: 'token_unavailable' }),
      }),
      log.logger,
    );
    expect(log.parsed().filter((l) => l.msg === 'reconciliation tick')).toEqual([
      expect.objectContaining({
        candidates: 4,
        accepted: 1,
        settled: 0,
        rejected: 1,
        manualReview: 1,
        unavailable: 1,
        skipped: 0,
        dropped: 0,
        failed: 0,
      }),
    ]);
  });
});

describe('the reconciliation pass: start and stop', () => {
  it('runs its first tick at start, not after the interval', async () => {
    const { intent } = await reconcilingIntent();
    const reconciler = reconcilerOf({ [intent.id]: () => ({ outcome: 'ambiguous' }) });
    const pass = passOf(reconciler, silent, { tickMs: 60_000 });
    pass.start();
    try {
      await until('the first tick', () => reconciler.calls.length === 1);
    } finally {
      await pass.stop();
    }
    expect((await rowOf(intent.id)).status).toBe('manual_review');
  });

  it('waits for the attempt in flight on stop and takes no further candidate', async () => {
    const a = await reconcilingIntent();
    const b = await reconcilingIntent();
    let finished = false;
    const reconciler = reconcilerOf({
      [a.intent.id]: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        finished = true;
        return { outcome: 'ambiguous' };
      },
      [b.intent.id]: () => ({ outcome: 'ambiguous' }),
    });
    const pass = passOf(reconciler);
    void pass.tick();
    await until('the first attempt', () => reconciler.calls.length === 1);
    await pass.stop();
    expect(finished).toBe(true);
    expect((await rowOf(a.intent.id)).status).toBe('manual_review');
    expect(reconciler.calls).toEqual([a.intent.id]);
    expect(await rowOf(b.intent.id)).toMatchObject({
      status: 'reconciling',
      reconcileClaimedAt: null,
    });
  });
});
