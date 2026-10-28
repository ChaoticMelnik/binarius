# One backup run (docs/backups.md -> The service): pg_dump -> age -> the remote, the server's .env
# beside it, the first run of a day copied into daily/, then the old runs pruned. Nothing touches
# a local disk but a byte counter. Prints one line on stdout: `backup ok: ...` or
# `backup failed: <step> (...)`; a failure exits 1 and pings <BACKUP_PING_URL>/fail.
set -eu
. "$(dirname "$0")/lib.sh"

started="$(date -u +%s)"

partial=''

# A run that failed before both of its objects were stored is removed, so restore-check and
# restore never take a truncated dump for the latest run.
fail() {
  printf 'backup failed: %s (%s)\n' "$1" "$2"
  if [ -n "$partial" ]; then
    rclone purge "$partial" || log warn "the partial run was not removed (exit $?)"
  fi
  ping fail
  exit 1
}

missing="$(missing_remote_var)"
if [ -z "$missing" ]; then
  missing="$(missing_var BACKUP_AGE_RECIPIENT)"
fi
if [ -n "$missing" ]; then
  fail config "$missing"
fi

if [ -n "${BACKUP_ENV_FILE:-}" ] && { [ ! -f "$BACKUP_ENV_MOUNT" ] || [ ! -s "$BACKUP_ENV_MOUNT" ]; }; then
  fail env "BACKUP_ENV_FILE is set, but $BACKUP_ENV_MOUNT is not a non-empty file"
fi

rc=0
pg_isready -q || rc=$?
if [ "$rc" -ne 0 ]; then
  fail postgres "exit $rc"
fi

s="$(mktemp -d)"
trap 'rm -rf "$s"' EXIT

run="$(run_name)"
dir="$(remote)/hourly/$run"

# stdin -> age -> <object>. The bytes age writes are counted on their way to rclone, so the
# stored object can be compared with what was sent.
upload() {
  rm -f "$s/fifo" "$s/encrypt.rc" "$s/upload.rc" "$s/bytes"
  mkfifo "$s/fifo"
  wc -c < "$s/fifo" | tr -d ' ' > "$s/bytes" &
  counter=$!
  { rc=0; age -r "$BACKUP_AGE_RECIPIENT" || rc=$?; echo "$rc" > "$s/encrypt.rc"; } \
    | tee "$s/fifo" | { rc=0; rclone rcat "$1" || rc=$?; echo "$rc" > "$s/upload.rc"; }
  wait "$counter"
}

# The stages are read from the last one back: a failed rclone kills the stages before it with
# SIGPIPE, while a failed pg_dump leaves the stages after it at 0.
check_upload() {
  for stage in upload encrypt; do
    rc="$(stage_rc "$s/$stage.rc")"
    if [ "$rc" -eq 0 ]; then
      continue
    elif [ -z "$1" ]; then
      fail "$stage" "exit $rc"
    else
      fail "$1" "$stage, exit $rc"
    fi
  done
}

# the stored object's size against the counted bytes, and against a floor
verify() {
  object="${1##*/}"
  floor="$2"
  sent="$(cat "$s/bytes")"
  rc=0
  listing="$(rclone lsl "$1")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail verify "$object, exit $rc"
  fi
  set -- $listing
  stored="${1:-0}"
  if [ "$stored" != "$sent" ]; then
    fail verify "$object: $stored bytes stored, $sent sent"
  fi
  if [ "$stored" -lt "$floor" ]; then
    fail verify "$object: $stored bytes, below $floor"
  fi
}

partial="$dir"
{ rc=0; pg_dump --format=custom || rc=$?; echo "$rc" > "$s/dump.rc"; } | upload "$dir/binarius.dump.age"
check_upload ''
rc="$(stage_rc "$s/dump.rc")"
if [ "$rc" -ne 0 ]; then
  fail dump "exit $rc"
fi
verify "$dir/binarius.dump.age" "$MIN_DUMP_BYTES"
dump_bytes="$(cat "$s/bytes")"

env_summary='env none'
if [ -n "${BACKUP_ENV_FILE:-}" ]; then
  upload "$dir/env.age" < "$BACKUP_ENV_MOUNT"
  check_upload env
  verify "$dir/env.age" 1
  env_summary="env $(cat "$s/bytes") bytes"
fi
partial=''

# The first run of a UTC day is the day's copy, whatever minute the container started at. The
# listing is recursive from the root because a missing daily/ is an error on a local remote.
rc=0
listing="$(rclone lsf --dirs-only -R --max-depth 2 "$(remote)")" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail daily "exit $rc"
fi
if printf '%s\n' "$listing" | grep -q "^daily/binarius-$(date_key "$run")"; then
  daily='daily exists'
else
  rc=0
  rclone copy "$dir" "$(remote)/daily/$run" || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail daily "exit $rc"
  fi
  daily='daily copied'
fi

for tier in "hourly $HOURLY_KEEP_DAYS" "daily $DAILY_KEEP_DAYS"; do
  set -- $tier
  rc=0
  rclone delete --min-age "${2}d" "$(remote)/$1" || rc=$?
  if [ "$rc" -eq 0 ]; then
    rclone rmdirs --leave-root "$(remote)/$1" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    fail prune "$1, exit $rc"
  fi
done

touch "$BACKUP_STATE_DIR/ok"
ping success
printf 'backup ok: %s, dump %s bytes, %s, %s, %s s\n' \
  "$run" "$dump_bytes" "$env_summary" "$daily" "$(($(date -u +%s) - started))"
