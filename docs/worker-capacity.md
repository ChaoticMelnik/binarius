# Worker fleet: the registry, socket ownership and capacity (ARCH-02, #94)

```bash
# the unit and integration tests of this part
pnpm exec vitest run apps/trading-worker/src/fleet apps/trading-worker/src/broker \
  packages/db/src/worker-process-ops.db.test.ts packages/db/src/session-lease-ops.db.test.ts
```

`trading-worker` can run as several processes. Each one registers in Postgres, learns the live set
from its own heartbeat, and holds the broker sockets only of the accounts that rendezvous hashing
over that set names it for. The lease of #93 ([broker-session.md](broker-session.md) → The lease)
stays the guarantee that no account has two sockets; the registry decides which process tries.

What this part does not partition: the trading session orchestrator, the settlement catch-up and
the reconciliation pass run in every process (each safe under several: the step key, idempotent
settles, the claim lease — [worker-deploy.md](worker-deploy.md) → Why two workers at once are safe)
and are partitioned in #815; intent jobs are routed to the account's owner since #347
([trade-intent-transport.md](trade-intent-transport.md) → Routing to the owner). **Until #815, `TRADING_WORKER_REPLICAS` stays 1**: with more, every
process runs the loops, and the broker GET budget is per process
([trade-intent-transport.md](trade-intent-transport.md) → Budget).

## The registry

`worker_processes` (migration 0084): `owner_id uuid` primary key, `started_at`, `heartbeat_at`,
`expires_at`, CHECK `worker_processes_expiry_check (expires_at > heartbeat_at)`. No FK, outside
the lock chain (Rule 5); every time is the database clock. `owner_id` is the process id: one
`randomUUID()` per start in `worker.ts`, the same id as the owner of its leases, logged as
`ownerId` in `trading-worker started` (with the sockets on or off).

| Operation (`packages/db/src/worker-process-ops.ts`) | Statement | Answer |
|---|---|---|
| `heartbeatWorkerProcess` | one statement: a CTE deletes rows lapsed longer than `pruneAfterMs` (never ours), a CTE upserts our row (`heartbeat_at = now()`, `expires_at = now() + ttl`), the outer select returns `expires_at > now()` **union** our id | the live ids, ours included; the outer select reads the statement's snapshot and does not see the CTE's write, hence the union (`worker-process-ops.db.test.ts` G1, G6) |
| `deregisterWorkerProcess` | `delete where owner_id = $me` | at a graceful stop, after the leases went back |

`fleet/registry.ts` (`createFleetRegistry`):

- `start()` sends one heartbeat at once, then one every `WORKER_HEARTBEAT_MS`; a heartbeat is
  single-flight and bounded by `WORKER_HEARTBEAT_TIMEOUT_MS`, a late answer is ignored.
- On an answer to a heartbeat sent at monotonic `t0`: the live set is the answer sorted by the
  registry (the statement's order is not relied on), trusted until `t0 + WORKER_LIVE_FENCE_MS`.
  A changed set logs `worker fleet changed`.
- `owns(accountId)`: a non-empty view, before its fence, and `ownerOf(accountId, live)` is us.
  Before the first answer nothing is owned; past the fence nothing is owned — a process that
  cannot heartbeat stops claiming accounts before the others see its row lapse.
- A heartbeat that throws (`error`) or times out (`warn`) keeps the view until its fence: one
  failure does not fence (the chain below).
- `stop()` owns nothing from that moment, then deletes our row (bounded by the heartbeat timeout;
  a failure leaves the row to lapse after `WORKER_PROCESS_TTL_MS`).

A lapsed row stays `WORKER_PROCESS_PRUNE_MS` (1 h) for an operator and is deleted by another
process's heartbeat; the table holds at most the restarts of the last hour.

## Ownership

`fleet/rendezvous.ts`, `ownerOf(accountId, live)`: for every live owner the sha256 of
`` `${owner}:${accountId}` `` (UTF-8, all 32 bytes); the greatest under `Buffer.compare` wins,
equal digests go to the lower owner id. Every process with the same live set gets the same answer;
a joining process takes only the accounts it wins, a leaving one gives away only its own
(`rendezvous.test.ts` H1–H7; H4: within ±15 % of an even split over 10 000 ids for 2–6
processes; H6 pins a vector computed with `shasum -a 256`, which #347 and any SQL twin must match).

**The session manager** (`broker/session-manager.ts`, `owns` from the registry):

- The tick's candidates are filtered by `owns`; the cap, the cap warning (`candidates` = owned)
  and the start queue use the owned ones. #93's candidate filter stays: an account whose live
  lease another process holds is not even a candidate, so a move never costs a `lease busy`.
- **The shed.** A `running` entry whose account is in work but no longer ours is marked:
  `sessionFor` refuses it at once (the executor goes over REST), its events are still written and
  its lease still renewed; the first tick at or after `SESSION_SHED_GRACE_MS` (6 s) closes the
  client, logs `broker session shed` and releases that one lease by `releaseSessionLease` — a CAS
  on `(account, owner, acquired_at)`, so a release that commits after our own re-acquire deletes
  nothing. A command already on the socket ends within `BROKER_SOCKET_COMMAND_TIMEOUT_MS` (5 s),
  inside the grace (asserted at import). Owned again within the grace (the view flapped): the mark
  goes, the socket stays. A `starting` entry is dropped at once, and its lease, when its acquire
  had answered, released the same way.
- A release that throws or overruns its bound (`SESSION_LEASE_RENEW_TIMEOUT_MS`) logs
  `broker session lease release failed`; the row lapses after the lease TTL.

**Liveness.** After a membership change every socket is on its owner within one heartbeat (the old
owner learns) + one tick (it marks) + the grace + one tick (it closes and releases) + one tick (the
new owner's scan sees the free lease) + one acquire and one token fetch: ≤ 6 + 5 + 6 + 5 + 5 ≈ 27 s
plus the start. **Safety:** at most one socket per account (the lease, unchanged; `session-lease.db.test.ts`
M3, `worker.handoff.db.test.ts` H14). With one process the live set is itself and every account is
owned from the first answer (≤ one session tick after start).

**Windows.** Two processes' views differ for up to one heartbeat after a change; both may try an
account, the lease lets one in and the other is held back `SESSION_RETRY_MS`, by when its view
says not ours. Falsifiable: two processes' `worker capacity` lines of the same minute with
different `liveView` for more than one line.

## The capacity line

`fleet/capacity.ts`: every `CAPACITY_LOG_MS` (60 s) one `info` `worker capacity`, the first one
interval after start:

| Field | Meaning |
|---|---|
| `ownerId` | the process id |
| `live` | processes in this process's view |
| `liveView` | 8 hex chars of sha256 over the sorted ids: equal across processes that agree |
| `heartbeatAgeMs` | monotonic time since the heartbeat that answered last; `null` before the first |
| `sockets` | whether `BROKER_WS_URL` is set |
| `owned`, `cappedOut` | owned accounts in work at the last scan, and how many of them are over the cap |
| `sessions`, `starting` | running and starting sessions |
| `cap` | `MAX_SESSIONS_PER_WORKER` |
| `shed` | sessions shed since the previous line |
| `rssMb` | `process.memoryUsage().rss` |
| `eventLoopLagP99Ms` | p99 of `perf_hooks.monitorEventLoopDelay` (20 ms resolution) since the previous line |

The fields from `owned` to `shed` appear only with the sockets on. A process frozen whole logs
nothing: no `worker capacity` line for more than two minutes is the operator's signal.

## The cap

`MAX_SESSIONS_PER_WORKER` (env, 1..10 000, default 500 — the constant in
`broker/session-config.ts`): sessions, running and starting, one process holds among the accounts
it owns; the owned accounts beyond it trade over REST in `broker_accounts.id` order. The ceiling is
the scan's assumption (broker-session.md → risk 9). `compose.yaml` forwards it valueless (unset →
the code default); `.env.example` names the default.

## Replicas

`compose.yaml`: `deploy.replicas: ${TRADING_WORKER_REPLICAS:-1}` under `trading-worker` (unset or
empty → 1; `0` stops the service; a non-number fails `docker compose config`).
`scripts/deploy-worker.sh` refuses two running workers (exit 2) and rolls one; rolling N is #815.

```bash
docker compose config --format json | jq '.services["trading-worker"].deploy.replicas'
# expect: 1
```

## The envelope (#87 fills it)

| Processes | Accounts in work | Sessions per process | RSS per process | Event-loop p99 | Broker GETs/min | Measured |
|---|---|---|---|---|---|---|
| 1 | — | ≤ 500 (cap) | — | — | ≤ 392 per process | not yet (#87) |
| 2–6 | — | — | — | — | — | not yet (#87, #815) |

The 500 cap, the 10 000 ceiling and the 2–6 range are not measured. #88 adds the degradation
behaviour; the pilot runs one replica until both.

## Constants

`apps/trading-worker/src/fleet/config.ts` (`FLEET_CONFIG`, checked at import):

| Constant | Value | Bounds |
|---|---|---|
| `WORKER_HEARTBEAT_MS` | 6 000 | the heartbeat interval |
| `WORKER_HEARTBEAT_TIMEOUT_MS` | 2 000 | how long one heartbeat (and the deregister at stop) may take |
| `WORKER_LIVE_FENCE_MS` | 25 000 | how long after sending a heartbeat the process trusts its view |
| `WORKER_PROCESS_TTL_MS` | 30 000 | how long a row outlives its last heartbeat |
| `WORKER_PROCESS_PRUNE_MS` | 3 600 000 | how long a lapsed row is kept |
| `CAPACITY_LOG_MS` | 60 000 | the capacity line's interval |

The chain: `TIMEOUT < HEARTBEAT`; `2 × HEARTBEAT + 2 × TIMEOUT < LIVE_FENCE` (one failed heartbeat
does not fence); `LIVE_FENCE < PROCESS_TTL` (a process stops claiming before the others may take
its accounts); `PROCESS_TTL < PRUNE`; every value an integer in `[1, MAX_TIMER_MS]`. In
`intents/config.ts`: `MAX_SUBMIT_ACK_TIMEOUT_MS + SESSION_STOP_BUDGET_MS +
WORKER_HEARTBEAT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS` — the deregister follows the manager's
stop in one phase-1 step. In `broker/session-config.ts`: `SESSION_SHED_GRACE_MS` (6 000) above
`BROKER_SOCKET_COMMAND_TIMEOUT_MS` (5 000).

## Start and shutdown

`start()`: the registry first (its heartbeat is out before the manager's first tick, which owns
nothing until it answers), then the pass, the catch-up, the orchestrator, the manager, the capacity
reporter. Shutdown phase 1: the intents consumer's step is `worker.close()` →
`drainDeadLetters()` → `sessions.stop()` → `registry.stop()`, so our row goes only after our
leases did and a successor that takes our accounts never meets our live lease; the reporter's
timer is cleared with the sweeper's.

**The deploy's overlap** (#95): both containers register. The new one owns about half of the
accounts at its first heartbeat; the old one sheds them (grace, release) before or while its
SIGTERM drains, and releases the rest at its stop. A **mixed overlap** (an old image without the
registry): the new process is alone in `worker_processes`, owns everything, and its candidate
filter still skips the old process's live leases — today's handoff. A `dirty` old process neither
releases nor deregisters: its leases lapse after the lease TTL, its row after 30 s.

## Logs

| `msg` | Level | Fields |
|---|---|---|
| `worker fleet changed` | info | `live` (ids), `liveView`, `joined`, `left` |
| `worker heartbeat failed` | error | `err` |
| `worker heartbeat timed out` | warn | `timeoutMs` |
| `worker heartbeat threw` | error | `err` — the bookkeeping after an answer, not the database |
| `worker deregister failed` | error | `err` |
| `worker deregister timed out` | warn | `timeoutMs` |
| `worker capacity` | info | the table above |
| `broker session shed` | info | `accountId`, `graceMs` |
| `broker session lease release failed` | error / warn | `accountId`, `err` / `timedOut` (a shed's release) |

## Tests

- `packages/db/src/schema.db.test.ts` → `worker_processes (#94)` G0: the CHECK at the boundary and
  a microsecond past it, a NULL expiry, the primary key.
- `packages/db/src/worker-process-ops.db.test.ts` G1–G6: the TTL by the database clock, two
  processes, the `>` boundary inside one transaction, the prune, the union.
- `packages/db/src/session-lease-ops.db.test.ts` A6, D2: the CAS token and the release.
- `apps/trading-worker/src/fleet/`: `rendezvous.test.ts` H1–H7, `registry.test.ts` F1–F6,
  `capacity.test.ts` C1–C2, `config.test.ts`.
- `broker/session-manager.test.ts` O1–O7: the owned filter and the cap, the shed (no command at
  once, events written, closed and released after the grace), a command in flight at the shed, a
  starting entry, a flap, the counts, a failing release.
- `broker/session-lease.db.test.ts` M3: two managers with complementary views, then the views
  swapped: one socket per account at every poll, every socket and lease on the new owner.
- `worker.handoff.db.test.ts` H14: two workers over one database; each account's lease on the
  process `ownerOf` names, one socket per account at every poll, both capacity lines with
  `live: 2` and one `liveView`.

## Accepted risks

1. **Start delay ≤ one session tick** (5 s): nothing is owned until the first heartbeat answers;
   the consumers are unaffected.
2. **A shed closes a ready socket** of an account that merely moved: its trades go over REST until
   the new owner's socket is ready (Liveness). With one replica nothing is shed.
3. **The loops are not partitioned** (#815): with more than one replica the GET budget is per
   process, hence one replica. Intent jobs reach the owner since #347; a job processed by a
   non-owner (no view yet, a failed forward, an `intent-direct` job) still goes over REST.
4. **`heartbeatAgeMs` and the lag are the process's own view**; a frozen process logs nothing.
5. **The cap, the ceiling and the envelope are not measured** (#87).
