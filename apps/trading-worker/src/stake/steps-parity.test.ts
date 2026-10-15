import { describe, expect, it } from 'vitest';
import { SessionTradeResult, sessionTradeSteps } from '@binarius/shared';
import { createStakeSizer, type SessionTrade } from './size';
import { input, loss, martingale, tie, win } from './testing';

// The cycle and step a session's trade message prints (#464, packages/shared/src/session-steps.ts)
// against the sizer that sizes the trade: for every history of up to six settled trades, the step
// the sizer gives the next trade is the step the message gives it, under either strategy.

const { Won: W, Lost: L, Tied: T } = SessionTradeResult;
const TRADES: Record<SessionTradeResult, SessionTrade> = {
  [W]: win('1.00', '0.85'),
  [L]: loss('1.00'),
  [T]: tie('1.00'),
};

function histories(length: number): SessionTradeResult[][] {
  if (length === 0) return [[]];
  return histories(length - 1).flatMap((history) => [W, L, T].map((next) => [...history, next]));
}
const ALL = [0, 1, 2, 3, 4, 5, 6].flatMap(histories);

describe('the steps of the trade messages and the sizer (#464)', () => {
  it('covers every history of up to six trades', () => {
    expect(ALL).toHaveLength(1 + 3 + 9 + 27 + 81 + 243 + 729);
  });

  it.each([
    ['fixed', createStakeSizer()],
    ['martingale', createStakeSizer(martingale({ maxSteps: 10 }))],
  ] as const)('%s: the next trade gets the sizer’s step', (strategy, sizer) => {
    for (const history of ALL) {
      const decision = sizer.next(input({ history: history.map((result) => TRADES[result]) }));
      if (!('features' in decision) || decision.features === undefined) {
        throw new Error(`no features for ${history.join(',')}`);
      }
      const message = sessionTradeSteps([...history, W], strategy).at(-1)!;
      expect(message.step, history.join(',')).toBe(decision.features.step);
    }
  });
});
