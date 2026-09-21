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

- Node.js >= 22.12.0 (see `.node-version`)
- pnpm 10.34.1 (managed via Corepack, see `packageManager` in `package.json`)

## Commands

```bash
pnpm install     # install all workspace dependencies
pnpm typecheck   # tsc -b across the project-reference graph
pnpm lint        # eslint .
pnpm test        # vitest run
```
