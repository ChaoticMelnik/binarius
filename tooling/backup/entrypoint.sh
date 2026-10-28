# The backup image's commands (docs/backups.md -> The service). `docker compose exec` bypasses the
# ENTRYPOINT, so the image also has backup-now, restore-check, restore and fetch-env on its PATH,
# each a wrapper that calls this script.
set -eu
here="$(dirname "$0")"
. "$here/lib.sh"

# A run immediately (every container start is a backup, so a deploy's `up --wait` checks the
# whole path), then one at the top of every hour; on Sundays at 03 UTC the restore drill after
# it. A failed run does not end the loop: its signals are the ping and the healthcheck. Each run
# is waited for in the background, so a SIGTERM ends the container at once; an upload cut off
# that way leaves no finished object.
loop() {
  trap 'exit 0' INT TERM
  while :; do
    sh "$here/backup.sh" &
    wait $! || true
    if [ "$(date -u +%u%H)" = 703 ]; then
      if [ -n "${BACKUP_AGE_IDENTITY:-}" ]; then
        sh "$here/restore-check.sh" &
        wait $! || true
      else
        log info 'restore-check skipped: no BACKUP_AGE_IDENTITY'
      fi
    fi
    sleep "$(seconds_until_next_hour "$(date -u +%s)")" &
    wait $! || true
  done
}

command="${1:-loop}"
if [ "$#" -gt 0 ]; then
  shift
fi
case "$command" in
  loop) loop ;;
  backup-now) exec sh "$here/backup.sh" ;;
  restore-check) exec sh "$here/restore-check.sh" ;;
  restore) exec sh "$here/restore.sh" "$@" ;;
  fetch-env) exec sh "$here/fetch-env.sh" "$@" ;;
  age-keygen) exec age-keygen "$@" ;;
  *)
    printf 'usage: %s\n' 'loop | backup-now | restore-check | restore <run> | fetch-env <run> | age-keygen' >&2
    exit 64
    ;;
esac
