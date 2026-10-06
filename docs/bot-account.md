# /account — the state of the Binodex link

`/account` (#185) shows a user, in the bot, which Binodex accounts are linked to their Telegram
account and in what state. It reads only: the users row is not refreshed and nothing is
recorded — `/start` and `/settings`, both through `POST /users/start` ([bot-start.md](bot-start.md)),
are the places that write it.

## Components

- `packages/shared/src/account.ts` — the contract: `USER_ACCOUNT_LIST_LIMIT`, `UserErrorCode`,
  the request and response schemas of `POST /users/account`, and `isPendingLink`.
  `account.typecheck.ts` beside it is compiled by `tsc -b` and holds the claim that `id` exists on
  the pending member only.
- `packages/db/src/account-ops.ts` — `readUserAccounts` (two plain selects) and the allowlisted
  projections `toLinkedAccountView` and `toUserAccountView`.
- `apps/backend/src/users/routes.ts` — `POST /users/account`, in the same encapsulated plugin as
  `POST /users/start`, so the same internal bearer hook covers it.
- `apps/bot/src/` — `backend-client.ts` (`readAccount`), `texts.ts` (the `account*` entries,
  `accountStatus`, `LABELS.accountCommand`), `bot.ts` (the handler, `accountKeyboard`,
  `addConnectButtons`), `commands.ts` (the menu entry), `timing.ts` (`HANDLER_CALLS.account`).

## Sequence

```text
/account [anything]
  bot  → POST /users/account { telegramUserId }
  back → 200 { user: { status, accounts: [...] } }   or   404 { error: 'user_not_found' }
  bot  → one message:
           blocked                     → TEXTS.blocked, no buttons
           404 user_not_found, or []   → TEXTS.accountNone + the two connect buttons
           links                       → accountStatus(accounts) + accountKeyboard(accounts)
           anything else               → TEXTS.unavailable, warn '/account not read'
```

The command is answered in private chats only, with or without trailing text. The handler is
registered right after `/start` and does not call `next()`, so the email dialog's text handler
never sees it: `/account` in the middle of the dialog is answered and the dialog, its step and its
clock are left as they were.

## The message

`accountStatus` (`apps/bot/src/texts.ts`) builds a header, a blank line, then one line per link in
the order the backend sent them (newest first). The header follows the best link there is:

| Links                        | Header                        |
| ---------------------------- | ----------------------------- |
| at least one `active`        | `accountConnected`            |
| no `active`, a `pending` one | `accountPending`              |
| only `revoked`               | `accountRevoked`              |
| none                         | `accountNone` alone, no lines |

Each line is `accountLineActive`, `accountLinePending` or `accountLineRevoked` with the address;
an address the broker did not send, or sent blank, is «адрес неизвестен» (`accountUnknownAddress`,
a fragment nested without a second escape). The address is a hole of `telegramHtml`, escaped once. The texts
are the ones the owner approved on 2026-10-03, verbatim.

## The keyboard

`accountKeyboard` puts one «✅ Подтвердить: ‹email›» button (or «✅ Подтвердить привязку» without an
address) per `pending` link — the same `LABELS.confirmButton`, callback data and confirm handler
as `/start` — and then, while no link is `active`, the welcome's two rows «🔗 Подключить аккаунт
Binodex» and «🌐 Войти через сайт Binodex» (`addConnectButtons`, shared with the welcome). A user
whose links are all `active`, or `active` and `revoked`, gets the text with no `reply_markup`.

| Links                   | Confirm buttons | Connect buttons |
| ----------------------- | --------------- | --------------- |
| none / `user_not_found` | —               | yes             |
| `active` (± `revoked`)  | —               | —               |
| `active` + `pending`    | one per pending | —               |
| `pending` (± `revoked`) | one per pending | yes             |
| `revoked` only          | —               | yes             |

## POST /users/account

Internal route, `Authorization: Bearer <INTERNAL_API_TOKEN>`, the hook of `POST /users/start`.
Request and response are validated by `@binarius/shared/account`.

| Request field    | Notes                                             |
| ---------------- | ------------------------------------------------- |
| `telegramUserId` | decimal string, the shared `telegramUserIdSchema` |

| `user` field | Notes                                                             |
| ------------ | ----------------------------------------------------------------- |
| `status`     | `active` or `blocked`                                             |
| `accounts`   | every `broker_accounts` row of the user, newest first, at most 10 |

Each entry of `accounts` is `{ status, email }`, and a `pending` entry also carries `id` — what
the confirm button sends back. The wire shape is a union discriminated by `status`, so an active
or revoked row's id cannot leave the backend by type, and the bot's `z.object` strips a stray one.
No token, `brokerUserId`, `users.id`, revocation reason, halt flag or partner flag is selected.

| Outcome                                               | Source                                          | Bot                                          |
| ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| 200, `status: 'blocked'`                              | the users row                                   | `TEXTS.blocked` only                         |
| 200, `accounts: []`                                   | a users row with no `broker_accounts` row       | `accountNone` + connect buttons              |
| 200, `accounts: [...]`                                | the rows                                        | `accountStatus` + `accountKeyboard`          |
| 404 `user_not_found`                                  | no users row (the backend was down on `/start`) | `accountNone` + connect buttons, no log line |
| 404 `not_found`, 401, 400 `validation`, any other 4xx | the route refused or is absent                  | `TEXTS.unavailable` + warn                   |
| 5xx, unreachable, timeout, a broken 2xx body          | unknown                                         | `TEXTS.unavailable` + warn                   |

The bot tells «no users row» from «no route» by the error code, never by the status: a backend
without this route answers a bare `404 not_found`, and that is an outage, not «не подключён».
The warn line is `/account not read` with `errorLogFields` and `backendStatus`/`backendReason`;
`BackendError` carries the status and the bare error code only, nothing else from the body.

The read is two plain selects without a transaction — the users row, then its accounts — and
locks nothing. A block or a link landing between them can make one answer a few milliseconds
mixed; the answer is informational and the next `/account` reads again.

## The list bound

`USER_ACCOUNT_LIST_LIMIT` = 10 bounds three places: the query's `limit`, the response schema's
`.max`, and the texts test. With 10 links whose addresses are 254 characters of `<&>_*"`, the
message is 2 708 (active), 2 853 (pending) and 2 893 (revoked) UTF-16 code units of the 4 096
Telegram accepts; it crosses the limit at 16, 15 and 15 links. `texts.test.ts` asserts both sides.
Beyond 10 links the oldest are dropped silently, with no «и ещё N»: each link is a distinct broker
account linked by hand, and nobody is expected to have more than ten.

The broker's address is not bounded on the wire, so an absurd one can still push the message over
the limit; Telegram then refuses it, the user gets nothing, and the error reaches `bot.catch` like
any other runtime refusal ([bot-start.md → Texts](bot-start.md#texts)). There is no fallback: the
message is a text message already, not a caption, and a shorter one would have to drop links.

## An empty address

An address that is empty or only whitespace is no address: `addressOrNull`
(`packages/shared/src/oauth.ts`) turns it into `null` and leaves any other address as the broker
sent it. `toOAuthTokens` applies it, so a blank address from the broker is stored as NULL, on the
first login and on a re-login alike (the latest answer wins). Rows stored before #214 may still hold
a blank one; nothing rewrites them, and the same function runs in the three projections that read
the column — `toLinkedAccountView` (`/account`), `toUserStartView` (`/start`'s confirm buttons) and
`toBrokerAccountView` (the callback, confirm and email-login answers, and the push after the
callback). So `/account` reads «адрес неизвестен», both confirm buttons read «✅ Подтвердить
привязку», and the account card after the confirm button has no 📧 line (after an email login it
shows the address typed in the dialog), rather than «Подключён: » or «📧 Аккаунт Binodex: » with
nothing after it. The column has no CHECK: a future writer that bypasses `toOAuthTokens` is
caught by the projections, not by the database.

## Timing

`HANDLER_CALLS.account` = one backend call and one Bot API call (`readAccount`, then
`sendMessage`), 13 s; the longest handler path (`confirm`, 45 s) is unchanged. `timing.test.ts`
runs every branch — no sender, a group, an active link, a pending and a revoked link, no link, a
blocked user, `user_not_found`, an unreachable backend — and checks the declaration against the
worst of them.

## Boundaries

- **#136** — the token balance is `POST /trading/access` ([trading-access.md](trading-access.md)); the bot shows it from #24.
- **#24** — the main menu, and re-sending a lost or unpinned account card.
- `/help` lists the commands from `BOT_COMMANDS`, `/account` included ([bot-start.md → /help](bot-start.md#help-184)).
- **#120** — `/settings` and `/support`: [bot-start.md](bot-start.md#notification-level-and-support-120).
- **#119** — a user who blocked the bot ([bot-start.md → Blocking the bot](bot-start.md#blocking-the-bot-119)); `/account` does not read or clear that mark.
- The revocation reason (`auth_revoked_reason`) stays internal: the user sees «Подключение
  отозвано» and the way back in.
