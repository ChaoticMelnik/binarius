# Runbook: broker outage, mass reconnect, emergency stop (#96)

What to do when the broker stops answering, when the worker's sessions drop together, or when
trading must be stopped by hand. Every command below was run against a freshly migrated database
on 2026-10-09; the outputs are quoted as they printed. On the server prefix each CLI command with
`docker compose exec backend` as shown; the CLI is the same one `docs/kill-switch.md` describes.

## The automatic stop (circuit breaker)

The worker closes the global trading switch on its own when, within the last 120 s
(`CIRCUIT_BREAKER_WINDOW_MS`), at least 10 (`CIRCUIT_BREAKER_MIN_FAILURES`) and at least 50 %
(`CIRCUIT_BREAKER_FAILURE_PERCENT`) of either signal failed:

| Signal | A failure | An answer |
|---|---|---|
| REST / submit | a submit the broker left without an answer: `unknown` with `broker_unavailable` (`trade command outcome unknown`) | an `accepted` or a `rejected` submit |
| sockets (only with `BROKER_WS_URL` set) | a session that was ready and is still not ready 45 s later (`SOCKET_LOSS_GRACE_MS`, longer than one full reconnect, 30 s), or one closed by the server after it was ready | the denominator is the sessions running |

Counted once per intent (REST) or account (sockets) in the window. Not counted: a token refusal or
a broker 429 (an answer), `token_expired`/`auth_failed` (credentials), our own drops (idle, the
lease fence of #93, a refusal, a stop). The thresholds can be raised or lowered through the
worker's env (`.env.example`); a window not longer than the 45 s grace stops the worker at start.

It closes **demo and real together**, writes the audit row `trading_stopped` with
`via: circuit_breaker`, and never opens anything: only an operator reopens
(`trading_switch_open_source_check` refuses an open row with this source).

## Signs

- The worker log: `error` `circuit breaker tripped` `{ signal: rest | socket, failures, total,
  windowMs, changed }`. `changed: false` means the switch was already closed (an operator's stop
  stands, with its reason).
- `docker compose exec backend pnpm --filter @binarius/backend kill-switch status`:

  ```
  Торговля остановлена (с 2026-10-09T07:24:23.408Z, источник circuit_breaker): Автостоп: брокер не отвечает (REST: 12 из 20 отправок без ответа за 120 с)
  ```

  The socket signal's reason reads «Автостоп: потеряна связь с брокером (сокеты: N из M сессий за
  120 с)».
- The audit row: `select action, payload from audit_log where entity_type = 'trading_switch'
  order by created_at desc limit 3` →
  `trading_stopped | {"via": "circuit_breaker", "reason": "…", "source": "circuit_breaker"}`.
- `error` `circuit breaker trip failed` means the stop itself did not commit (the database): the
  breaker tries again on the next failure; check `status` and stop by hand if needed.

There is no alert channel (ops alerts were cancelled, 2026-10-08): watch the worker's log for
`circuit breaker tripped`, or point external log monitoring at it.

## First checks

1. Is the broker answering? Its status page and a submit in the bot. The REST failures are
   `trade command outcome unknown` lines (`transport: rest_fallback`, `code: unavailable` or
   `contract_violation`).
2. The sockets: `broker session closed` with `reason: disconnected_by_server`, `broker socket
   connect error`, and whether a `connect_error` carries a 429 (the per-IP limit,
   [broker-session.md](broker-session.md) → Accepted risks 10).
3. Our side: `broker session lease fenced` / `lease lost` lines mean our database stalled, not the
   broker — these are not counted by the breaker, but they also move trading to REST.

## While trading is stopped

Nothing that is already running stops: open trades settle, the broker sessions stay, the
reconciliation pass and the settlement catch-up go on, the balance tick runs. New intents are
refused with `trading_paused` (the bot shows «⏸ Торговля временно приостановлена, попробуйте
позже.»), queued ones are rejected and their token released, demo sessions stop as `kill_switch`
([kill-switch.md](kill-switch.md)).

Intents left `unknown` by the outage go to reconciliation as usual; an ambiguous one parks in
`manual_review` with the account halted ([trade-intent-transport.md](trade-intent-transport.md)).

## Reopening

Only when the broker answers again and the failure lines have stopped for a few minutes. A reopen
during the storm trips again on the next qualifying window.

```bash
docker compose exec backend pnpm --filter @binarius/backend kill-switch off --reason "брокер в норме"
```

prints «Торговля открыта — demo и real.»; `status` then prints «Торговля открыта (с …, источник
operator)». Do not reopen while `manual_review` intents of the outage are unresolved if the broker
may still be opening trades late.

## Emergency stop by hand

At any time, for any reason (an outage below the thresholds — fewer than 10 submits in 2 min —
or a broker announcement):

```bash
docker compose exec backend pnpm --filter @binarius/backend kill-switch on --reason "инцидент брокера"
```

prints «Торговля остановлена. Новые заявки отклоняются; уже открытые сделки, сверка и расчёт
продолжаются.» A later automatic trip leaves the operator's reason in place (`changed: false`).

## Mass reconnect

When every session drops at once (a broker restart, a network blip):

- the sockets reconnect by themselves with backoff (up to 10 s between attempts, ±50 %); a
  restart that reconnects everyone within one cycle is not counted by the breaker;
- sessions closed by the server are held back `SESSION_RETRY_MS` (60 s) and restarted by the next
  ticks; their trades go over REST meanwhile;
- the broker allows 600 requests a minute per IP: restarting the worker by hand makes every
  session reconnect at once and can draw 429s. Prefer waiting it out; restart only if the worker
  itself is stuck (its log has stopped: `reconciliation tick` and `settlement catch-up tick` come
  every 15 s and 5 s when there is work), and then expect a slower ramp.

## Escalation

The broker's support with the time range and the counts from the `circuit breaker tripped` line;
the owner for a reopen decision while `manual_review` intents of the outage are open.
