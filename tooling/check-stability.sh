#!/usr/bin/env bash
# Runs the test suite N times and tabulates every failure class #166 was about: hook and test
# timeouts, time-order CHECK violations, the 42601 they cascade into, and the test database's
# clock: steps back and skew against this host (tooling/db-clock-probe.ts runs for the whole
# series).
#
#   tooling/check-stability.sh quiet N   N sequential `pnpm check`
#   tooling/check-stability.sh load N    N rounds of two parallel `vitest run` beside 4 CPU hogs
#
# Needs TEST_DATABASE_URL and REDIS_URL, as the tests do. Logs go to $STABILITY_OUT (a fresh temp
# directory by default). Exits 0 only when every run passed and the probe saw neither a step back
# nor a skew.
# bash 3.2 compatible: it runs under macOS's /bin/bash.
set -euo pipefail

usage() {
  echo "usage: $0 quiet|load N" >&2
  exit 64
}

[ $# -eq 2 ] || usage
mode=$1
runs=$2
case $mode in quiet | load) ;; *) usage ;; esac
case $runs in '' | *[!0-9]* | 0) usage ;; esac
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"

# The load mode adds CPU only: with the host's swap nearly full, two suites in parallel were the
# most it took and stayed green at 589 MB free; below this it would measure the swap, not the code.
MIN_FREE_SWAP_MB=${MIN_FREE_SWAP_MB:-512}
HOGS_PER_ROUND=4

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
out=${STABILITY_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/check-stability.XXXXXX")}
mkdir -p "$out"
probe_log=$out/probe.log
summary=$out/summary.txt
: > "$probe_log"
: > "$summary"

hogs=()
suites=()
probe_pid=

descendants() {
  local child
  for child in $(pgrep -P "$1" || true); do
    echo "$child"
    descendants "$child"
  done
}

# the whole tree, collected before the first kill: pnpm does not pass a TERM on to the vitest
# workers under it, and a child whose parent died first is no longer found by its parent's pid
kill_tree() {
  local pids
  pids="$1 $(descendants "$1")"
  # shellcheck disable=SC2086
  kill $pids 2> /dev/null || true
}

cleanup() {
  if [ ${#hogs[@]} -gt 0 ]; then kill "${hogs[@]}" 2> /dev/null || true; fi
  hogs=()
  # a signal sent to this script alone (not to the terminal's process group) leaves them running
  local suite
  for suite in ${suites[@]+"${suites[@]}"}; do kill_tree "$suite"; done
  suites=()
  if [ -n "$probe_pid" ]; then kill "$probe_pid" 2> /dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# "vm.swapusage: total = 13312.00M  used = 12989.62M  free = 322.38M  (encrypted)"
swap_field() {
  sysctl -n vm.swapusage | sed -nE "s/.*$1 = ([0-9]+)(\.[0-9]+)?M.*/\1/p"
}

require_swap() {
  [ "$(uname)" = Darwin ] || return 0
  local total free
  total=$(swap_field total)
  free=$(swap_field free)
  case "$total" in '' | *[!0-9]*) total=unreadable ;; esac
  case "$free" in '' | *[!0-9]*) free=unreadable ;; esac
  if [ "$total" = unreadable ] || [ "$free" = unreadable ]; then
    echo "refusing the load mode: cannot read vm.swapusage ($(sysctl -n vm.swapusage))" >&2
    exit 2
  fi
  # macOS creates swap files on demand: no swap at all means no memory pressure yet
  if [ "$total" -eq 0 ]; then
    echo "swap guard skipped: no swap in use (vm.swapusage total = 0)" | tee -a "$summary"
    return 0
  fi
  if [ "$free" -lt "$MIN_FREE_SWAP_MB" ]; then
    echo "refusing the load mode: ${free} MB of swap free, below MIN_FREE_SWAP_MB=${MIN_FREE_SWAP_MB}" >&2
    exit 2
  fi
}

steps_so_far() {
  grep -c 'STEP BACK' "$probe_log" || true
}

# the probe logs SKEW when the clock enters that state and every 30 s inside it
skews_so_far() {
  grep -c 'SKEW' "$probe_log" || true
}

failed_files() {
  grep -E '^ *FAIL ' "$1" | grep -oE '[A-Za-z0-9_./-]+\.test\.ts' | sort -u | tr '\n' ' ' || true
}

# what one suite's log shows
suite_columns() {
  local log=$1
  printf 'hook_timeouts=%s test_timeouts=%s 42601=%s checks=[%s] failed=[%s]' \
    "$(grep -c 'Hook timed out' "$log" || true)" \
    "$(grep -c 'Test timed out' "$log" || true)" \
    "$(grep -c "code: '42601'" "$log" || true)" \
    "$(grep -oE 'violates check constraint "[a-z_]+"' "$log" | sed -E 's/.*"(.*)"/\1/' | sort -u | tr '\n' ' ' || true)" \
    "$(failed_files "$log")"
}

if [ "$mode" = load ]; then require_swap; fi

node tooling/db-clock-probe.ts --log "$probe_log" > "$out/probe.out" 2>&1 &
probe_pid=$!
sleep 2
if ! kill -0 "$probe_pid" 2> /dev/null; then
  probe_pid=
  echo "the clock probe did not start (Node from .node-version? see $out/probe.out)" >&2
  exit 1
fi

echo "mode=$mode runs=$runs out=$out $(uptime | sed 's/.*load/load/')" | tee -a "$summary"
failures=0
i=1
while [ "$i" -le "$runs" ]; do
  steps_before=$(steps_so_far)
  skews_before=$(skews_so_far)
  t0=$(date +%s)
  if [ "$mode" = quiet ]; then
    # in the background, so a TERM is handled now and not after the whole check
    pnpm check > "$out/run-$i.log" 2>&1 &
    suites=("$!")
    rc=0
    wait "${suites[0]}" || rc=$?
    suites=()
    t1=$(date +%s)
    printf '%-4s rc=%-3s wall=%4ss steps_back=%s skew=%s %s\n' "$i" "$rc" $((t1 - t0)) \
      $(($(steps_so_far) - steps_before)) $(($(skews_so_far) - skews_before)) \
      "$(suite_columns "$out/run-$i.log")" | tee -a "$summary"
    [ "$rc" -eq 0 ] || failures=$((failures + 1))
  else
    require_swap
    h=1
    while [ "$h" -le "$HOGS_PER_ROUND" ]; do
      yes > /dev/null &
      hogs+=($!)
      h=$((h + 1))
    done
    # vitest, not `pnpm check`: two `tsc -b --clean` would race over the same dist/
    pnpm exec vitest run > "$out/run-$i-a.log" 2>&1 &
    a=$!
    pnpm exec vitest run > "$out/run-$i-b.log" 2>&1 &
    b=$!
    suites=("$a" "$b")
    ra=0
    wait "$a" || ra=$?
    rb=0
    wait "$b" || rb=$?
    t1=$(date +%s)
    suites=()
    kill "${hogs[@]}" 2> /dev/null || true
    hogs=()
    # wall time and the clock are the round's; the rest is each suite's own
    printf 'round %s rc=a:%s,b:%s wall=%ss steps_back=%s skew=%s\n' "$i" "$ra" "$rb" $((t1 - t0)) \
      $(($(steps_so_far) - steps_before)) $(($(skews_so_far) - skews_before)) | tee -a "$summary"
    printf '  %s/a %s\n' "$i" "$(suite_columns "$out/run-$i-a.log")" | tee -a "$summary"
    printf '  %s/b %s\n' "$i" "$(suite_columns "$out/run-$i-b.log")" | tee -a "$summary"
    [ "$ra" -eq 0 ] || failures=$((failures + 1))
    [ "$rb" -eq 0 ] || failures=$((failures + 1))
  fi
  i=$((i + 1))
done

kill -INT "$probe_pid" 2> /dev/null || true
probe_rc=0
wait "$probe_pid" || probe_rc=$?
probe_pid=
grep -E 'final:' "$probe_log" | tee -a "$summary" || true
echo "failed runs: $failures, probe exit: $probe_rc (0 clean, 1 stepped back or skewed, 2 no samples, 64 usage, 70 probe error)" | tee -a "$summary"
[ "$failures" -eq 0 ] && [ "$probe_rc" -eq 0 ]
