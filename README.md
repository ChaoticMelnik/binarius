# Binarius

pnpm workspaces monorepo for the Binarius Telegram trading bot.

## Structure

- `apps/bot` — Telegram bot (grammY)
- `apps/backend` — API (Fastify): OAuth, postbacks, auth
- `apps/web` — web pages (Fastify, server-rendered HTML): staff login and admin (#34), checkout later
- `apps/trading-worker` — trading loop worker (Socket.IO client)
- `packages/db` — Drizzle schema and transactional operations, shared by `apps/backend` and `apps/trading-worker`
- `packages/shared` — shared types/contracts, consumed by all 4 apps
- `packages/broker-rest` — the Binodex Broker REST client and the pairs catalog cache, shared by `apps/backend` and `apps/trading-worker`
- `packages/mock-broker` — test-only Binodex Broker API fixture (REST and Socket.IO), for the broker clients' tests

How a trade order travels from the bot to the worker (PostgreSQL outbox + BullMQ) is described in
[docs/trade-intent-transport.md](docs/trade-intent-transport.md); how a user links a Binodex
account and how those tokens stay fresh is in [docs/binodex-oauth.md](docs/binodex-oauth.md);
what `/start` does and where the acquisition source is kept is in
[docs/bot-start.md](docs/bot-start.md); how a staff member gets into the admin pages, and how
those sessions are revoked, is in [docs/staff-login.md](docs/staff-login.md); what the mock
broker answers, and which of it was observed on the live broker, is in
[docs/mock-broker.md](docs/mock-broker.md); how a raw broker Socket.IO event becomes a typed
domain event or a log-safe problem is in [docs/broker-socket.md](docs/broker-socket.md); what
the broker REST client sends to the broker and how it classifies answers is in
[docs/broker-rest.md](docs/broker-rest.md); how the backend caches the broker's pairs and serves
them on `GET /trading/pairs` is in [docs/pairs-catalog.md](docs/pairs-catalog.md); what
`/account` shows about a user's Binodex links is in [docs/bot-account.md](docs/bot-account.md);
how the worker fetches candles, turns them into a direction or into a reason for none, and
journals each decision is in [docs/signal.md](docs/signal.md); how the backend answers a user's
token balance and broker balance is in [docs/trading-access.md](docs/trading-access.md); where the
broker balance snapshot comes from and how fresh it is kept is in
[docs/broker-balance.md](docs/broker-balance.md).

## Requirements

- Node.js ^22.18.0 || ^24.0.0 || >=26.0.0 (pinned in `.node-version`). The floor is Node's native
  TypeScript stripping: `eslint.config.js` imports its status-literal rule straight from
  `tooling/eslint-rules/*.ts`. From a shell that skipped `fnm use`, `pnpm lint` fails with
  `ERR_UNKNOWN_FILE_EXTENSION` — the same signal as `.node-version`. An editor's ESLint server
  runs on the extension's own Node, which also has to be 22.18 or newer.
- pnpm 10.34.1 (managed via Corepack, see `packageManager` in `package.json`)

## Commands

```bash
pnpm install             # install all workspace dependencies
pnpm check               # the one check command: what CI runs, and what "green" means
pnpm typecheck           # tsc -b across the project-reference graph
pnpm lint                # eslint .
pnpm test                # vitest run — needs a migrated Postgres, see Database below
pnpm test apps/backend   # one package's tests (path filter)
pnpm test --project unit # the tests that need no Postgres or Redis
```

`pnpm check` runs `tsc -b --clean`, then the tests, then `tsc -b`, then `eslint .`. The order is
the point: `tsc -b --clean` deletes each project's outputs for its current sources (the output of
a source that no longer exists stays behind), so the tests run before anything is built again;
and `tooling/manifest-targets.test.ts` checks that every manifest entry point names a file in the
tree, never an ignored build output. The other scripts are for running one step on its own.

## Docker dev environment

Postgres, Redis, and the four apps run in containers; the apps hot-reload from your working tree.
The apps are not meant to run outside Docker in this repo state.

```bash
cp .env.example .env                # then fill in the eight REQUIRED values; compose stops while any is empty
docker compose up --build --watch   # build, start, sync src/ edits into the containers
curl 127.0.0.1:3000/health          # {"status":"ok","postgres":"ok","redis":"ok"}
curl -I 127.0.0.1:3001/admin/login  # HTTP/1.1 200 OK — the staff login page
docker compose down -v              # stop and drop the Postgres volume
```

Plain `docker compose up` starts everything without file sync. `--build` matters: without it,
`--watch` starts from the last built image and only picks up edits made after it started.
Under `--watch`, edits to `src/` restart the affected app; edits to a `package.json`,
`pnpm-lock.yaml`, or a tsconfig rebuild the image. Postgres (`5432`), Redis (`6379`), and the
backend (`3000`) and `web` (`3001`: the admin pages and the Mini App login pages) are published
on `127.0.0.1` only.

## Database

`packages/db` holds the Drizzle schema and its forward-only migrations (`packages/db/drizzle`).
`DATABASE_URL` names the dev stack's Postgres for the host-side drizzle-kit commands
(`pnpm db:migrate`, `db:generate`, `db:check`). Even this partial start needs all eight REQUIRED
values in `.env`, because Compose interpolates the whole file before it picks which services to
run: that includes `TELEGRAM_BOT_TOKEN`, which only the `bot` and `backend` services read, so
`docker compose up -d postgres redis` refuses to run without it:

```bash
docker compose up -d postgres redis
export DATABASE_URL=postgres://binarius:binarius@localhost:5432/binarius   # the .env.example values
pnpm db:migrate          # apply pending migrations (idempotent)
```

The integration tests never read `DATABASE_URL`. They run against the Postgres named by
`TEST_DATABASE_URL`, a native PostgreSQL 18 on the host ([Test database](#test-database-native-postgresql-18)
below), and the Redis named by `REDIS_URL` (the compose one), and fail without either:

```bash
export TEST_DATABASE_URL=postgres://binarius@127.0.0.1:5434/binarius   # the .env.example value
export REDIS_URL=redis://localhost:6379
DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate   # the test database's own migrations
pnpm test
```

The tests are two vitest projects (`vitest.config.ts`). `integration` is every
`*.db.test.ts` and `*.redis.test.ts` under `apps/*/src` and `packages/*/src`: a test that reads
`TEST_DATABASE_URL` or `REDIS_URL`, imports `pg`, `ioredis`, `bullmq` or `@binarius/db/testing`,
or calls `createTempDatabase` must be named that way, and only such a test may be —
`tooling/vitest-projects.test.ts` fails otherwise. The project's budgets are wider than vitest's
defaults, because a busy host starves the database: 60 s for a hook (a temporary database is
created and migrated in `beforeAll`) and 20 s for a test. Before its first test file the project
runs `tooling/integration-preflight.ts` ([Test database](#test-database-native-postgresql-18)).
`unit` is everything else, on the defaults, and needs no services: `pnpm test --project unit`.
`pnpm test --project integration` runs only the first.

### Test database: native PostgreSQL 18

The tests compare the database's clock with their own (a column against `Date.now()`) and one
transaction's `now()` with a later one's (the time-order CHECKs). Both hold when Postgres and the
tests share one clock: on the production host, in CI (a service container on the runner's kernel)
and with a native Postgres on a Mac. They did not hold with the compose Postgres, which on a Mac
runs in the Colima VM (#166):

- the Lima guest agent sets the VM's clock from the host's whenever they drift 100 ms apart, which
  happened every 10-20 s, and each time the clock stepped back by 80-180 ms;
- after the Mac sleeps the VM's clock is behind by the length of the sleep until something sets
  it: the agent within about 10 s, `systemd-timesyncd` alone only at its next poll, up to 34
  minutes later (with the agent's right to set the time taken away, the VM stayed 84 minutes
  behind for at least 14 minutes);
- the VM's 2 vCPUs starve when the host is busy.

Setting it up once on a Mac (Homebrew; port 5434, because 5432 may be another local Postgres and
5433 is the `POSTGRES_PORT` this README suggests for the compose one):

```bash
brew install postgresql@18   # keg-only; creates the cluster in /opt/homebrew/var/postgresql@18
sed -i '' -E 's/^#?port = 5432/port = 5434/' /opt/homebrew/var/postgresql@18/postgresql.conf
brew services start postgresql@18   # and at every login
/opt/homebrew/opt/postgresql@18/bin/pg_isready -h 127.0.0.1 -p 5434
/opt/homebrew/opt/postgresql@18/bin/createuser -h 127.0.0.1 -p 5434 -s binarius
/opt/homebrew/opt/postgresql@18/bin/createdb -h 127.0.0.1 -p 5434 -O binarius binarius
```

The role is a superuser because `createTempDatabase` creates and force-drops databases. Homebrew's
cluster trusts local connections, so the URL carries no password. Then migrate it as above.

`tooling/integration-preflight.ts` refuses to start the integration tests, with one message naming
this section, when the database in `TEST_DATABASE_URL`:

- is older than PostgreSQL 18 (`old.status` in RETURNING needs 18);
- has a clock more than 1 s off the host's;
- is, on a Mac, a containerised Postgres (`data_directory` under `/var/lib/postgresql`, where the
  `postgres` image keeps it), that is, the compose one in the VM.

`tooling/db-clock-probe.ts` watches the same clock continuously: it reads `clock_timestamp()` every
5 ms and logs each step back and each stretch more than 1 s off the host. Exit codes: 0 clean, 1 a
step back or a skew, 2 no sample at all, 64 bad usage, 70 the probe itself failed.

```bash
node tooling/db-clock-probe.ts --seconds 900   # TEST_DATABASE_URL as above
```

`tooling/check-stability.sh` repeats the suite and tabulates timeouts, time-order CHECK
violations, and the probe's steps back and skew, which runs throughout. It needs
`TEST_DATABASE_URL` and `REDIS_URL` set as above and a shell that ran `fnm use`:

```bash
tooling/check-stability.sh quiet 10   # ten `pnpm check` in a row
tooling/check-stability.sh load 3     # three rounds of two parallel suites beside 4 CPU hogs
```

`load` refuses to start a round below 512 MB of free swap (`MIN_FREE_SWAP_MB`), and when
`vm.swapusage` cannot be read; with no swap in use at all (macOS creates it on demand) the guard is
skipped and the summary says so. It adds CPU pressure only, and a host that is swapping measures
the swap. Logs and `summary.txt` go to `$STABILITY_OUT`, a fresh temporary directory by default.

`packages/db/src/schema.db.test.ts` uses the migrated test database itself; every other
integration test creates its own `binarius_test_<timestamp>_<hex>` database (migrated on the fly,
dropped afterwards, orphans older than an hour reaped on the next run) and a random BullMQ key
prefix, so the role in `TEST_DATABASE_URL` needs `CREATEDB`.

If another Postgres already owns host port 5432, set `POSTGRES_PORT=5433` in `.env` and use that
port in `DATABASE_URL`.

Inside the stack the same migration runs as `docker compose exec backend pnpm db:migrate`, which
is what a deployment that never had a host-side checkout uses. Nothing applies migrations when a
container starts yet (#75), so one of the two forms has to be run by hand before anything reads a
table.

Changing the schema: edit `packages/db/src/schema/*`, run `pnpm db:generate`, read the generated SQL
(no DROP without a decision), `pnpm db:migrate`, and commit the migration with its `meta/` files
(`.claude/CLAUDE.md` → База данных). Committed migrations are never edited — CI rejects that; add a
new one. `pnpm db:check` validates the migration journal. Triggers and other objects drizzle-kit does
not model go into a custom migration (`drizzle-kit generate --custom`).

## Staff accounts

Admin pages are behind a staff login: a password plus a confirmation in Telegram, with sessions
that any staff member can revoke. Accounts are created from a CLI, never from the environment,
and the generated password is printed once. The CLI needs a migrated database: `pnpm db:migrate`
from the host ([Database](#database) above) or `docker compose exec backend pnpm db:migrate`
inside the stack.

```bash
docker compose exec backend pnpm --filter @binarius/backend staff create \
  --login ada --telegram-id 123456789 --name "Ада"
docker compose exec backend pnpm --filter @binarius/backend staff reset-password --login ada
docker compose exec backend pnpm --filter @binarius/backend staff disable --login ada
```

The Telegram ID is the one the staff bot answers with when the person sends it `/start`; the bot
runs on `ADMIN_BOT_TOKEN`, which is a **second** bot from @BotFather, not `TELEGRAM_BOT_TOKEN`.
The whole flow, the trust boundaries and the audit trail are in
[docs/staff-login.md](docs/staff-login.md).
