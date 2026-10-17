import type { FastifyInstance } from 'fastify';
import {
  checkStake,
  normalizeDecimal,
  safeParseSetStakeRequest,
  STAKE_PATH,
  StakeErrorCode,
  stakeScale,
  TradeMode,
} from '@binarius/shared';
import { readBalanceSnapshot, resolveBalanceAccount, setStake, type Db } from '@binarius/db';

// POST /trading/stake (#297 demo, #326 real; docs/bot-demo-trade.md -> The stake): the bounds are
// checked against the request mode's balance in the stored snapshot of any age, with no broker
// call. Read, then write, not atomic by choice: the bounds are checked again at every trade
// (createTradeIntent's checkStake option) and every session start, so a save that a moving
// snapshot made stale costs one refusal at press time. DEMO_ONLY is not read (#326): a real stake
// is a preference that moves no money, and the real trade and the real session refuse demo_only
// at creation. Registered inside tradingRoutes, whose bearer hook covers it.
export function registerStake(app: FastifyInstance, { db }: { db: Db }): void {
  app.post(STAKE_PATH, async (request, reply) => {
    const parsed = safeParseSetStakeRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const telegramUserId = BigInt(parsed.data.telegramUserId);
    const { mode, amount } = parsed.data;
    const userNotFound = () => reply.code(404).send({ error: StakeErrorCode.UserNotFound });
    const balanceUnavailable = () =>
      reply.code(409).send({ error: StakeErrorCode.BalanceUnavailable });

    if (amount !== null) {
      const resolved = await resolveBalanceAccount(db, { telegramUserId });
      if (resolved.kind === 'no_user') return userNotFound();
      if (resolved.kind !== 'account') return balanceUnavailable();
      const snapshot = await readBalanceSnapshot(db, resolved.account.id);
      if (snapshot === undefined) return balanceUnavailable();
      const limits = {
        minTradeAmount: snapshot.minTradeAmount,
        available: mode === TradeMode.Real ? snapshot.real.available : snapshot.demo.available,
      };
      const refusal = checkStake(amount, limits);
      if (refusal !== null) {
        return reply.code(409).send({
          error: refusal,
          limits: {
            minTradeAmount: normalizeDecimal(limits.minTradeAmount),
            available: normalizeDecimal(limits.available),
            scale: stakeScale(limits.minTradeAmount),
          },
        });
      }
    }

    const saved = await setStake(db, telegramUserId, mode, amount);
    if (saved === undefined) return userNotFound();
    return reply.send(saved);
  });
}
