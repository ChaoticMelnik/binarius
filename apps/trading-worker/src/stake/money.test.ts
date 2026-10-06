import { tradeAmountSchema } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  ceilToScale,
  divCeil,
  expectedProfit,
  floorToScale,
  formatAmount,
  formatStake,
  parseAmount,
  parsePayout,
} from './money';

const amount = (text: string): bigint => {
  const value = parseAmount(text);
  if (value === undefined) throw new RangeError(`test amount out of domain: ${text}`);
  return value;
};

const payout = (value: number): bigint => {
  const scaled = parsePayout(value);
  if (scaled === undefined) throw new RangeError(`test payout refused: ${value}`);
  return scaled;
};

// The mock broker's profit rule (packages/mock-broker/src/money.ts -> percentOf, applied to cents in
// state.ts), restated: the trading worker does not depend on the fixture package. Basis points
// come from Math.round(percent * 100), so the rule is exact only for payouts with <= 2 decimals.
const fixtureProfitCents = (cents: bigint, percent: number): bigint =>
  (cents * BigInt(Math.round(percent * 100))) / 10_000n;

describe('stake money: parseAmount', () => {
  it('M1 accepts 12 integer and 8 fractional digits and refuses 13 and 9, as tradeAmountSchema does', () => {
    const cases: [string, boolean][] = [
      ['999999999999.99999999', true],
      ['1.5', true],
      ['0.00000001', true],
      ['1000000000000', false],
      ['1.123456789', false],
    ];
    for (const [text, inDomain] of cases) {
      expect(parseAmount(text) !== undefined, text).toBe(inDomain);
      expect(tradeAmountSchema.safeParse(text).success, text).toBe(inDomain);
    }
    expect(parseAmount('999999999999.99999999')).toBe(99999999999999999999n);
  });

  it('M2 keeps the sign and refuses what is not plain decimal text, without rounding', () => {
    expect(parseAmount('-1.5')).toBe(-150000000n);
    expect(parseAmount('-0')).toBe(0n);
    for (const text of ['1.', '.5', '1e3', 'NaN', 'Infinity', '', ' 1', '+1', '1,5']) {
      expect(parseAmount(text), text).toBeUndefined();
    }
  });
});

describe('stake money: formatting', () => {
  it('M3 formatAmount writes the canonical form', () => {
    expect(formatAmount(150000000n)).toBe('1.5');
    expect(formatAmount(100000000n)).toBe('1');
    expect(formatAmount(0n)).toBe('0');
    expect(formatAmount(-218000000n)).toBe('-2.18');
    expect(formatAmount(1n)).toBe('0.00000001');
  });

  it('M4 formatStake writes exactly `scale` fractional digits and the result is a trade amount', () => {
    expect(formatStake(218000000n, 2)).toBe('2.18');
    expect(formatStake(100000000n, 2)).toBe('1.00');
    expect(formatStake(100000000n, 0)).toBe('1');
    expect(formatStake(100000000n, 8)).toBe('1.00000000');
    for (const [value, scale] of [
      [218000000n, 2],
      [100000000n, 0],
      [99999999999999999999n, 8],
    ] as const) {
      expect(tradeAmountSchema.safeParse(formatStake(value, scale)).success).toBe(true);
    }
    expect(() => formatStake(218000001n, 2)).toThrow(RangeError);
    expect(() => formatStake(-100000000n, 2)).toThrow(RangeError);
  });
});

describe('stake money: rounding', () => {
  it('M5 ceil and floor leave a multiple alone, round the rest and refuse a negative value', () => {
    expect(ceilToScale(218000000n, 2)).toBe(218000000n);
    expect(floorToScale(218000000n, 2)).toBe(218000000n);
    expect(ceilToScale(185000001n, 2)).toBe(186000000n);
    expect(floorToScale(185999999n, 2)).toBe(185000000n);
    expect(ceilToScale(1n, 0)).toBe(100000000n);
    expect(ceilToScale(1n, 8)).toBe(1n);
    expect(() => ceilToScale(-1n, 2)).toThrow(RangeError);
    expect(() => floorToScale(-1n, 2)).toThrow(RangeError);
    expect(() => ceilToScale(1n, 9)).toThrow(RangeError);
  });

  it('M6 divCeil rounds up and refuses a non-positive divisor', () => {
    expect(divCeil(7n, 2n)).toBe(4n);
    expect(divCeil(8n, 2n)).toBe(4n);
    expect(divCeil(0n, 3n)).toBe(0n);
    expect(() => divCeil(1n, 0n)).toThrow(RangeError);
  });
});

describe('stake money: parsePayout', () => {
  it('M7 turns a plain percentage into scale 4 and refuses the rest', () => {
    expect(parsePayout(85)).toBe(850000n);
    expect(parsePayout(85.5)).toBe(855000n);
    expect(parsePayout(82.5)).toBe(825000n);
    expect(parsePayout(0.5)).toBe(5000n);
    expect(parsePayout(9999.9999)).toBe(99999999n);
    for (const value of [0, -1, 1e-7, 12345, 1.23456, Number.NaN, Infinity, -Infinity]) {
      expect(parsePayout(value), String(value)).toBeUndefined();
    }
  });
});

describe('stake money: expectedProfit', () => {
  it('M8 equals the mock broker rule on payouts with at most 2 decimals', () => {
    for (const p of [0.5, 7.5, 82.5, 85, 85.5, 99.99, 100]) {
      for (const stake of ['1.00', '2.18', '100.00', '12345.67']) {
        const cents = amount(stake) / 1_000_000n;
        expect(expectedProfit(amount(stake), payout(p), 2), `${stake} at ${p}`).toBe(
          fixtureProfitCents(cents, p) * 1_000_000n,
        );
      }
    }
  });

  it('M9 keeps 3-4 payout decimals the fixture rounds to basis points', () => {
    // percentOf would give 218 and 3333: it rounds 9999.9999 to 10000.00 and 33.3333 to 33.33
    expect(formatAmount(expectedProfit(amount('2.18'), payout(9999.9999), 2))).toBe('217.99');
    expect(formatAmount(expectedProfit(amount('10000.00'), payout(33.3333), 2))).toBe('3333.33');
    expect(formatAmount(expectedProfit(amount('2.18'), payout(33.3333), 2))).toBe('0.72');
    expect(fixtureProfitCents(218n, 9999.9999)).toBe(21800n);
    expect(fixtureProfitCents(1_000_000n, 33.3333)).toBe(333300n);
  });
});
