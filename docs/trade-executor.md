# Trade command executor (ARCH-01, #100)

`createTradeCommandExecutor({ sessions, rest, tokens, logger })`
(`apps/trading-worker/src/intents/trade-command-executor.ts`) implements the processor's
`TradeExecutor` port (`intents/executor.ts`): it sends the intent's order to the broker and turns
the answer into `accepted`, `rejected` or `unknown`. The processor
([trade-intent-transport.md](trade-intent-transport.md)) owns the deadline, the outcome writes and
the reconciliation row; the executor writes nothing.

```bash
pnpm test --project unit apps/trading-worker/src/intents/trade-command-executor.test.ts apps/trading-worker/src/broker apps/trading-worker/src/intents/executor.test.ts
# the processor on the production composition (TEST_DATABASE_URL and REDIS_URL as in README → Test database)
pnpm test --project integration apps/trading-worker/src/intents/processor.db.test.ts
```

## Components

| Part | Where | What |
|---|---|---|
| `buildExecutor(env, inner)` | `intents/executor.ts` | the worker's one production composition: `realTradingGate` outside the trade command executor (#134). With `REAL_TRADING_ENABLED` off a real intent is `rejected`/`real_trading_disabled` and the inner executor is never called (`executor.test.ts`, through `parseEnv`) |
| `TradeSessionSource` | `broker/trade-session.ts` | `sessionFor(brokerAccountId)` → the account's live socket client or `undefined`. Production: the session manager ([broker-session.md](broker-session.md), #101) when `BROKER_WS_URL` is set, `noTradeSessions` (always `undefined`) otherwise |
| `BrokerSocketClient.openTrade` | `broker/socket.ts` | the socket command and its correlation ([broker-socket.md](broker-socket.md) → The trade command) |
| `AccessTokenSource` | `broker/access-token.ts` | the account's broker token for the REST path (#90: `createBackendAccessTokenSource` over the backend's internal route; the backend refreshes when needed). `ok: false` for every expected failure, a refusal or the backend unavailable; a throw is a bug |
| `BrokerRestClient.openTrade` | `packages/broker-rest` | the REST fallback ([broker-rest.md](broker-rest.md) → Errors) |

The amount goes out in its shortest decimal form (`normalizeDecimal` from `@binarius/db`:
`'10.00000000'` → `'10'`, `'1.50000000'` → `'1.5'`), never through a float. The live broker
took `"1.5"` (2026-10-03); eight fraction digits were never sent live and the fixture refuses
them.

## The two-cases rule

1. **Socket**, when the account has a session: `openTrade(intent.mode, request, signal)`.
2. **REST**, only when nothing was emitted: no session for the account, or the session answered
   `not_sent`/`not_ready` (any state but `ready`, or a connection tainted by an aborted command
   until its replacement is `ready`). `transport` is then `rest_fallback`.

After an emit the answer is the socket's or `unknown`. The executor never follows an emit with a
POST, never sends the order twice and never retries; what happened to an `unknown` order is
established by reconciliation (#89/#90), which only reads. #90's REST reconciler never answers
`not_found`: an order it cannot find once the window has closed is parked in `manual_review`
(`reconciliation_not_found`) with the account halted, and the reserve is kept until an operator
decides (the release on proven absence is #274). So `broker_unavailable` costs the user nothing
silently: the trade is found and accepted, or it waits for a human. The four disconnect stages and the
test that proves each (`trade-command-executor.test.ts`):

| Stage | Outcome | Test |
|---|---|---|
| before send (no session, a session not `ready`, or a tainted connection) | one REST POST, `rest_fallback` | S3, S4, S9 |
| after send, before any answer (the transport drops) | `unknown`, no REST request, nothing re-emitted on the next connection | S5 |
| before the success (the server drops the socket; the trade did open) | `unknown`, no REST request | S6 |
| after the success | `accepted` | S7 |

S5, S6 and S8 (abort while waiting) also assert that the socket journal holds one `open_trade`
and the REST journal no POST: the ban on a second open. S9 aborts a command and submits the next
one at once, with the connection kept open through the client's `openSocket` seam: the second
goes over REST, the socket journal still holds one `open_trade`.

## Outcomes

`signal` (the processor's `SUBMIT_ACK_TIMEOUT_MS`) is passed to the socket wait, the token
fetch and the REST call; the executor has no timer of its own.

| Stage | Answer | `SubmitResult` | `last_error` |
|---|---|---|---|
| socket | `success` | `accepted`, `transport: socket`, the broker's trade | — |
| socket | `fail` | `rejected`, `detail` = the messages joined with `; `, cut to 200 | `broker_rejected` |
| socket | `unknown` (`state_changed`, `aborted`) | `unknown` | `broker_unavailable` |
| socket | `not_sent`/`not_ready` | → REST | — |
| socket | `not_sent`/`aborted` (the deadline already passed) | `unknown`, dropped by the processor | `broker_unavailable` |
| no session | — | → REST | — |
| REST, token | `ok: false` (any reason: a refusal or the backend unavailable) | `rejected`; no request leaves the worker | `broker_rejected` |
| REST, token | a throw | propagates: the processor's `unknown`/`executor_error` | — |
| REST | the trade | `accepted`, `transport: rest_fallback` | — |
| REST | `unauthorized`, `rate_limited`, `rejected` | `rejected`, `detail` = the broker's, already cut | `broker_rejected` |
| REST | `unavailable`, `contract_violation` | `unknown` | `broker_unavailable` |
| REST | `aborted` | `unknown`, dropped by the processor | `broker_unavailable` |
| REST | any other throw | propagates: the processor's `unknown`/`executor_error` | — |

`rejected` only where the order certainly did not go out; `unknown` everywhere it may exist. An
accepted trade that does not match the intent is the processor's `trade_mismatch` (#17), not the
executor's. The `detail` is logged, never stored.

## Logs

The worker's pino (`logOptions`). No token, no amount, no URL; broker text only as `detail`, cut
to `MAX_DETAIL_LENGTH` (200). The socket state is logged as `sessionState`: `state` is a redacted
key (the OAuth state). `trade-command-executor.test.ts` (L1) reads the log itself across every
line below and finds no `SECRET-` sentinel and no broker host.

| `msg` | Level | Fields |
|---|---|---|
| `trade command accepted` | info | `intentId`, `transport`, `brokerTradeId` |
| `trade command refused` | warn | `intentId`, `transport`; socket: `failures` (count), `detail`; token: `stage: token`, `reason`, `status`; REST: `stage: rest`, `code`, `status`, `retryAfterSec`, `detail` |
| `trade command outcome unknown` | warn | `intentId`, `transport`; socket: `reason`, `sessionState`; REST: `stage: rest`, `code`, `status` |
| `trade command falls back to rest` | info | `intentId`, `sessionState` (`none` without a session) |

## Accepted risks

1. **The socket command was never exercised live** (owner, 2026-10-06): its shape comes from
   broker-web and the fixture. Falsifiable: the first demo session on the pilot gives
   `trade command outcome unknown` with `transport: socket` on every intent while the REST
   fallback succeeds; if the cause is the answer's shape, a `broker event problem` with
   `kind: schema` on `user.demo.open_trade.success` at `is_demo` (optional in broker-web, absent
   from the live `close_trade.success`). The fix would be the shared schema, not the executor.
2. Without `BROKER_WS_URL` every intent travels over REST (`rest_fallback`) and the socket path
   runs only in tests; with it, an account in work has a session ([broker-session.md](broker-session.md)).
   The `transport` column shows it per intent.
3. **The token fetch and the POST can outlast the submit deadline** (owner, 2026-10-06). The
   token route's budget is 7 s (`ACCESS_TOKEN_ROUTE_BUDGET_MS`: one broker token exchange of up
   to 5 s, #90) and the REST call's 5 s (`BROKER_REST_TIMEOUT_MS`); together 12 s against the
   default `SUBMIT_ACK_TIMEOUT_MS` of 10 s. The executor does not pass `mayRefresh` (default
   `true`), so the backend may exchange the token on this path (a trade is a user action). When
   the budget runs out the processor writes `executor_timeout`/`unknown` and reconciliation
   decides; a fetch cut before the POST sent nothing, so the reconciler finds no trade and parks
   the intent in `manual_review` with the account halted (no `not_found` in `main`, #274).
4. A late answer of an earlier command on the same connection is closed by #101: a command that
   ends without its answer taints its connection and the client drops it, and a `success` is the
   answer only with the command's asset, action and amount ([broker-socket.md → The trade
   command](broker-socket.md#the-trade-command-100)). What stays open is an answer on another
   socket of the same user — a manual order in broker-web, if the live broker sends answers to
   every socket: a `fail` would reject our intent while our order may be open, and a `success`
   with equal terms would link the manual trade. The two-socket probe (#285) decides whether
   `BROKER_WS_URL` may be set; until then it stays unset.
5. Every token failure is `broker_rejected` (owner: one new code); the log names the stage and
   the reason.
6. The broker's `fail` and REST `detail` texts are logged cut to 200 characters; an amount the
   broker echoes would be a log-only exposure.

## Boundaries

- **#90**: the token source and its backend route, `BROKER_API_BASE_URL`, `BACKEND_URL`,
  `INTERNAL_API_TOKEN`, the REST client in `index.ts`, the reconciler and the catch-up.
- **#101**: implemented — the session manager ([broker-session.md](broker-session.md)) and the
  taint; no `refresh()` after `accepted` (the `update_balance` before `open_trade.success` is it).
- **#91**: the "REST only before send" rule and the four stages are proven here.
- The operator tool for `manual_review` and the bot's trade flow are later issues.
