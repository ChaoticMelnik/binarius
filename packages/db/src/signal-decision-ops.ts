import { and, asc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  safeParseTradingSessionSettings,
  SIGNAL_ALGORITHM_VERSIONS,
  SIGNAL_CHART_INTERVAL_MS,
  sessionStakeParams,
  sessionTradeSteps,
  SessionTradeResult,
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  TradeIntentStatus,
  type DecimalString,
  type DecisionTicksDetail,
  type DecisionTicksStatus,
  type LastTick,
  type SessionStakeStrategy,
  type SessionTradeStep,
  type SignalInterval,
  type TradeAction,
  type TradeIntentFailureReason,
  type TradeLogTickRow,
  type TradeMode,
  type TradingSessionStopReason,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { literal, payoutInColumn } from './schema/columns';
import { brokerTrades, BrokerTradeStatus } from './schema/broker-trades';
import { decisionTicks } from './schema/decision-ticks';
import { signalDecisions } from './schema/signal-decisions';
import { tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { tradeResultSql } from './session-notice-ops';
import type { DbExecutor } from './trade-intent-ops';

// The trade log (#666, docs/trade-log.md): the decision rows a session's processes write and the
// export's reads. One INSERT per decision, with its outcome; no UPDATE.

export interface SignalDecisionInput {
  context: SignalDecisionContext;
  tradingSessionId: string | null;
  brokerAccountId: string | null;
  step: number | null;
  assetId: number;
  interval: SignalInterval | null;
  version: string;
  decidedAtMs: number;
  takenAtMs: number;
  kind: SignalKind;
  action: TradeAction | null;
  payout: number | null;
  digits: number | null;
  params: Readonly<Record<string, unknown>>;
  decision: Readonly<Record<string, unknown>>;
  source: Readonly<Record<string, unknown>>;
  series: readonly unknown[];
  lastTick: LastTick | null;
  outcome: SignalDecisionOutcome;
  detail: string | null;
  result?: Record<string, unknown> | null;
  // required, so every writer names it: a shadow row's f + 7 s (#669), null for a session's rows
  ticksUntilMs: number | null;
}

export async function recordSignalDecision(
  exec: DbExecutor,
  input: SignalDecisionInput,
): Promise<{ id: string }> {
  const [row] = await exec
    .insert(signalDecisions)
    .values({
      context: input.context,
      tradingSessionId: input.tradingSessionId,
      brokerAccountId: input.brokerAccountId,
      step: input.step,
      assetId: input.assetId,
      interval: input.interval,
      version: input.version,
      decidedAtMs: input.decidedAtMs,
      takenAtMs: input.takenAtMs,
      kind: input.kind,
      action: input.action,
      payout: payoutInColumn(input.payout),
      digits: input.digits,
      params: input.params,
      decision: input.decision,
      source: input.source,
      series: [...input.series],
      lastTick: input.lastTick,
      outcome: input.outcome,
      detail: input.detail,
      result: input.result ?? null,
      ticksUntilMs: input.ticksUntilMs,
    })
    .returning({ id: signalDecisions.id });
  if (row === undefined) throw new Error('signal_decisions insert returned no row');
  return row;
}

// --- The export's reads -------------------------------------------------------------------------

export interface TradeLogDecisionRow {
  id: string;
  context: SignalDecisionContext;
  outcome: SignalDecisionOutcome;
  detail: string | null;
  version: string;
  assetId: number;
  interval: SignalInterval | null;
  step: number | null;
  kind: SignalKind;
  action: TradeAction | null;
  decidedAtMs: number;
  takenAtMs: number;
  recordedAt: Date;
  payout: number | null;
  digits: number | null;
  params: Record<string, unknown>;
  decision: Record<string, unknown>;
  source: Record<string, unknown>;
  series: unknown[];
  lastTick: LastTick | null;
  result: Record<string, unknown> | null;
  ticksUntilMs: number | null;
}

export interface TradeLogSessionRow {
  id: string;
  userId: string;
  brokerAccountId: string;
  mode: TradeMode;
  settings: unknown;
  stopReason: TradingSessionStopReason | null;
}

export interface TradeLogBrokerRow {
  status: BrokerTradeStatus;
  payout: number | null;
  openPrice: number;
  openTimestampMs: number;
  closePrice: number | null;
  closeTimestampMs: number | null;
  profit: DecimalString | null;
}

export interface TradeLogIntentRow {
  id: string;
  status: TradeIntentStatus;
  mode: TradeMode;
  assetId: number;
  action: TradeAction;
  amount: DecimalString;
  durationSec: number;
  createdAt: Date;
  submittedAt: Date | null;
  lastError: TradeIntentFailureReason | null;
  submitDeadlineAt: Date | null;
  submitNotBeforeAt: Date | null;
  broker: TradeLogBrokerRow | null;
}

// the decision's decision_ticks row (#668), null without one
export interface TradeLogTicksRow {
  status: DecisionTicksStatus;
  detail: DecisionTicksDetail | null;
  fromMs: number;
  untilMs: number;
  count: number;
  ticks: TradeLogTickRow[];
}

export interface TradeLogRow {
  decision: TradeLogDecisionRow;
  session: TradeLogSessionRow | null;
  intent: TradeLogIntentRow | null;
  ticks: TradeLogTicksRow | null;
}

// the page's last row: recorded_at as the database's text, since a Date drops its microseconds
export interface TradeLogCursor {
  recordedAt: string;
  id: string;
}

export interface TradeLogPage {
  rows: TradeLogRow[];
  next: TradeLogCursor | undefined;
}

// A page of decisions recorded in [from, to), in (recorded_at, id) order, after the cursor. Named
// columns only (Rule 9): no token, no telegram_user_id, no broker_user_id, no broker_trades.raw.
export async function readTradeLogPage(
  db: Db,
  options: {
    from: Date;
    to: Date;
    after?: TradeLogCursor;
    limit: number;
    sessionId?: string;
  },
): Promise<TradeLogPage> {
  const d = signalDecisions;
  const rows = await db
    .select({
      cursor: sql<string>`${d.recordedAt}::text`,
      id: d.id,
      context: d.context,
      outcome: d.outcome,
      detail: d.detail,
      version: d.version,
      assetId: d.assetId,
      interval: d.interval,
      step: d.step,
      kind: d.kind,
      action: d.action,
      decidedAtMs: d.decidedAtMs,
      takenAtMs: d.takenAtMs,
      recordedAt: d.recordedAt,
      payout: d.payout,
      digits: d.digits,
      params: d.params,
      decision: d.decision,
      source: d.source,
      series: d.series,
      lastTick: d.lastTick,
      result: d.result,
      ticksUntilMs: d.ticksUntilMs,
      sessionId: tradingSessions.id,
      sessionUserId: brokerAccounts.userId,
      sessionAccountId: tradingSessions.brokerAccountId,
      sessionMode: tradingSessions.mode,
      sessionSettings: tradingSessions.settings,
      sessionStopReason: tradingSessions.stopReason,
      intentId: tradeIntents.id,
      intentStatus: tradeIntents.status,
      intentMode: tradeIntents.mode,
      intentAssetId: tradeIntents.assetId,
      intentAction: tradeIntents.action,
      intentAmount: tradeIntents.amount,
      intentDurationSec: tradeIntents.durationSec,
      intentCreatedAt: tradeIntents.createdAt,
      intentSubmittedAt: tradeIntents.submittedAt,
      intentLastError: tradeIntents.lastError,
      intentSubmitDeadlineAt: tradeIntents.submitDeadlineAt,
      intentSubmitNotBeforeAt: tradeIntents.submitNotBeforeAt,
      brokerStatus: brokerTrades.status,
      brokerPayout: brokerTrades.payout,
      brokerOpenPrice: brokerTrades.openPrice,
      brokerOpenTimestampMs: brokerTrades.openTimestampMs,
      brokerClosePrice: brokerTrades.closePrice,
      brokerCloseTimestampMs: brokerTrades.closeTimestampMs,
      brokerProfit: brokerTrades.profit,
      ticksStatus: decisionTicks.status,
      ticksDetail: decisionTicks.detail,
      ticksWindowFromMs: decisionTicks.fromMs,
      ticksWindowUntilMs: decisionTicks.untilMs,
      ticksCount: decisionTicks.count,
      ticksRows: decisionTicks.ticks,
    })
    .from(d)
    .leftJoin(tradingSessions, eq(tradingSessions.id, d.tradingSessionId))
    .leftJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .leftJoin(tradeIntents, eq(tradeIntents.signalDecisionId, d.id))
    .leftJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
    .leftJoin(decisionTicks, eq(decisionTicks.decisionId, d.id))
    .where(
      and(
        gte(d.recordedAt, options.from),
        lt(d.recordedAt, options.to),
        options.sessionId === undefined ? undefined : eq(d.tradingSessionId, options.sessionId),
        options.after === undefined
          ? undefined
          : sql`(${d.recordedAt}, ${d.id}) > (${options.after.recordedAt}::timestamptz, ${options.after.id}::uuid)`,
      ),
    )
    .orderBy(asc(d.recordedAt), asc(d.id))
    .limit(options.limit);

  const last = rows.at(-1);
  return {
    rows: rows.map((row) => ({
      decision: {
        id: row.id,
        context: row.context,
        outcome: row.outcome,
        detail: row.detail,
        version: row.version,
        assetId: row.assetId,
        interval: row.interval,
        step: row.step,
        kind: row.kind,
        action: row.action,
        decidedAtMs: row.decidedAtMs,
        takenAtMs: row.takenAtMs,
        recordedAt: row.recordedAt,
        payout: row.payout,
        digits: row.digits,
        params: row.params,
        decision: row.decision,
        source: row.source,
        series: row.series,
        lastTick: row.lastTick,
        result: row.result,
        ticksUntilMs: row.ticksUntilMs,
      },
      session:
        row.sessionId === null ||
        row.sessionUserId === null ||
        row.sessionAccountId === null ||
        row.sessionMode === null
          ? null
          : {
              id: row.sessionId,
              userId: row.sessionUserId,
              brokerAccountId: row.sessionAccountId,
              mode: row.sessionMode,
              settings: row.sessionSettings,
              stopReason: row.sessionStopReason,
            },
      intent:
        row.intentId === null ||
        row.intentStatus === null ||
        row.intentMode === null ||
        row.intentAssetId === null ||
        row.intentAction === null ||
        row.intentAmount === null ||
        row.intentDurationSec === null ||
        row.intentCreatedAt === null
          ? null
          : {
              id: row.intentId,
              status: row.intentStatus,
              mode: row.intentMode,
              assetId: row.intentAssetId,
              action: row.intentAction,
              amount: row.intentAmount,
              durationSec: row.intentDurationSec,
              createdAt: row.intentCreatedAt,
              submittedAt: row.intentSubmittedAt,
              lastError: row.intentLastError,
              submitDeadlineAt: row.intentSubmitDeadlineAt,
              submitNotBeforeAt: row.intentSubmitNotBeforeAt,
              broker:
                row.brokerStatus === null ||
                row.brokerOpenPrice === null ||
                row.brokerOpenTimestampMs === null
                  ? null
                  : {
                      status: row.brokerStatus,
                      payout: row.brokerPayout,
                      openPrice: row.brokerOpenPrice,
                      openTimestampMs: row.brokerOpenTimestampMs,
                      closePrice: row.brokerClosePrice,
                      closeTimestampMs: row.brokerCloseTimestampMs,
                      profit: row.brokerProfit,
                    },
            },
      ticks:
        row.ticksStatus === null ||
        row.ticksWindowFromMs === null ||
        row.ticksWindowUntilMs === null ||
        row.ticksCount === null ||
        row.ticksRows === null
          ? null
          : {
              status: row.ticksStatus,
              detail: row.ticksDetail,
              fromMs: row.ticksWindowFromMs,
              untilMs: row.ticksWindowUntilMs,
              count: row.ticksCount,
              ticks: row.ticksRows,
            },
    })),
    next:
      last === undefined || rows.length < options.limit
        ? undefined
        : { recordedAt: last.cursor, id: last.id },
  };
}

// The export's default end: the database's clock, the one recorded_at is written by, rounded up
// to the next millisecond, so a row recorded in the current millisecond is in [from, end)
export async function readTradeLogEnd(db: Db): Promise<Date> {
  const { rows } = await db.execute<{ end: string }>(
    sql`select to_char((date_trunc('milliseconds', now()) + interval '1 millisecond') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as end`,
  );
  const end = rows[0]?.end;
  if (end === undefined) throw new Error('now() returned no row');
  return new Date(end);
}

// The cycle and step of every settled trade of the sessions (sessionTradeSteps, the bot's
// numbering), by intent id; a session whose settings do not parse gets none.
export async function readSessionTradeSteps(
  db: Db,
  sessionIds: readonly string[],
): Promise<Map<string, SessionTradeStep>> {
  const steps = new Map<string, SessionTradeStep>();
  if (sessionIds.length === 0) return steps;
  const ids = [...new Set(sessionIds)];
  const sessions = await db
    .select({ id: tradingSessions.id, settings: tradingSessions.settings })
    .from(tradingSessions)
    .where(inArray(tradingSessions.id, ids));
  const trades = await db
    .select({
      sessionId: tradeIntents.tradingSessionId,
      intentId: tradeIntents.id,
      result: tradeResultSql,
    })
    .from(tradeIntents)
    .innerJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
    .where(
      and(
        inArray(tradeIntents.tradingSessionId, ids),
        eq(tradeIntents.status, TradeIntentStatus.Settled),
      ),
    )
    .orderBy(asc(tradeIntents.createdAt), asc(tradeIntents.id));
  for (const session of sessions) {
    const strategy = sessionStrategy(session.settings);
    if (strategy === null) continue;
    const own = trades.filter((trade) => trade.sessionId === session.id);
    sessionTradeSteps(
      own.map((trade) => trade.result),
      strategy,
    ).forEach((step, index) => {
      const trade = own[index];
      if (trade !== undefined) steps.set(trade.intentId, step);
    });
  }
  return steps;
}

export function sessionStrategy(settings: unknown): SessionStakeStrategy | null {
  const parsed = safeParseTradingSessionSettings(settings);
  return parsed.success ? sessionStakeParams(parsed.data).strategy : null;
}

// The journal entry a row was recorded from (packages/signal's SignalJournalEntry for a version
// the replay knows; a tick-based version's fields as stored otherwise).
export function journalEntryOf(row: TradeLogDecisionRow): Record<string, unknown> {
  const known =
    row.interval !== null && (SIGNAL_ALGORITHM_VERSIONS as readonly string[]).includes(row.version);
  return {
    assetId: row.assetId,
    interval: row.interval,
    ...(row.digits === null ? {} : { digits: row.digits }),
    ...(known && row.interval !== null
      ? { intervalMs: SIGNAL_CHART_INTERVAL_MS[row.interval] }
      : {}),
    nowMs: row.decidedAtMs,
    source: row.source,
    version: row.version,
    params: row.params,
    series: row.series,
    decision: row.decision,
  };
}

// --- The trade report's read (#502, docs/trade-log.md → The report) -----------------------------

// where an intent's direction came from: a session's decision row, a one-off trade (no session),
// or a session intent without a decision row (before 0068, or `record_missing` until #835)
export const TradeReportOrigin = {
  Signal: 'signal',
  Manual: 'manual',
  Unlinked: 'unlinked',
} as const;
export type TradeReportOrigin = (typeof TradeReportOrigin)[keyof typeof TradeReportOrigin];

// one group of intents; pooled: the group over every pair (assetId null). Money columns are the
// SQL sums as text, null when the group has no closed trade.
export type TradeReportCell = {
  mode: TradeMode;
  origin: TradeReportOrigin;
  version: string | null;
  paramsHash: string | null;
  interval: SignalInterval | null;
  durationSec: number;
  assetId: number | null;
  pooled: boolean;
  symbol: string | null;
  intents: number;
  trades: number;
  notClosed: number;
  wins: number;
  losses: number;
  ties: number;
  // closed trades with a payout; the mean, min and max are over them alone
  priced: number;
  payoutMean: number | null;
  payoutMin: number | null;
  payoutMax: number | null;
  staked: DecimalString | null;
  pnl: DecimalString | null;
  roiPct: string | null;
  firstAt: string | null;
  lastAt: string | null;
};

// one parameter set of a version, over its closed trades of the window
export type TradeReportVersion = {
  version: string;
  paramsHash: string;
  params: string;
  trades: number;
  firstAt: string;
  lastAt: string;
};

export type TradeReportNotClosed = {
  status: TradeIntentStatus;
  count: number;
};

export interface TradeReportStats {
  intents: number;
  trades: number;
  cells: TradeReportCell[];
  versions: TradeReportVersion[];
  notClosed: TradeReportNotClosed[];
}

const isoText = (value: SQL) =>
  sql`to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Three aggregates over the intents of [from, to) by trade_intents.created_at, each with its broker
// trade and decision row; only groups reach the process. A trade is a closed broker trade, its
// result tradeResultSql; money stays SQL numeric (Rule 2).
export async function readTradeReportStats(
  db: Db,
  { from, to }: { from: Date; to: Date },
): Promise<TradeReportStats> {
  const i = tradeIntents;
  const b = brokerTrades;
  const d = signalDecisions;
  const rows = sql`select ${i.id} as id, ${i.mode} as mode, ${i.status} as status,
      case when ${i.tradingSessionId} is null then ${literal(TradeReportOrigin.Manual)}
        when ${d.id} is null then ${literal(TradeReportOrigin.Unlinked)}
        else ${literal(TradeReportOrigin.Signal)} end as origin,
      ${d.version} as version, ${d.paramsHash} as params_hash, ${d.params}::text as params,
      ${d.interval} as interval, ${i.durationSec} as duration_sec, ${i.assetId} as asset_id,
      ${d.source}->>'symbol' as symbol, ${i.amount} as amount, ${i.createdAt} as created_at,
      ${b.payout} as payout, ${b.profit} as profit,
      coalesce(${b.status} = ${literal(BrokerTradeStatus.Closed)}, false) as closed,
      ${tradeResultSql} as result
    from ${i}
    left join ${b} on ${b.intentId} = ${i.id}
    left join ${d} on ${d.id} = ${i.signalDecisionId}
    where ${and(gte(i.createdAt, from), lt(i.createdAt, to))}`;
  const won = literal(SessionTradeResult.Won);
  const lost = literal(SessionTradeResult.Lost);
  const tied = literal(SessionTradeResult.Tied);

  const cells = await db.execute<TradeReportCell>(sql`
    select r.mode as "mode", r.origin as "origin", r.version as "version",
      r.params_hash as "paramsHash", r.interval as "interval", r.duration_sec as "durationSec",
      r.asset_id as "assetId", grouping(r.asset_id) = 1 as "pooled",
      min(r.symbol) as "symbol",
      count(*)::int as "intents",
      (count(*) filter (where r.closed))::int as "trades",
      (count(*) filter (where not r.closed))::int as "notClosed",
      (count(*) filter (where r.closed and r.result = ${won}))::int as "wins",
      (count(*) filter (where r.closed and r.result = ${lost}))::int as "losses",
      (count(*) filter (where r.closed and r.result = ${tied}))::int as "ties",
      (count(r.payout) filter (where r.closed))::int as "priced",
      (avg(r.payout) filter (where r.closed))::float8 as "payoutMean",
      (min(r.payout) filter (where r.closed))::float8 as "payoutMin",
      (max(r.payout) filter (where r.closed))::float8 as "payoutMax",
      (sum(r.amount) filter (where r.closed))::text as "staked",
      (sum(r.profit) filter (where r.closed))::text as "pnl",
      round(100 * sum(r.profit) filter (where r.closed)
        / nullif(sum(r.amount) filter (where r.closed), 0), 2)::text as "roiPct",
      ${isoText(sql`min(r.created_at) filter (where r.closed)`)} as "firstAt",
      ${isoText(sql`max(r.created_at) filter (where r.closed)`)} as "lastAt"
    from (${rows}) r
    group by grouping sets (
      (r.mode, r.origin, r.version, r.params_hash, r.interval, r.duration_sec, r.asset_id),
      (r.mode, r.origin, r.version, r.params_hash, r.interval, r.duration_sec))`);

  const versions = await db.execute<TradeReportVersion>(sql`
    select r.version as "version", r.params_hash as "paramsHash", min(r.params) as "params",
      count(*)::int as "trades",
      ${isoText(sql`min(r.created_at)`)} as "firstAt",
      ${isoText(sql`max(r.created_at)`)} as "lastAt"
    from (${rows}) r
    where r.origin = ${literal(TradeReportOrigin.Signal)} and r.closed
    group by r.version, r.params_hash`);

  const notClosed = await db.execute<TradeReportNotClosed>(sql`
    select r.status as "status", count(*)::int as "count"
    from (${rows}) r
    where not r.closed
    group by r.status`);

  const pooled = cells.rows.filter((cell) => cell.pooled);
  return {
    intents: pooled.reduce((sum, cell) => sum + cell.intents, 0),
    trades: pooled.reduce((sum, cell) => sum + cell.trades, 0),
    cells: cells.rows,
    versions: versions.rows,
    notClosed: notClosed.rows,
  };
}
