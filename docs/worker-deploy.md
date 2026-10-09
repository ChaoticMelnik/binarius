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

1. **Preconditions.** It reads the running `trading-worker` containers
   (`docker compose ps -q --status running trading-worker`) and all of them in any state
   (`docker compose ps -q -a trading-worker`).
   - None running: a plain `docker compose up -d trading-worker`, exit 0 (`started without an
     overlap`). Stopped containers it found are named (`stopped containers found: …`); compose
     reconciles them to one running container (it starts, recreates or removes them).
   - Two or more running: refused, exit 2. A previous run did not finish; an operator stops all but
     one (`docker stop -t 40 <id>; docker rm <id>`) and runs it again.
   - One running and any other container of the service in any state (a **leftover**): refused,
     exit 2, each leftover listed with its state and image. A previous run left it: an interrupt
     during step 4 (the daemon finishes the stop, `docker rm` never runs) or a failed `docker rm`.
     It must refuse: the scale-up of step 2 counts every container of the service, so compose would
     start the stopped one on its old image instead of creating a new container, and that
     container's earlier log already carries a ready line. The operator removes it
     (`docker stop -t 40 <id>` if it runs; `docker rm <id>`) and runs it again.
2. **The overlap.** `docker compose up -d --no-deps --no-recreate --scale trading-worker=2
   trading-worker`: the old container keeps its image and config, the new one is created from the
   current image and config. The new id is the one container `ps -q -a` lists after the scale-up
   and did not list before; none or more than one: exit 1, nothing touched.
3. **Readiness.** Once a second, up to `READY_TIMEOUT_S` (120), the script inspects the new
   container (`{{.State.Running}} {{.State.StartedAt}}`) and, while it runs, reads its log since
   that start (`docker logs --since <StartedAt>`) for `"msg":"trading-worker started"`
   (`WORKER_READY_MSG`, `worker.ts`). The line is printed by `createWorker().start()` right after
   both BullMQ consumers were built, so the new process already takes jobs when it appears. The
   grep is `grep -F … >/dev/null`, not `-q`: `-q` exits on the first match and `docker logs` then
   dies of SIGPIPE, which `pipefail` turns into a miss.
   - Which check holds what: the leftover refusal (step 1) and the appeared-id check (step 2) keep a
     stale container from becoming "new"; `--since` keeps readiness to the current lifetime, so a
     container in a restart loop never passes on a line of a lifetime that died (once the command
     exits on a crash, #146; under the current `tsx watch` command a crash does not exit, below).
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

Every exit path prints the state it left. An interrupt (INT/TERM) or a failed command under
`set -e` after step 2 prints the stage and every container of the service with its state and image
(not only the running ones): two running workers are safe (next section), and the next run refuses
while a second container exists in any state.

Knobs: `READY_TIMEOUT_S` (a positive integer; anything else exits 2 before any change), `COMPOSE`
(default `docker compose`, word-split, e.g. `COMPOSE="docker compose -p other"`).

### Exit codes

| Code | State left |
|---|---|
| 0 | the new worker runs alone, or none ran and a plain `up -d` started one |
| 1, rollback | the new worker never became ready: removed, the old one runs untouched |
| 1, new id check | compose created no second container, or more than one (listed, none removed): the old one runs untouched |
| 1, stage `overlap` | the scale-up failed: the old one runs; a created-but-not-started new one may exist |
| 1, stage `rollback` | `docker rm` of the new one failed: the old one runs, the new one is stopped (a failed readiness inspect counts as "not running" and lands here too) |
| 1, stage `stop-old` | `docker stop`, `docker inspect` or `docker rm` of the old one failed: the new one runs ready; the old one is stopped or still stopping, not removed |
| 1, stage `scale-down` | `--scale 1` failed: the new one runs alone (with one container the command is a no-op) |
| 2 | refused, nothing changed: two or more running, a leftover besides the running one in any state, or a bad `READY_TIMEOUT_S` |
| 130 / 143 | interrupted: the stage and every container with its state and image are printed |

A failed command prints the trap's `ended at stage '<stage>'` and the listing; a rollback and a
missing new id print their own lines and no listing. In every row the next run refuses while a
second container exists, and names it.

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

**The overlap's length.** From the new container's start (its consumers take jobs before the ready
line) to the old one's exit: the readiness wait, seconds when the worker starts cleanly and at most
`READY_TIMEOUT_S` (120 s), plus the old container's stop (≤ 40 s: phase 1 ≤ 35 s, phase 2 ≤ 4 s);
on a rollback the new container's stop (≤ 40 s) instead. A run interrupted or failed after the
scale-up leaves both until an operator resolves it (Exit codes); the next run refuses while the
second container exists in any state. Nothing in the code bounds the window.

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
- **An interrupt during step 4.** The daemon finishes the stop, `docker rm` never runs, and
  `restart: unless-stopped` does not restart a hand-stopped container: one runs, one is stopped.
  The next run refuses and names the stopped one (step 1).
- **`BROKER_WS_URL` unset.** No sessions and no leases: the overlap is the consumers, the
  orchestrator, the reconciliation pass and the catch-up only.
- **Several shards** (#94) reuse this script per shard; that is #94's concern.

## Accepted risks

1. **Double broker reads for the overlap.** Both processes run the reconciliation pass and the
   catch-up: up to 2 × `WORKER_BROKER_GETS_PER_MINUTE` (2 × 400) a minute for the overlap (≤ 160 s
   when the script completes, longer after an interrupted run until an operator acts), which with
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

# R1, the happy path
docker compose build trading-worker
scripts/deploy-worker.sh; echo "exit=$?"
# expect: "new container: <id>" (the one that appeared), "new container ready", the old one's
# "shutting down" with exit code 0, "done: trading-worker runs as <id>", exit=0
docker inspect -f '{{.Image}}' <id>
# expect: the image just built (docker image inspect -f '{{.Id}}' <project>-trading-worker)
docker compose up -d trading-worker
docker compose ps trading-worker
# expect: the same container as "runs as", not recreated

# R4, a new container that never gets ready (an env value the worker refuses)
WORKER_CONCURRENCY=0 scripts/deploy-worker.sh; echo "exit=$?"
# expect: "Env WORKER_CONCURRENCY must be between 1 and 100", after 120 s
# "rollback: no ready line within 120s", "the old container … runs untouched", exit=1

# R2, a stopped leftover (the deterministic form of an interrupt during step 4)
docker compose up -d --no-deps --no-recreate --scale trading-worker=2 trading-worker
docker compose ps -q -a trading-worker
# the second id: wait for its ready line, then stop it without rm
until docker logs <second> 2>&1 | grep -F '"msg":"trading-worker started"'; do sleep 1; done
docker stop -t 40 <second>
docker logs <second> 2>&1 | grep -c '"msg":"trading-worker started"'
# expect: 1 (the line a read over every lifetime would accept)
scripts/deploy-worker.sh; echo "exit=$?"
# expect: "refused: trading-worker containers besides the running one <old>:",
# "<second> exited sha256:…", exit=2; docker compose ps -a trading-worker unchanged

# R5, the readiness read covers the current lifetime only (same state)
docker start <second>
until [ "$(docker logs <second> 2>&1 | grep -c '"msg":"trading-worker started"')" -ge 2 ]; do sleep 1; done
docker logs --since "$(docker inspect -f '{{.State.StartedAt}}' <second>)" <second> 2>&1 |
  grep -c '"msg":"trading-worker started"'
# expect: 1
docker stop -t 40 <second>; docker rm <second>

# R6 (the PR's evidence, a temporary edit): with the leftover refusal of step 1 disabled and the
# state of R2, the run ends "compose created no second trading-worker container; the old one runs
# untouched", exit=1, and the leftover runs again on its old image; stop and remove it, restore
# the script

# R3, two workers running
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
   Then the leftover case: `up -d --no-deps --no-recreate --scale w=2 w` again (it creates `w-3`),
   `docker stop -t 5 <w-3>` without `rm`. Expected: `docker compose ps -q -a w` lists both while
   `docker compose ps -q --status running w` lists one; `up -d --no-deps --no-recreate --scale w=2
   w` prints `w-3 Started` and creates nothing (`ps -q -a w` lists the same two ids). Compose
   5.5.1 does this locally. The script's refusal rests on `ps -a` listing the stopped one; if it
   does not, the script is not used until this document says how. Then
   `docker stop -t 5 <w-3>; docker rm <w-3>` and a plain `up -d`.
2. **The first real run:** `docker stats --no-stream` while both containers run, and
   `docker inspect -f '{{.State.OOMKilled}}' <id>` for both afterwards.
3. **`binarius-deploy`** (server-only, not in the repo): after the build and the migrations, call
   `scripts/deploy-worker.sh`, then the existing `docker compose up -d --wait`; the worker is
   already current and is not recreated.
