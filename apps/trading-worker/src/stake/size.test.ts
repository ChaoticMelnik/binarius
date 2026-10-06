import { tradeAmountSchema } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { StakeStrategy } from './codes';
import type { StakeParams } from './config';
import { ceilToScale, expectedProfit, parseAmount, parsePayout } from './money';
import { createStakeSizer, type SessionTrade, type StakeDecision } from './size';
import { d, input, loss, martingale, rejected, START_MS, tie, unresolved, win } from './testing';

const amount = (text: string): bigint => {
  const value = parseAmount(text);
  if (value === undefined) throw new RangeError(`test amount out of domain: ${text}`);
  return value;
};

const stakeOf = (decision: StakeDecision): string => {
  if (decision.kind !== 'stake') {
    throw new Error(`expected a stake, got ${JSON.stringify(decision)}`);
  }
  return decision.amount;
};

// the stakes of consecutive losses: each step's history holds the losses of the stakes before it
function series(params: StakeParams, payout: number, steps: number): string[] {
  const sizer = createStakeSizer(params);
  const history: SessionTrade[] = [];
  const stakes: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const stake = stakeOf(sizer.next(input({ history, payout })));
    stakes.push(stake);
    history.push(loss(stake));
  }
  return stakes;
}

const WIDE = { maxStake: d('999999999999.99'), maxSessionLoss: d('999999999999.99') };

describe('stake sizer: fixed', () => {
  it('S0 an empty history gives the base stake at step 1; fixed does not read the payout', () => {
    const sizer = createStakeSizer();
    const decision = sizer.next(input());
    expect(decision).toEqual({
      kind: 'stake',
      version: 'v1',
      amount: '1.00',
      features: {
        strategy: 'fixed',
        step: 1,
        consecutiveLosses: 0,
        streakLoss: '0',
        realizedSessionLoss: '0',
        settledTrades: 0,
        sessionElapsedMs: 1000,
        baseStake: '1.00',
      },
    });
    expect(stakeOf(sizer.next(input({ payout: Number.NaN })))).toBe('1.00');
    expect(stakeOf(sizer.next(input({ payout: 0, history: [loss('1.00')] })))).toBe('1.00');
  });

  it('S16 fixed keeps the base stake after ten losses and reads no martingale limit', () => {
    const history = Array.from({ length: 10 }, () => loss('1.00'));
    const decision = createStakeSizer().next(
      input({ history, nowMs: START_MS + 365 * 86_400_000 }),
    );
    expect(stakeOf(decision)).toBe('1.00');
    expect(decision.kind === 'stake' && decision.features).toMatchObject({
      strategy: 'fixed',
      step: 1,
      consecutiveLosses: 10,
      realizedSessionLoss: '10',
    });
  });
});

describe('stake sizer: the martingale step', () => {
  it('S1 pins the series of consecutive losses', () => {
    expect(series(martingale(), 85, 5)).toEqual(['1.00', '2.18', '4.75', '10.33', '22.49']);
    expect(series(martingale(), 100, 4)).toEqual(['1.00', '2.00', '4.00', '8.00']);
    expect(series(martingale(), 82.5, 3)).toEqual(['1.00', '2.21', '4.89']);
    expect(series(martingale(WIDE), 7.5, 3)).toEqual(['1.00', '14.27', '204.54']);
    const capped = createStakeSizer(martingale()).next(
      input({ payout: 7.5, history: [loss('1.00'), loss('14.27')] }),
    );
    expect(capped).toMatchObject({
      kind: 'stop',
      reason: 'max_stake_exceeded',
      detail: { amount: '204.54', maxStake: '100.00' },
    });
  });

  it('S2 the stake is the smallest on the grid whose profit covers the target', () => {
    const sizer = createStakeSizer(martingale(WIDE));
    const base = amount('1.00');
    const cent = 10n ** 6n;
    const payouts = [0.5, 1, 7.5, 33.3333, 50, 82.5, 85, 99.99, 100, 150, 9999.9999];
    const losses = ['0.01', '0.37', '1', '1.5', '2.18', '7.93', '12345.67', '0.00000001'];
    let cells = 0;
    for (const p of payouts) {
      const scaled = parsePayout(p);
      if (scaled === undefined) throw new RangeError(`test payout refused: ${p}`);
      for (const l of [...losses, '4900000000.00']) {
        const decision = sizer.next(
          input({
            payout: p,
            history: [loss(l)],
            minTradeAmount: d('0.01'),
            available: d('999999999999.99'),
          }),
        );
        const stake = amount(stakeOf(decision));
        const floor = amount(l) + expectedProfit(base, scaled, 2);
        const target = ceilToScale(floor, 2);
        const at = `loss ${l} at payout ${p}: stake ${stake}`;
        expect(target >= floor, at).toBe(true);
        expect(expectedProfit(stake, scaled, 2) >= target, at).toBe(true);
        expect(expectedProfit(stake - cent, scaled, 2) < target, at).toBe(true);
        cells += 1;
      }
    }
    expect(cells).toBe(99);
  });

  it('S3 a streak loss with 8 decimals is rounded up into the target', () => {
    const decision = createStakeSizer(martingale()).next(input({ history: [loss('1.00000001')] }));
    expect(stakeOf(decision)).toBe('2.19');
    expect(decision.kind === 'stake' && decision.features.streakLoss).toBe('1.00000001');
  });

  it('S4 a tie repeats the stake: step and streak loss do not change', () => {
    const decision = createStakeSizer(martingale()).next(
      input({ history: [loss('1.00'), tie('2.18')] }),
    );
    expect(stakeOf(decision)).toBe('2.18');
    expect(decision.kind === 'stake' && decision.features).toMatchObject({
      step: 2,
      consecutiveLosses: 1,
      streakLoss: '1',
      settledTrades: 2,
    });
  });

  it('S5 a rejected order does not touch the streak', () => {
    const decision = createStakeSizer(martingale()).next(
      input({ history: [loss('1.00'), rejected()] }),
    );
    expect(stakeOf(decision)).toBe('2.18');
    expect(decision.kind === 'stake' && decision.features.settledTrades).toBe(1);
  });

  it('S6 a win ends the streak; the session loss counts every settled trade', () => {
    const decision = createStakeSizer(martingale()).next(
      input({ history: [loss('1.00'), loss('2.18'), win('4.75', '4.03'), loss('1.00')] }),
    );
    expect(stakeOf(decision)).toBe('2.18');
    expect(decision.kind === 'stake' && decision.features).toMatchObject({
      step: 2,
      consecutiveLosses: 1,
      streakLoss: '1',
      realizedSessionLoss: '0.15',
      settledTrades: 4,
    });
  });

  it('S7 a win smaller than the streak loss still resets the series', () => {
    const decision = createStakeSizer(martingale()).next(
      input({ history: [loss('1.00'), loss('2.18'), win('4.75', '1.00')] }),
    );
    expect(stakeOf(decision)).toBe('1.00');
    expect(decision.kind === 'stake' && decision.features).toMatchObject({
      step: 1,
      consecutiveLosses: 0,
      streakLoss: '0',
      realizedSessionLoss: '2.18',
    });
  });

  it('S8 a session in profit has a realized loss of 0, never negative', () => {
    const decision = createStakeSizer(martingale()).next(input({ history: [win('1.00', '0.85')] }));
    expect(decision.kind === 'stake' && decision.features.realizedSessionLoss).toBe('0');
  });
});

describe('stake sizer: data stops', () => {
  it('S9 an unresolved trade at any index stops both strategies', () => {
    const history = [unresolved(), win('1.00', '0.85')];
    for (const params of [martingale(), undefined]) {
      expect(createStakeSizer(params).next(input({ history }))).toEqual({
        kind: 'stop',
        version: 'v1',
        reason: 'unresolved_trade',
        detail: { index: 0 },
      });
    }
  });

  it('S10 a history amount outside the domain stops with the field and index', () => {
    const badProfit: SessionTrade = {
      kind: 'settled',
      stake: d('1.00'),
      profit: d('-0.123456789'),
    };
    expect(
      createStakeSizer(martingale()).next(input({ history: [loss('1.00'), badProfit] })),
    ).toEqual({
      kind: 'stop',
      version: 'v1',
      reason: 'invalid_amount',
      detail: { field: 'history.profit', index: 1 },
    });
    const badStake: SessionTrade = { kind: 'settled', stake: d('1000000000000'), profit: d('0') };
    expect(createStakeSizer().next(input({ history: [badStake] }))).toMatchObject({
      reason: 'invalid_amount',
      detail: { field: 'history.stake', index: 0 },
    });
  });

  it('S11 a loss above the stake and a non-positive stake are invalid trades', () => {
    const tooLarge: SessionTrade = { kind: 'settled', stake: d('1.00'), profit: d('-1.01') };
    expect(createStakeSizer().next(input({ history: [tooLarge] }))).toEqual({
      kind: 'stop',
      version: 'v1',
      reason: 'invalid_trade',
      detail: { index: 0, problem: 'loss_exceeds_stake' },
    });
    const zero: SessionTrade = { kind: 'settled', stake: d('0'), profit: d('0') };
    expect(createStakeSizer().next(input({ history: [zero] }))).toMatchObject({
      reason: 'invalid_trade',
      detail: { index: 0, problem: 'non_positive_stake' },
    });
  });

  it('S12 a balance amount outside the domain or negative stops with its field', () => {
    expect(createStakeSizer().next(input({ available: d('1000000000000.00') }))).toEqual({
      kind: 'stop',
      version: 'v1',
      reason: 'invalid_amount',
      detail: { field: 'available' },
    });
    expect(createStakeSizer().next(input({ minTradeAmount: d('-1') }))).toMatchObject({
      reason: 'invalid_amount',
      detail: { field: 'minTradeAmount' },
    });
  });

  it('S15 an unusable payout stops martingale on step 1 and on step 2', () => {
    const sizer = createStakeSizer(martingale());
    expect(sizer.next(input({ payout: 0 }))).toEqual({
      kind: 'stop',
      version: 'v1',
      reason: 'invalid_payout',
      detail: { payout: '0' },
    });
    expect(sizer.next(input({ payout: 1.23456, history: [loss('1.00')] }))).toMatchObject({
      reason: 'invalid_payout',
      detail: { payout: '1.23456' },
    });
  });
});

describe('stake sizer: limits', () => {
  const THREE_LOSSES = [loss('1.00'), loss('2.18'), loss('4.75')];

  it('S13 the first violated check in the fixed order is the reason', () => {
    const durationAndSteps = createStakeSizer(martingale({ maxSteps: 2 })).next(
      input({ history: [loss('1.00'), loss('2.18')], nowMs: START_MS + 3_600_001 }),
    );
    expect(durationAndSteps).toMatchObject({
      reason: 'session_duration_exceeded',
      detail: { sessionElapsedMs: 3_600_001, maxSessionDurationMs: 3_600_000 },
    });
    const stakeAndLoss = createStakeSizer(
      martingale({ maxStake: d('10.00'), maxSessionLoss: d('10.00') }),
    ).next(input({ history: THREE_LOSSES }));
    expect(stakeAndLoss).toMatchObject({
      reason: 'max_stake_exceeded',
      detail: { amount: '10.33', maxStake: '10.00' },
    });
    const minAndAvailable = createStakeSizer(martingale()).next(
      input({ minTradeAmount: d('1.50'), available: d('0.50') }),
    );
    expect(minAndAvailable).toMatchObject({
      reason: 'below_min_trade_amount',
      detail: { amount: '1', minTradeAmount: '1.50' },
    });
    const preCheck = createStakeSizer(martingale({ maxSteps: 4, maxSessionLoss: d('10.00') })).next(
      input({ history: THREE_LOSSES }),
    );
    expect(preCheck).toMatchObject({
      reason: 'max_session_loss_exceeded',
      features: { step: 4 },
      detail: { amount: '10.33', realizedSessionLoss: '7.93', maxSessionLoss: '10.00' },
    });
  });

  it('S13b steps before stake, and available after min', () => {
    const stepsAndStake = createStakeSizer(martingale({ maxSteps: 3, maxStake: d('10.00') })).next(
      input({ history: THREE_LOSSES }),
    );
    expect(stepsAndStake).toMatchObject({
      reason: 'max_steps_exceeded',
      detail: { step: 4, maxSteps: 3 },
    });
    const available = createStakeSizer().next(input({ available: d('0.99') }));
    expect(available).toMatchObject({
      reason: 'insufficient_balance',
      detail: { amount: '1', available: '0.99' },
    });
  });

  it('S14 every bound is inclusive', () => {
    const afterOne = { history: [loss('1.00')] };
    const cases: [string, StakeParams, Parameters<typeof input>[0]][] = [
      ['elapsed == max', martingale(), { nowMs: START_MS + 3_600_000 }],
      ['step == maxSteps', martingale({ maxSteps: 2 }), afterOne],
      ['stake == maxStake', martingale({ maxStake: d('2.18') }), afterOne],
      ['realized + stake == maxSessionLoss', martingale({ maxSessionLoss: d('3.18') }), afterOne],
      ['stake == min', martingale(), { ...afterOne, minTradeAmount: d('2.18') }],
      ['stake == available', martingale(), { ...afterOne, available: d('2.18') }],
    ];
    for (const [name, params, patch] of cases) {
      expect(createStakeSizer(params).next(input(patch)).kind, name).toBe('stake');
    }
  });

  it('S21 a candidate outside the amount domain is stopped by maxStake, never formatted', () => {
    const decision = createStakeSizer(martingale(WIDE)).next(
      input({
        payout: 0.5,
        history: [loss('5000000000.00')],
        minTradeAmount: d('0.01'),
        available: d('999999999999.99'),
      }),
    );
    expect(decision).toMatchObject({
      kind: 'stop',
      reason: 'max_stake_exceeded',
      detail: { amount: '1000000000000', maxStake: '999999999999.99' },
    });
  });

  // the session stop-loss reads the realized loss, not the streak; the balance check reads the
  // candidate, not the base: each history makes the two operands differ
  it('S22a a win inside the session: the realized loss stops it although the streak is 0', () => {
    const decision = createStakeSizer(martingale({ maxSessionLoss: d('3.00') })).next(
      input({ history: [loss('1.00'), loss('2.18'), win('4.75', '1.00')] }),
    );
    expect(decision).toMatchObject({
      kind: 'stop',
      reason: 'max_session_loss_exceeded',
      features: { step: 1, streakLoss: '0', realizedSessionLoss: '2.18' },
      detail: { amount: '1', realizedSessionLoss: '2.18', maxSessionLoss: '3.00' },
    });
  });

  it('S22b a realized loss below the streak lets a stake through that the streak would stop', () => {
    const decision = createStakeSizer(martingale({ maxSessionLoss: d('2.34') })).next(
      input({ history: [loss('1.00'), loss('2.18'), win('4.75', '4.03'), loss('1.00')] }),
    );
    expect(stakeOf(decision)).toBe('2.18');
    expect(decision.kind === 'stake' && decision.features).toMatchObject({
      step: 2,
      streakLoss: '1',
      realizedSessionLoss: '0.15',
    });
  });

  it('S22c the balance check reads the candidate of step 2, not the base stake', () => {
    const decision = createStakeSizer(martingale()).next(
      input({ history: [loss('1.00')], available: d('2.17') }),
    );
    expect(decision).toMatchObject({
      kind: 'stop',
      reason: 'insufficient_balance',
      detail: { amount: '2.18', available: '2.17' },
    });
  });
});

describe('stake sizer: contract', () => {
  it('S17 a clock going backwards or not finite throws', () => {
    const sizer = createStakeSizer();
    expect(() => sizer.next(input({ nowMs: START_MS - 1 }))).toThrow(RangeError);
    expect(() => sizer.next(input({ nowMs: Number.NaN }))).toThrow(RangeError);
    expect(() => sizer.next(input({ sessionStartedAtMs: -1, nowMs: 0 }))).toThrow(RangeError);
  });

  it('S18 every decision survives JSON unchanged and has no undefined value', () => {
    const hasUndefined = (value: unknown): boolean =>
      value === undefined ||
      (typeof value === 'object' && value !== null && Object.values(value).some(hasUndefined));
    const decisions = [
      createStakeSizer(martingale()).next(input({ history: [loss('1.00')] })),
      createStakeSizer(martingale({ maxSessionLoss: d('3.00') })).next(
        input({ history: [loss('1.00')] }),
      ),
      createStakeSizer(martingale()).next(input({ payout: Number.NaN })),
      createStakeSizer().next(input({ history: [unresolved()] })),
      createStakeSizer().next(input({ available: d('-1') })),
    ];
    expect(decisions.map((decision) => decision.kind)).toEqual([
      'stake',
      'stop',
      'stop',
      'stop',
      'stop',
    ]);
    for (const decision of decisions) {
      expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
      expect(hasUndefined(decision)).toBe(false);
    }
  });

  it('S19 sizer.params is a frozen copy: the caller mutating its object changes nothing', () => {
    const params = martingale();
    const sizer = createStakeSizer(params);
    if (params.strategy !== StakeStrategy.Martingale) throw new Error('fixture');
    params.baseStake = d('5.00');
    params.limits.maxSteps = 2;
    expect(sizer.params).toMatchObject({ baseStake: '1.00', limits: { maxSteps: 5 } });
    expect(Object.isFrozen(sizer.params)).toBe(true);
    expect(
      sizer.params.strategy === StakeStrategy.Martingale && Object.isFrozen(sizer.params.limits),
    ).toBe(true);
    const history = [loss('1.00'), loss('2.18'), loss('4.75')];
    expect(stakeOf(sizer.next(input({ history })))).toBe('10.33');
  });

  it('S20 the amount is a trade amount with exactly stakeScale decimals', () => {
    const at2 = stakeOf(createStakeSizer(martingale()).next(input({ history: [loss('1.00')] })));
    const at0 = stakeOf(
      createStakeSizer(martingale({}, '1', 0)).next(
        input({ history: [loss('1')], minTradeAmount: d('1') }),
      ),
    );
    const base0 = stakeOf(createStakeSizer(martingale({}, '1', 0)).next(input()));
    const at8 = stakeOf(createStakeSizer(martingale({}, '1', 8)).next(input()));
    expect([at2, at0, base0, at8]).toEqual(['2.18', '2', '1', '1.00000000']);
    for (const value of [at2, at0, base0, at8]) {
      expect(tradeAmountSchema.safeParse(value).success, value).toBe(true);
    }
  });
});
