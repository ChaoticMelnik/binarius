import { sql } from 'drizzle-orm';
import { bigint, check, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  DecisionTicksDetail,
  DecisionTicksStatus,
  type TradeLogTickRow,
  type UnixMs,
} from '@binarius/shared';
import { inList, literal } from './columns';
import { signalDecisions } from './signal-decisions';

// The ticks around a decision (#668, docs/trade-log.md → The ticks around a decision): one row per
// captured decision, written once by the backend's trade log keeper when its window closed. No
// UPDATE writer; the retention sweep deletes a row with its decision.
export const decisionTicks = pgTable(
  'decision_ticks',
  {
    decisionId: uuid('decision_id')
      .primaryKey()
      .references(() => signalDecisions.id, { onDelete: 'restrict' }),
    // the window [fromMs, untilMs] by the broker's tick time
    fromMs: bigint('from_ms', { mode: 'number' }).$type<UnixMs>().notNull(),
    untilMs: bigint('until_ms', { mode: 'number' }).$type<UnixMs>().notNull(),
    status: text('status').$type<DecisionTicksStatus>().notNull(),
    detail: text('detail').$type<DecisionTicksDetail>(),
    count: integer('count').notNull(),
    ticks: jsonb('ticks').$type<TradeLogTickRow[]>().notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('decision_ticks_from_ms_check', sql`${t.fromMs} > 0`),
    check('decision_ticks_window_check', sql`${t.untilMs} >= ${t.fromMs}`),
    inList('decision_ticks_status_check', t.status, DecisionTicksStatus),
    inList('decision_ticks_detail_check', t.detail, DecisionTicksDetail),
    check(
      'decision_ticks_detail_pair_check',
      sql`(${t.status} = ${literal(DecisionTicksStatus.Complete)}) = (${t.detail} is null)`,
    ),
    check('decision_ticks_count_check', sql`${t.count} >= 0`),
    check(
      'decision_ticks_count_pair_check',
      sql`(${t.status} = ${literal(DecisionTicksStatus.Unavailable)}) = (${t.count} = 0)`,
    ),
    // a case: jsonb_array_length of a non-array raises instead of returning false
    check(
      'decision_ticks_ticks_check',
      sql`case when jsonb_typeof(${t.ticks}) = 'array' then jsonb_array_length(${t.ticks}) = ${t.count} else false end`,
    ),
  ],
);
