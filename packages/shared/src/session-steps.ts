// A settled trade of a session as its message names it (#464): the class of the broker trade's
// profit, by its sign. No column holds it, so it is a plain const, not a status (Rule 1).
export const SessionTradeResult = { Won: 'won', Lost: 'lost', Tied: 'tied' } as const;
export type SessionTradeResult = (typeof SessionTradeResult)[keyof typeof SessionTradeResult];

// The stake strategies' wire names (#450): settings v2 and v3 carry one, the worker's sizer takes it
// (apps/trading-worker/src/stake/codes.ts re-exports it) and settings v1 read as fixed
export const SessionStakeStrategy = { Fixed: 'fixed', Martingale: 'martingale' } as const;
export type SessionStakeStrategy = (typeof SessionStakeStrategy)[keyof typeof SessionStakeStrategy];

export interface SessionTradeStep {
  cycle: number;
  step: number;
}

// The cycle and step of each settled trade of a session, in their order (docs/bot-session.md →
// Trade messages). Under martingale the step is the trade's number within its cycle (#551): a win
// ends the cycle, a loss and a tie both move to the next step. A cycle is the sizer's series
// (readHistory in apps/trading-worker/src/stake/size.ts): only a win closes it. The sizer's own
// step counts the losses in a row plus one and bounds its raises (maxSteps), so the message's
// step exceeds it by the ties of the series (steps-parity.test.ts). Under fixed every trade is
// step 1 of the next cycle.
export function sessionTradeSteps(
  results: readonly SessionTradeResult[],
  strategy: SessionStakeStrategy,
): SessionTradeStep[] {
  const steps: SessionTradeStep[] = [];
  let tradesSinceWin = 0;
  let cycle = 0;
  for (const result of results) {
    const step = strategy === SessionStakeStrategy.Martingale ? tradesSinceWin + 1 : 1;
    if (step === 1) cycle += 1;
    steps.push({ cycle, step });
    tradesSinceWin = result === SessionTradeResult.Won ? 0 : tradesSinceWin + 1;
  }
  return steps;
}
