import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountHaltReason,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  UserStatus,
  type ClosedTrade,
  type DecimalString,
  type OpenTrade,
} from '@binarius/shared';
import {
  closedTradeFor,
  INTEGRATION_WAIT_CEILING_MS,
  openTradeFor,
  until,
} from '@binarius/shared/testing';
import {
  closeTradingSwitch,
  createTempDatabase,
  intentRequest,
  seedBalanceSnapshot,
  seedBrokerAccount,
  seedQueuedIntent,
  seedUnknownIntent,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from './testing';
import {
  TOKENS_PER_INTENT,
  TradeIntentError,
  TradeIntentMismatchError,
  claimReconciling,
  concludeReconciled,
  createTradeIntent,
  findTradeIntent,
  getTradeIntentView,
  haltAccountForManualReview,
  listLinkedBrokerTradeIds,
  listOverdueAcceptedIntents,
  listReconcilingCandidates,
  listStaleSubmittingIntents,
  markIntentAccepted,
  markIntentManualReview,
  millisecondsAgo,
  markIntentUnknown,
  readHeldExposure,
  rejectExpiredIntent,
  rejectIntent,
  settleClosedTrades,
  settleIntent,
  startReconciling,
  takeIntent,
  transitionIntent,
  uniqueViolation,
  type ManualReviewReason,
  type TradeIntentRow,
} from './trade-intent-ops';
import {
  brokerAccounts,
  brokerTrades,
  outboxEvents,
  tokenLedger,
  tradeIntents,
  tradingSwitch,
  users,
} from './schema/index';
import { openTrading } from './trading-switch-ops';
import { setTradingMode } from './user-ops';

// Integration tests on a temporary migrated database (README → Database). Rows are committed
// for real: concurrency cases need separate connections, and token_ledger is append-only.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const MAX_AGE_MS = 60_000;

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const tokenReservedOf = async (userId: string) =>
  (await tmp.db.select({ v: users.tokenReserved }).from(users).where(eq(users.id, userId)))[0]!.v;

const ledgerOf = (intentId: string) =>
  tmp.db
    .select({ kind: tokenLedger.kind, reservedDelta: tokenLedger.reservedDelta })
    .from(tokenLedger)
    .where(eq(tokenLedger.intentId, intentId))
    .orderBy(tokenLedger.createdAt);

const outboxOf = (intentId: string) =>
  tmp.db.select().from(outboxEvents).where(eq(outboxEvents.intentId, intentId));

async function failsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TradeIntentError);
  expect((error as TradeIntentError).code).toBe(code);
}

const take = (intent: { id: string; version: number }) =>
  takeIntent(tmp.db, { id: intent.id, expectedVersion: intent.version, maxAgeMs: MAX_AGE_MS });

// the worker's "expired" branch needs an old row; created_at is not append-only
const ageIntent = (id: string, ms: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ createdAt: millisecondsAgo(ms) })
    .where(eq(tradeIntents.id, id));

const ageSubmission = (id: string, ms: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ submittedAt: millisecondsAgo(ms) })
    .where(eq(tradeIntents.id, id));

describe('createTradeIntent', () => {
  it('reserves a token and queues the intent in one go', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    const { intent, created } = await createTradeIntent(tmp.db, input);

    expect(created).toBe(true);
    expect(intent).toMatchObject({
      brokerAccountId: s.brokerAccountId,
      userId: s.userId,
      status: 'queued',
      version: 3,
      tokensReserved: TOKENS_PER_INTENT,
      clientRequestId: input.clientRequestId,
      amount: '10.00000000',
      lastError: null,
      submittedAt: null,
      // the route's path names no session (#287's orchestrator is the only one that does)
      tradingSessionId: null,
      transport: null,
    });
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
    expect(await ledgerOf(intent.id)).toEqual([
      { kind: 'reserve', reservedDelta: TOKENS_PER_INTENT },
    ]);
    expect(await outboxOf(intent.id)).toMatchObject([
      {
        topic: 'trading-intents',
        status: 'pending',
        payload: { intent_id: intent.id },
        attempts: 0,
      },
    ]);
  });

  it('replays the same request without reserving twice', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    const first = await createTradeIntent(tmp.db, input);
    const second = await createTradeIntent(
      tmp.db,
      {
        ...input,
        amount: '10.000' as DecimalString,
      },
    );

    expect(second.created).toBe(false);
    expect(second.intent.id).toBe(first.intent.id);
    expect(second.intent.version).toBe(first.intent.version);
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
    expect(await ledgerOf(first.intent.id)).toHaveLength(1);
  });

  it('replays after the account was revoked and after a second account appeared', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    const first = await createTradeIntent(tmp.db, input);

    await tmp.db
      .update(brokerAccounts)
      .set({ status: 'revoked' })
      .where(eq(brokerAccounts.id, s.brokerAccountId));
    expect((await createTradeIntent(tmp.db, input)).intent.id).toBe(first.intent.id);

    await seedBrokerAccount(tmp.db, s.userId);
    await seedBrokerAccount(tmp.db, s.userId);
    expect((await createTradeIntent(tmp.db, input)).intent.id).toBe(first.intent.id);
  });

  it('rejects a reused clientRequestId with different parameters', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    await createTradeIntent(tmp.db, input);
    await failsWith(
      createTradeIntent(tmp.db, { ...input, action: 'down' }),
      'client_request_id_conflict',
    );
  });

  it('treats the same clientRequestId on another account as a conflict, not a replay', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const other = await seedBrokerAccount(tmp.db, s.userId);
    const input = intentRequest(s.telegramUserId, { brokerAccountId: s.brokerAccountId });
    const first = await createTradeIntent(tmp.db, input);

    await failsWith(
      createTradeIntent(tmp.db, { ...input, brokerAccountId: other }),
      'client_request_id_conflict',
    );
    // without an account the retry is a replay whatever account the original used
    const withoutAccount = intentRequest(s.telegramUserId, {
      clientRequestId: input.clientRequestId,
    });
    expect((await createTradeIntent(tmp.db, withoutAccount)).intent.id).toBe(
      first.intent.id,
    );
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
    expect(await ledgerOf(first.intent.id)).toHaveLength(1);
  });

  it('refuses without available tokens and writes nothing', async () => {
    const s = await seedUserWithAccount(tmp.db, { balance: 0n });
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(s.telegramUserId)),
      'insufficient_tokens',
    );
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(
      await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, s.userId)),
    ).toEqual([]);
    expect(await tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, s.userId))).toEqual(
      [],
    );
  });

  it('counts already reserved tokens against the balance', async () => {
    const s = await seedUserWithAccount(tmp.db, { balance: 1n });
    await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(s.telegramUserId)),
      // the active-intent index would also refuse; the token guard runs first
      'insufficient_tokens',
    );
  });

  it('refuses a blocked user through the reserve guard', async () => {
    const user = await seedUser(tmp.db, { status: 'blocked' });
    await seedBrokerAccount(tmp.db, user.userId);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(user.telegramUserId)),
      'user_blocked',
    );
    expect(await tokenReservedOf(user.userId)).toBe(0n);
  });

  it('allows one active intent per account', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(s.telegramUserId)),
      'active_intent_exists',
    );
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
  });

  it.each([
    ['revoked', { status: 'revoked' as const }, 'account_revoked'],
    ['halted', { tradingHalted: true, haltedReason: AccountHaltReason.ReconciliationAmbiguous }, 'account_halted'],
    // linked but not confirmed in the bot: a distinct answer, because the user can fix it
    ['pending', { status: 'pending' as const }, 'account_not_confirmed'],
  ])('refuses a %s account', async (_label, patch, code) => {
    const user = await seedUser(tmp.db);
    const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId, patch);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(user.telegramUserId, { brokerAccountId })),
      code,
    );
    expect(await tokenReservedOf(user.userId)).toBe(0n);
  });

  // the worker never reads the account's status, so nothing may reach the queue for an
  // unconfirmed account in the first place
  it('creates neither an intent nor an outbox row for an unconfirmed account', async () => {
    const user = await seedUser(tmp.db);
    const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId, { status: 'pending' });
    const outboxBefore = await tmp.db.select({ id: outboxEvents.id }).from(outboxEvents);

    // named explicitly, and picked automatically: both paths have to answer the same way
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(user.telegramUserId, { brokerAccountId })),
      'account_not_confirmed',
    );
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(user.telegramUserId)),
      'account_not_confirmed',
    );

    expect(
      await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, user.userId)),
    ).toEqual([]);
    expect(await tmp.db.select({ id: outboxEvents.id }).from(outboxEvents)).toHaveLength(
      outboxBefore.length,
    );
  });

  it('classifies lookups: unknown user, no account, foreign account, ambiguous account', async () => {
    await failsWith(
      createTradeIntent(tmp.db, intentRequest('999999999')),
      'user_not_found',
    );

    const lonely = await seedUser(tmp.db);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(lonely.telegramUserId)),
      'broker_account_not_found',
    );

    const other = await seedUserWithAccount(tmp.db);
    await failsWith(
      createTradeIntent(
        tmp.db,
        intentRequest(lonely.telegramUserId, { brokerAccountId: other.brokerAccountId }),
      ),
      'broker_account_not_found',
    );

    const twoAccounts = await seedUserWithAccount(tmp.db);
    await seedBrokerAccount(tmp.db, twoAccounts.userId);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(twoAccounts.telegramUserId)),
      'ambiguous_broker_account',
    );
    expect(
      (
        await createTradeIntent(
          tmp.db,
          intentRequest(twoAccounts.telegramUserId, {
            brokerAccountId: twoAccounts.brokerAccountId,
          }),
        )
      ).created,
    ).toBe(true);
  });

  it('serves concurrent identical requests one intent and one reserve', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createTradeIntent(tmp.db, input)),
    );
    const ids = new Set(results.map((r) => r.intent.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
    expect(await ledgerOf(results[0]!.intent.id)).toHaveLength(1);
  });

  it('lets exactly one of concurrent different requests through', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        createTradeIntent(tmp.db, intentRequest(s.telegramUserId)),
      ),
    );
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect((r.reason as TradeIntentError).code).toBe('active_intent_exists');
    }
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
  });

  it('lets exactly one of concurrent cross-account requests with one clientRequestId through', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const other = await seedBrokerAccount(tmp.db, s.userId);
    const clientRequestId = `cross-${s.telegramUserId}`;
    const settled = await Promise.allSettled(
      [s.brokerAccountId, other, s.brokerAccountId, other].map((brokerAccountId) =>
        createTradeIntent(
          tmp.db,
          intentRequest(s.telegramUserId, { clientRequestId, brokerAccountId }),
        ),
      ),
    );
    const fulfilled = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(new Set(fulfilled.map((r) => r.intent.id)).size).toBe(1);
    expect(fulfilled.filter((r) => r.created)).toHaveLength(1);
    const winner = fulfilled[0]!.intent.brokerAccountId;
    for (const r of fulfilled) expect(r.intent.brokerAccountId).toBe(winner);
    for (const r of settled) {
      if (r.status === 'rejected') {
        expect((r.reason as TradeIntentError).code).toBe('client_request_id_conflict');
      }
    }
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
    expect(await ledgerOf(fulfilled[0]!.intent.id)).toHaveLength(1);
  });

  // Creation holds the user row while its INSERT waits on the active-intent index; a rejection
  // that locked the intent first and the user second closed the cycle (40P01). The order is
  // now users → trade_intents on both paths. Probabilistic: with the old order the deadlock
  // showed within a handful of rounds.
  it('does not deadlock a rejection against a concurrent creation on the same account', async () => {
    const s = await seedUserWithAccount(tmp.db, { balance: 100n });
    for (let round = 0; round < 20; round += 1) {
      const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
      const taken = (await take(intent))!;
      const [rejection, creation] = await Promise.allSettled([
        tmp.db.transaction((tx) =>
          rejectIntent(tx, {
            id: intent.id,
            from: 'submitting',
            expectedVersion: taken.version,
            reason: TradeIntentFailureReason.BrokerRejected,
          }),
        ),
        createTradeIntent(tmp.db, intentRequest(s.telegramUserId)),
      ]);
      expect(rejection.status).toBe('fulfilled');
      if (creation.status === 'rejected') {
        expect(creation.reason).toBeInstanceOf(TradeIntentError);
        expect((creation.reason as TradeIntentError).code).toBe('active_intent_exists');
      } else {
        const next = creation.value.intent;
        const nextTaken = (await take(next))!;
        await tmp.db.transaction((tx) =>
          rejectIntent(tx, {
            id: next.id,
            from: 'submitting',
            expectedVersion: nextTaken.version,
            reason: TradeIntentFailureReason.BrokerRejected,
          }),
        );
      }
    }
    expect(await tokenReservedOf(s.userId)).toBe(0n);
  });
});

describe('uniqueViolation', () => {
  it('reads the constraint off the wrapped driver error only for 23505', () => {
    expect(uniqueViolation({ cause: { code: '23505', constraint: 'x' } })).toBe('x');
    expect(uniqueViolation({ cause: { code: '23514', constraint: 'x' } })).toBeUndefined();
    expect(uniqueViolation({ code: '23505', constraint: 'x' })).toBeUndefined();
    expect(uniqueViolation(new Error('plain'))).toBeUndefined();
  });
});

describe('transitions', () => {
  it('refuses an edge outside the transition table before touching the database', async () => {
    await expect(
      transitionIntent(tmp.db, {
        id: '00000000-0000-0000-0000-000000000000',
        from: 'queued',
        to: 'settled',
      }),
    ).rejects.toThrow('illegal trade intent transition queued -> settled');
  });

  it('takes a fresh queued intent and refuses a stale version', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
    expect(await take({ id: intent.id, version: intent.version - 1 })).toBeUndefined();
    const taken = await take(intent);
    expect(taken).toMatchObject({ status: 'submitting', version: intent.version + 1 });
    expect(taken!.submittedAt).toBeInstanceOf(Date);
    expect(await take(intent)).toBeUndefined();
  });

  it('expires an old queued intent on the database clock and releases the token', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
    const expire = () =>
      tmp.db.transaction((tx) =>
        rejectExpiredIntent(tx, {
          id: intent.id,
          expectedVersion: intent.version,
          maxAgeMs: MAX_AGE_MS,
        }),
      );
    await expect(expire()).resolves.toBeUndefined();

    await ageIntent(intent.id, 120_000);
    expect(await take(intent)).toBeUndefined();
    expect(await expire()).toMatchObject({
      status: 'rejected',
      lastError: 'expired',
      tokensReserved: 0n,
    });
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(await ledgerOf(intent.id)).toEqual([
      { kind: 'reserve', reservedDelta: TOKENS_PER_INTENT },
      { kind: 'release', reservedDelta: -TOKENS_PER_INTENT },
    ]);
  });

  it('rejects a submitting intent once, releasing the reserve exactly once', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
    const taken = (await take(intent))!;
    const rejected = await tmp.db.transaction((tx) =>
      rejectIntent(tx, {
        id: intent.id,
        from: 'submitting',
        expectedVersion: taken.version,
        reason: TradeIntentFailureReason.BrokerRejected,
      }),
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      lastError: 'broker_rejected',
      tokensReserved: 0n,
      version: taken.version + 1,
    });
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(await ledgerOf(intent.id)).toHaveLength(2);

    await expect(
      tmp.db.transaction((tx) =>
        rejectIntent(tx, {
          id: intent.id,
          from: 'submitting',
          reason: TradeIntentFailureReason.BrokerRejected,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(await ledgerOf(intent.id)).toHaveLength(2);

    // the account is free again
    expect(
      (await createTradeIntent(tmp.db, intentRequest(s.telegramUserId))).created,
    ).toBe(true);
  });

  it('refuses to release below the cached reserve instead of desynchronizing', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
    await tmp.db.update(users).set({ tokenReserved: 0n }).where(eq(users.id, s.userId));
    await expect(
      tmp.db.transaction((tx) =>
        rejectIntent(tx, {
          id: intent.id,
          from: 'queued',
          reason: TradeIntentFailureReason.PublishFailed,
        }),
      ),
    ).rejects.toThrow('token reserve underflow');
    // the transaction rolled back: the intent is still queued and the ledger untouched
    expect((await findTradeIntent(tmp.db, intent.id))!.status).toBe('queued');
    expect(await ledgerOf(intent.id)).toHaveLength(1);
  });

  it('marks unknown once with a single reconciliation row, honoring the age guard', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
    const taken = (await take(intent))!;

    await expect(
      tmp.db.transaction((tx) =>
        markIntentUnknown(tx, {
          id: intent.id,
          reason: TradeIntentFailureReason.StaleSubmitting,
          olderThanMs: MAX_AGE_MS,
        }),
      ),
    ).resolves.toBeUndefined();

    const unknown = await tmp.db.transaction((tx) =>
      markIntentUnknown(tx, {
        id: intent.id,
        reason: TradeIntentFailureReason.ExecutorTimeout,
        expectedVersion: taken.version,
      }),
    );
    expect(unknown).toMatchObject({
      status: 'unknown',
      lastError: 'executor_timeout',
      tokensReserved: TOKENS_PER_INTENT,
    });
    await expect(
      tmp.db.transaction((tx) =>
        markIntentUnknown(tx, { id: intent.id, reason: TradeIntentFailureReason.ExecutorTimeout }),
      ),
    ).resolves.toBeUndefined();
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
    expect((await outboxOf(intent.id)).map((r) => r.topic).sort()).toEqual([
      'trading-intents',
      'trading-reconciliation',
    ]);
  });

  it('lists only intents submitting longer than the threshold', async () => {
    const stale = await seedUserWithAccount(tmp.db);
    const fresh = await seedUserWithAccount(tmp.db);
    const staleIntent = (await take(
      (await createTradeIntent(tmp.db, intentRequest(stale.telegramUserId))).intent,
    ))!;
    const freshIntent = (await take(
      (await createTradeIntent(tmp.db, intentRequest(fresh.telegramUserId))).intent,
    ))!;
    await ageSubmission(staleIntent.id, 120_000);
    const listed = await listStaleSubmittingIntents(tmp.db, {
      olderThanMs: MAX_AGE_MS,
      limit: 100,
    });
    const ids = listed.map((r) => r.id);
    expect(ids).toContain(staleIntent.id);
    expect(ids).not.toContain(freshIntent.id);
  });
});

describe('getTradeIntentView', () => {
  it('maps the row to the wire shape with nullable fields and string bigints', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    const { intent } = await createTradeIntent(tmp.db, input);
    const view = await getTradeIntentView(tmp.db, intent.id, BigInt(s.telegramUserId));
    expect(view).toEqual({
      id: intent.id,
      brokerAccountId: s.brokerAccountId,
      telegramUserId: s.telegramUserId,
      mode: 'demo',
      assetId: 91,
      amount: '10.00000000',
      action: 'up',
      durationSec: 60,
      clientRequestId: input.clientRequestId,
      createdAt: intent.createdAt.toISOString(),
      status: 'queued',
      version: 3,
      tokensReserved: '1',
      transport: null,
      submittedAt: null,
      lastError: null,
      updatedAt: intent.updatedAt.toISOString(),
    });
    expect(
      await getTradeIntentView(
        tmp.db,
        '00000000-0000-0000-0000-000000000000',
        BigInt(s.telegramUserId),
      ),
    ).toBeUndefined();
  });

  it("reads another user's intent as undefined, like a missing one (#127)", async () => {
    const owner = await seedUserWithAccount(tmp.db);
    const other = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(
      tmp.db,
      intentRequest(owner.telegramUserId),
    );
    expect(await getTradeIntentView(tmp.db, intent.id, BigInt(owner.telegramUserId))).toMatchObject(
      {
        id: intent.id,
      },
    );
    expect(
      await getTradeIntentView(tmp.db, intent.id, BigInt(other.telegramUserId)),
    ).toBeUndefined();
  });
});

describe('createTradeIntent: the global trading switch (#144)', () => {
  const real = (telegramUserId: string, patch: Parameters<typeof intentRequest>[1] = {}) =>
    intentRequest(telegramUserId, { mode: TradeMode.Real, ...patch });

  const userLedger = (userId: string) =>
    tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, userId));

  afterEach(() => openTrading(tmp.db));

  it('P1 refuses a demo intent while closed and leaves no trace', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await closeTradingSwitch(tmp.db);
    await failsWith(createTradeIntent(tmp.db, intentRequest(s.telegramUserId)), 'trading_paused');
    expect(
      await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, s.userId)),
    ).toEqual([]);
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(await userLedger(s.userId)).toEqual([]);
  });

  it('P2 refuses a real intent while closed', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await closeTradingSwitch(tmp.db);
    await failsWith(createTradeIntent(tmp.db, real(s.telegramUserId)), 'trading_paused');
  });

  it('P3 replays an intent created while open after the switch closed', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    const first = await createTradeIntent(tmp.db, input);
    await closeTradingSwitch(tmp.db);
    const again = await createTradeIntent(tmp.db, input);
    expect(again.created).toBe(false);
    expect(again.intent.id).toBe(first.intent.id);
  });

  // the switch is read before resolveAccount: a foreign account would otherwise answer
  // broker_account_not_found
  it('refuses before reading the account', async () => {
    const lonely = await seedUser(tmp.db);
    const other = await seedUserWithAccount(tmp.db);
    await closeTradingSwitch(tmp.db);
    await failsWith(
      createTradeIntent(
        tmp.db,
        intentRequest(lonely.telegramUserId, { brokerAccountId: other.brokerAccountId }),
      ),
      'trading_paused',
    );
  });

  it('P4 creates demo and real intents while open', async () => {
    const demo = await seedUserWithAccount(tmp.db);
    const realSeed = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    expect((await createTradeIntent(tmp.db, intentRequest(demo.telegramUserId))).intent).toMatchObject(
      { mode: 'demo', status: 'queued' },
    );
    expect((await createTradeIntent(tmp.db, real(realSeed.telegramUserId))).intent).toMatchObject({
      mode: 'real',
      status: 'queued',
    });
  });

  it('refuses while the row is missing (fail-closed)', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await tmp.db.delete(tradingSwitch);
    await failsWith(createTradeIntent(tmp.db, intentRequest(s.telegramUserId)), 'trading_paused');
  });
});

describe('createTradeIntent: the demo-stake bounds (#297)', () => {
  const checked = { checkDemoStake: true } as const;
  const amount = (value: string) => value as DecimalString;

  async function refusedWithoutTrace(
    seed: { userId: string; telegramUserId: string },
    input: ReturnType<typeof intentRequest>,
    code: string,
  ) {
    await failsWith(createTradeIntent(tmp.db, input, undefined, checked), code);
    expect(
      await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, seed.userId)),
    ).toEqual([]);
    expect(await tokenReservedOf(seed.userId)).toBe(0n);
    expect(
      await tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, seed.userId)),
    ).toEqual([]);
  }

  it('B1 without the option creates a demo intent with no snapshot, as before', async () => {
    const s = await seedUserWithAccount(tmp.db);
    expect((await createTradeIntent(tmp.db, intentRequest(s.telegramUserId))).created).toBe(true);
  });

  it('B2 refuses balance_unavailable without a snapshot', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await refusedWithoutTrace(s, intentRequest(s.telegramUserId), 'balance_unavailable');
  });

  it.each([
    ['0.99', 'stake_below_minimum'],
    ['50.01', 'insufficient_demo_balance'],
    ['1.234', 'stake_precision'],
  ])('B3 refuses %s with %s and leaves no trace', async (value, code) => {
    const s = await seedUserWithAccount(tmp.db);
    await seedBalanceSnapshot(tmp.db, s.brokerAccountId, {
      minTradeAmount: '1',
      demoAvailable: '50',
    });
    await refusedWithoutTrace(s, intentRequest(s.telegramUserId, { amount: amount(value) }), code);
  });

  it.each([['1'], ['1.5'], ['50']])(
    'B4 creates %s inside the bounds, both ends included',
    async (value) => {
      const s = await seedUserWithAccount(tmp.db);
      await seedBalanceSnapshot(tmp.db, s.brokerAccountId, {
        minTradeAmount: '1',
        demoAvailable: '50',
      });
      const { created } = await createTradeIntent(
        tmp.db,
        intentRequest(s.telegramUserId, { amount: amount(value) }),
        undefined,
        checked,
      );
      expect(created).toBe(true);
    },
  );

  it('B5 does not check a real intent', async () => {
    const s = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    const input = intentRequest(s.telegramUserId, { mode: TradeMode.Real });
    expect((await createTradeIntent(tmp.db, input, undefined, checked)).created).toBe(true);
  });

  it('B6 replays a committed intent after the balance dropped below its amount', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await seedBalanceSnapshot(tmp.db, s.brokerAccountId, { demoAvailable: '10' });
    const input = intentRequest(s.telegramUserId, { amount: amount('10') });
    const first = await createTradeIntent(tmp.db, input, undefined, checked);
    await seedBalanceSnapshot(tmp.db, s.brokerAccountId, { demoAvailable: '0' });
    const again = await createTradeIntent(tmp.db, input, undefined, checked);
    expect(again.created).toBe(false);
    expect(again.intent.id).toBe(first.intent.id);
  });

  it('B7 answers trading_paused before the bounds', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await closeTradingSwitch(tmp.db);
    try {
      await refusedWithoutTrace(s, intentRequest(s.telegramUserId), 'trading_paused');
    } finally {
      await openTrading(tmp.db);
    }
  });
});

describe('createTradeIntent: DEMO_ONLY (#396)', () => {
  const real = (telegramUserId: string) => intentRequest(telegramUserId, { mode: TradeMode.Real });
  const demoOnly = { demoOnly: true } as const;
  const intentsOf = (userId: string) =>
    tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, userId));

  it('F1 refuses a real intent and leaves no trace, ahead of the switch and the account', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await failsWith(
      createTradeIntent(tmp.db, real(s.telegramUserId), undefined, demoOnly),
      'demo_only',
    );
    expect(await intentsOf(s.userId)).toEqual([]);
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(await tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, s.userId))).toEqual(
      [],
    );

    await closeTradingSwitch(tmp.db);
    try {
      await failsWith(
        createTradeIntent(tmp.db, real(s.telegramUserId), undefined, demoOnly),
        'demo_only',
      );
    } finally {
      await openTrading(tmp.db);
    }

    await tmp.db
      .update(brokerAccounts)
      .set({ status: 'revoked' })
      .where(eq(brokerAccounts.id, s.brokerAccountId));
    await failsWith(
      createTradeIntent(tmp.db, real(s.telegramUserId), undefined, demoOnly),
      'demo_only',
    );
  });

  it('F2 creates a demo intent under the flag', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(
      tmp.db,
      intentRequest(s.telegramUserId),
      undefined,
      demoOnly,
    );
    expect(intent).toMatchObject({ mode: 'demo', status: 'queued' });
  });

  it('F3 creates a real intent with the flag off or absent', async () => {
    const off = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    const absent = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    const created = await createTradeIntent(tmp.db, real(off.telegramUserId), undefined, {
      demoOnly: false,
    });
    expect(created.intent).toMatchObject({ mode: 'real', status: 'queued' });
    expect((await createTradeIntent(tmp.db, real(absent.telegramUserId))).created).toBe(true);
  });

  it('F4 replays a real intent created without the flag', async () => {
    const s = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    const input = real(s.telegramUserId);
    const first = await createTradeIntent(tmp.db, input, undefined, { demoOnly: false });
    const again = await createTradeIntent(tmp.db, input, undefined, demoOnly);
    expect(again.created).toBe(false);
    expect(again.intent.id).toBe(first.intent.id);
  });
});

// The real-mode gate in the reserve UPDATE (#121, Rule 36): a real intent only for a user whose
// users.trading_mode is real; a demo intent is never refused by the mode.
describe('createTradeIntent: the user\'s trading mode (#121)', () => {
  const real = (telegramUserId: string) => intentRequest(telegramUserId, { mode: TradeMode.Real });
  const intentsOf = (userId: string) =>
    tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, userId));

  it('M1 refuses a real intent for a user in demo mode and leaves no trace', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await failsWith(createTradeIntent(tmp.db, real(s.telegramUserId)), 'real_mode_off');
    expect(await intentsOf(s.userId)).toEqual([]);
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(await tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, s.userId))).toEqual(
      [],
    );
  });

  it('M2 creates a real intent for a user in real mode, and a demo one in either mode', async () => {
    const s = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    const { intent } = await createTradeIntent(tmp.db, real(s.telegramUserId));
    expect(intent).toMatchObject({ mode: 'real', status: 'queued' });
    const demo = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    expect(
      (await createTradeIntent(tmp.db, intentRequest(demo.telegramUserId))).intent,
    ).toMatchObject({ mode: 'demo', status: 'queued' });
  });

  it('M3 answers user_blocked before real_mode_off', async () => {
    const s = await seedUserWithAccount(tmp.db, { status: UserStatus.Blocked });
    await failsWith(createTradeIntent(tmp.db, real(s.telegramUserId)), 'user_blocked');
  });

  it('M3b answers insufficient_tokens for a real-mode user without tokens', async () => {
    const s = await seedUserWithAccount(tmp.db, { balance: 0n, tradingMode: TradeMode.Real });
    await failsWith(createTradeIntent(tmp.db, real(s.telegramUserId)), 'insufficient_tokens');
  });

  it('M4 replays a real intent after the user went back to demo', async () => {
    const s = await seedUserWithAccount(tmp.db, { tradingMode: TradeMode.Real });
    const input = real(s.telegramUserId);
    const first = await createTradeIntent(tmp.db, input);
    await setTradingMode(tmp.db, BigInt(s.telegramUserId), TradeMode.Demo);
    const again = await createTradeIntent(tmp.db, input);
    expect(again.created).toBe(false);
    expect(again.intent.id).toBe(first.intent.id);
  });
});

// --- #17: acceptance with the broker's trade, settlement, the closed-trade applier -------------

const tradesOf = (intentId: string) =>
  tmp.db.select().from(brokerTrades).where(eq(brokerTrades.intentId, intentId));

const userTokens = async (userId: string) =>
  (
    await tmp.db
      .select({ balance: users.tokenBalance, reserved: users.tokenReserved })
      .from(users)
      .where(eq(users.id, userId))
  )[0]!;

const settleRowsOf = (intentId: string) =>
  tmp.db
    .select({ reservedDelta: tokenLedger.reservedDelta, balanceDelta: tokenLedger.balanceDelta })
    .from(tokenLedger)
    .where(and(eq(tokenLedger.intentId, intentId), eq(tokenLedger.kind, 'settle')));

async function submittingIntent() {
  const seed = await seedQueuedIntent(tmp.db);
  const intent = (await take(seed.intent))!;
  return { ...seed, intent };
}

const accept = (intent: TradeIntentRow, trade: OpenTrade, from?: 'submitting' | 'reconciling') =>
  tmp.db.transaction((tx) =>
    markIntentAccepted(tx, {
      id: intent.id,
      expectedVersion: intent.version,
      transport: 'socket',
      trade,
      ...(from === undefined ? {} : { from }),
    }),
  );

async function acceptedIntent() {
  const seed = await submittingIntent();
  const open = openTradeFor(seed.intent);
  const intent = (await accept(seed.intent, open))!;
  return { ...seed, intent, open };
}

// submitting → unknown → reconciling (→ manual_review): the edges #89/#90 will own, driven here
// through the shared CAS so the trigger sees ordinary transitions
async function parkedIntent(to: 'reconciling' | 'manual_review') {
  const seed = await submittingIntent();
  const unknown = (await tmp.db.transaction((tx) =>
    markIntentUnknown(tx, {
      id: seed.intent.id,
      reason: TradeIntentFailureReason.StaleSubmitting,
    }),
  ))!;
  let intent = (await transitionIntent(tmp.db, {
    id: unknown.id,
    from: TradeIntentStatus.Unknown,
    to: TradeIntentStatus.Reconciling,
    expectedVersion: unknown.version,
  }))!;
  if (to === 'manual_review') {
    intent = (await transitionIntent(tmp.db, {
      id: intent.id,
      from: TradeIntentStatus.Reconciling,
      to: TradeIntentStatus.ManualReview,
      expectedVersion: intent.version,
    }))!;
  }
  return { ...seed, intent };
}

async function mismatchOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TradeIntentMismatchError);
  return (error as TradeIntentMismatchError).reason;
}

const settle = (
  intent: TradeIntentRow,
  trade: ClosedTrade,
  from: 'accepted' | 'manual_review' = 'accepted',
) => tmp.db.transaction((tx) => settleIntent(tx, { id: intent.id, from, trade }));

describe('markIntentAccepted (#17)', () => {
  it('accepts with the broker trade and writes its open row in the same transaction', async () => {
    const { intent } = await submittingIntent();
    const open = openTradeFor(intent);
    const accepted = await accept(intent, open);
    expect(accepted).toMatchObject({
      status: 'accepted',
      transport: 'socket',
      tokensReserved: TOKENS_PER_INTENT,
      version: intent.version + 1,
    });
    const rows = await tradesOf(intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      brokerAccountId: intent.brokerAccountId,
      brokerTradeId: open.id,
      mode: 'demo',
      status: 'open',
      amount: '10.00000000',
      openTimestampMs: open.openTimestamp,
      closePrice: null,
      raw: { ...open },
    });
    expect(await accept(intent, open)).toBeUndefined();
    expect(await tradesOf(intent.id)).toHaveLength(1);
  });

  it.each([
    ['mode', { isDemo: false }],
    ['asset', { assetId: 92 }],
    ['action', { action: 'down' as const }],
    ['amount', { amount: '10.5' as DecimalString }],
  ])(
    'refuses a trade that disagrees on %s and leaves the intent submitting',
    async (reason, patch) => {
      const { intent } = await submittingIntent();
      expect(await mismatchOf(accept(intent, openTradeFor(intent, patch)))).toBe(reason);
      expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({
        status: 'submitting',
        version: intent.version,
      });
      expect(await tradesOf(intent.id)).toEqual([]);
    },
  );

  // the check runs before the CAS: a caller that catches the error inside its own transaction
  // still sees the intent submitting there, with nothing written
  it("refuses a mismatching trade before the CAS, inside the caller's transaction", async () => {
    const { intent } = await submittingIntent();
    const seen = await tmp.db.transaction(async (tx) => {
      const reason = await mismatchOf(
        markIntentAccepted(tx, {
          id: intent.id,
          expectedVersion: intent.version,
          transport: 'socket',
          trade: openTradeFor(intent, { assetId: 92 }),
        }),
      );
      const [row] = await tx
        .select({ status: tradeIntents.status, version: tradeIntents.version })
        .from(tradeIntents)
        .where(eq(tradeIntents.id, intent.id));
      return { reason, row };
    });
    expect(seen).toEqual({
      reason: 'asset',
      row: { status: 'submitting', version: intent.version },
    });
  });

  it('compares the amount as a decimal, not as a spelling', async () => {
    const { intent } = await submittingIntent();
    const accepted = await accept(
      intent,
      openTradeFor(intent, { amount: '10.0' as DecimalString }),
    );
    expect(accepted?.status).toBe('accepted');
  });

  it('refuses a broker trade already linked to another intent of the account', async () => {
    const first = await acceptedIntent();
    const settled = await settle(first.intent, closedTradeFor(first.open));
    expect(settled?.status).toBe('settled');
    const second = (await take(
      (
        await createTradeIntent(
          tmp.db,
          intentRequest(first.telegramUserId, { brokerAccountId: first.brokerAccountId }),
        )
      ).intent,
    ))!;
    expect(await mismatchOf(accept(second, { ...first.open }))).toBe('trade_already_linked');
    expect(await findTradeIntent(tmp.db, second.id)).toMatchObject({ status: 'submitting' });
    expect(await tradesOf(second.id)).toEqual([]);
  });

  it('accepts from reconciling with the trade reconciliation found', async () => {
    const { intent } = await parkedIntent('reconciling');
    const accepted = await accept(intent, openTradeFor(intent), 'reconciling');
    expect(accepted).toMatchObject({ status: 'accepted', lastError: 'stale_submitting' });
    expect(await tradesOf(intent.id)).toHaveLength(1);
  });
});

describe('settleIntent (#17)', () => {
  it('settles an accepted intent, debits the token and closes the trade at a loss', async () => {
    const { intent, open, userId } = await acceptedIntent();
    const before = await userTokens(userId);
    const closed = closedTradeFor(open);
    const settled = await settle(intent, closed);
    expect(settled).toMatchObject({ status: 'settled', tokensReserved: 0n });
    expect(await settleRowsOf(intent.id)).toEqual([{ reservedDelta: -1n, balanceDelta: -1n }]);
    expect(await userTokens(userId)).toEqual({
      balance: before.balance - 1n,
      reserved: before.reserved - 1n,
    });
    const [row] = await tradesOf(intent.id);
    expect(row).toMatchObject({
      status: 'closed',
      closePrice: closed.closePrice,
      closeTimestampMs: closed.closeTimestamp,
      profit: '-10.00000000',
      raw: { ...closed },
    });

    expect(await settle(intent, closed)).toBeUndefined();
    expect(await settleRowsOf(intent.id)).toHaveLength(1);
    expect(await tradesOf(intent.id)).toHaveLength(1);
    expect(await userTokens(userId)).toEqual({
      balance: before.balance - 1n,
      reserved: before.reserved - 1n,
    });
  });

  it('refuses a closed trade other than the linked one and changes nothing', async () => {
    const { intent, open, userId } = await acceptedIntent();
    const before = await userTokens(userId);
    const other = closedTradeFor(openTradeFor(intent));
    expect(await mismatchOf(settle(intent, other))).toBe('trade_already_linked');
    expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({ status: 'accepted' });
    expect(await settleRowsOf(intent.id)).toEqual([]);
    expect(await userTokens(userId)).toEqual(before);
    expect(await tradesOf(intent.id)).toMatchObject([{ brokerTradeId: open.id, status: 'open' }]);
  });

  it("applies a same-id close as received, keeping the row's open fields", async () => {
    const { intent, open } = await acceptedIntent();
    const closed = closedTradeFor(open, { amount: '11.00' as DecimalString, action: 'down' });
    expect(await settle(intent, closed)).toMatchObject({ status: 'settled' });
    expect(await settleRowsOf(intent.id)).toEqual([{ reservedDelta: -1n, balanceDelta: -1n }]);
    expect(await tradesOf(intent.id)).toMatchObject([
      {
        brokerTradeId: open.id,
        status: 'closed',
        closePrice: closed.closePrice,
        closeTimestampMs: closed.closeTimestamp,
        profit: '-10.00000000',
        amount: '10.00000000',
        action: open.action,
      },
    ]);
  });

  it('settles a never-linked manual_review intent by inserting the closed trade', async () => {
    const { intent, userId } = await parkedIntent('manual_review');
    const before = await userTokens(userId);
    const closed = closedTradeFor(openTradeFor(intent));
    expect(await settle(intent, closed, 'manual_review')).toMatchObject({ status: 'settled' });
    expect(await tradesOf(intent.id)).toMatchObject([
      { brokerTradeId: closed.id, status: 'closed', profit: '-10.00000000', potentialProfit: null },
    ]);
    expect((await userTokens(userId)).balance).toBe(before.balance - 1n);
  });

  it('refuses a mismatching trade for a manual_review intent and inserts nothing', async () => {
    const { intent } = await parkedIntent('manual_review');
    const closed = closedTradeFor(openTradeFor(intent, { assetId: 92 }));
    expect(await mismatchOf(settle(intent, closed, 'manual_review'))).toBe('asset');
    expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({ status: 'manual_review' });
    expect(await tradesOf(intent.id)).toEqual([]);
  });

  it('lets the operator reject a manual_review intent and releases the token', async () => {
    const { intent, userId } = await parkedIntent('manual_review');
    const rejected = await tmp.db.transaction((tx) =>
      rejectIntent(tx, {
        id: intent.id,
        from: TradeIntentStatus.ManualReview,
        reason: TradeIntentFailureReason.ManualRejected,
      }),
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      lastError: 'manual_rejected',
      tokensReserved: 0n,
    });
    expect((await ledgerOf(intent.id)).map((r) => r.kind)).toEqual(['reserve', 'release']);
    expect(await tokenReservedOf(userId)).toBe(0n);
  });
});

describe('settleClosedTrades (#17)', () => {
  it('answers every trade of a batch and replays it without a second debit', async () => {
    const ours = await acceptedIntent();
    const done = await acceptedIntent();
    // one account per intent: the applier is called per account, so each gets its own batch
    await settleClosedTrades(tmp.db, {
      brokerAccountId: done.brokerAccountId,
      trades: [closedTradeFor(done.open)],
    });
    const reconciling = await parkedIntent('reconciling');
    const reconcilingOpen = openTradeFor(reconciling.intent);
    await tmp.db.insert(brokerTrades).values({
      brokerAccountId: reconciling.brokerAccountId,
      intentId: reconciling.intent.id,
      brokerTradeId: reconcilingOpen.id,
      mode: 'demo',
      assetId: reconcilingOpen.assetId,
      action: reconcilingOpen.action,
      amount: reconcilingOpen.amount,
      payout: reconcilingOpen.payout,
      openPrice: reconcilingOpen.openPrice,
      openTimestampMs: reconcilingOpen.openTimestamp,
      status: 'open',
      raw: {},
    });
    const contradicting = await acceptedIntent();

    const batch = async () => [
      ...(await settleClosedTrades(tmp.db, {
        brokerAccountId: ours.brokerAccountId,
        trades: [closedTradeFor(ours.open), closedTradeFor(openTradeFor(ours.intent))],
      })),
      ...(await settleClosedTrades(tmp.db, {
        brokerAccountId: done.brokerAccountId,
        trades: [closedTradeFor(done.open)],
      })),
      ...(await settleClosedTrades(tmp.db, {
        brokerAccountId: reconciling.brokerAccountId,
        trades: [closedTradeFor(reconcilingOpen)],
      })),
      ...(await settleClosedTrades(tmp.db, {
        brokerAccountId: contradicting.brokerAccountId,
        trades: [
          closedTradeFor(contradicting.open, {
            amount: '11.00' as DecimalString,
            action: 'down',
          }),
        ],
      })),
    ];
    const first = await batch();
    expect(first.map((o) => o.result)).toEqual([
      'settled',
      'not_ours',
      'already_settled',
      'intent_not_accepted',
      'settled',
    ]);
    expect(first[3]).toMatchObject({ status: 'reconciling' });
    expect(await findTradeIntent(tmp.db, ours.intent.id)).toMatchObject({ status: 'settled' });
    // a same-id close is applied as received, whatever its open fields say
    expect(await findTradeIntent(tmp.db, contradicting.intent.id)).toMatchObject({
      status: 'settled',
    });

    const replay = await batch();
    expect(replay.map((o) => o.result)).toEqual([
      'already_settled',
      'not_ours',
      'already_settled',
      'intent_not_accepted',
      'already_settled',
    ]);
    expect(await settleRowsOf(ours.intent.id)).toHaveLength(1);
    expect(await settleRowsOf(contradicting.intent.id)).toHaveLength(1);
  });

  // One live intent per account (trade_intents_active_account_idx) means one call can settle at
  // most one intent, so what the per-trade transaction has to guarantee is that a failing settle
  // writes nothing of itself: profit NaN passes the decimal brand but not broker_trades_profit_check.
  it('writes nothing of a settle whose last statement fails, and lets the error through', async () => {
    const ours = await acceptedIntent();
    const before = await userTokens(ours.userId);
    const error = await settleClosedTrades(tmp.db, {
      brokerAccountId: ours.brokerAccountId,
      trades: [
        closedTradeFor(openTradeFor(ours.intent)),
        closedTradeFor(ours.open, { profit: 'NaN' as DecimalString }),
      ],
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect((error as { cause?: unknown }).cause).toMatchObject({
      code: '23514',
      constraint: 'broker_trades_profit_check',
    });
    expect(await findTradeIntent(tmp.db, ours.intent.id)).toMatchObject({
      status: 'accepted',
      tokensReserved: TOKENS_PER_INTENT,
    });
    expect(await settleRowsOf(ours.intent.id)).toEqual([]);
    expect(await userTokens(ours.userId)).toEqual(before);
    expect(await tradesOf(ours.intent.id)).toMatchObject([{ status: 'open', profit: null }]);
  });
});

describe('listOverdueAcceptedIntents (#17)', () => {
  const backdate = (intentId: string, ms: number) =>
    tmp.db
      .update(brokerTrades)
      .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint - ${ms}` })
      .where(eq(brokerTrades.intentId, intentId));

  it('lists accepted intents past open time + duration + grace, oldest close first', async () => {
    // created in the opposite order of their expected close, so the order is the query's own
    const old = await acceptedIntent();
    const older = await acceptedIntent();
    const fresh = await acceptedIntent();
    const settled = await acceptedIntent();
    const closedByHand = await acceptedIntent();
    await backdate(older.intent.id, 2 * 86_400_000);
    await backdate(old.intent.id, 86_400_000);
    await backdate(settled.intent.id, 3 * 86_400_000);
    await settle(settled.intent, closedTradeFor(settled.open));
    // a closed trade under an accepted intent cannot arise through the ops (settleIntent closes
    // both in one transaction); the query still refuses to call it overdue
    await backdate(closedByHand.intent.id, 3 * 86_400_000);
    await tmp.db
      .update(brokerTrades)
      .set({ status: 'closed', closePrice: 1.1, closeTimestampMs: 1, profit: '1' as DecimalString })
      .where(eq(brokerTrades.intentId, closedByHand.intent.id));

    const listed = await listOverdueAcceptedIntents(tmp.db, { graceMs: 60_000, limit: 100 });
    const ids = listed.map((r) => r.id);
    expect(ids).not.toContain(fresh.intent.id);
    expect(ids).not.toContain(settled.intent.id);
    expect(ids).not.toContain(closedByHand.intent.id);
    expect(ids.filter((id) => id === older.intent.id || id === old.intent.id)).toEqual([
      older.intent.id,
      old.intent.id,
    ]);
    expect(listed.find((r) => r.id === old.intent.id)).toEqual({
      id: old.intent.id,
      brokerAccountId: old.brokerAccountId,
      brokerTradeId: old.open.id,
      mode: 'demo',
    });
    expect(
      (await listOverdueAcceptedIntents(tmp.db, { graceMs: 60_000, limit: 1 })).map((r) => r.id),
    ).toEqual([older.intent.id]);
    // the grace is part of the predicate: one day of grace keeps the one-day-old trade out
    const graced = await listOverdueAcceptedIntents(tmp.db, { graceMs: 86_400_000, limit: 100 });
    expect(graced.map((r) => r.id)).toContain(older.intent.id);
    expect(graced.map((r) => r.id)).not.toContain(old.intent.id);
  });

  it('leaves out the accounts the caller excludes (#90)', async () => {
    const held = await acceptedIntent();
    const other = await acceptedIntent();
    await backdate(held.intent.id, 4 * 86_400_000);
    await backdate(other.intent.id, 4 * 86_400_000);
    const ids = async (exclude?: string[]) =>
      (await listOverdueAcceptedIntents(tmp.db, { graceMs: 60_000, limit: 100, exclude })).map(
        (r) => r.id,
      );
    expect(await ids()).toEqual(expect.arrayContaining([held.intent.id, other.intent.id]));
    const excluded = await ids([held.brokerAccountId]);
    expect(excluded).not.toContain(held.intent.id);
    expect(excluded).toContain(other.intent.id);
  });
});

describe('readHeldExposure (#92)', () => {
  const money = (value: string) => value as DecimalString;
  const modeOf = async (
    brokerAccountId: string,
    mode: 'demo' | 'real',
    held?: Partial<Record<'demo' | 'real', DecimalString>>,
  ) =>
    (
      await readHeldExposure(tmp.db, { brokerAccountId, ...(held === undefined ? {} : { held }) })
    ).find((row) => row.mode === mode)!;
  const backdate = (intentId: string, ms: number) =>
    tmp.db
      .update(brokerTrades)
      .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint - ${ms}` })
      .where(eq(brokerTrades.intentId, intentId));
  // the next intent of the same account, taken and accepted with its own open trade
  async function acceptedOnAccount(telegramUserId: string) {
    const { intent: created } = await createTradeIntent(tmp.db, intentRequest(telegramUserId));
    const taken = (await take(created))!;
    const open = openTradeFor(taken);
    return { intent: (await accept(taken, open))!, open };
  }

  it('H1 answers both modes for an account with nothing open; held compares against zero', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const rows = await readHeldExposure(tmp.db, {
      brokerAccountId: seed.brokerAccountId,
      held: { demo: money('0') },
    });
    expect(rows).toEqual([
      {
        mode: 'demo',
        openTradeIds: [],
        recentIntentCount: 0,
        unresolvedIntent: false,
        settlementPending: false,
        heldExceedsOpen: false,
        readAt: expect.any(Date),
      },
      {
        mode: 'real',
        openTradeIds: [],
        recentIntentCount: 0,
        unresolvedIntent: false,
        settlementPending: false,
        heldExceedsOpen: null,
        readAt: expect.any(Date),
      },
    ]);
    expect(
      (await modeOf(seed.brokerAccountId, 'demo', { demo: money('1.5') })).heldExceedsOpen,
    ).toBe(true);
  });

  it('H2 sums only the open trades of the mode, compared as numeric', async () => {
    const first = await acceptedIntent();
    await settle(first.intent, closedTradeFor(first.open));
    const second = await acceptedOnAccount(first.telegramUserId);
    const demo = (held: string) => modeOf(first.brokerAccountId, 'demo', { demo: money(held) });

    expect((await demo('10')).openTradeIds).toEqual([second.open.id]);
    expect((await demo('10')).heldExceedsOpen).toBe(false);
    expect((await demo('10.00000001')).heldExceedsOpen).toBe(true);
    // 15 is above the open 10 and below the open + closed 20
    expect((await demo('15')).heldExceedsOpen).toBe(true);
  });

  it('H3 marks a mode whose open trade is at or past its expected close, by the database clock', async () => {
    const seed = await acceptedIntent();
    await backdate(seed.intent.id, 59_000);
    expect((await modeOf(seed.brokerAccountId, 'demo')).settlementPending).toBe(false);
    await backdate(seed.intent.id, 120_000);
    expect((await modeOf(seed.brokerAccountId, 'demo')).settlementPending).toBe(true);
  });

  it('H4 calls an intent without an open linked trade unresolved', async () => {
    const submitting = await submittingIntent();
    expect((await modeOf(submitting.brokerAccountId, 'demo')).unresolvedIntent).toBe(true);
    const parked = await parkedIntent('manual_review');
    expect((await modeOf(parked.brokerAccountId, 'demo')).unresolvedIntent).toBe(true);
    const accepted = await acceptedIntent();
    expect((await modeOf(accepted.brokerAccountId, 'demo')).unresolvedIntent).toBe(false);
  });

  it('H5 keeps the modes apart', async () => {
    const seed = await submittingIntent();
    expect(await modeOf(seed.brokerAccountId, 'real', { real: money('1') })).toEqual({
      mode: 'real',
      openTradeIds: [],
      recentIntentCount: 0,
      unresolvedIntent: false,
      settlementPending: false,
      heldExceedsOpen: true,
      readAt: expect.any(Date),
    });
  });

  it('H6 counts the recent intents of the mode, so one created between two reads shows', async () => {
    const first = await acceptedIntent();
    expect((await modeOf(first.brokerAccountId, 'demo')).recentIntentCount).toBe(1);
    await settle(first.intent, closedTradeFor(first.open));
    await createTradeIntent(tmp.db, intentRequest(first.telegramUserId));
    expect((await modeOf(first.brokerAccountId, 'demo')).recentIntentCount).toBe(2);
    // past the window an intent no longer counts: the count is bounded by it, not by history
    await tmp.db
      .update(tradeIntents)
      .set({ createdAt: sql`now() - interval '11 minutes'` })
      .where(eq(tradeIntents.id, first.intent.id));
    expect((await modeOf(first.brokerAccountId, 'demo')).recentIntentCount).toBe(1);
  });

  it('H6b counts from the bound it is given instead of its own window (#92)', async () => {
    const first = await acceptedIntent();
    await tmp.db
      .update(tradeIntents)
      .set({ createdAt: sql`now() - interval '11 minutes'` })
      .where(eq(tradeIntents.id, first.intent.id));
    expect((await modeOf(first.brokerAccountId, 'demo')).recentIntentCount).toBe(0);
    const since = new Date(Date.now() - 12 * 60_000);
    const [demo] = await readHeldExposure(tmp.db, {
      brokerAccountId: first.brokerAccountId,
      intentsSince: since,
    });
    expect(demo!.recentIntentCount).toBe(1);
  });

  it('H7 reads the database clock once, the same in both rows', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const rows = await readHeldExposure(tmp.db, { brokerAccountId: seed.brokerAccountId });
    expect(rows[0]!.readAt).toBeInstanceOf(Date);
    expect(rows[1]!.readAt.getTime()).toBe(rows[0]!.readAt.getTime());
  });
});

describe('listLinkedBrokerTradeIds (#90)', () => {
  it("answers which of the given trade ids back an intent of this account", async () => {
    const linked = await acceptedIntent();
    const foreign = await acceptedIntent();
    const ids = [linked.open.id, foreign.open.id, 'never-seen'];
    expect(
      await listLinkedBrokerTradeIds(tmp.db, {
        brokerAccountId: linked.brokerAccountId,
        brokerTradeIds: ids,
      }),
    ).toEqual(new Set([linked.open.id]));
    expect(
      await listLinkedBrokerTradeIds(tmp.db, {
        brokerAccountId: linked.brokerAccountId,
        brokerTradeIds: [],
      }),
    ).toEqual(new Set());
  });
});

describe('the transition guard seen through the ops (#17)', () => {
  it('refuses an edge outside the graph at the database even with the version bumped', async () => {
    const { intent } = await seedQueuedIntent(tmp.db);
    const error = await tmp.db
      .update(tradeIntents)
      .set({ status: 'accepted', version: sql`${tradeIntents.version} + 1` })
      .where(eq(tradeIntents.id, intent.id))
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect((error as { cause?: unknown }).cause).toMatchObject({
      code: 'P0001',
      constraint: 'trade_intents_transition_guard',
    });
    expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({ status: 'queued' });
  });
});

// --- #89: reconciliation ------------------------------------------------------------------------

const RETRY_MS = 60_000;

async function reconcilingIntent(patch: Parameters<typeof seedUnknownIntent>[1] = {}) {
  const seed = await seedUnknownIntent(tmp.db, patch);
  const intent = (await startReconciling(tmp.db, {
    id: seed.intent.id,
    expectedVersion: seed.intent.version,
  }))!;
  return { ...seed, intent };
}

async function claimedIntent() {
  const seed = await reconcilingIntent();
  const intent = (await claimReconciling(tmp.db, { id: seed.intent.id, retryMs: RETRY_MS }))!;
  return { ...seed, intent };
}

const ageClaim = (id: string, ms: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ reconcileClaimedAt: millisecondsAgo(ms) })
    .where(eq(tradeIntents.id, id));

const conclude = (intent: TradeIntentRow, trade: OpenTrade | ClosedTrade) =>
  tmp.db.transaction((tx) =>
    concludeReconciled(tx, { id: intent.id, expectedVersion: intent.version, trade }),
  );

describe('startReconciling (#89)', () => {
  it('moves an unknown intent to reconciling with the reserve kept and no claim', async () => {
    const { intent, userId } = await seedUnknownIntent(tmp.db);
    expect(
      await startReconciling(tmp.db, { id: intent.id, expectedVersion: intent.version + 1 }),
    ).toBeUndefined();
    const started = await startReconciling(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
    });
    expect(started).toMatchObject({
      status: 'reconciling',
      version: intent.version + 1,
      reconcileClaimedAt: null,
      tokensReserved: TOKENS_PER_INTENT,
    });
    expect(await tokenReservedOf(userId)).toBe(TOKENS_PER_INTENT);
    expect(
      await startReconciling(tmp.db, { id: intent.id, expectedVersion: started!.version }),
    ).toBeUndefined();
  });

  it('refuses an intent that is not unknown', async () => {
    const { intent } = await seedQueuedIntent(tmp.db);
    expect(
      await startReconciling(tmp.db, { id: intent.id, expectedVersion: intent.version }),
    ).toBeUndefined();
    expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({ status: 'queued' });
  });
});

describe('claimReconciling (#89)', () => {
  it('claims once per lease on the database clock and bumps the version', async () => {
    const { intent } = await reconcilingIntent();
    const claimed = await claimReconciling(tmp.db, { id: intent.id, retryMs: RETRY_MS });
    expect(claimed).toMatchObject({ status: 'reconciling', version: intent.version + 1 });
    expect(Math.abs(claimed!.reconcileClaimedAt!.getTime() - Date.now())).toBeLessThan(
      INTEGRATION_WAIT_CEILING_MS,
    );
    expect(await claimReconciling(tmp.db, { id: intent.id, retryMs: RETRY_MS })).toBeUndefined();
    await ageClaim(intent.id, RETRY_MS + 1_000);
    expect(await claimReconciling(tmp.db, { id: intent.id, retryMs: RETRY_MS })).toMatchObject({
      version: intent.version + 2,
    });
  });

  it('refuses an intent that is not reconciling', async () => {
    const { intent } = await seedUnknownIntent(tmp.db);
    expect(await claimReconciling(tmp.db, { id: intent.id, retryMs: RETRY_MS })).toBeUndefined();
    expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({
      status: 'unknown',
      version: intent.version,
      reconcileClaimedAt: null,
    });
  });
});

describe('listReconcilingCandidates (#89)', () => {
  it('lists never-claimed first, then lapsed claims, and skips live claims and other statuses', async () => {
    const a = await claimedIntent();
    await ageClaim(a.intent.id, 120_000);
    const b = await reconcilingIntent();
    const c = await claimedIntent();
    await ageClaim(c.intent.id, 10_000);
    const d = await seedUnknownIntent(tmp.db);
    const ours = new Set([a.intent.id, b.intent.id, c.intent.id, d.intent.id]);
    const listed = async (limit: number) =>
      (await listReconcilingCandidates(tmp.db, { retryMs: RETRY_MS, limit }))
        .map(({ id }) => id)
        .filter((id) => ours.has(id));
    expect(await listed(1_000)).toEqual([b.intent.id, a.intent.id]);
    // never-claimed rows of other cases sort first too, so the limit is checked on the head
    const [head] = await listReconcilingCandidates(tmp.db, { retryMs: RETRY_MS, limit: 1 });
    expect((await findTradeIntent(tmp.db, head!.id))?.reconcileClaimedAt ?? null).toBeNull();
  });
});

describe('concludeReconciled (#89)', () => {
  it('accepts with an open trade, keeps the reserve and the transport as found', async () => {
    const { intent, userId } = await claimedIntent();
    const open = openTradeFor(intent);
    expect(await conclude({ ...intent, version: intent.version - 1 }, open)).toBeUndefined();
    expect(await tradesOf(intent.id)).toEqual([]);
    const accepted = await conclude(intent, open);
    expect(accepted).toMatchObject({
      status: 'accepted',
      version: intent.version + 1,
      transport: null,
      tokensReserved: TOKENS_PER_INTENT,
    });
    expect(await tradesOf(intent.id)).toMatchObject([
      { brokerTradeId: open.id, status: 'open', potentialProfit: '10.00000000' },
    ]);
    expect((await ledgerOf(intent.id)).map(({ kind }) => kind)).toEqual(['reserve']);
    expect(await tokenReservedOf(userId)).toBe(TOKENS_PER_INTENT);
  });

  it('keeps a transport the executor recorded', async () => {
    const { intent } = await claimedIntent();
    await tmp.db
      .update(tradeIntents)
      .set({ transport: 'socket' })
      .where(eq(tradeIntents.id, intent.id));
    expect(await conclude(intent, openTradeFor(intent))).toMatchObject({
      status: 'accepted',
      transport: 'socket',
    });
  });

  it('accepts and settles a closed trade in one transaction', async () => {
    const { intent, userId } = await claimedIntent();
    const before = await userTokens(userId);
    const closed = closedTradeFor(openTradeFor(intent));
    const settled = await conclude(intent, closed);
    expect(settled).toMatchObject({
      status: 'settled',
      version: intent.version + 2,
      tokensReserved: 0n,
    });
    expect(await settleRowsOf(intent.id)).toEqual([
      { reservedDelta: -TOKENS_PER_INTENT, balanceDelta: -TOKENS_PER_INTENT },
    ]);
    expect(await userTokens(userId)).toEqual({
      balance: before.balance - TOKENS_PER_INTENT,
      reserved: before.reserved - TOKENS_PER_INTENT,
    });
    expect(await tradesOf(intent.id)).toMatchObject([
      {
        brokerTradeId: closed.id,
        status: 'closed',
        profit: '-10.00000000',
        closePrice: closed.closePrice,
        closeTimestampMs: closed.closeTimestamp,
        potentialProfit: null,
      },
    ]);
    expect(await conclude(intent, closed)).toBeUndefined();
    expect(await settleRowsOf(intent.id)).toHaveLength(1);
    expect(await tradesOf(intent.id)).toHaveLength(1);
  });

  it('refuses a trade of another asset and rolls the acceptance back', async () => {
    const { intent } = await claimedIntent();
    expect(await mismatchOf(conclude(intent, openTradeFor(intent, { assetId: 92 })))).toBe('asset');
    expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({
      status: 'reconciling',
      version: intent.version,
    });
    expect(await tradesOf(intent.id)).toEqual([]);
  });

  it('refuses a trade already linked to another intent of the account', async () => {
    const first = await acceptedIntent();
    expect((await settle(first.intent, closedTradeFor(first.open)))?.status).toBe('settled');
    const { intent: unknown } = await (async () => {
      const created = await createTradeIntent(
        tmp.db,
        intentRequest(first.telegramUserId, { brokerAccountId: first.brokerAccountId }),
      );
      const taken = (await take(created.intent))!;
      return {
        intent: (await tmp.db.transaction((tx) =>
          markIntentUnknown(tx, {
            id: taken.id,
            expectedVersion: taken.version,
            reason: TradeIntentFailureReason.ExecutorTimeout,
          }),
        ))!,
      };
    })();
    const reconciling = (await startReconciling(tmp.db, {
      id: unknown.id,
      expectedVersion: unknown.version,
    }))!;
    expect(await mismatchOf(conclude(reconciling, { ...first.open }))).toBe('trade_already_linked');
    expect(await findTradeIntent(tmp.db, reconciling.id)).toMatchObject({
      status: 'reconciling',
    });
    expect(await tradesOf(reconciling.id)).toEqual([]);
  });
});

describe('markIntentManualReview (#89)', () => {
  it('parks the intent with the reserve kept, then the operator may still reject it', async () => {
    const { intent, userId } = await claimedIntent();
    const reason = TradeIntentFailureReason.ReconciliationAmbiguous;
    expect(
      await markIntentManualReview(tmp.db, {
        id: intent.id,
        expectedVersion: intent.version + 1,
        reason,
      }),
    ).toBeUndefined();
    const parked = await markIntentManualReview(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
      reason,
    });
    expect(parked).toMatchObject({
      status: 'manual_review',
      lastError: 'reconciliation_ambiguous',
      tokensReserved: TOKENS_PER_INTENT,
      version: intent.version + 1,
    });
    expect((await ledgerOf(intent.id)).map(({ kind }) => kind)).toEqual(['reserve']);
    const rejected = await tmp.db.transaction((tx) =>
      rejectIntent(tx, {
        id: intent.id,
        from: TradeIntentStatus.ManualReview,
        reason: TradeIntentFailureReason.ManualRejected,
      }),
    );
    expect(rejected).toMatchObject({ status: 'rejected', lastError: 'manual_rejected' });
    expect(await tokenReservedOf(userId)).toBe(0n);
  });
});

describe('haltAccountForManualReview (#90)', () => {
  const accountOf = async (id: string) =>
    (
      await tmp.db
        .select({ halted: brokerAccounts.tradingHalted, reason: brokerAccounts.haltedReason })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, id))
    )[0]!;
  const halt = (intent: { id: string; version: number }, reason: ManualReviewReason) =>
    tmp.db.transaction((tx) =>
      haltAccountForManualReview(tx, { id: intent.id, expectedVersion: intent.version, reason }),
    );

  it.each([
    [TradeIntentFailureReason.ReconciliationAmbiguous, AccountHaltReason.ReconciliationAmbiguous],
    [TradeIntentFailureReason.ReconciliationNotFound, AccountHaltReason.ReconciliationNotFound],
    [TradeIntentFailureReason.TradeMismatch, AccountHaltReason.TradeMismatch],
  ] as const)('parks the intent and halts the account for %s', async (reason, haltReason) => {
    const { intent, brokerAccountId, userId } = await claimedIntent();
    const parked = await halt(intent, reason);
    expect(parked).toMatchObject({ status: 'manual_review', lastError: reason });
    expect(await accountOf(brokerAccountId)).toEqual({ halted: true, reason: haltReason });
    expect(await tokenReservedOf(userId)).toBe(TOKENS_PER_INTENT);
  });

  it('writes nothing when the CAS is lost', async () => {
    const { intent, brokerAccountId } = await claimedIntent();
    expect(
      await halt({ id: intent.id, version: intent.version + 1 }, 'reconciliation_ambiguous'),
    ).toBeUndefined();
    expect(await accountOf(brokerAccountId)).toEqual({ halted: false, reason: null });
    expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({ status: 'reconciling' });
  });

  it('rolls the halt back with the transaction it ran in', async () => {
    const { intent, brokerAccountId } = await claimedIntent();
    const rollback = new Error('rollback');
    await expect(
      tmp.db.transaction(async (tx) => {
        await haltAccountForManualReview(tx, {
          id: intent.id,
          expectedVersion: intent.version,
          reason: TradeIntentFailureReason.TradeMismatch,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await accountOf(brokerAccountId)).toEqual({ halted: false, reason: null });
    expect(await findTradeIntent(tmp.db, intent.id)).toMatchObject({ status: 'reconciling' });
  });

  it('overwrites the reason on an account that is already halted', async () => {
    const { intent, brokerAccountId } = await claimedIntent();
    await tmp.db
      .update(brokerAccounts)
      .set({ tradingHalted: true, haltedReason: AccountHaltReason.ReconciliationAmbiguous })
      .where(eq(brokerAccounts.id, brokerAccountId));
    await halt(intent, TradeIntentFailureReason.TradeMismatch);
    expect(await accountOf(brokerAccountId)).toEqual({
      halted: true,
      reason: AccountHaltReason.TradeMismatch,
    });
  });

  // A creator holds broker_accounts FOR NO KEY UPDATE and then touches the account's active
  // intent (its INSERT waits on the active-intent index). A halt that updated the intent before
  // locking the account would wait on the creator while the creator waits on it (40P01). Here the
  // creator is played by a transaction that holds the account lock until the halt is queued
  // behind it, then locks the intent row.
  it('locks the account before touching the intent, so a creator holding it finishes first', async () => {
    const { intent, brokerAccountId } = await claimedIntent();
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => (lockTaken = resolve));
    let releaseHolder!: () => void;
    const released = new Promise<void>((resolve) => (releaseHolder = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await tx
        .select({ id: brokerAccounts.id })
        .from(brokerAccounts)
        .where(eq(brokerAccounts.id, brokerAccountId))
        .for('no key update');
      lockTaken();
      await released;
      await tx
        .select({ id: tradeIntents.id })
        .from(tradeIntents)
        .where(eq(tradeIntents.id, intent.id))
        .for('update');
    });
    await taken;
    const halting = halt(intent, TradeIntentFailureReason.ReconciliationAmbiguous);
    await until('the halt to queue behind the account lock', async () => {
      const { rows } = await tmp.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return (rows[0]?.waiting ?? 0) > 0;
    });
    releaseHolder();
    const [held, halted] = await Promise.allSettled([holder, halting]);
    expect(held.status).toBe('fulfilled');
    expect(halted.status === 'fulfilled' && halted.value?.status).toBe('manual_review');
    expect(await accountOf(brokerAccountId)).toEqual({
      halted: true,
      reason: AccountHaltReason.ReconciliationAmbiguous,
    });
  });
});

describe('rejectIntent from reconciling (#89)', () => {
  it('releases the reserve on reconciliation_not_found', async () => {
    const { intent, userId } = await claimedIntent();
    const rejected = await tmp.db.transaction((tx) =>
      rejectIntent(tx, {
        id: intent.id,
        from: TradeIntentStatus.Reconciling,
        expectedVersion: intent.version,
        reason: TradeIntentFailureReason.ReconciliationNotFound,
      }),
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      lastError: 'reconciliation_not_found',
      tokensReserved: 0n,
    });
    expect(await ledgerOf(intent.id)).toEqual([
      { kind: 'reserve', reservedDelta: TOKENS_PER_INTENT },
      { kind: 'release', reservedDelta: -TOKENS_PER_INTENT },
    ]);
    expect(await tokenReservedOf(userId)).toBe(0n);
  });
});
