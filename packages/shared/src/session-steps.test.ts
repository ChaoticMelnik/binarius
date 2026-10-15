import { describe, expect, it } from 'vitest';
import { SessionTradeResult, sessionTradeSteps } from './session-steps';

const { Won: W, Lost: L, Tied: T } = SessionTradeResult;
const pairs = (steps: { cycle: number; step: number }[]) =>
  steps.map(({ cycle, step }) => `${cycle}.${step}`);

describe('sessionTradeSteps', () => {
  it('fixed: every trade is step 1 of the next cycle, whatever it ended with', () => {
    expect(pairs(sessionTradeSteps([L, L, W, T, L], 'fixed'))).toEqual([
      '1.1',
      '2.1',
      '3.1',
      '4.1',
      '5.1',
    ]);
  });

  it('martingale: losses in a row climb the steps of one cycle, a win ends it', () => {
    expect(pairs(sessionTradeSteps([L, L, W, W], 'martingale'))).toEqual([
      '1.1',
      '1.2',
      '1.3',
      '2.1',
    ]);
  });

  it('martingale: a tie at step 2 keeps the next trade at step 2 of the same cycle', () => {
    expect(pairs(sessionTradeSteps([L, T, L, W], 'martingale'))).toEqual([
      '1.1',
      '1.2',
      '1.2',
      '1.3',
    ]);
  });

  it('martingale: a tie at step 1 leaves the next trade at step 1 of a new cycle', () => {
    expect(pairs(sessionTradeSteps([T, W, L], 'martingale'))).toEqual(['1.1', '2.1', '3.1']);
  });

  it('no trades, no steps', () => {
    expect(sessionTradeSteps([], 'martingale')).toEqual([]);
  });
});
