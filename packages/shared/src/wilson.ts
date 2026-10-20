const Z95 = 1.959964;

export interface Interval95 {
  low: number;
  high: number;
}

// Wilson score interval, in percent; 0 trials -> the whole range
export function wilson(wins: number, n: number): Interval95 {
  if (n === 0) return { low: 0, high: 100 };
  const p = wins / n;
  const z2 = Z95 * Z95;
  const centre = p + z2 / (2 * n);
  const margin = Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return {
    low: (100 * (centre - margin)) / denominator,
    high: (100 * (centre + margin)) / denominator,
  };
}

export type Verdict = 'beats break-even' | 'inconclusive' | 'below';

// beating break-even needs the whole interval above it; touching it is not enough
export function verdictOf(ci: Interval95, breakEven: number): Verdict {
  if (ci.low > breakEven) return 'beats break-even';
  if (ci.high < breakEven) return 'below';
  return 'inconclusive';
}

export function markdownTable(
  head: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  const line = (cells: readonly (string | number)[]) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}
