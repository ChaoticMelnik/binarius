import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id } from './columns';
import { staff } from './staff';

// One row per admin session. Only the hash of the token is stored: the token itself lives in
// the browser's cookie and nowhere else, so a database dump does not hand anyone a session.
// Revocation is a column rather than a deletion, and every admin request re-reads this row
// inside its own transaction — that is what makes a revoke visible to the very next request.
export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: id(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    ip: text('ip').notNull(),
    userAgent: text('user_agent').notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // NULL when the CLI revoked it (disable / reset-password), which has no staff member behind it
    revokedByStaffId: uuid('revoked_by_staff_id').references(() => staff.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    uniqueIndex('staff_sessions_token_hash_idx').on(t.tokenHash),
    index('staff_sessions_staff_id_idx').on(t.staffId),
    index('staff_sessions_expires_at_idx').on(t.expiresAt),
    check('staff_sessions_expires_after_created_check', sql`${t.expiresAt} > ${t.createdAt}`),
    check('staff_sessions_last_seen_after_created_check', sql`${t.lastSeenAt} >= ${t.createdAt}`),
    check(
      'staff_sessions_revoked_after_created_check',
      sql`${t.revokedAt} is null or ${t.revokedAt} >= ${t.createdAt}`,
    ),
    // a revoker with no revocation is a half-written row
    check(
      'staff_sessions_revoked_by_pair_check',
      sql`${t.revokedByStaffId} is null or ${t.revokedAt} is not null`,
    ),
  ],
);
