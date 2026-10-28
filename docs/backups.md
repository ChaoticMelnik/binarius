# Postgres backups

How the database is backed up every hour to an external bucket, how a backup is checked by
restoring it, and how one is restored for real. Issue #143; the restore runbook of #145 is the
section [Restoring](#restoring).

## What is backed up, and what is not

- **The whole Postgres database**, every hour: `pg_dump --format=custom` of `$POSTGRES_DB` — every
  table of `public`, the migration journal `drizzle.__drizzle_migrations`, the CHECKs, indexes,
  append-only triggers and functions. The recovery point is at most an hour old (RPO ≤ 1 h).
- **The server's `.env`**, with every run: the bot tokens, the broker client secret and the
  `TOKEN_ENCRYPTION_KEY` the stored OAuth tokens are encrypted with. A database without that key
  holds tokens nobody can decrypt.
- **Not Redis.** Its BullMQ queues are derived state: the publisher publishes the `pending`
  `outbox_events` rows again, and the sweeper puts lost jobs back
  ([trade-intent-transport.md](trade-intent-transport.md)). A restore empties Redis on purpose.
- **Not the host's files**: `/etc/caddy/Caddyfile` (its example is
  [deploy/Caddyfile](../deploy/Caddyfile)), `binarius-deploy`, the Docker installation.

What a restore loses is the window since the run it restores:

- **Trades in the window.** An intent the restored database does not have was still sent to the
  broker; its reservation and its outcome are gone, and the reconciliation (#89/#90) only looks at
  intents it knows.
- **OAuth refresh tokens exchanged in the window.** The restored refresh token is already spent,
  so its next refresh fails and the link is revoked (Rule 12): that user links the account again.
- **Everything else written in the window**: sign-ups, sessions, notifications, staff actions.

## The objects

Every run is one prefix with two objects, both encrypted with [age](https://age-encryption.org)
to the owner's public key:

```text
<BACKUP_REMOTE_PATH>/hourly/binarius-<YYYYmmddTHHMMSSZ>/binarius.dump.age   pg_dump -Fc | age
<BACKUP_REMOTE_PATH>/hourly/binarius-<YYYYmmddTHHMMSSZ>/env.age             the server .env | age
<BACKUP_REMOTE_PATH>/daily/binarius-<YYYYmmddTHHMMSSZ>/…                     the day's copy, restored like an hourly run
```

- **Streamed.** `pg_dump | age | rclone rcat`: the server's disk (about 1.5 GB free on the pilot)
  holds only a byte counter, a fifo and the stages' exit codes, in a temporary directory.
- **Verified.** The bytes age wrote are counted on their way to rclone, and the stored object's
  size (`rclone lsl`) must equal them; a dump object must also be at least 512 bytes (an empty
  age stream is 200). A run that failed before both objects were stored is removed
  (`rclone purge`), so a truncated dump never becomes the latest run.
- **The day's copy.** The first run of a UTC day is copied into `daily/` (server-side on B2),
  whatever minute the container started at. A day counts as copied when some
  `daily/binarius-<that date>…/` holds `binarius.dump.age`, and `env.age` too when
  `BACKUP_ENV_FILE` is set; later runs of that day then skip the copy. A copy that fails is removed
  (`rclone purge`) and the run fails as `daily`, so the next run of the day copies it again.
- **Retention.** After a stored run, objects older than 7 days are deleted from `hourly/` and
  older than 30 days from `daily/` — about 168 hourly runs and 30 daily ones. A failed run prunes
  nothing.
- **Deleted is hidden, on B2.** rclone's delete hides a B2 file version; the bucket's lifecycle
  rule keeps hidden versions 14 days (Setting it up, step 1). That protects against an ordinary
  prune, not against a leaked key: the server's key has `deleteFiles`, and rclone's `purge` on B2
  deletes every version at once. A key with delete rights on the server is an accepted risk.

## The service

`backup` in `compose.yaml`, under the profile `backup`: off unless `COMPOSE_PROFILES=backup` is
in `.env` (the server's) or the shell. Its own image from [tooling/backup](../tooling/backup)
(`FROM postgres:18-alpine`, the same image as the `postgres` service, plus `age`, `rclone` and
`curl`), tagged `<project>-backup`. `pull_policy: build` makes every `docker compose up` rebuild
it from the cache, so `binarius-deploy` keeps it current without building it itself. Under the
prod pair its log rotates like every other service's ([deploy.md](deploy.md)).

- **The loop** (the default command): a run at once — so every start of the container, every
  deploy that recreates it included, is a backup — then one at the top of every hour; on Sundays
  in the 03:00 UTC run, the restore drill `restore-check` after the backup. A failed run does not
  end the loop. A SIGTERM ends the container at once. A run cut off during the dump's upload
  leaves no finished dump, and the next hour covers it; one cut off later can leave a dump without
  `env.age` or part of the day's copy, which the next run of the day copies again.
- **The healthcheck**: a successful run touches `/run/backup/ok`; the container is `healthy`
  while that file is younger than 130 minutes — two hourly runs and a margin — and `unhealthy`
  once backups stop. `start_period: 300s` covers the run every start makes. A deploy's
  `up --wait` fails on `backup` in two cases:
  - after a recreate, it waits for the first run and fails about 390 s later (`start_period` 300
    and 3 × 30 s) when that run fails;
  - once backups have been failing for more than 130 minutes, the container is `unhealthy` and
    the `up --wait` of **every** deploy fails, recreated or not.

  Either way the apps are up: read `docker compose logs backup`.
- **The ping**: with `BACKUP_PING_URL` set, a stored run pings it, a failed run or a failed
  drill pings `<url>/fail`. The drill never pings success: it shares the check with the hourly
  runs, and an "up" from it would hide a backup that failed an hour earlier. A failed ping is a
  warning, not a failed run.
- **Secrets are never printed**: no script echoes a key, the identity or the `.env`, and none
  runs under `set -x`. The ping URL is not printed either, and it reaches `curl` on stdin, not on
  the command line the host's `ps` shows. The one exception is `fetch-env`,
  whose purpose is to print the `.env`.

The commands, as `docker compose exec -T backup <command>` on the running container or
`docker compose --progress quiet run --rm backup <command>` without one (`--progress quiet`:
`run` builds the image first and would print the build log on stdout):

| command | does | prints | exit |
|---|---|---|---|
| `backup-now` | one run, as the loop does | `backup ok: <run>, dump N bytes, env M bytes\|env none, daily copied\|daily exists, T s` | 0 |
| | | `backup failed: <config\|env\|postgres\|dump\|encrypt\|upload\|verify\|daily\|prune> (<detail>)` | 1 |
| `restore-check` | the drill (below) on the latest run | `rows <table> <n>` per table, then `restore-check ok: <run>, <n> tables, schema identical, migrations <count>, env ok\|env none` | 0 |
| | | `restore-check skipped: the database is N bytes, above M …` | 0 |
| | | `restore-check failed: <config\|postgres\|no-backups\|stale\|env\|create\|restore\|schema\|migrations\|rows> (<detail>)` | 1 |
| `restore <run>` | replaces the live database with the run (Restoring) | `restore ok: <run> now serves as <db>; the previous database is <db>_before_restore_<time> (drop it by hand when done)` | 0 |
| | | `restore refused: <confirm …\|N connections to <db> …\|usage …>` | 1 |
| | | `restore failed: <config\|postgres\|find\|not-found\|create\|restore\|rename> (<detail>)` | 1 |
| `fetch-env <run>` | prints the run's `.env` | the file, on stdout | 0 |
| | | on stderr: `fetch-env failed: <config\|find\|not-found\|fetch> (<detail>)` | 1 |
| | | on stderr: the usage | 64 |
| `age-keygen` | a new age key pair | the key file | 0 |

An unknown command prints the usage and exits 64. A failure's detail names the stage and its exit
code, or for `config` the variable that is missing.

**The drill** (`restore-check`). The live database must be at most
`BACKUP_RESTORE_CHECK_MAX_BYTES` (500 MB by default), because the drill restores onto the same
volume; above it the drill prints `skipped` and is done on another machine (Restoring). Then:

1. the latest run under `hourly/` must exist (`no-backups`) and be younger than 130 minutes
   (`stale`);
2. its `env.age` must decrypt and hold one non-empty `TOKEN_ENCRYPTION_KEY=` line, when
   `BACKUP_ENV_FILE` is set (`env`);
3. its dump is restored into the scratch database `<db>_restore_check` (`pg_restore
   --exit-on-error --no-owner --no-privileges`);
4. **the schema**: the live schema (`pg_dump -s`) is loaded into a second scratch database,
   `<db>_restore_check_schema`, without data, and the `pg_dump -s` of the two scratch databases
   must be equal byte for byte (the `\restrict` lines and the version header aside). The restored
   schema is not compared with the live database itself: Postgres prints an expression from its
   stored tree, and a restore parses the text again — the `WHEN` of `bonus_rules_immutable`
   (migration 0059) comes back with its nested `OR`s flattened. What this check says is that the
   restored schema equals the live one as loaded from its own `pg_dump -s`: a lost table, column,
   index, CHECK, trigger or function, or a changed body, is a difference; an object `pg_dump`
   itself reproduces wrongly would be wrong on both sides and is not;
5. the migration journal: the same count and the same latest `created_at` as the live one;
6. a row count per table of `public`, printed as `rows <table> <n>`.

Both scratch databases are dropped on every exit, and at the start of the next drill should one
survive a `SIGKILL`.

## Configuration

All of it in the server's `.env`; the service forwards each variable only when set, and the
scripts refuse an empty or missing required one by name (`backup failed: config (<NAME>)`), so
Compose itself never refuses.

| variable | read by | required | example |
|---|---|---|---|
| `COMPOSE_PROFILES` | Compose | to run the service at all | `backup` |
| `BACKUP_REMOTE_PATH` | every command | yes | `binarius-backups-<suffix>/pilot` (b2: `<bucket>/<prefix>`); `/tmp/backups` (local) |
| `RCLONE_CONFIG_BACKUP_TYPE` | every command | yes | `b2` on the pilot; `local` in CI and by hand |
| `RCLONE_CONFIG_BACKUP_ACCOUNT` | every command | for `b2` | the B2 application key's `keyID` |
| `RCLONE_CONFIG_BACKUP_KEY` | every command | for `b2` | the B2 `applicationKey` |
| `BACKUP_AGE_RECIPIENT` | `backup-now`, the loop | yes | `age1…` |
| `BACKUP_AGE_IDENTITY` | `restore-check`, `restore`, `fetch-env` | for those; without it the loop skips the drill | `AGE-SECRET-KEY-1…` |
| `BACKUP_ENV_FILE` | Compose (the mount), every run | no; unset, no `env.age` is stored | `/opt/binarius/.env` |
| `BACKUP_PING_URL` | every run, the drill | no | `https://hc-ping.com/<uuid>` |
| `BACKUP_RESTORE_CHECK_MAX_BYTES` | `restore-check` | no | `524288000` |

The remote is always named `backup`, and rclone reads it from `RCLONE_CONFIG_BACKUP_*` alone (no
config file). The database connection is the `postgres` service's own user, password and
database. `BACKUP_ENV_FILE` is the host path Compose mounts read-only at `/run/backup/env`; when
it is set, a run refuses before `pg_dump` unless that file is non-empty
(`backup failed: env (…)`). The container runs as root, because the server's `.env` is
`chmod 600`. The image sets rclone's B2 chunk to 5 MiB and one upload at a time: rclone's
defaults buffer 4 × 96 MiB of a streamed upload, on a host with 961 MB of memory.

## Setting it up on the pilot

The owner's steps; the agent does not run them.

0. **Room for it.** At least 400 MB free after the image (~110 MB on top of `postgres:18-alpine`):

   ```bash
   ssh deploy@185.249.152.35 'cd /opt/binarius && df -h / && docker system df && docker compose exec -T postgres psql -U binarius -d binarius -Atc "select pg_size_pretty(pg_database_size(current_database()))"'
   ```

   A database above 500 MB means the weekly drill on the server prints `skipped`; the drill is
   then step 8.
1. **The bucket.** In the Backblaze console: Create Bucket — `binarius-backups-<suffix>`,
   Private, Encryption SSE-B2, Object Lock off, in the EU region (check the region in the bucket's
   details). Lifecycle Settings: "Keep prior versions for this number of days: 14". App Keys → Add
   a New Application Key: name `binarius-backup`, access to this bucket only, capabilities
   `listBuckets, listFiles, readFiles, writeFiles, deleteFiles`; note its `keyID` and
   `applicationKey` (shown once).
2. **The ping.** healthchecks.io → New Check: name `binarius backup`, period 1 hour, grace 30
   minutes; an integration (Telegram or email); copy the ping URL `https://hc-ping.com/<uuid>`.
3. **The age key**, on your own machine: `brew install age && age-keygen` (or
   `docker run --rm alpine:3.24 sh -c 'apk add -q age && age-keygen'`). The
   `AGE-SECRET-KEY-1…` line goes into your password manager; `age1…` is the public key.
4. **The server's `.env`** (`ssh deploy@185.249.152.35`, then
   `cd /opt/binarius && cp .env .env.bak-pre-143 && nano .env`), appended:

   ```text
   COMPOSE_PROFILES=backup
   BACKUP_REMOTE_PATH=binarius-backups-<suffix>/pilot
   RCLONE_CONFIG_BACKUP_TYPE=b2
   RCLONE_CONFIG_BACKUP_ACCOUNT=<keyID>
   RCLONE_CONFIG_BACKUP_KEY=<applicationKey>
   BACKUP_AGE_RECIPIENT=age1…
   BACKUP_AGE_IDENTITY=AGE-SECRET-KEY-1…
   BACKUP_ENV_FILE=/opt/binarius/.env
   BACKUP_PING_URL=https://hc-ping.com/<uuid>
   ```

   The line `COMPOSE_FILE=compose.yaml:compose.prod.yaml` already there stays; the two work
   together.
5. **The start**, after the usual deploy of the merge
   (`docker compose stop bot && binarius-deploy <sha>`):

   ```bash
   ssh deploy@185.249.152.35 'cd /opt/binarius && docker compose config -q && docker compose up -d --wait backup'
   ```

   From then on every `binarius-deploy` rebuilds and starts `backup` itself.
6. **The check**: `docker compose ps backup` is `healthy`; `docker compose logs --no-log-prefix
   backup` has `backup ok: binarius-…, … T s` with T below 300; `docker compose exec -T backup
   restore-check` prints `restore-check ok: …`; the healthchecks.io check is "up"; the bucket has
   `pilot/hourly/binarius-…/` with two files; `docker stats --no-stream` during the next hourly
   run shows `backup` below 100 MB.
7. **A drill on your own machine**, once at acceptance and whenever the server's drill prints
   `skipped`: Restoring → On another machine, then `restore-check` there.

## Restoring

`restore <run>` replaces the live database with one run:

- it refuses unless `BACKUP_RESTORE_CONFIRM` equals the run's name, and while anything is
  connected to the live database;
- it restores into `<db>_restored`, then renames, in one transaction, the live database to
  `<db>_before_restore_<YYYYmmddHHMMSS>` and `<db>_restored` to `<db>`. A connection that arrived
  in between makes the rename fail with nothing changed (`restore failed: rename`; `<db>_restored`
  is kept, and the next `restore` starts it over). Should the connection drop during the rename,
  `select datname from pg_database` says which state it is in;
- it never applies the run's `.env`: `fetch-env <run>` prints it, and the live `.env` stays the
  source while it is intact (an older run holds the tokens and keys of its time).

`restore` and `fetch-env` take the run from `hourly/`, and once it is older than 7 days from
`daily/` (30 days, one run a day). The runs with a dump are listed in the bucket, or with
`docker compose exec -T backup sh -c 'rclone lsf -R --files-only --max-depth 3 "backup:$BACKUP_REMOTE_PATH" | grep binarius.dump.age'`,
which prints `hourly/<run>/binarius.dump.age` and `daily/<run>/binarius.dump.age` lines.

### On the pilot

The `.env` with `COMPOSE_FILE` makes every command below run the prod pair.

```bash
ssh deploy@185.249.152.35
cd /opt/binarius
docker compose stop bot backend trading-worker web
docker compose exec -T -e BACKUP_RESTORE_CONFIRM=<run> backup restore <run>
docker compose exec -T redis redis-cli FLUSHALL
docker compose up -d --wait
```

- **Stop all four** first: the backend holds a `LISTEN` connection (#723), and `restore` refuses
  while it is open.
- **`FLUSHALL`** empties the BullMQ queues of jobs the restored database knows nothing about; the
  publisher publishes every `pending` outbox row of the restored database again. It also empties
  the dead-letter queue (#92), which is diagnostics only.
- **The worker registry** (`worker_processes`, #94) comes back as it was at the run: only rows
  with `expires_at > now()` count as live, the restored ones expire by themselves, and the
  heartbeat deletes rows expired longer than `pruneAfterMs` ([worker-capacity.md](worker-capacity.md)).
  Nothing to clean by hand.
- **The replaced database**, once the restored one is confirmed:
  `docker compose exec -T postgres psql -U binarius -d postgres -c 'drop database "binarius_before_restore_<YYYYmmddHHMMSS>"'`.

### On another machine

A checkout of the same commit, and an `.env` with the eight required values, `COMPOSE_PROFILES=backup`,
`BACKUP_REMOTE_PATH`, `RCLONE_CONFIG_BACKUP_*` and `BACKUP_AGE_IDENTITY` (`BACKUP_AGE_RECIPIENT` only
to make backups there too). The fresh `postgres` service has an empty database for `restore` to
replace:

```bash
docker compose up -d --wait postgres
(umask 077 && docker compose --progress quiet run --rm -T backup fetch-env <run> > restored.env)
docker compose --progress quiet run --rm -e BACKUP_RESTORE_CONFIRM=<run> backup restore <run>
docker compose --progress quiet run --rm backup restore-check
```

`restored.env` holds the old server's secrets: `umask 077` makes it readable by its owner alone,
and `-T` keeps a terminal's CRLF out of it. Take what the new server needs into its `.env` and
delete the file. `restore-check` after the restore compares the latest run with what was
just restored, which is the drill; it passes only when `<run>` is the latest run and younger
than 130 minutes (an older run: compare the `rows` of a `restore-check` on the server). The new
server then goes on as in Setting it up, step 4.

## Edge cases

- **The first run on an empty database** (a fresh volume, CI before the migrations) dumps about
  900 bytes and passes; the drill always takes the latest run.
- **A start at 00:30 UTC** copies that run into `daily/`; the 01:00 run finds it.
- **Two runs in the same second** (`backup-now` beside the loop) write the same names, the second
  over the first with the same content; nothing serializes them, and the manual command is only
  for the check and for debugging. The same holds for a manual `restore-check` beside the weekly
  one: they share the scratch databases.
- **A deploy during a run** ends the container at once. A run cut off during the dump's upload
  leaves no finished dump (an unfinished B2 large file, visible in the console), the next hour
  covers the gap, and the healthchecks.io grace of 30 minutes keeps it quiet. One cut off later
  can leave a dump without `env.age` or part of the day's copy, which the next run of the day
  copies again; `fetch-env` of a run without `env.age` answers `not-found`, and a neighbouring
  run's `.env` serves instead.
- **A cut-off day copy** is copied again by the next run of that day. When it was the only run of
  the day, that day's copy stays incomplete, and its hourly run lives 7 days.
- **An hourly dump during a deploy's migration.** `pg_dump` holds `ACCESS SHARE` on every table
  for the whole dump: an `ALTER TABLE` waits for its end, and the application's queries on that
  table wait behind the `ALTER`. The window is the dump's duration, the `T s` of `backup ok`;
  above 60 s, deploys go outside `:00`–`:0T`.
- **A deploy's `up --wait` waits for the first run** whenever `backup` is recreated: a change of
  `tooling/backup`, or the build-cache prune (`--max-used-space 300MB`) having dropped the
  `apk add` layer. A B2 failure at that moment fails the deploy's `up --wait` about 390 s later
  with the apps already running. Once backups have been failing for more than 130 minutes, every
  deploy's `up --wait` fails the same way, even without a recreate. Either way: read
  `docker compose ps` and `docker compose logs backup`, leave the apps alone.
- **A drill right after a deploy that migrated** compares a run from before the migration with
  the migrated live database and fails as `schema` or `migrations`; the next hourly run fixes it.
  The weekly drill runs straight after its own hourly run.
- **`BACKUP_AGE_IDENTITY` that does not pair with `BACKUP_AGE_RECIPIENT`** fails the drill (`env`
  or `restore`), which is why the setup ends with a manual `restore-check`.
- **`COMPOSE_PROFILES=backup` without the variables**: the container starts, every run prints
  `backup failed: config (BACKUP_REMOTE_PATH)`, the healthcheck never passes and a deploy's
  `up --wait` fails after `start_period`.
- **Traffic**: 24 dumps a day; at 1 GB of database (a dump of roughly 15 %), about 3.6 GB a day
  out of the server.
- **Memory**: rclone holds about 5 MiB of chunk and its 16 MiB buffer; `pg_dump` and `pg_restore`
  run in the `backup` container, the drill loads the same Postgres once a week.

## Tests

- `tooling/backup/backup.test.ts` (the unit project of `pnpm check`) runs every script under `sh`
  against stand-ins for `pg_dump`, `pg_restore`, `psql`, `pg_isready`, `age`, `rclone` (a
  directory tree as the remote) and `curl`: the order of the calls, every failure and its line,
  the purge of a partial run and of a failed day's copy, the pings, the drill's two scratch
  databases, `restore`'s refusals and its one transaction, `restore` and `fetch-env` of a run kept
  only in `daily/`, and the pins of the service in `compose.yaml`, `.env.example` and the
  Dockerfile. On CI the scripts run under dash, on macOS under bash as `sh`, in the image under
  busybox ash.
- The CI compose job runs the service on the real Postgres 18, `pg_dump`, `age` and `rclone`
  (remote `local`): the run at start, `backup-now`, `restore-check` of the first-run data
  (`rows staff 1`), `restore` into the live database, with the backend, the worker and `web`
  started again on it, and `fetch-env` of the start's run once its `hourly/` copy is removed, so
  only `daily/` serves it. The weekly schedule of the loop is not tested: its evidence is the
  pilot's log, one `restore-check ok` a week.
- `tooling/compose-prod.test.ts` P3 holds the service's log rotation in `compose.prod.yaml`.

With CD (#147), `up -d --build --wait` reads `COMPOSE_PROFILES` from the server's `.env` and starts
`backup` like the rest, without a step of its own.

## Checking it by hand

With the stack up (README → Docker dev environment) and, in `.env`:

```text
COMPOSE_PROFILES=backup
RCLONE_CONFIG_BACKUP_TYPE=local
BACKUP_REMOTE_PATH=/tmp/backups
```

```bash
out="$(docker compose --progress quiet run --rm --no-deps -T backup age-keygen)"
printf 'BACKUP_AGE_RECIPIENT=%s\nBACKUP_AGE_IDENTITY=%s\n' \
  "$(printf '%s\n' "$out" | sed -n 's/^# public key: //p')" \
  "$(printf '%s\n' "$out" | grep '^AGE-SECRET-KEY-')" >> .env
docker compose up -d --wait backup
docker compose logs --no-log-prefix backup
docker compose exec -T backup backup-now
docker compose exec -T backup restore-check
docker compose stop bot backend trading-worker web
docker compose exec -T -e BACKUP_RESTORE_CONFIRM=<run> backup restore <run>
docker compose up -d --wait
```

`<run>` is the name `backup-now` printed. The backups live inside the container
(`/tmp/backups`) and go with it. The CI compose job runs the same commands on every pull request.
