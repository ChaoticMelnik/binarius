#!/usr/bin/env bash
# Usage: phase-watchdog.sh <issue> <branch|-> <limit-min> <phase>
# Prints one line "STALLED #<issue> <phase> <idle-min>" and exits 0 once nothing happened on GitHub
# for longer than <limit-min>; otherwise runs until stopped (TaskStop).
set -u

if [ $# -ne 4 ]; then
  echo "usage: $0 <issue> <branch|-> <limit-min> <phase>" >&2
  exit 2
fi

REPO=ChaoticMelnik/binarius
issue=$1
branch=$2
limit=$3
phase=$4
interval=${WATCHDOG_INTERVAL_SEC:-300}
# the phase was just spawned: its start counts as activity, so old history does not fire at once
start=$(date -u +%s)

latest_activity() {
  local last=$start t
  t=$(gh issue view "$issue" --repo "$REPO" --json comments,updatedAt \
    --jq '[.updatedAt, (.comments[].createdAt)] | map(fromdateiso8601) | max' 2>/dev/null || true)
  [[ $t =~ ^[0-9]+$ ]] && ((t > last)) && last=$t
  if [ "$branch" != "-" ]; then
    t=$(gh api "repos/$REPO/branches/$branch" \
      --jq '.commit.commit.committer.date | fromdateiso8601' 2>/dev/null || true)
    [[ $t =~ ^[0-9]+$ ]] && ((t > last)) && last=$t
    t=$(gh pr list --repo "$REPO" --head "$branch" --state all --limit 10 --json updatedAt,comments,reviews \
      --jq '[.[] | .updatedAt, (.comments[].createdAt), (.reviews[].submittedAt)]
            | map(select(. != null) | fromdateiso8601) | max // empty' 2>/dev/null || true)
    [[ $t =~ ^[0-9]+$ ]] && ((t > last)) && last=$t
  fi
  echo "$last"
}

while true; do
  sleep "$interval"
  idle=$((($(date -u +%s) - $(latest_activity)) / 60))
  if ((idle > limit)); then
    echo "STALLED #$issue $phase $idle"
    exit 0
  fi
done
