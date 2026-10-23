import { TradeIntentStatus } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { SessionTradeKind } from './codes';
import { sessionStakeInput, sessionTradeOf } from './history';
import { d } from './testing';

describe('sessionTradeOf (#775)', () => {
  it('ST1 a rejected intent is a rejected trade', () => {
    expect(
      sessionTradeOf({ status: TradeIntentStatus.Rejected, amount: d('1.00'), profit: null }),
    ).toEqual({ kind: SessionTradeKind.Rejected });
  });

  it('ST2 a settled intent with a profit is a settled trade of its amount and profit', () => {
    expect(
      sessionTradeOf({ status: TradeIntentStatus.Settled, amount: d('2.00'), profit: d('-2.00') }),
    ).toEqual({ kind: SessionTradeKind.Settled, stake: '2.00', profit: '-2.00' });
  });

  it('ST3 a settled intent without a profit and a live intent are unresolved', () => {
    expect(
      sessionTradeOf({ status: TradeIntentStatus.Settled, amount: d('2.00'), profit: null }),
    ).toEqual({ kind: SessionTradeKind.Unresolved });
    expect(
      sessionTradeOf({ status: TradeIntentStatus.Accepted, amount: d('2.00'), profit: null }),
    ).toEqual({ kind: SessionTradeKind.Unresolved });
  });
});

describe('sessionStakeInput (#775)', () => {
  const base = {
    intents: [],
    payout: 92,
    minTradeAmount: d('1.00'),
    available: d('50.00'),
    sessionStartedAtMs: 1_000_000,
  };

  it('ST4 a clock behind started_at is clamped to it, one ahead is kept', () => {
    expect(sessionStakeInput({ ...base, nowMs: 995_000 }).nowMs).toBe(1_000_000);
    expect(sessionStakeInput({ ...base, nowMs: 1_005_000 }).nowMs).toBe(1_005_000);
  });

  it('ST5 maps the intents in order and passes payout, minimum and available through', () => {
    expect(
      sessionStakeInput({
        ...base,
        nowMs: 1_005_000,
        intents: [
          { status: TradeIntentStatus.Rejected, amount: d('1.00'), profit: null },
          { status: TradeIntentStatus.Settled, amount: d('1.00'), profit: d('-1.00') },
          { status: TradeIntentStatus.Accepted, amount: d('2.00'), profit: null },
        ],
      }),
    ).toEqual({
      history: [
        { kind: SessionTradeKind.Rejected },
        { kind: SessionTradeKind.Settled, stake: '1.00', profit: '-1.00' },
        { kind: SessionTradeKind.Unresolved },
      ],
      payout: 92,
      minTradeAmount: '1.00',
      available: '50.00',
      sessionStartedAtMs: 1_000_000,
      nowMs: 1_005_000,
    });
  });
});
