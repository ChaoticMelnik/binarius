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
| Routes    | `apps/backend/src/auth/routes.ts`         | `POST /auth/binodex/start`, `POST /auth/binodex/callback`, `POST /auth/binodex/confirm`          |
| Refresh   | `apps/backend/src/auth/token-service.ts`  | `ensureFreshAccessToken(accountId)`                                                              |

## Sequence

```
bot ──POST /auth/binodex/start (internal token)──▶ backend
        │                                   creates oauth_states row (hash only, 10 min TTL)
        ◀── { authorizeUrl, state, expiresAt }
user ──opens authorizeUrl──▶ binodex.app  (client_id, redirect_uri, state, ref, response_mode)
broker ──code + state──▶ page/popup (#32)
page ──POST /auth/binodex/callback (public)──▶ backend
        │  CAS on the state row  ──▶ exchange code ──▶ link user + broker account (pending)
        ◀── { account }
bot ──POST /auth/binodex/confirm (internal token)──▶ backend   pending ──▶ active
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
| failed state lookups | 600/min | only a state that resolved to no row | junk, without letting real logins close the door |

Both counters **reserve** their slot before the work they limit, and the failure counter gives
its slot back when the work turns out not to be a failure: the callback takes a failure slot
before the state lookup and releases it when the state resolves, or when the lookup itself
throws. The ceiling never releases — every request counts against it, which is the point. A counter
incremented after the lookup would let a whole concurrent burst through, because none of them
has counted yet while the others are being admitted. A database outage does not spend the
budget either — it is not a guess.

A successful login spends only the ceiling, so a burst of real users cannot exhaust the narrow
counter. The narrow limit is deliberately high: a 32-byte state cannot be guessed, so the window
only has to bound junk, and a low threshold would have meant one request per second could close
the callback for everyone. A per-IP limit belongs with the proxy configuration (#4); a
distributed one is a follow-up.

## Why a new account starts pending

The callback proves that **someone** authorized at the broker. It does not prove that the person
who finished the login is the Telegram user who started it: the authorize URL is an ordinary
link, and a link can be handed to somebody else. Without a second step, an attacker who passes
their own link to a victim ends up with the victim's brokerage account attached to the
attacker's Telegram account.

So `linkBrokerAccount` writes a new account as `pending`, and only `POST /auth/binodex/confirm`
— called by the bot, carrying the internal token and the Telegram id — turns it into `active`.
Three rules make that gate hold:

- a second login **does not** stand in for the confirmation: a `pending` row stays `pending`,
  though its tokens are still rotated. Only a row that was `active` or `revoked` returns to
  `active` on a re-login, because its owner confirmed it once already;
- confirmation is scoped by ownership. The account is looked up by id **and** user, so an
  account that belongs to somebody else is indistinguishable from one that does not exist;
- the user row is read under lock inside the same transaction, so a block landing at the same
  moment cannot slip past.

A `pending` account cannot trade: both account-selection paths in `packages/db/src/trade-intent-ops.ts`
filter on `active`, and the trading API answers `account_not_confirmed` rather than the
misleading `account_halted`. That matters because `apps/trading-worker` never reads the account
status at all — it trusts that nothing reached the queue for an account that may not act. The
invariant it depends on: no intent is created for a non-active account, and there is no
`active → pending` transition.

**Residual risk.** The confirmation makes an unexpected link visible and costs the attacker an
extra step, but in the scenario above the person confirming is the attacker, who sees the
victim's email and agrees. Closing the vector completely needs proof of who finished the flow —
signed Telegram `initData` forwarded by the login page (#32) and compared with
`oauth_states.telegram_user_id`. Until then the gap is documented rather than closed, which is
acceptable only while no bot or web client calls these routes.

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

It refreshes the tokens and clears `auth_revoked_reason`. What it does to `status` depends on
where the account was: an account that was `active` or `revoked` becomes `active` again, because
its owner confirmed it once already; one that is still `pending` stays `pending`, because a
second login is not the confirmation nobody gave. It does not touch `trading_halted` or
`halted_reason`: those belong to reconciliation (ARCH-04), and an account halted for an
ambiguous match stays halted through a re-login.

## Refresh

`ensureFreshAccessToken(accountId)` runs the whole decision inside one transaction holding the
account row, which makes it single-flight per account:

| Step                                                        | Outcome                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| account missing                                             | `account_not_found`                                                                                               |
| `status = pending`                                          | `account_pending` — nobody has confirmed it, so it may not act on the user's behalf                               |
| `status = revoked`                                          | `account_revoked` — checked **before** the expiry, so a revoked account never hands out the token it still stores |
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

The backfill of a missing `refresh_token_hash` writes that column and `updated_at`, which every
write here bumps. In particular it leaves `token_rotated_at` alone: that column dates the refresh
token and starts the ninety-day clock, so moving it would hand a token that is already months old
another ninety days of life.

Exchange failures map to revocations, never to retries:

| Failure                        | Reason                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| broker answers `invalid_grant` | `refresh_invalid_grant` — the token was already consumed, which is what a replayed refresh token looks like from our side                            |
| timeout, network error, 5xx    | `refresh_outcome_unknown` — the broker may have rotated the pair before the connection died, and presenting the old token again would be that replay |

Every branch commits its revocation and reports afterwards; throwing inside the transaction
would roll the revocation back.

One class of failure cannot be handled inside that transaction: the stored pair stopped being
reliably ours and something afterwards failed. The trigger is not any particular call — a failed
write usually poisons the transaction so the revocation would be rejected too, and a failure
raised by the COMMIT is never visible to code running inside it at all. So the service records
what it was holding at the two points where the pair becomes unreliable, lets the transaction
roll back, and revokes in a **second** transaction:

- the broker answered and rotated the pair;
- the broker's answer never arrived (timeout, network failure, 5xx), which this flow already
  treats as a consumed token.

An `invalid_grant` refusal is deliberately not one of them: the broker refused, nothing rotated,
and if that transaction's COMMIT fails the next call gets the same refusal and revokes with the
exact reason. The recording covers a failed rotation write, a failed revocation on either branch,
and a failed COMMIT alike.

The second transaction cannot revoke unconditionally. Its row lock is gone, so the user may have
logged in again in the gap, and revoking by id alone would destroy that new session — the same
mistake the key-id rule above exists to prevent. `revokeAccountIfUnchanged` therefore matches on
the refresh hash the caller was holding (`is not distinct from`, because a legacy row carries
NULL) and reports which of four things happened:

| Outcome | Meaning | What the service does |
| --- | --- | --- |
| `revoked` | the row still held the lost pair | reports `account_revoked` / `refresh_outcome_unknown` |
| `already_revoked` | someone else got there first | reports `account_revoked` with their reason |
| `changed` | the user logged in again; the lost pair is nobody's dependency now | logs and rethrows the original failure |
| `missing` | the account is gone | logs and rethrows |

If the second transaction itself fails, the account stays active holding a token the broker will
refuse, the failure is logged, and `ensureFreshAccessToken` **throws** rather than returning a
result — callers such as ARCH-01 (#40) see an exception, not an `AccessTokenResult`. The next
refresh gets `invalid_grant` and revokes it there.

## Secrets

Broker errors carry a code and a status, never the response body, the request form or a cause.
`trade_intents`-style allowlists apply here too: `auth_revoked_reason` holds one of four values,
CHECKed in the schema. `LOG_REDACT_PATHS` covers the broker's snake_case names, `state` and
`authorizationCode` at every depth, plus `req.body.code` — insurance for a future serializer
rather than a path anything logs today, since Fastify's `req` serializer never emits the body.
The bare key `code` is
deliberately **not** redacted: SQLSTATE, libuv errno and Fastify's `FST_ERR_*` all travel under
that name, and blanking them would cost the diagnostics this project logs errors by — errors are
logged as `{ name, code }`. Sites that use `errorLogFields` add the same two fields for one level
of `cause`; sites that use `errorIdentity` deliberately do not — in some the error is one this
code constructs and has no cause, and in others, such as the worker's executor port, the contract
is that nothing beyond the thrown error's own name and code is logged
(`packages/shared/src/logging.ts`). The cause matters where a wrapper has nothing of its own:
drizzle's query error sets neither `name` nor `code`, and the SQLSTATE that makes a database
failure actionable is on the pg error underneath.
No key path can reach a string, so what is logged is shaped rather than redacted. Every line this
application writes passes the error through `errorIdentity` or `errorLogFields`, a rule in
`eslint.config.js` refuses an `err`/`cause` field that does not — within the shapes it can see,
which its own comment lists — and a subclass of Fastify's
`LogController` does the same for the lines the framework writes on our behalf — including the
4xx path, which our error handler reaches by delegating through `reply.send(error)`. The request
serializer and a custom not-found handler strip `code` and `state` from the logged URL, for the
case where the broker delivers them as query parameters.

That is not the same as "the log contains no raw error". Fastify logs a few of its own events
without going through `LogController`, and neither the subclass nor the lint rule reaches them:
errors thrown by hooks, a promise rejected after the reply was sent, trailer errors, a stream
error on an auto-generated HEAD route, the raw URL inside its duplicate-reply warning — and
client errors. All but the last need a bug of this project's own to fire; a client error is
triggered by a malformed request from outside, and Node attaches the raw request bytes to the
parser errors it raises, which is one reason the default level is `info` rather than `trace`.
The claim this project makes is the narrower one, because the last four rounds of review were
spent on claims that were wider than the code.

A state legitimately appears in what `start` returns — inside the authorize URL and as a field of
its own, which is what the bot passes on. It is absent from callback responses, from errors, and
from every line this application or `SafeLogController` writes.

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

`INTERNAL_API_TOKEN`, `BROKER_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` and
`TOKEN_ENCRYPTION_KEY_ID` have **no deployable default anywhere in this repository**. Neither
`compose.yaml`, which uses the `${VAR:?message}` form, nor `.env.example`, which lists them with
empty assignments, supplies a value that a deployment could inherit by following the setup
instructions. `${VAR:?}` refuses an empty value as well as a missing one, so `cp .env.example .env`
leaves the stack still refusing to start, and a developer has to put something there deliberately.

Values for these names do appear in the tree, and every one of them is a fixture: CI's compose job
sets its own throwaway values, `apps/backend/src/env.test.ts` builds its own, and `.env.example`
names the all-zero development key in a comment, which is useless outside the `dev` key id. None
of them is a default that a deployment receives. A CI step asserts the refusal, one variable at a
time and for an empty value as well as a missing one — the check exists because the last two
attempts at this each left a way in.

The development encryption key is thirty-two zero bytes, and `.env.example` names it in a comment
rather than assigning it. It is published here and is therefore no protection at all, so the
backend accepts it **only** paired with `TOKEN_ENCRYPTION_KEY_ID=dev`. Any other key id with that
key fails at startup: the combination means a rotation where the id was changed and the key was
not.

## Boundaries

- **#32** owns the login page and the `web_message` popup; it calls these two routes.
- **#10** owns the linking UI and re-linking an account that belongs to someone else.
- **#39** owns the email + code login, a separate grant entirely.
- **ARCH-01 (#40)** will call `ensureFreshAccessToken` before talking to the broker socket.
- **#35** owns the reusable mock broker; the stub next to the client
  (`apps/backend/src/broker/testing/oauth-stub.ts`) exists so this suite can prove code expiry,
  single use and refresh-family behaviour.
