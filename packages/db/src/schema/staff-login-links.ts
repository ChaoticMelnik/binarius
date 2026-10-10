import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, inList, literal } from './columns';
import { staff } from './staff';

export const StaffLoginLinkStatus = {
  // sent to the staff member's Telegram and not opened yet; past `expires_at` it is dead all the
  // same, because expiry is decided by the clock, not by a status
  Issued: 'issued',
  // opened, and a session was created from it
  Used: 'used',
  // a later press of the button replaced it
  Superseded: 'superseded',
  // the credentials or the status changed under it (CLI disable / reset-password, own password)
  Revoked: 'revoked',
} as const;
export type StaffLoginLinkStatus = (typeof StaffLoginLinkStatus)[keyof typeof StaffLoginLinkStatus];

// One row per login link the staff bot sent (#448). Only the sha256 of the token is stored: the
// token itself lives in the Telegram message and nowhere else, so a database dump opens nothing.
// Every transition is a CAS on `status`, and the one into `used` also re-checks the owner's
// status and the expiry by the database's clock.
export const staffLoginLinks = pgTable(
  'staff_login_links',
  {
    id: id(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    status: text('status')
      .$type<StaffLoginLinkStatus>()
      .notNull()
      .default(StaffLoginLinkStatus.Issued),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('staff_login_links_token_hash_idx').on(t.tokenHash),
    // at most one link a staff member can still open: a press supersedes the previous one in the
    // same transaction that inserts the new one
    uniqueIndex('staff_login_links_live_idx')
      .on(t.staffId)
      .where(sql`${t.status} = ${literal(StaffLoginLinkStatus.Issued)}`),
    // the per-staff rate limit counts this staff member's recent rows
    index('staff_login_links_staff_created_idx').on(t.staffId, t.createdAt),
    inList('staff_login_links_status_check', t.status, StaffLoginLinkStatus),
    check('staff_login_links_expires_after_created_check', sql`${t.expiresAt} > ${t.createdAt}`),
    // being used and the moment it was used are one fact
    check(
      'staff_login_links_used_pair_check',
      sql`(${t.status} = ${literal(StaffLoginLinkStatus.Used)}) = (${t.usedAt} is not null)`,
    ),
    check(
      'staff_login_links_used_after_created_check',
      sql`${t.usedAt} is null or ${t.usedAt} >= ${t.createdAt}`,
    ),
  ],
);
