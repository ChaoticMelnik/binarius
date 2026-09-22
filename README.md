# Binarius

pnpm workspaces monorepo for the Binarius Telegram trading bot.

## Structure

- `apps/bot` — Telegram bot (grammY)
- `apps/backend` — API (Fastify): OAuth, postbacks, auth
- `apps/web` — web pages (Next.js): login, checkout, admin
- `apps/trading-worker` — trading loop worker (Socket.IO client)
- `packages/db` — Drizzle schema, shared by `apps/backend` and `apps/trading-worker`
- `packages/shared` — shared types/contracts, consumed by all 4 apps

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
The `packages/db` tests run against a real, migrated Postgres named by `DATABASE_URL` and fail
without one — `pnpm test` therefore needs the compose Postgres:

```bash
docker compose up -d postgres
export DATABASE_URL=postgres://binarius:binarius@localhost:5432/binarius   # the .env.example value
pnpm db:migrate          # apply pending migrations (idempotent)
pnpm test
```

If another Postgres already owns host port 5432, set `POSTGRES_PORT=5433` in `.env` and use that
port in `DATABASE_URL`.

Changing the schema: edit `packages/db/src/schema/*`, run `pnpm db:generate`, read the generated SQL
(no DROP without a decision), `pnpm db:migrate`, and commit the migration with its `meta/` files
(`.claude/CLAUDE.md` → База данных). Committed migrations are never edited — CI rejects that; add a
new one. `pnpm db:check` validates the migration journal. Triggers and other objects drizzle-kit does
not model go into a custom migration (`drizzle-kit generate --custom`).
