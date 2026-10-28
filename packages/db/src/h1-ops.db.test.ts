import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildH1SessionSettings,
  decimalStringSchema,
  TradingSessionStatus,
  TradingSessionStopReason,
  type TradingSessionSettings,
  SessionStakeStrategy,
} from '@binarius/shared';
import {
  listActiveH1Sessions,
  readActiveH1Session,
  readH1Account,
  readLastH1Session,
} from './h1-ops';
import { tradingSessions } from './schema/index';
import {
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

// every case starts with no active session in this file's database
beforeEach(async () => {
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
    cycles: 5,
    stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 2 },
    strategy: SessionStakeStrategy.Martingale,
  });
  if (!built.success) throw new Error('H1 fixture settings do not parse');
  return built.data;
};

describe('the H1 reads (#670)', () => {
  it('H1-M7 reads the account with its owner, tells an active H1 session from another one and finds the newest H1 session', async () => {
    const { brokerAccountId, telegramUserId, userId } = await seedUserWithAccount(tmp.db);
    expect(await readH1Account(tmp.db, brokerAccountId)).toEqual({
      id: brokerAccountId,
      status: 'active',
      tradingHalted: false,
      userId,
      userStatus: 'active',
      telegramUserId,
      tradingMode: 'demo',
    });
    expect(await readH1Account(tmp.db, randomUUID())).toBeUndefined();
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

  it("H1-M8′ the driver's list (#707, #828): every active H1 session, with the owner and settings", async () => {
    const one = await seedUserWithAccount(tmp.db);
    const two = await seedUserWithAccount(tmp.db);
    const other = await seedUserWithAccount(tmp.db);
    const first = await seedTradingSession(tmp.db, one.brokerAccountId, {
      settings: h1Settings(),
    });
    const second = await seedTradingSession(tmp.db, two.brokerAccountId, {
      settings: h1Settings(),
    });
    // not an H1 session
    await seedTradingSession(tmp.db, other.brokerAccountId);

    const list = await listActiveH1Sessions(tmp.db);
    const row = (id: string, seed: { brokerAccountId: string; telegramUserId: string }) => ({
      id,
      brokerAccountId: seed.brokerAccountId,
      mode: 'demo',
      telegramUserId: seed.telegramUserId,
      settings: h1Settings(),
      startedAt: expect.any(Date),
    });
    expect([...list].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [row(first.id, one), row(second.id, two)].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
