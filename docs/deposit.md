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
bot (#27): «💳 Пополнить» web_app button → WEB_PUBLIC_URL/cashier
web (#111): GET /cashier — Mini App page; the widget in an iframe; postMessage handshake
web (#111/#112): POST /cashier/session, POST /cashier/credited — same-origin, forward initData to backend
backend (#11): POST /deposit/widget-session {initData, clientIp?} → DEMO_ONLY → initData → user
               → the single active account → ensureFreshAccessToken(mayRefresh: true)
               → broker POST /v1/broker/widget-sessions {origin: WEB_PUBLIC_URL, mode: deposit}
               → {session, expiresInSec, widgetUrl, widgetOrigin}
backend (#112): POST /deposit/credited {initData} → balance refresh → «Реальный баланс: $X»
```

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
signal so it ends before the REST client's own 5 s and reads as `aborted`. `web`'s forward (#111)
has to wait longer than the budget; the budget is inside the backend's shutdown phase 1. Lock waits and
statements are ordinary latency, as on the other routes. The links are in `TIMING_CHAIN_HOLDS`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DEPOSIT_WIDGET_ORIGINS` | the origin of `BROKER_OAUTH_AUTHORIZE_URL` | comma-separated https origins the widget may be served from; each spelled as `WEB_PUBLIC_URL` is, no empty item, no repeats; an empty value stops the backend at start |
| `WEB_PUBLIC_URL` | — (already required) | the `origin` sent to the broker |
| `BROKER_CLIENT_ID` | — (already required) | the `client_id` of the fallback widget URL |

The cashier page's CSP `frame-src` and its `postMessage` check (#111) name these origins in
advance, which is why a widget the broker serves from anywhere else is refused here rather than
framed. `compose.yaml` forwards `DEPOSIT_WIDGET_ORIGINS` to `backend` only, without a default.

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

Exit code 0 on `ok`, 1 otherwise.

## Contracts for the next parts

- #111: show texts for every code above, `demo_only` and `ambiguous_account` included; forward
  `initData` and optionally `clientIp`, nothing else (the body is strict); time the forward out
  above `DEPOSIT_WIDGET_SESSION_BUDGET_MS`; the CSP `frame-src` names `DEPOSIT_WIDGET_ORIGINS` —
  `web` needs the same list (its own variable with a parity check, or one source; #111 decides).
- #112: re-mint through this route unchanged; `broker_unavailable` after a 401 means "retry once".
- #27: offer the button whatever the user's `trading_mode`.

## Boundaries

- One attempt per request: a retry is the user's (the page's retry button), bounded by the per-user
  window.
- The windows are per process, as the callback's (`rate-window.ts`).
- Rule 12's residual window: a block committed after the token was read does not stop that one
  widget call (stated, as for every caller).
- `region: "ru"` without a `widget_url`: the fallback is the global platform; whether that is
  right is unverified until the probe says what comes back.
