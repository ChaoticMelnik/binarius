import {
  PASSWORD_VERIFY_CONCURRENCY,
  PASSWORD_VERIFY_MAX_WAIT_MS,
  PASSWORD_VERIFY_QUEUE_MAX,
} from '../timing';

export const PasswordQueueRefusal = {
  /** more requests are already waiting than the queue holds */
  Full: 'full',
  /** a slot did not come free inside the wait budget */
  TimedOut: 'timed_out',
} as const;
export type PasswordQueueRefusal = (typeof PasswordQueueRefusal)[keyof typeof PasswordQueueRefusal];

export class PasswordQueueOverflow extends Error {
  readonly reason: PasswordQueueRefusal;

  constructor(reason: PasswordQueueRefusal) {
    super(`password verification refused: ${reason}`);
    this.name = 'PasswordQueueOverflow';
    this.reason = reason;
  }
}

export interface PasswordQueueOptions {
  concurrency?: number;
  queueMax?: number;
  maxWaitMs?: number;
}

export interface PasswordQueue {
  /** Runs `work` once a slot is free, or throws PasswordQueueOverflow without running it. */
  run<T>(work: () => Promise<T>): Promise<T>;
  readonly running: number;
  readonly waiting: number;
}

/**
 * The gate in front of scrypt. One hash holds 128 MiB for about 250 ms, so the thing that has
 * to be bounded is not how long a login takes but how many hashes exist at once: without this,
 * a burst of login requests is a way to spend the process's memory, and no per-route rate limit
 * expressed in requests per minute bounds a concurrent burst.
 *
 * Refusing is the point — a caller that cannot have a slot is answered 429 and never reaches
 * the KDF, so the refusal costs nothing and the work that is running keeps its share.
 */
export function createPasswordQueue({
  concurrency = PASSWORD_VERIFY_CONCURRENCY,
  queueMax = PASSWORD_VERIFY_QUEUE_MAX,
  maxWaitMs = PASSWORD_VERIFY_MAX_WAIT_MS,
}: PasswordQueueOptions = {}): PasswordQueue {
  let running = 0;
  const waiters: { admit: () => void; refuse: (error: Error) => void }[] = [];

  const release = (): void => {
    running -= 1;
    const next = waiters.shift();
    if (next === undefined) return;
    running += 1;
    next.admit();
  };

  const acquire = async (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return;
    }
    if (waiters.length >= queueMax) throw new PasswordQueueOverflow(PasswordQueueRefusal.Full);
    await new Promise<void>((resolve, reject) => {
      // a holder, because the two closures below are created before the timer they cancel
      const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
      const entry = {
        admit: () => {
          clearTimeout(deadline.timer);
          resolve();
        },
        refuse: (error: Error) => reject(error),
      };
      waiters.push(entry);
      deadline.timer = setTimeout(() => {
        const at = waiters.indexOf(entry);
        // already admitted: the slot is ours and the timeout lost the race
        if (at === -1) return;
        waiters.splice(at, 1);
        entry.refuse(new PasswordQueueOverflow(PasswordQueueRefusal.TimedOut));
      }, maxWaitMs);
    });
  };

  return {
    async run(work) {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
    get running() {
      return running;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
