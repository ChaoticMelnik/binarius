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

Mandatory stop points follow `~/.claude/CLAUDE.md` → Skill Orchestration → Pipeline autonomy, as waived (or not) by this repo's `.claude/CLAUDE.md` → Переопределения глобального `~/.claude/CLAUDE.md` — that section is the only record of what is waived; read it there rather than trusting a copy. The merge confirmation is never waivable: before every single merge, tech-lead asks the owner via `AskUserQuestion`. `/manager` (`.claude/skills/manager/SKILL.md`) runs Phases 0–5 of Mode 2 unattended — Phase 5 in its night form, the session's entry and docs PR without a merge — with the substitutions and the exceptions of its § Правила ночи; it never merges.

**Codex** — Tech Lead also owns enforcement of the Codex checkpoint (reviewer Step 6-pre on a round that ends in a merge, round 3 included, and tech-lead's own 6-pre run; the Phase 5 docs PR gets none — #769). The rules below replace `~/.claude/CLAUDE.md` → ABSOLUTE RULE (plan and review) and its Timeout policy for this repo. Where this skill and `~/.claude/CLAUDE.md` disagree, the project's `.claude/CLAUDE.md` governs (its section «Переопределения глобального `~/.claude/CLAUDE.md`»).
- **Планирование без Codex.** Ни план архитектора, ни Plan Update (любого круга) Codex не проверяет.
- **Ревью — Codex один раз, в самом конце.** Обычный круг ревью — только агенты reviewer'а (3b-3d) и ручной чеклист. Codex запускается только на круге, который заканчивается мержем: на круге без Blocker/Major после 3b-3d и чеклиста и на 3-м (последнем) круге при любых находках — whole-feature pass по всему diff на текущем head (`.claude/skills/reviewer/SKILL.md` → Step 6-pre; after a rebase-only, at the run's own anchor — «A rebase of a pushed branch»). Его Blocker/Major на 1-2-м круге возвращает задачу обычным кругом, на 3-м — добавляется к оставшимся находкам круга (Phase 4, итерация 3). Project Review — без Codex. Docs-PR аудита сессии (tech-lead Phase 5) — без Codex и без reviewer'а (#769).
- **Лимит Codex исчерпан — пропуск без вопросов.** Ошибка usage limit (или лимит, уже видимый в preflight) — не ждать сброса, не делать вторую попытку и не спрашивать владельца: чекпоинт пропускается, в ревью/PR пишется строка пропуска (тексты — `.claude/skills/reviewer/SKILL.md` → Step 6-pre, п. 4), мерж-вопрос идёт как обычно и упоминает пропуск; кто публикует ready-to-merge — reviewer Step 6b и tech-lead → Merge relay. Правило действует до сброса лимита: следующий финальный чекпоинт после сброса снова запускает Codex. Прочие сбои Codex (не готов, таймаут, ошибка) — прежняя политика: 2 попытки, затем вопрос владельцу.
- **PR сессии менеджера — без Codex совсем** — `.claude/skills/manager/SKILL.md` → Правила ночи → «Codex ночью не запускается».

**Short sessions.** Одна сессия tech-lead — на задачу или волну задач; после мержей и записи аудита сессии (tech-lead Phase 5 — она идёт и перед предложением новой сессии) работа продолжается в новой сессии, а не в той же. Сессия постановки задач — тоже не марафон. Когда сессия длиннее суток или после трёх смерженных задач, tech-lead предлагает владельцу начать новую.

### Phases run as spawned agents

Every phase is an `Agent` spawn with an explicit `model` (Models by role below): architect `fable` for a first plan and `opus` for every Plan Update, implementer and reviewer `opus`, `subagent_type: "general-purpose"`. The spawn's `model` is what sets the phase's model; a skill's frontmatter does not survive a `Skill()` call inside one turn (#42). Never ask the owner to switch `/model` between phases.

Spawn prompt — every phase gets these, in this order:
1. Role and issue: "You are the <ROLE> phase for GitHub issue #<N> (ChaoticMelnik/binarius, working dir <path>)."
2. "First action: `Skill(skill: \"<role>\")`, then follow it."
3. "You have no `AskUserQuestion`. A clarify question is asked only on a real fork the issue and the plan leave open — no minimum (`.claude/CLAUDE.md` → Фазы и вопросы владельцу), none on a topic with a standing answer there; each with 2-4 options, the recommended one first, in Russian. With questions: return them in your final message and stop, making no edits — you will be continued with the answers. With none: write «развилок нет» in your hand-off and go straight on to the plan / the implementation in this same run."
4. Node: `eval "$(fnm env)" && fnm use`. Code search: CodeGraph first for every structural question, grep only for what it cannot answer (`.claude/CLAUDE.md` → CodeGraph).
5. What to return: the role's own hand-off (plan comment URL / PR URL and commit list / review verdict with merge request) plus deviations and anything unfinished.
6. For an architect Plan Update: the review round it follows.
7. For a reviewer: the PR number, the review round (1-3), and the Codex usage limit preflight saw — `until <ДД.ММ HH:MM> (job <id>)` or `none`.

**Clarify relay.** Architect and implementer start with a clarify round only when they have a question (`.claude/CLAUDE.md` → Фазы и вопросы владельцу): the agent returns its questions and stops; with none it writes «развилок нет» in its hand-off and continues on its own. Tech-lead asks them in one `AskUserQuestion` call (at most 4 questions per call — the rest go in a second call, never replaced by the recommended default — #284), passing every option through unchanged, then continues the same agent with `SendMessage` carrying the answers (a fresh spawn with the answers in its prompt if the agent is gone). A question the agent marks as a plan defect goes to the architect for a Plan Update, not to the owner — and so does one whose text says the plan contradicts itself, even when the agent offers options (#590). Tech-lead's own clarify questions (Phase 0, merge, change of approach) follow the phases' rule: an option that depends on a tool or API capability is verified by a safe read-only probe before it is asked, and the action it proposes (a merge above all) is never performed before the answer (architect Step 5, implementer Step 0).

**The main context runs no tests** (`.claude/CLAUDE.md` → Проверки, #511). Tech-lead does not run `pnpm check`, `pnpm test`/`typecheck`/`lint`, vitest, `tooling/mutations.ts` or a per-commit check; it reads the phases' hand-offs and `gh pr checks`. Where a rule needs a run (any rebase of a pushed branch — «A rebase of a pushed branch»), it goes to one implementer spawn (`model: "opus"`) with that narrow task. Not test runs, and done here: `pnpm db:migrate` of the shared database after a merge (Step 7), the Codex 6-pre runs and the whole-feature check, and `git range-diff` on doubt about a rebase-only verdict («A rebase of a pushed branch»).

**Failed or stalled phase.** When a phase agent fails or stalls (e.g. the stream watchdog), first make sure it has ended — its task notification reports `completed` or `failed`; if it is still running, stop it (`TaskStop`) or continue it, never run a second agent beside it, since a live agent can still post after the check. Then check on GitHub what it already did — issue comments, Pipeline Status, pushed commits, PR state — against what it was supposed to return. Only the missing part is redone: continue the agent, or spawn a fresh one with the done parts named as done. A blind re-spawn duplicates a posted plan or a status change (#56).

**Continuing a phase after a model limit.** A phase stopped by a usage limit (its transcript's last model is `<synthetic>`) and continued after the reset — `SendMessage`, or a fresh spawn with the done parts named — gets its remaining steps in its skill's order, never reordered to save the work first: for an implementer, every unpushed commit but the head gets its per-commit check and the head the full `pnpm check` (implementer Step 5) before the push — «check the commits, then push», never «push first». The continuation names the commits seen in the worktree and which of them are already checked (#537).

**Merge relay.** The reviewer never merges when spawned; it returns its verdict and a merge request (PR, approved head, the id of the 6-pre Codex job or its skip line, the ready-to-merge comment URL or the classifier's refusal, checks, allowed methods). Tech-lead asks via `AskUserQuestion` immediately before this specific merge, runs `gh pr merge <N>` with the chosen allowed method only on an explicit yes — never `--admin` or another bypass — and then confirms `gh pr view <N> --json state,mergedAt` shows `MERGED`. With `--delete-branch`, every worktree holding the PR's branch is removed first (`git worktree list --porcelain` — the implementer's `impl-<N>`, a night's `audit-*`): `gh` deletes the local branch before the remote one and stops when a worktree holds it, so the PR merges and the remote branch stays (#724). After the merge, a closed `mut/<N>-*` branch of the PR's CI mutations (implementer Step 5) is deleted too (`git push origin --delete <branch>`) — by day and when merging a `/manager` session's PR (#75). After a Codex skip the reviewer posts the ready-to-merge comment with the skip line itself (reviewer Step 6b). When it returns that the permission classifier refused the comment (#258), tech-lead posts the returned body from the main context. After the owner's explicit skip by day (Timeout policy), tech-lead continues the reviewer with the answer, and the reviewer posts the ready-to-merge comment with the owner's skip line (reviewer Step 6-pre item 4); on a classifier refusal, tech-lead posts the returned body. The merge question names the skip, or the Codex job, and the open Minors. A failed merge (conflicts, red checks, branch protection) is reported and stops; never a bypass.

**Merge method** (standing answer, #388 — not asked). Rebase с удалением ветки (`gh pr merge <N> --rebase --delete-branch`). Исключение — база стека (на её ветку открыт другой PR): сначала зависимые PR переводятся на `main`, база мержится `--rebase` без `--delete-branch`, ветка удаляется после ребейза зависимых, когда на неё не смотрит ни один открытый PR — иначе GitHub закрывает зависимые PR (порядок — «A PR left In Review by a manager session», шаг 1). Исключение — красный коммит в уже запушенной истории: squash (`.claude/CLAUDE.md` → Git; implementer Step 5); вопрос о мерже это называет. Подтверждение перед каждым мержем остаётся, но вопрос — только «мержить?», без выбора способа.

**A rebase of a pushed branch.** Every rebase of a branch that is already in `origin` is a rebase-only task of one implementer spawn (`model: "opus"`, implementer → Fixing Review Findings → Step 5, «A rebase-only task»), never a plain `git rebase` in tech-lead's context (#769). That covers both targets:
- onto `main`: «Mergeability right before the merge», Mode 1 Step 3 after the parent merged, Phase 2 when the chain base merged, Phase 3 for a stacked PR whose base merged, and «A PR left In Review by a manager session», step 1 (`rebase --onto origin/main <old base head>`);
- onto a stack base: Mode 1 Step 3 while the parent moves.

The spawn records the conflict hunks at the rebase's stops, runs Step 5's checks and pushes with `--force-with-lease`. When the branch has an open PR, it also posts one comment (the hunks, `old-head` / `new-head`, the `git range-diff` output, the verdict with the commits it marks) and adds the line «range-diff: только конфликты, <link>» or «range-diff: изменения сверх конфликтов, <link>» to the PR body. A branch with no PR has no evidence yet and gets neither.

The criterion is the implementer's: only the conflict hunks changed → «только конфликты»; any other `+`/`-` change, even in a conflicting file, → «сверх конфликтов». Tech-lead re-checks it only on doubt (its own `git fetch origin <old-head>` — the SHA from the comment; a force-pushed head stays fetchable — then, in the main checkout with no checkout, `git range-diff --no-color --creation-factor=100 <old-base>..<old-head> <new-base>..<new-head>`: `<old-base>` is what the branch sat on — `git merge-base <old-head> origin/main` for a branch that sat on `main`, the old base head the comment names for a stacked one — and `<new-base>` is what the rebase went onto — `origin/main`, or the new base head the comment names for a rebase onto a parent still open, after `git fetch origin <new base head>`. With `origin/main` as the new range under an open parent, the parent's own commits appear as `>` rows and every stack rebase reads «сверх конфликтов» (#782).)

A later rebase adds a new comment whose `old-head` is the previous comment's `new-head`, and a new line in the PR body; the earlier lines stay. **Each piece of evidence has its own anchor** — the head it was taken at, which it names itself: the mutation table its `head=`, the CI-only `mut/<N>-*` runs the feature head their branch was cut from, the Codex final pass the `head=` of its marker, the LGTM and the round-3 verdict the head in the ready-to-merge comment or the review heading. An anchor still covers `headRefOid` when it is the `old-head` of a range-diff comment and from that comment on the chain is unbroken «только конфликты»: each `old-head` the previous comment's `new-head`, the last `new-head` equal to `headRefOid`. Evidence whose anchor is off that chain is re-taken as the list below says — a «сверх конфликтов» link ends every chain through it, and the cascade's new table, pass and run are anchored at its new head. Commits pushed between two rebases (a fix round) are not a defect: they start new chains, the round's own table, pass and verdict are anchored at the round's head, and the older evidence they replaced is not checked. One anchor for all evidence named the wrong head whenever evidence was taken between two rebases (#782).

What the verdict redoes depends on whether the PR already has an approving verdict (LGTM, Minor-only, or a round-3 verdict):
- «только конфликты»: nothing is re-taken. CI must be green at the new head — or «no checks» on a PR of paths CI skips only (`.claude/CLAUDE.md` → Проверки, #646).
- «сверх конфликтов», before an approving verdict: the same implementer re-takes the mutation table at the new head in one call of `tooling/mutations.ts` and re-cuts the CI-only `mut/<N>-*` runs (implementer Step 5); the next review round reviews the whole feature. CI is green.
- «сверх конфликтов», after an approving verdict: the same re-take, then three more steps.
  - A short reviewer spawn (`model: "opus"`) on what the comment marks, and only that: the inner diff of each `!` pair with a change outside its conflict hunks, and `git show` of each `>` commit. Its Blocker/Major are handled as a round's (Phase 4); on a PR whose three rounds are used, the pass is a check, not a round, and a Blocker/Major goes to the Phase 4 iteration 3 branches.
  - Tech-lead's own 6-pre run at the new head (Phase 4; none for a `/manager` session's PR), its "Known, moved open into a follow-up issue" field filled with the findings the owner already moved to the Backlog issue (#637).
  - Green CI.

  The merge question names the pass and the run.

After a rebase of an approved PR, the merge question is asked again for the new head and names the line; an earlier yes does not carry over.

**Mergeability right before the merge.** After the yes and immediately before `gh pr merge`, re-check `gh pr view <N> --json mergeable,headRefOid` (`UNKNOWN` → read it again): a neighbour can merge during the review (#152). `CONFLICTING` → no merge: «A rebase of a pushed branch» above, then the merge question again.

### Models by role

Механизм — #56. Требование владельца: самая мощная модель — на архитектуре; остальные роли распределены по стоимости, потому что связывающее ограничение темпа — недельный кап Fable, а не Opus.

| Роль / агент | Модель (алиас → id) | Где задано |
|---|---|---|
| `/tech-lead` (оркестрация, clarify- и merge-relay) | модель сессии | главный контекст; frontmatter `model: inherit` |
| `/clarify` | вопросы готовит фаза на своей модели, задаёт tech-lead | implementer Step 0, architect Step 5 |
| `/architect` — первичный план | `fable` → `claude-fable-5-1` (Claude Fable 5.1), самая мощная | параметр `model` Agent-спавна tech-lead'а |
| `/architect` — Plan Update (после ревью, сверка устаревшего плана, дефекты плана от implementer'а) | `opus` → `claude-opus-5-5` (экономия лимита Fable) | параметр `model` Agent-спавна tech-lead'а |
| `/implementer` | `opus` → `claude-opus-5-5` | параметр `model` Agent-спавна tech-lead'а |
| `/reviewer` (оркестрация, консолидация, ручной чеклист) | `opus` → `claude-opus-5-5` | параметр `model` Agent-спавна tech-lead'а |
| субагенты `/code-review high`, `/security-review` | `opus` → `claude-opus-5-5` | параметр `model` вложенного спавна, reviewer Step 3c / 3b |
| субагент `/simplify` (report-only, без вложенных агентов) | `sonnet` → `claude-sonnet-5-5` | параметр `model` вложенного спавна, reviewer Step 3d |
| Codex — финальный whole-feature pass перед мержем | `gpt-5.6-sol`, reasoning `high` | явные `--model gpt-5.6-sol --effort high` в каждом `task`-вызове companion-скрипта (reviewer Step 6-pre и свой 6-pre tech-lead'а); `~/.codex/config.toml` — только fallback для ручных запусков владельца; `review`/`adversarial-review` в pipeline не используются (нет `--effort`, не читают шаблон промпта); `codex:rescue` не используется |

Механизм (сверки по транскриптам с их id — `docs/process-decisions.md` → «tech-lead → Models by role»):
- Модель фазы задаёт параметр `model` Agent-спавна.
- id в таблице — запись последней сверки, а не гарантия; при аудите модели сравнивается то, что фактически в транскрипте, и расхождение с таблицей — повод обновить таблицу, а не считать прогон нарушением.
- `model:` во frontmatter скилла действует только при прямом вызове скилла владельцем: при `Skill()` внутри хода tech-lead'а модель не переключается (#42). Поэтому фазы — спавны, а не `Skill()`-вызовы в главном контексте.
- Модель сессии фазы не задаёт: требование «сессия остаётся на Fable» снято. Промпт владельца посреди фазы попадает в главный контекст, а не в уже работающий спавн, и модель архитектора не понижает.
- Агент не может сам сменить модель сессии (`/model` — только владелец). Менять карту моделей = править параметры спавнов в скиллах и эту таблицу.
- `effort` у спавнов не задаётся — действует `effortLevel` сессии (`xhigh`).
- Если организация запретила модель через `availableModels`, Claude Code может молча оставить другую — поэтому фактическая модель проверяется по транскрипту — только по запросу владельца или при подозрении на подмену модели (#769), не на каждую задачу: Mode 1 → Model policy — check (`resolvedModel` спавна для глубины 1, `subagents/*.meta.json` + транскрипт агента для любой глубины). id сравниваются до первой `[`: `resolvedModel` может нести суффикс варианта контекстного окна (#56).

---

## Mode 1: Monitoring

### When to invoke

At the end of a session, for its `audits.md` entry (Mode 2 → Phase 5), or when the owner asks for a process audit. The checklists below are the catalogue of deviations: tech-lead applies them to the phases' hand-offs and to GitHub as each task passes, and the entry records only what deviated, never the steps that passed (#769). Nothing is posted per task.

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
- [ ] Mutation evidence is one PR comment with the table of `tooling/mutations.ts` (header `head=` equals the PR's final head — or the table's own anchor: a head from which an unbroken chain of «только конфликты» rebase comments leads to the final head, the PR body carrying their lines («A rebase of a pushed branch»); `list-sha256=` matches the list in its `<details>` block); the hand-off names one full `pnpm check` at the final head

### Reviewer step — check

- [ ] Review comments are specific and actionable, not vague
- [ ] Blockers/Majors were noted before any approval
- [ ] Codex ran only where reviewer Step 6-pre and tech-lead's own 6-pre run say. The last completed run's marker `head=` is the merged head — or the run's own anchor: a head from which an unbroken chain of «только конфликты» rebase comments leads to the merged head («A rebase of a pushed branch») — or a skip line is accepted ("Whole-feature pass — check", by kind).
- [ ] If a Blocker/Major was found: reviewer returned the issue to **Todo** before any re-implementation started; a Minor-only review did not
- [ ] If clean: the ready-to-merge comment is posted (by the reviewer, or by the spawner after a classifier refusal), names the approved head, carries the skip line when Codex was skipped, and the reviewer did not self-approve
- [ ] Every review round reviewed `gh pr diff` (the whole feature), never an iteration delta
- [ ] CI (`gh pr checks`) was green on the merged head (a PR of paths CI skips only has none — `.claude/CLAUDE.md` → Проверки, #646) — `pnpm check` there carries the automated gates (manifest targets, status literals, constraint coverage); the reviewer's Runtime check took it from CI, not from a local `pnpm check`
- [ ] Neither tech-lead nor `/manager` ran a test (`pnpm check`/`test`/`typecheck`/`lint`, vitest, mutations, a per-commit check) in the main context ("Phases run as spawned agents" → «The main context runs no tests»)

### Whole-feature pass — check

The reviewer's final Codex pass (Step 6-pre, `Whole-feature pass` marker) covered exactly the approved diff. A skip line instead of a run (in the review, the ready-to-merge comment, or tech-lead's PR comment from its own 6-pre run; texts in reviewer Step 6-pre item 4), by kind:
- **Usage limit:** `node "$COMPANION" status <id> --json | jq -r '.job.status, .job.summary, (.job.progressPreview // [] | .[])'` prints `failed` and a summary or a `progressPreview` line matching `hit your usage limit` — the text can sit only in `progressPreview` while the summary holds Codex's first message (#668). If `status` answers "No job found" (the job was started from a review worktree that is gone, and jobs are keyed by working directory): `jq -r --arg id <id> '.jobs[]? | select(.id == $id) | .status, .summary' ~/.claude/plugins/data/codex-openai-codex/state/*/state.json`.
- **The owner's skip** (by day, or after the failures of tech-lead's own 6-pre run): recorded as an owner-approved deviation, not a Major; its source is the `AskUserQuestion` answer in this session.
- **A PR of a `/manager` session:** the manager line is the rule (`.claude/skills/manager/SKILL.md` → Правила ночи → «Codex ночью не запускается»), not a deviation; no run to check.
- **A Phase 5 session audit docs PR** (`docs/audit-*`): no run and no skip line by rule (Overview → Codex, #769); not a deviation.

Anything else is a Major audit finding. Otherwise check the run by its job id — the one in the reviewer's merge request, or tech-lead's own 6-pre run:

```bash
COMPANION="$(jq -r '.plugins["codex@openai-codex"][0].installPath' ~/.claude/plugins/installed_plugins.json)/scripts/codex-companion.mjs"
jq -r --arg id <job-id> '.jobs[]? | select(.id == $id) | .status, (.request.prompt | split("\n")[0])' ~/.claude/plugins/data/codex-openai-codex/state/*/state.json
# completed
# Whole-feature pass #<PR>: base=<b> head=<h> diff-sha256=<x>
```

The query reads every workspace's `state.json`, so it works from any directory and any session (`status <id> --json` answers "No job found" outside the job's working directory). `<h>` is the merged head (`gh pr view <N> --json headRefOid`), or the run's own anchor — a head from which an unbroken chain of «только конфликты» rebase comments leads to the merged head («A rebase of a pushed branch»). No output, a status other than `completed`, no marker, another head, or another base is a Major audit finding. The base is checked without a hash: `git cat-file -e <h> || git fetch origin <h>`, then `git merge-base <h> origin/main` prints `<b>` — a rebase or squash merge writes new commits, so the fork point stays, and `<b>..<h>` is the diff `gh pr diff` showed.

### Audit proposals — check

- [ ] Every proposal of the previous audit entry in `audits.md` carries a status (Phase 5 format)

### Model policy — check

Run only on the owner's request or on a suspicion of a substituted model — a hand-off that names a model other than the spawn's alias, or none, while the work looks like another model's; a phase visibly cheaper or faster than its model; a task notification whose `resolvedModel` differs from the alias (#769). It is not part of the session entry otherwise.

Each phase's spawn requested its policy model and ran on it. Every spawn, at any depth, leaves `subagents/agent-<agentId>.meta.json` (`model` = requested alias, `description`, `spawnDepth`, `toolUseId`, `parentAgentId`). The model the harness assigned (`resolvedModel`) is stored only in the root transcript, on the spawn's `tool_result`, and only for depth 1 once a result came back (`completed` or `async_launched`). The agent's own transcript names the model it actually ran on:

```bash
tooling/model-policy-check.sh <session-id>   # one line per spawn: description | depth | requested | resolved | ran
```

Usage, output columns and an example (#56) — the script header.

Per row, comparing ids up to the first `[` (`[1m]` names the context-window variant, not a different model):
- (a) `requested` is the policy alias for that phase or sub-tool;
- (b) when `resolved` is an id, it is that alias's id in Models by role;
- (c) `ran` is exactly one id, and it is the table's id for the requested alias. `<synthetic>` is not a model: it is the harness's placeholder on an API error message (a usage limit, a 429). Drop it before judging (c), and record what the row shows instead: the agent died, and whether it had posted anything (#132, #136, #138, #236).

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
- Each dependent branch rebases onto its parent, not onto `main` — once pushed, as a rebase-only task («A rebase of a pushed branch»).
- When A merges into `main`, B gets a rebase-only task onto the updated `main` immediately («A rebase of a pushed branch»).
- If B's PR targets A's branch, retarget it to `main` before A merges and merge A without `--delete-branch`: Mode 2 → "A PR left In Review by a manager session", step 1.

### Step 4: Announce the merge order

Post as a comment on each affected issue/PR, or directly to the user:

```
## Merge Order Notice

1. #A (feat/A-description) — base; merge first
   Shared files: ...

2. #B (feat/B-description) — depends on #A
   Branch from: feat/A-description (not main)
   Action required: a rebase-only task onto main after #A merges
```

### Step 5: Block out-of-order merges

If a PR is about to be merged out of the declared order: comment on the PR that it must wait, and do not approve it.

### Step 6: Update the chain when issues change

Re-run the conflict check whenever: a new issue enters In Progress, a PR is merged, or an issue's file scope changes (the Architect updates the plan).

### Step 7: Parallel implementers on one machine

Several implementers or reviewers at once (#177, #192, #103, #166) share the host, the dev databases and the session scratchpad. Each spawn prompt states:
- **Own worktree**, created by the agent itself with `git worktree add .claude/worktrees/impl-<N> -b <branch> <base>` (`<base>` — `origin/main` or a declared stack's base branch, implementer Step 2) and `git worktree lock` — an `isolation: "worktree"` spawn's tree is removed when its clarify round ends unchanged. The main checkout belongs to one agent at a time. Tech-lead unlocks and removes the worktree after the merge. A worktree has no `TEST_DATABASE_URL`/`REDIS_URL` (the main `.env` holds neither): the spawn prompt names the README values, `postgres://binarius@127.0.0.1:5434/binarius` and `redis://localhost:6379` (#511). Exception — a worktree-isolated session (tech-lead itself runs inside `.claude/worktrees/<name>`): the harness lets its agents write only in that one worktree (an `EnterWorktree` into another one is refused), so implementers and reviewers run one at a time in the session's worktree, and extra worktrees are useful only to read-only architects (#241, #78, #79, #300, #358).
- **Manager worktrees** (`impl-<N>`, `review-*`, `audit-<date>` of a `/manager` night) are left in place after the night; tech-lead removes them after the merge like its own.
- **Own scratch subdirectory** (`<scratchpad>/impl-<N>/`, `review-<N>/`, `arch-<N>/`, `rebase-<N>/`): parallel agents overwrite each other's scripts and plans in a shared directory (#125, #126). The rule covers the short spawns of a merge relay too — a rebase-only implementer, a rebase-check reviewer (#720, #729).
- **Sub-skills pointed explicitly** at `gh pr diff <N>` and the worktree: `/security-review` and `/code-review` load the main checkout's diff by default. A brief alone did not hold (#97, #85): the spawn prompt hands them the diff saved as a file in the reviewer's scratch dir plus the review worktree path, and forbids `git checkout`/`switch` in the main checkout.
- **Shared-resource window**: before a full `pnpm check`, a VM/host change or a long series, `ps -axo pid,comm,args | awk '($2 ~ /(^|\/)node$/ && /vitest|db-clock-probe/) || ($2 ~ /(^|\/)bash$/ && $4 ~ /check-stability\.sh$/)'` must show no foreign run, and the guard stops the command on a hit (non-zero exit or a wait loop), not only prints it (#97, #85); tech-lead serialises anything that restarts shared services ("GO" only when the others are idle). The guard matches the process name, not the command text: `pgrep -f 'vitest'` (even `'[n]ode .*vitest'`) also matches the shell whose own command line holds the pattern, so its wait loop never clears (#134, #17).
- **At most two reviewers at once**: each spawns three opus/sonnet sub-agents, and three parallel reviews (#119, #185, #104) exhausted the session limit together before any of them posted; a dead reviewer is re-spawned only after GitHub shows it posted nothing.
- **At most three Opus phase agents at once** across implementers and reviewers: five at once (#134, #99, #133, #19, #17) hit the session limit together and stopped mid-step; the rest wait in tech-lead's queue.
- **Fresh review worktree path per round**: a removed review worktree leaves its Codex broker attached to the path, and a later round that recreates the same path fails Codex on the first attempt (#99). The reviewer names it `review-<PR>-r<round>-<epoch>` and runs `codex status` from that worktree — jobs are keyed by working directory.
- **No shared Telegram token**: a runtime check that starts `bot` or `backend` (the staff bot polls inside `backend`) runs with dummy `TELEGRAM_BOT_TOKEN`/`ADMIN_BOT_TOKEN` unless the check itself needs Telegram, and never with a token another poller uses. Two pollers on one token end each other with 409, and the loser's container stays "running" (#136). The local `.env` has its own dev bots, but parallel agents would still share those.
- **A plan's stand check is not forbidden by parallelism**: a spawn prompt does not ban starting services wholesale; when the plan runs a documented procedure on the local stack, the prompt names where (own worktree, own database, dev bots under the rule above, PIDs, loopback only — the backend binds `0.0.0.0` with no host setting, so a dev branch's stand is kept on `127.0.0.1` by a preload in the scratch dir, #405) and when (before or after the PR) (#391, #405).
- **Unmerged migrations stay off the shared test database**: an implementer whose branch adds a migration points `TEST_DATABASE_URL` at a database of its own (`createdb -h 127.0.0.1 -p 5434 -U binarius binarius_impl_<N>`, then `DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate`) and drops it after the merge. The shared `binarius` database gets only migrations that are on `main` — and gets them: after merging a PR that adds a migration, tech-lead runs `DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate` (a migration, not a test run) from the updated main checkout once the guard above is clear, or every `pnpm check` on a fresh `main` fails `schema.db.test.ts` (#17, #89) — and nobody drops tables or edits `drizzle.__drizzle_migrations` there by hand (#235).
- **Long data jobs outlive no phase**: a phase agent's background job (a multi-hour `fetch`, a full backtest) dies with the agent (#381). A job longer than ~15 min is started by tech-lead as its own background task; the phase returns the command, the env and the log path instead of waiting on it.
- **Stop only your own processes, by PID**: an agent records the PID of every process it starts and stops exactly those (`kill <pid>`); never `pkill -f`/`killall` by a command-line pattern, which matches every session's `tsx src/index.ts` alike (#396).

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

Before the session's first issue, record its start for the audit header (Phase 5): `TZ=Europe/Moscow date '+%Y-%m-%d %H:%M'`.

Phase 0 runs once, before the session's first issue (#769). For every later issue of the session only the git block above is repeated — it reports the tree's state and decides nothing else; the preflight items below are not re-run, except item 6, which precedes every Fable spawn, and the task-dependent halves of items 2 and 4, which run before each implementer spawn whose plan touches them (#769). `/manager` runs it once per night the same way (manager → Phase 0 step 2).

**Preflight checks (mandatory, same phase):**

1. **Codex** — `node "$COMPANION" setup --json` (companion path as in "Whole-feature pass — check"): `ready`, `auth.loggedIn`. Not ready → `Skill(skill: "codex:setup")` once; still not ready → STOP and ask the owner. Then the budget: `node "$COMPANION" status --all --json` — a recent job whose summary or `progressPreview` matches `hit your usage limit` (reviewer Step 6-pre item 4) does not stop or delay the pipeline: record `until <ДД.ММ HH:MM> (job <id>)` for the reviewer's spawn-prompt item 7 (the rule: Overview → Codex). An issue needs one run per review round that reaches 6-pre (at most 3), plus one per tech-lead's own 6-pre run, which repeats after a rebase of an approved PR with «сверх конфликтов» («A rebase of a pushed branch»).
2. **GitHub** — `gh auth status`; if stale, ask the owner to `gh auth login` / refresh. If the plan's files include `.github/workflows/*` (checked per task, before the implementer spawn): the token needs the `workflow` scope, or `origin` must be an SSH remote (`git remote -v`) — otherwise the push fails at the end of implementation.
3. **Project CLAUDE.md on main** — `git diff origin/main -- .claude/CLAUDE.md` must be empty: the harness loads whatever is checked out, and a waiver living only on an unmerged branch was once acted on for a day.
4. **Runtimes** — every runtime the acceptance criteria exercise is available locally at CI's version: Node from `.node-version` (`eval "$(fnm env)" && fnm use`), Postgres/Redis (`docker compose ps`), Docker/Compose/buildx if the issue touches images or compose (checked per task, before the implementer spawn); CLI plugins match what CI uses.
5. **Previous audit** — every proposal of the latest `audits.md` entry has a status (Phase 5 format). An unmarked proposal, or `открыто` without a date and owner, is reported to the owner as a warning before the pipeline starts; it does not stop the pipeline. Two more warnings, reported the same way and stopping nothing; Phase 5 records both (item 2a; #769):
   (a) a manager session that ended without its docs PR — its process is over (an archived `state-<start>.json`; or `state.json` with `ended` set, or failing manager Phase 0 step 1's RUNNING test), it started after PR #777 merged, it has no `audit_pr`, and no `## Сессия <its session> — manager` header is in `audits.md` on `origin/main` or in an open `docs/audit-*` PR;
   (b) a PR merged after PR #777, not on a `docs/audit-*` or `docs/<N>-audit` branch, that no `audits.md` on `origin/main` and no open `docs/audit-*` PR names as `#<number>`.

   One run prints both, one line per finding (`LOST NIGHT: <session> (<file>)`, `UNRECORDED PR #<n>`):
   ```bash
   tooling/audit-gaps.sh
   ```
6. **Model limits** — before a Fable spawn: если за последние 7 дней в транскриптах проекта был отказ лимита Fable (`find ~/.claude/projects/-Users-user-Documents-Binarius -name '*.jsonl' -mtime -7 -print0 | xargs -0 jq -r 'select(.message.model? == "<synthetic>") | select([.message.content[]? | select(.type == "text") | .text] | join(" ") | test("Fable limit")) | .timestamp' 2>/dev/null | sort | tail -1` печатает время последнего отказа; простой `grep` по тексту отказа совпадает с этой строкой, загруженной в каждую сессию, и печатает что-то всегда, #511) и владелец не сообщил о сбросе — первичный план сразу на `opus` со строкой «план на Opus (лимит Fable <дата>)», без попытки на Fable и без вопроса. Не больше трёх Opus-фаз одновременно (Step 7).

**Timeout policy (every checkpoint):** usage limit — Overview → Codex. Any other failure: at most 2 attempts per Codex run; after the second, stop and ask the owner — no third attempt by default. The owner may choose to skip a checkpoint only by an explicit answer; the line is the owner's skip line (reviewer Step 6-pre item 4).

#### Phase 1 — Architect

Spawn the architect (`Agent`, `model: "fable"` — or `opus` under preflight item 6 — prompt per "Phases run as spawned agents"). Round 1 returns clarify questions, if the agent has any, → clarify relay → the same agent drafts the plan and posts it (no Codex — planning has none); with no question the agent posts the plan in that same run (spawn item 3). Never perform architect steps inline, regardless of how small the issue looks.

If this repo's CLAUDE.md has waived the commit/PR stop points: no text between phases — spawn the implementer next. If not waived: report the plan to the owner and follow whatever stop behavior the unwaived pipeline default implies before continuing.

#### Phase 2 — Implementer

Before the spawn, a plan more than a day old or written by another session is checked against `main`: `git log --oneline <plan's base sha>..origin/main -- <files the plan names>`. Any output → the architect writes a round-0 Plan Update first (#396, #397). When the issue already has an open PR, the spawn prompt states its review rounds counted by the `## Review round` headings of its reviews and comments (reviewer Step 6-pre) — an empty `gh pr view --json reviews` is not «no review» (#123).

Before the spawn, the task-dependent halves of preflight items 2 and 4 (Phase 0), when the plan's files touch them. Spawn the implementer (`Agent`, `model: "opus"`). Round 1 returns its clarify questions, if any (implementer Step 0; with none the implementer starts work in that same run), → clarify relay; plan defects among them go to the architect first (a fresh architect spawn on `opus` for the Plan Update, with the plan URL and the defects) → the implementer continues with the answers and the Plan Update. Never perform implementer steps inline.

If a merge-chain base branch (Mode 1, Step 3) has already merged into `main` since the chain was declared, the branch moves onto `main` before implementation continues — a rebase-only task once it is pushed («A rebase of a pushed branch»), otherwise in the implementer's own run — check `gh pr view <base-PR> --json state,mergedAt` first.

#### Phase 3 — Finalize

Once the PR exists and the issue is In Review: spawn the reviewer (`Agent`, `model: "opus"`) — the Tech Lead owns the full lifecycle end to end. No per-task audit comment is posted (#769): deviations go into the session's entry (Phase 5). A PR stacked on another open PR (Mode 1 Step 3) is reviewed only after its base merges and a rebase-only task moved it onto `main` («A rebase of a pushed branch») — until then `gh pr diff` also shows the base's commits (#252).

#### Phase 4 — Review findings loop

Track the iteration count (starts at 1 for the first review). **Hard limit: 3 review rounds per issue** — there is no round 4. An issue split by size into several PRs (architect Step 4a, or the implementer at the fallback line) counts its rounds per PR: each PR has its own limit of 3 (#666).

Only a Blocker or Major counts as "finds issues" and returns the issue to Todo (reviewer → Severity Guide). A Minor-only verdict goes to the merge relay below as a clean PR; the merge question names the open Minors, and the owner decides whether they are fixed in another round first. Minors still open at the merge go, without a question, into one new Backlog issue (`/github`: "Create an issue" + "Add issue to Project #2", body with `Refs #<N>`, the PR link and each finding with severity and comment link); its number goes into the report (standing answer, #388).

**If the reviewer finds a Blocker or Major:**
1. Iteration 1 → the architect first (Plan Update on `opus`; the issue returns to In Progress), then the implementer, then the reviewer again for this issue. The fix round's implementer is a **fresh spawn**, not a `SendMessage` continuation of the first one: its prompt carries the PR, the review comment URLs, the Plan Update URL, the branch and the worktree, and it reads them anew — a continued implementer drags its whole first-round context into every call.
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
It posted the ready-to-merge comment or returned the classifier's refusal (Merge relay), and returned a merge request. Merge relay: `AskUserQuestion` immediately before this merge, `gh pr merge` only on an explicit yes, then confirm `state == "MERGED"`. **Do not move the issue to Done before that** — a clean review isn't merged work. Then move the issue to **Done** via `/github` skill; Phase 5 runs on its triggers (Phase 5).

**Tech-lead's own 6-pre run** (Phase 4 iteration 3 after a round-3 Blocker fix; a rebase of an approved PR whose range-diff verdict is «сверх конфликтов» — «A rebase of a pushed branch» under Phases run as spawned agents; never for a `/manager` session's PR, «A PR left In Review by a manager session» step 2). Not a review round.
1. `gh pr checks <N>` at the current head: wait while running. Red → report it to the owner; no run, no merge question.
2. The reviewer's Step 6-pre command, from the main context, at the current head. The prompt's "Known, moved open into a follow-up issue" field (`.claude/codex-review-prompt.md`) lists only the findings the owner has already moved, open, into a follow-up issue (the round-limit issue or a Backlog issue), so a re-run on a moved head reports only what is new; a finding this PR fixed is never on that list — the pass must still see an incomplete fix (#536).
3. Outcome:
   - Clean → the job id goes into the merge question.
   - Blocker/Major → post it as a PR comment. On a PR whose last review round was 3, go to the Phase 4 iteration 3 branches (a Blocker holds the merge; a Major goes into the new issue on the owner's yes). Otherwise the owner decides via `AskUserQuestion`: a Plan Update round (the count continues) or close the PR.
   - Usage limit → tech-lead posts the usage-limit skip line (reviewer Step 6-pre item 4) as a PR comment, and the merge question names it.
   - Any other failure → 2 attempts, then `AskUserQuestion` «Codex: запустить позже / мержить без него». On the second answer, tech-lead posts the owner's skip line as a PR comment.

**A PR left In Review by a manager session.** Start from the night's report: the reviewer's verdict and the checks are recorded there, and the night's `audits.md` entry waits in its docs PR `docs/audit-<date>` (manager → Substitution 5) — merged last, with the usual merge question; the next session's own entry records only its own work — unless the night left no docs PR (Phase 0 item 5 (a)): then Phase 5 item 2a writes the night's entry. In this order:
1. **A stacked PR** (its base is another open PR, «Merge after #<base>»). Deleting the base branch on the base's merge (`--delete-branch`) makes GitHub **close** every PR that targets it, not retarget it (#437, #439). In this order:
   - before the base's merge, retarget every dependent: `gh pr list --base <base branch> --json number --jq '.[].number'`, then `gh pr edit <dep> --base main` for each;
   - merge the base with `--rebase` and **without** `--delete-branch` — the one exception to the standing merge method; the merge question says so;
   - on each dependent, an implementer "rebase only" spawn (`model: "opus"`, implementer → Fixing Review Findings → Step 5) does: `git -c core.commentChar=';' -c merge.conflictStyle=diff3 rebase --onto origin/main <old base head>`; before the push, implementer Step 5's checks on the rewritten commits — the per-commit check on each but the head, the full `pnpm check` at the head — a commit that fails is reworked before the push; when the rework would need more than the rebase, the branch is pushed as is and the spawn reports it, the PR is squash-merged so no red commit reaches `main`, and the merge question says so (#494); then `git push --force-with-lease` and the range-diff comment with its verdict (implementer → «A rebase-only task»); the mutation table is re-taken at the new head only on «сверх конфликтов» («A rebase of a pushed branch»). `gh pr view <dep> --json closingIssuesReferences` must name its issue — a PR opened on another PR's branch can lose its `Closes` link when retargeted (#441);
   - delete the base branch (`git push origin --delete <base branch>`) only when `gh pr list --base <base branch>` is empty.
2. **No Codex** (`.claude/skills/manager/SKILL.md` → Правила ночи → «Codex ночью не запускается»): no run and no question, even when step 1 moved the head; the merge question names the night's manager line (reviewer Step 6-pre item 4).
3. **The merge relay**; Phase 5 runs on its triggers (Phase 5). After any rebase onto a moved `main` — stacked or not, textually clean or not — the cascade of «A rebase of a pushed branch» for an approved PR runs before the merge question: green checks at the new head even on «только конфликты» (a clean rebase can still break CI — #446, #447), and on «сверх конфликтов» (#234, #141) the reviewer pass on what the comment marks; disclosure in the PR alone is not enough.

A PR with open Blocker/Major («Открытые находки на конец цикла задачи (3-й круг) или сессии менеджера»): the owner decides — a Plan Update round (the round count continues from the night's) or close the PR. A PR whose last round was 3 gets no further round: Phase 4 iteration 3 branches instead.

#### Phase 5 — Session audit

Tech-lead runs it itself on the first of three triggers (#769), and again on the first trigger after the owner continues the session:
- every issue the session took is merged or left to the owner In Review;
- right before it proposes a new session (Overview → «Short sessions»);
- the owner stops or ends the session.

A limit that ends the session early triggers it too, while the main context still runs. The result is one `audits.md` entry and one docs PR for the work up to that trigger (#769). Nothing is posted per task. If the owner continues in the same session afterwards, the next trigger writes a new entry for what came after, headed `## Сессия <start> — tech-lead (продолжение): …` with the same `<start>` (a third: «(продолжение 2)»); the suffix reaches no check — Phase 0 item 5 (a) and `tooling/audit-gaps.sh` key on manager headers only (#782). A session that ends without Phase 5 is caught by the next session's Phase 0 item 5 (b).

1. Sync local state:
   ```bash
   git fetch origin
   git checkout main
   git pull --rebase origin main
   ```
2. Append one entry to `audits.md` (`---` separator before it) — deviations and findings only, no recap of the steps that passed:
   ```markdown
   ## Сессия <start> — <tech-lead|manager>: #N1 (PR #P1, <k> кругов, <merged|In Review>), #N2 (…)

   ### Отклонения процесса
   | Задача | Роль | Шаг | Отклонение | Severity |
   |--------|------|-----|------------|----------|

   ### Находки ревью
   | Задача | Finding | Severity | Класс | Root cause | Missed at step |
   |--------|---------|----------|-------|------------|----------------|

   ### Предложения по процессу
   1. <proposal> — **<status>**
   ```
   `<start>` is the session's start, `YYYY-MM-DD HH:MM` Moscow time: tech-lead records it in Phase 0; the manager takes `state.json.session`. Two sessions a day are common, and Phase 0 item 5 (a) finds a night's entry by this header.

   Классы: `instance-vs-class` (исправлен экземпляр, а не класс), `unverified-claim` (утверждение не проверено исполнением), `env-parity` (проверено по локальной среде, а не по среде раннера), `codex-ops` (операционный сбой Codex), `preflight`, `single-source` (один факт в двух местах), `other`. An empty table is one line «нет». A Blocker/Major round's root cause and the step that should have caught it go into «Находки ревью», not into a separate comment. A model is named only where a hand-off named it from its own transcript (architect → How this role runs); the transcript check is not run for the entry (Mode 1 → Model policy — check).
2a. **What earlier sessions left unrecorded.** (a) A night from Phase 0 item 5 (a) gets its own entry, written by the next session of any kind — a `/manager` night too, in `audits.md` only (#769): «## Сессия <its `state.json.session`> — manager (записана <YYYY-MM-DD> сессией <tech-lead|manager>): #N1 (PR #P1, …), …», built from the night's report (`report-<date>.html`), its `state.json` and GitHub (the PRs, reviews, «Решение менеджера» comments); proposals carry the night report's «Предложения по процессу» with statuses as in item 3. (b) PRs from Phase 0 item 5 (b) that are still named nowhere at this point and were merged before this session started are added to this session's entry — a row «<PR> — не записан своей сессией» in «Отклонения процесса», and its review findings from GitHub; a duplicate with a still running parallel session's entry is accepted. Both go into this session's docs PR, and its title lists their issues too.
3. **Close the audit loop.** Every proposal ends with exactly one status:
   - `внедрено в #<PR>: <файл> → <секция>` — the skill edit goes into the same docs PR as the session entry;
   - `отклонено: <причина>` — only after the owner's explicit yes via `AskUserQuestion` (one call for all proposals up for rejection); a date of the decision goes inside the reason;
   - `вынесено в #<N>` — the issue is created and added to the board now (`/github`), not "later";
   - `открыто (<YYYY-MM-DD>, <владелец>)` — allowed, and Phase 0 of the next session warns about it.
4. **Docs PR** — branch `docs/audit-<YYYY-MM-DD>` of the session's start date from `main` — when `git ls-remote --exit-code --heads origin docs/audit-<date>` finds it taken, the first free of `-2`, `-3` …; title «audit: сессия <YYYY-MM-DD> (#N1, #N2 …)», the entry and the skill edits, PR body with `Refs #N1, #N2 …` instead of `Closes` (the issues are already Done; `.claude/CLAUDE.md` → Git). It gets no reviewer phase, no 3b-3d sub-agents and no Codex pass (#769) — process text, not code:
   - CI: a docs PR of paths CI skips only (`.claude/CLAUDE.md` → Проверки, #646) runs none — `gh pr checks` answering «no checks reported» is expected; do not wait for it. A docs PR that touches any other path waits for green CI before the merge question, as any PR.
   - The merge relay as for any PR: `AskUserQuestion` immediately before the merge; the question names the entry's proposals with their statuses.

A night's entry is written by the manager itself (manager → Substitution 5); the morning session merges that PR and records only its own work; a night that ended before its Phase 5 is written by the next session of any kind (item 2a).

---

## Project Architecture Reference

Отправная точка — `binodex-bot-implementation-plan.md`, черновой план поставщика (в репозиторий не входит): только для выбора технологий, для правил не используется:

| Компонент | Выбор | Пакет/приложение |
|---|---|---|
| Telegram-бот | Node.js + grammY (TypeScript) | `apps/bot` |
| Backend API | TypeScript + Fastify (OAuth, постбэки, авторизация, состояния) | `apps/backend` |
| Веб-страницы | Fastify + серверный HTML (вход сотрудников, касса, минимальная админка) (#68, #34) | `apps/web` |
| Торговый worker | Отдельный Node.js-процесс + Socket.IO-клиент | `apps/trading-worker` |
| БД | PostgreSQL + Drizzle ORM, forward-only миграции: `pnpm db:generate` / `pnpm db:migrate`, сервис `migrate` (#75) | `packages/db` |
| Фоновые задачи | Redis + BullMQ (уведомления, сверка, обработка событий) | использует `packages/db` |
| Общие типы/контракты | TypeScript, без раннего разделения на микросервисы | `packages/shared` |
| Тесты | Vitest (unit/integration); `packages/e2e` — демо-цикл поверх настоящих процессов, тоже Vitest (`pnpm test packages/e2e`, `docs/e2e-demo-cycle.md`) | во всех пакетах |
| Пакетный менеджер | pnpm workspaces, единый monorepo | корень репозитория |
| Развёртывание | Docker Compose + HTTPS reverse proxy (Caddy на хосте — `docs/postbacks.md` → The Caddy route) на пилотном VPS (адрес — `docs/binodex-oauth.md` → проверка с IP пилота) | backend и bot — `binarius-deploy` на хосте (`docs/bot-session.md`), worker — `scripts/deploy-worker.sh` (`docs/worker-deploy.md`) |

Доменные инварианты, подтверждённые кодом, — индекс `.claude/skills/architect/SKILL.md` → Architecture Rules to Enforce и файлы `.claude/skills/architect/rules/*.md` (единственный полный список; по файлам задачи — `node tooling/rules-for.ts <files>`). Точный контракт Binodex Broker/Partner API, бонусная сетка, лимиты сессии и параметры хостинга здесь не зафиксированы: архитектор проектирует и проверяет их для конкретного issue, а не переносит из чернового плана.

---

## Forbidden Actions (both modes)

- Never push to `main` or merge a PR without whatever confirmation this repo's CLAUDE.md currently requires.
- Never move an issue to Done without explicit confirmation that the PR was merged (`state == "MERGED"`).
- Never edit files in another agent's/developer's active domain without flagging the conflict.
- Never execute Architect, Implementer or Reviewer steps inline — always as an `Agent` spawn with the policy `model` whose first action invokes the role's Skill, even for trivial one-line issues — except the reviewer's Step 6-pre command, which tech-lead runs itself as tech-lead's own 6-pre run (Phase 4 iteration 3 after a round-3 Blocker fix, a rebase of an approved PR with «сверх конфликтов»).
- Never write text output between pipeline phases where this repo's CLAUDE.md has waived stop points — an inter-phase recap forces the user to say "continue" unnecessarily.
- Never waive a missing Codex final pass silently: a usage-limit skip is recorded with its skip line where the run would have been, any other missing pass is a process deviation, except where no pass is the rule (a `/manager` session's PR, a Phase 5 session audit docs PR).
- Any question to the owner goes through `AskUserQuestion`, never plain text — including the questions a spawned phase returns.
- Never offer "one more iteration of the same loop" at the Iteration 2 stop, and never start a 4th review round.
- Never create the round-limit issue (Phase 4, iteration 3) without the owner's yes on its title and findings.
