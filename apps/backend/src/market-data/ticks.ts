import type { LastTick } from '@binarius/shared';
import { tickProblem, type Tick } from '@binarius/signal';

// The newest data-socket tick of each pair (#666, docs/market-data.md → The tick store): the
// active client's ticks, as the ring takes them; the signal route answers it with a session's
// decision record. #668 widens it to a window.
export interface TickStore {
  // receivedAtMs: the local clock when the tick arrived; a tick the ring would refuse is dropped,
  // and one older than the pair's newest does not replace it
  push(assetId: number, tick: Tick, receivedAtMs: number): void;
  last(assetId: number): LastTick | undefined;
  counters(): { pairs: number };
}

export function createTickStore(): TickStore {
  const newest = new Map<number, LastTick>();
  return {
    push(assetId, tick, receivedAtMs) {
      if (tickProblem(tick, receivedAtMs) !== undefined) return;
      const held = newest.get(assetId);
      if (held !== undefined && tick.timestamp < held.timestamp) return;
      newest.set(assetId, { price: tick.price, timestamp: tick.timestamp, receivedAtMs });
    },
    last: (assetId) => newest.get(assetId),
    counters: () => ({ pairs: newest.size }),
  };
}
