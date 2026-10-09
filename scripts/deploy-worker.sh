#!/usr/bin/env bash
# Replaces the running trading-worker container with one built from the current image, with an
# overlap (#95, docs/worker-deploy.md): the new container starts and takes jobs first, then the old
# one drains and gives up its socket leases. Run it from the checkout after `docker compose build`
# and the migrations.
#
# Exit codes: 0 the new worker runs alone (or none ran and a plain `up -d` started one);
# 1 the new worker never logged ready: it was removed and the old one runs untouched; or a command
# failed under set -e: the trap printed the stage and every container with its state
# (docs/worker-deploy.md -> Exit codes);
# 2 refused, nothing changed: two or more workers run, a container besides the running one exists
# in any state, or READY_TIMEOUT_S is not a positive integer.
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

list_containers() {
  local id
  for id in "$@"; do
    say "  $id $(docker inspect -f '{{.State.Status}} {{.Image}}' "$id")"
  done
}

running=()
while IFS= read -r id; do running+=("$id"); done < <(container_ids --status running)
all=()
while IFS= read -r id; do all+=("$id"); done < <(container_ids -a)

case "${#running[@]}" in
  0)
    if ((${#all[@]} > 0)); then
      say "stopped containers found: ${all[*]}; compose reconciles them to one running container"
    fi
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

leftovers=()
for id in "${all[@]}"; do
  if [[ "$id" != "$old" ]]; then leftovers+=("$id"); fi
done
if ((${#leftovers[@]} > 0)); then
  say "refused: $service containers besides the running one $old:"
  list_containers "${leftovers[@]}"
  say "a previous run left it (an interrupt during the old container's stop, or a failed docker rm); compose would start it on its old image instead of creating a new container"
  say "remove it (docker stop -t $stop_timeout_s <id> if it is not stopped; docker rm <id>), then run again; nothing changed"
  exit 2
fi

say "old container: $old"

stage=overlap
on_exit() {
  local status=$? id
  if [[ "$stage" != done ]]; then
    say "ended at stage '$stage' (exit $status); $service containers now (id, state, image):"
    while IFS= read -r id; do list_containers "$id"; done < <(container_ids -a)
    say "the next run refuses while a second container exists in any state (docker stop -t $stop_timeout_s <id> if it runs; docker rm <id>), starts one with a plain up -d when none runs, and deploys normally with exactly one running; two running workers are safe (docs/worker-deploy.md)"
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" up -d --no-deps --no-recreate --scale "$service=2" "$service"

new_ids=()
while IFS= read -r id; do
  existed=false
  for before in "${all[@]}"; do
    if [[ "$id" == "$before" ]]; then existed=true; fi
  done
  if [[ "$existed" != true ]]; then new_ids+=("$id"); fi
done < <(container_ids -a)
case "${#new_ids[@]}" in
  0)
    stage=done
    say "compose created no second $service container; the old one runs untouched"
    exit 1
    ;;
  1) ;;
  *)
    stage=done
    say "unexpected: ${#new_ids[@]} new $service containers:"
    list_containers "${new_ids[@]}"
    say "none removed; the next run refuses until an operator removes all but one"
    exit 1
    ;;
esac
new="${new_ids[0]}"
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
  read -r is_running started_at <<<"$(docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' "$new")"
  if [[ "$is_running" != true ]]; then
    docker logs --tail 20 "$new" 2>&1 | sed 's/^/deploy-worker:   /' || true
    rollback "the new container exited before it was ready"
  fi
  # grep without -q reads to EOF: -q exits on the first match and docker logs then dies of SIGPIPE,
  # which pipefail turns into a miss
  if docker logs --since "$started_at" "$new" 2>&1 | grep -F "$ready_line" >/dev/null; then
    ready=true
    break
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
