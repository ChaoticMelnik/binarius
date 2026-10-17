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

export type ReferralInviter =
  | { referralId: null }
  | { referralId: string; paid: true }
  | { referralId: string; paid: false; inviterUserId: string; inviterBlocked: boolean };

// The first half of the inviter's reward (#116, docs/referrals.md → Locks), called right after the
// invitee's users row is locked FOR NO KEY UPDATE and before any other table: the inviter's users
// row is locked here, while the referral is unpaid. No cycle (Rule 5): (a) a reward writer takes
// every users lock before its first lock of another table, and no writer waits on a users row
// while holding a broker_accounts, deposit_events or token_ledger lock - the inviter's own login
// with the invitee's broker account waits on that account holding only its users row; (b) the
// second users row is the inviter's, always older (a referral is recorded only by the /start that
// created the invitee's row, Rule 34), and only reward writers hold two.
//
// The paid read is race-free: every writer of this referral's reward is an activation of the same
// invitee, serialized by its users row; token_ledger_referral_idx stays the arbiter.
export async function lockReferralInviter(tx: Tx, inviteeUserId: string): Promise<ReferralInviter> {
  // no lock: a referral row is never updated, and the ledger FK takes KEY SHARE on it
  const [referral] = await tx
    .select({ id: referrals.id, inviterUserId: referrals.inviterUserId })
    .from(referrals)
    .where(eq(referrals.inviteeUserId, inviteeUserId));
  if (referral === undefined) return { referralId: null };

  const [paid] = await tx
    .select({ id: tokenLedger.id })
    .from(tokenLedger)
    .where(eq(tokenLedger.referralId, referral.id));
  if (paid !== undefined) return { referralId: referral.id, paid: true };

  const [inviter] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, referral.inviterUserId))
    .for('no key update');
  if (inviter === undefined) throw new Error('referral inviter vanished');
  return {
    referralId: referral.id,
    paid: false,
    inviterUserId: referral.inviterUserId,
    inviterBlocked: inviter.status === UserStatus.Blocked,
  };
}

// The second half, after the account was made active by this transaction; it takes no lock of
// its own. already_rewarded is answered before the rule is read, so a deactivated or broken rule
// neither changes the answer for a paid reward nor rolls a re-login back.
export async function grantReferralReward(
  tx: Tx,
  { referral, account }: { referral: ReferralInviter; account: { isPartnerClient: boolean } },
): Promise<ReferralRewardResult> {
  if (!account.isPartnerClient) {
    return { rewarded: false, reason: ReferralRewardSkipReason.NotPartnerClient, referralId: null };
  }
  if (referral.referralId === null) {
    return { rewarded: false, reason: ReferralRewardSkipReason.NoReferral, referralId: null };
  }
  const skip = (reason: ReferralRewardSkipReason): ReferralRewardResult => ({
    rewarded: false,
    reason,
    referralId: referral.referralId,
  });
  if (referral.paid) return skip(ReferralRewardSkipReason.AlreadyRewarded);
  if (referral.inviterBlocked) return skip(ReferralRewardSkipReason.InviterBlocked);

  const grant = await applyBonus(tx, {
    code: REFERRAL_REWARD_RULE_CODE,
    userId: referral.inviterUserId,
    reference: { referralId: referral.referralId },
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
    referralId: referral.referralId,
    inviterUserId: referral.inviterUserId,
    tokens: grant.tokens,
    ruleId: grant.ruleId,
    version: grant.version,
  };
}
