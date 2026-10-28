# The demo cycle end to end (issue #105)

`packages/e2e/src/demo-cycle.db.test.ts` (`@binarius/e2e`) takes one user through the whole demo
cycle: `/start` → the email login → the manual choice of a pair → the analysis → a demo session of
five cycles → its result. The backend, the trading worker and the bot run as their production
compositions in one vitest process, over one Postgres, one Redis and the mock broker
([mock-broker.md](mock-broker.md)). Only two things are stand-ins: Telegram (a grammY transformer
on the bot's and the backend's `Api`) and the broker (the mock). The bot reaches the backend over
HTTP with its real client, and the worker reaches it through its real token and pairs
sources. The worker reaches the broker over the socket and REST.

It is an integration test (`*.db.test.ts`), so `pnpm check` runs it in CI against Postgres and
Redis. It needs no browser and no running service, and it takes about 2.5 s locally.

A second file on the same harness, `packages/e2e/src/repeat-events.db.test.ts` (#106), delivers
the cycle's events twice: `/start`, the login texts, the amount press and the broker's postbacks
([Repeated events](#repeated-events-106)). Each file has its own database, mock broker and queue
prefix.

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
| `createCachedSignalFeed(createSignalFeed(...))` | the same, on production's `SIGNAL_FETCH_BUDGET_MS` and `SIGNAL_CACHE_MAX_TTL_MS`, with the signal pacer `index.ts` builds (#405): the run is the no-source mode, so every chart GET takes a `tryTake` token |
| `createClientPush` | the same; its `api` goes through the Telegram transformer |
| `accessToken` (`ensureFreshAccessToken`) | the same |
| `buildApp` | the same, with the trading, pairs, sessions (with the H1 driver), signal (with the H1 scanner's `h1`), signals (the H1 scanner), auth and users deps. `payments` and `admin` take the `unused*Deps` of the suites, so a call there fails the test. `deposit` takes `unusedDepositDeps` with the real init-data verifier. Its logs go to the backend's sink |
| `OutboxPublisher` | the same; `pollMs` 50 (every queued intent wakes it anyway) |
| `createBalanceReconciler` | built, not started: the routes call `refresh()` themselves |
| `createSessionNoticeSender` | the same; `tickMs` production's `SESSION_NOTICE_TICK_MS` (3 000, #723: a message within a second is the wake's, not a short tick's), `perSecond` 50, `chatGapMs` 100 (production: `SESSION_NOTICE_SEND_PER_SECOND`, `SESSION_NOTICE_CHAT_GAP_MS`) |
| `createSessionNoticeListener` | the same (#723): on the harness's pool, `wake()` of the sender; started after it, stopped before it |
| `createSecondSeries`, `createH1Scanner`, `createH1Driver` (inside `marketData`, #828) | built on a series of their own that the harness's pump fills ([The price path](#the-price-path)): the scanner serves the analysis's `h1` and the signals list, the driver trades every session; the driver's `submitBudgetMs` 5 000 (the run's take is not timed, as `session-routes.db.test.ts` H1-R10) and `scanMs` 1 000; `streaming` always true. The listener's notification reaches `h1Driver.notice` as in `index.ts` (the repeat step). Started after `listen()` before the pump, stopped first |
| `createAdminBot`, `createMailingEngine`, `createStarReconciler`, `createServiceAccountKeeper` | not built: no staff, mailing, Stars or service account takes part in the cycle |
| `marketData` (the manager, the ring, the backfill, the driver, the scanner) | not built: it exists only with the backend's `BROKER_WS_URL`; without it the candle feed reads REST (#405), as here |
| `createBotTextRefresher` | not built: the texts are the catalog's defaults |
| `postbacks` | `{ db, secret }` with the harness's secret (`E2E_POSTBACK_SECRET`), as with `POSTBACK_URL_SECRET` set; the demo cycle sends none, the repeat run sends four |

### Worker (`harness/worker.ts`, from `apps/trading-worker/src/index.ts`)

`createWorker` itself, with an `Env`. `brokerWsUrl` is the mock, so orders go over the socket, as
on the pilot since 2026-10-08. `demoOnly` is `false`. The circuit breaker cannot trip within the
run. The harness passes no `testing.tokens` or `pairs`, unlike
`worker.handoff.db.test.ts`: the worker asks the backend. `testing.tuning` is `TEST_WORKER_TUNING`
from `apps/trading-worker/src/testing.ts`, shared with the handoff test (a 100 ms orchestrator and
session tick, production's lease lengths), and `testing.queuePrefix` is the file's
prefix. The socket oracle `watchSockets` comes from the same module.

### Bot (`harness/bot.ts`, from `apps/bot/src/index.ts`)

`createBot` with `createBackendClient` on the backend's URL, `createIntentTracker` on production's
constants and `createSessionTracker` with `firstPollMs` 200 and `pollMs` 300 (production: 3 s and
10 s), the deadline and the resume gap production's. `createSessionResumer` is built because
`createBot` requires it, and not started, since no restart happens. `runBot` (polling) is replaced
by `bot.handleUpdate`. The bot gets `botInfo`, so it never calls `getMe`. One `createShownSignals`
store goes to the signal waiter and the bot, as in `index.ts` (#829); the harness keeps each
record a start took (`shownTaken`) for S5's oracle.

### Telegram (`harness/telegram.ts`)

The bot's `captureApi` (it also refuses a «🔄 Повторить» that would repeat a write, #350) and the
push's `capturePushApi` record every call. Both answer a send or an edit with a message from one
shared `message_id` sequence, so an id the push sent can never be taken for one the bot sent. A
photo gets two sizes with their own `file_id`. A press takes the newest message of the bot in the
chat of `USER` that carries a button with the given label, and sends its `callback_data` from that
message; messages to the repeat run's other users are skipped. A press on a photo arrives as a
photo's press (#482). Labels come from `LABELS` and the label builders, never from literals, and no
callback data is built by hand.

Every `start`, `send` and `press` returns the update it sent. `replay(update)` hands the same
object to `bot.handleUpdate` again: Telegram's re-delivery, with the same `update_id` and
`callback_query.id`.

## Sequence

| Stage | What the test does | Oracles |
| --- | --- | --- |
| S1 | `/start` | a «🔗 Подключить аккаунт Binodex» button; `users` row `active`, 0 tokens, no demo stake |
| S2 | the press, then the address | the mock sent a code (`oauth.codeFor`); the bot's answer names the address; the journal has one `emailSendCode` with the keys `client_id`, `client_secret`, `email` |
| S3 | the code | the account card (`sendPhoto`, pinned) with the starter pack of 100 and «🎮 Демо-торговля»; `broker_accounts` `active`, broker user `7001`, `is_partner_client`; `readTokenBalance` 100; one `emailLogin` |
| S4 | «🎮 Демо-торговля» → «🧭 Вручную» → the type (exactly one: «💱 Валюты · 1») → the pair (its summary at 5 s, #685) → «📊 Анализ» | the analysis card (it exists because the scanner holds an H1 signal on the pumped series, #828: «Сильный сигнал на рост») offers `$1.00 ✅` (the broker's minimum), the screen is deleted, the journal has a `chart` request for asset 101 at `5s` (the card's rows), `users.last_analysis_*` = 101 / 5 |
| S5 | wait for the worker's socket of the account (the analysis's access read put it in work; a user's pause gives it in production), then the amount | the status message (`sendPhoto`, «5 с»), the card is deleted; `trading_sessions` `active`, `demo`, start signal `up` (the card's direction, #829: the start took the card's record, `shownTaken` one `analysis` record `up`); the session's two `h1-start` rows — the start's `session_start` `started` and Шаг 1's `intent` row linked by the first intent's `signal_decision_id` — both with `decided_at_ms` the card's second and `source` `{ kind: shown, source: analysis }`; the first intent `up` with no `submit_deadline_at`; settings v5 `{ durationSec: 5, cycles: 5, martingale, baseStake '1', stakeScale 2, limits { maxSteps 4, maxStake '12', maxSessionLoss '20' }, signal { kind 'h1', R1, entryDelaySec 1, expirySec 5 } }`; `users.demo_stake` 1; `status_message_id` is the status message's id; no waiting message is awaited: the pump gives an H1 signal on every second, and «🔎 Ждём сигнал…» goes only after a `no_signal` decision (#722) |
| S6 | for each of 6 trades (the H1 driver's: step 1 on the card's direction (#829), step 2 the repeat at the loss's notice, then one a signal at most every 7 s, #828): wait for it at the mock and for its intent to be `accepted` — trades 1 and 2 also for their open block in the push (#700: trade 1's a new message, trade 2's an edit) — then settle it (a loss, then 5 wins) and wait for `settled`; the open blocks of trades 1 and 2 within 1 s of `accepted`, trade 2's result within 1 s of `settled` (#723, the sender's wake on production's tick) | stakes `1, 2.18, 1, 1, 1, 1`, all `up`, demo, asset 101; the session `stopped` / `completed`; 6 intents `settled` over `socket`, `client_request_id` `session:<id>:1..6`; trades 4–6 each at least 6 s after the one before (the driver's cadence, `f + 7 s` less the decision's jitter); `broker_trades` profits `-1, 1.85, 0.85 ×4` and the same at the mock; the mock's demo balance `10004.25`; never more than one socket per broker user |
| S7 | wait for `final_notice_sent_at` (#537: the backend's last act for the session, no message) | the push: 5 cycle messages, silent, the first opening with trade 1's open block; every send or edit carrying an open block has exactly «⏹ Остановить сессию» `session:stop:<id>:c` (#722), every other one no keyboard (a result's edit takes it off); three edits of the first — trade 1's result with the adaptive line under it (#718), trade 2's open block under the line, trade 2's result (#700), the line once between 🔴 and 🟢; an open block at most once a trade, at least for trades 1 and 2, and none left in the chat at the end; every «🔎 Ждём сигнал…» (by its `:w` data; none when the session has no `no_signal` decision, #722) is deleted after it went out, and before the next message the backend sends when one follows |
| S8 | wait for the bot's summary photo (`sendPhoto` whose caption starts with «📈»), then both marks set | no text summary in the push (the bot tracks the session, so the fallback sends nothing); the status message edited to its finished form; the summary: with sound (no `disable_notification`), the caption's first line «📈 EUR/USD», `+$4.25`, «🧪 Демобаланс: $10 004.25», no `t.me/` link in the caption and no `referral_codes` row for the user (#709), «🏠 В меню» among its buttons |
| S9 | | tokens 94, none reserved; the ledger: `bonus` ×1, `reserve` ×6, `settle` ×6, nothing else |
| S10 | | no line at `error` in any of the three logs; the teardown: the worker's shutdown `clean`, `broker.close()` without listener errors |

The trade is settled only after its intent is `accepted`. A trade settled before the worker
recorded the broker's answer would close through the settlement catch-up seconds later, not
through the socket. A real 5-second trade never closes that early.

The «📤 Поделиться» button of the summary card is not asserted: PR #597 sets it only with
`SHARE_STORAGE_CHAT_ID`, and `session-share.test.ts` covers it.

The pump gives an H1 signal on every second, so the session never waits for one and the run has
no waiting message (#722); the check holds for any number of them, and the sender's own tests
(`session-notices.db.test.ts`, the #722 describe) show when one appears and goes.

A stage waits for the observable action it then asserts (a Telegram call, a trade at the mock),
never for a database mark committed before that action. `summary_sent_at` is such a mark:
`claimSessionSummary` commits before the bot draws the card and sends it, so S8 reads it after its
wait, as an assertion. `final_notice_sent_at` is no longer one (#537): the backend sends nothing
with it, and it commits only after every trade's message and waiting message of the session went
in the same turn of the sender, so S7 waits for it and then reads the push.

## Repeated events (#106)

The bot does not dedupe updates by `update_id`, so «the second time changes nothing» is held by the
backend and the database: the `users` upsert, one active session per account and its 409
`active_session_exists`, a text outside the login dialog being ignored, and the postbacks' keys
(Rule 7). A repeat is the same `Update` object a second time, or the same postback query a second
time; a new `/start` with a payload is a new update and is tested as one. Each oracle is a
positive count read after the repeat (1 account, 1 session, 3 journal rows), not "nothing changed"
from an empty start. The users are `USER` (A), `E2E_USER_B` and `E2E_USER_C`.

| Stage | What the test does | Oracles |
| --- | --- | --- |
| S1 | `/start` | the connect button; A's `users` row `active`, 0 tokens, no acquisition source |
| R1 | the same `/start` update again; then `/start promo-a` and `/start promo-b` | the welcome again; the same row (`id`, `created_at`, status, 0 tokens, no source); `promo-a` recorded with `acquired_at`, `promo-b` leaves both; 1 user |
| S2 | the press, the address | one `emailSendCode` |
| R3a | the address update again, on the code step | the text is taken as a code: one `emailLogin` the mock refuses, still one `emailSendCode`, the same code at the mock; the bot answers with the code step's keyboard (resend, change address) |
| S3 | the code | the account card; the account `active`, broker user `7001`; 100 tokens; two `emailLogin` |
| R3b | the code update again | no Telegram call at all; still two `emailLogin`, one account, one `bonus` row, 100 tokens |
| R2 | B: `/start`, `/invite`; A: `/start ref_<B's code>`; C: the same, then that update again | the code is read from B's screen; A, who exists, gets the status card and no `referrals` row, and keeps `promo-a`; C gets one row (`invitee` C) and `acquisition_source` = the payload; C's repeat leaves the same row; 3 users |
| R4 | postbacks for broker user `7001`: a deposit, the same query again, `ftd` of the same payment, a third id with amount 60 | `recorded`, `duplicate`, `repeated`, `repeated`; one `deposit_events` row (`received`, A's user and account, 50 USD, the same `id` throughout); `postback_deliveries` 1, 2, 3; the backend's `postback received` lines in that order and one `postback repeated with different fields` with `mismatch: ['amount']` and no `amount` key; 100 tokens, one ledger row |
| S4–S5 | the manual door, the amount | the status message («5 с»); one session, `active`, `demo`; `demo_stake` 1 |
| R5 | the amount press again | one more `sendPhoto` with «5 с» in A's chat; one session, the same `id`, `settings` and start signal; `demo_stake` 1 |
| trade 1 | wait for the trade and its intent `accepted`, settle a win | exactly one intent of the session before the settle |
| R6 | `/start` mid-session | the account card, pinned; the session still the one `active` row; 3 users |
| trades 2–5 | the same cycle, all wins | the session `stopped` / `completed` |
| totals | | 95 tokens, none reserved; the ledger `bonus` ×1, `reserve` ×5, `settle` ×5; 5 intents, 1 account, 1 session, 3 users, 1 referral, 1 deposit, 3 deliveries; `emailSendCode` 1, `emailLogin` 2; 5 trades at the mock, profit 0.85 each |
| logs | | no line at `error` in any of the three logs (the refused code and the other amount are `warn`) |

After R5 the bot shows the running session in a new message, and tracking moves to it. Which of
the two messages `trading_sessions.status_message_id` holds is not asserted: PR #591 changes that
rule from the first to the newest.

R3a replays the address while the dialog is alive, the worst case: on the code step any text is a
code ([bot-start.md → Email dialog](bot-start.md#email-dialog)), and the mock keeps a code a wrong
attempt did not match. It spends one of the five attempts of `EMAIL_LOGIN_ATTEMPTS_PER_KEY`. In
production a re-delivery comes after a restart, when the dialog is gone; that is R3b's case, where
the text is ignored.

## The price path

Two series, two jobs (#828). **The second series** (`harness/h1.ts` → `startH1Pump`) is what the
backend's H1 scanner and driver read: it pushes `H1_PUMP_HISTORY_SEC` (320) seconds of a convex
ramp `price(t) = 1.1 + 1e-6 × t²` (rounded to the pair's 5 digits) before the run's clock, then one
tick a second and `advance` every 100 ms. Each 3-second move is the largest of the window behind
it, so R1 reads `up` on every second; `harness/h1.test.ts` E2E-H1 pins it by running
`createH1Detector(H1_R1_PARAMS)` over ten minutes of the ramp. The ramp is synthetic: the run proves
the H1 path, not the detector's edge (the detector's own tests do). It feeds the series only.

**The mock's curve** prices the trades and draws the analysis's candles:
`harness/broker.ts` → `rampPricePath`: `base × (1 + slope × k + zigzag × (k mod 2))`, where `k` is
the index of the 5-second candle since the broker started (`candleMs` 5 000 since #685, the demo's
one duration; 15 000 before). It uses `base` 1.08765, `slope`
0.0001 per candle and `zigzag` 0.0005: the same series on every candle length. The architect's probe
(decider v2, `DEFAULT_SIGNAL_PARAMS`, 60 clock positions within and across 15 s candles, #105) gave
`signal:up` at every position (RSI ≈ 58, ATR
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
4. Each wait is bounded by `until`'s 15 s, and the whole case by 120 s (#828: the driver's 7 s
   cadence brings each case to about 28 s locally). If a stage hits its bound
   on CI, the fix is to split its wait into smaller conditions, not to raise the bound.
5. The sender's `perSecond` 50 is a test value. Production's chain against the shutdown budget is
   pinned in `apps/backend/src/timing.test.ts`, not here.
6. The harness repeats `index.ts` by hand (Components).

## Boundaries

- Not repeated in #106: a restart of the bot (the dialog is lost, and the text is then ignored,
  which R3b shows), the amount press after the session ended (it opens a new session by design),
  `/stop` twice, `connect` again, a duplicate `successful_payment` (Stars reconciliation, #117), a
  postback through the proxy header (`postbacks/routes.db.test.ts`), crediting a deposit (#386).
- Moving the backend's `oauth-stub.ts` suites to the mock: #603.
- Not covered: the «Сигналы сейчас» path (the H1 scanner's list is built but not pressed), the
  REST transport (the first H1 trade goes over it when the worker's socket is not up yet: S5 waits
  for the socket) and a restart of the bot or the worker in the middle of a session.
- No Playwright: since #314 the cycle has no browser surface. The login is a dialog in the bot,
  and the cashier (`apps/web`) is not part of the demo cycle.
