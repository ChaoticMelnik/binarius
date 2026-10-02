# Binarius

pnpm workspaces monorepo for the Binarius Telegram trading bot.

## Structure

- `apps/bot` — Telegram bot (grammY)
- `apps/backend` — API (Fastify): OAuth, postbacks, auth
- `apps/web` — web pages (Fastify, server-rendered HTML): staff login and admin (#34), checkout later
- `apps/trading-worker` — trading loop worker (Socket.IO client)
- `packages/db` — Drizzle schema and transactional operations, shared by `apps/backend` and `apps/trading-worker`
- `packages/shared` — shared types/contracts, consumed by all 4 apps

How a trade order travels from the bot to the worker (PostgreSQL outbox + BullMQ) is described in
[docs/trade-intent-transport.md](docs/trade-intent-transport.md); how a user links a Binodex
account and how those tokens stay fresh is in [docs/binodex-oauth.md](docs/binodex-oauth.md);
what `/start` does and where the acquisition source is kept is in
[docs/bot-start.md](docs/bot-start.md); how a staff member gets into the admin pages, and how
those sessions are revoked, is in [docs/staff-login.md](docs/staff-login.md).

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

### The VM clock (Colima)

On a Mac the containers run in a Colima VM. Its `lima-guestagent` compares the VM's clock with the
host's every 10 s and, past a 100 ms drift, sets the VM's time in one jump (Lima issue #5543).
`systemd-timesyncd` in the VM pulls the same clock towards NTP at the same time, so the jump
lands _backwards_, by 80-125 ms, as often as every 20 s under load. Postgres's `now()` then reads
earlier in a later transaction, and the time-order CHECKs (`*_after_created`,
`staff_login_challenges_code_sent_check` and the like) reject rows the code wrote correctly
(#166). Production and CI run Postgres on the host's own kernel clock, where an NTP daemon slews
small offsets instead of stepping.

The fix takes the right to set the time away from the agent, leaving the VM's clock to
`systemd-timesyncd` alone, which slews it:

```bash
colima ssh -- sudo mkdir -p /etc/systemd/system/lima-guestagent.service.d
printf '[Service]\nCapabilityBoundingSet=~CAP_SYS_TIME\n' \
  | colima ssh -- sudo tee /etc/systemd/system/lima-guestagent.service.d/no-sys-time.conf
colima ssh -- sudo systemctl daemon-reload
colima ssh -- sudo systemctl restart lima-guestagent
```

Restarting the agent drops and re-announces the port forwards; check that `docker ps` and
`curl 127.0.0.1:3000/health` answer afterwards. To verify the fix:

```bash
colima ssh -- systemctl show lima-guestagent -p ActiveState -p NRestarts -p DropInPaths
colima ssh -- systemctl is-active systemd-timesyncd   # active: it is now the only clock keeper
colima ssh -- sudo journalctl -u lima-guestagent --since -10min | grep -i synctime
```

`DropInPaths` names `no-sys-time.conf`, and every 10 s the journal shows `SyncTime: failed to set
system time` with `operation not permitted` instead of `system time synchronized with host`. The drop-in lives in the VM's
disk: after `colima delete` repeat it; after `colima restart` check `DropInPaths`.

`tooling/db-clock-probe.ts` is the detector: it reads Postgres's `clock_timestamp()` every 5 ms
and logs each step back (exit 1 if there was one, 2 if it never got a sample):

```bash
node tooling/db-clock-probe.ts --seconds 900   # DATABASE_URL as for the tests
```

After the fix the VM's clock follows NTP and the Mac's does not quite, so the database reads
ahead of `Date.now()` by the Mac's own NTP error (157 ms when this was written; `sntp
time.apple.com` on the Mac shows it). Database-against-database comparisons do not see that;
tests that compare `Date.now()` with a database column expect the column to be the later one, with
margins of 500 ms or more.

## Database

`packages/db` holds the Drizzle schema and its forward-only migrations (`packages/db/drizzle`).
The integration tests run against a real Postgres named by `DATABASE_URL` and a real Redis named
by `REDIS_URL`, and fail without them — `pnpm test` therefore needs the compose services. Even
this partial start needs all eight REQUIRED values in `.env`, because Compose interpolates the
whole file before it picks which services to run: that includes `TELEGRAM_BOT_TOKEN`, which only
the `bot` and `backend` services read, so `docker compose up -d postgres redis` refuses to run
without it:

```bash
docker compose up -d postgres redis
export DATABASE_URL=postgres://binarius:binarius@localhost:5432/binarius   # the .env.example values
export REDIS_URL=redis://localhost:6379
pnpm db:migrate          # apply pending migrations (idempotent)
pnpm test
```

The tests are two vitest projects (`vitest.config.ts`). `integration` is every
`*.db.test.ts` and `*.redis.test.ts` under `apps/*/src` and `packages/*/src`: a test that reads
`DATABASE_URL` or `REDIS_URL`, imports `pg`, `ioredis`, `bullmq` or `@binarius/db/testing`, or
calls `createTempDatabase` must be named that way, and only such a test may be —
`tooling/vitest-projects.test.ts` fails otherwise. The project's budgets are wider than vitest's
defaults, because a busy host starves the VM Postgres runs in: 60 s for a hook (a temporary
database is created and migrated in `beforeAll`) and 20 s for a test. `unit` is everything else,
on the defaults. `pnpm test --project integration` runs only the first.

`tooling/check-stability.sh` repeats the suite and tabulates timeouts, time-order CHECK
violations and steps back of the database clock (`tooling/db-clock-probe.ts` runs throughout), with
`DATABASE_URL` and `REDIS_URL` set as above and from a shell that ran `fnm use`:

```bash
tooling/check-stability.sh quiet 10   # ten `pnpm check` in a row
tooling/check-stability.sh load 3     # three rounds of two parallel suites beside 4 CPU hogs
```

`load` refuses to start a round below 512 MB of free swap (`MIN_FREE_SWAP_MB`): it adds CPU pressure only,
and a host that is swapping measures the swap. Logs and `summary.txt` go to `$STABILITY_OUT`, a
fresh temporary directory by default.

`packages/db/src/schema.db.test.ts` uses the migrated database itself; every other integration
test creates its own `binarius_test_<timestamp>_<hex>` database (migrated on the fly, dropped
afterwards, orphans older than an hour reaped on the next run) and a random BullMQ key prefix, so
the role in `DATABASE_URL` needs `CREATEDB` — the compose role is a superuser.

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
