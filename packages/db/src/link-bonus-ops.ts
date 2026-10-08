import { eq, sql } from 'drizzle-orm';
import { LinkBonusSkipReason, TokenLedgerKind, type LinkBonusGrantView } from '@binarius/shared';
import { literal } from './schema/columns';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// The starter pack a confirmed link earns. The one place the number lives: the bot prints
// whatever the backend sends.
export const LINK_BONUS_TOKENS = 100n;
// Written to the ledger row's `note`, so #13's rule engine can attribute these rows later.
export const LINK_BONUS_RULE_CODE = 'link_bonus';

export type LinkBonusGrant =
  { granted: true; tokens: bigint } | { granted: false; reason: LinkBonusSkipReason };

// The only writer of the starter pack. Preconditions, which the caller's transaction owns: the
// users row is held FOR NO KEY UPDATE, and the account row was just made active by this
// transaction. One pack per user is token_ledger_link_bonus_user_idx's, not a read here, so
// calling this on every activation is safe. A non-partner account spends no slot: the same
// user confirming a partner account later still gets the pack.
export async function grantLinkBonus(
  tx: Tx,
  { userId, account }: { userId: string; account: { id: string; isPartnerClient: boolean } },
): Promise<LinkBonusGrant> {
  if (!account.isPartnerClient) {
    return { granted: false, reason: LinkBonusSkipReason.NotPartnerClient };
  }
  const tokens = LINK_BONUS_TOKENS;
  const [row] = await tx
    .insert(tokenLedger)
    .values({
      userId,
      kind: TokenLedgerKind.Bonus,
      balanceDelta: tokens,
      brokerAccountId: account.id,
      note: LINK_BONUS_RULE_CODE,
    })
    // the predicate repeats token_ledger_link_bonus_user_idx's: a partial unique index is an
    // arbiter only when the conflict clause implies its predicate
    .onConflictDoNothing({
      target: tokenLedger.userId,
      where: sql`${tokenLedger.kind} = ${literal(TokenLedgerKind.Bonus)} and ${tokenLedger.brokerAccountId} is not null`,
    })
    .returning({ id: tokenLedger.id });
  if (row === undefined) return { granted: false, reason: LinkBonusSkipReason.AlreadyGranted };

  await tx
    .update(users)
    .set({ tokenBalance: sql`${users.tokenBalance} + ${tokens}` })
    .where(eq(users.id, userId));
  return { granted: true, tokens };
}

// bigint → decimal string, the only form the amount travels in
export function toLinkBonusGrantView(grant: LinkBonusGrant): LinkBonusGrantView {
  return grant.granted
    ? { granted: true, tokens: grant.tokens.toString() }
    : { granted: false, reason: grant.reason };
}
