export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface Pacer {
  take(): Promise<void>;
}

const WINDOW_MS = 60_000;

// A bucket of `perMinute` tokens, full again a minute after the window it was drawn in opened;
// one token per GET. A forward clock jump refills early: at most one extra batch in a minute.
export function createPacer(perMinute: number, clock: Clock = systemClock): Pacer {
  let windowStart: number | undefined;
  let tokens = 0;
  return {
    async take() {
      for (;;) {
        const now = clock.now();
        if (windowStart === undefined || now >= windowStart + WINDOW_MS) {
          windowStart = now;
          tokens = perMinute;
        }
        if (tokens > 0) {
          tokens--;
          return;
        }
        await clock.sleep(windowStart + WINDOW_MS - now);
      }
    },
  };
}
