import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { REFERRAL_CODE_PATTERN } from '@binarius/shared';
import { createdAt, id, sqlTextLiteral } from './columns';
import { users } from './users';

// Personal start links (#115, docs/referrals.md). A user's code, created by readUserReferral
// (referral-ops.ts) on the first /invite and never changed. `code ~ …` lets NULL through, so the
// column is NOT NULL rather than spelling the NULL case out.
export const referralCodes = pgTable(
  'referral_codes',
  {
    userId: uuid('user_id').primaryKey(),
    code: text('code').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'referral_codes_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    unique('referral_codes_code_key').on(t.code),
    check(
      'referral_codes_code_check',
      sql`${t.code} ~ ${sqlTextLiteral(REFERRAL_CODE_PATTERN.source, 'REFERRAL_CODE_PATTERN')}`,
    ),
  ],
);

// Who invited whom: one row per invitee, ever, written only by recordUserStart (user-ops.ts) in
// the transaction of the /start that created the invitee's users row. The reward is #116's.
export const referrals = pgTable(
  'referrals',
  {
    id: id(),
    inviteeUserId: uuid('invitee_user_id').notNull(),
    inviterUserId: uuid('inviter_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'referrals_invitee_fk',
      columns: [t.inviteeUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'referrals_inviter_fk',
      columns: [t.inviterUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    unique('referrals_invitee_key').on(t.inviteeUserId),
    check('referrals_not_self_check', sql`${t.inviteeUserId} <> ${t.inviterUserId}`),
    index('referrals_inviter_idx').on(t.inviterUserId),
  ],
);

export type ReferralCodeRow = typeof referralCodes.$inferSelect;
export type ReferralRow = typeof referrals.$inferSelect;
