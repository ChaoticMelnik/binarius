import { TradeAction } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { DECISION_SLACK_MS } from './config';
import { firstPrice, outcomeOf, priceIndex } from './price';
import { simulate } from './simulate';
import { aggregate, secondsPath, T0 } from './testing';
import type { Variant } from './variants';

describe('price', () => {
  it('P1 reads the 1s row labelled floor(ms / 1000) x 1000; a missing row is no price', () => {
    const seconds = secondsPath(T0, 10).filter((_, i) => i !== 4);
    const price = priceIndex(seconds);
    expect(price(T0 + 3_999)).toBe(seconds[3].close);
    expect(price(T0 + 3_000)).toBe(seconds[3].close);
    expect(price(T0 + 4_500)).toBeUndefined();
    expect(price(T0 - 1)).toBeUndefined();
    expect(price(T0 + 10_000)).toBeUndefined();
    expect(firstPrice(price, () => 7)(T0 + 4_500)).toBe(7);
    expect(firstPrice(price, () => 7)(T0 + 3_000)).toBe(seconds[3].close);
  });

  it('P2 up wins on a rise, a tie is neither, down mirrors', () => {
    expect(outcomeOf(TradeAction.Up, 1, 2)).toBe('win');
    expect(outcomeOf(TradeAction.Up, 2, 1)).toBe('loss');
    expect(outcomeOf(TradeAction.Up, 1, 1)).toBe('tie');
    expect(outcomeOf(TradeAction.Down, 2, 1)).toBe('win');
    expect(outcomeOf(TradeAction.Down, 1, 2)).toBe('loss');
    expect(outcomeOf(TradeAction.Down, 1, 1)).toBe('tie');
  });

  it('P3 at openDelay 0 the entry is the 1s close at D, not the last closed candle; the exit is the 1s close at D + duration', () => {
    // D = T0 + 5 000 + DECISION_SLACK_MS = row 7; a 5 s trade exits at row 12
    const level = (i: number) => (i < 7 ? 1 : i === 7 ? 1.2 : i === 12 ? 1.1 : 1.3);
    const seconds = secondsPath(T0, 60, level);
    const fives = aggregate(seconds, 5_000);
    const decidedAt = fives[1].timestamp + DECISION_SLACK_MS;
    expect(fives[0].close).toBe(1);
    expect(seconds[7].timestamp).toBe(decidedAt);
    const once: Variant = {
      name: 'once',
      intervals: ['5s'],
      grid: [{}],
      headlinePause: false,
      decide: ({ nowMs }) =>
        nowMs === decidedAt ? { action: TradeAction.Up } : { refusal: 'none' },
    };
    const { trades } = simulate(
      { assetId: 1, digits: 5, price: priceIndex(seconds), series: { '5s': fives } },
      {
        variant: once,
        point: {},
        interval: '5s',
        pause: false,
        openDelayMs: 0,
        from: T0 + 1,
        until: T0 + 60_000,
      },
    );
    // entry 1.2 -> exit 1.1 loses; an entry at the last closed close (1) or an exit at a
    // neighbouring row (1.3) would win
    expect(trades).toEqual([
      {
        decidedAt,
        action: TradeAction.Up,
        entryAt: decidedAt,
        exitAt: decidedAt + 5_000,
        outcome: 'loss',
      },
    ]);
  });
});
