// The worker's composition for the in-process end-to-end test (packages/e2e,
// docs/e2e-demo-cycle.md). Test-only: imported by packages/e2e alone, never by a runtime module.

export type { Env } from './env';
export { createWorker, type ShutdownResult, type TradingWorker, type WorkerTuning } from './worker';
export { TEST_SUBMIT_ACK_TIMEOUT_MS, TEST_WORKER_TUNING, watchSockets } from './testing';
