import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { SignalDecisionOutcome } from '@binarius/shared';
import {
  brokerAccounts,
  brokerTrades,
  depositEvents,
  postbackDeliveries,
  referralCodes,
  referrals,
  signalDecisions,
  tokenLedger,
  tradeIntents,
  tradingSessions,
  users,
  type Db,
} from '@binarius/db';

// The rows the run's oracles read; the harness writes none of them
export function e2eReads(db: Db) {
  return {
    async userRow(telegramUserId: bigint) {
      const [row] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId));
      return row;
    },
    async usersCount() {
      const [row] = await db.select({ n: count() }).from(users);
      return row?.n;
    },
    accountsOf: (userId: string) =>
      db.select().from(brokerAccounts).where(eq(brokerAccounts.userId, userId)),
    sessionsOf: (brokerAccountId: string) =>
      db
        .select()
        .from(tradingSessions)
        .where(eq(tradingSessions.brokerAccountId, brokerAccountId))
        .orderBy(asc(tradingSessions.createdAt)),
    referralsOf: (inviterUserId: string) =>
      db.select().from(referrals).where(eq(referrals.inviterUserId, inviterUserId)),
    async referralCodeOf(userId: string) {
      const [row] = await db
        .select({ code: referralCodes.code })
        .from(referralCodes)
        .where(eq(referralCodes.userId, userId));
      return row?.code;
    },
    depositsOf: (paymentId: string) =>
      db.select().from(depositEvents).where(eq(depositEvents.paymentId, paymentId)),
    deliveriesOf: (paymentId: string) =>
      db
        .select()
        .from(postbackDeliveries)
        .where(sql`${postbackDeliveries.payload} ->> 'payment_id' = ${paymentId}`)
        .orderBy(asc(postbackDeliveries.createdAt)),
    async accountOf(userId: string) {
      const [row] = await db.select().from(brokerAccounts).where(eq(brokerAccounts.userId, userId));
      return row;
    },
    async sessionOf(brokerAccountId: string) {
      const [row] = await db
        .select()
        .from(tradingSessions)
        .where(eq(tradingSessions.brokerAccountId, brokerAccountId));
      return row;
    },
    // the session's no_signal decisions (#722): the only rows a waiting message may follow
    async noSignalCountOf(sessionId: string) {
      const [row] = await db
        .select({ n: count() })
        .from(signalDecisions)
        .where(
          and(
            eq(signalDecisions.tradingSessionId, sessionId),
            eq(signalDecisions.outcome, SignalDecisionOutcome.NoSignal),
          ),
        );
      return row?.n ?? 0;
    },
    // the session's decision rows in the order they were written (#829)
    decisionsOf: (sessionId: string) =>
      db
        .select()
        .from(signalDecisions)
        .where(eq(signalDecisions.tradingSessionId, sessionId))
        .orderBy(asc(signalDecisions.recordedAt), asc(signalDecisions.id)),
    intentsOf: (sessionId: string) =>
      db
        .select()
        .from(tradeIntents)
        .where(eq(tradeIntents.tradingSessionId, sessionId))
        .orderBy(asc(tradeIntents.createdAt)),
    tradesOf: (intentIds: string[]) =>
      intentIds.length === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(brokerTrades)
            .where(inArray(brokerTrades.intentId, intentIds))
            .orderBy(asc(brokerTrades.openTimestampMs)),
    ledgerOf: (userId: string) =>
      db
        .select()
        .from(tokenLedger)
        .where(eq(tokenLedger.userId, userId))
        .orderBy(asc(tokenLedger.createdAt)),
  };
}
