import { describe, expect, it } from 'vitest';
import { markdownTable, verdictOf, wilson } from './wilson';

const round = ({ low, high }: { low: number; high: number }) => [
  Number(low.toFixed(1)),
  Number(high.toFixed(1)),
];

describe('wilson', () => {
  it('W1 the Wilson interval matches the reference values', () => {
    expect(round(wilson(8, 30))).toEqual([14.2, 44.4]);
    expect(round(wilson(0, 10))).toEqual([0, 27.8]);
    expect(round(wilson(180, 300))).toEqual([54.4, 65.4]);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 100 });
  });

  it('W2 the verdict at the boundaries', () => {
    expect(verdictOf({ low: 55.6, high: 60 }, 55.6)).toBe('inconclusive');
    expect(verdictOf({ low: 55.7, high: 60 }, 55.6)).toBe('beats break-even');
    expect(verdictOf({ low: 40, high: 55.5 }, 55.6)).toBe('below');
    expect(verdictOf({ low: 40, high: 55.6 }, 55.6)).toBe('inconclusive');
  });

  it('W3 a markdown table: the head, the separator, the rows with their cells as given', () => {
    expect(
      markdownTable(
        ['a', 'b'],
        [
          [1, 'x'],
          [2.5, '-'],
        ],
      ),
    ).toBe(['| a | b |', '| --- | --- |', '| 1 | x |', '| 2.5 | - |'].join('\n'));
    expect(markdownTable(['only'], [])).toBe('| only |\n| --- |');
  });
});
