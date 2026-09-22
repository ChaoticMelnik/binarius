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

Mandatory stop points follow `~/.claude/CLAUDE.md` → Skill Orchestration → Pipeline autonomy, as waived (or not) by this repo's own `.claude/CLAUDE.md` → Git-процесс. As of bootstrap, nothing is waived here: `/implementer` stops for commit authorization and again before push/PR; the merge stop point is never waivable at all — `/reviewer` reports a clean PR and waits for the user to merge it, unless this repo's CLAUDE.md has separately opted into agent-executed merges with a per-merge `AskUserQuestion` confirmation.

Tech Lead also owns enforcement of the two Codex checkpoints: plan review during Architect, code review during Reviewer — both mandatory (`~/.claude/CLAUDE.md` → ABSOLUTE RULE).

Model per role is fixed by `.claude/CLAUDE.md` → Модели по ролям pipeline: this skill runs on the session model (`model: inherit`), `/architect` switches to Fable, `/implementer` and `/reviewer` to Opus — each via its own frontmatter at `Skill(...)` invocation time, reviewer sub-agents via an explicit `model` on every spawn. Never ask the owner to switch `/model` between phases; the skills do it, and the session model is only the fallback.

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
- [ ] PR body has: what changed, `Closes #<N>`, a test plan
- [ ] Issue moved to In Review only after the PR was created
- [ ] PR contains only relevant files (no `git add .` artifacts)
- [ ] No new type/build errors in the diff

### Reviewer step — check

- [ ] Review comments are specific and actionable, not vague
- [ ] Blockers/Majors were noted before any approval
- [ ] Codex code review ran before the reviewer finalized the verdict
- [ ] If issues found: reviewer returned the issue to **Todo** before any re-implementation started
- [ ] If clean: reviewer posted the ready-to-merge comment and did not self-approve

### Model policy — check

- [ ] Each phase ran on its policy model (`.claude/CLAUDE.md` → Модели по ролям pipeline): Architect on Fable, Implementer and Reviewer on Opus, `/simplify` sub-agent on Sonnet. Verify from the session transcript, not from frontmatter:
  ```bash
  grep -o '"model":"[^"]*"' ~/.claude/projects/-Users-user-Documents-Binarius/<session-id>.jsonl | sort | uniq -c
  ```
  Only the session model in the output means the per-skill switch did not happen. Severity: Major if Architect ran below Fable, Minor if another phase ran above its policy model (cost only).

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

1. **Codex** — invoke `Skill(skill: "codex:setup")` (the official `codex` plugin, `openai-codex` marketplace — not MCP; `codex mcp-server` was removed upstream in codex-cli 0.153.0+). If it reports Codex missing/unauthenticated and offers to fix it, let it; still not ready → STOP and ask the user. Never start the pipeline knowing a mandatory checkpoint can't run.
2. **GitHub** — `gh auth status`; if stale, ask the user to `gh auth login` / refresh before proceeding.
3. **Model** — the system prompt names the session model. The policy fallback is Fable (`.claude/CLAUDE.md` → Модели по ролям pipeline). If the session runs on anything else, continue, but record it as a deviation in the Phase 3 audit: an owner prompt mid-phase would then drop `/architect` below Fable.

**Timeout policy (every checkpoint):** if a Codex call times out twice in a row, offer the skip decision immediately — no third attempt by default.

#### Phase 1 — Architect

Invoke `/architect` via the Skill tool with the issue number. Never perform architect steps inline, regardless of how small the issue looks.

If this repo's CLAUDE.md has waived the commit/PR stop points: no text between phases — immediately invoke `/implementer` next. If not waived (the bootstrap default): report the plan to the user and follow whatever stop behavior the unwaived pipeline default implies before continuing.

#### Phase 2 — Implementer

Invoke `/implementer` via the Skill tool with the issue number. Never perform implementer steps inline.

If a merge-chain base branch (Mode 1, Step 3) has already merged into `main` since the chain was declared, rebase onto `main` before implementation continues — check `gh pr view <base-PR> --json state,mergedAt` first.

#### Phase 3 — Finalize

Once the PR exists and the issue is In Review:
1. Run the Monitoring-mode audit on the completed work.
2. Post the audit as a GitHub issue comment.
3. Invoke `/reviewer` — the Tech Lead owns the full lifecycle end to end.

#### Phase 4 — Review findings loop

Track the iteration count (starts at 1 for the first review).

**If `/reviewer` finds issues:**
1. Iteration ≥ 2 → stop, report to the user: "Ревьюер вернул задачу во второй раз. Требуется ручное вмешательство." Do not invoke implementer again.
2. Iteration < 2 → invoke `/architect` first for a Plan Update (returns the issue to In Progress), then `/implementer` to fix, then re-invoke `/reviewer` with "rerun" for this issue.

**If `/reviewer` reports the PR is clean:**
Reviewer already posted the ready-to-merge comment and cannot self-approve. Report to the user that the PR is ready. **Do not move the issue to Done yet** — a clean review isn't the same as merged work. Wait for confirmed merge (per this repo's merge policy in CLAUDE.md), then move the issue to **Done** via `/github` skill, then run Phase 5.

#### Phase 5 — Post-Done housekeeping

Run once the merge is confirmed and the issue is Done.

1. Sync local state:
   ```bash
   git fetch origin
   git checkout main
   git pull --rebase origin main
   ```
2. If the iteration counter in Phase 4 reached ≥ 1: produce a Process Improvement Report (root cause + which workflow step should have caught it, per finding) and post it as a GitHub issue comment.
3. Always: append an entry to `audits.md` in the project root (create it if missing, `# Audit Log` heading first, `---` separator before each new entry):
   ```markdown
   ## #N — <issue title> (<YYYY-MM-DD>)

   ### Process audit
   | Role | Step | Result |
   |------|------|--------|

   ### Review iterations: <N>

   ### Findings (if any)
   | Finding | Severity | Root cause | Missed at step |
   |---------|----------|------------|-----------------|

   ### Process improvement proposals (if any)
   1. ...
   ```

---

## Project Architecture Reference

Стек зафиксирован 2026-09-21 при бутстрапе pipeline. Отправная точка — `binodex-bot-implementation-plan.md`, использованный **только для выбора технологий** (это черновой план поставщика, его бизнес-сценарии и допущения не проверены — он не является обязывающей техспецификацией фич для пайплайна):

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

Доменные сущности, доменные инварианты (demo/real, дедупликация постбэков, транзакционность резерва токена и т.п.), схема БД, точный контракт Binodex Broker/Partner API, бонусная сетка, лимиты сессии и параметры хостинга — не зафиксированы здесь. Всё это архитектор проектирует и верифицирует для первого реального issue (Волна 0 плана — проверка реализуемости на тестовом аккаунте), а не переносит из чернового плана заранее. `.claude/skills/architect/SKILL.md` → Architecture Rules to Enforce заполняется по мере того, как эти правила подтверждаются.

---

## Forbidden Actions (both modes)

- Never push to `main` or merge a PR without whatever confirmation this repo's CLAUDE.md currently requires.
- Never move an issue to Done without explicit confirmation that the PR was merged (`state == "MERGED"`).
- Never edit files in another agent's/developer's active domain without flagging the conflict.
- Never execute Architect or Implementer steps inline — always via the Skill tool, even for trivial one-line issues.
- Never write text output between pipeline phases where this repo's CLAUDE.md has waived stop points — an inter-phase recap forces the user to say "continue" unnecessarily.
- Never waive a missing Codex checkpoint silently — report it as a process deviation.
- Any question to the owner goes through `AskUserQuestion`, never plain text.
