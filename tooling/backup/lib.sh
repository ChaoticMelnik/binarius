# Shared by the backup scripts (docs/backups.md). POSIX sh: the image runs them under busybox
# ash, the unit tests under the runner's dash and macOS's bash-as-sh - no pipefail, no `local`,
# no `date -d`. A pipeline's stages report their own exit codes through files instead.

HOURLY_KEEP_DAYS=7
DAILY_KEEP_DAYS=30
# an age stream of an empty input is 200 bytes; a pg_dump -Fc of an empty database is 905 before
# encryption, so anything below this is an object without a body
MIN_DUMP_BYTES=512
# two hourly runs and a margin: the same window as the compose healthcheck's -mmin -130
STALE_AFTER=130m
RESTORE_CHECK_MAX_BYTES_DEFAULT=524288000
# 63 bytes of a Postgres identifier minus the longest suffix, _before_restore_<14 digits>: a longer
# name would be truncated into another database's name
MAX_DATABASE_NAME=33

# test seams: compose sets neither, the tests cannot create /run/backup on their host
BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-/run/backup}"
BACKUP_ENV_MOUNT="${BACKUP_ENV_MOUNT:-/run/backup/env}"

# the NOTICE of every `drop database if exists` is noise in the service's log
PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
export PGOPTIONS

log() {
  printf '%s backup %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >&2
}

# the first required variable that is unset or empty, or nothing
missing_var() {
  for name in "$@"; do
    eval "value=\${$name:-}"
    if [ -z "$value" ]; then
      printf '%s' "$name"
      return 0
    fi
  done
}

# the remote's configuration, which every command needs; the B2 credentials only for type b2
missing_remote_var() {
  missing="$(missing_var BACKUP_REMOTE_PATH RCLONE_CONFIG_BACKUP_TYPE)"
  if [ -z "$missing" ] && [ "$RCLONE_CONFIG_BACKUP_TYPE" = b2 ]; then
    missing="$(missing_var RCLONE_CONFIG_BACKUP_ACCOUNT RCLONE_CONFIG_BACKUP_KEY)"
  fi
  printf '%s' "$missing"
}

remote() {
  printf 'backup:%s' "$BACKUP_REMOTE_PATH"
}

run_name() {
  printf 'binarius-%s' "$(date -u +%Y%m%dT%H%M%SZ)"
}

is_run_name() {
  case "$1" in
    binarius-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) return 0 ;;
    *) return 1 ;;
  esac
}

# the database names are written into SQL as quoted identifiers
is_database_name() {
  case "$1" in
    '' | *[!a-z0-9_]*) return 1 ;;
  esac
  [ "${#1}" -le "$MAX_DATABASE_NAME" ]
}

# binarius-20261009T030000Z -> 20261009
date_key() {
  printf '%s' "$1" | cut -c10-17
}

seconds_until_next_hour() {
  printf '%s' "$((3600 - $1 % 3600))"
}

# success | fail. The URL is never printed: a healthchecks.io ping URL is its own credential.
ping() {
  if [ -z "${BACKUP_PING_URL:-}" ]; then
    return 0
  fi
  url="$BACKUP_PING_URL"
  if [ "$1" = fail ]; then
    url="$url/fail"
  fi
  # the URL goes in on stdin, not in argv: the host's ps shows every container's argv
  printf 'url = "%s"\n' "$url" | curl -fsS -m 10 --retry 2 -o /dev/null -K - \
    || log warn "the $1 ping failed"
}

# BACKUP_AGE_IDENTITY into a file only its owner reads, inside the caller's temporary directory
write_identity() {
  (umask 077 && printf '%s\n' "$BACKUP_AGE_IDENTITY" > "$1")
}

# the exit code a pipeline stage wrote into $1, or 255 when it never wrote one
stage_rc() {
  if [ -s "$1" ]; then
    cat "$1"
  else
    printf '255'
  fi
}

# <dir> <stage>...: the stages of one pipeline in its order. Prints `<stage>, exit N` of the first
# stage that failed other than by 141, else of the first one at 141, else nothing. A stage at 141
# died of SIGPIPE because the one after it stopped reading, so the cause is further down.
failed_stage() {
  d="$1"
  shift
  sigpipe=''
  for stage in "$@"; do
    rc="$(stage_rc "$d/$stage.rc")"
    if [ "$rc" -eq 141 ]; then
      if [ -z "$sigpipe" ]; then
        sigpipe="$stage, exit 141"
      fi
    elif [ "$rc" -ne 0 ]; then
      printf '%s, exit %s' "$stage" "$rc"
      return 0
    fi
  done
  printf '%s' "$sigpipe"
}

# <run> <object>: <remote>/hourly/<run> or <remote>/daily/<run>, the first tier where the run
# holds <object>; nothing when neither does. A failed listing returns its exit code.
find_run() {
  rc=0
  objects="$(rclone lsf --files-only -R --max-depth 3 "$(remote)")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi
  for tier in hourly daily; do
    if printf '%s\n' "$objects" | grep -qx "$tier/$1/$2"; then
      printf '%s/%s/%s' "$(remote)" "$tier" "$1"
      return 0
    fi
  done
}

# rclone cat <object> | age -d | <the rest of the pipeline, on stdout>; the stages' codes go to
# <dir>/cat.rc and <dir>/decrypt.rc
fetch_decrypted() {
  { rc=0; rclone cat "$1" || rc=$?; echo "$rc" > "$2/cat.rc"; } \
    | { rc=0; age -d -i "$3" || rc=$?; echo "$rc" > "$2/decrypt.rc"; }
}
