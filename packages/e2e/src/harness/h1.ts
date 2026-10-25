import type { SecondSeries } from '@binarius/backend/e2e';

// The second series of the run (#828, docs/e2e-demo-cycle.md → The price path): every session the
// bot starts is H1's, so the backend's H1 scanner and driver need 1s closes the R1 detector reads
// as a signal on every second. The pump feeds the series only; the mock broker prices the trades
// and the test scripts their outcomes.

const SECOND_MS = 1_000;
// seconds pushed before the run's clock: the R1 window (300 s) and a margin, the series' capacity
export const H1_PUMP_HISTORY_SEC = 320;
const BASE_PRICE = 1.1;
// the convex ramp's curvature: every 3-second move is the largest of the window behind it, far
// above the rounding of a 5-digit pair (h1.test.ts E2E-H1 pins it)
const CURVATURE = 1e-6;
// the clock rule and the next second's tick, as the driver's tick does in production
const PUMP_TICK_MS = 100;

// the price of the pump's second t (t = 0 is its first second), rounded to the pair's digits
export const h1PumpPrice = (t: number, digits: number): number =>
  Number((BASE_PRICE + CURVATURE * t * t).toFixed(digits));

export interface H1Pump {
  stop(): void;
}

export function startH1Pump({
  series,
  assetId,
  digits,
  now = Date.now,
}: {
  series: Pick<SecondSeries, 'push' | 'advance'>;
  assetId: number;
  digits: number;
  now?: () => number;
}): H1Pump {
  // the label of the second holding the clock now; the history ends before it
  const current = Math.ceil(now() / SECOND_MS) * SECOND_MS;
  const first = current - H1_PUMP_HISTORY_SEC * SECOND_MS;
  const priceAt = (label: number) => h1PumpPrice((label - first) / SECOND_MS, digits);
  // one tick inside each second (label - 1000, label], received at once
  const push = (label: number, timestamp: number) =>
    series.push(assetId, digits, { price: priceAt(label), timestamp }, timestamp);
  for (let label = first; label < current; label += SECOND_MS) push(label, label - SECOND_MS / 2);
  let last = current - SECOND_MS;
  const pump = () => {
    const at = now();
    const label = Math.ceil(at / SECOND_MS) * SECOND_MS;
    if (label > last) {
      last = label;
      push(label, at);
    }
    series.advance(at);
  };
  pump();
  const timer = setInterval(pump, PUMP_TICK_MS);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
