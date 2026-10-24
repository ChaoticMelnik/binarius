# Deploying: the production profile

How the stack runs on a server (#146): the same `compose.yaml` as development, with the override
`compose.prod.yaml`, built into one image that carries a bundle per app, behind Caddy on the host.
The pilot is one VPS (1 vCPU, 961 MB RAM + 2 GB swap, ~2 GB of free disk) shared with other
services of the owner.

## Topology

- **Caddy on the host**, outside Compose, terminates HTTPS on 80/443 and proxies the domain to
  `web` on `127.0.0.1:3001`; the one exception is the broker's postback route, which goes to the
  backend on `127.0.0.1:3000` ([`deploy/Caddyfile`](../deploy/Caddyfile),
  [postbacks.md → The Caddy route](postbacks.md#the-caddy-route-owners-step-on-the-host)).
- **Compose publishes on loopback only**: Postgres, Redis, the backend and `web`. Nothing of the
  stack is reachable from outside but through Caddy.
- **The host is shared** with a VPN. What a deployment never touches there: `dockerd` (no
  `daemon.json` edit, no restart, no Docker reinstall), `ufw` (never enabled), the VPN's
  containers, and the DNS records of the domain other than the stack's own `A` record. That is
  also why log rotation is set per service in `compose.prod.yaml` rather than once in
  `daemon.json`.

## What the production profile changes

`compose.prod.yaml` is an override, never a file on its own: Compose merges it over
`compose.yaml`, and refuses it when it names a service `compose.yaml` does not have. It changes
three things and nothing else (`tooling/compose-prod.test.ts` P1-P5, Rule 52):

| | dev (`compose.yaml` alone) | prod (`compose.yaml` + `compose.prod.yaml`) |
|---|---|---|
| app command | `pnpm --filter @binarius/<app> dev` = `tsx watch src/index.ts` (three node processes per app, TypeScript compiled on the fly) | `node apps/<app>/dist/index.js`: one node process under tini |
| a process that exits | the `tsx watch` supervisor survives, the container stays `running` (#65) | the container exits with the process's code; `restart` brings it back |
| logs | unbounded `json-file` | `json-file`, `max-size: 10m`, `max-file: 3` on all seven services |
| `postgres`, `redis` restart | none | `${COMPOSE_RESTART:-unless-stopped}`, like the app services |

Everything else is inherited unchanged: environment, ports, `depends_on`, `init: true`,
`stop_grace_period` and the shutdown budgets (Rule 10), the backend's healthcheck, the image.
`migrate` keeps its command `pnpm db:migrate` (Rule 16): it exits before the apps start, so it
holds no memory at idle. The CLIs keep theirs too — `docker compose exec backend pnpm --filter
@binarius/backend staff create …`, `bot-text`, `h1`, `socket-probe` and the rest run under `tsx`
inside the same container, because the image still carries `pnpm`, `tsx` and the sources.

`docker compose watch` (or `up --watch`) under the pair is inert: it syncs `src/` into a container
that runs `dist/`. It is never run on the server.

## The build

`pnpm build` (`node tooling/build.ts`) writes one ESM bundle per app, `apps/<app>/dist/index.js`
with a source map beside it, for every `apps/*` directory with a `src/index.ts`. The image runs it
as `RUN pnpm build` after copying the tree; `.dockerignore` keeps the host's `dist/` out, so the
image runs only what it built itself.

Why a bundle: the output of `tsc -b` cannot run under Node. The sources import each other without
extensions (`moduleResolution: Bundler`) and the workspace packages export `./src/*.ts`, so Node's
ESM resolver refuses both. The bundle resolves them at build time instead:

- **inside**: the app's own code and every `@binarius/*` package it imports;
- **outside**: every third-party package and `node:*` builtin, imported at run time from
  `apps/<app>/node_modules`, byte for byte the same specifiers as in the sources.

Under pnpm's strict layout a bundled package's own dependencies are not on that path, so every
external package must be in the app's own `dependencies` — not devDependencies, and not merely
present somewhere on disk. That is why `socket.io-client` is a dependency of the backend and the
worker and `zod` one of the bot and the worker: their bundled packages import them. The build
refuses (and with it `docker build`) when:

- a bundle imports a package its app does not declare in `dependencies`;
- a bundle took in a file from `node_modules`;
- a bundle took in a CLI (`/cli/`), `export-pages.ts`, a `testing.ts` or a test file — a CLI's
  `import.meta.main` guard would be true inside the bundle and run its `main()` in the service.

`tooling/build.test.ts` (B1-B5) builds the four bundles into a temporary directory on every
`pnpm check`. Locally `apps/*/dist/` is shared with `tsc -b`, whose `--clean` removes the bundle
and whose output overwrites it: a bundle on the host is a throwaway; only the image's runs.

Stack traces name the bundle's lines; function names are kept (no minification). To read a trace
against the sources, run the service once with source maps:

```bash
docker compose run --rm --no-deps backend node --enable-source-maps apps/backend/dist/index.js
```

## Files a package reads

Three places read files of their own package at run time: the bot's pictures and fonts, `web`'s
admin stylesheet and fonts, and `packages/db`'s migrations folder (the startup schema check reads
its journal inside the backend's and the worker's bundles). In a bundle every module shares the
bundle's `import.meta.url`, so `new URL('./assets/x.jpg', import.meta.url)` would point into
`apps/<app>/dist/`. They find the package's root instead:

```ts
path.dirname(createRequire(import.meta.url).resolve('@binarius/<pkg>/package.json'))
```

From `src/` that is the package's self-reference; from a bundle it is the self-reference too
(`apps/bot/dist` lies inside `apps/bot`) or the consumer's `node_modules` symlink, and Node
returns the real path either way. The package lists `"./package.json": "./package.json"` in its
`exports` (bot, web, db), or Node refuses the subpath. The bot's form is `botFile()` in
`apps/bot/src/package-root.ts`, which also checks each file for read access when its module is
imported, so a wrong path stops the process at start, not at the first card; `web` reads its files
at import already. The helper is not in `packages/shared`: that package compiles without Node's
types (`types: []`, #6). A new file read at run time takes the same form: a unit test from `src/`
cannot tell a wrong `import.meta.url` path from a right one.

## Selecting the profile

- **On the server**: one line in the checkout's `.env`,
  `COMPOSE_FILE=compose.yaml:compose.prod.yaml`. Compose reads it there, so every command run in
  the checkout — `binarius-deploy`, `scripts/deploy-worker.sh`, `exec`, `logs`, `run` — takes the
  pair without flags. A `COMPOSE_FILE` exported in the shell overrides `.env`: never export it on
  the server. With `COMPOSE_FILE` set, a `compose.override.yaml` is no longer loaded.
- **Locally and in CI**: `docker compose -f compose.yaml -f compose.prod.yaml …`; the CI compose job
  sets `COMPOSE_FILE` in its environment. An explicit `-f` overrides `COMPOSE_FILE`.
- Without either, `docker compose up` is the dev stack.

The merged configuration, without starting anything:

```bash
docker compose -f compose.yaml -f compose.prod.yaml config --format json | jq -c '.services | to_entries[] | {s: .key, command: .value.command, restart: .value.restart, logging: .value.logging.options}'
```

(Compose interpolates the whole file first, so the eight REQUIRED values of `.env.example` must be
set, as for any compose command.)

## A process that exits

Under the prod command the container's exit code is the process's: a bot whose `getMe` is refused
(`apps/bot/src/lifecycle.ts`), a backend or worker whose database is behind its journal, or any
`process.exit(1)` ends the container, and `restart: unless-stopped` starts it again (Docker's
backoff in between; `docker compose ps` shows `Restarting`). Under `COMPOSE_RESTART=no`, which CI
sets, it stays `exited (1)`. The CI compose job proves both on the pair: «a dead process ends its
container on the prod pair» (the bot with a fake token) and «a process refuses a database behind
its journal» (backend and worker, `docker compose run` of their own prod command).

`up --wait` is no oracle for a service without a healthcheck (bot, worker, web until #65): it
reports «started» the moment the container runs. The oracles are `docker compose ps`,
`docker inspect`, the health and page probes, and the worker's ready line
([worker-deploy.md](worker-deploy.md)).

On a host reboot every service comes back by its restart policy, `postgres` and `redis` included.
`depends_on` is not honoured there: a backend or worker that starts before Postgres fails its
schema check, exits 1 and is restarted until the database answers.

## Log rotation

Each container keeps at most three files of 10 MB (≤ 30 MB per service, ≤ 210 MB for the seven).
`docker compose logs` reads only what is left. The setting changes a container's configuration,
so it applies when the container is recreated.

## HTTPS

[`deploy/Caddyfile`](../deploy/Caddyfile) is the site block of the host's `/etc/caddy/Caddyfile`,
kept here as an example; the live file is the source and a change there is copied back. Caddy gets
and renews the certificate itself. Checking a copy without touching the host:

```bash
docker run --rm -i caddy:2.6.2 sh -c 'cat > /tmp/C && caddy validate --config /tmp/C --adapter caddyfile' < deploy/Caddyfile
```

On the host: `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo
systemctl reload caddy`.

`trustProxy` is not set in the backend or `web`: behind Caddy, `ip` in the staff login's
`audit_log` rows is `127.0.0.1`. Nothing keys on it.

## Switching the pilot (owner's steps, once)

The agent does not run these; each is an SSH command from the owner's machine.

1. **Before**: a baseline of memory and a read of the server's own files.

   ```bash
   ssh deploy@185.249.152.35 'cd /opt/binarius && free -m && swapon --show && ps -eo pid,ppid,rss,comm,args --sort=-rss | head -25 && docker stats --no-stream && docker compose version && cat compose.override.yaml && grep -n "compose\|COMPOSE" "$(command -v binarius-deploy)" && cat /etc/caddy/Caddyfile'
   ```

   Anything in `compose.override.yaml` other than log rotation goes into `compose.prod.yaml` by a
   PR first. `binarius-deploy` must neither pass `-f` nor set `COMPOSE_FILE` itself. The live
   Caddyfile is compared with `deploy/Caddyfile`.
2. **The usual deploy** of the merged ref, still on the dev commands (the image now carries the
   bundles):

   ```bash
   ssh deploy@185.249.152.35 'cd /opt/binarius && docker compose stop bot && binarius-deploy main'
   ```

3. **The switch** — a few seconds without service: all seven containers are recreated (restart
   policy and log driver change for `postgres` and `redis` too); the data stays on the volumes.

   ```bash
   ssh deploy@185.249.152.35 'cd /opt/binarius \
     && cp .env .env.bak-pre-146 \
     && printf "\n# the prod profile (docs/deploy.md)\nCOMPOSE_FILE=compose.yaml:compose.prod.yaml\n" >> .env \
     && mv compose.override.yaml "$HOME/compose.override.yaml.bak-pre-146" \
     && docker compose config -q \
     && docker compose stop bot \
     && docker compose up -d --wait \
     && docker compose ps --format "{{.Service}} {{.Command}} {{.Status}}"'
   ```

   Expected: four `node apps/<app>/dist/index.js` lines `Up`, the backend `(healthy)`, `migrate`
   `Exited (0)`.
4. **Checks**:

   ```bash
   ssh deploy@185.249.152.35 'cd /opt/binarius && curl -fsS 127.0.0.1:3000/health && curl -fsS -o /dev/null -w "%{http_code}\n" https://binarius.salescreativesads.com/admin/login && for s in backend trading-worker web bot; do printf "%s: " $s; docker compose exec -T $s ps -o comm= | sort | tr "\n" " "; echo; done && docker inspect -f "{{.Name}} {{.HostConfig.RestartPolicy.Name}} {{.HostConfig.LogConfig.Config}}" $(docker compose ps -q)'
   ```

   `ok`, `200`, `docker-init node ps` for each app, `unless-stopped` and `max-file:3 max-size:10m`
   for every container.
5. **Memory**, after about ten idle minutes, with the baseline's command:

   ```bash
   ssh deploy@185.249.152.35 'free -m && swapon --show && ps -eo pid,ppid,rss,comm,args --sort=-rss | head -25 && docker stats --no-stream && vmstat 1 5'
   ```

   Compared with the table in #146: the `pnpm` and `tsx watch` rows are gone, one `node` per
   service is left; the goal is a pilot out of swap at idle. The result goes into #146 as a
   comment.
6. **A dead process ends its container**, without touching the live bot (a `run` container has no
   restart and is removed; a refused `getMe` never polls, so no 409):

   ```bash
   ssh deploy@185.249.152.35 'cd /opt/binarius && docker compose run --rm --no-deps -e TELEGRAM_BOT_TOKEN=bad bot; echo "exit=$?"'
   ```

   Expected: the line `long polling stopped with an error`, then `exit=1`.

After the switch every deploy stays `docker compose stop bot && binarius-deploy <ref>`: the
script's `docker compose build migrate` builds the image with its bundles.

## Rollback

Remove the `COMPOSE_FILE` line from the server's `.env` (or restore `.env.bak-pre-146`) and run
`docker compose up -d`: the same image still carries `pnpm`, `tsx` and the sources, so the dev
commands run again. Log rotation goes with it unless `compose.override.yaml` is put back.

## A prod-shaped run on a laptop

The owner's check, not part of any automated step:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d --build --wait
docker compose -f compose.yaml -f compose.prod.yaml ps --format '{{.Service}} {{.Command}} {{.Status}}'
docker compose -f compose.yaml -f compose.prod.yaml down
```

Without `-v` the volumes are kept; the dev stack started afterwards uses the same ones.
