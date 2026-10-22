import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradingSessionStatus,
  TradingSessionStopReason,
  buildH1SessionSettings,
  decimalStringSchema,
  type DecimalString,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import { tradingSessions, users } from './schema/index';
import {
  claimSessionFinalNotice,
  claimSessionOpenNotice,
  claimSessionTradeNotice,
  claimSessionTradeNotices,
  claimSessionWaiting,
  clearSessionWaitingMessage,
  listPendingSessionNotices,
  readSessionWaitingMessage,
  recordSessionWaitingMessage,
  claimSummaryFallback,
  listSummaryFallback,
  recordSessionCycleMessage,
  releaseSummaryFallback,
  releaseSessionOpenNotice,
  releaseSessionTradeNotice,
  releaseSessionTradeNotices,
  releaseSessionWaiting,
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

async function seedSession(settings?: unknown) {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(
    tmp.db,
    seed.brokerAccountId,
    settings === undefined ? {} : { settings },
  );
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
      decision: null,
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

// the next step of the session, open at the broker (#700)
async function opened(target: Awaited<ReturnType<typeof seedSession>>, amount = '5') {
  target.step += 1;
  const intent = await intentOf(target, target.step, amount);
  return { intent, open: await accept(intent, target.step) };
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
const finalClaim = (session: { id: string }, closeSummary = false) =>
  claimSessionFinalNotice(tmp.db, { sessionId: session.id, closeSummary });
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
      trades: [
        {
          amount: '5.00000000',
          outcome: '9.60000000',
          result: 'won',
          openPrice: 1,
          closePrice: 1.5,
          assetId: 101,
        },
      ],
      cycleMessage: null,
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
    expect(claimed.map((row) => row?.trades.at(-1)?.openPrice)).toEqual([1, 3, 4]);
    // every settled trade up to the claimed one, in order: its cycle's blocks
    expect(claimed.at(-1)?.trades.map((row) => [row.openPrice, row.result, row.outcome])).toEqual([
      [1, 'won', '9.60000000'],
      [3, 'lost', '-5.00000000'],
      [4, 'tied', '0.00000000'],
    ]);
    expect(await claim(target.session, 3)).toBeUndefined();
  });

  it.each([
    ['5', '4.6', '9.60000000', 'won'],
    ['5', '0.001', '5.00100000', 'won'],
    ['5', '-5', '-5.00000000', 'lost'],
    ['5', '-2.5', '-2.50000000', 'lost'],
    ['5', '0', '0.00000000', 'tied'],
    ['0.005', '0.0046', '0.00960000', 'won'],
  ])(
    'N4 a stake of %s at profit %s prints %s after the arrow (#684), %s',
    async (amount, profit, outcome, result) => {
      const target = await seedSession();
      await settled(target, profit, amount);
      expect((await claim(target.session, 0))?.trades.at(-1)).toMatchObject({ outcome, result });
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
    expect((await claim(target.session, 0))?.trades.at(-1)?.openPrice).toBe(1);
    expect(
      await releaseSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 1 }),
    ).toBe(false);
    expect((await rowOf(target.session)).notifiedTrades).toBe(1);
  });
});

describe('claimSessionTradeNotices (#707, the H1 summary)', () => {
  const claimBatch = (session: { id: string }, from: number, to: number) =>
    claimSessionTradeNotices(tmp.db, { sessionId: session.id, from, to });

  it('N24 claims up to the settled count, never past it', async () => {
    const target = await seedSession();
    for (const profit of ['4.6', '-5', '4.6']) await settled(target, profit);
    expect(await claimBatch(target.session, 0, 4)).toBeUndefined();
    expect((await rowOf(target.session)).notifiedTrades).toBe(0);
    expect(await claimBatch(target.session, 0, 3)).toEqual({
      totals: { won: 2, lost: 1, tied: 0, result: '4.20000000' },
      cycleMessage: null,
    });
    expect((await rowOf(target.session)).notifiedTrades).toBe(3);
  });

  it('N25 a batch claims from the cursor only: a stale from loses', async () => {
    const target = await seedSession();
    for (const profit of ['4.6', '-5', '0']) await settled(target, profit);
    expect(await claimBatch(target.session, 0, 2)).toBeDefined();
    expect(await claimBatch(target.session, 0, 3)).toBeUndefined();
    expect((await rowOf(target.session)).notifiedTrades).toBe(2);
    expect((await claimBatch(target.session, 2, 3))?.totals).toEqual({
      won: 1,
      lost: 1,
      tied: 1,
      result: '-0.40000000',
    });
  });

  it('N26 the totals are of the first `to` settled trades in order; a rejected step is none', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await rejected(target);
    await settled(target, '-5');
    await settled(target, '4.6');
    expect((await claimBatch(target.session, 0, 2))?.totals).toEqual({
      won: 1,
      lost: 1,
      tied: 0,
      result: '-0.40000000',
    });
  });

  it('N27 a release puts the batch back once; the closed notices refuse a claim', async () => {
    const target = await seedSession();
    for (const profit of ['4.6', '4.6']) await settled(target, profit);
    await claimBatch(target.session, 0, 2);
    const release = () =>
      releaseSessionTradeNotices(tmp.db, { sessionId: target.session.id, from: 0, to: 2 });
    expect(await release()).toBe(true);
    expect((await rowOf(target.session)).notifiedTrades).toBe(0);
    expect(await release()).toBe(false);
    expect(await claimBatch(target.session, 0, 2)).toBeDefined();
    await stop(target.session);
    expect(await finalClaim(target.session)).toBe(true);
    expect(await release()).toBe(false);
    expect((await rowOf(target.session)).notifiedTrades).toBe(2);
  });
});

describe('the cycle message (#551)', () => {
  const record = (session: { id: string }, claimed: number, messageId: number, from: number) =>
    recordSessionCycleMessage(tmp.db, {
      sessionId: session.id,
      cursor: claimed + 1,
      messageId,
      from,
    });
  const stateOf = async (session: { id: string }) => {
    const row = await rowOf(session);
    return [row.cycleMessageId, row.cycleMessageFrom];
  };

  it('N10 is recorded only while the cursor stands right after the claimed trade and no summary was sent', async () => {
    const target = await seedSession();
    await settled(target, '-5');
    await settled(target, '-5');
    await claim(target.session, 0);
    expect(await record(target.session, 0, 41, 0)).toBe(true);
    expect(await stateOf(target.session)).toEqual([41, 0]);
    // the cursor moved on: a sender whose claim was overtaken writes nothing
    await claim(target.session, 1);
    expect(await record(target.session, 0, 99, 0)).toBe(false);
    expect(await stateOf(target.session)).toEqual([41, 0]);
    // nor one behind the cursor's last claim
    expect(await record(target.session, 2, 99, 0)).toBe(false);
    expect(await record(target.session, 1, 42, 1)).toBe(true);
    expect(await stateOf(target.session)).toEqual([42, 1]);
    await stop(target.session);
    await finalClaim(target.session);
    expect(await record(target.session, 1, 99, 0)).toBe(false);
    expect(await stateOf(target.session)).toEqual([42, 1]);
  });

  it('N11 a release and the next claim leave the cycle message as it is', async () => {
    const target = await seedSession();
    await settled(target, '-5');
    await settled(target, '-5');
    await claim(target.session, 0);
    await record(target.session, 0, 41, 0);
    await claim(target.session, 1);
    expect(
      await releaseSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 1 }),
    ).toBe(true);
    expect(await stateOf(target.session)).toEqual([41, 0]);
    await claim(target.session, 1);
    expect(await stateOf(target.session)).toEqual([41, 0]);
  });

  it('N12 the claim returns the recorded cycle message', async () => {
    const target = await seedSession();
    await settled(target, '-5');
    await settled(target, '0');
    expect((await claim(target.session, 0))?.cycleMessage).toBeNull();
    await record(target.session, 0, 41, 0);
    expect((await claim(target.session, 1))?.cycleMessage).toEqual({ messageId: 41, from: 0 });
  });
});

describe("the open trade's block (#700)", () => {
  const openClaim = (session: { id: string }, intentId: string, settled: number) =>
    claimSessionOpenNotice(tmp.db, { sessionId: session.id, intentId, settled });
  const openRelease = (session: { id: string }, intentId: string) =>
    releaseSessionOpenNotice(tmp.db, { sessionId: session.id, intentId });
  const markOf = async (session: { id: string }) => (await rowOf(session)).openNoticeIntentId;
  const settleOpen = ({ intent, open }: Awaited<ReturnType<typeof opened>>) =>
    tmp.db.transaction((tx) =>
      settleIntent(tx, {
        id: intent.id,
        from: TradeIntentStatus.Accepted,
        trade: closedTradeFor(open, { profit: '-5' as DecimalString, closePrice: 9.5 }),
      }),
    );

  it('N30 claims the open trade once, with the settled trades above it and its stake, direction, open price and asset', async () => {
    const target = await seedSession();
    await settled(target, '-5');
    await claim(target.session, 0);
    const trade = await opened(target, '11.5');
    expect(await openClaim(target.session, trade.intent.id, 1)).toEqual({
      trades: [
        {
          amount: '5.00000000',
          outcome: '-5.00000000',
          result: 'lost',
          openPrice: 1,
          closePrice: 1.5,
          assetId: 101,
        },
      ],
      open: { amount: '11.50000000', action: 'up', openPrice: 2, assetId: 101 },
      cycleMessage: null,
    });
    expect(await markOf(target.session)).toBe(trade.intent.id);
    // the cursor is untouched: the open block is no settled trade
    expect((await rowOf(target.session)).notifiedTrades).toBe(1);
    expect(await openClaim(target.session, trade.intent.id, 1)).toBeUndefined();
  });

  it('N30 the first trade of the session: no settled trade above it', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    expect(await openClaim(target.session, trade.intent.id, 0)).toMatchObject({
      trades: [],
      open: { openPrice: 1 },
    });
  });

  it('N31 two claims of the same open trade at once: exactly one wins', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    const results = await Promise.all([
      openClaim(target.session, trade.intent.id, 0),
      openClaim(target.session, trade.intent.id, 0),
    ]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
    expect(await markOf(target.session)).toBe(trade.intent.id);
  });

  it('N32 is refused while a settled trade above it is not claimed yet', async () => {
    const target = await seedSession();
    await settled(target, '-5');
    const trade = await opened(target);
    // the cursor behind the settled trades, whether the caller counts them or not
    expect(await openClaim(target.session, trade.intent.id, 1)).toBeUndefined();
    expect(await openClaim(target.session, trade.intent.id, 0)).toBeUndefined();
    expect(await markOf(target.session)).toBeNull();
    await claim(target.session, 0);
    expect(await openClaim(target.session, trade.intent.id, 1)).toBeDefined();
  });

  it('N32 is refused once the trade settled, and for an intent that is not open at the broker', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    await settleOpen(trade);
    // its result claimed: the counts match, only the open trade refuses
    await claim(target.session, 0);
    expect(await openClaim(target.session, trade.intent.id, 1)).toBeUndefined();
    target.step += 1;
    const queued = await intentOf(target, target.step);
    expect(await openClaim(target.session, queued.id, 1)).toBeUndefined();
    expect(await markOf(target.session)).toBeNull();
  });

  it('N32 is refused once the notices are closed', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    await tmp.db
      .update(tradingSessions)
      .set({ finalNoticeSentAt: sql`now()` })
      .where(eq(tradingSessions.id, target.session.id));
    expect(await openClaim(target.session, trade.intent.id, 0)).toBeUndefined();
    expect(await markOf(target.session)).toBeNull();
  });

  it('N33 a release clears only its own intent, and the block is claimable again', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    await openClaim(target.session, trade.intent.id, 0);
    expect(await openRelease(target.session, randomUUID())).toBe(false);
    expect(await markOf(target.session)).toBe(trade.intent.id);
    expect(await openRelease(target.session, trade.intent.id)).toBe(true);
    expect(await markOf(target.session)).toBeNull();
    expect(await openRelease(target.session, trade.intent.id)).toBe(false);
    expect(await openClaim(target.session, trade.intent.id, 0)).toBeDefined();
  });

  it("N34 the open block's message is recorded only at its cursor with its intent still marked", async () => {
    const target = await seedSession();
    await settled(target, '-5');
    await claim(target.session, 0);
    const trade = await opened(target);
    await openClaim(target.session, trade.intent.id, 1);
    const record = (cursor: number, openIntentId: string, messageId: number) =>
      recordSessionCycleMessage(tmp.db, {
        sessionId: target.session.id,
        cursor,
        openIntentId,
        messageId,
        from: 1,
      });
    expect(await record(1, randomUUID(), 99)).toBe(false);
    expect(await record(0, trade.intent.id, 99)).toBe(false);
    expect((await rowOf(target.session)).cycleMessageId).toBeNull();
    expect(await record(1, trade.intent.id, 41)).toBe(true);
    expect([
      (await rowOf(target.session)).cycleMessageId,
      (await rowOf(target.session)).cycleMessageFrom,
    ]).toEqual([41, 1]);
    // once settled, the trade's own claim returns the message its open block went in
    await settleOpen(trade);
    expect((await claim(target.session, 1))?.cycleMessage).toEqual({ messageId: 41, from: 1 });
  });

  it('N35 lists the open trade until its block is claimed, then not until it settles', async () => {
    const target = await seedSession();
    expect(await pendingOf(target.session)).toBeUndefined();
    const trade = await opened(target);
    expect(await pendingOf(target.session)).toMatchObject({
      notifiedTrades: 0,
      settled: 0,
      openIntentId: trade.intent.id,
      openNoticeIntentId: null,
    });
    await openClaim(target.session, trade.intent.id, 0);
    expect(await pendingOf(target.session)).toBeUndefined();
    await settleOpen(trade);
    expect(await pendingOf(target.session)).toMatchObject({
      settled: 1,
      openIntentId: null,
      openNoticeIntentId: trade.intent.id,
    });
  });

  it("N32 an H1 session's open trade is not listed (#670)", async () => {
    const built = buildH1SessionSettings({
      assetId: 101,
      trades: 10,
      stake: { baseStake: decimalStringSchema.parse('1'), stakeScale: 0 },
      maxLossMultiplier: 10,
    });
    if (!built.success) throw new Error('fixture settings do not parse');
    const target = await seedSession(built.data);
    await opened(target);
    expect(await pendingOf(target.session)).toBeUndefined();
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
    expect((await claim(target.session, 1))?.trades.at(-1)).toMatchObject({
      openPrice: 7,
      result: 'lost',
    });
    expect(await finalClaim(target.session)).toBe(true);
    expect(await pendingOf(target.session)).toBeUndefined();
  });
});

describe('the two marks (#537)', () => {
  it("N6' closeSummary sets both marks in one statement; without it only the final mark", async () => {
    const closed = await seedSession();
    await rejected(closed);
    await stop(closed.session, TradingSessionStopReason.UserStopped);
    expect(await finalClaim(closed.session, true)).toBe(true);
    const both = await rowOf(closed.session);
    expect(both.finalNoticeSentAt).toBeInstanceOf(Date);
    // one statement: one now()
    expect(both.summarySentAt).toEqual(both.finalNoticeSentAt);

    const open = await seedSession();
    await settled(open, '4.6');
    await stop(open.session);
    await claim(open.session, 0);
    expect(await finalClaim(open.session)).toBe(true);
    const first = await rowOf(open.session);
    expect(first.finalNoticeSentAt).toBeInstanceOf(Date);
    expect(first.summarySentAt).toBeNull();
  });

  it("N6' a refused final claim closes no summary either", async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    expect(await finalClaim(target.session, true)).toBe(false);
    expect((await rowOf(target.session)).summarySentAt).toBeNull();
  });
});

describe('the fallback summary (#537)', () => {
  const GRACE_MS = 1_800_000;
  const listed = async (session: { id: string }, graceMs = GRACE_MS) =>
    (await listSummaryFallback(tmp.db, { limit: 10_000, graceMs })).find(
      (row) => row.sessionId === session.id,
    );
  const setRow = (session: { id: string }, values: PgUpdateSetSource<typeof tradingSessions>) =>
    tmp.db.update(tradingSessions).set(values).where(eq(tradingSessions.id, session.id));
  // a finished session with one settled trade and its notices closed
  async function closedWithTrade(
    reason: TradingSessionStopReason = TradingSessionStopReason.Completed,
  ) {
    const target = await seedSession();
    await settled(target, '4.6');
    await stop(target.session, reason);
    await claim(target.session, 0);
    expect(await finalClaim(target.session)).toBe(true);
    return target;
  }
  const markAgo = (session: { id: string }, minutes: number) =>
    setRow(session, { finalNoticeSentAt: sql`now() - make_interval(mins => ${minutes})` });

  it('N20 without a status message at once; with one only past the grace', async () => {
    const untracked = await closedWithTrade();
    expect(await listed(untracked.session)).toEqual({
      sessionId: untracked.session.id,
      telegramUserId: BigInt(untracked.seed.telegramUserId),
      telegramBlocked: false,
    });

    const tracked = await closedWithTrade();
    await setRow(tracked.session, { statusMessageId: 77 });
    expect(await listed(tracked.session)).toBeUndefined();
    await markAgo(tracked.session, 29);
    expect(await listed(tracked.session)).toBeUndefined();
    await markAgo(tracked.session, 31);
    expect(await listed(tracked.session)).toBeDefined();
  });

  it('N20 lists only claimable rows: the no-signal stop without trades too, not a closed step, not open notices, not another stop without trades', async () => {
    const noSignal = await seedSession();
    await stop(noSignal.session, TradingSessionStopReason.NoSignalTimeout);
    expect(await listed(noSignal.session)).toBeUndefined();
    await finalClaim(noSignal.session);
    expect(await listed(noSignal.session)).toBeDefined();

    const empty = await seedSession();
    await rejected(empty);
    await stop(empty.session, TradingSessionStopReason.UserStopped);
    await finalClaim(empty.session);
    expect(await listed(empty.session)).toBeUndefined();

    const claimed = await closedWithTrade();
    await setRow(claimed.session, { summarySentAt: sql`now()` });
    expect(await listed(claimed.session)).toBeUndefined();
  });

  it('N20 lists the oldest mark first and stops at its limit', async () => {
    const older = await closedWithTrade();
    const newer = await closedWithTrade();
    await markAgo(newer.session, 1);
    await markAgo(older.session, 2);
    const all = await listSummaryFallback(tmp.db, { limit: 10_000, graceMs: GRACE_MS });
    const ids = all.map((row) => row.sessionId);
    expect(ids.indexOf(older.session.id)).toBeLessThan(ids.indexOf(newer.session.id));
    expect(await listSummaryFallback(tmp.db, { limit: 2, graceMs: GRACE_MS })).toEqual(
      all.slice(0, 2),
    );
  });

  it('N20 flags a user who blocked the bot', async () => {
    const target = await closedWithTrade();
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, target.seed.userId));
    expect((await listed(target.session))?.telegramBlocked).toBe(true);
  });

  it('N21 claims once and returns its mark; a row not claimable is undefined', async () => {
    const target = await closedWithTrade();
    const won = await claimSummaryFallback(tmp.db, { sessionId: target.session.id });
    const [mark] = await tmp.db
      .select({ text: sql<string>`${tradingSessions.summarySentAt}::text` })
      .from(tradingSessions)
      .where(eq(tradingSessions.id, target.session.id));
    expect(won?.claimedAt).toBe(mark?.text);
    expect(await claimSummaryFallback(tmp.db, { sessionId: target.session.id })).toBeUndefined();

    const running = await seedSession();
    expect(await claimSummaryFallback(tmp.db, { sessionId: running.session.id })).toBeUndefined();
    expect((await rowOf(running.session)).summarySentAt).toBeNull();
  });

  it('N22 a release takes back only its own mark', async () => {
    const target = await closedWithTrade();
    const won = (await claimSummaryFallback(tmp.db, { sessionId: target.session.id }))!;
    expect(
      await releaseSummaryFallback(tmp.db, {
        sessionId: target.session.id,
        claimedAt: won.claimedAt,
      }),
    ).toBe(true);
    expect((await rowOf(target.session)).summarySentAt).toBeNull();
    // the bot claimed after the release: its mark is not this claim's
    await setRow(target.session, { summarySentAt: sql`now()` });
    expect(
      await releaseSummaryFallback(tmp.db, {
        sessionId: target.session.id,
        claimedAt: won.claimedAt,
      }),
    ).toBe(false);
    expect((await rowOf(target.session)).summarySentAt).toBeInstanceOf(Date);
  });

  it('N22 the release key holds the mark to the microsecond', async () => {
    const target = await closedWithTrade();
    const won = (await claimSummaryFallback(tmp.db, { sessionId: target.session.id }))!;
    // the same millisecond, another microsecond: a Date would not tell them apart
    await setRow(target.session, {
      summarySentAt: sql`${won.claimedAt}::timestamptz + interval '1 microsecond'`,
    });
    expect(
      await releaseSummaryFallback(tmp.db, {
        sessionId: target.session.id,
        claimedAt: won.claimedAt,
      }),
    ).toBe(false);
  });

  it('N23 two claims at once: exactly one wins', async () => {
    const target = await closedWithTrade();
    const results = await Promise.all([
      claimSummaryFallback(tmp.db, { sessionId: target.session.id }),
      claimSummaryFallback(tmp.db, { sessionId: target.session.id }),
    ]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
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
      stopReason: TradingSessionStopReason.UserStopped,
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

describe('the waiting message (#536)', () => {
  const waitingClaim = (session: { id: string }) =>
    claimSessionWaiting(tmp.db, { sessionId: session.id });
  const waitingRecord = (session: { id: string }, slot: number, messageId: number) =>
    recordSessionWaitingMessage(tmp.db, { sessionId: session.id, slot, messageId });
  const waitingClear = (session: { id: string }, messageId: number) =>
    clearSessionWaitingMessage(tmp.db, { sessionId: session.id, messageId });
  const statusMessage = (session: { id: string }, messageId: number) =>
    tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: messageId })
      .where(eq(tradingSessions.id, session.id));
  // the session's first trade, claimed and sent in a new cycle message
  async function cycleMessage(
    target: Awaited<ReturnType<typeof seedSession>>,
    claimed: number,
    messageId: number,
  ) {
    await settled(target, '-5');
    await claim(target.session, claimed);
    await recordSessionCycleMessage(tmp.db, {
      sessionId: target.session.id,
      cursor: claimed + 1,
      messageId,
      from: claimed,
    });
  }
  const waitingOf = async (session: { id: string }) => {
    const row = await rowOf(session);
    return [row.waitingMessageId, row.waitingAfterMessage];
  };

  it('N13 claims a slot once, only on an active session under its status or a claimed trade', async () => {
    const target = await seedSession();
    // no message of the session yet: the waiting message would stand above it
    expect(await waitingClaim(target.session)).toBeUndefined();
    await statusMessage(target.session, 7);
    expect(await waitingClaim(target.session)).toEqual({ slot: 7 });
    expect(await waitingClaim(target.session)).toBeUndefined();
    expect(await waitingOf(target.session)).toEqual([null, 7]);
    // a new cycle message leaves the slot behind
    await cycleMessage(target, 0, 41);
    expect(await waitingClaim(target.session)).toEqual({ slot: 41 });
    expect(await waitingClaim(target.session)).toBeUndefined();

    // a live waiting message on an earlier slot holds the claim until it is cleared
    await waitingRecord(target.session, 41, 50);
    await cycleMessage(target, 1, 42);
    expect(await waitingClaim(target.session)).toBeUndefined();
    await waitingClear(target.session, 50);
    expect(await waitingClaim(target.session)).toEqual({ slot: 42 });

    const cycleOnly = await seedSession();
    await cycleMessage(cycleOnly, 0, 41);
    expect(await waitingClaim(cycleOnly.session)).toEqual({ slot: 41 });

    // a claimed trade whose message was not recorded: its message went after the session's
    const claimedOnly = await seedSession();
    await settled(claimedOnly, '-5');
    expect(await waitingClaim(claimedOnly.session)).toBeUndefined();
    await claim(claimedOnly.session, 0);
    expect(await waitingClaim(claimedOnly.session)).toEqual({ slot: 0 });

    const stopped = await seedSession();
    await statusMessage(stopped.session, 7);
    await stop(stopped.session, TradingSessionStopReason.UserStopped);
    expect(await waitingClaim(stopped.session)).toBeUndefined();
  });

  it('N13 two claims of the same slot at once: exactly one wins', async () => {
    const target = await seedSession();
    await statusMessage(target.session, 7);
    const results = await Promise.all([waitingClaim(target.session), waitingClaim(target.session)]);
    expect(results.filter((result) => result !== undefined)).toEqual([{ slot: 7 }]);
  });

  it('N14 the id is recorded only on its own claimed slot without an id, on an active session', async () => {
    const target = await seedSession();
    await statusMessage(target.session, 7);
    // nothing claimed
    expect(await waitingRecord(target.session, 7, 50)).toBe(false);
    await waitingClaim(target.session);
    expect(await waitingRecord(target.session, 41, 50)).toBe(false);
    expect(await waitingRecord(target.session, 7, 50)).toBe(true);
    expect(await waitingRecord(target.session, 7, 51)).toBe(false);
    expect(await waitingOf(target.session)).toEqual([50, 7]);

    const stopped = await seedSession();
    await statusMessage(stopped.session, 7);
    await waitingClaim(stopped.session);
    await stop(stopped.session, TradingSessionStopReason.UserStopped);
    expect(await waitingRecord(stopped.session, 7, 50)).toBe(false);
    expect(await waitingOf(stopped.session)).toEqual([null, 7]);
  });

  it('N15 a release frees the claimed slot only while no id was recorded', async () => {
    const target = await seedSession();
    await statusMessage(target.session, 7);
    await waitingClaim(target.session);
    expect(await releaseSessionWaiting(tmp.db, { sessionId: target.session.id, slot: 41 })).toBe(
      false,
    );
    expect(await releaseSessionWaiting(tmp.db, { sessionId: target.session.id, slot: 7 })).toBe(
      true,
    );
    expect(await waitingOf(target.session)).toEqual([null, null]);
    expect(await waitingClaim(target.session)).toEqual({ slot: 7 });
    await waitingRecord(target.session, 7, 50);
    expect(await releaseSessionWaiting(tmp.db, { sessionId: target.session.id, slot: 7 })).toBe(
      false,
    );
    expect(await waitingOf(target.session)).toEqual([50, 7]);
  });

  it('N16 a clear drops only its own id and frees the slot', async () => {
    const target = await seedSession();
    await statusMessage(target.session, 7);
    await waitingClaim(target.session);
    await waitingRecord(target.session, 7, 50);
    expect(await waitingClear(target.session, 51)).toBe(false);
    expect(await waitingOf(target.session)).toEqual([50, 7]);
    expect(await waitingClear(target.session, 50)).toBe(true);
    expect(await waitingOf(target.session)).toEqual([null, null]);
    // an active session is due again on the same cycle message
    expect(await waitingClaim(target.session)).toEqual({ slot: 7 });
  });

  it('N21 the re-read returns the live id and status; NULL after a clear or a hand-over at a stop (#587 round 1)', async () => {
    const reread = (session: { id: string }) =>
      readSessionWaitingMessage(tmp.db, { sessionId: session.id });
    const cleared = await seedSession();
    await statusMessage(cleared.session, 7);
    await waitingClaim(cleared.session);
    await waitingRecord(cleared.session, 7, 50);
    expect(await reread(cleared.session)).toEqual({
      waitingMessageId: 50,
      status: TradingSessionStatus.Active,
    });
    await waitingClear(cleared.session, 50);
    expect(await reread(cleared.session)).toEqual({
      waitingMessageId: null,
      status: TradingSessionStatus.Active,
    });
    const handedOver = await seedSession();
    await statusMessage(handedOver.session, 7);
    await waitingClaim(handedOver.session);
    await waitingRecord(handedOver.session, 7, 50);
    await stopTradingSession(tmp.db, {
      id: handedOver.session.id,
      reason: TradingSessionStopReason.UserStopped,
      waitingMessageId: 50,
    });
    expect(await reread(handedOver.session)).toEqual({
      waitingMessageId: null,
      status: TradingSessionStatus.Stopped,
    });
    expect(await reread({ id: '00000000-0000-4000-8000-000000000000' })).toBeUndefined();
  });

  it('N17 the summary is refused while a waiting message is live, granted once it is cleared', async () => {
    const target = await seedSession();
    await statusMessage(target.session, 7);
    await waitingClaim(target.session);
    await waitingRecord(target.session, 7, 50);
    await stop(target.session, TradingSessionStopReason.UserStopped);
    expect(await finalClaim(target.session)).toBe(false);
    await waitingClear(target.session, 50);
    expect(await finalClaim(target.session)).toBe(true);
    // no claim after the summary
    expect(await waitingClaim(target.session)).toBeUndefined();
  });

  it('N18 lists a session with a waiting message due or stale, never one of a blocked user', async () => {
    const due = await seedSession();
    await statusMessage(due.session, 7);
    const live = await seedSession();
    await statusMessage(live.session, 7);
    await waitingClaim(live.session);
    await waitingRecord(live.session, 7, 50);
    const stopped = await seedSession();
    await statusMessage(stopped.session, 7);
    await waitingClaim(stopped.session);
    await waitingRecord(stopped.session, 7, 50);
    await rejected(stopped);
    await stop(stopped.session, TradingSessionStopReason.UserStopped);
    const blocked = await seedSession();
    await statusMessage(blocked.session, 7);
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, blocked.seed.userId));

    expect(await pendingOf(due.session)).toMatchObject({
      status: 'active',
      waitingMessageId: null,
      waitingDue: true,
      waitingStale: false,
      finished: false,
    });
    expect(await pendingOf(live.session)).toBeUndefined();
    expect(await pendingOf(stopped.session)).toMatchObject({
      status: 'stopped',
      waitingMessageId: 50,
      waitingDue: false,
      waitingStale: true,
    });
    expect(await pendingOf(blocked.session)).toBeUndefined();

    // a new cycle message makes the live one stale
    await cycleMessage(live, 0, 41);
    expect(await pendingOf(live.session)).toMatchObject({
      waitingMessageId: 50,
      waitingDue: false,
      waitingStale: true,
    });
    await waitingClear(live.session, 50);
    expect(await pendingOf(live.session)).toMatchObject({
      waitingMessageId: null,
      waitingDue: true,
      waitingStale: false,
    });
  });

  it('N20 a status message recorded after the cycle message (a relaunch) moves the slot (#587)', async () => {
    const target = await seedSession();
    await statusMessage(target.session, 7);
    await cycleMessage(target, 0, 41);
    expect(await waitingClaim(target.session)).toEqual({ slot: 41 });
    await waitingRecord(target.session, 41, 50);
    expect(await pendingOf(target.session)).toBeUndefined();
    await statusMessage(target.session, 60);
    expect(await pendingOf(target.session)).toMatchObject({
      waitingMessageId: 50,
      waitingDue: false,
      waitingStale: true,
    });
    await waitingClear(target.session, 50);
    expect(await waitingClaim(target.session)).toEqual({ slot: 60 });
  });

  it("N18' a blocked user's active session keeps its waiting message unlisted on a left-behind slot; a stopped one is stale (#587)", async () => {
    const block = (target: Awaited<ReturnType<typeof seedSession>>) =>
      tmp.db
        .update(users)
        .set({ telegramBlockedAt: sql`now()` })
        .where(eq(users.id, target.seed.userId));
    const active = await seedSession();
    await statusMessage(active.session, 7);
    await waitingClaim(active.session);
    await waitingRecord(active.session, 7, 50);
    await block(active);
    await cycleMessage(active, 0, 41);
    // its trade claimed: nothing else would list it
    expect(await pendingOf(active.session)).toBeUndefined();
    expect(await waitingOf(active.session)).toEqual([50, 7]);
    const stopped = await seedSession();
    await statusMessage(stopped.session, 7);
    await waitingClaim(stopped.session);
    await waitingRecord(stopped.session, 7, 50);
    await block(stopped);
    await stop(stopped.session, TradingSessionStopReason.UserStopped);
    expect(await pendingOf(stopped.session)).toMatchObject({
      waitingMessageId: 50,
      waitingStale: true,
    });
  });

  // No backfill (owner 2026-10-17): the DDL leaves both columns NULL on every session at the
  // deploy, so a running one with its status or a claimed trade is due at the backend's start
  it("N19 the deploy's state: a running session with an anchor is due, a stopped one is not", async () => {
    const recorded = await seedSession();
    await statusMessage(recorded.session, 7);
    await cycleMessage(recorded, 0, 41);
    const claimedOnly = await seedSession();
    await settled(claimedOnly, '-5');
    await claim(claimedOnly.session, 0);
    const bare = await seedSession();
    const ended = await seedSession();
    await statusMessage(ended.session, 7);
    await cycleMessage(ended, 0, 41);
    await stop(ended.session, TradingSessionStopReason.UserStopped);
    for (const target of [recorded, claimedOnly, bare, ended]) {
      expect(await waitingOf(target.session)).toEqual([null, null]);
    }

    expect(await pendingOf(recorded.session)).toMatchObject({ waitingDue: true });
    expect(await pendingOf(claimedOnly.session)).toMatchObject({ waitingDue: true });
    expect(await pendingOf(bare.session)).toBeUndefined();
    // listed for its summary, if at all, never for a waiting message
    expect((await pendingOf(ended.session))?.waitingDue ?? false).toBe(false);
    expect(await waitingClaim(recorded.session)).toEqual({ slot: 41 });
    expect(await waitingClaim(claimedOnly.session)).toEqual({ slot: 0 });
    expect(await waitingClaim(ended.session)).toBeUndefined();
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
    // stopped before the deploy with a trade still on manual review (#534 m5)
    const review = await seedSession();
    await settled(review, '4.6');
    const onReviewIntent = await onReview(review);
    await stop(review.session, TradingSessionStopReason.ManualReview);
    const ids = [running.session.id, ended.session.id, review.session.id];
    // the waiting slot claimed on the session's latest message: only the trade notices under test
    await tmp.db
      .update(tradingSessions)
      .set({ notifiedTrades: 0, finalNoticeSentAt: null, waitingAfterMessage: 0 })
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
    expect(await rowOf(review.session)).toMatchObject({
      notifiedTrades: 1,
      finalNoticeSentAt: expect.any(Date),
    });

    // settled by an operator after the deploy: the mark keeps the session out of the list and
    // refuses the trade's claim, so neither its message nor a summary goes out
    await tmp.db.transaction((tx) =>
      settleIntent(tx, {
        id: onReviewIntent.id,
        from: TradeIntentStatus.ManualReview,
        trade: closedTradeFor(openTradeFor(onReviewIntent, { openPrice: 7 }), {
          profit: '-5' as DecimalString,
          closePrice: 6,
        }),
      }),
    );
    expect(await pendingOf(review.session)).toBeUndefined();
    expect(await claim(review.session, 1)).toBeUndefined();
  });
});
