// A sliding window of answered and failed events (#96, docs/runbook-broker-outage.md). It counts
// distinct keys: an intent for the REST signal, an account for the sockets, so one key failing
// over and over counts once. A key's latest event wins: an account that lost its socket and got it
// back is answered. Pruned on every call, so it holds the events of one window at most. The clock
// is the caller's: the window is a rate, not a deadline.

export interface WindowStats {
  failures: number;
  total: number;
}

export interface FailureWindow {
  record(key: string, failed: boolean, atMs: number): void;
  stats(atMs: number): WindowStats;
  clear(): void;
}

export function createFailureWindow(windowMs: number): FailureWindow {
  // insertion order is event order: a key re-recorded is moved to the end
  const latest = new Map<string, { failed: boolean; atMs: number }>();

  function prune(atMs: number) {
    for (const [key, event] of latest) {
      if (event.atMs > atMs - windowMs) break;
      latest.delete(key);
    }
  }

  return {
    record(key, failed, atMs) {
      latest.delete(key);
      latest.set(key, { failed, atMs });
      prune(atMs);
    },
    stats(atMs) {
      prune(atMs);
      let failures = 0;
      for (const event of latest.values()) if (event.failed) failures += 1;
      return { failures, total: latest.size };
    },
    clear() {
      latest.clear();
    },
  };
}

// at least minFailures, and at least failurePercent of the keys in the window
export const tripsAt = (
  { failures, total }: WindowStats,
  { minFailures, failurePercent }: { minFailures: number; failurePercent: number },
): boolean => failures >= minFailures && failures * 100 >= failurePercent * total;
