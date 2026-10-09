import { BOT_PROFILE_PUBLISH_BUDGET_MS } from '@binarius/shared';
import { ADMIN_LOGIN_BUDGET_MS } from '@binarius/shared/admin';
import { OAUTH_CALLBACK_BUDGET_MS } from '@binarius/shared/oauth';

// Every bound this process runs under, and what each one bounds. The chain is checked at
// import, so a constant edited into an impossible order stops the process rather than
// producing a shutdown that cuts a login in half.

// One call to the backend's /admin API (AbortSignal.timeout in backend-client.ts). It has to
// sit above what the backend may spend on the longest of them — the login step, which waits
// for a scrypt slot, derives, and then calls Telegram — or this process would give up on a
// login that is still going to succeed, and the staff member would see an error over a
// challenge that exists. A save or reset of a command or profile text, and «Опубликовать
// заново», wait for a publish of the command menu and the profile after the write
// (BOT_PROFILE_PUBLISH_BUDGET_MS, #361); the statements around it are ordinary latency.
export const BACKEND_REQUEST_TIMEOUT_MS = 8_000;
// The forward of the Mini App's callback to the backend's public POST /auth/binodex/callback.
// Above what the backend may spend there — the code exchange and the push — for the same
// reason: giving up earlier would show the user an unknown outcome over a link that happened.
export const OAUTH_CALLBACK_REQUEST_TIMEOUT_MS = 10_000;
// app.close() waits for the request in flight, and the longest thing a request waits on is
// exactly one backend call.
export const SHUTDOWN_BUDGET_MS = 11_000;
// stop_grace_period of the compose service `web`, kept in step by timing.test.ts.
export const COMPOSE_STOP_GRACE_PERIOD_MS = 14_000;

export const TIMING_CHAIN_HOLDS =
  ADMIN_LOGIN_BUDGET_MS < BACKEND_REQUEST_TIMEOUT_MS &&
  BOT_PROFILE_PUBLISH_BUDGET_MS < BACKEND_REQUEST_TIMEOUT_MS &&
  OAUTH_CALLBACK_BUDGET_MS < OAUTH_CALLBACK_REQUEST_TIMEOUT_MS &&
  Math.max(BACKEND_REQUEST_TIMEOUT_MS, OAUTH_CALLBACK_REQUEST_TIMEOUT_MS) < SHUTDOWN_BUDGET_MS &&
  SHUTDOWN_BUDGET_MS < COMPOSE_STOP_GRACE_PERIOD_MS;
if (!TIMING_CHAIN_HOLDS) {
  throw new Error('web timing constants are out of order (see timing.ts)');
}
