import { SignalKind, tradeOutcomeOf, type Candle } from '@binarius/shared';
import type { H1Detector } from '@binarius/signal';
import { StandError } from './cache';
import { PRICE_STEP_MS } from './config';
import type { SimTrade } from './simulate';

export interface SecondCloses {
  // the timestamp of closes[0]
  first: number;
  // NaN where the chart has no row
  closes: Float64Array;
}

// undefined for an empty series
export function closesBySecond(rows: readonly Candle[]): SecondCloses | undefined {
  const first = rows[0]?.timestamp;
  if (first === undefined) return undefined;
  const last = rows[rows.length - 1].timestamp;
  const closes = new Float64Array((last - first) / PRICE_STEP_MS + 1).fill(NaN);
  for (const row of rows) {
    if ((row.timestamp - first) % PRICE_STEP_MS !== 0) {
      throw new StandError(`h1: the 1s row at ${row.timestamp} is not on a whole second`);
    }
    closes[(row.timestamp - first) / PRICE_STEP_MS] = row.close;
  }
  return { first, closes };
}

export interface H1Plan {
  entryDelaySec: number;
  expirySec: number;
}

export interface H1Simulation {
  decisions: number;
  trades: SimTrade[];
  // no_signal decisions by reason
  refusals: Record<string, number>;
}

// The backtest script's cadence (docs/signal-stand.md -> H1): a decision every second from the
// first full window; a signal at f opens at f + g, closes at f + g + H, and the next decision is
// at f + g + H + 1, so one trade at a time per pair.
export function simulateH1(
  { first, closes }: SecondCloses,
  detector: H1Detector,
  { entryDelaySec: g, expirySec: H }: H1Plan,
): H1Simulation {
  const trades: SimTrade[] = [];
  const refusals: Record<string, number> = {};
  let decisions = 0;
  let f = detector.params.sdWindowSec;
  while (f + g + H < closes.length) {
    const decision = detector.decide({ closes, at: f });
    decisions++;
    if (decision.kind === SignalKind.NoSignal) {
      refusals[decision.reason] = (refusals[decision.reason] ?? 0) + 1;
      f += 1;
      continue;
    }
    const entry = closes[f + g];
    const exit = closes[f + g + H];
    trades.push({
      decidedAt: first + f * PRICE_STEP_MS,
      action: decision.action,
      entryAt: first + (f + g) * PRICE_STEP_MS,
      exitAt: first + (f + g + H) * PRICE_STEP_MS,
      outcome:
        Number.isNaN(entry) || Number.isNaN(exit)
          ? 'unpriced'
          : tradeOutcomeOf(decision.action, entry, exit),
    });
    f = f + g + H + 1;
  }
  return { decisions, trades, refusals };
}
