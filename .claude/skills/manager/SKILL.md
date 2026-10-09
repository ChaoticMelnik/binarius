---
name: manager
description: Unattended night session (about 8 hours) for when the owner cannot answer. Picks tasks from the board, runs architect → implementer → reviewer per tech-lead Mode 2, answers clarify questions itself, never merges, and keeps a private report artifact centred on behaviour changes. Launch with `/manager`, `/manager до 06:00`, `/manager 6 ч` or `/manager проба: задача #N, лимит 1 ч`.
model: inherit
---

# Manager Role

## Overview

The owner's decisions and the exceptions this role has from the day pipeline live in one place: `.claude/CLAUDE.md` → «Режим manager — ночная автономная сессия». This skill holds the procedure and the operational numbers; it does not repeat that section.

The manager runs **tech-lead Mode 2, Phases 0–4** (`.claude/skills/tech-lead/SKILL.md`): Phase 0 once per night, inside the manager's own Phase 0, and Phases 1–4 per task. Tech-lead's text applies as written, including "Phases run as spawned agents" (models, spawn prompt), "Failed or stalled phase" and Step 7 (worktrees, scratch dirs, the shared-resource guard, phase concurrency limits). There are exactly five substitutions:

1. **Clarify relay** → the manager answers (§ Substitutions, 1).
2. **Merge relay** → stop at In Review (§ Substitutions, 2).
3. **Phase 4 at the session's end** with an open Blocker/Major → In Review with an open-findings comment (§ Substitutions, 3).
4. **Model limits** → Fable falls back to Opus; an Opus limit ends the session (§ Substitutions, 4).
5. **Phase 5 is not run** — there is no merge; the audit entry and docs PR happen in the morning, after the owner merges (§ Morning).

Tasks run **one at a time**. The manager never asks the owner anything, never calls `AskUserQuestion`, and never merges.

## Launch

From the main checkout, not from a worktree-isolated session (in one, the harness lets agents write only in that worktree, so implementers cannot create `.claude/worktrees/impl-<N>` — tech-lead Step 7):

```bash
cd /Users/user/Documents/Binarius
claude --model opus --permission-mode auto "/manager до 06:00"     # or "/manager 6 ч"; default 8 ч
```

`--bg` and a later `claude attach` work too. Non-interactive `claude -p "/manager …" --model opus --permission-mode auto < /dev/null` also works — under `-p` the process waits for background Bash and background `Agent` notifications, and a permission request turns into a `permission_denials` entry instead of hanging (probes of #397, table in its PR).

Arguments (Russian, free form; the manager reads them):
- `до HH:MM` — deadline in Moscow time; `N ч` — duration; nothing — 8 h.
- `проба: задача #N, лимит 1 ч` — a trial run: only issue `#N`, deadline in 1 h, may run from a branch checkout (the preflight's `.claude/` check is then skipped and the report says so).

The manager does not switch the main checkout's branch. Phases work in `.claude/worktrees/impl-<N>` and `review-<PR>-r<round>-<epoch>`, left in place for the morning.

## State

`ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")` is the main checkout from any worktree. Directory `M=$ROOT/.claude/worktrees/manager` (ignored by git, the same path for every session):
- `state.json` — `{session, start, deadline, launch, report:{path,url}, main_sha_start, tasks:[{issue,status,branch,pr,phase,round,started,ended,plan_model,decisions,open_findings,watchdog_task}], skipped:[{issue,reason}], created:[], stops:[]}`; times as Unix seconds. Rewritten on every transition (claim, spawn, phase result, status change, report publish).
- `report-<YYYY-MM-DD>.html` — the report's local file.

After a compaction or `claude --resume`, the first action is to re-read `state.json`, compare each task with GitHub (Pipeline Status, PR, last comments — "Failed or stalled phase") and restart the watchdog of a running phase; no new snapshot.

## Phase 0 — Preflight and snapshot

1. **Another manager.** `state.json` exists, its `start` is under 9 h ago, and this session is not resuming it (§ State) → stop with a message naming that session and its report. Every manager starts from the main checkout, so the file is the same for all of them.
2. **Tech-lead Phase 0** as written (fetch, status, Codex/GitHub/runtime checks, previous audit). Codex not ready or out of budget does not stop the night: it is recorded, and the Codex rule below applies.
3. **`.claude/` is `main`'s**: `git fetch --prune origin && git diff origin/main --stat -- .claude/` prints nothing (the harness loads skills from the checkout). Non-empty → stop with the diff. Skipped only in a trial run declared in the launch prompt.
4. **Snapshot** into the report's «Исходное состояние»:
   ```bash
   git rev-parse origin/main && git log --oneline -5 origin/main
   gh pr list --repo ChaoticMelnik/binarius --state open --json number,headRefName,baseRefName,title --jq '.[] | "#\(.number) \(.headRefName) → \(.baseRefName) \(.title)"'
   # board: /github → "List issues by status", once each for In Progress, In Review, Todo
   git for-each-ref --sort=-committerdate --format='%(committerdate:unix) %(committerdate:iso8601) %(refname:short)' refs/remotes/origin \
     | awk -v t=$(( $(date +%s) - 86400 )) '$1 > t {print $2, $3, $4, $5}'
   git worktree list
   ```
5. **DEMO_ONLY stand** — the money guard (#396):
   ```bash
   grep -c '^DEMO_ONLY=true$' "$ROOT/.env"                                   # must print 1
   grep -E '^(TELEGRAM_BOT_TOKEN|ADMIN_BOT_TOKEN)=' "$ROOT/.env" | cut -d= -f1  # the dev bots of 2026-10-04 are there
   DC="docker compose -f $ROOT/compose.yaml -p binarius-manager"
   DEMO_ONLY=true POSTGRES_PORT=5436 REDIS_PORT=6380 $DC up -d --build postgres redis trading-worker
   $DC logs trading-worker | grep 'trading-worker started'   # must show demoOnly: true
   $DC down -v
   ```
   Only the worker comes up — it does not poll Telegram, so no 409 with the server bots; the ports are moved off the day stand's. `.env` without `DEMO_ONLY=true` → no phase brings up a stand tonight (the spawn prompt says so), and the report says why. Docker down or ports taken → the report says «проверка по `.env` выполнена, строка лога — фаза <X>», and the first phase that brings up a stand quotes the line.
6. **Clock and alarm.** Write `state.json` (`start` = now, `deadline` from the launch arguments), then the alarm: `Bash` with `run_in_background: true`, command `sleep <deadline − now>; echo DEADLINE`. The completion notice carries no stdout: any completion of this task is a wake-up, and the decision is always the clock (§ Budget).
7. **Report.** `Skill(artifact-design)`, copy `.claude/skills/manager/report-template.html` to `$M/report-<date>.html`, fill «Исходное состояние» and the header, publish with `Artifact` (`file_path` = that file, `icon: "report"`, `pin: true`, `description` = one sentence on the night) and store the URL in `state.json`.

## Task selection

**Pool**: Pipeline Status **Todo**, and **In Progress** with an «Implementation Plan» comment and no branch, PR or worktree. Order: the board's order, with business-logic changes (воронка, демо, сигналы, сессии — judged from the title and body) before Minor follow-ups. Issues in `created[]` are never in tonight's pool. In a trial run the pool is the one issue named.

**Skip** (each with its reason in `skipped[]` and the report):
- `[SPIKE]` in the title.
- A dependency (the body's «Зависимости», or a plan's merge order) that is not merged and cannot be stacked (below).
- **Taken by another session** — any of:
  ```bash
  N=<issue>; R=ChaoticMelnik/binarius; DAY=$(( $(date +%s) - 86400 ))
  # (1) status In Review, or In Progress with a branch/PR — /github → "Find issue's current Pipeline Status"
  gh pr list --repo $R --state open --json number,headRefName,body \
    | jq --arg n "$N" '[.[] | select((.headRefName | test("/" + $n + "-")) or (.body | test("(?i)closes #" + $n + "\\b")))] | map(.number)'   # (2) must be []
  git for-each-ref --format='%(committerdate:unix) %(refname:short)' refs/remotes/origin \
    | awk -v n="$N" -v t=$DAY '$1 > t && $2 ~ ("/" n "-")'                                  # (3) must print nothing
  git worktree list --porcelain | grep -E "^branch refs/heads/[^/]+/$N-"                     # (4) must print nothing
  gh issue view $N --repo $R --json comments --jq '[.comments[].createdAt | fromdateiso8601] | max // 0' \
    | awk -v t=$DAY '{ if ($1 > t) print "recent comment" }'                                   # (5) must print nothing
  ```
  Signal (5) counts any author: all sessions and the owner post as one login, so only age tells. A false skip is cheaper than a duplicate.

**Stacking**: a dependent issue is taken only if its base is (a) merged, (b) In Review from a day session, or (c) a task of this session with LGTM or Minor-only. A base still in its review loop → skip for now. The implementer branches from the base's head (implementer Step 2), the PR is created with `gh pr create --base <base branch>` (its diff is then only the delta — so, unlike the day rule of tech-lead Phase 3, it is reviewed tonight), its body says «Merge after #<base>», and the report's «Порядок мержа» lists the pair.

**Time**: no new task when less than 90 min remain to the deadline.

**Claim**: re-run the five checks right before writing anything; any new signal → skip. Then `→ In Progress` (`/github`), then the comment «Взята менеджером, сессия <YYYY-MM-DD> <HH:MM MSK>; отчёт: <report URL>». If a write times out, re-read status and comments before repeating it.

## Task cycle

Tech-lead Mode 2 Phase 1 (Todo) or Phase 2 (In Progress with a plan), then Phases 3–4, through tech-lead's own text. Each spawn prompt is tech-lead's six items plus these **night additions**:
- "This is a `/manager` night session: questions go back to the manager, who answers them by `.claude/CLAUDE.md` → Режим manager."
- "Forbidden tonight (`.claude/CLAUDE.md` → Режим manager → Запрещено ночью): no stand without `DEMO_ONLY=true` — quote the `trading-worker started … demoOnly: true` line in your hand-off whenever you bring one up; dummy or dev bot tokens only, never another poller's (tech-lead Step 7); no edits of `.claude/` except this feature's Architecture Rules entries in `architect/SKILL.md`; nothing on the VPS; no deploy; no merge, push to `main`, force-push or branch deletion; no `--admin` or other bypass flag."
- "Any issue you create (a split, a follow-up) goes to **Backlog**, never Todo." (architect)
- "Your hand-off adds a «Behaviour changes» paragraph: what changes for the user, for money, for trading — or «none»." (implementer)
- "A stacked base: branch from `<base branch>`, `gh pr create --base <base branch>`, «Merge after #<base>» in the body." (implementer, when stacking)

**Watchdog** — after every spawn, a background `Bash`:
```bash
.claude/skills/manager/phase-watchdog.sh <N> <branch or -> <limit-min> <architect|implementer|reviewer>
```
Limits: architect 60, implementer 150, reviewer 90 min of no activity on GitHub (issue comments, the branch's last commit, the PR's comments and reviews). It checks every 5 min and exits only on a stall. On its completion notice, read the task's output file (the notice carries no stdout): a `STALLED` line → make sure the phase agent has not reported `completed`/`failed`, then `TaskStop` it, record «фаза остановлена по таймауту простоя (вероятно, ждала разрешения)» in the task and the report, leave the task where it stands, and go to the next task. When a phase ends normally, `TaskStop` its watchdog.

### Substitutions

**1. Clarify relay → the manager answers.** Replaces tech-lead "Clarify relay" for every question a phase returns and for every checkpoint question that goes to the owner in the day (the Codex retry question, the change of approach). For each question, in order:
1. a standing answer (`.claude/CLAUDE.md` → Постоянные ответы владельца) covers it → that answer;
2. otherwise the option marked "(Recommended)"; without a mark, the first option.

A question the phase marks as a plan defect goes to the architect for a Plan Update, as in the day. Before answering, post one comment per round on the issue:
```
## Решение менеджера (сессия <YYYY-MM-DD>, <architect|implementer> clarify, раунд <k>)
1. <вопрос> — варианты: (a) …; (b) …; (c) … → **(a)** — рекомендуемый вариант | постоянный ответ «<тема>»
```
Then `SendMessage` to the same agent with the answers (a fresh spawn with the answers in its prompt if it is gone), and add the decisions to the task's row in the report.

**2. Merge relay → stop at In Review.** Replaces tech-lead "Merge relay" and Phase 4 "If the reviewer reports the PR is clean". The reviewer posts its ready-to-merge comment as written; when its Codex pass was skipped on a limit and the classifier refuses that comment from a sub-agent (#258), the manager posts it from the main context, naming the skip. The manager records the merge request — PR, approved head, the Codex job id or the skip line, `gh pr checks` — in `state.json` and the report, and does nothing else: no merge, no Done. A Minor-only verdict is handled the same way, the Minors listed in the report; the Backlog issue for them is created at the morning merge (standing answer «Оставшиеся Minor»), not tonight.

**3. Open Blocker/Major at the session's end.** Inside the session the day loop holds: reviewer → Todo → architect Plan Update → In Progress → implementer → reviewer. After round 2 the change of approach is re-planning from scratch — the architect writes a new plan against the current branch (tech-lead Phase 4, iteration 2, "re-plan from scratch"); never the whole-feature-Codex option, since Codex takes no part in planning (owner's rule of 2026-10-08, PR #353). A split is the architect's call, its new issues in Backlog. Round 3 is the last. When the cycle stops with a Blocker/Major open — after round 3, at the deadline or on a model limit — the manager moves the issue to **In Review**, posts on the PR «Открытые находки на конец сессии менеджера <YYYY-MM-DD>: …» with each finding's severity and comment link, and adds them to the report. No issue is created for them.

**4. Model limits.** An architect spawn (plan or Plan Update) that dies on a usage-limit / 429 API error (its notice is `failed`, or its transcript's last model is `<synthetic>`) **before posting anything** (checked on GitHub, "Failed or stalled phase") is re-spawned once with `model: "opus"` and the same prompt plus: "Open the plan with the line «план на Opus (лимит Fable <HH:MM>)»." The task's `plan_model` becomes `Opus (лимит Fable HH:MM)`. A plan already posted on Opus is not redone when Fable comes back. An Opus spawn dying on a limit → **early finish**: `TaskStop` every running phase and watchdog, record each task's state, finalize the report. Replaces the day's question «Plan Update on Opus?» (tech-lead Phase 4, iteration 1).

**Codex** — only the final whole-feature pass on a round without Blocker/Major before the merge; an exhausted limit means a skip with the line `Codex пропущен: лимит до HH:MM (job <id>), правило 2026-10-08`, without a question (owner's rule of 2026-10-08, PR #353; after its merge — `.claude/CLAUDE.md` → «Codex — только финальное ревью перед мержем»). A reviewer's clean round tonight is the round that would end in a merge, so it runs that pass. A non-limit Codex failure after two attempts is a skip with a line in the review, by substitution 1.

## Budget

On every transition — before a claim, before a spawn, after every notice — compare `date -u +%s` with `deadline` from `state.json`; the alarm only wakes the manager up, the clock decides. A lost notice therefore never extends the night beyond the next transition.
- Less than 90 min left → no new task.
- Deadline passed → the running phase finishes; no new phase or round starts. The task stays where that phase leaves it (a posted plan → In Progress; a PR → In Review), and the report says so. An open Blocker/Major → substitution 3.
- Then the final report (§ Report) and the session's last message: the report URL, the local file path, one line per task.

## Report

Sections and their order are the template's (`report-template.html`). The task row's «Поведение» column is the night's main content: written from the plan's Scope and the implementer's «Behaviour changes» paragraph. «Проверка руками» comes from the issue's «Как проверить руками» and the PR's test plan.

Update the local file (Edit) and republish with `Artifact` and the same `file_path` (no `icon`) after each claim, PR, review verdict, manager decision, skip and stop. The final publish sets the header's status to «завершена» or «досрочный финал: <причина>». A failed publish (network) does not stop the session: the file stays, the next update retries, and the final message carries the path.

## Morning — for the owner

1. Open the pinned report: the tasks, behaviour changes, merge order, owner steps.
2. Read the «Решение менеджера» comments of each issue; a wrong decision → a review comment or a Plan Update round.
3. In a day session, `/tech-lead`, per PR in the report's merge order — tech-lead Mode 2 → "A PR left In Review by a manager session": merge relay (`--rebase --delete-branch`), a stacked dependent rebased `--onto origin/main` with `--force-with-lease`, CI, its merge relay; Phase 5 after each merge.
4. A PR with open Blocker/Major: a Plan Update round (the round count continues from the night's) or close the PR.
5. The worktrees `impl-<N>` and `review-*` are removed by tech-lead after each merge (tech-lead Step 7).

## Forbidden

`.claude/CLAUDE.md` → Режим manager → «Запрещено ночью» is the list. In addition, for the manager itself:
- Never call `AskUserQuestion`, never wait for an answer from the owner.
- Never run `gh pr merge`, never move an issue to Done.
- Never run two task cycles at once, and never take an issue created tonight.
- Never edit files in a phase's worktree — phases do the work.
