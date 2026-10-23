import { TradeIntentStatus, type DecimalString } from '@binarius/shared';
import { SessionTradeKind } from './codes';
import type { SessionTrade, StakeInput } from './size';

export interface SessionIntentOutcome {
  status: TradeIntentStatus;
  amount: DecimalString;
  profit: DecimalString | null;
}

// The one mapping of a session's intents to the sizer's trades (#775): the orchestrator and the
// backend's H1 driver size over the same history. A settled intent whose broker trade has no
// profit yet is unresolved, not a zero
export function sessionTradeOf(intent: SessionIntentOutcome): SessionTrade {
  if (intent.status === TradeIntentStatus.Rejected) return { kind: SessionTradeKind.Rejected };
  if (intent.status === TradeIntentStatus.Settled && intent.profit !== null) {
    return { kind: SessionTradeKind.Settled, stake: intent.amount, profit: intent.profit };
  }
  return { kind: SessionTradeKind.Unresolved };
}

// The one sizer input of a session's step (#775): the orchestrator's attempts and the H1 driver.
// started_at is the database's clock: a process clock behind it would make the sizer throw
export function sessionStakeInput(input: {
  intents: readonly SessionIntentOutcome[];
  payout: number;
  minTradeAmount: DecimalString;
  available: DecimalString;
  sessionStartedAtMs: number;
  nowMs: number;
}): StakeInput {
  return {
    history: input.intents.map(sessionTradeOf),
    payout: input.payout,
    minTradeAmount: input.minTradeAmount,
    available: input.available,
    sessionStartedAtMs: input.sessionStartedAtMs,
    nowMs: Math.max(input.nowMs, input.sessionStartedAtMs),
  };
}
