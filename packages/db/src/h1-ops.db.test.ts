import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  buildH1SessionSettings,
  decimalStringSchema,
  TradingSessionStatus,
  TradingSessionStopReason,
  type TradingSessionSettings,
} from '@binarius/shared';
import {
  listActiveH1Sessions,
  listH1Accounts,
  readActiveH1Session,
  readH1Account,
  readLastH1Session,
  setH1Mark,
} from './h1-ops';
import { auditLog, brokerAccounts, tradingSessions } from './schema/index';
import {
  brokerAccountRow,
  createTempDatabase,
  seedTradingSession,
  seedUserWithAccount,
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

// every case starts with no marked account and no active session in this file's database
beforeEach(async () => {
  await tmp.db.update(brokerAccounts).set({ h1Since: null });
  await tmp.db
    .update(tradingSessions)
    .set({
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.UserStopped,
      endedAt: sql`now()`,
    })
    .where(eq(tradingSessions.status, TradingSessionStatus.Active));
});

const h1Settings = (): TradingSessionSettings => {
  const built = buildH1SessionSettings({
    assetId: 101,
    trades: 10,
    stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 2 },
    maxLossMultiplier: 20,
  });
  if (!built.success) throw new Error('H1 fixture settings do not parse');
  return built.data;
};

const mark = (accountId: string, h1: boolean) =>
  tmp.db.transaction((tx) => setH1Mark(tx, { accountId, h1 }));

const auditRows = (accountId: string) =>
  tmp.db
    .select({ action: auditLog.action, payload: auditLog.payload, actorType: auditLog.actorType })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'broker_account'), eq(auditLog.entityId, accountId)));

describe('setH1Mark (#670)', () => {
  // the audit rows are the callers' (#745): the CLI's in h1-mark.db.test.ts, the admin route's
  it('H1-M1 marks once: a re-mark keeps the first date; setH1Mark itself writes no audit row', async () => {
    const { brokerAccountId } = await seedUserWithAccount(tmp.db);
    expect(await mark(brokerAccountId, true)).toBe('marked');
    const first = (await brokerAccountRow(tmp.db, brokerAccountId)).h1Since;
    expect(first).toBeInstanceOf(Date);
    expect(await mark(brokerAccountId, true)).toBe('unchanged');
    expect((await brokerAccountRow(tmp.db, brokerAccountId)).h1Since).toEqual(first);
    expect(await auditRows(brokerAccountId)).toEqual([]);
  });

  it('H1-M2 unmarks a marked account without a session; a second unmark is unchanged', async () => {
    const { brokerAccountId } = await seedUserWithAccount(tmp.db);
    await mark(brokerAccountId, true);
    expect(await mark(brokerAccountId, false)).toBe('unmarked');
    expect((await brokerAccountRow(tmp.db, brokerAccountId)).h1Since).toBeNull();
    expect(await mark(brokerAccountId, false)).toBe('unchanged');
    expect(await auditRows(brokerAccountId)).toEqual([]);
  });

  it('H1-M3 answers not_found for an unknown account, both ways, and writes nothing', async () => {
    const id = randomUUID();
    expect(await mark(id, true)).toBe('not_found');
    expect(await mark(id, false)).toBe('not_found');
    expect(await auditRows(id)).toEqual([]);
  });

  it('H1-M4 keeps the mark while an H1 session is active; another active session does not', async () => {
    const h1 = await seedUserWithAccount(tmp.db);
    await mark(h1.brokerAccountId, true);
    await seedTradingSession(tmp.db, h1.brokerAccountId, { settings: h1Settings() });
    expect(await mark(h1.brokerAccountId, false)).toBe('active_session');
    expect((await brokerAccountRow(tmp.db, h1.brokerAccountId)).h1Since).toBeInstanceOf(Date);

    const bot = await seedUserWithAccount(tmp.db);
    await mark(bot.brokerAccountId, true);
    await seedTradingSession(tmp.db, bot.brokerAccountId);
    expect(await mark(bot.brokerAccountId, false)).toBe('unmarked');
  });

  it('H1-M5 a stopped H1 session does not hold the mark; the mark changes nothing else on the row', async () => {
    const { brokerAccountId } = await seedUserWithAccount(tmp.db);
    await tmp.db
      .update(brokerAccounts)
      .set({ serviceSince: sql`now() - interval '1 day'`, status: BrokerAccountStatus.Revoked })
      .where(eq(brokerAccounts.id, brokerAccountId));
    const before = await brokerAccountRow(tmp.db, brokerAccountId);
    await mark(brokerAccountId, true);
    const session = await seedTradingSession(tmp.db, brokerAccountId, { settings: h1Settings() });
    await tmp.db
      .update(tradingSessions)
      .set({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.UserStopped,
        endedAt: sql`now()`,
      })
      .where(eq(tradingSessions.id, session.id));
    expect(await mark(brokerAccountId, false)).toBe('unmarked');
    const after = await brokerAccountRow(tmp.db, brokerAccountId);
    expect({ ...after, h1Since: null, updatedAt: null }).toEqual({
      ...before,
      h1Since: null,
      updatedAt: null,
    });
  });
});

describe('the H1 reads (#670)', () => {
  it('H1-M6 lists the marked accounts, oldest mark first, with the active H1 session only', async () => {
    const first = await seedUserWithAccount(tmp.db);
    const second = await seedUserWithAccount(tmp.db);
    const unmarked = await seedUserWithAccount(tmp.db);
    await mark(first.brokerAccountId, true);
    await tmp.db
      .update(brokerAccounts)
      .set({ h1Since: sql`now() - interval '1 hour'` })
      .where(eq(brokerAccounts.id, first.brokerAccountId));
    await mark(second.brokerAccountId, true);
    const session = await seedTradingSession(tmp.db, first.brokerAccountId, {
      settings: h1Settings(),
    });
    await seedTradingSession(tmp.db, second.brokerAccountId);
    await seedTradingSession(tmp.db, unmarked.brokerAccountId, { settings: h1Settings() });

    const listed = await listH1Accounts(tmp.db);
    expect(listed.map((row) => [row.id, row.activeSessionId])).toEqual([
      [first.brokerAccountId, session.id],
      [second.brokerAccountId, null],
    ]);
    expect(listed[0]).toMatchObject({
      telegramUserId: first.telegramUserId,
      userId: first.userId,
      tradingMode: 'demo',
      status: 'active',
      tradingHalted: false,
    });
    expect(await readH1Account(tmp.db, unmarked.brokerAccountId)).toMatchObject({
      id: unmarked.brokerAccountId,
      h1Since: null,
      telegramUserId: unmarked.telegramUserId,
    });
    expect(await readH1Account(tmp.db, randomUUID())).toBeUndefined();
  });

  it('H1-M7 tells an active H1 session from another one and finds the newest H1 session', async () => {
    const { brokerAccountId } = await seedUserWithAccount(tmp.db);
    expect(await readActiveH1Session(tmp.db, brokerAccountId)).toBeUndefined();
    expect(await readLastH1Session(tmp.db, brokerAccountId)).toBeUndefined();

    const bot = await seedTradingSession(tmp.db, brokerAccountId);
    expect(await readActiveH1Session(tmp.db, brokerAccountId)).toEqual({ id: bot.id, isH1: false });
    expect(await readLastH1Session(tmp.db, brokerAccountId)).toBeUndefined();
    await tmp.db
      .update(tradingSessions)
      .set({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.UserStopped,
        endedAt: sql`now()`,
      })
      .where(eq(tradingSessions.id, bot.id));

    const old = await seedTradingSession(tmp.db, brokerAccountId, {
      settings: h1Settings(),
      startedAt: new Date(Date.now() - 7_200_000),
    });
    await tmp.db
      .update(tradingSessions)
      .set({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.Timeout,
        endedAt: sql`now()`,
      })
      .where(eq(tradingSessions.id, old.id));
    expect(await readLastH1Session(tmp.db, brokerAccountId)).toBe(old.id);

    const live = await seedTradingSession(tmp.db, brokerAccountId, {
      settings: h1Settings(),
      startedAt: new Date(Date.now() - 3_600_000 * 3),
    });
    expect(await readActiveH1Session(tmp.db, brokerAccountId)).toEqual({ id: live.id, isH1: true });
    expect(await readLastH1Session(tmp.db, brokerAccountId)).toBe(live.id);
  });

  it("H1-M8 the driver's list (#707): active H1 sessions on marked accounts only, with the owner and settings", async () => {
    const marked = await seedUserWithAccount(tmp.db);
    const unmarked = await seedUserWithAccount(tmp.db);
    const other = await seedUserWithAccount(tmp.db);
    expect(await mark(marked.brokerAccountId, true)).toBe('marked');
    expect(await mark(other.brokerAccountId, true)).toBe('marked');
    const live = await seedTradingSession(tmp.db, marked.brokerAccountId, {
      settings: h1Settings(),
    });
    // a v4 row on an unmarked account: only by hand after #707's lock
    await seedTradingSession(tmp.db, unmarked.brokerAccountId, { settings: h1Settings() });
    // not an H1 session on a marked account
    await seedTradingSession(tmp.db, other.brokerAccountId);

    const list = await listActiveH1Sessions(tmp.db);
    expect(list).toEqual([
      {
        id: live.id,
        brokerAccountId: marked.brokerAccountId,
        mode: 'demo',
        telegramUserId: marked.telegramUserId,
        settings: h1Settings(),
        startedAt: expect.any(Date),
      },
    ]);
  });
});
