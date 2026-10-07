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
  safeParseTradingSessionResponse,
  type DecimalString,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import { tradingSessions, users } from './schema/index';
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
  rejectIntent,
  settleIntent,
  takeIntent,
  type TradeIntentRow,
} from './trade-intent-ops';
import { openTrading, stopTrading } from './trading-switch-ops';
import {
  checkTradingSessionStart,
  createSessionIntent,
  readActiveTradingSessionView,
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

async function settle(intent: TradeIntentRow, profit: string): Promise<void> {
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
) =>
  createSessionIntent(tmp.db, {
    sessionId,
    step,
    telegramUserId: seed.telegramUserId,
    brokerAccountId: seed.brokerAccountId,
    mode: TradeMode.Demo,
    assetId: 101,
    amount: decimalStringSchema.parse('1'),
    action: TradeAction.Up,
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
      trades: { planned: 5, settled: 0, rejected: 0, won: 0, lost: 0, tied: 0 },
      lastIntent: null,
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
