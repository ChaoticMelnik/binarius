import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountHaltReason,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  decimalStringSchema,
  type DecimalString,
  type TradeIntentErrorCode,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor, until } from '@binarius/shared/testing';
import { brokerAccounts, tokenLedger, tradeIntents, tradingSessions, users } from './schema/index';
import {
  closeTradingSwitch,
  createTempDatabase,
  seedBrokerAccount,
  seedTradingSession,
  seedUnknownIntent,
  seedUser,
  seedUserWithAccount,
  sessionSettings,
  type TempDatabase,
} from './testing';
import {
  TOKENS_PER_INTENT,
  TradeIntentError,
  TradingSessionNotActiveError,
  createTradeIntent,
  haltAccountForManualReview,
  markIntentAccepted,
  rejectIntent,
  settleIntent,
  startReconciling,
  takeIntent,
  transitionIntent,
  type TradeIntentRow,
} from './trade-intent-ops';
import {
  TradingSessionError,
  TradingSessionDbErrorCode,
  createSessionIntent,
  createTradingSession,
  listRunnableSessions,
  markSessionDecision,
  readSessionHistory,
  stopExpiredSessions,
  stopHaltedSessions,
  stopPausedSessions,
  stopTradingSession,
  type CreateSessionIntentInput,
} from './trading-session-ops';
import { openTrading } from './trading-switch-ops';

// Integration tests on a temporary migrated database (README → Database), rows committed for
// real: the lock cases need separate connections.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const HOUR_MS = 3_600_000;

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const sessionOf = async (id: string) =>
  (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, id)))[0];

const tokenReservedOf = async (userId: string) =>
  (await tmp.db.select({ v: users.tokenReserved }).from(users).where(eq(users.id, userId)))[0]!.v;

const ledgerRowsOf = async (userId: string) =>
  tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, userId));

const intentsOfAccount = (brokerAccountId: string) =>
  tmp.db.select().from(tradeIntents).where(eq(tradeIntents.brokerAccountId, brokerAccountId));

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function sessionFailsWith(promise: Promise<unknown>, code: TradingSessionDbErrorCode) {
  const error = await thrown(promise);
  expect(error).toBeInstanceOf(TradingSessionError);
  expect((error as TradingSessionError).code).toBe(code);
}

async function intentFailsWith(promise: Promise<unknown>, code: TradeIntentErrorCode) {
  const error = await thrown(promise);
  expect(error).toBeInstanceOf(TradeIntentError);
  expect((error as TradeIntentError).code).toBe(code);
}

const lockWaiters = async () => {
  const { rows } = await tmp.db.execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return rows[0]?.waiting ?? 0;
};

// Waits until `pending` queues behind a lock or settles. A caller that never waited (the lock it
// should take is gone) settles first; the test releases the holder either way and then asserts.
async function queuedBehindLock(pending: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await until('the caller to queue behind the lock or finish', async () => {
    return settled || (await lockWaiters()) > 0;
  });
  return !settled;
}

// a transaction that takes a lock, signals, and holds it until released
function holdLock(
  lock: (tx: Parameters<Parameters<TempDatabase['db']['transaction']>[0]>[0]) => Promise<unknown>,
) {
  let taken!: () => void;
  const lockTaken = new Promise<void>((resolve) => (taken = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const done = tmp.db.transaction(async (tx) => {
    await lock(tx);
    taken();
    await released;
  });
  return { lockTaken, release, done };
}

async function seedSessionAccount(options: { balance?: bigint } = {}) {
  const seed = await seedUserWithAccount(tmp.db, options);
  const session = await createTradingSession(tmp.db, {
    telegramUserId: seed.telegramUserId,
    brokerAccountId: seed.brokerAccountId,
    mode: TradeMode.Demo,
    settings: sessionSettings(),
  });
  return { ...seed, session };
}

const intentInput = (
  seed: { telegramUserId: string; brokerAccountId: string; session: { id: string } },
  patch: Partial<CreateSessionIntentInput> = {},
): CreateSessionIntentInput => ({
  sessionId: seed.session.id,
  step: 1,
  telegramUserId: seed.telegramUserId,
  brokerAccountId: seed.brokerAccountId,
  mode: TradeMode.Demo,
  assetId: 101,
  amount: decimalStringSchema.parse('1'),
  action: TradeAction.Up,
  durationSec: 60,
  ...patch,
});

// queued → submitting → accepted → settled through the production writers
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

describe('createTradingSession', () => {
  it('C1 inserts an active session with the settings as given and started_at from the database', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const settings = sessionSettings({ trades: 3, assetId: 7 });
    const row = await createTradingSession(tmp.db, {
      telegramUserId: seed.telegramUserId,
      brokerAccountId: seed.brokerAccountId,
      mode: TradeMode.Demo,
      settings,
    });
    const { rows } = await tmp.db.execute<{ now: Date }>(sql`select now() as now`);
    expect(row).toMatchObject({
      brokerAccountId: seed.brokerAccountId,
      mode: 'demo',
      status: 'active',
      stopReason: null,
      endedAt: null,
      lastDecisionAt: null,
    });
    expect((await sessionOf(row.id))!.settings).toEqual(settings);
    expect(row.startedAt.getTime()).toBeLessThanOrEqual(new Date(rows[0]!.now).getTime());
  });

  it('C2 refuses a second active session of the account and leaves the first untouched', async () => {
    const seed = await seedSessionAccount();
    await sessionFailsWith(
      createTradingSession(tmp.db, {
        telegramUserId: seed.telegramUserId,
        brokerAccountId: seed.brokerAccountId,
        mode: TradeMode.Demo,
        settings: sessionSettings(),
      }),
      TradingSessionDbErrorCode.ActiveSessionExists,
    );
    const rows = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.brokerAccountId, seed.brokerAccountId));
    expect(rows).toEqual([expect.objectContaining({ id: seed.session.id, status: 'active' })]);
  });

  it('C3 a stopped session does not block a new one', async () => {
    const seed = await seedSessionAccount();
    await stopTradingSession(tmp.db, { id: seed.session.id, reason: 'completed' });
    const next = await createTradingSession(tmp.db, {
      telegramUserId: seed.telegramUserId,
      brokerAccountId: seed.brokerAccountId,
      mode: TradeMode.Demo,
      settings: sessionSettings(),
    });
    expect(next.status).toBe('active');
  });

  it.each([
    ['pending', TradingSessionDbErrorCode.AccountNotConfirmed],
    ['revoked', TradingSessionDbErrorCode.AccountRevoked],
  ] as const)('C4 refuses a %s account', async (status, code) => {
    const user = await seedUser(tmp.db);
    const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId, { status });
    await sessionFailsWith(
      createTradingSession(tmp.db, {
        telegramUserId: user.telegramUserId,
        brokerAccountId,
        mode: 'demo',
        settings: sessionSettings(),
      }),
      code,
    );
  });

  it('C6 refuses a real session before it reads anything, and writes no row', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    await sessionFailsWith(
      createTradingSession(tmp.db, {
        telegramUserId: seed.telegramUserId,
        brokerAccountId: seed.brokerAccountId,
        mode: TradeMode.Real,
        settings: sessionSettings(),
      }),
      TradingSessionDbErrorCode.ModeNotAllowed,
    );
    expect(
      await tmp.db
        .select()
        .from(tradingSessions)
        .where(eq(tradingSessions.brokerAccountId, seed.brokerAccountId)),
    ).toEqual([]);
  });

  it('C4 refuses a halted account, a blocked user and an unknown id', async () => {
    const user = await seedUser(tmp.db);
    const halted = await seedBrokerAccount(tmp.db, user.userId, {
      tradingHalted: true,
      haltedReason: AccountHaltReason.TradeMismatch,
    });
    await sessionFailsWith(
      createTradingSession(tmp.db, {
        telegramUserId: user.telegramUserId,
        brokerAccountId: halted,
        mode: 'demo',
        settings: sessionSettings(),
      }),
      TradingSessionDbErrorCode.AccountHalted,
    );
    const blocked = await seedUser(tmp.db, { status: 'blocked' });
    const ofBlocked = await seedBrokerAccount(tmp.db, blocked.userId);
    await sessionFailsWith(
      createTradingSession(tmp.db, {
        telegramUserId: blocked.telegramUserId,
        brokerAccountId: ofBlocked,
        mode: 'demo',
        settings: sessionSettings(),
      }),
      TradingSessionDbErrorCode.UserNotActive,
    );
    await sessionFailsWith(
      createTradingSession(tmp.db, {
        telegramUserId: user.telegramUserId,
        brokerAccountId: '00000000-0000-4000-8000-000000000000',
        mode: 'demo',
        settings: sessionSettings(),
      }),
      TradingSessionDbErrorCode.AccountNotFound,
    );
    const rows = await tmp.db
      .select()
      .from(tradingSessions)
      .where(sql`${tradingSessions.brokerAccountId} in (${halted}, ${ofBlocked})`);
    expect(rows).toEqual([]);
  });

  it('C6 refuses an account of another user as account_not_found and writes no row', async () => {
    const owner = await seedUserWithAccount(tmp.db);
    const stranger = await seedUser(tmp.db);
    await sessionFailsWith(
      createTradingSession(tmp.db, {
        telegramUserId: stranger.telegramUserId,
        brokerAccountId: owner.brokerAccountId,
        mode: 'demo',
        settings: sessionSettings(),
      }),
      TradingSessionDbErrorCode.AccountNotFound,
    );
    const rows = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.brokerAccountId, owner.brokerAccountId));
    expect(rows).toEqual([]);
  });

  it('C5 waits on a held user row; a block committed meanwhile refuses the session', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const holder = holdLock(async (tx) => {
      await tx.select().from(users).where(eq(users.id, seed.userId)).for('no key update');
      await tx.update(users).set({ status: 'blocked' }).where(eq(users.id, seed.userId));
    });
    await holder.lockTaken;
    const creating = thrown(
      createTradingSession(tmp.db, {
        telegramUserId: seed.telegramUserId,
        brokerAccountId: seed.brokerAccountId,
        mode: 'demo',
        settings: sessionSettings(),
      }),
    );
    const queued = await queuedBehindLock(creating);
    holder.release();
    await holder.done;
    expect(queued).toBe(true);
    const error = await creating;
    expect(error).toBeInstanceOf(TradingSessionError);
    expect((error as TradingSessionError).code).toBe(TradingSessionDbErrorCode.UserNotActive);
    const rows = await tmp.db
      .select()
      .from(tradingSessions)
      .where(eq(tradingSessions.brokerAccountId, seed.brokerAccountId));
    expect(rows).toEqual([]);
  });

  it('C5 waits on a held account row; a halt committed meanwhile refuses the session', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const holder = holdLock(async (tx) => {
      await tx
        .update(brokerAccounts)
        .set({ tradingHalted: true, haltedReason: AccountHaltReason.TradeMismatch })
        .where(eq(brokerAccounts.id, seed.brokerAccountId));
    });
    await holder.lockTaken;
    const creating = thrown(
      createTradingSession(tmp.db, {
        telegramUserId: seed.telegramUserId,
        brokerAccountId: seed.brokerAccountId,
        mode: 'demo',
        settings: sessionSettings(),
      }),
    );
    const queued = await queuedBehindLock(creating);
    holder.release();
    await holder.done;
    expect(queued).toBe(true);
    const error = await creating;
    expect((error as TradingSessionError).code).toBe(TradingSessionDbErrorCode.AccountHalted);
  });
});

describe('createTradingSession: the global trading switch (#144)', () => {
  it('C7 refuses while trading is closed and writes no row', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    await closeTradingSwitch(tmp.db);
    try {
      await sessionFailsWith(
        createTradingSession(tmp.db, {
          telegramUserId: seed.telegramUserId,
          brokerAccountId: seed.brokerAccountId,
          mode: TradeMode.Demo,
          settings: sessionSettings(),
        }),
        TradingSessionDbErrorCode.TradingPaused,
      );
    } finally {
      await openTrading(tmp.db);
    }
    expect(
      await tmp.db
        .select()
        .from(tradingSessions)
        .where(eq(tradingSessions.brokerAccountId, seed.brokerAccountId)),
    ).toEqual([]);
  });
});

describe('listRunnableSessions', () => {
  it('R1 lists a session with no intent or only terminal ones, not one whose account has a live intent', async () => {
    const empty = await seedSessionAccount();
    const finished = await seedSessionAccount();
    const { intent: done } = await createSessionIntent(tmp.db, intentInput(finished));
    await reject(done);
    const live = await seedSessionAccount();
    await createSessionIntent(tmp.db, intentInput(live));
    // a bot trade (no session) on the account holds the session as the index would
    const bot = await seedSessionAccount();
    await createTradeIntent(tmp.db, {
      telegramUserId: bot.telegramUserId,
      brokerAccountId: bot.brokerAccountId,
      mode: 'demo',
      assetId: 101,
      amount: decimalStringSchema.parse('1'),
      action: 'up',
      durationSec: 60,
      clientRequestId: `bot-${bot.session.id}`,
    });
    const ids = (await listRunnableSessions(tmp.db, { limit: 1000, maxDurationMs: HOUR_MS })).map(
      (s) => s.id,
    );
    expect(ids).toEqual(expect.arrayContaining([empty.session.id, finished.session.id]));
    expect(ids).not.toContain(live.session.id);
    expect(ids).not.toContain(bot.session.id);
  });

  it('R2 orders by last_decision_at nulls first, then created_at, and honours exclude', async () => {
    const a = await seedSessionAccount();
    const b = await seedSessionAccount();
    const c = await seedSessionAccount();
    const d = await seedSessionAccount();
    await tmp.db
      .update(tradingSessions)
      .set({ lastDecisionAt: sql`now() - interval '1 minute'` })
      .where(eq(tradingSessions.id, a.session.id));
    await tmp.db
      .update(tradingSessions)
      .set({ lastDecisionAt: sql`now() - interval '2 minutes'` })
      .where(eq(tradingSessions.id, b.session.id));
    const mine = new Set([a.session.id, b.session.id, c.session.id, d.session.id]);
    const order = (await listRunnableSessions(tmp.db, { limit: 1000, maxDurationMs: HOUR_MS }))
      .map((s) => s.id)
      .filter((id) => mine.has(id));
    expect(order).toEqual([c.session.id, d.session.id, b.session.id, a.session.id]);
    const excluded = (
      await listRunnableSessions(tmp.db, {
        limit: 1000,
        maxDurationMs: HOUR_MS,
        exclude: [c.session.id],
      })
    )
      .map((s) => s.id)
      .filter((id) => mine.has(id));
    expect(excluded).toEqual([d.session.id, b.session.id, a.session.id]);
  });

  it('R3 never lists a stopped session and returns the raw settings', async () => {
    const stopped = await seedSessionAccount();
    await stopTradingSession(tmp.db, { id: stopped.session.id, reason: 'timeout' });
    const raw = await seedUserWithAccount(tmp.db);
    const bad = await seedTradingSession(tmp.db, raw.brokerAccountId, { settings: {} });
    const listed = await listRunnableSessions(tmp.db, { limit: 1000, maxDurationMs: HOUR_MS });
    expect(listed.map((s) => s.id)).not.toContain(stopped.session.id);
    expect(listed.find((s) => s.id === bad.id)).toMatchObject({ settings: {}, mode: 'demo' });
  });
  it('R4 never lists a session past the deadline (#287 review M1)', async () => {
    const old = await seedUserWithAccount(tmp.db);
    const expired = await seedTradingSession(tmp.db, old.brokerAccountId, {
      startedAt: new Date(Date.now() - 2 * HOUR_MS),
    });
    const recent = await seedUserWithAccount(tmp.db);
    const within = await seedTradingSession(tmp.db, recent.brokerAccountId, {
      startedAt: new Date(Date.now() - HOUR_MS + 60_000),
    });
    const ids = (await listRunnableSessions(tmp.db, { limit: 1000, maxDurationMs: HOUR_MS })).map(
      (s) => s.id,
    );
    expect(ids).toContain(within.id);
    expect(ids).not.toContain(expired.id);
  });
});

describe('the stop sweeps', () => {
  it('S1 stopExpiredSessions stops only sessions past started_at + maxDurationMs', async () => {
    const old = await seedUserWithAccount(tmp.db);
    const expired = await seedTradingSession(tmp.db, old.brokerAccountId, {
      startedAt: new Date(Date.now() - 2 * HOUR_MS),
    });
    const fresh = await seedSessionAccount();
    const stopped = await stopExpiredSessions(tmp.db, { maxDurationMs: HOUR_MS, limit: 1000 });
    expect(stopped).toContainEqual({ id: expired.id, brokerAccountId: old.brokerAccountId });
    expect(stopped.map((s) => s.id)).not.toContain(fresh.session.id);
    expect(await sessionOf(expired.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'timeout',
      endedAt: expect.any(Date),
    });
    expect((await sessionOf(fresh.session.id))!.status).toBe('active');
    // a second sweep finds nothing to stop: the first reason stays
    expect(
      (await stopExpiredSessions(tmp.db, { maxDurationMs: HOUR_MS, limit: 1000 })).map((s) => s.id),
    ).not.toContain(expired.id);
  });

  it('S2 stopHaltedSessions stops the session of an account the pass halted', async () => {
    const seed = await seedUnknownIntent(tmp.db);
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
    const reconciling = (await startReconciling(tmp.db, {
      id: seed.intent.id,
      expectedVersion: seed.intent.version,
    }))!;
    await tmp.db.transaction((tx) =>
      haltAccountForManualReview(tx, {
        id: reconciling.id,
        expectedVersion: reconciling.version,
        reason: TradeIntentFailureReason.ReconciliationAmbiguous,
      }),
    );
    const bystander = await seedSessionAccount();
    const stopped = await stopHaltedSessions(tmp.db, { limit: 1000 });
    expect(stopped).toContainEqual({ id: session.id, brokerAccountId: seed.brokerAccountId });
    expect(stopped.map((s) => s.id)).not.toContain(bystander.session.id);
    expect(await sessionOf(session.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'manual_review',
    });
    expect((await sessionOf(bystander.session.id))!.status).toBe('active');
  });

  it('S2 the halt alone: trading_halted written directly, no intent', async () => {
    const seed = await seedSessionAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ tradingHalted: true, haltedReason: AccountHaltReason.TradeMismatch })
      .where(eq(brokerAccounts.id, seed.brokerAccountId));
    const stopped = await stopHaltedSessions(tmp.db, { limit: 1000 });
    expect(stopped.map((s) => s.id)).toContain(seed.session.id);
  });

  it('S2 the manual_review intent alone: the account un-halted by an operator', async () => {
    const seed = await seedSessionAccount();
    const { intent } = await createSessionIntent(tmp.db, intentInput(seed));
    const taken = (await takeIntent(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
      maxAgeMs: 60_000,
    }))!;
    let row = taken;
    for (const [from, to] of [
      [TradeIntentStatus.Submitting, TradeIntentStatus.Unknown],
      [TradeIntentStatus.Unknown, TradeIntentStatus.Reconciling],
      [TradeIntentStatus.Reconciling, TradeIntentStatus.ManualReview],
    ] as const) {
      row = (await transitionIntent(tmp.db, {
        id: row.id,
        from,
        to,
        expectedVersion: row.version,
      }))!;
    }
    expect(row.status).toBe('manual_review');
    const stopped = await stopHaltedSessions(tmp.db, { limit: 1000 });
    expect(stopped.map((s) => s.id)).toContain(seed.session.id);
  });
});

describe('stopPausedSessions (#144)', () => {
  it('S3 stops nothing while open, then every active session with kill_switch once closed', async () => {
    const live = await seedSessionAccount();
    const done = await seedSessionAccount();
    await stopTradingSession(tmp.db, { id: done.session.id, reason: 'completed' });

    expect((await stopPausedSessions(tmp.db, { limit: 1000 })).map((s) => s.id)).not.toContain(
      live.session.id,
    );
    expect((await sessionOf(live.session.id))!.status).toBe('active');

    await closeTradingSwitch(tmp.db);
    try {
      const stopped = await stopPausedSessions(tmp.db, { limit: 1000 });
      expect(stopped).toContainEqual({
        id: live.session.id,
        brokerAccountId: live.brokerAccountId,
      });
      expect(stopped.map((s) => s.id)).not.toContain(done.session.id);
      expect((await stopPausedSessions(tmp.db, { limit: 1000 })).map((s) => s.id)).not.toContain(
        live.session.id,
      );
    } finally {
      await openTrading(tmp.db);
    }
    expect(await sessionOf(live.session.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'kill_switch',
      endedAt: expect.any(Date),
    });
    // a session another writer stopped first keeps its reason
    expect((await sessionOf(done.session.id))!.stopReason).toBe('completed');
  });
});

describe('readSessionHistory', () => {
  it('H1 returns the session intents in creation order with the linked profit and the owner', async () => {
    const seed = await seedSessionAccount();
    const { intent: first } = await createSessionIntent(tmp.db, intentInput(seed));
    await settle(first, '0.82');
    const { intent: second } = await createSessionIntent(
      tmp.db,
      intentInput(seed, { step: 2, action: TradeAction.Down }),
    );
    const history = await readSessionHistory(tmp.db, seed.session.id, { maxDurationMs: HOUR_MS });
    expect(history).toEqual({
      telegramUserId: seed.telegramUserId,
      expired: false,
      intents: [
        {
          id: first.id,
          status: 'settled',
          amount: '1.00000000',
          profit: '0.82000000',
          lastError: null,
        },
        { id: second.id, status: 'queued', amount: '1.00000000', profit: null, lastError: null },
      ],
    });
    expect(
      await readSessionHistory(tmp.db, '00000000-0000-4000-8000-000000000000', {
        maxDurationMs: HOUR_MS,
      }),
    ).toBeUndefined();
  });
  it('H2 flags a session past the deadline (#287 review M1)', async () => {
    const old = await seedUserWithAccount(tmp.db);
    const expired = await seedTradingSession(tmp.db, old.brokerAccountId, {
      startedAt: new Date(Date.now() - 2 * HOUR_MS),
    });
    const fresh = await seedSessionAccount();
    expect(
      (await readSessionHistory(tmp.db, expired.id, { maxDurationMs: HOUR_MS }))!.expired,
    ).toBe(true);
    expect(
      (await readSessionHistory(tmp.db, fresh.session.id, { maxDurationMs: HOUR_MS }))!.expired,
    ).toBe(false);
  });
});

describe('stopTradingSession and markSessionDecision', () => {
  it('T1 stops an active session once; a second stop keeps the first reason', async () => {
    const seed = await seedSessionAccount();
    const stopped = await stopTradingSession(tmp.db, { id: seed.session.id, reason: 'completed' });
    expect(stopped).toMatchObject({
      status: 'stopped',
      stopReason: 'completed',
      endedAt: expect.any(Date),
      lastDecisionAt: expect.any(Date),
    });
    expect(
      await stopTradingSession(tmp.db, { id: seed.session.id, reason: 'user_stopped' }),
    ).toBeUndefined();
    expect((await sessionOf(seed.session.id))!.stopReason).toBe('completed');
  });

  it('D1 moves last_decision_at on an active session only', async () => {
    const active = await seedSessionAccount();
    await markSessionDecision(tmp.db, { id: active.session.id });
    expect((await sessionOf(active.session.id))!.lastDecisionAt).toBeInstanceOf(Date);
    const stopped = await seedSessionAccount();
    const row = (await stopTradingSession(tmp.db, { id: stopped.session.id, reason: 'timeout' }))!;
    await tmp.db.execute(sql`select pg_sleep(0.01)`);
    await markSessionDecision(tmp.db, { id: stopped.session.id });
    expect((await sessionOf(stopped.session.id))!.lastDecisionAt).toEqual(row.lastDecisionAt);
  });
});

describe('createSessionIntent', () => {
  it('I1 creates a queued intent of the session with the step key, the reserve and the outbox row', async () => {
    const seed = await seedSessionAccount();
    const { intent, created } = await createSessionIntent(tmp.db, intentInput(seed));
    expect(created).toBe(true);
    expect(intent).toMatchObject({
      status: 'queued',
      tradingSessionId: seed.session.id,
      clientRequestId: `session:${seed.session.id}:1`,
      tokensReserved: TOKENS_PER_INTENT,
    });
    expect(await tokenReservedOf(seed.userId)).toBe(TOKENS_PER_INTENT);
  });

  it('I2 the same step with the same terms replays the row and reserves once', async () => {
    const seed = await seedSessionAccount();
    const first = await createSessionIntent(tmp.db, intentInput(seed));
    const again = await createSessionIntent(tmp.db, intentInput(seed));
    expect(again).toEqual({ intent: first.intent, created: false });
    expect(await intentsOfAccount(seed.brokerAccountId)).toHaveLength(1);
    expect(await tokenReservedOf(seed.userId)).toBe(TOKENS_PER_INTENT);
  });

  it('I3 the next step while the first is live is refused by the active-intent index', async () => {
    const seed = await seedSessionAccount();
    await createSessionIntent(tmp.db, intentInput(seed));
    await intentFailsWith(
      createSessionIntent(tmp.db, intentInput(seed, { step: 2 })),
      'active_intent_exists',
    );
  });

  it('I4 a stopped session gets no intent, no reserve and no ledger row', async () => {
    const seed = await seedSessionAccount();
    await stopTradingSession(tmp.db, { id: seed.session.id, reason: 'user_stopped' });
    const error = await thrown(createSessionIntent(tmp.db, intentInput(seed)));
    expect(error).toBeInstanceOf(TradingSessionNotActiveError);
    expect(await intentsOfAccount(seed.brokerAccountId)).toEqual([]);
    expect(await tokenReservedOf(seed.userId)).toBe(0n);
    expect(await ledgerRowsOf(seed.userId)).toEqual([]);
  });

  it('I4 a session of another account is not this account’s session', async () => {
    const seed = await seedSessionAccount();
    const other = await seedSessionAccount();
    const error = await thrown(
      createSessionIntent(tmp.db, intentInput(seed, { sessionId: other.session.id })),
    );
    expect(error).toBeInstanceOf(TradingSessionNotActiveError);
    expect(await intentsOfAccount(seed.brokerAccountId)).toEqual([]);
  });

  it('I4 an intent in another mode than the session’s is refused: no row, no reserve', async () => {
    const seed = await seedSessionAccount();
    const error = await thrown(
      createSessionIntent(tmp.db, intentInput(seed, { mode: TradeMode.Real })),
    );
    expect(error).toBeInstanceOf(TradingSessionNotActiveError);
    expect(await intentsOfAccount(seed.brokerAccountId)).toEqual([]);
    expect(await tokenReservedOf(seed.userId)).toBe(0n);
    expect(await ledgerRowsOf(seed.userId)).toEqual([]);
  });

  it('I5 waits on a held session row', async () => {
    const seed = await seedSessionAccount();
    const holder = holdLock((tx) =>
      tx
        .select()
        .from(tradingSessions)
        .where(eq(tradingSessions.id, seed.session.id))
        .for('no key update'),
    );
    await holder.lockTaken;
    const creating = createSessionIntent(tmp.db, intentInput(seed));
    const queued = await queuedBehindLock(creating);
    holder.release();
    await holder.done;
    expect(queued).toBe(true);
    expect((await creating).created).toBe(true);
  });

  it('I6 the same step with another action is a request-id conflict; the first row stands', async () => {
    const seed = await seedSessionAccount();
    const first = await createSessionIntent(tmp.db, intentInput(seed));
    await intentFailsWith(
      createSessionIntent(tmp.db, intentInput(seed, { action: TradeAction.Down })),
      'client_request_id_conflict',
    );
    expect(await intentsOfAccount(seed.brokerAccountId)).toEqual([
      expect.objectContaining({ id: first.intent.id, action: 'up' }),
    ]);
    expect(await tokenReservedOf(seed.userId)).toBe(TOKENS_PER_INTENT);
  });
});
