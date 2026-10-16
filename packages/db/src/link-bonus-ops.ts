import { LinkBonusSkipReason, type LinkBonusGrantView } from '@binarius/shared';
import { applyBonus } from './bonus-rule-ops';
import type { Tx } from './trade-intent-ops';

// The starter pack's rule code (#13): the amount is the active link_bonus version's (100 in v1,
// seeded by 0059), the bot prints whatever the backend sends.
export const LINK_BONUS_RULE_CODE = 'link_bonus';

export type LinkBonusGrant =
  { granted: true; tokens: bigint } | { granted: false; reason: LinkBonusSkipReason };

// The only caller of applyBonus for the starter pack. Preconditions, which the caller's
// transaction owns: the users row is held FOR NO KEY UPDATE, and the account row was just made
// active by this transaction. One pack per user is token_ledger_link_bonus_user_idx's, not a read
// here, so calling this on every activation is safe. A non-partner account spends no slot: the
// same user confirming a partner account later still gets the pack. With no active link_bonus
// version the account is activated without a pack (no_active_rule); an active version whose
// params do not parse throws InvalidBonusRule and the activation rolls back.
export async function grantLinkBonus(
  tx: Tx,
  { userId, account }: { userId: string; account: { id: string; isPartnerClient: boolean } },
): Promise<LinkBonusGrant> {
  if (!account.isPartnerClient) {
    return { granted: false, reason: LinkBonusSkipReason.NotPartnerClient };
  }
  const grant = await applyBonus(tx, {
    code: LINK_BONUS_RULE_CODE,
    userId,
    reference: { brokerAccountId: account.id },
  });
  return grant.granted ? { granted: true, tokens: grant.tokens } : grant;
}

// bigint → decimal string, the only form the amount travels in
export function toLinkBonusGrantView(grant: LinkBonusGrant): LinkBonusGrantView {
  return grant.granted
    ? { granted: true, tokens: grant.tokens.toString() }
    : { granted: false, reason: grant.reason };
}
