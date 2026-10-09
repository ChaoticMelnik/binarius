#!/usr/bin/env bash
# Replaces the running trading-worker container with one built from the current image, with an
# overlap (#95, docs/worker-deploy.md): the new container starts and takes jobs first, then the old
# one drains and gives up its socket leases. Run it from the checkout after `docker compose build`
# and the migrations.
#
# Exit codes: 0 the new worker runs alone (or none ran and a plain `up -d` started one);
# 1 the new worker never logged ready, it was removed and the old one runs untouched;
# 2 refused: more than one worker runs already, an operator decides which one stays.
#
# Knobs: READY_TIMEOUT_S (default 120), COMPOSE (default "docker compose").
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

read -r -a compose <<<"${COMPOSE:-docker compose}"
ready_timeout_s="${READY_TIMEOUT_S:-120}"
service=trading-worker
# equals stop_grace_period in compose.yaml
stop_timeout_s=40
# printed by createWorker().start() once both consumers take jobs (worker.ts WORKER_READY_MSG)
ready_line='"msg":"trading-worker started"'

say() { printf 'deploy-worker: %s\n' "$*"; }

if ! [[ "$ready_timeout_s" =~ ^[1-9][0-9]*$ ]]; then
  say "READY_TIMEOUT_S must be a positive integer, got '$ready_timeout_s'; nothing changed"
  exit 2
fi

container_ids() {
  local id
  while IFS= read -r id; do
    if [[ -n "$id" ]]; then printf '%s\n' "$id"; fi
  done < <("${compose[@]}" ps -q "$@" "$service")
}

running=()
while IFS= read -r id; do running+=("$id"); done < <(container_ids --status running)

case "${#running[@]}" in
  0)
    say "no running $service: starting one with a plain up -d"
    "${compose[@]}" up -d "$service"
    say "done: $service started without an overlap"
    exit 0
    ;;
  1) ;;
  *)
    say "refused: ${#running[@]} running $service containers (${running[*]})"
    say "a previous run did not finish; stop all but one (docker stop -t $stop_timeout_s <id>; docker rm <id>), then run again"
    exit 2
    ;;
esac

old="${running[0]}"
say "old container: $old"

stage=overlap
on_exit() {
  local status=$?
  if [[ "$stage" != done ]]; then
    say "interrupted at stage '$stage' (exit $status); running $service containers now:"
    container_ids --status running | sed 's/^/deploy-worker:   /'
    say "two running workers are safe (docs/worker-deploy.md); while two run, the next run refuses"
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" up -d --no-deps --no-recreate --scale "$service=2" "$service"

new=""
while IFS= read -r id; do
  if [[ "$id" != "$old" ]]; then new="$id"; fi
done < <(container_ids -a)
if [[ -z "$new" ]]; then
  stage=done
  say "compose created no second $service container; the old one runs untouched"
  exit 1
fi
say "new container: $new; waiting up to ${ready_timeout_s}s for its ready line"

rollback() {
  stage=rollback
  say "rollback: $1; stopping and removing the new container $new"
  docker stop -t "$stop_timeout_s" "$new" >/dev/null || true
  docker rm "$new" >/dev/null
  stage=done
  say "rolled back: the old container $old runs untouched"
  exit 1
}

ready=false
for ((waited = 0; waited < ready_timeout_s; waited++)); do
  if docker logs "$new" 2>&1 | grep -qF "$ready_line"; then
    ready=true
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$new")" != true ]]; then
    docker logs --tail 20 "$new" 2>&1 | sed 's/^/deploy-worker:   /' || true
    rollback "the new container exited before it was ready"
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs --tail 20 "$new" 2>&1 | sed 's/^/deploy-worker:   /' || true
  rollback "no ready line within ${ready_timeout_s}s"
fi
say "new container ready"

stage=stop-old
say "stopping the old container (SIGTERM, up to ${stop_timeout_s}s for its drain)"
docker stop -t "$stop_timeout_s" "$old" >/dev/null
shutdown_lines="$(docker logs "$old" 2>&1 | grep -E '"msg":"(shutting down|shutdown: [^"]*)"' || true)"
old_exit="$(docker inspect -f '{{.State.ExitCode}}' "$old")"
docker rm "$old" >/dev/null

stage=scale-down
"${compose[@]}" up -d --no-deps --no-recreate --scale "$service=1" "$service"
stage=done

say "the old container's shutdown (exit code $old_exit):"
printf '%s\n' "$shutdown_lines" | sed 's/^/deploy-worker:   /'
if grep -qF 'active jobs did not finish' <<<"$shutdown_lines"; then
  say "warning: the old worker's drain overran; its submits in flight are resolved by the new worker's sweeper and reconciliation (docs/worker-deploy.md)"
fi
say "done: $service runs as $new"
