# Restores one run into the live database (docs/backups.md -> Restoring): into
# <PGDATABASE>_restored first, then two renames in one transaction, so the database it replaces
# stays as <PGDATABASE>_before_restore_<time> until the owner drops it. Refuses without
# BACKUP_RESTORE_CONFIRM=<run> and while anything is connected to the live database.
set -eu
. "$(dirname "$0")/lib.sh"

run="${1:-}"
s=''
restored=''

cleanup() {
  if [ -n "$restored" ]; then
    psql -X -q -d postgres -c "drop database if exists \"$restored\" with (force)" \
      || log warn "$restored was not dropped"
  fi
  if [ -n "$s" ]; then
    rm -rf "$s"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

refuse() {
  printf 'restore refused: %s\n' "$1"
  exit 1
}

fail() {
  printf 'restore failed: %s (%s)\n' "$1" "$2"
  exit 1
}

if ! is_run_name "$run"; then
  refuse 'usage: restore binarius-<YYYYmmddTHHMMSSZ> (the run, as the bucket lists it)'
fi
if [ "${BACKUP_RESTORE_CONFIRM:-}" != "$run" ]; then
  refuse "confirm: set BACKUP_RESTORE_CONFIRM=$run to replace the live database with it"
fi
missing="$(missing_remote_var)"
if [ -z "$missing" ]; then
  missing="$(missing_var BACKUP_AGE_IDENTITY PGDATABASE)"
fi
if [ -n "$missing" ]; then
  fail config "$missing"
fi
if ! is_database_name "$PGDATABASE"; then
  fail config 'PGDATABASE is not [a-z0-9_]'
fi

rc=0
connections="$(psql -X -At -d postgres -c \
  "select count(*) from pg_stat_activity where datname = '$PGDATABASE'")" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail postgres "exit $rc"
fi
if [ "$connections" -ne 0 ]; then
  refuse "$connections connections to $PGDATABASE - stop bot, backend, trading-worker and web first"
fi

target="${PGDATABASE}_restored"
previous="${PGDATABASE}_before_restore_$(date -u +%Y%m%d%H%M%S)"
s="$(mktemp -d)"
identity="$s/identity"
write_identity "$identity"

restored="$target"
rc=0
psql -X -q -v ON_ERROR_STOP=1 -d postgres \
  -c "drop database if exists \"$target\" with (force)" \
  -c "create database \"$target\"" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail create "exit $rc"
fi

fetch_decrypted "$(remote)/hourly/$run/binarius.dump.age" "$s" "$identity" \
  | { rc=0; pg_restore --exit-on-error --no-owner --no-privileges -d "$target" || rc=$?; echo "$rc" > "$s/restore.rc"; }
for stage in restore decrypt cat; do
  rc="$(stage_rc "$s/$stage.rc")"
  if [ "$rc" -ne 0 ]; then
    fail restore "$stage, exit $rc"
  fi
done

# Both renames or neither: a connection that arrived since the count above makes the first one
# fail, and the live database is then untouched. The restored copy is kept either way.
restored=''
rc=0
psql -X -q -v ON_ERROR_STOP=1 -d postgres <<SQL || rc=$?
begin;
alter database "$PGDATABASE" rename to "$previous";
alter database "$target" rename to "$PGDATABASE";
commit;
SQL
if [ "$rc" -ne 0 ]; then
  fail rename "exit $rc; $PGDATABASE is unchanged, $target is kept for another try"
fi

printf 'restore ok: %s now serves as %s; the previous database is %s (drop it by hand when done)\n' \
  "$run" "$PGDATABASE" "$previous"
