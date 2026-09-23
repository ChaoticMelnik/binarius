# Binodex login (issue #9)

How a Telegram user ends up with a linked broker account, and how that account keeps a usable
access token afterwards. The broker's own contract — the authorize page, the 120-second
single-use code, the server-to-server token endpoint — is quoted from its admin docs; the
refresh grant follows RFC 6749 and is an assumption until a real call confirms it (#8/#35).

## Components

| Component | Package                                   | Role                                                                                             |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Contract  | `packages/shared/src/oauth.ts`            | wire schemas, the login request/response shapes, the error codes and the four revocation reasons |
| Storage   | `packages/db/src/oauth-ops.ts`            | state rows, the linking transaction, rotation and revocation                                     |
| Client    | `apps/backend/src/broker/oauth-client.ts` | the two exchanges, one attempt each, under a real abort                                          |
| Routes    | `apps/backend/src/auth/routes.ts`         | `POST /auth/binodex/start`, `POST /auth/binodex/callback`                                        |
| Refresh   | `apps/backend/src/auth/token-service.ts`  | `ensureFreshAccessToken(accountId)`                                                              |

## Sequence

```
bot ──POST /auth/binodex/start (internal token)──▶ backend
        │                                   creates oauth_states row (hash only, 10 min TTL)
        ◀── { authorizeUrl, state, expiresAt }
user ──opens authorizeUrl──▶ binodex.app  (client_id, redirect_uri, state, ref, response_mode)
broker ──code + state──▶ page/popup (#32)
page ──POST /auth/binodex/callback (public)──▶ backend
        │  CAS on the state row  ──▶ exchange code ──▶ link user + broker account
        ◀── { account }
later: ensureFreshAccessToken(accountId) ──▶ stored token, or one exchange, or a revocation
```

## Why the callback is public

The page that receives the code runs in a browser and cannot hold the internal API token. The
single-use state is what authorizes the call: 32 random bytes, stored only as a SHA-256 hash,
consumed by one `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`. Two parallel
callbacks with one state therefore produce exactly one exchange, and a forged, expired or
replayed state never reaches the broker at all.

The route also carries a 4 KB body limit and two counters per process, both on a one-minute
window and neither keyed by IP: `trustProxy` is not configured, so behind a reverse proxy every
request would arrive from one address, and trusting the forwarded header without a proxy list
would let a caller choose its own.

| Counter | Limit | Spent by | What it bounds |
| --- | --- | --- | --- |
| all requests | 3000/min | every request, before the body is parsed and before any query | how much work an anonymous caller can trigger at all |
| failed state lookups | 60/min | only a state that resolved to no row | guessing, without letting real logins close the door |

A successful login spends only the ceiling, so a burst of real users cannot exhaust the narrow
counter — that was the flaw of a single global window. Once sixty misses land in a minute the
callback answers 429 to everyone until the window rolls, which is the accepted cost: sixty
consecutive misses mean a guessing client or a broken one, not sixty users. A per-IP limit
belongs with the proxy configuration (#4); a distributed one is a follow-up.

## The state row

`oauth_states` keeps the hash, the Telegram id, the redirect URI it was issued for, an expiry
and a `used_at`. Everything the callback acts on comes from the row the CAS returns, never from
the request body. The TTL is ten minutes — the state is created before the user types their
credentials, while the broker's 120 seconds apply to the code that comes back. Expired rows are
deleted opportunistically when a new state is created, a hundred at a time with `SKIP LOCKED`,
so concurrent logins never queue on the same batch.

## Linking, and why it takes two steps

Token ciphertexts are authenticated against the row they live in (`keyId|accountId|field` as
AAD, `packages/db/src/crypto.ts`). A single `INSERT … ON CONFLICT DO UPDATE` would therefore
write ciphertext bound to a candidate id into a row that already has a different one, and
nothing could decrypt it afterwards. The transaction instead:

1. takes the `users` row (creating it if this is a first login) — lock order `users →
broker_accounts`, the same as every other writer;
2. inserts the account under an id generated up front, `ON CONFLICT (broker_user_id) DO NOTHING`;
3. if the account already existed, locks it `FOR NO KEY UPDATE`, checks the owner, and
   re-encrypts the tokens under its real id.

`id`, `user_id` and `broker_user_id` never change, which keeps the lock compatible with the
`KEY SHARE` locks the `trade_intents` foreign keys take. A blocked user is not unblocked by
logging in, and an account that belongs to another Telegram user answers 409
`broker_account_taken`. Several accounts per user stay allowed — ARCH-03 continues to answer
`ambiguous_broker_account` until the bot names one.

## What a re-login does and does not touch

It refreshes the tokens, sets `status = active` and clears `auth_revoked_reason`. It does not
touch `trading_halted` or `halted_reason`: those belong to reconciliation (ARCH-04), and an
account halted for an ambiguous match stays halted through a re-login.

## Refresh

`ensureFreshAccessToken(accountId)` runs the whole decision inside one transaction holding the
account row, which makes it single-flight per account:

| Step                                                        | Outcome                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| account missing                                             | `account_not_found`                                                                                               |
| `status ≠ active`                                           | `account_revoked` — checked **before** the expiry, so a revoked account never hands out the token it still stores |
| `token_key_id ≠ the process's key id`                       | `key_unavailable`, and **nothing is written** (see below)                                                         |
| ciphertext fails to decrypt under its own key id            | revoke `storage_inconsistent`                                                                                     |
| stored hash ≠ hash of the stored ciphertext                 | revoke `storage_inconsistent`                                                                                     |
| access token still valid (60 s skew)                        | return it; a legacy row missing its hash gets one here, and only the hash                                         |
| `coalesce(token_rotated_at, created_at)` older than 90 days | revoke `refresh_expired`, without asking the broker                                                               |
| rotated pair names another `broker_user_id`                 | revoke `storage_inconsistent`, the pair is not applied                                                            |
| otherwise                                                   | exactly one refresh exchange                                                                                      |

A row encrypted under another key id is left strictly alone. During a key rollout both the old
and the new process are running, and a process holding the old key would otherwise see every
freshly re-authorized account as inconsistent and revoke it — undoing a login the user has just
completed. Declining to serve the row costs an error for one process and nothing else; the
process that holds the matching key serves it normally.

The backfill of a missing `refresh_token_hash` writes that column and nothing else. In
particular it leaves `token_rotated_at` alone: that column dates the refresh token and starts
the ninety-day clock, so moving it would hand a token that is already months old another ninety
days of life.

Exchange failures map to revocations, never to retries:

| Failure                        | Reason                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| broker answers `invalid_grant` | `refresh_invalid_grant` — the token was already consumed, which is what a replayed refresh token looks like from our side                            |
| timeout, network error, 5xx    | `refresh_outcome_unknown` — the broker may have rotated the pair before the connection died, and presenting the old token again would be that replay |

Every branch commits its revocation and reports afterwards; throwing inside the transaction
would roll the revocation back.

One case cannot be handled inside that transaction: the exchange succeeded and storing the new
pair failed. PostgreSQL rejects every statement after a failed one in the same transaction, so
the revocation would be rejected too. The service therefore lets the transaction roll back and
revokes the account `refresh_outcome_unknown` in a **second** transaction — the broker has
consumed the stored token, and a rolled-back write means our only copy of its replacement is
gone. If that second transaction also fails, the account stays active holding a token the
broker will refuse, and the next refresh revokes it on `invalid_grant`.

## Secrets

Broker errors carry a code and a status, never the response body, the request form or a cause.
`trade_intents`-style allowlists apply here too: `auth_revoked_reason` holds one of four values,
CHECKed in the schema. `LOG_REDACT_PATHS` covers the broker's snake_case names, `state` and
`authorizationCode` at every depth, plus the single path `req.body.code`. The bare key `code` is
deliberately **not** redacted: SQLSTATE, libuv errno and Fastify's `FST_ERR_*` all travel under
that name, and blanking them would cost the diagnostics this project logs errors by — errors are
logged as `{ name, code }` and nothing else (`errorIdentity`, `packages/shared/src/logging.ts`).
The one place a state legitimately appears is the authorize URL that `start` returns — it is
absent from callback responses, from errors and from logs.

## Configuration

Backend only, never the worker (the worker neither exchanges grants nor decrypts tokens):

| Variable                                   | Meaning                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `BROKER_CLIENT_ID`, `BROKER_CLIENT_SECRET` | the OAuth client registered in the broker's cabinet (#8)                                                   |
| `BROKER_OAUTH_AUTHORIZE_URL`               | the page the bot links to; `https:` only                                                                   |
| `BROKER_API_BASE_URL`                      | where `POST /v1/broker/oauth/token` lives; `https:` only                                                   |
| `BROKER_OAUTH_REDIRECT_URI`                | must match the value registered with the client; `http:` only for `127.0.0.1` or `localhost`               |
| `BROKER_PARTNER_REF`                       | attached to every authorization request, so a new user registers under this installation's partner account |
| `TOKEN_ENCRYPTION_KEY`                     | 32 bytes, base64; `openssl rand -base64 32`                                                                |
| `TOKEN_ENCRYPTION_KEY_ID`                  | names the key for rotation; no `\|`, no whitespace (the cipher binds with it)                              |

compose supplies dev values so the stack starts without secrets, including an all-zero
encryption key. That key is published in this repository and is therefore no protection at all,
so the backend accepts it **only** paired with `TOKEN_ENCRYPTION_KEY_ID=dev`, which is what
compose sets. Any other key id with that key fails at startup: the combination means a rotation
where the id was changed and the key was not. A deployment (#4) overrides every one of them.

## Boundaries

- **#32** owns the login page and the `web_message` popup; it calls these two routes.
- **#10** owns the linking UI and re-linking an account that belongs to someone else.
- **#39** owns the email + code login, a separate grant entirely.
- **ARCH-01 (#40)** will call `ensureFreshAccessToken` before talking to the broker socket.
- **#35** owns the reusable mock broker; the stub next to the client
  (`apps/backend/src/broker/testing/oauth-stub.ts`) exists so this suite can prove code expiry,
  single use and refresh-family behaviour.
