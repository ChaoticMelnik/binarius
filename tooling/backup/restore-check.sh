# The restore drill (docs/backups.md -> The service): the latest run is restored into a scratch
# database on the same server and compared with the live one - the schema byte for byte, the
# migration journal, then a row count per table. The scratch database is dropped on every exit.
# Prints `restore-check ok: ...`, `restore-check skipped: ...` (exit 0) or
# `restore-check failed: <step> (...)` (exit 1, pings <BACKUP_PING_URL>/fail).
set -eu
. "$(dirname "$0")/lib.sh"

scratch="${PGDATABASE:-}_restore_check"
schema="${PGDATABASE:-}_restore_check_schema"
s=''
created=''

cleanup() {
  if [ -n "$created" ]; then
    for db in "$scratch" "$schema"; do
      psql -X -q -d postgres -c "drop database if exists \"$db\" with (force)" \
        || log warn "the scratch database $db was not dropped"
    done
  fi
  if [ -n "$s" ]; then
    rm -rf "$s"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

fail() {
  printf 'restore-check failed: %s (%s)\n' "$1" "$2"
  ping fail
  exit 1
}

missing="$(missing_remote_var)"
if [ -z "$missing" ]; then
  missing="$(missing_var BACKUP_AGE_IDENTITY PGDATABASE)"
fi
if [ -n "$missing" ]; then
  fail config "$missing"
fi
if ! is_database_name "$PGDATABASE"; then
  fail config "PGDATABASE is not [a-z0-9_] of at most $MAX_DATABASE_NAME characters"
fi

rc=0
size="$(psql -X -At -c 'select pg_database_size(current_database())')" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail postgres "exit $rc"
fi
ceiling="${BACKUP_RESTORE_CHECK_MAX_BYTES:-$RESTORE_CHECK_MAX_BYTES_DEFAULT}"
if [ "$size" -gt "$ceiling" ]; then
  printf 'restore-check skipped: the database is %s bytes, above %s (BACKUP_RESTORE_CHECK_MAX_BYTES); drill on another machine, docs/backups.md -> Restoring\n' \
    "$size" "$ceiling"
  exit 0
fi

rc=0
runs="$(rclone lsf --dirs-only "$(remote)/hourly")" || rc=$?
run="$(printf '%s\n' "$runs" | sed -n 's,^\(binarius-[0-9TZ]*\)/$,\1,p' | sort | tail -n 1)"
if [ -z "$run" ] && [ "$rc" -eq 0 ]; then
  fail no-backups 'hourly/ holds no run'
elif [ -z "$run" ]; then
  fail no-backups "exit $rc"
fi
dir="$(remote)/hourly/$run"

rc=0
old="$(rclone lsf --files-only --min-age "$STALE_AFTER" "$dir")" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail stale "exit $rc"
fi
if printf '%s\n' "$old" | grep -qx 'binarius.dump.age'; then
  fail stale "$run is older than $STALE_AFTER"
fi

s="$(mktemp -d)"
identity="$s/identity"
write_identity "$identity"

env_summary='env none'
if [ -n "${BACKUP_ENV_FILE:-}" ]; then
  keys="$(fetch_decrypted "$dir/env.age" "$s" "$identity" | grep -c '^TOKEN_ENCRYPTION_KEY=.' || true)"
  if [ "$(stage_rc "$s/cat.rc")" -ne 0 ] || [ "$(stage_rc "$s/decrypt.rc")" -ne 0 ] || [ "$keys" -ne 1 ]; then
    fail env "fetch exit $(stage_rc "$s/cat.rc"), decrypt exit $(stage_rc "$s/decrypt.rc"), $keys TOKEN_ENCRYPTION_KEY lines"
  fi
  env_summary='env ok'
fi

created=1
rc=0
psql -X -q -v ON_ERROR_STOP=1 -d postgres \
  -c "drop database if exists \"$scratch\" with (force)" \
  -c "drop database if exists \"$schema\" with (force)" \
  -c "create database \"$scratch\"" || rc=$?
if [ "$rc" -ne 0 ]; then
  fail create "exit $rc"
fi

fetch_decrypted "$dir/binarius.dump.age" "$s" "$identity" \
  | { rc=0; pg_restore --exit-on-error --no-owner --no-privileges -d "$scratch" || rc=$?; echo "$rc" > "$s/restore.rc"; }
stage="$(failed_stage "$s" cat decrypt restore)"
if [ -n "$stage" ]; then
  fail restore "$stage"
fi

# The restored schema is compared with the live one loaded from its own pg_dump -s into a second
# database without data, not with the live one itself: Postgres prints an expression from its
# stored tree, and a restore re-parses it (the WHEN of 0059's bonus_rules_immutable comes back
# with its nested ORs flattened). Both sides then went through pg_dump once, so a lost index,
# CHECK, trigger or function, or a changed body, is a diff and a reprint is not.
schema_fail() {
  fail schema "$1, exit $2"
}
rc=0
pg_dump -s --no-owner --no-privileges -d "$PGDATABASE" > "$s/live.sql" || rc=$?
if [ "$rc" -ne 0 ]; then
  schema_fail "pg_dump $PGDATABASE" "$rc"
fi
rc=0
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database \"$schema\"" || rc=$?
if [ "$rc" -ne 0 ]; then
  schema_fail "create $schema" "$rc"
fi
rc=0
psql -X -q -v ON_ERROR_STOP=1 -d "$schema" -f "$s/live.sql" > /dev/null || rc=$?
if [ "$rc" -ne 0 ]; then
  schema_fail "load the live schema into $schema" "$rc"
fi
# pg_dump 18 brackets its output with \restrict <random token> lines, and the header names the
# versions: neither is part of the schema
for db in "$scratch" "$schema"; do
  rc=0
  pg_dump -s --no-owner --no-privileges -d "$db" > "$s/raw.sql" || rc=$?
  if [ "$rc" -ne 0 ]; then
    schema_fail "pg_dump $db" "$rc"
  fi
  grep -Ev '^\\(un)?restrict |^-- Dumped ' "$s/raw.sql" > "$s/$db.sql" || true
done
if ! diff "$s/$schema.sql" "$s/$scratch.sql" > "$s/schema.diff"; then
  head -n 20 "$s/schema.diff"
  fail schema 'the restored schema differs from the live one loaded from its pg_dump -s'
fi

journal='select count(*), max(created_at) from drizzle.__drizzle_migrations'
rc=0
live="$(psql -X -At -c "$journal")" || rc=$?
restored="$(psql -X -At -d "$scratch" -c "$journal")" || rc=$?
if [ "$rc" -ne 0 ] || [ "$live" != "$restored" ]; then
  fail migrations "live $live, restored $restored, exit $rc"
fi

rows="$(psql -X -At -F ' ' -d "$scratch" -c "
  select table_name,
         (xpath('/row/c/text()',
                query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                             false, true, '')))[1]::text
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name")" || fail rows "exit $?"
printf '%s\n' "$rows" | sed -n 's/^\(.*\) \([0-9]*\)$/rows \1 \2/p'
tables="$(printf '%s\n' "$rows" | grep -c . || true)"

# no success ping: the check shares the backups' healthchecks.io check, and an "up" here would
# hide a backup failure an hour earlier
printf 'restore-check ok: %s, %s tables, schema identical, migrations %s, %s\n' \
  "$run" "$tables" "${live%%|*}" "$env_summary"
