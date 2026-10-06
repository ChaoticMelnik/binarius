import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  TradeIntentFailureReason,
  TradeMode,
  UserStatus,
  type BrokerUser,
  type DecimalString,
} from '@binarius/shared';
import { INTEGRATION_WAIT_CEILING_MS } from '@binarius/shared/testing';
import {
  balanceSnapshotOutOfDomain,
  listBalanceRefreshCandidates,
  readBalanceSnapshot,
  recordBalanceRefreshFailure,
  resolveBalanceAccount,
  summarizeWatchedBalances,
  toBrokerBalanceView,
  touchBalanceRequested,
  upsertBalanceSnapshot,
  type BalanceSnapshotRead,
} from './balance-snapshot-ops';
import type { Db } from './client';
import { BalanceRefreshError, brokerBalanceSnapshots } from './schema/index';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedQueuedIntent,
  seedUser,
  type TempDatabase,
} from './testing';
import { rejectIntent } from './trade-intent-ops';

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

const money = (value: string) => value as DecimalString;

const brokerUser = (patch: Partial<BrokerUser> = {}): BrokerUser => ({
  id: 'broker-1',
  level: { code: 'standard', rank: 1 },
  minTradeAmount: money('1'),
  real: { available: money('100'), held: money('0'), total: money('100') },
  demo: { available: money('10000'), held: money('25.5'), total: money('10025.5') },
  ...patch,
});

async function seedAccount(db: Db = tmp.db, patch: Parameters<typeof seedBrokerAccount>[2] = {}) {
  const user = await seedUser(db);
  const accountId = await seedBrokerAccount(db, user.userId, patch);
  return { ...user, accountId };
}

async function snapshotRow(accountId: string, db: Db = tmp.db) {
  const [row] = await db
    .select({
      row: brokerBalanceSnapshots,
      restAgeMs: sql<number>`extract(epoch from now() - ${brokerBalanceSnapshots.restObservedAt}) * 1000`,
    })
    .from(brokerBalanceSnapshots)
    .where(eq(brokerBalanceSnapshots.brokerAccountId, accountId));
  return row;
}

// moves a timestamp column by the database clock; the ops never take a time from the caller
async function shift(accountId: string, column: string, by: string, db: Db = tmp.db) {
  await db.execute(
    sql`update broker_balance_snapshots set ${sql.identifier(column)} = now() + ${by}::interval where broker_account_id = ${accountId}`,
  );
}

describe('upsertBalanceSnapshot', () => {
  it('inserts the amounts at scale 8, the level and the database time', async () => {
    const { accountId } = await seedAccount();
    expect(
      await upsertBalanceSnapshot(tmp.db, {
        brokerAccountId: accountId,
        user: brokerUser(),
        requested: false,
      }),
    ).toEqual({ written: true });

    const stored = await snapshotRow(accountId);
    expect(stored!.row).toMatchObject({
      realAvailable: '100.00000000',
      realHeld: '0.00000000',
      realTotal: '100.00000000',
      demoAvailable: '10000.00000000',
      demoHeld: '25.50000000',
      demoTotal: '10025.50000000',
      minTradeAmount: '1.00000000',
      levelCode: 'standard',
      levelRank: 1,
      realEventAt: null,
      demoEventAt: null,
      lastRequestedAt: null,
      lastRefreshError: null,
      lastRefreshFailedAt: null,
    });
    expect(Math.abs(stored!.restAgeMs)).toBeLessThan(INTEGRATION_WAIT_CEILING_MS);
  });

  it('sets last_requested_at only when the bot asked', async () => {
    const { accountId } = await seedAccount();
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: true,
    });
    expect((await snapshotRow(accountId))!.row.lastRequestedAt).toBeInstanceOf(Date);
  });

  it('replaces the amounts, clears the failure and keeps last_requested_at on a repeat', async () => {
    const { accountId } = await seedAccount();
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: true,
    });
    await shift(accountId, 'rest_observed_at', '-5 minutes');
    await shift(accountId, 'last_requested_at', '-3 minutes');
    await recordBalanceRefreshFailure(tmp.db, accountId, BalanceRefreshError.Unavailable);
    const before = await snapshotRow(accountId);

    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser({
        level: { code: 'gold', rank: 2.5 },
        real: { available: money('60'), held: money('40'), total: money('100') },
      }),
      requested: false,
    });

    const after = await snapshotRow(accountId);
    expect(after!.row).toMatchObject({
      realAvailable: '60.00000000',
      realHeld: '40.00000000',
      levelCode: 'gold',
      levelRank: 2.5,
      lastRequestedAt: before!.row.lastRequestedAt,
      lastRefreshError: null,
      lastRefreshFailedAt: null,
    });
    expect(Math.abs(after!.restAgeMs)).toBeLessThan(INTEGRATION_WAIT_CEILING_MS);
  });

  it('moves only the event times it is given, and keeps them on a REST write', async () => {
    const { accountId } = await seedAccount();
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: false,
      eventAt: [TradeMode.Real],
    });
    const first = (await snapshotRow(accountId))!.row;
    expect(first.realEventAt).toBeInstanceOf(Date);
    expect(first.demoEventAt).toBeNull();

    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: false,
    });
    expect((await snapshotRow(accountId))!.row.realEventAt).toEqual(first.realEventAt);

    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: false,
      eventAt: [TradeMode.Demo],
    });
    const third = (await snapshotRow(accountId))!.row;
    expect(third.demoEventAt).toBeInstanceOf(Date);
    expect(third.realEventAt).toEqual(first.realEventAt);
  });
});

describe('the stored domain', () => {
  const withAmount = (value: string) =>
    brokerUser({ real: { available: money(value), held: money('0'), total: money('100') } });
  const withRank = (rank: number) => brokerUser({ level: { code: 'standard', rank } });
  const withCode = (code: string) => brokerUser({ level: { code, rank: 1 } });

  // each against an existing snapshot, which must come out of it unchanged
  it.each<[string, BrokerUser, string]>([
    [
      'nine fraction digits (numeric would round them)',
      withAmount('1.123456789'),
      'real.available',
    ],
    [
      'thirteen integer digits (numeric would overflow)',
      withAmount('1000000000000'),
      'real.available',
    ],
    ['a negative amount', withAmount('-1'), 'real.available'],
    ['a negative amount within the scale', withAmount('-0.00000001'), 'real.available'],
    ['a negative zero', withAmount('-0'), 'real.available'],
    [
      'a bad min trade amount',
      brokerUser({ minTradeAmount: money('0.000000001') }),
      'minTradeAmount',
    ],
    [
      'a bad demo total',
      brokerUser({ demo: { available: money('1'), held: money('0'), total: money('-1') } }),
      'demo.total',
    ],
    ['a rank of 10000', withRank(10_000), 'level.rank'],
    ['a rank that rounds up to 10000', withRank(9999.99995), 'level.rank'],
    ['a negative rank', withRank(-1), 'level.rank'],
    ['a rank in exponent form', withRank(1e-7), 'level.rank'],
    ['a level code with NUL', withCode('a\u0000b'), 'level.code'],
    ['a level code over 64 characters', withCode('x'.repeat(65)), 'level.code'],
    ['an empty level code', withCode(''), 'level.code'],
    ['a level code with a line break', withCode('vip\n'), 'level.code'],
  ])('refuses %s', async (_label, user, field) => {
    const { accountId } = await seedAccount();
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: false,
    });
    const before = (await snapshotRow(accountId))!.row;

    expect(
      await upsertBalanceSnapshot(tmp.db, { brokerAccountId: accountId, user, requested: true }),
    ).toEqual({ written: false, field });
    expect((await snapshotRow(accountId))!.row).toEqual(before);
  });

  it('writes the edges of the domain unchanged', async () => {
    const { accountId } = await seedAccount();
    const user = brokerUser({
      level: { code: 'standard', rank: 9999.9999 },
      minTradeAmount: money('0'),
      real: {
        available: money('999999999999.99999999'),
        held: money('0'),
        total: money('999999999999.99999999'),
      },
    });
    expect(
      await upsertBalanceSnapshot(tmp.db, { brokerAccountId: accountId, user, requested: false }),
    ).toEqual({ written: true });
    expect((await snapshotRow(accountId))!.row).toMatchObject({
      realAvailable: '999999999999.99999999',
      minTradeAmount: '0.00000000',
      levelRank: 9999.9999,
    });

    const zeroRank = await seedAccount();
    expect(
      await upsertBalanceSnapshot(tmp.db, {
        brokerAccountId: zeroRank.accountId,
        user: withRank(0),
        requested: false,
      }),
    ).toEqual({ written: true });
    expect((await snapshotRow(zeroRank.accountId))!.row.levelRank).toBe(0);

    for (const code of ['x'.repeat(64), 'золото 2']) {
      const { accountId: codeAccount } = await seedAccount();
      expect(
        await upsertBalanceSnapshot(tmp.db, {
          brokerAccountId: codeAccount,
          user: withCode(code),
          requested: false,
        }),
      ).toEqual({ written: true });
      expect((await snapshotRow(codeAccount))!.row.levelCode).toBe(code);
    }
  });

  it('names nothing for a value inside it', () => {
    expect(balanceSnapshotOutOfDomain(brokerUser())).toBeUndefined();
  });
});

describe('recordBalanceRefreshFailure and touchBalanceRequested', () => {
  it('records a failure with its time on an existing snapshot', async () => {
    const { accountId } = await seedAccount();
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: false,
    });
    expect(
      await recordBalanceRefreshFailure(tmp.db, accountId, BalanceRefreshError.RateLimited),
    ).toBe(true);
    const { row } = (await snapshotRow(accountId))!;
    expect(row.lastRefreshError).toBe('rate_limited');
    expect(row.lastRefreshFailedAt).toBeInstanceOf(Date);
  });

  it('creates no snapshot from a failure or a request alone', async () => {
    const { accountId } = await seedAccount();
    expect(
      await recordBalanceRefreshFailure(tmp.db, accountId, BalanceRefreshError.Unavailable),
    ).toBe(false);
    expect(await touchBalanceRequested(tmp.db, accountId)).toBe(false);
    expect(await snapshotRow(accountId)).toBeUndefined();
  });

  it('moves last_requested_at and updated_at on a request', async () => {
    const { accountId } = await seedAccount();
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: false,
    });
    await shift(accountId, 'updated_at', '-1 hour');
    const before = (await snapshotRow(accountId))!.row;

    expect(await touchBalanceRequested(tmp.db, accountId)).toBe(true);
    const after = (await snapshotRow(accountId))!.row;
    expect(after.lastRequestedAt).toBeInstanceOf(Date);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });
});

describe('readBalanceSnapshot', () => {
  async function written() {
    const { accountId } = await seedAccount();
    await upsertBalanceSnapshot(tmp.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: false,
    });
    return accountId;
  }

  it('returns nothing for an account without a snapshot', async () => {
    const { accountId } = await seedAccount();
    expect(await readBalanceSnapshot(tmp.db, accountId)).toBeUndefined();
  });

  it('returns the stored values and the REST age by the database clock', async () => {
    const accountId = await written();
    await shift(accountId, 'rest_observed_at', '-90 seconds');
    const read = await readBalanceSnapshot(tmp.db, accountId);
    expect(read).toMatchObject({
      real: { available: '100.00000000', held: '0.00000000', total: '100.00000000' },
      demo: { available: '10000.00000000', held: '25.50000000', total: '10025.50000000' },
      minTradeAmount: '1.00000000',
      level: { code: 'standard', rank: 1 },
      balanceEventAgeSec: null,
      lastRefreshError: null,
    });
    expect(read!.restSnapshotAgeSec).toBeGreaterThanOrEqual(89);
    expect(read!.restSnapshotAgeSec).toBeLessThanOrEqual(90 + INTEGRATION_WAIT_CEILING_MS / 1_000);
  });

  it('reads a timestamp in the future as age 0', async () => {
    const accountId = await written();
    await shift(accountId, 'rest_observed_at', '5 seconds');
    expect((await readBalanceSnapshot(tmp.db, accountId))!.restSnapshotAgeSec).toBe(0);
  });

  it('takes the newer of the two event times', async () => {
    const accountId = await written();
    await shift(accountId, 'real_event_at', '-30 seconds');
    expect(
      (await readBalanceSnapshot(tmp.db, accountId))!.balanceEventAgeSec,
    ).toBeGreaterThanOrEqual(29);
    await shift(accountId, 'demo_event_at', '-10 seconds');
    const age = (await readBalanceSnapshot(tmp.db, accountId))!.balanceEventAgeSec;
    expect(age).toBeGreaterThanOrEqual(9);
    expect(age).toBeLessThanOrEqual(10 + INTEGRATION_WAIT_CEILING_MS / 1_000);
  });

  it('carries the last refresh error', async () => {
    const accountId = await written();
    await recordBalanceRefreshFailure(tmp.db, accountId, BalanceRefreshError.AccountMismatch);
    expect((await readBalanceSnapshot(tmp.db, accountId))!.lastRefreshError).toBe(
      'account_mismatch',
    );
  });
});

// A database of their own: both read every account in the database, so rows other cases seed
// would change their counts and their order.
describe('the accounts in work', () => {
  let own: TempDatabase;
  beforeAll(async () => {
    own = await createTempDatabase(baseUrl);
  });
  afterAll(() => own.drop());

  const WINDOW_MS = 600_000;
  const SKEW_MS = 60_000;
  const candidates = (limit = 100) =>
    listBalanceRefreshCandidates(own.db, {
      watchWindowMs: WINDOW_MS,
      accessSkewMs: SKEW_MS,
      limit,
    });

  async function requested(by: string, patch: Parameters<typeof seedBrokerAccount>[2] = {}) {
    const { accountId } = await seedAccount(own.db, patch);
    await upsertBalanceSnapshot(own.db, {
      brokerAccountId: accountId,
      user: brokerUser(),
      requested: true,
    });
    await shift(accountId, 'last_requested_at', by, own.db);
    return accountId;
  }

  it('lists, orders and limits the refresh candidates, and summarizes the watched', async () => {
    expect(await summarizeWatchedBalances(own.db, { watchWindowMs: WINDOW_MS })).toEqual({
      watched: 0,
      withoutSnapshot: 0,
      oldestAgeSec: null,
    });

    // in: a queued intent and no snapshot yet; asked 9 minutes ago, observed 2 and 5 minutes ago
    const withIntent = (await seedQueuedIntent(own.db)).brokerAccountId;
    expect(await summarizeWatchedBalances(own.db, { watchWindowMs: WINDOW_MS })).toEqual({
      watched: 1,
      withoutSnapshot: 1,
      oldestAgeSec: null,
    });
    const askedOlder = await requested('-9 minutes');
    await shift(askedOlder, 'rest_observed_at', '-500 seconds', own.db);
    const askedNewer = await requested('-1 minute');
    await shift(askedNewer, 'rest_observed_at', '-2 minutes', own.db);

    // out: asked 11 minutes ago; pending; revoked; a blocked user; a token inside the skew;
    // an intent that has ended
    await requested('-11 minutes');
    await requested('-1 minute', { status: BrokerAccountStatus.Pending });
    await requested('-1 minute', { status: BrokerAccountStatus.Revoked });
    const blocked = await seedUser(own.db, { status: UserStatus.Blocked });
    const blockedAccount = await seedBrokerAccount(own.db, blocked.userId);
    await upsertBalanceSnapshot(own.db, {
      brokerAccountId: blockedAccount,
      user: brokerUser(),
      requested: true,
    });
    const expiring = await requested('-1 minute', {
      accessTokenExpiresAt: new Date(Date.now() + 30_000),
    });
    const ended = await seedQueuedIntent(own.db);
    await own.db.transaction((tx) =>
      rejectIntent(tx, {
        id: ended.intent.id,
        from: 'queued',
        reason: TradeIntentFailureReason.Expired,
      }),
    );

    expect(await candidates()).toEqual([withIntent, askedOlder, askedNewer]);
    expect(await candidates(2)).toEqual([withIntent, askedOlder]);

    // the expiring token is watched but not a candidate: this is where its age shows. The older
    // REST snapshot has a recent event, so it is not the stalest observation.
    await shift(expiring, 'rest_observed_at', '-400 seconds', own.db);
    await shift(askedOlder, 'real_event_at', '-10 seconds', own.db);
    const summary = await summarizeWatchedBalances(own.db, { watchWindowMs: WINDOW_MS });
    expect(summary).toMatchObject({ watched: 4, withoutSnapshot: 1 });
    expect(summary.oldestAgeSec).toBeGreaterThanOrEqual(399);
    expect(summary.oldestAgeSec).toBeLessThanOrEqual(400 + INTEGRATION_WAIT_CEILING_MS / 1_000);

    // a recorded failure counts as an attempt: the failing account goes behind the healthy one
    await recordBalanceRefreshFailure(own.db, askedOlder, BalanceRefreshError.AccountMismatch);
    expect(await candidates()).toEqual([withIntent, askedNewer, askedOlder]);

    // held back by the caller: gone from the list, the rest in the same order
    expect(
      await listBalanceRefreshCandidates(own.db, {
        watchWindowMs: WINDOW_MS,
        accessSkewMs: SKEW_MS,
        limit: 100,
        exclude: [withIntent],
      }),
    ).toEqual([askedNewer, askedOlder]);
  });
});

describe('resolveBalanceAccount', () => {
  const resolve = (telegramUserId: string, brokerAccountId?: string) =>
    resolveBalanceAccount(tmp.db, {
      telegramUserId: BigInt(telegramUserId),
      ...(brokerAccountId === undefined ? {} : { brokerAccountId }),
    });

  it('tells an unknown user apart', async () => {
    expect(await resolveBalanceAccount(tmp.db, { telegramUserId: 999_999_999n })).toEqual({
      kind: 'no_user',
    });
  });

  it('picks the only active account with what the caller needs', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const user = await seedUser(tmp.db, { status: UserStatus.Blocked });
    await seedBrokerAccount(tmp.db, user.userId, { status: BrokerAccountStatus.Pending });
    const id = await seedBrokerAccount(tmp.db, user.userId, {
      brokerUserId: 'broker-resolve-1',
      accessTokenExpiresAt: expiresAt,
    });
    expect(await resolve(user.telegramUserId)).toEqual({
      kind: 'account',
      account: {
        id,
        status: 'active',
        brokerUserId: 'broker-resolve-1',
        accessTokenExpiresAt: expiresAt,
        userStatus: 'blocked',
      },
    });
  });

  it('refuses to guess between two active accounts', async () => {
    const user = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, user.userId);
    await seedBrokerAccount(tmp.db, user.userId);
    expect(await resolve(user.telegramUserId)).toEqual({ kind: 'ambiguous' });
  });

  it('says there is no account when none is active', async () => {
    const user = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, user.userId, { status: BrokerAccountStatus.Pending });
    expect(await resolve(user.telegramUserId)).toEqual({ kind: 'no_account' });
  });

  it('returns an explicit account of the user whatever its status', async () => {
    const user = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, user.userId);
    const pending = await seedBrokerAccount(tmp.db, user.userId, {
      status: BrokerAccountStatus.Pending,
    });
    expect(await resolve(user.telegramUserId, pending)).toMatchObject({
      kind: 'account',
      account: { id: pending, status: 'pending' },
    });
  });

  it('does not find an explicit account of another user, or one that does not exist', async () => {
    const user = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, user.userId);
    const other = await seedAccount();
    expect(await resolve(user.telegramUserId, other.accountId)).toEqual({ kind: 'not_found' });
    expect(await resolve(user.telegramUserId, '00000000-0000-4000-8000-000000000000')).toEqual({
      kind: 'not_found',
    });
  });
});

describe('toBrokerBalanceView', () => {
  const read: BalanceSnapshotRead = {
    real: {
      available: money('100.00000000'),
      held: money('0.00000000'),
      total: money('100.00000000'),
    },
    demo: {
      available: money('10.00000000'),
      held: money('0.00000000'),
      total: money('10.00000000'),
    },
    minTradeAmount: money('1.00000000'),
    level: { code: 'standard', rank: 1 },
    restSnapshotAgeSec: 5,
    balanceEventAgeSec: null,
    lastRefreshError: BalanceRefreshError.Unavailable,
  };

  it('carries exactly the view keys, without the refresh error', () => {
    const view = toBrokerBalanceView(read);
    expect(Object.keys(view).sort()).toEqual([
      'balanceEventAgeSec',
      'demo',
      'fresh',
      'level',
      'minTradeAmount',
      'real',
      'restSnapshotAgeSec',
    ]);
    expect(view).toMatchObject({ real: read.real, demo: read.demo, fresh: true });
  });

  it('is fresh by a recent event over a stale REST snapshot', () => {
    expect(
      toBrokerBalanceView({ ...read, restSnapshotAgeSec: 600, balanceEventAgeSec: 10 }).fresh,
    ).toBe(true);
  });

  it('goes by the REST age while there is no event', () => {
    expect(toBrokerBalanceView({ ...read, restSnapshotAgeSec: 61 }).fresh).toBe(false);
    expect(toBrokerBalanceView({ ...read, restSnapshotAgeSec: 60 }).fresh).toBe(true);
  });
});
