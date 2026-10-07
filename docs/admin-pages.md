# Admin pages

Read-only pages for support and debugging, behind the staff login ([staff-login.md](staff-login.md)).
They change nothing: no page here writes to a table other than `staff_sessions` (the session touch)
and `audit_log` (the record of the view). #107 adds the overview, the user list with search, and
the user card; #108–#110 add their sections and pages through the same mechanism.

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

The read functions (`packages/db/src/admin-read-ops.ts`) take a `Tx`, not a `Db`, so the compiler
refuses a call outside a transaction. That a route's transaction is the one `asStaff` opens — and
so writes its row — is enforced by review only (see Boundaries).

The reads lock nothing: `users`, `broker_accounts` and `trade_intents` are read without `FOR …`,
and the session touch is the only `UPDATE`.

How `web` acts on a backend answer:

| Answer | Action |
|---|---|
| 401 `session_invalid` | clear the cookie, 302 to `/admin/login` |
| 401 `unauthorized` | our own bearer was refused: 500, cookie kept |
| 400 `validation` | `web` checked the query first, so the contract drifted: 500 |
| 404 `not_found` (user card) | 404 «Пользователь не найден»; the row is already written |
| anything else | 500, cookie kept, the error logged by name and code |

## Pages

Every page has the same nav (Сводка | Пользователи | Сессии) and the account block
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
  counted here; the breakdown by status is #108.

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

The user and the accounts are two `SELECT`s without a shared snapshot: an account linked in between
may or may not show, and either answer was true at its moment.

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

## Boundaries

What `web` refuses before asking the backend, with no row:

- a session cookie of the wrong shape → cleared, 302 to login;
- a search query outside the schema (too long, a control character, `q` given twice) → 400 with
  the form and the message, whatever the cursor says;
- a cursor that is not a uuid → 302 to the same search without it;
- a card id that is not a uuid → 404.

An empty `q=` (an emptied search box) is no query: the whole list. Unknown query keys (`utm_*`, a
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
- `users` and `trade_intents` have no index on `created_at`; the list and the overview scan them.
  Assumed: up to 100 000 users and 1 000 000 intents on the pilot. If `explain analyze` of the list
  or the overview passes 200 ms at those sizes, add a `(created_at, id)` index in its own migration.
- The backend request timeout (`BACKEND_REQUEST_TIMEOUT_MS`) covers each page: at most three
  `SELECT`s.

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
6. Check what was written:
   ```bash
   docker compose exec postgres psql -U binarius -d binarius \
     -c "select action, entity_type, payload from audit_log order by created_at desc limit 8"
   ```
   Among them: `user_viewed` with entity `user`, three `users_viewed` with `q` and `by` =
   `telegram_user_id`, `broker_user_id` and `email`, one `users_viewed` with only `path`, and
   `overview_viewed`. The refused 257-character search wrote nothing.
7. `docker compose down -v` when done.
