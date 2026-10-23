import { TradeIntentStatus } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { SessionTradeKind } from './codes';
import { sessionTradeOf } from './history';
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
