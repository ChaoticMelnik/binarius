#!/usr/bin/env bash
# Which model each phase spawn of one Claude session requested, was assigned and ran on, from the
# session's transcripts (tech-lead Mode 1 -> Model policy - check: run only on the owner's request
# or on a suspicion of a substituted model; the judging rules (a)-(c) and the severity are there).
#
#   tooling/model-policy-check.sh <session-id>
#
# One line per spawn at any depth: description | depth | requested | resolved | ran. `resolved` is
# the harness's resolvedModel, recorded only at depth 1 once a result came back; `ran` is every
# distinct message.model of the agent's own transcript. Output of #56's own run (abridged):
#
#   Architect #56 research + questions | depth 1 | requested fable | resolved claude-fable-5-1 | ran claude-fable-5-1
#   Reviewer #56 PR #61 | depth 1 | requested opus | resolved claude-opus-5-5[1m] | ran claude-opus-5-5
#   Implementer #56 clarify round | depth 1 | requested opus | resolved no result record (continued via SendMessage or still running) | ran claude-opus-5-5
#   Simplify review PR 61 | depth 2 | requested sonnet | resolved not recorded at depth >= 2 | ran claude-sonnet-5
#   - | depth 3 | requested inherited from parent a04adae24974857c8 (parent ran claude-opus-5-5 ) | resolved not recorded at depth >= 2 | ran claude-opus-5-5
#
# Exit 2 without a session id or without its transcript.
set -uo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <session-id>" >&2; exit 2; }
S=~/.claude/projects/-Users-user-Documents-Binarius/$1
[ -f "$S.jsonl" ] || { echo "no transcript $S.jsonl" >&2; exit 2; }

resolved=$(jq -c 'select(.toolUseResult.resolvedModel? != null)
  | {id: (.message.content[] | select(.type == "tool_result") | .tool_use_id), m: .toolUseResult.resolvedModel}' "$S.jsonl")
# only message.model is the model the agent ran on; a transcript also carries advisorModel
# and attachment.model, and a plain grep for "model" reports those as extra ids (#68)
ran() { jq -r 'select(.message.model != null) | .message.model' "$S/subagents/agent-$1.jsonl" | sort -u | tr '\n' ' '; }
for m in "$S"/subagents/*.meta.json; do
  [ -e "$m" ] || { echo "no spawns in $S/subagents"; break; }
  id=$(basename "$m" .meta.json); id=${id#agent-}
  depth=$(jq -r .spawnDepth "$m"); req=$(jq -r '.model // empty' "$m")
  tu=$(jq -r '.toolUseId // empty' "$m"); parent=$(jq -r '.parentAgentId // empty' "$m")
  if [ "$depth" -ge 2 ]; then res="not recorded at depth >= 2"
  else
    res=$(printf '%s\n' "$resolved" | jq -r --arg tu "$tu" 'select(.id == $tu) | .m' | head -1)
    [ -n "$res" ] || res="no result record (continued via SendMessage or still running)"
  fi
  [ -n "$req" ] || req="inherited from parent $parent (parent ran $(ran "$parent"))"
  printf '%s | depth %s | requested %s | resolved %s | ran %s\n' \
    "$(jq -r '.description // "-"' "$m")" "$depth" "$req" "$res" "$(ran "$id")"
done
