import { sql, type SQL } from 'drizzle-orm';
import {
  SignalDecisionContext,
  SignalDecisionOutcome,
  TRADE_TICKS_SHADOW_SAMPLE,
  type SignalDecisionContext as SignalDecisionContextValue,
  type TradeIntentStatus,
} from '@binarius/shared';
import type { Db } from './client';
import type { BrokerTradeStatus } from './schema/broker-trades';
import { literal } from './schema/columns';
import { decisionTicks } from './schema/decision-ticks';

// The ticks around a decision and the trade log's retention (#668, docs/trade-log.md → The ticks
// around a decision, → Retention): the keeper's reads and writes.

// shadowTicksSampled in SQL: the uuid's first four hex digits modulo the sample, K13 pins both
export const shadowSampledSql = (id: SQL): SQL =>
  sql`((('x' || left(${id}::text, 4))::bit(16)::int % ${sql.raw(String(TRADE_TICKS_SHADOW_SAMPLE))}) = 0)`;

export interface DecisionTicksCandidate {
  id: string;
  context: SignalDecisionContextValue;
  assetId: number;
  decidedAtMs: number;
  ticksUntilMs: number | null;
  intentStatus: TradeIntentStatus | null;
  // the intent's updated_at (the database clock), ms
  intentUpdatedAtMs: number | null;
  tradeStatus: BrokerTradeStatus | null;
  closeTimestampMs: number | null;
}

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

// Decisions recorded within the horizon (the database clock) without a decision_ticks row: every
// `intent` row and the sampled `shadow` rows, oldest first.
export async function listDecisionTicksCandidates(
  db: Db,
  options: { horizonMs: number; limit: number },
): Promise<DecisionTicksCandidate[]> {
  const { rows } = await db.execute<{
    id: string;
    context: SignalDecisionContextValue;
    asset_id: number;
    decided_at_ms: string;
    ticks_until_ms: string | null;
    intent_status: TradeIntentStatus | null;
    intent_updated_at_ms: string | null;
    trade_status: BrokerTradeStatus | null;
    close_timestamp_ms: string | null;
  }>(sql`
    select d.id, d.context, d.asset_id, d.decided_at_ms, d.ticks_until_ms,
           i.status as intent_status,
           floor(extract(epoch from i.updated_at) * 1000)::bigint as intent_updated_at_ms,
           b.status as trade_status, b.close_timestamp_ms
    from signal_decisions d
    left join decision_ticks k on k.decision_id = d.id
    left join trade_intents i on i.signal_decision_id = d.id
    left join broker_trades b on b.intent_id = i.id
    where d.recorded_at >= now() - make_interval(secs => ${options.horizonMs / 1000})
      and k.decision_id is null
      and (d.outcome = ${literal(SignalDecisionOutcome.Intent)}
           or (d.outcome = ${literal(SignalDecisionOutcome.Shadow)} and ${shadowSampledSql(sql.raw('d.id'))}))
    order by d.recorded_at, d.id
    limit ${options.limit}
  `);
  return rows.map((row) => ({
    id: row.id,
    context: row.context,
    assetId: row.asset_id,
    decidedAtMs: Number(row.decided_at_ms),
    ticksUntilMs: num(row.ticks_until_ms),
    intentStatus: row.intent_status,
    intentUpdatedAtMs: num(row.intent_updated_at_ms),
    tradeStatus: row.trade_status,
    closeTimestampMs: num(row.close_timestamp_ms),
  }));
}

export type DecisionTicksInsert = typeof decisionTicks.$inferInsert;

// One row per decision, written once: a row another backend wrote first (a deploy overlap) wins.
// Returns the number of rows inserted.
export async function insertDecisionTicks(db: Db, rows: DecisionTicksInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(decisionTicks)
    .values(rows)
    .onConflictDoNothing({ target: decisionTicks.decisionId })
    .returning({ decisionId: decisionTicks.decisionId });
  return inserted.length;
}

// Deletes up to `batch` decisions no intent names, recorded (the database clock) more than
// shadowRetentionDays ago for a shadow row or retentionDays ago for any row, with their
// decision_ticks rows, in one statement.
export async function sweepSignalDecisions(
  db: Db,
  options: { retentionDays: number; shadowRetentionDays: number; batch: number },
): Promise<{ decisions: number; ticks: number }> {
  const { rows } = await db.execute<{ decisions: number; ticks: number }>(sql`
    with victims as (
      select d.id from signal_decisions d
      where ((d.context = ${literal(SignalDecisionContext.Shadow)}
              and d.recorded_at < now() - make_interval(days => ${options.shadowRetentionDays}))
             or d.recorded_at < now() - make_interval(days => ${options.retentionDays}))
        and not exists (select 1 from trade_intents i where i.signal_decision_id = d.id)
      order by d.recorded_at, d.id
      limit ${options.batch}
    ), t as (
      delete from decision_ticks where decision_id in (select id from victims) returning decision_id
    ), s as (
      delete from signal_decisions where id in (select id from victims) returning id
    )
    select (select count(*) from s)::int as decisions, (select count(*) from t)::int as ticks
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('sweepSignalDecisions: the statement returned no row');
  return { decisions: row.decisions, ticks: row.ticks };
}
