---
name: architect
description: Plans implementation for GitHub issues before they move to In Progress. Research the issue, explore the codebase, write a clear plan as an issue comment, then move the issue to In Progress. Also reviews issues returned from review to add clarifications.
model: fable
---

# Architect Role

## Overview

Researches issues and writes implementation plans before any code is written. The plan is the primary artifact. Before it's final, run an independent **Codex plan review** (Step 7) and incorporate any Blocker/Major gaps.

**How this role runs.** In the pipeline, `/tech-lead` starts it as an `Agent` spawn (`subagent_type: "general-purpose"`, `model: "fable"`), and the spawned agent's first action is `Skill(skill: "architect")`. The spawn's `model` is what puts planning on the strongest model (`.claude/CLAUDE.md` → Модели по ролям pipeline); the `model: fable` frontmatter above only matters when the owner invokes `/architect` directly. A spawned agent has no `AskUserQuestion`: every question for the owner is returned to tech-lead in the agent's final message (Step 5), and tech-lead asks it.

## When to Invoke

- Issue is in **Todo**, no plan yet
- Issue **returned from review** to Todo — add a clarifying comment to the existing plan

---

## Workflow — New Issue

### Step 1: Read the issue

Use the `/github` skill's "Read Issue + Comments" template — one filtered `gh issue view` call. Pipeline Status comes from the `/github` GraphQL template ("Find issue's current Pipeline Status"), never from `gh project item-list`.

### Step 2: Explore the codebase

If CodeGraph is configured for this project (`~/.claude/CLAUDE.md` → CodeGraph): `codegraph_context`/`codegraph_search`/`codegraph_explore`/`codegraph_files`. Otherwise grep/read directly.

**Scope rule:** cover the entire affected domain, not just explicitly mentioned entities. If the issue touches an architectural constraint, apply it to every entity in that domain — missed entities get caught at review, expensively.

### Step 3: Domain-wide impact scan (mandatory)

For every function/symbol the issue mentions:
```
codegraph_callers(<symbol>)   — who calls it, may need the same fix
codegraph_impact(<symbol>)    — what breaks if this changes
```
(Grep-based equivalents if CodeGraph isn't set up yet.)

Produce a domain coverage table:

| Entity / file | Affected? | Reason | Enforcement |
|---|---|---|---|

Every entity in the domain must appear — "not mentioned in the issue" is not a reason to skip. If undetermined, mark "Needs check" and investigate before writing the plan.

- **Enforcement** (tasks with schema, constraints or other invariants): for each invariant the plan relies on, `enforced` (a constraint/trigger/check-at-import/test makes it impossible to break — name it), `partial` (enforced for some paths — name the ones that are not), or `stated` (only a comment or a doc says so). "N of M covered" hides which ones are missing; list them.
- **Parsers and request shapes:** every parser, schema and request/response shape in the domain gets its own row — not "the routes", each one.

### Step 4: Identify affected areas

Files to create/modify; schema changes (`packages/db` Drizzle schema); API/Socket.IO contract changes shared between `apps/backend` and `apps/trading-worker`; auth/authorization consistency (every mutating route needs the same pattern as its neighbors); frontend components affected in `apps/web`/`apps/bot`; conflicts with other in-flight branches. Sibling issues of the same wave that already have plans: read their file lists and merge order, and make this plan agree on who owns each shared file and who merges first (#119 and #185 were planned in one session, both claimed `users.ts`/`user-ops.ts` and both said they merge first; it surfaced only at implementer clarify). Agreeing on files is not enough: for every type or signature a sibling plan changes (a required field added to a deps type, a renamed export), list the new files of this plan that construct or call it, since git shows no conflict there and `main` breaks in whichever PR merges second (#136 built its new test on `buildApp`, while #138 made `AppDeps.pairs` required and patched only the existing `buildApp` callers). The same goes for new numbered entries in shared lists — an Architecture Rule number taken by a sibling plan is named, and the plan says the PR merging second renumbers (#19 and #134 both added Rule 22, 2026-10-06). A plan that says "merge after #X" also says what the implementer does when #X has no branch yet — an interim form and the conversion step after #X merges (#99 and #89 against #205's `until()`, 2026-10-06).

If a project-specific schema/design skill is installed (`drizzle-orm-patterns` for this project), invoke it before drafting schema changes.

### Step 4a: Size gate (owner's rule, 2026-09-30)

One issue = one PR of **≤ ~2000 added lines, tests and docs included; 3000 is the ceiling**. Generated files do not count: `packages/db/drizzle/meta/*_snapshot.json` alone is ~2 800 lines for any schema change, lands whole in whichever PR carries the migration, and no split can shrink it (owner, 2026-10-01, #10); the migration SQL and `_journal.json` do count. Review rounds grow with diff size: PRs of 6-12k lines took 4-8 rounds (#7, #9, #22, #68), PRs under ~2k took 1-2.

Estimate from Step 4's file list, calibrated on this repo's actuals rather than intuition — tests here are typically 1-2x the code: #6 contracts 2.1k, #7 schema 7.5k, #42 transport 7.2k, #22 bot /start 6.1k, #9 OAuth 11.5k, #68 staff login 11.8k.

- ≤ 2000 → proceed.
- 2000-3000 → proceed only if no split yields parts that are each mergeable on their own; say why in the plan.
- \> 3000 → split before the plan: each part is an independently mergeable issue that leaves `main` working, every acceptance criterion of the original lands in exactly one part. Create the parts with `/github` ("Create an issue" + "Add issue to Project #2"), rewrite this issue's body to the first part with links to the rest and their order, and plan only that first part. Report the split in the hand-off. The owner pre-authorized creating split issues without a separate confirmation (2026-09-30).

### Step 5: Clarifying questions (every issue)

Always, for every issue — the `/clarify` floor has no exception here, a mechanical fix included. Prepare **at least 3** targeted questions: intent ambiguity in unaddressed edge cases, explicit scope boundary, integration constraints if an external system is involved (Binodex Broker/Partner API in particular — its contract is still partially unconfirmed). Each question has 2-4 concrete options, the recommended one first, worded in Russian. Before offering an option, verify it can actually be carried out — only with a safe read-only probe (the flag appears in `--help`, the API returns the field, a dry run, a scratch file outside the repo); the proposed state-changing action itself — a merge, an issue, a commit, a push, a status change — is never performed before the owner's answer; an option the owner picks and the plan later drops costs a reversal question (#56: `review --scope branch` had no `--effort` and ignored the prompt template).

- **Spawned by tech-lead (the pipeline):** return the questions as the agent's final message and stop — no plan is written in this round. Tech-lead asks them through `AskUserQuestion` and continues this agent (or spawns a fresh one) with the answers.
- **Invoked directly by the owner:** ask through `AskUserQuestion`.

Do not proceed to Step 6 until answered.

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
- [ ] Every invariant from "Architecture Rules" below that the change touches is named in the plan and preserved
- [ ] No new build/type/lint/test failures (`pnpm check` passes)
- [ ] Every mutating endpoint has authorization consistent with adjacent code
- [ ] read→mutate patterns: atomic guard, or race condition explicitly accepted with reason
- [ ] try/catch blocks: catch behavior explicitly stated
- [ ] Every irreversible action whose outcome the user learns only from the response (a grant, an activation, a redeemed code): the plan says how the caller learns it after a timeout that fired post-commit — re-read the state before reporting an error, never infer it from the retry's refusal (owner, 2026-10-01: #10 m2 and #172 finding 4)
- [ ] Every error code the caller turns into an action (end a dialog, keep a step, retry, recheck): the plan names the code's source — the caller's own limit, a shared ceiling, a refusal before the side effect, or an unknown outcome — and derives the action from the source, not from the code's name; a code outside the table gets its own row, never a catch-all (#176: a shared route ceiling ended the user's dialog; every unlisted 4xx counted as an unknown outcome)
- [ ] Nullable parameter type changes: legacy fallback paths verified against existing null/undefined data
- [ ] A change that rewrites user-visible texts or labels: the plan finds every stale quote by searching for the old texts themselves (not by quote character), across `docs/`, `README.md`, code comments and the files that define the constants, and lists the hits with what each becomes (#198: `grep '«'` missed quotes in "…" in two docs; a later search skipped `texts.ts`'s own comment)
- [ ] Every mutation or probe the plan names as proof of a new check breaks only that check: it is run against the current code first, and a probe that also reddens an existing check, or a mutation that cannot reach the assertion it is assigned to, is replaced before the plan is posted (#199: a timing probe that broke an older conjunct too, and a `Promise.all` mutation invisible to call order; #209: a sample row that could never pass)
- [ ] Single source per fact: each version, list, env value or secret scope the plan introduces lives in one place; every other place derives from it or is checked against it
- [ ] Every new or changed CHECK was executed against NULL and boundary values before it went into the plan
- [ ] Every permission the plan grants was checked against every restriction the same plan adds (a path allowed by one and forbidden by the other)
- [ ] Framework defaults the plan relies on (error bodies, redaction, retries, timeouts) were verified by running them, not from docs or memory
- [ ] Every type-inference claim is backed by a `tsc` probe that compiles the exported signature consuming the change, not only the call site (#85: `loggerInstance: pino(...)` compiled at the `Fastify(...)` call and failed on `buildApp`'s return type, TS2322)
- [ ] Every budget/timeout constant names the operation it bounds; the chain between them is checked at import and by a test, in every process that has one
- [ ] CI-executed tooling was checked against the runner image's version, not the local one
- [ ] Every documented invariant is worded no wider than the place that enforces it (cite it)
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
| Work queue / background tick (candidates picked by an order key) | A table of every way an attempt can end (success, each failure code, a throw, an abort, a skip) and what each does to the order key or to a hold-back. If some ending leaves the item at the head of the queue, that item starves every other one (#235 m1: failures did not move `rest_observed_at`; the #137 fix covered the outcomes but not a throw, round 1 m2) |
| Credential / session lifecycle (disable, reset, revoke) | Every artifact issued under the old credential and every request in flight, with the source of each timestamp written (`now()` is transaction start) and the lock modes checked against a concurrent issue path |

### Step 7: Run Codex plan review

Codex runs through the `codex` plugin's companion script, called from Bash — not through `Skill(codex:rescue)`, which needs `AskUserQuestion` and a main-context `Agent` that a spawned architect does not have. The script's path changes with the plugin version; set `COMPANION` exactly as `.claude/skills/tech-lead/SKILL.md` → "Whole-feature pass — check" does (the one place that line lives), then:

```bash
node "$COMPANION" task --background --fresh --model gpt-5.6-sol --effort high --prompt-file <file>
node "$COMPANION" status <job-id> --wait --timeout-ms 540000   # repeat until the job leaves running
node "$COMPANION" result <job-id>
```

1. Write the request to a file from `.claude/codex-plan-review-prompt.md`: the issue and acceptance criteria, the draft plan, the domain coverage table, the affected files/schema/API list, and the invariants (Architecture Rules below). The Codex sandbox has no network, so **everything goes into the file inline** — never a URL or "see the issue". `task` without `--write` runs in a read-only sandbox; say "review only" in the request anyway.
2. Before a long run, apply the usage-limit rule of tech-lead → Phase 0, item 1.
3. Always `--background` + `status --wait` polling (a foreground call dies at the 10-minute tool cap) and always `--fresh` with the full context — never `--resume` after a failure.
4. Timeout/failure policy: 2 attempts, then stop. Spawned by tech-lead: return the failure to tech-lead. Direct invocation: ask the owner.

Ask for findings only — missing domain entities, skipped edge cases, wrong ownership/placement, schema/contract drift, auth/multi-tenant risks. Verify every Blocker/Major against the code before it changes the plan (a Codex claim is a hypothesis, like any other), then revise the draft.

### Step 8: Post the plan, move the issue

Post the final plan as an issue comment (`/github` skill), then move the issue to **In Progress**.

---

## Workflow — Issue Returned from Review

### Step 1: Read the PR review comments

`gh pr view <N> --json comments` and/or `gh pr diff <N>` — understand what was rejected and why.

### Step 2: Re-check the revised plan with Codex — new cycle only

Only when this Plan Update opens a new cycle — after the second unsuccessful review round (`.claude/skills/tech-lead/SKILL.md` → Phase 4, iteration 2; the spawn prompt says "Codex re-check: yes"). After the first round the Plan Update goes without Codex: skip to Step 3 and write "Codex re-check: not required (round 1)" in it (owner's rule, 2026-09-30). Invoked directly by the owner: ask which round this is if the PR comments do not show it.

Same mechanism as Step 7 (companion `task`, full context inline). Send: original plan, review findings, proposed revised steps. Ask whether the revision fully covers the gap. A reviewer's "optional improvement" is checked like a finding before it goes into the Plan Update — two simplify agents once recommended the exact change that broke CI.

### Step 3: Post a clarifying comment

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

### Step 4: Move the issue back to In Progress

Implementer picks it up only once this comment exists.

---

## Architecture Rules to Enforce in Every Plan

Модульные границы: `apps/bot`, `apps/backend`, `apps/web`, `apps/trading-worker`, `packages/db`, `packages/shared` (стек — `.claude/skills/tech-lead/SKILL.md` → Project Architecture Reference). Общий Drizzle-контракт и общие типы в `packages/shared` меняет только их владелец за волну (`.claude/CLAUDE.md` → Несколько параллельных агентов).

Инварианты ниже подтверждены кодом в `main` (2026-09-24). Это единственный полный список: reviewer, Codex-промпты и `.claude/CLAUDE.md` ссылаются сюда. Новый инвариант вносится только со ссылкой на место, где он enforced, и формулируется не шире этого места.

1. **Статусы.** Статусная колонка — `text` + CHECK из одной `as const`-константы на домен (`inList` в `packages/db/src/schema/columns.ts`); SQL-сравнения со значением — только через `literal()`/`sqlLiteralList`. Enforcement `partial` — ESLint `local/no-status-literal` (`tooling/eslint-rules/no-status-literal.ts`) вне файла определения константы ловит литерал (и template-литерал без подстановок) в позиции, чей тип — ровно множество значений константы: присваивание, аргумент, return, значение поля, `===`/`!==`/`==`/`!=` и `case` по объявленному типу (`s`, `row.prop`, `row['prop']`), а также `'значение'` из `[a-z0-9_-]` внутри `sql`-шаблона или `sql.raw`. Не ловит: вычисляемый доступ `row[key]` (сравнение идёт с суженным типом), позицию, типизированную шире (`string`) или подмножеством значений, нетипизированные копии списка (например, `z.enum([...])` без ссылки на константу), литералы в `*.test.ts`.
2. **Деньги и токены.** Токены — `bigint` (`tokenAmount`, `columns.ts`), денежные суммы — `numeric(20,8)` в string-mode из одного `money()` (`columns.ts`, все денежные колонки, #137) с CHECK против `NaN` (`positiveNumeric`; для сумм, которые бывают нулём, — `nonNegativeNumeric`), в коде — `DecimalString` из `@binarius/shared`; JS `number`/float для них не используется. На границе брокерского wire JSON-число становится `DecimalString` только в `moneyWireSchema` (`packages/shared/src/money.ts`), через `String()`, без арифметики: целое — только safe-int; дробное (#236) — только если `String()` даёт простую десятичную запись не длиннее `MAX_WIRE_SIGNIFICANT_DIGITS` (15) значащих цифр; `NaN`, `±Infinity`, целые от 2^53, экспоненциальная запись и 16+ значащих цифр отвергаются; текст с > 15 значащими цифрами, который `JSON.parse` округлил до короткого double, неотличим и принимается (`money.test.ts`). Ту же схему использует `partnerTraderStatsWireSchema.balance` (Partner API live не проверялся, #14). Единственное место, где JS `number` для денег создаётся намеренно, — `wireMoney` в `packages/mock-broker/src/money.ts`: фикстура изображает провод брокера и строит число из десятичного текста центов, без арифметики (`money.test.ts` мока). Кэш `users.token_balance`/`token_reserved` равен суммам `token_ledger` и пишется в одной транзакции со строкой леджера — `createInTransaction`, `releaseTokens`, `grantLinkBonus`, `consumeTokens` (`settleIntent`, #17: `settle` = `reserved_delta −1`, `balance_delta −1`); читается одним statement через `readTokenBalance` (`packages/db/src/token-balance-ops.ts`, #136). Равенство для этих четырёх writer'ов проверяет `token-balance-ops.db.test.ts`; для будущих writer'ов (#117, #109) правило stated, не enforced — триггера нет.
3. **Append-only.** `token_ledger` и `audit_log` отвергают UPDATE, DELETE и TRUNCATE — row- и statement-триггеры (`packages/db/drizzle/0001_append_only.sql`). Enforced: гейт покрытия в `schema.db.test.ts` требует наблюдать все четыре триггера.
4. **Владение строк — композитными FK**, не проверками в коде: `trade_intents_account_owner_fk`, `trade_intents_session_account_fk`, `deposit_events_account_owner_fk`, `token_ledger_intent_owner_fk`, `token_ledger_deposit_owner_fk`, `broker_trades_intent_account_fk`.
5. **Порядок блокировок** `users → broker_accounts → trade_intents → broker_trades` для всех писателей (`broker_trades` пишут только `markIntentAccepted`/`settleIntent`, #17; расчёт `broker_accounts` не блокирует; `concludeReconciled` (#89) блокирует `users` до `trade_intents`, как `rejectIntent`; остановка аккаунта в #90 блокирует `broker_accounts` до `markIntentManualReview`); `broker_accounts` блокируется `FOR NO KEY UPDATE` (`packages/db/src/trade-intent-ops.ts` — комментарий о порядке и `createTradeIntent`/`rejectIntent`; `packages/db/src/oauth-ops.ts`). `broker_balance_snapshots` — вне цепочки: её пишут только операции `packages/db/src/balance-snapshot-ops.ts`, каждая принимает `Db` (не транзакцию) и выполняется одним autocommit-statement'ом (Rule 21).
   `users → notification_jobs` — `markTelegramBlocked`, `setNotificationLevel` (`packages/db/src/delivery-ops.ts`): UPDATE строки `users` берёт её блокировку, затем `cancelPendingNotificationJobs` в той же транзакции; порядок записан в комментариях над `cancelPendingNotificationJobs` и `setNotificationLevel`, отмена проверяется `delivery-ops.db.test.ts`, сам порядок блокировок — не тестом.
6. **Переходы `trade_intents`** — только CAS внутри UPDATE (`status = from`, опционально `version` и предикат); возрастные предикаты — по часам БД (`trade-intent-ops.ts`). CAS — дисциплина операций (stated); единственный UPDATE `trade_intents`, не являющийся переходом, — `claimReconciling` (#89): статуса в SET нет (триггер не срабатывает), `version + 1`, предикат аренды, `reconcile_claimed_at = now()`; каждый UPDATE, меняющий `status`, идёт по ребру графа `TRADE_INTENT_TRANSITIONS` и поднимает `version` на 1 — enforced триггером `trade_intents_transition_guard` (`BEFORE UPDATE OF status`, миграция 0014; INSERT может нести любой статус — путь создания вставляет только `planned`, stated; копия графа сверяется сеткой всех пар в `schema.db.test.ts`, смена графа — новая миграция с `CREATE OR REPLACE FUNCTION`); «терминальный ⇔ резерв 0» — CHECK `trade_intents_terminal_reserve_check` (0013, из `TERMINAL_TRADE_INTENT_STATUSES`). Другие state machine'ы устроены иначе и этим правилом не покрыты: `outbox_events` — claim `for update skip locked` по `(id, status)`, затем update по `id` в той же транзакции (`apps/backend/src/outbox/store.ts`); `broker_accounts` — update по `id` под `FOR NO KEY UPDATE` в порядке блокировок, revocation по хешу refresh-токена там, где строка не заблокирована (`oauth-ops.ts`).
7. **Идемпотентность:** unique `(user_id, client_request_id)` (`trade_intents_user_request_idx`, миграция 0002); не больше одного нетерминального intent'а на аккаунт (`trade_intents_active_account_idx`); outbox — unique `(topic, intent_id)` (`outbox_events_topic_intent_key`); сделка брокера привязывается к intent'у ровно один раз — `broker_trades_account_trade_key` + `broker_trades_intent_id_key` (#17), терминальных строк леджера (`release`/`settle`) — не больше одной на intent (`token_ledger_terminal_intent_idx`); что она есть — правило писателей (`rejectIntent`/`settleIntent` читают резерв под блокировкой и пишут строку при > 0), stated.
8. **Ошибки логируются именем и кодом** через `errorIdentity`/`errorLogFields` (`packages/shared/src/logging.ts`). Enforcement `partial` — ESLint `no-restricted-syntax` (`eslint.config.js`; комментарий там — источник этого списка) видит поле `err`/`error`/`cause`/`exception` в первом объекте вызова логгера, в том числе у логгера, взятого в переменную (`const l = request.log; l.error({ err })`), и positional error по имени переменной. Не видит: вложенный объект (`{ ctx: { err } }`), объект вторым аргументом, computed key, `logger[level](error)`, метод логгера в переменной, spread, positional error в переменной, не названной как ошибка, `new Error(x)` позиционно. Redact-пути покрывают глубину 0–5 (`LOG_REDACT_PATHS`); строку они не чистят. Runtime-сеть (#85): все четыре процесса собирают pino-логгер через `logOptions` (backend и web отдают его Fastify как `loggerInstance`); сериализаторы ключей `LOG_ERROR_KEYS` (`err`, `error`, `cause`, `exception` — тот же список строит regex ESLint-правила) сводят значение на верхнем уровне лог-объекта к `{ name, code?, cause?: { name, code? } }` (cause — вложенно, в отличие от соседнего ключа у `errorLogFields`); объект проходит своим `name`, только если уже имеет форму identity (литерал с собственными ключами лишь `name`/`code`/`cause` той же формы), иначе — `typeof`; `hooks.logMethod` подставляет фиксированное `msg`, где pino скопировал бы `err.message`. Сеть не покрывает: ошибку под другим или вложенным ключом, format-аргумент (`%s`/`%o`), свободный текст сообщения, явно переданное сообщение (`error.message` в `defaultErrorLog`/`writeHeadError` Fastify — поэтому `SafeLogController` в backend остаётся, в web эти строки отключены `disableRequestLogging`). Логгеры, которые тесты строят сами (`pino()` без `logOptions`), — вне сети.
9. **500 непрозрачны:** наружу проходит только целочисленный 4xx, остальное — `{ error: 'internal' }` (`setErrorHandler` в `apps/backend/src/app.ts`). Wire-view собирается allowlist'ом полей, строка БД никогда не spread'ится (`brokerAccountViewSchema` в `packages/shared/src/oauth.ts`, `toTradeIntentView` в `trade-intent-ops.ts`).
10. **Цепочки таймаутов проверяются при импорте** в каждом процессе: `TIMING_CHAIN_HOLDS` в `apps/backend/src/timing.ts`, `apps/trading-worker/src/intents/config.ts` и `apps/bot/src/timing.ts`, а также `PAIRS_CATALOG_CHAIN_HOLDS` в `packages/broker-rest/src/pairs-catalog.ts` (таймаут REST-запроса, диапазон TTL каталога пар, потолок устаревания; `MAX_BROKER_PAIRS_TTL_MS + BROKER_REST_TIMEOUT_MS < BROKER_PAIRS_MAX_STALE_MS` — граница `fresh` каталога (#125) ниже потолка) (throw при нарушении) + тесты рядом. Снимок баланса брокера (#137) — в backend-цепочке: `BROKER_REST_TIMEOUT_MS < MIN_BALANCE_RECONCILE_INTERVAL_MS`, `MAX_BALANCE_RECONCILE_INTERVAL_MS <= BROKER_BALANCE_SLA_MS`, `MAX_BALANCE_POLL_PER_MINUTE < BROKER_RATE_LIMIT_PER_MINUTE`, `MAX_BALANCE_RECONCILE_INTERVAL_MS < BALANCE_STALLED_RETRY_MS < BALANCE_WATCH_WINDOW_MS`, `TRADING_ACCESS_REFRESH_BUDGET_MS < TRADING_ACCESS_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS`. Проход сверки (#89) — в цепочке worker'а: `BROKER_REST_TIMEOUT_MS < RECONCILE_ATTEMPT_TIMEOUT_MS < RECONCILE_RETRY_MS`, `RECONCILE_ATTEMPT_TIMEOUT_MS < SHUTDOWN_PHASE1_BUDGET_MS`, `RECONCILE_TICK_MS <= RECONCILE_RETRY_MS`; env-границы `env.ts` берутся из `timing.ts`. Сигнал (#258) — в backend-цепочке: `SIGNAL_FETCH_BUDGET_MS < BROKER_REST_TIMEOUT_MS`, `SIGNAL_FETCH_BUDGET_MS < TRADING_SIGNAL_BUDGET_MS < SHUTDOWN_PHASE1_BUDGET_MS`, `SIGNAL_CACHE_MAX_TTL_MS < SIGNAL_CHART_INTERVAL_MS['1m']`.
11. **Токены в покое** — AES-256-GCM, AAD = `keyId|accountId|field` с запретом `|` в частях, `token_key_id` для ротации (`packages/db/src/crypto.ts`, `broker-accounts.ts`).
12. **OAuth.** State хранится только хешем и одноразов через CAS по `used_at` (`oauth-states.ts`, `oauth-ops.ts`); аккаунт, привязанный через OAuth-callback (`linkBrokerAccount(…, activate: false)`), начинает с `pending` и активируется только подтверждением в боте (default колонки, миграция 0005); вход по почте (#162) — единственный путь с `activate: true`: аккаунт сразу `active`, стартовый пакет в той же транзакции; заблокированный пользователь не доходит до брокера (`oauth-ops.ts` → `user_blocked`); токен брокера не выдаётся аккаунту заблокированного пользователя: `refreshUnderLock` читает `users.status` тем же statement'ом, что блокирует аккаунт (`lockAccountForRefresh`, `for no key update of broker_accounts`, `users` не блокируется), до расшифровки и обмена (`token-service.db.test.ts`); блокировка, закоммиченная после выдачи токена, уже отправленный GET не останавливает (stated); callback принимает code+state только с подписанным Telegram `initData` владельца state — подпись и возраст проверяются до запроса в БД (`apps/backend/src/auth/telegram-init-data.ts`), id сравнивается с `oauth_states.telegram_user_id` из строки CAS до обмена кода (`apps/backend/src/auth/routes.ts`, #113); refresh: `revoked` проверяется до истечения, ровно одна попытка обмена, сбой → revocation, не retry (`apps/backend/src/auth/token-service.ts`, `docs/binodex-oauth.md` → Refresh). Обмен — только по действию пользователя: фоновый цикл баланса вызывает `ensureFreshAccessToken` с `mayRefresh: false`, и под блокировкой строки истекающий токен возвращает `refresh_needed` без обмена и без revocation по возрасту (`token-service.db.test.ts`); отбор кандидатов с валидным токеном (`listBalanceRefreshCandidates`, `accessSkewMs`) — оптимизация, не гарантия. Пустой или пробельный `user.email` брокера становится `null` в `toOAuthTokens` (`addressOrNull`, `packages/shared/src/oauth.ts`); та же функция — в `toBrokerAccountView`, `toLinkedAccountView`, `toUserStartView` для строк, записанных раньше (#214); CHECK на колонке нет — для будущего писателя правило stated.
13. **bot → backend:** общий bearer, сравнение за постоянное время (`timingSafeEqual` в `apps/backend/src/auth/internal.ts`); внутренний API полностью доверенный, чтения не скоупятся по пользователю (`docs/trade-intent-transport.md` → Boundaries).
14. **Env:** пустое значение — всегда ошибка; отсутствующее — ошибка для обязательной переменной (`readEnv` без fallback, `packages/shared/src/env.ts`) и default из кода для необязательной (`readEnv(source, name, fallback)`: `BROKER_PAIRS_TTL_MS`, `BALANCE_*`, `INTENT_MAX_AGE_MS`, `REAL_TRADING_ENABLED`); в compose обязательная — `${VAR:?}` (CI-guard в `.github/workflows/ci.yml`, job `compose`), необязательная — valueless-запись `VAR:` (forward только если задана; `${VAR:-}` вставил бы `""`), пин записи — `composeServiceEnvValue` в `apps/backend/src/timing.test.ts` / `apps/trading-worker/src/intents/config.test.ts`.
15. **Executor:** `rejected` — только когда ордер точно не открылся; throw → `unknown`; `accepted` — только с `OpenTrade` брокера (`SubmitResult.accepted` требует `transport` и `trade`), совпадающей с intent'ом по режиму, активу, направлению и сумме, иначе `unknown` (`trade_mismatch`) — `markIntentAccepted` (`packages/db/src/trade-intent-ops.ts`) и `persistOutcome` (`apps/trading-worker/src/intents/processor.ts`), #17; `detail` только в лог, обрезается до `MAX_DETAIL_LENGTH` при логировании (`persistOutcome` в `apps/trading-worker/src/intents/processor.ts`; константа — `packages/broker-rest/src/rest.ts`, та же, что режет `detail` брокера в REST-клиенте; контракт — `executor.ts`).
16. **Миграции forward-only**, каждое изменение схемы — с миграцией: CI (`ci.yml`, шаги «Schema changes carry a committed migration» и «Committed migrations are immutable»).
17. **Валидация на границах** (zod) — в роутах `apps/backend/src/*/routes.ts`; внутренний код доверяет провалидированным данным.
18. **Тексты пользователю в Telegram** — только `TelegramHtml` из `telegramHtml` в `packages/shared/src/telegram-html.ts`, `parse_mode: 'HTML'` ставят два seam'а (`apps/bot/src/send.ts`, `apps/backend/src/auth/link-notifier.ts`); подписи кнопок, описания команд и профиль бота (`PROFILE` в `apps/bot/src/texts.ts`: описание и короткое описание, лимиты 512/120 держит `texts.test.ts`) — plain, не экранируются. Enforcement `partial`: ESLint `no-restricted-syntax` (`eslint.config.js`, блок bot/auth) ловит прямые `.reply(`/`.sendMessage(`/… по точному имени метода вне seam'ов и вне `*.test.ts` (список — `RAW_TELEGRAM_SEND_METHODS` в `eslint.config.js`: методы Bot API с разбираемым текстом и их алиасы grammY, выведенные двумя командами из комментария над списком для `@grammyjs/types` 5.0.0 и grammy 1.46.0), не ловит метод в переменной и `apps/backend/src/admin` (служебный бот, plain text по решению владельца 2026-10-02); валидность — тестом рядом с каждой константой через `telegramTextProblems` (`@binarius/shared/testing`: `telegramHtmlProblems`, пустой текст, лимит длины, строка с пробелом по краю); `telegramHtmlProblems` проверяет список тегов и атрибутов, порядок закрытия, вложенность по Bot API (внутри `pre`/`code` — только `code` прямо в `pre`; `a`/`tg-emoji`/`tg-time`/`pre`/`code` друг в друга не вкладываются); вложенность с blockquote и `pre`/`code` внутри жирного и ему подобных не проверяется — Bot API её не определяет.
19. **Доставляемость в Telegram и уровень уведомлений.** Факт «пользователь заблокировал бота» — одна колонка `users.telegram_blocked_at` (NULL = доставка возможна), независимая от `users.status`; ставится `markTelegramBlocked` — в той же транзакции отменяет `pending`-задания `notification_jobs` этого пользователя (`delivery-ops.db.test.ts`) — из роута `POST /users/chat-member` и из `recordTelegramSendFailure` на 403 (`apps/backend/src/users/telegram-delivery.ts`); сегодня `recordTelegramSendFailure` вызывает только push после входа через сайт (`apps/backend/src/auth/routes.ts`); снимается `markTelegramReachable` и upsert'ом `/users/start` (`/start` и `/settings`, `user-ops.ts`). Уровень — `users.notification_level`, `text` + CHECK из `NotificationLevel` (`packages/shared/src/users.ts`, `users_notification_level_check`, `schema.db.test.ts`), пишется только `setNotificationLevel` из роута `POST /users/notification-level` (`delivery-ops.db.test.ts`, `routes.db.test.ts`); для `off` та же транзакция отменяет `pending`-задания через `cancelPendingNotificationJobs`. Решение об отправке читает колонки только через `deliverable()` = `telegram_blocked_at is null and notification_level <> 'off'` и `acceptsMailing()` = `deliverable()` и, для `reduced`, ни одного `sent`-задания с `sent_at` за последние `REDUCED_LEVEL_WINDOW_HOURS` (`packages/db/src/delivery-ops.ts`, `delivery-ops.db.test.ts`); кроме них уровень читает только `/users/start` для `/settings` (`toUserStartView`). Уровень не касается ответов на команды и кнопки, push после входа через сайт и итогов сделок пользователя (решение владельца 2026-10-03). Сегодня ни один отправитель не читает `deliverable()`/`acceptsMailing()`: рассылок нет. Enforcement `stated` для будущих отправителей (#123, #124, #202): каждый берёт задания с `acceptsMailing()` в запросе, пишет `sent`/`sent_at` на каждую рассылку и вызывает `recordTelegramSendFailure` при ошибке отправки.
20. **Сигнал v1 (`packages/signal/src/`, коды и wire-схема решения — `packages/shared/src/signal.ts`).** Решение — чистая функция от `candles`, `intervalMs`, `nowMs` и параметров (`createSignalDecider`, `decide.ts`): без часов, сети и логов. Направление выдаётся только по закрытым свечам без пропусков (`prepareCandles`, `candles.ts`: свеча, начинающаяся позже `nowMs`, — `invalid_candle/in_future`; формирующаяся (`timestamp ≤ nowMs < timestamp + intervalMs`) отбрасывается, шаг строго `intervalMs`, последняя закрытая не старше `maxStaleIntervals` интервалов, не меньше `minClosedCandles`), при согласии тренда и момента и ATR% внутри `[minAtrPct, maxAtrPct]`; любой дефицит данных или несогласие — `no_signal` с кодом из `NoSignalReason` (`packages/shared/src/signal.ts`), никогда throw и никогда значение по умолчанию (`candles.test.ts`, `decide.test.ts`). Числовой «уверенности»/вероятности в решении нет (решение владельца 2026-10-03). Throw — только на неверные параметры и неверные `intervalMs`/`nowMs` (`assertSignalParams`, проверяется при импорте для `DEFAULT_SIGNAL_PARAMS`; `assertSignalClock`). Фид (`feed.ts`, #133): окно запроса — `SIGNAL_CHART_LIMIT` (60) свечей до текущей границы интервала, `SIGNAL_CHART_LIMIT − 1 − maxStaleIntervals ≥ minClosedCandles` проверяется при импорте и при создании фида (`assertFeedLimit`, `feed-config.test.ts`, `feed.test.ts` F6); каждая строка журнала `signal decision` версии `v1` повторяется в то же решение `replaySignalJournalEntry` (`journal.test.ts`, `feed.test.ts`); ошибка REST — `fetch_failed` с кодом клиента, одна строка `warn`, без повтора. Первый потребитель через границу процесса — `POST /trading/signal` (#258): кэш `createCachedSignalFeed` по `(assetId, interval)` держит `decided` до конца свечи, не дольше `SIGNAL_CACHE_MAX_TTL_MS`, `rate_limited` — на `retryAfterSec`; остальные сбои не держатся; параллельные запросы делят один fetch под собственным дедлайном кэша (`cache.test.ts`); каждое решение декайдера проходит `signalDecisionSchema` (`decide.test.ts` D15).
21. **Снимок баланса брокера (#137, #235).** `broker_balance_snapshots` — одна строка на аккаунт (FK `broker_balance_snapshots_account_fk`); пишут только операции `packages/db/src/balance-snapshot-ops.ts`, каждая — один autocommit-statement на `Db`. `*_observed_at`/`*_event_at` и возрасты — по часам БД; возраст будущей метки — 0, NULL остаётся NULL (`case … greatest(0, …)`); `fresh = min(restSnapshotAgeSec, balanceEventAgeSec ?? ∞) <= BROKER_BALANCE_SLA_SEC` (`isBalanceFresh`, `packages/shared/src/broker-balance.ts`). Запись проверяет домен колонок до statement'а и возвращает `{ written: false, field }` (`balanceSnapshotOutOfDomain`: суммы без знака, ≤ 12 целых и ≤ 8 дробных цифр; `level.rank` — по десятичной форме; `level.code` — 1–64 code points без управляющих символов, enforcement `partial`: только писатель, колонка без CHECK; `balance-snapshot-ops.db.test.ts`). Писатель сверяет `id` ответа брокера с `broker_accounts.broker_user_id` до записи (`balance-reconciler.db.test.ts`). Фоновый цикл: кандидаты — «аккаунты в работе» с валидным токеном, порядок `greatest(rest_observed_at, last_refresh_failed_at) asc nulls first` (`balance-snapshot-ops.db.test.ts`); попытка, не оставившая следа в строке (в том числе throw и `user_blocked`), откладывается в памяти на `BALANCE_STALLED_RETRY_MS`, неожиданная ошибка в тике логируется только через `errorLogFields` (`balance-reconciler.db.test.ts`). Для будущих писателей (#99/#101 — `user.data` через `upsertBalanceSnapshot`, `update_balance` через `applyBalanceEvent`; #100 — `refresh()` после `accepted`, #92 — после сверки) правило `stated` (`docs/broker-balance.md` → Contract for the socket writers).
22. **Real-режим за флагом (#134).** `real`-intent создаётся только при `REAL_TRADING_ENABLED=true` у backend (`createInTransaction`, `packages/db/src/trade-intent-ops.ts`: после replay, до чтения аккаунта и резерва — `trade-intent-ops.db.test.ts`) и уходит в executor только при `true` у worker (`realTradingGate` — самый внешний слой над executor'ом, `apps/trading-worker/src/intents/executor.ts`; `executor.test.ts`, `processor.db.test.ts`); имя, default `false` и разбор (ровно `true`/`false`) — `parseRealTradingEnabledEnv` (`packages/shared/src/env.ts`, `env.test.ts`); compose передаёт одно значение `.env` обоим сервисам (`timing.test.ts`, `config.test.ts`), каждый процесс читает свой `process.env` при старте. Replay возвращает существующий real-intent при любом состоянии флага (правило «replay first»). Флаг — на процесс: backend и worker, перезапущенные в разные моменты, могут разойтись — `stated`; безопасно в обе стороны (ничего не создаётся / создаётся и отклоняется с release). Demo флагом не ограничивается.
23. **Размер ставки v1 (`apps/trading-worker/src/stake/`).** Решение — чистая функция от параметров и входа (`createStakeSizer`, `size.ts`): без часов, сети, БД и логов. Деньги — `DecimalString` на входе и выходе, арифметика — `bigint` со шкалой 8 (`money.ts`, домен 12/8 сверен с `tradeAmountSchema` в `money.test.ts`); payout брокера (`number`) становится целым шкалы 4 через `String()` без арифметики (`parsePayout`); JS-float для денег не создаётся, `bigint` в решение не попадает (`size.test.ts`, JSON round-trip). Превышение лимита, ставка ниже `min_trade_amount` или выше `available`, неразрешённая заявка в истории и непригодные данные — `stop` с кодом из `StopReason` (`codes.ts`) в фиксированном порядке проверок, никогда подгонка ставки и никогда пропуск шага; throw — только на неверные параметры (`assertStakeParams`, при импорте для `DEFAULT_STAKE_PARAMS`) и неверные часы. Шаг Мартингейла — наименьшая ставка на шкале `stakeScale`, чей профит `floor_s(stake × payout/100)` покрывает `ceil_s(убыток серии + профит базовой ставки)` (`size.test.ts`, сетка через `next()`); кандидат выше `maxStake` останавливается до форматирования, поэтому `amount` ставки всегда проходит `tradeAmountSchema` (`size.test.ts`, S20 и S21). Лимиты Мартингейла обязательны по типу `StakeParams` и в `assertStakeParams`; `DEFAULT_STAKE_PARAMS` — `fixed`. Подключение к сессии, env и `trading_sessions.settings` — #130 (stated).

---

24. **Проход сверки (#89, `apps/trading-worker/src/intents/reconciliation.ts`).** Кандидаты — `status = reconciling and (reconcile_claimed_at is null or reconcile_claimed_at < now() − RECONCILE_RETRY_MS)`, порядок `reconcile_claimed_at asc nulls first` (один SQL-фрагмент `reconcileLeaseExpired` для списка и claim'а, `trade-intent-ops.ts`). Claim (`claimReconciling`) — первая запись каждой попытки, до обращения к брокеру: ни один исход не оставляет ключ порядка на месте (`reconciliation.db.test.ts`). `accepted` из `reconciling` — только через `concludeReconciled` с найденной сделкой брокера (закрытая — `accepted → settled` в той же транзакции); единственное освобождение резерва из `reconciling` — `rejectIntent` на `not_found` реконсилера (`reconciliation_not_found`); `unavailable`, дедлайн попытки и throw не пишут ничего, кроме claim'а; каждый исход — CAS по `status = reconciling` и `version` из claim'а (`trade-intent-ops.db.test.ts`, `reconciliation.db.test.ts`). Порт `IntentReconciler` только читает и никогда не открывает сделку; уверенность его `not_found` — `stated`, правило — у реализации (#90).

## Forbidden Actions

- Never push to `main` or merge a PR.
- Never write code — the Architect's output is the plan only.
- Never move an issue to In Review — that's the Implementer's job.
- Never skip domain scope analysis.
- Never skip the Codex plan-review checkpoint (Step 7, and Returned from Review Step 2 when it opens a new cycle). If Codex is unavailable, say so explicitly in the plan handoff.
- Never post a plan whose size estimate exceeds 3000 added lines — split first (Step 4a).
- Never call `AskUserQuestion` when running as a spawned agent — return the questions to tech-lead.
