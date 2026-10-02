#!/usr/bin/env bash
# Runs the test suite N times and tabulates every failure class #166 was about: hook and test
# timeouts, time-order CHECK violations, the 42601 they cascade into, and steps back of the
# Postgres clock (tooling/db-clock-probe.ts runs for the whole series).
#
#   tooling/check-stability.sh quiet N   N sequential `pnpm check`
#   tooling/check-stability.sh load N    N rounds of two parallel `vitest run` beside 4 CPU hogs
#
# Needs DATABASE_URL and REDIS_URL, as the tests do. Logs go to $STABILITY_OUT (a fresh temp
# directory by default). Exits 0 only when every run passed and the probe saw no step back.
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
: "${DATABASE_URL:?DATABASE_URL is required}"
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
cleanup() {
  if [ ${#hogs[@]} -gt 0 ]; then kill "${hogs[@]}" 2> /dev/null || true; fi
  hogs=()
  # a signal sent to this script alone (not to the terminal's process group) leaves them running
  if [ ${#suites[@]} -gt 0 ]; then kill "${suites[@]}" 2> /dev/null || true; fi
  suites=()
  if [ -n "$probe_pid" ]; then kill "$probe_pid" 2> /dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_swap_mb() {
  # "vm.swapusage: total = 13312.00M  used = 12989.62M  free = 322.38M  (encrypted)"
  sysctl -n vm.swapusage | sed -E 's/.*free = ([0-9]+)(\.[0-9]+)?M.*/\1/'
}

require_swap() {
  [ "$(uname)" = Darwin ] || return 0
  local free
  free=$(free_swap_mb)
  if [ "$free" -lt "$MIN_FREE_SWAP_MB" ]; then
    echo "refusing the load mode: ${free} MB of swap free, below MIN_FREE_SWAP_MB=${MIN_FREE_SWAP_MB}" >&2
    exit 2
  fi
}

steps_so_far() {
  grep -c 'STEP BACK' "$probe_log" || true
}

failed_files() {
  grep -E '^ *FAIL ' "$1" | grep -oE '[A-Za-z0-9_./-]+\.test\.ts' | sort -u | tr '\n' ' ' || true
}

row() {
  local label=$1 rc=$2 wall=$3 log=$4 steps=$5
  printf '%-6s rc=%-3s wall=%4ss hook_timeouts=%s test_timeouts=%s 42601=%s steps_back=%s checks=[%s] failed=[%s]\n' \
    "$label" "$rc" "$wall" \
    "$(grep -c 'Hook timed out' "$log" || true)" \
    "$(grep -c 'Test timed out' "$log" || true)" \
    "$(grep -c "code: '42601'" "$log" || true)" \
    "$steps" \
    "$(grep -oE 'violates check constraint "[a-z_]+"' "$log" | sed -E 's/.*"(.*)"/\1/' | sort -u | tr '\n' ' ' || true)" \
    "$(failed_files "$log")" | tee -a "$summary"
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
  before=$(steps_so_far)
  t0=$(date +%s)
  if [ "$mode" = quiet ]; then
    rc=0
    pnpm check > "$out/run-$i.log" 2>&1 || rc=$?
    t1=$(date +%s)
    row "$i" "$rc" $((t1 - t0)) "$out/run-$i.log" $(($(steps_so_far) - before))
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
    steps=$(($(steps_so_far) - before))
    row "$i/a" "$ra" $((t1 - t0)) "$out/run-$i-a.log" "$steps"
    row "$i/b" "$rb" $((t1 - t0)) "$out/run-$i-b.log" "$steps"
    [ "$ra" -eq 0 ] || failures=$((failures + 1))
    [ "$rb" -eq 0 ] || failures=$((failures + 1))
  fi
  i=$((i + 1))
done

kill -INT "$probe_pid"
probe_rc=0
wait "$probe_pid" || probe_rc=$?
probe_pid=
grep -E 'final:' "$probe_log" | tee -a "$summary" || true
echo "failed runs: $failures, probe exit: $probe_rc (0 clean, 1 stepped back, 2 no samples)" | tee -a "$summary"
[ "$failures" -eq 0 ] && [ "$probe_rc" -eq 0 ]
