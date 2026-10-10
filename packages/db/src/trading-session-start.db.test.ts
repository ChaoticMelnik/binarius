import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountHaltReason,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  decimalStringSchema,
  safeParseSessionSummaryResponse,
  safeParseTradingSessionResponse,
  type BrokerUser,
  type DecimalString,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import { applyBalanceEvent, upsertBalanceSnapshot } from './balance-snapshot-ops';
import { brokerBalanceSnapshots, tradingSessions, users } from './schema/index';
import {
  createTempDatabase,
  intentRequest,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  seedUserWithAccount,
  sessionSettings,
  type TempDatabase,
} from './testing';
import {
  createTradeIntent,
  markIntentAccepted,
  markIntentManualReview,
  markIntentUnknown,
  rejectIntent,
  settleIntent,
  startReconciling,
  takeIntent,
  type TradeIntentRow,
} from './trade-intent-ops';
import { openTrading, stopTrading } from './trading-switch-ops';
import {
  checkTradingSessionStart,
  claimSessionSummary,
  createSessionIntent,
  readActiveTradingSessionView,
  readTradingSessionAccount,
  readTradingSessionView,
  stopTradingSession,
} from './trading-session-ops';

// The start route's pre-check and the owner-scoped view (#283), on a temporary migrated database.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

async function accept(intent: TradeIntentRow, openPrice?: number) {
  const taken = (await takeIntent(tmp.db, {
    id: intent.id,
    expectedVersion: intent.version,
    maxAgeMs: 60_000,
  }))!;
  const open = openTradeFor(intent, openPrice === undefined ? {} : { openPrice });
  await tmp.db.transaction((tx) =>
    markIntentAccepted(tx, {
      id: taken.id,
      expectedVersion: taken.version,
      transport: 'rest_fallback',
      trade: open,
    }),
  );
  return open;
}

async function settle(
  intent: TradeIntentRow,
  profit: string,
  prices?: { open: number; close: number },
): Promise<void> {
  if (prices !== undefined) {
    const open = await accept(intent, prices.open);
    await tmp.db.transaction((tx) =>
      settleIntent(tx, {
        id: intent.id,
        from: TradeIntentStatus.Accepted,
        trade: closedTradeFor(open, {
          profit: profit as DecimalString,
          closePrice: prices.close,
        }),
      }),
    );
    return;
  }
  const taken = (await takeIntent(tmp.db, {
    id: intent.id,
    expectedVersion: intent.version,
    maxAgeMs: 60_000,
  }))!;
  const open = openTradeFor(intent);
  await tmp.db.transaction((tx) =>
    markIntentAccepted(tx, {
      id: taken.id,
      expectedVersion: taken.version,
      transport: 'rest_fallback',
      trade: open,
    }),
  );
  await tmp.db.transaction((tx) =>
    settleIntent(tx, {
      id: intent.id,
      from: TradeIntentStatus.Accepted,
      trade: closedTradeFor(open, { profit: profit as DecimalString }),
    }),
  );
}

async function reject(intent: TradeIntentRow): Promise<void> {
  await tmp.db.transaction((tx) =>
    rejectIntent(tx, {
      id: intent.id,
      from: TradeIntentStatus.Queued,
      expectedVersion: intent.version,
      reason: TradeIntentFailureReason.BrokerRejected,
    }),
  );
}

const check = (telegramUserId: string, brokerAccountId?: string) =>
  checkTradingSessionStart(tmp.db, {
    telegramUserId,
    ...(brokerAccountId === undefined ? {} : { brokerAccountId }),
  });

describe('checkTradingSessionStart', () => {
  it('passes an eligible account and returns its token expiry', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const result = await check(seed.telegramUserId);
    expect(result).toMatchObject({ ok: true, brokerAccountId: seed.brokerAccountId });
    expect(result.ok && result.accessTokenExpiresAt).toBeInstanceOf(Date);
  });

  it('E0 a closed trading switch refuses first, before the user and the account', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    await stopTrading(tmp.db, { source: 'operator', reason: 'test' });
    try {
      expect(await check(seed.telegramUserId)).toEqual({
        ok: false,
        code: TradingSessionErrorCode.TradingPaused,
      });
      expect(await check('999999999')).toEqual({
        ok: false,
        code: TradingSessionErrorCode.TradingPaused,
      });
    } finally {
      await openTrading(tmp.db);
    }
    expect((await check(seed.telegramUserId)).ok).toBe(true);
  });

  it('E1 an unknown user', async () => {
    expect(await check('999999999')).toEqual({
      ok: false,
      code: TradingSessionErrorCode.UserNotFound,
    });
  });

  it("E2 another user's account, two active accounts, only a pending one", async () => {
    const owner = await seedUserWithAccount(tmp.db);
    const other = await seedUserWithAccount(tmp.db);
    expect(await check(owner.telegramUserId, other.brokerAccountId)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.BrokerAccountNotFound,
    });

    const two = await seedUserWithAccount(tmp.db);
    await seedBrokerAccount(tmp.db, two.userId);
    expect(await check(two.telegramUserId)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.AmbiguousBrokerAccount,
    });

    const pendingOnly = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, pendingOnly.userId, { status: 'pending' });
    expect(await check(pendingOnly.telegramUserId)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.AccountNotConfirmed,
    });
  });

  it('E3 an explicit pending account and an explicit revoked one', async () => {
    const user = await seedUser(tmp.db);
    const pending = await seedBrokerAccount(tmp.db, user.userId, { status: 'pending' });
    const revoked = await seedBrokerAccount(tmp.db, user.userId, { status: 'revoked' });
    expect(await check(user.telegramUserId, pending)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.AccountNotConfirmed,
    });
    expect(await check(user.telegramUserId, revoked)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.AccountRevoked,
    });
  });

  it('E4 a halted account', async () => {
    const user = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, user.userId, {
      tradingHalted: true,
      haltedReason: AccountHaltReason.TradeMismatch,
    });
    expect(await check(user.telegramUserId)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.AccountHalted,
    });
  });

  it('E5 a blocked user', async () => {
    const seed = await seedUserWithAccount(tmp.db, { status: 'blocked' });
    expect(await check(seed.telegramUserId)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.UserBlocked,
    });
  });

  it('E6 an active session refuses with its id; a stopped one does not', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const stopped = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await stopTradingSession(tmp.db, {
      id: stopped.id,
      reason: TradingSessionStopReason.Completed,
    });
    expect((await check(seed.telegramUserId)).ok).toBe(true);
    const active = await seedTradingSession(tmp.db, seed.brokerAccountId);
    expect(await check(seed.telegramUserId)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.ActiveSessionExists,
      activeSessionId: active.id,
    });
  });

  it('E7 no available token', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 1n });
    await tmp.db.update(users).set({ tokenReserved: 1n }).where(eq(users.id, seed.userId));
    expect(await check(seed.telegramUserId)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.InsufficientTokens,
    });
  });

  it('E8 the account refusal wins over the token one', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    await seedBrokerAccount(tmp.db, user.userId, {
      tradingHalted: true,
      haltedReason: AccountHaltReason.TradeMismatch,
    });
    expect(await check(user.telegramUserId)).toEqual({
      ok: false,
      code: TradingSessionErrorCode.AccountHalted,
    });
  });
});

const sessionIntent = (
  seed: { telegramUserId: string; brokerAccountId: string },
  sessionId: string,
  step: number,
  mode: TradeMode = TradeMode.Demo,
  { amount = '1', action = TradeAction.Up }: { amount?: string; action?: TradeAction } = {},
) =>
  createSessionIntent(tmp.db, {
    sessionId,
    step,
    telegramUserId: seed.telegramUserId,
    brokerAccountId: seed.brokerAccountId,
    mode,
    assetId: 101,
    amount: decimalStringSchema.parse(amount),
    action,
    durationSec: 60,
  });

describe('readTradingSessionView', () => {
  it("V1 counts the session's own intents by status and profit sign; lastIntent is the newest", async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settle((await sessionIntent(seed, session.id, 1)).intent, '0.85');
    await settle((await sessionIntent(seed, session.id, 2)).intent, '-1');
    await settle((await sessionIntent(seed, session.id, 3)).intent, '0');
    await reject((await sessionIntent(seed, session.id, 4)).intent);
    // the bot's own trade on the same account: neither a step nor a win of the session
    const { intent: botIntent } = await createTradeIntent(
      tmp.db,
      intentRequest(seed.telegramUserId),
    );
    await settle(botIntent, '0.85');
    const { intent: queued } = await sessionIntent(seed, session.id, 5);

    const view = await readTradingSessionView(tmp.db, session.id, seed.telegramUserId);
    expect(safeParseTradingSessionResponse({ session: view }).success).toBe(true);
    expect(view!.trades).toEqual({
      planned: 5,
      settled: 3,
      rejected: 1,
      won: 1,
      lost: 1,
      tied: 1,
      profit: '-0.15000000',
    });
    expect(view!.lastIntent).toMatchObject({ id: queued.id, status: 'queued' });
    expect(view).toMatchObject({
      id: session.id,
      mode: 'demo',
      status: TradingSessionStatus.Active,
      stopReason: null,
      endedAt: null,
      settings: sessionSettings(),
    });
  });

  it("V2 another user's telegram id reads nothing", async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const other = await seedUser(tmp.db);
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    expect(await readTradingSessionView(tmp.db, session.id, other.telegramUserId)).toBeUndefined();
    expect(await readTradingSessionView(tmp.db, session.id, seed.telegramUserId)).toBeDefined();
  });

  it('V3 a missing id reads nothing', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    expect(
      await readTradingSessionView(
        tmp.db,
        '00000000-0000-4000-8000-000000000000',
        seed.telegramUserId,
      ),
    ).toBeUndefined();
  });

  it('V4 settings that fail v1 read as null with zero planned', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, { settings: {} });
    const view = await readTradingSessionView(tmp.db, session.id, seed.telegramUserId);
    expect(view).toMatchObject({ settings: null, trades: { planned: 0 } });
    expect(safeParseTradingSessionResponse({ session: view }).success).toBe(true);
  });

  it('V5 a session without intents has zero counters and no last intent', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    const view = await readTradingSessionView(tmp.db, session.id, seed.telegramUserId);
    expect(view).toMatchObject({
      trades: {
        planned: 5,
        settled: 0,
        rejected: 0,
        won: 0,
        lost: 0,
        tied: 0,
        profit: '0.00000000',
      },
      lastIntent: null,
      balance: null,
    });
  });

  it('V6 a stopped session carries its reason and end', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await stopTradingSession(tmp.db, {
      id: session.id,
      reason: TradingSessionStopReason.UserStopped,
    });
    const view = await readTradingSessionView(tmp.db, session.id, seed.telegramUserId);
    const [row] = await tmp.db
      .select({ endedAt: tradingSessions.endedAt })
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    expect(view).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
      endedAt: row!.endedAt!.toISOString(),
    });
  });

  it("drizzle applies the view's transaction options (repeatable read, read only)", async () => {
    const { rows } = await tmp.db.transaction(
      (tx) =>
        tx.execute<{ ro: string; iso: string }>(
          sql`select current_setting('transaction_read_only') as ro, current_setting('transaction_isolation') as iso`,
        ),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    expect(rows[0]).toEqual({ ro: 'on', iso: 'repeatable read' });
  });
});

const money = (value: string) => value as DecimalString;
const brokerUser = (demo: string, real: string): BrokerUser => ({
  id: 'broker-1',
  level: { code: 'standard', rank: 1 },
  minTradeAmount: money('1'),
  real: { available: money(real), held: money('0'), total: money(real) },
  demo: { available: money(demo), held: money('0'), total: money(demo) },
});
const snapshot = (brokerAccountId: string, demo = '10002.5', real = '250') =>
  upsertBalanceSnapshot(tmp.db, {
    brokerAccountId,
    user: brokerUser(demo, real),
    requested: false,
  });
// the REST read an hour ago: older than any settlement a test writes after it
const backdate = (brokerAccountId: string) =>
  tmp.db
    .update(brokerBalanceSnapshots)
    .set({ restObservedAt: sql`now() - interval '1 hour'` })
    .where(eq(brokerBalanceSnapshots.brokerAccountId, brokerAccountId));
const viewOf = async (session: { id: string }, seed: { telegramUserId: string }) =>
  (await readTradingSessionView(tmp.db, session.id, seed.telegramUserId))!;

describe('readTradingSessionView: the profit sum and the balance (#337)', () => {
  it.each([
    ['wins only', ['0.85', '0.9'], '1.75000000'],
    ['losses only', ['-1', '-1'], '-2.00000000'],
    ['a mix with a tie', ['0.85', '-1', '0'], '-0.15000000'],
    ['a tie only', ['0'], '0.00000000'],
  ])('V7 sums the settled trades in SQL: %s', async (_name, profits, sum) => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    let step = 1;
    for (const profit of profits) {
      await settle((await sessionIntent(seed, session.id, step++)).intent, profit);
    }
    // neither a rejected step nor the bot's own trade on the account counts
    await reject((await sessionIntent(seed, session.id, step)).intent);
    const { intent: botIntent } = await createTradeIntent(
      tmp.db,
      intentRequest(seed.telegramUserId),
    );
    await settle(botIntent, '5');
    const view = await viewOf(session, seed);
    expect(view.trades.profit).toBe(sum);
    expect(safeParseTradingSessionResponse({ session: view }).success).toBe(true);
  });

  it('V7 a session with no settled trade sums to zero at scale 8', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await reject((await sessionIntent(seed, session.id, 1)).intent);
    await sessionIntent(seed, session.id, 2);
    expect((await viewOf(session, seed)).trades.profit).toBe('0.00000000');
  });

  it("V8 a real session sums its real trades and shows the snapshot's real balance", async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, {
      mode: TradeMode.Real,
    });
    await settle((await sessionIntent(seed, session.id, 1, TradeMode.Real)).intent, '0.85');
    await settle((await sessionIntent(seed, session.id, 2, TradeMode.Real)).intent, '-1');
    await snapshot(seed.brokerAccountId, '10002.5', '250.75');
    const view = await viewOf(session, seed);
    expect(view.trades.profit).toBe('-0.15000000');
    expect(view.balance).toEqual({ available: '250.75000000', ageSec: 0, current: true });
    expect(safeParseTradingSessionResponse({ session: view }).success).toBe(true);
  });

  it('V9a an account without a snapshot has no balance', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settle((await sessionIntent(seed, session.id, 1)).intent, '0.85');
    expect((await viewOf(session, seed)).balance).toBeNull();
  });

  it('V9b a snapshot written after the settlements is current', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settle((await sessionIntent(seed, session.id, 1)).intent, '0.85');
    await snapshot(seed.brokerAccountId);
    expect((await viewOf(session, seed)).balance).toEqual({
      available: '10002.50000000',
      ageSec: 0,
      current: true,
    });
  });

  it('V9c a snapshot taken between the reserve and the settlement is not current', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    const { intent } = await sessionIntent(seed, session.id, 1);
    await snapshot(seed.brokerAccountId);
    await settle(intent, '0.85');
    expect((await viewOf(session, seed)).balance).toMatchObject({ current: false });
  });

  it('V9d an old snapshot with no settlement of the session is current, with its age', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await reject((await sessionIntent(seed, session.id, 1)).intent);
    await snapshot(seed.brokerAccountId);
    await backdate(seed.brokerAccountId);
    const { balance } = await viewOf(session, seed);
    expect(balance).toMatchObject({ current: true });
    expect(balance!.ageSec).toBeGreaterThanOrEqual(3600);
  });

  it("V9e the mode's own socket event counts as an observation, the other mode's does not", async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const demo = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settle((await sessionIntent(seed, demo.id, 1)).intent, '0.85');
    await stopTradingSession(tmp.db, { id: demo.id, reason: TradingSessionStopReason.Completed });
    const real = await seedTradingSession(tmp.db, seed.brokerAccountId, { mode: TradeMode.Real });
    await settle((await sessionIntent(seed, real.id, 1, TradeMode.Real)).intent, '-1');
    await snapshot(seed.brokerAccountId);
    await backdate(seed.brokerAccountId);
    await applyBalanceEvent(tmp.db, {
      brokerAccountId: seed.brokerAccountId,
      mode: TradeMode.Demo,
      balance: { available: money('10003'), held: money('0'), total: money('10003') },
    });
    expect((await viewOf(demo, seed)).balance).toEqual({
      available: '10003.00000000',
      ageSec: 0,
      current: true,
    });
    const realBalance = (await viewOf(real, seed)).balance!;
    expect(realBalance).toMatchObject({ available: '250.00000000', current: false });
    expect(realBalance.ageSec).toBeGreaterThanOrEqual(3600);
  });
});

describe('readTradingSessionAccount', () => {
  it("V10 reads the session's account for its owner only", async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const other = await seedUser(tmp.db);
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    expect(await readTradingSessionAccount(tmp.db, session.id, seed.telegramUserId)).toEqual({
      brokerAccountId: seed.brokerAccountId,
    });
    expect(
      await readTradingSessionAccount(tmp.db, session.id, other.telegramUserId),
    ).toBeUndefined();
    expect(
      await readTradingSessionAccount(
        tmp.db,
        '00000000-0000-4000-8000-000000000000',
        seed.telegramUserId,
      ),
    ).toBeUndefined();
  });
});

describe('readActiveTradingSessionView', () => {
  it("reads the account's active session and nothing once it stopped", async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    expect(
      (await readActiveTradingSessionView(tmp.db, seed.brokerAccountId, seed.telegramUserId))?.id,
    ).toBe(session.id);
    await stopTradingSession(tmp.db, {
      id: session.id,
      reason: TradingSessionStopReason.UserStopped,
    });
    expect(
      await readActiveTradingSessionView(tmp.db, seed.brokerAccountId, seed.telegramUserId),
    ).toBeUndefined();
  });
});

describe('readTradingSessionView: the trade list (#464)', () => {
  const line = (action: TradeAction, amount: string, profit: string, result: string) => ({
    action,
    amount,
    profit,
    result,
  });

  it('V11 only settled trades, in creation order, with their own stake and the SQL class', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settle((await sessionIntent(seed, session.id, 1)).intent, '0.85');
    await reject((await sessionIntent(seed, session.id, 2)).intent);
    const down = { amount: '2', action: TradeAction.Down };
    await settle((await sessionIntent(seed, session.id, 3, TradeMode.Demo, down)).intent, '-2');
    await settle((await sessionIntent(seed, session.id, 4)).intent, '0');
    await accept((await sessionIntent(seed, session.id, 5)).intent);

    const view = await readTradingSessionView(tmp.db, session.id, seed.telegramUserId);
    expect(safeParseTradingSessionResponse({ session: view }).success).toBe(true);
    expect(view!.settledTrades).toEqual([
      line(TradeAction.Up, '1.00000000', '0.85000000', 'won'),
      line(TradeAction.Down, '2.00000000', '-2.00000000', 'lost'),
      line(TradeAction.Up, '1.00000000', '0.00000000', 'tied'),
    ]);
    expect(view!.settledTrades).toHaveLength(view!.trades.settled);
    expect(view!.lastIntent).toMatchObject({ status: 'accepted' });
  });

  it('V12 a trade on manual review is not a line; the settled ones are', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settle((await sessionIntent(seed, session.id, 1)).intent, '-1');
    const { intent } = await sessionIntent(seed, session.id, 2);
    const taken = (await takeIntent(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
      maxAgeMs: 60_000,
    }))!;
    const unknown = (await tmp.db.transaction((tx) =>
      markIntentUnknown(tx, {
        id: taken.id,
        expectedVersion: taken.version,
        reason: TradeIntentFailureReason.ExecutorTimeout,
      }),
    ))!;
    const reconciling = (await startReconciling(tmp.db, {
      id: unknown.id,
      expectedVersion: unknown.version,
    }))!;
    expect(
      await markIntentManualReview(tmp.db, {
        id: reconciling.id,
        expectedVersion: reconciling.version,
        reason: TradeIntentFailureReason.ReconciliationNotFound,
      }),
    ).toMatchObject({ status: 'manual_review' });
    await stopTradingSession(tmp.db, {
      id: session.id,
      reason: TradingSessionStopReason.ManualReview,
    });

    const view = await readTradingSessionView(tmp.db, session.id, seed.telegramUserId);
    expect(view!.settledTrades).toEqual([
      line(TradeAction.Up, '1.00000000', '-1.00000000', 'lost'),
    ]);
    expect(view!.lastIntent).toMatchObject({ id: intent.id, status: 'manual_review' });
  });

  it('V13 a session without a settled trade has an empty list', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await reject((await sessionIntent(seed, session.id, 1)).intent);
    const view = await readTradingSessionView(tmp.db, session.id, seed.telegramUserId);
    expect(view!.settledTrades).toEqual([]);
  });

  it("V14 the account's own bot trade between the steps is not a line of the session", async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settle((await sessionIntent(seed, session.id, 1)).intent, '0.85');
    const { intent: botIntent } = await createTradeIntent(
      tmp.db,
      intentRequest(seed.telegramUserId),
    );
    await settle(botIntent, '5');
    await settle((await sessionIntent(seed, session.id, 2)).intent, '0');

    const view = await readTradingSessionView(tmp.db, session.id, seed.telegramUserId);
    expect(view!.settledTrades).toEqual([
      line(TradeAction.Up, '1.00000000', '0.85000000', 'won'),
      line(TradeAction.Up, '1.00000000', '0.00000000', 'tied'),
    ]);
  });
});

describe('claimSessionSummary (#318)', () => {
  type Seed = Awaited<ReturnType<typeof seedUserWithAccount>>;
  const claim = (session: { id: string }, seed: { telegramUserId: string }) =>
    claimSessionSummary(tmp.db, { id: session.id, telegramUserId: seed.telegramUserId });
  const sentAt = async (session: { id: string }) =>
    (
      await tmp.db
        .select({ at: tradingSessions.summarySentAt })
        .from(tradingSessions)
        .where(eq(tradingSessions.id, session.id))
    )[0]?.at;
  const stop = (session: { id: string }) =>
    stopTradingSession(tmp.db, { id: session.id, reason: TradingSessionStopReason.Completed });
  // a stopped session of `profits`, each step settled at its own prices
  const finished = async (profits: string[], mode: TradeMode = TradeMode.Demo) => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, { mode });
    let step = 1;
    for (const profit of profits) {
      const { intent } = await sessionIntent(seed, session.id, step, mode);
      await settle(intent, profit, { open: step, close: step + 0.5 });
      step += 1;
    }
    await stop(session);
    return { seed, session };
  };

  it('S1 a mixed session: its trades in creation order and the exact sum, once', async () => {
    const { seed, session } = await finished(['0.85', '-1', '0']);
    const summary = await claim(session, seed);
    expect(summary).toEqual({
      result: '-0.15000000',
      trades: [
        { profit: '0.85000000', openPrice: 1, closePrice: 1.5 },
        { profit: '-1.00000000', openPrice: 2, closePrice: 2.5 },
        { profit: '0.00000000', openPrice: 3, closePrice: 3.5 },
      ],
    });
    expect(safeParseSessionSummaryResponse({ summary }).success).toBe(true);
    expect(await sentAt(session)).toBeInstanceOf(Date);
    // S4: the second claim of the same session
    expect(await claim(session, seed)).toBeUndefined();
  });

  it('S2 losses only sum negative', async () => {
    const { seed, session } = await finished(['-1', '-2.5']);
    expect((await claim(session, seed))?.result).toBe('-3.50000000');
  });

  it('S3 a real session is claimed as a demo one', async () => {
    const { seed, session } = await finished(['0.85', '-1'], TradeMode.Real);
    expect(await claim(session, seed)).toMatchObject({ result: '-0.15000000' });
  });

  it('S5 an active session is not claimed and keeps NULL', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await settle((await sessionIntent(seed, session.id, 1)).intent, '0.85');
    expect(await claim(session, seed)).toBeUndefined();
    expect(await sentAt(session)).toBeNull();
  });

  it.each([
    ['queued', async (_seed: Seed, intent: TradeIntentRow) => void intent],
    ['accepted', async (_seed: Seed, intent: TradeIntentRow) => void (await accept(intent))],
  ])(
    'S6 a stopped session whose last trade is %s is not claimed and keeps NULL',
    async (_name, move) => {
      const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
      const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
      await settle((await sessionIntent(seed, session.id, 1)).intent, '0.85');
      await move(seed, (await sessionIntent(seed, session.id, 2)).intent);
      await stop(session);
      expect(await claim(session, seed)).toBeUndefined();
      expect(await sentAt(session)).toBeNull();
    },
  );

  it('S7 a stopped session with no settled trade (only rejected) is not claimed', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await reject((await sessionIntent(seed, session.id, 1)).intent);
    await stop(session);
    expect(await claim(session, seed)).toBeUndefined();
    expect(await sentAt(session)).toBeNull();
  });

  it('S7b a stopped session with no intent at all is not claimed', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await stop(session);
    expect(await claim(session, seed)).toBeUndefined();
    expect(await sentAt(session)).toBeNull();
  });

  it('S8 rejected steps are left out of the trades and do not block the claim', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    await reject((await sessionIntent(seed, session.id, 1)).intent);
    await settle((await sessionIntent(seed, session.id, 2)).intent, '0.85', {
      open: 7,
      close: 8,
    });
    await reject((await sessionIntent(seed, session.id, 3)).intent);
    // the bot's own trade on the same account is no step of the session
    const { intent: botIntent } = await createTradeIntent(
      tmp.db,
      intentRequest(seed.telegramUserId),
    );
    await settle(botIntent, '5');
    await stop(session);
    expect(await claim(session, seed)).toEqual({
      result: '0.85000000',
      trades: [{ profit: '0.85000000', openPrice: 7, closePrice: 8 }],
    });
  });

  it("S9 another user's telegram id claims nothing and keeps NULL", async () => {
    const { seed, session } = await finished(['0.85']);
    const other = await seedUser(tmp.db);
    expect(await claim(session, other)).toBeUndefined();
    expect(await sentAt(session)).toBeNull();
    expect(await claim(session, seed)).toBeDefined();
  });

  it("S10 the result equals the view's profit over the same finished session", async () => {
    const { seed, session } = await finished(['0.85', '-1', '0', '1.23456789']);
    const view = await viewOf(session, seed);
    const summary = await claim(session, seed);
    expect(summary?.result).toBe(view.trades.profit);
    // S11: exact at scale 8, no float on the way
    expect(summary?.result).toBe('1.08456789');
  });

  // no CHECK ties a broker trade to its intent's status: a closed trade on a rejected intent is a
  // row the schema allows, and neither the list nor the sum may take it
  it('S13 a closed broker trade on a rejected step is left out of the trades and the sum', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 10n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    const { intent: won } = await sessionIntent(seed, session.id, 1);
    await settle(won, '0.85', { open: 1, close: 2 });
    const { intent: rejected } = await sessionIntent(seed, session.id, 2);
    await reject(rejected);
    await tmp.db.execute(sql`
      insert into broker_trades (broker_account_id, intent_id, broker_trade_id, mode, asset_id,
        action, amount, payout, open_price, open_timestamp_ms, close_price, close_timestamp_ms,
        profit, status, raw)
      select broker_account_id, ${rejected.id}, broker_trade_id || '-copy', mode, asset_id,
        action, amount, payout, 5, open_timestamp_ms, 6, close_timestamp_ms, 100, status, raw
        from broker_trades where intent_id = ${won.id}`);
    await stop(session);
    const view = await viewOf(session, seed);
    expect(await claim(session, seed)).toEqual({
      result: '0.85000000',
      trades: [{ profit: '0.85000000', openPrice: 1, closePrice: 2 }],
    });
    expect(view.trades.profit).toBe('0.85000000');
  });

  it('S12 two claims at once: exactly one wins', async () => {
    const { seed, session } = await finished(['0.85']);
    const results = await Promise.all([claim(session, seed), claim(session, seed)]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });
});
