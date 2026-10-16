import { eq } from 'drizzle-orm';
import { LinkBonusSkipReason, ReferralRewardSkipReason, UserStatus } from '@binarius/shared';
import { applyBonus } from './bonus-rule-ops';
import { referrals } from './schema/referrals';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// The inviter's reward's rule code (#13): the amount is the active referral_reward version's (50
// in v1, seeded by 0059).
export const REFERRAL_REWARD_RULE_CODE = 'referral_reward';

export type ReferralRewardResult =
  | {
      rewarded: true;
      referralId: string;
      inviterUserId: string;
      tokens: bigint;
      ruleId: string;
      version: number;
    }
  | { rewarded: false; reason: ReferralRewardSkipReason; referralId: string | null };

// The inviter's reward (#116, docs/referrals.md → The reward), in the invitee's activation
// transaction, after grantLinkBonus. Preconditions the caller owns: the invitee's users row is
// held FOR NO KEY UPDATE and the account was just made active by this transaction.
//
// The inviter's users row is the second users row this transaction locks (Rule 5). No cycle:
// a referral is recorded only by the /start that created the invitee's row (Rule 34), so the
// inviter's row is always older, and every wait among these writers runs from a newer row to an
// older one.
//
// already_rewarded is answered before the rule is read, so a deactivated or broken rule neither
// changes the answer for a paid reward nor rolls a re-login back. That read is race-free: every
// writer of this referral's reward is an activation of the same invitee, serialized by its users
// row; token_ledger_referral_idx stays the arbiter.
export async function grantReferralReward(
  tx: Tx,
  { inviteeUserId, account }: { inviteeUserId: string; account: { isPartnerClient: boolean } },
): Promise<ReferralRewardResult> {
  if (!account.isPartnerClient) {
    return { rewarded: false, reason: ReferralRewardSkipReason.NotPartnerClient, referralId: null };
  }
  // no lock: a referral row is never updated, and the ledger FK takes KEY SHARE on it
  const [referral] = await tx
    .select({ id: referrals.id, inviterUserId: referrals.inviterUserId })
    .from(referrals)
    .where(eq(referrals.inviteeUserId, inviteeUserId));
  if (referral === undefined) {
    return { rewarded: false, reason: ReferralRewardSkipReason.NoReferral, referralId: null };
  }
  const skip = (reason: ReferralRewardSkipReason): ReferralRewardResult => ({
    rewarded: false,
    reason,
    referralId: referral.id,
  });

  const [paid] = await tx
    .select({ id: tokenLedger.id })
    .from(tokenLedger)
    .where(eq(tokenLedger.referralId, referral.id));
  if (paid !== undefined) return skip(ReferralRewardSkipReason.AlreadyRewarded);

  const [inviter] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, referral.inviterUserId))
    .for('no key update');
  if (inviter === undefined) throw new Error('referral inviter vanished');
  if (inviter.status === UserStatus.Blocked) return skip(ReferralRewardSkipReason.InviterBlocked);

  const grant = await applyBonus(tx, {
    code: REFERRAL_REWARD_RULE_CODE,
    userId: referral.inviterUserId,
    reference: { referralId: referral.id },
  });
  if (!grant.granted) {
    return skip(
      grant.reason === LinkBonusSkipReason.NoActiveRule
        ? ReferralRewardSkipReason.NoActiveRule
        : ReferralRewardSkipReason.AlreadyRewarded,
    );
  }
  return {
    rewarded: true,
    referralId: referral.id,
    inviterUserId: referral.inviterUserId,
    tokens: grant.tokens,
    ruleId: grant.ruleId,
    version: grant.version,
  };
}
