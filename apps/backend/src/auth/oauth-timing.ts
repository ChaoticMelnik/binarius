// How long a login state lives, from `createOAuthState` to the callback (no route issues one
// since #314). It has to outlive the user typing their credentials, unlike the 120 s code it leads
// to.
export const OAUTH_STATE_TTL_MS = 600_000;

// How far the clocks of Telegram's servers, which stamp initData's auth_date, and of this host
// may disagree before a real login is refused as stale.
export const INIT_DATA_CLOCK_SKEW_MS = 60_000;

// The oldest auth_date the callback accepts. The Mini App opened on a button the bot showed after
// the state existed (until #314), and the callback has to arrive before the state expires, so a
// real login's initData is never older than the state's TTL; the skew covers the two clocks.
export const INIT_DATA_MAX_AGE_MS = OAUTH_STATE_TTL_MS + INIT_DATA_CLOCK_SKEW_MS;

// The cashier (#11, docs/deposit.md): the Mini App stays open while the user pays, and every
// session renewal after the widget's reauth (#112) re-sends the initData it was opened with. What
// it grants is a deposit session for the user's own account, so an hour is the accepted window.
export const DEPOSIT_INIT_DATA_SESSION_MS = 3_600_000;
export const DEPOSIT_INIT_DATA_MAX_AGE_MS = DEPOSIT_INIT_DATA_SESSION_MS + INIT_DATA_CLOCK_SKEW_MS;
