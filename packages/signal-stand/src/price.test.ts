import { TradeAction } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { firstPrice, outcomeOf, priceIndex } from './price';
import { aggregate, secondsPath, T0 } from './testing';

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

  it('P3 at openDelay 0 the entry is the 5s close and the exit the close of the expiry candle', () => {
    const seconds = secondsPath(T0, 60);
    const fives = aggregate(seconds, 5_000);
    const price = priceIndex(seconds);
    // a decision at the boundary of candle n+1 enters at close n; a 5 s trade exits at close n+1
    const boundary = fives[3].timestamp;
    expect(price(boundary - 1_000)).toBe(fives[2].close);
    expect(price(boundary + 5_000 - 1_000)).toBe(fives[3].close);
  });
});
