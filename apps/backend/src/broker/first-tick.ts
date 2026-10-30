import type { FastifyBaseLogger } from 'fastify';
import { errorLogFields } from '@binarius/shared';
import { firstTickAtMs, firstTickDelayMs } from '../timing';

export interface FirstTickOptions {
  intervalMs: number;
  firstTickMinMs: number;
  random: () => number;
  // ms since the newest attempt any process recorded, by the database clock; null when none
  lastAttemptAgeMs: () => Promise<number | null>;
  tick: () => void;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

// The broker loops' schedule (#874, Rule 65, docs/broker-balance.md → Start and shutdown): the
// first tick at firstTickAtMs over the age the read answered, the interval from that tick.
// Returns cancel(): no timer is armed after it, and its promise settles once the read has, so
// stop() leaves no query running against a pool about to close.
export function scheduleTicks(options: FirstTickOptions): () => Promise<void> {
  const { intervalMs, firstTickMinMs, random, tick, logger } = options;
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;

  const read = options.lastAttemptAgeMs().then(
    (age) => age,
    (error: unknown) => {
      if (!cancelled) {
        logger.warn(
          errorLogFields(error),
          'first tick: the last attempt read failed, waiting a whole interval',
        );
      }
      // age 0: a whole interval, the delay before #874
      return 0;
    },
  );

  const armed = read.then((age) => {
    if (cancelled) return;
    const delayMs = firstTickAtMs(
      firstTickDelayMs(firstTickMinMs, intervalMs, random),
      intervalMs,
      age,
    );
    timer = setTimeout(() => {
      timer = setInterval(tick, intervalMs);
      tick();
    }, delayMs);
  });

  return () => {
    cancelled = true;
    // the pending first tick or the interval: one handle at a time
    clearTimeout(timer);
    timer = undefined;
    return armed;
  };
}
