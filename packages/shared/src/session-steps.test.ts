import { describe, expect, it } from 'vitest';
import {
  AdaptiveLineSlot,
  SessionStakeStrategy,
  SessionTradeResult,
  sessionAdaptiveLines,
  sessionNextAdaptiveLine,
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
// #718: the adaptive line stands once per martingale cycle, between steps 1 and 2 - under a lost
// step 1 at once, above step 2 after a tie - and never under fixed
describe('sessionAdaptiveLines (#718)', () => {
  const { Below: B, Above: A } = AdaptiveLineSlot;
  const histories: SessionTradeResult[][] = [[]];
  for (let length = 1; length <= 6; length += 1) {
    for (const prefix of histories.filter((h) => h.length === length - 1)) {
      for (const result of [W, L, T]) histories.push([...prefix, result]);
    }
  }

  it('AL1 a lost step 1: the line under it at once', () => {
    expect(sessionAdaptiveLines([L], 'martingale')).toEqual([B]);
  });

  it('AL2 a lost step 1, then a tie, a loss and a win: the line under step 1 alone', () => {
    expect(sessionAdaptiveLines([L, T, L, W], 'martingale')).toEqual([B, null, null, null]);
  });

  it('AL3 a tie at step 1: nothing under it, the line above step 2', () => {
    expect(sessionAdaptiveLines([T, L, L, W], 'martingale')).toEqual([null, A, null, null]);
  });

  it('AL4 each cycle its own slot', () => {
    expect(sessionAdaptiveLines([T, T, L], 'martingale')).toEqual([null, A, null]);
    expect(sessionAdaptiveLines([L, W, L], 'martingale')).toEqual([B, null, B]);
  });

  it('AL5 fixed: no line, whatever the trades ended with', () => {
    expect(sessionAdaptiveLines([L, L, T], 'fixed')).toEqual([null, null, null]);
  });

  it('AL6 every history of up to six trades: one line per cycle of two blocks or a lost one, between steps 1 and 2', () => {
    for (const history of histories) {
      expect(sessionAdaptiveLines(history, 'fixed'), history.join('')).toEqual(
        history.map(() => null),
      );
      const slots = sessionAdaptiveLines(history, 'martingale');
      const steps = sessionTradeSteps(history, 'martingale');
      const cycles = new Map<number, number[]>();
      steps.forEach(({ cycle }, i) => cycles.set(cycle, [...(cycles.get(cycle) ?? []), i]));
      for (const indices of cycles.values()) {
        const [first, second] = indices;
        const expected = indices.map(() => null as AdaptiveLineSlot | null);
        if (history[first!] === L) expected[0] = B;
        else if (second !== undefined) expected[1] = A;
        expect(
          indices.map((i) => slots[i]),
          history.join(''),
        ).toEqual(expected);
      }
    }
  });

  it('AL7 the open block: above step 2 after a tie, else none; the result block agrees but for the line a loss puts under step 1', () => {
    expect(sessionNextAdaptiveLine([T], 'martingale')).toBe(A);
    expect(sessionNextAdaptiveLine([L], 'martingale')).toBeNull();
    expect(sessionNextAdaptiveLine([], 'martingale')).toBeNull();
    expect(sessionNextAdaptiveLine([W], 'martingale')).toBeNull();
    expect(sessionNextAdaptiveLine([T], 'fixed')).toBeNull();
    for (const strategy of Object.values(SessionStakeStrategy)) {
      for (const history of histories) {
        const open = sessionNextAdaptiveLine(history, strategy);
        expect(open, history.join('')).not.toBe(B);
        for (const result of [W, T]) {
          expect(
            sessionAdaptiveLines([...history, result], strategy).at(-1),
            history.join(''),
          ).toBe(open);
        }
        const lost = sessionAdaptiveLines([...history, L], strategy).at(-1);
        expect(lost === B ? null : lost, history.join('')).toBe(open);
      }
    }
  });
});

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
