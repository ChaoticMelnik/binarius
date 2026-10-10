# /start and the welcome screen

The bot's first screen (#22): who the user is, where they came from, and the action the screen
offers — connecting a Binodex account by email (#171; the site sign-in is hidden since #314) — or,
when a link is waiting, confirming it (#10). Linking itself, the email login's backend
routes, the confirmation and the starter pack are described in
[binodex-oauth.md](binodex-oauth.md); this document covers what the bot sends and calls.

## Components

- `packages/shared/src/users.ts` — the contract: `UserStatus`, `NotificationLevel`, the
  start-payload and language-tag patterns, and the request/response schemas of `POST /users/start`,
  `POST /users/chat-member` and `POST /users/notification-level`.
- `packages/db/src/user-ops.ts` — `recordUserStart` (one upsert, the active-account check and
  the list of links waiting for confirmation) and `toUserStartView` (the allowlisted projection).
- `apps/backend/src/users/routes.ts` — `POST /users/start`, `POST /users/chat-member` and
  `POST /users/notification-level`, behind the internal bearer, and `POST /users/account` beside them, which `/account` reads
  ([bot-account.md](bot-account.md)).
- `packages/db/src/delivery-ops.ts` — whether the bot may mail a user: `deliverable()`,
  `acceptsMailing()` and `REDUCED_LEVEL_WINDOW_HOURS`, the mark and clear helpers, the pending-job
  cancel and `setNotificationLevel` ([Blocking the bot](#blocking-the-bot-119),
  [Notification level and /support](#notification-level-and-support-120)).
- `apps/backend/src/users/telegram-delivery.ts` — what a 403 on a send means:
  `isTelegramForbidden` and `recordTelegramSendFailure`, the helper a sender hands a failed send
  to (today only the link push does).
- `apps/bot/src/` — `env.ts`, `timing.ts`, `backend-client.ts`, `texts.ts` (with `accountCard`,
  [The account card](#the-account-card), `PROFILE`, [Bot profile](#bot-profile), `SUPPORT`,
  [Notification level and /support](#notification-level-and-support-120), `helpText`,
  [/help](#help-184), and `statusCard`, [bot-menu.md](bot-menu.md)), `format.ts` (the status
  card's amounts and counts, [bot-menu.md](bot-menu.md)), `send.ts` (with `editMessageTextByIdHtml`, the
  edit outside an update the intent tracker uses), `logging.ts`, `assets.ts` (the path of
  `assets/account-card.jpg`, the card's picture), `login-dialog.ts` (the email dialog's state,
  [Email dialog](#email-dialog)), `bot.ts` (the handlers),
  `lifecycle.ts` (start, the profile registration — the menu, the description, the short
  description — signals, drain), `index.ts` (wiring), and
  `testing.ts`, the fixtures the suites share; `demo.ts`, `demo-catalog.ts` and `analysis.ts` (the
  screens behind the demo button, their check on a fresh catalog and the analysis screen,
  [bot-demo.md](bot-demo.md)), `demo-trade.ts` and `intent-tracker.ts` (the stake press, the
  refresh button and the tracker that follows a demo trade's status, [bot-demo-trade.md](bot-demo-trade.md)) and
  `screen.ts` (how a refused edit of a screen is classified, shared by `/settings`, the demo and
  the demo trade).
- `packages/shared/src/bot-texts.ts` — the catalog of every client bot text, the bot's and the
  backend push's alike ([bot-texts.md](bot-texts.md)); `bot-text-template.ts` beside it renders
  and validates them.
- `packages/shared/src/link-confirmation.ts` — the confirm button's callback data the bot shares
  with the backend's push after an OAuth login (#128), the pattern the bot recognises the button
  by, and `confirmButtonLabel`, the label with the account's address or without one. The prompt,
  «✅ Аккаунт Binodex подключён!» (sent by the push alone; the bot sends the account card
  instead), the blocked and the account-taken texts are catalog entries.
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
  bot  → blocked                  → "🔒 Доступ ограничен" + the support link (#350)
         pendingBrokerAccounts    → "🔐 Найдена новая привязка…" + one "✅ Подтвердить" button
                                    per link
         hasActiveBrokerAccount   → POST /trading/access → the status card, pinned
                                    (bot-menu.md)
         otherwise                → welcome (video caption when configured): what the bot
                                    is, "Главное — автосессия" (#360), how to connect; + one
                                    button: "🔗 Подключить аккаунт Binodex" (connect)

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
  bot  → dialog ends, the account card with the pack, as after "✅ Подтвердить"
         a failure that is not a definite refusal → POST /users/start, the recheck below

tap "🔄 Запросить код ещё раз" (callback data resend)
  bot  → answerCallbackQuery ∥ POST /auth/binodex/email/send-code with the dialog's address
         a 429 → "⚠️ Новый код сейчас запросить нельзя…", the code step stays: the code
         already sent is still good
         any other 4xx → "⚠️ Сервис временно недоступен…" + the same two buttons, the code step
         stays: the backend refused before the letter, and the code already sent is still good

tap an old "🌐 Войти через сайт Binodex" (callback data oauth), hidden since #314
  bot  → answerCallbackQuery, then editMessageReplyMarkup: the old message loses its keyboard;
         nothing is sent and the backend is not called

tap "✅ Подтвердить" (callback data confirm:<account id>) — from /start, or from the backend's
push after an OAuth login (#128): the same button, handled the same way
  bot  → answerCallbackQuery ∥ POST /auth/binodex/confirm { telegramUserId, accountId }
  back → { account, grant }
  bot  → the account card, pinned (The account card below): the greeting, the account's
         address, what is available, and the pack (the number the backend sent) or why none was
         paid (not a partner account, or the pack was already paid); or the refusal
```

A waiting link comes before "welcome back" on purpose: a user with an active account who finds
a new link they did not make has to see it, not a greeting (binodex-oauth.md → Why a new account
starts pending). The button reads `✅ Подтвердить: <email>`, or `✅ Подтвердить привязку` when the
broker sent no email or a blank one (`addressOrNull`, [bot-account.md → An empty
address](bot-account.md#an-empty-address)). Callback data that matches `confirm:` but is not a uuid only stops the spinner.
The refusals the user can act on have their own text — `broker_account_not_found` (start over),
`account_not_pending` (already confirmed), `user_blocked` — and anything else is "⚠️ Сервис
временно недоступен" with a warn line carrying the backend status.

Buttons sent before #171 carry `connect`, so they now open the email dialog; an old message keeps
its older label (without the emoji), which still says what happens. Buttons sent before #314 under
the welcome, `/account` and the no-account refusals of the demo also carry `oauth`, the site sign-in: a press only stops the spinner and
removes that message's keyboard (`removeLegacyKeyboard`, as for the demo's old duration buttons,
[bot-demo.md](bot-demo.md)), so the user starts again from `/start`; an old `/account` message
loses its confirm buttons with it, and `/start` and `/account` show them again. A refused edit is
an info line.

Since #314 the bot offers no site sign-in, and `POST /auth/binodex/start` is gone (404). The Mini
App pages, the callback and the push stay for a state issued before that: a callback for one still
links a `pending` account, and the push and `/start` show its confirm button (#114, #113, #128 —
[binodex-oauth.md](binodex-oauth.md)).

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
is reported with the account card without the pack line and without the address: the recheck
knows that an account is active, not which one nor what was paid. A user who already had an
active account and types a wrong code for another address is therefore told, truly, that an
account is connected (the owner's answer 1a), and that card replaces their pinned one minus the
«📧» line (#200, Plan Update); the address is on the card the activating login or confirmation
sent. A blocked user gets the blocked text; otherwise the original failure is answered. When the
recheck itself fails, the answer is «⚠️ Сервис временно недоступен», not «❌ Код не подошёл»:
without the state that would be a guess.

## The account card

Where an account becomes usable and the user is told so, the bot sends one **account card** (#200)
and pins it: after a successful email login, after «✅ Подтвердить», and after the recheck above
finds an account active. It replaces the success texts the bot used to send; the backend's push
after an OAuth login still sends «✅ Аккаунт Binodex подключён!» as text
([binodex-oauth.md → The push after the callback](binodex-oauth.md#the-push-after-the-callback-128)),
and a waiting link is confirmed with the button, which sends the card.

**What it says.** `accountCard({ firstName, email, grant })` in `apps/bot/src/texts.ts` builds the
caption from those three fields and nothing else, so no token, code or password can reach it:
the greeting by Telegram's `first_name` («🎉 Привет!» when the name is blank), the account's
address when it is known (`📧`), what Binarius gives, and the pack — the number the backend sent
in a blockquote, or the `ℹ️` reason none was paid. The address is the broker's for the account
it issued tokens for, or after an email login without one the address the code was redeemed for;
a confirmed link without an address and the recheck show no `📧` line, and the recheck shows no
pack line either. Every fragment is a `TEXTS` entry.

**Its button** (#350). The card carries «🎮 Демо-торговля» (`DEMO_CALLBACK_DATA`), the status
card's own entry, on all three paths and on the text card that replaces a refused photo; the push
after an OAuth login carries it too ([bot-navigation.md](bot-navigation.md)).

**The picture.** `apps/bot/src/assets/account-card.jpg`, its path in `assets.ts`, uploaded as an
`InputFile` with every card — no `file_id` cache, accepted at one card per account activation.
The bot runs from `src` (tsx), so the path resolves there; the Dockerfile's `COPY . .` puts the
file in the image. `assets.test.ts` checks it is a JPEG inside the Bot API's photo limits (10 MB,
width + height ≤ 10 000, ratio ≤ 20), and a test in `bot.test.ts` lets grammY upload it to a
loopback server and finds its bytes in the `sendPhoto` body, so a wrong path is caught there.

**Three outcomes of the photo call**, as for the welcome video: a refusal (`GrammyError`, nothing
was sent) → the same card goes as a text message, and that message is pinned; a transport failure
(`HttpError`: the 8 s timeout, a dropped socket, a file that could not be opened) → delivery is
unknown, nothing more is sent and nothing is pinned, logged at `error` with `method: 'sendPhoto'`
and the update id; anything else is rethrown into `bot.catch`. The text sent instead has its own
outcomes: sent and pinned, or failed in transport — logged at `error` with
`method: 'sendMessage'` and the update id, nothing pinned, nothing more sent (#214); a refusal of
the text message reaches `bot.catch`, which logs a `GrammyError` with its method. The card and the
welcome go through one helper, `sendWithTextFallback` in `bot.ts`. A user left without a card that
way has an active account all the same; `/start` and `/menu` send and pin the status card
([bot-menu.md](bot-menu.md)), which takes the account card's place as the pinned message.

**Pinning.** `unpinAllChatMessages`, then `pinChatMessage` on the card with
`disable_notification: true` — the card has just notified. The bot stores no message id, so
clearing every pin is what leaves one card pinned; the user's own pins in the bot chat go too (the
owner's choice). In a private chat neither call needs rights. Each may fail: one `warn` line with
the method and the Telegram code, and the next step runs — a failed unpin still pins, a failed
pin changes nothing about the connection, which is already committed. Neither is retried, and the
caption does not claim the card is pinned.

What is logged is the error's identity, the method and the code (`telegramErrorFields`), never
the payload: the caption holds the user's address. `logging.test.ts` reads those lines at `trace`
and finds neither the address nor the code typed in them.

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
| `notificationLevel`      | `all`, `reduced` or `off` (`NotificationLevel`); what `/settings` shows   |
| `demoStake`              | the saved demo stake, canonical decimal string, or `null` for the broker's minimum (#297) |

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

## Blocking the bot (#119)

When a user blocks the bot, the backend marks them unreachable until they come back and cancels
their pending notification jobs; the mailing engine reads the mark and sends such a user nothing
([mailing.md](mailing.md)). The fact lives in one column,
`users.telegram_blocked_at` (NULL = deliverable, migration 0009), independent of `users.status`,
which is the admin block: neither path writes the other.

```text
the user blocks the bot
  Telegram → my_chat_member, new status `kicked`
  bot  → POST /users/chat-member { telegramUserId, status: 'kicked' }
  back → markTelegramBlocked: telegram_blocked_at = coalesce(telegram_blocked_at, now()),
         and in the same transaction the user's `pending` notification_jobs → `canceled`
the user unblocks the bot
  Telegram → my_chat_member, new status `member`
  bot  → POST /users/chat-member { telegramUserId, status: 'member' }
  back → markTelegramReachable: telegram_blocked_at = NULL
the user sends /start or /settings
  the /users/start upsert sets telegram_blocked_at = NULL: they have just written to the bot
a send is refused with 403 (the link push after the callback, a mailing)
  back → recordTelegramSendFailure → markTelegramBlocked, as above
```

The bot asks Telegram for `my_chat_member` (`ALLOWED_UPDATES` in `lifecycle.ts`), handles it in
private chats only, forwards `kicked` and `member` as Telegram spells them and ignores any other
status; it decides nothing and sends nothing — a blocked chat could not receive it anyway. A
repeated `kicked` keeps the first time and runs the cancel again, so a job created between two
signals is caught. An id with no users row is answered `recorded: false` and nothing is inserted:
rows are created by `POST /users/start` (`/start` and `/settings`).

A 403 on a send that is reported counts as "cannot deliver" — blocked, deactivated, never started
— and the mark clears on the user's next `/start` or `/settings` (both upsert through
`/users/start`) or unblock. Two sends report one, through `recordTelegramSendFailure`: the link
push after the OAuth callback (`apps/backend/src/auth/routes.ts`) and the mailing engine
(`apps/backend/src/mailing/engine.ts`, #202). On neither path is Telegram's `description` compared
or logged.

What a sender does (#202's engine, [mailing.md](mailing.md); #123 and #124 are scenarios of the
same engine): it claims its jobs with `acceptsMailing()` — which includes `deliverable()` — in the
claim statement (joining `users`) instead of spelling the columns, and hands a 403 to
`recordTelegramSendFailure` (`mailing-ops.db.test.ts` M6, `engine.db.test.ts` M7). A job claimed a moment before the block
lands may then still be attempted once; that attempt is the 403 that marks the user, and no second
one follows.

Deliberately not done: no message on unblock (the user's next `/start` answers as usual); blocks
from before the deploy are not replayed — Telegram does not resend old `my_chat_member` updates,
so such a user is marked on their first 403; a 403 on the bot's own replies is not reported,
because a block always produces `my_chat_member` as well. The staff bot is its own domain.

Log lines: the route writes `the user blocked the bot` (`recorded`, `canceledJobs`) or `the user
unblocked the bot` (`recorded`) at `info`; `recordTelegramSendFailure` writes `Telegram refused a
send with 403; the user is marked unreachable` (`recorded`, `canceledJobs`) at `info`, or `the
Telegram block could not be recorded` at `error` with the error's identity — the caller's own
response does not change either way. None of them carries the Telegram id. The bot writes `chat
member status not recorded` at `warn` with the error's identity, the backend status and
`chatMember`.

## POST /users/chat-member

Internal route, `Authorization: Bearer <INTERNAL_API_TOKEN>`, in the same plugin as
`/users/start`. Request and response are validated by `@binarius/shared/users`.

| Field            | Notes                                                        |
| ---------------- | ------------------------------------------------------------ |
| `telegramUserId` | decimal string, the shared `telegramUserIdSchema`            |
| `status`         | `kicked` or `member` (`TelegramChatMemberStatus`)            |

Answers: `200 { recorded }` — `false` when no users row has this id, and then nothing was
written — `400 { error: 'validation', issues }`, `401 { error: 'unauthorized' }`. A retry is
idempotent.

## Notification level and /support (#120)

A user chooses how often the bot may write to them unasked: `users.notification_level` (migration
0010), one of `NotificationLevel` in `packages/shared/src/users.ts` — `all` (the default, every
existing user included), `reduced` or `off`. It is a preference beside `telegram_blocked_at` and
`status`; none of the three writes another. The level never governs the replies to the user's
commands and buttons, the push after a site login (#128) or the results of the user's own trades
(the owner, 2026-10-03). It governs the mailings ([mailing.md](mailing.md)): `off` cancels what
is pending and the engine sends nothing more, `reduced` holds a second mailing within the window.

```text
/settings
  bot  → POST /users/start (the recheck request: id, name, language; no payload)
  bot  → blocked: the blocked text; otherwise the levels message, the selected level marked ✅,
         then «💵 Сумма демо-сделки: $5.00» (or «минимальная ставка брокера») and a row
         «💵 Изменить» → stk:o:s, the stake picker (#297, bot-demo-trade.md → The stake)
settings (the picker's «↩️ Назад к настройкам»)
  bot  → answerCallbackQuery ∥ POST /users/start, then the /settings message edited in place
a level pressed (level:all, level:reduced, level:off)
  bot  → answerCallbackQuery ∥ POST /users/notification-level { telegramUserId, level }
         → { level, demoStake }, so the edit keeps the stake line
  back → setNotificationLevel: the users row updated; for `off`, in the same transaction, the
         user's `pending` notification_jobs → `canceled` (lock order users → notification_jobs)
  bot  → the message edited in place from the answer's level; refused as not modified:
         nothing more; refused as gone or not editable: the same text and keyboard as a new
         message; any other refusal: bot.catch, nothing sent; failed in transport (HttpError):
         nothing more
the selected level pressed (level:current)
  bot  → answerCallbackQuery only
/support
  bot  → the support message with one url button; no backend call
```

**What a level means** (`packages/db/src/delivery-ops.ts`): `deliverable()` is
`telegram_blocked_at is null and notification_level <> 'off'`; `acceptsMailing()` is
`deliverable()` and, at `reduced`, no `sent` notification job of this user with `sent_at` inside
the last `REDUCED_LEVEL_WINDOW_HOURS` (24) by the database clock — at most one mailing a day,
counted from what was sent, not from what was scheduled. `reduced` cancels nothing: the window is
applied when a sender claims, and a job it skips stays `pending`. Two senders claiming the same
`reduced` user at the same instant can both pass the window (accepted); a sender that cannot
accept that locks the users row first. What a sender must do is in
[Blocking the bot](#blocking-the-bot-119): `acceptsMailing()` in its claim, and a `sent` row with
`sent_at` for each mailing, which is what the window reads.

**The bot.** `/settings` reads the level from `/users/start`, so it also creates a missing users
row and clears the Telegram block mark, as `/start` would; a blocked user gets the blocked text and
the support link, and a backend failure the unavailable text with «🔄 Повторить» (`cmd:settings`)
and the menu (#350, ([bot-navigation.md](bot-navigation.md))). A press acts on no error code of the set route: any
failure is the unavailable text as a new message with the menu, the keyboard untouched, so
pressing again is the retry.

Unlike a refused send, a refused edit may mean the message already shows the result, so the
refusal is classified (`editRefusal` in `bot.ts`), by `error_code` 400 and the lead phrase of
Telegram's `description` as the Bot API server words it (telegram-bot-api `Client.cpp`); the
description is compared, never logged.

| Edit outcome | What the bot does |
| --- | --- |
| 400 `message is not modified` — a second press of the same level, queued against the keyboard the first edit had not yet replaced | nothing more: the message already shows it; one `info` line |
| 400 `message to edit not found` or `message can't be edited` — the message is gone or too old | the same text and keyboard as a new message; one `warn` line |
| any other refusal (another 400, 403, 429, …) | rethrown into `bot.catch`, nothing sent: the message is most likely still on screen, and its keyboard is the retry |
| a transport failure (`HttpError`) | nothing more, since the edit may have landed and the keyboard is still there; one `error` line |
| anything else | rethrown into `bot.catch` |

An older
`/settings` message keeps a stale ✅ until it is pressed. The route does not check `status`, so a
stale keyboard still works for an admin-blocked user. `/support` calls nothing, so it answers a
blocked user and a backend outage alike.

**Support.** The button opens `https://t.me/<SUPPORT.telegramUsername>`, `SUPPORT` in
`apps/bot/src/texts.ts`: a temporary personal account, which #220 replaces by changing that one
line. The three texts that send the user to support — the account card's last line, the blocked
text and the account-taken text — end with `: /support`, which Telegram shows as a command.

Log lines: the route writes `notification level set` at `info` with `notificationLevel` and
`canceledJobs` — not `level`, which is pino's own key — and no Telegram id. The bot writes
`/settings not read` and `notification level not set` at `warn` with the error's identity and the
backend status, `the settings message already shows this level` at `info` and `the settings
message was not edited, sending it anew` at `warn`, both with `method: 'editMessageText'` and the
Telegram code, and `the settings edit failed in transport,
sending nothing more` at `error` with the method and the update id; never the message text.

## POST /users/notification-level

Internal route, `Authorization: Bearer <INTERNAL_API_TOKEN>`, in the same plugin as
`/users/start`. Request and response are validated by `@binarius/shared/users`.

| Field            | Notes                                                  |
| ---------------- | ------------------------------------------------------ |
| `telegramUserId` | decimal string, the shared `telegramUserIdSchema`      |
| `level`          | `all`, `reduced` or `off` (`NotificationLevel`)        |

Answers: `200 { level }` — the stored level — `400 { error: 'validation', issues }`,
`401 { error: 'unauthorized' }`, `404 { error: 'user_not_found' }` when no users row has this id
(nothing is inserted). A retry is idempotent; `off` repeated cancels whatever became pending since.

## Texts

Every text a Telegram user receives is Telegram HTML, sent with `parse_mode: 'HTML'`. The texts
are the bot texts catalog's (`packages/shared/src/bot-texts.ts`, [bot-texts.md](bot-texts.md)):
the bot reads them as `TEXTS` in `apps/bot/src/texts.ts`, the backend's push as `CLIENT_TEXTS` in
`apps/backend/src/auth/texts.ts`, both rendered from the same entries when a message is built. The
staff bot (`apps/backend/src/admin`) stays plain text, addressed with «вы» (the owner's decision
of 2026-10-02).

**The module.** `packages/shared/src/telegram-html.ts` holds `telegramHtml`, a tagged template that
escapes every hole (`&`, `<`, `>` and `"` — the three the Bot API requires in text, and the quote so
a hole inside an attribute cannot close it; `'`, `_`, `*` mean nothing in HTML mode), and
`TelegramHtml`, the type it returns. The type is nominal: a string or an object literal is not one,
so «📩 Код отправлен на <address>» can carry what the user typed only through a hole, escaped once. A
`TelegramHtml` in a hole, or an array of them, is nested without a second escaping pass. A static
part of a template is the author's: a literal `&` or `<` there is written as an entity. A cast
defeats the type, as it defeats any.

**Two seams.** `parse_mode` is set and `TelegramHtml` is unwrapped in two places only:
`apps/bot/src/send.ts` (`replyHtml`, `replyWithVideoHtml`, `replyWithPhotoHtml`,
`editMessageTextHtml`) and
`apps/backend/src/auth/client-push.ts` (the link push and the mailings, #202); a caller's extra can neither override `parse_mode` nor
pass `entities`. ESLint (`eslint.config.js`, the Telegram block) forbids grammY's send methods by
name everywhere else in `apps/bot/src`, `apps/backend/src/auth` and `apps/backend/src/mailing`,
outside tests; it does not see a
method held in a variable. The list is `RAW_TELEGRAM_SEND_METHODS` in `eslint.config.js`: every
Bot API method that takes parsed text and every grammY alias of one, derived from
`@grammyjs/types` 5.0.0 and grammy 1.46.0 by the two commands in the comment above it.

**Labels are plain.** Button labels and the command descriptions (`LABELS`, the backend's
`CLIENT_LABELS`) are not parsed by Telegram, so they are plain strings and are never escaped:
«✅ Подтвердить: <email>» shows the broker's email as it is, `&` included. The same holds for the
bot's description and short description (`PROFILE`, [Bot profile](#bot-profile)): plain, line
breaks kept as written, their limits held by `texts.test.ts` and the catalog entries' limits.

**Checked by tests.** Every catalog default goes through `botTextProblems` in `bot-texts.test.ts`
([bot-texts.md](bot-texts.md)), and every entry of `TEXTS` through `telegramTextProblems`
(`@binarius/shared/testing`) in `texts.test.ts`; both must report nothing. The second runs `telegramHtmlProblems`, which
fails any text with a tag or an attribute Telegram does not list, a tag left open or closed out of
order, a nested blockquote, a tag inside `pre` or `code` other than `code` directly in `pre`, one of
`a`, `tg-emoji`, `tg-time`, `pre`, `code` inside another of them, or a bare `<`, `>`, `&`. Where the
Bot API's nesting rules do not settle a case — whether a blockquote may hold or sit inside one of
those five, whether bold and its kind may hold `pre` or `code` — the validator accepts it, and
Telegram decides when the message is sent. The helper also refuses a text that is empty after
entities parsing, one over its limit, and a line that starts or ends with a space. Lengths are
measured on `plainTextOf(...)` — the text "after entities parsing" the Bot API counts, in UTF-16
code units: at most 4096 for a message (`TELEGRAM_MESSAGE_LIMIT`, the helper's default) and 1024
for the welcome, which travels as a video caption whenever `WELCOME_VIDEO_FILE_ID` is set
(`TELEGRAM_CAPTION_LIMIT`, passed by its own test), so configuring a video cannot break sending. A text that takes a value
is called with a 254-character argument of `<&>_*"`, which must read back as it went in. The
account card is a photo caption too: every variant of it is checked against 1024 with each hole
at its real maximum — a 64-character name, a 254-character address, a 19-digit token count — of
the same characters. The broker's address is not bounded on the wire, so a longer one can push
the caption over the limit; Telegram then refuses the photo and the card goes as text. A
Telegram refusal at runtime ("can't parse entities") goes through the existing error paths; there
is no check at send time.

**Style** (the owner, 2026-10-02): «ты»; an emoji at the start of each meaningful line and in a
header; a bold header line where a message has one (a warning that is itself the first line, as in
`codeSentUnknown`, carries no header); a reward in a `<blockquote>`; every button label starts with
an emoji, a command description (a `LABELS` key ending in `Command`) does not; short lines, one thought each. Texts promise no profit,
no signal accuracy and no "model training", and the only number in them is the backend's token
count, printed as it arrives. A multi-line text starts at column zero in the source, since
indentation inside a template is part of the message; `telegramTextProblems` refuses a line that
starts or ends with a space. A button named inside a text is quoted by its exact label, emoji included.

New messages (nudges) are written with the same module, as the account card is: a message goes
into a `TelegramHtml` constant beside `TEXTS`, a label that Telegram does not parse goes into a plain
constant beside `LABELS`, as the profile texts did ([Bot profile](#bot-profile)).

The text fallback answers a **refusal**, not any failure, and the video call has three outcomes
rather than two. When Telegram replies `ok: false` (`GrammyError`) nothing was sent, so the
welcome goes out as a text message with the same button and the refusal is logged: a wrong file id
costs the video, not the screen. When the call fails in transport instead — our own 8 s client
timeout, a dropped socket, anything that arrives as `HttpError` — Telegram may already have
delivered the video, so nothing further is sent; it is logged on the spot, by identity and with
the `sendVideo` it was, because `HttpError` carries no method and `bot.catch` could not tell
that line from a timeout on any other call. The user repeats `/start`: a second welcome is worse
than a missing one. The text welcome sent after a refusal has its own outcomes: sent, or
failed in transport — logged at `error` with `method: 'sendMessage'` and the update id, nothing
more sent (#214); a refusal of the text message reaches `bot.catch`, which logs a `GrammyError`
with its method. The welcome and the account card go through one helper, `sendWithTextFallback` in
`bot.ts`. Anything else is neither a refusal nor a delivery problem — a bug, a broken
plugin — and is rethrown into `bot.catch` unchanged rather than reported as one.

## /help (#184)

```text
/help
  bot  → one message: what the bot does, how to connect, the commands; no backend call
```

The message is `helpText(botCommands())` in `apps/bot/src/texts.ts`, built on every `/help` (so it
reads the catalog's texts and their overrides as they are then) and sent through `replyHtml` with «🏠 В меню» (#350). Three
blocks, one blank line apart:

- `TEXTS.helpAbout` — the header and the three feature lines, the catalog's `featureLines`
  fragment, the same one the account card nests, so the two copies cannot drift
  (`profileDescription` keeps its own plain copy, which Telegram does not parse);
- `TEXTS.helpConnect` — `/start` and the connect button, quoted by its label through the
  `connectButton` fragment;
- `TEXTS.helpCommands` and one `/<command> — <description>` line per entry of the menu
  (`botCommands()`, [Command menu](#command-menu)), in its order, with no emoji. `bot.ts` passes
  the list in, so the tests can pass hostile data. Both holes of a line are escaped; Telegram shows
  every `/<command>` as a tappable command without markup.

The answer reads no state, so an admin-blocked user (`UserStatus.Blocked`) and a backend outage
get the same message; a user who blocked the bot cannot send `/help` at all. A static connect block
is accepted: a user with an account connected also reads «Если аккаунт ещё не подключён, нажми
/start». `/help@<bot username>` and `/help` with trailing text are answered the same way; groups,
supergroups and channels are ignored by `privateChats`, as for every command; any command that is
not in the menu is still ignored (#162). On the address or code step `/help` answers and leaves the
step and its clock untouched, as `/start` and `/account` do. A refused or failed `sendMessage`
reaches `bot.catch`, nothing is retried, and the handler writes no log line of its own.

`HANDLER_CALLS.help` is one Bot API call and no backend call (8 s). `texts.test.ts` holds the
message inside the limit, its exact assembly, the command lines equal to `botCommands()` (each
once, in order), the escaping of both holes, the feature lines shared with the card and both button
labels; `bot.test.ts` sends `/help` through the real handlers and fails when a command of the menu
is missing from the answer; `timing.test.ts` holds the declared calls.

## Command menu

Telegram's «Меню» button and the hints shown when the user types `/` list six commands, in this
order: `/start` — «Начать», `/menu` — «Главное меню» ([bot-menu.md](bot-menu.md)), `/account` —
«Аккаунт Binodex» ([bot-account.md](bot-account.md)),
`/settings` — «Настройки уведомлений», `/help` — «Помощь» ([/help](#help-184)) and `/support` —
«Поддержка» ([Notification level and /support](#notification-level-and-support-120)). The list is `BOT_COMMANDS` in
`packages/shared/src/bot-commands.ts`, the only place it is written (#301): each command's name and
the key of its description, the catalog's `commands` group, which the CLI can override
([bot-texts.md](bot-texts.md) → Publishing). The bot reads it through `botCommands()` in
`texts.ts`, with the descriptions in effect at that moment. The next command is one more pair there,
one more key in the catalog, and one more literal in each of the two `setMyCommands` assertions of
`lifecycle.test.ts`, which name the values on purpose.
`packages/shared/src/bot-commands.test.ts` holds the list equal to the `commands` group (each key
once) and the Bot API limits (a command of 1-32 lowercase letters, digits and underscores, a
description of 1-256 UTF-16 code units, at most 100 commands, each once); an override is held to
256 by its catalog entry. `commands.test.ts` sends every listed command through the real handlers
to check that it is answered — grammY keeps no registry of handlers to ask instead. A handler with
no menu entry is invisible to that check.

The scope is `all_private_chats`: the bot ignores every other chat type (`bot.chatType('private')`
in `bot.ts`), so a menu there would offer commands nothing answers. For a user in a private chat
Telegram consults this scope before `default`, so a list set earlier through @BotFather (which
sets `default`) is shadowed where the bot talks and would still show in groups. No
`language_code` is sent: one list for every interface language.

`runBot` (`apps/bot/src/lifecycle.ts`) registers the list on every start, inside grammY's
`onStart` — after `getMe` and `deleteWebhook` have succeeded and before the first `getUpdates` —
so an invalid token fails once, at `getMe`, and the list is on Telegram's side before the first
update is taken. Before the registration `onStart` waits for the first load of the text overrides
(`botTexts.loaded()`, at most `BACKEND_REQUEST_TIMEOUT_MS`), so the menu carries the overridden
descriptions; a failed load registers the defaults (#301). A signal during that wait skips the
registration. `setMyCommands` replaces the whole list of the scope, so a command removed from
`BOT_COMMANDS` disappears on the next successful registration. The CLI publishes the same list
after a change ([bot-texts.md](bot-texts.md) → Publishing).

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

## Bot profile

Two texts describe the bot before anyone talks to it. The **description** is the «Что умеет этот
бот?» block an empty chat shows before Start; the **short description** is the line on the bot's
profile page and in the preview of a shared link to it. Both are written once, as the catalog's
`profileDescription` and `profileShortDescription` ([bot-texts.md](bot-texts.md)), which the CLI
can override and publish (#301, bot-texts.md → Publishing), read by
`PROFILE` in `apps/bot/src/texts.ts`, and follow the [Style](#texts) of the other texts. Telegram parses neither, so they are plain and never escaped, and line breaks are kept
as written. The Bot API bounds the description at 512 and the short description at 120 characters,
counted here in UTF-16 code units (`String#length`, the unit `bot-commands.test.ts` counts in).
`texts.test.ts` holds both limits against the texts themselves, refuses an empty text (an empty
string is what removes the text on Telegram's side), markup or an entity, a non-empty line without a
leading emoji, a line with a space at either end, and a line break in the short description.

`runBot` registers them on every start, inside grammY's `onStart`, after the first texts load and
right after the command menu: `setMyCommands`, then `setMyDescription`, then
`setMyShortDescription`, one call at a time and
one attempt each. Every call is caught on its own — a refusal, a transport failure or the 8 s
client timeout, anything else — and logged at `warn` by the error's identity and the method:
`bot commands not registered`, `bot description not registered`,
`bot short description not registered`. The next call is still made and polling begins as usual;
a failure costs that part of the profile, and Telegram keeps the last value that did register
until the next start repeats the call. No `language_code` is sent: one text for every interface
language, as for the menu. The value typed into @BotFather is the same property, so the first
successful registration replaces it.

The bot's name and avatar are not registered: they stay with @BotFather (`setMyName` and
`setMyProfilePhoto` are not called, owner, 2026-10-02).

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
which declares what each handler does on its longest path: `/start` and `/menu` are two backend
calls and up to four Bot API calls (the access read, then the status card: the photo refused, the
text, the unpin, the pin — [bot-menu.md](bot-menu.md)); the demo button is one backend call and two
Bot API calls, and each demo screen after it one backend call and up to three Bot API calls (the
query answered, the edit refused, the screen sent anew — [bot-demo.md](bot-demo.md)), except
«📊 Анализ», three backend calls (the catalog, the signal, the access read for the stake label —
#297) and up to four Bot API calls (the query answered, «⏳» and the result, one of the two edits
refused and sent anew); the
stake button is four backend calls (the catalog and the access read together but counted one after
the other, the intent and its one retry) and two Bot API calls, and «🔄 Обновить статус» two backend
calls and up to three Bot API calls ([bot-demo-trade.md](bot-demo-trade.md)); the resend button is one
backend call and two Bot API calls; an old oauth button (#314) is no backend call and two Bot API
calls (the query answered, the keyboard removed); the confirm button is one backend call and up to five
Bot API calls (the query answered, then the account card: the photo refused, the text, the unpin,
the pin); the connect button is no backend call and two Bot API calls; a `my_chat_member` update
is one backend call and no Bot API call (5 s); a text on the address step is one backend call and
one Bot API call, as are `/account` (the read, then the status) and `/settings` (the read, then the
levels); a level pressed is one backend call and up to three Bot API calls (the query answered,
the edit refused, the message sent anew), the selected level one Bot API call, `/support` and
`/help` one Bot API call and no backend call each; the stake picker, the session buttons and an
old duration button are declared in the same table (bot-demo-trade.md, bot-session.md,
bot-demo.md); and a text on the code step two backend calls (the login and the recheck) and up to
four Bot API calls (the same card), 42 s. The longest is «📊 Анализ», 3 × 5 000 + 4 × 8 000 =
**47 s**, inside the **50 s** shutdown budget, inside the **55 s** `stop_grace_period` of the
compose service. The usual path is far shorter — the answer, the «⏳» edit and the result's edit
beside three short reads — and the 47 s needs three backend calls and four Bot API calls each to
hit its timeout. `timing.test.ts` runs
every terminal branch of each handler through the real handlers and asserts that each makes the
calls it is declared to make and that the worst of them is what `HANDLER_CALLS` says — so a
handler that grows a call turns the suite red instead of quietly outgrowing the budget. It reads
`stop_grace_period` out of `compose.yaml` rather than trusting it, and grammY's polling backoff
out of grammY.

What that test cannot see, and no test here can: a handler or a terminal branch nobody added to
the enumeration. Adding either is a manual step, because grammY keeps no registry of handlers.

On SIGTERM or SIGINT `runBot` stops taking updates and waits for `bot.stop()`, the polling loop
itself and the intent tracker's `stop()` (#127: its timers cleared, the poll in flight drained,
`INTENT_TRACK_DRAIN_MS` = 5 s + 8 s = 13 s, a conjunct of the chain) within the budget, then exits 0. A second signal is ignored: the listeners
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

The profile registration ([Command menu](#command-menu), [Bot profile](#bot-profile)) is
`STARTUP_CALLS` = 3 Bot API calls at startup, one after another, each bounded by the same 8 s
client timeout, after the wait for the first texts load (the refresher's budget,
`BACKEND_REQUEST_TIMEOUT_MS` = 5 s, as `index.ts` wires it), and is not part of `HANDLER_CALLS`: no
update is in flight while it runs. Its bound is `STARTUP_BUDGET_MS` = 5 s + 3 × 8 s = **29 s**, and
`STARTUP_BUDGET_MS < SHUTDOWN_BUDGET_MS` is a conjunct of the import-time chain; `lifecycle.test.ts` checks that the real start makes exactly
`STARTUP_CALLS` calls between `deleteWebhook` and the first `getUpdates`. grammY awaits `onStart`
to completion and `bot.stop()` cancels none of these calls, so a SIGTERM during the registration
waits for all three (≤ 24 s) with `bot.stop()`'s offset confirmation (≤ 8 s) running alongside,
inside the 50 s budget, and grammY then returns from `start()` without a first `getUpdates`. In
that case `bot started` is still written, after `shutting down`, because `onStart` finishes before
grammY sees the stop.

An overrun exits 1, losing the update in flight rather than the whole container's shutdown. The
closing line distinguishes the two ways a drain ends badly: a step that rejected logs itself as
it fails (`shutdown: bot.stop() failed`, `shutdown: polling loop failed`,
`shutdown: intent tracker failed`), and the budget line is
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
- **#24** — the status card a connected user gets on `/start` and `/menu`: [bot-menu.md](bot-menu.md);
  the demo flow behind its button and the analysis screen: [bot-demo.md](bot-demo.md); the demo
  trade and its status message: [bot-demo-trade.md](bot-demo-trade.md) (#127).
- The bot's name and avatar — set by hand in @BotFather; `setMyName`/`setMyProfilePhoto` are not
  called (owner, 2026-10-02).
- The staff bot's profile (`apps/backend/src/admin`, `ADMIN_BOT_TOKEN`) — not registered.
- **#31** — referral start links; they take their own payload prefix, and the format is not
  fixed here.
- **#114** — the Mini App login and callback pages in `apps/web` behind the `web_app` button the
  bot no longer sends (#314); the `initData` check they rely on is the backend's (#113,
  binodex-oauth.md).
- **#35** — end-to-end coverage against the mock broker.
- **#123, #124** — scenarios of the mailing engine (#202, [mailing.md](mailing.md)), which claims
  with `acceptsMailing()`, records each mailing as a `sent` job and calls
  `recordTelegramSendFailure` ([Blocking the bot](#blocking-the-bot-119)).
- **#220** — a permanent support account in place of the temporary `SUPPORT.telegramUsername`.
- Per-kind toggles, a daily digest, quiet hours — not asked (#120).
- **#185** — `/account`, the state of the Binodex link: [bot-account.md](bot-account.md).
