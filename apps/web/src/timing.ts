import { ADMIN_LOGIN_BUDGET_MS } from '@binarius/shared/admin';

// Every bound this process runs under, and what each one bounds. The chain is checked at
// import, so a constant edited into an impossible order stops the process rather than
// producing a shutdown that cuts a login in half.

// One call to the backend's /admin API (AbortSignal.timeout in backend-client.ts). It has to
// sit above what the backend may spend on the longest of them — the login step, which waits
// for a scrypt slot, derives, and then calls Telegram — or this process would give up on a
// login that is still going to succeed, and the staff member would see an error over a
// challenge that exists.
export const BACKEND_REQUEST_TIMEOUT_MS = 8_000;
// app.close() waits for the request in flight, and the longest thing a request waits on is
// exactly one backend call.
export const SHUTDOWN_BUDGET_MS = 9_000;
// stop_grace_period of the compose service `web`, kept in step by timing.test.ts.
export const COMPOSE_STOP_GRACE_PERIOD_MS = 12_000;

export const TIMING_CHAIN_HOLDS =
  ADMIN_LOGIN_BUDGET_MS < BACKEND_REQUEST_TIMEOUT_MS &&
  BACKEND_REQUEST_TIMEOUT_MS < SHUTDOWN_BUDGET_MS &&
  SHUTDOWN_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('web timing constants are out of order (see timing.ts)');
}
