// A settled trade of a session as its message names it (#464): the class of the broker trade's
// profit, by its sign. No column holds it, so it is a plain const, not a status (Rule 1).
export const SessionTradeResult = { Won: 'won', Lost: 'lost', Tied: 'tied' } as const;
export type SessionTradeResult = (typeof SessionTradeResult)[keyof typeof SessionTradeResult];

// The stake strategies' wire names, as the worker's sizer spells them (apps/trading-worker
// src/stake/codes.ts); settings v1 carry none, so every session is fixed until #450.
export type SessionStakeStrategy = 'fixed' | 'martingale';

export interface SessionTradeStep {
  cycle: number;
  step: number;
}

// The cycle and step of each settled trade of a session, in their order (docs/bot-session.md →
// Trade messages). The step is the sizer's own (readHistory in apps/trading-worker/src/stake/
// size.ts, held equal by steps-parity.test.ts): 1 under fixed; under martingale the losses in a
// row before the trade plus one, a win ending the series and a tie leaving it as it is. A cycle
// is a series: every trade at step 1 after the first starts the next one.
export function sessionTradeSteps(
  results: readonly SessionTradeResult[],
  strategy: SessionStakeStrategy,
): SessionTradeStep[] {
  const steps: SessionTradeStep[] = [];
  let consecutiveLosses = 0;
  let cycle = 0;
  for (const result of results) {
    const step = strategy === 'martingale' ? consecutiveLosses + 1 : 1;
    if (step === 1) cycle += 1;
    steps.push({ cycle, step });
    if (result === SessionTradeResult.Won) consecutiveLosses = 0;
    else if (result === SessionTradeResult.Lost) consecutiveLosses += 1;
  }
  return steps;
}
