# keep in sync with .node-version (CI fails if they differ)
ARG NODE_VERSION=22.23.2
FROM node:${NODE_VERSION}-alpine

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
RUN chown node:node /app
USER node

# root package.json stays here: Corepack reads the pnpm pin from its packageManager field
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# manifests only, so a source or config edit does not re-link the workspace
COPY --chown=node:node apps/backend/package.json apps/backend/
COPY --chown=node:node apps/bot/package.json apps/bot/
COPY --chown=node:node apps/trading-worker/package.json apps/trading-worker/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --offline

COPY --chown=node:node . .
