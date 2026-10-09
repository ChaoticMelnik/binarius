import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_ACTIVE_WINDOW_MINUTES,
  ADMIN_PAGE_SIZE,
  ADMIN_USER_RECENT_LEDGER,
  AuthRevokedReason,
  BrokerAccountStatus,
  TokenLedgerKind,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  UserStatus,
  type DecimalString,
} from '@binarius/shared';
import {
  classifyUserSearch,
  listUsersForAdmin,
  readAdminOverview,
  readUserForAdmin,
  toAdminBrokerAccountView,
  toAdminOverview,
  toAdminUserDetail,
  type UserSearch,
} from './admin-read-ops';
import { TERMINAL_TRADE_INTENT_STATUSES } from './schema/trade-intents';
import type { Db } from './client';
import { brokerAccounts, depositEvents, tokenLedger, tradeIntents, users } from './schema/index';
import {
  brokerAccountRow,
  createTempDatabase,
  seedBrokerAccount,
  seedQueuedIntent,
  seedUser,
  seedUserWithAccount,
  type TempDatabase,
} from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}
const testUrl = baseUrl;

const DAY_START = sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;

// each describe owns a database: the page and count oracles need to know every row
const withDatabase = () => {
  const ref: { tmp?: TempDatabase } = {};
  beforeAll(async () => {
    ref.tmp = await createTempDatabase(testUrl);
  });
  afterAll(() => ref.tmp?.drop());
  return (): Db => {
    if (ref.tmp === undefined) throw new Error('database not created yet');
    return ref.tmp.db;
  };
};

const list = (db: Db, options: { search?: UserSearch; cursor?: string; limit?: number } = {}) =>
  db.transaction((tx) => listUsersForAdmin(tx, { limit: ADMIN_PAGE_SIZE, ...options }));

const search = (db: Db, q: string) => list(db, { search: classifyUserSearch(q) });

const setCreatedAt = (db: Db, userId: string, at: ReturnType<typeof sql>) =>
  db.update(users).set({ createdAt: at }).where(eq(users.id, userId));

describe('classifyUserSearch', () => {
  it.each([
    ['4242', 'telegram_user_id'],
    ['9223372036854775807', 'telegram_user_id'],
    // past int8: no ::bigint branch, so no 22003
    ['9223372036854775808', 'broker_user_id'],
    ['0042', 'broker_user_id'],
    ['desk@broker', 'email'],
    ['broker-7', 'broker_user_id'],
  ])('%s → %s', (q, by) => {
    expect(classifyUserSearch(q)).toEqual({ by, value: q });
  });
});

describe('listUsersForAdmin — pages', () => {
  const db = withDatabase();
  const ids: string[] = [];

  beforeAll(async () => {
    // newest first: ids[0] is the newest
    for (let i = 0; i < ADMIN_PAGE_SIZE + 1; i += 1) {
      const { userId } = await seedUser(db());
      await setCreatedAt(db(), userId, sql`now() - make_interval(secs => ${i + 1})`);
      ids.push(userId);
    }
  });

  it('shows ADMIN_PAGE_SIZE rows and a cursor at the last one shown when one more exists', async () => {
    const page = await list(db());
    expect(page.rows.map((r) => r.id)).toEqual(ids.slice(0, ADMIN_PAGE_SIZE));
    expect(page.nextCursor).toBe(ids[ADMIN_PAGE_SIZE - 1]);
    const next = await list(db(), { cursor: page.nextCursor ?? undefined });
    expect(next.rows.map((r) => r.id)).toEqual([ids[ADMIN_PAGE_SIZE]]);
    expect(next.nextCursor).toBeNull();
  });

  it('gives no cursor when exactly ADMIN_PAGE_SIZE rows remain', async () => {
    const page = await list(db(), { cursor: ids[0] });
    expect(page.rows).toHaveLength(ADMIN_PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
  });

  it('answers an id with no row with an empty page, not an error', async () => {
    const page = await list(db(), { cursor: '00000000-0000-4000-8000-00000000dead' });
    expect(page).toEqual({ rows: [], nextCursor: null });
  });
});

describe('listUsersForAdmin — equal created_at across a page boundary', () => {
  const db = withDatabase();

  it('breaks the tie by id, with no row skipped or repeated', async () => {
    const seeded = [await seedUser(db()), await seedUser(db()), await seedUser(db())];
    for (const { userId } of seeded) {
      await setCreatedAt(db(), userId, sql`'2026-10-01T00:00:00.123456Z'::timestamptz`);
    }
    const expected = seeded
      .map((s) => s.userId)
      .sort()
      .reverse();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page = await list(db(), { limit: 1, cursor });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toEqual(expected);
    expect(cursor).toBeUndefined();
  });
});

describe('listUsersForAdmin — search', () => {
  const db = withDatabase();
  let ada: string;
  let byTelegram: { userId: string; telegramUserId: string };
  let byBrokerDigits: string;
  let desk: string;
  let other: string;

  beforeAll(async () => {
    ada = (await seedUser(db())).userId;
    const adaAccount = await seedBrokerAccount(db(), ada, { brokerUserId: 'broker-ada' });
    await db()
      .update(brokerAccounts)
      .set({ email: 'ada@x.com' })
      .where(eq(brokerAccounts.id, adaAccount));

    byTelegram = await seedUser(db());
    // another user whose broker id is the first one's Telegram id
    byBrokerDigits = (await seedUser(db())).userId;
    await seedBrokerAccount(db(), byBrokerDigits, { brokerUserId: byTelegram.telegramUserId });

    desk = (await seedUser(db())).userId;
    await seedBrokerAccount(db(), desk, { brokerUserId: 'desk@broker' });

    other = (await seedUser(db())).userId;
    await seedBrokerAccount(db(), other, { brokerUserId: 'broker-7' });
  });

  const found = async (q: string) => (await search(db(), q)).rows.map((r) => r.id).sort();

  it('matches an email exactly and case-insensitively, never by substring', async () => {
    expect(await found('ada@x')).toEqual([]);
    expect(await found('ADA@X.COM')).toEqual([ada]);
  });

  it('matches digits by Telegram id and by broker id at once', async () => {
    expect(await found(byTelegram.telegramUserId)).toEqual(
      [byTelegram.userId, byBrokerDigits].sort(),
    );
  });

  it('matches a broker id that looks like an address', async () => {
    expect(await found('desk@broker')).toEqual([desk]);
  });

  it('matches a broker id exactly', async () => {
    expect(await found('broker-7')).toEqual([other]);
    expect(await found('broker-')).toEqual([]);
  });

  it('treats LIKE metacharacters as text', async () => {
    expect(await found('broker-%')).toEqual([]);
    expect(await found('%')).toEqual([]);
  });
});

describe('readUserForAdmin', () => {
  const db = withDatabase();

  it('is undefined for an id with no row', async () => {
    const card = await db().transaction((tx) =>
      readUserForAdmin(tx, '00000000-0000-4000-8000-00000000dead'),
    );
    expect(card).toBeUndefined();
  });

  it('computes available in bigint and lists no accounts for a user without any', async () => {
    const { userId } = await seedUser(db(), { balance: 5n });
    await db().update(users).set({ tokenReserved: 2n }).where(eq(users.id, userId));
    const card = await db().transaction((tx) => readUserForAdmin(tx, userId));
    if (card === undefined) throw new Error('no card');
    expect(toAdminUserDetail(card.user).tokens).toEqual({
      balance: '5',
      reserved: '2',
      available: '3',
    });
    expect(card.brokerAccounts).toEqual([]);
  });

  it('projects an account to exactly its wire keys, a blank address as none', async () => {
    const { userId } = await seedUser(db());
    const accountId = await seedBrokerAccount(db(), userId, {
      status: BrokerAccountStatus.Revoked,
    });
    await db()
      .update(brokerAccounts)
      .set({ email: '  ', authRevokedReason: AuthRevokedReason.RefreshExpired })
      .where(eq(brokerAccounts.id, accountId));
    const card = await db().transaction((tx) => readUserForAdmin(tx, userId));
    expect(card?.brokerAccounts.map((a) => a.id)).toEqual([accountId]);
    // the whole row, ciphertexts included: the projection is what keeps them off the wire
    const view = toAdminBrokerAccountView(await brokerAccountRow(db(), accountId));
    expect(Object.keys(view)).toEqual([
      'id',
      'brokerUserId',
      'email',
      'isPartnerClient',
      'status',
      'authRevokedReason',
      'tradingHalted',
      'haltedReason',
      'accessTokenExpiresAt',
      'tokenRotatedAt',
      'createdAt',
      'updatedAt',
    ]);
    expect(view.email).toBeNull();
    expect(view.authRevokedReason).toBe(AuthRevokedReason.RefreshExpired);
  });
});

describe('readAdminOverview', () => {
  const db = withDatabase();

  const overview = () =>
    db().transaction(async (tx) => {
      // the boundary must not follow the session time zone
      await tx.execute(sql`set local time zone 'Asia/Tokyo'`);
      return readAdminOverview(tx, { activeWindowMinutes: ADMIN_ACTIVE_WINDOW_MINUTES });
    });

  it('counts nothing on an empty database', async () => {
    const row = await overview();
    expect(row).toMatchObject({
      usersTotal: 0,
      usersToday: 0,
      usersBlocked: 0,
      usersWithActiveBrokerAccount: 0,
      usersActiveNow: 0,
      intentsTotal: 0,
      intentsToday: 0,
    });
  });

  it('counts from 00:00 UTC, the active window, blocked users and distinct account owners', async () => {
    const touch = (userId: string, patch: Partial<Record<'createdAt' | 'updatedAt', unknown>>) =>
      db()
        .update(users)
        .set(patch as never)
        .where(eq(users.id, userId));

    const yesterday = sql`${DAY_START} - interval '1 day'`;
    const longAgo = sql`now() - interval '1 day'`;

    const early = await seedUser(db(), { status: UserStatus.Blocked });
    await seedBrokerAccount(db(), early.userId, { status: BrokerAccountStatus.Pending });
    await touch(early.userId, {
      createdAt: sql`${DAY_START} - interval '1 second'`,
      updatedAt: sql`now() - make_interval(mins => ${ADMIN_ACTIVE_WINDOW_MINUTES + 1})`,
    });

    const onTheDot = await seedUser(db());
    await seedBrokerAccount(db(), onTheDot.userId);
    await seedBrokerAccount(db(), onTheDot.userId);
    await touch(onTheDot.userId, {
      createdAt: DAY_START,
      updatedAt: sql`now() - make_interval(mins => ${ADMIN_ACTIVE_WINDOW_MINUTES - 1})`,
    });

    const before = await seedQueuedIntent(db());
    const after = await seedQueuedIntent(db());
    for (const seed of [before, after]) {
      await touch(seed.userId, { createdAt: yesterday, updatedAt: longAgo });
    }
    await db()
      .update(tradeIntents)
      .set({ createdAt: sql`${DAY_START} - interval '1 second'` })
      .where(eq(tradeIntents.id, before.intent.id));
    await db()
      .update(tradeIntents)
      .set({ createdAt: DAY_START })
      .where(eq(tradeIntents.id, after.intent.id));

    const row = await overview();
    expect(row).toMatchObject({
      usersTotal: 4,
      usersToday: 1,
      usersBlocked: 1,
      usersWithActiveBrokerAccount: 3,
      usersActiveNow: 1,
      intentsTotal: 2,
      intentsToday: 1,
    });
    const asOf = row.asOf;
    expect(row.dayStartsAt.getTime()).toBe(
      Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
    );
  });
});

describe('readUserForAdmin — the trading section (#330)', () => {
  const db = withDatabase();

  it("reads the user's own intents and counts into the card", async () => {
    const { userId } = await seedUser(db());
    const brokerAccountId = await seedBrokerAccount(db(), userId);
    const [own] = await db()
      .insert(tradeIntents)
      .values({
        userId,
        brokerAccountId,
        mode: TradeMode.Demo,
        assetId: 1,
        amount: '1.50000000' as DecimalString,
        action: TradeAction.Up,
        durationSec: 60,
        clientRequestId: 'card-1',
        status: TradeIntentStatus.Queued,
        tokensReserved: 1n,
      })
      .returning({ id: tradeIntents.id });
    await seedQueuedIntent(db());
    const card = await db().transaction((tx) => readUserForAdmin(tx, userId));
    expect(card?.intents.recent.map((r) => r.id)).toEqual([own?.id]);
    expect(card?.intents).toMatchObject({ total: 1, active: 1 });
  });
});

describe('readUserForAdmin — the token ledger section (#109)', () => {
  const db = withDatabase();

  const adjust = async (userId: string, secondsAgo: number) => {
    const [row] = await db()
      .insert(tokenLedger)
      .values({
        userId,
        kind: TokenLedgerKind.Adjustment,
        balanceDelta: 1n,
        reservedDelta: 0n,
        createdAt: sql`'2026-10-01T12:00:00.000000Z'::timestamptz - make_interval(secs => ${secondsAgo})`,
      })
      .returning({ id: tokenLedger.id });
    if (row === undefined) throw new Error('adjust: insert returned no row');
    return row.id;
  };

  it("reads the user's newest ADMIN_USER_RECENT_LEDGER rows, none of another user's", async () => {
    const { userId } = await seedUser(db());
    const other = await seedUser(db());
    const own: string[] = [];
    for (let i = 0; i < 25; i += 1) own.push(await adjust(userId, 2 * i + 2));
    // newer than every row of the owner: a leak would take a slot at the top
    await adjust(other.userId, 1);
    const card = await db().transaction((tx) => readUserForAdmin(tx, userId));
    expect(ADMIN_USER_RECENT_LEDGER).toBe(20);
    expect(card?.ledger.map((r) => r.id)).toEqual(own.slice(0, ADMIN_USER_RECENT_LEDGER));
  });

  it('is empty for a user without ledger rows', async () => {
    const { userId } = await seedUser(db());
    const card = await db().transaction((tx) => readUserForAdmin(tx, userId));
    expect(card?.ledger).toEqual([]);
  });
});

describe('readUserForAdmin — the deposits section (#341)', () => {
  const db = withDatabase();
  let seq = 0;

  const deposit = async (
    owner: { userId?: string; brokerAccountId: string },
    secondsAgo: number,
  ) => {
    const [row] = await db()
      .insert(depositEvents)
      .values({
        userId: owner.userId ?? null,
        brokerAccountId: owner.brokerAccountId,
        postbackId: `card-pb-${++seq}`,
        payload: {},
        createdAt: sql`'2026-10-01T12:00:00.000000Z'::timestamptz - make_interval(secs => ${secondsAgo})`,
      })
      .returning({ id: depositEvents.id });
    if (row === undefined) throw new Error('deposit: insert returned no row');
    return row.id;
  };

  it("reads the user's newest ADMIN_USER_RECENT_LEDGER deposits, none of another user's or an account-only row", async () => {
    const owner = await seedUserWithAccount(db());
    const other = await seedUserWithAccount(db());
    const own: string[] = [];
    for (let i = 0; i < 25; i += 1) own.push(await deposit(owner, 2 * i + 3));
    // newer than every row of the owner: a leak would take a slot at the top
    await deposit(other, 1);
    await deposit({ brokerAccountId: owner.brokerAccountId }, 2);
    const card = await db().transaction((tx) => readUserForAdmin(tx, owner.userId));
    expect(card?.deposits.map((r) => r.id)).toEqual(own.slice(0, ADMIN_USER_RECENT_LEDGER));
  });

  it('is empty for a user without deposits', async () => {
    const { userId } = await seedUser(db());
    const card = await db().transaction((tx) => readUserForAdmin(tx, userId));
    expect(card?.deposits).toEqual([]);
  });
});

describe('readAdminOverview — intents by status (#330)', () => {
  const db = withDatabase();

  const overview = () =>
    db().transaction((tx) =>
      readAdminOverview(tx, { activeWindowMinutes: ADMIN_ACTIVE_WINDOW_MINUTES }),
    );
  const statuses = Object.values(TradeIntentStatus);
  const isTerminal = (s: TradeIntentStatus) => TERMINAL_TRADE_INTENT_STATUSES.includes(s);

  it('gives every status a zero and no active intent on an empty table', async () => {
    const view = toAdminOverview(await overview(), ADMIN_ACTIVE_WINDOW_MINUTES);
    expect(view.intents.byStatus).toEqual(Object.fromEntries(statuses.map((s) => [s, 0])));
    expect(view.intents.active).toBe(0);
  });

  it('counts each status, sums to the total, and counts the non-terminal ones as active', async () => {
    const { userId } = await seedUser(db());
    let seq = 0;
    const insert = (status: TradeIntentStatus, brokerAccountId: string) =>
      db()
        .insert(tradeIntents)
        .values({
          userId,
          brokerAccountId,
          mode: TradeMode.Demo,
          assetId: 1,
          amount: '1.50000000' as DecimalString,
          action: TradeAction.Up,
          durationSec: 60,
          clientRequestId: `overview-${++seq}`,
          status,
          tokensReserved: isTerminal(status) ? 0n : 1n,
        });
    // one non-terminal intent per account (trade_intents_active_account_idx)
    for (const status of statuses) await insert(status, await seedBrokerAccount(db(), userId));
    await insert(TradeIntentStatus.Settled, await seedBrokerAccount(db(), userId));

    const view = toAdminOverview(await overview(), ADMIN_ACTIVE_WINDOW_MINUTES);
    expect(view.intents.byStatus).toEqual({
      ...Object.fromEntries(statuses.map((s) => [s, 1])),
      settled: 2,
    });
    expect(view.intents.total).toBe(11);
    expect(Object.values(view.intents.byStatus).reduce((a, b) => a + b, 0)).toBe(
      view.intents.total,
    );
    expect(statuses.filter((s) => !isTerminal(s))).toHaveLength(8);
    expect(view.intents.active).toBe(8);
  });

  // one statement is what makes the breakdown agree with the total
  it('reads everything in exactly one statement', async () => {
    await db().transaction(async (tx) => {
      const execute = vi.spyOn(tx, 'execute');
      const select = vi.spyOn(tx, 'select');
      await readAdminOverview(tx, { activeWindowMinutes: ADMIN_ACTIVE_WINDOW_MINUTES });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(select).not.toHaveBeenCalled();
    });
  });
});
