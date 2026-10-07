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
3. **The code.** `POST /admin/login/confirm` sends the code to `POST /admin/auth/confirm`. On a
   match the backend creates a row in `staff_sessions` and answers with a token, which the web
   process puts in an `HttpOnly` cookie. The token itself is stored nowhere: the row holds its
   SHA-256.
4. **Every request after that** re-reads the session row inside the transaction that also does
   the work and writes the audit entry. There is no cache, which is what makes a revoke visible
   to the very next request.

A session lives **24 hours** at most, and dies after **60 minutes** with no admin request.

## Trust boundaries

| Boundary | What crosses it | What is checked |
|---|---|---|
| browser → `apps/web` | the form, the cookies | zod on every field; `Origin` on every POST; `SameSite=Lax`, `HttpOnly`, `Secure` when the origin is https |
| `apps/web` → `apps/backend` | `Authorization: Bearer $ADMIN_WEB_TOKEN`, `X-Staff-Session` | the bearer opens `/admin/*` and nothing else; the session is checked in the database on every request |
| `apps/backend` → Telegram | the invitation and the code | a bounded call; a refusal closes the challenge, so nobody waits out the window |
| Telegram → `apps/backend` | the button press | a CAS that joins `staff` on the Telegram account the update came from — the id in the button authorises nothing |

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
| `WEB_PUBLIC_URL` | `web` | The origin the pages are served from — these and the Mini App login pages (#114, binodex-oauth.md → The Mini App pages). Checked against the `Origin` header on every POST, and decides whether the cookie may be `Secure`; compose also derives the default `BROKER_OAUTH_REDIRECT_URI` from it, so it is spelled exactly `scheme://host[:port]` — no whitespace, control or invisible format characters (a CRLF `.env` leaves a `\r`), `/`, `?`, `#`, `\`, `%`, `@` or dot-segments (compose appends `/oauth/callback` to it; `web` refuses to start otherwise). Scheme and host case, a default or zero-padded port, IPv4 shorthand and IDNA mapping of the host are accepted and normalised. Default `http://127.0.0.1:3001`. Called `ADMIN_PUBLIC_URL` before #114: compose refuses to start while the old name is still set in `.env` (the `init` guard on `web` in compose.yaml), so a stale name cannot fall back to the loopback default silently. |
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
transaction, in the order `staff → challenges → sessions`: open challenges are closed and live
sessions revoked, so a challenge created a moment earlier cannot still walk through to a session.

A login already in flight neither slips past that nor breaks it. The two serialize on the
challenge row `completeLogin` holds until it commits: either the CLI closes that challenge first
and the login, once it stops waiting, finds it closed under it, or the CLI waits there and
afterwards sees the session the login committed. The revocation is stamped with
`clock_timestamp()` rather than `now()` for that second case: `now()` is the transaction's start,
a session committed by a login that began later carries a `created_at` after it, and
`staff_sessions_revoked_after_created_check` would reject that, aborting the whole operation and
leaving the account exactly as it was (#149).

Every CHECK that orders a stamp against a `created_at` written by an earlier transaction (the
sessions' `last_seen`/`revoked`, the challenges' `confirmed`/`prompt_sent`/`code_sent`) also
assumes the database clock never steps backwards between the two. A production kernel clock does
not; the Colima VM a Mac runs the compose Postgres in does, which is why the local integration
tests run against a native Postgres on the host instead (README → Test database, #166).

There is no way to change a password from the UI yet — that is a follow-up issue.

## What is written down

Every login attempt that reached the password check, every button press that matched a challenge,
and every admin request performed under a live session writes a row in `audit_log`, in the same
transaction as the thing it records: no row, no data (`runAsStaff`, `startLoginChallenge`,
`completeLogin`, the Telegram CASes). Refusals before that point leave no row: a route ceiling
(429), a malformed body (400), a full scrypt queue (429), a session token of the wrong shape or a
session that is not live (401), and a session id that is not a uuid, which `apps/web` refuses
before the backend is asked. The actions are a closed list (`AuditAction`, enforced
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

## Limits

Per process, because one backend replica is what the deployment runs; the lockout is per account
and lives in the database.

- 120 login requests and 300 confirm requests per minute, taken before the body is read.
- 5 attempts per unknown login name per 15 minutes.
- 5 wrong passwords lock the account for 15 minutes. The counter is written after the derivation,
  not before it: `PASSWORD_VERIFY_CONCURRENCY + PASSWORD_VERIFY_QUEUE_MAX` (2 + 8, `timing.ts`)
  derivations can be in flight and queued against one account at once, and the queue hands a slot
  back in its `finally` — before `registerPasswordFailure` runs, which the route calls only after
  `queue.run` has returned — so arrivals that keep coming can start more. The lock lands when the
  fifth recorded failure commits; how many guesses were *tried* by then is bounded by the queue's
  throughput, not by five. A correct password arriving under the lock is still refused.
- 5 wrong codes exhaust the challenge.
- At most 2 scrypt derivations at once, at most 8 waiting, at most 2 s of waiting. Over any of
  those the request is refused with 429 and no derivation runs.

«Это не я» closes that challenge and records the press; it changes nothing on the account — the
password hash, the status, the failure counter and the lockout stay as they were
(`denyChallengeFromTelegram`). The same password therefore opens a new challenge on the next
attempt, until an operator runs `staff reset-password` or `staff disable`; a login is still
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
5. **Learn your Telegram ID.** Send `/start` to the new bot. It answers with your own id.
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
9. **Check the refusal path.** Log out, start a login again, and this time press **«Это не я»**.
   The code page should send you back to the login form saying the confirmation expired, and
   `audit_log` should hold a `staff_login_denied` row:
   ```bash
   docker compose exec postgres psql -U binarius -d binarius \
     -c "select action, payload from audit_log order by created_at desc limit 5"
   ```

If step 7 or 8 fails while steps 3 and 4 were clean, the shape of our Bot API calls is what to
look at: it is the one thing the test suite cannot check.
