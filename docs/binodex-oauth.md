# Binodex login (issue #9)

How a Telegram user ends up with a linked broker account, and how that account keeps a usable
access token afterwards. There are two ways in: the OAuth login below, and the email login
(#162, [Email login](#email-login-issue-162)), which the bot offers first. The broker's own contract — the authorize page, the 120-second
single-use code, the server-to-server code exchange and the token refresh — was checked against
the live broker on 2026-10-01 (#102, #163); see [Broker contract](#broker-contract-verified-2026-10-01).

## Components

| Component | Package                                   | Role                                                                                             |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Contract  | `packages/shared/src/oauth.ts`            | wire schemas, the login request/response shapes, the error codes and the four revocation reasons |
| Storage   | `packages/db/src/oauth-ops.ts`            | state rows, the linking transaction, rotation and revocation                                     |
| Starter pack | `packages/db/src/link-bonus-ops.ts`    | `LINK_BONUS_TOKENS` and `grantLinkBonus`, called by the confirmation (#10) and by the email login (#162) |
| Client    | `apps/backend/src/broker/oauth-client.ts` | the code exchange on `POST /v1/broker/oauth/token`, the refresh on `POST /v1/broker/user-auth/refresh`, and the email `send-code` and `login`, one attempt each, under a real abort; `BROKER_ENDPOINTS` is the one table of paths and statuses |
| Routes    | `apps/backend/src/auth/routes.ts`         | `POST /auth/binodex/start`, `POST /auth/binodex/callback`, `POST /auth/binodex/confirm`, `POST /auth/binodex/email/send-code`, `POST /auth/binodex/email/login` |
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
user ──/start──▶ bot: pendingBrokerAccounts is not empty ──▶ "Подтвердить" button (#10)
bot ──POST /auth/binodex/confirm (internal token)──▶ backend   pending ──▶ active, starter pack
        ◀── { account, grant }
later: ensureFreshAccessToken(accountId) ──▶ stored token, or one exchange, or a revocation
```

The email login (#162) has no browser leg and no confirmation:

```
bot ──POST /auth/binodex/email/send-code (internal token)──▶ backend ──▶ broker email/send-code
        ◀── { codeSent: true }                                   the broker mails a code
bot ──POST /auth/binodex/email/login (internal token, code)──▶ backend ──▶ broker email/login
        │                   (partner_code) ──▶ link user + broker account (active), starter pack
        ◀── { account, grant }
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

So the callback calls `linkBrokerAccount` with `activate: false`, which writes a new account as
`pending`, and on this path only `POST /auth/binodex/confirm` — called by the bot, carrying the
internal token and the Telegram id — turns it into `active`. The email login is the one caller
that activates directly ([Why it skips pending](#why-it-skips-pending)). Three rules make the
OAuth gate hold:

- a second OAuth login **does not** stand in for the confirmation: a `pending` row stays `pending`,
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
`oauth_states.telegram_user_id`.

Since #22 the bot calls `POST /auth/binodex/start`, so an authorize URL is available to any
Telegram user who taps the button, and "no client calls these routes" no longer describes the
deployment. What that changes, and what it does not:

- the handing-over scenario becomes executable as soon as #32 delivers an authorization code to
  `POST /auth/binodex/callback`. Before that page exists, no code reaches the backend at all:
  the authorize request carries `response_mode=web_message`, and a plain redirect with `?code=`
  lands on the backend's 404, where the code is stripped from the log;
- once it does, the first thing a handed-over link costs the victim is not a takeover but their
  own account: the callback writes a `pending` row carrying the victim's `broker_user_id` under
  the attacker's Telegram account, and `broker_accounts_broker_user_id_idx` then answers the
  victim's own attempt with `broker_account_taken`. A takeover needs the attacker to confirm as
  well, which is the step the section above describes;
- nothing in the bot or the backend can close this. The proof has to come from the page that
  finishes the flow, which is why the `initData` check belongs to #32 as a condition of shipping
  the page rather than as work that follows it.

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

## The starter pack

Confirming a partner account (#10) pays its user `LINK_BONUS_TOKENS`, once per user — 100
autotrading tokens, defined once in `packages/db/src/link-bonus-ops.ts` and nowhere else; the bot prints the
number the backend sends. The demo balance is not part of it: the broker sets it when the account
is created, and nothing here stores or credits one.

- **Where.** `grantLinkBonus` runs inside the `confirmBrokerAccount` transaction, after the
  `UPDATE … SET status = 'active'`. The users row is already held `FOR NO KEY UPDATE`, so the
  lock order stays `users → broker_accounts`; the ledger row and `users.token_balance` change
  together, or not at all. The callback and a `pending` account pay nothing, and neither does a
  re-login that brings a `revoked` account back to `active` — that is not a first activation.
- **Once per user.** The ledger row is a `bonus` that names the account it was earned by
  (`token_ledger.broker_account_id`, a composite FK on `(id, user_id)`, so it can only name one
  of the user's own accounts), with `note = 'link_bonus'` for #13. The partial unique index
  `token_ledger_link_bonus_user_idx` on `user_id`, over bonuses that name an account, holds one
  such row per user; the insert is `ON CONFLICT … DO NOTHING`, and a second account answers
  `already_granted` with the balance untouched. The key is the user, not the account: linking a
  second account does not pay again.
- **Partner accounts only.** `is_partner_client`, as the broker reported it on the latest login
  and read from the locked row, decides. `false` links the account as usual — `active`, able to
  trade — pays nothing and answers `not_partner_client`. That rule lives in `grantLinkBonus`,
  not in the database, and it spends no slot: the same user confirming a partner account later
  still gets the pack.
- **The answer.** `POST /auth/binodex/confirm` returns `{ account, grant }`, where `grant` is
  `{ granted: true, tokens: "100" }` (a decimal string) or `{ granted: false, reason }` with
  `reason` one of `not_partner_client`, `already_granted`.
- **#162.** The email login calls the same `grantLinkBonus` inside `linkBrokerAccount`
  (`activate: true`), with the same preconditions: the users row held by `upsertUser`, the
  account made `active` by that transaction. It calls it on **every** email login, not only the
  first activation — the index is what holds one pack per user. The one difference from the
  OAuth path follows: a user whose `active` or `revoked` partner account never earned the pack
  (it was a non-partner account when it was confirmed) gets it on an email login, while an
  OAuth re-login pays nothing. That is the rule above — a partner account confirmed later still
  pays.

Accounts confirmed before migration `0008` received nothing; there was no production data then.

## Email login (issue #162)

The bot asks for an address, the backend asks the broker to mail a code to it, the user types the
code into the bot, and the backend redeems it. The broker registers a new account under
`partner_code` (`BROKER_PARTNER_REF`) or signs an existing one in; either way it answers the same
body as the code exchange, and the account is stored through the same `linkBrokerAccount` — the
same row, the same encryption, the same refresh through `user-auth/refresh`.

### Why it skips pending

`linkBrokerAccount(…, activate: true)` writes a new account as `active`, and turns the user's own
`pending`, `active` or `revoked` row into `active` with `auth_revoked_reason` cleared. Another
user's account is still `broker_account_taken`, with nothing written. The confirmation exists
because the OAuth callback proves only that *someone* authorized at the broker, and a link can be
handed to a victim. Here the code from the letter is typed into the bot by the Telegram user who
gets the account; a confirmation would be that user confirming to themselves. A `pending` row an
unfinished OAuth login left is activated the same way. The OAuth callback passes
`activate: false` and is unchanged, and the column default stays `pending`.

### Routes

Both are in the internal-token scope, next to `start` and `confirm`. The address is
`emailAddressSchema` (trimmed, then checked, at most 254 characters, case kept on the wire), the
code `emailLoginCodeSchema` (trimmed, 1-64 characters, any shape — the broker answers a wrong
shape with `Invalid or expired code` too). Neither the address nor the code is stored or written
to the log by these routes; `broker_accounts.email` holds what the broker reports, as with OAuth.

| Route | Answer | Errors |
| --- | --- | --- |
| `POST /auth/binodex/email/send-code` `{ telegramUserId, email }` | 200 `{ codeSent: true }` | 400 `validation`; 400 `invalid_email` (the broker refused the address); 409 `user_blocked`; 429 `too_many_attempts` / `too_many_requests`; 502 `broker_contract_violation` / `broker_unavailable` |
| `POST /auth/binodex/email/login` `{ telegramUserId, email, code }` | 200 `{ account, grant }`, as `confirm` | 400 `validation`; 400 `invalid_code` (wrong, expired or used code); 409 `user_blocked` / `broker_account_taken`; 429 `too_many_attempts` / `too_many_requests`; 502 `broker_contract_violation` / `broker_unavailable` |

The order inside each route: the route ceiling (an `onRequest` hook on the route, which runs after
the scope's bearer check, so a caller without the token cannot spend it), the body, the blocked
check (before the broker), the per-key windows, the broker, and for `login` the transaction.

### Limits

In-process windows (`rate-window.ts`), like the callback's: reset by a restart and per backend
process, which is what is deployed.

- **Ceilings:** 60 `send-code` and 300 `login` requests a minute for the whole route → 429
  `too_many_requests`. Every `send-code` is a real letter, so it is held far lower.
- **Per key, 10 minutes:** 3 `send-code` and 5 `login` attempts per Telegram user **and** per
  address (the key is the hash of the lower-cased address; the map holds no address) → 429
  `too_many_attempts`. The address window on `login` stops a brute force of one address's code
  spread across several Telegram accounts; the cost is that anyone who knows an address can hold
  its login for up to ten minutes, which `send-code`'s own address window allows already. The
  Telegram user is counted first, so a user over their own allowance does not spend the
  address's.
- The slot is taken **before** the broker call and never given back, even when the broker fails:
  a sixth attempt is refused even with the right code, and a broker outage spends the user's
  allowance.
- None of this depends on the broker's code lifetime or its own lockout, which were not measured.
  Whoever runs out waits and asks for a new code; every `send-code` is a new code.

### Accepted cost

The status map reads no body (see [Broker contract](#broker-contract-verified-2026-10-01)), so a
`BROKER_PARTNER_REF` of the right shape that does not belong to this installation's partner
account looks exactly like a wrong code: `invalid_code` to the user, 400/`invalid_grant` in the
warn line. The first live email login after a deploy is what checks it.

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

| Failure | Reason |
| --- | --- |
| broker answers 401 to `user-auth/refresh` (`Invalid token`: unknown or already consumed) | `refresh_invalid_grant` — the token was already consumed, which is what a replayed refresh token looks like from our side |
| anything else | `refresh_outcome_unknown` — a timeout, a network error or a 5xx, but also a 4xx other than 401 (a 400 means our request was malformed, and the broker may still have read the token) and a 2xx whose body breaks the contract. In each the broker may have rotated the pair, and presenting the old token again would be that replay |

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
refresh gets a 401 and revokes it there with `refresh_invalid_grant`.

### Why the refresh does not compare the user

The answer from `user-auth/refresh` carries no `user`, so there is nothing to compare: the code
exchange is the only place a pair arrives with a `broker_user_id`, and `linkBrokerAccount` keys
on it there. Ownership of a refreshed pair rests on the token we present instead. It is decrypted
from this account's own row — the AAD is `keyId|accountId|field`, so a ciphertext copied from
another row does not decrypt — and matched against `refresh_token_hash` before the exchange, and
the answer is written back into the same row under the same lock (`applyRotatedTokens`). What is
left is the broker itself answering a valid token with somebody else's pair, which is a broker
compromise and outside this flow's threat model.

### A 401 means the chain is dead

The live broker answers a replayed refresh token with 401, and after that it also refuses the
newest token of the same chain (the last row of the Live check table). A 401 therefore cannot be
read as "this one token was stale": the whole session is gone, whatever caused it, and revoking
the account so the user logs in again is the only move left. No stored token would get a
different answer, which is why `refresh_invalid_grant` is final.

## Broker contract (verified 2026-10-01)

Observed with curl and the live-check script against `https://api.binodex.app` with this
installation's client id (#102, #163). The `message` texts are what the broker said that day, not
a contract this code relies on.

| Endpoint | Request | Success | Observed refusals |
| --- | --- | --- | --- |
| `POST /v1/broker/oauth/token` | form-urlencoded (JSON is accepted too): `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` | 200 `{access_token, refresh_token, token_type, expires_in: 604800, user: {id, email, is_partner_client, …}}` | 400 `Invalid or expired authorization code`; 401 `Authentication failed: Invalid client credentials`; 400 `Validation failed: "code" is required` for `grant_type=refresh_token` — there is no refresh grant here |
| `POST /v1/broker/user-auth/refresh` | JSON `{refresh_token}`, no client credentials | 200 `{access_token, refresh_token, token_type, expires_in: 604800}`, **no `user`** | 401 `Invalid token` for an unknown or consumed token; 400 `Validation failed: "refresh_token" is required` |
| `POST /v1/broker/user-auth/email/send-code` | JSON `{client_id, client_secret, email}` | 200 `{status: true}`, and the broker mails a code | 400 `Validation failed: "email" is required` for an address it does not take; 401 for wrong client credentials |
| `POST /v1/broker/user-auth/email/login` | JSON `{client_id, client_secret, email, code, partner_code}` | 200, the same body as the code exchange, `user` included (#102) | 400 `Invalid or expired code` for a wrong or foreign code; 400 `Validation failed` without `code`; 401 for wrong client credentials |

The two email rows come from #102 and from probes on 2026-10-01 that sent no letter (an invalid
address, a code that was never issued, a wrong secret). A successful login of an existing user by
email was checked live by the owner in #102.

Every error body has the shape `{"error":{"message","details"}}` — an object, not the OAuth string
`{"error":"invalid_grant"}`. `binodex.app` without `api.` answers every `POST /v1/broker/...` with
405 and an empty body.

The client tells failures apart by the HTTP status alone, through one table that holds each
endpoint's path and the status it refuses a grant with (`BROKER_ENDPOINTS` and `classify` in
`oauth-client.ts`; `post()` takes the table's key and nothing else, so a call cannot reach one
endpoint while being classified as another); the error body is released unread and is never
parsed or logged:

| Status | `oauth/token` | `user-auth/refresh` | `email/send-code` | `email/login` |
| --- | --- | --- | --- | --- |
| 400 | `invalid_grant` | `rejected` | `invalid_grant` | `invalid_grant` |
| 401 | `rejected` | `invalid_grant` | `rejected` | `rejected` |
| other 4xx | `rejected` | `rejected` | `rejected` | `rejected` |
| 5xx, timeout, network failure | `unavailable` | `unavailable` | `unavailable` | `unavailable` |
| 2xx that breaks the schema, or `expires_in` outside (0, 30 days] | `contract_violation` | `contract_violation` | `contract_violation` (anything but `status: true`) | `contract_violation` |

The routes turn `invalid_grant` into 400 — `invalid_code` on the callback and the email login,
`invalid_email` on `send-code` — and everything else into 502 (`brokerOutcome` in `routes.ts`).

A 400 on the code exchange is also what our own malformed request gets (`Validation failed`), so
such a bug reaches the browser as `invalid_code`, and the callback's warn line cannot tell it from
an expired code either. That is the accepted cost of not reading the body; the client tests pin
the map, so a change to what we send is caught there rather than in production.

### Live check: OAuth tokens on `user-auth/refresh`

`user-auth/refresh` was first confirmed with tokens from the email login (#102). Whether it also
takes a refresh token issued by the OAuth code exchange was checked on 2026-10-01 at about 08:42
UTC, with a freshly registered account and `ref` set to the short partner code:

1. open `https://binodex.app/oauth/authorize?client_id=<id>&redirect_uri=<registered uri>&state=<any>&ref=<code>`
   and log in; the browser lands on `<redirect_uri>?code=…&state=…` (a connection error on that
   page does not matter — the code is in the address bar);
2. within 120 seconds, exchange the code on `oauth/token` (form, with the client credentials);
3. post the returned refresh token to `user-auth/refresh` as JSON;
4. post the **old** refresh token again;
5. post the refresh token from step 3.

The script printed statuses, field names and the replay's error body, never a token or the
secret:

| Step | Result |
| --- | --- |
| code exchange | 200: `access_token`, `refresh_token`, `token_type`, `expires_in=604800`, `user{id, email, …, is_partner_client=true, …}`; both tokens JWT-shaped |
| refresh with the OAuth refresh token | 200: `access_token`, `refresh_token`, `token_type`, `expires_in=604800`, no `user` |
| replay of the old refresh token | 401 `{"error":{"message":"Invalid token","details":{}}}` |
| the new refresh token, after that replay | 401 — the replay killed the whole chain |

So the OAuth refresh token is refreshable on `user-auth/refresh`, single-use, and a replay
revokes the newest pair too (see [A 401 means the chain is dead](#a-401-means-the-chain-is-dead)).
The new account came back with `is_partner_client=true`: the short code passed as `ref` attaches
an account registered during the OAuth login to the partner account.

### Live check: an account registered without the partner link

Checked on 2026-10-01 at about 09:28 UTC for the starter pack's partner rule. The owner registered
a new account directly on binodex.app, with a different email and no partner link, then logged
into it on our authorize page with `client_id` and `ref=<short code>`, redirect
`http://localhost:3000/auth/callback`. The `oauth/token` exchange answered 200 with
`user.id=101962`, `is_verified=false`, `is_partner_client=true`.

`false` was **not** observed. Two readings fit, and nothing on our side tells them apart:

- (a) the broker attaches an existing, unattached account to the partner when it logs in
  through the partner's authorize page with `ref` — the broker's page probably sends
  `partnerCode` with its own login, since #163 showed that `POST /v1/broker/oauth/authorize`
  itself does not carry `ref`;
- (b) the account was a partner one already.

Neither is claimed as confirmed. The code branches on the stored boolean, and the `false` branch
is tested against the stub only. An earlier attempt in the same run returned the #163 account
(`user.id=97266`, `true`) because the browser profile still held its session; it is not an
observation.

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
of `cause`; sites that use `errorIdentity` deliberately do not. In some the error is one this
code constructs and has no cause; in others, such as the worker's executor port, the contract is
that nothing beyond the thrown error's own name and code is logged; and in the dependency checks
the driver puts the whole diagnostic on the error's own `code` (a SQLSTATE, an `ECONNREFUSED`)
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
| `BROKER_API_BASE_URL`                      | the API host every `POST /v1/broker/...` call in `BROKER_ENDPOINTS` lives on: `https://api.binodex.app`; `https:` only. `binodex.app` without `api.` answers 405 to every API call |
| `BROKER_OAUTH_REDIRECT_URI`                | must match the value registered with the client; `http:` only for `127.0.0.1` or `localhost`               |
| `BROKER_PARTNER_REF`                       | the short partner code, `<code>` from `https://bdclick.app/smart/<code>` — never the link: `[A-Za-z0-9_-]`, 1-64 chars, checked at backend startup (`parsePartnerCode` in `apps/backend/src/env.ts`). Sent as `ref` on every authorization request and as `partner_code` on every email login, so a new user registers under this installation's partner account |
| `TOKEN_ENCRYPTION_KEY`                     | 32 bytes, base64; `openssl rand -base64 32`                                                                |
| `TOKEN_ENCRYPTION_KEY_ID`                  | names the key for rotation; no `\|`, no whitespace (the cipher binds with it)                              |

`INTERNAL_API_TOKEN`, `BROKER_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`TOKEN_ENCRYPTION_KEY_ID` and `BROKER_PARTNER_REF` have **no deployable default anywhere in this
repository**. The partner code is not a secret, but a made-up one fails silently — every new
account registers outside the partner account — so it gets the same treatment. Neither
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

- **#22** owns `/start` and the button that calls `POST /auth/binodex/start`; it hands the user
  an authorize URL and nothing else (docs/bot-start.md).
- **#128** owns the backend's push right after a successful callback: a `sendMessage` to the
  Telegram id restored from the state, without waiting for the user to come back to the chat.
- **#32** owns the login page and the `web_message` popup; it calls the callback route, and it
  is where the `initData` check above closes the handoff gap.
- **#10** owns the starter pack, the confirm button and the outcome message in the bot. Re-linking
  an account that belongs to another Telegram user is out of scope: `broker_account_taken` is
  final, and moving an account is a separate support task.
- **#162** is the backend half of the email + code login ([Email login](#email-login-issue-162)):
  the client calls, the two routes, the activation and the starter pack. **#171** owns the bot's
  side: the address → code dialog, its state, the buttons and texts.
- **ARCH-01 (#40)** will call `ensureFreshAccessToken` before talking to the broker socket.
- **#35** owns the reusable mock broker; the stub next to the client
  (`apps/backend/src/broker/testing/oauth-stub.ts`) exists so this suite can prove code expiry,
  single use and refresh-family behaviour, and the email codes' single use and partner check,
  with the statuses and error bodies of the live broker.
