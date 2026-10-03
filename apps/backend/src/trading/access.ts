import type { FastifyInstance } from 'fastify';
import { UserErrorCode, safeParseTradingAccessRequest } from '@binarius/shared';
import { readTokenBalance, toTradingAccessView, type Db } from '@binarius/db';

// Read-only: nothing here reserves or credits; the reservation itself is createTradeIntent's CAS.
// Registered inside tradingRoutes, after its bearer hook.
export function registerTradingAccess(app: FastifyInstance, { db }: { db: Db }): void {
  app.post('/trading/access', async (request, reply) => {
    const parsed = safeParseTradingAccessRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const snapshot = await readTokenBalance(db, BigInt(parsed.data.telegramUserId));
    if (snapshot === undefined) {
      return reply.code(404).send({ error: UserErrorCode.UserNotFound });
    }
    return reply.send(toTradingAccessView(snapshot));
  });
}
