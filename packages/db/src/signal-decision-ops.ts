import {
  SignalKind,
  type LastTick,
  type SignalDecisionContext,
  type SignalDecisionOutcome,
  type SignalInterval,
  type SignalRecord,
  type TradeAction,
} from '@binarius/shared';
import { SIGNAL_DECISION_PAYOUT_MAX, signalDecisions } from './schema/signal-decisions';
import type { DbExecutor } from './trade-intent-ops';

// The trade log (#666, docs/trade-log.md): the decision rows a session's processes write. One
// INSERT per decision, with its outcome; no UPDATE.

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
    })
    .returning({ id: signalDecisions.id });
  if (row === undefined) throw new Error('signal_decisions insert returned no row');
  return row;
}
