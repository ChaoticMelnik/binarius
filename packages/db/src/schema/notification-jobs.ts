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

// skeleton (#7): kinds and payloads are defined by the notifications issue (#29)
export const notificationJobs = pgTable(
  'notification_jobs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
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
    uniqueIndex('notification_jobs_dedupe_key_idx')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index('notification_jobs_status_scheduled_idx').on(t.status, t.scheduledAt),
    index('notification_jobs_user_id_idx').on(t.userId),
    inList('notification_jobs_status_check', t.status, NotificationJobStatus),
  ],
);
