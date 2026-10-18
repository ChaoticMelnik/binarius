// The composition pieces the in-process end-to-end test (packages/e2e, docs/e2e-demo-cycle.md)
// wires the way index.ts does. Test-only: imported by packages/e2e alone, never by a runtime module.

export { buildApp, type AppDeps } from './app';
export { createClientPush, type ClientPush } from './auth/client-push';
export { DEPOSIT_INIT_DATA_MAX_AGE_MS, INIT_DATA_MAX_AGE_MS } from './auth/oauth-timing';
export { createInitDataVerifier } from './auth/telegram-init-data';
export { ensureFreshAccessToken } from './auth/token-service';
export { createBalanceReconciler } from './broker/balance-reconciler';
export { createBrokerOAuthClient } from './broker/oauth-client';
export { createBullmqPublisher } from './outbox/bullmq';
export { OutboxPublisher } from './outbox/publisher';
export { createSessionNoticeSender } from './trading/session-notices';
export type { TradingRoutesDeps } from './trading/routes';
export { createScanPacer } from './signal/pacer';
export {
  SIGNAL_CACHE_MAX_TTL_MS,
  SIGNAL_FETCH_BUDGET_MS,
  SIGNAL_SCAN_BACKOFF_MAX_MS,
  SIGNAL_SCAN_BACKOFF_MIN_MS,
  signalRestCapacity,
} from './timing';
export {
  captureApi as capturePushApi,
  unusedAdminDeps,
  unusedPaymentsDeps,
  type CapturedApi as CapturedPushApi,
} from './admin/testing';
export { unusedDepositDeps } from './deposit/testing';
export { unusedSignalsDeps } from './trading/testing';
