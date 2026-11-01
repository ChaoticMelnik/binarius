import { errorLogFields } from '@binarius/shared';
import type { Logger } from './logging';

// Work a handler hands off so the user's chain is not held by it (#875, Rule 70): the status
// card's unpin and pin. It starts on a timer, so after the handler has returned and its update is
// done; a failure is logged and goes nowhere else. stop() runs beside the drain of the handlers
// (closeAll runs the shutdown steps side by side): work not yet started is dropped, and so is any
// handed off after it — the next /start pins again — while work already running is waited for,
// at most DETACHED_DRAIN_MS (timing.ts).
export interface DetachedWork {
  run: (work: () => Promise<void>) => void;
  // every handed-off work started and settled: for the tests
  settled: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createDetachedWork({ logger }: { logger: Logger }): DetachedWork {
  let stopping = false;
  const waiting = new Set<ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();

  const begin = (work: () => Promise<void>) => {
    const running = work()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'detached work failed');
      })
      .finally(() => {
        inFlight.delete(running);
      });
    inFlight.add(running);
  };
  const drain = async () => {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  };

  return {
    run: (work) => {
      if (stopping) return;
      const timer = setTimeout(() => {
        waiting.delete(timer);
        begin(work);
      }, 0);
      waiting.add(timer);
    },
    settled: async () => {
      while (waiting.size > 0 || inFlight.size > 0) {
        // timers of one delay fire in the order set: this one comes after every waiting work's
        if (waiting.size > 0) await new Promise((resolve) => setTimeout(resolve, 0));
        await drain();
      }
    },
    stop: async () => {
      stopping = true;
      for (const timer of waiting) clearTimeout(timer);
      waiting.clear();
      await drain();
    },
  };
}
