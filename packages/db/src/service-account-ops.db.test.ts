import { randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountHaltReason,
  AuthRevokedReason,
  BrokerAccountStatus,
  UserStatus,
} from '@binarius/shared';
import { brokerAccounts } from './schema/index';
import {
  listServiceAccountStates,
  listServiceBrokerAccounts,
  listServiceRenewalCandidates,
  setServiceMark,
} from './service-account-ops';
import {
  brokerAccountRow,
  createTempDatabase,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from './testing';

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

// every case starts with no service account in this file's database, and with every earlier
// case's account far from due, so a case sees only the rows it made
beforeEach(async () => {
  await tmp.db
    .update(brokerAccounts)
    .set({ serviceSince: null, accessTokenExpiresAt: sql`now() + interval '30 days'` });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const at = (expression: string): SQL => sql.raw(expression);

async function account(
  patch: {
    userStatus?: UserStatus;
    status?: BrokerAccountStatus;
    serviceSince?: SQL | null;
    expiresAt?: SQL;
    rotatedAt?: SQL | null;
    createdAt?: SQL;
  } = {},
): Promise<string> {
  const { userId } = await seedUser(tmp.db, { status: patch.userStatus ?? UserStatus.Active });
  const id = await seedBrokerAccount(tmp.db, userId, {
    status: patch.status ?? BrokerAccountStatus.Active,
  });
  await tmp.db
    .update(brokerAccounts)
    .set({
      serviceSince: patch.serviceSince === undefined ? sql`now()` : patch.serviceSince,
      ...(patch.expiresAt === undefined ? {} : { accessTokenExpiresAt: patch.expiresAt }),
      ...(patch.rotatedAt === undefined ? {} : { tokenRotatedAt: patch.rotatedAt }),
      ...(patch.createdAt === undefined ? {} : { createdAt: patch.createdAt }),
    })
    .where(eq(brokerAccounts.id, id));
  return id;
}

const candidates = (options: { limit?: number; exclude?: string[] } = {}) =>
  listServiceRenewalCandidates(tmp.db, {
    renewAheadMs: DAY,
    rotationGapMs: HOUR,
    limit: options.limit ?? 100,
    exclude: options.exclude,
  });

describe('listServiceBrokerAccounts (the #404 contract)', () => {
  it('O1: returns the working marked accounts only, oldest mark first, as id, broker id and date', async () => {
    const later = await account({ serviceSince: at(`now() - interval '1 hour'`) });
    const earlier = await account({ serviceSince: at(`now() - interval '2 hours'`) });
    await account({ serviceSince: null });
    await account({ status: BrokerAccountStatus.Revoked });
    await account({ status: BrokerAccountStatus.Pending });

    const rows = await listServiceBrokerAccounts(tmp.db);
    expect(rows.map((row) => row.id)).toEqual([earlier, later]);
    const first = await brokerAccountRow(tmp.db, earlier);
    expect(rows[0]).toEqual({
      id: earlier,
      brokerUserId: first.brokerUserId,
      serviceSince: first.serviceSince,
    });
    expect(Object.keys(rows[0] ?? {})).toEqual(['id', 'brokerUserId', 'serviceSince']);
  });

  it('O1: breaks a tie on the date by id', async () => {
    const a = await account({ serviceSince: at(`'2026-10-01T00:00:00Z'::timestamptz`) });
    const b = await account({ serviceSince: at(`'2026-10-01T00:00:00Z'::timestamptz`) });
    const rows = await listServiceBrokerAccounts(tmp.db);
    expect(rows.map((row) => row.id)).toEqual([a, b].sort());
  });

  it('O2: a token expired now or a second ago is not working; one with a second left is', async () => {
    await account({ expiresAt: at('now()') });
    await account({ expiresAt: at(`now() - interval '1 second'`) });
    const alive = await account({ expiresAt: at(`now() + interval '2 seconds'`) });
    expect((await listServiceBrokerAccounts(tmp.db)).map((row) => row.id)).toEqual([alive]);
  });

  it("O3: a blocked user's marked account is not working", async () => {
    await account({ userStatus: UserStatus.Blocked });
    expect(await listServiceBrokerAccounts(tmp.db)).toEqual([]);
  });
});

describe('listServiceRenewalCandidates', () => {
  it('O4: a token inside the window is due, one just outside it is not', async () => {
    const inside = await account({
      expiresAt: at(`now() + interval '1 day' - interval '1 second'`),
      rotatedAt: null,
      createdAt: at(`now() - interval '2 hours'`),
    });
    await account({
      expiresAt: at(`now() + interval '1 day' + interval '5 seconds'`),
      rotatedAt: null,
      createdAt: at(`now() - interval '2 hours'`),
    });
    expect(await candidates()).toEqual([inside]);
  });

  it('O5: the gap since the last rotation, or since creation when there was none', async () => {
    const due = { expiresAt: at(`now() + interval '1 hour'`) };
    await account({ ...due, rotatedAt: at(`now() - interval '1 hour' + interval '5 seconds'`) });
    const old = await account({
      ...due,
      rotatedAt: at(`now() - interval '1 hour' - interval '1 second'`),
    });
    const never = await account({
      ...due,
      rotatedAt: null,
      createdAt: at(`now() - interval '2 hours'`),
    });
    await account({ ...due, rotatedAt: null, createdAt: at('now()') });
    expect((await candidates()).sort()).toEqual([old, never].sort());
  });

  it('O6: an unmarked account with an expired token is never due, nor a revoked marked one', async () => {
    const expired = {
      expiresAt: at(`now() - interval '1 minute'`),
      rotatedAt: null,
      createdAt: at(`now() - interval '2 hours'`),
    };
    await account({ ...expired, serviceSince: null });
    await account({ ...expired, status: BrokerAccountStatus.Revoked });
    await account({ ...expired, status: BrokerAccountStatus.Pending });
    await account({ ...expired, userStatus: UserStatus.Blocked });
    expect(await candidates()).toEqual([]);
    const marked = await account(expired);
    expect(await candidates()).toEqual([marked]);
  });

  it('O7: soonest expiry first, the limit cuts, exclude removes', async () => {
    const base = { rotatedAt: null, createdAt: at(`now() - interval '2 hours'`) };
    // the larger id expires sooner, so the order by id alone is the reverse of the right one
    const [low = '', high = ''] = [await account(base), await account(base)].sort();
    const due = (id: string, hours: number) =>
      tmp.db
        .update(brokerAccounts)
        .set({ accessTokenExpiresAt: sql`now() + make_interval(hours => ${hours})` })
        .where(eq(brokerAccounts.id, id));
    await due(high, 2);
    await due(low, 3);
    const [sooner, later] = [high, low];
    expect(await candidates()).toEqual([sooner, later]);
    expect(await candidates({ limit: 1 })).toEqual([sooner]);
    expect(await candidates({ exclude: [sooner] })).toEqual([later]);
  });
});

describe('listServiceAccountStates', () => {
  it('O8: every marked account with working and the reason by precedence, unmarked ones absent', async () => {
    const s = (n: number) => at(`now() - interval '${String(10 - n)} hours'`);
    const blockedRevoked = await account({
      serviceSince: s(1),
      userStatus: UserStatus.Blocked,
      status: BrokerAccountStatus.Revoked,
    });
    const pendingExpired = await account({
      serviceSince: s(2),
      status: BrokerAccountStatus.Pending,
      expiresAt: at(`now() - interval '1 minute'`),
    });
    const revokedExpired = await account({
      serviceSince: s(3),
      status: BrokerAccountStatus.Revoked,
      expiresAt: at(`now() - interval '1 minute'`),
    });
    const expired = await account({
      serviceSince: s(4),
      expiresAt: at(`now() - interval '1 minute'`),
    });
    const working = await account({ serviceSince: s(5) });
    await account({ serviceSince: null });

    const states = await listServiceAccountStates(tmp.db);
    expect(states.map((row) => [row.id, row.working, row.notWorkingReason])).toEqual([
      [blockedRevoked, false, 'user_blocked'],
      [pendingExpired, false, 'pending'],
      [revokedExpired, false, 'revoked'],
      [expired, false, 'token_expired'],
      [working, true, null],
    ]);
    const row = await brokerAccountRow(tmp.db, working);
    const state = states[4];
    expect(state?.userId).toBe(row.userId);
    expect(typeof state?.telegramUserId).toBe('bigint');
    expect(state?.serviceSince).toEqual(row.serviceSince);
    expect(state).not.toHaveProperty('accessTokenEnc');
    expect(state).not.toHaveProperty('refreshTokenHash');
  });
});

describe('setServiceMark', () => {
  const inTx = <T>(fn: Parameters<typeof tmp.db.transaction<T>>[0]) => tmp.db.transaction(fn);

  it('O9: marks once, keeps the first date on a re-mark, unmarks once, and tells an unknown id', async () => {
    const id = await account({ serviceSince: null });
    const [{ txNow } = { txNow: '' }] = await inTx(async (tx) => {
      expect(await setServiceMark(tx, { accountId: id, service: true })).toBe('marked');
      return (await tx.execute<{ txNow: string }>(sql`select now()::text as "txNow"`)).rows;
    });
    const first = (await brokerAccountRow(tmp.db, id)).serviceSince;
    expect(first?.getTime()).toBe(new Date(txNow).getTime());

    expect(await inTx((tx) => setServiceMark(tx, { accountId: id, service: true }))).toBe(
      'unchanged',
    );
    expect((await brokerAccountRow(tmp.db, id)).serviceSince).toEqual(first);

    expect(await inTx((tx) => setServiceMark(tx, { accountId: id, service: false }))).toBe(
      'unmarked',
    );
    expect((await brokerAccountRow(tmp.db, id)).serviceSince).toBeNull();
    expect(await inTx((tx) => setServiceMark(tx, { accountId: id, service: false }))).toBe(
      'unchanged',
    );
    expect(await inTx((tx) => setServiceMark(tx, { accountId: randomUUID(), service: true }))).toBe(
      'not_found',
    );
  });

  it('O10: touches nothing but the mark and updated_at', async () => {
    const id = await account({
      serviceSince: null,
      status: BrokerAccountStatus.Revoked,
      rotatedAt: at(`now() - interval '3 hours'`),
    });
    await tmp.db
      .update(brokerAccounts)
      .set({
        tradingHalted: true,
        haltedReason: AccountHaltReason.TradeMismatch,
        authRevokedReason: AuthRevokedReason.RefreshExpired,
      })
      .where(eq(brokerAccounts.id, id));
    const before = await brokerAccountRow(tmp.db, id);
    await inTx((tx) => setServiceMark(tx, { accountId: id, service: true }));
    const after = await brokerAccountRow(tmp.db, id);
    expect(after).toEqual({
      ...before,
      serviceSince: after.serviceSince,
      updatedAt: after.updatedAt,
    });
    expect(after.serviceSince).not.toBeNull();
  });
});
