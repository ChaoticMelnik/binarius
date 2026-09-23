# Binarius

pnpm workspaces monorepo for the Binarius Telegram trading bot.

## Structure

- `apps/bot` — Telegram bot (grammY)
- `apps/backend` — API (Fastify): OAuth, postbacks, auth
- `apps/web` — web pages (Next.js): login, checkout, admin
- `apps/trading-worker` — trading loop worker (Socket.IO client)
- `packages/db` — Drizzle schema and transactional operations, shared by `apps/backend` and `apps/trading-worker`
- `packages/shared` — shared types/contracts, consumed by all 4 apps

How a trade order travels from the bot to the worker (PostgreSQL outbox + BullMQ) is described in
[docs/trade-intent-transport.md](docs/trade-intent-transport.md); how a user links a Binodex
account and how those tokens stay fresh is in [docs/binodex-oauth.md](docs/binodex-oauth.md).

## Requirements

- Node.js ^22.13.0 || ^24.0.0 || >=26.0.0 (pinned in `.node-version`)
- pnpm 10.34.1 (managed via Corepack, see `packageManager` in `package.json`)

## Commands

```bash
pnpm install             # install all workspace dependencies
pnpm typecheck           # tsc -b across the project-reference graph
pnpm lint                # eslint .
pnpm test                # vitest run — needs a migrated Postgres, see Database below
pnpm test apps/backend   # one package's tests (path filter)
```

## Docker dev environment

Postgres, Redis, and the four apps run in containers; the apps hot-reload from your working tree.
The apps are not meant to run outside Docker in this repo state.

```bash
cp .env.example .env                # optional: every value is also the compose default
docker compose up --build --watch   # build, start, sync src/ edits into the containers
curl 127.0.0.1:3000/health          # {"status":"ok","postgres":"ok","redis":"ok"}
docker compose down -v              # stop and drop the Postgres volume
```

Plain `docker compose up` starts everything without file sync. `--build` matters: without it,
`--watch` starts from the last built image and only picks up edits made after it started.
Under `--watch`, edits to `src/` restart the affected app; edits to a `package.json`,
`pnpm-lock.yaml`, or a tsconfig rebuild the image. Postgres (`5432`), Redis (`6379`), and the
backend (`3000`) are published on `127.0.0.1` only.

## Database

`packages/db` holds the Drizzle schema and its forward-only migrations (`packages/db/drizzle`).
The integration tests run against a real Postgres named by `DATABASE_URL` and a real Redis named
by `REDIS_URL`, and fail without them — `pnpm test` therefore needs the compose services:

```bash
docker compose up -d postgres redis
export DATABASE_URL=postgres://binarius:binarius@localhost:5432/binarius   # the .env.example values
export REDIS_URL=redis://localhost:6379
pnpm db:migrate          # apply pending migrations (idempotent)
pnpm test
```

`packages/db/src/schema.db.test.ts` uses the migrated database itself; every other integration
test creates its own `binarius_test_<timestamp>_<hex>` database (migrated on the fly, dropped
afterwards, orphans older than an hour reaped on the next run) and a random BullMQ key prefix, so
the role in `DATABASE_URL` needs `CREATEDB` — the compose role is a superuser.

If another Postgres already owns host port 5432, set `POSTGRES_PORT=5433` in `.env` and use that
port in `DATABASE_URL`.

Changing the schema: edit `packages/db/src/schema/*`, run `pnpm db:generate`, read the generated SQL
(no DROP without a decision), `pnpm db:migrate`, and commit the migration with its `meta/` files
(`.claude/CLAUDE.md` → База данных). Committed migrations are never edited — CI rejects that; add a
new one. `pnpm db:check` validates the migration journal. Triggers and other objects drizzle-kit does
not model go into a custom migration (`drizzle-kit generate --custom`).
