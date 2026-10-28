import { H1SecondClosedBy, type LastTick } from '@binarius/shared';
import { assertDigits, tickProblem, type Tick } from '@binarius/signal';

// The 1s closes of the data socket for H1 (#669, docs/h1.md -> The second series): a
// second is labelled by its end s (a multiple of 1 000 ms) and covers (s - 1000, s], as the
// broker's 1s chart does; c[s] is the price of the last tick with timestamp <= s, rounded to the
// pair's digits, carried over quiet seconds. A second f is closed by its own pair's first tick past
// it, or by the process clock closeMarginMs after f; a closed second never changes. When the
// active socket leaves `ready`, each pair's seconds are NaN until its first tick after the drop.
// No timers and no logger: the H1 driver's tick drives advance() (#830).

export interface SecondSeriesOptions {
  capacitySec: number;
  closeMarginMs: number;
}

export interface ClosedSecond {
  assetId: number;
  // the closed second's end label
  second: number;
  closedBy: H1SecondClosedBy;
  // the receipt of the closing tick, or the clock reading of advance()
  closedAtMs: number;
}

export interface SecondWindow {
  // the closes of the lengthSec seconds ending at f, NaN where the series has no price
  closes: Float64Array;
  // every one of those seconds is a closed second the series still holds
  complete: boolean;
}

export interface SecondSeriesCounters {
  pairs: number;
  // ticks more than closeMarginMs past their receipt: counted, not applied
  ahead: number;
  // ticks at or before their pair's last closed second: counted, not applied
  late: number;
  closedByTick: number;
  closedByClock: number;
  // seconds closed as NaN after a drop
  holeSeconds: number;
  // a pair's series emptied because more than capacitySec seconds closed at once
  resets: number;
}

export type ClosedSecondListener = (closed: ClosedSecond) => void;

export interface SecondSeries {
  // digits: the pair's, from the catalog; a pair keeps the digits of its first tick
  push(assetId: number, digits: number, tick: Tick, receivedAtMs: number): void;
  // the clock rule for every pair
  advance(nowMs: number): void;
  // the active socket left `ready`
  onDrop(): void;
  // listeners run synchronously after the state is updated, one call per second in order; a
  // listener must not throw (it runs inside the socket's event handler)
  onClosed(listener: ClosedSecondListener): () => void;
  window(assetId: number, f: number, lengthSec: number): SecondWindow;
  close(assetId: number, f: number): number;
  // the tick whose price is c[f]; undefined outside the series or where c[f] is NaN
  lastTickOf(assetId: number, f: number): LastTick | undefined;
  // the digits the pair's closes are rounded to
  digitsOf(assetId: number): number | undefined;
  // the pair's newest closed second the series holds, with how and when it closed (#796);
  // undefined before its first close and after a reset until the next one
  lastClosed(assetId: number): ClosedSecond | undefined;
  counters(): SecondSeriesCounters;
}

const SECOND_MS = 1_000;

interface PairState {
  digits: number;
  close: Float64Array;
  tickTs: Float64Array;
  receivedAt: Float64Array;
  // the first second the series holds; closed seconds are [max(start, held floor), closedUntil]
  start: number;
  closedUntil: number;
  last: LastTick;
  holePending: boolean;
  lastClosedBy: H1SecondClosedBy;
  lastClosedAtMs: number;
}

export const secondOf = (timestamp: number) => Math.ceil(timestamp / SECOND_MS) * SECOND_MS;

export function createSecondSeries(options: SecondSeriesOptions): SecondSeries {
  const { capacitySec, closeMarginMs } = options;
  if (!Number.isInteger(capacitySec) || capacitySec <= 0) {
    throw new RangeError(
      `second series: capacitySec must be a positive integer, got ${capacitySec}`,
    );
  }
  if (!Number.isFinite(closeMarginMs) || closeMarginMs < 0) {
    throw new RangeError(
      `second series: closeMarginMs must be finite and >= 0, got ${closeMarginMs}`,
    );
  }
  const pairs = new Map<number, PairState>();
  const listeners = new Set<ClosedSecondListener>();
  const counts = { ahead: 0, late: 0, closedByTick: 0, closedByClock: 0, holeSeconds: 0, resets: 0 };

  const slotOf = (second: number) => (second / SECOND_MS) % capacitySec;
  const floorOf = (pair: PairState) =>
    Math.max(pair.start, pair.closedUntil - (capacitySec - 1) * SECOND_MS);
  const held = (pair: PairState, second: number) =>
    second % SECOND_MS === 0 && second >= floorOf(pair) && second <= pair.closedUntil;

  // closes (closedUntil, target]; the seconds closed, in order, for the caller to announce
  function closeThrough(pair: PairState, target: number, by: H1SecondClosedBy): number[] {
    const n = (target - pair.closedUntil) / SECOND_MS;
    if (n > capacitySec) {
      counts.resets += 1;
      pair.closedUntil = target;
      pair.start = target + SECOND_MS;
      return [];
    }
    const closed: number[] = [];
    for (let second = pair.closedUntil + SECOND_MS; second <= target; second += SECOND_MS) {
      const slot = slotOf(second);
      if (pair.holePending) {
        pair.close[slot] = NaN;
        pair.tickTs[slot] = NaN;
        pair.receivedAt[slot] = NaN;
        counts.holeSeconds += 1;
      } else {
        pair.close[slot] = pair.last.price;
        pair.tickTs[slot] = pair.last.timestamp;
        pair.receivedAt[slot] = pair.last.receivedAtMs;
      }
      if (by === H1SecondClosedBy.Tick) counts.closedByTick += 1;
      else counts.closedByClock += 1;
      pair.closedUntil = second;
      closed.push(second);
    }
    return closed;
  }

  function announce(
    assetId: number,
    pair: PairState,
    seconds: readonly number[],
    closedBy: H1SecondClosedBy,
    closedAtMs: number,
  ) {
    if (seconds.length > 0) {
      pair.lastClosedBy = closedBy;
      pair.lastClosedAtMs = closedAtMs;
    }
    for (const second of seconds) {
      for (const listener of listeners) listener({ assetId, second, closedBy, closedAtMs });
    }
  }

  return {
    push(assetId, digits, tick, receivedAtMs) {
      if (tickProblem(tick, receivedAtMs) !== undefined) return;
      // a tick from the future would close the seconds up to it at once, and a closed second never
      // changes; checked before the pair lookup, so it does not open a pair either
      if (tick.timestamp > receivedAtMs + closeMarginMs) {
        counts.ahead += 1;
        return;
      }
      const second = secondOf(tick.timestamp);
      const pair = pairs.get(assetId);
      if (pair === undefined) {
        assertDigits(digits);
        pairs.set(assetId, {
          digits,
          close: new Float64Array(capacitySec).fill(NaN),
          tickTs: new Float64Array(capacitySec).fill(NaN),
          receivedAt: new Float64Array(capacitySec).fill(NaN),
          start: second,
          closedUntil: second - SECOND_MS,
          last: {
            price: Number(tick.price.toFixed(digits)),
            timestamp: tick.timestamp,
            receivedAtMs,
          },
          holePending: false,
          lastClosedBy: H1SecondClosedBy.Tick,
          lastClosedAtMs: NaN,
        });
        return;
      }
      if (tick.timestamp <= pair.closedUntil) {
        counts.late += 1;
        return;
      }
      const closed =
        second - SECOND_MS > pair.closedUntil
          ? closeThrough(pair, second - SECOND_MS, H1SecondClosedBy.Tick)
          : [];
      // the first tick after a drop: c[s] from its second on is known again
      pair.holePending = false;
      if (tick.timestamp >= pair.last.timestamp) {
        pair.last = {
          price: Number(tick.price.toFixed(pair.digits)),
          timestamp: tick.timestamp,
          receivedAtMs,
        };
      }
      announce(assetId, pair, closed, H1SecondClosedBy.Tick, receivedAtMs);
    },
    advance(nowMs) {
      for (const [assetId, pair] of pairs) {
        const next = pair.closedUntil + SECOND_MS;
        if (nowMs < next + closeMarginMs) continue;
        const target = next + Math.floor((nowMs - closeMarginMs - next) / SECOND_MS) * SECOND_MS;
        announce(
          assetId,
          pair,
          closeThrough(pair, target, H1SecondClosedBy.Clock),
          H1SecondClosedBy.Clock,
          nowMs,
        );
      }
    },
    onDrop() {
      for (const pair of pairs.values()) pair.holePending = true;
    },
    onClosed(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    window(assetId, f, lengthSec) {
      const closes = new Float64Array(lengthSec).fill(NaN);
      const pair = pairs.get(assetId);
      if (pair === undefined) return { closes, complete: false };
      let complete = true;
      for (let i = 0; i < lengthSec; i++) {
        const second = f - (lengthSec - 1 - i) * SECOND_MS;
        if (held(pair, second)) closes[i] = pair.close[slotOf(second)];
        else complete = false;
      }
      return { closes, complete };
    },
    close(assetId, f) {
      const pair = pairs.get(assetId);
      return pair !== undefined && held(pair, f) ? pair.close[slotOf(f)] : NaN;
    },
    lastTickOf(assetId, f) {
      const pair = pairs.get(assetId);
      if (pair === undefined || !held(pair, f)) return undefined;
      const slot = slotOf(f);
      const price = pair.close[slot];
      if (Number.isNaN(price)) return undefined;
      return { price, timestamp: pair.tickTs[slot], receivedAtMs: pair.receivedAt[slot] };
    },
    digitsOf: (assetId) => pairs.get(assetId)?.digits,
    lastClosed(assetId) {
      const pair = pairs.get(assetId);
      if (pair === undefined || !held(pair, pair.closedUntil)) return undefined;
      return {
        assetId,
        second: pair.closedUntil,
        closedBy: pair.lastClosedBy,
        closedAtMs: pair.lastClosedAtMs,
      };
    },
    counters: () => ({ pairs: pairs.size, ...counts }),
  };
}
