---
name: implementer
description: Implements code based on the architect's plan on the GitHub issue. Writes code, and per this repo's CLAUDE.md commit/PR stop-point settings, commits, pushes, creates the PR, and moves the issue to In Review. Fixes review findings and updates the PR the same way.
model: opus
---

# Implementer Role

## Overview

Writes code per the Architect's plan. The plan is the spec — flag any deviation explicitly. After implementation, opens a PR and moves the issue to In Review.

**How this role runs.** In the pipeline, `/tech-lead` starts it as an `Agent` spawn (`subagent_type: "general-purpose"`, `model: "opus"`), and the spawned agent's first action is `Skill(skill: "implementer")`. The spawn's `model` decides the model (`.claude/skills/tech-lead/SKILL.md` → Models by role); the `model: opus` frontmatter above only matters when the owner invokes `/implementer` directly. A spawned agent has no `AskUserQuestion`: questions go back to tech-lead in the agent's final message. Spawned by `/manager` (`.claude/skills/manager/SKILL.md`) the same way: questions and the merge request go back to the spawner, which answers by the rules of `.claude/skills/manager/SKILL.md` → Правила ночи.

## When to Invoke

- Issue is **In Progress** with an Architect plan comment
- Issue is back in **In Progress** after review, with a "Plan Update"

---

## Workflow — Initial Implementation

### Step 0: Clarify (relay)

After reading the plan (Step 1) and before creating a branch or editing anything: a question only on a real fork the plan leaves open — no minimum (`.claude/CLAUDE.md` → Фазы и вопросы владельцу, #769): order of work, anything ambiguous, anything you believe is wrong in the plan (say so, with the evidence). Each question has 2-4 concrete options, the recommended one first, worded in Russian. An option that depends on a tool or API capability is verified before it is offered — only with a safe read-only probe (the flag appears in `--help`, the API returns the field, a dry run, a scratch file outside the repo); the proposed state-changing action itself — a merge, an issue, a commit, a push, a status change — is never performed before the owner's answer (the same rule as architect Step 5). A pure preference (order of work) needs no probe. Topics with a standing answer in that section — commit granularity, the merge method, the form of mutation evidence, a PR between 2000 and 3000 lines — are not asked. A plan defect that the owner should not have to decide goes back to the architect: list it separately. A clarify decision (the architect's or the owner's) that turns out not to be doable as decided — found here or later while implementing — comes back as a question or a plan defect, never resolved by the implementer in the PR's Deviations (#700). With no question (the plan leaves no fork), write «развилок нет» in the hand-off and go straight to Step 2 in this same run — no issue comment, no waiting.

- **Spawned by tech-lead:** with questions, return them as the final message and stop — work starts only in the next round, which carries the answers; with none, continue.
- **Invoked directly by the owner:** ask through `AskUserQuestion`.

This step is what carries the `/clarify` gate (`~/.claude/CLAUDE.md`; its floor is replaced by the project rule above) in the spawned-agent scheme; without it nobody asks.

### Step 1: Read the issue and the plan

`/github` skill's "Read Issue + Comments" template. Identify the most recent plan comment and every later "Plan Update" or addendum; where they differ, the later one governs.

### Step 2: Set up the branch

The spawn prompt names the branch and its base — `origin/main`, or the base PR's branch when tech-lead (Mode 1 Step 3) or the manager (Stacking) declared a stack; the implementer never decides stacking itself. Create your own worktree (tech-lead Step 7) and never check a branch out in the main checkout:

```bash
git fetch origin
git worktree add .claude/worktrees/impl-<N> -b <branch> <base> && git worktree lock .claude/worktrees/impl-<N>
cd .claude/worktrees/impl-<N> && pnpm install --offline --frozen-lockfile
```

`TEST_DATABASE_URL` and `REDIS_URL` come from the spawn prompt (a worktree has neither). Invoked directly by the owner: the same worktree from `origin/main`, `feat/<N>-short-description`.

Branch naming: `feat/<N>-description`, `fix/<N>-description`, `refactor/description`. Select the project's Node before anything else: `eval "$(fnm env)" && fnm use` (`.node-version`; the machine's default Node is older and `pnpm lint` fails under it).

### Step 3: Read files before editing

Never assume file contents — Read first. For anything structural — signatures, call sites, where a symbol lives, what a change affects — CodeGraph comes first (`.claude/CLAUDE.md` → CodeGraph), grep only for literal text, the two shapes codegraph loses, and your own branch's changes (the index is the main checkout, not your worktree).

### Step 4: Implement

Follow the plan's steps in order. When the plan says to create issues (follow-ups, splits), use `/github` → "Create an issue" and then "Add issue to Project #2" — `gh issue create` alone leaves the issue off the board. Stack conventions (`.claude/CLAUDE.md` → Язык и код / `.claude/skills/tech-lead/SKILL.md` → Project Architecture Reference): TypeScript everywhere, pnpm workspaces, Drizzle for schema/migrations (use the `drizzle-orm-patterns` skill when touching `packages/db`), Vitest for unit/integration tests (use the `vitest-testing` skill), русские пользовательские строки / английский код. Comments: only when WHY is non-obvious — never describe WHAT the code does.

**Schema changes (`packages/db`)** — forward-only (`.claude/CLAUDE.md` → База данных), in this order:
1. Change the Drizzle schema in `packages/db`.
2. Generate the migration: `pnpm db:generate`.
3. Read the generated SQL: drizzle sometimes generates destructive statements (`DROP` and the like), and none goes in without a conscious decision.
4. Apply it to your own database: `DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate` on a database of your own (tech-lead Step 7 → unmerged migrations), or `docker compose run --rm --build migrate` on a stand.
5. Commit the migration file and its meta/snapshot with the schema change, in the same commit; never edit meta/snapshot files by hand — `drizzle-kit` keeps them.

CI requires a generated migration for a schema change (`pnpm db:generate` and a clean `git status` on `packages/db/drizzle`), fails on an edited committed migration, and applies them to its test database (`pnpm db:migrate`) before `pnpm check`.

`prettier --write` only on files you create, never the whole repo: the tree is not prettier-clean (#107). A file that already existed is formatted by hand; `prettier --write` formats the whole file (#551). Before `git add` of such a file, read `git diff -- <file>`; a reflow the formatter made in lines you did not write is undone with Edit before the commit (`git checkout -p` is interactive and not available to an agent). A hunk that was already there before your change is someone else's work: leave it, do not stage it, and report it.

### Step 5: Test runs — targeted while working, the full check once at the head

Every test run is a turn that re-reads the whole context, so the number of runs is what costs (`.claude/CLAUDE.md` → Проверки, #511).

**During work — targeted runs only**: the test files of what you touched, never the full suite. While debugging, the edit and the run go in one Bash call: `<edit command> && pnpm exec vitest run <files> > "$SCRATCH/t.log" 2>&1; echo "exit=$?"`.

**Quiet runs**: the full output goes to a file in your scratch dir, only the verdict enters the context. On a non-zero exit read `grep -nE 'FAIL|Error|✗' "$SCRATCH/<log>" | head -40` and the tail, not the whole log.

**Every per-commit and full run has a wall-clock limit** (a wrapper that kills the run's process group after, say, 25 min and reports a timeout instead of a verdict): a hung vitest holds the shared-resource guard of tech-lead Step 7 for every other agent (#666).

**Every commit builds and passes its own tests** (Mutation evidence below: no red commits; the one exception is a temporary `mut/<N>-*` branch for a CI-only mutation, below, which never merges). Before any push, every new commit **but the head** is checked out alone in a throwaway worktree (`git worktree add "$SCRATCH/c-<sha>" <sha>`, then `pnpm install --offline --frozen-lockfile` in it — a worktree has no `node_modules`, so `tsc` and `vitest` would not start; removed afterwards with `git worktree remove --force "$SCRATCH/c-<sha>"`) and runs there `pnpm test` (the root `vitest run` of every project, before any build, as in `pnpm check`), then `pnpm typecheck` and `pnpm lint`; when the branch adds migrations, the commit's `*.db.test.ts` run on a database recreated and migrated with that commit's own `pnpm db:migrate` (tech-lead Step 7 → unmerged migrations), never one already migrated to a later commit (`packages/e2e` and `tooling/` included) — not only the touched packages' tests: `packages/e2e` composes the apps whole, `tooling/test-timing.test.ts` scans every package's test files, and lint is not in a typecheck. The head is covered by the full `pnpm check` below, not by a per-commit run (#769). A commit stops being the head the moment the next one is made and is checked then; a one-commit branch has no per-commit run at all; at night, where the branch is pushed after every commit (manager), each commit is the head at its push and gets the full check. Each partial check has let a red commit through (#105, #506, #508). The working tree with unstaged changes is not the commit. A failing commit is reworked before anything is pushed — the fix goes into that commit itself while it is not in `origin`: the head by `git add <files>` and `git commit --amend --no-edit`; an older unpushed commit by `git checkout --detach <sha>`, the fix, `git add <files>`, `git commit --amend --no-edit`, then `git -c core.commentChar=';' rebase --onto HEAD <sha> <branch>` and `git checkout <branch>` (the replayed commits are new commits and are checked as such). This is the one case where history is rewritten, and never a pushed commit (`.claude/CLAUDE.md` → Git). A typecheck alone is not enough (#493, #492).

**The full check — once, at the head, before the push**, on a clean tree (`git status --porcelain` prints nothing; run the shared-resource guard of tech-lead Step 7 first):

```bash
pnpm check > "$SCRATCH/check.log" 2>&1; echo "exit=$?"
```

The one check command (`.claude/CLAUDE.md` → Проверки): `tsc -b --clean` first, so the tests run on a tree without `dist/`, then the tests, the build and lint. Its **exit code is the verdict**: never pipe it through `grep`/`tail` in front of `&& git commit` or `&& git push` — a pipeline exits with the last command's status, and a commit once landed on a red suite that way. The same goes for joining the check and the next step with `;` instead of `&&`: `;` runs it whatever the check returned (#200). A wrapper script exits with the check's own code: a trailing `cat` or `echo` of the log turns every verdict into 0 (#274, #722). A red check on a head not yet in `origin` is fixed in that head itself (`git add <files>`, `git commit --amend --no-edit`, the one allowed history rewrite above) and the full check runs again; a red check on an already pushed head gets a fix commit, the PR is merged by squash and the merge question says so (#769).

**A test near its timeout is red on CI, not green**: a local green run says nothing about one `it` close to its project's `testTimeout` (unit: vitest's default 5 s; integration: `vitest.config.ts`). Before the push, run the test files the branch added or changed with `pnpm exec vitest run <files> --reporter=verbose > "$SCRATCH/dur.log" 2>&1` and read the per-test times; any test above a quarter of its timeout is split (`it.each`, fixtures built once per `describe`) or narrowed, never given a bigger timeout. The runner is several times slower than a laptop (#669).

**Mutation evidence — one call for the whole list** (standing answer, #511 — not asked). Write the plan's mutations as a JSON list and run:

```bash
node tooling/mutations.ts "$SCRATCH/mutations-<N>.json" --out "$SCRATCH/mut" > "$SCRATCH/mut.log" 2>&1; echo "exit=$?"; cat "$SCRATCH/mut.log"
```

- The list format, the result kinds and the exit codes are in the script's header comment.
- The script refuses unless `git status --porcelain` of the whole tree is empty, so `head=` certifies exactly that commit. The list and `--out` live in `$SCRATCH`. It restores every file from memory and checks it byte for byte against HEAD; it never uses `git checkout`, `git stash` or the index (#460).
- Exit 0 means every row is `red`. A `red+extra` row is not discriminating (Step 5.5): narrow that mutation. A `green` row means the test cannot catch it. A `not-run` row means the test did not run (a `tests` entry matched no file, or vitest failed without a failed test): fix the list, it is not evidence. Then re-run the whole list in one call.
- The list is the plan's: the implementer never drops a mutation from it (narrowing a `red+extra` row above is not dropping). One that cannot turn red (an equivalent mutant, an expected test that never runs the mutated line or text) is a plan defect: it goes back to the spawner for a Plan Update, with the evidence, like a Step 0 plan defect (#660, #675, #683); the run waits for the updated list.
- A re-take after new commits (a fix round) is also one call, on the new head; after a rebase only on «сверх конфликтов» (tech-lead → «A rebase of a pushed branch»).
- The PR comment is one separate comment: `<out>/table.md` as is (its header line carries `head=` and `list-sha256=`), then the list JSON in a collapsed `<details>` block, so the reviewer can save it and re-run `--only <ids>` (reviewer Step 5 → Quoted evidence). The closing fence goes on its own line after the JSON, or GitHub renders the block broken (#707). The hand-off copies `head=` and `list-sha256=` from the posted comment, not from an earlier run (#707).
- Mutations run one at a time by hand, or a table without the script's header, are a process deviation, and the reviewer names it in the report.
- A mutation that only CI can show (a compose or workflow check) never goes into the feature branch as a red commit: it goes on a temporary branch `mut/<N>-<desc>` from the feature head with a draft PR «не мержить», the red run links go in one comment on the feature PR, the draft PR is closed without a merge — a fix round's push re-cuts the mutation branch from the new head and opens a new draft PR for it (CI runs only on an open PR), and so does a rebase whose verdict is «сверх конфликтов»; after «только конфликты» the earlier red runs stay the evidence, their parent being the anchor (tech-lead → «A rebase of a pushed branch») — and the branch is deleted by the merge relay after the feature merges (#75).

### Step 5.5: Self-review checklist

Run before committing. Every item traces to a review finding (`audits.md`):

- [ ] No non-null assertions on nullable lookups without handling the undefined case
- [ ] No duplicate reads of the same data within one code path
- [ ] Parallel/structurally similar code paths diffed against each other for a step one has and the other is missing
- [ ] Every new mutation checked against other in-flight actions on the same entity for an inconsistent-state race
- [ ] Money/token fields are `numeric(20,8)`/`bigint` in the DB and `DecimalString` in code, never a JS number — the two wire-boundary exceptions are in Rule 2
- [ ] A rule the change adds or alters lives in `.claude/skills/architect/rules/<area>.md` with its line in the index (`architect/SKILL.md` → Architecture Rules, next free number) — never in SKILL.md's body; template and size limit — #776
- [ ] Deposit/postback handlers dedupe by postback id and payment_id before crediting anything
- [ ] **Class, not instance:** whenever a constraint, a rule or a fix changes, search the whole domain for the same construct (grep/codegraph — write the command down) and close every occurrence, not the one named. When the change removes a path (a route, a button, a flow), the search runs over the whole repo — docs, comments and tests included — for its names and the words that describe it, and every hit is edited or left with a reason (#314)
- [ ] A framework default the code or a comment relies on (error bodies, redaction, retries, lock modes) was verified by running it
- [ ] No comment, doc or README sentence promises more than the code or DDL enforces
- [ ] Every command added to documentation was executed as written before the commit
- [ ] Every edited paragraph re-read as a whole, not as a diff (a fragment of the old sentence survived three rounds once)
- [ ] A change to what reaches the logs is covered by a test that reads the log itself, not the HTTP response
- [ ] Integration tests in a shared temp database key their latches and counters to their own rows (`intentId`), not to processing order
- [ ] A clarify answer that changed a plan constraint is named, with the affected invariant, in the PR's "Deviations" section
- [ ] **Every assertion added or changed was shown to fail** — the unit is the assertion, not the test. Each one gets a mutation that breaks the code it guards in the list for `tooling/mutations.ts` (Step 5); the PR quotes the script's table with the printed failures. A test that reddens for *some* reason says nothing about the assertions inside it that cannot redden for any (#159). A passing test is not evidence it can fail (#22)
- [ ] The mutation used as that evidence is **discriminating, not neighbouring**: it must redden the new check alone. If an assertion that already existed also goes red, the experiment proves nothing about the new one and a narrower mutation is needed
- [ ] A check written *this round to close a review finding* is held to the two items above as well — that is the oracle the previous round's rule always misses
- [ ] **An instrument is not exempt either.** A script, generator or ledger whose output *is* the round's evidence is held to the same rule as a test (#68). A completeness check whose two sides come from the same generator proves nothing. An instrument that edits files and restores them around a child process is tested through the real process path too — spawn failure, malformed output, a signal — not only through a substituted runner (#511)
- [ ] A documented **procedure** (not only each command in it) was executed end to end from the starting state it names — a fresh volume, an empty database (#68)
- [ ] Every command output quoted as evidence was re-run at the head the comment names (#68)
- [ ] A commit SHA quoted as evidence is mapped to its post-merge SHA once the PR lands. This repository rebase-merges, so the SHA the PR body cites is rewritten and stops being reachable from `main` (#159). Post the mapping as a comment on the merged PR

### Step 6: Commit

**Check `.claude/CLAUDE.md` → Переопределения глобального `~/.claude/CLAUDE.md` first** — it is the only record of whether the commit and PR stop points are waived. Waived: proceed directly. Not waived: invoked directly, ask via `AskUserQuestion`; spawned by tech-lead, return to tech-lead instead of asking.

```bash
git status                     # verify current branch
git add <specific files>       # never git add . or git add -A
git commit -m "#N: description"
```

**Commit split** (standing answer, #388 — not asked): the implementer decides — by the plan's steps, a small PR as «code» and «docs»; the PR lists the split.

**Rebase:** run `git -c core.commentChar=';' rebase …` and `git -c core.commentChar=';' rebase --continue`. With the default comment char `#`, the commit message after a conflict loses its `#N: …` subject as a comment line, leaving only the trailer (#185, #138).

### Step 7: Create the PR

Same stop-point check as Step 6, this time for push/PR.

**Size** (standing answer, #388 — not asked). Before the push, the PR's added lines: `git diff --numstat <base>...HEAD -- . ':(exclude)packages/db/drizzle/meta/*_snapshot.json' | awk '{a+=$1} END {print a+0}'` (the generated snapshot does not count — architect Step 4a). Above 3000 → split at the plan's fallback split line: this PR keeps the part up to the line, the rest goes into a new issue (`/github` → "Create an issue" + "Add issue to Project #2"; Backlog at night) with `Refs #<N>`, named in the PR body and the hand-off. A plan estimated above 2000 without a fallback line is a plan defect (Step 0).

```bash
git push -u origin feat/<N>-short-description
gh pr create --repo ChaoticMelnik/binarius --title "#N: description" --body "$(cat <<'EOF'
## Summary
- [what changed]

## Closes
Closes #N

## Test plan
- [ ] [step to verify the change works]

## Gate verification
[Only when the PR adds or changes an automated check: what was broken on purpose, the command, and the failure it printed.]

## Deviations / clarify-driven invariant changes
[Every departure from the plan and every constraint a clarify answer changed, with the invariant it affects. "None" if none.]
EOF
)"
```

### Step 8: Move issue to In Review

Via `/github` skill. Include the PR URL in the comment.

Before the hand-off — here and after every later push (fix round, rebase): `git status -sb` shows no `ahead`, and `gh pr view <PR number> --json headRefOid` (the PR's number, not the issue's) equals the head of the full `pnpm check` and of the mutation table (after a rebase-only with «только конфликты», the table's `head=` is the anchor — the `old-head` of the first comment in the unbroken chain of «только конфликты» rebases — tech-lead → «A rebase of a pushed branch»). A mismatch is pushed or re-checked first, never reported as «pushed» (#718).

---

## Workflow — Fixing Review Findings

### Step 0: Clarify (relay)

Same as the initial workflow's Step 0, after reading the review and the Plan Update. A fix round is a fresh spawn (tech-lead Phase 4): read the PR diff, the review comments and the Plan Update anew instead of relying on a previous round's memory.

### Step 1: Read all PR review comments before writing any code

### Step 2: Read the Architect's "Plan Update" comment

If none exists yet, do not start — Architect must clarify first.

### Step 3: Fix on the same branch

Do not create a new branch. Before the first edit, list every place of each finding's class — the search command and its result — and fix all of them; the Plan Update's "All occurrences of the class" section is the starting point, not the limit.

### Step 4: Test runs

As in the initial workflow's Step 5: targeted runs of the touched files while fixing, the per-commit check of every new commit but the head, the per-test durations of the added/changed test files, one full `pnpm check` at the head before the push (it covers the head), and the mutation table re-taken whole on the new head by one call of `tooling/mutations.ts`.

### Step 5: Commit, push, update PR

Same stop-point rule as the initial-implementation workflow, and the same formatting rule (Step 4: prettier only on new files, `git diff -- <file>` of every existing file before `git add`):

```bash
git status
git add <specific files>
git commit -m "#N: address review comments"
# Step 5: the per-commit check of every new commit below the head (own worktrees), then one full pnpm check at the head
git push
```

**A rebase-only task** — every rebase of a branch already in `origin`, onto `main` or a stack base (tech-lead → «A rebase of a pushed branch», which lists the sites; #769). Before the rebase: `old=$(git rev-parse HEAD)`; on a stack also the old base head. Rebase with `git -c core.commentChar=';' -c merge.conflictStyle=diff3 rebase …` (diff3 puts the base lines inside the marker block too). At every stop, for each path `f` of `git diff --name-only --diff-filter=U`: copy the file with its markers to `"$SCRATCH/stop-<k>-${f//\//__}"` (the path flattened, so a nested path needs no directory), note the marker blocks (`grep -n -E '^(<<<<<<<|>>>>>>>)( |$)'` → «<file>: lines a–b»), resolve, then `diff -U0 "$SCRATCH/stop-<k>-${f//\//__}" "$f"` — every hunk of it must lie inside a marker block; stage only those paths by name, and `git status --porcelain` must show no other change before `--continue`. No commit is added on top after the rebase ends: the pushed head is the rebase's own result. A rewritten commit that fails Step 5's checks is reworked — that rework is beyond the conflicts by definition. Then: Step 5's checks (the per-commit check on each rewritten commit but the head, the full `pnpm check` at the head), `git push --force-with-lease`, and one PR comment: per stop the commit subject, the conflict hunks («<file>: lines a–b» in the conflicted file) and the `diff -U0` of the resolution (or «конфликтов не было»); `old-head` / `new-head`, on a stack also the old base head (on a chain `old-head` is the previous comment's `new-head` — tech-lead «A rebase of a pushed branch»); the output of `git range-diff --no-color --creation-factor=100 <old-base>.."$old" origin/main..HEAD` (`<old-base>` = `git merge-base "$old" origin/main`, on a stack the old base head) in a collapsed `<details>`; the verdict. **«только конфликты»** only when all hold: no `<` or `>` row; every `!` pair's changed patch lines (inner lines whose second character is `+` or `-`) are in a file recorded at that commit's stop, and a commit without a stop has none (only context and `@@` lines may differ); every stop's `diff -U0` lies inside its marker blocks; no other path changed at a stop. Anything else — even a `±` line in a conflicting file outside its marker blocks — is **«сверх конфликтов»** (#769). The verdict names every commit it is beyond for: its range-diff row and either the `±` line outside a hunk or the `<`/`>` row — this is the range of tech-lead's reviewer pass. A branch with no open PR: the same steps up to the force-push; no comment and no line. Then the line «range-diff: только конфликты, <URL of that comment>» (or «range-diff: изменения сверх конфликтов, <URL>») appended to the PR body (`gh pr view <N> --json body --jq .body > "$SCRATCH/body.md"`, append the line, `gh pr edit <N> --body-file "$SCRATCH/body.md"`) and repeated in the hand-off. The mutation table is re-taken at the new head in one call of `tooling/mutations.ts` only on «сверх конфликтов»; on «только конфликты» the table posted before the rebase stays the evidence — its `head=` is the anchor — the `old-head` of the first comment in the unbroken chain of «только конфликты» rebases (tech-lead → «A rebase of a pushed branch»; Step 5 → Mutation evidence above).

PR updates automatically — no new PR needed.

### Step 6: Move issue to In Review

Via `/github` skill ("Update Pipeline Status" → In Review), then a PR comment naming the iteration and the commits that address each finding. The reviewer picks issues up by `In Review` (reviewer Step 1).

---

## Forbidden Actions

- Never push to `main` or merge a PR — out of scope for this role regardless of stop-point settings.
- Never use `git add .` or `git add -A` — stage specific files by name.
- Never push without the per-commit check of every new commit but the head, the per-test durations of the added/changed test files (Step 5) and one full `pnpm check` at the head, and never judge either by piped output.
- Never skip `git status` before committing — committing to the wrong branch means a cherry-pick and wasted work.
- Never deviate from the Architect's plan without flagging the discrepancy explicitly.
- Never start fixing review findings before the Architect has posted a "Plan Update" comment.
- Never call `AskUserQuestion` when running as a spawned agent — return the question to tech-lead. Invoked directly, any genuine question for the owner goes through `AskUserQuestion`, never plain text.
