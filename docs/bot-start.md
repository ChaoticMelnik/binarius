# /start and the welcome screen

The bot's first screen (#22): who the user is, where they came from, and the one action the
screen offers — connecting a Binodex account. Linking itself is described in
[binodex-oauth.md](binodex-oauth.md); this document stops at the authorize URL.

## Components

- `packages/shared/src/users.ts` — the contract: `UserStatus`, the start-payload and language-tag
  patterns, and the request/response schemas of `POST /users/start`.
- `packages/db/src/user-ops.ts` — `recordUserStart` (one upsert plus the account check) and
  `toUserStartView` (the allowlisted projection).
- `apps/backend/src/users/routes.ts` — `POST /users/start`, behind the internal bearer.
- `apps/bot/src/` — `env.ts`, `timing.ts`, `backend-client.ts`, `texts.ts`, `logging.ts`,
  `bot.ts` (the handlers), `lifecycle.ts` (start, signals, drain), `index.ts` (wiring), and
  `testing.ts`, the fixtures the suites share.

The bot never opens a database connection: everything it knows comes from the backend's internal
API over a shared bearer.

## Sequence

```text
/start [payload]
  bot  → POST /users/start { telegramUserId, displayName, languageCode?, startPayload? }
  back → { user: { telegramUserId, status, acquisitionSource, acquiredAt, hasActiveBrokerAccount } }
  bot  → blocked                  → "Доступ ограничен", no button
         hasActiveBrokerAccount   → "С возвращением", no button
         otherwise                → welcome (video caption when configured) + "Подключить аккаунт"

tap "Подключить аккаунт"
  bot  → answerCallbackQuery ∥ POST /auth/binodex/start { telegramUserId }
  back → { authorizeUrl, state, expiresAt }
  bot  → message with a url button pointing at authorizeUrl
```

What happens after the user opens that URL belongs to #32 (the login page that receives the
authorization code) and #23 (the confirmation and the message that reports its outcome).

## First touch

`users.acquisition_source` holds the raw `/start` payload, and `users.acquired_at` the database
clock at the moment it was recorded. Both are written **once**, on the first `/start` that
carries a usable payload:

- a `/start` with no payload writes neither, so an organic first visit does not spend the slot;
- a later `/start` with a payload fills them in;
- every `/start` after that leaves them as they are, including one with a different payload;
- linking, confirming or revoking a broker account never touches them.

A payload is usable when it matches `START_PAYLOAD_PATTERN` (`^[A-Za-z0-9_-]{1,64}$`, the format
Telegram documents for start parameters). Anything else — too long, a space, a plus sign,
Cyrillic — is treated as no payload at all, without an error message: the user did not compose
the link. The bot stores the string as it arrived; splitting it into campaign fields belongs to
whoever generates the links. Referral prefixes are #31.

The same rule is enforced twice, in `startPayloadSchema` and in the CHECK constraint
`users_acquisition_source_check`, which is generated from the same regex source. The two engines
are not the same engine, so `packages/db/src/user-ops.db.test.ts` runs one corpus of strings
through both and compares the verdicts row by row. `users_acquisition_pair_check` keeps the pair
whole: a source without a time, or a time without a source, is rejected by the database.

## POST /users/start

Internal route, `Authorization: Bearer <INTERNAL_API_TOKEN>`, same as the trading and login
routes. Request and response are validated by `@binarius/shared/users`.

| Field            | Notes                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `telegramUserId` | decimal string, the shared `telegramUserIdSchema`                     |
| `displayName`    | trimmed, 1-256 characters; the bot joins `first_name` and `last_name` |
| `languageCode`   | optional, `LANGUAGE_CODE_PATTERN`, at most 35 characters              |
| `startPayload`   | optional, `START_PAYLOAD_PATTERN`                                     |

`LANGUAGE_CODE_PATTERN` is a deliberately narrow approximation of an IETF tag, not a BCP 47
validator: a 2-3 letter primary subtag, then `-` subtags of 1-8 letters or digits. Private-use
(`x-…`) and grandfathered (`i-…`) tags are refused, and a lone singleton such as `en-a` passes.

Answers: `200 { user }`, `400 { error: 'validation', issues }`, `401 { error: 'unauthorized' }`.

Every field the bot derives is checked against this same schema before it is sent, `displayName`
included: the joined name goes through `userStartRequestSchema.shape.displayName`, and when it
does not pass — a `first_name` of nothing but spaces is what Bot API still calls non-empty — the
Telegram user id is sent as the name instead. The optional fields are simply dropped when they
do not pass; the name cannot be, because the route requires it.

The write is a single `INSERT ... ON CONFLICT (telegram_user_id) DO UPDATE`, so two `/start`
updates racing on a new user produce one row. It refreshes `display_name` and, when one arrived,
`language_code`; it does **not** write `status`, so a blocked user stays blocked — the route
still answers `200`, with `status: 'blocked'`, and the bot shows the restricted text. The reply
also carries `hasActiveBrokerAccount`, read in the same transaction after the upsert, in the
lock order `users → broker_accounts` the rest of the schema uses.

## Texts

All user-facing strings live in `apps/bot/src/texts.ts`, in Russian, sent without `parse_mode`.
The welcome has to fit in 1024 UTF-16 code units because it travels as a video caption whenever
`WELCOME_VIDEO_FILE_ID` is set — `apps/bot/src/texts.test.ts` holds that limit in the unit the
Bot API counts in, so configuring a video cannot break sending.

The text fallback answers a **refusal**, not any failure, and the video call has three outcomes
rather than two. When Telegram replies `ok: false` (`GrammyError`) nothing was sent, so the
welcome goes out as plain text with the same button and the refusal is logged: a wrong file id
costs the video, not the screen. When the call fails in transport instead — our own 8 s client
timeout, a dropped socket, anything that arrives as `HttpError` — Telegram may already have
delivered the video, so nothing further is sent; it is logged on the spot, by identity and with
the `sendVideo` it was, because `HttpError` carries no method and `bot.catch` could not tell
that line from a timeout on any other call. The user repeats `/start`: a second welcome is worse
than a missing one. Anything else is neither a refusal nor a delivery problem — a bug, a broken
plugin — and is rethrown into `bot.catch` unchanged rather than reported as one.

## Configuration

| Variable                | Required    | Meaning                                                               |
| ----------------------- | ----------- | --------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`    | yes         | the BotFather token; no whitespace                                    |
| `INTERNAL_API_TOKEN`    | yes         | bearer for the backend's internal API, 16+ characters                 |
| `BACKEND_URL`           | yes         | `http:`/`https:`, `http://backend:3000` under compose                 |
| `LOG_LEVEL`             | no (`info`) | pino level                                                            |
| `WELCOME_VIDEO_FILE_ID` | no          | `file_id` of the welcome video, no whitespace; absent means text only |

Under compose the `bot` service is given only these five names, not the shared environment
anchor the other services take: the Postgres password and the Redis URL have no business in a
process that opens neither, and `WELCOME_VIDEO_FILE_ID` is passed only when it is set.
Nothing in this repository guards that today. `env.test.ts` used to scan `compose.yaml` line by
line for the names, and it stayed green while Compose handed the container more than the scan
could see — a `<<:` merge of the anchor, or an `env_file:`, is resolved by Compose and not by the
text — so the scanner was removed rather than left vouching for what it could not read. A check
that takes the set from `docker compose config --format json` in CI is tracked by #70.

An empty value is a misconfiguration, not a default: the process refuses to start, and so does a
value carrying whitespace — a `file_id` with a trailing newline is one Telegram refuses on every
`/start`. Because Compose interpolates the whole file before it picks services,
`TELEGRAM_BOT_TOKEN` has to be set for **any** compose command, including
`docker compose up -d postgres redis` (README → Database).

CI never starts the `bot` service, and `--wait` could not tell us if it did. With a fake token
the bot fails at `getMe` (401, which grammY does not retry) and the process exits 1 — but the
container's command is `tsx watch`, whose supervisor survives that exit and keeps the container
running, and `bot` has no healthcheck, so `--wait` would report success over a dead bot. That
supervisor gap is the same in all four app services and is tracked as #65. The workflow derives
the service list from `docker compose config --services` minus `bot`, so a service added to
`compose.yaml` later is started in CI rather than silently left out.

## Timing and shutdown

`apps/bot/src/timing.ts` holds every bound and checks their order at import, so a constant
edited into an impossible order stops the process instead of producing a shutdown that loses
updates. Long polling asks for **one** update per `getUpdates` and waits 5 s for it, below the
8 s Bot API client timeout (grammY's own default is 500 s, so it is set explicitly); one backend
call is capped at 5 s.

The handler budget is not a sentence about the handlers, it is computed from `HANDLER_CALLS`,
which declares what each handler does on its longest path: `/start` is one backend call and up
to two Bot API calls (the video refused, then the text), the connect button is one backend call
and two Bot API calls. That makes 5 000 + 8 000 + 8 000 = **21 s**, inside the **25 s** shutdown
budget, inside the **30 s** `stop_grace_period` of the compose service. `timing.test.ts` runs
every terminal branch of both handlers through the real handlers and asserts that each makes the
calls it is declared to make and that the worst of them is what `HANDLER_CALLS` says — so a
handler that grows a call turns the suite red instead of quietly outgrowing the budget. It reads
`stop_grace_period` out of `compose.yaml` rather than trusting it, and grammY's polling backoff
out of grammY.

What that test cannot see, and no test here can: a handler or a terminal branch nobody added to
the enumeration. Adding either is a manual step, because grammY keeps no registry of handlers.

On SIGTERM or SIGINT `runBot` stops taking updates and waits for both `bot.stop()` and the
polling loop itself within the budget, then exits 0. A second signal is ignored: the listeners
stay installed (`on`, not `once`), so Node never falls back to the default action, which would
kill the drain instead. Because the batch is one update, the drain waits for at most one
handler, and `bot.stop()` confirms the offset of exactly the update in flight — with grammY's
default batch of 100 it would confirm only the current one and leave the rest of the batch to be
redelivered. Both of those are premises of the budget rather than preferences, so
`POLLING_BATCH_LIMIT === 1` is a conjunct of the import-time chain in `timing.ts`: another limit
stops the process at import instead of at the next shutdown. The one case the drain cannot
shorten is grammY's 3 s sleep after a failed `getUpdates` (`retry_after` after a 429,
which has no ceiling): `bot.stop()` does not interrupt it, so the drain waits it out — but no
update is in flight during that sleep, so an overrun there costs the exit code and nothing else.

An overrun exits 1, losing the update in flight rather than the whole container's shutdown. The
closing line distinguishes the two ways a drain ends badly: a step that rejected logs itself as
it fails (`shutdown: bot.stop() failed`, `shutdown: polling loop failed`), and the budget line is
written only when a step really did run out of time.

## Boundaries

- **#23** — the bot's side of the return from the login page: `confirm` and the success or
  failure message.
- **#24** — the main menu and the demo balance, including what a returning user sees instead of
  a one-line greeting.
- **#31** — referral start links; they take their own payload prefix, and the format is not
  fixed here.
- **#32** — the login page, and the `initData` check that closes the handoff gap described in
  binodex-oauth.md.
- **#35** — end-to-end coverage against the mock broker.
