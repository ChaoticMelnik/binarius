import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { AccountHaltReason, TradeIntentStatus, type DecimalString } from '@binarius/shared';
import { closedTradeFor, openTradeFor, until } from '@binarius/shared/testing';
import {
  brokerAccounts,
  brokerTrades,
  claimReconciling,
  createTradeIntent,
  findTradeIntent,
  listLinkedBrokerTradeIds,
  millisecondsAgo,
  startReconciling,
  TradeIntentError,
  tokenLedger,
  tradeIntents,
  users,
  type TradeIntentRow,
} from '@binarius/db';
import {
  createTempDatabase,
  intentRequest,
  seedUnknownIntent,
  type TempDatabase,
} from '@binarius/db/testing';
import type { BalanceCheck, BalanceCheckEnding } from './balance-check';
import { InvalidJobError } from './processor';
import type { IntentReconciler, ReconcileResult } from './reconciler';
import { createRestReconciler } from './rest-reconciler';
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
  checkCalls.length = 0;
  checkAnswer = () => Promise.resolve('compared');
});

// the balance check after an outcome (#92): every call recorded by account; a case swaps the answer
const checkCalls: string[] = [];
let checkAnswer: (signal: AbortSignal) => Promise<BalanceCheckEnding> = () =>
  Promise.resolve('compared');
const balanceCheck: BalanceCheck = {
  check: (brokerAccountId, signal) => {
    checkCalls.push(brokerAccountId);
    return checkAnswer(signal);
  },
};

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
    balanceCheck,
    logger,
    config: {
      tickMs: 60_000,
      retryMs: RETRY_MS,
      attemptTimeoutMs: 1_000,
      batchSize: 50,
      balanceCheckTimeoutMs: 1_000,
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
const accountOf = async (id: string) =>
  (
    await tmp.db
      .select({ halted: brokerAccounts.tradingHalted, reason: brokerAccounts.haltedReason })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, id))
  )[0]!;
const ALERT = 'account halted for manual review';
const ageClaim = (id: string, ms: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ reconcileClaimedAt: millisecondsAgo(ms) })
    .where(eq(tradeIntents.id, id));

describe('processReconciliationJob', () => {
  const job = (payload: unknown) =>
    processReconciliationJob({ db: tmp.db, logger: silent }, payload);

  it('moves an unknown intent to reconciling for the next tick of the pass', async () => {
    const { intent } = await seedUnknownIntent(tmp.db);
    expect(await job({ intentId: intent.id })).toBe('reconciling');
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'reconciling',
      version: intent.version + 1,
      reconcileClaimedAt: null,
    });
  });

  it('is a no-op for an intent already reconciling, and for a second delivery', async () => {
    const { intent } = await seedUnknownIntent(tmp.db);
    expect(await job({ intentId: intent.id })).toBe('reconciling');
    expect(await job({ intentId: intent.id })).toBe('noop');
    expect(await job({ intentId: intent.id })).toBe('noop');
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

  it('parks the intent on ambiguous, halts the account and alerts once (#90)', async () => {
    const { intent, brokerAccountId, telegramUserId } = await reconcilingIntent();
    const log = capture('info');
    await tickOnce(reconcilerOf({ [intent.id]: () => ({ outcome: 'ambiguous' }) }), log.logger);
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'manual_review',
      lastError: 'reconciliation_ambiguous',
      tokensReserved: 1n,
    });
    expect(await ledgerKinds(intent.id)).toEqual(['reserve']);
    expect(await accountOf(brokerAccountId)).toEqual({
      halted: true,
      reason: AccountHaltReason.ReconciliationAmbiguous,
    });
    const alerts = log.parsed().filter((line) => line.msg === ALERT);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: 50,
      intentId: intent.id,
      brokerAccountId,
      reason: 'reconciliation_ambiguous',
    });
    expect(Object.keys(alerts[0]!).sort()).toEqual(
      ['brokerAccountId', 'hostname', 'intentId', 'level', 'msg', 'pid', 'reason', 'time'].sort(),
    );
    // the halt stops new intents for the account
    const refused = await createTradeIntent(tmp.db, intentRequest(telegramUserId)).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(TradeIntentError);
    expect((refused as TradeIntentError).code).toBe('account_halted');
  });

  it('parks the intent on unresolved, halts the account with reconciliation_not_found and keeps the reserve', async () => {
    const { intent, brokerAccountId, userId } = await reconcilingIntent();
    const log = capture('info');
    await tickOnce(reconcilerOf({ [intent.id]: () => ({ outcome: 'unresolved' }) }), log.logger);
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'manual_review',
      lastError: 'reconciliation_not_found',
      tokensReserved: 1n,
    });
    expect(await ledgerKinds(intent.id)).toEqual(['reserve']);
    expect((await userTokens(userId)).reserved).toBe(1n);
    expect(await accountOf(brokerAccountId)).toEqual({
      halted: true,
      reason: AccountHaltReason.ReconciliationNotFound,
    });
    expect(log.line(ALERT)).toMatchObject({
      intentId: intent.id,
      brokerAccountId,
      reason: 'reconciliation_not_found',
    });
  });

  it('neither halts nor alerts when the manual_review CAS is lost (#90)', async () => {
    const { intent, brokerAccountId } = await reconcilingIntent();
    const log = capture('info');
    await tickOnce(
      reconcilerOf({
        [intent.id]: async (row) => {
          await ageClaim(row.id, RETRY_MS + 1_000);
          await claimReconciling(tmp.db, { id: row.id, retryMs: RETRY_MS });
          return { outcome: 'ambiguous' };
        },
      }),
      log.logger,
    );
    expect((await rowOf(intent.id)).status).toBe('reconciling');
    expect(await accountOf(brokerAccountId)).toEqual({ halted: false, reason: null });
    expect(log.line(ALERT)).toBeUndefined();
    expect(log.line('reconciliation outcome dropped')).toMatchObject({ outcome: 'ambiguous' });
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
    expect(await accountOf(intent.brokerAccountId)).toEqual({
      halted: true,
      reason: AccountHaltReason.TradeMismatch,
    });
    expect(log.line(ALERT)).toMatchObject({
      intentId: intent.id,
      brokerAccountId: intent.brokerAccountId,
      reason: 'trade_mismatch',
    });
    expect(
      log.line('reconciled trade does not match the intent; parked for manual review'),
    ).toMatchObject({ intentId: intent.id, brokerTradeId: other.id, mismatch: 'asset' });
  });
});

// The real reconciler against the mock broker's REST API: the stub token source stands in for
// the backend's route (its own suite is broker/access-token.test.ts).
describe('the reconciliation pass with the REST reconciler (#90)', () => {
  const TOKEN = 'e2e-access-token';
  let broker: MockBroker;
  let brokerUserId = 9_000;
  beforeAll(async () => {
    broker = await startMockBroker();
  });
  afterAll(() => broker.close());

  const restReconciler = () =>
    createRestReconciler({
      rest: createBrokerRestClient({ baseUrl: broker.url }),
      tokens: { accessToken: () => Promise.resolve({ ok: true, accessToken: token }) },
      linkedTradeIds: (accountId, ids) =>
        listLinkedBrokerTradeIds(tmp.db, { brokerAccountId: accountId, brokerTradeIds: ids }),
      logger: silent,
      config: { windowBeforeMs: 60_000, windowAfterMs: 90_000, pageSize: 50, maxPages: 2 },
    });
  let token = TOKEN;

  // each case trades as its own broker user, so the lists hold only that case's trades
  async function intentWithBroker() {
    token = `${TOKEN}-${++brokerUserId}`;
    broker.users.register({ id: brokerUserId, accessToken: token });
    const seed = await reconcilingIntent101();
    return seed;
  }

  async function reconcilingIntent101() {
    const seed = await seedUnknownIntent(tmp.db, { assetId: 101 });
    const intent = (await startReconciling(tmp.db, {
      id: seed.intent.id,
      expectedVersion: seed.intent.version,
    }))!;
    return { ...seed, intent };
  }

  const openAtBroker = (intent: TradeIntentRow) =>
    createBrokerRestClient({ baseUrl: broker.url }).openTrade(
      { accessToken: token },
      {
        assetId: intent.assetId,
        // the mock broker takes at most two decimals; the stored numeric(20,8) spelling has eight
        amount: '10.00' as DecimalString,
        action: intent.action,
        durationSec: intent.durationSec,
        isDemo: true,
      },
    );

  it('accepts the open trade it finds and links it', async () => {
    const { intent } = await intentWithBroker();
    const trade = await openAtBroker(intent);
    await tickOnce(restReconciler());
    expect(await rowOf(intent.id)).toMatchObject({ status: 'accepted', tokensReserved: 1n });
    expect(await tradesOf(intent.id)).toMatchObject([{ brokerTradeId: trade.id, status: 'open' }]);
  });

  it('settles the closed trade it finds', async () => {
    const { intent } = await intentWithBroker();
    const trade = await openAtBroker(intent);
    broker.trades.settle(Number(trade.id), { outcome: 'loss' });
    await tickOnce(restReconciler());
    expect(await rowOf(intent.id)).toMatchObject({ status: 'settled', tokensReserved: 0n });
    expect(await tradesOf(intent.id)).toMatchObject([
      { brokerTradeId: trade.id, status: 'closed' },
    ]);
  });

  it('parks for manual review with reconciliation_not_found and halts the account once the window has closed without a trade', async () => {
    const { intent, brokerAccountId } = await intentWithBroker();
    await tmp.db
      .update(tradeIntents)
      .set({ submittedAt: millisecondsAgo(200_000) })
      .where(eq(tradeIntents.id, intent.id));
    const log = capture('info');
    await tickOnce(restReconciler(), log.logger);
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'manual_review',
      lastError: 'reconciliation_not_found',
      tokensReserved: 1n,
    });
    expect(await accountOf(brokerAccountId)).toEqual({
      halted: true,
      reason: AccountHaltReason.ReconciliationNotFound,
    });
    expect(log.line(ALERT)).toMatchObject({ intentId: intent.id, reason: 'reconciliation_not_found' });
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
        balanceCompared: 3,
        balanceMismatch: 0,
      }),
    ]);
  });
});

describe('the reconciliation pass: the balance check (#92)', () => {
  it('R1 runs once after accepted, settled, manual_review and rejected, for the intent account', async () => {
    const accepted = await reconcilingIntent();
    const settled = await reconcilingIntent();
    const parked = await reconcilingIntent();
    const missing = await reconcilingIntent();
    await tickOnce(
      reconcilerOf({
        [accepted.intent.id]: (row) => ({ outcome: 'found', trade: openTradeFor(row) }),
        [settled.intent.id]: (row) => ({
          outcome: 'found',
          trade: closedTradeFor(openTradeFor(row)),
        }),
        [parked.intent.id]: () => ({ outcome: 'ambiguous' }),
        [missing.intent.id]: () => ({ outcome: 'not_found' }),
      }),
    );
    expect([...checkCalls].sort()).toEqual(
      [
        accepted.brokerAccountId,
        settled.brokerAccountId,
        parked.brokerAccountId,
        missing.brokerAccountId,
      ].sort(),
    );
  });

  it('R2 does not run after unavailable or a throwing reconciler', async () => {
    const unavailable = await reconcilingIntent();
    const throwing = await reconcilingIntent();
    await tickOnce(
      reconcilerOf({
        [unavailable.intent.id]: () => ({ outcome: 'unavailable', reason: 'token_unavailable' }),
        [throwing.intent.id]: () => {
          throw new Error('reconciler bug');
        },
      }),
    );
    expect(checkCalls).toEqual([]);
  });

  it('R3 logs a throwing check and leaves the outcome as recorded', async () => {
    const { intent, brokerAccountId } = await reconcilingIntent();
    checkAnswer = () => Promise.reject(new TypeError('check bug'));
    const log = capture('info');
    await tickOnce(reconcilerOf({ [intent.id]: () => ({ outcome: 'ambiguous' }) }), log.logger);
    expect((await rowOf(intent.id)).status).toBe('manual_review');
    expect(log.line('balance check threw')).toMatchObject({
      brokerAccountId,
      err: { name: 'TypeError' },
    });
    expect(log.line('reconciliation tick')).toMatchObject({ manualReview: 1, failed: 0 });
  });

  it('R4 cuts a check at its deadline, aborting its signal, and the tick goes on', async () => {
    const a = await reconcilingIntent();
    const b = await reconcilingIntent();
    let aborted = false;
    checkAnswer = (signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      });
    const log = capture('info');
    const reconciler = reconcilerOf({
      [a.intent.id]: () => ({ outcome: 'ambiguous' }),
      [b.intent.id]: () => ({ outcome: 'ambiguous' }),
    });
    const pass = passOf(reconciler, log.logger, { balanceCheckTimeoutMs: 50 });
    await pass.tick();
    // the deadline aborted it, not stop()
    expect(aborted).toBe(true);
    await pass.stop();
    expect(reconciler.calls).toHaveLength(2);
    expect(log.parsed().filter((l) => l.msg === 'balance check timed out')).toHaveLength(2);
  });

  it('R5 ends the tick when the check is rate limited', async () => {
    const a = await reconcilingIntent();
    const b = await reconcilingIntent();
    checkAnswer = () => Promise.resolve('rate_limited');
    const reconciler = reconcilerOf({
      [a.intent.id]: () => ({ outcome: 'ambiguous' }),
      [b.intent.id]: () => ({ outcome: 'ambiguous' }),
    });
    await tickOnce(reconciler);
    expect(reconciler.calls).toHaveLength(1);
  });

  it('R6 starts no check once stop() was called', async () => {
    const { intent } = await reconcilingIntent();
    const reconciler = reconcilerOf({
      [intent.id]: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { outcome: 'ambiguous' };
      },
    });
    const pass = passOf(reconciler);
    void pass.tick();
    await until('the attempt', () => reconciler.calls.length === 1);
    await pass.stop();
    expect((await rowOf(intent.id)).status).toBe('manual_review');
    expect(checkCalls).toEqual([]);
  });

  it('counts the compared checks and the mismatches in the summary', async () => {
    const a = await reconcilingIntent();
    const b = await reconcilingIntent();
    const answers: BalanceCheckEnding[] = ['mismatch', 'not_compared'];
    checkAnswer = () => Promise.resolve(answers.shift()!);
    const log = capture('info');
    await tickOnce(
      reconcilerOf({
        [a.intent.id]: () => ({ outcome: 'ambiguous' }),
        [b.intent.id]: () => ({ outcome: 'ambiguous' }),
      }),
      log.logger,
    );
    expect(log.line('reconciliation tick')).toMatchObject({
      balanceCompared: 1,
      balanceMismatch: 1,
    });
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
