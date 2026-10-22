import { describe, expect, it } from 'vitest';
import {
  SessionStakeStrategy,
  SessionTradeResult,
  sessionNextStep,
  sessionTradeSteps,
} from './session-steps';
import { safeParseTradingSessionSettings, sessionProgress } from './trading-session';

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

  it('martingale: a tie is the next step of the same cycle (#551)', () => {
    expect(pairs(sessionTradeSteps([L, T, L, W], 'martingale'))).toEqual([
      '1.1',
      '1.2',
      '1.3',
      '1.4',
    ]);
  });

  it('martingale: a tie at step 1 leaves the cycle open, only a win closes it (#551)', () => {
    expect(pairs(sessionTradeSteps([T, W, L], 'martingale'))).toEqual(['1.1', '1.2', '2.1']);
  });

  it('no trades, no steps', () => {
    expect(sessionTradeSteps([], 'martingale')).toEqual([]);
  });
});

// #700: the open trade's block prints the position its result block will print, whatever the
// trade ends with, over every history of up to six trades under both strategies
describe('sessionNextStep (#700)', () => {
  const histories: SessionTradeResult[][] = [[]];
  for (let length = 1; length <= 6; length += 1) {
    for (const prefix of histories.filter((h) => h.length === length - 1)) {
      for (const result of [W, L, T]) histories.push([...prefix, result]);
    }
  }

  it.each(Object.values(SessionStakeStrategy))(
    '%s: the open trade takes the position it settles at, on any result',
    (strategy) => {
      for (const history of histories) {
        const open = sessionNextStep(history, strategy);
        for (const result of [W, L, T]) {
          expect(
            sessionTradeSteps([...history, result], strategy).at(-1),
            history.join(''),
          ).toEqual(open);
        }
      }
    },
  );

  it('martingale: after a win a new cycle, after a loss or a tie the next step', () => {
    expect(sessionNextStep([L, W], 'martingale')).toEqual({ cycle: 2, step: 1 });
    expect(sessionNextStep([L, T], 'martingale')).toEqual({ cycle: 1, step: 3 });
    expect(sessionNextStep([], 'martingale')).toEqual({ cycle: 1, step: 1 });
    expect(sessionNextStep([L, L], 'fixed')).toEqual({ cycle: 3, step: 1 });
  });
});

// #552: the session's closed cycles (sessionProgress, what ends it) are the cycles the messages
// number (sessionTradeSteps) whose last trade is a win, or every cycle under fixed: one boundary
describe('sessionProgress against sessionTradeSteps (#552)', () => {
  const histories: SessionTradeResult[][] = [[]];
  for (let length = 1; length <= 6; length += 1) {
    for (const prefix of histories.filter((h) => h.length === length - 1)) {
      for (const result of [W, L, T]) histories.push([...prefix, result]);
    }
  }
  const settingsOf = (strategy: SessionStakeStrategy) => {
    const parsed = safeParseTradingSessionSettings({
      version: 3,
      assetId: 1,
      durationSec: 5,
      cycles: 20,
      stake:
        strategy === SessionStakeStrategy.Martingale
          ? {
              strategy,
              baseStake: '1',
              stakeScale: 0,
              limits: {
                maxSteps: 4,
                maxStake: '12',
                maxSessionLoss: '20',
                maxSessionDurationMs: 1,
              },
            }
          : { strategy, baseStake: '1', stakeScale: 0 },
    });
    if (!parsed.success) throw new Error('fixture settings do not parse');
    return parsed.data;
  };

  it.each([SessionStakeStrategy.Martingale, SessionStakeStrategy.Fixed])(
    '%s: every history of up to six trades',
    (strategy) => {
      const settings = settingsOf(strategy);
      expect(histories).toHaveLength(1 + 3 + 9 + 27 + 81 + 243 + 729);
      for (const history of histories) {
        const steps = sessionTradeSteps(history, strategy);
        const lastOfCycle = new Map<number, SessionTradeResult>();
        steps.forEach(({ cycle }, i) => lastOfCycle.set(cycle, history[i]!));
        const closed = [...lastOfCycle.values()].filter(
          (result) => strategy === SessionStakeStrategy.Fixed || result === W,
        ).length;
        const done = sessionProgress(settings, {
          settled: history.length,
          won: history.filter((result) => result === W).length,
        }).done;
        expect({ history, done }).toEqual({ history, done: closed });
      }
    },
  );
});
