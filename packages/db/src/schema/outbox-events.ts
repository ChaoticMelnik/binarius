import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, inList } from './columns';
import { tradeIntents } from './trade-intents';

export const OutboxTopic = {
  TradingIntents: 'trading-intents',
  TradingReconciliation: 'trading-reconciliation',
} as const;
export type OutboxTopic = (typeof OutboxTopic)[keyof typeof OutboxTopic];

export const OutboxStatus = {
  Pending: 'pending',
  Published: 'published',
  Failed: 'failed',
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export interface OutboxPayload {
  intent_id: string;
}

// ARCH-03: written in the same transaction as the intent; the publisher turns pending rows
// into BullMQ jobs with jobId = intent_id. The payload carries only the intent id, never tokens.
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => tradeIntents.id, { onDelete: 'restrict' }),
    topic: text('topic').$type<OutboxTopic>().notNull().default(OutboxTopic.TradingIntents),
    payload: jsonb('payload').$type<OutboxPayload>().notNull(),
    status: text('status').$type<OutboxStatus>().notNull().default(OutboxStatus.Pending),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('outbox_events_topic_intent_key').on(t.topic, t.intentId),
    inList('outbox_events_topic_check', t.topic, OutboxTopic),
    inList('outbox_events_status_check', t.status, OutboxStatus),
    // The column is the FK/uniqueness key, the payload is the publisher's contract: keep them
    // equal. The key-existence test is what makes this false rather than NULL for a payload
    // that omits intent_id (a CHECK passes on NULL), and comparing text to text keeps the
    // uuid cast out of the constraint, so malformed input is 23514 and never 22P02.
    check(
      'outbox_events_payload_check',
      sql`jsonb_typeof(${t.payload}) = 'object'
          and ${t.payload} ? 'intent_id'
          and jsonb_typeof(${t.payload} -> 'intent_id') = 'string'
          and lower(${t.payload} ->> 'intent_id') = ${t.intentId}::text`,
    ),
    index('outbox_events_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);
