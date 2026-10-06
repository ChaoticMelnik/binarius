import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  type ClosedTrade,
  type DecimalString,
  type OpenTrade,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import {
  createTempDatabase,
  intentRequest,
  seedBrokerAccount,
  seedQueuedIntent,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from './testing';
import {
  TOKENS_PER_INTENT,
  TradeIntentError,
  TradeIntentMismatchError,
  createTradeIntent,
  findTradeIntent,
  getTradeIntentView,
  listOverdueAcceptedIntents,
  listStaleSubmittingIntents,
  markIntentAccepted,
  millisecondsAgo,
  markIntentUnknown,
  rejectExpiredIntent,
  rejectIntent,
  settleClosedTrades,
  settleIntent,
  takeIntent,
  transitionIntent,
  uniqueViolation,
  type TradeIntentRow,
  type TradePolicy,
} from './trade-intent-ops';
import {
  brokerAccounts,
  brokerTrades,
  outboxEvents,
  tokenLedger,
  tradeIntents,
  users,
} from './schema/index';

// Integration tests on a temporary migrated database (README → Database). Rows are committed
// for real: concurrency cases need separate connections, and token_ledger is append-only.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const MAX_AGE_MS = 60_000;
const flagOff: TradePolicy = { realTradingEnabled: false };
const flagOn: TradePolicy = { realTradingEnabled: true };

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
    const { intent, created } = await createTradeIntent(tmp.db, input, flagOff);

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
    const first = await createTradeIntent(tmp.db, input, flagOff);
    const second = await createTradeIntent(
      tmp.db,
      {
        ...input,
        amount: '10.000' as DecimalString,
      },
      flagOff,
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
    const first = await createTradeIntent(tmp.db, input, flagOff);

    await tmp.db
      .update(brokerAccounts)
      .set({ status: 'revoked' })
      .where(eq(brokerAccounts.id, s.brokerAccountId));
    expect((await createTradeIntent(tmp.db, input, flagOff)).intent.id).toBe(first.intent.id);

    await seedBrokerAccount(tmp.db, s.userId);
    await seedBrokerAccount(tmp.db, s.userId);
    expect((await createTradeIntent(tmp.db, input, flagOff)).intent.id).toBe(first.intent.id);
  });

  it('rejects a reused clientRequestId with different parameters', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    await createTradeIntent(tmp.db, input, flagOff);
    await failsWith(
      createTradeIntent(tmp.db, { ...input, action: 'down' }, flagOff),
      'client_request_id_conflict',
    );
  });

  it('treats the same clientRequestId on another account as a conflict, not a replay', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const other = await seedBrokerAccount(tmp.db, s.userId);
    const input = intentRequest(s.telegramUserId, { brokerAccountId: s.brokerAccountId });
    const first = await createTradeIntent(tmp.db, input, flagOff);

    await failsWith(
      createTradeIntent(tmp.db, { ...input, brokerAccountId: other }, flagOff),
      'client_request_id_conflict',
    );
    // without an account the retry is a replay whatever account the original used
    const withoutAccount = intentRequest(s.telegramUserId, {
      clientRequestId: input.clientRequestId,
    });
    expect((await createTradeIntent(tmp.db, withoutAccount, flagOff)).intent.id).toBe(
      first.intent.id,
    );
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
    expect(await ledgerOf(first.intent.id)).toHaveLength(1);
  });

  it('refuses without available tokens and writes nothing', async () => {
    const s = await seedUserWithAccount(tmp.db, { balance: 0n });
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff),
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
    await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff),
      // the active-intent index would also refuse; the token guard runs first
      'insufficient_tokens',
    );
  });

  it('refuses a blocked user through the reserve guard', async () => {
    const user = await seedUser(tmp.db, { status: 'blocked' });
    await seedBrokerAccount(tmp.db, user.userId);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(user.telegramUserId), flagOff),
      'user_blocked',
    );
    expect(await tokenReservedOf(user.userId)).toBe(0n);
  });

  it('allows one active intent per account', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff),
      'active_intent_exists',
    );
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
  });

  it.each([
    ['revoked', { status: 'revoked' as const }, 'account_revoked'],
    ['halted', { tradingHalted: true }, 'account_halted'],
    // linked but not confirmed in the bot: a distinct answer, because the user can fix it
    ['pending', { status: 'pending' as const }, 'account_not_confirmed'],
  ])('refuses a %s account', async (_label, patch, code) => {
    const user = await seedUser(tmp.db);
    const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId, patch);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(user.telegramUserId, { brokerAccountId }), flagOff),
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
      createTradeIntent(tmp.db, intentRequest(user.telegramUserId, { brokerAccountId }), flagOff),
      'account_not_confirmed',
    );
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(user.telegramUserId), flagOff),
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
      createTradeIntent(tmp.db, intentRequest('999999999'), flagOff),
      'user_not_found',
    );

    const lonely = await seedUser(tmp.db);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(lonely.telegramUserId), flagOff),
      'broker_account_not_found',
    );

    const other = await seedUserWithAccount(tmp.db);
    await failsWith(
      createTradeIntent(
        tmp.db,
        intentRequest(lonely.telegramUserId, { brokerAccountId: other.brokerAccountId }),
        flagOff,
      ),
      'broker_account_not_found',
    );

    const twoAccounts = await seedUserWithAccount(tmp.db);
    await seedBrokerAccount(tmp.db, twoAccounts.userId);
    await failsWith(
      createTradeIntent(tmp.db, intentRequest(twoAccounts.telegramUserId), flagOff),
      'ambiguous_broker_account',
    );
    expect(
      (
        await createTradeIntent(
          tmp.db,
          intentRequest(twoAccounts.telegramUserId, {
            brokerAccountId: twoAccounts.brokerAccountId,
          }),
          flagOff,
        )
      ).created,
    ).toBe(true);
  });

  it('serves concurrent identical requests one intent and one reserve', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = intentRequest(s.telegramUserId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createTradeIntent(tmp.db, input, flagOff)),
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
        createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff),
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
          flagOff,
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
      const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff);
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
        createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff),
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
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff);
    expect(await take({ id: intent.id, version: intent.version - 1 })).toBeUndefined();
    const taken = await take(intent);
    expect(taken).toMatchObject({ status: 'submitting', version: intent.version + 1 });
    expect(taken!.submittedAt).toBeInstanceOf(Date);
    expect(await take(intent)).toBeUndefined();
  });

  it('expires an old queued intent on the database clock and releases the token', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff);
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
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff);
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
      (await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff)).created,
    ).toBe(true);
  });

  it('refuses to release below the cached reserve instead of desynchronizing', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff);
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
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId), flagOff);
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
      (await createTradeIntent(tmp.db, intentRequest(stale.telegramUserId), flagOff)).intent,
    ))!;
    const freshIntent = (await take(
      (await createTradeIntent(tmp.db, intentRequest(fresh.telegramUserId), flagOff)).intent,
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
    const { intent } = await createTradeIntent(tmp.db, input, flagOff);
    const view = await getTradeIntentView(tmp.db, intent.id);
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
      await getTradeIntentView(tmp.db, '00000000-0000-0000-0000-000000000000'),
    ).toBeUndefined();
  });
});

describe('createTradeIntent: the real-mode grant (#134)', () => {
  const real = (telegramUserId: string, patch: Parameters<typeof intentRequest>[1] = {}) =>
    intentRequest(telegramUserId, { mode: TradeMode.Real, ...patch });

  const userLedger = (userId: string) =>
    tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, userId));

  it('refuses a real intent with the flag off and leaves no trace', async () => {
    const s = await seedUserWithAccount(tmp.db);
    await failsWith(
      createTradeIntent(tmp.db, real(s.telegramUserId), flagOff),
      'real_trading_disabled',
    );
    expect(
      await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, s.userId)),
    ).toEqual([]);
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(await userLedger(s.userId)).toEqual([]);
  });

  it('creates a real intent with the flag on', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent, created } = await createTradeIntent(tmp.db, real(s.telegramUserId), flagOn);
    expect(created).toBe(true);
    expect(intent).toMatchObject({ mode: 'real', status: 'queued' });
  });

  it('replays a real intent created while on after the flag went off', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const input = real(s.telegramUserId);
    const first = await createTradeIntent(tmp.db, input, flagOn);
    const again = await createTradeIntent(tmp.db, input, flagOff);
    expect(again.created).toBe(false);
    expect(again.intent.id).toBe(first.intent.id);
  });

  // the gate runs before resolveAccount: a foreign account would otherwise answer
  // broker_account_not_found
  it('refuses before reading the account', async () => {
    const lonely = await seedUser(tmp.db);
    const other = await seedUserWithAccount(tmp.db);
    await failsWith(
      createTradeIntent(
        tmp.db,
        real(lonely.telegramUserId, { brokerAccountId: other.brokerAccountId }),
        flagOff,
      ),
      'real_trading_disabled',
    );
  });

  it('leaves demo alone with the flag off', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent, created } = await createTradeIntent(
      tmp.db,
      intentRequest(s.telegramUserId),
      flagOff,
    );
    expect(created).toBe(true);
    expect(intent.mode).toBe('demo');
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
          flagOff,
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
        trades: [closedTradeFor(contradicting.open, { amount: '11.00' as DecimalString })],
      })),
    ];
    const first = await batch();
    expect(first.map((o) => o.result)).toEqual([
      'settled',
      'not_ours',
      'already_settled',
      'intent_not_accepted',
      'mismatch',
    ]);
    expect(first[3]).toMatchObject({ status: 'reconciling' });
    expect(first[4]).toMatchObject({ reason: 'amount' });
    expect(await findTradeIntent(tmp.db, ours.intent.id)).toMatchObject({ status: 'settled' });
    expect(await findTradeIntent(tmp.db, contradicting.intent.id)).toMatchObject({
      status: 'accepted',
    });

    const replay = await batch();
    expect(replay.map((o) => o.result)).toEqual([
      'already_settled',
      'not_ours',
      'already_settled',
      'intent_not_accepted',
      'mismatch',
    ]);
    expect(await settleRowsOf(ours.intent.id)).toHaveLength(1);
  });

  it('applies each trade on its own: a mismatch does not stop the rest of the batch', async () => {
    const ours = await acceptedIntent();
    const closed = closedTradeFor(ours.open);
    const outcomes = await settleClosedTrades(tmp.db, {
      brokerAccountId: ours.brokerAccountId,
      trades: [{ ...closed, action: 'down' }, closed],
    });
    expect(outcomes.map((o) => o.result)).toEqual(['mismatch', 'settled']);
    expect(await findTradeIntent(tmp.db, ours.intent.id)).toMatchObject({ status: 'settled' });
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
