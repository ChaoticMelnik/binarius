import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TradeIntentFailureReason, type CreateTradeIntentRequest } from '@binarius/shared';
import type { DecimalString } from '@binarius/shared';
import { createTempDatabase, type TempDatabase } from './testing';
import {
  TOKENS_PER_INTENT,
  TradeIntentError,
  createTradeIntent,
  findTradeIntent,
  getTradeIntentView,
  markIntentAccepted,
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

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

let seq = 0;
async function seedUser(balance = 5n, status: 'active' | 'blocked' = 'active') {
  const telegramUserId = BigInt(700_000 + ++seq);
  const [user] = await tmp.db
    .insert(users)
    .values({ telegramUserId, tokenBalance: balance, status })
    .returning({ id: users.id });
  return { userId: user!.id, telegramUserId: telegramUserId.toString() };
}

async function seedAccount(
  userId: string,
  patch: Partial<typeof brokerAccounts.$inferInsert> = {},
) {
  const [account] = await tmp.db
    .insert(brokerAccounts)
    .values({
      userId,
      brokerUserId: `broker-${++seq}`,
      accessTokenEnc: Buffer.from('enc'),
      refreshTokenEnc: Buffer.from('enc'),
      tokenKeyId: 'k1',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      ...patch,
    })
    .returning({ id: brokerAccounts.id });
  return account!.id;
}

async function seed(balance?: bigint) {
  const user = await seedUser(balance);
  const accountId = await seedAccount(user.userId);
  return { ...user, accountId };
}

const request = (
  telegramUserId: string,
  patch: Partial<CreateTradeIntentRequest> = {},
): CreateTradeIntentRequest => ({
  telegramUserId,
  mode: 'demo',
  assetId: 91,
  amount: '10.00' as DecimalString,
  action: 'up',
  durationSec: 60,
  clientRequestId: `req-${++seq}`,
  ...patch,
});

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

// the worker's "expired" branch needs an old row; created_at is not append-only
const ageIntent = (id: string, ms: number) =>
  tmp.db
    .update(tradeIntents)
    .set({ createdAt: sql`now() - (${ms}::int * interval '1 millisecond')` })
    .where(eq(tradeIntents.id, id));

describe('createTradeIntent', () => {
  it('reserves a token and queues the intent in one go', async () => {
    const s = await seed();
    const input = request(s.telegramUserId);
    const { intent, created } = await createTradeIntent(tmp.db, input);

    expect(created).toBe(true);
    expect(intent).toMatchObject({
      brokerAccountId: s.accountId,
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
    const s = await seed();
    const input = request(s.telegramUserId);
    const first = await createTradeIntent(tmp.db, input);
    const second = await createTradeIntent(tmp.db, { ...input, amount: '10.000' as DecimalString });

    expect(second.created).toBe(false);
    expect(second.intent.id).toBe(first.intent.id);
    expect(second.intent.version).toBe(first.intent.version);
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
    expect(await ledgerOf(first.intent.id)).toHaveLength(1);
  });

  it('replays after the account was revoked and after a second account appeared', async () => {
    const s = await seed();
    const input = request(s.telegramUserId);
    const first = await createTradeIntent(tmp.db, input);

    await tmp.db
      .update(brokerAccounts)
      .set({ status: 'revoked' })
      .where(eq(brokerAccounts.id, s.accountId));
    expect((await createTradeIntent(tmp.db, input)).intent.id).toBe(first.intent.id);

    await seedAccount(s.userId);
    await seedAccount(s.userId);
    expect((await createTradeIntent(tmp.db, input)).intent.id).toBe(first.intent.id);
  });

  it('rejects a reused clientRequestId with different parameters', async () => {
    const s = await seed();
    const input = request(s.telegramUserId);
    await createTradeIntent(tmp.db, input);
    await failsWith(
      createTradeIntent(tmp.db, { ...input, action: 'down' }),
      'client_request_id_conflict',
    );
  });

  it('refuses without available tokens and writes nothing', async () => {
    const s = await seed(0n);
    await failsWith(createTradeIntent(tmp.db, request(s.telegramUserId)), 'insufficient_tokens');
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(
      await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.userId, s.userId)),
    ).toEqual([]);
    expect(await tmp.db.select().from(tokenLedger).where(eq(tokenLedger.userId, s.userId))).toEqual(
      [],
    );
  });

  it('counts already reserved tokens against the balance', async () => {
    const s = await seed(1n);
    await createTradeIntent(tmp.db, request(s.telegramUserId));
    await failsWith(
      createTradeIntent(tmp.db, request(s.telegramUserId)),
      // the active-intent index would also refuse; the token guard runs first
      'insufficient_tokens',
    );
  });

  it('refuses a blocked user through the reserve guard', async () => {
    const user = await seedUser(5n, 'blocked');
    await seedAccount(user.userId);
    await failsWith(createTradeIntent(tmp.db, request(user.telegramUserId)), 'user_blocked');
    expect(await tokenReservedOf(user.userId)).toBe(0n);
  });

  it('allows one active intent per account', async () => {
    const s = await seed();
    await createTradeIntent(tmp.db, request(s.telegramUserId));
    await failsWith(createTradeIntent(tmp.db, request(s.telegramUserId)), 'active_intent_exists');
    expect(await tokenReservedOf(s.userId)).toBe(TOKENS_PER_INTENT);
  });

  it.each([
    ['revoked', { status: 'revoked' as const }, 'account_revoked'],
    ['halted', { tradingHalted: true }, 'account_halted'],
  ])('refuses a %s account', async (_label, patch, code) => {
    const user = await seedUser();
    const accountId = await seedAccount(user.userId, patch);
    await failsWith(
      createTradeIntent(tmp.db, request(user.telegramUserId, { brokerAccountId: accountId })),
      code,
    );
    expect(await tokenReservedOf(user.userId)).toBe(0n);
  });

  it('classifies lookups: unknown user, no account, foreign account, ambiguous account', async () => {
    await failsWith(createTradeIntent(tmp.db, request('999999999')), 'user_not_found');

    const lonely = await seedUser();
    await failsWith(
      createTradeIntent(tmp.db, request(lonely.telegramUserId)),
      'broker_account_not_found',
    );

    const other = await seed();
    await failsWith(
      createTradeIntent(
        tmp.db,
        request(lonely.telegramUserId, { brokerAccountId: other.accountId }),
      ),
      'broker_account_not_found',
    );

    const twoAccounts = await seed();
    await seedAccount(twoAccounts.userId);
    await failsWith(
      createTradeIntent(tmp.db, request(twoAccounts.telegramUserId)),
      'ambiguous_broker_account',
    );
    expect(
      (
        await createTradeIntent(
          tmp.db,
          request(twoAccounts.telegramUserId, { brokerAccountId: twoAccounts.accountId }),
        )
      ).created,
    ).toBe(true);
  });

  it('serves concurrent identical requests one intent and one reserve', async () => {
    const s = await seed();
    const input = request(s.telegramUserId);
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
    const s = await seed();
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => createTradeIntent(tmp.db, request(s.telegramUserId))),
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
    const s = await seed();
    const { intent } = await createTradeIntent(tmp.db, request(s.telegramUserId));
    expect(
      await takeIntent(tmp.db, {
        id: intent.id,
        expectedVersion: intent.version - 1,
        maxAgeMs: 60_000,
      }),
    ).toBeUndefined();
    const taken = await takeIntent(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
      maxAgeMs: 60_000,
    });
    expect(taken).toMatchObject({ status: 'submitting', version: intent.version + 1 });
    expect(taken!.submittedAt).toBeInstanceOf(Date);
    expect(
      await takeIntent(tmp.db, {
        id: intent.id,
        expectedVersion: intent.version,
        maxAgeMs: 60_000,
      }),
    ).toBeUndefined();
  });

  it('expires an old queued intent on the database clock and releases the token', async () => {
    const s = await seed();
    const { intent } = await createTradeIntent(tmp.db, request(s.telegramUserId));
    await expect(
      tmp.db.transaction((tx) =>
        rejectExpiredIntent(tx, {
          id: intent.id,
          expectedVersion: intent.version,
          maxAgeMs: 60_000,
        }),
      ),
    ).resolves.toBeUndefined();

    await ageIntent(intent.id, 120_000);
    expect(
      await takeIntent(tmp.db, {
        id: intent.id,
        expectedVersion: intent.version,
        maxAgeMs: 60_000,
      }),
    ).toBeUndefined();
    const expired = await tmp.db.transaction((tx) =>
      rejectExpiredIntent(tx, { id: intent.id, expectedVersion: intent.version, maxAgeMs: 60_000 }),
    );
    expect(expired).toMatchObject({ status: 'rejected', lastError: 'expired', tokensReserved: 0n });
    expect(await tokenReservedOf(s.userId)).toBe(0n);
    expect(await ledgerOf(intent.id)).toEqual([
      { kind: 'reserve', reservedDelta: TOKENS_PER_INTENT },
      { kind: 'release', reservedDelta: -TOKENS_PER_INTENT },
    ]);
  });

  it('rejects a submitting intent once, releasing the reserve exactly once', async () => {
    const s = await seed();
    const { intent } = await createTradeIntent(tmp.db, request(s.telegramUserId));
    const taken = (await takeIntent(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
      maxAgeMs: 60_000,
    }))!;
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
    expect((await createTradeIntent(tmp.db, request(s.telegramUserId))).created).toBe(true);
  });

  it('refuses to release below the cached reserve instead of desynchronizing', async () => {
    const s = await seed();
    const { intent } = await createTradeIntent(tmp.db, request(s.telegramUserId));
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
    const s = await seed();
    const { intent } = await createTradeIntent(tmp.db, request(s.telegramUserId));
    const taken = (await takeIntent(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
      maxAgeMs: 60_000,
    }))!;

    await expect(
      tmp.db.transaction((tx) =>
        markIntentUnknown(tx, {
          id: intent.id,
          reason: TradeIntentFailureReason.StaleSubmitting,
          olderThanMs: 60_000,
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
    const s = await seed();
    const { intent } = await createTradeIntent(tmp.db, request(s.telegramUserId));
    const taken = (await takeIntent(tmp.db, {
      id: intent.id,
      expectedVersion: intent.version,
      maxAgeMs: 60_000,
    }))!;
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
});

describe('getTradeIntentView', () => {
  it('maps the row to the wire shape with nullable fields and string bigints', async () => {
    const s = await seed();
    const input = request(s.telegramUserId);
    const { intent } = await createTradeIntent(tmp.db, input);
    const view = await getTradeIntentView(tmp.db, intent.id);
    expect(view).toEqual({
      id: intent.id,
      brokerAccountId: s.accountId,
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
