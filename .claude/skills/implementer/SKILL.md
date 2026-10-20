---
name: implementer
description: Implements code based on the architect's plan on the GitHub issue. Writes code, and per this repo's CLAUDE.md commit/PR stop-point settings, commits, pushes, creates the PR, and moves the issue to In Review. Fixes review findings and updates the PR the same way.
model: opus
---

# Implementer Role

## Overview

Writes code per the Architect's plan. The plan is the spec — flag any deviation explicitly. After implementation, opens a PR and moves the issue to In Review.

**How this role runs.** In the pipeline, `/tech-lead` starts it as an `Agent` spawn (`subagent_type: "general-purpose"`, `model: "opus"`), and the spawned agent's first action is `Skill(skill: "implementer")`. The spawn's `model` decides the model (`.claude/CLAUDE.md` → Модели по ролям pipeline); the `model: opus` frontmatter above only matters when the owner invokes `/implementer` directly. A spawned agent has no `AskUserQuestion`: questions go back to tech-lead in the agent's final message. Spawned by `/manager` (`.claude/skills/manager/SKILL.md`) the same way: questions and the merge request go back to the spawner, which answers by the rules of `.claude/CLAUDE.md` → Режим manager.

## When to Invoke

- Issue is **In Progress** with an Architect plan comment
- Issue is back in **In Progress** after review, with a "Plan Update"

---

## Workflow — Initial Implementation

### Step 0: Clarify (relay)

After reading the plan (Step 1) and before creating a branch or editing anything: questions about the forks the plan leaves open — at least 1 (`.claude/CLAUDE.md` → Постоянные ответы владельца): order of work, anything ambiguous, anything you believe is wrong in the plan (say so, with the evidence). Each question has 2-4 concrete options, the recommended one first, worded in Russian. An option that depends on a tool or API capability is verified before it is offered — only with a safe read-only probe (the flag appears in `--help`, the API returns the field, a dry run, a scratch file outside the repo); the proposed state-changing action itself — a merge, an issue, a commit, a push, a status change — is never performed before the owner's answer (the same rule as architect Step 5). A pure preference (order of work) needs no probe. Topics with a standing answer in that section — commit granularity, the merge method, the form of mutation evidence, a PR between 2000 and 3000 lines — are not asked and do not count toward the floor. A plan defect that the owner should not have to decide goes back to the architect: list it separately. With no question (the plan leaves no fork), say so with the reason in one issue comment, not only in the hand-off (#318 on 2026-10-10: the reason lived only in the hand-off).

- **Spawned by tech-lead:** return the questions as the final message and stop. Work starts only in the next round, which carries the answers.
- **Invoked directly by the owner:** ask through `AskUserQuestion`.

This step is what carries the `/clarify` gate (`~/.claude/CLAUDE.md`) in the spawned-agent scheme; without it nobody asks.

### Step 1: Read the issue and the plan

`/github` skill's "Read Issue + Comments" template. Identify the most recent plan comment and every later "Plan Update" or addendum; where they differ, the later one governs.

### Step 2: Set up the branch

```bash
gh pr list --repo ChaoticMelnik/binarius --state open --json number,headRefName --limit 1
```

- **No open PRs** → branch from `main`:
  ```bash
  git fetch origin
  git checkout -b feat/<N>-short-description origin/main
  ```
- **Open PR exists** and this issue shares files with it (per `/tech-lead`'s merge-chain rule) → branch from that PR's head instead:
  ```bash
  git fetch origin
  git checkout -b feat/<N>-short-description origin/<headRefName-of-that-PR>
  ```

Branch naming: `feat/<N>-description`, `fix/<N>-description`, `refactor/description`. Select the project's Node before anything else: `eval "$(fnm env)" && fnm use` (`.node-version`; the machine's default Node is older and `pnpm lint` fails under it).

### Step 3: Read files before editing

Never assume file contents — Read first. For anything structural — signatures, call sites, where a symbol lives, what a change affects — CodeGraph comes first (`.claude/CLAUDE.md` → CodeGraph → «Приоритет — codegraph»), grep only for literal text, the two shapes codegraph loses, and your own branch's changes (the index is the main checkout, not your worktree).

### Step 4: Implement

Follow the plan's steps in order. When the plan says to create issues (follow-ups, splits), use `/github` → "Create an issue" and then "Add issue to Project #2" — `gh issue create` alone leaves the issue off the board. Stack conventions (`.claude/CLAUDE.md` → Конвенции кода / `.claude/skills/tech-lead/SKILL.md` → Project Architecture Reference): TypeScript everywhere, pnpm workspaces, Drizzle for schema/migrations (use the `drizzle-orm-patterns` skill when touching `packages/db`), Vitest for unit/integration tests (use the `vitest-testing` skill), русские пользовательские строки / английский код. Comments: only when WHY is non-obvious — never describe WHAT the code does.

`prettier --write` only on files you create, never the whole repo: the tree is not prettier-clean, and a repo-wide pass in #107 reflowed untouched code in `apps/backend` and `apps/web`, which took a separate revert commit. A file that already existed is formatted by hand; `prettier --write` formats the whole file, and one run on `schema.db.test.ts` in #551 reflowed unrelated tests and took fix-up commit `abaf9e4`. Before `git add` of such a file, read `git diff -- <file>`; a reflow the formatter made in lines you did not write is undone with Edit before the commit (`git checkout -p` is interactive and not available to an agent). A hunk that was already there before your change is someone else's work: leave it, do not stage it, and report it.

### Step 5: Test runs — targeted while working, the full check once at the head

Every test run is a turn that re-reads the whole context, so the number of runs is what costs (`.claude/CLAUDE.md` → Экономия токенов → «Тесты — только в спавн-агентах», #511).

**During work — targeted runs only**: the test files of what you touched, never the full suite. While debugging, the edit and the run go in one Bash call: `<edit command> && pnpm exec vitest run <files> > "$SCRATCH/t.log" 2>&1; echo "exit=$?"`.

**Quiet runs**: the full output goes to a file in your scratch dir, only the verdict enters the context. On a non-zero exit read `grep -nE 'FAIL|Error|✗' "$SCRATCH/<log>" | head -40` and the tail, not the whole log.

**Every per-commit and full run has a wall-clock limit** (a wrapper that kills the run's process group after, say, 25 min and reports a timeout instead of a verdict): a hung vitest holds the shared-resource guard of tech-lead Step 7 for every other agent. #666's per-commit run of 3b910440 hung ~18 h with a worker at ~112 % CPU and blocked #667's implementer (2026-10-19/20); the same commit passed in 60 s under a limit.

**Every commit builds and passes its own tests** (`.claude/CLAUDE.md` → Постоянные ответы владельца → «Доказательства мутаций»: no red commits). After each commit and before any push — every new commit, the head included — check out that commit alone in a throwaway worktree (`git worktree add "$SCRATCH/c-<sha>" <sha>`, then `pnpm install --offline --frozen-lockfile` in it — a worktree has no `node_modules`, so `tsc` and `vitest` would not start; removed afterwards with `git worktree remove --force "$SCRATCH/c-<sha>"`) and run there `pnpm test` (the root `vitest run` of every project, before any build, as in `pnpm check`), then `pnpm typecheck` and `pnpm lint`; when the branch adds migrations, the commit's `*.db.test.ts` run on a database recreated and migrated with that commit's own `pnpm db:migrate` (tech-lead Step 7 → unmerged migrations), never one already migrated to a later commit (`packages/e2e` and `tooling/` included) — not only the touched packages' tests: `packages/e2e` composes the apps whole, `tooling/test-timing.test.ts` scans every package's test files, and lint is not in a typecheck. On 2026-10-17 each partial check let a red commit through, each on a different part of `pnpm check`: #105's 7b0871f (timing scan), #506's 184c5d1d–696c2127 (`packages/e2e`), #508's dd2f1be8 (lint) — all three PRs went in by squash; #576's commits, checked with the full set, had none. The working tree with unstaged changes is not the commit; a failing commit is reworked before anything is pushed. A typecheck alone is not enough: #493's first commit typechecked and failed a timing test, and #492 got two non-building commits from a staged `git mv` landing in the wrong commit (2026-10-14; both were squash-merged because history cannot be rewritten at night).

**The full check — once, at the head, before the push**, on a clean tree (`git status --porcelain` prints nothing; run the shared-resource guard of tech-lead Step 7 first):

```bash
pnpm check > "$SCRATCH/check.log" 2>&1; echo "exit=$?"
```

The one check command (`.claude/CLAUDE.md` → CI): `tsc -b --clean` first, so the tests run on a tree without `dist/`, then the tests, the build and lint. Its **exit code is the verdict**: never pipe it through `grep`/`tail` in front of `&& git commit` or `&& git push` — a pipeline exits with the last command's status, and a commit once landed on a red suite that way. The same goes for joining the check and the next step with `;` instead of `&&`: `;` runs it whatever the check returned (#200: commit 2 was made on a red check that way, caught before the push). A red check is fixed in a new commit, which gets its own per-commit check, and the full check runs again on the new head.

**A test near its timeout is red on CI, not green**: a local green run says nothing about one `it` close to its project's `testTimeout` (unit: vitest's default 5 s; integration: `vitest.config.ts`). Before the push, run the test files the branch added or changed with `pnpm exec vitest run <files> --reporter=verbose > "$SCRATCH/dur.log" 2>&1` and read the per-test times; any test above a quarter of its timeout is split (`it.each`, fixtures built once per `describe`) or narrowed, never given a bigger timeout. The runner is several times slower than a laptop: #669's H-T8 passed the full local check and failed CI at 5 042 ms, and H-U5 went from 516 ms on `main` to 2 862 ms on CI (2026-10-20).

**Mutation evidence — one call for the whole list** (`.claude/CLAUDE.md` → «Доказательства мутаций»). Write the plan's mutations as a JSON list and run:

```bash
node tooling/mutations.ts "$SCRATCH/mutations-<N>.json" --out "$SCRATCH/mut" > "$SCRATCH/mut.log" 2>&1; echo "exit=$?"; cat "$SCRATCH/mut.log"
```

- The list format, the result kinds and the exit codes are in the script's header comment.
- The script refuses unless `git status --porcelain` of the whole tree is empty, so `head=` certifies exactly that commit. The list and `--out` live in `$SCRATCH`. It restores every file from memory and checks it byte for byte against HEAD; it never uses `git checkout`, `git stash` or the index (#460: `git checkout --` over uncommitted changes wiped three files of work).
- Exit 0 means every row is `red`. A `red+extra` row is not discriminating (Step 5.5): narrow that mutation. A `green` row means the test cannot catch it. A `not-run` row means the test did not run (a `tests` entry matched no file, or vitest failed without a failed test): fix the list, it is not evidence. Then re-run the whole list in one call.
- A re-take after new commits is also one call, on the new head.
- The PR comment is one separate comment: `<out>/table.md` as is (its header line carries `head=` and `list-sha256=`), then the list JSON in a collapsed `<details>` block, so the reviewer can save it and re-run `--only <ids>` (reviewer Step 5 → Quoted evidence).
- Mutations run one at a time by hand, or a table without the script's header, are a process deviation, and the reviewer names it in the report.

### Step 5.5: Self-review checklist

Run before committing. Every item traces to a review finding (`audits.md`):

- [ ] No non-null assertions on nullable lookups without handling the undefined case
- [ ] No duplicate reads of the same data within one code path
- [ ] Parallel/structurally similar code paths diffed against each other for a step one has and the other is missing
- [ ] Every new mutation checked against other in-flight actions on the same entity for an inconsistent-state race
- [ ] Money/token fields are `numeric(20,8)`/`bigint` in the DB and `DecimalString` in code, never a JS number — the two wire-boundary exceptions are in Rule 2
- [ ] Deposit/postback handlers dedupe by postback id and payment_id before crediting anything
- [ ] **Class, not instance:** whenever a constraint, a rule or a fix changes, search the whole domain for the same construct (grep/codegraph — write the command down) and close every occurrence, not the one named. When the change removes a path (a route, a button, a flow), the search runs over the whole repo — docs, comments and tests included — for its names and the words that describe it, and every hit is edited or left with a reason (#314: present-tense claims about the removed site sign-in surfaced one by one over four review rounds of #335 and #340)
- [ ] A framework default the code or a comment relies on (error bodies, redaction, retries, lock modes) was verified by running it
- [ ] No comment, doc or README sentence promises more than the code or DDL enforces
- [ ] Every command added to documentation was executed as written before the commit
- [ ] Every edited paragraph re-read as a whole, not as a diff (a fragment of the old sentence survived three rounds once)
- [ ] A change to what reaches the logs is covered by a test that reads the log itself, not the HTTP response
- [ ] Integration tests in a shared temp database key their latches and counters to their own rows (`intentId`), not to processing order
- [ ] A clarify answer that changed a plan constraint is named, with the affected invariant, in the PR's "Deviations" section
- [ ] **Every assertion added or changed was shown to fail** — the unit is the assertion, not the test. Each one gets a mutation that breaks the code it guards in the list for `tooling/mutations.ts` (Step 5); the PR quotes the script's table with the printed failures. A test that reddens for *some* reason says nothing about the assertions inside it that cannot redden for any: #159 shipped a `revoked_at >= created_at` check that compares JS `Date`s at millisecond resolution against a microsecond inversion, so on the real bug pair it returned true while the test went red through the DDL CHECK beside it. A passing test is not evidence it can fail — #22 shipped three Majors past suites that were green by construction
- [ ] The mutation used as that evidence is **discriminating, not neighbouring**: it must redden the new check alone. If an assertion that already existed also goes red, the experiment proves nothing about the new one and a narrower mutation is needed
- [ ] A check written *this round to close a review finding* is held to the two items above as well — that is the oracle the previous round's rule always misses
- [ ] **An instrument is not exempt either.** A script, generator or ledger whose output *is* the round's evidence is held to the same rule as a test — #68 rested a whole round on `assertion-ledger.sh`, which silently dropped deletion-only hunks and globbed zero files. A completeness check whose two sides come from the same generator proves nothing. An instrument that edits files and restores them around a child process is tested through the real process path too — spawn failure, malformed output, a signal — not only through a substituted runner: #511's `tooling/mutations.ts` passed 14 stubbed tests while a throw inside the child's event handler left the mutated file in the tree
- [ ] A documented **procedure** (not only each command in it) was executed end to end from the starting state it names — a fresh volume, an empty database. #68's bring-up procedure passed command by command on a working environment and could not create its first account on a fresh one
- [ ] Every command output quoted as evidence was re-run at the head the comment names. Carried-over output from an earlier tree was a finding twice in #68 (m16, n3), both times with the claim itself intact
- [ ] A commit SHA quoted as evidence is mapped to its post-merge SHA once the PR lands. This repository rebase-merges, so the SHA the PR body cites is rewritten and stops being reachable from `main` — #159 gave its red run a commit of its own precisely so it could be checked out, and the quoted id then pointed at a commit only the PR's refs still hold. Post the mapping as a comment on the merged PR

### Step 6: Commit

**Check this repo's CLAUDE.md → Git-процесс first** — it is the only record of whether the commit and PR stop points are waived. Waived: proceed directly. Not waived: invoked directly, ask via `AskUserQuestion`; spawned by tech-lead, return to tech-lead instead of asking.

```bash
git status                     # verify current branch
git add <specific files>       # never git add . or git add -A
git commit -m "#N: description"
```

**Rebase:** run `git -c core.commentChar=';' rebase …` and `git -c core.commentChar=';' rebase --continue`. With the default comment char `#`, the commit message after a conflict loses its `#N: …` subject as a comment line, leaving only the trailer (#185, #138). Probed on git 2.32: the plain `--continue` dropped the subject; with `;` it was kept.

### Step 7: Create the PR

Same stop-point check as Step 6, this time for push/PR:

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

As in the initial workflow's Step 5: targeted runs of the touched files while fixing, the per-commit check of every new commit, the per-test durations of the added/changed test files, one full `pnpm check` at the head before the push, and the mutation table re-taken whole on the new head by one call of `tooling/mutations.ts`.

### Step 5: Commit, push, update PR

Same stop-point rule as the initial-implementation workflow, and the same formatting rule (Step 4: prettier only on new files, `git diff -- <file>` of every existing file before `git add`):

```bash
git status
git add <specific files>
git commit -m "#N: address review comments"
# the per-commit check of Step 5 on this commit (its own worktree), then one full pnpm check at the head
git push
```

A rebase-only task (tech-lead → «Mergeability right before the merge», and the stacked rebase of tech-lead → «A PR left In Review by a manager session», step 1) runs the same per-commit check on every rewritten commit before its force-push, and re-takes the mutation table on the new head by one call of `tooling/mutations.ts`.

PR updates automatically — no new PR needed.

### Step 6: Move issue to In Review

Via `/github` skill ("Update Pipeline Status" → In Review), then a PR comment naming the iteration and the commits that address each finding. The reviewer picks issues up by `In Review` (reviewer Step 1).

---

## Forbidden Actions

- Never push to `main` or merge a PR — out of scope for this role regardless of stop-point settings.
- Never use `git add .` or `git add -A` — stage specific files by name.
- Never push without the per-commit check of every new commit, the per-test durations of the added/changed test files (Step 5) and one full `pnpm check` at the head, and never judge either by piped output.
- Never skip `git status` before committing — committing to the wrong branch means a cherry-pick and wasted work.
- Never deviate from the Architect's plan without flagging the discrepancy explicitly.
- Never start fixing review findings before the Architect has posted a "Plan Update" comment.
- Never call `AskUserQuestion` when running as a spawned agent — return the question to tech-lead. Invoked directly, any genuine question for the owner goes through `AskUserQuestion`, never plain text.
