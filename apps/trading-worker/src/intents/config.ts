// A job holds its lock for LOCK_DURATION_MS (renewed while the processor runs); a worker that
// dies mid-job has its job redelivered after the lock lapses. The redelivery, and the sweeper,
// treat an intent as stuck only once it has been submitting for STALE_SUBMITTING_MS, which is
// kept >= LOCK_DURATION_MS > MAX_SUBMIT_ACK_TIMEOUT_MS: no live worker can still be inside its
// ack deadline by the time anyone calls its intent unknown.
export const LOCK_DURATION_MS = 60_000;
export const STALLED_INTERVAL_MS = 30_000;
export const MAX_STALLED_COUNT = 1;
export const STALE_SUBMITTING_MS = 60_000;
export const MAX_SUBMIT_ACK_TIMEOUT_MS = 30_000;

export const SWEEP_INTERVAL_MS = 15_000;
export const SWEEP_BATCH_SIZE = 50;

// below compose's default stop_grace_period (10 s): a job that does not finish in time leaves
// its intent in submitting for the sweeper, the process never gets SIGKILLed mid-write
export const SHUTDOWN_BUDGET_MS = 8_000;

// free text from the executor is logged, never persisted, and only this much of it
export const MAX_DETAIL_LENGTH = 200;
