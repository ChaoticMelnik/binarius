# Staff login to the admin pages

How a person who works here gets into `apps/web`'s admin pages, what each step is allowed to
do, and what is written down. Issue #68.

## The flow

1. **The password.** `POST /admin/login` on the web process takes the form, and the web process
   calls `POST /admin/auth/login` on the backend with its own bearer, plus the address and the
   user agent it saw. The backend looks the login up case-insensitively, derives scrypt, and —
   if the password was right — opens a *challenge*: one row in `staff_login_challenges` that is
   valid for five minutes.
2. **The button.** The backend's staff bot sends that person a message naming the account, the
   address, the browser and the time, with **«Подтвердить вход»** and **«Это не я»**. Pressing
   the first issues a six-digit code and sends it; pressing the second closes the attempt and
   records it — and nothing else: the password stays valid (Limits).
3. **The code.** `POST /admin/login/confirm` sends the code to `POST /admin/auth/confirm`. The
   challenge id travels in a cookie; `web` forwards it only if it matches `UUID_PATTERN`, and the
   backend's schema reads it with that same pattern, so a value `web` lets through is never
   refused as malformed. Should the two drift anyway, `web` logs the backend's `400 validation`
   as an error, drops the cookie and starts the form over with «Подтверждение истекло, войдите
   снова» — the same as a `410`. On a match the backend creates a row in `staff_sessions` and answers with a token, which the web
   process puts in an `HttpOnly` cookie. The token itself is stored nowhere: the row holds its
   SHA-256.
4. **Every request after that** re-reads the session row inside the transaction that also does
   the work and writes the audit entry. There is no cache, which is what makes a revoke visible
   to the very next request.

A session lives **24 hours** at most, and dies after **60 minutes** with no admin request.

## Logging in by a link from the bot (#448)

A second way in, beside the password and the code — not instead of it (owner's decision
2026-10-10): the password flow stays as the fallback for when the bot is unreachable.

1. **`/start`.** The staff bot looks the sender up by the Telegram account the update came from
   (`findStaffByTelegram`, one index lookup). An active staff member gets «Войти в админку».
   Everyone else — nobody's account, or a disabled one — gets one refusal, «Доступа нет», with
   the sender's own Telegram id and no button: the same text for both, so the answer says
   nothing about whether an account exists, and the id is still how the first setup learns it
   (Bringing it up the first time, step 5).
2. **The button** (`sl:l`, no id in it). `issueLoginLink` takes the `staff` row of the account
   the update came from `FOR NO KEY UPDATE`, supersedes the staff member's previous unused link,
   and inserts a new row in `staff_login_links`: 32 random bytes as base64url, of which only the
   SHA-256 is stored, valid for **5 minutes** by the database's clock. The bot sends
   `<WEB_PUBLIC_URL>/admin/login/link/<token>` as a plain-text message with the link preview
   disabled, then answers the button. A password lockout (`locked_until`) does not shut this
   path (owner's answer В4).
3. **Opening it.** `GET /admin/login/link/<token>` on `web` checks the token against
   `STAFF_LOGIN_LINK_TOKEN_PATTERN` and asks `POST /admin/auth/link/inspect`: a single SELECT
   that spends nothing and writes no row, so Telegram's preview, a messenger's prefetch or a
   browser's prerender cannot use the link up. A live link shows a page with «Войти»; a used, an
   expired or an otherwise dead one shows its refusal (410).
4. **«Войти».** The page's form posts back to the same path. The POST passes the `Origin` check
   every POST of `web` passes (#241), and `POST /admin/auth/link/complete` spends the link in one
   CAS: the link is still `issued`, inside its five minutes, and its owner is active. On a match
   the backend creates a `staff_sessions` row — the same writer as the code login
   (`insertStaffSession`), the same 24 hours / 60 minutes — and `web` sets the same cookie and
   goes to `/admin/sessions`. The token reaches the backend in the request body, never in a path.

A link is single-use: the second open of a link that logged someone in says «Ссылка уже
использована» however late it is. A press of the button supersedes the previous link
(«Ссылка недействительна»); the CLI's `disable` and `reset-password` and a staff member's own
password change revoke an unused one in the same transaction as the rest (Accounts). Revoking one
session from the sessions page does not touch links: that is one session, not the credentials.

Accepted:

- The link is one factor — the staff member's Telegram account — without the password (owner's
  decisions 1–2). Whoever holds that Telegram session can log in within five minutes of a press;
  `staff disable` is the way to stop it.
- The link stays in the Telegram chat and passes Telegram's servers. After a login or five
  minutes it is dead.
- A reverse proxy's access log, if it is on (Caddy on the pilot), records the path with the
  token. `web` logs no request line (`disableRequestLogging`); the repository has no proxy
  configuration, so turning that log off or filtering it is the deployer's step. A logged token is
  dead after its use or its five minutes.
- `staff_login_link_issued` is written before the message is sent. When the send fails the row
  is there and nobody got the link: the `warn` line says so, and the next press supersedes it.
- Rows are not swept: their number is the number of presses. Falsifiable: fewer than 1000 presses
  a day across the staff; above that, a sweep like the challenges' `CHALLENGE_RETENTION`.
- A timeout between `web` and the backend after the commit leaves the link used and no cookie set:
  a retry answers «уже использована» and the staff member presses the button again; the orphan
  session dies after 60 minutes idle — as with `completeLogin`.

## Trust boundaries

| Boundary | What crosses it | What is checked |
|---|---|---|
| browser → `apps/web` | the form, the cookies, the login link's token in the path | zod on every field; the link's token by `STAFF_LOGIN_LINK_TOKEN_PATTERN` before the backend is asked, and its GET spends nothing — only the POST behind «Войти» does; `Origin` on every POST — the pages send `Referrer-Policy: same-origin`, under which the browser puts the real Origin on its own form POSTs (under `no-referrer` it sends `Origin: null`, which is refused — #241); `SameSite=Lax`, `HttpOnly`, `Secure` when the origin is https |
| `apps/web` → `apps/backend` | `Authorization: Bearer $ADMIN_WEB_TOKEN`, `X-Staff-Session` | the bearer opens `/admin/*` and nothing else; the session is checked in the database on every request |
| `apps/backend` → Telegram | the invitation, the code, the login link | a bounded call; a refusal closes the challenge, so nobody waits out the window |
| Telegram → `apps/backend` | the button press | a CAS that joins `staff` on the Telegram account the update came from — the id in the button authorises nothing |
| Telegram → `apps/backend` | `/start`, the login link button (#448) | the staff member is the one whose `telegram_user_id` is the update's sender; nothing in the button names anyone. Only the sender's own account can be asked about, and every refusal is one text |

`ip` and `userAgent` are what the web process saw, and the backend records them as given. Behind
a reverse proxy that is the proxy's address until `trustProxy` is configured (#4).

`apps/web` holds no database connection. That is not tidiness: everything it may read is decided
by a staff session the backend checks inside the transaction that records the read, so a direct
query from there would be a read with no audit row behind it. `no-db-access.test.ts` keeps it so.

## Configuration

| Variable | Where | What it is |
|---|---|---|
| `ADMIN_BOT_TOKEN` | `backend` | **A second bot**, from @BotFather. Not `TELEGRAM_BOT_TOKEN`: the backend reads both — it sends the push after an OAuth login (#128) on the public bot's token without polling it — and refuses to start when they are equal. What that check prevents: one value in both is two pollers on one bot — Telegram answers `getUpdates` with 409 to the one it terminates, grammY rethrows 409 instead of retrying it (`grammy/out/bot.js`), and that poller stays dead; which of the two it is, is Telegram's to decide, and the two outcomes differ. If the loser is the public bot, its process logs the failure — the error's name, not its 409, is what `errorLogFields` carries there — and calls `exit(1)` (`apps/bot/src/lifecycle.ts`; under compose's `tsx watch` the container stays up anyway, #65), while the staff poller goes on working on the public bot's token and out of the public bot's chats: that branch does not fail closed. If the loser is the staff poller, the backend logs `the staff login bot stopped polling` with the 409, stays healthy with `isPolling()` false, and every admin login answers `503 telegram_unavailable` with a `polling_down` row — closed, and indistinguishable from a bad token (see «When Telegram is not reachable»). Either way the whole symptom is one line in one of the two logs. |
| `ADMIN_WEB_TOKEN` | `backend`, `web` | The narrow shared secret between them. The backend refuses to start when it equals `INTERNAL_API_TOKEN`: the bearer comparator is the same on both sides, so one value in both would open the whole internal API to `web`. |
| `WEB_PUBLIC_URL` | `web`, `backend` | The origin the pages are served from — these and the Mini App login pages (#114, binodex-oauth.md → The Mini App pages). The backend reads it with the same parser for the login link its staff bot sends (#448), and refuses to start without it; compose gives both services the same value and default, tied by a test. Checked against the `Origin` header on every POST, and decides whether the cookie may be `Secure`; compose also derives the default `BROKER_OAUTH_REDIRECT_URI` from it, so it is spelled exactly `scheme://host[:port]` — no whitespace, control or invisible format characters (a CRLF `.env` leaves a `\r`), `/`, `?`, `#`, `\`, `%`, `@` or dot-segments (compose appends `/oauth/callback` to it; `web` refuses to start otherwise). Scheme and host case, a default or zero-padded port, IPv4 shorthand and IDNA mapping of the host are accepted and normalised. Default `http://127.0.0.1:3001`. Called `ADMIN_PUBLIC_URL` before #114: compose refuses to start while the old name is still set in `.env` (the `init` guard on `web` in compose.yaml), so a stale name cannot fall back to the loopback default silently. |
| `WEB_PORT` | compose | Host port for the pages, `127.0.0.1` only. Change it together with `WEB_PUBLIC_URL` — a test ties the two defaults, because a mismatch makes every form submission a 403. |

Both tokens are REQUIRED: compose refuses to start while either is empty, and a CI step checks
that each is required on its own.

## Accounts

Created from a CLI in the backend container, never from the environment — who did what is only
answerable while every login belongs to someone. The generated password is printed once. On a
migrated database: nothing in the stack applies migrations on start yet (#75), so a volume that
has never been migrated answers `relation "staff" does not exist` (see «Bringing it up the first
time» below, or `pnpm db:migrate` from the host).

```bash
docker compose exec backend pnpm --filter @binarius/backend staff create \
  --login ada --telegram-id 123456789 --name "Ада"
docker compose exec backend pnpm --filter @binarius/backend staff reset-password --login ada
docker compose exec backend pnpm --filter @binarius/backend staff disable --login ada
```

`disable` and `reset-password` invalidate everything issued under the old credentials in one
transaction, in the order `staff → challenges → links → sessions`: open challenges are closed,
unused login links (#448) revoked and live sessions revoked, so a challenge or a link issued a
moment earlier cannot still walk through to a session. The CLI prints the three counts.

A login already in flight neither slips past that nor breaks it. The two serialize on the
challenge row `completeLogin` holds until it commits — or the link row `completeLinkLogin` holds:
either the CLI closes that row first and the login, once it stops waiting, finds it closed under
it, or the CLI waits there and afterwards sees the session the login committed. The revocation is stamped with
`clock_timestamp()` rather than `now()` for that second case: `now()` is the transaction's start,
a session committed by a login that began later carries a `created_at` after it, and
`staff_sessions_revoked_after_created_check` would reject that, aborting the whole operation and
leaving the account exactly as it was (#149).

Every CHECK that orders a stamp against a `created_at` written by an earlier transaction (the
sessions' `last_seen`/`revoked`, the challenges' `confirmed`/`prompt_sent`/`code_sent`) also
assumes the database clock never steps backwards between the two. A production kernel clock does
not; the Colima VM a Mac runs the compose Postgres in does, which is why the local integration
tests run against a native Postgres on the host instead (README → Test database, #166).

## Changing your own password

`POST /admin/auth/password` (#78) runs under the staff session like every other admin request.
The body is `currentPassword`, `newPassword` and the client facts: both passwords 1–256
characters, the new one different from the current one — `adminChangePasswordRequestSchema`, one
schema for the backend and for the web page that calls it (#79). Three phases, as at login:

1. **A read** by the session token (`findStaffForPasswordChange`): the hash, and the lockout if one
   is running. It is outside any transaction and writes no row, like the login's lookup: the KDF
   runs next, and holding rows through it is what the login refuses to do. A lockout running at
   this point is read again inside the transaction that records it: still running —
   `429 too_many_attempts` with no derivation and a `locked` row carrying that reading; just
   ended — no row, and the request goes on to the KDF. That refusal is recorded outside
   `runAsStaff`, like `recordLoginLockout` at login: it does no work under the session, and the
   session id in the row is the pre-read's.
2. **One slot in the scrypt queue.** On entering it the row is read again: a lockout or a reset
   that landed while the request waited refuses it with no derivation. The current password is
   verified against the hash of the first read, the row is read once more, and only if it is
   still the same is the new password hashed. So once the fifth failure has committed, every guess
   in flight — right or wrong — answers `429 too_many_attempts` after at most one derivation (none
   when the lockout landed while the request waited for its slot), as the login
   form answers `401` in the same case: a stolen cookie learns nothing faster than the login form
   does. The one exception is a correct guess whose new hash was already being derived when the
   lockout committed: it answers the same `429` after two derivations (Limits).
   `PASSWORD_CHANGE_DERIVATIONS` sizes the derivations against `ADMIN_LOGIN_BUDGET_MS` in
   `timing.ts`.
3. **A transaction** (`runAsStaff` with `lockStaff`) that takes the `staff` row first, then touches
   the session, then runs `applyStaffPasswordChange`: a CAS on the hash the KDF verified, with the
   account active and not locked. On success the new hash is written, the failure counter and the
   lockout are cleared, open challenges are closed, unused login links are revoked, and every other
session of the staff member
   that is not revoked and still within its absolute lifetime — idle-expired ones included, the
   CLI's definition — is revoked with `revoked_by_staff_id` set to the staff member. The session
   that made the change stays, so its cookie stays valid. The answer is
   `{ changed: true, revokedSessions }`, the number of those revoked sessions.

A wrong current password is a wrong password at login. It counts in the same
`failed_password_attempts` and the same lockout (`countPasswordFailure`), so a stolen session
cookie is no faster an oracle for the password than the login form, and five wrong — in either
place — lock both. It answers `401 invalid_credentials`. A lockout that lands between the last
re-read and the transaction is caught by the CAS and answers `429` with a `locked` row. A reset or
a disable in that window revokes the changing session, so the transaction's touch finds no live
session: `401 session_invalid`, no row. `state_changed` is reached only by a concurrent change from
the same session (`401`, a `state_changed` row). Neither the lockout nor the change counts
anything — there is nothing left to count against.

The lock order is the CLI's, `staff` first. A change and a CLI reset, two changes from two devices,
or a change and a revoke of the changing session from another device serialize on the `staff` row
instead of deadlocking on two session rows; the second one finds its session revoked and answers
`401 session_invalid`. `POST /admin/sessions/:id/revoke` takes the same lock. Two sessions of
different staff members revoking each other are not ordered by it (#151).

Nothing is sent to Telegram. Resetting another staff member's password stays the CLI's
`staff reset-password`: there are no roles yet.

The page is `/admin/password` ([admin-pages.md](admin-pages.md) → Сменить пароль): the current
password and the new one twice; `apps/web` refuses a mismatch and the shared schema before the
backend is asked, and never renders or logs the values.

## What is written down

Every login attempt that reached the password check, every button press that matched a challenge,
and every admin request performed under a live session writes a row in `audit_log`, in the same
transaction as the thing it records: no row, no data (`runAsStaff`, `startLoginChallenge`,
`completeLogin`, the Telegram CASes, `issueLoginLink`, `completeLinkLogin`). Refusals before that
point leave no row: a route ceiling
(429), a malformed body (400), a full scrypt queue (429), a session token of the wrong shape or a
session that is not live (401), a password change refused before its transaction (a token of the
wrong shape, a session the pre-read finds not live, a body outside the schema, a full scrypt
queue), a session id, or a user or intent card id, that is not a uuid,
or a password form whose two entries differ or fail the schema (400),
which `apps/web` refuses before the backend is asked, and a search query, a list filter or an
audit filter outside its schema (400), which `apps/web` also refuses before asking. The login link
(#448) adds to those: its GET (inspect), a link token of the wrong shape (404 at `web`, 400 at the
backend), a token nobody was issued, and the bot's refusal of a sender who is nobody's account —
those go to the process log only (owner's answer В5: rows are about known staff members). The
bot's refusal of a known disabled account is written after its reply has gone, so the reply takes
the same time either way. The actions are a closed list (`AuditAction`, enforced
by `audit_log_action_check`), and the payloads hold only named keys — never a password, a code,
a token, a raw error object, or the login someone typed for an account that does not exist.

| Event | `action` |
|---|---|
| CLI create / disable / reset-password | `staff_created` / `staff_disabled` / `staff_password_reset` |
| unknown login, disabled account, wrong password, state changed under the KDF | `staff_login_failed` |
| refused because the account is locked out | `staff_login_locked` |
| password accepted, challenge opened or reused | `staff_login_password_ok` |
| Telegram would not take the invitation or the code | `staff_login_telegram_failed` |
| «Подтвердить вход» | `staff_login_telegram_confirmed` |
| «Это не я» | `staff_login_denied` |
| wrong or unusable code | `staff_login_code_failed` |
| session created | `staff_login_completed` |
| sessions listed | `staff_sessions_viewed` |
| session revoked, or a revoke that found nothing | `staff_session_revoked` |
| logout | `staff_logout` |
| overview opened | `overview_viewed` |
| users listed or searched | `users_viewed` |
| user card opened, or an id that found nothing | `user_viewed` |
| intents listed or filtered | `intents_viewed` |
| intent card opened, or an id that found nothing | `intent_viewed` |
| trading sessions listed | `trading_sessions_viewed` |
| token ledger listed or filtered | `tokens_viewed` |
| deposits listed or filtered | `deposits_viewed` |
| broker accounts listed or filtered | `broker_accounts_viewed` |
| token adjustment applied or refused (#246) | `token_adjusted` |
| audit log listed or filtered | `audit_log_viewed` |
| own password changed | `staff_password_changed` |
| own password change refused: wrong current password, locked out, state changed under the KDF | `staff_password_change_failed` |
| login link sent by the bot (#448) | `staff_login_link_issued` |
| login link refused: the bot to a disabled account (`reason: disabled`, `via: start` or `button`), the per-staff limit (`rate_limited`), or a link opened that is `used`, `expired`, `superseded` or `revoked`, or whose owner is disabled (`disabled`); `state_changed` when the CAS missed a link the re-read still finds usable, which nothing in this feature produces | `staff_login_link_refused` |
| session created from a login link | `staff_login_link_completed` |

The read pages behind the session, and what each of their rows carries, are in
[admin-pages.md](admin-pages.md).

## Limits

Per process, because one backend replica is what the deployment runs; the lockout is per account
and lives in the database.

- 120 login requests and 300 confirm requests per minute, taken before the body is read; for
  the login link, 300 inspect and 120 complete requests per minute, the same way.
- 5 login links per staff member per 15 minutes; the sixth press answers with an alert and a
  `rate_limited` row.
- 5 attempts per unknown login name per 15 minutes.
- 5 wrong passwords — at login or in the change form — lock the account for 15 minutes. The
  counter is written after the derivation, not before it: `PASSWORD_VERIFY_CONCURRENCY +
  PASSWORD_VERIFY_QUEUE_MAX` (2 + 8, `timing.ts`) derivations can be in flight and queued against
  one account at once, and the queue hands a slot back in its `finally` — before
  `registerPasswordFailure` (in the change form, `countPasswordFailure`) runs, which the route calls
  only after `queue.run` has returned — so arrivals that keep coming can start more. The lock
  lands when the fifth recorded failure commits; how many guesses were *tried* by then is bounded
  by the queue's throughput, not by five. A correct password arriving under the lock is still
  refused. The refusal under a running lockout — at login or in the change form — re-reads the
  lockout in the transaction that records it; a lockout that ended in between is not a refusal.
  Once the lockout has committed, a change request already in flight is refused with the
  same `429` in the same time whatever its password was, except the correct guess caught mid-hash
  above (accepted: at most `PASSWORD_VERIFY_CONCURRENCY` such requests at once).
- 5 wrong codes exhaust the challenge.
- At most 2 scrypt slots at once, at most 8 waiting, at most 2 s of waiting. A password change
  holds its slot for two reads of the `staff` row and up to two derivations; those two reads are
  bounded by the pool's `query_timeout`, not by the timing chain. Over any of those limits the
  request is refused with 429 and no derivation runs.

«Это не я» closes that challenge and records the press; it changes nothing on the account — the
password hash, the status, the failure counter and the lockout stay as they were
(`denyChallengeFromTelegram`). The same password therefore opens a new challenge on the next
attempt, until an operator runs `staff reset-password` or `staff disable`, or the staff member
changes the password themselves; a login is still
protected by the second factor, which only ever reaches the account's own Telegram.

Accepted, not fixed: while a challenge is open and its invitation delivered, a second login with
the correct password from another device reuses it silently — there is no second message, so
«Это не я» is available only from the first one. If the second login arrives while the first
invitation is still in flight — before `prompt_sent_at` is written, which happens after the
commit that created the challenge — it sends a second, identical invitation; and if that second
send fails while the first succeeded, the challenge is closed as `failed` although a message was
delivered: the button in it then answers «stale», and the next login opens a new challenge.
Either way the attacker gets a `challengeId`, which is useless without the code, and the code is
only ever delivered to the account's own Telegram.

## When Telegram is not reachable

Fail closed. The gate is asked on every login — including one that reuses a challenge already
open, and including one whose invitation has already gone out, where nothing is owed to Telegram
at all. If long polling is not running, or the Bot API refuses the message, the challenge is
closed and the login answers `503 telegram_unavailable` with a row saying which of the two it was.

There is one exception, and it is not a hole: a challenge whose button has already been pressed is
not closed. The code is in Telegram already and typing it back needs no poller, so the login
answers `200` with the same `challengeId`, and the `staff_login_telegram_failed` row carries
`closed: false` to say the gate ran and found the challenge had moved on.

There is no fallback second factor. A bad `ADMIN_BOT_TOKEN` therefore leaves the backend running
and healthy while nobody can open a new login to the admin pages — deliberately, and visible in
the log as one `error` line at startup.

## Bringing it up the first time

The automated suite is the only evidence this feature has: nothing in it has been run against the
real Telegram. The first person to deploy it should walk this through once.

1. **Create the bot.** In @BotFather, `/newbot`, and keep the token. It must be a different bot
   from the public one.
2. **Configure.** In `.env`:
   ```
   ADMIN_BOT_TOKEN=<the token from BotFather>
   ADMIN_WEB_TOKEN=<openssl rand -hex 32>
   ```
   Leave `WEB_PUBLIC_URL` and `WEB_PORT` at their defaults for a local run.
3. **Start.** `docker compose up --build --wait`. Then
   `curl -fsS http://127.0.0.1:3001/admin/login | grep -q '<form'` should succeed — the command
   CI's *the admin pages answer* step polls with, and a CI step checks this section still carries
   it — and the backend log should **not** contain `the staff login bot stopped polling`. `--wait` says nothing about the schema: the backend is
   healthy on an empty database, which is what the next step is for.
4. **Apply the migrations.**
   ```bash
   docker compose exec backend pnpm db:migrate
   ```
   It prints `migrations applied successfully!`. Nothing in the stack applies them on start yet
   (#75), so on a volume that has never been migrated — a fresh clone, a new deployment — step 6
   would otherwise fail with `relation "staff" does not exist`. The command is idempotent, so
   running it on an already-migrated volume is a no-op.
5. **Learn your Telegram ID.** Send `/start` to the new bot. It answers «Доступа нет» with your
   own id.
6. **Create an account**, with that id:
   ```bash
   docker compose exec backend pnpm --filter @binarius/backend staff create \
     --login ada --telegram-id <the id from step 5> --name "Ада"
   ```
   Copy the password it prints.
7. **Log in.** Open `http://127.0.0.1:3001/admin/login`, enter the login and that password. The
   bot should send the invitation naming your login and address.
8. **Press «Подтвердить вход».** The bot sends a six-digit code; enter it. The sessions page
   should open and list your own session as «текущая».
9. **Log in by the link** (#448). Log out, send `/start` again — the bot now offers «Войти в
   админку». Press it: the bot sends a link without a preview. Open it, press «Войти», and the
   sessions page opens. Open the same link again: «Ссылка уже использована».
10. **Check the refusal path.** Log out, start a login again, and this time press **«Это не я»**.
   The code page should send you back to the login form saying the confirmation expired, and
   `audit_log` should hold a `staff_login_denied` row:
   ```bash
   docker compose exec postgres psql -U binarius -d binarius \
     -c "select action, payload from audit_log order by created_at desc limit 5"
   ```

If step 7 or 8 fails while steps 3 and 4 were clean, the shape of our Bot API calls is what to
look at: it is the one thing the test suite cannot check.
