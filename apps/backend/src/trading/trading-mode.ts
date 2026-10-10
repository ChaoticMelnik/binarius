import type { FastifyInstance } from 'fastify';
import {
  decimalLessThan,
  safeParseSetTradingModeRequest,
  TradeMode,
  TRADING_MODE_PATH,
  TradingModeErrorCode,
} from '@binarius/shared';
import { readBalanceSnapshot, resolveBalanceAccount, setTradingMode, type Db } from '@binarius/db';

// POST /trading/mode (#121, docs/trading-mode.md -> The route): the user's trading mode, both
// directions. Back to demo is never refused but for a missing user. Real is refused on a
// DEMO_ONLY process before any read, then needs the single active account's stored snapshot of
// any age (no broker call) with real.available at least the broker's minimum. Read, then write,
// not atomic by choice, as POST /trading/demo-stake: the bound is a UX gate, and the broker refuses
// a real order above the balance. users.status and the kill-switch are not read: a blocked user's
// trades and a closed switch are refused at creation. Registered inside tradingRoutes, whose
// bearer hook covers it.
export function registerTradingMode(
  app: FastifyInstance,
  { db, demoOnly }: { db: Db; demoOnly: boolean },
): void {
  app.post(TRADING_MODE_PATH, async (request, reply) => {
    const parsed = safeParseSetTradingModeRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const telegramUserId = BigInt(parsed.data.telegramUserId);
    const { mode } = parsed.data;
    const userNotFound = () => reply.code(404).send({ error: TradingModeErrorCode.UserNotFound });
    const refuse = (error: TradingModeErrorCode) => reply.code(409).send({ error });

    if (mode === TradeMode.Real) {
      if (demoOnly) return refuse(TradingModeErrorCode.DemoOnly);
      const resolved = await resolveBalanceAccount(db, { telegramUserId });
      if (resolved.kind === 'no_user') return userNotFound();
      if (resolved.kind !== 'account') return refuse(TradingModeErrorCode.BalanceUnavailable);
      const snapshot = await readBalanceSnapshot(db, resolved.account.id);
      if (snapshot === undefined) return refuse(TradingModeErrorCode.BalanceUnavailable);
      if (decimalLessThan(snapshot.real.available, snapshot.minTradeAmount)) {
        return refuse(TradingModeErrorCode.RealBalanceBelowMinimum);
      }
    }

    const result = await setTradingMode(db, telegramUserId, mode);
    if (result === undefined) return userNotFound();
    return reply.send({ tradingMode: result.tradingMode, changed: result.changed });
  });
}
