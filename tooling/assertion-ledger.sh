#!/usr/bin/env bash
# Generates the list of assertions a round has to account for, and enumerates the assertion
# shapes that went green by construction in #68 iteration 1 (five holes, none of them in the
# plan's oracle table). The unit here is the assertion, not the `it` block: four of those five
# were a second or third `expect` inside a test whose first assertion was real, so a mutation
# that reddened the block "confirmed" them too.
#
#   ledger <base>   every `expect(` in an it/test block the diff <base>..HEAD touched
#   scan   <base>   the five shapes, over every tracked *.test.ts, tagged [diff] or [base]
#
# The point of `ledger` is a set, not a count: the reviewer re-runs it with the same base and
#
#   comm -3 <(sort keys-from-the-PR) <(tooling/assertion-ledger.sh ledger <base> | cut -d: -f1,2 | sort)
#
# must be empty. Equal counts prove nothing — a duplicated key and a missing one cancel out.
#
# `scan` is repo-wide on purpose. Its own oracle is that it surfaces all five known holes, and
# two of them (apps/backend/src/timing.test.ts, apps/trading-worker/src/intents/config.test.ts)
# sit in files no #68 commit touched: the class is defined by the production module, not by the
# diff. Each hit carries [diff] or [base] so a round can tell what it owns. Automating this into
# a gate, and what to do with the [base] hits on pre-existing code, is #76.
#
# bash + git + grep + awk only: it has to run from a reviewer's shell with nothing installed.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: tooling/assertion-ledger.sh ledger <base>
       tooling/assertion-ledger.sh scan   <base>

  ledger  every assertion in an it/test block the diff <base>..HEAD touched, as `file:line: text`.
          <base> is the head of the previous round, so the ledger covers what this round adds or
          changes rather than every assertion in the branch.
  scan    the five green-by-construction shapes (S1-S4, S6 — Plan Update 1 defines no S5), over
          every tracked *.test.ts, as `S<n> [diff|base] file:line: text`. <base> only decides the
          tag.
EOF
  exit 2
}

[ $# -eq 2 ] || usage
mode=$1
base=$2

cd "$(git rev-parse --show-toplevel)"
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
  echo "assertion-ledger: '$base' is not a commit" >&2
  exit 2
}

# deleted files would make grep fail the whole run; --diff-filter=d drops them
changed_test_files() { git diff --name-only --diff-filter=d "$base"..HEAD -- '*.test.ts'; }
all_test_files() { git ls-files '*.test.ts'; }

# --- ledger ------------------------------------------------------------------------------------

# `@@ -a,b +c,d @@` -> `c-(c+d-1)`. A pure deletion (d = 0) touches no new line and yields nothing.
hunk_ranges() {
  git diff -U0 "$base"..HEAD -- "$1" | awk '
    /^@@/ {
      plus = $3; sub(/^\+/, "", plus)
      n = split(plus, p, ",")
      c = p[1] + 0; d = (n > 1 ? p[2] + 0 : 1)
      if (d > 0) printf "%d-%d ", c, c + d - 1
    }'
}

# A block runs from its `it`/`test` line to the next `it`/`test`/`describe` line or the end of the
# file. That is a superset of the real block, deliberately: a multi-line matcher whose `expect(`
# line the diff did not touch still lands in the ledger.
ledger_file() {
  awk -v file="$1" -v ranges="$2" '
    { line[NR] = $0 }
    END {
      nr = split(ranges, R, " ")
      for (i = 1; i <= nr; i++) { split(R[i], ab, "-"); lo[i] = ab[1] + 0; hi[i] = ab[2] + 0 }
      nb = 0
      for (i = 1; i <= NR; i++) {
        if (line[i] ~ /^[[:space:]]*(it|test|describe)([[:space:]]*\.[A-Za-z_]+)*[[:space:]]*(\(|`)/) {
          nb++
          start[nb] = i
          isit[nb] = (line[i] ~ /^[[:space:]]*(it|test)([[:space:]]*\.[A-Za-z_]+)*[[:space:]]*(\(|`)/)
        }
      }
      for (b = 1; b <= nb; b++) {
        if (!isit[b]) continue
        s = start[b]; e = (b < nb ? start[b + 1] - 1 : NR)
        touched = 0
        for (i = 1; i <= nr; i++) if (lo[i] <= e && hi[i] >= s) { touched = 1; break }
        if (!touched) continue
        for (i = s; i <= e; i++) {
          if (line[i] !~ /expect\(/) continue
          t = line[i]; sub(/^[[:space:]]+/, "", t); sub(/[[:space:]]+$/, "", t)
          printf "%s:%d: %s\n", file, i, t
        }
      }
    }' "$1"
}

run_ledger() {
  local file ranges
  changed_test_files | while IFS= read -r file; do
    ranges=$(hunk_ranges "$file")
    [ -n "$ranges" ] || continue
    ledger_file "$file" "$ranges"
  done
}

# --- scan --------------------------------------------------------------------------------------

# S4's class is "an assertion about a constant whose defining module throws at import": the
# identifiers are derived from the production modules, not listed here, so a second constant
# guarded the same way is picked up without editing this script.
throwing_constants() {
  git ls-files 'apps/*/src/**/*.ts' 'packages/*/src/**/*.ts' \
    | grep -v '\.test\.ts$' \
    | while IFS= read -r f; do
        awk '
          { line[NR] = $0 }
          END {
            for (i = 1; i <= NR; i++) {
              if (match(line[i], /if \(![A-Za-z_][A-Za-z0-9_]*\)/)) {
                name = substr(line[i], RSTART + 5, RLENGTH - 6)
                for (j = i; j <= i + 3 && j <= NR; j++) if (line[j] ~ /throw/) { print name; break }
              }
            }
          }' "$f"
      done | sort -u
}

# The sims a test can switch on: a named member of a `*/testing.ts` factory whose body assigns
# to a bare identifier (a closure `let` or a reassigned parameter). The assignment has to be a
# statement — a line ending in `;` — which is what keeps a destructuring default (`password =
# TEST_STAFF_PASSWORD,`) out, and the member is scoped by brace depth so an assignment after its
# body is not attributed to it. Counters (`++x`) never match either: `updateId` and `seq` are not
# worlds a second act could inherit.
sim_setters() {
  git ls-files '*/testing.ts' | while IFS= read -r f; do
    awk '
      {
        if (member != "" && depth < member_depth) member = ""
        if ($0 ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*:[[:space:]]*(async[[:space:]]+)?\(/) {
          candidate = $0
          sub(/^[[:space:]]*/, "", candidate)
          sub(/:.*$/, "", candidate)
        } else candidate = ""
        if (member != "" && $0 ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^=].*;[[:space:]]*$/) print member
        depth += gsub(/\{/, "{") - gsub(/\}/, "}")
        if (candidate != "") { member = candidate; member_depth = depth }
      }
    ' "$f"
  done | sort -u
}

# Whether a line belongs to an assertion statement: from a line carrying `expect(` until the
# parentheses opened there close on a line ending the statement. Shapes inside an argument
# (`.some(...)`, a flag in a `toMatchObject`) are only interesting there.
#
# $1 file, $2 tag, $3 space-separated S4 identifiers, $4 space-separated sim setters
scan_file() {
  awk -v file="$1" -v tag="$2" -v consts="$3" -v setters="$4" '
    function emit(s, n, text,   t) {
      t = text; sub(/^[[:space:]]+/, "", t); sub(/[[:space:]]+$/, "", t)
      printf "%s %s %s:%d: %s\n", s, tag, file, n, t
    }
    BEGIN {
      nc = split(consts, C, " ")
      ns = split(setters, S, " ")
    }
    {
      opens = gsub(/\(/, "("); closes = gsub(/\)/, ")")
      if (!inassert && $0 ~ /expect\(/) { inassert = 1; depth = 0 }
      if (inassert) {
        # S1 — a value a branch or a flag decides, asserted in one direction
        if ($0 ~ /toBe\((true|false)\)/ || $0 ~ /toBe(Truthy|Falsy)\(\)/ \
            || $0 ~ /toBe(Defined|Undefined)\(\)/ || $0 ~ /toHaveLength\(0\)/ \
            || $0 ~ /toEqual\(\[\]\)/ || $0 ~ /\.(some|find|every)\(/ \
            || $0 ~ /[A-Za-z_][A-Za-z0-9_]*:[[:space:]]*(true|false)[,}[:space:]]/ \
            || $0 ~ /[A-Za-z_][A-Za-z0-9_]*:[[:space:]]*(true|false)$/) emit("S1", NR, $0)
        # S2 — the expectation recomputes the definition instead of pinning the value
        if ($0 ~ /Math\./ || $0 ~ /Object\.(values|keys|entries)/ || $0 ~ /\.reduce\(/ \
            || $0 ~ /[A-Z][A-Z0-9_][A-Z0-9_]+[[:space:]]*[*\/+-][[:space:]]*[A-Za-z0-9_]/ \
            || $0 ~ /[A-Za-z0-9_][[:space:]]*[*\/+-][[:space:]]*[A-Z][A-Z0-9_][A-Z0-9_]+/) emit("S2", NR, $0)
        # S3 — a filter asserted empty: can the value it filters for ever be written by code?
        if ($0 ~ /\.filter\(/ || $0 ~ /toHaveLength\(0\)/ || $0 ~ /toEqual\(\[\]\)/ \
            || $0 ~ /\.some\(.*\)\)?\.toBe\(false\)/ || $0 ~ /\.find\(.*toBeUndefined\(\)/) emit("S3", NR, $0)
        # S4 — a constant whose module throws at import: the file dies before the assertion runs
        for (i = 1; i <= nc; i++) if ($0 ~ ("expect\\(" C[i] "\\)")) emit("S4", NR, $0)
      }
      # S6 — a sim switched on by a test: was it switched back before the second act?
      for (i = 1; i <= ns; i++) if ($0 ~ ("\\." S[i] "\\(")) emit("S6", NR, $0)
      if (inassert) {
        depth += opens - closes
        if (depth <= 0) inassert = 0
      }
    }' "$1"
}

run_scan() {
  local consts setters diff_files file tag
  consts=$(throwing_constants | tr '\n' ' ')
  setters=$(sim_setters | tr '\n' ' ')
  diff_files=$(changed_test_files)
  echo "# S4 identifiers (module throws at import): ${consts:-none}"
  echo "# S6 sim setters (mutable state in */testing.ts): ${setters:-none}"
  echo "# [diff] = the file changed in $base..HEAD; [base] = it did not"
  all_test_files | while IFS= read -r file; do
    if printf '%s\n' "$diff_files" | grep -qxF "$file"; then tag='[diff]'; else tag='[base]'; fi
    scan_file "$file" "$tag" "$consts" "$setters"
  done
}

case "$mode" in
  ledger) run_ledger ;;
  scan) run_scan ;;
  *) usage ;;
esac
