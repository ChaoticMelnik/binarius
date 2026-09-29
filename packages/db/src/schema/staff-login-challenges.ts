import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, inList, literal, sqlLiteralList } from './columns';
import { staff } from './staff';

export const StaffLoginChallengeStatus = {
  // the password was accepted; the invitation is on its way to Telegram and no code exists yet
  Pending: 'pending',
  // the staff member pressed "Подтвердить вход" and a code was issued
  Confirmed: 'confirmed',
  // the code was entered correctly and a session was created
  Completed: 'completed',
  // the staff member pressed "Это не я"
  Denied: 'denied',
  Expired: 'expired',
  // five wrong codes
  Exhausted: 'exhausted',
  // Telegram would not take the invitation or the code, so nothing can arrive
  Failed: 'failed',
} as const;
export type StaffLoginChallengeStatus =
  (typeof StaffLoginChallengeStatus)[keyof typeof StaffLoginChallengeStatus];

// A challenge is open while it can still turn into a session. The partial unique index below
// is keyed on exactly this set, so the two cannot drift.
export const OPEN_CHALLENGE_STATUSES = [
  StaffLoginChallengeStatus.Pending,
  StaffLoginChallengeStatus.Confirmed,
] as const;

// statuses a code must exist for; `pending` is the mirror case, where it must not
const CODE_BEARING_STATUSES = [
  StaffLoginChallengeStatus.Confirmed,
  StaffLoginChallengeStatus.Completed,
  StaffLoginChallengeStatus.Exhausted,
] as const;

// One row per login attempt that got past the password. The id travels in the Telegram button's
// callback_data, so it identifies the attempt but authorises nothing: every transition is a CAS
// that also joins `staff` on the Telegram account the update came from.
//
// `prompt_sent_at` and `code_sent_at` are delivery state, not decoration: a process that dies
// between the commit and the Bot API call would otherwise leave the staff member waiting out
// the whole window with nothing in Telegram. NULL means "not delivered, may be sent".
export const staffLoginChallenges = pgTable(
  'staff_login_challenges',
  {
    id: id(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    status: text('status')
      .$type<StaffLoginChallengeStatus>()
      .notNull()
      .default(StaffLoginChallengeStatus.Pending),
    codeHash: text('code_hash'),
    codeAttempts: integer('code_attempts').notNull().default(0),
    // what the web process saw for the request that started this attempt
    ip: text('ip').notNull(),
    userAgent: text('user_agent').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    promptSentAt: timestamp('prompt_sent_at', { withTimezone: true }),
    codeSentAt: timestamp('code_sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('staff_login_challenges_staff_id_idx').on(t.staffId),
    index('staff_login_challenges_expires_at_idx').on(t.expiresAt),
    // at most one attempt in flight per staff member: a second login reuses the first one's
    // row instead of issuing a second code the first button press would invalidate
    uniqueIndex('staff_login_challenges_open_idx')
      .on(t.staffId)
      .where(sql`${t.status} in (${sqlLiteralList(OPEN_CHALLENGE_STATUSES)})`),
    inList('staff_login_challenges_status_check', t.status, StaffLoginChallengeStatus),
    check('staff_login_challenges_code_attempts_check', sql`${t.codeAttempts} >= 0`),
    check(
      'staff_login_challenges_expires_after_created_check',
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
    // a code and the moment it was issued are one fact
    check(
      'staff_login_challenges_confirmed_pair_check',
      sql`(${t.confirmedAt} is null) = (${t.codeHash} is null)`,
    ),
    check(
      'staff_login_challenges_confirmed_after_created_check',
      sql`${t.confirmedAt} is null or ${t.confirmedAt} >= ${t.createdAt}`,
    ),
    // `denied`, `expired` and `failed` can hold a code or not, depending on how far the
    // attempt got; the other three cannot be ambiguous
    check(
      'staff_login_challenges_code_status_check',
      sql`case
            when ${t.status} = ${literal(StaffLoginChallengeStatus.Pending)} then ${t.codeHash} is null
            when ${t.status} in (${sqlLiteralList(CODE_BEARING_STATUSES)}) then ${t.codeHash} is not null
            else true
          end`,
    ),
    check(
      'staff_login_challenges_prompt_sent_check',
      sql`${t.promptSentAt} is null or ${t.promptSentAt} >= ${t.createdAt}`,
    ),
    // a code cannot have been delivered before it existed
    check(
      'staff_login_challenges_code_sent_check',
      sql`${t.codeSentAt} is null or (${t.codeHash} is not null and ${t.codeSentAt} >= ${t.createdAt})`,
    ),
  ],
);
