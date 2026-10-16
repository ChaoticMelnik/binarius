import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradingSessionStopReason,
  decimalStringSchema,
  type DecimalString,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import { tradingSessions, users } from './schema/index';
import {
  claimSessionFinalNotice,
  claimSessionTradeNotice,
  listPendingSessionNotices,
  releaseSessionFinalNotice,
  releaseSessionTradeNotice,
} from './session-notice-ops';
import {
  createTempDatabase,
  seedTradingSession,
  seedUserWithAccount,
  type TempDatabase,
} from './testing';
import {
  markIntentAccepted,
  rejectIntent,
  settleIntent,
  takeIntent,
  transitionIntent,
  type TradeIntentRow,
} from './trade-intent-ops';
import { createSessionIntent, stopTradingSession } from './trading-session-ops';

// The session notices' cursor and marks (#464, docs/bot-session.md → Trade messages), on a
// temporary migrated database. Every case reads its own sessions only: the list scans them all.
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

type Seed = Awaited<ReturnType<typeof seedUserWithAccount>>;

async function seedSession() {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
  return { seed, session, step: 0 };
}

const intentOf = async (
  { seed, session }: { seed: Seed; session: { id: string } },
  step: number,
  amount = '5',
) =>
  (
    await createSessionIntent(tmp.db, {
      sessionId: session.id,
      step,
      telegramUserId: seed.telegramUserId,
      brokerAccountId: seed.brokerAccountId,
      mode: 'demo',
      assetId: 101,
      amount: decimalStringSchema.parse(amount),
      action: TradeAction.Up,
      durationSec: 60,
    })
  ).intent;

async function accept(intent: TradeIntentRow, openPrice: number) {
  const taken = (await takeIntent(tmp.db, {
    id: intent.id,
    expectedVersion: intent.version,
    maxAgeMs: 60_000,
  }))!;
  const open = openTradeFor(intent, { openPrice });
  await tmp.db.transaction((tx) =>
    markIntentAccepted(tx, {
      id: taken.id,
      expectedVersion: taken.version,
      transport: 'rest_fallback',
      trade: open,
    }),
  );
  return open;
}

// the next step of the session, settled at `profit` and its own prices
async function settled(
  target: Awaited<ReturnType<typeof seedSession>>,
  profit: string,
  amount = '5',
): Promise<TradeIntentRow> {
  target.step += 1;
  const intent = await intentOf(target, target.step, amount);
  const open = await accept(intent, target.step);
  await tmp.db.transaction((tx) =>
    settleIntent(tx, {
      id: intent.id,
      from: TradeIntentStatus.Accepted,
      trade: closedTradeFor(open, {
        profit: profit as DecimalString,
        closePrice: target.step + 0.5,
      }),
    }),
  );
  return intent;
}

async function rejected(target: Awaited<ReturnType<typeof seedSession>>) {
  target.step += 1;
  const intent = await intentOf(target, target.step);
  await tmp.db.transaction((tx) =>
    rejectIntent(tx, {
      id: intent.id,
      from: TradeIntentStatus.Queued,
      expectedVersion: intent.version,
      reason: TradeIntentFailureReason.BrokerRejected,
    }),
  );
}

// the next step of the session on manual review: submitting → unknown → reconciling → review
async function onReview(target: Awaited<ReturnType<typeof seedSession>>) {
  target.step += 1;
  const intent = await intentOf(target, target.step);
  let row = (await takeIntent(tmp.db, {
    id: intent.id,
    expectedVersion: intent.version,
    maxAgeMs: 60_000,
  }))!;
  for (const [from, to] of [
    [TradeIntentStatus.Submitting, TradeIntentStatus.Unknown],
    [TradeIntentStatus.Unknown, TradeIntentStatus.Reconciling],
    [TradeIntentStatus.Reconciling, TradeIntentStatus.ManualReview],
  ] as const) {
    row = (await transitionIntent(tmp.db, { id: row.id, from, to, expectedVersion: row.version }))!;
  }
  return row;
}

const stop = (
  session: { id: string },
  reason: TradingSessionStopReason = TradingSessionStopReason.Completed,
) => stopTradingSession(tmp.db, { id: session.id, reason });
const claim = (session: { id: string }, claimed: number) =>
  claimSessionTradeNotice(tmp.db, { sessionId: session.id, claimed });
const finalClaim = (session: { id: string }) =>
  claimSessionFinalNotice(tmp.db, { sessionId: session.id });
const rowOf = async (session: { id: string }) =>
  (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, session.id)))[0]!;
const pendingOf = async (session: { id: string }) =>
  (await listPendingSessionNotices(tmp.db, { limit: 10_000 })).find(
    (row) => row.sessionId === session.id,
  );

describe('claimSessionTradeNotice', () => {
  it('N1 claims the first settled trade once, with its stake, outcome, class and prices', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    expect(await claim(target.session, 0)).toEqual({
      trade: {
        amount: '5.00000000',
        outcome: '4.60000000',
        result: 'won',
        openPrice: 1,
        closePrice: 1.5,
        assetId: 101,
      },
      results: ['won'],
    });
    expect((await rowOf(target.session)).notifiedTrades).toBe(1);
    expect(await claim(target.session, 0)).toBeUndefined();
    // no second settled trade yet
    expect(await claim(target.session, 1)).toBeUndefined();
    expect((await rowOf(target.session)).notifiedTrades).toBe(1);
  });

  it('N2 two claims of the same trade at once: exactly one wins', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    const results = await Promise.all([claim(target.session, 0), claim(target.session, 0)]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
    expect((await rowOf(target.session)).notifiedTrades).toBe(1);
  });

  it('N3 claims the trades in creation order; a rejected step is no trade', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await rejected(target);
    await settled(target, '-5');
    await settled(target, '0');
    const claimed = [];
    for (let index = 0; index < 3; index += 1) claimed.push(await claim(target.session, index));
    expect(claimed.map((row) => row?.trade.openPrice)).toEqual([1, 3, 4]);
    expect(claimed.at(-1)?.results).toEqual(['won', 'lost', 'tied']);
    expect(await claim(target.session, 3)).toBeUndefined();
  });

  it.each([
    ['4.6', '4.60000000', 'won'],
    ['0.001', '0.00100000', 'won'],
    ['-5', '-5.00000000', 'lost'],
    ['-2.5', '-2.50000000', 'lost'],
    ['0', '0.00000000', 'tied'],
  ])(
    'N4 a stake of 5 at profit %s prints its profit %s (#539), %s',
    async (profit, outcome, result) => {
      const target = await seedSession();
      await settled(target, profit);
      expect((await claim(target.session, 0))?.trade).toMatchObject({ outcome, result });
    },
  );

  it('N5 a release puts the trade back once; a stale one changes nothing', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await claim(target.session, 0);
    expect(
      await releaseSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 0 }),
    ).toBe(true);
    expect((await rowOf(target.session)).notifiedTrades).toBe(0);
    expect(
      await releaseSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 0 }),
    ).toBe(false);
    expect((await claim(target.session, 0))?.trade.openPrice).toBe(1);
    expect(
      await releaseSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 1 }),
    ).toBe(false);
    expect((await rowOf(target.session)).notifiedTrades).toBe(1);
  });
});

describe('claimSessionFinalNotice', () => {
  it('N6 is refused while the session runs, a trade is on review or unclaimed; granted once', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    expect(await finalClaim(target.session)).toBe(false);
    await stop(target.session);
    // its one trade is not claimed yet
    expect(await finalClaim(target.session)).toBe(false);
    await claim(target.session, 0);
    expect(await finalClaim(target.session)).toBe(true);
    expect((await rowOf(target.session)).finalNoticeSentAt).toBeInstanceOf(Date);
    expect(await finalClaim(target.session)).toBe(false);
    // a summary sent closes the cursor: no trade claim or release after it
    expect(
      await releaseSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 0 }),
    ).toBe(false);
  });

  it('N6 a finished session with no settled trade is granted at once', async () => {
    const target = await seedSession();
    await rejected(target);
    await stop(target.session, TradingSessionStopReason.UserStopped);
    expect(await finalClaim(target.session)).toBe(true);
  });

  it('N8 a trade on review holds the summary; once settled it is claimed, then the summary', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    const review = await onReview(target);
    await stop(target.session, TradingSessionStopReason.ManualReview);
    await claim(target.session, 0);
    expect(await pendingOf(target.session)).toBeUndefined();
    expect(await finalClaim(target.session)).toBe(false);

    await tmp.db.transaction((tx) =>
      settleIntent(tx, {
        id: review.id,
        from: TradeIntentStatus.ManualReview,
        trade: closedTradeFor(openTradeFor(review, { openPrice: 7 }), {
          profit: '-5' as DecimalString,
          closePrice: 6,
        }),
      }),
    );
    expect(await pendingOf(target.session)).toMatchObject({
      notifiedTrades: 1,
      settled: 2,
      finished: true,
    });
    expect(await finalClaim(target.session)).toBe(false);
    expect((await claim(target.session, 1))?.trade).toMatchObject({
      openPrice: 7,
      result: 'lost',
    });
    expect(await finalClaim(target.session)).toBe(true);
    expect(await pendingOf(target.session)).toBeUndefined();
  });
});

describe('releaseSessionFinalNotice', () => {
  it('N9 takes the summary mark back only while the card was not claimed on it', async () => {
    const target = await seedSession();
    await stop(target.session, TradingSessionStopReason.UserStopped);
    expect(await releaseSessionFinalNotice(tmp.db, { sessionId: target.session.id })).toBe(false);
    await finalClaim(target.session);
    expect(await releaseSessionFinalNotice(tmp.db, { sessionId: target.session.id })).toBe(true);
    expect((await rowOf(target.session)).finalNoticeSentAt).toBeNull();
    await finalClaim(target.session);
    await tmp.db
      .update(tradingSessions)
      .set({ summarySentAt: sql`now()` })
      .where(eq(tradingSessions.id, target.session.id));
    expect(await releaseSessionFinalNotice(tmp.db, { sessionId: target.session.id })).toBe(false);
    expect((await rowOf(target.session)).finalNoticeSentAt).toBeInstanceOf(Date);
  });
});

describe('listPendingSessionNotices', () => {
  it('N7 lists a session with a trade past its cursor or finished, with its owner and block', async () => {
    const quiet = await seedSession();
    const fresh = await seedSession();
    await settled(fresh, '4.6');
    const ended = await seedSession();
    await stop(ended.session, TradingSessionStopReason.UserStopped);
    const sent = await seedSession();
    await stop(sent.session, TradingSessionStopReason.UserStopped);
    await finalClaim(sent.session);
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, fresh.seed.userId));

    expect(await pendingOf(quiet.session)).toBeUndefined();
    expect(await pendingOf(sent.session)).toBeUndefined();
    expect(await pendingOf(fresh.session)).toMatchObject({
      notifiedTrades: 0,
      settled: 1,
      finished: false,
      telegramUserId: BigInt(fresh.seed.telegramUserId),
      telegramBlocked: true,
    });
    expect(await pendingOf(ended.session)).toMatchObject({
      settled: 0,
      finished: true,
      telegramUserId: BigInt(ended.seed.telegramUserId),
      telegramBlocked: false,
    });
    // claimed: nothing new until the next trade
    await claim(fresh.session, 0);
    expect(await pendingOf(fresh.session)).toBeUndefined();
  });

  it('N7 lists the oldest first and stops at its limit', async () => {
    const all = await listPendingSessionNotices(tmp.db, { limit: 10_000 });
    const firstTwo = await listPendingSessionNotices(tmp.db, { limit: 2 });
    expect(firstTwo).toEqual(all.slice(0, 2));
  });
});

// The backfill (0050) as the deploy runs it: the cursor at every session's settled trades, the
// mark on every stopped one. Its SQL is read from the migration file and run over sessions put
// back to the state before it.
describe('migration 0050 (the backfill)', () => {
  it('starts the notices from the deploy: nothing settled before it is sent', async () => {
    const running = await seedSession();
    await settled(running, '4.6');
    await rejected(running);
    await settled(running, '-5');
    const ended = await seedSession();
    await settled(ended, '0');
    await stop(ended.session);
    const ids = [running.session.id, ended.session.id];
    await tmp.db
      .update(tradingSessions)
      .set({ notifiedTrades: 0, finalNoticeSentAt: null })
      .where(sql`${tradingSessions.id} in (${sql.join(ids, sql`, `)})`);

    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'drizzle',
      '0050_session_notices_backfill.sql',
    );
    for (const statement of (await readFile(file, 'utf8')).split('--> statement-breakpoint')) {
      await tmp.pool.query(statement);
    }

    expect(await rowOf(running.session)).toMatchObject({
      notifiedTrades: 2,
      finalNoticeSentAt: null,
    });
    expect(await rowOf(ended.session)).toMatchObject({
      notifiedTrades: 1,
      finalNoticeSentAt: expect.any(Date),
    });
    expect(await pendingOf(running.session)).toBeUndefined();
  });
});
