import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TradeIntentFailureReason, type DecimalString } from '@binarius/shared';
import {
  createTempDatabase,
  intentRequest,
  seedBrokerAccount,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from './testing';
import {
  TOKENS_PER_INTENT,
  TradeIntentError,
  createTradeIntent,
  findTradeIntent,
  getTradeIntentView,
  listStaleSubmittingIntents,
  markIntentAccepted,
  millisecondsAgo,
  markIntentUnknown,
  rejectExpiredIntent,
  rejectIntent,
  takeIntent,
  transitionIntent,
  uniqueViolation,
} from './trade-intent-ops';
import { brokerAccounts, outboxEvents, tokenLedger, tradeIntents, users } from './schema/index';

// Integration tests on a temporary migrated database (README → Database). Rows are committed
// for real: concurrency cases need separate connections, and token_ledger is append-only.
const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for packages/db integration tests (see README)');
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
    const second = await createTradeIntent(tmp.db, {
      ...input,
      amount: '10.000' as DecimalString,
    });

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
    expect((await createTradeIntent(tmp.db, withoutAccount)).intent.id).toBe(first.intent.id);
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
    await failsWith(createTradeIntent(tmp.db, intentRequest(user.telegramUserId)), 'user_blocked');
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
    ['halted', { tradingHalted: true }, 'account_halted'],
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
    await failsWith(createTradeIntent(tmp.db, intentRequest('999999999')), 'user_not_found');

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
      Array.from({ length: 4 }, () => createTradeIntent(tmp.db, intentRequest(s.telegramUserId))),
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
    expect((await createTradeIntent(tmp.db, intentRequest(s.telegramUserId))).created).toBe(true);
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

  it('accepts with the transport that carried the order', async () => {
    const s = await seedUserWithAccount(tmp.db);
    const { intent } = await createTradeIntent(tmp.db, intentRequest(s.telegramUserId));
    const taken = (await take(intent))!;
    const accepted = await markIntentAccepted(tmp.db, {
      id: intent.id,
      expectedVersion: taken.version,
      transport: 'socket',
    });
    expect(accepted).toMatchObject({
      status: 'accepted',
      transport: 'socket',
      tokensReserved: TOKENS_PER_INTENT,
    });
    expect(
      await markIntentAccepted(tmp.db, { id: intent.id, expectedVersion: taken.version }),
    ).toBeUndefined();
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
