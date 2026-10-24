# Binarius

pnpm workspaces monorepo for the Binarius Telegram trading bot.

## Structure

- `apps/bot` — Telegram bot (grammY)
- `apps/backend` — API (Fastify): OAuth, postbacks, auth; the trade log's export (`trade-log export`, docs/trade-log.md); the H1 shadow on the data socket's ticks, on unless `H1_SHADOW=off` (docs/h1.md); the H1 shadow report (`h1 shadow report`); the H1 mark and sessions (`h1 mark|unmark|list`, `h1 session start|stop|status`, #670); the H1 driver that opens an H1 session's trades, sized by `packages/stake`, with `H1_SUBMIT_BUDGET_MS` (#707; a regular session with H1 entries since #775)
- `apps/web` — web pages (Fastify, server-rendered HTML): staff login and admin (#34), checkout later
- `apps/trading-worker` — trading loop worker
- `packages/db` — Drizzle schema and transactional operations, shared by `apps/backend` and `apps/trading-worker`
- `packages/shared` — shared types/contracts, consumed by all 4 apps
- `packages/broker-rest` — the Binodex Broker REST client and the pairs catalog cache, shared by `apps/backend` and `apps/trading-worker`
- `packages/broker-socket` — the Binodex Broker Socket.IO client and its event normalizer, shared by `apps/backend` (the market data source, #404) and `apps/trading-worker`
- `packages/signal` — Signal module v2 (the decider, the chart feed, its journal and cache, and the tick-to-candle builder (#392)), shared by `apps/backend` (`POST /trading/signal`, the background scanner behind `GET /trading/signals`) and `apps/trading-worker`
- `packages/stake` — the session stake sizer (fixed and Martingale), shared by `apps/backend` (the H1 driver) and `apps/trading-worker` (the orchestrator) ([docs/stake.md](docs/stake.md))
- `packages/signal-stand` — the Signal backtest stand (#381): a CLI over cached broker candles, imported by no app ([docs/signal-stand.md](docs/signal-stand.md))
- `packages/mock-broker` — test-only Binodex Broker API fixture (REST and Socket.IO), for the broker clients' tests
- `packages/e2e` — test-only: the demo cycle end to end over the real backend, bot and worker, the mock broker and a stand-in Telegram ([docs/e2e-demo-cycle.md](docs/e2e-demo-cycle.md))

How a trade order travels from the bot to the worker (PostgreSQL outbox + BullMQ) is described in
[docs/trade-intent-transport.md](docs/trade-intent-transport.md); how a user links a Binodex
account and how those tokens stay fresh is in [docs/binodex-oauth.md](docs/binodex-oauth.md);
what `/start` does and where the acquisition source is kept is in
[docs/bot-start.md](docs/bot-start.md); how a staff member gets into the admin pages, and how
those sessions are revoked, is in [docs/staff-login.md](docs/staff-login.md); what the mock
broker answers, and which of it was observed on the live broker, is in
[docs/mock-broker.md](docs/mock-broker.md); how a raw broker Socket.IO event becomes a typed
domain event or a log-safe problem, and how the worker's socket client authenticates,
subscribes and reconnects, is in [docs/broker-socket.md](docs/broker-socket.md); what
the broker REST client sends to the broker and how it classifies answers is in
[docs/broker-rest.md](docs/broker-rest.md); how the worker sends a trade command over the socket
or, when nothing was sent, over REST, and which answer means what, is in
[docs/trade-executor.md](docs/trade-executor.md); how the backend caches the broker's pairs and serves
them on `GET /trading/pairs` is in [docs/pairs-catalog.md](docs/pairs-catalog.md); how the
backend builds candles from the price stream of a service account's socket is in
[docs/market-data.md](docs/market-data.md); how the backend decides H1 on a 1s series of those
ticks without trading and records each signal with its outcome is in [docs/h1.md](docs/h1.md); what
`/account` shows about a user's Binodex links is in [docs/bot-account.md](docs/bot-account.md);
what a connected user sees as the bot's home — the status card with the balances and the tokens —
is in [docs/bot-menu.md](docs/bot-menu.md); what the demo button leads to — the signals, the
launch of a cycle, and behind «🧭 Вручную» the asset, the duration, the check on a
fresh catalog and the analysis screen — is in
[docs/bot-demo.md](docs/bot-demo.md); how the stake button opens a demo trade and its status
message follows the intent is in [docs/bot-demo-trade.md](docs/bot-demo-trade.md); how the session
button starts a session of five cycles in the user's mode, follows it in one message and stops it is in
[docs/bot-session.md](docs/bot-session.md); where every
client bot text is written, the registry of variables a text can print, how its template and
validator work and what stays in code is in [docs/bot-texts.md](docs/bot-texts.md);
how the signal package fetches candles, turns them into a direction or into a reason for none,
and journals each decision, how the backend serves it on `POST /trading/signal`, and how its
scanner keeps the signals of every eligible pair from the data socket's candles for `GET /trading/signals` (#405),
is in [docs/signal.md](docs/signal.md); how the worker sizes the next
stake and when a session stops is in [docs/stake.md](docs/stake.md); how the backend answers a
user's token balance and broker balance is in [docs/trading-access.md](docs/trading-access.md);
how a user switches between demo and real, and what real mode changes, is in
[docs/trading-mode.md](docs/trading-mode.md);
where the broker balance snapshot comes from and how fresh it is kept is in
[docs/broker-balance.md](docs/broker-balance.md); how the broker's Deposit and FTD postbacks are
received, journaled and deduplicated (nothing is credited yet) is in
[docs/postbacks.md](docs/postbacks.md); how the cashier gets a session of the broker's deposit
widget, the owner's probe of it, and the Mini App page that embeds it is in
[docs/deposit.md](docs/deposit.md); which broker accounts are service accounts, how their tokens
renew themselves and when the staff bot is told there are too few is in
[docs/service-accounts.md](docs/service-accounts.md).

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
pnpm test packages/e2e   # the demo cycle end to end, docs/e2e-demo-cycle.md
STAND_DIR=~/binarius-stand/stand pnpm --filter @binarius/signal-stand stand run   # the Signal backtest, docs/signal-stand.md
STAND_DIR=~/binarius-stand/stand pnpm --filter @binarius/signal-stand stand h1    # the H1 backtest (the reference and R1), docs/signal-stand.md
STAND_DIR=~/binarius-stand/stand-30d NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @binarius/signal-stand stand h1 --assets 237831086,364060136,759228819,1430524430,1605169136,1775154181,2025372713 --move-sec 3 --sd-step 3,5 --delays 1,2 --expiries 5   # R1's grid (#669), docs/signal-stand.md
pnpm --silent --filter @binarius/backend trade-log export --from 2026-10-20T00:00:00Z > trade-log.jsonl   # the sessions' decisions (DATABASE_URL), docs/trade-log.md
pnpm --silent --filter @binarius/backend h1 shadow report --since 24h   # the H1 shadow's win rate, CI and verdict per set and pair (DATABASE_URL), docs/h1.md
pnpm --silent --filter @binarius/backend h1 list   # the accounts marked for H1 sessions (DATABASE_URL), docs/h1.md → Sessions
pnpm --silent --filter @binarius/backend h1 session status --account <accountId>   # the account's last H1 session, its cycles (DATABASE_URL), docs/h1.md → Sessions
pnpm --filter @binarius/web admin:export <dir> [--serve <port>]   # the admin pages as static files, docs/admin-design-system.md
```

`pnpm check` runs `tsc -b --clean`, then the tests, then `tsc -b`, then `eslint .`. The order is
the point: `tsc -b --clean` deletes each project's outputs for its current sources (the output of
a source that no longer exists stays behind), so the tests run before anything is built again;
and `tooling/manifest-targets.test.ts` checks that every manifest entry point names a file in the
tree, never an ignored build output. The other scripts are for running one step on its own.

`node tooling/rules-for.ts <files>` prints the Architecture Rules whose text names the given paths
(in backticks, inside a command or in the prose) and, for a file under `apps/` or `packages/`, the
always-on set `ALWAYS` (`--list`, `--files`, `--map`, `--dump`, and `--split <ref>`, which
regenerates the rule files from the one-section SKILL.md of an older commit; the index is
`.claude/skills/architect/SKILL.md` → Architecture Rules, the rules are in
`.claude/skills/architect/rules/*.md`), for example
`gh pr diff <N> --name-only | xargs node tooling/rules-for.ts --list`;
`tooling/rules-for.test.ts` checks every path, identifier and literal the rules cite, every test id
after a test-file citation, and that every tracked file, and a new file in every directory, gets
directly exactly the rules whose text names it (the grammar and what it does not read — the head
of the test).

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
The four apps and `migrate` are built from this one Dockerfile into one image, tagged
`<project>-app` (`binarius-app` in a checkout named `binarius`).

Replacing the trading worker of a running stack without a gap in job processing:
`scripts/deploy-worker.sh` after `docker compose build trading-worker` and
`docker compose run --rm migrate` (the new container starts first, then the old one drains;
[docs/worker-deploy.md](docs/worker-deploy.md)). One image serves every app service and `migrate`,
so building the worker rebuilds the migrations too.

## Database

`packages/db` holds the Drizzle schema and its forward-only migrations (`packages/db/drizzle`).
The backend keeps one client of its pool (`pg`'s default 10) for its whole run, `LISTEN`ing for
the session notice wake (#723, [docs/bot-session.md](docs/bot-session.md#rate-and-timing)).
`DATABASE_URL` names the dev stack's Postgres for the host-side commands: `pnpm db:migrate` is the
package's own runner (`packages/db/src/cli/migrate.ts`: drizzle's migrator and its
`drizzle.__drizzle_migrations` table, under an advisory lock so two runs never collide, one retry
on a deadlock), `db:generate` and `db:check` are drizzle-kit. Even this partial start needs all eight REQUIRED
values in `.env`, because Compose interpolates the whole file before it picks which services to
run: that includes `TELEGRAM_BOT_TOKEN`, which only the `bot` and `backend` services read, so
`docker compose up -d postgres redis` refuses to run without it:

```bash
docker compose up -d postgres redis
export DATABASE_URL=postgres://binarius:binarius@localhost:5432/binarius   # the .env.example values
pnpm db:migrate          # apply pending migrations (idempotent): applied N … / nothing to apply …
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

A test waits through `until(what, condition)` from `@binarius/shared/testing`, never with a
deadline of its own: the ceiling is picked by the file's project, `UNIT_WAIT_CEILING_MS` (4 s,
under vitest's 5 s default) or `INTEGRATION_WAIT_CEILING_MS` (15 s, under the 20 s budget), and
`tooling/vitest-projects.test.ts` keeps both below their budgets. An elapsed-time upper bound
uses the same two constants or is proven structurally. `tooling/test-timing.test.ts` fails
`pnpm check` on four forms in a `*.test.ts`: a polling loop with its own deadline
(`Date.now()` against a `deadline`/`until`/`ceiling` name), `vi.waitFor`/`vi.waitUntil`, a
`toBeLessThan(OrEqual)` ceiling given as a number or an all-caps constant on a timed line, and
any fixed wait (`sleep(n)`, `setTimeout(resolve, n)` or a wrapper over it) other than a zero
delay. A wait left on purpose - a negative wait, a duration a scripted delay must run out, a wait
inside a fake - is listed in its `ALLOWED` with the reason; an entry that matches nothing fails.
`DEFERRED_TO_FOLLOW_UP` holds the files in-flight issues still own until they are converted.
The scan is regex-based: a deadline built another way is not caught.

### Test database: native PostgreSQL 18

The tests compare the database's clock with their own (a column against `Date.now()`), and the
seven `>= created_at` stamp CHECKs compare a row's `created_at` — its transaction's `now()` — with
a later statement's `clock_timestamp()`; the four `expires_at > created_at` compare two values
written by the same INSERT. Both clock comparisons hold when Postgres and the
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

The role is a superuser (`-s`): that covers both rights the tests are known to need — `CREATEDB`,
because `createTempDatabase` creates and force-drops databases, and `pg_read_all_settings`, because
the preflight below reads `data_directory` (`show data_directory` is refused to any other role:
`permission denied to examine "data_directory"`); a narrower role was not tried. Homebrew's cluster
trusts local connections, so the URL carries no password. Then migrate it as above.

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
violations, and, per run, the probe's steps back and skewed samples (its 5 ms readings more than
1 s off the host; the probe runs throughout and logs its counters on `SIGUSR2`). It needs
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
integration test creates its own `binarius_test_<timestamp>_<hex>` database (migrated on the fly —
except the runner's tests in `packages/db/src/migrate.db.test.ts`, which start from an empty one —
dropped afterwards, orphans older than an hour reaped on the next run) and a random BullMQ key
prefix — the `CREATEDB` half of the role's rights above.

If another Postgres already owns host port 5432, set `POSTGRES_PORT=5433` in `.env` and use that
port in `DATABASE_URL`.

Inside the stack the same runner is the one-shot `migrate` service: every `docker compose up` that
starts `backend` or `trading-worker` runs it first, and both wait for its exit 0
(`service_completed_successfully`) — a failed migration stops them in `created`, and `up --wait`
exits 1. On an already-migrated volume it prints `nothing to apply` and applies nothing. Both
processes also check the schema themselves at start: a database behind their journal makes them
exit 1 (`database schema is behind this image, run the migrations first`; the `dev` command's
`tsx watch` keeps the container up after that, #65), one ahead of it is a warning. To apply by hand: `docker compose run --rm migrate` (`--build` when the migration was
generated after the image was built). Under `--watch` a generated migration is synced into the
containers but never applied on its own (it is read first, it can DROP), so the next restart of
either process refuses until it is. A deployment runs the migration as its own step before `up`:
an `up` whose `migrate` fails has already removed the old containers
([docs/worker-deploy.md](docs/worker-deploy.md)).

Changing the schema: edit `packages/db/src/schema/*`, run `pnpm db:generate`, read the generated SQL
(no DROP without a decision), `pnpm db:migrate` from the host or
`docker compose run --rm --build migrate`, and commit the migration with its `meta/` files
(`.claude/CLAUDE.md` → База данных). Committed migrations are never edited — CI rejects that; add a
new one. `pnpm db:check` validates the migration journal. Triggers and other objects drizzle-kit does
not model go into a custom migration (`drizzle-kit generate --custom`).

## Staff accounts

Admin pages are behind a staff login: a password plus a confirmation in Telegram, with sessions
that any staff member can revoke. Accounts are created from a CLI, never from the environment,
and the generated password is printed once. The CLI needs a migrated database, which inside the
stack it always has: it runs in `backend`, which starts only after the `migrate` service
([Database](#database) above). From the host, run `pnpm db:migrate` first.

```bash
docker compose exec backend pnpm --filter @binarius/backend staff create \
  --login ada --telegram-id 123456789 --name "Ада"
docker compose exec backend pnpm --filter @binarius/backend staff reset-password --login ada
docker compose exec backend pnpm --filter @binarius/backend staff disable --login ada
```

The Telegram ID is the one the staff bot answers with when the person sends it `/start`; the bot
runs on `ADMIN_BOT_TOKEN`, which is a **second** bot from @BotFather, not `TELEGRAM_BOT_TOKEN`.
The whole flow, the trust boundaries and the audit trail are in
[docs/staff-login.md](docs/staff-login.md); the pages a session opens (overview, users, user card,
intents, intent card, trading sessions, token ledger, audit log, bot texts) and what each view
records are in [docs/admin-pages.md](docs/admin-pages.md).

## Trading switch

One switch stops new trades for demo and real together without a restart; trades already open,
reconciliation and settlement go on. A fresh database starts open. The same migrated database
as above:

```bash
docker compose exec backend pnpm --filter @binarius/backend kill-switch status
docker compose exec backend pnpm --filter @binarius/backend kill-switch on --reason "инцидент брокера"
docker compose exec backend pnpm --filter @binarius/backend kill-switch off
```

What each command prints, what a closed switch does to queued intents and sessions, and the
deploy note are in [docs/kill-switch.md](docs/kill-switch.md).

## Bonus rules

The starter pack (and, after #116 and #386, the referral reward and the deposit bonus) is credited
under a versioned rule. A version is never edited: a change is a new version, then `activate`; what
was already credited is not recalculated. The same migrated database as above:

```bash
docker compose exec backend pnpm --filter @binarius/backend bonus-rule list
docker compose exec backend pnpm --filter @binarius/backend bonus-rule new-version link_bonus --params '{"tokens": "150"}'
docker compose exec backend pnpm --filter @binarius/backend bonus-rule activate link_bonus 2
docker compose exec backend pnpm --filter @binarius/backend bonus-rule deactivate link_bonus
```

The model, the params of each kind and the deploy note are in
[docs/bonus-rules.md](docs/bonus-rules.md).

## Demo-only stand

A stand an agent drives (#397) runs with `DEMO_ONLY=true` in `.env`: `backend` and
`trading-worker` then refuse every real intent and real session (409 `demo_only`; a queued real
intent is rejected before it reaches the broker), and demo trades as usual. Only `true` or
`false`; unset is `false`; any other value stops the process at start. Never set it on the pilot.
The flag is read at start, so a change needs the containers recreated (`docker compose up -d
backend trading-worker`; `docker compose restart` does not re-read `.env`). Before working on a
stand, the latest start line of each service must show it:

```bash
for s in backend trading-worker; do
  docker compose logs --no-log-prefix "$s" | grep -F "\"msg\":\"$s started\"" | tail -1 |
    grep -q '"demoOnly":true' && echo "$s: demo-only" || echo "$s: NOT demo-only"
done
```

On a protected stand it prints exactly `backend: demo-only` and `trading-worker: demo-only`;
anything else means the stand is not protected: recreate the containers and run it again. Each
service is read on its own, by its latest line: a container's log keeps its earlier starts, so a
count over both services can come from one of them.

What each process does with it and how it differs from the trading switch:
[docs/kill-switch.md](docs/kill-switch.md) → DEMO_ONLY.

## Bot texts

The client bot's texts can be overridden without a deploy: the bot and the backend's push apply a
saved text within 35 s. They are edited in the admin («Тексты бота»,
[docs/admin-pages.md](docs/admin-pages.md) → Bot texts) or with the CLI, on the same migrated
database as above; `show` prints the text alone, so its output is the file `set` takes back:

```bash
docker compose exec -T backend pnpm -s --filter @binarius/backend bot-text show welcome > welcome.txt
docker compose exec -T backend pnpm --filter @binarius/backend bot-text set welcome --file - < welcome.txt
docker compose exec backend pnpm --filter @binarius/backend bot-text reset welcome
docker compose exec backend pnpm --filter @binarius/backend bot-text list
docker compose exec backend pnpm --filter @binarius/backend bot-text publish
```

The command descriptions and the bot's profile live in Telegram: a save or reset of one of them, in
the admin or with the CLI `set`/`reset`, publishes it at once and shows the result per method, and
«Опубликовать заново» in the admin or `publish` sends the menu and both profile texts again (after a
failed publish, for example). The bot also publishes them at every start. What the writer refuses, how the texts are loaded and published:
[docs/bot-texts.md](docs/bot-texts.md).

## Postbacks

The broker's Deposit and FTD postbacks arrive on `GET /postbacks/binodex/<secret>`, a route the
backend registers only while `POSTBACK_URL_SECRET` is set. Each delivery is journaled and each
payment becomes one deposit; nothing is credited yet (#386). Deposits are on the admin page
«Депозиты»; what each delivery carried is in the `postback_deliveries` journal. The route, its
answers, how to read the journal, the cabinet setup and the migration's precondition are in
[docs/postbacks.md](docs/postbacks.md).
