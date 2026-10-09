import { and, eq, sql } from 'drizzle-orm';
import { checkTokenAdjustment, TokenLedgerKind } from '@binarius/shared';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// The admin's manual token adjustment (#246, docs/admin-pages.md → Корректировка токенов).
//
// Composed into the caller's transaction (the route runs it inside runAsStaff, which records the
// audit row from what this returns). Lock order (Rule 5): the users row FOR NO KEY UPDATE is the
// only lock taken here and the first of the users → … chain; runAsStaff touched its own
// staff_sessions row before, and no writer takes users before a staff table, so there is no cycle.
// Nothing else is locked: intents' reserve is held by users_token_reserved_check and by the
// check below, which reads the reserve under the lock rather than from a snapshot before it.
//
// |delta| ≤ TOKEN_ADJUSTMENT_MAX_TOKENS is policy, not a CHECK: this writer and the request
// schema both apply checkTokenAdjustment, and only raw SQL bypasses it.

export interface AdjustTokensInput {
  userId: string;
  delta: bigint;
  note: string;
  // the balance the staff member saw; undefined skips the optimistic check (#246 В4)
  expectedBalance?: bigint;
}

export type AdjustTokensResult =
  | {
      outcome: 'adjusted';
      entry: typeof tokenLedger.$inferSelect & { telegramUserId: bigint };
      balanceBefore: bigint;
      balanceAfter: bigint;
      reserved: bigint;
    }
  | { outcome: 'not_found' }
  | { outcome: 'balance_changed' | 'insufficient_available'; balance: bigint; reserved: bigint };

// A caller that skipped the request schema; the route never reaches it. The name only (Rule 8).
export class InvalidTokenAdjustment extends Error {
  override readonly name = 'InvalidTokenAdjustment';
}

export async function adjustTokens(
  tx: Tx,
  { userId, delta, note, expectedBalance }: AdjustTokensInput,
): Promise<AdjustTokensResult> {
  if (checkTokenAdjustment(delta, note) !== null) throw new InvalidTokenAdjustment();

  const [user] = await tx
    .select({
      telegramUserId: users.telegramUserId,
      balance: users.tokenBalance,
      reserved: users.tokenReserved,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');
  if (user === undefined) return { outcome: 'not_found' };
  const { balance, reserved } = user;

  // the stale-balance refusal first: it shows the fresh numbers, and only a deliberate retry
  // meets the refusal by what is available
  if (expectedBalance !== undefined && balance !== expectedBalance) {
    return { outcome: 'balance_changed', balance, reserved };
  }
  // with reserved ≥ 0 this also covers balance + delta < 0; a credit is never refused here
  if (balance + delta < reserved) return { outcome: 'insufficient_available', balance, reserved };

  const [row] = await tx
    .insert(tokenLedger)
    .values({
      userId,
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: delta,
      reservedDelta: 0n,
      note,
    })
    .returning();
  if (row === undefined) throw new Error('token adjustment insert returned no row');
  // the predicate repeats the check above as an atomic backstop, in the style of releaseTokens
  const [after] = await tx
    .update(users)
    .set({ tokenBalance: sql`${users.tokenBalance} + ${delta}` })
    .where(
      and(eq(users.id, userId), sql`${users.tokenBalance} + ${delta} >= ${users.tokenReserved}`),
    )
    .returning({ balance: users.tokenBalance });
  // unreachable under the lock held above: the cache and the ledger diverged
  if (after === undefined) throw new Error(`token adjustment underflow for user ${userId}`);
  return {
    outcome: 'adjusted',
    entry: { ...row, telegramUserId: user.telegramUserId },
    balanceBefore: balance,
    balanceAfter: after.balance,
    reserved,
  };
}
