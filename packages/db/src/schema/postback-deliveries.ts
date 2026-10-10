import {
  PostbackDeliveryOutcome,
  PostbackEvent,
  PostbackRejectReason,
  PostbackSource,
} from '@binarius/shared';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, inList, literal } from './columns';
import { depositEvents } from './deposit-events';

const rejected = literal(PostbackDeliveryOutcome.Rejected);

// The journal (#141, docs/postbacks.md): one row per delivery that passed the URL secret,
// including one the parser refused. A repeat of a recorded postback id writes nothing.
export const postbackDeliveries = pgTable(
  'postback_deliveries',
  {
    id: id(),
    source: text('source').$type<PostbackSource>().notNull(),
    // NULL only on a rejected row (missing_postback_id)
    postbackId: text('postback_id'),
    // NULL only on a rejected row (no or an unknown marker)
    event: text('event').$type<PostbackEvent>(),
    outcome: text('outcome').$type<PostbackDeliveryOutcome>().notNull(),
    rejectReason: text('reject_reason').$type<PostbackRejectReason>(),
    depositEventId: uuid('deposit_event_id').references(() => depositEvents.id, {
      onDelete: 'restrict',
    }),
    // the query as received, the secret is in the path and never here
    payload: jsonb('payload').$type<Record<string, string>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    inList('postback_deliveries_source_check', t.source, PostbackSource),
    inList('postback_deliveries_event_check', t.event, PostbackEvent),
    inList('postback_deliveries_outcome_check', t.outcome, PostbackDeliveryOutcome),
    inList('postback_deliveries_reject_reason_check', t.rejectReason, PostbackRejectReason),
    // a rejected row has a reason and no deposit; any other has a deposit, an id and an event,
    // so the partial unique below never sees a NULL id on a row it covers
    check(
      'postback_deliveries_outcome_shape_check',
      sql`case
        when ${t.outcome} = ${rejected}
          then ${t.depositEventId} is null and ${t.rejectReason} is not null
        else ${t.depositEventId} is not null and ${t.rejectReason} is null
          and ${t.postbackId} is not null and ${t.event} is not null
      end`,
    ),
    // one delivery per postback id; a rejected one takes no slot, so a corrected re-send with
    // the same id is recorded
    uniqueIndex('postback_deliveries_source_postback_idx')
      .on(t.source, t.postbackId)
      .where(sql`${t.outcome} <> ${rejected}`),
    index('postback_deliveries_deposit_event_id_idx').on(t.depositEventId),
    index('postback_deliveries_created_at_idx').on(t.createdAt),
  ],
);
