# Trading access — the token balance

`POST /trading/access` (#136) tells the bot what a user may trade with right now. Issue #15 is
split in three: #136 answers the token side (this document), #137 adds the broker balance
snapshot and its age to the same response, #138 serves the pair catalog as its own
`GET /trading/pairs`. The route only reads: nothing is reserved, credited or refreshed, and the
users row is not touched.

## Components

| Part | File | What it holds |
| --- | --- | --- |
| Contract | `packages/shared/src/trading-access.ts` | request and response schemas, `safeParseTradingAccessRequest` / `safeParseTradingAccessResponse`; `tokenCountSchema` (`trading.ts`) is the one spelling of a non-negative token count on the wire; a positive count (`linkBonusGrantViewSchema.tokens`, `oauth.ts`) keeps its own pattern |
| Read | `packages/db/src/token-balance-ops.ts` | `readTokenBalance` (one `select` of the users row) and the allowlisted projection `toTradingAccessView` |
| Route | `apps/backend/src/trading/access.ts` | `registerTradingAccess`, registered inside the `tradingRoutes` plugin (`routes.ts`), so its bearer hook covers it |
| Tests | `token-balance-ops.db.test.ts`, `access.db.test.ts`, `trading-access.test.ts` | the cache against the ledger, concurrency, the HTTP outcomes, the parser |

## Sequence

```text
bot  → POST /trading/access { telegramUserId }        (Authorization: Bearer INTERNAL_API_TOKEN)
back → SELECT status, token_balance, token_reserved FROM users WHERE telegram_user_id = $1
back → 200 { status, tokens: { balance, reserved, available } }   or   404 { error: 'user_not_found' }
```

The bot's display and its `BackendClient` method are #24's.

## Request

| Field | Type | Rule |
| --- | --- | --- |
| `telegramUserId` | string | `telegramUserIdSchema`: a positive integer that fits int8 |

## Response (200)

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `'active' \| 'blocked'` | `users.status`, informational only — refusing a blocked user's trade stays in `createTradeIntent`'s CAS |
| `tokens.balance` | unsigned decimal string | `users.token_balance` |
| `tokens.reserved` | unsigned decimal string | `users.token_reserved`: tokens held by intents not yet settled or released |
| `tokens.available` | unsigned decimal string | `balance - reserved`, computed in `bigint` from the same row |

The response schema refuses a body where `available` is not `balance - reserved`. The backend never
sends one, so for the bot's parser such a body is a contract violation, not numbers to show.

## Outcomes

| Outcome | Source | What the caller (#24) does |
| --- | --- | --- |
| 200 `status: 'active'` | the users row | show the numbers |
| 200 `status: 'blocked'` | the users row | the blocked text; the numbers are still the user's |
| 404 `user_not_found` (`UserErrorCode.UserNotFound`) | no users row: such a user has no ledger and no reservation | «not connected», chosen by the error code |
| 404 `not_found` (an older backend without the route), 401, 400 `validation`, any other 4xx | the route refused or does not exist; nothing about the user is known | unavailable + warn |
| 5xx, unreachable, timeout, a 2xx body that does not parse | unknown, but nothing was written, so a retry is free | unavailable + warn |

## Freshness and concurrency

"Reflects `token_ledger`" means: the committed state of the user's row at the moment the one
`select` takes its snapshot.

- `balance` and `reserved` come from one statement, so from one committed version of the row. A
  reserve (`createInTransaction`: the users `UPDATE` and the ledger row in one transaction) is
  seen whole or not at all.
- A reserve committed before `POST /trading/intents` answered 201 is visible to the next read.
- A reserve still in flight is neither visible nor waited for: no lock clause is taken, and its
  `FOR NO KEY UPDATE` row lock does not block a plain `SELECT`.
- The answer is a point in time. `available` is not a reservation: the only reservation is
  `createInTransaction`'s CAS `token_balance - token_reserved >= 1`, which reads the same two
  columns.

**The invariant the read rests on.** `users.token_balance` / `token_reserved` are the cache of
`sum(balance_delta)` / `sum(reserved_delta)` over the user's `token_ledger` rows. Every writer in
the code today moves the cache in the same transaction as its ledger row:

- `createInTransaction` (reserve, `trade-intent-ops.ts`);
- `releaseTokens` (release, through `rejectIntent` / `rejectExpiredIntent`);
- `grantLinkBonus` (the starter pack, through `confirmBrokerAccount`, `link-bonus-ops.ts`).

`users_token_reserved_check` keeps `0 <= reserved <= balance` per statement.
`token-balance-ops.db.test.ts` checks that the cache equals the ledger sums after each of those
writers and under a concurrent burst of reserves. That equality is held by the writers, not by a
trigger. A new writer — purchases (#117), manual adjustments (#109), settlement (ARCH-04) — must
write its ledger row and the cache in one transaction, or this endpoint will be off by the
missing delta.

`reserved > balance` cannot pass the CHECK. If it is ever read, `toTradingAccessView` throws
rather than send a signed count. The caller gets the opaque 500 (`{ "error": "internal" }`), and
the log line carries the error's name.

## Running it locally

In a compose project of its own, on its own ports and volume, so it touches neither the
`binarius` stack nor its `pgdata` (the dev database). Only `backend` and the services it depends
on start, and both bot tokens are replaced with dummies: the backend polls `ADMIN_BOT_TOKEN`
itself (the staff bot), and a real token here would compete with the deployment that owns it.
With a dummy, that poller logs `the staff login bot stopped polling` and the backend stays up.
Nothing applies migrations when a container starts yet (#75). Run from the repository root, with
`.env` filled in:

```bash
dc() {
  COMPOSE_PROJECT_NAME=binarius-trading-access \
  POSTGRES_PORT=55432 REDIS_PORT=56379 BACKEND_PORT=53000 \
  ADMIN_BOT_TOKEN=local-only-admin-token TELEGRAM_BOT_TOKEN=local-only-public-token \
  docker compose "$@"
}
dc down -v   # a leftover volume from an earlier run would keep the users row
dc up --build --wait backend
dc exec -T backend pnpm db:migrate
INTERNAL_API_TOKEN="$(dc exec -T backend printenv INTERNAL_API_TOKEN)"
access() {
  printf 'Authorization: Bearer %s\n' "$INTERNAL_API_TOKEN" |
  curl -s -w '\nHTTP %{http_code}\n' -X POST "127.0.0.1:53000$1" \
    -H @- -H 'Content-Type: application/json' -d "$2"
}
access /trading/access '{"telegramUserId":"1"}'
# {"error":"user_not_found"}  HTTP 404 — no users row yet
access /users/start '{"telegramUserId":"1","displayName":"Ada"}' >/dev/null   # what /start sends
access /trading/access '{"telegramUserId":"1"}'
# {"status":"active","tokens":{"balance":"0","reserved":"0","available":"0"}}  HTTP 200
dc down -v   # removes this project's containers and its volume only
```

If 55432, 56379 or 53000 is taken, change it in `dc` (and 53000 in `access`).

## Boundaries

- **#137**: the `broker` section of this response (the balance snapshot and its ages) and
  `brokerAccountId?` in the request.
- **#138**: the pair catalog, `GET /trading/pairs`.
- **#24**: the bot's display and `BackendClient`.
- **#117, #109, ARCH-04**: future ledger writers, bound by the same-transaction rule above.
- `/users/start` and `/users/account` carry no balance, by design: their views stay allowlists
  without it.
