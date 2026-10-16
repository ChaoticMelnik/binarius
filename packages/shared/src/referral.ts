import * as z from 'zod';
import { telegramUserIdSchema, tokenCountSchema } from './trading';
import { UserStatus } from './users';

// Personal start links (#115, docs/referrals.md). The code is random, never derived from an id,
// so a link reveals nothing about its owner. `referral_codes_code_check` in packages/db is built
// from the same pattern.
export const REFERRAL_CODE_LENGTH = 8;
export const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9]{8}$/;
export const REFERRAL_PAYLOAD_PREFIX = 'ref_';

export const referralPayloadOf = (code: string): string => `${REFERRAL_PAYLOAD_PREFIX}${code}`;

// the code of a `ref_<code>` start payload; anything else, a malformed code included, is not one
export const referralCodeOf = (payload: string | undefined): string | undefined => {
  if (payload === undefined || !payload.startsWith(REFERRAL_PAYLOAD_PREFIX)) return undefined;
  const code = payload.slice(REFERRAL_PAYLOAD_PREFIX.length);
  return REFERRAL_CODE_PATTERN.test(code) ? code : undefined;
};

export const referralLinkOf = (botUsername: string, code: string): string =>
  `https://t.me/${botUsername}?start=${referralPayloadOf(code)}`;

// Why an invitee's activation paid the inviter no reward (#116, docs/referrals.md → The reward).
// Not an error: the invitee's account is activated either way.
export const ReferralRewardSkipReason = {
  NotPartnerClient: 'not_partner_client',
  NoReferral: 'no_referral',
  AlreadyRewarded: 'already_rewarded',
  InviterBlocked: 'inviter_blocked',
  // the referral_reward code has no active version valid now: the owner turned the reward off
  NoActiveRule: 'no_active_rule',
} as const;
export type ReferralRewardSkipReason =
  (typeof ReferralRewardSkipReason)[keyof typeof ReferralRewardSkipReason];

// POST /users/referral — the bot's /invite screen
export const userReferralRequestSchema = z.object({ telegramUserId: telegramUserIdSchema });
export type UserReferralRequest = z.infer<typeof userReferralRequestSchema>;

const invited = z.number().int().nonnegative();
// invitees with a confirmed partner account, and the tokens their rewards paid (#116): a decimal
// string, the amount is a bigint in the backend. While the reward rule is off the two differ.
const connected = invited;
// an active user always has a code; a blocked one never gets one created
export const userReferralViewSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal(UserStatus.Active),
    code: z.string().regex(REFERRAL_CODE_PATTERN),
    invited,
    connected,
    tokensEarned: tokenCountSchema,
  }),
  z.object({
    status: z.literal(UserStatus.Blocked),
    code: z.null(),
    invited,
    connected,
    tokensEarned: tokenCountSchema,
  }),
]);
export type UserReferralView = z.infer<typeof userReferralViewSchema>;

export const userReferralResponseSchema = z.object({ user: userReferralViewSchema });
export type UserReferralResponse = z.infer<typeof userReferralResponseSchema>;
