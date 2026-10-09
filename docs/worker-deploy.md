# Worker deploy with an overlap (ARCH-02, #95)

How a new trading-worker image replaces the running container without a gap in which no process
takes intent jobs, and why two workers running together for a short window are safe.

```bash
# from the checkout, after the image is built and the migrations ran
docker compose build trading-worker
scripts/deploy-worker.sh
```

## The sequence

`scripts/deploy-worker.sh` (bash, `set -euo pipefail`) runs from the checkout's root, whatever the
current directory:

1. **Preconditions.** It counts the running `trading-worker` containers
   (`docker compose ps -q --status running trading-worker`).
   - None: a plain `docker compose up -d trading-worker`, exit 0 (`started without an overlap`).
   - Two or more: refused, exit 2. A previous run did not finish; an operator stops all but one
     (`docker stop -t 40 <id>; docker rm <id>`) and runs it again.
2. **The overlap.** `docker compose up -d --no-deps --no-recreate --scale trading-worker=2
   trading-worker`: the old container keeps its image and config, the new one is created from the
   current image and config. The new id is the service's container that is not the old one.
3. **Readiness.** Once a second, up to `READY_TIMEOUT_S` (120), the script reads the new
   container's log for `"msg":"trading-worker started"` (`WORKER_READY_MSG`, `worker.ts`). The line
   is printed by `createWorker().start()` right after both BullMQ consumers were built, so the new
   process already takes jobs when it appears.
   - Not seen in time, or the new container is no longer running → **rollback**: its last 20 log
     lines, `docker stop -t 40` and `docker rm` of the **new** container, exit 1. The old one
     never got a signal.
   - Under the compose command (`pnpm … dev`, `tsx watch`) a worker that throws at start does not
     exit: `tsx` keeps watching, the container stays `running`, and the rollback comes from the
     timeout (seen locally, below). `restart: unless-stopped` would also restart an exited one.
4. **The old container stops.** `docker stop -t 40 <old>` (40 = `stop_grace_period`): SIGTERM and
   the worker's own two-phase shutdown. Phase 1 drains the consumers (the jobs in flight finish,
   the new process takes everything else), then stops the broker sessions and releases their
   leases (#93); phase 2 closes the connections.
5. **Cleanup.** The old container's shutdown lines and exit code are read, the container is
   removed, and `--scale trading-worker=1 --no-recreate` leaves exactly the new one. A later plain
   `docker compose up -d` does not recreate it: its image and config are the current ones (seen
   locally, below).
6. **Report.** The old container's `shutting down` line, any `shutdown: …` error line, its exit
   code and the new id. When the old drain overran (`active jobs did not finish`, exit 1) it adds a
   warning: those submits are resolved by the new process (below).

Every exit path prints the state it left. An interrupt (INT/TERM) after step 2 prints the stage and
the running containers: two running workers are safe (next section), and the next run refuses until
one is stopped.

Knobs: `READY_TIMEOUT_S` (a positive integer; anything else exits 2 before any change), `COMPOSE`
(default `docker compose`, word-split, e.g. `COMPOSE="docker compose -p other"`).

### Exit codes

| Code | State left |
|---|---|
| 0 | the new worker runs alone, or none ran and a plain `up -d` started one |
| 1 | the new worker never became ready: removed, the old one runs untouched |
| 2 | refused (two or more running, or a bad `READY_TIMEOUT_S`): nothing changed |
| 130 / 143 | interrupted: the stage and the running containers are printed |

## Why two workers at once are safe

For the overlap the two processes share Postgres, Redis and the broker. Each component, with the
guard that holds it and where that guard is tested:

| Component | Two processes during the overlap | Guard |
|---|---|---|
| Intent jobs | each job goes to one consumer; a second take of the same intent is impossible | BullMQ's job lock; the `queued → submitting` CAS of `takeIntent` (Rule 6, `processor.db.test.ts`) |
| A job redelivered across processes | never sends: an intent still `submitting` and younger than `STALE_SUBMITTING_MS` is left alone, an older one goes `unknown` | `handleSubmitting` → `markIntentUnknown` with the age predicate |
| Broker sockets (`BROKER_WS_URL` set) | the new process opens a socket only for an account whose lease is free; the old one releases its leases after closing its sockets | the lease (#93, Rule 32): `acquireSessionLease`; `stop()` deletes our rows after every client stopped |
| Orchestrator (demo sessions) | both may attempt the same session; the second is a replay or a conflict, never a second trade | the step key `session:<id>:<step>` (unique `(user_id, client_request_id)`) and one live intent per account (`trade_intents_active_account_idx`) |
| Reconciliation pass | each intent is attempted by one process at a time | the claim lease of `claimReconciling` (Rule 24) |
| Settlement catch-up | both may read the same account's trades; the settle writes are idempotent | none for the reads: their cost is accepted risk 1 |
| Stale-submitting sweeper | both may sweep; one move per intent | `markIntentUnknown`'s CAS with the age predicate |
| Token refresh | the worker never exchanges a token itself; two processes asking for the same account exchange at most once | the backend's `ensureFreshAccessToken` under one row lock (`token-service.db.test.ts` «exchanges once when two callers race on the same account», Rule 12) |
| Circuit breaker (#96) | **per-process windows**: each process counts only its own submits and its own sessions | none across processes (below) |

**The circuit breaker during the overlap.** Each process has its own window
(`CIRCUIT_BREAKER_WINDOW_MS`, 120 s) in memory. During the overlap each sees only its share of the
submits, and the new process starts with an empty window, so a broker outage that spans the deploy
is counted from scratch by the new process and a trip may come later than with one process (up to
one window). The old process stops its breaker in phase 1: it starts no trip after SIGTERM. The
handoff itself counts no loss: the old process's `stop()` is its own drop (not a loss), and the new
process reports a session only once it was ready and left it. The runbook's thresholds
(docs/runbook-broker-outage.md) are per process.

**Sockets during the handoff.** The new process's candidate scan skips an account whose lease
another owner holds and has not lapsed (`listSessionCandidates` with `ownerId`), so until the old
process releases its leases the new one sends those accounts' orders over REST (Rule 15: nothing
was emitted on its side). After the release the account is a candidate on the next session tick
(`SESSION_TICK_MS`, 5 s) and its socket opens after one lease acquire and one token fetch. A
`dirty` old process (drain overrun) releases nothing: its leases lapse after `SESSION_LEASE_TTL_MS`
and the new process takes them as after a crash (docs/broker-session.md → The lease, ~95 s).

**The overlap's length.** From the new container's ready line to the old one's exit: at most one
readiness poll (1 s) plus the old container's stop (≤ 40 s: phase 1 ≤ 35 s, phase 2 ≤ 4 s). Nothing
in the code bounds it beyond `docker stop -t 40`.

## A drain that overruns

A job still running when the old process's phase 1 budget (35 s) ends makes its shutdown `dirty`:
it logs `shutdown: active jobs did not finish within the budget, exiting without cleanup` and exits
1 without phase 2. The intent stays `submitting`. The new process resolves it: after
`STALE_SUBMITTING_MS` (60 s) its sweeper marks it `unknown`, the reconciliation job moves it to
`reconciling` and the pass finds the one trade at the broker or reports none — never a second send
(Rule 15, #131). The script prints the warning and still exits 0: the new worker runs.

## Other edges

- **Migrations before the overlap.** The old worker runs on the new schema for up to the overlap.
  That already happens today between `migrate` and `up`; migrations stay forward-only and additive
  (`.claude/CLAUDE.md` → База данных).
- **The backend is deployed separately.** The worker may run against the previous backend (or the
  reverse) across one deploy, so the internal routes (`/trading/accounts/:id/access-token`, the
  signal and pairs routes) stay compatible across one deploy; a breaking change to one of them is a
  two-step deploy.
- **`BROKER_WS_URL` unset.** No sessions and no leases: the overlap is the consumers, the
  orchestrator, the reconciliation pass and the catch-up only.
- **Several shards** (#94) reuse this script per shard; that is #94's concern.

## Accepted risks

1. **Double broker reads for the overlap.** Both processes run the reconciliation pass and the
   catch-up: up to 2 × `WORKER_BROKER_GETS_PER_MINUTE` (2 × 400) a minute for ≤ ~41 s, which with
   the backend's shares (2 × 100) is over the broker's 600 a minute per IP in the worst case.
   Falsifiable: `rate_limited` in the reconciliation or catch-up ticks during a deploy.
2. **Memory on the pilot** during the overlap: two worker processes on one host. Falsifiable:
   `docker inspect -f '{{.State.OOMKilled}}' <id>` true for either container (owner step 2).
3. **Readiness is a log line**, not a health endpoint: it proves the consumers were built, not that
   Postgres or the broker answer. A worker that starts and then cannot reach the database still
   lets the old one stop. Until #65/#67 the deploy's own checks after `up --wait` are the backstop.
4. **The script is not run in CI**: it needs a Docker daemon. Its evidence is the local run below
   and the owner's pilot steps.
5. **The overlap is not bounded by code** (above).

## Tests

`apps/trading-worker/src/worker.handoff.db.test.ts`: two `createWorker` compositions (the
production wiring) over one Postgres, one Redis prefix and one mock broker, with the timers
shortened (`WorkerTestSeams`) and the backend's routes stubbed:

- **H1** (with and without `BROKER_WS_URL`): A holds two submits at the broker, B starts, A gets
  SIGTERM, two more intents follow. Every intent ends `accepted` with no error, A recorded exactly
  its two and B the rest, one broker trade per intent, A's shutdown `clean`.
- **H2** (with sockets): at every poll during H1 at most one socket per broker user; after A's
  shutdown B holds one for every account in work.
- **H3**: A's phase 1 overruns while a REST submit is held (`dirty`), A's pool ends as the exit
  would; B's sweeper marks the intent `unknown`, reconciliation links the one trade.
- **H4**: a demo session of three trades runs across the handoff: three steps
  `session:<id>:1..3`, three trades at the broker, the session `completed`.
- **H5**: `start()` logs the ready line once, and the script greps that exact text.
- **W1**: a drain past the budget returns `dirty` and phase 2 does not run (Redis and the pool stay
  open). **W2**: a clean drain returns `clean` and closes them.

`index.ts` keeps the env, the pool and Redis, the signal handlers and `process.exit(clean ? 0 : 1)`;
everything else is `worker.ts`.

## Running it locally

A throwaway compose project beside the dev stack: its own volumes and ports, no bot, no backend,
and the broker's REST pointed at a closed port, so nothing reaches the broker. `BROKER_WS_URL` stays
unset. The outputs of the run on 2026-10-09 are quoted in the PR of #95.

```bash
export COMPOSE_PROJECT_NAME=binarius-deploy-probe POSTGRES_PORT=5436 REDIS_PORT=6380 \
  BROKER_API_BASE_URL=https://127.0.0.1:9
unset BROKER_WS_URL
docker compose run --rm trading-worker pnpm db:migrate
docker compose up -d trading-worker
until docker compose logs trading-worker | grep '"msg":"trading-worker started"'; do sleep 1; done
# expect: one line with "sessions":false

# the happy path
docker compose build trading-worker
scripts/deploy-worker.sh; echo "exit=$?"
# expect: "new container ready", the old one's "shutting down" with exit code 0, exit=0
docker compose up -d trading-worker
docker compose ps trading-worker
# expect: the same container as "runs as", not recreated

# a new container that never gets ready (an env value the worker refuses)
WORKER_CONCURRENCY=0 scripts/deploy-worker.sh; echo "exit=$?"
# expect: "Env WORKER_CONCURRENCY must be between 1 and 100", after 120 s
# "rollback: no ready line within 120s", "the old container … runs untouched", exit=1

# two workers running
docker compose up -d --no-deps --no-recreate --scale trading-worker=2 trading-worker
scripts/deploy-worker.sh; echo "exit=$?"
# expect: "refused: 2 running trading-worker containers (…)", exit=2
docker compose ps -q trading-worker
docker stop -t 40 <the newer id>; docker rm <the newer id>

docker compose down -v
```

## Owner steps on the pilot

The implementer does not touch the pilot; these are the owner's.

1. **Compose on the pilot behaves like the local run.** `docker compose version`, then in
   `/tmp/probe95` a throwaway project with a tiny image (`alpine`, a `sleep` loop that traps TERM):
   build v1, `up -d`, build v2, `up -d --no-deps --no-recreate --scale w=2 w`, `docker stop -t 5
   <w-1>`, `docker rm <w-1>`, `up -d --no-deps --no-recreate --scale w=1 w`, a plain `up -d`.
   Expected: `w-1` stays on v1 while `w-2` is created on v2; the TERM trap runs; `w-2` stays
   `Running` after the scale-down and after the plain `up -d`. If any differs, the script is not used
   on the pilot until this document says how.
2. **The first real run:** `docker stats --no-stream` while both containers run, and
   `docker inspect -f '{{.State.OOMKilled}}' <id>` for both afterwards.
3. **`binarius-deploy`** (server-only, not in the repo): after the build and the migrations, call
   `scripts/deploy-worker.sh`, then the existing `docker compose up -d --wait`; the worker is
   already current and is not recreated.
