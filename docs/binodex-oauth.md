# Binodex login (issue #9)

How a Telegram user ends up with a linked broker account, and how that account keeps a usable
access token afterwards. There are two ways in: the OAuth login below, and the email login
(#162, [Email login](#email-login-issue-162)), which the bot offers first. The broker's own contract — the authorize page, the 120-second
single-use code, the server-to-server code exchange and the token refresh — was checked against
the live broker on 2026-10-01 (#102, #163); see [Broker contract](#broker-contract-verified-2026-10-01).

## Components

| Component | Package                                   | Role                                                                                             |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Contract  | `packages/shared/src/oauth.ts`            | wire schemas, the login request/response shapes, the error codes and the four revocation reasons |
| Storage   | `packages/db/src/oauth-ops.ts`            | state rows, the linking transaction, rotation and revocation                                     |
| Starter pack | `packages/db/src/link-bonus-ops.ts`    | `LINK_BONUS_TOKENS` and `grantLinkBonus`, called by the confirmation (#10) and by the email login (#162) |
| Client    | `apps/backend/src/broker/oauth-client.ts` | the code exchange on `POST /v1/broker/oauth/token`, the refresh on `POST /v1/broker/user-auth/refresh`, and the email `send-code` and `login`, one attempt each, under a real abort; `BROKER_ENDPOINTS` is the one table of paths and statuses |
| Routes    | `apps/backend/src/auth/routes.ts`         | `POST /auth/binodex/start`, `POST /auth/binodex/callback`, `POST /auth/binodex/confirm`, `POST /auth/binodex/email/send-code`, `POST /auth/binodex/email/login` |
| Refresh   | `apps/backend/src/auth/token-service.ts`  | `ensureFreshAccessToken(accountId)`                                                              |
| Push      | `apps/backend/src/auth/link-notifier.ts`  | the one `sendMessage` after the callback (#128), on the public bot's token, without polling it   |
| Telegram proof | `apps/backend/src/auth/telegram-init-data.ts` | the signature and age check of the Mini App's `initData` the callback carries (#113); its limits live in `apps/backend/src/auth/oauth-timing.ts` |
| Link texts | `packages/shared/src/link-confirmation.ts` | the texts and the confirm button's callback data the bot and the push both send               |
| Mini App pages | `apps/web/src/oauth/` | `GET /oauth/login`, `GET /oauth/callback`, `POST /oauth/callback` (the forward to the backend) and the page script (#114); [The Mini App pages](#the-mini-app-pages-114) |

## Sequence

```
bot ──POST /auth/binodex/start (internal token)──▶ backend
        │                                   creates oauth_states row (hash only, 10 min TTL)
        ◀── { authorizeUrl, state, expiresAt, miniAppUrl (https redirect URI only) }
bot ──web_app button on miniAppUrl (a url button on authorizeUrl without it)──▶ user
Mini App ──GET /oauth/login?authorize=…──▶ web: checks authorize, renders the page
page ──location.replace(authorizeUrl), same webview──▶ binodex.app  (client_id, redirect_uri, state, ref)
broker ──302 <redirect_uri>?code&state──▶ web: GET /oauth/callback, the callback page
page ──POST /oauth/callback {code, state, initData}──▶ web (Origin check)
web ──POST /auth/binodex/callback (public, no bearer), the body unchanged──▶ backend
        │  initData signature + age (no query) ──▶ CAS on the state row
        │  ──▶ initData user == state's Telegram id ──▶ exchange code
        │  ──▶ link user + broker account (pending)
        │  after the commit: sendMessage to the state's Telegram id ──▶ "✅ Подтвердить" button (#128)
        ◀── { account }                       web ──▶ page: { outcome } ──▶ its text
user ──/start──▶ bot: pendingBrokerAccounts is not empty ──▶ "✅ Подтвердить" button (#10)
bot ──POST /auth/binodex/confirm (internal token)──▶ backend   pending ──▶ active, starter pack
        ◀── { account, grant }
later: ensureFreshAccessToken(accountId) ──▶ stored token, or one exchange, or a revocation
```

The email login (#162) has no browser leg and no confirmation:

```
bot ──POST /auth/binodex/email/send-code (internal token)──▶ backend ──▶ broker email/send-code
        ◀── { codeSent: true }                                   the broker mails a code
bot ──POST /auth/binodex/email/login (internal token, code)──▶ backend ──▶ broker email/login
        │                   (partner_code) ──▶ link user + broker account (active), starter pack
        ◀── { account, grant }
```

## Why the callback is public

The page that receives the code runs in a browser and cannot hold the internal API token. The
single-use state is what authorizes the call: 32 random bytes, stored only as a SHA-256 hash,
consumed by one `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`. Two parallel
callbacks with one state therefore produce exactly one exchange, and a forged, expired or
replayed state never reaches the broker at all.

The state names the login; it does not say who finished it. That is what `initData` is for
(#113): the page runs as a Telegram Mini App of the public bot and sends `Telegram.WebApp.initData`
unchanged — re-encoding it changes the signed values (`+` reads as a space). The backend checks it
as core.telegram.org/bots/webapps → *Validating data received via the Mini App* describes: the
key is HMAC-SHA256 of `TELEGRAM_BOT_TOKEN` under `WebAppData`, the hash covers every other field
sorted by key, and every field Telegram sent stays in the check. The route runs its steps in
this order (`apps/backend/src/auth/routes.ts`):

1. the ceiling below, before the body is read;
2. the body schema: `state`, `code` and `initData` (at most 4096 characters, `INIT_DATA_MAX_LENGTH`
   in `packages/shared/src/oauth.ts`) — 400 `validation`;
3. the `initData` signature, then its age, then its `user` field, without a single query — 401
   `invalid_telegram_auth`. The state is not touched and nobody is told: its owner is not known
   yet. `auth_date` may be at most `INIT_DATA_MAX_AGE_MS` old — the state's ten-minute TTL plus
   60 s for the two clocks, all three in `apps/backend/src/auth/oauth-timing.ts` — because the
   Mini App opens on a button the bot shows after the state exists, and the callback has to
   arrive before the state expires. An `auth_date` ahead of this host's clock is accepted: only
   Telegram can sign one. A `user.id` that is not a positive safe integer is refused, because
   `JSON.parse` would already have rounded it;
4. the state CAS — 400 `invalid_state`;
5. the Telegram id the `initData` names against `oauth_states.telegram_user_id` from the row the
   CAS returned. A mismatch is 403 `telegram_user_mismatch`: the state stays spent, the code never
   reaches the broker, nothing is written to `broker_accounts`, and the state's owner gets the
   «❌ Не удалось завершить вход…» push. The response says nothing about the owner to the browser
   that sent it;
6. the code exchange and the link, as before.

The route also carries an 8 KB body limit (every field at its schema maximum, plus the JSON
around them) and two counters per process, both on a one-minute
window and neither keyed by IP: `trustProxy` is not configured, so behind a reverse proxy every
request would arrive from one address, and trusting the forwarded header without a proxy list
would let a caller choose its own.

| Counter | Limit | Spent by | What it bounds |
| --- | --- | --- | --- |
| all requests | 3000/min | every request, before the body is parsed and before any query | how much work an anonymous caller can trigger at all |
| failed state lookups | 600/min | only a state that resolved to no row | junk, without letting real logins close the door |

A refused `initData` spends only the ceiling: checking it is a hash, not a query. A mismatch
spends only the ceiling as well, because its state did resolve to a row.

Both counters **reserve** their slot before the work they limit, and the failure counter gives
its slot back when the work turns out not to be a failure: the callback takes a failure slot
before the state lookup and releases it when the state resolves, or when the lookup itself
throws. The ceiling never releases — every request counts against it, which is the point. A counter
incremented after the lookup would let a whole concurrent burst through, because none of them
has counted yet while the others are being admitted. A database outage does not spend the
budget either — it is not a guess.

A successful login spends only the ceiling, so a burst of real users cannot exhaust the narrow
counter. The narrow limit is deliberately high: a 32-byte state cannot be guessed, so the window
only has to bound junk, and a low threshold would have meant one request per second could close
the callback for everyone. A per-IP limit belongs with the proxy configuration (#4); a
distributed one is a follow-up.

## The Mini App pages (#114)

`initData` exists only inside a Mini App, so the login runs in one: the bot's button is a
`web_app` button on the `miniAppUrl` the start answered, and both the broker's page and the
callback page load in that one webview. `apps/web` serves the two pages (`apps/web/src/oauth/`);
the paths, the query parameter name, the body limit and the callback budget are constants in
`packages/shared/src/oauth.ts`.

**The login page (`GET /oauth/login?authorize=<authorizeUrl>`).** The backend builds `miniAppUrl`
from the redirect URI's origin and `OAUTH_LOGIN_PATH`, with the authorize URL as the parameter,
and only for an `https:` redirect URI: Telegram takes only https in a `web_app` button, so the
local stack's loopback redirect gets the old `url` button instead. The page refuses — 400, a
notice, and a one-word `reason` in the log, never the value — any `authorize` that is longer
than 2 048 characters, not a URL, not `https:`, not exactly the configured
`BROKER_OAUTH_AUTHORIZE_URL`'s origin and path, without a `state` of 1-256 characters, or whose
`redirect_uri`, parsed as a URL, is not `<WEB_PUBLIC_URL>/oauth/callback` (host case and a default
port do not matter; a query, a fragment, credentials or a trailing slash do). The parameter is
therefore not an open redirect, and the broker sends the user back to the origin that holds the launch data. Otherwise
the page loads Telegram's SDK and navigates the same webview to the broker with
`location.replace`; the link on the page is for a webview that does not.

**The round trip.** Telegram puts the launch data in the Mini App's URL fragment; the broker's
redirect loses it. Telegram's SDK (`telegram-web-app.js`) stores those parameters in
`sessionStorage` and restores them when the fragment is empty, so the callback page, on the same
origin and in the same webview, reads `Telegram.WebApp.initData` again. That the webview keeps
`sessionStorage` across the broker's origin and back is an assumption the first live test checks
(below); nothing in this repository can.

**The callback page (`GET /oauth/callback?code&state`).** It renders neither value. A redirect
without both, or with either outside the callback schema's bounds (a cancelled login, a broker
error), answers 400 with «Не удалось завершить вход. Начните заново из бота.» and nothing is
posted. Otherwise the page script:

1. takes `initData` from the SDK; empty, or no SDK at all, shows «Откройте вход из Telegram ещё
   раз.» and calls nothing;
2. drops the query with `history.replaceState`, so a reload lands on the notice rather than
   sending a spent code again;
3. posts `{ state, code, initData }` to `POST /oauth/callback` on `apps/web` — `initData` exactly
   as the SDK gives it, no parsing, trimming or re-encoding;
4. shows the block the answer names. Every text is rendered by the server; the script only
   chooses which one is visible, and a non-2xx answer, a body that is not JSON or a failed fetch
   shows the «unknown» text. «Вернуться в Telegram» calls `Telegram.WebApp.close()`.

**Why the browser calls `apps/web`, not the backend.** On the VPS the backend is private: the
proxy routes the domain to `web` only. `apps/web` validates the body with the shared
`oauthCallbackRequestSchema` (400 `validation` otherwise), applies its Origin check (every POST),
and forwards the body unchanged to `POST /auth/binodex/callback` **without a bearer**: the
backend's public scope checks none, and the admin bearer opens `/admin/*`, so sending it here
would only be a place for it to leak. `client_secret` never leaves the backend. The forward's
body limit is the backend's, `OAUTH_CALLBACK_BODY_LIMIT_BYTES`. Neither page keeps a rate limit
of its own: the backend's two counters above bound the work.

**The outcomes.** The state column is what the backend did to the state row before answering
(the route order in [Why the callback is public](#why-the-callback-is-public)):

| Backend answer | State | `outcome` | Text |
| --- | --- | --- | --- |
| 200 `{ account }` | spent | `linked` | «Готово. Вернитесь в Telegram — бот прислал сообщение о подключении.» |
| 401 `invalid_telegram_auth` | alive | `open_from_telegram` | «Откройте вход из Telegram ещё раз.» — the bot's button still works for this state |
| 429 `too_many_requests` | alive | `busy` | «Сейчас слишком много запросов. Через минуту откройте вход из Telegram ещё раз.» |
| 400 `invalid_state`, 403 `telegram_user_mismatch`, 400 `invalid_code`, 502 `broker_unavailable`, 502 `broker_contract_violation` | spent or none | `start_over` | «Ссылка для входа устарела. Начните заново через /start.» |
| 409 `user_blocked` | spent | `blocked` | «Доступ ограничен.» |
| 409 `broker_account_taken` | spent | `taken` | «Этот аккаунт Binodex уже подключён к другому пользователю Telegram.» |
| 400 `validation` | alive | `start_over`, and an `error` line: our own body was refused, a drift between the two processes | as above |
| anything else, no answer, a 2xx outside the contract | unknown | `unknown` (`apps/web` answers 500 and logs the error by identity) | «Не удалось получить результат входа. Вернитесь в Telegram: если вход прошёл, бот прислал сообщение, иначе начните заново через /start.» |

The page never infers an outcome it was not told and never retries the POST: the link is
reported by the push (#128) and shown again by `/start` (#10).

**Headers.** The `/oauth/*` routes send their own policy, `default-src 'none'; script-src 'self'
https://telegram.org; connect-src 'self'; style-src 'self'; form-action 'none'; frame-ancestors
https://web.telegram.org; base-uri 'none'`, and no `X-Frame-Options` — a browser that honours both
would let `DENY` override `frame-ancestors`. `https://web.telegram.org` is Telegram Web, where the
Mini App runs in an iframe, and the one parent origin the SDK itself trusts. In that iframe the
SDK also injects a `<style>` element that Telegram Web fills with a custom style;
`style-src 'self'` refuses that style, which costs the styling and nothing else. `nosniff`, `referrer-policy: no-referrer` (the navigation to the
broker carries no `Referer`), `cache-control: no-store` and HSTS are the same as on the admin
pages, whose own policy and `X-Frame-Options: DENY` are unchanged.

**Timeouts.** The backend may hold the callback for `OAUTH_CALLBACK_BUDGET_MS` (8 s,
`packages/shared/src/oauth.ts`): the code exchange (5 s) and the push (3 s); its timing chain
checks that the two fit and that the budget fits in shutdown phase 1. `apps/web` waits 10 s for
the forward (`OAUTH_CALLBACK_REQUEST_TIMEOUT_MS`), above the budget so it never gives up on a link
that is still going to happen; its shutdown budget is 11 s and the compose `stop_grace_period`
14 s. Both chains throw at import when out of order.

**The first live test**, on a phone with the VPS deployed and the local stack stopped (they share
the bot token): `/start` → «🌐 Войти через сайт Binodex» → the `web_app` button → the broker's login
inside the Mini App → the callback page → «Готово» → the push with «✅ Подтвердить». It checks the
two assumptions nothing here can: (a) the webview keeps `sessionStorage` across `binodex.app`
and back — «Откройте вход из Telegram ещё раз» on the callback page although it was opened from
Telegram means it does not, and the fix is another carrier for the proof (a new issue); (b) the
broker's login page works inside the webview. A `web_app` URL Telegram refuses shows up as no
message at all after the tap and an `update handler failed` line in the bot's log carrying
Telegram's error code (`apps/bot/src/bot.ts` → `bot.catch`). Then once from Telegram Web.

## Why a new account starts pending

The callback proves that **someone** authorized at the broker. It does not prove that the person
who finished the login is the Telegram user who started it: the authorize URL is an ordinary
link, and a link can be handed to somebody else. Without a second step, an attacker who passes
their own link to a victim ends up with the victim's brokerage account attached to the
attacker's Telegram account.

So the callback calls `linkBrokerAccount` with `activate: false`, which writes a new account as
`pending`, and on this path only `POST /auth/binodex/confirm` — called by the bot, carrying the
internal token and the Telegram id — turns it into `active`. The email login is the one caller
that activates directly ([Why it skips pending](#why-it-skips-pending)). Three rules make the
OAuth gate hold:

- a second OAuth login **does not** stand in for the confirmation: a `pending` row stays `pending`,
  though its tokens are still rotated. Only a row that was `active` or `revoked` returns to
  `active` on a re-login, because its owner confirmed it once already;
- confirmation is scoped by ownership. The account is looked up by id **and** user, so an
  account that belongs to somebody else is indistinguishable from one that does not exist;
- the user row is read under lock inside the same transaction, so a block landing at the same
  moment cannot slip past.

A `pending` account cannot trade: both account-selection paths in `packages/db/src/trade-intent-ops.ts`
filter on `active`, and the trading API answers `account_not_confirmed` rather than the
misleading `account_halted`. That matters because `apps/trading-worker` never reads the account
status at all — it trusts that nothing reached the queue for an account that may not act. The
invariant it depends on: no intent is created for a non-active account, and there is no
`active → pending` transition.

**Residual risk.** The confirmation makes an unexpected link visible and costs the attacker an
extra step, but in the scenario above the person confirming is the attacker, who sees the
victim's email and agrees. Since #113 the callback also needs proof of who finished the flow:
`initData` signed for the Telegram user the state belongs to ([Why the callback is
public](#why-the-callback-is-public), steps 3 and 5). A handed-over link that the victim
finishes in their own Telegram ends in 403 `telegram_user_mismatch`; one finished in a plain
browser carries no `initData` and never reaches the state. Neither writes a row, so the victim's
own later login is not answered with `broker_account_taken`.

What is left:

- a victim who sends the attacker the address the broker redirected them to — code and state —
  within the code's 120 seconds. The attacker then finishes the login with their own `initData`,
  which matches their own state; the confirmation does not help either, because the attacker is
  the one confirming;
- a captured `initData` replayed within its window links an account only to the Telegram user it
  names, never to anyone else;
- the compromise of the user's Telegram account itself, which is outside this model.

## The state row

`oauth_states` keeps the hash, the Telegram id, the redirect URI it was issued for, an expiry
and a `used_at`. Everything the callback acts on comes from the row the CAS returns, never from
the request body. The TTL is ten minutes — the state is created before the user types their
credentials, while the broker's 120 seconds apply to the code that comes back. Expired rows are
deleted opportunistically when a new state is created, a hundred at a time with `SKIP LOCKED`,
so concurrent logins never queue on the same batch.

## Linking, and why it takes two steps

Token ciphertexts are authenticated against the row they live in (`keyId|accountId|field` as
AAD, `packages/db/src/crypto.ts`). A single `INSERT … ON CONFLICT DO UPDATE` would therefore
write ciphertext bound to a candidate id into a row that already has a different one, and
nothing could decrypt it afterwards. The transaction instead:

1. takes the `users` row (creating it if this is a first login) — lock order `users →
broker_accounts`, the same as every other writer;
2. inserts the account under an id generated up front, `ON CONFLICT (broker_user_id) DO NOTHING`;
3. if the account already existed, locks it `FOR NO KEY UPDATE`, checks the owner, and
   re-encrypts the tokens under its real id.

`id`, `user_id` and `broker_user_id` never change, which keeps the lock compatible with the
`KEY SHARE` locks the `trade_intents` foreign keys take. A blocked user is not unblocked by
logging in, and an account that belongs to another Telegram user answers 409
`broker_account_taken`. Several accounts per user stay allowed — ARCH-03 continues to answer
`ambiguous_broker_account` until the bot names one.

## What a re-login does and does not touch

It refreshes the tokens and clears `auth_revoked_reason`. What it does to `status` depends on
where the account was: an account that was `active` or `revoked` becomes `active` again, because
its owner confirmed it once already; one that is still `pending` stays `pending`, because a
second login is not the confirmation nobody gave. It does not touch `trading_halted` or
`halted_reason`: those belong to reconciliation (ARCH-04), and an account halted for an
ambiguous match stays halted through a re-login.

## The push after the callback (#128)

The user learns how the login ended from the bot, not from the page the broker sent them to: right
after `POST /auth/binodex/callback` has an outcome, the backend sends one message to the Telegram
id the state row names — the user who started the login — without waiting for them to come back
to the chat.

| Outcome of the callback | Status | Message |
| --- | --- | --- |
| a new link, or a re-login of an account still `pending` | 200 | «🔐 Найдена новая привязка…» with one «✅ Подтвердить: ‹email›» button for that account — what `/start` shows for it (#10); the bot handles the press as before |
| a re-login of an account that was `active` or `revoked` (it is `active` again) | 200 | «✅ Аккаунт Binodex подключён!», no button: nothing is paid on this path |
| `user_blocked` | 409 | «🔒 Доступ ограничен…» |
| `broker_account_taken` | 409 | «❌ Этот аккаунт Binodex уже подключён к другому пользователю Telegram…», to the user who started the login, never to the account's owner |
| `invalid_code`, `broker_unavailable`, `broker_contract_violation` | 400 / 502 | «❌ Не удалось завершить вход через сайт Binodex. Попробуй ещё раз через /start.» — the state is spent, so a retry needs a new one |
| `telegram_user_mismatch` | 403 | the same «❌ Не удалось завершить вход…», to the state's owner only, never to the Telegram user the `initData` names; the state is spent and the code was never exchanged |
| `validation`, `invalid_telegram_auth` | 400 / 401 | none: the state has not been read, so there is no addressee |
| `invalid_state` | 400 | none: the state is what names the addressee |
| a database failure | 500 | none: the outcome is unknown |

One attempt, after `linkBrokerAccount` has committed and outside any transaction, bounded by
`LINK_PUSH_TELEGRAM_API_TIMEOUT_MS` (3 s, `apps/backend/src/timing.ts`; the code exchange plus
the push stay inside shutdown phase 1, which the timing chain checks at import). The route
awaits it, so the page can wait up to those 3 s longer (plus, after a 403, one database write),
but its response does not depend on it: the status and body are the ones in the table whatever
Telegram answers, and nothing is written about the push, with one exception: a 403 marks the
user as having blocked the bot (#119,
[bot-start.md → Blocking the bot](bot-start.md#blocking-the-bot-119)) — their pending
`notification_jobs` are canceled, and every sender is to skip the user until they unblock or
send `/start` (a rule for senders that do not exist yet, not yet enforced by one). A push that does not arrive — Telegram refused it (403 when the user blocked the bot), was slow,
or was unreachable — is made up for by the button on the user's next `/start`; there is no queue
and no retry.

The backend holds the public bot's token (`TELEGRAM_BOT_TOKEN`) for this and only sends on it: a
bare grammY `Api` calls nothing until the push, not even `getMe`, so `apps/bot` stays the one
poller and there is no 409. A failed push is one `warn` line, `the link outcome could not be
pushed to Telegram`, carrying the error's name, the method, Telegram's error code or the
transport error's identity, and the outcome's kind (`push`) — no state, code, token or email:
grammY's transport error wraps a URL with the token in it, and the request payload holds the
email on the button.

To exercise the route without the Mini App, call the backend directly; the route needs
`initData` signed with `TELEGRAM_BOT_TOKEN`. `apps/backend/src/auth/testing/init-data.ts` signs one
for any Telegram id, the way Telegram builds it. From the repository root, with the backend
running and Node from `.node-version`:

```sh
set -a; . ./.env; set +a   # INTERNAL_API_TOKEN and TELEGRAM_BOT_TOKEN
BACKEND=http://127.0.0.1:3000
MY_ID=<your Telegram id>
sign() {
  TELEGRAM_USER_ID="$1" pnpm --silent --filter @binarius/backend exec tsx -e "import { signInitData } from './src/auth/testing/init-data.ts'; console.log(signInitData({ botToken: process.env.TELEGRAM_BOT_TOKEN, telegramUserId: BigInt(process.env.TELEGRAM_USER_ID) }))"
}
start() {
  curl -s -X POST "$BACKEND/auth/binodex/start" -H "authorization: Bearer $INTERNAL_API_TOKEN" \
    -H 'content-type: application/json' -d "{\"telegramUserId\":\"$MY_ID\"}"
}
callback() {   # state, code, Telegram id the initData names
  curl -s -w ' %{http_code}\n' -X POST "$BACKEND/auth/binodex/callback" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg state "$1" --arg code "$2" --arg initData "$(sign "$3")" \
      '{state: $state, code: $code, initData: $initData}')"
}
```

- Without the broker: `callback "$(start | jq -r .state)" any-code 1` answers
  `{"error":"telegram_user_mismatch"} 403`, and your chat gets «❌ Не удалось завершить вход…».
- With the broker: `start`, log in at its `authorizeUrl`, take the code from the address bar (as
  in the live check below) and run `callback <state> <code> "$MY_ID"` within 120 seconds: the
  chat gets the message for that outcome.

## The starter pack

Confirming a partner account (#10) pays its user `LINK_BONUS_TOKENS`, once per user — 100
autotrading tokens, defined once in `packages/db/src/link-bonus-ops.ts` and nowhere else; the bot prints the
number the backend sends. The demo balance is not part of it: the broker sets it when the account
is created, and nothing here stores or credits one.

- **Where.** `grantLinkBonus` runs inside the `confirmBrokerAccount` transaction, after the
  `UPDATE … SET status = 'active'`. The users row is already held `FOR NO KEY UPDATE`, so the
  lock order stays `users → broker_accounts`; the ledger row and `users.token_balance` change
  together, or not at all. The callback and a `pending` account pay nothing, and neither does a
  re-login that brings a `revoked` account back to `active` — that is not a first activation.
- **Once per user.** The ledger row is a `bonus` that names the account it was earned by
  (`token_ledger.broker_account_id`, a composite FK on `(id, user_id)`, so it can only name one
  of the user's own accounts), with `note = 'link_bonus'` for #13. The partial unique index
  `token_ledger_link_bonus_user_idx` on `user_id`, over bonuses that name an account, holds one
  such row per user; the insert is `ON CONFLICT … DO NOTHING`, and a second account answers
  `already_granted` with the balance untouched. The key is the user, not the account: linking a
  second account does not pay again.
- **Partner accounts only.** `is_partner_client`, as the broker reported it on the latest login
  and read from the locked row, decides. `false` links the account as usual — `active`, able to
  trade — pays nothing and answers `not_partner_client`. That rule lives in `grantLinkBonus`,
  not in the database, and it spends no slot: the same user confirming a partner account later
  still gets the pack.
- **The answer.** `POST /auth/binodex/confirm` returns `{ account, grant }`, where `grant` is
  `{ granted: true, tokens: "100" }` (a decimal string) or `{ granted: false, reason }` with
  `reason` one of `not_partner_client`, `already_granted`.
- **#162.** The email login calls the same `grantLinkBonus` inside `linkBrokerAccount`
  (`activate: true`), with the same preconditions: the users row held by `upsertUser`, the
  account made `active` by that transaction. It calls it on **every** email login, not only the
  first activation — the index is what holds one pack per user. The one difference from the
  OAuth path follows: a user whose `active` or `revoked` partner account never earned the pack
  (it was a non-partner account when it was confirmed) gets it on an email login, while an
  OAuth re-login pays nothing. That is the rule above — a partner account confirmed later still
  pays.

Accounts confirmed before migration `0008` received nothing; there was no production data then.

## Email login (issue #162)

The bot asks for an address, the backend asks the broker to mail a code to it, the user types the
code into the bot, and the backend redeems it. The broker registers a new account under
`partner_code` (`BROKER_PARTNER_REF`) or signs an existing one in; either way it answers the same
body as the code exchange, and the account is stored through the same `linkBrokerAccount` — the
same row, the same encryption, the same refresh through `user-auth/refresh`.

### Why it skips pending

`linkBrokerAccount(…, activate: true)` writes a new account as `active`, and turns the user's own
`pending`, `active` or `revoked` row into `active` with `auth_revoked_reason` cleared. Another
user's account is still `broker_account_taken`, with nothing written. The confirmation exists
because the OAuth callback proves only that *someone* authorized at the broker, and a link can be
handed to a victim. Here the code from the letter is typed into the bot by the Telegram user who
gets the account; a confirmation would be that user confirming to themselves. A `pending` row an
unfinished OAuth login left is activated the same way. The OAuth callback passes
`activate: false` and is unchanged, and the column default stays `pending`.

### Routes

Both are in the internal-token scope, next to `start` and `confirm`. The address is
`emailAddressSchema` (trimmed, then checked, at most 254 characters, case kept on the wire), the
code `emailLoginCodeSchema` (trimmed, 1-64 characters, any shape — the broker answers a wrong
shape with `Invalid or expired code` too). Neither the address nor the code is stored or written
to the log by these routes; `broker_accounts.email` holds what the broker reports, as with OAuth.

| Route | Answer | Errors |
| --- | --- | --- |
| `POST /auth/binodex/email/send-code` `{ telegramUserId, email }` | 200 `{ codeSent: true }` | 400 `validation`; 400 `invalid_email` (the broker refused the address); 409 `user_blocked`; 429 `too_many_attempts` / `too_many_requests`; 502 `broker_contract_violation` / `broker_unavailable` |
| `POST /auth/binodex/email/login` `{ telegramUserId, email, code }` | 200 `{ account, grant }`, as `confirm` | 400 `validation`; 400 `invalid_code` (wrong, expired or used code); 409 `user_blocked` / `broker_account_taken`; 429 `too_many_attempts` / `too_many_requests`; 502 `broker_contract_violation` / `broker_unavailable` |

The order inside each route: the route ceiling (an `onRequest` hook on the route, which runs after
the scope's bearer check, so a caller without the token cannot spend it), the body, the blocked
check (before the broker), the per-key windows, the broker, and for `login` the transaction.

### Limits

In-process windows (`rate-window.ts`), like the callback's: reset by a restart and per backend
process, which is what is deployed.

- **Ceilings:** 60 `send-code` and 300 `login` requests a minute for the whole route → 429
  `too_many_requests`. Every `send-code` is a real letter, so it is held far lower.
- **Per key, 10 minutes:** 3 `send-code` and 5 `login` attempts per Telegram user **and** per
  address (the key is the hash of the lower-cased address; the map holds no address) → 429
  `too_many_attempts`. The address window on `login` stops a brute force of one address's code
  spread across several Telegram accounts; the cost is that anyone who knows an address can hold
  its login for up to ten minutes, which `send-code`'s own address window allows already. The
  Telegram user is counted first, so a user over their own allowance does not spend the
  address's.
- The slot is taken **before** the broker call and never given back, even when the broker fails:
  a sixth attempt is refused even with the right code, and a broker outage spends the user's
  allowance.
- None of this depends on the broker's code lifetime or its own lockout, which were not measured.
  Whoever runs out waits and asks for a new code; every `send-code` is a new code.

### Accepted cost

The status map reads no body (see [Broker contract](#broker-contract-verified-2026-10-01)), so a
`BROKER_PARTNER_REF` of the right shape that does not belong to this installation's partner
account looks exactly like a wrong code: `invalid_code` to the user, 400/`invalid_grant` in the
warn line. The first live email login after a deploy is what checks it.

## Refresh

`ensureFreshAccessToken(accountId)` runs the whole decision inside one transaction holding the
account row, which makes it single-flight per account:

| Step                                                        | Outcome                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| account missing                                             | `account_not_found`                                                                                               |
| `status = pending`                                          | `account_pending` — nobody has confirmed it, so it may not act on the user's behalf                               |
| `status = revoked`                                          | `account_revoked` — checked **before** the expiry, so a revoked account never hands out the token it still stores |
| `token_key_id ≠ the process's key id`                       | `key_unavailable`, and **nothing is written** (see below)                                                         |
| ciphertext fails to decrypt under its own key id            | revoke `storage_inconsistent`                                                                                     |
| stored hash ≠ hash of the stored ciphertext                 | revoke `storage_inconsistent`                                                                                     |
| access token still valid (60 s skew)                        | return it; a legacy row missing its hash gets one here, and only the hash                                         |
| `coalesce(token_rotated_at, created_at)` older than 90 days | revoke `refresh_expired`, without asking the broker                                                               |
| otherwise                                                   | exactly one refresh exchange                                                                                      |

A row encrypted under another key id is left strictly alone. During a key rollout both the old
and the new process are running, and a process holding the old key would otherwise see every
freshly re-authorized account as inconsistent and revoke it — undoing a login the user has just
completed. Declining to serve the row costs an error for one process and nothing else; the
process that holds the matching key serves it normally.

The backfill of a missing `refresh_token_hash` writes that column and `updated_at`, which every
write here bumps. In particular it leaves `token_rotated_at` alone: that column dates the refresh
token and starts the ninety-day clock, so moving it would hand a token that is already months old
another ninety days of life.

Exchange failures map to revocations, never to retries:

| Failure | Reason |
| --- | --- |
| broker answers 401 to `user-auth/refresh` (`Invalid token`: unknown or already consumed) | `refresh_invalid_grant` — the token was already consumed, which is what a replayed refresh token looks like from our side |
| anything else | `refresh_outcome_unknown` — a timeout, a network error or a 5xx, but also a 4xx other than 401 (a 400 means our request was malformed, and the broker may still have read the token) and a 2xx whose body breaks the contract. In each the broker may have rotated the pair, and presenting the old token again would be that replay |

Every branch commits its revocation and reports afterwards; throwing inside the transaction
would roll the revocation back.

One class of failure cannot be handled inside that transaction: the stored pair stopped being
reliably ours and something afterwards failed. The trigger is not any particular call — a failed
write usually poisons the transaction so the revocation would be rejected too, and a failure
raised by the COMMIT is never visible to code running inside it at all. So the service records
what it was holding at the two points where the pair becomes unreliable, lets the transaction
roll back, and revokes in a **second** transaction:

- the broker answered and rotated the pair;
- the broker's answer never arrived (timeout, network failure, 5xx), which this flow already
  treats as a consumed token.

An `invalid_grant` refusal is deliberately not one of them: the broker refused, nothing rotated,
and if that transaction's COMMIT fails the next call gets the same refusal and revokes with the
exact reason. The recording covers a failed rotation write, a failed revocation on either branch,
and a failed COMMIT alike.

The second transaction cannot revoke unconditionally. Its row lock is gone, so the user may have
logged in again in the gap, and revoking by id alone would destroy that new session — the same
mistake the key-id rule above exists to prevent. `revokeAccountIfUnchanged` therefore matches on
the refresh hash the caller was holding (`is not distinct from`, because a legacy row carries
NULL) and reports which of four things happened:

| Outcome | Meaning | What the service does |
| --- | --- | --- |
| `revoked` | the row still held the lost pair | reports `account_revoked` / `refresh_outcome_unknown` |
| `already_revoked` | someone else got there first | reports `account_revoked` with their reason |
| `changed` | the user logged in again; the lost pair is nobody's dependency now | logs and rethrows the original failure |
| `missing` | the account is gone | logs and rethrows |

If the second transaction itself fails, the account stays active holding a token the broker will
refuse, the failure is logged, and `ensureFreshAccessToken` **throws** rather than returning a
result — callers such as ARCH-01 (#40) see an exception, not an `AccessTokenResult`. The next
refresh gets a 401 and revokes it there with `refresh_invalid_grant`.

### Why the refresh does not compare the user

The answer from `user-auth/refresh` carries no `user`, so there is nothing to compare: the code
exchange is the only place a pair arrives with a `broker_user_id`, and `linkBrokerAccount` keys
on it there. Ownership of a refreshed pair rests on the token we present instead. It is decrypted
from this account's own row — the AAD is `keyId|accountId|field`, so a ciphertext copied from
another row does not decrypt — and matched against `refresh_token_hash` before the exchange, and
the answer is written back into the same row under the same lock (`applyRotatedTokens`). What is
left is the broker itself answering a valid token with somebody else's pair, which is a broker
compromise and outside this flow's threat model.

### A 401 means the chain is dead

The live broker answers a replayed refresh token with 401, and after that it also refuses the
newest token of the same chain (the last row of the Live check table). A 401 therefore cannot be
read as "this one token was stale": the whole session is gone, whatever caused it, and revoking
the account so the user logs in again is the only move left. No stored token would get a
different answer, which is why `refresh_invalid_grant` is final.

## Broker contract (verified 2026-10-01)

Observed with curl and the live-check script against `https://api.binodex.app` with this
installation's client id (#102, #163). The `message` texts are what the broker said that day, not
a contract this code relies on.

| Endpoint | Request | Success | Observed refusals |
| --- | --- | --- | --- |
| `POST /v1/broker/oauth/token` | form-urlencoded (JSON is accepted too): `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` | 200 `{access_token, refresh_token, token_type, expires_in: 604800, user: {id, email, is_partner_client, …}}` | 400 `Invalid or expired authorization code`; 401 `Authentication failed: Invalid client credentials`; 400 `Validation failed: "code" is required` for `grant_type=refresh_token` — there is no refresh grant here |
| `POST /v1/broker/user-auth/refresh` | JSON `{refresh_token}`, no client credentials | 200 `{access_token, refresh_token, token_type, expires_in: 604800}`, **no `user`** | 401 `Invalid token` for an unknown or consumed token; 400 `Validation failed: "refresh_token" is required` |
| `POST /v1/broker/user-auth/email/send-code` | JSON `{client_id, client_secret, email}` | 200 `{status: true}`, and the broker mails a code | 400 `Validation failed: "email" is required` for an address it does not take; 401 for wrong client credentials |
| `POST /v1/broker/user-auth/email/login` | JSON `{client_id, client_secret, email, code, partner_code}` | 200, the same body as the code exchange, `user` included (#102) | 400 `Invalid or expired code` for a wrong or foreign code; 400 `Validation failed` without `code`; 401 for wrong client credentials |

The two email rows come from #102 and from probes on 2026-10-01 that sent no letter (an invalid
address, a code that was never issued, a wrong secret). A successful login of an existing user by
email was checked live by the owner in #102.

Every error body has the shape `{"error":{"message","details"}}` — an object, not the OAuth string
`{"error":"invalid_grant"}`. `binodex.app` without `api.` answers every `POST /v1/broker/...` with
405 and an empty body.

The client tells failures apart by the HTTP status alone, through one table that holds each
endpoint's path and the status it refuses a grant with (`BROKER_ENDPOINTS` and `classify` in
`oauth-client.ts`; `post()` takes the table's key and nothing else, so a call cannot reach one
endpoint while being classified as another); the error body is released unread and is never
parsed or logged:

| Status | `oauth/token` | `user-auth/refresh` | `email/send-code` | `email/login` |
| --- | --- | --- | --- | --- |
| 400 | `invalid_grant` | `rejected` | `invalid_grant` | `invalid_grant` |
| 401 | `rejected` | `invalid_grant` | `rejected` | `rejected` |
| other 4xx | `rejected` | `rejected` | `rejected` | `rejected` |
| 5xx, timeout, network failure | `unavailable` | `unavailable` | `unavailable` | `unavailable` |
| 2xx that breaks the schema, or `expires_in` outside (0, 30 days] | `contract_violation` | `contract_violation` | `contract_violation` (anything but `status: true`) | `contract_violation` |

The routes turn `invalid_grant` into 400 — `invalid_code` on the callback and the email login,
`invalid_email` on `send-code` — and everything else into 502 (`brokerOutcome` in `routes.ts`).

A 400 on the code exchange is also what our own malformed request gets (`Validation failed`), so
such a bug reaches the browser as `invalid_code`, and the callback's warn line cannot tell it from
an expired code either. That is the accepted cost of not reading the body; the client tests pin
the map, so a change to what we send is caught there rather than in production.

### Live check: OAuth tokens on `user-auth/refresh`

`user-auth/refresh` was first confirmed with tokens from the email login (#102). Whether it also
takes a refresh token issued by the OAuth code exchange was checked on 2026-10-01 at about 08:42
UTC, with a freshly registered account and `ref` set to the short partner code:

1. open `https://binodex.app/oauth/authorize?client_id=<id>&redirect_uri=<registered uri>&state=<any>&ref=<code>`
   and log in; the browser lands on `<redirect_uri>?code=…&state=…` (a connection error on that
   page does not matter — the code is in the address bar);
2. within 120 seconds, exchange the code on `oauth/token` (form, with the client credentials);
3. post the returned refresh token to `user-auth/refresh` as JSON;
4. post the **old** refresh token again;
5. post the refresh token from step 3.

The script printed statuses, field names and the replay's error body, never a token or the
secret:

| Step | Result |
| --- | --- |
| code exchange | 200: `access_token`, `refresh_token`, `token_type`, `expires_in=604800`, `user{id, email, …, is_partner_client=true, …}`; both tokens JWT-shaped |
| refresh with the OAuth refresh token | 200: `access_token`, `refresh_token`, `token_type`, `expires_in=604800`, no `user` |
| replay of the old refresh token | 401 `{"error":{"message":"Invalid token","details":{}}}` |
| the new refresh token, after that replay | 401 — the replay killed the whole chain |

So the OAuth refresh token is refreshable on `user-auth/refresh`, single-use, and a replay
revokes the newest pair too (see [A 401 means the chain is dead](#a-401-means-the-chain-is-dead)).
The new account came back with `is_partner_client=true`: the short code passed as `ref` attaches
an account registered during the OAuth login to the partner account.

### Live check: an account registered without the partner link

Checked on 2026-10-01 at about 09:28 UTC for the starter pack's partner rule. The owner registered
a new account directly on binodex.app, with a different email and no partner link, then logged
into it on our authorize page with `client_id` and `ref=<short code>`, redirect
`http://localhost:3000/auth/callback`. The `oauth/token` exchange answered 200 with
`user.id=101962`, `is_verified=false`, `is_partner_client=true`.

`false` was **not** observed. Two readings fit, and nothing on our side tells them apart:

- (a) the broker attaches an existing, unattached account to the partner when it logs in
  through the partner's authorize page with `ref` — the broker's page probably sends
  `partnerCode` with its own login, since #163 showed that `POST /v1/broker/oauth/authorize`
  itself does not carry `ref`;
- (b) the account was a partner one already.

Neither is claimed as confirmed. The code branches on the stored boolean, and the `false` branch
is tested against the stub only. An earlier attempt in the same run returned the #163 account
(`user.id=97266`, `true`) because the browser profile still held its session; it is not an
observation.

## Secrets

Broker errors carry a code and a status, never the response body, the request form or a cause.
`trade_intents`-style allowlists apply here too: `auth_revoked_reason` holds one of four values,
CHECKed in the schema. `LOG_REDACT_PATHS` covers the broker's snake_case names, `state` and
`authorizationCode` at every depth, plus `req.body.code` — insurance for a future serializer
rather than a path anything logs today, since Fastify's `req` serializer never emits the body.
The bare key `code` is
deliberately **not** redacted: SQLSTATE, libuv errno and Fastify's `FST_ERR_*` all travel under
that name, and blanking them would cost the diagnostics this project logs errors by — errors are
logged as `{ name, code }`. Sites that use `errorLogFields` add the same two fields for one level
of `cause`; sites that use `errorIdentity` deliberately do not. In some the error is one this
code constructs and has no cause; in others, such as the worker's executor port, the contract is
that nothing beyond the thrown error's own name and code is logged; and in the dependency checks
the driver puts the whole diagnostic on the error's own `code` (a SQLSTATE, an `ECONNREFUSED`)
(`packages/shared/src/logging.ts`). The cause matters where a wrapper has nothing of its own:
drizzle's query error sets neither `name` nor `code`, and the SQLSTATE that makes a database
failure actionable is on the pg error underneath.
No key path can reach a string, so what is logged is shaped rather than redacted. Every line this
application writes passes the error through `errorIdentity` or `errorLogFields`, a rule in
`eslint.config.js` refuses an `err`/`error`/`cause`/`exception` field that does not — within the
shapes it can see, which its own comment lists — and a subclass of Fastify's
`LogController` does the same for the lines the framework writes on our behalf — including the
4xx path, which our error handler reaches by delegating through `reply.send(error)`. The request
serializer and a custom not-found handler strip `code` and `state` from the logged URL, for the
case where the broker delivers them as query parameters.

Under that, the logger itself holds a whitelist (#85). Every process builds its pino logger from
`logOptions` (`packages/shared/src/logging.ts`); backend and web hand the instance to Fastify as
`loggerInstance`, so request loggers and children inherit it. Its serializers reduce whatever sits
under one of the four keys `err`, `error`, `cause`, `exception` at the top level of a log object to
`{ name, code?, cause?: { name, code? } }` — the error's name, a string code and one level of
cause, nested under the key; `errorLogFields` puts the cause beside `err` instead, and both shapes
pass the serializer unchanged. An object is let through by its own `name` only when it already has
that shape: a plain or null-prototype object whose own keys are a string `name`, optionally a
string `code` and such a `cause`.
A record that merely has a `name` is logged as `{ name: 'object' }`; a plain object with nothing
but string `name`/`code` is indistinguishable from an identity and keeps its `name`. A hook writes
a fixed message, `error logged without a message`, where pino would otherwise copy `err.message`
into `msg` — an error logged positionally or as `{ err }` without a message of its own.

That is not the same as "the log contains no raw error". Fastify's own lines that carry the error
under `err` or positionally — errors thrown by hooks, a promise rejected after the reply was
sent, trailer errors, a stream error on an auto-generated HEAD route, client errors — now reach
the log by name and code only. What the whitelist does not reach: an error nested under another
key (`{ ctx: { err } }`), an error interpolated into the message by a format argument (`%s`,
`%o`), free text a call site writes itself, and a message passed explicitly — Fastify passes `error.message` as the message of its
default error log and its head-write failure, which is why `SafeLogController` stays, and it
writes the raw URL into its duplicate-reply warning. A client error is triggered by a malformed
request from outside, and Node attaches the raw request bytes to the parser errors it raises; the
whitelist drops those fields, and the default level is `info` rather than `trace` besides. The
claim this project makes is the narrower one, because the earlier rounds of review were spent on
claims that were wider than the code.

A state legitimately appears in what `start` returns — inside the authorize URL and as a field of
its own, which is what the bot passes on. It is absent from callback responses, from errors, and
from every line this application or `SafeLogController` writes.

## Configuration

Backend only, never the worker (the worker neither exchanges grants nor decrypts tokens);
`TELEGRAM_BOT_TOKEN` is the one the `bot` service reads as well, and `BROKER_OAUTH_AUTHORIZE_URL`
and `WEB_PUBLIC_URL` are read by `web`:

| Variable                                   | Meaning                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `BROKER_CLIENT_ID`, `BROKER_CLIENT_SECRET` | the OAuth client registered in the broker's cabinet (#8)                                                   |
| `BROKER_OAUTH_AUTHORIZE_URL`               | the broker's authorize page; `https:` only. Read by `backend`, which builds the URL, and by `web`, whose login page navigates only to it; compose gives both one default through a YAML anchor |
| `BROKER_API_BASE_URL`                      | the API host every `POST /v1/broker/...` call in `BROKER_ENDPOINTS` lives on: `https://api.binodex.app`; `https:` only. `binodex.app` without `api.` answers 405 to every API call. The pairs catalog's `GET /v1/broker/pairs/binary` uses the same base (docs/pairs-catalog.md) |
| `BROKER_OAUTH_REDIRECT_URI`                | must match the value registered with the client byte for byte (`localhost` is not `127.0.0.1`), and its path must be `/oauth/callback`, the page `web` serves — the backend refuses to start otherwise. `http:` only for `127.0.0.1` or `localhost`, and then the bot sends a plain link, not the Mini App. Compose defaults it to `<WEB_PUBLIC_URL>/oauth/callback`, and a login completes only when it equals that value of the same deployment; set it only to match the spelling registered with the broker, which the backend sends byte for byte |
| `WEB_PUBLIC_URL`                           | `web` only: the origin its pages are served from (the admin pages and the Mini App pages), with nothing after the host or port — no trailing `/`, `?` or `#`; see docs/staff-login.md → Configuration |
| `BROKER_PARTNER_REF`                       | the short partner code, `<code>` from `https://bdclick.app/smart/<code>` — never the link: `[A-Za-z0-9_-]`, 1-64 chars, checked at backend startup (`parsePartnerCode` in `apps/backend/src/env.ts`). Sent as `ref` on every authorization request and as `partner_code` on every email login, so a new user registers under this installation's partner account |
| `TOKEN_ENCRYPTION_KEY`                     | 32 bytes, base64; `openssl rand -base64 32`                                                                |
| `TOKEN_ENCRYPTION_KEY_ID`                  | names the key for rotation; no `\|`, no whitespace (the cipher binds with it)                              |
| `TELEGRAM_BOT_TOKEN`                       | the public bot's token, which `bot` polls; the backend only sends the push after the callback on it and checks the Mini App's `initData` with it. No whitespace; the backend refuses to start when it equals `ADMIN_BOT_TOKEN` |

`INTERNAL_API_TOKEN`, `BROKER_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`TOKEN_ENCRYPTION_KEY_ID` and `BROKER_PARTNER_REF` have **no deployable default anywhere in this
repository**. The partner code is not a secret, but a made-up one fails silently — every new
account registers outside the partner account — so it gets the same treatment. Neither
`compose.yaml`, which uses the `${VAR:?message}` form, nor `.env.example`, which lists them with
empty assignments, supplies a value that a deployment could inherit by following the setup
instructions. `${VAR:?}` refuses an empty value as well as a missing one, so `cp .env.example .env`
leaves the stack still refusing to start, and a developer has to put something there deliberately.

Values for these names do appear in the tree, and every one of them is a fixture: CI's compose job
sets its own throwaway values, `apps/backend/src/env.test.ts` builds its own, and `.env.example`
names the all-zero development key in a comment, which is useless outside the `dev` key id. None
of them is a default that a deployment receives. A CI step asserts the refusal, one variable at a
time and for an empty value as well as a missing one — the check exists because the last two
attempts at this each left a way in.

The development encryption key is thirty-two zero bytes, and `.env.example` names it in a comment
rather than assigning it. It is published here and is therefore no protection at all, so the
backend accepts it **only** paired with `TOKEN_ENCRYPTION_KEY_ID=dev`. Any other key id with that
key fails at startup: the combination means a rotation where the id was changed and the key was
not.

## Boundaries

- **#22** owns `/start` and the button that calls `POST /auth/binodex/start`; it hands the user
  an authorize URL and nothing else (docs/bot-start.md).
- **#128** is the backend's push after the callback ([The push after the callback](#the-push-after-the-callback-128)):
  a `sendMessage` to the Telegram id restored from the state, on every outcome after the state.
- **#113** is the backend's `initData` check on the callback ([Why the callback is
  public](#why-the-callback-is-public)): the signature, the age and the comparison with the
  state's owner.
- **#114** is the bot's `web_app` button and the Mini App login and callback pages in `apps/web`
  ([The Mini App pages](#the-mini-app-pages-114)); the callback page sends
  `Telegram.WebApp.initData` unchanged with the code and the state, through `apps/web`.
- **#10** owns the starter pack and the confirm button; the outcome message in the bot is the
  account card (#200, [bot-start.md → The account card](bot-start.md#the-account-card)). Re-linking
  an account that belongs to another Telegram user is out of scope: `broker_account_taken` is
  final, and moving an account is a separate support task.
- **#162** is the backend half of the email + code login ([Email login](#email-login-issue-162)):
  the client calls, the two routes, the activation and the starter pack. **#171** owns the bot's
  side: the address → code dialog, its state, the buttons and texts
  ([bot-start.md → Email dialog](bot-start.md#email-dialog)).
- **ARCH-01 (#40)** will call `ensureFreshAccessToken` before talking to the broker socket.
- **#35** owns the reusable mock broker; the stub next to the client
  (`apps/backend/src/broker/testing/oauth-stub.ts`) exists so this suite can prove code expiry,
  single use and refresh-family behaviour, and the email codes' single use and partner check,
  with the statuses and error bodies of the live broker.
