import { eq } from 'drizzle-orm';
import type { TradeMode, TradingAccessResponse, UserStatus } from '@binarius/shared';
import { users } from './schema/users';
import type { DbExecutor } from './trade-intent-ops';

// The token side of POST /trading/access (#136).
//
// users.token_balance / token_reserved are the cache of token_ledger's sums, and every ledger
// writer moves the cache in the same transaction as its row: createInTransaction (reserve),
// releaseTokens (release), grantLinkBonus (starter pack), consumeTokens (settle, #17),
// adjustTokens (the admin's manual adjustment, #246). A new writer — purchases (#117) — must keep
// that rule, or this read lies by the missing delta (token-balance-ops.db.test.ts and
// token-adjustment-ops.db.test.ts prove the equality for the writers above).
//
// One statement, no lock clause: PostgreSQL evaluates it against one snapshot, so balance and
// reserved come from the same committed version of the row, and a reserve in flight is neither
// seen half-done nor waited for (its FOR NO KEY UPDATE does not block a plain SELECT). Reading
// the row and then summing the ledger would be two snapshots that a commit can fall between.

export interface TokenBalanceSnapshot {
  status: UserStatus;
  balance: bigint;
  reserved: bigint;
  tradingMode: TradeMode;
}

export async function readTokenBalance(
  exec: DbExecutor,
  telegramUserId: bigint,
): Promise<TokenBalanceSnapshot | undefined> {
  const [row] = await exec
    .select({
      status: users.status,
      balance: users.tokenBalance,
      reserved: users.tokenReserved,
      tradingMode: users.tradingMode,
    })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  return row;
}

export function toTradingAccessView({
  status,
  balance,
  reserved,
  tradingMode,
}: TokenBalanceSnapshot): Pick<TradingAccessResponse, 'status' | 'tokens' | 'tradingMode'> {
  const available = balance - reserved;
  // unreachable under users_token_reserved_check; a signed count must not reach the wire
  if (available < 0n) throw new Error('token reserve exceeds balance');
  return {
    status,
    tokens: {
      balance: balance.toString(),
      reserved: reserved.toString(),
      available: available.toString(),
    },
    tradingMode,
  };
}
