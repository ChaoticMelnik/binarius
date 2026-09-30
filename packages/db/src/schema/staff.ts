import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { STAFF_LOGIN_PATTERN } from '@binarius/shared';
import { createdAt, id, inList, sqlTextLiteral, updatedAt } from './columns';

export const StaffStatus = { Active: 'active', Disabled: 'disabled' } as const;
export type StaffStatus = (typeof StaffStatus)[keyof typeof StaffStatus];

// Every hash this schema accepts is one staff-password.ts wrote. The CHECK is not a format
// validator — it is the line that stops a row carrying a hash from some other KDF, which
// verifyPassword would refuse at login time and nowhere earlier.
export const STAFF_PASSWORD_HASH_PREFIX = '$scrypt$';

// One row per person who can open the admin pages. There is no shared account and no account
// created from the environment: who did what is only answerable while every login belongs to
// someone. `locked_until` NULL means not locked; the attempt counter is not zeroed when a
// lockout expires, the next failure after it restarts the count at 1 (staff-ops.ts).
export const staff = pgTable(
  'staff',
  {
    id: id(),
    login: text('login').notNull(),
    passwordHash: text('password_hash').notNull(),
    // the Telegram account the second factor is sent to; one account, one staff member
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull(),
    displayName: text('display_name'),
    status: text('status').$type<StaffStatus>().notNull().default(StaffStatus.Active),
    failedPasswordAttempts: integer('failed_password_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // logins are compared case-insensitively at login, so two rows differing only in case
    // would be two accounts one password prompt cannot tell apart
    uniqueIndex('staff_login_lower_idx').on(sql`lower(${t.login})`),
    uniqueIndex('staff_telegram_user_id_idx').on(t.telegramUserId),
    check(
      'staff_login_check',
      sql`${t.login} ~ ${sqlTextLiteral(STAFF_LOGIN_PATTERN.source, 'STAFF_LOGIN_PATTERN')}`,
    ),
    check(
      'staff_password_hash_check',
      sql`left(${t.passwordHash}, ${sql.raw(String(STAFF_PASSWORD_HASH_PREFIX.length))}) = ${sqlTextLiteral(STAFF_PASSWORD_HASH_PREFIX, 'STAFF_PASSWORD_HASH_PREFIX')}`,
    ),
    inList('staff_status_check', t.status, StaffStatus),
    check('staff_failed_attempts_check', sql`${t.failedPasswordAttempts} >= 0`),
    // Telegram ids are positive; 0 is what an unset field deserializes to
    check('staff_telegram_user_id_check', sql`${t.telegramUserId} > 0`),
  ],
);
