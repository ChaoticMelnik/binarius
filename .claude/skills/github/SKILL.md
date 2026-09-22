---
name: github
description: Token-efficient GitHub Issues + Projects operations for the agent pipeline. Reads use `gh issue`/`gh project item-list` with --jq filtering to return only the needed fields — no isolated Agent subagent needed by default, since gh (unlike the Linear MCP tool) lets you filter server-side before the result reaches context. Writes (status changes, comments) use the same templates. Use this skill whenever another skill needs to read or write a GitHub issue or its Project board status.
---

# GitHub Skill

## Project Constants — never re-run field-list/item-list to rediscover these

```
Owner:      ChaoticMelnik
Repo:       ChaoticMelnik/binarius
Default branch: main

Project number: 2
Project (node) id: PVT_kwHOAuWLpM4BkLYI
Pipeline Status field id: PVTSSF_lAHOAuWLpM4BkLYIzhi841o

Status option ids:
  Backlog      58a4bd05
  Todo         1d459acf
  In Progress  4b97f9bd
  In Review    82f643c1
  Done         26ea2318
  Canceled     e78329c7
```

Stable for the life of the project. Filled in once during bootstrap (Step 2). Never call `gh project field-list`/`item-list` again just to look these up.

### Reading the Pipeline Status field in `--jq`

`gh project item-list --format json` lowercases the first letter of every custom field name, so the key is **`.["pipeline Status"]`**, not `.["Pipeline Status"]`. Verified against gh 2.96.0. Both wrong spellings fail silently:

- `.["Pipeline Status"]` yields `null` for every item, which looks exactly like "no issue is in that status."
- `.status` is the board's **built-in** Status field, which this project does not keep in sync with Pipeline Status — as of 2026-09-23 it reports `Todo` for 26 issues whose Pipeline Status is `Backlog`. Never substitute it.

The templates below use `(.["pipeline Status"] // .["Pipeline Status"])` so a future gh change to either spelling keeps working. If a status query ever returns `null` or an empty list, verify the key against `gh project item-list 2 --owner ChaoticMelnik --format json --jq '.items[0] | keys'` before concluding the board is empty.

---

## Core rule: filter before it reaches context

`gh issue`/`gh pr`/`gh project` all support `--json <fields>` plus `-q/--jq <expr>`. Always request only the fields a template needs and shape them with `--jq` — the unfiltered JSON never has to enter the main context, so (unlike Linear's MCP tool, which always returns the full object regardless of what you ask for) there is no structural need to wrap these calls in an isolated Agent subagent. Run them directly.

**Exception:** a call whose `--jq` output is still bulky (a wide `gh issue list` with no `--limit`, or batch-processing many issues in one pass) — route that one through an isolated `Agent`, same principle as elsewhere in the pipeline: nothing bulky lands in the main context. The mechanism (inline `--jq` vs. isolation) is whichever is cheaper for that specific call shape.

---

## Operation: Read Issue (metadata + body)

```bash
gh issue view <N> --repo ChaoticMelnik/binarius --json number,title,state,url,labels,assignees,body,updatedAt \
  --jq '"# #\(.number): \(.title)\n\nState: \(.state) | Assignees: \([.assignees[].login] | join(", ") // "—")\nLabels: \([.labels[].name] | join(", "))\nURL: \(.url) | Updated: \(.updatedAt)\n\n## Description\n\n\(.body // "(empty)")"'
```

## Operation: Read Issue + Comments (combined)

Use for architect planning, reviewer context, re-review.

```bash
gh issue view <N> --repo ChaoticMelnik/binarius --json number,title,state,url,labels,assignees,body,comments \
  --jq '"# #\(.number): \(.title)\n\nState: \(.state) | Assignees: \([.assignees[].login] | join(", ") // "—")\nLabels: \([.labels[].name] | join(", "))\nURL: \(.url)\n\n## Description\n\n\(.body // "(empty)")\n\n## Comments (\(.comments | length))\n\n" + ([.comments[] | "### \(.createdAt) — \(.author.login)\n\(.body)\n"] | join("\n"))'
```

## Operation: Find issue's current Pipeline Status

```bash
gh project item-list 2 --owner ChaoticMelnik --format json \
  --jq '.items[] | select(.content.number == <N>) | {status: (.["pipeline Status"] // .["Pipeline Status"]), itemId: .id}'
```

`itemId` (the Project item id, not the issue number) is required for the next operation.

## Operation: Update Pipeline Status

```bash
gh project item-edit --id <ITEM_ID> --project-id PVT_kwHOAuWLpM4BkLYI \
  --field-id PVTSSF_lAHOAuWLpM4BkLYIzhi841o --single-select-option-id <TARGET_OPTION_ID>
```

Substitute the target status's option id from the Project Constants block above.

## Operation: List issues by status

```bash
gh project item-list 2 --owner ChaoticMelnik --format json \
  --jq '[.items[] | select((.["pipeline Status"] // .["Pipeline Status"]) == "In Review") | {number: .content.number, title: .content.title, url: .content.url}]'
```

## Operation: Post a comment

```bash
gh issue comment <N> --repo ChaoticMelnik/binarius --body "$(cat <<'EOF'
<BODY>
EOF
)"
```

## Operation: Create an issue

```bash
gh issue create --repo ChaoticMelnik/binarius --title "<title>" --body "<body>" --label "<label1>,<label2>"
```

Returns the issue URL directly — already short, no extra formatting needed.

---

## Quick Reference

| Need | Command |
|---|---|
| Read issue (no comments) | `gh issue view` + `--jq` template above |
| Read issue + comments | `gh issue view --json ...,comments` + `--jq` template above |
| Find current status | `gh project item-list` + `select(.content.number == N)` |
| Update status | `gh project item-edit --single-select-option-id ...` |
| List issues by status | `gh project item-list` + `select(.["pipeline Status"] == ...)` |
| Post comment | `gh issue comment` |
| Create issue | `gh issue create` |

**Rule of thumb:** every `gh issue`/`gh project` call carries an explicit `--json`/`--jq` (or `--format json --jq`) that trims the result to only what the caller needs — never call these with no filter "to see what's there."
