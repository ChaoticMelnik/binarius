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
pnpm test                # vitest run
pnpm test apps/backend   # one package's tests (path filter)
```

## Docker dev environment

Postgres, Redis, and the four apps run in containers; the apps hot-reload from your working tree.

```bash
cp .env.example .env        # optional: every value is also the compose default
docker compose up --watch   # build, start, sync src/ edits into the containers
curl localhost:3000/health  # {"status":"ok","postgres":"ok","redis":"ok"}
docker compose down -v      # stop and drop the Postgres volume
```

Plain `docker compose up` starts everything without file sync. Under `--watch`, edits to
`src/` restart the affected app; edits to a `package.json`, `pnpm-lock.yaml`, or a tsconfig
rebuild the image. Postgres (`5432`), Redis (`6379`), and the backend (`3000`) are published on
`127.0.0.1` only. `pnpm test` never needs Docker.
