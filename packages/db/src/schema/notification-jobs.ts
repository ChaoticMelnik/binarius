import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { NotificationKind } from '@binarius/shared';
import { createdAt, id, inList, updatedAt } from './columns';
import { users } from './users';

export const NotificationJobStatus = {
  Pending: 'pending',
  Sent: 'sent',
  Failed: 'failed',
  Canceled: 'canceled',
} as const;
export type NotificationJobStatus =
  (typeof NotificationJobStatus)[keyof typeof NotificationJobStatus];

// The mailing engine's queue (#202, docs/mailing.md): the planner inserts, the sender claims.
export const notificationJobs = pgTable(
  'notification_jobs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NotificationKind>().notNull(),
    status: text('status')
      .$type<NotificationJobStatus>()
      .notNull()
      .default(NotificationJobStatus.Pending),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // per user, not global: a scheduled or broadcast job is keyed by event or date
    // (`daily-summary-2026-09-22`), so a global unique would deliver to the first user and
    // silently drop everyone else
    uniqueIndex('notification_jobs_dedupe_key_idx')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index('notification_jobs_status_scheduled_idx').on(t.status, t.scheduledAt),
    index('notification_jobs_user_id_idx').on(t.userId),
    inList('notification_jobs_status_check', t.status, NotificationJobStatus),
    inList('notification_jobs_kind_check', t.kind, NotificationKind),
  ],
);

// The moment from which each kind plans (docs/mailing.md → Cutoff): a scenario plans only for
// facts at or after plans_from, so a kind added to a running system never reaches the users whose
// fact is older (#202: no reminders for accounts connected before the engine's deploy). The
// migration that adds a kind seeds its row from the database clock; a kind with no row plans
// nothing.
export const notificationKinds = pgTable(
  'notification_kinds',
  {
    kind: text('kind').$type<NotificationKind>().primaryKey(),
    plansFrom: timestamp('plans_from', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [inList('notification_kinds_kind_check', t.kind, NotificationKind)],
);
