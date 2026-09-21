# keep in sync with .node-version (CI fails if they differ)
ARG NODE_VERSION=22.23.2
FROM node:${NODE_VERSION}-alpine

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile --offline
