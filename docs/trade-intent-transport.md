# Trade intent transport (ARCH-03, issue #42)

How an order travels from the Telegram bot to the trading worker. Nothing calls the worker
directly: the backend records the intent in PostgreSQL, an outbox row carries it to BullMQ, and
the worker takes it from there. PostgreSQL is the source of truth throughout; Redis/BullMQ is a
delivery channel that can be rebuilt from the database.

## Components

| Component  | Package                               | Role                                                                                 |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| Contract   | `packages/shared/src/trading.ts`      | request/response schemas, statuses, allowlisted failure reasons, queue payload       |
| Operations | `packages/db/src/trade-intent-ops.ts` | every status transition, the creation transaction, the token reserve/release         |
| API        | `apps/backend/src/trading/routes.ts`  | `POST /trading/intents`, `GET /trading/intents/:id` behind the internal Bearer token |
| Publisher  | `apps/backend/src/outbox/`            | turns pending `outbox_events` rows into BullMQ jobs, re-publishes lost ones          |
| Consumer   | `apps/trading-worker/src/intents/`    | processes `trading-intents` jobs through the `TradeExecutor` port                    |

## Sequence

```
bot ──POST /trading/intents──▶ backend ──tx──▶ trade_intents (queued) + outbox_events (pending)
                                   │  201 { intent }                     │
                                   ◀─────────────────────────────────────┘
                              publisher: pending row ──add(jobId = intent id)──▶ BullMQ trading-intents
                              worker: re-read ──CAS queued→submitting──▶ executor.submit ──▶ CAS submitting→accepted|rejected|unknown
bot ──GET /trading/intents/:id──▶ backend ──▶ { intent }   (status, lastError, version)
```

### Creation transaction (`createTradeIntent`)

1. Resolve the user by `telegramUserId` (404 `user_not_found`).
2. **Idempotent replay first**: a row with the same `(user, clientRequestId)` is returned as-is
   (200) whatever the user's or account's flags are now; the same id with different parameters
   is 409 `client_request_id_conflict`. `clientRequestId` is unique per user by contract.
3. Resolve the broker account: the given `brokerAccountId` must belong to the user (404), or the
   user's single active account (0 → 404, more than one → 409 `ambiguous_broker_account`).
4. Reserve one token with a guarded update on `users` (`status = active`,
   `token_balance - token_reserved >= 1`); zero rows → 409 `user_blocked` or `insufficient_tokens`.
5. Lock the account with `FOR NO KEY UPDATE` and the predicates `status = active`,
   `trading_halted = false`; zero rows → 409 `account_revoked` / `account_halted`.
6. Insert the intent (`planned`, `tokens_reserved = 1`), the ledger `reserve` row, move it to
   `reserved`, insert the outbox row, move it to `queued`, commit.
7. After the commit the publisher is woken; a failed wake only logs (the poll picks the row up).

A unique violation on `trade_intents_account_request_idx` or `trade_intents_active_account_idx`
(two identical or two competing requests) rolls back and re-runs step 2: found → replay, not found
→ 409 `active_intent_exists`. That 409 is a snapshot — the competing intent may already be
terminal when the bot reads it; retrying with the same `clientRequestId` is the intended reaction.

**Lock order is `users` → `broker_accounts`.** Any other writer that touches both tables in one
transaction (OAuth linking, revocation, reconciliation) must lock in that order.

## Statuses and who sets them

| Status                                    | Set by                                                                           | Meaning                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `planned` → `reserved` → `queued`         | backend, creation transaction                                                    | intent and outbox row persisted, token reserved. `queued` is what the API returns                                 |
| `submitting`                              | worker, `takeIntent` CAS                                                         | the job was taken; `submitted_at` is set on the database clock                                                    |
| `accepted`                                | worker, explicit executor result only                                            | the broker confirmed the order. `socket.emit` or a local `ok` never counts                                        |
| `rejected`                                | worker (executor said no, or the intent expired), publisher (delivery exhausted) | terminal; the token reserve is released in the same transaction                                                   |
| `unknown`                                 | worker (executor timeout, throw, or a stale `submitting`), sweeper               | the order may have reached the broker; reserve kept; a `trading-reconciliation` outbox row is written for ARCH-04 |
| `settled`, `reconciling`, `manual_review` | ARCH-04 / #17                                                                    | out of scope here                                                                                                 |

Every transition bumps `version`; every transition is a compare-and-set on `status` (and usually
`version`), so a duplicate or late writer gets zero rows instead of overwriting newer state.

## Delivery, ACK and timeout semantics

| Stage                                                                  | Retry policy                                                        | Timeout                                                                                                                    | On failure                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher `queue.add`                                                  | outbox `attempts` with backoff 1 s, 2 s, 4 s, 8 s (cap 16 s), max 5 | 5 s per add (`Promise.race`; a late success is harmless, the job id dedupes)                                               | 5th failure: outbox `failed` **and**, in the same transaction, a still-`queued` intent → `rejected` (`publish_failed`) with token release |
| Lost job (published row, intent still `queued` after 30 s, job absent) | counted as a failed delivery, same cap                              | sweep every 15 s                                                                                                           | row back to `pending`, republished                                                                                                        |
| BullMQ job                                                             | `attempts: 1` — the trade command is never retried by the queue     | `lockDuration` 60 s, `stalledInterval` 30 s, `maxStalledCount` 1                                                           | a job that throws is dead-lettered; a stalled job is redelivered once                                                                     |
| `takeIntent`                                                           | —                                                                   | `INTENT_MAX_AGE_MS` (60 s) in the CAS predicate, database clock                                                            | too old → `rejected` (`expired`), executor never called                                                                                   |
| `executor.submit`                                                      | none                                                                | `SUBMIT_ACK_TIMEOUT_MS` (10 s), enforced by the processor with `Promise.race`; the executor also receives an `AbortSignal` | timeout → `unknown` (`executor_timeout`); throw → `unknown` (`executor_error`)                                                            |
| Outcome write                                                          | none                                                                | —                                                                                                                          | a database failure here fails the job (dead letter); the intent stays `submitting` until the sweeper                                      |
| Stale `submitting` (redelivery or sweeper, every 15 s)                 | —                                                                   | `STALE_SUBMITTING_MS` 60 s ≥ `lockDuration` > max ack timeout                                                              | → `unknown` (`stale_submitting`) + reconciliation row                                                                                     |

Invariants these numbers encode: no live worker can still be inside its ack deadline when a
redelivery or the sweeper calls its intent unknown, and the broker command is never sent twice —
a redelivered job only checks state, it does not resubmit.

The sweeper can win a race against a slow executor: the late `accepted` is then dropped (the CAS
sees `unknown`, not `submitting`) and reconciliation recovers the real result.

## Dead-letter queue

`trading-intents-dead-letter` receives one entry per failed job: `{ intentId | null, reason,
failedAt }` with `reason` from the allowlist (`invalid_job` for a malformed payload or a missing
intent, `processing_failed` otherwise). No exception text is stored — it can carry connection
details — the log line next to it has the error. A failure to write the entry is logged as
`dlq_publish_failed`; the worker keeps running. Nothing consumes the queue automatically; inspect
it with the BullMQ tooling of your choice.

## Persisted reasons and secrets

`trade_intents.last_error`, `outbox_events.last_error` and dead-letter entries only ever hold
`TradeIntentFailureReason` codes. The executor may return a free-text `detail`; it is truncated
to 200 characters and logged, never stored. Queue payloads carry the intent id only. Neither the
publisher nor the worker loads broker tokens. Both loggers redact `authorization` and token-like
keys.

## Configuration

Backend: `INTERNAL_API_TOKEN` (required, ≥ 16 characters, no whitespace; compose supplies a
dev-only fallback that a deployment must override). Publisher constants live in
`apps/backend/src/outbox/publisher.ts` (`DEFAULT_PUBLISHER_CONFIG`).

Worker (optional, code defaults in `apps/trading-worker/src/env.ts`):

| Variable                | Default | Bounds                                                             |
| ----------------------- | ------- | ------------------------------------------------------------------ |
| `INTENT_MAX_AGE_MS`     | 60000   | 1000–600000                                                        |
| `SUBMIT_ACK_TIMEOUT_MS` | 10000   | 500–30000 (`MAX_SUBMIT_ACK_TIMEOUT_MS`, below the stale threshold) |
| `WORKER_CONCURRENCY`    | 5       | 1–100                                                              |

Fixed constants and why they relate the way they do: `apps/trading-worker/src/intents/config.ts`.

## Boundaries

- **ARCH-01 (#40)** implements `TradeExecutor` (`apps/trading-worker/src/intents/executor.ts`)
  with the broker socket client. Until then `notConfiguredExecutor` rejects every intent with
  `executor_not_configured`, so the whole path can be exercised without a broker.
- **ARCH-04 (#43)** consumes `trading-reconciliation` jobs and owns `unknown → reconciling → …`,
  settlement and the release of reserves held by `unknown` intents. The publisher already
  publishes that topic; jobs wait in the queue until the consumer exists.
- **#17** owns the remaining state-machine rules; **#15/#16/#21** the demo/real eligibility rules
  (the creation transaction only checks the user and account flags that exist today).
- **#25 / #29**: the bot tracks and notifies by `intent.id`. `GET /trading/intents/:id` is the
  status source; a notification dedupe key should be derived from the intent id and status.
- `trading_session_id` stays `NULL` until #20 links intents to sessions.

## Running it locally

```bash
docker compose up --build --wait
TOKEN=binarius-dev-internal-token
curl -s -X POST 127.0.0.1:3000/trading/intents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"telegramUserId":"1","mode":"demo","assetId":1,"amount":"10.00","action":"up","durationSec":60,"clientRequestId":"demo-1"}'
# 404 user_not_found until a user and broker account exist (OAuth, #9); with them: 201 queued,
# then GET /trading/intents/<id> shows rejected / executor_not_configured within a second
```
