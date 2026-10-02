# /start and the welcome screen

The bot's first screen (#22): who the user is, where they came from, and the action the screen
offers — connecting a Binodex account, by email first (#171) and through the broker's site second
— or, when a link is waiting, confirming it (#10). Linking itself, the email login's backend
routes, the confirmation and the starter pack are described in
[binodex-oauth.md](binodex-oauth.md); this document covers what the bot sends and calls.

## Components

- `packages/shared/src/users.ts` — the contract: `UserStatus`, the start-payload and language-tag
  patterns, and the request/response schemas of `POST /users/start`.
- `packages/db/src/user-ops.ts` — `recordUserStart` (one upsert, the active-account check and
  the list of links waiting for confirmation) and `toUserStartView` (the allowlisted projection).
- `apps/backend/src/users/routes.ts` — `POST /users/start`, behind the internal bearer.
- `apps/bot/src/` — `env.ts`, `timing.ts`, `backend-client.ts`, `texts.ts`, `logging.ts`,
  `login-dialog.ts` (the email dialog's state, [Email dialog](#email-dialog)), `bot.ts` (the
  handlers), `commands.ts` (the command menu and its scope, [Command menu](#command-menu)),
  `lifecycle.ts` (start, the menu registration, signals, drain), `index.ts` (wiring), and
  `testing.ts`, the fixtures the suites share.
- `packages/shared/src/link-confirmation.ts` — the texts and the confirm button's callback data
  the bot shares with the backend's push after an OAuth login (#128): the prompt, «✅ Аккаунт
  Binodex подключён!», the blocked and the account-taken texts (`LINK_TEXTS`), the button label
  (`LINK_LABELS`), and the pattern the bot recognises the button by.
- `packages/shared/src/telegram-html.ts` — Telegram HTML for every text a user receives
  ([Texts](#texts)).

The bot never opens a database connection: everything it knows comes from the backend's internal
API over a shared bearer.

## Sequence

```text
/start [payload]
  bot  → POST /users/start { telegramUserId, displayName, languageCode?, startPayload? }
  back → { user: { telegramUserId, status, acquisitionSource, acquiredAt, hasActiveBrokerAccount,
                   pendingBrokerAccounts } }
  bot  → blocked                  → "🔒 Доступ ограничен", no button
         pendingBrokerAccounts    → "🔐 Найдена новая привязка…" + one "✅ Подтвердить" button
                                    per link
         hasActiveBrokerAccount   → "👋 С возвращением!", no button
         otherwise                → welcome (video caption when configured) + two buttons:
                                    "🔗 Подключить аккаунт Binodex" (connect),
                                    "🌐 Войти через сайт Binodex" (oauth)

tap "🔗 Подключить аккаунт Binodex" (callback data connect)
  bot  → answerCallbackQuery, dialog → address step, "📧 Пришли адрес электронной почты…"

text on the address step
  bot  → not an address (emailAddressSchema) → "❌ Это не похоже на адрес…", no backend call
         POST /auth/binodex/email/send-code { telegramUserId, email }
  back → { codeSent: true }
  bot  → dialog → code step, "📩 Код отправлен на <address>…" + "🔄 Запросить код ещё раз"
         (resend) and "✏️ Изменить адрес" (connect)
         no answer, 5xx or a broken body → dialog → code step all the same,
         "⚠️ Не удалось подтвердить отправку кода на <address>…" + the same two buttons: the
         letter may have gone out
         any other 4xx (400 validation, 401, 404, a Fastify 4xx) →
         "⚠️ Сервис временно недоступен…", the address step stays: the backend refused before
         the letter

text on the code step
  bot  → empty after trimming, or longer than 64 characters (emailLoginCodeSchema) →
         "❌ Код не подошёл…", no backend call
         POST /auth/binodex/email/login { telegramUserId, email, code }
  back → { account, grant }
  bot  → dialog ends, the outcome with the pack, as after "✅ Подтвердить"
         a failure that is not a definite refusal → POST /users/start, the recheck below

tap "🔄 Запросить код ещё раз" (callback data resend)
  bot  → answerCallbackQuery ∥ POST /auth/binodex/email/send-code with the dialog's address
         a 429 → "⚠️ Новый код сейчас запросить нельзя…", the code step stays: the code
         already sent is still good
         any other 4xx → "⚠️ Сервис временно недоступен…" + the same two buttons, the code step
         stays: the backend refused before the letter, and the code already sent is still good

tap "🌐 Войти через сайт Binodex" (callback data oauth)
  bot  → answerCallbackQuery ∥ POST /auth/binodex/start { telegramUserId }
  back → { authorizeUrl, state, expiresAt, miniAppUrl? }
  bot  → message with a web_app button on miniAppUrl, which opens apps/web's login page as a
         Mini App (#114); without miniAppUrl — an http redirect URI, the local stack — a url
         button on authorizeUrl, because Telegram opens only https Mini Apps

tap "✅ Подтвердить" (callback data confirm:<account id>) — from /start, or from the backend's
push after an OAuth login (#128): the same button, handled the same way
  bot  → answerCallbackQuery ∥ POST /auth/binodex/confirm { telegramUserId, accountId }
  back → { account, grant }
  bot  → the outcome: linked with the pack (the number the backend sent), linked without it
         (not a partner account, or the pack was already paid), or the refusal
```

A waiting link comes before "welcome back" on purpose: a user with an active account who finds
a new link they did not make has to see it, not a greeting (binodex-oauth.md → Why a new account
starts pending). The button reads `✅ Подтвердить: <email>`, or `✅ Подтвердить привязку` when the
broker sent no email. Callback data that matches `confirm:` but is not a uuid only stops the spinner.
The refusals the user can act on have their own text — `broker_account_not_found` (start over),
`account_not_pending` (already confirmed), `user_blocked` — and anything else is "⚠️ Сервис
временно недоступен" with a warn line carrying the backend status.

Buttons sent before #171 carry `connect`, so they now open the email dialog; an old message keeps
its older label (without the emoji), which still says what happens.

What happens after the tap is the Mini App's (#114, [binodex-oauth.md → The Mini App
pages](binodex-oauth.md#the-mini-app-pages-114)): `apps/web`'s login page navigates to the broker
inside the Mini App, and its callback page sends the code back. The button belongs to the public
bot because `TELEGRAM_BOT_TOKEN` is what signs the Mini App's launch data. The backend accepts that code only with the
Mini App's signed `initData` of the Telegram user the login belongs to (#113,
[binodex-oauth.md → Why the callback is public](binodex-oauth.md#why-the-callback-is-public)). Right after the callback the backend itself sends the user the outcome
(#128, [binodex-oauth.md → The push after the callback](binodex-oauth.md#the-push-after-the-callback-128)):
for a waiting link, the same prompt and button `/start` shows; a lost push is made up for by
`/start`.

## Email dialog

The dialog is two steps, the address and then the code, and its state is one entry per Telegram
user in `login-dialog.ts`: `{ step: 'email' }` or `{ step: 'code', email }`. It lives in the bot
process's memory (the owner's decision in #162), with no new dependency:

- an entry lives 10 minutes (`LOGIN_DIALOG_TTL_MS`) from its last change — a new code gives it
  another 10, a step kept after a refusal does not — and an expired one is dropped when it is
  next read;
- at most 10 000 entries (`LOGIN_DIALOG_MAX_ENTRIES`): a new user at the cap evicts the entry
  changed longest ago, which may be a live dialog — that user presses the button again;
- a restart or a deploy drops every dialog, and the user presses the button again.

The address is kept only in that entry, because the login call needs it beside the code; it is
not stored anywhere else and is not written to the log. `logging.test.ts` reads the lines at
`trace` for an unreachable send-code, a send-code refused by status, a failed login, a failed
recheck and a reply that fails on the code step, and finds neither the address nor the code in
any of them.

No lock guards the entry: grammY runs updates one after another and the bot polls one update at
a time (`POLLING_BATCH_LIMIT`), so a read, an awaited backend call and a write never interleave
with another update's.

What each step does with what the user types:

- **address step** — the text goes through `emailAddressSchema` from `@binarius/shared` first; a
  text it refuses is answered at once, without a backend call. A sent code moves the dialog to
  the code step, and the reply shows the address back so a typo is visible next to «✏️ Изменить
  адрес».
- **code step** — anything typed is a code, an address included (the owner's answer 4b);
  `emailLoginCodeSchema` trims the text and refuses only an empty result or one longer than 64
  characters.

The backend answers 429 for two different limits ([binodex-oauth.md →
Limits](binodex-oauth.md#limits); `ceiling` and `keyedWindows` in
`apps/backend/src/auth/routes.ts`), and the dialog treats them differently.
`too_many_requests` is the route's ceiling across all users, checked before anything else: no
letter goes out, no code is spent and none of this user's own allowance is used, so the step
stays and the same message can be sent again a little later. `too_many_attempts` is this
Telegram user's or this address's own allowance for the next minutes: asking for an address or
typing a code again would be refused the same way, so the dialog ends — except on «🔄 Запросить
код ещё раз», where the code already sent is still good and the code step stays.

An unknown send-code outcome — the code step all the same, «⚠️ Не удалось подтвердить
отправку кода…» — is what is left when nothing says whether the letter went out: no answer at all, a 500
(opaque by design, whatever failed), a 502 (the broker failed after it was called) or a 2xx
with a broken body (the route answers 200 only after the broker). A 4xx is not one of them.
Every 4xx that send-code answers today comes either before the letter or from the broker's
refusal of the address (`apps/backend/src/auth/routes.ts`): the bearer check, an unknown path,
the route ceiling, the body, the blocked check and the windows all come before the broker, and
`brokerOutcome` turns only the broker's `invalid_grant` into a 400 (`invalid_email`).
`routes.db.test.ts` shows no broker call for a 400 `validation` and a 409, and the ceiling
refusing before the body; `too_many_attempts` rests on the route's order alone. So a 4xx that is
not in `SEND_CODE_REFUSALS` (`apps/bot/src/bot.ts`) — a 400 `validation`, a 401, a 404,
Fastify's own 4xx without an error code, or one added later, which the bot takes on the same
terms — is answered «⚠️ Сервис временно недоступен» and the step stays as it was, with the code
step's buttons on «🔄 Запросить код ещё раз». It is logged at `warn` as `email code not sent`, like
the unknown outcome, with `backendStatus` and `backendReason` telling them apart.

What ends the dialog, and what does not:

| Event | Dialog |
| --- | --- |
| `connect` («🔗 Подключить аккаунт Binodex», «✏️ Изменить адрес») | back to the address step |
| code sent | to the code step |
| send-code with no answer, a 5xx (502 included) or a broken body | to the code step: the letter may have gone out |
| send-code any other 4xx (`validation`, 401, 404, a Fastify 4xx) | stays where it was, «⚠️ Сервис временно недоступен»: refused before the letter |
| send-code `invalid_email` | back to the address step |
| send-code `too_many_requests` on the address step | stays on the address step |
| send-code `too_many_attempts` on the address step | ends |
| send-code `too_many_requests` / `too_many_attempts` on «🔄 Запросить код ещё раз» | stays on the code step |
| send-code `user_blocked` | ends |
| login succeeded | ends |
| login `too_many_requests` | stays on the code step, no recheck |
| login `too_many_attempts` / `user_blocked` / `broker_account_taken` | ends, no recheck |
| login `invalid_code`, recheck finds no active account | stays on the code step |
| recheck finds an active account, or a blocked user | ends |
| any other login failure (backend unreachable, 5xx, a failed recheck) | unchanged — the user retries |
| `/start` or any other command | unchanged |
| text outside a dialog | ignored, nothing is sent |

A step kept after a refusal ("stays" in the table) keeps the clock it had; every row that moves
the dialog to a step, the unknown send-code included, restarts the 10 minutes. «🔄 Запросить код ещё раз» pressed when there is no dialog — it
expired, a login already finished it, or the bot restarted — answers «⚠️ Этот запрос кода уже не
действует…», which holds in each of those cases.

`/start` answers as it always does and leaves the dialog alone (the owner's answer 3c): the
`/start` handler is registered before the text handler and does not pass the update on, and the
text handler ignores every text that starts with `/`. A user who wants a different address uses
«✏️ Изменить адрес», or the connect button of the welcome that `/start` shows a user without an
active account.

**The recheck.** The login activates the account and pays the pack in one transaction, and its
outcome is only in its answer. When that answer is lost after the commit — the bot's own 5 s
timeout — the account is active, and the same code typed again is refused as `invalid_code`
because the broker's code is single-use. So a login failure that is not one of the definite
refusals in the table (`too_many_requests`, `too_many_attempts`, `user_blocked`,
`broker_account_taken`) is followed by `POST /users/start` with the user's name and language, the request
`/start` sends without a payload; it refreshes the name as any `/start` does. An active account
is reported as «✅ Аккаунт Binodex подключён!», without a number — the recheck knows the account is
active, not what was paid; a blocked user gets the blocked text; otherwise the original failure
is answered. When the recheck itself fails, the answer is «⚠️ Сервис временно недоступен», not
«❌ Код не подошёл»: without the state that would be a guess. A user who already had an active
account and types a wrong code is told the account is connected, which is true (the owner's
answer 1a).

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

| `user` field             | Notes                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `telegramUserId`         | decimal string                                                           |
| `status`                 | `active` or `blocked`                                                    |
| `acquisitionSource`      | the first usable payload, or `null`                                      |
| `acquiredAt`             | ISO timestamp with offset, or `null`                                     |
| `hasActiveBrokerAccount` | any of the user's accounts is `active`                                   |
| `pendingBrokerAccounts`  | links waiting for confirmation, newest first, each `{ id, email }` only — `email` may be `null` |

Every field the bot derives is checked against this same schema before it is sent, `displayName`
included: the joined name goes through `userStartRequestSchema.shape.displayName`, and when it
does not pass — a `first_name` of nothing but spaces is what Bot API still calls non-empty — the
Telegram user id is sent as the name instead. The optional fields are simply dropped when they
do not pass; the name cannot be, because the route requires it.

The write is a single `INSERT ... ON CONFLICT (telegram_user_id) DO UPDATE`, so two `/start`
updates racing on a new user produce one row. It refreshes `display_name` and, when one arrived,
`language_code`; it does **not** write `status`, so a blocked user stays blocked — the route
still answers `200`, with `status: 'blocked'`, and the bot shows the restricted text. The reply
also carries `hasActiveBrokerAccount` and `pendingBrokerAccounts`, both read in the same
transaction after the upsert, in the lock order `users → broker_accounts` the rest of the schema
uses.

## Texts

Every text a Telegram user receives is Telegram HTML, sent with `parse_mode: 'HTML'`: `TEXTS` in
`apps/bot/src/texts.ts`, `LINK_TEXTS` in `packages/shared/src/link-confirmation.ts` (spread into
`TEXTS`; the backend's push sends them too) and `AUTH_TEXTS` in `apps/backend/src/auth/texts.ts`
(the push alone). The staff bot (`apps/backend/src/admin`) stays plain text, addressed with «вы»
(the owner's decision of 2026-10-02).

**The module.** `packages/shared/src/telegram-html.ts` holds `telegramHtml`, a tagged template that
escapes every hole (`&`, `<`, `>` and `"` — the three the Bot API requires in text, and the quote so
a hole inside an attribute cannot close it; `'`, `_`, `*` mean nothing in HTML mode), and
`TelegramHtml`, the type it returns. The type is nominal: a string or an object literal is not one,
so «📩 Код отправлен на <address>» can carry what the user typed only through a hole, escaped once. A
`TelegramHtml` in a hole, or an array of them, is nested without a second escaping pass. A static
part of a template is the author's: a literal `&` or `<` there is written as an entity. A cast
defeats the type, as it defeats any.

**Two seams.** `parse_mode` is set and `TelegramHtml` is unwrapped in two places only:
`apps/bot/src/send.ts` (`replyHtml`, `replyWithVideoHtml`) and
`apps/backend/src/auth/link-notifier.ts`; a caller's extra can neither override `parse_mode` nor
pass `entities`. ESLint (`eslint.config.js`, the Telegram block) forbids grammY's send methods by
name everywhere else in `apps/bot/src` and `apps/backend/src/auth`; it does not see a method held in
a variable.

**Labels are plain.** Button labels and the `/start` description (`LABELS`, `LINK_LABELS`) are not
parsed by Telegram, so they are plain strings and are never escaped: «✅ Подтвердить: <email>»
shows the broker's email as it is, `&` included.

**Checked by tests.** Next to each constant (`texts.test.ts`, `link-confirmation.test.ts`,
`link-notifier.test.ts`), `telegramHtmlProblems` fails any text with a tag or an attribute Telegram
does not list, a tag left open or closed out of order, a nested blockquote, or a bare `<`, `>`, `&`.
Lengths are measured on `plainTextOf(...)` — the text "after entities parsing" the Bot API counts,
in UTF-16 code units: at most 4096 for a message (`TELEGRAM_MESSAGE_LIMIT`) and 1024 for the
welcome, which travels as a video caption whenever `WELCOME_VIDEO_FILE_ID` is set
(`TELEGRAM_CAPTION_LIMIT`), so configuring a video cannot break sending. A text that takes a value
is called with a 254-character argument of `<&>_*"`, which must read back as it went in. A
Telegram refusal at runtime ("can't parse entities") goes through the existing error paths; there
is no check at send time.

**Style** (the owner, 2026-10-02): «ты»; an emoji at the start of each meaningful line and in a
header; a bold header line where a message has one (a warning that is itself the first line, as in
`codeSentUnknown`, carries no header); a reward in a `<blockquote>`; every button label starts with
an emoji, the `/start` description does not; short lines, one thought each. Texts promise no profit,
no signal accuracy and no "model training", and the only number in them is the backend's token
count, printed as it arrives. A multi-line text starts at column zero in the source, since
indentation inside a template is part of the message; the tests refuse a line that starts or ends
with a space. A button named inside a text is quoted by its exact label, emoji included.

New messages (the pinned card, the bot profile, nudges) are written with the same module: a
message goes into a `TelegramHtml` constant beside `TEXTS`, a label or a profile description that
Telegram does not parse goes into a plain constant beside `LABELS`.

The text fallback answers a **refusal**, not any failure, and the video call has three outcomes
rather than two. When Telegram replies `ok: false` (`GrammyError`) nothing was sent, so the
welcome goes out as a text message with the same button and the refusal is logged: a wrong file id
costs the video, not the screen. When the call fails in transport instead — our own 8 s client
timeout, a dropped socket, anything that arrives as `HttpError` — Telegram may already have
delivered the video, so nothing further is sent; it is logged on the spot, by identity and with
the `sendVideo` it was, because `HttpError` carries no method and `bot.catch` could not tell
that line from a timeout on any other call. The user repeats `/start`: a second welcome is worse
than a missing one. Anything else is neither a refusal nor a delivery problem — a bug, a broken
plugin — and is rethrown into `bot.catch` unchanged rather than reported as one.

## Command menu

Telegram's «Меню» button and the hints shown when the user types `/` list one command: `/start` —
«Начать». The list is `BOT_COMMANDS` in `apps/bot/src/commands.ts`, the only place it is written;
the description is `LABELS.startCommand`. The next command is one more element there and one more
literal in the `setMyCommands` assertions of `lifecycle.test.ts`, which name the values on purpose.
`commands.test.ts` holds the Bot API limits (a command of 1-32 lowercase letters, digits and
underscores, a description of 1-256 UTF-16 code units, at most 100 commands, each once) and sends
every listed command through the real handlers to check that it is answered — grammY keeps no
registry of handlers to ask instead. A handler with no menu entry is invisible to that check.

The scope is `all_private_chats`: the bot ignores every other chat type (`bot.chatType('private')`
in `bot.ts`), so a menu there would offer commands nothing answers. For a user in a private chat
Telegram consults this scope before `default`, so a list set earlier through @BotFather (which
sets `default`) is shadowed where the bot talks and would still show in groups. No
`language_code` is sent: one list for every interface language.

`runBot` (`apps/bot/src/lifecycle.ts`) registers the list on every start, inside grammY's
`onStart` — after `getMe` and `deleteWebhook` have succeeded and before the first `getUpdates` —
so an invalid token fails once, at `getMe`, and the list is on Telegram's side before the first
update is taken. `setMyCommands` replaces the whole list of the scope, so a command removed from
`BOT_COMMANDS` disappears on the next successful registration.

A failed registration does not stop the bot. One attempt is made; whatever it throws — Telegram's
refusal, a transport failure or the 8 s client timeout, anything else — is caught and logged at
`warn` as `bot commands not registered`, by the error's identity and `method: 'setMyCommands'`,
and polling begins as usual. The only cost is the menu: Telegram keeps the last list that did
register, and the next start repeats the call. There is no retry within one process life.

There is no `setChatMenuButton` call. The Bot API: «If a menu button other than MenuButtonDefault
is set for a private chat, then it is applied in the chat. Otherwise the default menu button is
applied. By default, the menu button opens the list of bot commands.» Choosing `/start` from the
menu sends the same `/start` message, with the `bot_command` entity and no payload, as typing it,
so the handler is unchanged.

## Configuration

| Variable                | Required    | Meaning                                                               |
| ----------------------- | ----------- | --------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`    | yes         | the BotFather token; no whitespace. `backend` gets it too, for the push after the OAuth callback (#128), and never polls it |
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
to two Bot API calls (the video refused, then the text); the oauth, confirm and resend buttons
are one backend call and two Bot API calls each; the connect button is no backend call and two
Bot API calls; a text on the address step is one backend call and one Bot API call, and a text
on the code step two backend calls (the login and the recheck) and one Bot API call, 18 s. The
longest is 5 000 + 8 000 + 8 000 = **21 s**, inside the **25 s** shutdown budget, inside the
**30 s** `stop_grace_period` of the compose service. `timing.test.ts` runs
every terminal branch of each handler through the real handlers and asserts that each makes the
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

The command-menu registration ([Command menu](#command-menu)) is one Bot API call at startup,
bounded by the same 8 s client timeout, and is not part of `HANDLER_CALLS`: no update is in
flight while it runs. A SIGTERM during it runs `bot.stop()`'s offset confirmation (≤ 8 s)
alongside the registration (≤ 8 s), so the drain takes at most 8 s, inside the 25 s budget, and
grammY then returns from `start()` without a first `getUpdates`. In that case `bot started` is
still written, after `shutting down`, because `onStart` finishes before grammY sees the stop.

An overrun exits 1, losing the update in flight rather than the whole container's shutdown. The
closing line distinguishes the two ways a drain ends badly: a step that rejected logs itself as
it fails (`shutdown: bot.stop() failed`, `shutdown: polling loop failed`), and the budget line is
written only when a step really did run out of time.

## Boundaries

- **#162** — the backend half of the email login: the two routes, their limits, the activation
  and the pack ([binodex-oauth.md → Email login](binodex-oauth.md#email-login-issue-162)). The
  bot shows the limits' refusals without repeating their numbers.
- **#173** — the Minor findings of the email login's limits from the review of PR #172.

- **#128** — the backend's message right after the callback, sent to the Telegram id restored
  from the state, with the confirm button and texts shared with the bot.
- **#10** — re-linking an account that belongs to another Telegram user is out of scope:
  `broker_account_taken` is final, and moving an account is a separate support task.
- **#24** — the main menu and the demo balance, including what a returning user sees instead of
  a one-line greeting.
- **#31** — referral start links; they take their own payload prefix, and the format is not
  fixed here.
- **#114** — the Mini App login and callback pages in `apps/web` behind the `web_app` button; the
  `initData` check they rely on is the backend's (#113, binodex-oauth.md).
- **#35** — end-to-end coverage against the mock broker.
