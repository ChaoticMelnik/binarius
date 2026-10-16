import { randomInt } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import {
  BrokerAccountStatus,
  REFERRAL_CODE_LENGTH,
  UserStatus,
  type UserReferralView,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { referralCodes, referrals } from './schema/referrals';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 62^8 ≈ 2.2·10^14 codes: a collision is not expected, a third one in a row is a fault
export const REFERRAL_CODE_ATTEMPTS = 3;

// randomInt is uniform over its range, so the code carries no modulo bias
export const randomReferralCode = (): string =>
  Array.from({ length: REFERRAL_CODE_LENGTH }, () => BASE62[randomInt(BASE62.length)]).join('');

// The /invite screen's read (#115, docs/referrals.md → The route). It creates the user's code on
// first use, so it is a write too, but an idempotent one: a repeat finds the code the first made.
// Each step is one autocommit statement; no lock beyond the FK's KEY SHARE on the users row. A
// blocked user gets no new code. No users row → undefined. `connected` counts invitees whose
// partner account was ever confirmed (a revoked one included); `tokensEarned` sums the rewards
// paid (#116), so the two differ while the reward rule is off.
export async function readUserReferral(
  db: Db,
  telegramUserId: bigint,
  generate: () => string = randomReferralCode,
): Promise<UserReferralView | undefined> {
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  if (user === undefined) return undefined;

  const stats = async () => {
    const [invited] = await db
      .select({
        invited: count(),
        connected: sql<number>`count(*) filter (where exists (
          select 1 from ${brokerAccounts}
          where ${brokerAccounts.userId} = ${referrals.inviteeUserId}
            and ${brokerAccounts.isPartnerClient}
            and ${brokerAccounts.status} <> ${BrokerAccountStatus.Pending}
        ))`.mapWith(Number),
      })
      .from(referrals)
      .where(eq(referrals.inviterUserId, user.id));
    const [earned] = await db
      .select({ tokens: sql<string>`coalesce(sum(${tokenLedger.balanceDelta}), 0)::text` })
      .from(tokenLedger)
      .where(sql`${tokenLedger.userId} = ${user.id} and ${tokenLedger.referralId} is not null`);
    return {
      invited: invited?.invited ?? 0,
      connected: invited?.connected ?? 0,
      tokensEarned: earned?.tokens ?? '0',
    };
  };
  if (user.status === UserStatus.Blocked) {
    return { status: user.status, code: null, ...(await stats()) };
  }
  const code = await codeOf(db, user.id, generate);
  return { status: user.status, code, ...(await stats()) };
}

async function codeOf(db: Db, userId: string, generate: () => string): Promise<string> {
  const existing = await selectCode(db, userId);
  if (existing !== undefined) return existing;
  for (let attempt = 0; attempt < REFERRAL_CODE_ATTEMPTS; attempt++) {
    // a conflict on user_id is a concurrent first read, on code another user's code: either way
    // nothing is written, and the select below tells the two apart
    await db.insert(referralCodes).values({ userId, code: generate() }).onConflictDoNothing();
    const code = await selectCode(db, userId);
    if (code !== undefined) return code;
  }
  throw new Error(`no free referral code after ${REFERRAL_CODE_ATTEMPTS} attempts`);
}

const selectCode = async (db: Db, userId: string): Promise<string | undefined> => {
  const [row] = await db
    .select({ code: referralCodes.code })
    .from(referralCodes)
    .where(eq(referralCodes.userId, userId));
  return row?.code;
};
