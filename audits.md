# Audit Log

---

## #2 — Bootstrap pnpm monorepo skeleton (2026-09-22)

PR #45, rebase-merged as `722d288` + `513dfb9`.

### Process audit

| Role        | Step                         | Result                                                                                                                                                                                                     |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tech Lead   | Preflight                    | OK: Codex ready, `gh auth` valid, `main` current. Gap: token scopes not checked against the issue's file list; `workflow` scope was missing and surfaced only at push.                                     |
| Tech Lead   | `/clarify`                   | 4 questions: scope (all 4 Todo issues), branching (wait for #2 to merge), autonomy (continue through the batch), #6/#7 strictly sequential.                                                                |
| Tech Lead   | Merge order                  | #2 → #3 → #6 → #7 (#7 depends on #2 + #6 and needs #3's Postgres for its acceptance check).                                                                                                                |
| Architect   | `/clarify`                   | 4 questions (ESM, per-package Vitest test, flat ESLint, `tsc -b`) + 1 follow-up after Codex (Node 22).                                                                                                     |
| Architect   | Plan + Codex plan review     | Posted before In Progress. Codex Major (Vitest 5 requires Node ≥ 22.12, Node 20 EOL) verified via `npm view` and folded in; 3 Codex Minors folded in.                                                      |
| Implementer | `/clarify`                   | 4 questions (README, caret deps, single commit, `index.test.ts`).                                                                                                                                          |
| Implementer | Branch / commit / PR         | `feat/2-bootstrap-pnpm-monorepo`, `#2: bootstrap pnpm monorepo skeleton`, PR #45 with `Closes #2` and test plan; files staged by name. Push required switching `origin` to SSH (see preflight gap).        |
| Implementer | Deviation flagged            | `typescript ~6.0.3` instead of caret: `typescript-eslint@8.70.1` peer-caps at `<6.1.0`, latest is 7.0.2.                                                                                                   |
| Reviewer    | Iteration 1                  | Codex + security + code-review high + simplify. 1 Major (entry points at unbuilt `dist/`, independently reproduced) + 5 Minor → PR comment, issue → Todo.                                                  |
| Architect   | Plan Update + Codex re-check | `/clarify` 3 questions (exports → src, root-only engines, all Minors in scope). Codex re-check 3 Minors (CI masks the guard, Node range admits 23/25, `--filter` command doesn't exist) folded in.         |
| Implementer | Iteration 1 fix              | `/clarify` 3 questions. 20 files, lockfile untouched. Deviation flagged: `tsBuildInfoFile` into `dist/` (TS6305 from composite up-to-date semantics), verified with fresh-clone and stale-cache replays.   |
| Reviewer    | Re-review                    | Codex + security + code-review high + simplify: no Blocker/Major, cosmetic nits only. CI green, single run. Per-merge `AskUserQuestion` → rebase merge, branch deleted. Done only after `state == MERGED`. |

### Review iterations: 1

### Findings

| Finding                                                                                                                                                                             | Severity                             | Класс | Root cause                                                                                                                                                                                 | Missed at step                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `packages/shared`/`packages/db` entry points at `./dist/index.*`, built only by `tsc -b` under `typecheck`; real cross-package imports fail on standalone `pnpm test` / fresh clone | Major                                | unverified-claim | Entry points added on Codex suggestion without a build guarantee; placeholder tests cannot observe resolution; plan's verification ran typecheck before test, masking the order dependency | Architect Step 6/7, Implementer Step 5 |
| `engines.node >=22.12.0` below ESLint 10's Node-22 floor (`22.13.0`) and admitting Node 23/25 (excluded by Vitest 5)                                                                | Minor                                | unverified-claim | Floor derived from one tool's `engines`, not the toolchain intersection                                                                                                                    | Architect Step 6                       |
| CI ran twice per PR commit; `node-version` hardcoded beside `.node-version`; `engines` copied into 7 manifests                                                                      | Minor                                | single-source | First-draft defaults, no "single source per fact" pass                                                                                                                                     | Architect Step 6                       |
| `tsBuildInfoFile` default beside `tsconfig.json`; composite `tsc -b` trusts the cache and never stats outputs → TS6305 after `rm -rf */dist`                                        | Deviation (caught in implementation) | unverified-claim | TypeScript composite semantics; Plan Update named only the fresh-clone scenario                                                                                                            | Architect Plan Update                  |
| `gh` OAuth token lacked `workflow` scope for `.github/workflows/ci.yml`                                                                                                             | Process                              | preflight | Preflight checks auth validity, not required scopes                                                                                                                                        | Tech Lead Phase 0                      |

### Process improvement proposals

1. Architect validation checklist: every `package.json` entry point must resolve to committed source or to output produced by a step the check command itself runs. — **внедрено в #61: `tooling/manifest-targets.test.ts` → гейт в `pnpm check`**
2. Implementer self-review: run the check command once from a build-output-free state (`rm -rf **/dist` first) before committing. — **внедрено в #61: `package.json` → скрипт `check` (`tsc -b --clean` первым); `.claude/skills/implementer/SKILL.md` → Step 5**
3. Architect: when setting `engines`, record `npm view <tool> engines` for every root devDependency and state the intersection in the plan. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, таблица классов задач, строка «Toolchain / engines / Node version»; `.claude/codex-plan-review-prompt.md` → check 13**
4. Architect, tooling/build plans: enumerate fresh-clone, stale-cache, and incremental scenarios explicitly. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, таблица классов задач, строка «Toolchain / engines / Node version»; `.claude/codex-plan-review-prompt.md` → check 13**
5. Architect checklist for config issues: "single source per fact" (workflow triggers, Node version, engines). — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, Validation checklist «Single source per fact»; `.claude/codex-plan-review-prompt.md` → check 12 (объединено с #3 п.3)**
6. Tech Lead preflight: if the plan's file list includes `.github/workflows/*`, verify the `workflow` scope or an SSH remote before implementation. — **внедрено в #61: `.claude/skills/tech-lead/SKILL.md` → Phase 0, п.2 (GitHub)**
7. Reviewer: do not run the check command concurrently with a spawned `/code-review` agent on the same tree; its recipe runs `pnpm typecheck` regardless of the prompt. — **внедрено в #61: `.claude/skills/reviewer/SKILL.md` → Step 3 «Order of launch», Step 5 → Runtime check**
8. Hardening follow-ups surfaced (owner decides whether to file): `emitDeclarationOnly` in `tsconfig.base.json`; CI `concurrency` group; `.npmrc` `engine-strict=true`; replace deprecated `tseslint.config()` with `defineConfig`; cosmetic cleanups (dead top-level `types`, `*.tsbuildinfo` gitignore line, README/CI comment wording). — **вынесено в #57**

---

## #3 — Docker Compose dev-окружение (2026-09-22)

PR #47, rebase-merged as `c073c19` + `27b63ad` + `c0ccbd3`.

### Process audit

| Role        | Step                           | Result                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tech Lead   | Preflight                      | Docker absent on the dev machine — found during the architect pass, not Phase 0. Owner chose Colima + docker CLI (Homebrew); `docker-buildx` added later so the local builder matches CI.                                                                         |
| Architect   | `/clarify`                     | 4 questions (Docker, container scope, healthcheck depth, env contract).                                                                                                                                                                                           |
| Architect   | Plan + Codex plan review       | Codex 7 Major + 4 Minor (placeholder liveness, YAML shallow merge, pg connect timeout, URI-encoded credentials, LAN ports, `quit()` rejection, env validation depth) — all verified and folded in before posting.                                                 |
| Implementer | `/clarify`                     | 4 questions (timeout-test technique, CI job placement, container user, commit granularity).                                                                                                                                                                       |
| Implementer | Build / verify                 | Real `up --wait`, degraded path, watch restart on own and shared `src`, graceful `down`. Two plan errors found and flagged: `lazyConnect` + no offline queue failed the first probe; `localhost` resolves to `::1` on Alpine.                                     |
| Reviewer    | Iteration 1                    | Codex + security + code-review high + simplify. CI red (`initial_sync` rejected by the runner's Compose) + failure-path steps dying on the same validation → 2 Major, 10 Minor → Todo. Two review agents died on an API 403 and were relaunched on another model. |
| Architect   | Plan Update 1 + Codex re-check | `/clarify` 4 questions. Codex 5 Minors folded in (`${VAR}` still injects `""` → valueless entries; root manifest before `pnpm fetch` for the Corepack pin; `%FF`/IPv6 host checks; `LogLevel` import site; log the failing check's error).                        |
| Implementer | Iteration 1                    | `/clarify` 3 questions; empirical check of valueless-entry semantics; 12 files; owner-confirmed `HEALTH_TIMEOUT_MS` env instead of a constant.                                                                                                                    |
| Reviewer    | Re-review 1                    | No Blocker/Major; Minors → LGTM. Codex ran in background mode after a foreground timeout. Owner chose one more iteration on Minors 1–4 at the merge checkpoint.                                                                                                   |
| Architect   | Plan Update 2 + Codex re-check | `/clarify` 4 questions. Codex attempt 1 failed (no network in sandbox; context inlined on retry); re-check: probe comment must not promise a body; `down -v` noted as destructive (dev volume empty until #7).                                                    |
| Implementer | Iteration 2                    | `/clarify` 3 questions; 6 files. Found and reverted the shared `image:` tag (concurrent one-tag builds collide under the classic builder). Fail-fast check needed to run without `tsx watch`.                                                                     |
| Reviewer    | Re-review 2                    | All four passes clean (Codex re-run in background after a 10-minute foreground kill). Per-merge `AskUserQuestion` → rebase merge, branch deleted. Done after `state == MERGED`.                                                                                   |

### Review iterations: 2 (1 reviewer-returned, 1 owner-requested)

### Findings

| Finding                                                            | Severity           | Класс | Root cause                                                        | Missed at step                       |
| ------------------------------------------------------------------ | ------------------ | ----- | ----------------------------------------------------------------- | ------------------------------------ |
| `initial_sync` rejected by the CI runner's Compose                 | Major              | env-parity | Compose features verified only against Homebrew's version         | Architect Step 7, Implementer Step 5 |
| CI failure-path steps died on the same validation                  | Major              | unverified-claim | Diagnostics assumed compose itself cannot fail pre-build          | Architect Step 6                     |
| `env_file` on the shared anchor leaked `.env` into every container | Minor              | single-source | Two injection paths for one contract                              | Architect Step 6                     |
| `${VAR:-}` injected `""` for secrets                               | Minor              | unverified-claim | Interpolation semantics assumed                                   | Architect Step 6                     |
| `lazyConnect` first-probe failure; `localhost` → `::1`             | Minor (pre-review) | unverified-claim | Client/probe details not exercised until the real stack ran       | Architect Step 6                     |
| `HEALTH_TIMEOUT_MS` env vs fixed probe timeout                     | Minor              | unverified-claim | Clarify-driven change altered an invariant held only in prose     | Implementer clarify                  |
| Shared `image:` tag collided under the classic builder             | Minor              | unverified-claim | Optional suggestion accepted without local reproduction           | Reviewer Step 4                      |
| Docker / buildx absent locally                                     | Process            | preflight | Preflight did not check the runtimes the acceptance criteria need | Tech Lead Phase 0                    |

### Process improvement proposals

1. Architect: for CI-executed tooling, verify every feature against the runner image's version, not the local one. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, Validation checklist «CI-executed tooling» и строка «CI workflow»; `.claude/codex-plan-review-prompt.md` → check 11**
2. Architect: diagnostic/cleanup CI steps must tolerate the failure they exist to diagnose. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, таблица классов задач, строка «CI workflow»**
3. Architect: apply "single source per fact" to env delivery and secrets scoping, not only versions. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, Validation checklist «Single source per fact» (объединено с #2 п.5)**
4. Architect: verify Compose interpolation/env semantics with `docker compose config` before planning; probes target `127.0.0.1`; lazily-connecting clients cannot pass their own first check. — **отклонено: факты конфигурации (probes на 127.0.0.1, lazy-клиент не проходит свой первый probe), уже закреплены в compose.yaml и коде (решение владельца 2026-09-24); правило про `docker compose config` уже входит в architect Step 6 → «Compose / env»**
5. Implementer: when a clarify answer changes a plan constraint, state the affected invariant in the PR body. — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 7, шаблон PR «Deviations / clarify-driven invariant changes»; Step 5.5**
6. Reviewer: re-verify "optional improvement" suggestions like findings before folding them into a Plan Update; two simplify sub-agents recommended the exact CI breaker. — **внедрено в #61: `.claude/skills/reviewer/SKILL.md` → Step 4; `.claude/skills/architect/SKILL.md` → Workflow — Issue Returned from Review, Step 2**
7. Tech Lead preflight: verify every runtime the acceptance criteria exercise, including plugin parity with CI. — **внедрено в #61: `.claude/skills/tech-lead/SKILL.md` → Phase 0, п.4 (Runtimes)**
8. Codex checkpoints: inline all context (no network in the sandbox); run long reviews in background mode and poll `status`/`result`. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 7; `.claude/skills/reviewer/SKILL.md` → Step 3, 3a (объединено с #42 п.7)**
9. Follow-up candidates: consolidated in the iteration-2 LGTM comment on PR #47. — **вынесено в #58**

---

## #6 — Shared contracts: money, trading, broker, oauth, partner, socket (2026-09-22)

### Process audit

| Role        | Step                     | Result                                                                                                                                                                                                                          |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architect   | Plan + Codex plan review | Plan posted before In Progress (8-question clarify); Codex Blocker (string-only wire money) folded in                                                                                                                           |
| Architect   | Plan Update after review | Posted before re-implementation (4-question clarify); Codex re-check attempt 1 died mid-run, attempt 2 hit the Codex usage limit — partial result accepted by owner decision; M3 withdrawn after `tsc --listFiles` verification |
| Implementer | Branch / commits / PR    | `feat/6-shared-contracts`; `#6:` commits; PR #48 with `Closes #6`, test plan, iteration section; In Review right after push; diff limited to `packages/shared`                                                                  |
| Implementer | Check command            | Green both iterations (16/187 → 17/233 tests); prettier clean; nine subpaths verified through tsx                                                                                                                               |
| Reviewer    | Iteration 1              | Codex + security + code-review high + simplify; M1, M2 valid, M3 false positive; returned to Todo                                                                                                                               |
| Reviewer    | Rerun                    | Codex + three agents; all first-review findings closed; no Blocker/Major; 6 Minors; LGTM; merge asked via AskUserQuestion                                                                                                       |
| Tech-lead   | Merge / Done             | Rebase merge `243902a`, branch deleted; Done only after `state == MERGED`                                                                                                                                                       |
| Tech-lead   | Process                  | Commit/push autonomy was exercised while the waiver lived only in unmerged PR #1; surfaced to the owner, PR #1 merged 2026-09-22                                                                                                |

### Review iterations: 1

### Findings

| Finding                                                                                                                                    | Severity               | Класс | Root cause                                                                           | Missed at step                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| Partner `uid` string-only vs `int \| string` id policy                                                                                     | Major                  | single-source | Id policy stated in prose, no shared primitive                                       | Architect plan (entity list)            |
| No pre-submit failure edge in the transition table                                                                                         | Major                  | unverified-claim | Table transcribed from the plan's reading of ARCH-03, not derived from the diagram   | Architect clarify                       |
| d.ts "collides with auto-included `@types/node`"                                                                                           | Major (false positive) | unverified-claim | Reviewer assumed TS ≤5 defaults; TS 6 defaults `types` to `[]`                       | Reviewer Step 4 (verify tooling claims) |
| `assets_update` union proposal does not narrow                                                                                             | Minor                  | unverified-claim | Narrowing asserted without a probe                                                   | Architect plan (tsc probe)              |
| Nine missing `safeParseX`, untyped chart params                                                                                            | Minor                  | instance-vs-class | Parsers/params not enumerated in the coverage table                                  | Architect plan                          |
| Rerun Minors: `canTransition` prototype keys, Partner `source` strict, `asset_id` positivity, decoder comment, weak tests, envelope marker | Minor                  | instance-vs-class | Constraint changes applied to the named entity only; comment written from assumption | Implementer self-review                 |
| Autonomy waiver only in unmerged PR #1                                                                                                     | Process                | preflight | CLAUDE.md change never merged; harness loads the checked-out branch's copy           | Tech-lead Phase 0                       |
| Codex usage limit mid-pipeline                                                                                                             | Process                | codex-ops | Shared quota, reset 15:18                                                            | Tech-lead Phase 0                       |

### Process improvement proposals

1. Phase 0 preflight: `git diff origin/main -- .claude/CLAUDE.md` must be empty; check Codex quota/reset time with availability. — **внедрено в #61: `.claude/skills/tech-lead/SKILL.md` → Phase 0, п.1 (Codex, бюджет) и п.3 (Project CLAUDE.md on main) (объединено с #9 п.6)**
2. Reviewer: verify tooling-level claims with the tool before labeling a Major; severity re-verification applies to own findings. — **внедрено в #61: `.claude/skills/reviewer/SKILL.md` → Step 4**
3. Architect: back every type-inference claim with a `tsc` probe; enumerate every parser and request shape in the domain coverage table. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 3 (строки парсеров и request shapes), Step 6 → Validation checklist «type-inference claim»; `.claude/codex-plan-review-prompt.md` → check 14**
4. Implementer self-review: when relaxing or tightening a constraint, grep the domain for the same construct before committing. — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 5.5 «Class, not instance» (объединено с #7 п.4, #9 п.4)**

---

## #7 — Drizzle-схема ядра домена (2026-09-22)

### Process audit

| Role        | Step                  | Result                                                                                                                                                                                         |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architect   | Plan + Codex review   | План до In Progress; Codex дал 8 Major, все учтены до реализации                                                                                                                               |
| Architect   | Plan Updates ×3       | Каждый до начала правок, каждый с Codex-перепроверкой. Итерация 3: Codex нашёл 1 Blocker + 1 Major + 2 Minor **в самом плане**; итерация 4: 5 Minor, два из них предотвратили ухудшение тестов |
| Implementer | Branch / commits / PR | `feat/7-drizzle-schema`, 8 коммитов `#7:`, PR #49 с `Closes #7`; кросс-пакетная правка вынесена отдельным коммитом                                                                             |
| Implementer | Check command         | Зелёный на каждой итерации; 68 → 359 тестов                                                                                                                                                    |
| Reviewer    | Итерации 1–4          | Codex + security + code-review high (+ simplify на первой). Возвраты: 8 Major → 2 Major → 1 Major → 0                                                                                          |
| Reviewer    | Финал                 | Blocker/Major нет у всех троих, Codex чист два круга подряд; 43 конверсии сверены парсером                                                                                                     |
| Tech-lead   | Merge / Done          | Rebase `686aa2b` после подтверждения владельца; Done только после `state == MERGED`                                                                                                            |

### Review iterations: 4

### Findings

| Finding                                                                 | Severity        | Класс | Root cause                                                             | Missed at step                       |
| ----------------------------------------------------------------------- | --------------- | ----- | ---------------------------------------------------------------------- | ------------------------------------ |
| MATCH SIMPLE в композитном FK `deposit_events`                          | Major           | unverified-claim | Семантика match не была указана в плане                                | Architect                            |
| `manual_review` как терминальный статус                                 | Major           | other | Один предикат использован для двух разных вопросов                     | Architect (перенесено из итерации 1) |
| `bonus` занимает единственный слот депозита                             | Major           | unverified-claim | Разрешение и ограничение из одного плана не проверены на совместимость | Architect                            |
| CHECK, проходящий на NULL (дважды: в коде и в плане, который его чинил) | Major           | unverified-claim | Предикат описан прозой, а не выполнен                                  | Architect                            |
| TRUNCATE мимо row-level триггеров                                       | Major           | instance-vs-class | Область действия механизма не проверена                                | Architect                            |
| Литералы статусов вне одного файла (дважды)                             | Minor           | instance-vs-class | Правило применено к сущности, а не к домену                            | Implementer                          |
| 23 констрейнта без тестов                                               | Major (скрытый) | unverified-claim | Чеклист утверждал покрытие, которое никто не проверял                  | Architect + Implementer              |
| Комментарий обещает больше, чем DDL (×4)                                | Minor           | unverified-claim | Комментарий не считался предметом проверки                             | Reviewer                             |

### Process improvement proposals

1. Таблица охвата перечисляет инварианты со статусом enforced / partially enforced / stated — «N из M» четырежды маскировало неполноту. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 3, колонка «Enforcement»**
2. Каждый CHECK выполняется на NULL/boundary-случаях до попадания в план (введено после итерации 1, сработало на итерации 2 — поймало ошибку в самом Plan Update). — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, Validation checklist и строка «Schema / constraints»; `.claude/codex-plan-review-prompt.md` → check 8**
3. Разрешение и ограничение из одного плана проверяются на совместимость. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, Validation checklist «permission × restriction»; `.claude/codex-plan-review-prompt.md` → check 9**
4. Перенос правила — `grep` по домену, а не по названному файлу. — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 5.5 «Class, not instance» (объединено с #6 п.4)**
5. Покрытие проверок обеспечивается исполняемым гейтом, а не утверждением в чеклисте: поведенческая версия при добавлении нашла 23 непокрытых констрейнта. — **внедрено в #61: `packages/db/src/schema.db.test.ts` → describe «constraint coverage» (CHECK, unique, FK, триггеры)**

---

## #42 — ARCH-03: transport торгового intent (bot → backend → trading-worker) (2026-09-23)

PR #51, rebase-merged as `109ab57` (18 commits), branch deleted. Migration 0002 shipped in the same PR.

### Process audit

| Role        | Step                           | Result                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tech Lead   | Preflight                      | OK: git current, `gh` valid, Codex ready, session on Fable. `/clarify` 4 вопроса (порядок #42 → #9 → #22 → #34 → #35-A, строго последовательно, все до мержа). Merge order: активных веток нет; #9 идёт после #42 (общие `apps/backend` + `packages/db`).                        |
| Architect   | `/clarify`                     | 8 вопросов в двух блоках (резерв токена, auth bot→API, размещение publisher'а, executor-заглушка, TTL, ACK/timeout, bot-сторона, тесты на реальном Redis).                                                                                                                       |
| Architect   | Plan + Codex plan review       | План до In Progress; допущения проверены по исходникам (BullMQ 6.3.8 запрещает `:` в jobId — комментарий #7 был невыполним; Lua-дедуп; drizzle lock strength; pg bigint). Codex 2 раунда: 2 Blocker + 11 Major + 3 Minor, затем 3 Major + 5 Minor — все учтены до публикации.    |
| Implementer | `/clarify`                     | 4 вопроса (коммит на шаг, тесты падают без REDIS_URL, docs на английском, temp-БД с автоуборкой).                                                                                                                                                                                |
| Implementer | Build / verify                 | 7 коммитов по шагам + 1 self-review; check-команда на каждом шаге и из дерева без `dist/`; `db:generate` без diff; e2e через compose. Тест роутов нашёл реальный баг (Zod 4 выполняет `.refine` после провала `.regex` → 500 вместо 400).                                        |
| Reviewer    | Iteration 1                    | Codex + security + code-review high + simplify. Первый simplify-агент разложился на 4 суб-агента и был прерван — перезапущен с запретом вложенных агентов. 6 Major + 8 Minor → Todo.                                                                                             |
| Architect   | Plan Update 1 + Codex re-check | `/clarify` 4 (+1 после Codex: замена индекса per-account на per-user). Codex re-check: M3 частично + 2 новых Major + 6 Minor — учтены.                                                                                                                                           |
| Implementer | Iteration 1                    | `/clarify` 4; 6 коммитов (миграция 0002 с осознанным DROP старого индекса, lock order, per-topic policy, error handler, shutdown, DLQ drain, общие фикстуры); deadlock-тест доказан на старом порядке блокировок (падает за ~1 с).                                               |
| Reviewer    | Iteration 2                    | 1 Major (бюджет shutdown backend < дедлайн `add` — внесён итерацией 1) + 8 Minor → Todo. Второй возврат → остановка по правилу pipeline, владелец разрешил итерацию 2.                                                                                                           |
| Architect   | Plan Update 2 + Codex re-check | `/clarify` 3; Codex: 3 «Major» (два — о формулировке гарантии бюджета, один реальный: sweep после `has()`) + 6 Minor — учтены; числа 10 с / 4 с / 20 с.                                                                                                                          |
| Implementer | Iteration 2                    | `/clarify` 3; 5 коммитов. Отклонение процесса: коммит `7b15513` прошёл при красном полном прогоне (`pnpm test \| grep … && git commit` — код выхода grep'а); корень — гонка latch с остаточными строками в publisher-тестах — исправлен в `5e65f61`; три полных прогона зелёные. |
| Reviewer    | Iteration 3                    | Codex + security + code-review high + simplify: Blocker/Major нет, 6 Minor → follow-up-кандидаты в LGTM. CI зелёный. `AskUserQuestion` → rebase merge, ветка удалена; Done только после `state == MERGED`.                                                                       |
| Tech Lead   | Model policy                   | По транскрипту все ассистентские сообщения сессии — `claude-fable-5-1`: `model:` во frontmatter `/implementer`/`/reviewer` не переключил модель при вызове `Skill()` внутри хода. Minor (стоимость); допущение в CLAUDE.md опровергнуто.                                         |
| Tech Lead   | Codex ops                      | Попытка 1 re-check плана умерла при блокировке машины (companion-процесс убит, запись в runtime висела); восстановлено через `status --json`/`result`; далее все Codex-вызовы — background mode с поллингом.                                                                     |

### Review iterations: 2 (обе — возврат ревьюера)

### Findings

| Finding                                                                                             | Severity | Класс | Root cause                                                                        | Missed at step             |
| --------------------------------------------------------------------------------------------------- | -------- | ----- | --------------------------------------------------------------------------------- | -------------------------- |
| Тело 500 раскрывает SQL и параметры (`DrizzleQueryError.message`)                                   | Major    | unverified-claim | План утверждал «default 500 без тела ошибки БД», не проверив исполнением          | Architect Step 6           |
| `clientRequestId` уникален per user только контрактом; повтор с другим аккаунтом даёт второй резерв | Major    | instance-vs-class | Ограничение применено к одной сущности (account), а не к домену (user)            | Architect (таблица охвата) |
| Reconciliation-строки outbox исчерпывались в `failed` навсегда                                      | Major    | instance-vs-class | Политика exhaustion описана для одного топика, реализована topic-agnostic         | Architect                  |
| Deadlock rejection (intent→users) vs creation (users→intent index)                                  | Major    | instance-vs-class | Порядок блокировок задан только для пути создания                                 | Architect                  |
| `tick()`/`sweep()` не проверяли остановку                                                           | Major    | unverified-claim | Контракт `stop()` заявлен в комментарии, не в коде                                | Implementer                |
| Бюджет shutdown worker'а < дедлайн executor'а                                                       | Major    | unverified-claim | Бюджет выбран относительно grace, а не операции                                   | Architect                  |
| Бюджет shutdown backend < дедлайн `add` (внесён итерацией 1)                                        | Major    | instance-vs-class | Та же ошибка на втором процессе; Plan Update 1 описал цепочку только для worker'а | Architect Plan Update 1    |
| Redact-пути покрывали глубину 3, комментарий обещал 4–5                                             | Minor    | unverified-claim | Покрытие заявлено прозой, не проверено на pino                                    | Implementer                |
| Publisher-тесты флакали в полном прогоне                                                            | Process  | other | Фиксированные `sleep` и общая temp-БД файла: latch срабатывал на чужой строке     | Implementer                |
| Коммит при красном прогоне                                                                          | Process  | other | `pnpm test \| grep` маскирует код выхода                                          | Implementer Step 5         |
| Codex re-check убит при блокировке машины                                                           | Process  | codex-ops | Companion-процесс привязан к сессии субагента                                     | Tech Lead                  |
| Модели по ролям не переключились                                                                    | Minor    | unverified-claim | `model:` frontmatter не действует при `Skill()` внутри хода                       | Tech Lead Phase 0          |

### Process improvement proposals

1. Architect: для каждой константы-бюджета/таймаута план называет операцию, которую она ограничивает, и цепочка проверяется кодом при импорте и тестом — для **каждого** процесса, а не только для того, где ошибка найдена. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6 (Validation checklist, строка «Timeouts / budgets»), Architecture Rules п.10, Plan Update «Every process affected»; `.claude/codex-plan-review-prompt.md` → check 10**
2. Architect/Implementer: поведение фреймворка по умолчанию (тело 500 у Fastify, redact у pino) проверяется исполнением до того, как попадёт в план или комментарий. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 6, Validation checklist «Framework defaults»; `.claude/skills/implementer/SKILL.md` → Step 5.5; `.claude/codex-plan-review-prompt.md` → check 15**
3. Implementer Step 5: check-команда не пропускается через `grep` перед `&& git commit`; либо `set -o pipefail`, либо отдельный запуск с проверкой кода выхода. — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 5; `.claude/CLAUDE.md` → CI**
4. Implementer: интеграционные тесты в общей temp-БД файла привязывают latch'и и счётчики к своим строкам (`intentId`), а не к порядку обработки. — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 5.5**
5. Tech Lead: секция «Модели по ролям pipeline» в CLAUDE.md — допущение про переключение модели `Skill()`-вызовом опровергнуто транскриптом; владельцу решить: отдельные промпты на фазы, субагенты с явной `model`, или оставить всё на Fable. Отдельный docs-PR. — **внедрено в #61: `.claude/CLAUDE.md` → «Модели по ролям pipeline»; `.claude/skills/tech-lead/SKILL.md` → «Phases run as spawned agents», Mode 1 → Model policy — check**
6. Reviewer: инструкция simplify-агенту — «без вложенных агентов»; иначе он разложится и будет прерван. — **внедрено в #61: `.claude/skills/reviewer/SKILL.md` → Step 3, 3d**
7. Codex: только background mode с поллингом `status`/`result`; `--resume` треда после сбоя ненадёжен — `--fresh` с полным контекстом. — **внедрено в #61: `.claude/skills/architect/SKILL.md` → Step 7; `.claude/skills/reviewer/SKILL.md` → Step 3, 3a (объединено с #3 п.8)**
8. Follow-up-кандидаты (владелец решает, заводить ли issue): 6 Minor из LGTM итерации 3 (`stop()` cleanup guard, `sweeper.stop()` ждёт проход, комментарий в compose, `err.command.args` в redact, pino-тест с реальным `Error`, latch-хелпер); m8 параллельная обработка батча; upgrade-тест 0001→0002 на заполненной базе; interleaving-тесты; whitelist-сериализатор `err` перед ARCH-01. — **вынесено в #59**

---

## #9 — OAuth authorization-code flow (2026-09-23)

### Process audit
| Role | Step | Result |
|------|------|--------|
| Architect | План до In Progress | Да. Плюс восемь Plan Update, каждый после возврата с ревью |
| Architect | Codex plan review | Да на каждом плане. Находил Major в семи планах из восьми — в том числе в последнем, где первый набросок исправления получил четыре Major |
| Implementer | Ветка, коммиты, PR | `feat/9-binodex-oauth`, 30 коммитов формата `#9: …`, PR #53 с `Closes #9` |
| Implementer | Проверки до коммита | Да. Один раз нарушено: команда `node --env-file=.env <command>` попала в документацию без выполнения и не работала |
| Reviewer | Четыре проверяющих параллельно | Да на каждом круге, кроме случаев отказа Codex по лимиту |
| Reviewer | Codex code review | Восемь кругов. Два прогона потеряны на лимите использования, один отменён после получаса |
| Reviewer | Возврат в Todo при Major | Да, семь раз |
| Merge | Подтверждение перед мержем | Да. Мерж выполнил владелец: команда агента заблокирована классификатором прав |

### Review iterations: 8

### Findings
| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------| ----- |------------|-----------------|
| Ревью получало дифф итерации, а не фичу | Major (процесс) | other | Формулировка запроса к Codex во всех кругах, кроме последнего | Reviewer, семь кругов подряд |
| Отказ привязки после обмена оставляет мёртвый токен | Major | other | Следствие предыдущего: обе половины последовательности лежат в разных коммитах | Найдено только прогоном по всей задаче |
| Фикс закрывает механизм, но не всю поверхность | Major, трижды | instance-vs-class | Правился экземпляр, а не класс: ключ вместо всех причин, одна запись `.dockerignore` из шести, один список утверждений из четырёх | Implementer |
| Утверждение сильнее кода | Minor, шесть кругов подряд | unverified-claim | Текст писался от намерения, а не от проверенного | Implementer |
| Тест на исправление логов проверял тело ответа | Major | unverified-claim | Логи проверяемы только чтением логов; шва не было | Implementer + Reviewer |

### Process improvement proposals
1. **Последний прогон Codex перед мержем идёт по всей задаче, а не по диффу.** Семь диффовых ревью не нашли дефект, который прогон по фиче нашёл сразу. Записать в `.claude/skills/reviewer/SKILL.md` как отдельный шаг перед вердиктом о готовности к мержу. — **внедрено в #61: `.claude/skills/reviewer/SKILL.md` → Step 2 и Step 6-pre; `.claude/codex-review-prompt.md` → Scope; `.claude/skills/tech-lead/SKILL.md` → Mode 1 → Whole-feature pass — check**
2. **Правка текста перечитывается абзацем, а не диффом.** Три круга подряд в `.env.example` уцелевал обрывок предыдущей фразы, и комментарий противоречил себе через две строки. — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 5.5; `.claude/skills/architect/SKILL.md` → Step 6, строка «Text / docs edits»**
3. **Команда, попадающая в документацию, выполняется до коммита.** Нарушение дало неработающий рецепт, который заменил работающий. — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 5.5; `.claude/skills/architect/SKILL.md` → Step 6, строка «Text / docs edits»; `.claude/codex-review-prompt.md` → Check only for**
4. **Исправляя дефект, перечислить все места этого класса.** Формулировать шаг плана как «перечислить и закрыть все вхождения», а не «закрыть найденное». — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 5.5 и Fixing Review Findings → Step 3; `.claude/skills/architect/SKILL.md` → Plan Update «All occurrences of the class»; `.claude/codex-review-prompt.md` → Check only for (объединено с #6 п.4)**
5. **Правка того, что попадает в лог, покрывается тестом, читающим лог.** Потребовало шва `logDestination` в `buildApp`; шов оправдан, потому что pino пишет в файловый дескриптор мимо `process.stdout`. — **внедрено в #61: `.claude/skills/implementer/SKILL.md` → Step 5.5; `.claude/skills/reviewer/SKILL.md` → Step 5 (Code quality); `.claude/skills/architect/SKILL.md` → Step 6, строка «Logging changes»; `.claude/codex-review-prompt.md` → Check only for**
6. **Лимит Codex — планируемый ресурс.** Два прогона потеряны, один отменён после получаса. Для длинных задач стоит смотреть остаток до начала круга. — **внедрено в #61: `.claude/skills/tech-lead/SKILL.md` → Phase 0, п.1; `.claude/skills/reviewer/SKILL.md` → Step 3, 3a п.4 (объединено с #6 п.1)**

### Вынесено
- #54 — отказ привязки после успешного обмена оставляет аккаунт с мёртвым токеном, вместе с четырьмя Major из ревью плана исправления.
