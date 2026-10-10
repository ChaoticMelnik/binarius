# Trading switch (kill switch, #144)

One global switch stops new trades without stopping the service. It covers **demo and real
together**: there is no real-only switch (owner's decision 2026-10-07). It replaced #134's
`REAL_TRADING_ENABLED` environment flag, so opening trading for demo opens real too, and real
cannot be closed on its own.

While the switch is closed:

- `POST /trading/intents` refuses every new intent, demo and real, with 409 `trading_paused`.
  Only the user and an earlier intent with the same request id are read (a retry still gets
  the intent created while trading was open); nothing is reserved, nothing is woken;
- a queued intent whose job arrives is rejected with `trading_paused`, its token released, and
  nothing reaches the broker;
- `createTradingSession` refuses with `trading_paused`, and `stopPausedSessions` stops every
  active session with `stop_reason = kill_switch`. The orchestrator's tick runs it first, so the
  next tick stops a session before its signal call; an attempt already under way in the running
  tick still calls the signal, and its intent creation refuses `trading_paused`, which stops the
  session as `kill_switch` too. How long that takes is not bounded by `TRADING_SESSION_TICK_MS`:
  a tick runs its attempts one after another, and the sweep stops at most
  `TRADING_SESSION_BATCH_SIZE` sessions per tick ([trading-session.md](trading-session.md));
- trades already open, the broker sockets, reconciliation, settlement catch-up, the balance tick
  and the signal route go on as before.

The bot answers the refusal with «⏸ Торговля временно приостановлена, попробуйте позже.» and the
queued rejection with «⏸ Торговля временно приостановлена, попробуйте позже. Токен возвращён.»
Holders of open trades get no notice.

## The row

`trading_switch` (`packages/db/src/schema/trading-switch.ts`, migrations 0019, 0020 and 0033):

| Column | Rule |
|---|---|
| `id boolean primary key default true` | `trading_switch_singleton_check check (id)`: one row at most |
| `trading_enabled boolean not null` | the state; open is `true` |
| `source text not null` | `trading_switch_source_check`: `migration` (the seed), `operator` (the CLI) or `circuit_breaker` (the worker, #96); `trading_switch_open_source_check`: an open row's source is `migration` or `operator` |
| `reason text` | `trading_switch_stop_reason_check`: a closed row always has one; `trading_switch_reason_length_check`: 1–200 characters |
| `changed_at timestamptz not null` | the database's `now()` of the last change |

- **A missing row reads as closed** (fail-closed): a `DELETE` by hand stops trading, never opens
  it. Every SQL reader embeds the one predicate `tradingOpenSql`; the others call
  `readTradingSwitch` (`packages/db/src/trading-switch-ops.ts`).
- **A new database starts open.** Migration 0020 inserts `(true, 'migration', NULL)` (owner's
  decision 2026-10-07).
- **Only an operator opens trading.** `openTrading` is the only writer of `trading_enabled =
  true` and always writes `source = operator`; `stopTrading` writes only `false`. Enforced by
  `trading_switch_open_source_check` (#96: an open row with any source but the seed or the
  operator is refused, so the circuit breaker cannot open), and the writers are listed by
  `trading-switch-writers.test.ts` (T8).
- The CHECK holds the reason's length only. The content rule (trimmed, no control characters) is
  `tradingSwitchReasonSchema`, applied by the CLI.
- Rows of 0012–0018 that carried the retired reason `real_trading_disabled` are rewritten to
  `trading_paused` by migration 0019 before its new CHECKs are added.

## Readers and writers

| Who | Where | When closed |
|---|---|---|
| `createInTransaction` | after the replay, before the account and the reserve; any mode | `TradeIntentError(trading_paused)` → 409 |
| `takeIntent` | `queued → submitting` CAS, `and tradingOpenSql` | refused; the processor tries `rejectExpiredIntent`, then `rejectPausedIntent` |
| `rejectPausedIntent` | `queued → rejected` with the version CAS, reserve released | `warn` `intent rejected: trading paused` `{ intentId }` |
| `POST /trading/access` | `tradingOpen` in the answer | `false` |
| `createTradingSession` | after the account lock | `TradingSessionError(trading_paused)` |
| `stopPausedSessions` | one UPDATE, `status = active and not tradingOpenSql` | `stopped` / `kill_switch` |

- Readers take **no lock**. The writers lock only the switch row (Rule 5).
- `rejectPausedIntent` has **no switch predicate**: a switch reopened between the refused take and
  the rejection must not leave the intent `queued` with its job already consumed, holding the
  account's live-intent slot with nothing to move it. At the version the job read, `takeIntent`
  refuses an unexpired queued intent only for the switch, so the version CAS keeps this safe.
- The worker's fence is the CAS, not an executor wrapper: a database read inside the executor
  that hangs or throws would turn a never-sent order into `unknown` (Rule 15).

**The window (stated).** A `kill-switch on` commit does not wait for work already running: a
creation whose read ran before the commit can still insert one intent, and a `takeIntent`
statement that ran before it can still submit one. Every take that starts after the commit
refuses, so an intent created inside the window is rejected at take time unless it was already
taken. After `on` returns, no intent is **taken** for sending; intents already taken finish. The
bound is the creations in flight plus up to `WORKER_CONCURRENCY` submissions.

## The CLI

`apps/backend/src/cli/kill-switch.ts`; it reads only `DATABASE_URL`.

```bash
docker compose exec backend pnpm --filter @binarius/backend kill-switch status
docker compose exec backend pnpm --filter @binarius/backend kill-switch on --reason "инцидент брокера"
docker compose exec backend pnpm --filter @binarius/backend kill-switch off
docker compose exec backend pnpm --filter @binarius/backend kill-switch off --reason "брокер в норме"
```

| Command | Prints | Exit |
|---|---|---|
| `status` | «Торговля открыта (с <changed_at>, источник <source>)», or «Торговля остановлена (с …, источник …): <reason>», or «Строки переключателя нет — торговля остановлена» | 0 |
| `on --reason <text>` | «Торговля остановлена. Новые заявки отклоняются; уже открытые сделки, сверка и расчёт продолжаются.»; already closed: «Торговля уже остановлена (с …): <reason>» | 0 |
| `off [--reason <text>]` | «Торговля открыта — demo и real.»; already open: «Торговля уже открыта (с …)» | 0 |
| anything else (`on` without `--reason`, a reason that is empty, over 200 characters or holds a control character, an unknown flag, extra arguments) | the problem and the usage | 2 |
| a database failure (pool, statement, commit) | «Не удалось выполнить команду: <name and code>. Состояние могло измениться — проверьте командой status.» (`status`: «Не удалось прочитать состояние: …») | 1 |

- Each change is one transaction: the switch UPDATE (or the INSERT of a missing row) and, only
  when a row changed, an `audit_log` row: `trading_stopped` with `{ via, source, reason }` (`via`
  is `cli` for the operator, `circuit_breaker` for the worker's breaker) or `trading_resumed` with
  `{ via: 'cli', reason }`, `actor_type = system`,
  `entity_type = trading_switch`. A repeated command changes nothing and writes no audit row.
- `on` and `off` recreate a missing row (closed or open respectively).
- The failure line names the error and its cause by name and code only (Rule 8). It never says
  nothing changed: a commit whose acknowledgement was lost leaves the state unknown, so the
  operator learns it from `status`, never from a retry's answer.
- No restart is needed: backend and worker read the row on every request and every job.

## Deploy

The migrations open trading, so the pilot behaves as follows from the moment they land:

- before: demo traded, real was refused by `REAL_TRADING_ENABLED=false`;
- after: demo trades as before, **and real is no longer refused by any switch** unless the process
  runs `DEMO_ONLY=true` (below), which the pilot never does. What still
  stands between a real intent and the broker is the per-request checks of creation (the user
  `active`, an available token, the user's own `active`, not halted account, one live intent),
  the token route, the broker's own checks, and the user's trading mode: a real intent is created
  only for a user who switched real mode on in the bot ([trading-mode.md](trading-mode.md), Rule
  36), at the broker's minimum stake.

Steps:

1. Apply the migrations: `docker compose exec backend pnpm db:migrate` (automatically at start
   once #75 lands).
2. `docker compose exec backend pnpm --filter @binarius/backend kill-switch status` prints
   «Торговля открыта (с <changed_at>, источник migration)».
3. If real must not trade yet, the only switch is the global one: `… kill-switch on --reason
   "<why>"`. It closes demo and real together.
4. Delete `REAL_TRADING_ENABLED` from the server's `.env`. Compose no longer forwards it, so a
   leftover value reaches no process and has no effect.

The falsifiable sign that real is trading: `select count(*) from trade_intents where mode =
'real'` is above zero.

## Edge cases

- `kill-switch off` on a fresh database: «Торговля уже открыта (с …, источник migration)», exit 0.
- `on` while the bot polls an intent's status: the intent is rejected or finishes, and the
  tracker shows its line.
- The switch reopened between a refused take and the rejection: the intent is still rejected
  `trading_paused`.
- A database blip during a creation answers 500, not `trading_paused`: the read is part of the
  creation transaction.
- Backend and worker restarts change nothing: no process holds the state.

## The circuit breaker (#96)

The worker closes the switch on its own when the broker stops answering:
`stopTrading({ source: circuit_breaker, reason: «Автостоп: …» })`, demo and real together, audited
with `via: circuit_breaker`. It never opens: migration 0033 adds
`trading_switch_open_source_check check (not trading_enabled or source in ('migration',
'operator'))`, and `openTrading` writes `source = operator` in the same UPDATE, so the operator's
`kill-switch off` is the way back. `status` shows «… источник circuit_breaker): Автостоп: …».
Signals, thresholds and the operator's procedure:
[runbook-broker-outage.md](runbook-broker-outage.md).

## DEMO_ONLY (#396)

A second, narrower fuse for stands an agent drives (#397): a process started with `DEMO_ONLY=true`
does not send the broker an operation with real money; demo works as usual. It is not a switch:

| | The trading switch | `DEMO_ONLY` |
|---|---|---|
| Covers | demo and real | real only |
| Where | one database row, all processes | one process's environment |
| Changed by | `kill-switch on/off`, the breaker, no restart | `.env`, then recreating the containers (`docker compose up -d backend trading-worker`; `restart` keeps the old environment) |
| Default | open (the migration) | off (`false`; the pilot never sets it) |

It is read once at start by `parseDemoOnlyEnv` (`packages/shared/src/env.ts`): only `true` or
`false`; unset is `false`; an empty value or anything else (`1`, `TRUE`, `yes`) stops the process
with «Env DEMO_ONLY must not be empty» / «Env DEMO_ONLY must be one of: true false». Compose
forwards it to exactly `backend` and `trading-worker` (a valueless entry under
`x-broker-environment`, so it arrives only when set).

The readers and what each does with the flag on:

| Reader | What it does |
|---|---|
| `POST /trading/intents` (backend) | a real intent answers 409 `demo_only`. The check runs after the replay (a retry still gets a real intent an earlier process created) and before the switch, the account and the reserve: nothing is read, reserved or woken |
| `POST /trading/sessions` (backend) | `createTradingSession` refuses a real session `demo_only` before `mode_not_allowed` and before its transaction; the route sends demo today, so this guards #327's real sessions |
| the intent job (worker) | a queued real intent is rejected before `takeIntent`: `queued → rejected`, `last_error = demo_only`, the token released, the executor never called (it never becomes `submitting`). This holds however the intent got into the queue, including one an earlier process without the flag created. The flag wins over the age: an old real intent is `demo_only`, not `expired`. A `submitting` intent left by an earlier process goes the stale path as before (`unknown` → reconciliation, which only reads) |
| the session orchestrator (worker) | the attempt's intent creation refuses `demo_only` and the session stops as `account_unavailable`, logged `trading session stopped` with `code: demo_only`; no intent, no reserve |
| the CLI `session-start` (worker) | reads the flag and passes it to `createTradingSession`; it creates demo sessions only, so the refusal is unreachable today |

So the stand has two lines, as the switch does: creation in the backend and the take in the worker.
They are not equal: the worker's line holds alone (a flagged worker rejects every queued real
intent, whoever created it, and stops a real session at its first attempt), while the backend's
alone only refuses new real intents and sessions created through it: a real intent already queued,
or a real session row, still reaches an unflagged worker's executor. So the flag goes on both
processes, which the compose anchor does from one `.env` value, and the check below reads both.
The bot does not know the flag: it shows
the refusal as «⚠️ Реальные сделки на этом сервере отключены — доступен только демо-режим.» and the
rejection as «⚠️ Сделка отклонена: реальные сделки на этом сервере отключены. Токен возвращён.»;
the cashier (#11) must refuse `POST /deposit/widget-session` with 409 `demo_only` before it
exchanges a token (a requirement on #11, not code yet).

Not covered by a second check: the executor itself. Its only caller is `submitWithDeadline`
(`processor.ts`), which runs after a successful take; the breaker's decorator (#96,
`observe-executor.ts`) only wraps it. So the fence is before `submitting`, like the switch's:

```bash
grep -rn 'executor.submit' apps/trading-worker/src --include='*.ts' | grep -v '\.test\.ts'
```

Both processes log the flag at start, in both states:

```
{"level":30,…,"demoOnly":true,"msg":"backend started"}
{"level":30,…,"concurrency":5,"sessions":false,"demoOnly":true,"msg":"trading-worker started"}
```

The lines are a report, not the gate: the flag is in the processor's and the orchestrator's
configuration from the moment `createWorker` builds them, and the backend's routes from the moment
`buildApp` registers them. To check a stand before working on it:

```bash
for s in backend trading-worker; do
  docker compose logs --no-log-prefix "$s" | grep -F "\"msg\":\"$s started\"" | tail -1 |
    grep -q '"demoOnly":true' && echo "$s: demo-only" || echo "$s: NOT demo-only"
done
```

On a protected stand it prints exactly `backend: demo-only` and `trading-worker: demo-only`;
anything else (a missing start line prints `NOT demo-only` too) means the stand is not protected:
recreate the containers and run it again. It reads each service's latest start line, not a count:
a container's log survives `docker compose restart` and `restart: unless-stopped`, so a count over
both services can come from one of them, while recreation (`up -d`) starts a fresh log.

## Tests

- `packages/db/src/trading-switch-ops.db.test.ts`: the seed (T1), the writers and their audit
  rows (T2–T5; T2b the breaker's `via`), the missing row (T6), a reopen after a breaker stop (T9).
- `apps/trading-worker/src/circuit-breaker/*.test.ts`: the window (W1–W6), the breaker (B1–B6),
  the submit decorator (D1–D5), the constants and the env overrides.
- `packages/db/src/schema.db.test.ts` → `trading_switch (#144)`: every CHECK at NULL and the
  boundaries; the open-source CHECK on every source × state (#96).
- `packages/db/src/trading-switch-migration.db.test.ts`: the 0019 rewrite (S6).
- `packages/db/src/trading-switch-writers.test.ts`: the writers of an open switch (T8).
- `packages/db/src/trade-intent-ops.db.test.ts` P1–P4, `apps/backend/src/trading/routes.db.test.ts`,
  `access.db.test.ts`, `apps/trading-worker/src/intents/processor.db.test.ts` W1–W5,
  `packages/db/src/trading-session-ops.db.test.ts` C7 and S3, `apps/backend/src/cli/kill-switch*.test.ts`.
- `DEMO_ONLY` (#396): `packages/shared/src/env.test.ts` and both apps' `env.test.ts` (the
  spellings), `trade-intent-ops.db.test.ts` F1–F4, `trading-session-ops.db.test.ts` F1–F2,
  `apps/backend/src/trading/routes.db.test.ts` → DEMO_ONLY, `processor.db.test.ts` F1–F6,
  `orchestrator.db.test.ts` F1–F2, `cli/session-start.db.test.ts`, `worker.handoff.db.test.ts`
  H5–H6 (the started line) and H7–H8 (the flag through `createWorker`: a queued real intent
  rejected, a real session stopped), `intents/config.test.ts` (the compose entry).
