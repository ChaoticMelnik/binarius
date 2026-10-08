# Admin pages

Read-only pages for support and debugging, behind the staff login ([staff-login.md](staff-login.md)).
They change nothing: no page here writes to a table other than `staff_sessions` (the session touch)
and `audit_log` (the record of the view). #107 adds the overview, the user list with search, and
the user card; #108 adds the intents list and the intent card; #330 adds the trading sessions
list, the trading section of the user card and the breakdown of the overview by status; #109 adds
the token ledger list and the card's ledger section; #110 adds the audit log; deposits and the
broker accounts list (#341, #342) follow through the same mechanism.

## Mechanism

`apps/web` never talks to the database (`no-db-access.test.ts`); each page is one `GET` to the
backend under the staff session:

1. `web` reads the `admin_session` cookie. A cookie of the wrong shape counts as none: it is
   cleared and the browser goes to `/admin/login`, with no backend call (`withStaffSession`,
   `apps/web/src/admin/routes.ts`).
2. `web` calls the backend with the admin bearer (`ADMIN_WEB_TOKEN`) and `x-staff-session`.
3. The backend runs the read through `asStaff` (`apps/backend/src/admin/routes.ts`), the only way
   into `runAsStaff` (`packages/db/src/staff-ops.ts`). One transaction: touch the session (that
   is the liveness check), read, insert the `audit_log` row. If the insert fails, everything rolls
   back and nothing is answered — **no row, no data**.
4. `web` checks the answer against its strict schema (`packages/shared/src/admin.ts`): a key the
   contract does not name is a contract violation (500), not a silently dropped field.

The read functions (`packages/db/src/admin-read-ops.ts`, `admin-trading-ops.ts`, `admin-ledger-ops.ts`, `admin-audit-ops.ts`) take a `Tx`, not a `Db`, so the compiler
refuses a call outside a transaction. That a route's transaction is the one `asStaff` opens — and
so writes its row — is enforced by review only (see Boundaries).

The reads lock nothing: `users`, `broker_accounts`, `trade_intents`, `trading_sessions`,
`token_ledger`, `audit_log` and `staff` are read without `FOR …`, and the session touch is the only
`UPDATE`.

How `web` acts on a backend answer:

| Answer | Action |
|---|---|
| 401 `session_invalid` | clear the cookie, 302 to `/admin/login` |
| 401 `unauthorized` | our own bearer was refused: 500, cookie kept |
| 400 `validation` | `web` checked the query first, so the contract drifted: 500 |
| 404 `not_found` (user card) | 404 «Пользователь не найден»; the row is already written |
| 404 `not_found` (intent card) | 404 «Заявка не найдена»; the row is already written |
| anything else | 500, cookie kept, the error logged by name and code |

## Pages

Every page has the same nav (Сводка | Пользователи | Сессии сотрудников | Заявки | Торговые сессии |
Токены | Аудит) and the account block
(«login — Выйти»). The login shown is the one in the `me` of the backend answer the page was built
from; a page rendered without asking the backend (a refused search) shows no account block.
`GET /admin` redirects to `/admin/overview`; after a login the landing page is still
`/admin/sessions`. Timestamps are printed as the ISO instants the backend sent.

### Overview — `GET /admin/overview`

One `SELECT` with subqueries, so all the numbers come from one snapshot and agree with each other:

- users: total, new today, `status = blocked`, with at least one `active` broker account (each user
  counted once), and «active now»;
- trades: `trade_intents` rows, total and today, any status — what was created through the bot and
  the trading sessions. `broker_trades` holds only the trades the broker accepted and is not
  counted here;
- trades by status (#330): one count for each of the ten `TradeIntentStatus` values, in the order of
  the constant, a status with no rows included as 0, and «Активные (не в конечном статусе)» — the sum
  over the statuses outside `TERMINAL_TRADE_INTENT_STATUSES`. The breakdown is a subquery of the same
  `SELECT`, so it sums to the total.

**«Today» starts at 00:00 UTC by the database clock**
(`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`), whatever the session time zone.
The page prints that instant and the moment of the answer.

**«Active now» is a proxy, not presence**: users whose `users` row changed within the last
`ADMIN_ACTIVE_WINDOW_MINUTES` minutes. The answer carries the window, and the page prints the number
it received. What writes `users.updated_at`:

- `recordUserStart` — `/start` and `/settings` (`user-ops.ts`);
- `setDemoStake` (`user-ops.ts`);
- `markTelegramBlocked`, `markTelegramReachable`, `setNotificationLevel` (`delivery-ops.ts`);
- the token reserve on a new intent (`createInTransaction`), `releaseTokens` and `consumeTokens` —
  the settlement of a trade, which the worker runs, trading sessions included
  (`trade-intent-ops.ts`);
- `grantLinkBonus` (`link-bonus-ops.ts`);
- `upsertUser` on an OAuth login, insert only (`oauth-ops.ts`).

So a user whose session trade just settled counts as active without touching the bot. The
`$onUpdate` writers stamp the application clock and the window is measured by the database clock;
on one host they differ by milliseconds.

### Users — `GET /admin/users?q=&cursor=`

Newest first, `ADMIN_PAGE_SIZE` per page, keyset on `(created_at, id)`.

**Search is exact match only**, one field, `q` trimmed. The query is always compared with
`broker_accounts.broker_user_id` — a broker id can be any non-empty string, so the shape of the
query cannot rule it out — and, depending on its shape, with one more field:

| `q` looks like | also compared with | `by` in the audit row |
|---|---|---|
| a Telegram id (a positive integer, no leading zero, within `bigint`) | `users.telegram_user_id` | `telegram_user_id` |
| contains `@` | `broker_accounts.email`, case-insensitive | `email` |
| anything else | — | `broker_user_id` |

No `LIKE`: `%` and `_` are plain characters. The value goes to SQL as a parameter. A query of 1 to
`ADMIN_SEARCH_MAX_LENGTH` characters without control or invisible characters is accepted; a broker
id or an address longer than that cannot be found by this search.

**The cursor is a row id**, the id of the last row of the previous page. Its `created_at` is read
from the row, not carried in the URL: a JS date has milliseconds, `timestamptz` microseconds. The
next link appears only when one more row exists — a page of exactly `ADMIN_PAGE_SIZE` with nothing
after it has none. An id with no row gives an empty page, not an error (users are never deleted, so
only a hand-edited URL gets there).

Every list URL — the next and first links, the redirect, the request to the backend — is built by
one serializer, `adminUsersSearchParams` (`packages/shared/src/admin.ts`), so `q = 'a&b'` stays one
parameter.

### User card — `GET /admin/users/:id`

The `users` row and its `broker_accounts`, newest first. Sections:

- **Основное** — Telegram id, name, language, status, acquisition source and time, since when the
  bot cannot reach the user, notification level, demo stake (empty = «минимальная ставка
  брокера»), created and updated. The card only shows the notification level and the blocked
  time; what decides a send is still `deliverable()` (Rule 19).
- **Токены** — balance, reserved, available (`balance - reserved`, computed in `bigint`).
- **Брокерские аккаунты** — broker id, address (a blank one is shown as «—»), partner client,
  status, revocation reason, halt and its reason, token expiry and rotation, created and updated.
  The ciphertexts, the key id and the refresh-token hash are never selected.

- **Торговля** (#330) — «Всего заявок: N, активных: M» (active = not in a terminal status), the
  `ADMIN_USER_RECENT_INTENTS` newest intents of the user in the columns of the intents list (or
  «Заявок нет.»), and «Все заявки →»: the intents list filtered by this user, with its next pages.
  The section and the link are there also for a user without broker accounts. The recent intents are
  read by the list's own query, so their order is the list's.
- **Движения токенов** (#109) — the `ADMIN_USER_RECENT_LEDGER` newest `token_ledger` rows of the user
  in the columns of the token ledger list (or «Движений нет.»), and «Все записи →»: the list filtered
  by this user. Read by the list's own query. The section does not add its rows up: the balance is
  the one in «Токены», and the section is the newest rows, not all of them.
- **Аудит** (#110) — only a link, «Все события по пользователю →»: the audit log filtered by
  `entityType=user&entityId=<id>`. The card does not read `audit_log`.

The card is five `SELECT`s without a shared snapshot — the user, the accounts, the recent intents,
the two counters, the recent ledger rows: an account linked, an intent created or a ledger row
written in between may or may not show, and each answer was true at its moment — the balance in
«Токены» and the rows of «Движения токенов» can disagree by such a row. The sections are part of the
card's read: they write no row of their own (the one `user_viewed` row stays as it was).

### Intents — `GET /admin/intents?status=&mode=&user=&session=&cursor=`

`trade_intents`, newest first, `ADMIN_PAGE_SIZE` per page, keyset on `(created_at, id)` as on the
users page: one `SELECT` joined to `users` for the Telegram id. Each row links to the intent card
and, by its Telegram id, to the user card. Statuses, modes, directions and failure reasons are
printed as their codes.

**Filters are exact matches**, each optional, all of them combined:

| Parameter | Matches |
|---|---|
| `status` | one `TradeIntentStatus`, or `active` — every status that is not terminal, i.e. all but `settled` and `rejected` (`TERMINAL_TRADE_INTENT_STATUSES`, the same set the one-live-intent-per-account index uses) |
| `mode` | `demo` or `real` |
| `user` | the user's id (a uuid) |
| `session` | `trade_intents.trading_session_id` (a uuid) |

A `user` or `session` with no intents gives an empty page, not an error. **The cursor positions, it
does not filter**: the next page starts after the cursor row's `(created_at, id)` whether or not
that row passes the filters, and an id with no row gives an empty page. The form, the next and
first links, the redirect and the request to the backend all go through `adminIntentsSearchParams`
(`packages/shared/src/admin.ts`), in the order `status, mode, user, session, cursor`.

### Intent card — `GET /admin/intents/:id`

Every key of the intent's wire view: the 17 fields the bot sees (`GET /trading/intents/:id`) plus
three only staff navigate by — `userId` (a link to the user card), `tradingSessionId` (with
«Заявки этой сессии →», the list filtered by that session) and `reconcileClaimedAt`: when the
reconciliation pass last took the intent (its lease, #89); empty — never. `brokerAccountId` is
text. An empty value is shown as «—». The card reads any user's intent: it is behind the staff
session, not the bot's owner-scoped read.

### Trading sessions — `GET /admin/trading-sessions?cursor=`

`trading_sessions`, every one of them whatever the status of its account or user, newest first,
`ADMIN_PAGE_SIZE` per page, keyset on `(created_at, id)` as on the other lists: one `SELECT` joined to
`broker_accounts` and `users`. Columns: the session id with «Заявки →» (the intents list filtered by
this session), the owner's Telegram id (a link to the user card), the broker id, mode, status, stop
reason, then asset, duration, trades and base stake from `settings`, then started, ended and last
decision. Codes are printed as codes, an empty value as «—».

`settings` is parsed against v1 (`tradingSessionSettingsSchema`) at read, as the orchestrator and the
bot's view do: a row that does not parse — the column default `{}`, an extra key, another version —
is shown as «—» in all four settings columns. The raw `jsonb` never reaches the answer; the stake
scale is the sizer's parameter and is not shown.

No filters and no per-session trade counters. With a running orchestrator the active sessions are
on the first page: a session ends within `SESSION_MAX_DURATION_MS` of its start, unless the worker
is down or its sweep falls behind — then an active session can be older and further down the list.
A session's trades are its intents, one link away.

The next and first links, the redirect and the request to the backend go through
`adminTradingSessionsSearchParams` (`packages/shared/src/admin.ts`).

### Token ledger — `GET /admin/tokens?user=&kind=&cursor=`

`token_ledger`, newest first, `ADMIN_PAGE_SIZE` per page, keyset on `(created_at, id)` as on the
other lists: one `SELECT` joined to `users` for the Telegram id. Columns: the time of the row, the
owner's Telegram id (a link to the user card), the kind as its code, the change of the balance and
of the reserve, the reference, the note. The changes are the stored `bigint`s printed with their
sign (`release` and `settle` move the reserve down, an `adjustment` either way); nothing is computed
from them. A note is printed as text, an empty one as «—».

**Основание** is the one reference a row may carry (`token_ledger_reference_check`): an intent is a
link to its card; a deposit and a broker account are printed as their ids (they have no page yet); a
manual reference as `manual:<id>`; a row with none (an `adjustment` without one) shows «—».

**Filters are exact matches**, each optional, both combined:

| Parameter | Matches |
|---|---|
| `kind` | one `TokenLedgerKind` (`purchase`, `bonus`, `reserve`, `release`, `settle`, `adjustment`) |
| `user` | the user's id (a uuid) |

A `user` with no rows, or with no row at all, gives an empty page, not an error. The cursor
positions, it does not filter, as on the intents list. The form, the next and first links, the
redirect and the request to the backend go through `adminTokensSearchParams`
(`packages/shared/src/admin.ts`), in the order `user, kind, cursor`.

What the page shows on production: the reserve of every intent and its `release` or `settle`, and
the starter `bonus` of a linked account (with the account id). `purchase` (#117) and `adjustment`
(#246) have no writer yet. The page only shows rows: it does not compare their sum with the cached
balance in `users` — keeping that equal is the writers' rule (Rule 2), not something a view checks.

### Audit log — `GET /admin/audit?action=&entityType=&entityId=&actorId=&from=&to=&cursor=`

`audit_log`, newest first, `ADMIN_PAGE_SIZE` per page, keyset on `(created_at, id)` as on the other
lists: one `SELECT` left-joined to `staff` for the actor's login (`listAuditForAdmin`,
`packages/db/src/admin-audit-ops.ts`). Columns: the time of the row; who — the staff login, else the
raw `actor_id`, else «—», then `actor_type` as its code; the action as its code; the entity — its type
as a code and its id; the payload.

**Filters are exact matches**, each optional, all of them combined:

| Parameter | Schema | Matches |
|---|---|---|
| `action` | one `AuditAction` | `action = $1` |
| `entityType` | one `AuditEntityType` | `entity_type = $1` |
| `entityId` | a uuid | `entity_id = $1` |
| `actorId` | a uuid | `actor_id = $1` |
| `from` | `YYYY-MM-DD` | `created_at >= ($1::date)::timestamp at time zone 'UTC'` |
| `to` | `YYYY-MM-DD`, not before `from` | `created_at < (($1::date + 1)::timestamp) at time zone 'UTC'` |

**Dates are whole UTC days by the database clock, both bounds inclusive**, whatever the session time
zone: `from = to` is one day, from 00:00:00 UTC to the last microsecond before the next midnight. The
two selects of the form list the values of the constants (`packages/shared/src/audit.ts`), in their
order, after an empty «любое»/«любой». `actorId` has no field: it comes from a row's «все события →»
link, and the page then shows «Сотрудник: <id> — сбросить» and keeps it in a hidden field.

**Links from a row** go only where the target accepts the value: «все события →» only for an
`actor_id` that is a uuid (`actor_id` is free text — the CLI may write anything, a NULL writes
nothing), the entity id links to the user card for `user` and to the intent card for
`trade_intent`, and only when there is an id; anything else is text. A disabled staff member is still
shown by login — this is history, not access; a `user` actor would get a login only if its uuid
matched a staff id.

**The payload is a preview**: the first `ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS` (1 024) characters of
`payload::text`, cut in SQL (`left()`, characters, not bytes), and «(обрезано)» after it when the text
is longer. The `jsonb` itself never reaches the backend process or the answer: a `bot_text_saved` or
`bot_text_reset` row carries two bot texts of up to `BOT_TEXT_SOURCE_MAX` characters each (#299), and
fifty of them would make a page megabytes long. Every other writer's payload fits in the preview
whole. The text is Postgres's canonical `jsonb` output, not what the writer sent: keys in `jsonb`
order (shorter first), a space after `:` and `,` — `{"ip": "1.2.3.4", "err": {"name": "E"}}`. It is
printed as text in a `<code>` block. The full text of a bot text is in `bot_text_overrides` and the
`bot-text` CLI.

**The page records itself**: every request — the first page, «Далее», each filter — writes its own
`audit_log_viewed` row, after the `SELECT` and in the same transaction (`runAsStaff`). So a page never
shows its own row; the next request shows the previous one on top. The keyset cursor is the id of the
last row shown, so the rows written above it do not shift «Далее»: no repeat, no gap. Hide the views
with a filter (`action=…` of something else); they are not hidden by default.

The form is serialized by the browser (fields in DOM order, the empty ones as `key=`, which `web`
drops); the next and first links, the reset link, the redirect and the request to the backend go
through `adminAuditSearchParams` (`packages/shared/src/admin.ts`), in the order `action, entityType,
entityId, actorId, from, to, cursor`. The cursor positions, it does not filter, as on the intents
list; an id with no row gives an empty page.

## Audit actions

Each view writes one row with `actor_type = 'admin'` and `actor_id` = the staff id. Payload keys are
named and bounded; nothing else is recorded.

| Page | `action` | `entity` | `payload` |
|---|---|---|---|
| overview | `overview_viewed` | — | `{ path: '/admin/overview' }` |
| users | `users_viewed` | — | `{ path: '/admin/users', q?, by?, cursor? }` — a key only when the parameter was given |
| user card, found | `user_viewed` | `user`, the id | `{ path: '/admin/users/:id', result: 'found', userId }` |
| user card, a uuid with no row | `user_viewed` | — | `{ path, result: 'not_found', userId }` |
| user card, an id that is not a uuid (direct backend call) | `user_viewed` | — | `{ path, result: 'not_found' }` — arbitrary input is not recorded |
| intents | `intents_viewed` | — | `{ path: '/admin/intents', status?, mode?, userId?, tradingSessionId?, cursor? }` — a key only when the parameter was given; `tradingSessionId` rather than `sessionId`, which names a staff session in `staff_sessions_viewed` |
| intent card, found | `intent_viewed` | `trade_intent`, the id | `{ path: '/admin/intents/:id', result: 'found', intentId }` |
| intent card, a uuid with no row | `intent_viewed` | — | `{ path, result: 'not_found', intentId }` |
| intent card, an id that is not a uuid (direct backend call) | `intent_viewed` | — | `{ path, result: 'not_found' }` |
| trading sessions | `trading_sessions_viewed` | — | `{ path: '/admin/trading-sessions', cursor? }` — `cursor` only when given |
| token ledger | `tokens_viewed` | — | `{ path: '/admin/tokens', userId?, kind?, cursor? }` — a key only when the parameter was given |
| audit log | `audit_log_viewed` | — | `{ path: '/admin/audit', action?, entityType?, entityId?, actorId?, from?, to?, cursor? }` — a key only when the parameter was given; every value is an enum, a uuid or a date |

The card's trading and ledger sections and the overview's breakdown are parts of `user_viewed` and
`overview_viewed`; they add no row and no payload key.

## Boundaries

What `web` refuses before asking the backend, with no row:

- a session cookie of the wrong shape → cleared, 302 to login;
- a search query outside the schema (too long, a control character, `q` given twice) → 400 with
  the form and the message, whatever the cursor says;
- an intents filter outside the schema (an unknown status or mode, a `user` or `session` that is
  not a uuid — a value of blanks included —, a parameter given twice) → 400 with the form and the
  message, whatever the cursor says;
- a token ledger filter outside the schema (an unknown kind, a `user` that is not a uuid — a value
  of blanks included —, a parameter given twice) → 400 with the form and the message, whatever the
  cursor says;
- an audit filter outside the schema (an unknown action or entity type, an `entityId` or `actorId`
  that is not a uuid — a value of blanks included —, a date that is not `YYYY-MM-DD`, `from` after
  `to`, a parameter given twice) → 400 with the form and the message, whatever the cursor says;
- a cursor that is not a uuid, or given twice → 302 to the same search, filters or list without it;
- a user or intent card id that is not a uuid → 404.

An empty value (`q=`, or `status=` from the form's empty option) is no parameter: the whole list. Unknown query keys (`utm_*`, a
bookmark's leftovers) are dropped on both sides.

What the backend refuses before the session, with no row: a bad bearer (401 `unauthorized`), a
session token of the wrong shape (401 `session_invalid`), a list query outside the schema (400
`validation`). A card id that is not a uuid is checked *inside* the session, so the attempt leaves a
row, without the id.

Not enforced by code: a new route in `apps/backend/src/admin/routes.ts` must go through `asStaff`.
The `Tx` parameter guarantees a transaction, not the audit row; a route opening `db.transaction`
around these reads directly is caught only in review.

## Limits

- `ADMIN_PAGE_SIZE` rows per page, `ADMIN_SEARCH_MAX_LENGTH` characters per query,
  `ADMIN_ACTIVE_WINDOW_MINUTES` for «active now» — all in `packages/shared/src/admin.ts`.
- No rate ceiling on these reads, as on `/admin/sessions`: `web` is a trusted process behind the
  bearer, and the sessions are staff sessions.
- `users`, `trade_intents`, `trading_sessions` and `token_ledger` have no index on
  `(created_at, id)`; the lists and the overview scan them. The intents filters `user` and `session`
  and the card's trading section use `trade_intents_user_id_idx` and `trade_intents_session_id_idx`;
  the token ledger filter `user` and the card's ledger section use `token_ledger_user_created_idx`;
  the order is still a sort. Assumed: up to 100 000 users, 1 000 000 intents, 100 000 trading
  sessions and 1 000 000 ledger rows (two per trade) on the pilot. If `explain analyze` of a list or
  the overview passes 200 ms at those sizes, add a `(created_at, id)` index in its own migration.
- The backend request timeout (`BACKEND_REQUEST_TIMEOUT_MS`) covers each page: at most five
  `SELECT`s (the user card).
- The audit log: `audit_log_created_at_idx` serves the order and the dates, `audit_log_entity_idx`
  the filter by entity (the link from the user card); `action` and `actorId` have no index and scan.
  Assumed: up to 1 000 000 rows; if `explain analyze` of a page passes 200 ms there, add an index on
  `(action, created_at desc, id desc)` in its own migration. Each row of a page costs a
  `payload::text` of its `jsonb` for the preview.
- A row's payload on the page is at most `ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS` characters (≤ 4 096
  bytes), so a page of the audit log stays within ≈ 225 KB whatever the writers stored.
- Every view writes one `audit_log` row that is never deleted — viewing the audit log included, so
  the log grows with each look at it. Retention is #153.

## Running it locally

From a clean volume, with a real `ADMIN_BOT_TOKEN` (the login needs the Telegram confirmation):

1. `docker compose down -v`, then `docker compose up --build --wait`.
2. `docker compose exec backend pnpm db:migrate`.
3. Create an account and log in as in [staff-login.md](staff-login.md) → Bringing it up the first
   time, steps 5–8.
4. A clean volume has no users. Create one through the bot's own route, with a name that is markup,
   and give it a broker account (the ciphertexts are placeholders; no page decrypts them):
   ```bash
   # INTERNAL_API_TOKEN: the value from .env
   curl -sS -X POST http://127.0.0.1:3000/users/start \
     -H "authorization: Bearer $INTERNAL_API_TOKEN" -H 'content-type: application/json' \
     -d '{"telegramUserId":"1","displayName":"Ada <b>"}'
   docker compose exec postgres psql -U binarius -d binarius -c "insert into broker_accounts
     (user_id, broker_user_id, email, status, access_token_enc, refresh_token_enc, token_key_id,
     access_token_expires_at) select id, 'seed-broker-1', 'Ada@Example.com', 'active',
     '\x00'::bytea, '\x00'::bytea, 'seed', now() from users where telegram_user_id = 1"
   ```
5. Open `http://127.0.0.1:3001/admin` (→ the overview), then the users page, and search for
   `ada@example.com` (found despite the case), `seed-broker-1` and `1`. The name shows as
   `Ada <b>`, as text. Open the card: the account, the address, «минимальная ставка брокера».
   Search for 257 characters: 400, the form, no «Выйти».
   Then give the user two finished intents, one of them in a stopped trading session. Only terminal
   rows, with no reserve: nothing has to be written to `token_ledger`, the account is not «in work»
   for any process, and nothing moves these rows:
   ```bash
   docker compose exec -T postgres psql -U binarius -d binarius <<'SQL'
   with a as (select id, user_id from broker_accounts where broker_user_id = 'seed-broker-1'),
   s as (
     insert into trading_sessions (broker_account_id, mode, status, stop_reason, ended_at, settings)
     select id, 'demo', 'stopped', 'rejected_twice', now(),
       '{"version":1,"assetId":1,"durationSec":60,"trades":5,"stake":{"baseStake":"1","stakeScale":0}}'
     from a returning id)
   insert into trade_intents (broker_account_id, user_id, trading_session_id, mode, asset_id, amount,
     action, duration_sec, client_request_id, status, tokens_reserved, last_error)
   select a.id, a.user_id, s.id, 'demo', 1, '1.00000000'::numeric, 'up', 60, 'seed-1', 'rejected', 0,
     'broker_rejected' from a, s
   union all
   select a.id, a.user_id, null::uuid, 'demo', 1, '2.00000000'::numeric, 'down', 60, 'seed-<b>',
     'rejected', 0, 'expired' from a;
   SQL
   ```
   Open «Заявки»: two rows, newest first. `?status=active` — «Заявок нет» (both are finished);
   `?status=rejected&mode=demo` — both. The card of `seed-1`: «Заявки этой сессии →» lists one row.
   The card of `seed-<b>`: the request id as text, no session and no session link. The user card:
   «Торговля» — «Всего заявок: 2, активных: 0», both rows, and «Все заявки →» lists both.
   `?status=bogus` — 400, the form, no «Выйти»; `/admin/intents/not-a-uuid` — 404.
   Then add a second stopped session with the column's default settings, which are not v1. It is
   terminal: neither the orchestrator nor its sweep reads it, both take only `status = active`:
   ```bash
   docker compose exec postgres psql -U binarius -d binarius -c "insert into trading_sessions
     (broker_account_id, mode, status, stop_reason, ended_at) select id, 'demo', 'stopped',
     'invalid_settings', now() from broker_accounts where broker_user_id = 'seed-broker-1'"
   ```
   Open «Торговые сессии»: two rows. One has asset, duration, trades and stake `1`, `60`, `5`, `1`
   and the reason `rejected_twice`; the other has «—» in those four columns and `invalid_settings`.
   «Заявки →» of the first lists one row, of the second «Заявок нет.». The overview, «По статусам»:
   `rejected` 2, every other status 0, «Активные» 0 (on a volume with no other intents).
   Then give the user two ledger rows — a starter bonus naming the account and a manual adjustment
   with a note that is markup — and move the cached balance by their sum, so the cache still equals
   the ledger (Rule 2). Separate statements, so each row has its own `now()`:
   ```bash
   docker compose exec postgres psql -U binarius -d binarius -c "insert into token_ledger
     (user_id, kind, balance_delta, reserved_delta, broker_account_id) select u.id, 'bonus', 10, 0,
     a.id from users u join broker_accounts a on a.user_id = u.id
     where a.broker_user_id = 'seed-broker-1'"
   docker compose exec postgres psql -U binarius -d binarius -c "insert into token_ledger
     (user_id, kind, balance_delta, reserved_delta, note) select id, 'adjustment', -3, 0,
     'seed <script>' from users where telegram_user_id = 1"
   docker compose exec postgres psql -U binarius -d binarius -c "update users
     set token_balance = token_balance + 7 where telegram_user_id = 1"
   ```
   Open «Токены»: two rows, the adjustment first, `-3` with its sign, «—» in «Основание», the note
   `seed <script>` as text; the bonus with the account id. `?kind=bonus` — one row. The user card:
   «Токены» — balance 7; «Движения токенов» — both rows, and «Все записи →» opens the list filtered
   by this user. `?kind=bogus` — 400, the form, no «Выйти».
   Then the audit log. Open «Аудит» twice: the second page shows the first one's `audit_log_viewed`
   on top, its payload `{"path": "/admin/audit"}`. `?action=audit_log_viewed` — only those. From the
   user card, «Все события по пользователю →» (`?entityType=user&entityId=<id>`): the `user_viewed`
   rows. `?from=<today>&to=<today>` (UTC) — today's rows; `?action=bogus` — 400, the form, no
   «Выйти». Then a bot text row too long to show, written directly (the action is in the CHECK; the
   table takes only inserts):
   ```bash
   docker compose exec postgres psql -U binarius -d binarius -c "insert into audit_log
     (actor_type, action, entity_type, payload) values ('system', 'bot_text_saved', 'bot_text',
     jsonb_build_object('key', 'k', 'oldText', repeat('я', 20000), 'newText', 'x'))"
   ```
   Open «Аудит»: the row on top, «—» and `system` in «Кто», its payload cut with «(обрезано)».
6. Check what was written:
   ```bash
   docker compose exec postgres psql -U binarius -d binarius \
     -c "select action, entity_type, payload from audit_log order by created_at desc limit 8"
   ```
   Raise the limit to see the whole walk. Among the rows: `user_viewed` with entity `user`, three
   `users_viewed` with `q` and `by` = `telegram_user_id`, `broker_user_id` and `email`, one
   `users_viewed` with only `path`, and `overview_viewed`; `intents_viewed` with `status`, `mode`,
   `tradingSessionId` or `userId` — each only on its own request —, `intent_viewed` with entity
   `trade_intent`, `trading_sessions_viewed` with only `path`, and `tokens_viewed` with `kind` or
   `userId` — each only on its own request; `audit_log_viewed` with `action`, with `entityType` and
   `entityId`, or with `from` and `to` — each only on its own request; still one `user_viewed` per
   opening of the card. The refused 257-character search, `?status=bogus`, `?kind=bogus`,
   `?action=bogus` and the card id that is not a uuid wrote nothing.
7. `docker compose down -v` when done.
