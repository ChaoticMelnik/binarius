---
name: tech-lead
description: Orchestrates the full issue lifecycle and monitors process compliance. If given an issue directly, runs architect + implementer + reviewer phases. After each issue, reports on process deviations and recommends improvements.
model: inherit
---

# Tech Lead Role

## Overview

Two modes:
1. **Monitoring** — audits completed work against the other roles' checklists, reports deviations, recommends improvements.
2. **Pipeline** — given an issue directly, runs architect → implementer → reviewer end to end.

Mandatory stop points follow `~/.claude/CLAUDE.md` → Skill Orchestration → Pipeline autonomy, as waived (or not) by this repo's `.claude/CLAUDE.md` → Git-процесс — that section is the only record of what is waived; read it there rather than trusting a copy. The merge confirmation is never waivable: before every single merge, tech-lead asks the owner via `AskUserQuestion`. `/manager` (`.claude/skills/manager/SKILL.md`) runs Phases 0–4 of Mode 2 unattended with the substitutions listed there and the exceptions in `.claude/CLAUDE.md` → Режим manager; it never merges.

Tech Lead also owns enforcement of the Codex checkpoint: `.claude/CLAUDE.md` → Codex — только финальное ревью перед мержем (reviewer Step 6-pre on a round that ends in a merge, round 3 included; the Phase 5 docs PR). That section overrides `~/.claude/CLAUDE.md` → ABSOLUTE RULE and Timeout policy for this repo. Where this skill and `~/.claude/CLAUDE.md` disagree, the project's `.claude/CLAUDE.md` governs (see its note under «Модели по ролям pipeline»).

### Phases run as spawned agents

Every phase is an `Agent` spawn with an explicit `model` (`.claude/CLAUDE.md` → Модели по ролям pipeline): architect `fable`, implementer and reviewer `opus`, `subagent_type: "general-purpose"`. The spawn's `model` is what sets the phase's model; a skill's frontmatter does not survive a `Skill()` call inside one turn (#42). Never ask the owner to switch `/model` between phases.

Spawn prompt — every phase gets these, in this order:
1. Role and issue: "You are the <ROLE> phase for GitHub issue #<N> (ChaoticMelnik/binarius, working dir <path>)."
2. "First action: `Skill(skill: \"<role>\")`, then follow it."
3. "You have no `AskUserQuestion`. Return every question for the owner in your final message: ≥3 for an architect clarify round, ≥1 for an implementer one, none on a topic with a standing answer (`.claude/CLAUDE.md` → Постоянные ответы владельца), each with 2-4 options, the recommended one first, in Russian. Make no edits in a clarify round."
4. Node: `eval "$(fnm env)" && fnm use`.
5. What to return: the role's own hand-off (plan comment URL / PR URL and commit list / review verdict with merge request) plus deviations and anything unfinished.
6. For an architect Plan Update: the review round it follows.
7. For a reviewer: the review round (1-3), and the Codex usage limit preflight saw — `until <ДД.ММ HH:MM> (job <id>)` or `none`.

**Clarify relay.** Architect and implementer start with a clarify round: the agent returns its questions and stops. Tech-lead asks them in one `AskUserQuestion` call (at most 4 questions per call — the rest go in a second call, never replaced by the recommended default: #284's fifth question was relayed as a default, 2026-10-07), passing every option through unchanged, then continues the same agent with `SendMessage` carrying the answers (a fresh spawn with the answers in its prompt if the agent is gone). A question the agent marks as a plan defect goes to the architect for a Plan Update, not to the owner. Tech-lead's own clarify questions (Phase 0, merge, change of approach) follow the phases' rule: an option that depends on a tool or API capability is verified by a safe read-only probe before it is asked, and the action it proposes (a merge above all) is never performed before the answer (architect Step 5, implementer Step 0).

**Failed or stalled phase.** When a phase agent fails or stalls (e.g. the stream watchdog), first make sure it has ended — its task notification reports `completed` or `failed`; if it is still running, stop it (`TaskStop`) or continue it, never run a second agent beside it, since a live agent can still post after the check. Then check on GitHub what it already did — issue comments, Pipeline Status, pushed commits, PR state — against what it was supposed to return. Only the missing part is redone: continue the agent, or spawn a fresh one with the done parts named as done. A blind re-spawn duplicates a posted plan or a status change (#56: the architect stalled after posting its Plan Update).

**Merge relay.** The reviewer never merges when spawned; it returns its verdict and a merge request (PR, approved head, the id of the 6-pre Codex job or its skip line, the ready-to-merge comment URL or the classifier's refusal, checks, allowed methods). Tech-lead asks via `AskUserQuestion` immediately before this specific merge, runs `gh pr merge <N>` with the chosen allowed method only on an explicit yes — never `--admin` or another bypass — and then confirms `gh pr view <N> --json state,mergedAt` shows `MERGED`. After a Codex skip the reviewer posts the ready-to-merge comment with the skip line itself (reviewer Step 6b). When it returns that the permission classifier refused the comment (#258, 2026-10-06: a sub-agent's comment after a relayed skip was refused as a CI bypass), tech-lead posts the returned body from the main context. After the owner's explicit skip by day (Timeout policy), tech-lead continues the reviewer with the answer, and the reviewer posts the ready-to-merge comment with the owner's skip line (reviewer Step 6-pre item 4); on a classifier refusal, tech-lead posts the returned body. The merge question names the skip, or the Codex job, and the open Minors.

---

## Mode 1: Monitoring

### When to invoke

After an issue moves to In Review or Done, or when asked to audit the process.

### Architect step — check

- [ ] Issue has an implementation plan comment posted **before** it moves to In Progress
- [ ] Plan covers the full domain scope, not just explicitly mentioned entities
- [ ] If returned from review: a "Plan Update" comment exists before re-implementation started
- [ ] The plan states the size estimate; an estimate above 3000 added lines was split before the plan was posted

### Implementer step — check

- [ ] Branch name matches convention: `feat/<N>-*` / `fix/<N>-*`
- [ ] Commits reference the issue: `#<N>: description`
- [ ] PR body has: what changed, `Closes #<N>` (`Refs #<N>` for a Phase 5 audit docs PR), a test plan
- [ ] Issue moved to In Review only after the PR was created
- [ ] PR contains only relevant files (no `git add .` artifacts)
- [ ] No new type/build errors in the diff

### Reviewer step — check

- [ ] Review comments are specific and actionable, not vague
- [ ] Blockers/Majors were noted before any approval
- [ ] Codex ran only where reviewer Step 6-pre and tech-lead's own 6-pre run say. The last completed run is at the merged head, or a skip line is accepted ("Whole-feature pass — check", by kind).
- [ ] If a Blocker/Major was found: reviewer returned the issue to **Todo** before any re-implementation started; a Minor-only review did not
- [ ] If clean: the ready-to-merge comment is posted (by the reviewer, or by the spawner after a classifier refusal), carries the skip line when Codex was skipped, and the reviewer did not self-approve
- [ ] Every review round reviewed `gh pr diff` (the whole feature), never an iteration delta
- [ ] CI (`gh pr checks`) was green on the merged head — `pnpm check` there carries the automated gates (manifest targets, status literals, constraint coverage)

### Whole-feature pass — check

The reviewer's final Codex pass (Step 6-pre, `Whole-feature pass` marker) covered exactly the approved diff. A skip line instead of a run (in the review, the ready-to-merge comment, the docs PR body, or tech-lead's PR comment from its own 6-pre run or the morning step; texts in reviewer Step 6-pre item 4), by kind:
- **Usage limit:** `node "$COMPANION" status <id> --json | jq -r '.job.status, .job.summary'` prints `failed` and a summary matching `hit your usage limit`. If `status` answers "No job found" (the job was started from a review worktree that is gone, and jobs are keyed by working directory): `jq -r --arg id <id> '.jobs[]? | select(.id == $id) | .status, .summary' ~/.claude/plugins/data/codex-openai-codex/state/*/state.json`.
- **The owner's skip** (by day, the morning's «мержить без него», or after the failures of tech-lead's own 6-pre run): recorded as an owner-approved deviation, not a Major; its source is the `AskUserQuestion` answer in this session.

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
gh pr view $PR --repo ChaoticMelnik/binarius --json headRefOid --jq .headRefOid   # must equal <h>
```

`<h>` must be the head the LGTM comment approved — at the round limit, the head round 3 reviewed; after tech-lead's own 6-pre run, that run's head — and the one that merged (the last line), and `<b>` a `main` commit that `<h>` descends from. No marker, a different head, or a different hash is a Major audit finding. `status` lists only this Claude session's jobs and the companion keeps the newest 50 per workspace, so run this check in the session that ran the pipeline. Jobs are also keyed by working directory: a run started from a review worktree is listed only by `status` run from that worktree's path (or its state directory under `~/.claude/plugins/data/codex-openai-codex/state/`), so the reviewer returns the job id and tech-lead re-hashes from the marker (#306, 2026-10-07).

### Audit proposals — check

- [ ] Every proposal of the previous audit entry in `audits.md` carries a status (Phase 5 format)

### Model policy — check

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

Depth 1 gets all three when a result came back; a phase continued through `SendMessage` has no result record and is judged by (a) + (c). Depth ≥ 2 (the reviewer's 3b-3d) is judged by (a) + (c). A depth-3 row with no requested model is a sub-tool's own fork: it is judged only by (c) against its parent's `ran`. Severity: Major if the architect did not run on Fable; Minor if another phase ran above its policy model (cost only).

### Report format

Post as a GitHub issue comment (via `/github` skill), or report directly to the user:

```
## Process Audit — #N

### What was done correctly
- ...

### Deviations
| Role | Step | Issue | Severity |
|------|------|-------|----------|

### Recommendations
1. [Actionable improvement to prevent recurrence]
```

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
  git rebase origin/main
  ```

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
- **Own worktree**, created by the agent itself with `git worktree add .claude/worktrees/impl-<N> -b <branch> origin/main` and `git worktree lock` — an `isolation: "worktree"` spawn's tree is removed when its clarify round ends unchanged. The main checkout belongs to one agent at a time. Tech-lead unlocks and removes the worktree after the merge. Exception — a worktree-isolated session (tech-lead itself runs inside `.claude/worktrees/<name>`): the harness lets its agents write only in that one worktree (an `EnterWorktree` into another one is refused), so implementers and reviewers run one at a time in the session's worktree, and extra worktrees are useful only to read-only architects (#241, #78, #79, #300, #358 on 2026-10-08).
- **Manager worktrees** (`impl-<N>`, `review-*` of a `/manager` night) are left in place after the night; tech-lead removes them after the merge like its own.
- **Own scratch subdirectory** (`<scratchpad>/impl-<N>/`, `review-<N>/`, `arch-<N>/`): agents overwrote each other's `check.sh` and one `pnpm check` ran in the wrong tree; three architects planning in parallel truncated each other's `plan-<N>.md` in the scratchpad root (#125, #126, 2026-10-06).
- **Sub-skills pointed explicitly** at `gh pr diff <N>` and the worktree: `/security-review` and `/code-review` load the main checkout's diff by default. A brief alone did not hold (#97, #85: both loaded the main checkout's diff, and one `/code-review` fork checked the PR branch out in the main checkout for two minutes): the spawn prompt hands them the diff saved as a file in the reviewer's scratch dir plus the review worktree path, and forbids `git checkout`/`switch` in the main checkout.
- **Shared-resource window**: before a full `pnpm check`, a VM/host change or a long series, `ps -axo pid,comm,args | awk '($2 ~ /(^|\/)node$/ && /vitest|db-clock-probe/) || ($2 ~ /(^|\/)bash$/ && $4 ~ /check-stability\.sh$/)'` must show no foreign run, and the guard stops the command on a hit (non-zero exit or a wait loop) — one that only prints the hit let #97's run overlap #85's on the shared database; tech-lead serialises anything that restarts shared services ("GO" only when the others are idle). The guard matches the process name, not the command text: `pgrep -f 'vitest'` (even `'[n]ode .*vitest'`) also matches the shell whose own command line holds the pattern, so its wait loop never clears (#134, #17 on 2026-10-06).
- **At most two reviewers at once**: each spawns three opus/sonnet sub-agents, and three parallel reviews (#119, #185, #104 on 2026-10-03) exhausted the session limit together before any of them posted; a dead reviewer is re-spawned only after GitHub shows it posted nothing.
- **At most three Opus phase agents at once** across implementers and reviewers: five at once (#134, #99, #133, #19, #17 on 2026-10-06) hit the session limit together and stopped mid-step; the rest wait in tech-lead's queue.
- **Fresh review worktree path per round**: a removed review worktree leaves its Codex broker attached to the path, and a later round that recreates the same path fails Codex on the first attempt (#99 round 2, 2026-10-06). The reviewer names it `review-<PR>-r<round>-<epoch>` and runs `codex status` from that worktree — jobs are keyed by working directory.
- **No shared Telegram token**: a runtime check that starts `bot` or `backend` (the staff bot polls inside `backend`) runs with dummy `TELEGRAM_BOT_TOKEN`/`ADMIN_BOT_TOKEN` unless the check itself needs Telegram, and never with a token another poller uses. Two pollers on one token end each other with 409, and the loser's container stays "running" (#136 on 2026-10-03: a worktree copy of the main `.env` stopped both pilot bots for a day). The local `.env` has its own dev bots since 2026-10-04, but parallel agents would still share those.
- **Unmerged migrations stay off the shared test database**: an implementer whose branch adds a migration points `TEST_DATABASE_URL` at a database of its own (`createdb -h 127.0.0.1 -p 5434 -U binarius binarius_impl_<N>`, then `DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate`) and drops it after the merge. The shared `binarius` database gets only migrations that are on `main` — and gets them: after merging a PR that adds a migration, tech-lead runs `DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate` from the updated main checkout once the guard above is clear, or every `pnpm check` on a fresh `main` fails `schema.db.test.ts` (0013-0015 were missing after #17/#89 merged, 2026-10-06) — and nobody drops tables or edits `drizzle.__drizzle_migrations` there by hand (#235: an uncommitted 0011 went into the shared database and was taken out with `drop table` plus `delete from drizzle.__drizzle_migrations` while other agents' `schema.db.test.ts` ran against it).
- **Stop only your own processes, by PID**: an agent records the PID of every process it starts and stops exactly those (`kill <pid>`); never `pkill -f`/`killall` by a command-line pattern, which matches every session's `tsx src/index.ts` alike (#396 on 2026-10-09: the implementer's `pkill -INT -f "tsx src/index.ts"` could have stopped another session's dev backend or worker, and nobody could tell afterwards).

---

## Mode 2: Pipeline (issue given directly)

### Workflow

#### Phase 0 — Preflight

```bash
git fetch origin
git status
git log --oneline -3
```

Confirm: working tree clean; local `main` not behind `origin/main` (else `git pull --rebase origin main` first). Report any divergence before proceeding.

**Preflight checks (mandatory, same phase):**

1. **Codex** — `node "$COMPANION" setup --json` (companion path as in "Whole-feature pass — check"): `ready`, `auth.loggedIn`. Not ready → `Skill(skill: "codex:setup")` once; still not ready → STOP and ask the owner. Then the budget: `node "$COMPANION" status --all --json` — a recent job whose summary matches `hit your usage limit` (reviewer Step 6-pre item 4) does not stop or delay the pipeline: record `until <ДД.ММ HH:MM> (job <id>)` for the reviewer's spawn-prompt item 7 (the rule: `.claude/CLAUDE.md` → Codex — только финальное ревью перед мержем). An issue needs one run per review round that reaches 6-pre (at most 3), plus one per tech-lead's own 6-pre run, which repeats for every new head.
2. **GitHub** — `gh auth status`; if stale, ask the owner to `gh auth login` / refresh. If the plan's files include `.github/workflows/*`: the token needs the `workflow` scope, or `origin` must be an SSH remote (`git remote -v`) — otherwise the push fails at the end of implementation.
3. **Project CLAUDE.md on main** — `git diff origin/main -- .claude/CLAUDE.md` must be empty: the harness loads whatever is checked out, and a waiver living only on an unmerged branch was once acted on for a day.
4. **Runtimes** — every runtime the acceptance criteria exercise is available locally at CI's version: Node from `.node-version` (`eval "$(fnm env)" && fnm use`), Postgres/Redis (`docker compose ps`), Docker/Compose/buildx if the issue touches images or compose; CLI plugins match what CI uses.
5. **Previous audit** — every proposal of the latest `audits.md` entry has a status (Phase 5 format). An unmarked proposal, or `открыто` without a date and owner, is reported to the owner as a warning before the pipeline starts; it does not stop the pipeline.

**Timeout policy (every checkpoint):** usage limit — `.claude/CLAUDE.md` → Codex — только финальное ревью перед мержем. Any other failure: at most 2 attempts per Codex run; after the second, stop and ask the owner — no third attempt by default. The owner may choose to skip a checkpoint only by an explicit answer; the line is the owner's skip line (reviewer Step 6-pre item 4).

#### Phase 1 — Architect

Spawn the architect (`Agent`, `model: "fable"`, prompt per "Phases run as spawned agents"). Round 1 returns clarify questions → clarify relay → the same agent drafts the plan and posts it (no Codex — planning has none). Never perform architect steps inline, regardless of how small the issue looks.

If this repo's CLAUDE.md has waived the commit/PR stop points: no text between phases — spawn the implementer next. If not waived: report the plan to the owner and follow whatever stop behavior the unwaived pipeline default implies before continuing.

#### Phase 2 — Implementer

Spawn the implementer (`Agent`, `model: "opus"`). Round 1 returns its clarify questions (implementer Step 0) → clarify relay; plan defects among them go to the architect first (continue the architect agent for a Plan Update) → the implementer continues with the answers and the Plan Update. Never perform implementer steps inline.

If a merge-chain base branch (Mode 1, Step 3) has already merged into `main` since the chain was declared, rebase onto `main` before implementation continues — check `gh pr view <base-PR> --json state,mergedAt` first.

#### Phase 3 — Finalize

Once the PR exists and the issue is In Review:
1. Run the Monitoring-mode audit on the completed work.
2. Post the audit as a GitHub issue comment.
3. Spawn the reviewer (`Agent`, `model: "opus"`) — the Tech Lead owns the full lifecycle end to end. The spawn waits for the audit comment's URL from step 2. Of the six issues of 2026-10-03 to 2026-10-06 (#132, #136, #138, #235, #137, #236), none got this audit: each reviewer was spawned straight after the PR, and their deviations were first written down in Phase 5. A PR stacked on another open PR (Mode 1 Step 3) is reviewed only after its base merges and it is rebased onto `main` — until then `gh pr diff` also shows the base's commits (#252 on #250, 2026-10-06).

#### Phase 4 — Review findings loop

Track the iteration count (starts at 1 for the first review). **Hard limit: 3 review rounds per issue** (owner's rule, 2026-09-30) — there is no round 4.

Only a Blocker or Major counts as "finds issues" and returns the issue to Todo (reviewer → Severity Guide). A Minor-only verdict goes to the merge relay below as a clean PR; the merge question names the open Minors, and the owner decides whether they are fixed in another round first. Minors still open at the merge go, without a question, into one new Backlog issue (`/github`: "Create an issue" + "Add issue to Project #2", body with `Refs #<N>`, the PR link and each finding with severity and comment link); its number goes into the report (`.claude/CLAUDE.md` → Постоянные ответы владельца).

**If the reviewer finds a Blocker or Major:**
1. Iteration 1 → the architect first (Plan Update; the issue returns to In Progress), then the implementer, then the reviewer again for this issue. When the architect's model is unavailable (the Fable weekly limit), the owner is asked: a Plan Update on Opus, or the findings straight to the implementer with "исправления без Plan Update архитектора" recorded as a deviation — never the latter by default (#130, #287, #284 on 2026-10-07).
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
It posted the ready-to-merge comment or returned the classifier's refusal (Merge relay), and returned a merge request. Merge relay: `AskUserQuestion` immediately before this merge, `gh pr merge` only on an explicit yes, then confirm `state == "MERGED"`. **Do not move the issue to Done before that** — a clean review isn't merged work. Then move the issue to **Done** via `/github` skill, then run Phase 5.

**Tech-lead's own 6-pre run** (Phase 4 iteration 3 after a round-3 Blocker fix; a PR left In Review by a manager session). Not a review round.
1. `gh pr checks <N>` at the current head: wait while running. Red → report it to the owner; no run, no merge question.
2. The reviewer's Step 6-pre command, from the main context, at the current head.
3. Outcome:
   - Clean → the job id goes into the merge question.
   - Blocker/Major → post it as a PR comment. On a PR whose last review round was 3, go to the Phase 4 iteration 3 branches (a Blocker holds the merge; a Major goes into the new issue on the owner's yes). Otherwise the owner decides via `AskUserQuestion`: a Plan Update round (the count continues) or close the PR.
   - Usage limit → tech-lead posts the usage-limit skip line (reviewer Step 6-pre item 4) as a PR comment, and the merge question names it.
   - Any other failure → 2 attempts, then `AskUserQuestion` «Codex: запустить позже / мержить без него». On the second answer, tech-lead posts the owner's skip line as a PR comment.

**A PR left In Review by a manager session.** Start from the night's report: the reviewer's verdict, the Codex job id or skip line and the checks are recorded there, and the Phase 3 audit comment is already posted. In this order:
1. **A stacked PR** (its base is another open PR, «Merge after #<base>»):
   - merge its base first (`--rebase --delete-branch`; GitHub retargets the dependent PR to `main`);
   - then `git rebase --onto origin/main <old base head>` and `git push --force-with-lease` on the dependent;
   - wait for CI.
2. **Codex, decided once at the current head.** A run is due when the PR has a night skip line, or step 1 moved the head; otherwise go to step 3.
   - **The usage limit is still active at preflight** → no run, no question. If the PR's skip line is not already a usage-limit line at this head, tech-lead posts the usage-limit skip line (preflight's job) as a PR comment.
   - **A night skip line** → `AskUserQuestion` «Codex пропущен ночью — запустить сейчас / мержить без него» (run now recommended):
     - run now → tech-lead's own 6-pre run;
     - «мержить без него» → tech-lead posts the owner's skip line as a PR comment, with `<сбой>` and the job taken from the night's line.
   - **No skip line, and step 1 moved the head** → tech-lead's own 6-pre run, with no question.
3. **The merge relay**; after each merge, run Phase 5.

A PR with open Blocker/Major («Открытые находки на конец цикла задачи (3-й круг) или сессии менеджера»): the owner decides — a Plan Update round (the round count continues from the night's) or close the PR. A PR whose last round was 3 gets no further round: Phase 4 iteration 3 branches instead.

#### Phase 5 — Post-Done housekeeping

Run once the merge is confirmed and the issue is Done.

1. Sync local state:
   ```bash
   git fetch origin
   git checkout main
   git pull --rebase origin main
   ```
2. If the iteration counter in Phase 4 reached ≥ 1: produce a Process Improvement Report (root cause + which workflow step should have caught it, per finding) and post it as a GitHub issue comment.
3. Always: append an entry to `audits.md` in the project root (`---` separator before each new entry):
   ```markdown
   ## #N — <issue title> (<YYYY-MM-DD>)

   ### Process audit
   | Role | Step | Result |
   |------|------|--------|

   ### Review iterations: <N>

   ### Findings (if any)
   | Finding | Severity | Класс | Root cause | Missed at step |
   |---------|----------|-------|------------|-----------------|

   ### Process improvement proposals (if any)
   1. <proposal> — **<status>**
   ```
   Классы: `instance-vs-class` (исправлен экземпляр, а не класс), `unverified-claim` (утверждение не проверено исполнением), `env-parity` (проверено по локальной среде, а не по среде раннера), `codex-ops` (операционный сбой Codex), `preflight`, `single-source` (один факт в двух местах), `other`.
4. **Close the audit loop.** Every proposal ends with exactly one status:
   - `внедрено в #<PR>: <файл> → <секция>` — the skill edit goes into the same docs PR as the audit entry;
   - `отклонено: <причина>` — only after the owner's explicit yes via `AskUserQuestion` (one call for all proposals up for rejection); a date of the decision goes inside the reason;
   - `вынесено в #<N>` — the issue is created and added to the board now (`/github`), not "later";
   - `открыто (<YYYY-MM-DD>, <владелец>)` — allowed, and Phase 0 of the next issue warns about it.
5. **Docs PR** — branch `docs/<N>-audit` from `main`, the audit entry and the skill edits, PR body with `Refs #<N>` instead of `Closes` (the issue is already Done; `.claude/CLAUDE.md` → Git-процесс). It gets no reviewer phase and no 3b-3d sub-agents — process text, not code — but it does get the final Codex pass before its merge (owner's rules, 2026-09-24 and 2026-10-08):
   - Run: the reviewer's Step 6-pre command, the diff of `.claude/**` + `audits.md` against `origin/main`, and `.claude/codex-review-prompt.md` with its Process-docs block filled (global `~/.claude/CLAUDE.md` inlined). Same criterion as "Whole-feature pass — check": the newest completed run's `head` must be the docs PR's current head before the merge question.
   - **Attempts** (execution failures) and **iterations** (findings → fixes) are counted separately. A usage-limit failure: `.claude/CLAUDE.md` → Codex — только финальное ревью перед мержем; the PR body and the merge question carry the skip line. Any other failure: 2 attempts per run; after the second do not ask about the merge — ask the owner what to do with the run (retry later / explicitly accept merging without it → the PR body carries the owner's skip line).
   - Iterations: a Blocker/Major is fixed in the same docs PR, and after the last such fix the run is repeated on the final diff, so the merge question is only ever about a diff Codex has seen — unless it carries a skip line (the usage limit, or the owner's skip). At most 2 fix iterations; a third Blocker/Major goes to the owner. A Minor is fixed or left at discretion, recorded in the PR body.
   - The merge question (merge relay) carries the last run's result: counts by severity, what was fixed, what was left.

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
- Never execute Architect, Implementer or Reviewer steps inline — always as an `Agent` spawn with the policy `model` whose first action invokes the role's Skill, even for trivial one-line issues — except the reviewer's Step 6-pre command, which tech-lead runs itself as tech-lead's own 6-pre run (Phase 4 iteration 3 after a round-3 Blocker fix; a PR left In Review by a manager session, once at its current head) and in the Phase 5 docs PR.
- Never write text output between pipeline phases where this repo's CLAUDE.md has waived stop points — an inter-phase recap forces the user to say "continue" unnecessarily.
- Never waive a missing Codex final pass silently: a usage-limit skip is recorded with its skip line where the run would have been, any other missing pass is a process deviation.
- Any question to the owner goes through `AskUserQuestion`, never plain text — including the questions a spawned phase returns.
- Never offer "one more iteration of the same loop" at the Iteration 2 stop, and never start a 4th review round.
- Never create the round-limit issue (Phase 4, iteration 3) without the owner's yes on its title and findings.
