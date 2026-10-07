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

`trading_switch` (`packages/db/src/schema/trading-switch.ts`, migrations 0019 and 0020):

| Column | Rule |
|---|---|
| `id boolean primary key default true` | `trading_switch_singleton_check check (id)`: one row at most |
| `trading_enabled boolean not null` | the state; open is `true` |
| `source text not null` | `trading_switch_source_check`: `migration` (the seed) or `operator` (the CLI) |
| `reason text` | `trading_switch_stop_reason_check`: a closed row always has one; `trading_switch_reason_length_check`: 1–200 characters |
| `changed_at timestamptz not null` | the database's `now()` of the last change |

- **A missing row reads as closed** (fail-closed): a `DELETE` by hand stops trading, never opens
  it. Every SQL reader embeds the one predicate `tradingOpenSql`; the others call
  `readTradingSwitch` (`packages/db/src/trading-switch-ops.ts`).
- **A new database starts open.** Migration 0020 inserts `(true, 'migration', NULL)` (owner's
  decision 2026-10-07).
- **Only an operator opens trading.** `openTrading` is the only writer of `trading_enabled =
  true` and always writes `source = operator`; `stopTrading` writes only `false`. This is
  `stated`, held by a test that lists the writers (`trading-switch-writers.test.ts`), not by a
  CHECK — see For #96 below.
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
  when a row changed, an `audit_log` row: `trading_stopped` with `{ via: 'cli', source, reason }`
  or `trading_resumed` with `{ via: 'cli', reason }`, `actor_type = system`,
  `entity_type = trading_switch`. A repeated command changes nothing and writes no audit row.
- `on` and `off` recreate a missing row (closed or open respectively).
- The failure line names the error and its cause by name and code only (Rule 8). It never says
  nothing changed: a commit whose acknowledgement was lost leaves the state unknown, so the
  operator learns it from `status`, never from a retry's answer.
- No restart is needed: backend and worker read the row on every request and every job.

## Deploy

The migrations open trading, so the pilot behaves as follows from the moment they land:

- before: demo traded, real was refused by `REAL_TRADING_ENABLED=false`;
- after: demo trades as before, **and real is no longer refused by any switch**. What still
  stands between a real intent and the broker is the per-request checks of creation (the user
  `active`, an available token, the user's own `active`, not halted account, one live intent),
  the token route, the broker's own checks, and that no caller of ours creates a real intent
  (the bot sends only `demo`). A real intent today comes only from a direct internal-API call.

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

## For #96

The automatic circuit breaker appends `circuit_breaker` to `TradingSwitchSource` in its own
migration and calls `stopTrading` with it. The same migration adds
`trading_switch_open_source_check check (not trading_enabled or source in ('migration',
'operator'))`, so the database itself keeps that source from opening trading. Until a source
exists that must not open, such a CHECK would admit every valid value and could not be observed
failing, so #144 does not add it.

## Tests

- `packages/db/src/trading-switch-ops.db.test.ts`: the seed (T1), the writers and their audit
  rows (T2–T5), the missing row (T6).
- `packages/db/src/schema.db.test.ts` → `trading_switch (#144)`: every CHECK at NULL and the
  boundaries.
- `packages/db/src/trading-switch-migration.db.test.ts`: the 0019 rewrite (S6).
- `packages/db/src/trading-switch-writers.test.ts`: the writers of an open switch (T8).
- `packages/db/src/trade-intent-ops.db.test.ts` P1–P4, `apps/backend/src/trading/routes.db.test.ts`,
  `access.db.test.ts`, `apps/trading-worker/src/intents/processor.db.test.ts` W1–W5,
  `packages/db/src/trading-session-ops.db.test.ts` C7 and S3, `apps/backend/src/cli/kill-switch*.test.ts`.
