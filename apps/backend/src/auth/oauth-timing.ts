// How long a login state lives, from `createOAuthState` to the callback (no route issues one
// since #314). It has to outlive the user typing their credentials, unlike the 120 s code it leads
// to.
export const OAUTH_STATE_TTL_MS = 600_000;

// How far the clocks of Telegram's servers, which stamp initData's auth_date, and of this host
// may disagree before a real login is refused as stale.
export const INIT_DATA_CLOCK_SKEW_MS = 60_000;

// The oldest auth_date the callback accepts. The Mini App opens on a button the bot shows after
// the state exists, and the callback has to arrive before the state expires, so a real login's
// initData is never older than the state's TTL; the skew covers the two clocks.
export const INIT_DATA_MAX_AGE_MS = OAUTH_STATE_TTL_MS + INIT_DATA_CLOCK_SKEW_MS;
