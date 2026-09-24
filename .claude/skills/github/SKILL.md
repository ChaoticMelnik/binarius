---
name: github
description: Token-efficient GitHub Issues + Projects operations for the agent pipeline. Reads use `gh issue` and `gh api graphql` with --jq filtering to return only the needed fields — no isolated Agent subagent needed by default, since gh (unlike the Linear MCP tool) lets you filter server-side before the result reaches context. Writes (status changes, comments) use the same templates. Use this skill whenever another skill needs to read or write a GitHub issue or its Project board status.
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

### Why the status templates use GraphQL, not `gh project item-list`

`gh project item-list` returns 30 items unless given `--limit`, in no particular order and without saying it truncated (verified 2026-09-24: 30 of 47 items by default, highest issue number 31). A status lookup through it reports "not on the board" for any issue past the cut, which is how #54 and #56 went missing. The templates below ask GraphQL for one issue's own project items (the first 20 projects the issue is on — more is not expected, and the template prints a warning if there are), or page through the whole project with a cursor.

---

## Core rule: filter before it reaches context

`gh issue`/`gh pr`/`gh project` all support `--json <fields>` plus `-q/--jq <expr>`, and `gh api graphql` takes `--jq`. Always request only the fields a template needs and shape them with `--jq` — the unfiltered JSON never has to enter the main context, so (unlike Linear's MCP tool, which always returns the full object regardless of what you ask for) there is no structural need to wrap these calls in an isolated Agent subagent. Run them directly.

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
gh api graphql -F owner=ChaoticMelnik -F repo=binarius -F number=<N> -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 20) {
        pageInfo { hasNextPage }
        nodes {
          id
          project { id }
          fieldValueByName(name: "Pipeline Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
          }
        }
      }
    }
  }
}' --jq '.data.repository.issue.projectItems | (if .pageInfo.hasNextPage then "WARNING: the issue is on more than 20 projects; Project #2 may be on a later page" else empty end), (.nodes[] | select(.project.id == "PVT_kwHOAuWLpM4BkLYI") | {itemId: .id, status: .fieldValueByName.name, optionId: .fieldValueByName.optionId})'
```

`itemId` (the Project item id, not the issue number) is required for the next operation. No output means the issue is not on Project #2 — add it (below), do not conclude anything about its status. `status: null` means it is on the board with no Pipeline Status set.

## Operation: Update Pipeline Status

```bash
gh project item-edit --id <ITEM_ID> --project-id PVT_kwHOAuWLpM4BkLYI \
  --field-id PVTSSF_lAHOAuWLpM4BkLYIzhi841o --single-select-option-id <TARGET_OPTION_ID>
```

Substitute the target status's option id from the Project Constants block above.

## Operation: List issues by status

```bash
gh api graphql --paginate -f query='
query($endCursor: String) {
  node(id: "PVT_kwHOAuWLpM4BkLYI") {
    ... on ProjectV2 {
      items(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fieldValueByName(name: "Pipeline Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content { ... on Issue { number title url } }
        }
      }
    }
  }
}' --jq '.data.node.items.nodes[] | select(.fieldValueByName.name == "In Review") | {number: .content.number, title: .content.title, url: .content.url}'
```

`--paginate` follows `pageInfo.endCursor` until the last page, so the result does not depend on how many items the board holds. Substitute the status name (`Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Canceled`).

## Operation: Post a comment

```bash
gh issue comment <N> --repo ChaoticMelnik/binarius --body "$(cat <<'EOF'
<BODY>
EOF
)"
```

## Operation: Create an issue

```bash
gh issue create --repo ChaoticMelnik/binarius --title "<title>" --body-file <file>
```

Returns the issue URL. `gh issue create` does **not** add the issue to Project #2 — without the next operation the issue has no Pipeline Status and no status query will ever find it.

## Operation: Add issue to Project #2 (and set its status)

```bash
item=$(gh project item-add 2 --owner ChaoticMelnik --url https://github.com/ChaoticMelnik/binarius/issues/<N> --format json --jq .id)
gh project item-edit --id "$item" --project-id PVT_kwHOAuWLpM4BkLYI \
  --field-id PVTSSF_lAHOAuWLpM4BkLYIzhi841o --single-select-option-id <TARGET_OPTION_ID> --format json --jq .id
```

`item-add` is idempotent: for an issue already on the board it returns the existing item id. Then confirm with "Find issue's current Pipeline Status".

---

## Quick Reference

| Need | Command |
|---|---|
| Read issue (no comments) | `gh issue view` + `--jq` template above |
| Read issue + comments | `gh issue view --json ...,comments` + `--jq` template above |
| Find current status | `gh api graphql` → `issue.projectItems` template above |
| Update status | `gh project item-edit --single-select-option-id ...` |
| List issues by status | `gh api graphql --paginate` → `ProjectV2.items` template above |
| Post comment | `gh issue comment` |
| Create issue | `gh issue create`, then "Add issue to Project #2" |

**Rule of thumb:** every `gh issue`/`gh project`/`gh api graphql` call carries an explicit `--json`/`--jq` (or `--format json --jq`) that trims the result to only what the caller needs — never call these with no filter "to see what's there."
