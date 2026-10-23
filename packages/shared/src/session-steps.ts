// A settled trade of a session as its message names it (#464): the class of the broker trade's
// profit, by its sign. No column holds it, so it is a plain const, not a status (Rule 1).
export const SessionTradeResult = { Won: 'won', Lost: 'lost', Tied: 'tied' } as const;
export type SessionTradeResult = (typeof SessionTradeResult)[keyof typeof SessionTradeResult];

// The stake strategies' wire names (#450): settings v2 and v3 carry one, the stake sizer takes it
// (packages/stake/src/codes.ts re-exports it) and settings v1 read as fixed
export const SessionStakeStrategy = { Fixed: 'fixed', Martingale: 'martingale' } as const;
export type SessionStakeStrategy = (typeof SessionStakeStrategy)[keyof typeof SessionStakeStrategy];

export interface SessionTradeStep {
  cycle: number;
  step: number;
}

// The cycle and step of each settled trade of a session, in their order (docs/bot-session.md →
// Trade messages). Under martingale the step is the trade's number within its cycle (#551): a win
// ends the cycle, a loss and a tie both move to the next step. A cycle is the sizer's series
// (readHistory in packages/stake/src/size.ts): only a win closes it. The sizer's own
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

// The cycle and step of the session's open trade (#700): the position the trade takes once it
// settles, whatever it ends with - a trade's position depends only on the results before it, so
// the open block and the result block of one trade print the same «⚡ Цикл N Шаг M».
export function sessionNextStep(
  results: readonly SessionTradeResult[],
  strategy: SessionStakeStrategy,
): SessionTradeStep {
  const next = sessionTradeSteps([...results, SessionTradeResult.Won], strategy).at(-1);
  if (next === undefined) throw new Error('a session has no next step');
  return next;
}

// Where a block of the cycle message carries the adaptive line (#551 → #718): under martingale the
// line stands once per cycle, between steps 1 and 2, printed as soon as it is known - under a lost
// step 1 at once, above step 2 after a tie at step 1 (the tie itself promises no raise); never at
// steps 3 and on, never under fixed (no step 2, no raise). It stays when no step 2 follows (a stop
// before it): the message's text is a function of its blocks alone.
export const AdaptiveLineSlot = { Below: 'below', Above: 'above' } as const;
export type AdaptiveLineSlot = (typeof AdaptiveLineSlot)[keyof typeof AdaptiveLineSlot];

// The slot of each settled trade's block, by the indices of sessionTradeSteps: a step 2 always
// follows step 1 of its own cycle, so the result before it is that step's.
export function sessionAdaptiveLines(
  results: readonly SessionTradeResult[],
  strategy: SessionStakeStrategy,
): (AdaptiveLineSlot | null)[] {
  if (strategy !== SessionStakeStrategy.Martingale) return results.map(() => null);
  return sessionTradeSteps(results, strategy).map(({ step }, i) => {
    if (step === 1 && results[i] === SessionTradeResult.Lost) return AdaptiveLineSlot.Below;
    if (step === 2 && results[i - 1] === SessionTradeResult.Tied) return AdaptiveLineSlot.Above;
    return null;
  });
}

// The slot of the open trade's block (#700): its result is not known, so the slot that does not
// depend on it - above step 2 after a tie, else none; never below.
export function sessionNextAdaptiveLine(
  results: readonly SessionTradeResult[],
  strategy: SessionStakeStrategy,
): AdaptiveLineSlot | null {
  return sessionAdaptiveLines([...results, SessionTradeResult.Won], strategy).at(-1) ?? null;
}
