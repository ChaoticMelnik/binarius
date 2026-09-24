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

Mandatory stop points follow `~/.claude/CLAUDE.md` → Skill Orchestration → Pipeline autonomy, as waived (or not) by this repo's `.claude/CLAUDE.md` → Git-процесс — that section is the only record of what is waived; read it there rather than trusting a copy. The merge confirmation is never waivable: before every single merge, tech-lead asks the owner via `AskUserQuestion`.

Tech Lead also owns enforcement of the two Codex checkpoints: plan review during Architect, code review during Reviewer — both mandatory (`~/.claude/CLAUDE.md` → ABSOLUTE RULE). Where this skill and `~/.claude/CLAUDE.md` disagree, the project's `.claude/CLAUDE.md` governs (see its note under «Модели по ролям pipeline»).

### Phases run as spawned agents

Every phase is an `Agent` spawn with an explicit `model` (`.claude/CLAUDE.md` → Модели по ролям pipeline): architect `fable`, implementer and reviewer `opus`, `subagent_type: "general-purpose"`. The spawn's `model` is what sets the phase's model; a skill's frontmatter does not survive a `Skill()` call inside one turn (#42). Never ask the owner to switch `/model` between phases.

Spawn prompt — every phase gets these, in this order:
1. Role and issue: "You are the <ROLE> phase for GitHub issue #<N> (ChaoticMelnik/binarius, working dir <path>)."
2. "First action: `Skill(skill: \"<role>\")`, then follow it."
3. "You have no `AskUserQuestion`. Return every question for the owner in your final message: ≥3 for a clarify round, each with 2-4 options, the recommended one first, in Russian. Make no edits in a clarify round."
4. Node: `eval "$(fnm env)" && fnm use`.
5. What to return: the role's own hand-off (plan comment URL / PR URL and commit list / review verdict with merge request) plus deviations and anything unfinished.

**Clarify relay.** Architect and implementer start with a clarify round: the agent returns its questions and stops. Tech-lead asks them in one `AskUserQuestion` call, passing every option through unchanged, then continues the same agent with `SendMessage` carrying the answers (a fresh spawn with the answers in its prompt if the agent is gone). A question the agent marks as a plan defect goes to the architect for a Plan Update, not to the owner.

**Merge relay.** The reviewer never merges when spawned; it returns its verdict and a merge request (PR, approved head, the id of the Codex job counted as the whole-feature pass, checks, allowed methods). Tech-lead asks via `AskUserQuestion` immediately before this specific merge, runs `gh pr merge <N>` with the chosen allowed method only on an explicit yes — never `--admin` or another bypass — and then confirms `gh pr view <N> --json state,mergedAt` shows `MERGED`.

---

## Mode 1: Monitoring

### When to invoke

After an issue moves to In Review or Done, or when asked to audit the process.

### Architect step — check

- [ ] Issue has an implementation plan comment posted **before** it moves to In Progress
- [ ] Plan covers the full domain scope, not just explicitly mentioned entities
- [ ] Codex plan review happened before the plan was finalized
- [ ] If returned from review: a "Plan Update" comment exists before re-implementation started

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
- [ ] Codex code review ran before the reviewer finalized the verdict
- [ ] If issues found: reviewer returned the issue to **Todo** before any re-implementation started
- [ ] If clean: reviewer posted the ready-to-merge comment and did not self-approve
- [ ] Every review round reviewed `gh pr diff` (the whole feature), never an iteration delta
- [ ] CI (`gh pr checks`) was green on the merged head — `pnpm check` there carries the automated gates (manifest targets, status literals, constraint coverage)

### Whole-feature pass — check

The Codex run that counted as the whole-feature pass covered exactly the approved diff. That is the reviewer's 3a (`Iteration review` marker) when nothing landed after it, otherwise a 6-pre rerun (`Whole-feature pass` marker). Find the newest completed job with either marker and re-hash:

```bash
PR=<N>
COMPANION="$(jq -r '.plugins["codex@openai-codex"][0].installPath' ~/.claude/plugins/installed_plugins.json)/scripts/codex-companion.mjs"
node "$COMPANION" status --all --json | jq -r --arg pr "$PR" \
  '[.latestFinished, .recent[]?] | map(select(. != null and .status == "completed"
      and ((.request.prompt // "") | test("^(Iteration review|Whole-feature pass) #" + $pr + ":"))))
   | sort_by(.completedAt) | reverse | .[] | "\(.id) \(.completedAt) \(.request.prompt | split("\n")[0])"'
# first line = the newest completed full-diff run: base=<b> head=<h> diff-sha256=<x>
git fetch origin main
git merge-base --is-ancestor <b> <h> && git merge-base --is-ancestor <b> origin/main && echo base-ok
git diff --no-color --no-ext-diff <b> <h> | shasum -a 256        # must equal <x>
gh pr view $PR --repo ChaoticMelnik/binarius --json headRefOid --jq .headRefOid   # must equal <h>
```

`<h>` must be the head the LGTM comment approved and the one that merged (the last line), and `<b>` a `main` commit that `<h>` descends from. No marker, a different head, or a different hash is a Major audit finding. `status` lists only this Claude session's jobs and the companion keeps the newest 50 per workspace, so run this check in the session that ran the pipeline.

### Audit proposals — check

- [ ] Every proposal of the previous audit entry in `audits.md` carries a status (Phase 5 format)

### Model policy — check

Each phase's spawn requested its policy model and got it. The transcript links each `Agent` call to its result, and the result names the model the harness actually assigned (`resolvedModel`) and the agent's own transcript file:

```bash
S=~/.claude/projects/-Users-user-Documents-Binarius/<session-id>
jq -rs '
  [.[] | .message.content[]? | select(.type? == "tool_use" and .name == "Agent")
    | {id, model: .input.model, description: .input.description}] as $spawns
  | [.[] | select(.toolUseResult.agentId? != null)
    | {id: (.message.content[] | select(.type == "tool_result") | .tool_use_id),
       agentId: .toolUseResult.agentId, resolved: .toolUseResult.resolvedModel}] as $results
  | $spawns[] | . as $s | ([$results[] | select(.id == $s.id)] | first) as $r
  | [$s.description, ($s.model // "(none)"), ($r.resolved // "not finished"),
     (if $r then "subagents/agent-\($r.agentId).jsonl" else "-" end)] | join(" | ")
' "$S.jsonl"
grep -o '"model":"claude-[^"]*"' "$S/subagents/agent-<agentId>.jsonl" | sort -u
```

Per phase: (a) the requested `model` is the policy's; (b) `resolvedModel` is that alias's id in the table of `.claude/CLAUDE.md` → Модели по ролям pipeline; (c) the agent's own transcript names exactly one model, the same as `resolvedModel`. (a) and (b) are conclusive whatever the session model is — `resolvedModel` is what the harness assigned to that spawn. A spawn with no result yet is "not finished", not "failed".

Nested spawns (reviewer 3b-3d, depth 2) have no `resolvedModel` anywhere — a spawned agent's transcript does not store tool results' metadata. Every spawn, at any depth, leaves `subagents/agent-<agentId>.meta.json` with the requested `model`, `description`, `spawnDepth` and `parentAgentId`; pair it with (c) on the agent's own file:

```bash
for m in "$S"/subagents/*.meta.json; do a=${m%.meta.json}; printf '%s | depth %s | requested %s | ran %s\n' \
  "$(jq -r .description "$m")" "$(jq -r .spawnDepth "$m")" "$(jq -r '.model // "(none)"' "$m")" \
  "$(grep -o '"model":"claude-[^"]*"' "$a.jsonl" | sort -u | cut -d'"' -f4 | tr '\n' ' ')"; done
```

Severity: Major if Architect did not run on Fable; Minor if another phase ran above its policy model (cost only).

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

1. **Codex** — `node "$COMPANION" setup --json` (companion path as in "Whole-feature pass — check"): `ready`, `auth.loggedIn`. Not ready → `Skill(skill: "codex:setup")` once; still not ready → STOP and ask the owner. Then the budget: `node "$COMPANION" status --all --json` — a recent job that failed with "You've hit your usage limit … try again at HH:MM" means the pipeline waits for that reset; a long issue needs several runs (plan review, one per review round, the whole-feature pass).
2. **GitHub** — `gh auth status`; if stale, ask the owner to `gh auth login` / refresh. If the plan's files include `.github/workflows/*`: the token needs the `workflow` scope, or `origin` must be an SSH remote (`git remote -v`) — otherwise the push fails at the end of implementation.
3. **Project CLAUDE.md on main** — `git diff origin/main -- .claude/CLAUDE.md` must be empty: the harness loads whatever is checked out, and a waiver living only on an unmerged branch was once acted on for a day.
4. **Runtimes** — every runtime the acceptance criteria exercise is available locally at CI's version: Node from `.node-version` (`eval "$(fnm env)" && fnm use`), Postgres/Redis (`docker compose ps`), Docker/Compose/buildx if the issue touches images or compose; CLI plugins match what CI uses.
5. **Previous audit** — every proposal of the latest `audits.md` entry has a status (Phase 5 format). An unmarked proposal, or `открыто` without a date and owner, is reported to the owner as a warning before the pipeline starts; it does not stop the pipeline.

**Timeout policy (every checkpoint):** at most 2 attempts per Codex run; after the second failure, stop and ask the owner — no third attempt by default. The owner may choose to skip a checkpoint only by an explicit answer; Phase 5 narrows this further (no merge question without a successful run or that explicit answer).

#### Phase 1 — Architect

Spawn the architect (`Agent`, `model: "fable"`, prompt per "Phases run as spawned agents"). Round 1 returns clarify questions → clarify relay → the same agent drafts the plan, runs Codex plan review and posts it. Never perform architect steps inline, regardless of how small the issue looks.

If this repo's CLAUDE.md has waived the commit/PR stop points: no text between phases — spawn the implementer next. If not waived: report the plan to the owner and follow whatever stop behavior the unwaived pipeline default implies before continuing.

#### Phase 2 — Implementer

Spawn the implementer (`Agent`, `model: "opus"`). Round 1 returns its clarify questions (implementer Step 0) → clarify relay; plan defects among them go to the architect first (continue the architect agent for a Plan Update) → the implementer continues with the answers and the Plan Update. Never perform implementer steps inline.

If a merge-chain base branch (Mode 1, Step 3) has already merged into `main` since the chain was declared, rebase onto `main` before implementation continues — check `gh pr view <base-PR> --json state,mergedAt` first.

#### Phase 3 — Finalize

Once the PR exists and the issue is In Review:
1. Run the Monitoring-mode audit on the completed work.
2. Post the audit as a GitHub issue comment.
3. Spawn the reviewer (`Agent`, `model: "opus"`) — the Tech Lead owns the full lifecycle end to end.

#### Phase 4 — Review findings loop

Track the iteration count (starts at 1 for the first review).

**If the reviewer finds issues:**
1. Iteration ≥ 2 → stop. Ask the owner via `AskUserQuestion` for a **change of approach** — the same loop again is not among the options:
   - (a) a whole-feature Codex pass (the reviewer's Step 3a command with `KIND="Whole-feature pass"`, run now) and a Plan Update built from its findings, not from the last round's;
   - (b) split part of the issue into a separate issue (created and added to the board via `/github`), and narrow this PR;
   - (c) re-plan from scratch: the architect writes a new plan against the current branch.
   Do not spawn the implementer until the owner picked one.
2. Iteration < 2 → the architect first (Plan Update; the issue returns to In Progress), then the implementer, then the reviewer again for this issue.

**If the reviewer reports the PR is clean:**
It posted the ready-to-merge comment and returned a merge request. Merge relay: `AskUserQuestion` immediately before this merge, `gh pr merge` only on an explicit yes, then confirm `state == "MERGED"`. **Do not move the issue to Done before that** — a clean review isn't merged work. Then move the issue to **Done** via `/github` skill, then run Phase 5.

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
5. **Docs PR** — branch `docs/<N>-audit` from `main`, the audit entry and the skill edits, PR body with `Refs #<N>` instead of `Closes` (the issue is already Done; `.claude/CLAUDE.md` → Git-процесс). It gets no reviewer phase and no 3b-3d sub-agents — process text, not code — but it does get Codex (owner's rule, 2026-09-24):
   - Run: the reviewer's Step 3a command with `KIND="Whole-feature pass"`, the diff of `.claude/**` + `audits.md` against `origin/main`, and `.claude/codex-review-prompt.md` with its Process-docs block filled (global `~/.claude/CLAUDE.md` inlined). Same criterion as "Whole-feature pass — check": the newest completed run's `head` must be the docs PR's current head before the merge question.
   - **Attempts** (execution failures) and **iterations** (findings → fixes) are counted separately. Attempts: 2 per run; after the second failure do not ask about the merge — ask the owner what to do with the run (retry later / explicitly accept merging without it). There is no silent skip here.
   - Iterations: a Blocker/Major is fixed in the same docs PR, and after the last such fix the run is repeated on the final diff, so the merge question is only ever about a diff Codex has seen. At most 2 fix iterations; a third Blocker/Major goes to the owner. A Minor is fixed or left at discretion, recorded in the PR body.
   - The merge question (merge relay) carries the last run's result: counts by severity, what was fixed, what was left.

---

## Project Architecture Reference

Стек зафиксирован 2026-09-21 при бутстрапе pipeline. Отправная точка — `binodex-bot-implementation-plan.md`, черновой план поставщика: в репозиторий не входит, использован **только для выбора технологий** и для правил не используется (его бизнес-сценарии и допущения не проверены):

| Компонент | Выбор | Пакет/приложение |
|---|---|---|
| Telegram-бот | Node.js + grammY (TypeScript) | `apps/bot` |
| Backend API | TypeScript + Fastify (OAuth, постбэки, авторизация, состояния) | `apps/backend` |
| Веб-страницы | Next.js (вход, касса, минимальная админка) | `apps/web` |
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
- Never execute Architect, Implementer or Reviewer steps inline — always as an `Agent` spawn with the policy `model` whose first action invokes the role's Skill, even for trivial one-line issues.
- Never write text output between pipeline phases where this repo's CLAUDE.md has waived stop points — an inter-phase recap forces the user to say "continue" unnecessarily.
- Never waive a missing Codex checkpoint silently — report it as a process deviation.
- Any question to the owner goes through `AskUserQuestion`, never plain text — including the questions a spawned phase returns.
- Never offer "one more iteration of the same loop" at the Iteration ≥ 2 stop.
