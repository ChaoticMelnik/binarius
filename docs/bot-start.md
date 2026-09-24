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
  `bot.ts` (the handlers), `lifecycle.ts` (start, signals, drain), `index.ts` (wiring).

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
| `languageCode`   | optional, BCP 47 (`LANGUAGE_CODE_PATTERN`, at most 35 characters)     |
| `startPayload`   | optional, `START_PAYLOAD_PATTERN`                                     |

Answers: `200 { user }`, `400 { error: 'validation', issues }`, `401 { error: 'unauthorized' }`.

The write is a single `INSERT ... ON CONFLICT (telegram_user_id) DO UPDATE`, so two `/start`
updates racing on a new user produce one row. It refreshes `display_name` and, when one arrived,
`language_code`; it does **not** write `status`, so a blocked user stays blocked — the route
still answers `200`, with `status: 'blocked'`, and the bot shows the restricted text. The reply
also carries `hasActiveBrokerAccount`, read in the same transaction after the upsert, in the
lock order `users → broker_accounts` the rest of the schema uses.

## Texts

All user-facing strings live in `apps/bot/src/texts.ts`, in Russian, sent without `parse_mode`.
The welcome has to fit in 1024 characters because it travels as a video caption whenever
`WELCOME_VIDEO_FILE_ID` is set — `apps/bot/src/texts.test.ts` holds that limit, so configuring a
video cannot break sending. If Telegram refuses the file id, the welcome is sent as plain text
with the same button and the refusal is logged; a wrong file id costs the video, not the screen.

## Configuration

| Variable                | Required    | Meaning                                                |
| ----------------------- | ----------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`    | yes         | the BotFather token; no whitespace                     |
| `INTERNAL_API_TOKEN`    | yes         | bearer for the backend's internal API, 16+ characters  |
| `BACKEND_URL`           | yes         | `http:`/`https:`, `http://backend:3000` under compose  |
| `LOG_LEVEL`             | no (`info`) | pino level                                             |
| `WELCOME_VIDEO_FILE_ID` | no          | `file_id` of the welcome video; absent means text only |

An empty value is a misconfiguration, not a default: the process refuses to start. Because
Compose interpolates the whole file before it picks services, `TELEGRAM_BOT_TOKEN` has to be set
for **any** compose command, including `docker compose up -d postgres redis` (README → Database).
CI never starts the `bot` service: with a fake token the first `getMe` answers 401, grammY does
not retry it, and the process exits — which is the intended behaviour, not something `--wait`
can wait for.

## Timing and shutdown

`apps/bot/src/timing.ts` holds every bound and checks their order at import. Long polling waits
5 s per `getUpdates`, below the 8 s Bot API client timeout (grammY's own default is 500 s, so it
is set explicitly); one backend call is capped at 5 s; the longest handler therefore fits in
16 s, inside the 20 s shutdown budget, inside the 25 s `stop_grace_period` of the compose
service — which `timing.test.ts` reads out of `compose.yaml` rather than trusting.

On SIGTERM or SIGINT `runBot` stops taking updates and waits for both `bot.stop()` and the
polling loop itself within the budget, then exits 0; an overrun exits 1, losing the update in
flight rather than the whole container's shutdown. A second signal is ignored.

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
