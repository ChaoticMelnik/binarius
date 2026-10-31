# keep in sync with .node-version (CI fails if they differ)
ARG NODE_VERSION=22.23.2

# Three stages (#877, docs/deploy.md -> The build): `dev` is what compose.yaml runs (every
# dependency, tsx watch) and where the bundles are built; `prod` is what the production pair runs
# (compose.prod.yaml: `dependencies` only, the sources, the bundles copied from `dev`). `prod` is
# last, so a bare `docker build .` builds what the server runs.
FROM node:${NODE_VERSION}-alpine AS base

# PNPM_HOME puts the store at /pnpm/store, the cache mount below: the packages are downloaded
# into the build cache, never into a layer, and copied into node_modules once
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm
RUN corepack enable

WORKDIR /app
RUN chown node:node /app
USER node

# root package.json stays here: Corepack reads the pnpm pin from its packageManager field
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Corepack downloads pnpm here, once, into a layer both stages share
RUN pnpm --version

# manifests only, so a source or config edit does not re-link the workspace; every workspace
# package is listed (tooling/image.test.ts D3): a missing one is never linked
COPY --chown=node:node apps/backend/package.json apps/backend/
COPY --chown=node:node apps/bot/package.json apps/bot/
COPY --chown=node:node apps/trading-worker/package.json apps/trading-worker/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/broker-rest/package.json packages/broker-rest/
COPY --chown=node:node packages/broker-socket/package.json packages/broker-socket/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node packages/e2e/package.json packages/e2e/
COPY --chown=node:node packages/mock-broker/package.json packages/mock-broker/
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node packages/signal/package.json packages/signal/
COPY --chown=node:node packages/signal-stand/package.json packages/signal-stand/
COPY --chown=node:node packages/stake/package.json packages/stake/

FROM base AS dev
# sharing=locked: BuildKit runs the two stages' installs concurrently, and they share one store
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,uid=1000,gid=1000,sharing=locked \
    pnpm install --frozen-lockfile
COPY --chown=node:node . .
# the prod stage's bundles (tooling/build.ts, compose.prod.yaml): .dockerignore keeps the host's
# dist/ out, so the image runs only what it built itself
RUN pnpm build

# `dependencies` only: tsx is a root dependency, so `migrate` (node --import tsx) and every CLI
# the docs run (`pnpm --filter @binarius/<app> <script>`, a tsx script) work here; typescript,
# eslint, vitest and drizzle-kit do not come along
FROM base AS prod
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,uid=1000,gid=1000,sharing=locked \
    pnpm install --prod --frozen-lockfile
COPY --chown=node:node . .
COPY --from=dev --chown=node:node /app/apps/backend/dist apps/backend/dist
COPY --from=dev --chown=node:node /app/apps/bot/dist apps/bot/dist
COPY --from=dev --chown=node:node /app/apps/trading-worker/dist apps/trading-worker/dist
COPY --from=dev --chown=node:node /app/apps/web/dist apps/web/dist
