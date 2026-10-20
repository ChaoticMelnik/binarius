import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  H1_VERSION,
  H1ShadowEntryOutcome,
  safeParseTradingSessionSettings,
  SIGNAL_ALGORITHM_VERSIONS,
  SIGNAL_CHART_INTERVAL_MS,
  sessionStakeParams,
  sessionTradeSteps,
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  TradeIntentStatus,
  type DecimalString,
  type LastTick,
  type SessionStakeStrategy,
  type SessionTradeStep,
  type SignalInterval,
  type SignalRecord,
  type TradeAction,
  type TradeMode,
  type TradingSessionStopReason,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { literal } from './schema/columns';
import { brokerTrades, type BrokerTradeStatus } from './schema/broker-trades';
import { SIGNAL_DECISION_PAYOUT_MAX, signalDecisions } from './schema/signal-decisions';
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

// the writer's facts beside the record's entry
export interface SignalDecisionFacts {
  context: SignalDecisionContext;
  tradingSessionId: string | null;
  brokerAccountId: string;
  step: number | null;
  payout: number | null;
  takenAtMs: number;
  outcome: SignalDecisionOutcome;
  detail: string | null;
}

// One builder for both writers (the orchestrator, the start route): the row holds the entry as
// the backend answered it, so journalEntryOf rebuilds exactly what replaySignalJournalEntry needs.
export function signalDecisionInput(
  { entry, lastTick }: SignalRecord,
  facts: SignalDecisionFacts,
): SignalDecisionInput {
  const { decision } = entry;
  return {
    ...facts,
    assetId: entry.assetId,
    interval: entry.interval,
    version: entry.version,
    decidedAtMs: entry.nowMs,
    kind: decision.kind,
    action: decision.kind === SignalKind.Signal ? decision.action : null,
    digits: entry.digits,
    params: entry.params,
    decision,
    source: entry.source,
    series: entry.series,
    lastTick,
    ticksUntilMs: null,
  };
}

// The payout is the broker catalog's, unbounded by design (#631): one the column cannot hold is
// stored as NULL, so a writer's INSERT is never refused over it.
export function signalDecisionPayout(payout: number | null): number | null {
  return payout !== null &&
    Number.isFinite(payout) &&
    payout >= 0 &&
    payout <= SIGNAL_DECISION_PAYOUT_MAX
    ? payout
    : null;
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
      payout: signalDecisionPayout(input.payout),
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
  payout: number;
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
  broker: TradeLogBrokerRow | null;
}

export interface TradeLogRow {
  decision: TradeLogDecisionRow;
  session: TradeLogSessionRow | null;
  intent: TradeLogIntentRow | null;
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
      brokerStatus: brokerTrades.status,
      brokerPayout: brokerTrades.payout,
      brokerOpenPrice: brokerTrades.openPrice,
      brokerOpenTimestampMs: brokerTrades.openTimestampMs,
      brokerClosePrice: brokerTrades.closePrice,
      brokerCloseTimestampMs: brokerTrades.closeTimestampMs,
      brokerProfit: brokerTrades.profit,
    })
    .from(d)
    .leftJoin(tradingSessions, eq(tradingSessions.id, d.tradingSessionId))
    .leftJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .leftJoin(tradeIntents, eq(tradeIntents.signalDecisionId, d.id))
    .leftJoin(brokerTrades, eq(brokerTrades.intentId, tradeIntents.id))
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
              broker:
                row.brokerStatus === null ||
                row.brokerPayout === null ||
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

// --- The H1 shadow report's read (#681, docs/h1.md → The report) --------------------------------

// one entry delay of one set and pair; entryDelaySec null: the entries outside the row's shape
// (no delay 1..9), whatever their outcome
export type H1ShadowEntryCell = {
  set: string | null;
  assetId: number;
  entryDelaySec: number | null;
  records: number;
  wins: number;
  losses: number;
  ties: number;
  unpriced: number;
  // an outcome outside H1ShadowEntryOutcome, or none
  other: number;
  // at stake 1: +payout/100 per win with a payout, -1 per loss
  pnl: number;
  winsWithoutPayout: number;
};

export type H1ShadowPairStats = {
  set: string | null;
  assetId: number;
  symbol: string | null;
  decisions: number;
  // rows with a payout; the mean, min and max are over them alone
  pricedRows: number;
  payoutMean: number | null;
  payoutMin: number | null;
  payoutMax: number | null;
  // rows whose result.entries is not an array (result NULL included): decisions without entries
  rowsWithoutEntries: number;
};

export type H1ShadowSetStats = {
  set: string | null;
  decisions: number;
  // taken_at_ms - decided_at_ms, interpolated percentiles over the window
  lagMsP50: number;
  lagMsP95: number;
  // the distinct params.entryDelaySec of the set's rows, null when no row names one
  ownEntryDelaySecs: string[] | null;
};

export interface H1ShadowStats {
  decisions: number;
  entries: H1ShadowEntryCell[];
  pairs: H1ShadowPairStats[];
  sets: H1ShadowSetStats[];
}

// Three aggregates over the shadow rows of [from, to) by recorded_at; only groups reach the
// process. jsonb_array_elements throws on a non-array, hence the jsonb_typeof guard.
export async function readH1ShadowStats(
  db: Db,
  { from, to }: { from: Date; to: Date },
): Promise<H1ShadowStats> {
  const d = signalDecisions;
  const shadowRows = sql`${d.context} = ${literal(SignalDecisionContext.Shadow)}
    and ${d.outcome} = ${literal(SignalDecisionOutcome.Shadow)}
    and ${d.version} = ${H1_VERSION}
    and ${d.recordedAt} >= ${from.toISOString()}::timestamptz
    and ${d.recordedAt} < ${to.toISOString()}::timestamptz`;
  const win = literal(H1ShadowEntryOutcome.Win);
  const loss = literal(H1ShadowEntryOutcome.Loss);
  const tie = literal(H1ShadowEntryOutcome.Tie);
  const unpriced = literal(H1ShadowEntryOutcome.Unpriced);

  const entries = await db.execute<H1ShadowEntryCell>(sql`
    select ${d.params}->>'set' as "set",
      ${d.assetId} as "assetId",
      e.g as "entryDelaySec",
      count(*)::int as "records",
      (count(*) filter (where e.oc = ${win}))::int as "wins",
      (count(*) filter (where e.oc = ${loss}))::int as "losses",
      (count(*) filter (where e.oc = ${tie}))::int as "ties",
      (count(*) filter (where e.oc = ${unpriced}))::int as "unpriced",
      (count(*) filter (where e.oc is null or e.oc not in (${win}, ${loss}, ${tie}, ${unpriced})))::int as "other",
      coalesce(sum(case when e.oc = ${win} and ${d.payout} is not null then ${d.payout}::float8 / 100
        when e.oc = ${loss} then -1 else 0 end), 0)::float8 as "pnl",
      (count(*) filter (where e.oc = ${win} and ${d.payout} is null))::int as "winsWithoutPayout"
    from ${d}
    cross join lateral jsonb_array_elements(case when jsonb_typeof(${d.result}->'entries') = 'array'
      then ${d.result}->'entries' else '[]'::jsonb end) as x(entry)
    cross join lateral (select
      case when x.entry->>'entryDelaySec' ~ '^[1-9]$' then (x.entry->>'entryDelaySec')::int end as g,
      case when jsonb_typeof(x.entry->'outcome') = 'string' then x.entry->>'outcome' end as oc) e
    where ${shadowRows}
    group by 1, 2, 3`);

  const pairs = await db.execute<H1ShadowPairStats>(sql`
    select ${d.params}->>'set' as "set",
      ${d.assetId} as "assetId",
      min(${d.source}->>'symbol') as "symbol",
      count(*)::int as "decisions",
      count(${d.payout})::int as "pricedRows",
      avg(${d.payout})::float8 as "payoutMean",
      min(${d.payout})::float8 as "payoutMin",
      max(${d.payout})::float8 as "payoutMax",
      (count(*) filter (where jsonb_typeof(${d.result}->'entries') is distinct from 'array'))::int
        as "rowsWithoutEntries"
    from ${d}
    where ${shadowRows}
    group by 1, 2`);

  const sets = await db.execute<H1ShadowSetStats>(sql`
    select ${d.params}->>'set' as "set",
      count(*)::int as "decisions",
      percentile_cont(0.5) within group (order by ${d.takenAtMs} - ${d.decidedAtMs}) as "lagMsP50",
      percentile_cont(0.95) within group (order by ${d.takenAtMs} - ${d.decidedAtMs}) as "lagMsP95",
      array_agg(distinct ${d.params}->>'entryDelaySec')
        filter (where ${d.params}->>'entryDelaySec' is not null) as "ownEntryDelaySecs"
    from ${d}
    where ${shadowRows}
    group by 1`);

  return {
    decisions: sets.rows.reduce((sum, row) => sum + row.decisions, 0),
    entries: entries.rows,
    pairs: pairs.rows,
    sets: sets.rows,
  };
}
