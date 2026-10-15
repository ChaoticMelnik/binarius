import { TradeAction } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { DECISION_SLACK_MS, SETTLE_TICK_MS } from './config';
import type { PriceAt } from './price';
import { PAUSE_REFUSAL, simulate, type Market, type SimConfig } from './simulate';
import { T0 } from './testing';
import type { Variant } from './variants';

const STEP = 5_000;
const { Up, Down } = TradeAction;
const FIRST = Math.ceil((T0 + 1) / STEP) * STEP + DECISION_SLACK_MS;

// answers a script by call order (undefined = no signal), then no signal; records each nowMs
function scripted(script: readonly (TradeAction | undefined)[], seen: number[] = []): Variant {
  let i = 0;
  return {
    name: 'scripted',
    intervals: ['5s', '1m'],
    grid: [{}],
    headlinePause: true,
    decide({ nowMs }) {
      seen.push(nowMs);
      const action = script[i++];
      return action === undefined ? { refusal: 'none' } : { action };
    },
  };
}

// trade k is priced [entry, exit] = prices[k]; undefined leaves it unpriced
function scriptedPrices(prices: readonly ([number, number] | undefined)[]): PriceAt {
  const at = new Map<number, number | undefined>();
  let calls = 0;
  return (ms) => {
    if (!at.has(ms)) {
      at.set(ms, prices[Math.floor(calls / 2)]?.[calls % 2]);
      calls++;
    }
    return at.get(ms);
  };
}
const LOSS_UP: [number, number] = [2, 1];
const WIN_UP: [number, number] = [1, 2];
const TIE: [number, number] = [1, 1];

const market = (price: PriceAt = () => 1): Market => ({ assetId: 1, digits: 5, price, series: {} });
const config = (variant: Variant, over: Partial<SimConfig> = {}): SimConfig => ({
  variant,
  point: {},
  interval: '5s',
  pause: false,
  openDelayMs: 0,
  from: T0 + 1,
  until: T0 + 120_000,
  ...over,
});

describe('simulate', () => {
  it('S1 the cadence: boundary + slack; no signal -> next boundary + slack; a trade -> exit + tick', () => {
    const seen: number[] = [];
    const result = simulate(market(), config(scripted([undefined, Up, undefined], seen)));
    const exit = FIRST + STEP + 5_000;
    expect(seen.slice(0, 4)).toEqual([
      FIRST,
      FIRST + STEP,
      exit + SETTLE_TICK_MS,
      exit + SETTLE_TICK_MS + STEP,
    ]);
    expect(result.trades).toEqual([
      { decidedAt: FIRST + STEP, action: Up, entryAt: FIRST + STEP, exitAt: exit, outcome: 'tie' },
    ]);
  });

  it('S2 trades never overlap and the last exit is not after until', () => {
    const until = T0 + 61_000;
    const result = simulate(
      market(),
      config(scripted(Array(50).fill(Up)), { until, openDelayMs: 3_000 }),
    );
    expect(result.trades.length).toBeGreaterThan(3);
    result.trades.forEach((trade, i) => {
      if (i > 0)
        expect(trade.decidedAt).toBeGreaterThanOrEqual(
          result.trades[i - 1].exitAt + SETTLE_TICK_MS,
        );
    });
    expect(result.trades.at(-1)!.exitAt).toBeLessThanOrEqual(until);
    expect(result.trades.at(-1)!.exitAt + SETTLE_TICK_MS + 3_000 + 5_000).toBeGreaterThan(until);
  });

  it('S3 the pause: two losses up hold up until a no-signal or a down clears it', () => {
    const script = [Up, Up, Up, Up, undefined, Up, Down];
    const result = simulate(
      market(scriptedPrices([LOSS_UP, LOSS_UP, WIN_UP, [1, 2]])),
      config(scripted(script), { pause: true }),
    );
    expect(result.trades.map((t) => [t.action, t.outcome])).toEqual([
      [Up, 'loss'],
      [Up, 'loss'],
      [Up, 'win'],
      [Down, 'loss'],
    ]);
    expect(result.refusals[PAUSE_REFUSAL]).toBe(2);
    const off = simulate(
      market(scriptedPrices([LOSS_UP, LOSS_UP, WIN_UP, WIN_UP])),
      config(scripted(script), { pause: false }),
    );
    expect(off.trades).toHaveLength(6);
  });

  it('S3b a tie between two losses breaks the streak; a down clears the pause too', () => {
    const tie = simulate(
      market(scriptedPrices([LOSS_UP, TIE, LOSS_UP, WIN_UP])),
      config(scripted([Up, Up, Up, Up]), { pause: true }),
    );
    expect(tie.trades).toHaveLength(4);
    const cleared = simulate(
      market(scriptedPrices([LOSS_UP, LOSS_UP, [1, 2], WIN_UP])),
      config(scripted([Up, Up, Up, Down, Up]), { pause: true }),
    );
    expect(cleared.trades.map((t) => t.action)).toEqual([Up, Up, Down, Up]);
  });

  it('S4 a missing price leaves the trade unpriced, and the streak skips it', () => {
    const result = simulate(
      market(scriptedPrices([LOSS_UP, undefined, LOSS_UP])),
      config(scripted([Up, Up, Up, Up]), { pause: true }),
    );
    expect(result.trades.map((t) => t.outcome)).toEqual(['loss', 'unpriced', 'loss']);
    expect(result.refusals[PAUSE_REFUSAL]).toBe(1);
  });

  it('S5 every decision is a trade, a refusal or a pause', () => {
    const result = simulate(
      market(scriptedPrices([LOSS_UP, LOSS_UP])),
      config(scripted([Up, undefined, Up, Up, Up, undefined]), { pause: true }),
    );
    const refused = Object.values(result.refusals).reduce((a, b) => a + b, 0);
    expect(result.decisions).toBe(result.trades.length + refused);
    expect(result.trades).toHaveLength(2);
    expect(result.refusals).toEqual({ none: result.decisions - 2 - 2, [PAUSE_REFUSAL]: 2 });
  });

  it('S6 openDelay moves the entry and the exit, not the decision', () => {
    for (const openDelayMs of [0, 1_000, 3_000]) {
      const [trade] = simulate(market(), config(scripted([Up]), { openDelayMs })).trades;
      expect(trade.decidedAt).toBe(FIRST);
      expect(trade.entryAt).toBe(FIRST + openDelayMs);
      expect(trade.exitAt).toBe(FIRST + openDelayMs + 5_000);
    }
  });

  it('V8 the 1m interval decides on minute boundaries and trades 60 s', () => {
    const seen: number[] = [];
    const result = simulate(
      market(),
      config(scripted([undefined, Up], seen), { interval: '1m', until: T0 + 600_000 }),
    );
    const first = Math.ceil((T0 + 1) / 60_000) * 60_000 + DECISION_SLACK_MS;
    expect(seen.slice(0, 2)).toEqual([first, first + 60_000]);
    expect(result.trades[0].exitAt - result.trades[0].entryAt).toBe(60_000);
  });

  it('S8 a run is deterministic', () => {
    const run = () =>
      simulate(
        market(scriptedPrices([LOSS_UP, WIN_UP, LOSS_UP])),
        config(scripted([Up, Down, Up, undefined]), { pause: true }),
      );
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
