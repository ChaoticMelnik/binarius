# Service accounts

A service account is a connected broker account an admin marked to carry the broker's price stream
(#391). Without `user.auth` the broker answers `price.subscribe` with `user.auth.error` and sends no
`price.update` (checked on the pilot 2026-10-09), so the stream needs an account's token; #404 opens
its data socket on a service account and fails over to the next one. This document covers the mark,
the keeper that renews their tokens and the alert when fewer than three work.

Owner's decisions (2026-10-09, confirmed for real mode 2026-10-16): a service account may trade, in
demo and real, without any guard (Q1); it is marked from the admin, there is no separate login (Q2);
the minimum is the constant `SERVICE_ACCOUNTS_MIN = 3` (Q3); the staff bot hears about changes only
(Q4); the mark survives a revocation and a re-login (Q5). The first one is `dimmelya@gmail.com`.

## The mark

`broker_accounts.service_since timestamptz NULL` (migration `0053_service_accounts`): `NULL` is an
ordinary account; a timestamp is the mark and its date, which also orders the service accounts for
#404. Its one writer is `setServiceMark` (`packages/db/src/service-account-ops.ts`), one conditional
`UPDATE`:

- a mark sets `service_since = now()` only where it is `NULL` → `marked`;
- a removal sets it to `NULL` only where it is set → `unmarked`;
- a repeat of either changes nothing → `unchanged` (a re-mark keeps the first date); an unknown id
  → `not_found`.

Nothing else on the row changes: not the status, the tokens, `token_rotated_at` or the halt. A
revocation (`revokeAccount`, `revokeAccountIfUnchanged`) and a re-login (`linkBrokerAccount`, by
e-mail or OAuth) do not touch the column, so a revoked service account that its user logs in again
is working again on the keeper's next tick.

The admin marks and unmarks (docs/admin-pages.md → Service accounts): «Сделать служебным» on the
user card and the broker accounts list, «Снять» there and on «Служебные аккаунты». The backend
routes, both through `asStaff`:

| Route | Answer | `audit_log` |
|---|---|---|
| `GET /admin/service-accounts` | `{ me, min, working, accounts }` — every marked account, working or not, oldest mark first, each with `working` and `notWorkingReason` | `service_accounts_viewed { path }` |
| `POST /admin/broker-accounts/:id/service` `{ service: true }` | `{ me, outcome, account }`, `outcome` `marked` or `unchanged`; 404 for an unknown id | `broker_account_service_set`, entity `broker_account` + id, `{ path, result, accountId }` |
| the same with `{ service: false }` | `outcome` `unmarked` or `unchanged` | `broker_account_service_cleared`, the same shape |

An id that is not a uuid is answered 404 inside the session and recorded without the id
(`{ path, result: 'not_found' }`); a body other than `{ service: boolean }` is a 400 before the
session, with no row.

**Lock order (Rule 5).** The mark runs in `runAsStaff` without `lockStaff`: it touches the caller's
own `staff_sessions` row, then its `UPDATE` takes the `broker_accounts` row. No writer takes
`broker_accounts` before a staff table (`grep -ln "staffSessions\|staff_sessions"
packages/db/src/*.ts`: `staff-ops.ts` writes, the admin read ops only read, none touches
`broker_accounts`), so there is no cycle. The keeper takes `broker_accounts FOR NO KEY UPDATE`
through the token service only and never locks `users`.

## Working

One SQL fragment, `serviceAccountWorkingSql`, is the definition: marked, `broker_accounts.status =
'active'`, `users.status = 'active'` and `access_token_expires_at > now()` by the database clock.
`listServiceBrokerAccounts(db)` (the #404 contract: `{ id, brokerUserId, serviceSince }`, oldest mark
first, ties by id), the keeper's count and the admin page all read it. A marked account that is not
working has one reason, in the token service's order of checks:

| Reason | When | The alert and the page say |
|---|---|---|
| `user_blocked` | the user is blocked (whatever the account's state) | «пользователь заблокирован» |
| `pending` | linked by OAuth, not confirmed in the bot | «не подтверждён в боте» |
| `revoked` | revoked, with its `auth_revoked_reason` | «отозван (refresh_outcome_unknown)» |
| `token_expired` | active, the access token expired | «токен истёк» |

## The keeper

`createServiceAccountKeeper` (`apps/backend/src/broker/service-accounts.ts`), one per backend
process, built in `index.ts` with the token service's `accessToken` and the staff bot's
`notifyStaff`. `start()` runs after `listen()` with the other loops; a tick every
`SERVICE_ACCOUNTS_TICK_MS`, single-flight (a tick longer than the interval makes the next one a
no-op). Each tick:

1. **Renewals.** `listServiceRenewalCandidates`: marked, active, the user active, the token expiring
   within `SERVICE_TOKEN_RENEW_AHEAD_MS`, `coalesce(token_rotated_at, created_at)` older than
   `SERVICE_TOKEN_ROTATION_GAP_MS`, the held-back ones excluded, soonest expiry first, at most
   `SERVICE_RENEWALS_PER_TICK`. One after another:
   `accessToken(id, { mayRefresh: true, serviceOnly: true, renewAheadMs })`.
2. **The count** (`listServiceAccountStates`) and, when it changed below the minimum, the alert.
3. **One `info` line** `service accounts tick` with `{ marked, working, min, candidates, renewed,
   refused, held, below, alerted }`.

Every ending of an attempt:

| Ending | The row | The queue |
|---|---|---|
| `ok` (exchanged, or another caller had rotated it first) | the pair's expiry as the broker answered (7 days), `token_rotated_at` of that exchange — the keeper's or the earlier caller's | leaves the window; `renewed` |
| `refresh_rate_limited` | nothing (the pair is intact) | ends this tick's renewals — the limit is per IP, the next account would get it too; first again next tick |
| `account_revoked` (`refresh_outcome_unknown`, `refresh_invalid_grant`, `refresh_expired`, `storage_inconsistent`) | `revoked` by the token service | leaves the set; `refused`, a `warn` with the reason; the count of the same tick sees it |
| `user_blocked` after the exchange (blocked while it ran) | the rotated pair is stored | leaves the set by the `users` predicate |
| `not_service`, `user_blocked`, `account_pending`, `account_not_found` | nothing | leaves the set; `info` with the reason |
| `key_unavailable` (a key rollout; the token service warns) | nothing | held back `SERVICE_STALLED_RETRY_MS` |
| a throw (database, a bug) | nothing | `error` by name and code, held back `SERVICE_STALLED_RETRY_MS`, the next candidate goes on |
| `stop()` between two candidates | — | the rest is skipped and no alert is sent; an exchange under way completes (≤ `BROKER_HTTP_TIMEOUT_MS`) |

### The alert

The keeper remembers, in process memory, what the staff last heard: `{ below, working }`, nothing at
start. It sends:

- **below** — when `working < SERVICE_ACCOUNTS_MIN` and either nothing was heard yet in this process,
  or the last state was not below, or the number changed: «Служебных аккаунтов брокера в работе: 1
  из минимум 3 (отмечено: 3).», then «Не в работе:» and one line per account «— <address or broker
  id>: <reason>»;
- **restored** — when the count reaches the minimum after a below: «Служебные аккаунты брокера
  восстановлены: в работе 3 из минимум 3.»;
- nothing otherwise. A process started at or above the minimum is silent; one started below says so
  once.

The message goes to every active staff member through the staff bot (`AdminBot.notifyStaff`: plain
text, one `sendMessage` after another, each bounded by `ADMIN_TELEGRAM_API_TIMEOUT_MS` and by the
keeper's stop signal). The state is stored when at least one member got it, or when there is no
active staff member at all (one `warn` `no active staff to alert`); when every send failed it is not,
so the next tick tries again. A line `service accounts alert` with `{ kind, working, marked, sent,
failed }` follows each attempt. No token, no account id and never the text are logged.

## Constants

`apps/backend/src/timing.ts` → «The service accounts (#391)»; the chain is checked at import:

| Constant | Value | Bounds |
|---|---|---|
| `SERVICE_ACCOUNTS_TICK_MS` | 60 000 | the keeper's period |
| `SERVICE_TOKEN_RENEW_AHEAD_MS` | 86 400 000 | how long before its expiry a token is exchanged: a 429 leaves a day of retries a minute apart (the token lives 7 days, docs/binodex-oauth.md) |
| `SERVICE_TOKEN_ROTATION_GAP_MS` | 3 600 000 | at most one timer exchange an hour per account, whatever lifetime the broker answers |
| `SERVICE_RENEWALS_PER_TICK` | 5 | exchanges a tick |
| `SERVICE_STALLED_RETRY_MS` | 300 000 | the hold-back after `key_unavailable` or a throw |
| `SERVICE_ACCOUNTS_MIN` | 3 | `packages/shared/src/service-accounts.ts` |

The chain: `SERVICE_RENEWALS_PER_TICK × BROKER_HTTP_TIMEOUT_MS < SERVICE_ACCOUNTS_TICK_MS <
SERVICE_STALLED_RETRY_MS < SERVICE_TOKEN_ROTATION_GAP_MS < SERVICE_TOKEN_RENEW_AHEAD_MS`, and
`ADMIN_TELEGRAM_API_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS` (`stop()` waits for one send in flight;
`BROKER_HTTP_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS` already holds for one exchange). Exchanges are
outside the per-minute GET shares (`BROKER_BUDGET_HOLDS` is unchanged): at most five a minute in the
worst case, about one per service account every six days in practice.

## Start and shutdown

The keeper starts after `listen()` with the other loops and stops in phase 1 of the shutdown: the
current tick finishes its exchange in flight, sends nothing more, and `stop()` resolves.

## The Rule 12 exception

A timer never exchanges a token (docs/binodex-oauth.md → Refresh), with this one exception decided
by the owner: the keeper exchanges a service account's token by its age. It holds because
`ensureFreshAccessToken` checks the mark itself, under the row lock and after the status checks:
`serviceOnly: true` on a row with `service_since IS NULL` answers `not_service` with nothing
decrypted, exchanged or written (`token-service.db.test.ts` V1) and before the refused-token branch,
so an unmarked row's token is never marked expired (V6), and the keeper's candidate list
never names an unmarked account (`service-accounts.db.test.ts` K2, `service-account-ops.db.test.ts`
O6). The SQL list is an optimisation; the lock is the guarantee. Both options are read only when
`mayRefresh` is not `false` (V5), and the worker's `POST /trading/accounts/:id/access-token` has no
`serviceOnly` in its body, so no other caller can ask for it. The failure rules are the common ones:
one attempt, a 429 keeps the pair, any other failure that may have spent it revokes the account.

## Limits

- No index on `service_since`: the keeper scans `broker_accounts` once a minute (twice — the
  candidates and the count). Assumed: up to 3 000 accounts and 10 service accounts on the pilot; if
  `explain analyze` of `listServiceBrokerAccounts` passes 50 ms, add a partial index on
  `(service_since, id) where service_since is not null` in its own migration.
- The admin page is not paged: every marked account in one answer (`web`'s size row assumes at most
  50).
- At most 20 staff members are assumed for a broadcast (20 × 3 s, abortable at shutdown).

## Accepted risks

1. **A failed timer exchange revokes a trading account** (Q1, real mode included): a
   `refresh_outcome_unknown` or a 401 on the exchange revokes the whole row. An active real session
   stops as `account_unavailable` on its next attempt; an open real trade still closes at the
   broker, and its result is written by the settlement catch-up once the user logs in again by
   e-mail (until then the catch-up's token is refused and the account is held back), the reserve
   held until that write; the mark survives, so after that re-login the account counts as working
   again on the next tick; when the revocation leaves fewer than `SERVICE_ACCOUNTS_MIN` working, the
   staff bot names the account and the reason on the same tick.
2. **A 401 on a call in flight at the rotation instant**, if the broker invalidates the old access
   token on a refresh (not verified): about once every six days per service account, a day before the
   token would have expired anyway; the refused-token path (#281) restarts the consumer with the
   new token. Falsifiable: a worker `warn` `refused token reported` on a service account within a
   minute of a tick line with `renewed ≥ 1`.
3. **The alert state is process memory**: a restart below the minimum repeats the message once; a
   crash between the change and the message loses nothing — the next tick sees the state again.
4. **No reminder**: an operator who missed the message sees the state on the page and in every
   tick line.
5. **The renewal window uses the process clock** against a database-written expiry, as the 60 s skew
   does; inside a 24 h window a few seconds either way are harmless. The candidate list uses the
   database clock.
6. **A shortened `expires_in`**: if the broker ever answers a lifetime under an hour, the rotation gap
   lets the account fall to `token_expired` between exchanges, and the alert says so.

## Boundaries

- The keeper reads no `DEMO_ONLY` (Rule 33): a token exchange moves no money.
- The keeper never opens a trade, a socket or a session; the price stream is #404's.
- No email login from the admin (Q2) and no settings table (Q3).

## Running it locally

On a migrated database with a staff member whose dev staff bot is polling (staff-login.md →
Bringing it up the first time) and the backend and web running:

1. Give a user a broker account (the ciphertexts are placeholders, so its key id is not the
   process's and the keeper will hold it back rather than exchange it):
   ```bash
   curl -sS -X POST http://127.0.0.1:3000/users/start \
     -H "authorization: Bearer $INTERNAL_API_TOKEN" -H 'content-type: application/json' \
     -d '{"telegramUserId":"391","displayName":"Service"}'
   psql "$DATABASE_URL" -c "insert into broker_accounts (user_id, broker_user_id, email, status,
     access_token_enc, refresh_token_enc, token_key_id, access_token_expires_at, token_rotated_at)
     select id, 'seed-service-1', 'service@example.com', 'active', '\x00'::bytea, '\x00'::bytea,
     'seed', now() + interval '3 days', now() - interval '2 hours' from users
     where telegram_user_id = 391"
   ```
2. Open `http://127.0.0.1:3001/admin/users`, find `service@example.com`, open the card and press
   «Сделать служебным». On the next tick (about a minute) the staff bot sends «Служебных аккаунтов брокера в работе: 1
   из минимум 3 (отмечено: 1).»; «Служебные аккаунты» shows «В работе 1 из минимум 3 (отмечено 1)».
3. Make its token due:
   ```bash
   psql "$DATABASE_URL" -c "update broker_accounts set access_token_expires_at = now() + interval '1 hour'
     where broker_user_id = 'seed-service-1'"
   ```
   The next tick line has `candidates: 1, held: 1` and the token service warns `account is
   encrypted under another key, leaving it untouched`: the keeper asked, under the row lock, and
   nothing was written.
4. Press «Снять»: the next tick sends «… в работе: 0 из минимум 3 (отмечено: 0).» (0 is a change)
   and then nothing.
5. The checks the pilot uses, against the local database:
   ```bash
   psql "$DATABASE_URL" -c "select email, status, service_since, access_token_expires_at, token_rotated_at from broker_accounts where service_since is not null"
   psql "$DATABASE_URL" -c "select action, entity_type, payload from audit_log where action like 'broker_account_service%' or action = 'service_accounts_viewed' order by created_at desc limit 5"
   ```

## Running it on the pilot (the owner's step)

After the deploy, the first tick (a minute after the backend starts) finds no service account and
tells every active staff member once: «Служебных аккаунтов брокера в работе: 0 из минимум 3
(отмечено: 0).» A process started below the minimum says so once (The alert). Then: admin →
«Пользователи» → search `dimmelya@gmail.com` → the card → «Брокерские аккаунты» → «Сделать
служебным». On the next tick (about a minute) every active staff member gets «Служебных аккаунтов
брокера в работе: 1 из минимум 3 (отмечено: 1).» This is expected until two more are marked. An
account that is not working is listed under «Не в работе:» with its reason. «Служебные аккаунты»
shows the account. «Токен до» is the current token's expiry, up to 7 days ahead: the mark rotates
nothing. On the server:

```bash
docker compose logs --since 3m backend | grep -E 'service accounts tick|service accounts alert'
docker compose exec -T postgres psql -U binarius -d binarius -c "select email, status, service_since, access_token_expires_at, token_rotated_at from broker_accounts where service_since is not null"
docker compose exec -T postgres psql -U binarius -d binarius -c "select action, entity_type, payload from audit_log where action like 'broker_account_service%' or action = 'service_accounts_viewed' order by created_at desc limit 5"
```

The first automatic exchange comes on the first tick inside the last 24 h before that expiry. That
is the next tick if less than a day is left or the token has already expired, though never within
an hour of the token's last rotation. It shows as a tick line with `renewed: 1`, `token_rotated_at`
moved and «Токен до» about 7 days ahead.
