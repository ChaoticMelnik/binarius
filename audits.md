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

---

## #56 — Process: внедрить предложения аудитов в pipeline (2026-09-24)

PR #61, rebase-merged as `34c7b2c` (20 commits), branch deleted. Первый прогон, в котором фазы работали спавн-агентами с явной `model`.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Codex `setup --json` ready, `gh` valid, `main` current. Сессия на `claude-opus-5-5` — по решению владельца (Q10) это теперь норма. Перед стартом по отдельному `AskUserQuestion` смёржен PR #55 (audit #9), чтобы не было конфликта в `audits.md`. |
| Tech Lead | `/clarify` | 7 вопросов (режим pipeline, гейты без allowlist, порядок с #55, clarify-relay, пилот схемы, ретро-разметка, follow-up). |
| Architect | Clarify relay + план | Спавн `fable` → `claude-fable-5-1`. 11 вопросов и 3 после Codex-проверки задал tech-lead. План, Addendum и Plan Update 2 — каждый с Codex-проверкой: 8M+1m, 3M+3m, 2M+1m; все Major проверены и учтены. |
| Implementer | Clarify relay | Спавн `opus` → `claude-opus-5-5`. 7 вопросов; 4 из них оказались дефектами плана и ушли архитектору (Plan Update 2), а не владельцу. |
| Implementer | Build / verify | 9 коммитов, `pnpm check` зелёный перед каждым; draft-PR-зонд #60 показал красный CI на каждом из трёх гейтов (3 пуша вместо 2) и закрыт без мержа; follow-up #57, #58, #59 в Backlog. |
| Reviewer | Iteration 1 | Спавн `opus`; сам запустил security/code-review (`opus`) и simplify (`sonnet` → `claude-sonnet-5`) на глубине 2. Codex 3a по полному диффу с marker/hash. 6 Major (1 по запросу владельца) + 13 Minor → Todo. |
| Architect | Plan Update 1 | Clarify relay: 5 вопросов. Codex re-check: 8 находок учтены. Агент завис по watchdog (600 с) уже после публикации комментария и смены статуса; tech-lead проверил состояние на GitHub, повторного спавна не было. |
| Implementer | Iteration 1 | Clarify relay: 5 вопросов, 2 из них — дефекты шага 9, решены ответами владельца и записаны на issue. 10 коммитов, по одному на шаг Plan Update. |
| Reviewer | Iteration 2 | Blocker/Major нет. Три Codex-Major reviewer проверил и понизил до Minor, владелец подтвердил. 12 Minor → #62. 3a по неизменному head засчитан как whole-feature pass (правило M1). |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase, ветка удалена, `state == MERGED`, Done. |

### Review iterations: 1 (возврат ревьюера; итерация 2 чистая)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Waiver мержа называл `/reviewer`, а мержит tech-lead | Major | single-source | Схема мержа изменена в скиллах, а в CLAUDE.md осталась прежняя | Implementer Step 5.5 |
| Ветка и `Closes` docs-PR аудита не разрешены CLAUDE.md | Major | single-source | Новое правило Phase 5 не сверено с Git-процессом | Architect plan |
| У architect остался пропуск clarify, противоречащий tech-lead и глобальному правилу | Major | single-source | Правка одного скилла без сверки с соседними | Architect plan |
| Lint-правило не видело второе сравнение в if/else и template literal | Major | unverified-claim | Покрытие заявлено по probe-формам, а не по narrowing | Architect Addendum |
| Инварианты 1 и 8 шире, чем их enforcement | Major | unverified-claim | Формулировка от намерения, а не от правила | Architect plan |
| 3a и 6-pre дублировали один и тот же Codex-прогон | Major (по запросу владельца) | other | Правило #9 п.1 перенесено без учёта того, что 3a уже идёт по полному диффу | Architect Plan Update 2 |
| Ответ Q8 дан на вариант, который нельзя выполнить (`review` без `--effort`, без шаблона) | Process | unverified-claim | Варианты для владельца не проверены запуском до вопроса | Architect clarify |
| `resolvedModel` отсутствует на глубине ≥ 2 и после продолжения через SendMessage | Minor | unverified-claim | Механизм проверки модели выведен из одного спавна глубины 1 | Architect Plan Update 2 |
| Architect-агент завис после публикации | Process | other | Stream watchdog; побочные эффекты уже были выполнены | — |

### Process improvement proposals

1. **Упавшая или зависшая фаза: сначала убедиться, что агент завершён (иначе остановить или продолжить его), затем проверить её побочные эффекты на GitHub (комментарии, статус, пуш) и только потом решать о повторном спавне.** Иначе повторный спавн задублирует Plan Update. — **внедрено в #63: `.claude/skills/tech-lead/SKILL.md` → Phases run as spawned agents, «Failed or stalled phase»**
2. **Каждая фаза проверяет вариант, зависящий от возможностей инструмента, безопасной read-only пробой до того, как предложить его владельцу (флаг в `--help`, поле в API, dry-run); само действие, меняющее состояние, до ответа не выполняется.** Q8 пришлось пересматривать. — **внедрено в #63: `.claude/skills/architect/SKILL.md` → Step 5; `.claude/skills/implementer/SKILL.md` → Step 0; `.claude/skills/tech-lead/SKILL.md` → Phases run as spawned agents, «Clarify relay»**
3. **Проверка модели учитывает фазу, продолженную через SendMessage, и спавны глубины ≥ 2.** — **внедрено в #61: `.claude/skills/tech-lead/SKILL.md` → Model policy — check**
4. **Правка глобального `~/.claude/CLAUDE.md` под новую схему** (clarify-relay, спавны вместо Skill, Codex без MCP, модели на спавнах, Todo после ревью, merge relay, последовательность фаз). Текст правки tech-lead передаёт владельцу. — **открыто (2026-09-24, владелец)**
5. **12 Minor из ревью итерации 2.** — **вынесено в #62**

---

## #22 — /start + welcome flow (2026-09-28)

PR #64, rebase-merged as `a7a7c31` (14 коммитов), ветка удалена. 52 файла, +6132/-55. Четыре итерации ревью — больше, чем у любой задачи до сих пор, и все Major одного класса.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Codex ready, `gh` valid, Node 22.23.2 = `.node-version`, compose healthy, `.claude/CLAUDE.md` без дрейфа, все предложения прошлого аудита со статусами. Конфликтов нет: открытых PR ноль. |
| Architect | Clarify + план | Спавн `fable`. 6 вопросов (граница #22/#23, источник перехода, место хранения, повторный /start, велком-контент, транспорт). Codex plan review до публикации (11:42 против 11:47). |
| Implementer | Round 1 | Спавн `opus`. 6 вопросов; одно предложение исполнителя (fallback видео → текст) принято владельцем как отклонение от плана. 6 коммитов по слоям, CI зелёный. |
| Reviewer | Iteration 1 | 1 Major + 10 Minor → Todo. Codex 3a по полному диффу, хеш сверен. |
| Architect | Plan Update 1 | Codex: «ревизия ревью не покрывает», 8 находок, все учтены. |
| Implementer | Round 2 | 17 доказательств поломкой. Нашёл ошибку в самом плане: обещание «лишний вызов на любой ветке покрасит тест» ложно при проверке только максимума. |
| Reviewer | Iteration 2 | 2 Major + 4 Minor → Todo. Владелец выбрал смену подхода: MB вынесен в #67, `process.once` в трёх сервисах — в #66. |
| Architect | Plan Update 2 | Codex: 3 Major + 4 Minor, все учтены; класс дефекта переформулирован на уровень выше. |
| Implementer | Round 3 | Раунд сужен. 9 оракулов, каждый с доказательством. |
| Reviewer | Iteration 3 | 1 Major + 6 Minor → Todo. Владелец выбрал снять породившую Major проверку, guard вынесен в #70. |
| Architect | Plan Update 3 | Codex: 1 Major + 3 Minor. Забраковал доказательство как **соседнее** — мутация краснила и существующую проверку. Архитектор прогнал изолирующую. |
| Implementer | Round 4 | 3 коммита, 12 файлов. Все девять мутаций перепрогнаны, `node_modules` восстановлен побайтово (`cmp` + SHA). |
| Reviewer | Iteration 4 | Blocker/Major нет. 10 Minor → #71. F10 воспроизведён самостоятельно. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удаление ветки, `state == MERGED`, Done. Whole-feature pass сверен пересчётом хеша. |

### Review iterations: 3 (возврата ревьюера; итерация 4 чистая)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| M1 — бюджет хендлера отстал от кода на 5 с после санкционированного fallback | Major | unverified-claim | Решение согласовано, следствие для инварианта не доведено; охраняющий тест повторял выражение, которым константа определена, и утверждал константу, роняющую импорт при ложности | Implementer Step 5.5 |
| MA — `process.once` для SIGTERM: второй сигнал убивает дренаж | Major | unverified-claim | Фейк сигналов моделировал `on` вместо `once`, тест с двумя сигналами структурно не мог покраснеть | Architect Plan Update 1 (скан искал форму раунда 1, а не класс) |
| MB — сбои long polling невидимы: ни лога, ни healthcheck | Major | instance-vs-class | Единственный путь ошибки в `apps/bot`, до которого не дотягивается инвариант 8 | Architect plan |
| MC — guard env-ключей не fail-closed (`!!merge`, `env_file`) | Major | unverified-claim | Проверка, написанная **этим же раундом** для закрытия Minor, под правило раунда не подведена | Architect Plan Update 2 |
| mA — start-опции сверяются с теми же константами, что передаёт код | Minor | unverified-claim | Третий экземпляр самоподтверждающегося оракула, на файл в сторону от запрета | Architect Plan Update 2 |
| Доказательство нового оракула оказалось соседним, а не изолирующим | Process | unverified-claim | Мутация краснила и уже существующую проверку — про новую не доказывала ничего | Поймано Codex на Plan Update 3 |
| Семь разовых `403 authentication_failed` и один лимит сессии на шести агентах | Process | other | Инфраструктура; всегда через минуты работы, короткие пробы проходили | — |

### Process improvement proposals

1. **Запрет класса распространяется на собственный выход раунда, а не только на унаследованные дубли.** Проверка, написанная для закрытия находки, — такой же кандидат на дефект, и цена ошибки выше: она создаёт ложное впечатление покрытия. — **внедрено в #72: `.claude/skills/implementer/SKILL.md` → Step 5.5 (последний пункт)**
2. **Доказательство поломкой в чек-листе самопроверки:** каждый добавленный или изменённый тест показывается красным на регрессии, ради которой написан, с цитатой вывода. — **внедрено в #72: `.claude/skills/implementer/SKILL.md` → Step 5.5**
3. **Доказательство обязано быть изолирующим, а не соседним:** мутация краснит только новую проверку. — **внедрено в #72: `.claude/skills/implementer/SKILL.md` → Step 5.5 и `.claude/codex-plan-review-prompt.md` → check 18**
4. **Codex plan review получает проверки 17-19** (тестовые дубли; изолирующее доказательство на каждый новый оракул; удаление не оставляет ложных утверждений). Архитектор подставлял их вручную в раунде 4, и находки Codex прослеживаются именно к ним. — **внедрено в #72: `.claude/codex-plan-review-prompt.md`**
5. **Таблица моделей приведена к наблюдаемому** (`opus` → `claude-opus-5`) с пометкой, что id в таблице — запись последней сверки, а не гарантия. — **внедрено в #72: `.claude/CLAUDE.md` → Модели по ролям pipeline**
6. **10 Minor из финального ревью.** — **вынесено в #71**
7. **Два флакающих интеграционных теста** (`publisher.redis.test.ts`, `trade-intent-ops.db.test.ts` — по одному падению на шесть полных прогонов, короткие бюджеты по wall-clock, оба вне диффа #22). — **не заведено: при явном вопросе о follow-up issue (2026-09-28) владелец выбрал только issue по Minor'ам; наблюдение зафиксировано здесь**

---

## #68 — Staff login: пароль, подтверждение в Telegram, серверные сессии (2026-10-01)

PR #74, rebase-merged как `85cd10e` (28 коммитов), ветка удалена. 86 файлов, +12055/-139. Четыре итерации ревью, три возврата в Todo. Закрыт не чистой итерацией, а решением владельца: находки итерации 4 вынесены в #149-#156, задача доведена в текущем состоянии.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Codex ready, `gh` valid, Node 22.23.2 = `.node-version`, compose healthy, `.claude/CLAUDE.md` без дрейфа. |
| Architect | Clarify + план | Спавн `fable` (`claude-fable-5-1`). Codex plan review `task-mume5tuk-50ghj9` (gpt-5.6-sol/high, 13 мин): 2 Blocker, 10 Major, 6 Minor — все учтены до публикации плана. |
| Implementer | Round 1 | Спавн `opus` (`claude-opus-5`). 6 коммитов по слоям, PR с `Closes #68`, CI зелёный. |
| Reviewer | Iteration 1 | **0 Blocker, 2 Major, 12 Minor** → Todo. Codex 3a `task-mumnhe4p-tfpvut`, хеш диффа в маркере. Три severity Codex понижены с обоснованием механизма. |
| Architect | Plan Update 1 | Codex re-check `task-mumpfjp7-h6c1mg` (4 мин 56 с): 2 Major, 7 Minor, все учтены. |
| Implementer | Round 2 | Введён `tooling/assertion-ledger.sh` как инструмент доказательства полноты. |
| Reviewer | Iteration 2 | **0 Blocker, 2 Major, 18 Minor** → Todo. Codex 3a: первый job `task-muntsi76-r5yxc7` умер молча через ~7 мин (pid исчез, запись осталась `running`), перезапуск `task-munvo9ps-a1hkkc` дошёл — его находки опубликованы отдельным комментарием. |
| Architect | Plan Update 2 | Codex `task-muo2fzel-126rgl` (27 мин 54 с; первая попытка `task-munxursi-u9wyna` упёрлась в usage-limit через 6 мин): 2 Major, 7 Minor. Major 2 понижен до замечания к формулировке пробой блокировок на двух соединениях. |
| Implementer | Round 3 | Ledger удалён (оба его дефекта → #76), заменён человеческой проверкой с названными границами. |
| Reviewer | Iteration 3 | **0 Blocker, 0 Major, 16 Minor** — единственная итерация без возврата. Codex 3a `task-muo9zdlx-dp6c0n` отработал 17 мин 44 с по полному диффу и умер на usage-limit, находок не дал. |
| Tech Lead | Codex checkpoint | Ещё две попытки (`task-muob6fu9-42jo0y` 16:17, `task-muod943s-igdzko` 18:03) упали на том же лимите. Политика «2 попытки, затем спросить» соблюдена; владелец 2026-09-30 явно решил пропустить. Сброс лимита — 2026-10-05 10:26, подтверждён повторно перед мержем. |
| Implementer | Round 4 | Спавн `opus`. Десять Minor закрыты, каждое утверждение — изолирующей мутацией. |
| Reviewer | Iteration 4 | **0 Blocker, 1 Major, 11 Minor** → Todo. Major воспроизведён двумя клиентами против мигрированной БД. |
| Tech Lead | Смена подхода | Phase 4 отработала: итерация ≥2 с находками — остановка и вопрос владельцу. Владелец выбрал вариант вне предложенного списка: вынести всё в отдельные задачи, #68 довести как есть. |
| Tech Lead | Merge / Done | `AskUserQuestion` непосредственно перед мержем → rebase + удаление ветки. `state == MERGED`, `85cd10e`. Done после подтверждения. |
| Tech Lead | Model policy | Все фазы на политике: architect `claude-fable-5-1`, implementer и reviewer `claude-opus-5`, `/security-review` и `/code-review high` `claude-opus-5`, `/simplify` `claude-sonnet-5`. Нарушений нет — но скрипт проверки их показывал, см. предложение 1. |

### Review iterations: 3 (возврата ревьюера: итерации 1, 2 и 4; итерация 3 без возврата)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| I1-M1 — `ADMIN_WEB_TOKEN` и `INTERNAL_API_TOKEN` документированы как заведомо разные; ничто этого не обеспечивало, а тест, который это утверждал, был про другое | Major | unverified-claim | Охраняющий тест не проверял то, что заявлял | Implementer Step 5.5 |
| I1-M2 — процедура первого запуска не могла создать первую учётку на чистом томе | Major | env-parity | Каждая команда по отдельности работала на уже поднятом окружении; из стартового состояния, для которого написан текст, процедура не прогонялась | Implementer Step 5.5 («каждая команда выполнена» — но не «процедура целиком из названного состояния») |
| I2-M1 — fail-closed `isPolling()` пропускался при переиспользовании challenge'а, а документ формулировал правило безусловно | Major | instance-vs-class | Гейт поставлен на один путь из четырёх; claim шире механизма | Architect Plan Update 1 |
| I2-M2 — `assertion-ledger.sh`, инструмент, на котором стоял весь раунд, не перечислял то, что обещали его же комментарии (терял hunk'и только с удалениями; glob не матчил ни одного файла) | Major | unverified-claim | Правило «доказательство поломкой» распространялось на тесты, но не на инструмент, производящий доказательства | Implementer Step 5.5 |
| I4-Major — `invalidateIssued` пишет `revoked_at = now()` (старт транзакции); под READ COMMITTED попадает в сессию, вставленную начавшимся позже `completeLogin` → CHECK обрывает транзакцию, учётка остаётся `active`, сессия жива | Major | unverified-claim | Комментарий о порядке блокировок объявлял путь безопасным; `FOR NO KEY UPDATE` на `staff` не конфликтует с `KEY SHARE` от FK | Architect plan — **хотя Codex предложил ровно эту проверку на plan review** (см. предложение 5) |
| n3 / I3-m16 — вывод команды, процитированный как доказательство, относился к дереву до правок этой же итерации | Minor ×2 | unverified-claim | Доказательство собрано раньше головы, против которой опубликовано; само утверждение в обоих случаях верно | Reviewer Step 5 |
| Моя собственная сверка полноты `comm -3` была циклической: обе стороны порождал один генератор | Process | unverified-claim | Проверка полноты против собственного источника не доказывает ничего; исправлено публично в том же треде | Поймано Codex на Plan Update 2 |
| Опубликованные мной агрегаты скана (421/112/308) включали три строки заголовка скрипта; верные — 418/111/307 | Process | unverified-claim | Счёт не перепроверен на головe публикации | Исправлено публично |
| Три подряд срыва stream-watchdog остановили механику «фаза = спавн»; слайс 6 и работа с доказательствами сделаны частично инлайн в главном контексте tech-lead с санкции владельца | Process | other | Инфраструктура | — |
| Codex на всех прогонах работал без CodeGraph: политика одобрения `never` блокировала запуск MCP-сервера | Process | codex-ops | — | — |
| Обязательный whole-feature pass Codex отсутствует на смерженной голове | Process | codex-ops | Usage-limit до 2026-10-05 10:26; две попытки по политике, затем явное решение владельца 2026-09-30 | — |

### Process improvement proposals

1. **Скрипт проверки модельной политики давал ложное нарушение на каждом opus-прогоне.** Хелпер `ran()` грепал весь транскрипт по `"model":"claude-*"` и подхватывал `advisorModel` (`claude-opus-5-5`) и `attachment.model` наряду с `message.model` (`claude-opus-5`). Критерий (c) — «`ran` — ровно один id» — читался как нарушение на соответствующем политике прогоне. Проверено по транскрипту ревьюера итерации 4: 210 сообщений, `message.model` = `claude-opus-5` у всех 210, `advisorModel` = `claude-opus-5-5` у всех 210. Исправленный хелпер перепрогнан по шести агентам #68 — по одному id в каждой строке. — **внедрено в #157: `.claude/skills/tech-lead/SKILL.md` → Mode 1 → Model policy — check**
2. **Инструмент тоже не освобождён от правила доказательства.** Скрипт, генератор или реестр, чей вывод *и есть* доказательство раунда, держится того же правила, что и тест. Обобщает предложение 1 аудита #22 с «проверок, написанных этим раундом» на «любой инструмент, на котором раунд стоит». Отдельно: проверка полноты, обе стороны которой порождает один генератор, не доказывает ничего. — **внедрено в #157: `.claude/skills/implementer/SKILL.md` → Step 5.5**
3. **Документированная процедура прогоняется целиком из того стартового состояния, которое сама называет** — чистый том, пустая БД, — а не покомандно на уже работающем окружении. Это I1-M2 дословно. — **внедрено в #157: `.claude/skills/implementer/SKILL.md` → Step 5.5 и `.claude/skills/architect/SKILL.md` → Task classes → Text / docs edits**
4. **Процитированное доказательство перепрогоняется на той голове, против которой публикуется** — с обеих сторон: исполнитель цитирует свой вывод с головы коммита, ревьюер не принимает чужой вывод не перепрогнав. Класс всплыл в #68 дважды (m16, n3) и оба раза с верным утверждением, что и делает его незаметным. — **внедрено в #157: `.claude/skills/implementer/SKILL.md` → Step 5.5 и `.claude/skills/reviewer/SKILL.md` → Step 5**
5. **Проверки 20-22 Codex-шаблона — предложение самого Codex с plan review #68.** Проверка 22 (disable/reset атомарно инвалидируют выданные артефакты аутентификации и запросы в полёте) — **ровно класс того Major'а, который дошёл до мержа**. Codex назвал его на этапе плана, предложение было отложено в Phase 5, и дефект этого класса прожил все четыре итерации. Это самый дорогой вывод аудита: отложенная проверка шаблона — это не косметика, а пропущенный класс. Формулировка 22 теперь прямо называет источник отметки времени (`now()` — старт транзакции) и режимы блокировок. — **внедрено в #157: `.claude/codex-plan-review-prompt.md` (20 — сырые ошибки и внешние объекты в durable payload; 21 — контракт KDF; 22 — инвалидация выданных артефактов)**
6. **Находки итерации 4: 1 Major и 11 Minor.** — **вынесено в #149 (Major), #150, #151, #152, #153, #154, #155, #156**
7. **m21 — расхождение глобального и проектного CLAUDE.md** о статусе после ревью с замечаниями (`~/.claude/CLAUDE.md` → «Changes requested → back to In Progress» против проектного «reviewer сразу переводит → Todo»). Это новый экземпляр уже открытого предложения 4 аудита #56, а не отдельное предложение: правка глобального файла требует санкции владельца, агент её не вносит. — **открыто (2026-10-01, владелец)**
8. **Codex работает без CodeGraph** — политика одобрения `never` блокирует запуск MCP-сервера внутри Codex-прогона, поэтому независимый ревьюер каждый раз читает дерево с нуля. Стоимость видна в длительности: 17-28 минут на полный дифф. — **открыто (2026-10-01, владелец)**
9. **Whole-feature pass Codex по смерженной голове `85cd10e` не выполнен** (usage-limit до 2026-10-05 10:26; решение о пропуске — владельца, 2026-09-30). Предикаты плана не читал ни один независимый ревьюер. — **открыто (2026-10-01, владелец): прогнать пост-фактум после сброса лимита и завести issue на всё, что он найдёт**
10. **Этот PR аудита (#157) смержен без собственного прохода Codex.** Правило Phase 5 п.5 требует прохода и для docs-PR. Две попытки на этом диффе 2026-10-01 (`task-mup2abcy-oqily4`, `task-mup2azso-kdr7bu`) упали на том же usage-limit; третьей по политике не делалось, вопрос о мерже до решения владельца не задавался. Владелец 2026-10-01 явно принял мерж без прогона: процессный текст без кода, а четыре дня ожидания означали бы четыре дня работы со старым скриптом проверки моделей и без проверки 22 в шаблоне. Записано здесь, потому что запись аудита, умалчивающая о пропуске в себе самой, — ровно тот класс, который этот аудит разбирает. — **отклонено: прогон по этому диффу не состоится (решение владельца 2026-10-01); пост-фактум прогон по коду #68, где он имеет смысл, остаётся предложением 9**

---

## #149 — `invalidateIssued` помечает отзыв временем записи, а не старта транзакции (2026-10-01)

PR #159, rebase-merged как `a888b9d` (3 коммита), ветка удалена. 3 файла, +138/-1. **Одна итерация ревью, ноль возвратов** — первая задача после #68, прошедшая ревью с первого раза.

Дефект был живым в `main`: отключение скомпрометированной учётки и сброс пароля могли оборваться на `staff_sessions_revoked_after_created_check`, оставив учётку `active`, а только что выданную сессию — рабочей.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Дерево чистое, `main` на `1feb8d4`, `.claude/CLAUDE.md` без дрейфа, Node 22.23.2, шесть сервисов подняты, `origin` по SSH. Codex — лимит до 2026-10-05 10:26. |
| Owner | Вейвер Codex | 2026-10-01: «Разрешаю пропускать codex до пятого октября». Явное решение требуемой формы (ABSOLUTE RULE). Записано в первом абзаце плана, в вердикте ревью и здесь. |
| Architect | Clarify + план | Спавн `fable` (`claude-fable-5-1`). 4 вопроса. План — 269 строк, каждая премисса исполнена: probe A-H против свежемигрированной временной БД, вывод процитирован в опирающемся на него шаге. |
| Architect | Скан класса | Собственный механический критерий вместо унаследованного списка: 9 CHECK'ов, **8 писателей** — против пяти в теле issue и шести в моём уточнении. Два сверх списка: `confirmChallengeFromTelegram`, `runAsStaff`. |
| Architect | Step 7 Codex | Пропущен по вейверу владельца. Попыток не делалось. |
| Architect | Step 8 | Публикация плана и смена статуса **заблокированы классификатором auto mode**; агент вернул команды, tech-lead спросил владельца и выполнил сам. Обхода не было. |
| Implementer | Clarify | Спавн `opus` (`claude-opus-5`). 4 вопроса, дефектов плана не нашёл. |
| Implementer | Реализация | Три коммита (тест → фикс → docs) по решению владельца. Красный прогон снят с собственного SHA, зелёный — с головы, оба после создания коммитов. `pnpm check` зелёный с первой попытки, флейк D8 не проявился. |
| Reviewer | Iteration 1 | Спавн `opus`. **0 Blocker, 0 Major, 5 Minor** → #149 остаётся In Review. Доказательство перепрогнано на всех трёх SHA, включая половину «краснеют только эти два». 3b — ноль находок, 3c — 2 Minor + nit, 3d — 2 Minor. |
| Tech Lead | Merge / Done | `AskUserQuestion` непосредственно перед мержем → rebase + удаление ветки. `state == MERGED`, `a888b9d`. Done после подтверждения. |

### Review iterations: 0 (возвратов ревьюера нет)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| M1 — `revoked_at >= created_at` сравнивает JS `Date` (миллисекунды) против микросекундной инверсии; на паре из собственного красного прогона PR возвращает `true` | Minor | unverified-claim | Правило доказательства поломкой применялось с единицей «тест»; тест краснел через CHECK рядом, а само утверждение не умело краснеть ни при чём | Implementer Step 5.5 — **единица правила, см. предложение 1** |
| M2 — seam глотает второй аргумент `transaction` (`PgTransactionConfig`) | Minor | other | Латентно сегодня; весь аргумент корректности #149 — про READ COMMITTED, и будущий `isolationLevel` был бы проглочен молча | Implementer Step 5.5 |
| M3 — перечисление чередований в комментарии и docs читается как исчерпывающее, но пропускает то, которое прогоняет сам новый тест | Minor | unverified-claim | Тот же класс «утверждение шире механизма», что дал четыре итерации в #68 | Architect plan |
| M4, M5 — замыкание без пользы; общий каркас двух seam'ов | Minor ×2 | other | Косметика; M5 ревьюер рекомендовал не трогать в рамках задачи | — |
| Список писателей в теле #149 был неполон (пять вместо восьми) | Process | instance-vs-class | Я перенёс список из комментария ревьюера #68, не пересчитав. Поймано архитектором, потому что ему было велено строить таблицу охвата от собственного скана, а не от унаследованного списка | Поймано на Architect Step 3 |
| Семь остальных писателей защищены недостижимостью, а не конструкцией — probe опровержения срабатывает у всех семи | Process | unverified-claim | Решение «код не трогаем» опиралось на утверждение, которое было верно в более узкой форме, чем звучало | Поймано probe'ом архитектора; **вынесено в #158** |
| Процитированный SHA красного прогона переписан rebase-мержем | Process | other | «Дать красному прогону собственный SHA» и rebase-мерж вместе означают, что процитированный SHA и смерженный — разные | Поймано tech-lead'ом после мержа |
| Публикация плана и смена статуса заблокированы классификатором auto mode | Process | other | Инфраструктура; агент вернул команды вместо обхода, как ему было велено | — |
| Codex не читал ни план, ни код | Process | codex-ops | Лимит до 2026-10-05 10:26, вейвер владельца | — |

### Process improvement proposals

1. **Единица правила доказательства — утверждение, а не тест.** M1 — первый экземпляр, где эта разница видна в чистом виде: тест краснел (через DDL CHECK), а утверждение внутри него не умело краснеть ни при каких данных. Это предложение (a) архитектора из #68, которое я **записал и не внёс** в #157, внеся три других пункта. Цена отсрочки — ровно M1. — **внедрено в #161: `.claude/skills/implementer/SKILL.md` → Step 5.5 (первый пункт доказательства)**
2. **SHA, процитированный как доказательство, сопровождается соответствием после мержа.** Репозиторий мержит rebase'ом, поэтому процитированный id перестаёт быть достижимым от `main`. В #159 соответствие опубликовано комментарием к смерженному PR; правило — делать это сразу. — **внедрено в #161: `.claude/skills/implementer/SKILL.md` → Step 5.5**
3. **Пять Minor ревью #159.** — **вынесено в #160**
4. **Семь писателей `now()` защищены недостижимостью.** — **вынесено в #158**
5. **Ни план, ни код #149 не читал независимый ревьюер** (вейвер Codex до 2026-10-05 10:26). Это вторая задача подряд в таком режиме; предложение 9 аудита #68 о пост-фактум прогоне распространяется и на неё. — **открыто (2026-10-01, владелец): после сброса лимита прогнать Codex по `a888b9d` вместе с головой #68 и завести issue на найденное**

### Что сработало

Ноль возвратов ревьюера — впервые за последние задачи, и причина прослеживается. Архитектор получил указание проверять исполнением каждую премиссу и не наследовать чужие списки; он нашёл восьмерых писателей вместо пяти, построил опровергающий probe на каждого безопасного и уткнулся в то, что их безопасность — реахабилити, а не конструкция. Исполнитель на этом фундаменте отступил от плана ровно один раз (селектор `audit_log`) и был прав: `.at(-1)` из наброска плана утверждал бы про чужую строку. Ревьюер не принял ни одно из этих рассуждений на слово и перепрогнал доказательство на трёх SHA.

---

## #163 — Broker OAuth под реальный Binodex: хост API, refresh, формат ошибок, partner ref (2026-10-01)

PR #164, rebase-merged (4 коммита, голова `898cf56` → в `main` до `24f9674`), ветка удалена. 16 файлов, +507/−164. **Одна итерация ревью, ноль возвратов.** Первая задача серии #163 → #10 → #162 (порядок — решение владельца; #9 пропущен, закрыт PR #53 ещё 2026-09-23).

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | `main` синхронна, `.claude/CLAUDE.md` без дрейфа, Codex `ready` (лимит до 2026-10-05 10:26), gh по SSH, Node 22.23.2, шесть сервисов подняты. Предупреждение: предложение 5 аудита #149 открыто. |
| Owner | Clarify tech-lead | 4 вопроса: #9 пропустить, последовательный порядок, Codex пропускать везде (вейвер до 2026-10-05), live-check — агент + владелец на шагах браузера. |
| Architect | Clarify + план | Спавн `fable` → `claude-fable-5-1`. До вопросов — живые probe'ы `api.binodex.app` (статусы обоих эндпоинтов, формат ошибок, нормализация `ref` в SPA брокера). 7 вопросов, все ответы — рекомендованные. План ~440 строк, обе ветки live-check расписаны. |
| Architect | Step 7 Codex | Пропущен по вейверу владельца, записан в плане с датой. |
| Tech Lead + Owner | Live-check | Проведён до кода через Playwright: владелец вводил почту и код, tech-lead забирал `code` и запускал обмен. Первая попытка — 400 «redirect_uri is not registered»; вторая потеряла `code` из-за бага скрипта (`field()`); третья — ветка A. |
| Implementer | Clarify + код | Спавн `opus` → `claude-opus-5-5`. 4 вопроса. 4 коммита по слоям, `pnpm check` exit 0 на `898cf56`, каждое новое утверждение показано красным под мутацией. Расхождение redirect URI не тронул, вернул как вопрос — верно. |
| Reviewer | Iteration 1 | Спавн `opus` → `claude-opus-5-5`; 3b/3c `opus`, 3d `sonnet`. **0 Blocker, 0 Major, 4 Minor.** Первая сдача отчёта — преждевременная (до завершения 3c/3d); продолжен через SendMessage, вердикт — после всех трёх. |
| Reviewer | Runtime check | Локальный `pnpm check` дважды красный: таймауты `beforeAll` (`createTempDatabase`) при load ~6, не дефект диффа. Вердикт по проверкам — зелёный CI той же головы. |
| Tech Lead | Merge / Done | `AskUserQuestion` непосредственно перед мержем → rebase + удаление ветки, `--match-head-commit 898cf56`. `MERGED` 09:05:48Z, Done после подтверждения. |

### Review iterations: 0 (возвратов ревьюера нет)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| m1 — переходные сбои `refresh` не покрыты тестами | Minor | other | Тесты транспорта написаны на `exchangeCode`, общий `post()` покрыт косвенно | Implementer Step 5 |
| m2 — эндпоинт и URL передаются в `post()` раздельно | Minor | single-source | Одна сущность (эндпоинт ↔ карта статусов) в двух аргументах | Architect plan |
| m3, m4 — имя счётчика заглушки; дубль хелпера ошибки | Minor ×2 | other | Косметика | — |
| `fetch` следует 307/308 и повторяет POST с секретом (было до PR) | Observation | other | Дефолт `fetch` | — |
| Redirect URI в кабинете (`localhost:3000/auth/callback`) ≠ compose-дефолт (`127.0.0.1:3000/oauth/callback`), ни один путь не обслуживается | Process | env-parity | #9 проверялся только против моков; дефолт никогда не сверялся с кабинетом брокера | Поймано live-check'ом #163; к #114 |
| DB-тесты нестабильны при полном `pnpm check` (таймауты temp-БД; порядок времени в трёх тестах) | Process | env-parity | Вне диффа; CI зелёный | Implementer / Reviewer runtime check |
| Баг `field()` в скрипте live-check сжёг один одноразовый `code` | Process | unverified-claim | Скрипт-доказательство не прогнан на фикстуре до живого запуска | Architect (автор скрипта) |
| Алиас `opus` разрешился в `claude-opus-5-5`, таблица в `.claude/CLAUDE.md` пишет `claude-opus-5` | Process | other | Алиас плавает между прогонами (#56 — `5-5`, #22 — `5`); таблица — запись последней сверки | Model policy check |
| Codex не читал ни план, ни код | Process | codex-ops | Лимит до 2026-10-05 10:26, вейвер владельца | — |

### Process improvement proposals

1. **m1–m4 и hardening редиректов.** — **вынесено в #165**
2. **Нестабильные DB-тесты при полном `pnpm check`.** — **вынесено в #166**
3. **Redirect URI: маршрут/порт callback-страницы, дефолт и перерегистрация в кабинете.** — **вынесено в #114** (комментарий https://github.com/ChaoticMelnik/binarius/issues/114#issuecomment-5928304082)
4. **Пост-фактум Codex по `898cf56`** (третья задача подряд без независимого ревьюера) — присоединяется к предложению 5 аудита #149. — **открыто (2026-10-01, владелец): после сброса лимита 2026-10-05 прогнать Codex вместе с `a888b9d` и головой #68**

### Что сработало

- Live-check до кода: ветка A подтверждена, а заодно — отзыв всей цепочки при повторе refresh-токена (401 и на новом токене) и партнёрская привязка через OAuth `ref` end-to-end (`is_partner_client=true`); отдельная задача под неё не понадобилась.
- Implementer вернул расхождение redirect URI вопросом, а не решил его сам в чужом домене (#114).

---

## #10 — Привязка Telegram ↔ broker account: 100 токенов за первую привязку (2026-10-01)

PR #168, rebase-merged (6 коммитов, голова `9ece6f3`, в `main` до `c1a2047`), ветка удалена. 34 файла, +4031/−88, из них ~2 800 — сгенерированный `0008_snapshot.json`, вручную ~1 240. **Одна итерация ревью, ноль возвратов.** Вторая задача серии #163 → #10 → #162.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable` → `claude-fable-5-1`. 7 вопросов; владелец выбрал не рекомендованный вариант в одном — бот входит в #10. CHECK/индекс/ON CONFLICT исполнены на временной таблице до плана; граница с #128 опубликована на #128. |
| Tech Lead + Owner | Live-check | `is_partner_client` для аккаунта, зарегистрированного без `ref`: `true` (`user.id=101962`), `false` не наблюдался, обе интерпретации в docs. Две первые попытки дали аккаунт #163 — постоянный профиль Playwright держал старую сессию; сброшено очисткой хранилища сайта. |
| Architect | Step 7 Codex | Пропущен по вейверу владельца, записан в плане и в Plan Update. |
| Implementer | Clarify | Спавн `opus` → `claude-opus-5-5`. 4 вопроса владельцу + дефект плана (grep-проверка числа 100 не проходила на `main`) → архитектор, Plan Update до кода. |
| Implementer | Код | 6 коммитов по слоям, каждый проходит `pnpm check`; миграция 0008 + snapshot в одном коммите, SQL прочитан. Мутационная проверка каждого нового утверждения; тест, не умевший упасть, удалён. |
| Reviewer | Iteration 1 | Спавн `opus`. **0 Blocker, 0 Major, 5 Minor.** «Major» code-review (pending-привязка занимает /start) — признан принятым риском плана, следствие вынесено владельцу вопросом. Отчёт снова сдан до окончания 3c/3d — продолжен, вердикт после всех трёх. |
| Tech Lead | Merge / Done | `AskUserQuestion` непосредственно перед мержем → rebase + удаление ветки, `--match-head-commit 9ece6f3`. `MERGED` 10:27:11Z, Done после подтверждения. |

### Review iterations: 0 (возвратов ревьюера нет)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| m1 — prototype-lookup в `CONFIRM_REFUSALS` | Minor | other | Таблица кодов — обычный объект | Implementer Step 5 |
| m2 — грант не сообщается, если таймаут бота случился после коммита | Minor | other | Ответ — единственный канал итога, повтор видит `not_pending` | Architect plan |
| m3–m5 — кнопки не снимаются; двойная проекция/два запроса; дубль warn-блока | Minor ×3 | other | Косметика | — |
| Grep-проверка числа 100 в плане не могла пройти на `main` | Process | unverified-claim | Критерий плана не исполнен на текущем дереве до публикации | Architect plan → пойман Implementer clarify |
| Ревьюер дважды за день сдал отчёт до окончания своих субагентов | Process | other | 3b-3d спавнились в фоне; харнесс завершал ход ревьюера раньше | Reviewer Step 3 |
| Правило размера (≤2000/3000) не говорит, считается ли сгенерированный drizzle-snapshot (~2 800 строк на любую схемную задачу) | Process | single-source | Правило писалось до первой миграции в задаче такого размера | Architect Step 4a |
| Codex не читал ни план, ни код | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Minor m1–m5.** — **вынесено в #169**
2. **3b-3d — в foreground.** Спавнить субагенты ревьюера с `run_in_background: false`: они всё равно идут параллельно, а ход не кончается до их отчётов. — **внедрено в #170: `.claude/skills/reviewer/SKILL.md` → Step 3 → Order of launch**
3. **Сгенерированные файлы в правиле размера.** Явно исключить `packages/db/drizzle/meta/*_snapshot.json` из счёта строк в `.claude/CLAUDE.md` → Планирование задач и architect Step 4a. Владелец решил «не считать, вписать явно» (2026-10-01). — **внедрено в #170: `.claude/skills/architect/SKILL.md` → Step 4a; `.claude/CLAUDE.md` → Планирование задач**
4. **Пост-фактум Codex по `9ece6f3`** — присоединяется к предложению 4 аудита #163. — **открыто (2026-10-01, владелец): после сброса лимита 2026-10-05**

---

## #162 — Вход по email, часть 1: backend (2026-10-01)

PR #172, rebase-merged (5 коммитов, голова `f306aa9`, в `main` до `8bbbb8c`), ветка удалена. 13 файлов, +1487/−82. **Одна итерация ревью, ноль возвратов.** Третья задача серии #163 → #10 → #162; часть 2 (бот) вынесена в #171.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`. Живые probe'ы без отправки писем (невалидный адрес, фиктивный код, неверный секрет) — карта статусов из наблюдённых ответов. 8 вопросов, все ответы — рекомендованные; разбиение на #162 (backend) и #171 (бот) по правилу 2000-3000. |
| Owner | Live-check | Отклонил повторную проверку входа по почте: «я уже делал ранее проверку входа по почте и эта задача из этого появилась» (спайк #102). Записано как утверждение владельца. |
| Architect | Step 7 Codex | Пропущен по вейверу владельца, записан в плане. |
| Architect → Implementer | Добавление сверх ответа | Лимит login на адрес (архитектор добавил к «5 на пользователя») вынесен владельцу вопросом implementer'а, оставлен его решением — не принят молча. |
| Implementer | Код | Спавн `opus`. 5 коммитов по шагам плана, `pnpm check` exit 0 на всех пяти; таблица проверки поломкой на 19 строк, неузкие строки помечены. #165 m2 исправлен попутно. |
| Reviewer | Iteration 1 | Спавн `opus`. **0 Blocker, 0 Major, 7 Minor.** Первый прогон с правкой #170 (3b-3d в foreground): отчёт сдан один раз, после всех трёх субагентов. |
| Tech Lead | Merge / Done | `AskUserQuestion` непосредственно перед мержем → rebase + удаление ветки, `--match-head-commit f306aa9`. `MERGED` 11:27:39Z, Done после подтверждения. |
| Tech Lead | `.env` | По прямой просьбе владельца `BROKER_PARTNER_REF` заменён на короткий код; compose подставляет его; контейнеры не перезапускались. |

### Review iterations: 0 (возвратов ревьюера нет)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Окно лимитов: сброс не переносит ключ в конец порядка вытеснения | Minor | other | Дефект `rate-window.ts` до #172, на который новые лимиты опираются | Architect plan (переиспользовал без проверки поведения при вытеснении) |
| Отказ по адресу тратит слот пользователя; 429 брокера → 502; дубль маппинга; формулировки | Minor ×4 | other | — | Implementer / Architect |
| Повторный ввод кода после потерянного 200 → `invalid_code` | Minor | other | Ответ — единственный канал итога (тот же класс, что m2 #10) | Architect plan → в #171 |
| Стиль тестов и заглушки | Minor | other | Косметика | — |
| Codex не читал ни план, ни код | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Minor-находки ревью #172.** — **вынесено в #173**
2. **Потерянный ответ после коммита — класс, а не экземпляр.** Второй раз за день (m2 #10, находка 4 #172): ответ backend — единственный канал, по которому пользователь узнаёт итог необратимого действия. Для #171 добавлен критерий (перепроверка `/users/start`); общий шаблон «после таймаута — перечитать состояние» стоит предложить архитектору как правило. Владелец: да (2026-10-01). — **внедрено в #175: `.claude/skills/architect/SKILL.md` → Validation checklist**
3. **Пост-фактум Codex по `f306aa9`** — присоединяется к предложению 4 аудита #163. — **открыто (2026-10-01, владелец): после сброса лимита 2026-10-05**

### Что сработало

- Правка #170 (субагенты ревьюера в foreground) сняла преждевременную сдачу отчёта с первого же прогона.

---

## #171 — Вход по email, часть 2: диалог почта → код в боте (2026-10-01)

PR #176, rebase-merged (9 коммитов, голова `2294495`, в `main` до `0cd13d9`), ветка удалена. Часть 2 серии #162 → #171. **Два круга ревью: в первом Blocker/Major нет, но владелец решил не мержить, а исправить Minor 1-2 в этом PR.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Чисто: `main` = `origin/main`, Codex `ready` (вейвер), `gh` по SSH, `.claude/CLAUDE.md` = `origin/main`, Node 22.23.2, Postgres/Redis подняты; открытое предложение 3 аудита #162 — с датой и владельцем. |
| Architect | Clarify + план | Спавн `fable` → `claude-fable-5-1`. 5 вопросов; владелец выбрал 3c (`/start` не сбрасывает диалог) вопреки рекомендации, архитектор записал цену в плане. Кнопка «Изменить адрес» добавлена сверх ответа 4b — вынесена владельцу implementer'ом, не принята молча. Оценка ~1470 строк. Step 7 Codex — пропуск по вейверу, записан. |
| Implementer | Clarify + код | Спавн `opus` → `claude-opus-5-5`. 5 вопросов (разбивку коммитов tech-lead вписал в текст вопроса, а не отдельным вопросом — владелец не возразил). 6 коммитов, `pnpm check` exit 0 на каждом; проверка поломкой убрала защиту вытеснения, которую не ловил ни один тест. |
| Reviewer | Iteration 1 | Спавн `opus`. 0 Blocker, 0 Major, 8 Minor; `/code-review high` назвал R1-1 Major, ревьюер понизил (совпадает с буквой критерия) и вынес владельцу. Владелец: не мержить, чинить 1-2. |
| Architect | Plan Update | Без Codex (итерация 1). Взял 1, 2, 3, 5, 6, 7; находку 3 (уточнение ответа 2a) вынес владельцу — принята. |
| Implementer | Fixes | 4 вопроса, 3 коммита, `pnpm check` exit 0 на каждом, 12 поломок в Gate verification. Отклонение: любой 4xx на send-code → неизвестный исход. |
| Reviewer | Iteration 2 | Весь `gh pr diff`. 0 Blocker, 0 Major, 4 Minor; отклонение implementer'а — Minor 1. |
| Tech Lead | Merge / Done | `AskUserQuestion` перед мержем → rebase + удаление ветки, `--match-head-commit 2294495`. `MERGED` 14:33:32Z, Done после подтверждения. Follow-up #177 (Todo) — после «да» владельца на заголовок и список. |
| Model policy | Check | Все спавны на своих алиасах: architect `claude-fable-5-1`; implementer/reviewer/3b/3c `claude-opus-5-5`; 3d `claude-sonnet-5`. Таблица `.claude/CLAUDE.md` писала `claude-opus-5` — обновлена в этом PR. |

### Review iterations: 1 (один возврат после круга 1)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| R1-1: `too_many_requests` (общий потолок маршрута) сбрасывал диалог | Minor | other | Действие выведено из имени кода, источник отказа не разобран | Architect plan |
| R1-2: 429 на «Запросить код ещё раз» удалял диалог с действующим кодом | Minor | other | То же | Architect plan |
| R1-3: неизвестный исход send-code оставлял на шаге «адрес» | Minor | instance-vs-class | Правило #175 применено к login, не к send-code | Architect plan |
| R1-4: гонка таймаутов бота и брокера (5 с / 5 с) | Minor | other | — | Владелец не заводит |
| R1-5..8, R2-4: тексты, комментарии, housekeeping | Minor | other | Косметика | — |
| R2-1: любой 4xx на send-code → неизвестный исход | Minor | other | catch-all вместо явной строки | Implementer Step 5 → #177 |
| R2-2, R2-3: документация и тесты ветки 4xx, описание схемы кода | Minor | other | — | → #177 |
| Алиас `opus` → `claude-opus-5-5`, таблица писала `claude-opus-5` | Process | single-source | Таблица — запись последней сверки, не обновлялась с #22 | Model policy check |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Источник кода отказа — в таблице кодов плана.** Пункт Validation checklist: для каждого кода ошибки, который клиент превращает в действие, план называет источник (свой лимит / общий потолок / отказ до побочного эффекта / неизвестный исход), действие выводится из источника, код вне таблицы — отдельная строка, не catch-all. — **внедрено в #178: `.claude/skills/architect/SKILL.md` → Validation checklist**
2. **Таблица моделей.** `opus` → `claude-opus-5-5` по наблюдаемому в #163, #10, #171. — **внедрено в #178: `.claude/CLAUDE.md` → Модели по ролям pipeline**
3. **Minor R2-1..3.** — **вынесено в #177**
4. **Пост-фактум Codex по `2294495`** — присоединяется к предложению 4 аудита #163. — **открыто (2026-10-01, владелец): после сброса лимита 2026-10-05**

---

## #179 — Бот: меню команд (пока только /start) (2026-10-01)

PR #182 смержен через rebase: один коммит, голова `6a469ff`, в `main` стал `15c160c`. Ветка удалена. **Один круг ревью, чистый: один Minor, оставлен по решению владельца при мерже.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Чисто: `main` = `origin/main`, открытых PR нет, `gh` авторизован, `.claude/CLAUDE.md` = `origin/main`, Node 22.23.2, у предложений аудита #171 есть статусы. Codex пропущен по вейверу. Первый спавн архитектора прервал владелец. После «продолжай, сверь мастер» `main` пересверен на `5ecca63` (появился #180, затронувший `texts.ts`), и это передано архитектору. |
| Architect | Clarify + план | Спавн `fable` → `claude-fable-5-1`. 4 вопроса, все ответы — рекомендованные варианты. Поведение grammY `onStart` и дефолт кнопки меню проверены по исходнику и документации Bot API. Оценка ~280 строк. Step 7 Codex пропущен по вейверу, пропуск записан. |
| Implementer | Clarify | Спавн `opus` → `claude-opus-5-5`. Найдены два дефекта плана: A1 — шаг 7 падал без ответа на `getUpdates`; A2 — у ветки catch-all нет теста. Оба ушли архитектору, а не владельцу. Владельцу задан вопрос о разбивке коммитов: ответ — один коммит. |
| Architect | Plan Update | Без Codex (вейвер). A1 → фейковый `PollingLoop`, A2 → тест на `TypeError`, аргументы сравниваются с литералами. |
| Implementer | Код | 1 коммит, +315 строк, `pnpm check` exit 0 (1557 тестов). 14 мутаций, и каждая роняет тест. Проверка в реальном чате возможна только после деплоя. |
| Reviewer | Iteration 1 | Спавн `opus`, 3b–3d параллельно. 0 Blocker, 0 Major, 1 Minor (m1). CI зелёный. 3a/6-pre пропущены по вейверу. |
| Tech Lead | Merge / Done | `AskUserQuestion` перед мержем → rebase и удаление ветки, `--match-head-commit 6a469ff`. `MERGED` в 16:34:04Z; статус Done выставлен после подтверждения мержа. |
| Model policy | Check | architect `claude-fable-5-1`; implementer, reviewer, 3b, 3c — `claude-opus-5-5`; 3d — `claude-sonnet-5`. Совпадает с таблицей. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| A1: шаг 7 плана не мог пройти (`captureApi` без ответа `getUpdates`) | Plan defect | unverified-claim | Тестовая обвязка `logging.test.ts` не прочитана при планировании | Architect plan, поймано на Implementer Step 0 |
| A2: у catch-all ветки нет теста | Plan defect | other | Ветка указана в рисках, но не в шагах тестов | Architect plan, поймано на Implementer Step 0 |
| m1: комментарий «`bot started` means polling begins now» не верен при SIGTERM во время `setMyCommands` | Minor | other | Формулировка сильнее кода | Оставлен владельцем при мерже |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Пост-фактум Codex по `15c160c`** присоединяется к предложению 4 аудита #171. — **открыто (2026-10-01, владелец): после сброса лимита 2026-10-05**

---

## #128 — Привязка: сообщение бота об успехе или отказе привязки (2026-10-01)

PR #186 смержен через rebase: один коммит, голова `ddbc0ab`, в `main` стал `7f8c7f3`. Ветка удалена. **Один круг ревью, чистый: 5 Minor вынесены в #187 по решению владельца при мерже.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Чисто: `main` = `origin/main`, открытых PR и задач в работе нет, `gh` авторизован, `.claude/CLAUDE.md` = `origin/main`, Node 22.23.2, compose-стек поднят, у предложения аудита #179 есть статус. Codex пропущен по вейверу. Зависимость #114 открыта — вынесена архитектору вопросом. |
| Architect | Clarify + план | Спавн `fable` → `claude-fable-5-1`. 5 вопросов (транспорт, текст успеха, отказы, #114, await), все ответы — рекомендованные. Предпосылки проверены исполнением: tsc-проба grammY `Api`, runtime-проба (нет `getMe`, токен в `HttpError.message`), `docker compose config`. Оценка ~825 строк. Тело issue переписано. Step 7 Codex пропущен по вейверу, пропуск записан. Задача стартовала из Backlog, а не Todo. |
| Implementer | Clarify | Спавн `opus` → `claude-opus-5-5`. Дефект плана (устаревшие фразы «только `bot` читает `TELEGRAM_BOT_TOKEN`») ушёл архитектору; владельцу — 4 вопроса: один коммит (против рекомендованных 4), мутации локально, 403 → `warn`, живая проверка — владельцем после мержа. |
| Architect | Plan Update | Без Codex. Подтверждены 3 места + найдено 4-е (`.env.example:100-101`) поиском по всему классу. |
| Implementer | Код | 1 коммит, 37 файлов, `pnpm check` exit 0 (1593 теста) с db-тестами на локальном Postgres. 12 мутаций + мутация константы таймаута, каждая роняет тест. |
| Reviewer | Iteration 1 | Спавн `opus`, 3b–3d параллельно. 0 Blocker, 0 Major, 5 Minor + 2 косметики. Весь diff PR, не дельта. CI зелёный. 3a/6-pre пропущены по вейверу. |
| Tech Lead | Merge / Done | `AskUserQuestion` перед мержем → rebase и удаление ветки. `MERGED` в 17:35:50Z; Done — после подтверждения мержа. Follow-up #187 создан по ответу владельца, добавлен в Backlog. |
| Model policy | Check | architect `claude-fable-5-1`; implementer, reviewer, 3b, 3c — `claude-opus-5-5`; 3d — `claude-sonnet-5`. Совпадает с таблицей. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Устаревшие фразы про `TELEGRAM_BOT_TOKEN` в `.env.example`, `ci.yml`, `telegram-logging.ts` | Plan defect | instance-vs-class | План правил часть упоминаний, без поиска по всему классу | Architect plan, поймано на Implementer Step 0 |
| Заблокированному между start и callback советуют повторить /start | Minor | other | Маппинг отказов в плане не учёл блокировку после state | Architect plan → #187 |
| Тест «database fails» не может поймать сбой `linkBrokerAccount` | Minor | unverified-claim | Сбой внедрён до точки, которую тест защищает | Implementer → #187 |
| Граница `elapsed < 2_000` может флакать; формулировка «после коммита linkBrokerAccount» сильнее кода; затенение `...LINK_TEXTS`; шапка `admin/testing.ts` | Minor | other | — | → #187 |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Пост-фактум Codex по `7f8c7f3`** присоединяется к предложению 4 аудита #171. — **открыто (2026-10-01, владелец): после сброса лимита 2026-10-05**
2. **Minor ревью #186.** — **вынесено в #187**
