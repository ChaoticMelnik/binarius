import { asc, eq, inArray } from 'drizzle-orm';
import {
  brokerAccounts,
  brokerTrades,
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
