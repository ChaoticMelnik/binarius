#!/usr/bin/env bash
# What earlier sessions left out of audits.md (tech-lead Phase 0 item 5; Phase 5 item 2a writes
# what it finds). Two checks, both counted from the merge of PR #777 (#769), the cutoff:
#   LOST NIGHT: <session> (<file>)  a manager session whose process is over, that started after the
#                                    cutoff, has no audit_pr and no «## Сессия <session> — manager»
#                                    header in audits.md on origin/main or in an open docs/audit-* PR
#   UNRECORDED PR #<n>              a PR merged after the cutoff, not from a docs/audit-* or
#                                    docs/<N>-audit branch, that no audits.md on origin/main and no
#                                    open docs/audit-* PR names as #<n>
# Each line is a warning to report, not a stop: the script exits 0 after both checks, 2 without
# gh or jq. Run from any checkout of the repository.
#
#   tooling/audit-gaps.sh
set -uo pipefail

command -v gh >/dev/null && command -v jq >/dev/null || { echo "audit-gaps: needs gh and jq" >&2; exit 2; }

# (a) lost nights
R=ChaoticMelnik/binarius; T=$(mktemp -d)
ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)"); M=$ROOT/.claude/worktrees/manager
cut=$(gh pr view 777 --repo $R --json mergedAt --jq '.mergedAt // empty | fromdateiso8601')
if [ -z "$cut" ]; then echo "lost-night check skipped: #777 not merged, no cutoff"; else
git show origin/main:audits.md > "$T/main.md"
gh pr list --repo $R --state open --limit 100 --json number,headRefName --jq '.[] | select(.headRefName | startswith("docs/audit-")) | .number' |
  while read -r n; do gh pr diff "$n" --repo $R; done > "$T/open.diff"
find "$M" -maxdepth 1 -name 'state*.json' 2>/dev/null | while read -r S; do
  [ "$(jq -r .start "$S")" -gt "$cut" ] && [ -z "$(jq -r '.audit_pr // empty' "$S")" ] || continue
  pid=$(jq -r .pid "$S"); dl=$(jq -r .deadline "$S"); sess=$(jq -r .session "$S")
  if [ "$(basename "$S")" = state.json ] && [ -z "$(jq -r '.ended // empty' "$S")" ] \
     && kill -0 "$pid" 2>/dev/null && ps -o comm= -p "$pid" | grep -q claude \
     && [ "$(date -u +%s)" -lt $(( dl + (150 + 30) * 60 )) ]; then continue; fi   # still running
  h="## Сессия $sess — manager"
  grep -qF "$h" "$T/main.md" || grep -qF "+$h" "$T/open.diff" || echo "LOST NIGHT: $sess ($(basename "$S"))"
done
echo "lost-night check done (cutoff $cut)"; fi

# (b) merged PRs no audit entry names
R=ChaoticMelnik/binarius; T=$(mktemp -d)
cut=$(gh pr view 777 --repo $R --json mergedAt --jq '.mergedAt // empty')
if [ -z "$cut" ]; then echo "orphan check skipped: #777 not merged, no cutoff"; else
git show origin/main:audits.md > "$T/main.md"
gh pr list --repo $R --state open --limit 100 --json number,headRefName --jq '.[] | select(.headRefName | startswith("docs/audit-")) | .number' |
  while read -r n; do gh pr diff "$n" --repo $R; done > "$T/open.diff"
gh pr list --repo $R --state merged --limit 100 --json number,headRefName,mergedAt \
  --jq '.[] | select(.mergedAt > "'"$cut"'") | select(.headRefName | test("^docs/(audit-|[0-9]+-audit)") | not) | .number' |
  while read -r n; do grep -qE "#$n([^0-9]|$)" "$T/main.md" "$T/open.diff" || echo "UNRECORDED PR #$n"; done
echo "orphan check done (cutoff $cut)"; fi
