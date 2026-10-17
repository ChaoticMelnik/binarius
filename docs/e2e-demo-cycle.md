# The demo cycle end to end (issue #105)

`packages/e2e/src/demo-cycle.db.test.ts` (`@binarius/e2e`) takes one user through the whole demo
cycle: `/start` → the email login → the manual choice of a pair → the analysis → a demo session of
five cycles → its result. The backend, the trading worker and the bot run as their production
compositions in one vitest process, over one Postgres, one Redis and the mock broker
([mock-broker.md](mock-broker.md)). Only two things are stand-ins: Telegram (a grammY transformer
on the bot's and the backend's `Api`) and the broker (the mock). The bot reaches the backend over
HTTP with its real client, and the worker reaches it through its real token, signal and pairs
sources. The worker reaches the broker over the socket and REST.

It is an integration test (`*.db.test.ts`), so `pnpm check` runs it in CI against Postgres and
Redis. It needs no browser and no running service, and it takes about 2.5 s locally.

## Components

`packages/e2e/src/harness/` repeats the wiring of the three `index.ts` files. The apps expose
what it needs through one test-only barrel each (`apps/backend/src/e2e.ts`, `apps/bot/src/e2e.ts`,
`apps/trading-worker/src/e2e.ts`, the `./e2e` entry of their `exports`). Nothing at runtime
imports these barrels.

The harness does not follow `index.ts` by itself. When `index.ts` gets a new dependency (as
`marketData` came with #404), check it against this table and add it to the harness or to the
"not built" rows.

### Backend (`harness/backend.ts`, from `apps/backend/src/index.ts`)

| `index.ts` | Harness |
| --- | --- |
| `pool`, `redis` (health), `queueRedis` | the temp database's pool; one Redis client for the jobs and the health check |
| `createBullmqPublisher(queueRedis)` | the same, with a random key prefix for this file (`prefix`) |
| `createTokenCipher` | the same, with a random key |
| `createBrokerOAuthClient`, `createBrokerRestClient` | the same, on the mock's URL, with the mock's client credentials (`MOCK_OAUTH`) |
| `createPairsCatalog` | the same; `ttlMs` 60 000. It is warmed before `listen()` and started, as in `index.ts` |
| `createCachedSignalFeed(createSignalFeed(...))` | the same, on production's `SIGNAL_FETCH_BUDGET_MS` and `SIGNAL_CACHE_MAX_TTL_MS` |
| `createClientPush` | the same; its `api` goes through the Telegram transformer |
| `accessToken` (`ensureFreshAccessToken`) | the same |
| `buildApp` | the same, with the trading, pairs, sessions, signal, auth and users deps. `signals`, `payments` and `admin` take the `unused*Deps` of the suites, so a call there fails the test. `deposit` takes `unusedDepositDeps` with the real init-data verifier. Its logs go to the backend's sink |
| `OutboxPublisher` | the same; `pollMs` 50 (every queued intent wakes it anyway) |
| `createBalanceReconciler` | built, not started: the routes call `refresh()` themselves |
| `createSessionNoticeSender` | the same; `tickMs` 200, `perSecond` 50 (production: `SESSION_NOTICE_TICK_MS`, `SESSION_NOTICE_SEND_PER_SECOND`) |
| `signalScanners` | not built: the run takes the manual path, not «Сигналы сейчас» |
| `createAdminBot`, `createMailingEngine`, `createStarReconciler`, `createServiceAccountKeeper` | not built: no staff, mailing, Stars or service account takes part in the cycle |
| `marketData` | not built: it exists only with the backend's `BROKER_WS_URL`, and nothing reads the ring yet (#405) |
| `createBotTextRefresher` | not built: the texts are the catalog's defaults |
| `postbacks` | absent, as without `POSTBACK_URL_SECRET` |

### Worker (`harness/worker.ts`, from `apps/trading-worker/src/index.ts`)

`createWorker` itself, with an `Env`. `brokerWsUrl` is the mock, so orders go over the socket, as
on the pilot since 2026-10-08. `demoOnly` is `false`. The circuit breaker cannot trip within the
run. The harness passes no `testing.tokens`, `signals` or `pairs`, unlike
`worker.handoff.db.test.ts`: the worker asks the backend. `testing.tuning` is `TEST_WORKER_TUNING`
from `apps/trading-worker/src/testing.ts`, shared with the handoff test (a 100 ms orchestrator and
session tick, no candle slack, production's lease lengths), and `testing.queuePrefix` is the file's
prefix. The socket oracle `watchSockets` comes from the same module.

### Bot (`harness/bot.ts`, from `apps/bot/src/index.ts`)

`createBot` with `createBackendClient` on the backend's URL, `createIntentTracker` on production's
constants and `createSessionTracker` with `firstPollMs` 200 and `pollMs` 300 (production: 3 s and
10 s), the deadline and the resume gap production's. `createSessionResumer` is built because
`createBot` requires it, and not started, since no restart happens. `runBot` (polling) is replaced
by `bot.handleUpdate`. The bot gets `botInfo`, so it never calls `getMe`.

### Telegram (`harness/telegram.ts`)

The bot's `captureApi` (it also refuses a «🔄 Повторить» that would repeat a write, #350) and the
push's `capturePushApi` record every call. Both answer a send or an edit with a message from one
shared `message_id` sequence, so an id the push sent can never be taken for one the bot sent. A
photo gets two sizes with their own `file_id`. A press takes the newest message of the bot that
carries a button with the given label, and sends its `callback_data` from that message. A press on
a photo arrives as a photo's press (#482). Labels come from `LABELS` and the label builders, never
from literals, and no callback data is built by hand.

## Sequence

| Stage | What the test does | Oracles |
| --- | --- | --- |
| S1 | `/start` | a «🔗 Подключить аккаунт Binodex» button; `users` row `active`, 0 tokens, no demo stake |
| S2 | the press, then the address | the mock sent a code (`oauth.codeFor`); the bot's answer names the address; the journal has one `emailSendCode` with the keys `client_id`, `client_secret`, `email` |
| S3 | the code | the account card (`sendPhoto`, pinned) with the starter pack of 100 and «🎮 Демо-торговля»; `broker_accounts` `active`, broker user `7001`, `is_partner_client`; `readTokenBalance` 100; one `emailLogin` |
| S4 | «🎮 Демо-торговля» → «🧭 Выбрать пару вручную» → the type (exactly one: «💱 Валюты · 1») → the pair → «⏱ 15 с» → «📊 Анализ» | the analysis card offers `$1.00 ✅` (the broker's minimum), the screen is deleted, the journal has a `chart` request for asset 101 at `15s`, `users.last_analysis_*` = 101 / 15 |
| S5 | the amount | the status message (`sendPhoto`, «15 с»), the card is deleted; `trading_sessions` `active`, `demo`, start signal `up`, settings v3 `{ cycles: 5, martingale, baseStake '1', stakeScale 2, limits { maxSteps 4, maxStake '12', maxSessionLoss '20' } }`; `users.demo_stake` 1; `status_message_id` is the status message's id; then the first «🔎 Ждём сигнал…» in the push |
| S6 | for each of 6 trades: wait for it at the mock and for its intent to be `accepted`, then settle it (a loss, then 5 wins) and wait for `settled` | stakes `1, 2.18, 1, 1, 1, 1`, all `up`, demo, asset 101; the session `stopped` / `completed`; 6 intents `settled` over `socket`, `client_request_id` `session:<id>:1..6`; `broker_trades` profits `-1, 1.85, 0.85 ×4` and the same at the mock; the mock's demo balance `10004.25`; never more than one socket per broker user |
| S7 | wait for the summary in the push (a `sendMessage` with «🏠 В меню»), then `final_notice_sent_at` set | the push: 5 cycle messages, silent and without a keyboard, one edit of the first (step 2 of cycle 1); every «🔎 Ждём сигнал…» (at least one) is deleted after it went out and before the next message the backend sends; the summary is last, with sound, «🏠 В меню» alone and `+$4.25` |
| S8 | wait for the summary card's `sendPhoto` (its caption), then `summary_sent_at` set | the status message edited to its finished form; the summary card: silent, the caption `sessionCardCaption` with `+$4.25` and `@binarius_bot`, «🏠 В меню» among its buttons |
| S9 | | tokens 94, none reserved; the ledger: `bonus` ×1, `reserve` ×6, `settle` ×6, nothing else |
| S10 | | no line at `error` in any of the three logs; the teardown: the worker's shutdown `clean`, `broker.close()` without listener errors |

The trade is settled only after its intent is `accepted`. A trade settled before the worker
recorded the broker's answer would close through the settlement catch-up seconds later, not
through the socket. A real 15-second trade never closes that early.

The «📤 Поделиться» button of the summary card is not asserted: PR #597 sets it only with
`SHARE_STORAGE_CHAT_ID`, and `session-share.test.ts` covers it.

The test waits for the first waiting message before the first trade is settled, so the run always
has one. Whether later ones go out depends on whether the sender's tick falls between two trades,
so the check holds for any number of them.

A stage waits for the observable action it then asserts (a Telegram call, a trade at the mock),
never for a database mark committed before that action. `final_notice_sent_at` and
`summary_sent_at` are such marks: the backend's `claimSessionFinalNotice` commits before
`push.sendSessionSummary`, and `claimSessionSummary` commits before the bot draws the card and
sends it. S7 and S8 read them after their wait, as assertions.

## The price path

`harness/broker.ts` → `rampPricePath`: `base × (1 + slope × k + zigzag × (k mod 2))`, where `k` is
the index of the 15-second candle since the broker started. It uses `base` 1.08765, `slope`
0.0001 per candle and `zigzag` 0.0005. The architect's probe (decider v2, `DEFAULT_SIGNAL_PARAMS`,
60 clock positions within and across candles) gave `signal:up` at every position (RSI ≈ 58, ATR
≈ 0.096 %). Without the zigzag RSI is 100 and the decider refuses with `rsi_overbought`. The mock's
own waves give `volatility_too_low`. The decision is the same anywhere in the candle, so the test
does not depend on when the press falls.

The curve drives the chart, `open_price`, `close_price` and `price.update`. The candle's wick is at
most 0.05 % of the curve's price at the candle's start. Before #105 it was 0.05 % of the asset's
built-in base price (about 907 for asset 101): wicks of up to 0.45 on a 1.09 curve.

## The mock's OAuth

The email login and `oauth/token` are the mock's own routes: [mock-broker.md → OAuth and the email
login](mock-broker.md#oauth-and-the-email-login-105). The backend's OAuth client runs against them
unchanged, and the access token the login issues is the one the worker's socket and REST calls
present.

## Running it

```bash
eval "$(fnm env)" && fnm use
TEST_DATABASE_URL=postgres://binarius@127.0.0.1:5434/binarius REDIS_URL=redis://localhost:6379 \
  pnpm test packages/e2e
```

The variables are the integration project's (README → Test database). The file refuses to start
without them.

## The log oracle

Each process logs through production's `logOptions` into its own sink (`harness/logs.ts`, level
`info`). The run must leave no line at `error`. This oracle comes on top of the positive ones in
S1–S9, never in their place.

## Accepted risks

1. One process for three services: there is no process isolation and no container network, and the
   timings are kinder than on a compose stand. A deploy overlap and a crashed process are
   `worker.handoff.db.test.ts`'s cases, not this test's.
2. Telegram is a transformer: the shape of a call is not validated, and the `message_id` and
   `file_id` values are made up.
3. The mock's fixture rules (refusal texts, settlement on demand, an earlier access token still
   valid after a refresh, `is_partner_client` of a new address) may differ from the live broker
   ([mock-broker.md → Observed vs fixture rule](mock-broker.md#observed-vs-fixture-rule)).
4. Each wait is bounded by `until`'s 15 s, and the whole case by 120 s. If a stage hits its bound
   on CI, the fix is to split its wait into smaller conditions, not to raise the bound.
5. The sender's `perSecond` 50 is a test value. Production's chain against the shutdown budget is
   pinned in `apps/backend/src/timing.test.ts`, not here.
6. The harness repeats `index.ts` by hand (Components).

## Boundaries

- A repeated `/start`, a duplicate Telegram update or postback: #106, built on this harness.
- Moving the backend's `oauth-stub.ts` suites to the mock: #603.
- Not covered: the «Сигналы сейчас» path (the scanners), the REST transport and a restart of the
  bot or the worker in the middle of a session.
- No Playwright: since #314 the cycle has no browser surface. The login is a dialog in the bot,
  and the cashier (`apps/web`) is not part of the demo cycle.
