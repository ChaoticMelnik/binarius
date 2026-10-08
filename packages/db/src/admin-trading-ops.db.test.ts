import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_INTENTS_ACTIVE_FILTER,
  ADMIN_PAGE_SIZE,
  ADMIN_USER_RECENT_INTENTS,
  adminTradeIntentViewSchema,
  adminTradingSessionViewSchema,
  TradeAction,
  type DecimalString,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
} from '@binarius/shared';
import {
  listIntentsForAdmin,
  listTradingSessionsForAdmin,
  readIntentForAdmin,
  readUserIntentsSection,
  toAdminTradeIntentView,
  toAdminTradingSessionView,
  type AdminIntentFilters,
} from './admin-trading-ops';
import type { Db } from './client';
import { tradeIntents, tradingSessions } from './schema/index';
import { TERMINAL_TRADE_INTENT_STATUSES } from './schema/trade-intents';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  sessionSettings,
  type TempDatabase,
} from './testing';
import { markSessionDecision } from './trading-session-ops';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}
const testUrl = baseUrl;

// each describe owns a database: the page and filter oracles need to know every row
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

const list = (
  db: Db,
  options: { filters?: AdminIntentFilters; cursor?: string; limit?: number } = {},
) =>
  db.transaction((tx) =>
    listIntentsForAdmin(tx, { filters: {}, limit: ADMIN_PAGE_SIZE, ...options }),
  );

const isTerminal = (status: TradeIntentStatus) => TERMINAL_TRADE_INTENT_STATUSES.includes(status);

let requestSeq = 0;

interface Seeded {
  id: string;
  userId: string;
  status: TradeIntentStatus;
  mode: TradeMode;
  tradingSessionId: string | null;
}

// A row written directly: INSERT is not checked against the transition graph (only UPDATE is),
// so any status can be seeded. The reserve follows trade_intents_terminal_reserve_check, and
// created_at is explicit — two inserts in one transaction would share now().
async function insertIntent(
  db: Db,
  row: {
    userId: string;
    brokerAccountId: string;
    status: TradeIntentStatus;
    mode?: TradeMode;
    tradingSessionId?: string | null;
    secondsAgo: number;
  },
): Promise<Seeded> {
  const mode = row.mode ?? TradeMode.Demo;
  const tradingSessionId = row.tradingSessionId ?? null;
  const [inserted] = await db
    .insert(tradeIntents)
    .values({
      userId: row.userId,
      brokerAccountId: row.brokerAccountId,
      tradingSessionId,
      mode,
      assetId: 1,
      amount: '1.50000000' as DecimalString,
      action: TradeAction.Up,
      durationSec: 60,
      clientRequestId: `admin-${++requestSeq}`,
      status: row.status,
      tokensReserved: isTerminal(row.status) ? 0n : 1n,
      createdAt: sql`'2026-10-01T12:00:00.000000Z'::timestamptz - make_interval(secs => ${row.secondsAgo})`,
    })
    .returning({ id: tradeIntents.id });
  if (inserted === undefined) throw new Error('insertIntent: insert returned no row');
  return { id: inserted.id, userId: row.userId, status: row.status, mode, tradingSessionId };
}

const sorted = (ids: string[]) => [...ids].sort();

describe('listIntentsForAdmin — pages', () => {
  const db = withDatabase();
  const ids: string[] = [];

  beforeAll(async () => {
    const { userId } = await seedUser(db());
    const brokerAccountId = await seedBrokerAccount(db(), userId);
    // newest first: ids[0] is the newest
    for (let i = 0; i < ADMIN_PAGE_SIZE + 1; i += 1) {
      const seeded = await insertIntent(db(), {
        userId,
        brokerAccountId,
        status: TradeIntentStatus.Settled,
        secondsAgo: i + 1,
      });
      ids.push(seeded.id);
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

describe('listIntentsForAdmin — equal created_at across a page boundary', () => {
  const db = withDatabase();

  it('breaks the tie by id, with no row skipped or repeated', async () => {
    const { userId } = await seedUser(db());
    const brokerAccountId = await seedBrokerAccount(db(), userId);
    const seeded: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const row = await insertIntent(db(), {
        userId,
        brokerAccountId,
        status: TradeIntentStatus.Rejected,
        secondsAgo: 0,
      });
      seeded.push(row.id);
    }
    const expected = sorted(seeded).reverse();
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page = await list(db(), { cursor, limit: 1 });
      walked.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(walked).toEqual(expected);
    expect(cursor).toBeUndefined();
  });
});

describe('listIntentsForAdmin — filters', () => {
  const db = withDatabase();
  const seeds: Seeded[] = [];
  let userU = '';
  let userV = '';
  let sessionOne = '';
  let sessionTwo = '';
  let settledInSessionOne: Seeded | undefined;

  beforeAll(async () => {
    userU = (await seedUser(db())).userId;
    userV = (await seedUser(db())).userId;
    let age = 0;
    const nonTerminal = Object.values(TradeIntentStatus).filter((s) => !isTerminal(s));
    // one non-terminal intent per account (trade_intents_active_account_idx)
    const accounts: string[] = [];
    while (accounts.length < nonTerminal.length) {
      accounts.push(await seedBrokerAccount(db(), userU));
    }
    const [first, second] = accounts;
    if (first === undefined || second === undefined) throw new Error('no accounts seeded');
    // one active session per account: the account's earlier session is stopped
    sessionTwo = (await seedTradingSession(db(), first)).id;
    await db()
      .update(tradingSessions)
      .set({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.Completed,
        endedAt: new Date(),
      })
      .where(eq(tradingSessions.id, sessionTwo));
    sessionOne = (await seedTradingSession(db(), first)).id;

    for (const [i, status] of nonTerminal.entries()) {
      const brokerAccountId = accounts[i];
      if (brokerAccountId === undefined) throw new Error('account missing');
      seeds.push(
        await insertIntent(db(), {
          userId: userU,
          brokerAccountId,
          status,
          // the first account's live intent belongs to session one
          tradingSessionId: i === 0 ? sessionOne : null,
          secondsAgo: (age += 1),
        }),
      );
    }
    settledInSessionOne = await insertIntent(db(), {
      userId: userU,
      brokerAccountId: first,
      status: TradeIntentStatus.Settled,
      tradingSessionId: sessionOne,
      secondsAgo: (age += 1),
    });
    seeds.push(settledInSessionOne);
    seeds.push(
      await insertIntent(db(), {
        userId: userU,
        brokerAccountId: first,
        status: TradeIntentStatus.Rejected,
        tradingSessionId: sessionTwo,
        secondsAgo: (age += 1),
      }),
    );
    seeds.push(
      await insertIntent(db(), {
        userId: userU,
        brokerAccountId: second,
        status: TradeIntentStatus.Settled,
        mode: TradeMode.Real,
        secondsAgo: (age += 1),
      }),
    );
    const accountV = await seedBrokerAccount(db(), userV);
    seeds.push(
      await insertIntent(db(), {
        userId: userV,
        brokerAccountId: accountV,
        status: TradeIntentStatus.Queued,
        secondsAgo: age + 1,
      }),
    );
  });

  const expectIds = async (filters: AdminIntentFilters, predicate: (s: Seeded) => boolean) => {
    const page = await list(db(), { filters });
    expect(sorted(page.rows.map((r) => r.id))).toEqual(
      sorted(seeds.filter(predicate).map((s) => s.id)),
    );
  };

  it('"active" is exactly the statuses that are not terminal, all eight of them', async () => {
    const page = await list(db(), { filters: { status: ADMIN_INTENTS_ACTIVE_FILTER } });
    const statuses = new Set(page.rows.map((r) => r.status));
    expect([...statuses].sort()).toEqual(
      Object.values(TradeIntentStatus)
        .filter((s) => !TERMINAL_TRADE_INTENT_STATUSES.includes(s))
        .sort(),
    );
    await expectIds({ status: ADMIN_INTENTS_ACTIVE_FILTER }, (s) => !isTerminal(s.status));
  });

  it('a status matches only itself', async () => {
    await expectIds({ status: TradeIntentStatus.Settled }, (s) => s.status === 'settled');
    await expectIds(
      { status: TradeIntentStatus.ManualReview },
      (s) => s.status === 'manual_review',
    );
  });

  it('filters by mode', async () => {
    await expectIds({ mode: TradeMode.Real }, (s) => s.mode === 'real');
  });

  it("filters by user, and another user's id shows nothing of this one's", async () => {
    await expectIds({ userId: userV }, (s) => s.userId === userV);
    const page = await list(db(), { filters: { userId: '00000000-0000-4000-8000-00000000beef' } });
    expect(page).toEqual({ rows: [], nextCursor: null });
  });

  it('filters by trading session: not the intent without one, not the other session of the account', async () => {
    await expectIds({ tradingSessionId: sessionOne }, (s) => s.tradingSessionId === sessionOne);
    await expectIds({ tradingSessionId: sessionTwo }, (s) => s.tradingSessionId === sessionTwo);
  });

  it('combines every filter', async () => {
    await expectIds(
      {
        status: ADMIN_INTENTS_ACTIVE_FILTER,
        mode: TradeMode.Demo,
        userId: userU,
        tradingSessionId: sessionOne,
      },
      (s) =>
        !isTerminal(s.status) &&
        s.mode === 'demo' &&
        s.userId === userU &&
        s.tradingSessionId === sessionOne,
    );
  });

  // the cursor positions: a settled cursor row under the "active" filter still marks where the
  // page starts
  it('positions at a cursor row the filters would not show', async () => {
    const cursor = settledInSessionOne;
    if (cursor === undefined) throw new Error('not seeded');
    const cursorIndex = seeds.indexOf(cursor);
    const page = await list(db(), {
      filters: { status: ADMIN_INTENTS_ACTIVE_FILTER },
      cursor: cursor.id,
    });
    expect(page.rows.map((r) => r.id)).toEqual(
      seeds
        .slice(cursorIndex + 1)
        .filter((s) => !isTerminal(s.status))
        .map((s) => s.id),
    );
  });
});

describe('readIntentForAdmin and toAdminTradeIntentView', () => {
  const db = withDatabase();

  it('is undefined for an id with no row', async () => {
    const row = await db().transaction((tx) =>
      readIntentForAdmin(tx, '00000000-0000-4000-8000-00000000dead'),
    );
    expect(row).toBeUndefined();
  });

  it("projects to exactly the admin view's keys, with the owner's Telegram id and the lease", async () => {
    const { userId, telegramUserId } = await seedUser(db());
    const brokerAccountId = await seedBrokerAccount(db(), userId);
    const session = await seedTradingSession(db(), brokerAccountId);
    const claimed = await insertIntent(db(), {
      userId,
      brokerAccountId,
      status: TradeIntentStatus.Reconciling,
      tradingSessionId: session.id,
      secondsAgo: 2,
    });
    await db()
      .update(tradeIntents)
      .set({ reconcileClaimedAt: new Date('2026-10-01T12:00:05.000Z') })
      .where(eq(tradeIntents.id, claimed.id));
    const bare = await insertIntent(db(), {
      userId,
      brokerAccountId,
      status: TradeIntentStatus.Settled,
      secondsAgo: 1,
    });

    const read = (id: string) =>
      db().transaction(async (tx) => {
        const row = await readIntentForAdmin(tx, id);
        if (row === undefined) throw new Error(`no row ${id}`);
        return toAdminTradeIntentView(row);
      });
    const view = await read(claimed.id);
    expect(Object.keys(view).sort()).toEqual(Object.keys(adminTradeIntentViewSchema.shape).sort());
    expect(adminTradeIntentViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({
      id: claimed.id,
      userId,
      telegramUserId,
      brokerAccountId,
      tradingSessionId: session.id,
      reconcileClaimedAt: '2026-10-01T12:00:05.000Z',
      amount: '1.50000000',
      tokensReserved: '1',
    });
    expect(await read(bare.id)).toMatchObject({ tradingSessionId: null, reconcileClaimedAt: null });
  });
});

// --- The trading sessions page and the user card's trading section (#330) ---------------------

const listSessions = (db: Db, options: { cursor?: string; limit?: number } = {}) =>
  db.transaction((tx) => listTradingSessionsForAdmin(tx, { limit: ADMIN_PAGE_SIZE, ...options }));

// A stopped session written directly, created_at explicit: an account holds one active session at
// most, stopped ones are free.
async function insertStoppedSession(
  db: Db,
  brokerAccountId: string,
  row: { secondsAgo: number; settings?: unknown; id?: string },
): Promise<string> {
  const [inserted] = await db
    .insert(tradingSessions)
    .values({
      ...(row.id === undefined ? {} : { id: row.id }),
      brokerAccountId,
      mode: TradeMode.Demo,
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
      endedAt: new Date('2026-10-01T12:30:00.000Z'),
      settings: (row.settings ?? sessionSettings()) as never,
      createdAt: sql`'2026-10-01T12:00:00.000000Z'::timestamptz - make_interval(secs => ${row.secondsAgo})`,
    })
    .returning({ id: tradingSessions.id });
  if (inserted === undefined) throw new Error('insertStoppedSession: insert returned no row');
  return inserted.id;
}

describe('listTradingSessionsForAdmin — pages (#330)', () => {
  const db = withDatabase();
  const ids: string[] = [];

  beforeAll(async () => {
    const { userId } = await seedUser(db());
    const brokerAccountId = await seedBrokerAccount(db(), userId);
    for (let i = 0; i < ADMIN_PAGE_SIZE + 1; i += 1) {
      ids.push(await insertStoppedSession(db(), brokerAccountId, { secondsAgo: i + 1 }));
    }
  });

  it('shows ADMIN_PAGE_SIZE rows and a cursor at the last one shown when one more exists', async () => {
    const page = await listSessions(db());
    expect(page.rows.map((r) => r.id)).toEqual(ids.slice(0, ADMIN_PAGE_SIZE));
    expect(page.nextCursor).toBe(ids[ADMIN_PAGE_SIZE - 1]);
    const next = await listSessions(db(), { cursor: page.nextCursor ?? undefined });
    expect(next.rows.map((r) => r.id)).toEqual([ids[ADMIN_PAGE_SIZE]]);
    expect(next.nextCursor).toBeNull();
  });

  it('gives no cursor when exactly ADMIN_PAGE_SIZE rows remain', async () => {
    const page = await listSessions(db(), { cursor: ids[0] });
    expect(page.rows).toHaveLength(ADMIN_PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
  });

  it('answers an id with no row with an empty page, not an error', async () => {
    const page = await listSessions(db(), { cursor: '00000000-0000-4000-8000-00000000dead' });
    expect(page).toEqual({ rows: [], nextCursor: null });
  });
});

describe('listTradingSessionsForAdmin — equal created_at across a page boundary (#330)', () => {
  // a database per limit: the walk compares against every row there is
  describe.each([1, 2])('at limit %i', (limit) => {
    const db = withDatabase();

    it('breaks the tie by id, with no row skipped or repeated', async () => {
      const { userId } = await seedUser(db());
      const brokerAccountId = await seedBrokerAccount(db(), userId);
      const newest = await insertStoppedSession(db(), brokerAccountId, { secondsAgo: 0 });
      // inserted in ascending id order, so the heap order alone is the wrong order
      const tied: string[] = [];
      for (const n of [1, 2, 3, 4]) {
        const id = `00000000-0000-4000-8000-00000000000${n}`;
        tied.push(await insertStoppedSession(db(), brokerAccountId, { secondsAgo: 1, id }));
      }
      const walked: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await listSessions(db(), { cursor, limit });
        walked.push(...page.rows.map((r) => r.id));
        cursor = page.nextCursor ?? undefined;
        if (cursor === undefined) break;
      }
      expect(walked).toEqual([newest, ...[...tied].reverse()]);
      expect(cursor).toBeUndefined();
    });
  });
});

describe('listTradingSessionsForAdmin and toAdminTradingSessionView — owner and projection (#330)', () => {
  const db = withDatabase();

  const sessionView = async (id: string) => {
    const page = await listSessions(db());
    const row = page.rows.find((r) => r.id === id);
    if (row === undefined) throw new Error(`no session ${id}`);
    return toAdminTradingSessionView(row);
  };

  it("carries each session's own account and that account's owner", async () => {
    const ada = await seedUser(db());
    const bob = await seedUser(db());
    const adaAccount = await seedBrokerAccount(db(), ada.userId, { brokerUserId: 'ada-broker' });
    const bobAccount = await seedBrokerAccount(db(), bob.userId, { brokerUserId: 'bob-broker' });
    const adaSession = await insertStoppedSession(db(), adaAccount, { secondsAgo: 2 });
    const bobSession = await insertStoppedSession(db(), bobAccount, { secondsAgo: 1 });
    expect(await sessionView(adaSession)).toMatchObject({
      brokerAccountId: adaAccount,
      brokerUserId: 'ada-broker',
      userId: ada.userId,
      telegramUserId: ada.telegramUserId,
    });
    expect(await sessionView(bobSession)).toMatchObject({
      brokerAccountId: bobAccount,
      brokerUserId: 'bob-broker',
      userId: bob.userId,
      telegramUserId: bob.telegramUserId,
    });
  });

  it("projects to exactly the view's keys; a stopped session has its reason and end", async () => {
    const { userId } = await seedUser(db());
    const accountId = await seedBrokerAccount(db(), userId);
    const id = await insertStoppedSession(db(), accountId, { secondsAgo: 0 });
    const view = await sessionView(id);
    expect(Object.keys(view)).toEqual(Object.keys(adminTradingSessionViewSchema.shape));
    expect(adminTradingSessionViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
      endedAt: '2026-10-01T12:30:00.000Z',
    });
    expect(view.settings).toEqual(sessionSettings());
  });

  it('an active session has no reason, end or decision until one is marked', async () => {
    const { userId } = await seedUser(db());
    const accountId = await seedBrokerAccount(db(), userId);
    const session = await seedTradingSession(db(), accountId);
    expect(await sessionView(session.id)).toMatchObject({
      status: TradingSessionStatus.Active,
      stopReason: null,
      endedAt: null,
      lastDecisionAt: null,
    });
    await markSessionDecision(db(), { id: session.id });
    const [stored] = await db()
      .select({ at: tradingSessions.lastDecisionAt })
      .from(tradingSessions)
      .where(eq(tradingSessions.id, session.id));
    if (stored?.at == null) throw new Error('the decision was not marked');
    expect((await sessionView(session.id)).lastDecisionAt).toBe(stored.at.toISOString());
  });

  it.each([
    ['the column default {}', {}],
    ['v1 with an extra key', { ...sessionSettings(), extra: 1 }],
    ['another version', { ...sessionSettings(), version: 2 }],
  ])(
    'shows settings as null for %s, and the view still passes its schema',
    async (_label, settings) => {
      const { userId } = await seedUser(db());
      const accountId = await seedBrokerAccount(db(), userId);
      const id = await insertStoppedSession(db(), accountId, { secondsAgo: 0, settings });
      const view = await sessionView(id);
      expect(view.settings).toBeNull();
      expect(adminTradingSessionViewSchema.safeParse(view).success).toBe(true);
    },
  );
});

describe('readUserIntentsSection (#330)', () => {
  const db = withDatabase();
  let userU = '';
  let userEmpty = '';
  const uIds: string[] = [];
  const nonTerminal = Object.values(TradeIntentStatus).filter((s) => !isTerminal(s));

  beforeAll(async () => {
    userU = (await seedUser(db())).userId;
    const userV = (await seedUser(db())).userId;
    userEmpty = (await seedUser(db())).userId;
    let age = 0;
    // one non-terminal intent per account (trade_intents_active_account_idx)
    for (const status of nonTerminal) {
      const brokerAccountId = await seedBrokerAccount(db(), userU);
      const row = await insertIntent(db(), {
        userId: userU,
        brokerAccountId,
        status,
        secondsAgo: (age += 1),
      });
      uIds.push(row.id);
    }
    const terminalAccount = await seedBrokerAccount(db(), userU);
    while (uIds.length < 25) {
      const row = await insertIntent(db(), {
        userId: userU,
        brokerAccountId: terminalAccount,
        status: uIds.length % 2 === 0 ? TradeIntentStatus.Settled : TradeIntentStatus.Rejected,
        secondsAgo: (age += 1),
      });
      uIds.push(row.id);
    }
    // the other user's intents are newer than all of U's, a non-terminal one included
    const accountV = await seedBrokerAccount(db(), userV);
    for (const status of [TradeIntentStatus.Queued, TradeIntentStatus.Settled]) {
      await insertIntent(db(), { userId: userV, brokerAccountId: accountV, status, secondsAgo: 0 });
    }
  });

  const section = (userId: string) => db().transaction((tx) => readUserIntentsSection(tx, userId));

  it("shows the user's newest ADMIN_USER_RECENT_INTENTS, counts all and the non-terminal ones", async () => {
    const read = await section(userU);
    expect(read.recent.map((r) => r.id)).toEqual(uIds.slice(0, ADMIN_USER_RECENT_INTENTS));
    expect(read.total).toBe(25);
    expect(nonTerminal).toHaveLength(8);
    expect(read.active).toBe(nonTerminal.length);
  });

  it('is empty and zero for a user without intents while others have some', async () => {
    expect(await section(userEmpty)).toEqual({ recent: [], total: 0, active: 0 });
  });
});
