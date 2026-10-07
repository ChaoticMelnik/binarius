import type { FastifyInstance } from 'fastify';
import {
  checkDemoStake,
  DEMO_STAKE_PATH,
  DemoStakeErrorCode,
  demoStakeScale,
  normalizeDecimal,
  safeParseSetDemoStakeRequest,
  type DecimalString,
} from '@binarius/shared';
import { readBalanceSnapshot, resolveBalanceAccount, setDemoStake, type Db } from '@binarius/db';

const canonical = (value: DecimalString) => normalizeDecimal(value);

// POST /trading/demo-stake (#297, docs/bot-demo-trade.md -> The stake): the bounds are checked
// against the stored snapshot of any age, with no broker call. Read, then write, not atomic by
// choice: the bounds are checked again at every trade (createTradeIntent's checkDemoStake option)
// and every session start, so a save that a moving snapshot made stale costs one refusal at
// press time. Registered inside tradingRoutes, whose bearer hook covers it.
export function registerDemoStake(app: FastifyInstance, { db }: { db: Db }): void {
  app.post(DEMO_STAKE_PATH, async (request, reply) => {
    const parsed = safeParseSetDemoStakeRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const telegramUserId = BigInt(parsed.data.telegramUserId);
    const { amount } = parsed.data;
    const userNotFound = () => reply.code(404).send({ error: DemoStakeErrorCode.UserNotFound });
    const balanceUnavailable = () =>
      reply.code(409).send({ error: DemoStakeErrorCode.BalanceUnavailable });

    if (amount !== null) {
      const resolved = await resolveBalanceAccount(db, { telegramUserId });
      if (resolved.kind === 'no_user') return userNotFound();
      if (resolved.kind !== 'account') return balanceUnavailable();
      const snapshot = await readBalanceSnapshot(db, resolved.account.id);
      if (snapshot === undefined) return balanceUnavailable();
      const limits = {
        minTradeAmount: snapshot.minTradeAmount,
        demoAvailable: snapshot.demo.available,
      };
      const refusal = checkDemoStake(amount, limits);
      if (refusal !== null) {
        return reply.code(409).send({
          error: refusal,
          limits: {
            minTradeAmount: canonical(limits.minTradeAmount),
            demoAvailable: canonical(limits.demoAvailable),
            scale: demoStakeScale(limits.minTradeAmount),
          },
        });
      }
    }

    const saved = await setDemoStake(db, telegramUserId, amount);
    if (saved === undefined) return userNotFound();
    return reply.send(saved);
  });
}
