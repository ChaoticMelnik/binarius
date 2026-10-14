const RATE_WINDOW_MS = 60_000;

export interface Ticket {
  over: boolean;
  generation: number;
}

export interface RateWindow {
  take(): Ticket;
  release(generation: number): void;
  isOver(): boolean;
}

// One fixed window per process, rolled forward lazily. A distributed limit would need Redis and
// is follow-up work; this one bounds a single backend, which is what the deployment runs.
export function createWindow(limit: number): RateWindow {
  let startedAt = Date.now();
  let count = 0;
  let generation = 0;
  const roll = (): void => {
    if (Date.now() - startedAt < RATE_WINDOW_MS) return;
    startedAt = Date.now();
    count = 0;
    generation += 1;
  };
  return {
    // Reserves the slot before the work it limits, not after: a counter incremented once the
    // work has finished lets a concurrent burst through while every request is still in flight.
    take: (): Ticket => {
      roll();
      count += 1;
      return { over: count > limit, generation };
    },
    // returns a reservation that turned out not to be the thing being limited; a window that
    // has rolled since is a different window, and its count is not ours to touch
    release: (generation_: number): void => {
      roll();
      if (generation_ === generation && count > 0) count -= 1;
    },
    isOver: (): boolean => {
      roll();
      return count > limit;
    },
  };
}

/**
 * A window per key, for limits that are about one identity rather than one route. Bounded and
 * evicting: the keys come from request bodies, so an unbounded map would be the denial of
 * service the window exists to prevent. Eviction drops the oldest entry, which at worst gives
 * a flooder a fresh allowance — the route ceiling above is what bounds the volume.
 */
export function createKeyedWindow(limit: number, windowMs: number, maxKeys: number) {
  const seen = new Map<string, { startedAt: number; count: number }>();
  return {
    /** true when this key is over its allowance. */
    take: (key: string): boolean => {
      const now = Date.now();
      const entry = seen.get(key);
      if (entry === undefined || now - entry.startedAt >= windowMs) {
        if (seen.size >= maxKeys && entry === undefined) {
          // Map iterates in insertion order, so the first key is the oldest inserted
          const oldest = seen.keys().next();
          if (!oldest.done) seen.delete(oldest.value);
        }
        seen.set(key, { startedAt: now, count: 1 });
        return 1 > limit;
      }
      entry.count += 1;
      return entry.count > limit;
    },
  };
}
