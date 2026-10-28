# Prints the server's .env stored with one run (docs/backups.md -> Restoring). The one script
# whose purpose is to print a secret: nothing is applied automatically.
set -eu
. "$(dirname "$0")/lib.sh"

run="${1:-}"
if ! is_run_name "$run"; then
  printf 'usage: fetch-env binarius-<YYYYmmddTHHMMSSZ>\n' >&2
  exit 64
fi
missing="$(missing_remote_var)"
if [ -z "$missing" ]; then
  missing="$(missing_var BACKUP_AGE_IDENTITY)"
fi
if [ -n "$missing" ]; then
  printf 'fetch-env failed: config (%s)\n' "$missing" >&2
  exit 1
fi

rc=0
dir="$(find_run "$run" env.age)" || rc=$?
if [ "$rc" -ne 0 ]; then
  printf 'fetch-env failed: find (exit %s)\n' "$rc" >&2
  exit 1
fi
if [ -z "$dir" ]; then
  printf 'fetch-env failed: not-found (%s has no env.age under hourly/ or daily/)\n' "$run" >&2
  exit 1
fi

s="$(mktemp -d)"
trap 'rm -rf "$s"' EXIT
write_identity "$s/identity"
fetch_decrypted "$dir/env.age" "$s" "$s/identity"
stage="$(failed_stage "$s" cat decrypt)"
if [ -n "$stage" ]; then
  printf 'fetch-env failed: fetch (%s)\n' "$stage" >&2
  exit 1
fi
