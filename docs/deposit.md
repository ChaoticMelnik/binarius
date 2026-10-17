# Deposit: the cashier widget session

The user tops up their broker account inside Telegram, in the broker's own cashier widget embedded
in a Mini App page. This part (#11) is the backend's half of it: `POST /deposit/widget-session`
mints a widget session for the user's account, and `deposit-probe` lets the owner check the call
against the live broker before the page is built. Nothing here moves money: the widget is the
broker's, and so is the payment.

## The chain (#11 → #111 → #112 → #27)

Designed together on 2026-10-08 (owner's answers on #11); each issue ships one part, in this order,
so that no button opens a page that does not work yet.

```
bot (#27): «💳 Пополнить» web_app button → cashierUrlOf(WEB_PUBLIC_URL) = WEB_PUBLIC_URL/cashier, https only
web (#111): GET /cashier — Mini App page; the widget in an iframe; postMessage handshake
web (#111): POST /cashier/session — same-origin, per-IP window, forwards {initData, clientIp?} to backend
web (#112): POST /cashier/credited — same-origin, the same per-IP window, forwards {initData} to backend
backend (#11): POST /deposit/widget-session {initData, clientIp?} → DEMO_ONLY → initData → user
               → the single active account → ensureFreshAccessToken(mayRefresh: true)
               → broker POST /v1/broker/widget-sessions {origin: WEB_PUBLIC_URL, mode: deposit}
               → {session, expiresInSec, widgetUrl, widgetOrigin}
backend (#112): POST /deposit/credited {initData} → DEMO_ONLY → initData → per-user window
               → the single active account → balance refresh (requested, mayRefresh: true)
               → on a write: push «Реальный баланс: $X» with «🏠 В меню», once a minute per user
```

The bot's button (#27, `apps/bot/src/keyboards.ts` → `depositButton`/`depositRows`, the only
builders) stands at three entries, in both trading modes: the last row of the status card (under
«⭐ Купить токены»); under «⭐ Купить токены» in the two «не хватает токенов» refusals (a trade, a
session start), above the way back; at the end of a session, on the stopped status and on the
summary card, right above «👥 Пригласить друга» (the menu stays last). Its URL is
`cashierUrlOf(WEB_PUBLIC_URL)` (`packages/shared/src/bot-navigation.ts`, with `CASHIER_PAGE_PATH`,
the path `web` serves): Telegram opens a `web_app` URL over https only, so on any other origin
(local dev's `http://127.0.0.1:3001`) the bot shows no such button and logs one warning at
startup, «cashier button off: WEB_PUBLIC_URL is not https». The bot does not read `DEMO_ONLY`: on a
demo-only stand the button opens a page that says «Пополнение на этом сервере отключено». A deposit
credits no tokens yet (#386).

The session reaches the iframe only through `postMessage` (`binodex-embed:ready` → `init`), never
through a URL. The reference is the broker's own cashier, the public repository
`binodex/broker-web`: `src/app/api/widget-session/route.ts` (the call), `src/components/pay-embed.tsx`
(the iframe, the events, the origin check) and `src/lib/types.ts` (the answer).

Out of scope: withdraw (the broker's `mode` also takes `withdraw`; owner, 2026-09-21), crediting
deposits (#386), the user's `trading_mode` — a demo user deposits in order to be able to switch to
real (#121), so the route never reads it.

## The broker call

`POST /v1/broker/widget-sessions`, Bearer = the user's access token, JSON `{ origin, mode:
"deposit", user_ip? }` → `{ session, expires_in, widget_url?, widget_origin?, region? }`
(`packages/shared/src/oauth.ts` → Widget session; client: `@binarius/broker-rest`
`createWidgetSession`, one attempt). `origin` is `WEB_PUBLIC_URL`, the origin of the page that
embeds the widget. `user_ip` is the user's IP as `web` saw it, sent only when it parses as an IP
address (`net.isIP`); broker-web sends it, and its purpose is not documented. Not observed live yet:
the probe below is the first call.

## The route — `POST /deposit/widget-session`

Public, like the OAuth callback ([binodex-oauth.md](binodex-oauth.md) → Why the callback is
public): `web` forwards it on the internal network without a bearer, and the Mini App's signed
`initData` is the whole authorization. It is not `publicThroughProxy`, so a request that came
through Caddy gets the not-found answer (`deposit/routes.db.test.ts` D13).

Body (`depositWidgetSessionRequestSchema`, strict, `DEPOSIT_BODY_LIMIT_BYTES` 8 KiB): `initData`
(1-4096 characters) and an optional `clientIp` (1-45). Answer (`depositWidgetSessionResponseSchema`,
built field by field): `{ session, expiresInSec, widgetUrl, widgetOrigin }`. `widgetUrl` is the
broker's `widget_url`, or, without one, `<platform origin>/embed/pay?mode=deposit&client_id=<BROKER_CLIENT_ID>`
— the page never builds a URL, and only the backend knows the client id. `widgetOrigin` is the
broker's `widget_origin`, or the origin of `widgetUrl`. `region` is read for the probe and never
returned.

Steps, each before the next (`apps/backend/src/deposit/routes.ts`, core in `widget-session.ts`):

1. the route ceiling, before the body is parsed: 600 a minute for the process;
2. the body schema;
3. **DEMO_ONLY** — before any read, any token and any broker call (below);
4. `initData`: signature and age, no query;
5. the per-user window: 10 a minute per Telegram user, taken after `initData`, never given back;
6. the account: `resolveBalanceAccount`, the resolution of `/trading/access` and `/trading/mode` —
   the user's single active account (manager's decision on #11, 2026-10-14); a blocked user stops
   here;
7. the token: `ensureFreshAccessToken(account, { mayRefresh: true })` — a user action (Rule 12);
8. the broker call, under its own `DEPOSIT_BROKER_CALL_BUDGET_MS` signal;
9. the widget origins against `DEPOSIT_WIDGET_ORIGINS`.

The session is never logged: no line of the route or the core carries it, and `session` is a
redacted log key at every depth (`packages/shared/src/logging.ts`; D9 reads the log destination).

### Error table

The code decides what the page (#111) does; every source has its row, and each row has a test in
`deposit/routes.db.test.ts`.

| # | Source | Answer | Page action (#111) |
|---|---|---|---|
| 1 | body outside the strict schema | 400 `validation` | generic error |
| 2 | the route ceiling | 429 `too_many_requests` | wait, retry |
| 3 | DEMO_ONLY | 409 `demo_only` | «Пополнение на этом сервере отключено», no retry |
| 4 | `initData` malformed, forged, older than the limit, or without a usable user | 401 `invalid_telegram_auth` | «Открой кассу из Telegram заново» |
| 5 | the per-user window | 429 `too_many_requests` | wait, retry |
| 6 | no user, no account, no active account | 409 `no_active_account` | «Сначала подключи Binodex» (the bot's connect) |
| 7 | two or more active accounts | 409 `ambiguous_account` | support text |
| 8 | the user is blocked (the resolution, or the token's `user_blocked` under the lock) | 409 `user_blocked` | support text |
| 9 | token `account_revoked`, `account_pending`, `account_not_found` (the row changed after the resolution) | 409 `token_unavailable` | «Войди в Binodex заново» |
| 10 | token `refresh_rate_limited`, `key_unavailable` (and `refresh_needed`, which `mayRefresh: true` does not return) | 502 `broker_unavailable`, logged with the reason | retry |
| 11 | broker 401 | the refused token reported, then 502 `broker_unavailable` | retry: the next request exchanges |
| 12 | broker 429, 5xx, network, our call budget (`aborted`), a redirect, a 2xx breaking the contract or over the body ceiling | 502 `broker_unavailable`, logged with the `BrokerRestError` code, status and detail | retry |
| 13 | broker other 4xx (an origin it does not accept, etc.) | 502 `broker_rejected` | error text, no retry loop |
| 14 | the widget URL's origin or `widgetOrigin` not https, or not in `DEPOSIT_WIDGET_ORIGINS` | 502 `broker_rejected`, logged `widget origin not allowed` with the origin | error text, no retry loop |
| 15 | a throw (the database, the token service) | 500 `internal` | generic error |

Row 11 follows the balance reconciler (#281): on a 401 the token's fingerprint goes back through
`ensureFreshAccessToken(account, { mayRefresh: false, refusedToken })`, which marks it expired
without an exchange — the route's budget has no room for a second one — and the user's next
request exchanges it. A throw from that report is logged and does not change the answer.

### DEMO_ONLY

A backend started with `DEMO_ONLY=true` (#396, [kill-switch.md](kill-switch.md) → DEMO_ONLY)
answers 409 `demo_only` before it reads the database, verifies `initData`, takes a token or calls
the broker (D10: zero token calls, zero broker requests, a database that fails on any use).
`deposit-probe` reads the same flag and refuses the same way (P2).

### initData age

`DEPOSIT_INIT_DATA_MAX_AGE_MS` = 1 h + `INIT_DATA_CLOCK_SKEW_MS` (`apps/backend/src/auth/oauth-timing.ts`),
a second verifier next to the callback's: the cashier stays open while the user pays, and every
renewal after the widget's `reauth-required` (#112) re-sends the `initData` the page was opened
with. Accepted risk: a leaked `initData` lets its holder mint a deposit session for the victim's
own account for that hour — a payment form for the victim's account, nothing more.

### Budgets

`DEPOSIT_WIDGET_SESSION_BUDGET_MS` (8 s, `packages/shared/src/deposit.ts`) is what the route may
take: one token exchange under the account's row lock (`BROKER_HTTP_TIMEOUT_MS`, 5 s) and the broker
call (`DEPOSIT_BROKER_CALL_BUDGET_MS`, 3 s, `apps/backend/src/timing.ts`), passed as the call's
signal so it ends before the REST client's own 5 s and reads as `aborted`. `web`'s forward (#111,
`DEPOSIT_WIDGET_SESSION_REQUEST_TIMEOUT_MS`, 10 s) waits longer than the budget; the budget is inside the backend's shutdown phase 1. Lock waits and
statements are ordinary latency, as on the other routes. The links are in `TIMING_CHAIN_HOLDS`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DEPOSIT_WIDGET_ORIGINS` | the origin of `BROKER_OAUTH_AUTHORIZE_URL` | read by `backend` and `web`: comma-separated https origins the widget may be served from; each spelled as `WEB_PUBLIC_URL` is, no empty item, no repeats; an empty value stops either process at start |
| `WEB_PUBLIC_URL` | — (already required) | the `origin` sent to the broker |
| `BROKER_CLIENT_ID` | — (already required) | the `client_id` of the fallback widget URL |

The cashier page's CSP `frame-src` and `web`'s check of the backend's answer (#111) name these
origins in advance, which is why a widget the broker serves from anywhere else is refused here
rather than framed. Both processes read the one variable through one parser
(`parseDepositWidgetOriginsEnv`, `packages/shared/src/env.ts`), each with the origin of its own
`BROKER_OAUTH_AUTHORIZE_URL` (one compose anchor) as the default. `compose.yaml` forwards
`DEPOSIT_WIDGET_ORIGINS` to `backend` and `web`, without a default; both `timing.test.ts` pin it.

## The page (#111)

`apps/web/src/cashier/`, the Mini App the bot's button opens (#27):

| Route | What |
|---|---|
| `GET /cashier` | the page: Telegram's SDK, `/cashier/static/app.js`, one hidden block per state, «Повторить», «Вернуться в Telegram», and `<iframe id="widget" allow="payment *; clipboard-write *">` without a `src` |
| `GET /cashier/static/app.js` | the page script (`cashier/client.ts`), `public, max-age=3600` |
| `POST /cashier/session` | same-origin (the app's `Origin` check); the per-IP window; a strict `{ initData }` body up to `DEPOSIT_BODY_LIMIT_BYTES`; forwards `{ initData, clientIp? }` to `POST /deposit/widget-session` without a bearer, timed out at `DEPOSIT_WIDGET_SESSION_REQUEST_TIMEOUT_MS` (10 s, `apps/web/src/timing.ts`, above the route's 8 s budget, below the 11 s shutdown) |
| `POST /cashier/credited` (#112) | same-origin; the **same** per-IP window object; a strict `{ initData }` body up to 8 KiB (else 400, no forward); forwards `{ initData }` — no `clientIp` — to `POST /deposit/credited` without a bearer, timed out at `DEPOSIT_CREDITED_REQUEST_TIMEOUT_MS` (10 s, above the route's 8 s budget); answers 204 whatever the forward did — [After a deposit](#after-a-deposit--post-depositcredited-112) |

**The handshake** follows broker-web's `pay-embed.tsx`. The script attaches its `message` listener
first, then mints a session and sets `iframe.src` to the `widgetUrl` the backend answered — the
page builds no URL and picks no origin. Every message is accepted only when
`event.source === iframe.contentWindow && event.origin === widgetOrigin`, and only then is its
`data` read (a non-null object with a string `type`); anything else is ignored silently, Telegram
Web's own messages from `window.parent` included.

| Message | Page |
|---|---|
| `binodex-embed:ready` | the **first** `ready` takes the session minted on load while it is younger than `min(45 s, expiresInSec)` and clears it; otherwise, and on every later `ready` (the widget reloaded itself), a fresh `POST /cashier/session`. Then `{ type: 'binodex-embed:init', session }` is posted with target origin `widgetOrigin`, never `'*'`. A failed fresh mint shows its state and posts nothing |
| `binodex-embed:reauth-required` (#112) | the load session is dropped and a fresh `POST /cashier/session` is posted as `init` to the same frame: no reload, `src` untouched (C18) |
| `binodex-embed:resize` | `iframe.style.height` = `height` clamped to 520–900 px, only for a finite number (initial 720 px) |
| `binodex-embed:close` | `Telegram.WebApp.close()` |
| `binodex-embed:credited` (#112) | the `credited` notice above the widget, which stays (the user may pay again; `close` is the widget's); `POST /cashier/credited` with `{ initData }` only — the event's payload (amount, currency) is never read, and the POST's answer or failure changes nothing on the page (C15, C16) |
| `binodex-embed:error` (#112) | the `widget_error` notice above the widget, which stays; the event's `message` is never read, shown, sent or logged (C17) |

**The order of mint results** (#112; closes #492's review m1). The script keeps a `generation`,
bumped by every load (the first one and «Повторить»), which also clears the held session, the
fresh-mint flag and `widgetOrigin` (so the old frame's messages are ignored during a reload):

- a result of an older generation is dropped whole — no state, no `init` (C21a, C21b);
- at most one fresh mint (`ready`, `reauth-required`) is in flight; an event of either kind while
  it is coalesces into it: one POST, one `init` (C19);
- a successful fresh mint brings the widget back — state blocks, «Повторить» and «Вернуться»
  hidden, the iframe shown — before it posts `init`, so a widget an earlier failure hid returns
  (C21c);
- **one more mint on `unavailable`** (manager's decision Q2 on #112): every mint — the load, a fresh
  `ready`, `reauth-required` — that answers `unavailable` (the route's state, or the script's own
  mapping of a non-JSON body or a rejected fetch) is repeated once at once, in the same generation;
  the second answer is applied as it is (C20). The page cannot tell a broker 401 (#11's row 11: the
  next call exchanges) from an outage, so any `unavailable` gets the one retry. No retry on any other
  state, `busy` included (C22). Bounded by the per-user (10/min) and per-IP (60/min) windows.

**Notices.** `credited` and `error` show one of two server-rendered blocks (`<p data-notice="credited"
role="status" hidden>`, `<p data-notice="widget_error" …>`) above the iframe; the latest event's
notice is shown and the other hidden; a load and every state hide both. The script still holds no
text and writes no `textContent`/`innerHTML`.

The session lives in the script's closure, the POST answer and `postMessage` only: never in a URL,
`localStorage`, `sessionStorage` or a cookie, and never in a log line (`session` and `initData` are
redacted keys; the route logs neither).

**Headers.** `content-security-policy` is the OAuth pages' Mini App policy with
`frame-src <DEPOSIT_WIDGET_ORIGINS in order>` (`miniAppCsp`, `apps/web/src/mini-app.ts`), set in the
plugin's `onRequest`, so Fastify's error answers on these routes carry it too; no
`X-Frame-Options`. `referrer-policy: strict-origin`, not the OAuth pages' `no-referrer`: the cashier
URL carries no secret (Telegram's launch data is in the fragment), and the widget may read
`document.referrer` to learn its embedder, as it can under the browser default broker-web runs
with. No `sandbox` on the iframe (the broker's own cashier sets none).

**The origin re-check.** Before answering the page, `web` checks `new URL(widgetUrl).origin` and
`widgetOrigin` against its own `DEPOSIT_WIDGET_ORIGINS`; outside it → state `rejected` and one
`error` line `the backend returned a widget origin outside DEPOSIT_WIDGET_ORIGINS` with the origin.
With one variable for both processes this fires only on drift (one container restarted with a new
value).

**The client address and the per-IP window.** `web` runs with
`trustProxy: 'loopback, uniquelocal'`: Caddy on the host reaches it from loopback or the compose
bridge's gateway and replaces any client `X-Forwarded-For` with the address it saw (docs/postbacks.md
→ The Caddy route). Not a hop count: Fastify 5.12.5 reads a number as "trust nothing". `clientIp` is
forwarded only when the request came through a trusted proxy (`request.ips.length > 1`) and
`request.ip` parses as an IP. The window — 60 requests a minute per address, an IPv6 address by its
/64, an IPv4-mapped one as its IPv4 (`cashier/ip-key.ts`) — is taken in the route's `onRequest`,
after the `Origin` check and before the body is read, and never given back: over → 429 `busy`, no
forward. A peer outside the trusted list is keyed by its own address whatever header it sends.

**Page states** (`POST /cashier/session` answers `200 { outcome: 'ready', session, expiresInSec,
widgetUrl, widgetOrigin }` or `{ outcome: <state> }`; each row has a test in
`cashier/routes.test.ts` W5 and the state's display in `cashier/client.test.ts` C11):

| # | Source | Web answer | Page state | «Повторить» |
|---|---|---|---|---|
| 1 | no `Telegram.WebApp.initData` | — (no request) | `open_from_telegram` | no |
| 2 | the per-IP window | 429 `busy` | `busy` | yes |
| 3 | a body that is not a strict `{ initData }`, not JSON, or over 8 KiB | 400 `unavailable` (+ `warn`) | `unavailable` | yes |
| 4 | backend 200, both origins in the web list | 200 `ready` | the widget | — |
| 5 | backend 200, an origin outside the web list | 200 `rejected` (+ `error`) | `rejected` | no |
| 6 | backend 2xx outside the contract | 500 `unavailable` (+ `error`) | `unavailable` | yes |
| 7 | 400 `validation` (our body refused: drift) | 500 `unavailable` (+ `error`) | `unavailable` | yes |
| 8 | 429 `too_many_requests` | 200 `busy` | `busy` | yes |
| 9 | 409 `demo_only` | 200 `demo_only` | «Пополнение на этом сервере отключено» | no |
| 10 | 401 `invalid_telegram_auth` | 200 `open_from_telegram` | `open_from_telegram` | no |
| 11 | 409 `no_active_account` | 200 `connect_first` | `connect_first` | no |
| 12 | 409 `ambiguous_account` | 200 `ambiguous` | `ambiguous` (support) | no |
| 13 | 409 `user_blocked` | 200 `blocked` | `blocked` | no |
| 14 | 409 `token_unavailable` | 200 `relogin` | `relogin` | no |
| 15 | 502 `broker_unavailable` | 200 `unavailable` | `unavailable` | yes |
| 16 | 502 `broker_rejected` | 200 `rejected` | `rejected` | no |
| 17 | any other status or code (500 `internal`, 404 from a backend without #11, 413, an unknown code) | 500 `unavailable` (+ `error` with status and reason) | `unavailable` | yes |
| 18 | no answer (network, the 10 s timeout) | 500 `unavailable` (+ `error`) | `unavailable` | yes |
| 19 | the app's `Origin` check | 403 HTML | `unavailable` | yes |

The script maps an unknown outcome, a non-JSON body and a rejected fetch to `unavailable`; an
`unavailable` from any source but an unknown outcome is shown after the second answer (C20, C11).
«Повторить» re-runs the load (mint, then `src`); every state without it except
`open_from_telegram` offers «Вернуться в Telegram» (`WebApp.close()`).

**Owner checks** (need the deployed `backend` and `web`; not run by the pipeline):

1. `curl -sI https://binarius.salescreativesads.com/cashier | grep -i '^content-security-policy'` →
   `frame-src` lists the `DEPOSIT_WIDGET_ORIGINS` value (default `https://binodex.app`).
2. Log in to the admin pages and open «Сессии»: the new session's IP is your public address, not
   `127.x`/`172.x`. A `172.x` there means `web` did not get Caddy's header: the per-IP window would
   then be one window for everybody.
3. End to end in Telegram (with #27's button «💳 Пополнить» under the status card, or a Mini App
   link to `WEB_PUBLIC_URL/cashier` set in BotFather): the widget loads, the payment form and a payment method's next screen open, and the
   webview console shows no CSP violation. With `DEMO_ONLY=true` the page says «Пополнение на этом
   сервере отключено» — expected.

Accepted: a browser may check the widget frame's own navigations against this page's `frame-src`;
if the widget navigates its frame to another origin (3-D Secure, a payment provider) instead of a
popup, that origin has to be added to `DEPOSIT_WIDGET_ORIGINS` (check 3 shows it). The per-IP
window is per process and in memory, and false once more than ~20 people behind one address open
the cashier in the same minute (they see «busy» and retry).

## After a deposit — `POST /deposit/credited` (#112)

The widget's `binodex-embed:credited` is a **trigger, not data**: the page sends `{ initData }`
only, both schemas are strict (an `amount` key is a 400 at `web` and at the backend), and the only
effect is a broker balance read of the caller's own account. A forged `credited` — the user owns
their `initData` and can call the route — refreshes their own balance, within the per-user window.
Nothing is credited anywhere: crediting deposits is #386.

Public as `widget-session` is, in the same plugin (`apps/backend/src/deposit/credited.ts`,
registered by `deposit/routes.ts`), so it shares the plugin's ceiling and is not
`publicThroughProxy` (the proxy guard `postbacks/routes.db.test.ts` G1 covers it through `onRoute`).

Steps, each before the next:

1. the plugin's ceiling, 600 a minute, shared with `widget-session`;
2. the strict `{ initData }` body (`depositCreditedRequestSchema`, 8 KiB);
3. **DEMO_ONLY** → 409 `demo_only`, before any read: no widget session exists on such a server, so
   a `credited` there is stale or forged (K1);
4. `initData`: the deposit verifier, 1 h + skew;
5. the per-user window: `DEPOSIT_CREDITED_PER_USER_PER_MINUTE` = 3 per Telegram user, taken after
   `initData`, never given back — a burst of the widget's events is one refresh (K3);
6. the account: `resolveBalanceAccount`, as `widget-session`; a blocked user stops here;
7. `touchBalanceRequested`, as `POST /trading/access` does, so the tick watches the account even if
   this refresh writes nothing;
8. `balance.refresh(accountId, { signal: AbortSignal.timeout(DEPOSIT_CREDITED_REFRESH_BUDGET_MS),
   requested: true, mayRefresh: true })` — a user action (Rule 12), one flight per account; the
   route's wait ends at the signal, a flight it joined or started goes on by the reconciler's rules;
9. on `ok` only: the push.

Answer `{ outcome: 'refreshed' | 'pending' }` (`depositCreditedResponseSchema`). `pending` is
"nothing written within the budget": the tick refreshes the watched account within its interval
(docs/broker-balance.md).

### Error table — `POST /deposit/credited`

The outcome table is `CREDITED_ANSWERS` (`satisfies Record<BalanceRefreshOutcome, …>`); each row
has a test in `deposit/credited.db.test.ts`.

| # | Source | Answer | Push |
|---|---|---|---|
| 1 | body not a strict `{ initData }` | 400 `validation` | no |
| 2 | the plugin's ceiling | 429 `too_many_requests` | no |
| 3 | DEMO_ONLY | 409 `demo_only` | no |
| 4 | `initData` malformed, forged, stale | 401 `invalid_telegram_auth` | no |
| 5 | the per-user window (the 4th in a minute) | 429 `too_many_requests` | no |
| 6 | no user, no account, no active account | 409 `no_active_account` | no |
| 7 | two or more active accounts | 409 `ambiguous_account` | no |
| 8 | the resolved user is blocked; refresh `user_blocked` | 409 `user_blocked` | no |
| 9 | refresh `account_not_found` (the row went between the resolution and the lock) | 409 `no_active_account` | no |
| 10 | refresh `account_pending`, `account_revoked` | 409 `token_unavailable` | no |
| 11 | refresh `ok` | 200 `refreshed` | yes, unless one went to this user within 60 s |
| 12 | refresh `aborted` (our budget), `refresh_needed`, `unauthorized` (the reconciler has reported the token), `rate_limited`, `rejected`, `unavailable`, `contract_violation`, `account_mismatch`, `key_unavailable` | 200 `pending`, logged `info` with the outcome | no |
| 13 | a throw (the database, the reconciler) | 500 `internal` | no |

`web`'s `POST /cashier/credited` answers the page 204 whatever happens here and logs: nothing for a
200; `warn` with status and reason for a 401/409/429 carrying a `DepositErrorCode`; `error` for
anything else (no answer, a 2xx outside the contract, 400 `validation`, 5xx, an unknown code). Its
own refusals: the per-IP window → 429, a body that is not a strict `{ initData }` → 400, a
cross-origin POST → 403 — none forwarded.

### The push

After `ok` the route reads the snapshot it has just written (`readBalanceSnapshot` →
`toBrokerBalanceView`) and sends `ClientPush.sendDepositCredited(telegramUserId, { amount:
real.available, fresh })` (`apps/backend/src/auth/client-push.ts`), which builds the catalog's
`depositCredited` («💳 Пополнение получено / Реальный баланс: {realBalance}», group `deposit`,
[bot-texts.md](bot-texts.md)) with the «🏠 В меню» button (`MENU_CALLBACK_DATA`). The amount is the
broker's, formatted by the `realBalance` variable from its `DecimalString` (Rule 2); nothing of the
request or the widget's event reaches it. If the broker's ledger has not moved yet, the message says
what the broker reported (owner's decision 2026-10-08).

At most one push per Telegram user per `DEPOSIT_PUSH_MIN_INTERVAL_MS` (60 s): a keyed window of 1,
taken just before the send and never given back, so a failed send does not invite a retry storm
(K9). A send failure is logged `warn` by name and code (`errorLogFields` + `telegramErrorFields`,
`push: 'deposit'`) and handed to `recordTelegramSendFailure` (a 403 marks the user unreachable); it
never changes the answer (K10). The push answers the user's own action, like the push after the
site login: `notification_level` does not apply (K11), and `telegram_blocked_at` is not read before
the send.

No push on `pending` (accepted): a broker slower than 3 s, a token exchange inside the budget or a
429 leaves the user with the page's notice and no bot message; the tick writes the snapshot within
its interval and the next `/menu` shows it.

### Budgets

`DEPOSIT_CREDITED_BUDGET_MS` (8 s, `packages/shared/src/deposit.ts`) is what the route may take:
the refresh wait (`DEPOSIT_CREDITED_REFRESH_BUDGET_MS`, 3 s, `apps/backend/src/timing.ts`) and the
push (`CLIENT_PUSH_TELEGRAM_API_TIMEOUT_MS`, 3 s); it is inside the backend's shutdown phase 1, and
`web`'s forward (`DEPOSIT_CREDITED_REQUEST_TIMEOUT_MS`, 10 s) waits longer. Statements are ordinary
latency. The links are in both processes' `TIMING_CHAIN_HOLDS`.

**Owner checks** (need the deployed `backend` and `web` with this part, the live widget and a
non-demo-only stand — the owner's decision each time; not run by the pipeline):

1. In the cashier (Telegram), make a test deposit: the page shows «Пополнение получено — баланс в
   боте обновится», the widget stays; within a few seconds the bot sends «💳 Пополнение получено /
   Реальный баланс: $X» with «🏠 В меню», and X matches the broker's cabinet.
2. Leave the cashier open past the widget session's lifetime (`expiresInSec`, 60 s by the probe)
   and continue: the widget's `reauth-required` is answered without a reload (no «Открываем
   кассу…», the form keeps its state).
3. `docker compose logs web | grep cashier` and `docker compose logs backend | grep -i credited`:
   no `initData`, no session string, no widget `message`.

## The probe

`deposit-probe` (`apps/backend/src/cli/deposit-probe.ts`) mints one session for one account through
the same core as the route and prints the outcome, `expiresInSec`, whether `widget_url`,
`widget_origin` and `region` came back (the URLs by origin only) and the origin the widget would be
served from. Never the session. It takes the token with `mayRefresh: false`, as `rate-limit-probe`
does, so it never exchanges one; `refused: refresh_needed` means the stored token has expired —
open the bot's balance once, then retry.

**Owner step on the pilot, after the merge and before #111 starts** (needs a linked account's
token and the running backend container; not run by the pipeline):

```bash
docker compose logs backend | grep '"msg":"backend started"' | tail -1   # demoOnly of the running backend
docker compose exec -T -e ACCOUNT_ID=<broker_accounts.id> backend pnpm --filter @binarius/backend deposit-probe
```

Expected: `ok`, `expiresInSec 60`, and which widget fields came back. What the other answers mean:

- `broker_rejected: broker rejected HTTP 4xx` — the broker does not accept our web origin for the
  widget: register `WEB_PUBLIC_URL` in the broker's cabinet before #111;
- `broker_unavailable: broker unauthorized HTTP 401` — the stored token was refused and is now
  marked expired; open the bot's balance once and retry. A second 401 on a fresh token means the
  widget needs something the token lacks (accepted risk on #11): #111 waits;
- `broker_rejected: widget origin … is not in DEPOSIT_WIDGET_ORIGINS` — set `DEPOSIT_WIDGET_ORIGINS`
  to the reported origins before #111;
- `refused: demo_only` — the pilot runs `DEMO_ONLY=true`. The refusal stays (manager's decision on
  #11, 2026-10-14). Whether to override it for the probe is the owner's decision each time; the
  override applies to this one process only — the running backend keeps its flag — and the probe
  mints a 60-second widget session, no payment:

  ```bash
  docker compose exec -T -e DEMO_ONLY=false -e ACCOUNT_ID=<broker_accounts.id> backend pnpm --filter @binarius/backend deposit-probe
  ```

- `failed: <name> (<name> <code>)` — the probe stopped on an error (the database, the token or
  another step): only the error's name and code are printed (SQLSTATE for the database), never its
  message; whether a session was minted is not reported, and none is printed;
- `failed: <message>` — an env variable is missing or malformed: the message names the variable,
  never its value.

Exit code 0 on `ok`, 1 otherwise.

## Contracts for the next parts

- #111 (done, The page above): one variable and one parser for both processes.
- #112 (done, After a deposit above): `reauth-required` re-mints through `POST /cashier/session`
  unchanged; every `unavailable` mint is retried once; `POST /cashier/credited` takes the same
  per-IP window object.
- #27 (done, The chain above): the button in both trading modes; it opens `WEB_PUBLIC_URL/cashier`
  (no query).

## Boundaries

- One attempt per request: a retry is the user's (the page's retry button), bounded by the per-user
  window.
- The windows are per process and in memory, as the callback's (`packages/shared/src/rate-window.ts`):
  the per-user session and credited windows and the deposit push window (#112) reset on a restart.
- Rule 12's residual window: a block committed after the token was read does not stop that one
  widget call (stated, as for every caller).
- `region: "ru"` without a `widget_url`: the fallback is the global platform; whether that is
  right is unverified until the probe says what comes back.
