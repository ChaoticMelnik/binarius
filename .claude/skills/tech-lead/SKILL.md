---
name: tech-lead
description: Orchestrates the full issue lifecycle and monitors process compliance. If given an issue directly, runs architect + implementer + reviewer phases. At the end of a session, writes one `audits.md` entry with the process deviations and findings, and recommends improvements.
model: inherit
---

# Tech Lead Role

## Overview

Two modes:
1. **Monitoring** — audits completed work against the other roles' checklists, reports deviations, recommends improvements.
2. **Pipeline** — given an issue directly, runs architect → implementer → reviewer end to end.

Mandatory stop points follow `~/.claude/CLAUDE.md` → Skill Orchestration → Pipeline autonomy, as waived (or not) by this repo's `.claude/CLAUDE.md` → Git-процесс — that section is the only record of what is waived; read it there rather than trusting a copy. The merge confirmation is never waivable: before every single merge, tech-lead asks the owner via `AskUserQuestion`. `/manager` (`.claude/skills/manager/SKILL.md`) runs Phases 0–5 of Mode 2 unattended — Phase 5 in its night form, the session's entry and docs PR without a merge — with the substitutions listed there and the exceptions in `.claude/CLAUDE.md` → Режим manager; it never merges.

Tech Lead also owns enforcement of the Codex checkpoint: `.claude/CLAUDE.md` → Codex — только финальное ревью перед мержем (reviewer Step 6-pre on a round that ends in a merge, round 3 included, and tech-lead's own 6-pre run; the Phase 5 docs PR gets none — owner's decision 2026-10-23, #769). That section overrides `~/.claude/CLAUDE.md` → ABSOLUTE RULE and Timeout policy for this repo. Where this skill and `~/.claude/CLAUDE.md` disagree, the project's `.claude/CLAUDE.md` governs (see its note under «Модели по ролям pipeline»).

### Phases run as spawned agents

Every phase is an `Agent` spawn with an explicit `model` (`.claude/CLAUDE.md` → Модели по ролям pipeline): architect `fable` for a first plan and `opus` for every Plan Update (`.claude/CLAUDE.md` → Экономия токенов), implementer and reviewer `opus`, `subagent_type: "general-purpose"`. The spawn's `model` is what sets the phase's model; a skill's frontmatter does not survive a `Skill()` call inside one turn (#42). Never ask the owner to switch `/model` between phases.

Spawn prompt — every phase gets these, in this order:
1. Role and issue: "You are the <ROLE> phase for GitHub issue #<N> (ChaoticMelnik/binarius, working dir <path>)."
2. "First action: `Skill(skill: \"<role>\")`, then follow it."
3. "You have no `AskUserQuestion`. A clarify question is asked only on a real fork the issue and the plan leave open — no minimum (`.claude/CLAUDE.md` → Постоянные ответы владельца → «Вопросы `/clarify`»), none on a topic with a standing answer there; each with 2-4 options, the recommended one first, in Russian. With questions: return them in your final message and stop, making no edits — you will be continued with the answers. With none: write «развилок нет» in your hand-off and go straight on to the plan / the implementation in this same run."
4. Node: `eval "$(fnm env)" && fnm use`. Code search: CodeGraph first for every structural question, grep only for what it cannot answer (`.claude/CLAUDE.md` → CodeGraph → «Приоритет — codegraph»).
5. What to return: the role's own hand-off (plan comment URL / PR URL and commit list / review verdict with merge request) plus deviations and anything unfinished.
6. For an architect Plan Update: the review round it follows.
7. For a reviewer: the review round (1-3), and the Codex usage limit preflight saw — `until <ДД.ММ HH:MM> (job <id>)` or `none`.

**Clarify relay.** Architect and implementer start with a clarify round only when they have a question (`.claude/CLAUDE.md` → «Вопросы `/clarify`»): the agent returns its questions and stops; with none it writes «развилок нет» in its hand-off and continues on its own. Tech-lead asks them in one `AskUserQuestion` call (at most 4 questions per call — the rest go in a second call, never replaced by the recommended default: #284's fifth question was relayed as a default, 2026-10-07), passing every option through unchanged, then continues the same agent with `SendMessage` carrying the answers (a fresh spawn with the answers in its prompt if the agent is gone). A question the agent marks as a plan defect goes to the architect for a Plan Update, not to the owner — and so does one whose text says the plan contradicts itself, even when the agent offers options (#590: such a question was relayed to the owner as a choice, 2026-10-17). Tech-lead's own clarify questions (Phase 0, merge, change of approach) follow the phases' rule: an option that depends on a tool or API capability is verified by a safe read-only probe before it is asked, and the action it proposes (a merge above all) is never performed before the answer (architect Step 5, implementer Step 0).

**The main context runs no tests** (`.claude/CLAUDE.md` → Экономия токенов → «Тесты — только в спавн-агентах», #511). Tech-lead does not run `pnpm check`, `pnpm test`/`typecheck`/`lint`, vitest, `tooling/mutations.ts` or a per-commit check; it reads the phases' hand-offs and `gh pr checks`. Where a rule needs a run (a rebase before the merge, a stacked rebase), it goes to one implementer spawn (`model: "opus"`) with that narrow task. Not test runs, and done here: `pnpm db:migrate` of the shared database after a merge (Step 7), the Codex 6-pre runs and the whole-feature re-hash, and `git range-diff` on doubt about a rebase-only verdict («Mergeability right before the merge»).

**Failed or stalled phase.** When a phase agent fails or stalls (e.g. the stream watchdog), first make sure it has ended — its task notification reports `completed` or `failed`; if it is still running, stop it (`TaskStop`) or continue it, never run a second agent beside it, since a live agent can still post after the check. Then check on GitHub what it already did — issue comments, Pipeline Status, pushed commits, PR state — against what it was supposed to return. Only the missing part is redone: continue the agent, or spawn a fresh one with the done parts named as done. A blind re-spawn duplicates a posted plan or a status change (#56: the architect stalled after posting its Plan Update).

**Continuing a phase after a model limit.** A phase stopped by a usage limit (its transcript's last model is `<synthetic>`) and continued after the reset — `SendMessage`, or a fresh spawn with the done parts named — gets its remaining steps in its skill's order, never reordered to save the work first: for an implementer, every unpushed commit but the head gets its per-commit check and the head the full `pnpm check` (implementer Step 5) before the push — «check the commits, then push», never «push first». The continuation names the commits seen in the worktree and which of them are already checked. #537, 2026-10-21: the resume after the Opus weekly limit said «First push the branch now, then … the per-commit check of `7eb43c24`»; the commit failed `typecheck` after it was pushed, and PR #703 went in by squash.

**Merge relay.** The reviewer never merges when spawned; it returns its verdict and a merge request (PR, approved head, the id of the 6-pre Codex job or its skip line, the ready-to-merge comment URL or the classifier's refusal, checks, allowed methods). Tech-lead asks via `AskUserQuestion` immediately before this specific merge, runs `gh pr merge <N>` with the chosen allowed method only on an explicit yes — never `--admin` or another bypass — and then confirms `gh pr view <N> --json state,mergedAt` shows `MERGED`. With `--delete-branch`, every worktree holding the PR's branch is removed first (`git worktree list --porcelain` — the implementer's `impl-<N>`, a night's `audit-<date>`): `gh` deletes the local branch before the remote one and stops when a worktree holds it, so the PR merges and the remote branch stays (#724, 2026-10-22). After the merge, a closed `mut/<N>-*` branch of the PR's CI mutations (implementer Step 5) is deleted too (`git push origin --delete <branch>`) — by day and when merging a `/manager` session's PR (#75: `mut/75-schema-check` outlived the merge, 2026-10-22). After a Codex skip the reviewer posts the ready-to-merge comment with the skip line itself (reviewer Step 6b). When it returns that the permission classifier refused the comment (#258, 2026-10-06: a sub-agent's comment after a relayed skip was refused as a CI bypass), tech-lead posts the returned body from the main context. After the owner's explicit skip by day (Timeout policy), tech-lead continues the reviewer with the answer, and the reviewer posts the ready-to-merge comment with the owner's skip line (reviewer Step 6-pre item 4); on a classifier refusal, tech-lead posts the returned body. The merge question names the skip, or the Codex job, and the open Minors.

**Mergeability right before the merge.** After the yes and immediately before `gh pr merge`, re-check `gh pr view <N> --json mergeable,headRefOid` (`UNKNOWN` → read it again): a neighbour can merge during the review (#152: #429 merged during it and the PR turned `CONFLICTING`). `CONFLICTING` → no merge: the implementer gets a rebase-only task (resolve the conflicts, nothing else — implementer → Fixing Review Findings → Step 5, «A rebase-only task»). It ends with one PR comment — the conflict hunks recorded at the rebase's stops, the old and new heads, the `git range-diff` output in `<details>` and the verdict — and the line «range-diff: только конфликты, <link to that comment>» or «range-diff: изменения сверх конфликтов, <link>» in the PR body (owner's decision 2026-10-23, #769; 38 rebase-only agents in one week ran the whole cascade). The criterion and the record are the implementer's (implementer → «A rebase-only task»): conflict hunks recorded at the rebase's stops; any other `+`/`-` change, even in a conflicting file, is «сверх конфликтов». Tech-lead re-checks it only on doubt (its own `git fetch origin <old-head>` — the SHA from the comment; a force-pushed head stays fetchable — then `git range-diff --no-color --creation-factor=100 "$(git merge-base <old-head> origin/main)"..<old-head> origin/main..<new-head>` in the main checkout, no checkout; on a stack the old base head the comment names replaces the merge-base). A second rebase-only before the merge adds a new comment whose `old-head` is the previous comment's `new-head`, and a new line in the PR body; the earlier lines stay. The **anchor** is the head the mutation table, the Codex final pass and the LGTM covered: walk back from the last line to the first comment of an unbroken run of «только конфликты» lines — its `old-head` is the anchor; the last comment's `new-head` must equal `headRefOid`. A «сверх конфликтов» link ends the walk: its cascade covers the new head, which becomes the anchor. Then:
- «только конфликты» → green `gh pr checks` at the new head — or «no checks reported» on a PR of `.claude/**` and `audits.md` only (`paths-ignore`, #646) — is the whole cascade — no mutation re-take, no reviewer pass, no 6-pre; the merge question names the line and is asked again for the new head (the earlier yes does not carry over).
- «сверх конфликтов» → the same implementer re-takes the mutation table at the new head in one call of `tooling/mutations.ts` (`.claude/CLAUDE.md` → «Доказательства мутаций»), a reviewer pass on the commits beyond the conflict resolution (Phase 4 → «A PR left In Review by a manager session», step 3), tech-lead's own 6-pre run at the new head (Phase 4; none for a `/manager` session's PR) — its "Known, moved open into a follow-up issue" field filled with the findings the owner already moved to the Backlog issue (#637: left empty, the run re-raised #643's Minor as a Major) — green checks, and the owner is asked again for the new head.

---

## Mode 1: Monitoring

### When to invoke

At the end of a session, for its `audits.md` entry (Mode 2 → Phase 5), or when the owner asks for a process audit. The checklists below are the catalogue of deviations: tech-lead applies them to the phases' hand-offs and to GitHub as each task passes, and the entry records only what deviated, never the steps that passed (owner's decision 2026-10-23, #769). Nothing is posted per task.

### Architect step — check

- [ ] Issue has an implementation plan comment posted **before** it moves to In Progress
- [ ] Plan covers the full domain scope, not just explicitly mentioned entities
- [ ] If returned from review: a "Plan Update" comment exists before re-implementation started
- [ ] The plan states the size estimate; an estimate above 3000 added lines was split before the plan was posted

### Implementer step — check

- [ ] Branch name matches convention: `feat/<N>-*` / `fix/<N>-*`
- [ ] Commits reference the issue: `#<N>: description`
- [ ] PR body has: what changed, `Closes #<N>` (`Refs #N1, #N2 …` for a Phase 5 session audit docs PR), a test plan
- [ ] Issue moved to In Review only after the PR was created
- [ ] PR contains only relevant files (no `git add .` artifacts)
- [ ] No new type/build errors in the diff
- [ ] Mutation evidence is one PR comment with the table of `tooling/mutations.ts` (header `head=` equals the PR's final head — or, after a rebase-only whose PR body carries «range-diff: только конфликты», the anchor — the `old-head` of the first comment in the unbroken chain of «только конфликты» rebases («Mergeability right before the merge»); `list-sha256=` matches the list in its `<details>` block); the hand-off names one full `pnpm check` at that head

### Reviewer step — check

- [ ] Review comments are specific and actionable, not vague
- [ ] Blockers/Majors were noted before any approval
- [ ] Codex ran only where reviewer Step 6-pre and tech-lead's own 6-pre run say. The last completed run is at the merged head — or at the anchor of an unbroken chain of «только конфликты» rebases whose last `new-head` is the merged head («Mergeability right before the merge») — or a skip line is accepted ("Whole-feature pass — check", by kind).
- [ ] If a Blocker/Major was found: reviewer returned the issue to **Todo** before any re-implementation started; a Minor-only review did not
- [ ] If clean: the ready-to-merge comment is posted (by the reviewer, or by the spawner after a classifier refusal), carries the skip line when Codex was skipped, and the reviewer did not self-approve
- [ ] Every review round reviewed `gh pr diff` (the whole feature), never an iteration delta
- [ ] CI (`gh pr checks`) was green on the merged head (a PR of `.claude/**` and `audits.md` only has none, #646) — `pnpm check` there carries the automated gates (manifest targets, status literals, constraint coverage); the reviewer's Runtime check took it from CI, not from a local `pnpm check`
- [ ] Neither tech-lead nor `/manager` ran a test (`pnpm check`/`test`/`typecheck`/`lint`, vitest, mutations, a per-commit check) in the main context ("Phases run as spawned agents" → «The main context runs no tests»)

### Whole-feature pass — check

The reviewer's final Codex pass (Step 6-pre, `Whole-feature pass` marker) covered exactly the approved diff. A skip line instead of a run (in the review, the ready-to-merge comment, or tech-lead's PR comment from its own 6-pre run; texts in reviewer Step 6-pre item 4), by kind:
- **Usage limit:** `node "$COMPANION" status <id> --json | jq -r '.job.status, .job.summary, (.job.progressPreview // [] | .[])'` prints `failed` and a summary or a `progressPreview` line matching `hit your usage limit` — the text can sit only in `progressPreview` while the summary holds Codex's first message (#668: job task-mvhvi7oq-7flfqh, 2026-10-21). If `status` answers "No job found" (the job was started from a review worktree that is gone, and jobs are keyed by working directory): `jq -r --arg id <id> '.jobs[]? | select(.id == $id) | .status, .summary' ~/.claude/plugins/data/codex-openai-codex/state/*/state.json`.
- **The owner's skip** (by day, or after the failures of tech-lead's own 6-pre run): recorded as an owner-approved deviation, not a Major; its source is the `AskUserQuestion` answer in this session.
- **A PR of a `/manager` session:** the manager line is the rule (`.claude/CLAUDE.md` → Режим manager → «Codex ночью не запускается»), not a deviation; no run to re-hash.

Anything else is a Major audit finding. Otherwise find the newest completed job with the marker and re-hash:

```bash
PR=<N>
COMPANION="$(jq -r '.plugins["codex@openai-codex"][0].installPath' ~/.claude/plugins/installed_plugins.json)/scripts/codex-companion.mjs"
node "$COMPANION" status --all --json | jq -r --arg pr "$PR" \
  '[.latestFinished, .recent[]?] | map(select(. != null and .status == "completed"
      and ((.request.prompt // "") | test("^Whole-feature pass #" + $pr + ":"))))
   | sort_by(.completedAt) | reverse | .[] | "\(.id) \(.completedAt) \(.request.prompt | split("\n")[0])"'
# first line = the newest completed final pass: base=<b> head=<h> diff-sha256=<x>
git fetch origin main
git merge-base --is-ancestor <b> <h> && git merge-base --is-ancestor <b> origin/main && echo base-ok
git diff --no-color --no-ext-diff <b> <h> | shasum -a 256        # must equal <x>
gh pr view $PR --repo ChaoticMelnik/binarius --json headRefOid --jq .headRefOid   # must equal <h>, or the last new-head of the chain whose anchor is <h>
gh pr view $PR --repo ChaoticMelnik/binarius --json body --jq .body | grep -o 'range-diff: только конфликты, [^ ]*'   # the chain, newest last; read each comment's old-head/new-head
git fetch origin <h>   # an anchor that was force-pushed away is still fetchable by SHA (probe 2026-10-23, PR #760)
```

`<h>` must be the head the LGTM comment approved — at the round limit, the head round 3 reviewed; after tech-lead's own 6-pre run, that run's head — and the one that merged (the last line) — or, after «только конфликты» rebases, the anchor of their chain: each comment's `old-head` equals the previous one's `new-head`, and the last `new-head` merged — and `<b>` a `main` commit that `<h>` descends from. No marker, a different head, or a different hash is a Major audit finding; a broken chain (an `old-head` that is not the previous `new-head`) is one too. `status` lists only this Claude session's jobs and the companion keeps the newest 50 per workspace, so run this check in the session that ran the pipeline. Jobs are also keyed by working directory: a run started from a review worktree is listed only by `status` run from that worktree's path (or its state directory under `~/.claude/plugins/data/codex-openai-codex/state/`), so the reviewer returns the job id and tech-lead re-hashes from the marker (#306, 2026-10-07).

### Audit proposals — check

- [ ] Every proposal of the previous audit entry in `audits.md` carries a status (Phase 5 format)

### Model policy — check

Run only on the owner's request or on a suspicion of a substituted model — a hand-off that names a model other than the spawn's alias, or none, while the work looks like another model's; a phase visibly cheaper or faster than its model; a task notification whose `resolvedModel` differs from the alias (owner's decision 2026-10-23, #769). It is not part of the session entry otherwise.

Each phase's spawn requested its policy model and ran on it. Every spawn, at any depth, leaves `subagents/agent-<agentId>.meta.json` (`model` = requested alias, `description`, `spawnDepth`, `toolUseId`, `parentAgentId`). The model the harness assigned (`resolvedModel`) is stored only in the root transcript, on the spawn's `tool_result`, and only for depth 1 once a result came back (`completed` or `async_launched`). The agent's own transcript names the model it actually ran on:

```bash
S=~/.claude/projects/-Users-user-Documents-Binarius/<session-id>
resolved=$(jq -c 'select(.toolUseResult.resolvedModel? != null)
  | {id: (.message.content[] | select(.type == "tool_result") | .tool_use_id), m: .toolUseResult.resolvedModel}' "$S.jsonl")
# only message.model is the model the agent ran on; a transcript also carries advisorModel
# and attachment.model, and a plain grep for "model" reports those as extra ids (#68)
ran() { jq -r 'select(.message.model != null) | .message.model' "$S/subagents/agent-$1.jsonl" | sort -u | tr '\n' ' '; }
for m in "$S"/subagents/*.meta.json; do
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
```

Output of #56's own run (abridged):

```
Architect #56 research + questions | depth 1 | requested fable | resolved claude-fable-5-1 | ran claude-fable-5-1
Reviewer #56 PR #61 | depth 1 | requested opus | resolved claude-opus-5-5[1m] | ran claude-opus-5-5
Implementer #56 clarify round | depth 1 | requested opus | resolved no result record (continued via SendMessage or still running) | ran claude-opus-5-5
Simplify review PR 61 | depth 2 | requested sonnet | resolved not recorded at depth >= 2 | ran claude-sonnet-5
- | depth 3 | requested inherited from parent a04adae24974857c8 (parent ran claude-opus-5-5 ) | resolved not recorded at depth >= 2 | ran claude-opus-5-5
```

Per row, comparing ids up to the first `[` (`[1m]` names the context-window variant, not a different model):
- (a) `requested` is the policy alias for that phase or sub-tool;
- (b) when `resolved` is an id, it is that alias's id in `.claude/CLAUDE.md` → Модели по ролям pipeline;
- (c) `ran` is exactly one id, and it is the table's id for the requested alias. `<synthetic>` is not a model: it is the harness's placeholder on an API error message (a usage limit, a 429). Drop it before judging (c), and record what the row shows instead: the agent died, and whether it had posted anything (#132, #136, #138 and #236 on 2026-10-03/04: Fable and Opus weekly limits).

Depth 1 gets all three when a result came back; a phase continued through `SendMessage` has no result record and is judged by (a) + (c). Depth ≥ 2 (the reviewer's 3b-3d) is judged by (a) + (c). A depth-3 row with no requested model is a sub-tool's own fork: it is judged only by (c) against its parent's `ran`. Severity: Major if a first-plan architect did not run on Fable without the «план на Opus (лимит Fable …)» header line; a Plan Update on Opus is the policy, not a deviation; Minor if another phase ran above its policy model (cost only).

### Report format

The session entry in `audits.md` (Mode 2 → Phase 5 holds its format). A process audit the owner asks for outside a session is reported to the owner directly in the same shape — deviations, findings, proposals — never as a per-issue «Process Audit» comment.

---

## Conflict detection and merge order

Standing responsibility, not tied to a single issue. Run whenever a new issue enters In Progress, or when asked.

### Step 1: Build the active branch map

```bash
gh pr list --repo ChaoticMelnik/binarius --state open --json number,title,headRefName,baseRefName
```

Also list issues with Pipeline Status In Progress / In Review via `/github` skill.

### Step 2: Detect file-level overlaps

```bash
git diff --name-only main...feat/<A>-description
git diff --name-only main...feat/<B>-description
```

If the file lists overlap, the branches conflict. Особо чувствительные общие файлы (высокий приоритет при детекте конфликтов): `packages/db` (Drizzle-схема и миграции), `packages/shared` (общие типы/контракты API и Socket.IO-событий), OAuth/refresh-token middleware в `apps/backend`.

### Step 3: Determine merge order and rebasing chain

When two or more issues touch the same files, they must not both branch from `main`. Chain them:

```
main
 └── feat/A   ← branches from main
      └── feat/B   ← branches from feat/A, not from main
```

Rules:
- The issue that touches the shared file first (already in progress, or higher priority) is the base branch for dependents.
- Each dependent branch rebases onto its parent, not onto `main`.
- When A merges into `main`, B rebases onto the updated `main` immediately:
  ```bash
  git fetch origin
  git -c core.commentChar=';' rebase origin/main
  ```
- If B's PR targets A's branch, retarget it to `main` before A merges and merge A without `--delete-branch`: Mode 2 → "A PR left In Review by a manager session", step 1.

### Step 4: Announce the merge order

Post as a comment on each affected issue/PR, or directly to the user:

```
## Merge Order Notice

1. #A (feat/A-description) — base; merge first
   Shared files: ...

2. #B (feat/B-description) — depends on #A
   Branch from: feat/A-description (not main)
   Action required: rebase onto main after #A merges
```

### Step 5: Block out-of-order merges

If a PR is about to be merged out of the declared order: comment on the PR that it must wait, and do not approve it.

### Step 6: Update the chain when issues change

Re-run the conflict check whenever: a new issue enters In Progress, a PR is merged, or an issue's file scope changes (the Architect updates the plan).

### Step 7: Parallel implementers on one machine

Several implementers or reviewers at once (#177, #192, #103, #166 on 2026-10-02) share the host, the dev databases and the session scratchpad. Each spawn prompt states:
- **Own worktree**, created by the agent itself with `git worktree add .claude/worktrees/impl-<N> -b <branch> origin/main` and `git worktree lock` — an `isolation: "worktree"` spawn's tree is removed when its clarify round ends unchanged. The main checkout belongs to one agent at a time. Tech-lead unlocks and removes the worktree after the merge. A worktree has no `TEST_DATABASE_URL`/`REDIS_URL` (the main `.env` holds neither): the spawn prompt names the README values, `postgres://binarius@127.0.0.1:5434/binarius` and `redis://localhost:6379` — #511's implementer lost a full `pnpm check` finding that out. Exception — a worktree-isolated session (tech-lead itself runs inside `.claude/worktrees/<name>`): the harness lets its agents write only in that one worktree (an `EnterWorktree` into another one is refused), so implementers and reviewers run one at a time in the session's worktree, and extra worktrees are useful only to read-only architects (#241, #78, #79, #300, #358 on 2026-10-08).
- **Manager worktrees** (`impl-<N>`, `review-*`, `audit-<date>` of a `/manager` night) are left in place after the night; tech-lead removes them after the merge like its own.
- **Own scratch subdirectory** (`<scratchpad>/impl-<N>/`, `review-<N>/`, `arch-<N>/`, `rebase-<N>/`): agents overwrote each other's `check.sh` and one `pnpm check` ran in the wrong tree; three architects planning in parallel truncated each other's `plan-<N>.md` in the scratchpad root (#125, #126, 2026-10-06). The rule covers the short spawns of a merge relay too — a rebase-only implementer, a rebase-check reviewer (#720's rebase spawn overwrote the parallel #729 rebase spawn's scripts, 2026-10-22).
- **Sub-skills pointed explicitly** at `gh pr diff <N>` and the worktree: `/security-review` and `/code-review` load the main checkout's diff by default. A brief alone did not hold (#97, #85: both loaded the main checkout's diff, and one `/code-review` fork checked the PR branch out in the main checkout for two minutes): the spawn prompt hands them the diff saved as a file in the reviewer's scratch dir plus the review worktree path, and forbids `git checkout`/`switch` in the main checkout.
- **Shared-resource window**: before a full `pnpm check`, a VM/host change or a long series, `ps -axo pid,comm,args | awk '($2 ~ /(^|\/)node$/ && /vitest|db-clock-probe/) || ($2 ~ /(^|\/)bash$/ && $4 ~ /check-stability\.sh$/)'` must show no foreign run, and the guard stops the command on a hit (non-zero exit or a wait loop) — one that only prints the hit let #97's run overlap #85's on the shared database; tech-lead serialises anything that restarts shared services ("GO" only when the others are idle). The guard matches the process name, not the command text: `pgrep -f 'vitest'` (even `'[n]ode .*vitest'`) also matches the shell whose own command line holds the pattern, so its wait loop never clears (#134, #17 on 2026-10-06).
- **At most two reviewers at once**: each spawns three opus/sonnet sub-agents, and three parallel reviews (#119, #185, #104 on 2026-10-03) exhausted the session limit together before any of them posted; a dead reviewer is re-spawned only after GitHub shows it posted nothing.
- **At most three Opus phase agents at once** across implementers and reviewers: five at once (#134, #99, #133, #19, #17 on 2026-10-06) hit the session limit together and stopped mid-step; the rest wait in tech-lead's queue.
- **Fresh review worktree path per round**: a removed review worktree leaves its Codex broker attached to the path, and a later round that recreates the same path fails Codex on the first attempt (#99 round 2, 2026-10-06). The reviewer names it `review-<PR>-r<round>-<epoch>` and runs `codex status` from that worktree — jobs are keyed by working directory.
- **No shared Telegram token**: a runtime check that starts `bot` or `backend` (the staff bot polls inside `backend`) runs with dummy `TELEGRAM_BOT_TOKEN`/`ADMIN_BOT_TOKEN` unless the check itself needs Telegram, and never with a token another poller uses. Two pollers on one token end each other with 409, and the loser's container stays "running" (#136 on 2026-10-03: a worktree copy of the main `.env` stopped both pilot bots for a day). The local `.env` has its own dev bots since 2026-10-04, but parallel agents would still share those.
- **A plan's stand check is not forbidden by parallelism**: a spawn prompt does not ban starting services wholesale; when the plan runs a documented procedure on the local stack, the prompt names where (own worktree, own database, dev bots under the rule above, PIDs, loopback only — the backend binds `0.0.0.0` with no host setting, so a dev branch's stand is kept on `127.0.0.1` by a preload in the scratch dir, #405) and when (before or after the PR). #391's implementer got a blanket «do not start services» against its plan's procedure check, and the owner had to settle it (2026-10-16); #405's did again (2026-10-17).
- **Unmerged migrations stay off the shared test database**: an implementer whose branch adds a migration points `TEST_DATABASE_URL` at a database of its own (`createdb -h 127.0.0.1 -p 5434 -U binarius binarius_impl_<N>`, then `DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate`) and drops it after the merge. The shared `binarius` database gets only migrations that are on `main` — and gets them: after merging a PR that adds a migration, tech-lead runs `DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate` (a migration, not a test run) from the updated main checkout once the guard above is clear, or every `pnpm check` on a fresh `main` fails `schema.db.test.ts` (0013-0015 were missing after #17/#89 merged, 2026-10-06) — and nobody drops tables or edits `drizzle.__drizzle_migrations` there by hand (#235: an uncommitted 0011 went into the shared database and was taken out with `drop table` plus `delete from drizzle.__drizzle_migrations` while other agents' `schema.db.test.ts` ran against it).
- **Long data jobs outlive no phase**: a phase agent's background job (a multi-hour `fetch`, a full backtest) dies with the agent — #381's 28-pair fetch stopped at pair 14 when its implementer ended on an API 403 (2026-10-15). A job longer than ~15 min is started by tech-lead as its own background task; the phase returns the command, the env and the log path instead of waiting on it.
- **Stop only your own processes, by PID**: an agent records the PID of every process it starts and stops exactly those (`kill <pid>`); never `pkill -f`/`killall` by a command-line pattern, which matches every session's `tsx src/index.ts` alike (#396 on 2026-10-09: the implementer's `pkill -INT -f "tsx src/index.ts"` could have stopped another session's dev backend or worker, and nobody could tell afterwards).

---

## Mode 2: Pipeline (issue given directly)

### Workflow

#### Phase 0 — Preflight (once per session)

```bash
git fetch origin
git status
git log --oneline -3
```

Confirm: working tree clean; local `main` not behind `origin/main` (else `git pull --rebase origin main` first). Report any divergence before proceeding.

Phase 0 runs once, before the session's first issue (owner's decision 2026-10-23, #769). For every later issue of the session only the git block above is repeated — it reports the tree's state and decides nothing else; the preflight items below are not re-run, except item 6, which precedes every Fable spawn, and the task-dependent halves of items 2 and 4, which run before each implementer spawn whose plan touches them (owner's answer 2026-10-23, #769). `/manager` runs it once per night the same way (manager → Phase 0 step 2).

**Preflight checks (mandatory, same phase):**

1. **Codex** — `node "$COMPANION" setup --json` (companion path as in "Whole-feature pass — check"): `ready`, `auth.loggedIn`. Not ready → `Skill(skill: "codex:setup")` once; still not ready → STOP and ask the owner. Then the budget: `node "$COMPANION" status --all --json` — a recent job whose summary or `progressPreview` matches `hit your usage limit` (reviewer Step 6-pre item 4) does not stop or delay the pipeline: record `until <ДД.ММ HH:MM> (job <id>)` for the reviewer's spawn-prompt item 7 (the rule: `.claude/CLAUDE.md` → Codex — только финальное ревью перед мержем). An issue needs one run per review round that reaches 6-pre (at most 3), plus one per tech-lead's own 6-pre run, which repeats for every new head with changes beyond the conflicts of a rebase («Mergeability right before the merge»).
2. **GitHub** — `gh auth status`; if stale, ask the owner to `gh auth login` / refresh. If the plan's files include `.github/workflows/*` (checked per task, before the implementer spawn): the token needs the `workflow` scope, or `origin` must be an SSH remote (`git remote -v`) — otherwise the push fails at the end of implementation.
3. **Project CLAUDE.md on main** — `git diff origin/main -- .claude/CLAUDE.md` must be empty: the harness loads whatever is checked out, and a waiver living only on an unmerged branch was once acted on for a day.
4. **Runtimes** — every runtime the acceptance criteria exercise is available locally at CI's version: Node from `.node-version` (`eval "$(fnm env)" && fnm use`), Postgres/Redis (`docker compose ps`), Docker/Compose/buildx if the issue touches images or compose (checked per task, before the implementer spawn); CLI plugins match what CI uses.
5. **Previous audit** — every proposal of the latest `audits.md` entry has a status (Phase 5 format). An unmarked proposal, or `открыто` without a date and owner, is reported to the owner as a warning before the pipeline starts; it does not stop the pipeline. Two more warnings, reported the same way and stopping nothing: (a) a night whose session ended without its docs PR — the newest `$ROOT/.claude/worktrees/manager/state.json` (or the newest archived `state-<start>.json`) has `ended` and no `audit_pr`, and no `## Сессия <its date> — manager` header is in `audits.md` on `origin/main` or in an open `docs/audit-*` PR; (b) a PR merged after PR #777 (`gh pr view 777 --json mergedAt`), not on a `docs/audit-*` or `docs/*-audit` branch, whose `#<number>` appears neither in `audits.md` on `origin/main` nor in the diff of an open `docs/audit-*` PR (`gh pr list --state merged --limit 100 --json number,headRefName,mergedAt`, then `grep -q "#<n>\b"`). Phase 5 records both (item 2a; owner's answers 2026-10-23, #769).
6. **Model limits** — before a Fable spawn, the check in `.claude/CLAUDE.md` → Экономия токенов → «Лимиты до спавна»: a Fable limit seen in the last 7 days and no reset reported by the owner → the first plan goes to `opus` directly.

**Timeout policy (every checkpoint):** usage limit — `.claude/CLAUDE.md` → Codex — только финальное ревью перед мержем. Any other failure: at most 2 attempts per Codex run; after the second, stop and ask the owner — no third attempt by default. The owner may choose to skip a checkpoint only by an explicit answer; the line is the owner's skip line (reviewer Step 6-pre item 4).

#### Phase 1 — Architect

Spawn the architect (`Agent`, `model: "fable"` — or `opus` under preflight item 6 — prompt per "Phases run as spawned agents"). Round 1 returns clarify questions, if the agent has any, → clarify relay → the same agent drafts the plan and posts it (no Codex — planning has none); with no question the agent posts the plan in that same run (spawn item 3). Never perform architect steps inline, regardless of how small the issue looks.

If this repo's CLAUDE.md has waived the commit/PR stop points: no text between phases — spawn the implementer next. If not waived: report the plan to the owner and follow whatever stop behavior the unwaived pipeline default implies before continuing.

#### Phase 2 — Implementer

Before the spawn, a plan more than a day old or written by another session is checked against `main`: `git log --oneline <plan's base sha>..origin/main -- <files the plan names>`. Any output → the architect writes a round-0 Plan Update first (all seven plans of 2026-10-06..09 taken on 2026-10-10 needed one; #396 and #397 on 2026-10-09). When the issue already has an open PR, the spawn prompt states its review rounds counted by the `## Review round` headings of its reviews and comments (reviewer Step 6-pre) — an empty `gh pr view --json reviews` is not «no review» (#123: PR #435's round 1 was missed, 2026-10-18).

Before the spawn, the task-dependent halves of preflight items 2 and 4 (Phase 0), when the plan's files touch them. Spawn the implementer (`Agent`, `model: "opus"`). Round 1 returns its clarify questions, if any (implementer Step 0; with none the implementer starts work in that same run), → clarify relay; plan defects among them go to the architect first (a fresh architect spawn on `opus` for the Plan Update, with the plan URL and the defects) → the implementer continues with the answers and the Plan Update. Never perform implementer steps inline.

If a merge-chain base branch (Mode 1, Step 3) has already merged into `main` since the chain was declared, rebase onto `main` before implementation continues — check `gh pr view <base-PR> --json state,mergedAt` first.

#### Phase 3 — Finalize

Once the PR exists and the issue is In Review: spawn the reviewer (`Agent`, `model: "opus"`) — the Tech Lead owns the full lifecycle end to end. No per-task audit comment is posted (owner's decision 2026-10-23, #769): deviations go into the session's entry (Phase 5). A PR stacked on another open PR (Mode 1 Step 3) is reviewed only after its base merges and it is rebased onto `main` — until then `gh pr diff` also shows the base's commits (#252 on #250, 2026-10-06).

#### Phase 4 — Review findings loop

Track the iteration count (starts at 1 for the first review). **Hard limit: 3 review rounds per issue** (owner's rule, 2026-09-30) — there is no round 4. An issue split by size into several PRs (architect Step 4a, or the implementer at the fallback line) counts its rounds per PR: each PR has its own limit of 3 (owner's decision 2026-10-20, #666: #673 and #674 took two rounds each).

Only a Blocker or Major counts as "finds issues" and returns the issue to Todo (reviewer → Severity Guide). A Minor-only verdict goes to the merge relay below as a clean PR; the merge question names the open Minors, and the owner decides whether they are fixed in another round first. Minors still open at the merge go, without a question, into one new Backlog issue (`/github`: "Create an issue" + "Add issue to Project #2", body with `Refs #<N>`, the PR link and each finding with severity and comment link); its number goes into the report (`.claude/CLAUDE.md` → Постоянные ответы владельца).

**If the reviewer finds a Blocker or Major:**
1. Iteration 1 → the architect first (Plan Update on `opus`; the issue returns to In Progress), then the implementer, then the reviewer again for this issue. The fix round's implementer is a **fresh spawn**, not a `SendMessage` continuation of the first one: its prompt carries the PR, the review comment URLs, the Plan Update URL, the branch and the worktree, and it reads them anew — a continued implementer drags its whole first-round context into every call (`.claude/CLAUDE.md` → Экономия токенов).
2. Iteration 2 → stop: this starts a **new cycle**. Ask the owner via `AskUserQuestion` for a **change of approach** — the same loop again is not among the options:
   - (a) split part of the issue into a separate issue (created and added to the board via `/github`), and narrow this PR;
   - (b) re-plan from scratch: the architect writes a new plan against the current branch.
   Do not spawn the implementer until the owner picked one. Round 3 is the last one; say so in the question.
3. Iteration 3 → no further round. Round 3 always runs the reviewer's 6-pre pass, whatever 3b-3d found; its findings join the round's, and its job id or skip line goes into the merge question and the audit. The remaining findings do not go into a follow-up list — they go into **one new separate issue**:
   - Any **Blocker** left → the merge is held; ask the owner via `AskUserQuestion` what to do (fix it in this PR outside the round count / close the PR / other). Nothing is merged without that answer. A fix in this PR (a round-3 Blocker fix) moves the head: tech-lead's own 6-pre run (below) at the new head, before the merge question.
   - Only Minor left → create the new issue in Backlog without a question, as for a Minor-only verdict above, then the merge relay below — the merge question names the findings left open and the new issue.
   - A Major among them → ask the owner via `AskUserQuestion` to confirm the new issue: its draft title and the full list of findings it carries (each with severity and the PR comment link). Only on a yes: create it with `/github` ("Create an issue" + "Add issue to Project #2"), body with `Refs #<N>` and the PR link. Then the merge relay below, as for a clean PR — the merge question names the findings left open and the new issue. A no → ask what the owner wants instead; do not merge before that.
   The reviewer does not post LGTM for such a PR; the audit records it as "merged at the round limit, findings in #<new>".

**If the reviewer reports the PR is clean:**
It posted the ready-to-merge comment or returned the classifier's refusal (Merge relay), and returned a merge request. Merge relay: `AskUserQuestion` immediately before this merge, `gh pr merge` only on an explicit yes, then confirm `state == "MERGED"`. **Do not move the issue to Done before that** — a clean review isn't merged work. Then move the issue to **Done** via `/github` skill; Phase 5 runs once, at the session's end.

**Tech-lead's own 6-pre run** (Phase 4 iteration 3 after a round-3 Blocker fix; a rebase of an approved PR before its merge whose range-diff verdict is «сверх конфликтов» — «Mergeability right before the merge» under Phases run as spawned agents; never for a `/manager` session's PR, «A PR left In Review by a manager session» step 2). Not a review round.
1. `gh pr checks <N>` at the current head: wait while running. Red → report it to the owner; no run, no merge question.
2. The reviewer's Step 6-pre command, from the main context, at the current head. The prompt's "Known, moved open into a follow-up issue" field (`.claude/codex-review-prompt.md`) lists only the findings the owner has already moved, open, into a follow-up issue (the round-limit issue or a Backlog issue), so a re-run on a moved head reports only what is new; a finding this PR fixed is never on that list — the pass must still see an incomplete fix (#536: two re-runs after rebases re-listed tracked findings).
3. Outcome:
   - Clean → the job id goes into the merge question.
   - Blocker/Major → post it as a PR comment. On a PR whose last review round was 3, go to the Phase 4 iteration 3 branches (a Blocker holds the merge; a Major goes into the new issue on the owner's yes). Otherwise the owner decides via `AskUserQuestion`: a Plan Update round (the count continues) or close the PR.
   - Usage limit → tech-lead posts the usage-limit skip line (reviewer Step 6-pre item 4) as a PR comment, and the merge question names it.
   - Any other failure → 2 attempts, then `AskUserQuestion` «Codex: запустить позже / мержить без него». On the second answer, tech-lead posts the owner's skip line as a PR comment.

**A PR left In Review by a manager session.** Start from the night's report: the reviewer's verdict and the checks are recorded there, and the night's `audits.md` entry waits in its docs PR `docs/audit-<date>` (manager → Substitution 5) — merged last, with the usual merge question; the morning session's own entry records only its own work — unless the night left no docs PR (Phase 0 item 5 (a)): then Phase 5 item 2a writes the night's entry. In this order:
1. **A stacked PR** (its base is another open PR, «Merge after #<base>»). Deleting the base branch on the base's merge (`--delete-branch`) makes GitHub **close** every PR that targets it, not retarget it (#437 and #439 on 2026-10-10; reopening them needed the owner's permission to re-push the base branch). In this order:
   - before the base's merge, retarget every dependent: `gh pr list --base <base branch> --json number --jq '.[].number'`, then `gh pr edit <dep> --base main` for each;
   - merge the base with `--rebase` and **without** `--delete-branch` — the one exception to the standing merge method; the merge question says so;
   - on each dependent, an implementer "rebase only" spawn (`model: "opus"`, implementer → Fixing Review Findings → Step 5) does: `git -c core.commentChar=';' -c merge.conflictStyle=diff3 rebase --onto origin/main <old base head>`; before the push, implementer Step 5's checks on the rewritten commits — the per-commit check on each but the head, the full `pnpm check` at the head — a commit that fails is reworked before the push; when the rework would need more than the rebase, the branch is pushed as is and the spawn reports it, the PR is squash-merged so no red commit reaches `main`, and the merge question says so (#494 on 2026-10-15: commits 1–4 lost their typecheck in the rebase); then `git push --force-with-lease` and the range-diff comment with its verdict (implementer → «A rebase-only task»); the mutation table is re-taken at the new head only on «сверх конфликтов» («Mergeability right before the merge»). `gh pr view <dep> --json closingIssuesReferences` must name its issue — a PR opened on another PR's branch can lose its `Closes` link when retargeted (#441: #115 stayed open after the merge);
   - delete the base branch (`git push origin --delete <base branch>`) only when `gh pr list --base <base branch>` is empty.
2. **No Codex** (`.claude/CLAUDE.md` → Режим manager → «Codex ночью не запускается»): no run and no question, even when step 1 moved the head; the merge question names the night's manager line (reviewer Step 6-pre item 4).
3. **The merge relay**; Phase 5 runs once, at the session's end. After any rebase onto a moved `main` — stacked or not, textually clean or not — the merge question waits for green `gh pr checks` at the new head (or «no checks reported» on a PR of `.claude/**` and `audits.md` only — `paths-ignore`, #646): a clean rebase still broke CI twice on 2026-10-10 (#446: `tsc` after #448 made `webPublicUrl` required; #447: the longest-answer gate lacked rows for methods merged meanwhile). What a rebase changed beyond the conflicts is decided by its range-diff comment («Mergeability right before the merge»): «сверх конфликтов» — a new assumption, a changed test oracle (#234 `0580dee` and #141 `7b138a9`: rows for methods merged meanwhile) — gets a reviewer pass before the merge question: a short reviewer spawn (`model: "opus"`) on that commit range only; disclosure in the PR alone is not enough. Its Blocker/Major are handled as a round's (Phase 4); on a PR whose 3 rounds are used, the pass is a check, not a round, and a Blocker/Major goes to the Phase 4 iteration 3 branches. The merge question names the pass and its verdict. On «только конфликты» green checks and the line are enough.

A PR with open Blocker/Major («Открытые находки на конец цикла задачи (3-й круг) или сессии менеджера»): the owner decides — a Plan Update round (the round count continues from the night's) or close the PR. A PR whose last round was 3 gets no further round: Phase 4 iteration 3 branches instead.

#### Phase 5 — Session audit

Run once per session, after its last merge — or when the session ends early (a limit, the owner's stop), with what it has: one `audits.md` entry for the whole session and one docs PR (owner's decision 2026-10-23, #769; before it a task left three artifacts — a Phase 3 comment, a Phase 5 report comment and an entry with its own docs PR). Nothing per task.

1. Sync local state:
   ```bash
   git fetch origin
   git checkout main
   git pull --rebase origin main
   ```
2. Append one entry to `audits.md` (`---` separator before it) — deviations and findings only, no recap of the steps that passed:
   ```markdown
   ## Сессия <YYYY-MM-DD> — <tech-lead|manager>: #N1 (PR #P1, <k> кругов, <merged|In Review>), #N2 (…)

   ### Отклонения процесса
   | Задача | Роль | Шаг | Отклонение | Severity |
   |--------|------|-----|------------|----------|

   ### Находки ревью
   | Задача | Finding | Severity | Класс | Root cause | Missed at step |
   |--------|---------|----------|-------|------------|----------------|

   ### Предложения по процессу
   1. <proposal> — **<status>**
   ```
   Классы: `instance-vs-class` (исправлен экземпляр, а не класс), `unverified-claim` (утверждение не проверено исполнением), `env-parity` (проверено по локальной среде, а не по среде раннера), `codex-ops` (операционный сбой Codex), `preflight`, `single-source` (один факт в двух местах), `other`. An empty table is one line «нет». A Blocker/Major round's root cause and the step that should have caught it go into «Находки ревью», not into a separate comment. A model is named only where a hand-off named it from its own transcript (architect → How this role runs); the transcript check is not run for the entry (Mode 1 → Model policy — check).
2a. **What earlier sessions left unrecorded.** (a) A night from Phase 0 item 5 (a) gets its own entry, separate from this session's: «## Сессия <дата ночи> — manager (записана утром <YYYY-MM-DD>): #N1 (PR #P1, …), …», built from the night's report (`report-<date>.html`), its `state.json` and GitHub (the PRs, reviews, «Решение менеджера» comments); proposals carry the night report's «Предложения по процессу» with statuses as in item 3. (b) PRs from Phase 0 item 5 (b) that are still named nowhere at this point and were merged before this session started are added to this session's entry — a row «<PR> — не записан своей сессией» in «Отклонения процесса», and its review findings from GitHub; a duplicate with a still running parallel session's entry is accepted. Both go into this session's docs PR, and its title lists their issues too.
3. **Close the audit loop.** Every proposal ends with exactly one status:
   - `внедрено в #<PR>: <файл> → <секция>` — the skill edit goes into the same docs PR as the session entry;
   - `отклонено: <причина>` — only after the owner's explicit yes via `AskUserQuestion` (one call for all proposals up for rejection); a date of the decision goes inside the reason;
   - `вынесено в #<N>` — the issue is created and added to the board now (`/github`), not "later";
   - `открыто (<YYYY-MM-DD>, <владелец>)` — allowed, and Phase 0 of the next session warns about it.
4. **Docs PR** — branch `docs/audit-<YYYY-MM-DD>` from `main` (a second session that day: `docs/audit-<YYYY-MM-DD>-2`), title «audit: сессия <YYYY-MM-DD> (#N1, #N2 …)», the entry and the skill edits, PR body with `Refs #N1, #N2 …` instead of `Closes` (the issues are already Done; `.claude/CLAUDE.md` → Git-процесс). It gets no reviewer phase, no 3b-3d sub-agents and no Codex pass (owner's decision 2026-10-23, #769) — process text, not code:
   - CI: a docs PR of `.claude/**` and `audits.md` only runs none (`paths-ignore`, #646) — `gh pr checks` answering «no checks reported» is expected; do not wait for it. A docs PR that touches any other file waits for green CI before the merge question, as any PR.
   - The merge relay as for any PR: `AskUserQuestion` immediately before the merge; the question names the entry's proposals with their statuses.

A night's entry is written by the manager itself (manager → Substitution 5); the morning session merges that PR and records only its own work; a night that ended before its Phase 5 is written by the next session (item 2a).

---

## Project Architecture Reference

Стек зафиксирован 2026-09-21 при бутстрапе pipeline. Отправная точка — `binodex-bot-implementation-plan.md`, черновой план поставщика: в репозиторий не входит, использован **только для выбора технологий** и для правил не используется (его бизнес-сценарии и допущения не проверены):

| Компонент | Выбор | Пакет/приложение |
|---|---|---|
| Telegram-бот | Node.js + grammY (TypeScript) | `apps/bot` |
| Backend API | TypeScript + Fastify (OAuth, постбэки, авторизация, состояния) | `apps/backend` |
| Веб-страницы | Fastify + серверный HTML (вход сотрудников, касса, минимальная админка); решение владельца 2026-09-29 (#68, #34) | `apps/web` |
| Торговый worker | Отдельный Node.js-процесс + Socket.IO-клиент | `apps/trading-worker` |
| БД | PostgreSQL + Drizzle ORM, forward-only миграции (`drizzle-kit`) | `packages/db` |
| Фоновые задачи | Redis + BullMQ (уведомления, сверка, обработка событий) | использует `packages/db` |
| Общие типы/контракты | TypeScript, без раннего разделения на микросервисы | `packages/shared` |
| Тесты | Vitest (unit/integration) + Playwright (E2E) | во всех пакетах |
| Пакетный менеджер | pnpm workspaces, единый monorepo | корень репозитория |
| Развёртывание | Docker Compose + HTTPS reverse proxy | пилот — VPS (Hetzner, EU), оценка ресурсов и регион уточняются нагрузочным тестом, не решены здесь |

Доменные инварианты, подтверждённые кодом, — `.claude/skills/architect/SKILL.md` → Architecture Rules to Enforce (единственный полный список). Точный контракт Binodex Broker/Partner API, бонусная сетка, лимиты сессии и параметры хостинга здесь не зафиксированы: архитектор проектирует и проверяет их для конкретного issue, а не переносит из чернового плана.

---

## Forbidden Actions (both modes)

- Never push to `main` or merge a PR without whatever confirmation this repo's CLAUDE.md currently requires.
- Never move an issue to Done without explicit confirmation that the PR was merged (`state == "MERGED"`).
- Never edit files in another agent's/developer's active domain without flagging the conflict.
- Never execute Architect, Implementer or Reviewer steps inline — always as an `Agent` spawn with the policy `model` whose first action invokes the role's Skill, even for trivial one-line issues — except the reviewer's Step 6-pre command, which tech-lead runs itself as tech-lead's own 6-pre run (Phase 4 iteration 3 after a round-3 Blocker fix, a rebase before the merge with changes beyond the conflicts).
- Never write text output between pipeline phases where this repo's CLAUDE.md has waived stop points — an inter-phase recap forces the user to say "continue" unnecessarily.
- Never waive a missing Codex final pass silently: a usage-limit skip is recorded with its skip line where the run would have been, any other missing pass is a process deviation.
- Any question to the owner goes through `AskUserQuestion`, never plain text — including the questions a spawned phase returns.
- Never offer "one more iteration of the same loop" at the Iteration 2 stop, and never start a 4th review round.
- Never create the round-limit issue (Phase 4, iteration 3) without the owner's yes on its title and findings.
