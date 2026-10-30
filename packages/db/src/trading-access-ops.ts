import { eq, sql } from 'drizzle-orm';
import type { DecimalString } from '@binarius/shared';
import type { Db } from './client';
import {
  balanceAccountColumns,
  balanceAccountFilter,
  resolveAccountRows,
  type BalanceAccountResolution,
} from './balance-snapshot-ops';
import { brokerAccounts } from './schema/broker-accounts';
import { users } from './schema/users';
import { tokenBalanceColumns, type TokenBalanceSnapshot } from './token-balance-ops';
import { tradingOpenSql } from './trading-switch-ops';
import { canonicalStake } from './user-ops';

// Everything POST /trading/access reads before the broker step, in one statement (#874):
// readTokenBalance, readStakes, isTradingOpen(readTradingSwitch) and resolveBalanceAccount over
// the same users row. One snapshot, so the token facts keep readTokenBalance's guarantee
// (balance and reserved from one committed version of the row).

export interface TradingAccessState {
  tokens: TokenBalanceSnapshot;
  // canonical; null = the broker's minimum
  stakes: { demoStake: DecimalString | null; realStake: DecimalString | null };
  tradingOpen: boolean;
  // no_user is unreachable once the users row is read
  account: Exclude<BalanceAccountResolution, { kind: 'no_user' }>;
}

// undefined = no users row
export async function readTradingAccessState(
  db: Db,
  { telegramUserId, brokerAccountId }: { telegramUserId: bigint; brokerAccountId?: string },
): Promise<TradingAccessState | undefined> {
  const rows = await db
    .select({
      // nested: users.status and broker_accounts.status share the key `status`
      tokens: tokenBalanceColumns,
      demoStake: users.demoStake,
      realStake: users.realStake,
      tradingOpen: sql<boolean>`${tradingOpenSql}`,
      ...balanceAccountColumns,
    })
    .from(users)
    .leftJoin(brokerAccounts, balanceAccountFilter(brokerAccountId))
    .where(eq(users.telegramUserId, telegramUserId))
    .orderBy(brokerAccounts.id)
    .limit(2);
  const [first] = rows;
  if (first === undefined) return undefined;
  const account = resolveAccountRows(rows, brokerAccountId);
  // unreachable: rows is non-empty
  if (account.kind === 'no_user') throw new Error('users row read without a resolution');
  return {
    tokens: first.tokens,
    stakes: {
      demoStake: canonicalStake(first.demoStake),
      realStake: canonicalStake(first.realStake),
    },
    tradingOpen: first.tradingOpen,
    account,
  };
}
