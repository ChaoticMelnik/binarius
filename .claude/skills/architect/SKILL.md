---
name: architect
description: Plans implementation for GitHub issues before they move to In Progress. Research the issue, explore the codebase, write a clear plan as an issue comment, then move the issue to In Progress. Also reviews issues returned from review to add clarifications.
model: fable
---

# Architect Role

## Overview

Researches issues and writes implementation plans before any code is written. The plan is the primary artifact. Planning runs without Codex (owner's rule, 2026-10-08): Codex reviews only the finished PR, once, right before the merge (`.claude/CLAUDE.md` → Codex — только финальное ревью перед мержем).

**How this role runs.** In the pipeline, `/tech-lead` starts it as an `Agent` spawn (`subagent_type: "general-purpose"`, `model: "fable"` for a first plan, `opus` for a Plan Update — `.claude/CLAUDE.md` → Экономия токенов), and the spawned agent's first action is `Skill(skill: "architect")`. The spawn's `model` is what puts planning on the strongest model (`.claude/CLAUDE.md` → Модели по ролям pipeline); the `model: fable` frontmatter above only matters when the owner invokes `/architect` directly. A spawned agent has no `AskUserQuestion`: every question for the owner is returned to tech-lead in the agent's final message (Step 5), and tech-lead asks it. Spawned by `/manager` (`.claude/skills/manager/SKILL.md`) the same way: questions and the merge request go back to the spawner, which answers by the rules of `.claude/CLAUDE.md` → Режим manager. Split issues go to Backlog when the spawner is the manager (the spawn prompt says so). A plan's byline or hand-off names the model only from the agent's own transcript (`message.model` of its turns), never from memory or the system prompt; when unsure, it names none, and the spawner checks the transcript only under tech-lead Mode 1 → Model policy — check (owner's decision 2026-10-23, #769) (#675 Plan Update 1, and #274 and #745 Plan Update on 2026-10-23: three hand-offs named Fable while every turn ran `claude-opus-5-5`).

## When to Invoke

- Issue is in **Todo**, no plan yet
- Issue **returned from review** to Todo — add a clarifying comment to the existing plan

---

## Workflow — New Issue

### Step 1: Read the issue

Use the `/github` skill's "Read Issue + Comments" template — one filtered `gh issue view` call. Pipeline Status comes from the `/github` GraphQL template ("Find issue's current Pipeline Status"), never from `gh project item-list`.

### Step 2: Explore the codebase

CodeGraph first, always (`.claude/CLAUDE.md` → CodeGraph → «Приоритет — codegraph»): `codegraph_context` for the issue's area, then one `codegraph_explore` for the symbols it surfaces; `codegraph_search`/`codegraph_files` for the rest. grep/Read only for literal text, the two shapes codegraph loses, and code outside the indexed tree. The plan names the codegraph calls it rested on.

Then `node tooling/rules-for.ts <files the issue names>` and Read every rule file it names (`.claude/skills/architect/rules/*.md`, the index is in this file → Architecture Rules); the plan quotes the script's `--list` output for its own file list.

**Scope rule:** cover the entire affected domain, not just explicitly mentioned entities. If the issue touches an architectural constraint, apply it to every entity in that domain — missed entities get caught at review, expensively.

### Step 3: Domain-wide impact scan (mandatory)

For every function/symbol the issue mentions:
```
codegraph_callers(<symbol>)   — who calls it, may need the same fix
codegraph_impact(<symbol>)    — what breaks if this changes
```
Then the grep cross-check the same section requires: `obj.method()` calls and functions passed by reference, which `codegraph_callers`/`codegraph_impact` can under-report down to zero (confirmed on `trade_intents`).

Produce a domain coverage table:

| Entity / file | Affected? | Reason | Enforcement |
|---|---|---|---|

Every entity in the domain must appear — "not mentioned in the issue" is not a reason to skip. If undetermined, mark "Needs check" and investigate before writing the plan.

- **Enforcement** (tasks with schema, constraints or other invariants): for each invariant the plan relies on, `enforced` (a constraint/trigger/check-at-import/test makes it impossible to break — name it), `partial` (enforced for some paths — name the ones that are not), or `stated` (only a comment or a doc says so). "N of M covered" hides which ones are missing; list them.
- **Parsers and request shapes:** every parser, schema and request/response shape in the domain gets its own row — not "the routes", each one.

### Step 4: Identify affected areas

Files to create/modify; schema changes (`packages/db` Drizzle schema); API/Socket.IO contract changes shared between `apps/backend` and `apps/trading-worker`; auth/authorization consistency (every mutating route needs the same pattern as its neighbors); frontend components affected in `apps/web`/`apps/bot`; conflicts with other in-flight branches. Sibling issues of the same wave that already have plans: read their file lists and merge order, and make this plan agree on who owns each shared file and who merges first (#119 and #185 were planned in one session, both claimed `users.ts`/`user-ops.ts` and both said they merge first; it surfaced only at implementer clarify). Agreeing on files is not enough: for every type or signature a sibling plan changes (a required field added to a deps type, a renamed export), list the new files of this plan that construct or call it, since git shows no conflict there and `main` breaks in whichever PR merges second (#136 built its new test on `buildApp`, while #138 made `AppDeps.pairs` required and patched only the existing `buildApp` callers). The same goes for new numbered entries in shared lists — an Architecture Rule number taken by a sibling plan is named, and the plan says the PR merging second renumbers (#19 and #134 both added Rule 22, 2026-10-06). The same holds for numbered lists in `docs/` (the risk list of `docs/bot-session.md` and the like): #709's plan took risk 95, already taken by open PR #727 (2026-10-22). Shared literals count too: every test that pins a changed literal (a menu, a command list) is listed, not only its source (#708's plan missed two tests with the command-menu literal, 2026-10-22). A plan that says "merge after #X" also says what the implementer does when #X has no branch yet — an interim form and the conversion step after #X merges (#99 and #89 against #205's `until()`, 2026-10-06). The conflicts section is built against every In Progress issue on the board and every open PR, not only this issue's siblings (#258's plan missed #90 and #100, which touched the same shared files; caught at implementer clarify, 2026-10-06). A plan whose branch starts from `main` while an open PR rewrites the same lines writes its code in `main`'s shape and keeps the other PR's shape for the rebase recipe only (#697's plan wrote the holds in #720's shape, without `signalAction` and the pause branch, which still exist on `main`; caught at implementer clarify, 2026-10-22). A live probe against the pilot server or the owner's broker account is planned as the owner's step with the exact commands, not as an implementer action: the permission classifier blocks SSH to production from an agent (#90, 2026-10-06), and a design whose safety rests on an unrun probe has no safety condition at all. A planned ESLint guard is probed against the repo's real files under the planned config, not only against a throwaway file: what it catches beyond the target matters as much as what it misses (#240 planned `no-restricted-imports` on the premise that it skips `import * as`; it catches it, and as planned flagged the shared barrel and five test files).

If a project-specific schema/design skill is installed (`drizzle-orm-patterns` for this project), invoke it before drafting schema changes.

### Step 4a: Size gate (owner's rule, 2026-09-30)

One issue = one PR of **≤ ~2000 added lines, tests and docs included; 3000 is the ceiling**. Generated files do not count: `packages/db/drizzle/meta/*_snapshot.json` alone is ~2 800 lines for any schema change, lands whole in whichever PR carries the migration, and no split can shrink it (owner, 2026-10-01, #10); the migration SQL and `_journal.json` do count. Review rounds grow with diff size: PRs of 6-12k lines took 4-8 rounds (#7, #9, #22, #68), PRs under ~2k took 1-2.

Estimate from Step 4's file list, calibrated on this repo's actuals rather than intuition — tests here are typically 1-2x the code: #6 contracts 2.1k, #7 schema 7.5k, #42 transport 7.2k, #22 bot /start 6.1k, #9 OAuth 11.5k, #68 staff login 11.8k.

When the plan exhausts an open set — a `Record<Key, …>` over a catalog, a description per message, a case per status — list the In Progress and open-PR issues that add members to that set, and add their likely growth to the estimate. #299 (2026-10-07) was estimated at 2.7k against a catalog that #284 and then #297 extended while it was in flight: the PR grew to 3.4k, needed two size exceptions, and a whole review round went to describing #297's screens.

- ≤ 2000 → proceed.
- 2000-3000 → proceed only if no split yields parts that are each mergeable on their own; say why in the plan, and name the fallback split line the implementer uses if the actual diff passes 3000. Not a question to the owner (`.claude/CLAUDE.md` → Постоянные ответы владельца).
- \> 3000 → split before the plan: each part is an independently mergeable issue that leaves `main` working, every acceptance criterion of the original lands in exactly one part. Create the parts with `/github` ("Create an issue" + "Add issue to Project #2"), rewrite this issue's body to the first part with links to the rest and their order, and plan only that first part. Report the split in the hand-off. The owner pre-authorized creating split issues without a separate confirmation (2026-09-30).

### Step 5: Clarifying questions (only on real forks)

A question only on a real fork the issue and the research leave open — no minimum, for a first plan and for a Plan Update of any round, round 0 included (`.claude/CLAUDE.md` → Постоянные ответы владельца → «Вопросы `/clarify`», owner's decision 2026-10-23, #769: of 127 relayed rounds the non-recommended option was chosen ~9 times, and agents waited up to 18 h for the answers): intent ambiguity in an unaddressed edge case, a scope boundary the issue does not draw, an integration constraint of an external system (Binodex Broker/Partner API in particular — its contract is still partially unconfirmed). Each question has 2-4 concrete options, the recommended one first, worded in Russian. Before offering an option, verify it can actually be carried out — only with a safe read-only probe (the flag appears in `--help`, the API returns the field, a dry run, a scratch file outside the repo); the proposed state-changing action itself — a merge, an issue, a commit, a push, a status change — is never performed before the owner's answer; an option the owner picks and the plan later drops costs a reversal question (#56: `review --scope branch` had no `--effort` and ignored the prompt template).

A **round-0 Plan Update** (a stale plan checked against `main` before the implementer, tech-lead Phase 2) asks only on new forks the moved code creates; with none, the Plan Update says so in its hand-off, not in a separate comment.

- **Spawned by tech-lead (the pipeline):** with questions, return them as the agent's final message and stop — no plan is written in this round; tech-lead asks them through `AskUserQuestion` and continues this agent (or spawns a fresh one) with the answers. With none, write «развилок нет» in the hand-off and go straight to Step 6 in this same run.
- **Invoked directly by the owner:** ask through `AskUserQuestion`.

Do not proceed to Step 6 while a question is unanswered.

### Step 6: Draft the plan

```
## Implementation Plan

### Scope
[What IS and IS NOT covered]

### Size estimate
[Added lines: code / tests / docs, total — Step 4a]

### Architecture decisions
[Key constraints to honor]

### Files to change
- `path/to/file` — what changes and why

### Schema changes (if any)

### Implementation steps
1. ...

### Edge cases to handle

### Accepted risks / trade-offs
[Each with reasoning. If bounded by a scale assumption, state it as an explicit falsifiable one-liner. Reviewers must not re-raise these as findings.]

### Validation checklist
- [ ] All affected domain entities covered (not just issue-mentioned ones)
- [ ] Every rule `node tooling/rules-for.ts <the plan's files>` prints (output quoted in the plan) that the change touches is named in the plan and preserved; a rule the change adds or alters goes to `.claude/skills/architect/rules/<area>.md` with its line in the index (next free number)
- [ ] No new build/type/lint/test failures (`pnpm check` passes)
- [ ] Every mutating endpoint has authorization consistent with adjacent code
- [ ] read→mutate patterns: atomic guard, or race condition explicitly accepted with reason
- [ ] try/catch blocks: catch behavior explicitly stated
- [ ] Every irreversible action whose outcome the user learns only from the response (a grant, an activation, a redeemed code): the plan says how the caller learns it after a timeout that fired post-commit — re-read the state before reporting an error, never infer it from the retry's refusal (owner, 2026-10-01: #10 m2 and #172 finding 4)
- [ ] Every error code the caller turns into an action (end a dialog, keep a step, retry, recheck): the plan names the code's source — the caller's own limit, a shared ceiling, a refusal before the side effect, or an unknown outcome — and derives the action from the source, not from the code's name; a code outside the table gets its own row, never a catch-all (#176: a shared route ceiling ended the user's dialog; every unlisted 4xx counted as an unknown outcome)
- [ ] Nullable parameter type changes: legacy fallback paths verified against existing null/undefined data
- [ ] A change that rewrites user-visible texts or labels: the plan finds every stale quote by searching for the old texts themselves (not by quote character), across `docs/`, `README.md`, code comments and the files that define the constants, and lists the hits with what each becomes (#198: `grep '«'` missed quotes in "…" in two docs; a later search skipped `texts.ts`'s own comment)
- [ ] Every mutation or probe the plan names as proof of a new check breaks only that check: it is run against the current code first, and a probe that also reddens an existing check, or a mutation that cannot reach the assertion it is assigned to, is replaced before the plan is posted (#199: a timing probe that broke an older conjunct too, and a `Promise.all` mutation invisible to call order; #209: a sample row that could never pass). A check the plan itself adds has no current code to run against: every row of its tests is evaluated against every conjunct of the planned predicate (a scratch copy of it): an accepted row satisfies all of them, a refusal row fails exactly the one its mutation removes (#637: three rows also failed a second conjunct, and two mutations had no assertion to redden)
- [ ] Every row of the mutation list names the test that executes the mutated line or text and observes its effect — checked per row before the plan is posted, not assumed from the file name: a mutation of a migration's SQL is expected only in a test file that builds its database from the migration files (`createTempDatabase`), never in `packages/db/src/schema.db.test.ts`, which runs on the shared, already migrated `TEST_DATABASE_URL`; a test that calls the function directly does not see a mutation of its caller; a mutation of a check that runs at import is a `load-error`, not `red`; each `old` occurs once in its file. A guard of several conjuncts is checked for equivalent mutants: a conjunct whose removal changes no result (another conjunct already refuses the same inputs) is not in the list, and the plan names it as equivalent (2026-10-22: #660 M10/M11 expected L1, which calls the list directly, and M15 was a `load-error`; #675 `Number.isFinite` beside the range check, then 0077 mutations expected in `schema.db.test.ts`; #683 M3, the check's order against `pairOf` unobservable — three plans of one night, two Plan Updates in #675)
- [ ] Single source per fact: each version, list, env value or secret scope the plan introduces lives in one place; every other place derives from it or is checked against it
- [ ] Every new or changed CHECK was executed against NULL and boundary values before it went into the plan
- [ ] Every permission the plan grants was checked against every restriction the same plan adds (a path allowed by one and forbidden by the other)
- [ ] Framework defaults the plan relies on (error bodies, redaction, retries, timeouts) were verified by running them, not from docs or memory
- [ ] Every type-inference claim is backed by a `tsc` probe that compiles the exported signature consuming the change, not only the call site (#85: `loggerInstance: pino(...)` compiled at the `Fastify(...)` call and failed on `buildApp`'s return type, TS2322)
- [ ] Every budget/timeout constant names the operation it bounds; the chain between them is checked at import and by a test, in every process that has one
- [ ] CI-executed tooling was checked against the runner image's version, not the local one
- [ ] Every documented invariant is worded no wider than the place that enforces it (cite it)
- [ ] Every pass/fail gate the plan defines says what it returns on zero evidence (empty input, 0 compared rows, an empty sample, a missing cache): a refusal or FAIL, never PASS — and a test drives that case through the command's entry point to its exit code (or the caller-visible result), not only the gate function (#381 PR #520 M1: `calibrate` passed on an empty stand, `wilson(0, 0)` = [0, 100])
- [ ] Every time offset the plan defines names its reference point (a candle boundary, the decision moment, a record's timestamp), and every decision that uses it names the same one (#381 PR #512 M1: one decision measured `openDelay` from the decision moment, two others from the boundary, and the fallback counted the 2 s slack twice)
- [ ] Every decision taken after an `await` names the reading it uses — the one the request was built on, or a fresh one — and a state that can move during the `await` (a watermark, the clock) is never read again to judge what the request returned (#590 PR #614 M1: the backfill built its GET on `at` and judged the returned rows closed by `ring.fill(…, now())`, so the bucket forming at `at` was filled as closed)
- [ ] A change that makes a step run sooner (a wake, a removed or shortened wait or tick) lists every state that step reads and the writer of each, for every event that now triggers it, and shows each writer has committed before the read — or the step waits for it; a delay the old code had is treated as a possible guard until this list shows it was not one (#696 PR #713: round 1 — the wake after a settlement read the balance snapshot before `update_balance` wrote the payout and stopped the session `insufficient_balance`; round 2 — the fix covered the session's own settlements, while the wake also fired on other intents of the account)
- [ ] Every test double and fixture the plan names differs from the code's own normalisation on the axis under test: a fake `sleep` honours the abort signal the real one would, a catalog fixture is not already in the order the code re-sorts it, a state stream repeats a transition the code may see twice (#392 PR #553: a fake sleep that ignored `stop` hid an unpaced fetch after SIGINT; ascending ids hid coverage measured on a re-sorted split; no two-drop flap hid a hole stretched to the end of the run)
- [ ] Every existing path the plan reuses for a new kind of input (an edit, a stop, a send on a new message kind) names the input forms it accepts, and the plan's test drives the form the new caller produces in production — a photo message, not only a text one (#745 PR #760, round 1: the unsuffixed stop's in-place `editMessageText` was reused for the H1 session message, which is a photo; Telegram refused, the bot sent a second message and the photo kept a live «⏹»; H1-B3 pressed only on a text message)
```

Task classes with a mandatory plan section — each row traces to a real review finding (`audits.md`). A plan whose task falls into a class must contain that section:

| Task class | Required plan section |
|---|---|
| Toolchain / engines / Node version | `npm view <tool> engines` for every root devDependency and their intersection; fresh-clone, stale-cache and incremental scenarios, each named with its expected outcome |
| CI workflow | Feature list checked against the runner image's tool versions; every diagnostic/cleanup step still runs when the step it diagnoses has failed (`if: failure()`/`always()`, `continue-on-error`) |
| Compose / env | Interpolation and env semantics verified with `docker compose config` before the plan is written, output quoted — on the CI runner's Compose version too (a standalone release binary in a scratch dir), not only the local one (#192: a nested `${A+${B:?}}` passed on 5.5.1 and failed every `config` on the runner's 2.38.2) |
| Developer environment (VM, host services, package manager) | Behaviour across a host sleep/wake and a restart, not only right after the change; the rollback and its trigger; dry-run output of every package-manager step read in full and quoted (no `head`/`tail`); the exact scope of the owner's authorization (#166: a VM clock fix passed a 16-min acceptance and left the clock 84 min behind after the first sleep; a truncated `brew --dry-run` hid four upgrades) |
| Schema / constraints | Enforcement column in Step 3; every CHECK run on NULL/boundary rows; permission × restriction compatibility |
| Timeouts / budgets | Each constant → the operation it bounds; the ordering chain and where it is asserted (import + test) per process |
| Logging changes | The test that reads the log itself (a destination seam), not the HTTP response |
| Text / docs edits | Every command the text gives, run before commit **from the starting state the text names** (a fresh volume, an empty database — not an environment that already works); the edited paragraph re-read whole |
| Work queue / background tick / recovery list (candidates picked by an order key, or rows re-read on every pass until a flag is set) | A table of every way an attempt can end (success, each failure code, a throw, an abort, a skip) and what each does to the order key, to a hold-back, or to the column or predicate that keeps a row in the list. If some ending leaves the item at the head of the queue, that item starves every other one; if it leaves a row in a bounded list with nothing that can ever take it out, such rows accumulate until they fill the bound and newer rows drop out (#235 m1: failures did not move `rest_observed_at`; the #137 fix covered the outcomes but not a throw, round 1 m2; #567 round 1: a status message the user deleted or a blocked bot never set `summary_sent_at`, so the row stayed in the resume list forever; the fix cleared `status_message_id` on those endings) |
| Bulk start-up work (resume, replay, re-arm of many entries at once) | The worst-case number of entries and the external calls each makes in its first step; the resulting rate per external API against that API's documented limit (Telegram: `docs/bot-session.md` → Timing and → Rate and timing, ~30/s per bot; the broker: `packages/shared/src/broker-budget.ts`) and the backend's own limits; how the first calls are spread (a named rate constant in the process's own timing/config module — `timing.ts`, `*/config.ts` — and a test of the spacing). Arming every entry on one timer is a burst (#567 round 2: up to 2 000 recovered sessions polled and edited 3 s after a restart) |
| A later part of a split feature (its predecessor merged, open or stacked) | Every start-up, recovery and periodic path of the predecessor part replayed against the states this part adds and the messages it changes, at the deploy (old-format data, running sessions) and after a restart: what the merged path now does to them. The predecessor's code is a caller of the new states once both are deployed, not background (#536 round 2: #567's resume edited old status messages of running sessions and stripped their «⏹» while the backfill withheld the new one) |
| Supervisor of external connections (active/reserve, failover, reconnect, a pool of sockets or sessions on accounts) | In the first plan, not after review: the transition table over the product of the supervisor's own slot states × the client's states, each non-ready and each terminal state its own row (`connecting`, `authenticating`, `reconnecting` are not one state) × the async work in flight (token exchange, start, stop) × membership of the authoritative list the slots are chosen from. Each row: the handler path and its test id. Then a liveness bound (with a working account, the active reaches ready within a stated time, pinned in `timing.ts`) and the safety invariants (no account in two slots, nothing outside the list beyond one tick after a successful list read (a failed read keeps the slots until the next one — say so), every promise handled, late answers fenced). A table that lumps client states or never re-checks a running slot against the list misses the stuck states (#404: round 1 — a ready reserve never promoted; round 2 — an active stuck in `connecting` and a running socket on an unmarked account; a third plan as an explicit state machine closed them) |
| Render / dedupe key ("unchanged → skip") | The key covers everything the user sees change — picture, keyboard, message kind — not only the printed text; an admin text override (Rule 30) can make two texts equal (#568 round 1: an up→down turn with equal `sessionSignalUp`/`sessionSignalDown` overrides kept the bull picture). A test with the texts forced equal proves the key |
| Credential / session lifecycle (disable, reset, revoke) | Every artifact issued under the old credential and every request in flight, with the source of each timestamp written (`now()` is transaction start) and the lock modes checked against a concurrent issue path |

### Step 7: Post the plan, move the issue

Post the final plan as an issue comment (`/github` skill), then move the issue to **In Progress**.

Before the hand-off, read the stored body back (`gh api repos/ChaoticMelnik/binarius/issues/comments/<id> --jq .body`) and diff it against the local file — the same for a Plan Update. In the plan's code blocks, write control characters as `\x` escapes: a `\u00XX` escape in the local file came back in #197's plan as caret notation, which turned `[\s\x00-\x1f\x7f]` into a class that refused A-Z; only the implementer's clarify round caught it.

---

## Workflow — Issue Returned from Review

### Step 1: Read the PR review comments

`gh pr view <N> --json comments` and/or `gh pr diff <N>` — understand what was rejected and why. A reviewer's "optional improvement" is checked like a finding before it goes into the Plan Update — two simplify agents once recommended the exact change that broke CI.

### Step 2: Post a clarifying comment

New comment, don't edit the original plan — preserves the audit trail:

```
## Plan Update (after review)

### Review findings summary
### What was wrong in the original plan
### All occurrences of the class
[For each finding: the search that enumerates every place with the same construct (grep/codegraph command + result), and each place's fix. "Close the found one" is not a step.]
### Every process affected
[For budgets, timeouts, logging and shutdown: each process that has the same mechanism, not only the one the finding named.]
### Revised implementation steps
```

### Step 3: Move the issue back to In Progress

Implementer picks it up only once this comment exists.

---

## Architecture Rules to Enforce in Every Plan

Модульные границы: `apps/bot`, `apps/backend`, `apps/web`, `apps/trading-worker`, `packages/db`, `packages/shared` (стек — `.claude/skills/tech-lead/SKILL.md` → Project Architecture Reference). Общий Drizzle-контракт и общие типы в `packages/shared` меняет только их владелец за волну (`.claude/CLAUDE.md` → Несколько параллельных агентов).

Инварианты ниже подтверждены кодом в `main` (2026-09-24). Полный список — этот индекс и файлы `rules/*.md` этого каталога; reviewer, Codex-промпт (`.claude/codex-review-prompt.md`) и `.claude/CLAUDE.md` ссылаются сюда. Как загружать: `node tooling/rules-for.ts <файлы плана>` печатает правила по путям; файл области читается Read целиком, когда план трогает её. Новое правило — следующий свободный номер, файл своей области, строка здесь; со ссылкой на место, где оно enforced, не шире этого места (шаблон и лимит — #776).

### Index

1. **Статусы** — статусная колонка — `text` + CHECK из одной `as const`-константы на домен; сравнение в SQL — только через `literal()`/`sqlLiteralList` → `rules/core.md`
2. **Деньги и токены** — токены `bigint`, суммы `numeric(20,8)` string-mode из `money()`, в коде `DecimalString`; кэш `users` пишут писатели леджера в одной транзакции → `rules/core.md`
3. **Append-only** — `token_ledger` и `audit_log` отвергают UPDATE, DELETE и TRUNCATE триггерами; `bonus_rules` — неизменяемые строки → `rules/core.md`
4. **Владение строк — композитными FK** — владение строки держит композитный FK, не проверка в коде → `rules/core.md`
5. **Порядок блокировок** — `users → broker_accounts → trading_sessions → trade_intents → broker_trades` для всех писателей; `users → notification_jobs` → `rules/core.md`
6. **Переходы trade_intents** — только CAS внутри UPDATE; возрастные предикаты — по часам БД → `rules/trading.md`
7. **Идемпотентность** — unique `(user_id, client_request_id)`, один нетерминальный intent на аккаунт, outbox `(topic, intent_id)`, сделка брокера — к одному intent'у → `rules/core.md`
8. **Ошибки логируются именем и кодом** — `errorIdentity`/`errorLogFields`; ESLint и логгер ловят это частично → `rules/core.md`
9. **500 непрозрачны** — наружу только целочисленный 4xx, wire-view — allowlist полей, строка БД не spread'ится → `rules/core.md`
10. **Цепочки таймаутов** — `TIMING_CHAIN_HOLDS` и подобные проверяются при импорте в каждом процессе → `rules/core.md`
11. **Токены в покое** — AES-256-GCM, AAD `keyId|accountId|field`, `token_key_id` для ротации → `rules/auth.md`
12. **OAuth** — state хешем и одноразово через CAS, новый аккаунт `pending` до подтверждения, refresh — одна попытка, отзыв при возможном расходе пары → `rules/auth.md`
13. **bot → backend** — общий bearer, сравнение за постоянное время; чтения и остановки проверяют владельца по `telegramUserId` → `rules/auth.md`
14. **Env** — пустое значение — ошибка; отсутствующее — ошибка для обязательной, default из кода для необязательной → `rules/core.md`
15. **Executor** — `rejected` только при точно не открытом ордере, throw → `unknown`, `accepted` только с совпадающей `OpenTrade` → `rules/trading.md`
16. **Миграции forward-only** — каждое изменение схемы с миграцией, один runner `pnpm db:migrate` → `rules/core.md`
17. **Валидация на границах** — zod в роутах, внутренний код доверяет провалидированному; внешний id — `UUID_PATTERN` → `rules/core.md`
18. **Тексты пользователю в Telegram** — только `TelegramHtml`, `parse_mode: 'HTML'` ставят seam'ы → `rules/bot-ui.md`
19. **Доставляемость и уровень уведомлений** — блокировка бота — одна колонка `users.telegram_blocked_at`, уровень уведомлений и рассылки → `rules/bot-ui.md`
20. **Сигнал v2** — решение — чистая функция от закрытых свечей и параметров; коды и wire-схема — `packages/shared/src/signal.ts` → `rules/signal-h1.md`
21. **Снимок баланса брокера** — одна строка на аккаунт, пишут только операции `balance-snapshot-ops.ts`, возрасты — по часам БД → `rules/trading.md`
22. **Торговля за глобальным выключателем** — intent создаётся и уходит брокеру только при открытом `trading_switch` → `rules/trading.md`
23. **Размер ставки v1** — чистая функция от параметров и входа, деньги — `DecimalString` и `bigint` со шкалой 8 → `rules/trading.md`
24. **Проход сверки** — кандидаты и claim одним SQL-фрагментом `reconcileLeaseExpired`, claim — первая запись каждой попытки до брокера → `rules/trading.md`
25. **Сопоставление сделки** — ключи и окно по `open_timestamp`, связанные сделки исключаются, больше одного кандидата — `ambiguous` → `rules/trading.md`
26. **Тело HTTP-ответа — потолок байтов** — серверные fetch-клиенты читают тело с потолком → `rules/core.md`
27. **Менеджер сессий брокера** — создаётся только при `BROKER_WS_URL` и safe-вердикте `socket-probe` → `rules/trading.md`
28. **Торговая сессия** — одна `active`-сессия на аккаунт, владелец по `telegramUserId`, оркестратор и настройки сессии → `rules/trading.md`
29. **Ставка пользователя по режимам** — `users.demo_stake`/`users.real_stake` nullable `money()`, NULL — минимальная ставка → `rules/bot-ui.md`
30. **Переопределения текстов бота** — строка `bot_text_overrides` — только переопределение, ключ и длина — CHECK → `rules/bot-ui.md`
31. **Следующий шаг под каждым сообщением** — seam'ы `apps/bot/src/send.ts` требуют inline-клавиатуру; без неё — только `…WithoutNextStep` с причиной → `rules/bot-ui.md`
32. **Lease сокета брокера** — одна строка на аккаунт в `broker_session_leases`, каждая операция — один statement по часам БД → `rules/trading.md`
33. **Предохранитель DEMO_ONLY** — процесс с `DEMO_ONLY=true` не отправляет брокеру операцию с реальными деньгами → `rules/trading.md`
34. **Приглашения** — приглашённый — только пользователь, чью строку создал этот `/start` с `ref_<code>` → `rules/payments.md`
35. **Постбэки** — роут только при `POSTBACK_URL_SECRET`, приём никогда не начисляет, единственный писатель `recordPostback` → `rules/payments.md`
36. **Режим торговли пользователя** — `users.trading_mode` с CHECK, единственный писатель `writeTradingMode` → `rules/trading.md`
37. **Касса: widget-сессия** — `POST /deposit/widget-session` публичный по `initData`, порядок проверок роута → `rules/payments.md`
38. **Касса: страница** — `apps/web/src/cashier/`: фильтр `message`-событий по источнику и origin → `rules/payments.md`
39. **Покупка токенов за Stars** — цена и токены замораживаются в `star_payments`, единственный писатель `creditStarPayment` → `rules/payments.md`
40. **Правила бонусов** — начисление `bonus` — по неизменяемой версии правила, одна действующая версия на код → `rules/payments.md`
41. **Источник свечей из сокета** — только при `BROKER_WS_URL`, сокеты данных — на служебных аккаунтах в строю → `rules/signal-h1.md`
42. **Журнал решений сессий** — каждое решение с исходом — строка `signal_decisions` одним INSERT, UPDATE нет → `rules/signal-h1.md`
43. **Детектор H1** — чистая функция `decide({ closes, at })` от ряда закрытий секунд → `rules/signal-h1.md`
44. **Тень H1** — серия закрытий секунд из тиков активного сокета данных; закрытая секунда не меняется → `rules/signal-h1.md`
45. **Тики вокруг решения и срок хранения** — строка `decision_ticks` одна на решение, пишется один раз после закрытия окна; срок хранения журнала → `rules/signal-h1.md`
46. **Ожидание сигнала в боте** — после выбора пары бот не показывает «нет сигнала», а ждёт сигнал → `rules/bot-ui.md`
47. **Итог сессии одним сообщением** — итог завершённой сессии — одно сообщение бота со звуком; запасной текст — у backend'а → `rules/bot-ui.md`
48. **Сессии H1** — `broker_accounts.h1_since` пишет только `setH1Mark`; H1-сессия — обычная сессия только на помеченном аккаунте, настройки v5 пишет только `buildH1SessionSettings` → `rules/signal-h1.md`
49. **Роли кнопок** — каждая inline-кнопка строится с ролью из `ButtonRole`, цвет и ширина — только из таблиц ролей → `rules/bot-ui.md`
50. **Домен строки broker_trades** — значение брокера, которое колонка не вмещает, не отклоняет запись принятой сделки → `rules/trading.md`
51. **Отметки против created_at** — колонка, упорядоченная CHECK'ом относительно `created_at`, пишется через `statementNow` → `rules/core.md`

### Map: path → rules

<!-- generated: node tooling/rules-for.ts --map -->
| Путь | Правила |
|---|---|
| `.github` | core 14, 16 |
| `apps` | core 51; signal-h1 20, 43; bot-ui 18 |
| `apps/backend/src` | core 9, 10, 14, 16, 17; trading 22, 23, 27, 28, 33; signal-h1 41, 44, 45, 48; bot-ui 18, 19, 31, 46, 47, 49; payments 35 |
| `apps/backend/src/admin` | core 3, 5, 7, 8, 10, 14; trading 22, 28, 33, 36; signal-h1 48; bot-ui 18, 19, 29, 30, 31, 46; auth 12, 13 |
| `apps/backend/src/auth` | core 3, 5, 7; trading 22, 33, 36; bot-ui 18, 19, 29, 30, 31, 49; payments 35; auth 12, 13 |
| `apps/backend/src/bot-texts` | core 3, 5, 7; trading 22, 33, 36; bot-ui 19, 29, 30; auth 12, 13 |
| `apps/backend/src/broker` | core 26; trading 21; auth 12 |
| `apps/backend/src/cli` | core 26; trading 28, 33, 50; signal-h1 42, 44, 45, 48; bot-ui 30; payments 39, 40 |
| `apps/backend/src/deposit` | core 3, 5, 7; trading 22, 33, 36; bot-ui 19, 29, 30; payments 37; auth 12, 13 |
| `apps/backend/src/h1` | signal-h1 44, 48 |
| `apps/backend/src/mailing` | bot-ui 19 |
| `apps/backend/src/market-data` | signal-h1 41, 44, 45 |
| `apps/backend/src/outbox` | trading 6 |
| `apps/backend/src/payments` | core 3, 5, 7; trading 22, 33, 36; bot-ui 19, 29, 30; payments 39; auth 12, 13 |
| `apps/backend/src/postbacks` | core 3, 5, 7, 9; trading 22, 33, 36; bot-ui 19, 29, 30; payments 35, 37; auth 12, 13 |
| `apps/backend/src/signal` | signal-h1 20, 41 |
| `apps/backend/src/trade-log` | signal-h1 45 |
| `apps/backend/src/trading` | core 3, 5, 7, 26; trading 21, 22, 23, 28, 33, 36; signal-h1 20, 42, 48; bot-ui 19, 29, 30, 31, 47; auth 12, 13 |
| `apps/backend/src/users` | core 3, 5, 7; trading 22, 33, 36; bot-ui 19, 29, 30; auth 12, 13 |
| `apps/bot` | core 26 |
| `apps/bot/src` | core 8, 10, 14, 26; trading 22, 23, 27, 28, 33, 36, 50; signal-h1 20, 41, 44, 45, 48; bot-ui 18, 19, 29, 30, 31, 46, 47, 49; payments 39; auth 12, 13 |
| `apps/trading-worker/src` | core 10, 16; trading 22, 23, 27, 28, 32, 33; signal-h1 44, 45 |
| `apps/trading-worker/src/broker` | core 10, 26; trading 21, 22, 27, 32; auth 12 |
| `apps/trading-worker/src/circuit-breaker` | core 10; trading 22, 25, 28; signal-h1 20, 43 |
| `apps/trading-worker/src/cli` | trading 23, 27, 28 |
| `apps/trading-worker/src/intents` | core 10, 14; trading 15, 21, 22, 24, 25, 27, 28, 33; signal-h1 43, 48; auth 12 |
| `apps/trading-worker/src/trading-session` | core 10, 26; trading 22, 23, 24, 25, 28, 33, 36; signal-h1 42, 43, 48 |
| `apps/web` | core 26; bot-ui 30 |
| `apps/web/src` | core 9, 10, 14, 17, 26; trading 22, 23, 27, 28, 33, 36; signal-h1 41, 44, 45, 48; bot-ui 19, 31, 46, 47; payments 38 |
| `apps/web/src/admin` | bot-ui 30; payments 38 |
| `apps/web/src/cashier` | payments 38 |
| `apps/web/src/oauth` | core 26; payments 38 |
| `compose.yaml` | core 16; bot-ui 47 |
| `docs` | trading 21, 22, 24, 28; bot-ui 18; payments 37, 38; auth 12, 13 |
| `eslint.config.js` | core 8; bot-ui 18 |
| `packages` | core 51; bot-ui 18 |
| `packages/broker-rest/src` | core 10, 26; trading 15, 27, 28, 33; signal-h1 44, 45 |
| `packages/broker-socket/src` | core 10, 14; trading 15, 27, 28, 33; signal-h1 44, 45 |
| `packages/db/drizzle` | core 3, 51 |
| `packages/db/src` | core 2, 3, 4, 5, 7, 9, 10, 16, 51; trading 6, 15, 21, 22, 24, 27, 28, 32, 33, 36, 50; signal-h1 41, 42, 44, 45, 48; bot-ui 19, 29, 30, 47; payments 34, 35, 39, 40; auth 11, 12, 13 |
| `packages/db/src/cli` | core 16 |
| `packages/db/src/schema` | core 1, 2, 10, 51; trading 22, 27, 28, 33, 50; signal-h1 42, 44, 45; auth 11, 12 |
| `packages/e2e/src` | trading 28 |
| `packages/e2e/src/harness` | core 10; trading 22, 28; bot-ui 29, 46 |
| `packages/mock-broker/src` | core 2, 10; trading 15, 23, 27, 28, 33; signal-h1 44, 45 |
| `packages/shared` | core 10; trading 27; bot-ui 30 |
| `packages/shared/src` | core 2, 8, 9, 10, 14, 17, 26; trading 15, 21, 22, 23, 25, 27, 28, 33, 36, 50; signal-h1 20, 43, 44, 45, 48; bot-ui 18, 19, 29, 30, 31, 46, 47, 49; payments 39, 40; auth 12 |
| `packages/signal` | signal-h1 43 |
| `packages/signal-stand` | signal-h1 20 |
| `packages/signal-stand/src` | core 10; trading 25, 28; signal-h1 20, 41, 43, 44 |
| `packages/signal/src` | core 10; trading 25, 27, 28, 33; signal-h1 20, 41, 43, 44, 45, 48 |
| `packages/signal/src/fixtures` | signal-h1 20 |
| `packages/stake/src` | core 2, 10; trading 23, 25, 27, 28, 33; signal-h1 43, 44, 45, 48 |
| `scripts` | trading 27, 28; bot-ui 47 |
| `tooling` | core 1 |
<!-- /generated -->

## Forbidden Actions

- Never push to `main` or merge a PR.
- Never write code — the Architect's output is the plan only.
- Never move an issue to In Review — that's the Implementer's job.
- Never skip domain scope analysis.
- Never post a plan whose size estimate exceeds 3000 added lines — split first (Step 4a).
- Never call `AskUserQuestion` when running as a spawned agent — return the questions to tech-lead.
