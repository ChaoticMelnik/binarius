// A deadline that holds even when the call ignores its own abort signal (#481: on the pilot a
// broker GET kept the pairs catalog's single-flight for minutes with no error at all, and no
// probe reproduced a fetch that outlives AbortSignal.timeout - so the bound must not depend on
// one).
//
// run() gets a signal that aborts at timeoutMs or with the caller's signal. A run that settles
// before the cut, or within ABANDON_GRACE_MS after it, passes its own result or error through, so a
// healthy abort keeps every code the client gave before (its timeout, the caller's abort, a status
// whose error body the abort cut). A run still pending after that is abandoned: the caller gets a
// DeadlineError then, and the run's late result or error is dropped, never an unhandled
// rejection.

// One timer tick after the abort (Node and vitest's fake timers both run a 0 ms timer 1 ms later):
// every abort shape probed on Node 22.23.2 (no headers, headers without a body, an endless body,
// an endless error body, raw TCP, a blackhole address, a slow body) settles the fetch before even
// a setImmediate. A timer rather than setImmediate so vitest's default fake timers drive it.
// Bounds nothing a caller waits on beyond it, so it enters no timing chain.
export const ABANDON_GRACE_MS = 0;

// our timer, or the caller's signal; a type only - an `as const` object with these two values
// would claim every 'timeout' | 'aborted' literal in the repo (local/no-status-literal)
export type DeadlineKind = 'timeout' | 'aborted';

export class DeadlineError extends Error {
  // `code`, so errorLogFields carries which cut it was
  constructor(readonly code: DeadlineKind) {
    super(code);
    this.name = 'DeadlineError';
  }
}

export interface DeadlineHooks {
  // the caller was answered with this error while run() is still pending
  onAbandoned?: (error: DeadlineError) => void;
  // an abandoned run settled; lateMs counts from the abandonment
  onSettledLate?: (
    late: { lateMs: number; ok: true } | { lateMs: number; ok: false; error: unknown },
  ) => void;
}

// The logger the fetch clients log an abandoned or late-settled call to.
export interface FetchDeadlineLogger {
  error(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

let abandoned = 0;

// Calls of this process still pending after their own deadline. 0 when nothing was ever
// abandoned.
export const abandonedFetches = (): number => abandoned;

function callHook(hook: () => void): void {
  try {
    hook();
  } catch {
    // a hook is a log line; one that throws inside a timer callback would take the process down
  }
}

export function withinDeadline<T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  hooks: DeadlineHooks = {},
): Promise<T> {
  const deadline = new AbortController();
  const signal =
    callerSignal === undefined ? deadline.signal : AbortSignal.any([callerSignal, deadline.signal]);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cut = false;
    let abandonedAt: number | undefined;

    const onCaller = (): void => cutOff('aborted');
    const timer = setTimeout(() => cutOff('timeout'), timeoutMs);
    callerSignal?.addEventListener('abort', onCaller, { once: true });
    const release = (): void => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCaller);
    };

    function cutOff(kind: DeadlineKind): void {
      if (settled || cut) return;
      cut = true;
      release();
      if (kind === 'timeout') {
        // its own reason object: a client tells our cut from the caller's by the combined reason
        deadline.abort(Object.assign(new Error('deadline'), { name: 'TimeoutError' }));
      }
      setTimeout(() => {
        if (settled) return;
        abandoned += 1;
        abandonedAt = Date.now();
        const error = new DeadlineError(kind);
        reject(error);
        if (hooks.onAbandoned !== undefined) {
          const onAbandoned = hooks.onAbandoned;
          callHook(() => onAbandoned(error));
        }
      }, ABANDON_GRACE_MS);
    }

    function settle(outcome: { ok: true; value: T } | { ok: false; error: unknown }): void {
      settled = true;
      if (abandonedAt === undefined) {
        release();
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
        return;
      }
      abandoned -= 1;
      const lateMs = Math.max(0, Date.now() - abandonedAt);
      if (hooks.onSettledLate !== undefined) {
        const onSettledLate = hooks.onSettledLate;
        callHook(() =>
          onSettledLate(
            outcome.ok ? { lateMs, ok: true } : { lateMs, ok: false, error: outcome.error },
          ),
        );
      }
    }

    let running: Promise<T>;
    try {
      running = run(signal);
    } catch (error) {
      running = Promise.reject(error);
    }
    running.then(
      (value) => settle({ ok: true, value }),
      (error: unknown) => settle({ ok: false, error }),
    );
    // already aborted before the call: no abort event will come
    if (callerSignal?.aborted === true) cutOff('aborted');
  });
}
