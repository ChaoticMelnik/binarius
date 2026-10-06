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

---

## #113 — OAuth callback: проверка Telegram initData против владельца state (2026-10-01)

PR #189, rebase-merged (1 коммит, голова `f5d24e4`, в `main` `64473d2`), ветка удалена. 22 файла, +787/−52. Часть 1 из 2 задачи #32; часть 2 — #114. **Один круг ревью, ноль возвратов.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Порядок | #114 зависел от открытой #113; владелец выбрал «сначала #113» (`AskUserQuestion`), а не перенос оценки на архитектора #114. |
| Architect | Clarify + план | Спавн `fable` → `claude-fable-5-1`. 5 вопросов, все рекомендованные. По коду показал, что кнопка «Подтвердить» (#10) закрывает риск лишь частично (подтверждает владелец state; pending-строка блокирует вход жертвы бессрочно) — вынесено владельцу, не решено молча. Носитель — Mini App; кнопка и страница перенесены в #114 комментарием там. Оценка ~880 строк. Step 7 Codex — пропуск по вейверу, записан. |
| Implementer | Clarify + код | Спавн `opus` → `claude-opus-5-5`. 4 вопроса. Один коммит (выбор владельца), 27 поломок в Gate verification, верификатор сверен с подписью Python `hmac`. Половина ручного рецепта без брокера — на одноразовой БД `binarius_113_recipe`, dev-БД и контейнеры не тронуты; push владельцу дошёл (подтверждено владельцем). |
| Reviewer | Iteration 1 | Спавн `opus`; 3b/3c `opus`, 3d `sonnet`. **0 Blocker, 0 Major, 5 Minor**; security review без находок. |
| Tech Lead | Merge / Done | `AskUserQuestion` перед мержем → rebase + удаление ветки, `--match-head-commit f5d24e4`. `MERGED` 19:50:37Z, Done после подтверждения. Требование «Mini App после state» — комментарием в #114. |
| Model policy | Check | Все спавны на алиасах политики, id совпадают с таблицей `.claude/CLAUDE.md` (после #178). |

### Review iterations: 0 (возвратов ревьюера нет)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Неиспользуемые экспорты верификатора; warn на каждый 401; устаревшие оценки размера initData / лимита тела | Minor ×4 | other | Косметика | — (владелец: не заводить) |
| Mini App должен запускаться после выдачи state | Minor | other | Требование к соседней задаче | → комментарий в #114 |
| Флейк staff-login (`staff_login_challenges_code_sent_check` / `confirmed_after_created_check`): 2 красных полных прогона у implementer'а, у ревьюера не воспроизвёлся | Process | other | Вероятно, порядок временных меток в тестах staff-login | Владелец: ждать повтора |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Флейк staff-login.** Завести issue при следующем воспроизведении (решение владельца 2026-10-01: «дождаться повтора»). — **открыто (2026-10-01, владелец): до повтора флейка**
2. **Пост-фактум Codex по `f5d24e4`** — присоединяется к предложению 4 аудита #163. — **открыто (2026-10-01, владелец): после сброса лимита 2026-10-05**

---

## #114 — OAuth callback-страница в apps/web (2026-10-02)

PR #191, rebase-merged (2 коммита, голова `4bc72f0`, в `main` до `2ab2c11`), ветка удалена. 43 файла, +1494/−104. Часть 2 из 2 задачи #32 (часть 1 — #113, PR #189). Включает перенесённое из #113: страница входа Mini App и `web_app`-кнопка бота. **Один круг ревью, ноль возвратов.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead / Owner | Redirect URI | Владелец зарегистрировал `https://binarius.salescreativesads.com/oauth/callback` у брокера; локальный `.env` по просьбе владельца получил этот URI. Факт записан в #114 до планирования. |
| Architect | Clarify + план | Спавн `fable`. 6 вопросов, все рекомендованные. Пробы: `docker compose config` для вложенного дефолта и YAML-якоря, исходник `telegram-web-app.js` (sessionStorage, iframe-родитель `web.telegram.org`), DNS и Caddy на VPS (502 — web не запущен). Оценка ~1650 строк; шаги владельца вне репозитория перечислены. Step 7 Codex — пропуск по вейверу. |
| Implementer | Clarify + код | Спавн `opus`. 5 вопросов; владелец выбрал два коммита (не рекомендованный послойный вариант). 29 поломок в Gate verification; compose проверен только `config` (выбор владельца). Исправил утверждение плана: отклонённый `web_app`-URL не даёт «недоступен» — сообщение не уходит, бот логирует `update handler failed`. |
| Reviewer | Iteration 1 | Спавн `opus`. **0 Blocker, 0 Major, 4 Minor** + заметка про стиль SDK в Telegram Web; security review без подтверждённых находок; open-redirect, CSP по маршрутам, сырой initData и форвард без bearer проверены руками. |
| Tech Lead | Merge / Done | `AskUserQuestion` перед мержем (с предупреждением о переименовании env на VPS) → rebase + удаление ветки, `--match-head-commit 4bc72f0`. `MERGED` 21:10:55Z, Done после подтверждения. Follow-up #192 (Todo) — после «да» владельца на заголовок и список. |
| Owner | Live-test | **Не проведён на момент записи**: нужен деплой на VPS с переименованием `ADMIN_PUBLIC_URL` → `WEB_PUBLIC_URL` и остановленным локальным стеком. Два допущения (sessionStorage через брокера, страница брокера в webview) проверяются только им. |

### Review iterations: 0 (возвратов ревьюера нет)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| `redirect_uri` сравнивается строкой с нормализованным origin | Minor | other | Нормализация с одной стороны сравнения | Architect plan → #192 |
| Формулировка override `BROKER_OAUTH_REDIRECT_URI` в compose/docs | Minor | other | — | → #192 |
| Старое `ADMIN_PUBLIC_URL` под compose молча даёт loopback; план утверждал «не стартует» | Minor | unverified-claim | Поведение fail-fast проверено для `env.ts`, не для compose-дефолта | Architect plan → #192 |
| Дубли и мелкие упрощения | Minor | other | Косметика | → #192 |
| Утверждение плана про отклонённый `web_app`-URL («недоступен») | Process | unverified-claim | Не исполнено до плана; поймал implementer | Architect plan |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Minor ревью #191.** — **вынесено в #192**
2. **Живой тест #114 после деплоя** (телефон, затем Telegram Web; сигнатуры отказов — в ревью PR #191). — **открыто (2026-10-02, владелец): после деплоя на VPS**
3. **Пост-фактум Codex по `4bc72f0`** — присоединяется к предложению 4 аудита #163. — **открыто (2026-10-02, владелец): после сброса лимита 2026-10-05**

---

## #177 — Бот, вход по email: 4xx на send-code — не неизвестный исход (2026-10-02)

PR #194, rebase-merged (2 коммита, голова `e374541`). 5 файлов, +186/−9. **Один круг ревью, ноль возвратов.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`. Исследование ночью без владельца (clarify-only), 5 вопросов, ответы утром (5b — не рекомендованный). Таблица источников кодов отказа по правилу PR #178. Step 7 Codex — вейвер. |
| Implementer | Clarify + код | Спавн `opus`. 4 вопроса; 9 мутаций в Gate verification. ESLint `pnpm check` дважды краснел на чужих `.claude/worktrees/**` — записано в PR, исправлено в #166. |
| Reviewer | Iteration 1 | 0 Blocker, 0 Major, 2 Minor; владелец: не заводить задачу. |
| Tech Lead | Merge / Done | Подтверждение перед мержем, rebase, `--match-head-commit`. |

### Review iterations: 0

---

## #192 — Web: нормализация redirect_uri, отказ запуска при старом ADMIN_PUBLIC_URL (2026-10-02)

PR #195, rebase-merged (6 коммитов, голова `f96d581`). 17 файлов, +202/−70. **Один круг ревью, ноль возвратов.** Minor m1-m3 → #197.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`, ночью clarify-only. Pre-implementation Plan Update по дефекту implementer'а (хвостовые `?`/`#` → производная проверка «голого» origin, плюс `\` и пробел). Step 7 Codex — вейвер. |
| Implementer | Код | Спавн `opus`, свой worktree. CI `compose` упал на первом push: Compose 2.38.2 раннера вычисляет вложенный `:?` в `${A+…}` всегда — guard перенесён в `web.init` (булево), проверено на 2.38.2 и 5.5.1 отдельным бинарём. |
| Reviewer | Iteration 1 | 0 Blocker, 0 Major, 4 Minor (m1-m3 → #197). |

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Guard `${A+${B:?}}` ломал каждый `compose config` на раннере | Process | env-parity | Правило «CI-tooling на версии раннера» не применено к compose; проверено только на 5.5.1 | Architect plan → **внедрено в #207** |

### Review iterations: 0

---

## #103 — Mock-брокер: REST-фикстура Broker API (2026-10-02)

PR #196, rebase-merged после **3 кругов (лимит)**, голова `f3ac5cd`, +3070 (выше потолка 3000 с согласия владельца, прирост — тесты). Остаток m11-m15 → #204.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`, ночью clarify-only; read-only пробы живого API. Q3 (деньги строками) и Q4 (chart только в фикстуре) — против рекомендации, записаны как accepted risk. |
| Reviewer | Iteration 1 | 1 Major (M1: auth до задержки) + 8 Minor → Plan Update без Codex. |
| Reviewer | Iteration 2 | 1 Major (M2: регрессия от фикса M1) → смена подхода (владелец: перепроектировать `onRequest`), Codex re-check — вейвер. |
| Reviewer | Iteration 3 | 0 Blocker/Major, 5 Minor → #204 с «да» владельца; LGTM не ставился. Первый спавн R3 умер на API 403 (`claude-opus-5-5`), повтор прошёл. |

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| M1 | Major | other | Состояние прочитано до `await` | Architect plan |
| M2 | Major | instance-vs-class | Фикс M1 не прошёл все пути записи | Architect Plan Update R1 |
| Общий scratchpad: чужой `check.sh` перезаписан, один `pnpm check` прошёл не в том дереве | Process | other | Параллельные агенты в одном scratchpad | Tech Lead → **внедрено в #207** |

### Review iterations: 2

---

## #166 — DB-тесты: часы и таймауты (2026-10-02)

PR #203, rebase-merged (6 коммитов, голова `3efec56`). **Два круга ревью, один возврат.** Minor раунда 2 → #206; дедлайны внутри тестов → #205.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Исследование | Ночью исполнением найдена причина флейка: `lima-guestagent` шагает часы VM назад (Lima #5543). |
| Implementer | R0 | Drop-in без CAP_SYS_TIME с авторизацией владельца; позитивный контроль 96 → 0 шагов; приёмка в устойчивом состоянии. |
| Reviewer | R1 | Major: после сна Mac часы VM на 84 мин позади (подтверждено tech-lead'ом). **Откат drop-in'а** tech-lead'ом с «да» владельца в тот же час. |
| Architect | Plan Update | Владелец: нативный PostgreSQL 18 на хосте (5434, `TEST_DATABASE_URL`, preflight). |
| Implementer | R1 | Остановился на непредусмотренных апгрейдах brew (`--dry-run \| head` раньше их скрыл); владелец разрешил ровно 5 изменений. Приёмка 10/10 + 3/3, 0 шагов, 0 skew. |
| Reviewer | R2 | 0 Blocker/Major, Minor → #206. |

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Часы VM после сна | Major | env-parity | Приёмка без sleep/wake; пробник без проверки расхождения с хостом | Architect plan → **внедрено в #207** |
| Усечённый `brew --dry-run` | Process | unverified-claim | Вывод инструмента обрезан `head` | Implementer → **внедрено в #207** |

### Review iterations: 1

### Process improvement proposals (все четыре задачи)

1. **Compose на версии раннера + раздел «среда разработчика» в плане.** — **внедрено в #207: `.claude/skills/architect/SKILL.md` → Task classes (Compose / env, Developer environment)**
2. **Параллельные implementer'ы на одной машине** (свой worktree через `git worktree add` + lock, свой scratch-подкаталог, sub-skills на `gh pr diff`, окно общего Postgres). — **внедрено в #207: `.claude/skills/tech-lead/SKILL.md` → Conflict detection → Step 7**
3. **Minor-находки:** #177 — владелец: не заводить; #192 → **вынесено в #197**; #103 → **вынесено в #204**; #166 → **вынесено в #206**, дедлайны в тестах → **вынесено в #205**.
4. **Пост-фактум Codex по `e374541`, `f96d581`, `f3ac5cd`, `3efec56`** — присоединяется к предложению 4 аудита #163. — **открыто (2026-10-02, владелец): после сброса лимита 2026-10-05**

---

## #198 — Бот: стиль сообщений — «ты», эмодзи, HTML-разметка с экранированием (2026-10-02)

PR #208 смержен через rebase: 5 коммитов, голова `1e12991`, в `main` — `7bb90e8`. Ветка удалена. **Два круга ревью.** Круг 1: 8 Minor; владелец решил исправить m1–m5 до мержа. Круг 2 чистый, найдено ещё 5 Minor. Оставшиеся m6–m8 и n1–n5 вынесены в #209 после «да» владельца.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Чисто: `main` = `origin/main` (`0f427df`), открытых PR нет, ничего не в работе, `.claude/CLAUDE.md` = `origin/main`, Node 22.23.2, compose поднят, у всех предложений аудита #166 есть статусы. Codex пропущен по вейверу. |
| Architect | Clarify + план | Спавн `fable` → `claude-fable-5-1`. 5 вопросов; владелец отошёл от рекомендации в одном: эмодзи на всех кнопках. Полный текст каждого сообщения и каждой кнопки — в плане (ответ владельца 2); владелец утвердил тексты до старта implementer'а. Оценка ~860 строк. Codex пропущен. |
| Implementer | Clarify | Спавн `opus` → `claude-opus-5-5`. 4 вопроса; Q4 (одинаковые имена с `apps/web`) отдан архитектору. Plan Update: переименование в `telegramHtml`/`TelegramHtml`/`escapeTelegramHtml`, проверено tsc-пробой. |
| Implementer | Код | 4 коммита, на каждом `pnpm check` exit 0. Тексты сверены с планом скриптом; 29 мутаций модуля. Отклонения от плана записаны в PR: type-only экспорт класса из-за TS4094, коды оракула TS2724/TS1362. |
| Reviewer | Iteration 1 | Спавн `opus`. Первый запуск завис по stream watchdog, ничего не опубликовав; его продолжили через `SendMessage` после проверки GitHub. 0 Blocker, 0 Major, 8 Minor. m1 противоречит ответу владельца «все цитаты в доках»; LGTM не опубликован до решения владельца. |
| Architect | Plan Update | Без Codex (итерация 1). Поиск устаревших цитат — по самим текстам, с таблицей находок; `"` → `&quot;`; seam закрывает `entities`. |
| Implementer | Fixes | 3 вопроса, коммит один (решение владельца). `pnpm check` exit 0, мутации для m4/m5. Попутно исправлены ещё два ложных утверждения того же класса. |
| Reviewer | Iteration 2 | Весь `gh pr diff 208`. m1–m5 держатся, найдено 5 новых Minor (n1–n5). CI зелёный. |
| Tech Lead | Merge / Done | Перед мержем спросил через `AskUserQuestion` → rebase и удаление ветки, `--match-head-commit 1e12991`. `MERGED` в 14:43:45Z, после этого — Done. Задача #209 заведена после «да» владельца. |
| Model policy | Check | Architect `claude-fable-5-1`; implementer, reviewer, 3b, 3c — `claude-opus-5-5`; 3d — `claude-sonnet-5-5`. В таблице `.claude/CLAUDE.md` было `claude-sonnet-5`; исправлено в этом PR. |

### Review iterations: 2 (один возврат после круга 1)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| m1, m2: устаревшие цитаты в `docs/bot-start.md` и `docs/binodex-oauth.md` | Minor | instance-vs-class | Поиск шёл по символу кавычки `«` и только по одному файлу | Architect plan |
| m3: правило стиля в доке шире утверждённых текстов | Minor | unverified-claim | Правило записано без сверки с текстами | Implementer docs |
| m4: `"` не экранировалась | Minor | other | Набор экранирования взят для текстового контекста, атрибуты не учтены | Architect plan |
| m5: seam пропускал `entities` | Minor | other | `Omit` закрыл только `parse_mode` | Architect plan |
| n1: устаревшая цитата в комментарии `texts.ts` | Minor | instance-vs-class | Поиск по Plan Update не включал файлы, где определены константы | Architect Plan Update |
| n2–n5, m6–m8 | Minor | other | Вынесено | → #209 |
| Ревьюер завис по stream watchdog | Process | other | Сбой harness; ничего не было опубликовано, агента продолжили | — |
| `gh issue comment --jq` молча не сработал (второй раз после #179) | Process | single-source | Шаблон в `/github` не говорил, что флаг не поддерживается | — |
| Алиас `sonnet` разрешается в `claude-sonnet-5-5`, в таблице было `claude-sonnet-5` | Process | single-source | Таблица — запись последней сверки | Model policy check |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Поиск устаревших цитат — по самим текстам.** Когда меняются тексты, видимые пользователю, план ищет старые тексты сами по себе по `docs/`, README, комментариям и файлам констант и перечисляет найденное. — **внедрено в #210: `.claude/skills/architect/SKILL.md` → Validation checklist**
2. **`gh issue comment` и `gh pr comment` не принимают `--jq`.** — **внедрено в #210: `.claude/skills/github/SKILL.md` → Operation: Post a comment**
3. **Таблица моделей:** `sonnet` → `claude-sonnet-5-5`. — **внедрено в #210: `.claude/CLAUDE.md` → Модели по ролям pipeline**
4. **Minor m6–m8 и n1–n5.** — **вынесено в #209**
5. **Пост-фактум Codex по `7bb90e8`** — присоединяется к предложению 4 аудита #171. — **открыто (2026-10-02, владелец): после сброса лимита 2026-10-05**

---

## #209 — telegram-html и тексты бота: Minor из ревью #198 (2026-10-02)

PR #211 смержен через rebase: 7 коммитов, голова `af07763`, в `main` — `6817c1c`. Ветка удалена. **Один круг ревью, чистый: 2 Minor, оставлены по решению владельца при мерже.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | `main` = `origin/main` (`be6f038`), сразу после мержа docs-PR #210. Открытых PR нет. Codex пропущен по вейверу. |
| Architect | Clarify + план | Спавн `fable`. 5 вопросов, все ответы — рекомендованные варианты. Поиск устаревших цитат по самим текстам (правило из #210) нашёл ещё одну цитату того же класса (`bot.test.ts:554`). Оценка ~200 строк. Codex пропущен. |
| Implementer | Clarify | Спавн `opus`. 4 вопроса и дефект плана D1: в deny-list не хватало двух алиасов `*ToChannel`. Plan Update вывел алиасы из типа `Other<"X">`, а не по форме имени; команда вывода запущена, проверено 48 имён. |
| Implementer | Код | 7 коммитов, на каждом `pnpm check` exit 0. Каждая новая проверка доказана мутацией; lint-проба прогнана на старом и новом правиле. В тестовой строке плана была ошибка (`<b> </b>`), её поймал первый прогон. |
| Reviewer | Iteration 1 | Спавн `opus`, 3b–3d параллельно. 0 Blocker, 0 Major, 2 Minor и 1 nit. Мутации и команды вывода перезапущены на head. CI зелёный. |
| Tech Lead | Merge / Done | Перед мержем спросил через `AskUserQuestion` → rebase и удаление ветки, `--match-head-commit af07763`. `MERGED` в 15:57:13Z, после этого — Done. Для m2 в описание PR добавлена пометка. |
| Model policy | Check | architect `claude-fable-5-1`; implementer, reviewer, 3b, 3c — `claude-opus-5-5`; 3d — `claude-sonnet-5-5`. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| D1: в deny-list не хватало `sendGiftToChannel`/`replyWithGiftToChannel` | Plan defect | instance-vs-class | Алиасы искались по форме имени, а не по целевому методу | Architect plan; поймано на Implementer Step 0 |
| Тестовая строка `<b> </b>` для «пустого» не могла пройти | Plan defect | unverified-claim | Пример в плане не прогнан | Architect plan; поймано первым прогоном |
| m1: доки говорят «каждый метод с разбираемым текстом», но `quote_parse_mode` в `reply_parameters` не учтён | Minor | unverified-claim | Формулировка шире, чем то, что ищет шаг вывода | Оставлен владельцем при мерже |
| m2: устаревшие числа тестов в описании PR | Minor | other | Числа не перепроверены после следующих коммитов | В описание PR добавлена пометка |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Пост-фактум Codex по `6817c1c`** присоединяется к предложению 4 аудита #171. — **открыто (2026-10-02, владелец): после сброса лимита 2026-10-05**

---

## #200 — Бот: закреплённая карточка аккаунта после подключения (2026-10-02)

PR #213 смержен через rebase: 4 коммита, голова `7f100eb`, в `main` — `8e5b078`. Ветка удалена. **Один круг ревью, чистый: 3 Minor вынесены в #214 по решению владельца.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | `main` = `origin/main` (`ef713ce`), открытых PR нет. Codex пропущен по вейверу. |
| Tech Lead | Картинка | Владелец попросил сгенерировать картинку («пока сгенерируй сам, позже добавим нашу»). Сделана как HTML-страница и снята скриншотом Playwright: JPEG 1280×640, 68 КБ. Владелец утвердил её вместе с текстами. |
| Architect | Clarify + план | Спавн `fable`. 7 вопросов, все ответы — рекомендованные варианты. Тексты были в плане, владелец утвердил их до старта implementer'а. Бюджеты бота подняты (45/50/55 с), цепочка таймаутов backend не тронута. Codex пропущен. |
| Implementer | Clarify | Спавн `opus`. 3 вопроса и дефект плана: на перепроверке карточка показала бы адрес, который не подключали. Plan Update: на перепроверке `email: null`; две другие точки активации проверены. |
| Implementer | Код | 4 коммита. Первая версия коммита 2 сделана на красной проверке (`;` вместо `&&`); её не пушили, отменили и пересобрали на зелёной. Агент остановлен лимитом API посреди коммита 3; состояние проверено, агент продолжил с того же места. Отдельный loopback-тест проверяет загрузку настоящего файла. |
| Reviewer | Iteration 1 | Спавн `opus`, 3b–3d параллельно. Каждый коммит перепроверен в отдельном worktree (tsc, eslint, vitest). 0 Blocker, 0 Major, 3 Minor. CI зелёный. |
| Tech Lead | Merge / Done | Перед мержем спросил через `AskUserQuestion` → rebase и удаление ветки, `--match-head-commit 7f100eb`. `MERGED` в 20:06:06Z, после этого — Done. Задача #214 заведена по ответу владельца. |
| Model policy | Check | architect `claude-fable-5-1`; implementer, reviewer, 3b, 3c — `claude-opus-5-5`; 3d — `claude-sonnet-5-5`. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Карточка на перепроверке с адресом, который не подключали | Plan defect | unverified-claim | План взял `state.email`, не проверив, что перепроверка знает, какой аккаунт активен | Architect plan; поймано на Implementer Step 0 |
| Коммит на красной проверке (`;` вместо `&&`) | Process | other | Проверку и коммит соединили оператором, который не смотрит на код выхода | Implementer Step 5; поймано самим implementer'ом до push |
| m1: сбой транспорта у текстового фолбэка логируется без `method` (тот же класс в `sendWelcome`) | Minor | instance-vs-class | Форма скопирована из `sendWelcome` вместе с пробелом | → #214 |
| m2: пустой email от брокера даёт пустую строку 📧 | Minor | other | Контракт `z.string()` пропускает пустую строку | → #214 |
| m3: дубли в коде | Minor | other | — | → #214 |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Проверку и коммит соединять через `&&`, никогда через `;`.** — **внедрено в #215: `.claude/skills/implementer/SKILL.md` → Step 5**
2. **Minor m1–m3.** — **вынесено в #214**
3. **Пост-фактум Codex по `8e5b078`** присоединяется к предложению 4 аудита #171. — **открыто (2026-10-02, владелец): после сброса лимита 2026-10-05**

---

## #199 — Бот: профиль — описание «Что умеет этот бот?» и короткое описание (2026-10-02)

PR #216 смержен через rebase: 3 коммита, голова `f33ad38`, в `main` — `a08bd86`. Ветка удалена. **Один круг ревью, чистый: 1 Minor добавлен в #214 по решению владельца.** Это последняя из трёх задач, которые владелец выбрал 2026-10-02 (#198 → #209 → #200 → #199).

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | `main` = `origin/main` (`b63cf84`), открытых PR нет. Codex пропущен по вейверу. |
| Architect | Clarify + план | Спавн `fable`. 5 вопросов, все ответы — рекомендованные варианты. Тексты описания и короткого описания владелец выбрал прямо в вопросах, поэтому отдельного шага утверждения текстов не было. Оценка ~290 строк. Codex пропущен. |
| Implementer | Clarify | Спавн `opus`. 2 вопроса и 2 дефекта плана: мутация (g) не роняла назначенный ей тест; длины посчитаны неверно (352/80 единиц UTF-16, а не 346). Архитектор проверил оба исполнением; Plan Update. |
| Implementer | Код | 3 коммита, каждый через `pnpm check && git commit` (правило из #215), на каждом exit 0. Проба таймингов из плана заменена на пробу, которая ломает только новую проверку. |
| Reviewer | Iteration 1 | Спавн `opus`, 3b–3d параллельно. Каждый коммит перепроверен отдельно, мутации перезапущены. 0 Blocker, 0 Major, 1 Minor. CI зелёный. |
| Tech Lead | Merge / Done | Перед мержем спросил через `AskUserQuestion` → rebase и удаление ветки, `--match-head-commit f33ad38`. `MERGED` в 20:44:59Z, после этого — Done. Minor добавлен в #214. |
| Model policy | Check | architect `claude-fable-5-1`; implementer, reviewer, 3b, 3c — `claude-opus-5-5`; 3d — `claude-sonnet-5-5`. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Мутация (g) (`Promise.all`) не могла уронить тест на порядок вызовов | Plan defect | unverified-claim | Мутация не прогнана против назначенного ей теста | Architect plan; поймано на Implementer Step 0 |
| Проба таймингов ломала и старую проверку | Plan defect | unverified-claim | То же | Architect plan; поймано implementer'ом |
| Длины текстов посчитаны в кодовых точках, а не в единицах UTF-16 | Plan defect | unverified-claim | Цифра записана без измерения `String#length` | Architect plan; поймано на Implementer Step 0 |
| Minor 1: тест на HTML-сущности уже, чем обещает документация | Minor | unverified-claim | Фраза в доке шире регулярки | → #214 |
| Codex не читал ни план, ни код, ни этот docs-PR | Process | codex-ops | Вейвер владельца до 2026-10-05 | — |

### Process improvement proposals

1. **Каждую пробу или мутацию, которую план называет доказательством, прогонять против текущего кода до публикации плана.** Она должна ломать ровно свою проверку. — **внедрено в #217: `.claude/skills/architect/SKILL.md` → Validation checklist**
2. **Minor 1.** — **вынесено в #214**
3. **Пост-фактум Codex по `a08bd86`** присоединяется к предложению 4 аудита #171. — **открыто (2026-10-02, владелец): после сброса лимита 2026-10-05**

---

## #97 — ARCH-01: декодер payload и нормализатор событий брокера (2026-10-03)

PR #218 смержен через rebase: 2 коммита, голова `62c1d18`, в `main` — `8dbe7b4`, `220291d`. Ветка удалена. **Один круг ревью, чистый, 3 Minor.** Первая задача цепочки ARCH-01 (#97 → #98 → #104 → #99 → #100 → #101), план готовился волнами по решению владельца 2026-10-02.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | `main` = `origin/main`, CLAUDE.md без расхождений, Postgres/Redis подняты. Codex пропущен по вейверу. Планирование шло из read-only worktree `origin/main`: основной checkout был занят другой сессией. |
| Architect | Clarify + план | Спавн `fable`. 5 вопросов, все — рекомендованные варианты; выяснилось, что декодер уже есть в shared, и задача свелась к нормализатору. Оценка ~1050 строк. |
| Implementer | Clarify | Спавн `opus`. 5 вопросов, 1 дефект плана: живая проба 2026-10-02 показала, что `user.auth.success` приходит с одним аргументом `null`, и план считал бы его лишним при каждой авторизации. Plan Update — архитектор на `opus` (решение владельца 2026-10-03: Fable-лимит сессии исчерпан). |
| Implementer | Код | 2 коммита, `pnpm check` exit 0 перед каждым, 13 мутаций в Gate verification. Один прогон наложился на прогон #85: pgrep-проверка напечатала чужой прогон, но не остановила команду; повтор после него — exit 0. |
| Reviewer | Iteration 1 | Спавн `opus`, 3b–3d параллельно. 0 Blocker, 0 Major, 3 Minor. Подскиллы загрузили diff основного checkout'а; агенты это заметили и проверили `gh pr diff 218` вручную. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase и удаление ветки, `--match-head-commit 62c1d18`. `MERGED`, после этого — Done. |
| Model policy | Check | architect `claude-fable-5-1`, Plan Update `claude-opus-5-5` (по решению владельца); implementer, reviewer, 3b, 3c — `claude-opus-5-5`; 3d — `claude-sonnet-5-5`. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| `user.auth.success` с аргументом `null` считался бы лишним аргументом | Plan defect | unverified-claim | Форма события взята из исходников broker-web, живьём не наблюдалась до плана | Architect plan; поймано на Implementer Step 0 после живой пробы |
| `docs/broker-socket.md`: `open_trade_fail[].field` не назван свободным текстом брокера | Minor | other | Перечисление полей с текстом брокера неполное | Implementer docs |
| Описание PR: аннотации мапперов якобы нужны, потому что вывод падает в `unknown` — tsc без них проходит | Minor | unverified-claim | Причина не проверена удалением аннотаций | Implementer |
| Два избыточных теста | Minor | other | — | Implementer |
| pgrep-проверка печатала чужой прогон, но не останавливала `pnpm check` | Process | preflight | Правило Step 7 не говорило, что проверка обязана останавливать | Tech-lead Step 7 |
| Подскиллы ревью загрузили diff основного checkout'а | Process | other | Указание в брифе подскилл не соблюдает | Tech-lead Step 7 |

### Process improvement proposals

1. **Проверка на чужой прогон обязана останавливать команду, а не только печатать.** — **внедрено в #221: `.claude/skills/tech-lead/SKILL.md` → Step 7, Shared-resource window**
2. **Подскиллам ревью — diff файлом и путь worktree, запрет checkout в основном checkout'е.** — **внедрено в #221: `.claude/skills/tech-lead/SKILL.md` → Step 7, Sub-skills**
3. **3 Minor ревью PR #218** — **открыто (2026-10-03, владелец): PR смержен с ними, Minor в комментарии ревью; отдельная задача — по решению владельца**
4. **Пост-фактум Codex по `220291d`** присоединяется к предложению 4 аудита #171. — **открыто (2026-10-03, владелец): после сброса лимита 2026-10-05**

---

## #85 — Whitelist-сериализатор `err` в логах (2026-10-03)

PR #219 смержен через rebase: 3 коммита, голова `f8cbd48`, в `main` — до `a49f30b`. Ветка удалена. **Один круг ревью, чистый, 5 Minor.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Как у #97 (параллельная волна). |
| Architect | Clarify + план | Спавн `fable`. 5 вопросов, все — рекомендованные варианты; пробы pino/Fastify (наследование сериализаторов, `hooks.logMethod`, тип `logger.serializers.err`). Оценка ~430 строк. |
| Implementer | Clarify | Спавн `opus`. 5 вопросов, 1 дефект плана: у `new TypeError()` поле `name` не собственное, и буквальное прочтение плана ломало все тесты `errorIdentity`. Plan Update — архитектор на `opus`, вариант A с проверкой формы identity. |
| Implementer | Код | 3 коммита, `pnpm check` exit 0 после каждого, pgrep перед каждым прогоном. Мутация порядка веток из плана не могла упасть — заменена на ту, что падает, замена названа в PR. |
| Reviewer | Iteration 1 | Спавн `opus`, 3b–3d. 0 Blocker, 0 Major, 5 Minor. Форк `/code-review` переключил основной checkout на ветку PR на ~2 минуты и вернул `main`; потерь нет. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase и удаление ветки, `--match-head-commit f8cbd48`. `MERGED`, после этого — Done. |
| Model policy | Check | Как у #97. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| `name` у `Error` унаследован, не собственный | Plan defect | unverified-claim | Утверждение об «own name» не проверено на стандартной ошибке | Architect plan; поймано на Implementer Step 0 |
| `loggerInstance: pino(...)` ломал тип возврата `buildApp` (TS2322) | Plan defect | unverified-claim | tsc-проба плана компилировала только вызов `Fastify(...)` | Architect plan; поймано implementer'ом |
| m1: `log.error(null, err)` не назван в списках «не покрыто» | Minor | unverified-claim | Форма вызова не перебрана | Architect plan |
| m2: `code` берётся из любого объекта | Minor | other | Не регрессия: раньше логировался весь объект | — |
| m3: «имя только у формы identity» шире кода (любой `Error` тоже) | Minor | unverified-claim | Формулировка шире места enforcement | Implementer docs |
| m4: backend раскладывает `LOG_SERIALIZERS`, а не `logOptions(level).serializers` | Minor | single-source | — | Implementer |
| m5: дублирование ветки `cause`, лишние override'ы `SafeLogController` | Minor | other | — | Implementer |

### Process improvement proposals

1. **tsc-проба для изменения фабрики компилирует экспортируемую сигнатуру потребителя, а не только место вызова.** — **внедрено в #221: `.claude/skills/architect/SKILL.md` → Validation checklist**
2. **5 Minor ревью PR #219** — **открыто (2026-10-03, владелец): PR смержен с ними, Minor в комментарии ревью; отдельная задача — по решению владельца**
3. **Пост-фактум Codex по `a49f30b`** присоединяется к предложению 4 аудита #171. — **открыто (2026-10-03, владелец): после сброса лимита 2026-10-05**

---

## #98 — ARCH-01: REST-клиент Broker API (2026-10-03)

PR #222 смержен через rebase: 3 коммита, голова `4b1f331`. Ветка удалена. **Один круг ревью, чистый, 4 Minor.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`. Ответ владельца на вопрос о деньгах — живая проба вместо вариантов: tech-lead прогнал read-only скрипт в backend-контейнере на токене сохранённого аккаунта (токен не печатался). Деньги — JSON-целые, `level` — объект. Оценка ~1220 строк. |
| Implementer | Clarify + код | Спавн `opus`. 5 вопросов; устаревший текст `docs/broker-socket.md` (#97) поправлен в PR по выбору владельца вместо Plan Update. Rebase после мержа #85, лог-тест на `logOptions`. 3 коммита, `pnpm check` exit 0 на каждом, 36 мутаций. |
| Reviewer | Iteration 1 | Спавн `opus`. 0 Blocker, 0 Major, 4 Minor. Diff — файлом (правило #221), но `/code-review` всё равно ревьюил main. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase; единица денег записана предусловием в #99 и #100. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Единица денег не подтверждена: при целых единицах profit почти всегда дробный и `openTrade` даст `contract_violation`, при минорных — ×100 | Minor | unverified-claim | Аккаунт без сделок, живой пробой не проверить | Принято в плане; → предусловие #99/#100 |
| Тело ошибки читается целиком до проверки `MAX_ERROR_BODY_CHARS` | Minor | other | — | Implementer |
| «Дробь отвергается» шире кода (`12.0000000000000001` → 12) | Minor | unverified-claim | Формулировка шире `z.int()` | Implementer docs |
| Ожидание в тесте #97 сменилось `invalid_type` → `invalid_union` | Plan gap | unverified-claim | План утверждал, что тесты #97 пройдут без правок | Architect plan |

### Process improvement proposals

1. **Единица денег — предусловие #99 и #100** — **внедрено: комментарии в #99 и #100 (2026-10-03)**
2. **Пост-фактум Codex по `4b1f331`** — **открыто (2026-10-03, владелец): после сброса лимита 2026-10-05**

---

## #119 — Уведомления: блокировка бота пользователем останавливает рассылки (2026-10-03)

PR #223 смержен через rebase: 4 коммита, голова `1a33f6c`. **Один круг ревью, чистый, 4 Minor + мелочи.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План | Подготовлен в предыдущей сессии вместе с #185 и #120. |
| Implementer | Clarify + код | Спавн `opus`. 4 вопроса; противоречие планов #119 и #185 (оба «первые», оба владеют `users.ts`/`user-ops.ts`) решил владелец: файлы за #119. Полный `pnpm check` только на голове — выбор владельца. Миграция 0009 (один ADD COLUMN) применена к общей тестовой БД. 28 мутаций. |
| Reviewer | Iteration 1 | Первый спавн умер на лимите сессии вместе с ещё двумя ревьюерами, ничего не опубликовав; повтор после сброса — 0 Blocker, 0 Major. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase; Minor про Rule 5 и формулировки перенесены в #120. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Планы #119 и #185 противоречили в порядке мержа и владении файлами | Plan defect | single-source | Планы одной волны писались без сверки друг с другом | Architect plan; поймано на Implementer Step 0 |
| Тест «ignores unknown keys» не может упасть | Minor | unverified-claim | `parsed.success && …` проходит при неуспехе | Implementer |
| `docs/bot-start.md` и Rule 19 шире кода | Minor | unverified-claim | Обещания на будущих отправителей | → #120 |
| Rule 5 без порядка `users → notification_jobs` | Minor | other | — | → #120 |
| Три параллельных ревью исчерпали лимит сессии | Process | other | Каждый ревьюер — три opus/sonnet подагента | Tech-lead Step 7 |

### Process improvement proposals

1. **Планы одной волны сверяют владение общими файлами и порядок мержа** — **внедрено в #226: `.claude/skills/architect/SKILL.md` → Step 4**
2. **Не больше двух ревьюеров одновременно** — **внедрено в #226: `.claude/skills/tech-lead/SKILL.md` → Step 7**
3. **Minor Rule 5 и формулировки** — **вынесено в #120 (комментарий 2026-10-03)**

---

## #185 — Бот: команда /account (2026-10-03)

PR #224 смержен через rebase: 3 коммита, голова `3e515b4` (после rebase на #119). **Один круг ревью, чистый, 2 Minor.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Implementer | Clarify + код | Спавн `opus`. 5 вопросов; новый код в `account.ts`/`account-ops.ts` по решению владельца. `pnpm check` exit 0 перед каждым коммитом. После мержа #119 — rebase с конфликтами (только добавления); rebase стёр subject'ы коммитов (`#185` как комментарий git), пересобраны через `git commit-tree`. |
| Reviewer | Iteration 1 | Первый спавн умер на лимите; повтор — по перебазированной голове, резолюция конфликтов проверена. 0 Blocker, 0 Major. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| `git rebase` счёл строки `#185: …` комментариями и стёр subject'ы | Process | other | `core.commentChar` по умолчанию `#`, формат коммитов начинается с `#` | Implementer rebase |
| Тест «escaped once» не может упасть | Minor | unverified-claim | — | Implementer |
| Проверка «есть активная привязка» продублирована | Minor | other | — | Implementer |

### Process improvement proposals

1. **Rebase с форматом `#<N>:`** — `git -c core.commentChar=';' rebase …`, иначе subject'ы теряются — **внедрено в #245: `.claude/skills/implementer/SKILL.md` → Step 6 (повтор на #138, 2026-10-03)**

---

## #104 — Mock-брокер: Socket.IO-фикстура с управляемыми сценариями (2026-10-03)

PR #225 смержен через rebase: 4 коммита, голова `94bba0e`. **Два круга ревью: после первого владелец выбрал строгий вариант m1 до мержа.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`, живая WS-проба (порядок событий, Buffer, лишние события, обрыв ~16.7 с). Агент упал на лимите Fable после публикации плана — проверено по GitHub, повтора не было. |
| Implementer | Clarify + код | Спавн `opus`. 3 вопроса, docs переложены на текст #98. Противоречие плана (таблица open_trade vs решение 4) решено в пользу решения 4. 25 мутаций. |
| Reviewer | Iteration 1 | Первый спавн умер на лимите; повтор — 0 Blocker, 0 Major, 3 Minor; code-review агент оценил m1 как Major, ревьюер понизил. |
| Tech Lead | Iteration 1 → fix | Владелец выбрал «строго: исправить до мержа». Issue → Todo, Plan Update (`opus`, без Codex), фикс одним коммитом, rebase на #119. |
| Reviewer | Iteration 2 | Ревью всего PR, не только фикса. 0 Blocker, 0 Major, 2 Minor. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase. |

### Review iterations: 2

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| m1: сценарий open_trade тратится до проверки auth; delayMs открывал сделку для пользователя на момент срабатывания | Minor → исправлен | single-source | План описывал порядок в двух местах по-разному | Architect plan |
| r2-m1: строка disconnect с delayMs 50 мс может пройти, ничего не доказав | Minor | unverified-claim | Нет ожидания `sockets()` пустых | Implementer |
| r2-m2: «There are no timers» и «ответ отправителю» в docs | Minor | unverified-claim | Старые формулировки не найдены поиском | Implementer docs |

### Process improvement proposals

1. **`/code-review` не вызывать как Skill — рецепт вручную по diff-файлу** (ревьюил main во всех пяти ревью этой волны) — **внедрено в #226: `.claude/skills/reviewer/SKILL.md` → 3c**
2. **Пост-фактум Codex по #119, #185, #104** присоединяется к предложению 4 аудита #171 — **открыто (2026-10-03, владелец): после сброса лимита 2026-10-05**

---

## #120 — Уведомления: настройки частоты и /support (2026-10-03)

PR #227 смержен через rebase: 6 коммитов, голова `529e14b`. **Два круга ревью: 1 Major в первом, второй — чистый.** Последняя задача волны #119 → #185 → #120.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План | Подготовлен в предыдущей сессии, тексты утверждены владельцем 2026-10-03. |
| Implementer | Clarify + код | Спавн `opus`. 5 вопросов, включая перенос Minor из ревью #119 (Rule 5, формулировки). Ветка от `main` после #119 и #185. 5 коммитов, `pnpm check` exit 0 перед каждым, миграция 0010 (ADD COLUMN + CHECK). Дефект плана — лог под ключом pino `level` — исправлен в коде. |
| Reviewer | Iteration 1 | Спавн `opus`, 3c по diff-файлу вручную (правило #226 соблюдено). 1 Major, 6 Minor. CHECK 0010 прогнан на NULL и границах. |
| Architect | Plan Update | Спавн `opus`, без Codex (раунд 1). Классификация отказа правки по `error_code` и тексту Telegram, проверено по исходникам grammY и telegram-bot-api; поиск того же класса — других правок сообщений нет. |
| Implementer | Fix | Rebase на `main` после #226 без конфликтов, один fix-коммит; тест двойного нажатия красный на старой голове. |
| Reviewer | Iteration 2 | Ревью всего PR. 0 Blocker, 0 Major, 1 Minor + 1 nit. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase. |

### Review iterations: 2

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| M1: любой отказ правки `/settings` → повторная отправка; двойное нажатие давало дубль | Major → исправлен | instance-vs-class | План разобрал только отказ на кнопке текущего уровня, а не все отказы правки; пункт чек-листа об источнике каждого кода ошибки (#176) не применён к отказам Telegram | Architect plan |
| Лог уровня под ключом `level` перезаписал бы уровень записи pino | Plan defect | unverified-claim | Имя поля не сверено с зарезервированными ключами pino | Architect plan; поймано implementer'ом |
| m1: «только /start пишет строку users» в девяти местах | Minor → исправлен | instance-vs-class | Новый писатель строки не сверен со старыми формулировками | Implementer |
| m7: комментарий `HANDLER_CALLS.level` описывает старое поведение | Minor | unverified-claim | — | Implementer fix |

### Process improvement proposals

1. **Ответы внешнего API (Telegram в том числе) подпадают под пункт чек-листа об источнике каждого кода ошибки** — уже покрыто `.claude/skills/architect/SKILL.md` → Validation checklist (#176); класс повторился, новой правки нет — **отклонено как дубль существующего правила (2026-10-03, tech-lead): применение проверяет ревьюер**
2. **Пост-фактум Codex по `a2dd51c`** присоединяется к предложению 4 аудита #171 — **открыто (2026-10-03, владелец): после сброса лимита 2026-10-05**

---

## #132 — Signal v1: алгоритм сигнала по свечам (2026-10-03)

PR #230 смержен через rebase: 3 коммита, голова `7fde2cd`. **Один круг ревью, чистый, 5 Minor → #232.** Аудит записан 2026-10-06 вместе с остальной волной (#132, #136, #138, #235, #137) и #236, одним docs-PR по решению владельца; Phase 3 аудит по задачам волны не публиковался.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable` (`claude-fable-5-1`). 6 вопросов, владелец выбрал все рекомендованные. Codex plan review пропущен с пометкой (waiver владельца 2026-10-01..2026-10-05). Оценка ≈ 1 300 строк, факт +1 116. |
| Architect | Plan Update (до реализации) | Implementer на clarify нашёл два дефекта плана, при проверке нашёлся третий. Тот же агент Fable, продолженный для Plan Update, умер на недельном лимите Fable, ничего не опубликовав (в транскрипте `<synthetic>`). Владелец 2026-10-03 разрешил Plan Update на Opus: спавн `opus`, это исключение по его решению. |
| Implementer | Clarify + код | Спавн `opus`. 3 вопроса (пятый код `trend_flat`, нарезка коммитов, таблица мутаций). 3 коммита, таблица из 52 мутаций. Ревьюер принял отклонения: `codes.ts` против цикла импорта, экспорт `assertSignalClock`. |
| Tech Lead | Phase 3 | Аудит не опубликован, ревьюер запущен сразу после PR. |
| Reviewer | Iteration 1 | Спавн `opus`, 3b-3d (`opus`/`opus`/`sonnet`). 0 Blocker, 0 Major, 5 Minor. Codex 3a и whole-feature pass пропущены (waiver), вместо них ревью всего diff против плана и Plan Update. `pnpm check` exit 0, 2 822 теста. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку. Minor вынесены в #232 по решению владельца. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Будущая свеча и правило формирующейся свечи: план требовал недостижимый кейс «закрытая + одна будущая → in_future» | Plan defect | unverified-claim | Кейсы плана не прогнаны по шагу проверки данных | Architect plan (Codex снят); поймано на Implementer Step 0 |
| Оракул `rsi_neutral` / `trend_flat` не различал отказы, фикстура disagree падала в `trend_flat` | Plan defect | unverified-claim | Пункт чек-листа «проба прогнана по текущему коду до плана» не применён к фикстурам | Architect plan; поймано на Implementer Step 0 |
| m1: при экстремальных конечных ценах в `features` попадают NaN/Infinity, а docs обещают «every number finite» | Minor | unverified-claim | Docs шире кода, итог всё равно отказ | Implementer docs → #232 |
| m2, m3: сторона `low` в OHLC не тестируется; тест заморозки не отличает копию от заморозки входа | Minor | unverified-claim | Тест не может упасть на своей мутации | Implementer Step 5.5 → #232 |
| m4, m5: лишний экспорт `assertSignalClock`; «every field finite» в docs шире `candleProblem` | Minor | other | — | Implementer → #232 |
| Codex plan review, 3a и whole-feature pass не запускались | Process | codex-ops | Waiver владельца 2026-10-01..2026-10-05 (лимит Codex) | Пометка с датой в плане и ревью |
| Phase 3 аудит не опубликован ни по одной задаче волны и по #236 | Process | other | Ревьюер запускался сразу после PR | Tech-lead Phase 3 |

### Process improvement proposals

1. **Ревьюер запускается только с URL комментария аудита Phase 3** — **внедрено в #245: `.claude/skills/tech-lead/SKILL.md` → Phase 3**
2. **Minor m1-m5** — **вынесено в #232**
3. **Пост-фактум Codex по `7fde2cd`** присоединяется к предложению 4 аудита #171 — **открыто (2026-10-06, владелец): лимит Codex сброшен 2026-10-05, прогоны не запускались**

---

## #136 — Trading access: баланс токенов из token_ledger (2026-10-03)

PR #229 смержен через rebase: 5 коммитов, голова `756285a`. **Два круга ревью: в первом 6 Minor, владелец выбрал исправить их до мержа; второй круг чистый.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`. Общие вопросы #136/#137/#138 (эндпоинты бота, пакет REST-клиента) владелец решил одним `AskUserQuestion`. Codex plan review пропущен (waiver). Факт +740 строк. |
| Architect | Plan Update 1 (до реализации) | Спавн `opus` по решению владельца (лимит Fable). Дефект с clarify implementer'а: семантический конфликт с #138, которого git не покажет. |
| Implementer | Clarify + код | Спавн `opus`, 4 вопроса. Runtime-проверка 2026-10-03 09:27 UTC: копия основного `.env` в worktree и `docker compose -p binarius-136 up`. `bot` и staff-бот внутри `backend` поллили Telegram токенами пилотного сервера, оба серверных поллера получили 409 и остановились. Контейнеры остались «running», владелец заметил только на следующий день; починено рестартом, локальный `.env` переведён на отдельных dev-ботов 2026-10-04. 4 коммита. |
| Tech Lead | Phase 3 | Аудит не опубликован. |
| Reviewer | Iteration 1 | Спавн `opus`. 0 Blocker, 0 Major, 6 Minor. Codex пропущен (waiver). Блок «Running it locally» прогнан в отдельном compose-проекте. |
| Tech Lead | Iteration 1 → fix | Владелец: «Сначала исправить Minor». Plan Update 2 на `opus`, без Codex (раунд 1). Та же ловушка в других docs вынесена в #233. |
| Implementer | Fix | Один коммит `756285a`, мутации процитированы, rebase на #132. |
| Reviewer | Iteration 2 | Весь diff `5bc96bf..756285a` вместе с резолюцией rebase. Чисто. Блок docs прогнан как закоммичен, `printenv` показал фиктивные токены. Свой m6 из круга 1 ревьюер признал ошибочным. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку. |

### Review iterations: 2

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Новый тест #136 строился на `buildApp`, а #138 делает `AppDeps.pairs` обязательным: оба PR мержатся без конфликта, `tsc -b` на `main` падает | Plan defect | other | Правило волны (#226) сверяет файлы и порядок мержа, но не сигнатуры, которые меняет соседний план | Architect Step 4; поймано на Implementer Step 0 |
| Runtime-проверка на токенах пилота остановила оба серверных бота на сутки | Process | env-parity | Локальный `.env` и сервер делили токены; правила о токенах для runtime-проверок не было; у поллеров нет healthcheck (#65/#67) | Tech-lead Step 7 |
| m1: «Running it locally» поднимает проект compose по умолчанию; `down -v` удалил бы локальную dev-БД; staff-бот не назван | Minor → исправлен | instance-vs-class | В тексте закоммичена не та команда, что прогонялась (implementer гонял изолированный проект) | Implementer Step 5.5 (класс Text / docs edits); остальные docs → #233 |
| m2: комментарий «хук до роута обязателен» неверен для Fastify 5 | Minor → исправлен | unverified-claim | Поведение фреймворка не проверено запуском | Architect plan / Implementer |
| m3, m4: имя burst-теста шире того, что он ловит; кейс незакоммиченного reserve мог зависнуть вместо падения | Minor → исправлен | unverified-claim | — | Implementer Step 5.5 |
| m5: «единственное написание счётчика токенов» шире кода, regex скопирован | Minor → исправлен | single-source | Вторая копия паттерна `tokenCountSchema` | Implementer |
| m6 круга 1 («writes nothing» не может упасть) ошибочен: падает от любого update `users` | Reviewer error | unverified-claim | Утверждение ревьюера не проверено мутацией | Reviewer Step 4; исправлено самим ревьюером в круге 2 |

### Process improvement proposals

1. **Runtime-проверка с `bot`/`backend` — только на фиктивных токенах или токенах, которыми больше никто не поллит** — **внедрено в #245: `.claude/skills/tech-lead/SKILL.md` → Step 7**
2. **Планы одной волны сверяют сигнатуры, которые меняет соседний план, с новыми файлами своего плана** — **внедрено в #245: `.claude/skills/architect/SKILL.md` → Step 4**
3. **Изолированный compose-проект и фиктивные токены в остальных локальных процедурах** — **вынесено в #233**
4. **Пост-фактум Codex по `756285a`** присоединяется к предложению 4 аудита #171 — **открыто (2026-10-06, владелец)**

---

## #138 — Trading access: каталог пар с TTL-кэшем (2026-10-03)

PR #231 смержен через rebase: 9 коммитов, голова `7ea46c3`. **Два круга ревью: в первом 5 Minor, владелец выбрал исправить их вместе с rebase; во втором 3 Minor, смержен.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`. REST-клиент брокера переезжает в `packages/broker-rest` в этой задаче, #137 идёт после (решение владельца). Codex plan review пропущен (waiver). Факт +1 169 строк. |
| Architect | Plan Update 1 (до реализации) | Спавн `opus` по решению владельца, общий с #136. Три дефекта с clarify implementer'а: конфликт с #136, SIGTERM во время прогрева, цикл пакетов `shared` ↔ `broker-rest`. |
| Implementer | Clarify + код | Спавн `opus`. 5 коммитов, `pnpm check` после каждого. По данным tech-lead'а тоже поднимал локальный backend со staff-ботом на токенах основного `.env`. |
| Tech Lead | Phase 3 | Аудит не опубликован. |
| Reviewer | Iteration 1 | Спавн `opus`. 0 Blocker, 0 Major, 5 Minor, плюс пометка для #125. Codex пропущен (waiver). |
| Tech Lead | Iteration 1 → fix | Владелец: «Исправить Minor вместе с rebase». Plan Update 2 на `opus`, без Codex. Тот же класс в `oauth-client.ts` вынесен в #234. |
| Implementer | Fix | Rebase на `4a5463a` (#132, #136), 4 fix-коммита, мутации процитированы. При rebase два коммита потеряли subject (остался trailer), восстановлено через `git filter-branch --msg-filter`: повтор #185. |
| Reviewer | Iteration 2 | Весь diff и `git range-diff` rebase. 0 Blocker, 0 Major, 3 Minor (n1-n3). |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку, n1-n3 оставлены. |

### Review iterations: 2

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| SIGTERM во время прогрева: `start()` после `stop()` взводил таймер | Plan defect | other | Порядок старта и остановки не разобран для прогрева | Architect plan; поймано на Implementer Step 0 |
| Цикл пакетов `shared` ↔ `broker-rest` | Plan defect | unverified-claim | Граф зависимостей пакетов не проверен | Architect plan; поймано на Implementer Step 0 |
| m1: синхронный throw из `listPairs` навсегда клинит single-flight | Minor → исправлен | other | В плане разобран только async-отказ | Architect plan (пункт чек-листа о try/catch) |
| m2: проверка `stopped` после await без теста | Minor → исправлен | unverified-claim | Нет мутации на каждую ветку | Implementer Step 5.5 |
| m3: связь таймингов backend описана сильнее, чем делает shutdown | Minor → исправлен | unverified-claim | — | Implementer docs |
| m4: 2xx-тело брокера читается без лимита | Minor → исправлен | instance-vs-class | Тот же класс, что Minor аудита #98 о теле ошибки; третье место — `oauth-client.ts` | #98 review; → #234 |
| Rebase стёр subject'ы `#138: …` | Process | other | `core.commentChar` = `#`, предложение аудита #185 было открыто | Implementer rebase |
| n1-n3: запас лимита тела не закреплён тестом; комментарий `if (!shuttingDown)` шире кода; два экспорта без потребителя | Minor | unverified-claim | — | Implementer |

### Process improvement proposals

1. **Rebase через `git -c core.commentChar=';'`** (предложение аудита #185) — **внедрено в #245: `.claude/skills/implementer/SKILL.md` → Step 6**
2. **Лимит размера ответа в `oauth-client.ts`** — **вынесено в #234**
3. **Пост-фактум Codex по `7ea46c3`** присоединяется к предложению 4 аудита #171 — **открыто (2026-10-06, владелец)**

---

## #235 — Снимок баланса брокера: схема broker_balance_snapshots и операции (часть 1 #137) (2026-10-03)

PR #237 смержен через rebase: 2 коммита, голова `45962ff`. **Один круг ревью, чистый, 6 Minor; владелец перенёс их в план второй части #137.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План | Своего плана нет: действуют план и Plan Update 1 из #137 по линии 137a/137b. Разделение — решение владельца 2026-10-03 после того, как Plan Update поднял оценку до ~3 070 строк при потолке 3 000. Codex пропущен (waiver). Оценка ~1 000, факт +1 189 без snapshot. |
| Implementer | Код | Спавн `opus`, тот же агент потом делал вторую часть #137. Агент завис (stream watchdog, 600 с), его продолжили, ничего не потеряно, правило «Failed or stalled phase» соблюдено. Имя FK в 64 символа PostgreSQL обрезал, это поймал гейт. Незакоммиченную 0011 implementer руками убрал из общей тестовой БД (`drop table` + `delete from drizzle.__drizzle_migrations`) и сгенерировал заново, без вопроса владельцу. |
| Tech Lead | Phase 3 | Аудит не опубликован. |
| Reviewer | Iteration 1 | Спавн `opus`. 0 Blocker, 0 Major, 6 Minor. Codex пропущен (waiver). Сверено: 0011 в общей БД совпадает с закоммиченной по sha256, лишних constraint нет. |
| Tech Lead | Merge / Done | `AskUserQuestion` → «Да, m1-m6 в план #137». |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| m1: порядок кандидатов `rest_observed_at asc nulls first`: аккаунт, который падает каждый раз, навсегда в голове тика | Minor | instance-vs-class | Неудача не двигает ключ сортировки (решение 8 плана) | Architect plan; → #137, повтор в #137 m2 |
| m2: `level.code` не проверяется до записи (NUL → 22021, длина без предела) | Minor | instance-vs-class | Проверка домена покрыла суммы и rank, но не код | Architect plan → #137 |
| m3: комментарий обещает поведение второй части | Minor | unverified-claim | — | Implementer → #137 |
| m4: пробелы тестов (сводка, ветка `demoEvent`, NOT NULL трёх колонок) | Minor | unverified-claim | — | Implementer → #137 |
| m5: недостижимый код (`row ?? …`, throw на NOT NULL) | Minor | other | — | Implementer → #137 |
| m6: `money()` не единственный источник домена (20,8) | Minor | single-source | Две колонки задают numeric руками | Implementer → #137 |
| Незакоммиченная миграция в общей тестовой БД и её ручное удаление | Process | env-parity | Правила для незамерженных миграций на общей БД не было; деструктивная операция без подтверждения (глобальный Database Safety) | Tech-lead Step 7 |

### Process improvement proposals

1. **Незамерженная миграция идёт в собственную БД implementer'а, общая получает только миграции из `main`** — **внедрено в #245: `.claude/skills/tech-lead/SKILL.md` → Step 7**
2. **Minor m1-m6** — **вынесено в #137 (Plan Update 2, 2026-10-03)**
3. **Пост-фактум Codex по `45962ff`** присоединяется к предложению 4 аудита #171 — **открыто (2026-10-06, владелец)**

---

## #137 — Trading access: снимок баланса брокера (event-first и сверка раз в 60 с) (2026-10-04)

PR #238 (часть 2) смержен через rebase: 8 коммитов, голова `99d8747`. **Два круга ревью: в первом 6 Minor, владелец выбрал исправить их до мержа; во втором 1 Minor → #239.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`, 8 вопросов. Оценка ~2 100 строк, владелец оставил одной задачей. Codex plan review пропущен (waiver). |
| Architect | Plan Update 1 (до реализации) | Спавн `opus` по решению владельца. Дефекты с clarify implementer'а: значения брокера вне домена колонок, несовпадение часов при решении о refresh. Оценка ~2 980, затем ~3 070, выше потолка: владелец разделил задачу до реализации, часть 1 → #235. |
| Tech Lead | Живая проба | 2026-10-03, аккаунт владельца на пилоте: деньги в целых единицах, дробь приходит дробным числом JSON, `moneyWireSchema` её отклоняет. Создана #236. |
| Architect | Plan Update 2 (часть 2) | Спавн `opus`. Minor m1-m6 из #235 вошли в план; оценка ~2 235 строк, владелец: одним PR. |
| Implementer | Код | Спавн `opus`. 2 коммита вместо 4 (принято). Итог с исправлениями +2 568 строк. |
| Tech Lead | Phase 3 | Аудит не опубликован. |
| Reviewer | Iteration 1 | Спавн `opus`. 0 Blocker, 0 Major, 6 Minor. Codex пропущен (waiver). |
| Tech Lead | Iteration 1 → fix | Владелец: «Сначала исправить m1-m6». Plan Update 3 на `opus`, без Codex. |
| Implementer | Fix | 6 коммитов, таблица из 11 мутаций, повторно прогнаны 21 мутация из PR. |
| Reviewer | Iteration 2 | Весь diff `b94c54a..99d8747`. 0 Blocker, 0 Major, 1 Minor (n1). |
| Tech Lead | Merge / Done | `AskUserQuestion` → «Да + задача на n1» → #239. |

### Review iterations: 2

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Значения брокера вне домена колонок (дробь из 9 знаков, rank ≥ 10 000) | Plan defect | unverified-claim | Домен провода не сверен с доменом колонок | Architect plan; поймано на Implementer Step 0 |
| Часы при решении о refresh расходились | Plan defect | other | — | Architect plan; поймано на Implementer Step 0 |
| Plan Update поднял оценку выше потолка | Process | other | Семь money-CHECK и полная матрица кодов; оценка плана была ниже факта | Architect Step 4a; разделено до реализации |
| m1: Rule 12 — блокировка пользователя проверялась при выборе кандидатов, а не перед вызовом брокера | Minor → исправлен | instance-vs-class | Проверка стоит на пути выбора, а не перед побочным эффектом | Architect plan |
| m2: тик, попытка которого бросила исключение, не откладывался и при `limit = 1` морил остальные аккаунты | Minor → исправлен | instance-vs-class | Plan Update 2 закрыл исходы, но не throw: повтор #235 m1 | Architect Plan Update 2 |
| m3: изоляция кейса «answers at once», `refresh_needed` → `skipped`, второй `start()` | Minor → исправлен | unverified-claim | — | Implementer Step 5.5 |
| m4: `reasonFor` заканчивался `default:` вопреки чек-листу плана | Minor → исправлен | other | Пункт Validation о catch-all не применён | Implementer |
| m5, m6: проба rate-limit без проверки статусов; docs о сигналах и бюджете GET | Minor → исправлен | unverified-claim | — | Implementer |
| n1: соединение с `users` читает статус из снимка запроса, блокировка, закоммиченная во время ожидания lock'а, не видна | Minor | instance-vs-class | Новый путь исправления не перенёс инвариант целиком | Architect Plan Update 3 → #239 |

### Process improvement proposals

1. **Класс задач «очередь / фоновый тик»: таблица исходов попытки и их действия на ключ сортировки** — **внедрено в #245: `.claude/skills/architect/SKILL.md` → Task classes**
2. **n1** — **вынесено в #239**
3. **Пост-фактум Codex по `99d8747`** присоединяется к предложению 4 аудита #171 — **открыто (2026-10-06, владелец)**

---

## #236 — Деньги брокера: дробное число JSON отклоняется moneyWireSchema (2026-10-06)

PR #242 смержен через rebase: 5 коммитов, голова `99db31a` (на `main` — `78cc427`). **Один круг ревью, чистый, 4 Minor → #243. Первая задача после waiver'а, Codex прошёл на плане и на коде.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | 2026-10-04: спавн `fable` умер на лимите Fable, ничего не опубликовав. Владелец разрешил новый план на Opus, спавн `opus` упал на недельном лимите Opus (сброс 7 октября). 2026-10-06 спавн `fable` (`claude-fable-5-1`) отработал: 5 вопросов, Codex plan review `task-muwcu7mp-cnsbno` (`gpt-5.6-sol`, high), 2 Major и 6 Minor, все учтены. |
| Architect | Plan Update (до реализации) | Тот же агент Fable. Исправлены два дефекта с clarify implementer'а. |
| Implementer | Clarify + код | Спавн `opus`, 3 вопроса. 5 коммитов, правки `.claude/` отдельным коммитом. Красный прогон — во временном worktree. +438 строк. |
| Tech Lead | Phase 3 | Аудит не опубликован. |
| Reviewer | Iteration 1 | Спавн `opus`. Codex 3a `task-muwe9e8w-lbdd6r`, маркер `Iteration review #242: base=133ae6a head=99db31a diff-sha256=f0f7c9b2…`: к коду замечаний нет, 2 Minor по process docs (c). 3b-3d: 0 Blocker, 0 Major, 4 Minor. `pnpm check` exit 0, 3 144 теста. |
| Tech Lead | Whole-feature pass — check | Job `task-muwe9e8w-lbdd6r` перехеширован в этом аудите: base-ok, `f0f7c9b27464f57c…` совпал, голова = одобренная = смерженная. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку. Minor вынесены в #243. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Четвёртая копия правила денег (`.claude/CLAUDE.md:71`) не попала в список плана | Plan defect | single-source | Список копий в плане неполон; повторный grep в Plan Update нашёл только эту | Architect plan; поймано на Implementer Step 0 |
| Мутация m1 (потолок 15 → 16) краснила три теста, а не один | Plan defect | unverified-claim | Мутация не прогнана до плана | Architect plan (пункт чек-листа о мутациях); поймано на Implementer Step 0 |
| m1: оценка ошибки округления в `docs/broker-rest.md` занижена вдвое | Minor | unverified-claim | Не учтён второй шаг (`String()` после `JSON.parse`) | Architect plan (Accepted risk 2) → #243 |
| m2: граничный тест мока проверяет только `success`, не значение | Minor | unverified-claim | Plan Update §2 обосновал связь «проверено рассуждением», проверку значения из плана implementer не написал | Implementer → #243 |
| m3, m4: `registerUser` без верхней границы; два лишних утверждения в `state.test.ts` | Minor | other | — | Implementer → #243 |
| Codex (c): глобальный Task Workflow «Changes requested → In Progress» против проектного → Todo; глобальное «все три субагента» против правила малого diff | Minor | other | Глобальный файл не обновлён под проектные правила | Process docs; правит проектная секция |
| Три спавна архитектора умерли на лимитах моделей | Process | other | Недельные лимиты Fable и Opus | Tech-lead Model policy — check |
| Docs-PR аудита #245 смержен без Codex whole-feature pass: попытка 1 (`task-muwf2dls-7wcshy`) упала на лимите Codex, второй не было | Process | codex-ops | Лимит использования Codex до 15:25 MSK 2026-10-06 | Tech-lead Phase 5 step 5; владелец явно принял мерж без прогона (2026-10-06) |

### Process improvement proposals

1. **`<synthetic>` в Model policy — check: метка ошибки API, а не модель** — **внедрено в #245: `.claude/skills/tech-lead/SKILL.md` → Model policy — check**
2. **Minor m1-m4** — **вынесено в #243**
3. **Правка `~/.claude/CLAUDE.md` по двум находкам Codex (c)** — **отклонено: глобальный файл общий для всех проектов, проектный CLAUDE.md уже правит при расхождении (решение владельца 2026-10-06)**
4. **Пост-фактум Codex**: к списку предложения 4 аудита #171 добавляются головы этой волны (`7fde2cd`, `756285a`, `7ea46c3`, `45962ff`, `99d8747`) и docs-PR #221, #226, #228, смерженные без Codex — **открыто (2026-10-06, владелец)**

---

## #134 — Real-режим за флагом REAL_TRADING_ENABLED (2026-10-06)

PR #248 смержен через rebase: 3 коммита, голова `653e500` (на `main` — `8211c38`..`e1fe5e3`). **Один круг ревью, чистый, 3 Minor. Codex на ревью пропущен по явному решению владельца.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План | Другая сессия, 2026-10-06 07:45, Codex plan review `task-muwd1szm-spgzlo`. Владелец передал реализацию этой сессии. |
| Implementer | Clarify + код | Спавн `opus`: 4 вопроса, дефектов плана нет. Ранний push после коммита 1 (миграция 0012 + `createTradeIntent(db, input, policy)`), чтобы #17/#89 могли ветвиться. Своя БД `binarius_impl_134`. 587 строк без snapshot (оценка ~600). 21 мутация. |
| Tech Lead | Phase 3 | Аудит до ревью опубликован (issuecomment-6014181557). |
| Reviewer | Iteration 1 | Спавн `opus`, умер на лимите сессии (`<synthetic>`), продолжен через SendMessage — ничего не было опубликовано. 3b-3d: 0 Blocker/Major, 3 Minor. `pnpm check` на своей БД `binarius_review_248`, второй прогон (первый — флейк `oauth-client.test.ts` при load average 18.75). |
| Tech Lead | Whole-feature pass — check | Codex не запускался по решению владельца (лимит до 15:25 MSK) — маркера нет. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку. Minor 2 записан требованием в #100 (#40 закрыт и разбит на #99/#100/#101). |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Rule 14 шире, чем enforced (третья форма `${VAR:-default}`, три непокрытых пина воркера) | Minor | single-source | Формулировка правила не сверена с пинами | Implementer |
| Продакшен-обвязка обоих рубежей без теста | Minor | unverified-claim | Три независимых слоя делают её не единственной защитой — до #100 | Architect plan → требование в #100 |
| Устаревшая фраза ARCH-01 в `docs/trade-intent-transport.md` | Minor | single-source | — | Implementer |
| Rule 22 взят одновременно #134 и #19 | Process | single-source | Параллельные планы одной волны не сверили номера правил | Architect Step 4 → предложение 1 |
| Ожидание `pgrep -f 'vitest'` совпадает с собственным shell'ом | Process | env-parity | Шаблон проверки — по тексту команды, не по имени процесса | Tech-lead Step 7 → предложение 2 |

### Process improvement proposals

1. **Номера в общих списках (Architecture Rules) сверяются с соседними планами волны; второй по мержу перенумеровывает** — **внедрено в #255: `.claude/skills/architect/SKILL.md` → Step 4 (sibling plans)**
2. **Проверка чужих прогонов — по имени процесса (`ps … awk`), не `pgrep -f`** — **внедрено в #255: `.claude/skills/tech-lead/SKILL.md` → Step 7 → Shared-resource window**
3. **Minor 2 (обвязка рубежей)** — **вынесено в #100 (комментарий-требование, решение владельца 2026-10-06)**

---

## #133 — Signal v1: подключение к свечам ARCH-01 и журнал решений (2026-10-06)

PR #249 смержен через rebase: 5 коммитов, голова `b79b7e0` (на `main` — `8b55b86`..`a386b28`). **Один круг ревью, чистый, 4 Minor. Codex на плане и ревью пропущен по явному решению владельца.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`: 6 вопросов (владелец выбрал окно 60 вместо рекомендованных 100; цепочка пересчитана 60 − 1 − 2 = 57 ≥ 50). Живая read-only проба chart. Зависимость от #99 по тексту задачи не подтвердилась — план только на REST. Plan Update до реализации по 2 дефектам implementer'а. |
| Implementer | Clarify + код | Спавн `opus`: 5 вопросов. 5 коммитов, `pnpm check` перед каждым, +923. Умер на лимите сессии после push до PR, продолжен. Живая проба один раз (форма и число строк, без цен). |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6015860347). |
| Reviewer | Iteration 1 | Спавн `opus`. 3b-3d: 0 Blocker/Major, 4 Minor (guard интервала `Object.hasOwn`, формулировка F9, длина строки от брокера — принято на плане, порт F3b). |
| Tech Lead | Whole-feature pass — check | Codex не запускался по решению владельца — маркера нет. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку. Ветка отставала на 3 коммита #134 (общий только SKILL.md, без конфликта). |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| F7 `stale` недостижим при `now = closedNow`; плоская серия с wick 0.1 не даёт `volatility_too_low` | Plan defect | unverified-claim | Фикстуры теста не прогнаны до плана | Architect plan; поймано на Implementer Step 0 |
| m1-m4 (guard интервала, F9, длина строки, порт F3b) | Minor | other | — | Implementer; не вынесены (решения владельца не было) |
| Пять Opus-агентов одновременно упёрлись в лимит сессии | Process | other | Параллельность волны выше бюджета сессии | Tech-lead Step 7 → предложение 1 |

### Process improvement proposals

1. **Не больше трёх Opus-агентов фаз одновременно** — **внедрено в #255: `.claude/skills/tech-lead/SKILL.md` → Step 7**

---

## #19 — Stake-sizing v1 (2026-10-06)

PR #247 смержен через rebase: 4 коммита, голова `9eba0d6` (на `main` — `8c8d4df`..`1b14b14`). **Два круга ревью + проверка rebase. Codex на плане и ревью пропущен по явному решению владельца.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`: 8 вопросов, все рекомендованные. Проба BigInt-формулы (99 ячеек) и tsc-проба union. Plan Update до реализации (4 дефекта), Plan Update после круга 1 (без Codex). |
| Implementer | Clarify + код | Спавн `opus`: 3 коммита, +1 530, 30 мутаций. Круг 1 — S22a-c. Rebase на `main` после #134/#133, правило перенумеровано в 23. |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6014045763). |
| Reviewer | Iteration 1 | 1 Major: стоп-лосс сессии не различал `realizedSessionLoss` и `streakLoss` тестами. |
| Reviewer | Iteration 2 | Код чистый, но конфликт с `main` (Rule 22 от #134); по решению владельца — rebase и проверка range-diff без полного ревью, LGTM на `9eba0d6`. |
| Tech Lead | Whole-feature pass — check | Codex не запускался по решению владельца — маркера нет. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку. |

### Review iterations: 2

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| S2-сетка не проходит через `next()` вне домена; оракул `percentOf` точен только для ≤ 2 знаков | Plan defect | unverified-claim | Сетка и оракул не прогнаны до плана | Architect plan; поймано на Implementer Step 0 |
| M1: проверка 9m (`realizedSessionLoss`) и 11 (`candidate` vs `base`) не различались тестами | Major → исправлен | instance-vs-class | Все тесты лимита — истории из одних проигрышей; архитектор по классу нашёл вторую дыру (11) | Implementer Step 5.5; Architect plan (таблица мутаций) |
| m4-m7: верхняя граница прибыли, порядок стопов, K10, неиспользуемые типы | Minor | other | — | Implementer; не вынесены |

### Process improvement proposals

1. Покрыто предложением 1 записи #134 (номера правил волны).

---

## #17 — Trade intent state machine (2026-10-06)

PR #250 смержен через rebase: 2 коммита, голова `80b798e` (на `main` — `b70d175`, `fb230bc`). **Два круга ревью с Codex.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable`: 6 вопросов, проба триггера и CHECK на временной БД (сетка 10×10). Codex plan review пропущен по решению владельца. Hand-off #89/#90/#101 назван. Plan Update до реализации (список producer'ов `accepted`, `duration_sec`), Plan Update после круга 1 (без Codex). |
| Implementer | Clarify + код | Спавн `opus`: ветка от `feat/134-…` (merge chain), два rebase на `main`. Один коммит по выбору владельца + коммит круга 1 без force-push (на ветке строился #89). Своя БД `binarius_impl_17`. |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6016171488). |
| Reviewer | Iteration 1 | Codex `task-muwnl1ci-ifn828` + 3b-3d: 1 Major — отклонение implementer'а (повторная сверка привязанной сделки в `settleIntent`) делало заявку вечной `accepted`. Владелец: вернуться к плану. |
| Reviewer | Iteration 2 | Codex `task-muwode18-1xi6ts` «No findings», маркер `Iteration review #250: base=a386b28 head=80b798e diff-sha256=65d56109…`. 5 Minor. |
| Tech Lead | Whole-feature pass — check | Перехешировано перед мержем: хеш совпал, голова = одобренная = смерженная. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку. |

### Review iterations: 2

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| M1: повторная сверка привязанной сделки — тупик `accepted` (резерв, блокировка аккаунта, голодание #90) | Major → исправлен | other | Противоречие в самом плане (edge case «как получено» против `mismatch` в тесте шага 6); implementer разрешил его не в ту сторону | Architect plan; Implementer deviation |
| Шаг 2(d): три `accepted` на одном аккаунте невозможны (один активный intent) | Plan defect | unverified-claim | Тест не сверен с unique-индексом | Architect Plan Update |
| n1-n5 (лог несовпадения, наблюдаемость батча, `raw` при закрытии, устаревшее тело PR) | Minor | other | — | не вынесены |
| `codegraph_callers` — ноль вызовов для каждой операции домена | Process | other | Ограничение статического извлечения (оговорка глобального CLAUDE.md) | — → предложение 1 |

### Process improvement proposals

1. **Проектное подтверждение оговорки CodeGraph** — **внедрено в #255: `.claude/CLAUDE.md` → CodeGraph**

---

## #89 — Reconciliation: unknown → reconciling → accepted | rejected | manual_review (2026-10-06)

PR #252 смержен через rebase: 3 коммита, голова `f22df0c` (на `main` — `3439871`..`64cf7e3`). **Один круг ревью с Codex, чистый, 6 Minor → #253.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable` после плана #17 по решению владельца: 6 вопросов, SQL-проба claim-запроса. Codex plan review пропущен по решению владельца. Plan Update до реализации (`until()` из несмерженного #205; шаг 10 runtime-проверки переписан). |
| Implementer | Clarify + код | Спавн `opus`: ветка от `feat/17-…` на `80b798e`, после мержа #250 — `rebase --onto origin/main 80b798e`. 3 коммита, ~1 540 строк. Runtime-проверка в изолированном compose-проекте `binarius-89`. |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6016773528); ревью отложено до мержа базы и rebase. |
| Reviewer | Iteration 1 | Codex `task-muwox90h-8uu1v0`, маркер `Iteration review #252: base=fb230bc head=f22df0c diff-sha256=25ac182a…`. 0 Blocker/Major, 6 Minor. |
| Tech Lead | Whole-feature pass — check | Перехешировано перед мержем: хеш совпал, голова = одобренная = смерженная. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку; Minor → #253 (решение владельца). Общая тестовая БД получила 0013-0015 только после замечания ревьюера #99. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| `until()` из #205 недоступен; шаг 10 runtime невыполним (worker берёт job за миллисекунды, триггер #17 запрещает `rejected → submitting`) | Plan defect | unverified-claim | План опирался на несмерженную задачу и не прогнал процедуру | Architect plan; поймано на Implementer Step 0 → предложение 2 |
| m1-m6 (отмена по AbortSignal как `failed`, warn до CAS, тип `MarkAcceptedOptions`, тесты) | Minor | other | — | → #253 |
| Общая тестовая БД без миграций `main` после мержа | Process | env-parity | Никто не применял смерженные миграции к общей БД | Tech-lead Step 7 → предложение 3 |
| Stacked PR: дифф показывал коммиты #17 до мержа базы | Process | other | — | Tech-lead Phase 3 → предложение 4 |
| Codex второй попытки ревью #99 упал: брокер привязан к удалённому worktree | Process | codex-ops | Путь worktree переиспользован между кругами | Tech-lead Step 7 → предложение 5 |

### Process improvement proposals

1. **Minor m1-m6** — **вынесено в #253**
2. **План с «мерж после #X» называет промежуточную форму, если у #X нет ветки** — **внедрено в #255: `.claude/skills/architect/SKILL.md` → Step 4 (sibling plans)**
3. **После мержа PR с миграцией tech-lead применяет её к общей тестовой БД** — **внедрено в #255: `.claude/skills/tech-lead/SKILL.md` → Step 7 → Unmerged migrations**
4. **Stacked PR ревьюится после мержа базы и rebase на `main`** — **внедрено в #255: `.claude/skills/tech-lead/SKILL.md` → Phase 3**
5. **Свежий путь review-worktree на каждый круг, `codex status` из worktree** — **внедрено в #255: `.claude/skills/tech-lead/SKILL.md` → Step 7**
6. **#99 (PR #251) не смержен: прошёл 3 круга (лимит), Minor → #254, ждёт #205 + шаг 5 + whole-feature Codex на итоговом head** — **открыто (2026-10-06, владелец/tech-lead): запись аудита #99 — после его мержа**

---

## Волна «первая демосделка» — общие наблюдения (2026-10-06/07)

Одна сессия tech-lead провела #125, #258 (выделен из #126), #126, #127, #90, #100 от планирования до мержа. Общее для всех шести:
- **Codex не видел ни одной задачи волны.** Plan review пропущен по решению владельца у всех (лимит Codex до 20:27 MSK, затем до 01:46 MSK). Iteration review тоже: #125 — единственный прогон (`task-mux1xcp3-xn5mny`), у остальных пропуск по решению владельца.
- **Первые три спавна архитекторов на Fable упали с 403, повтор завис на watchdog.** Третий запуск — по указанию владельца, прошёл.
- **Три параллельных архитектора затёрли `plan-125.md`/`plan-126.md` в корне scratchpad** (текст восстановлен, опубликованные планы полные).
- **LGTM с пропущенным Codex не проходит у субагента.** Классификатор прав отказал ревьюеру #258 («CI Bypass»), комментарий и удаление worktree выполнил tech-lead по явному указанию владельца. GitHub 19:46-19:50Z отвечал 500 на создание комментариев; опубликовано через REST, без дублей.

### Process improvement proposals (волна)

1. **Отдельная scratch-подпапка и для архитекторов** — **внедрено в #280: `.claude/skills/tech-lead/SKILL.md` → Step 7 → Own scratch subdirectory**
2. **Раздел конфликтов плана — против всей доски и всех открытых PR, не только сиблингов** — **внедрено в #280: `.claude/skills/architect/SKILL.md` → Step 4**
3. **Живая проба на продакшене — шаг владельца с командами, не действие исполнителя** — **внедрено в #280: `.claude/skills/architect/SKILL.md` → Step 4**
4. **LGTM при пропущенном владельцем Codex публикует tech-lead из главного контекста** — **внедрено в #280: `.claude/skills/tech-lead/SKILL.md` → Merge relay**
5. **Бюджет Codex на волну: шесть задач × (plan review + 1-3 круга) не помещаются в одно окно лимита** — **открыто (2026-10-07, владелец): планировать волну под окно Codex или принимать пропуск заранее**
6. **#99: отладочные строки «out of state» логируют redacted `state`** — **вынесено в #279**

---

## #125 — Демо: выбор актива и длительности на свежем каталоге (2026-10-06)

PR #265 смержен через rebase (3 коммита, голова `dfbf050`), +2435 строк. **Один круг ревью с Codex, чистый, 8 Minor.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | Clarify + план | Спавн `fable` (3-я попытка, см. волну): 5 вопросов. Codex plan review пропущен по решению владельца. |
| Implementer | Clarify + код | Спавн `opus`: 4 вопроса, ветка от `origin/main`, 3 коммита по выбору владельца, Gate verification (11 мутаций). |
| Tech Lead | Phase 3 | Аудит до ревью опубликован (issuecomment-6023482389). |
| Reviewer | Iteration 1 | Codex `task-mux1xcp3-xn5mny`, маркер `Iteration review #265: base=a2ec408 head=dfbf050 diff-sha256=d24a8e1b…`. Codex дал 4 Major, ревьюер понизил до Minor с обоснованием на PR. |
| Tech Lead | Whole-feature pass — check | Маркер head = одобренный = смерженный `dfbf050`. |
| Tech Lead | Merge / Done | `AskUserQuestion` → rebase + удалить ветку. |

### Review iterations: 1 (без возвратов)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| m5: `checkDemoTrade` не сверяет длительность с `DEMO_DURATIONS_SEC` | Minor | instance-vs-class | Проверка паттерна callback есть, проверки в общем хелпере нет | → закрыто в #126 |
| m1-m4, m6-m8 (часы назад и `fresh`, тип без пар, id/symbol брокера, Rule 10 и `timeoutMs`, тест без падения, упрощения) | Minor | other | — | → #268 |

### Process improvement proposals

1. **Minor m1-m4, m6-m8** — **вынесено в #268**; m5 — **вынесено в #126** (закрыто там)

---

## #258 — Signal v1: пакет packages/signal, wire-форма решения и POST /trading/signal (2026-10-06)

Выделен архитектором из #126 (Step 4a). PR #269 смержен через rebase (6 коммитов, голова `4785a41`), +1544 строки.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План + Plan Update | План в одном раунде с #126. Три PLAN DEFECT от implementer'а (перенос `BrokerRestErrorCode` ломает #90/#100; раздел конфликтов без #90/#100; C9 невозможен на fake timers) → Plan Update до кода. Codex plan review пропущен владельцем. |
| Implementer | Clarify + код | Спавн `opus`: 2 вопроса владельцу + 3 дефекта архитектору; 6 коммитов по шагам, `git mv` модуля. |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6023983612). |
| Reviewer | Iteration 1 | Codex — 2 попытки упали на лимите (`task-mux2xt71-fy5qpe`, `task-mux3319p-z64ab3`); владелец пропустил Codex. Claude: 0 Blocker/Major, 4 Minor. |
| Tech Lead | Merge / Done | LGTM опубликовал tech-lead (субагенту отказал классификатор). `AskUserQuestion` → rebase. |

### Review iterations: 1

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Раздел конфликтов плана не видел #90/#100 | Plan defect | other | Конфликты строились только по сиблингам волны | Architect Step 4 → предложение 2 волны |
| C9 на fake timers невозможен (`AbortSignal.timeout` не двигается) | Plan defect | unverified-claim | Тест не пробован до плана | Architect plan; поймано на Implementer Step 0 |
| 4 Minor (кэш при `200 []`, Retry-After, охват D15, небезопасное целое) | Minor | other | — | → #270 |

### Process improvement proposals

1. **Minor 1-4** — **вынесено в #270**

---

## #126 — Демо: экран анализа из Signal module (2026-10-06)

PR #271 смержен через rebase (5 коммитов, голова `1f75b65`), +1496 строк. Ветка начата поверх #258 и перенесена на `main` после его мержа.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План | 7 вопросов владельцу; план написан до мержа #258 (Step 4a велит планировать только первую часть — отклонение, отмечено архитектором). Codex plan review пропущен владельцем. |
| Implementer | Clarify + код | 5 вопросов; m5 из ревью #125 закрыт в двух местах; `rebase --onto origin/main` после мержа #258. |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6024332341). |
| Reviewer | Iteration 1 | Codex не запускался (лимит, попытки не тратились); владелец пропустил. Claude: 0 Blocker/Major, 5 Minor. |
| Tech Lead | Merge / Done | LGTM — tech-lead. `AskUserQuestion` → rebase. |

### Review iterations: 1

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| 5 Minor («⏳» без клавиатуры, забытое «⏳», `retryAfterSec: 0`, сравнение EMA по сырым числам, упрощения) | Minor | other | — | → #272 |

### Process improvement proposals

1. **Minor 1-5** — **вынесено в #272**

---

## #127 — Демо: подтверждение ставки и статус intent (2026-10-06)

PR #273 смержен через rebase (9 коммитов, голова `8e04d1d`), ~+2800 строк. **Два круга ревью.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План + 2 Plan Update | 7 вопросов владельцу. PLAN DEFECT на clarify implementer'а: ключ идемпотентности по `message_id` повторялся после «Повторить анализ» → одноразовая метка в кнопке. После круга 1 — Plan Update без Codex. |
| Implementer | Clarify + код + раунд | 3 + 4 вопроса; 8 коммитов, раунд исправлений одним коммитом (выбор владельца). |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6024819801). |
| Reviewer | Iteration 1 | Codex не запускался (лимит). M1 (Major) + 5 Minor → Todo. |
| Reviewer | Iteration 2 | Весь PR; Codex пропущен владельцем. 0 Blocker/Major, 3 Minor. |
| Tech Lead | Merge / Done | LGTM — tech-lead. `AskUserQuestion` → rebase. |

### Review iterations: 2

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| Ключ `clientRequestId` по `message_id` при редактировании экрана на месте | Plan defect | unverified-claim | План не сверен с тем, как #126 перерисовывает анализ | Architect Step 4; поймано на Implementer Step 0 |
| M1: правка финального статуса без повтора при сбое | Major → исправлен | instance-vs-class | В таблице решений плана две противоречивые строки для финального статуса, предел для постоянно падающей правки не назван | Architect plan |
| m1-m4 (unhandled rejection трекера, комментарий DRAIN, `created`, лишнее условие) | Minor → исправлены | other | — | — |
| m5 (третья копия `logAnswerFailure`) | Minor | other | — | оставлено с обоснованием |
| n1-n3 (правка на последнем опросе при 429, комментарий 404, чистки) | Minor | other | — | → #276 |

### Process improvement proposals

1. **Minor n1-n3** — **вынесено в #276**

---

## #90 — Reconciliation: сопоставление сделки брокера с intent (2026-10-06/07)

PR #267 смержен через rebase (голова `12c775b`), 3331 строка без snapshot (превышение потолка принято владельцем дважды: 3173, затем ~3280). **Три круга ревью — лимит; новый цикл со сменой подхода.**

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План (другая сессия) + 3 Plan Update + addendum | Codex plan review пропущен владельцем. После круга 1 — Plan Update без Codex и addendum на PLAN DEFECT (проверка стыка ломала T11). После круга 2 — новый цикл: владелец выбрал «вынести часть, сузить PR»; Codex re-check пропущен владельцем. |
| Implementer | Clarify ×3 + код | 5 + 5 + 4 вопроса; живая проба заблокирована классификатором (SSH на продакшен), не обходилась. Force-with-lease только в feature-ветку — по решению владельца. |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6023835288). |
| Reviewer | Iteration 1 | Codex — 2 попытки на лимите. M1 (Major, деньги: короткая страница = список прочитан → ложный `not_found` → release) + 5 Minor. |
| Reviewer | Iteration 2 | Codex пропущен владельцем. M1-r2 (Major, деньги: пустая страница после страницы из ≥2 сделок) + 4 Minor. |
| Tech Lead | Phase 4, iteration 2 | `AskUserQuestion` о смене подхода → (b): `not_found` убран из `main`, доказательство отсутствия → #274; 429 на refresh → #275. |
| Reviewer | Iteration 3 (последний) | Весь PR; инвариант R-NF подтверждён мутацией (17 тестов). 0 Blocker/Major, 3 Minor. Codex пропущен владельцем. |
| Tech Lead | Merge / Done | Без LGTM (лимит кругов); заметка о мерже на лимите. Minor → #277 после подтверждения владельца. `AskUserQuestion` → rebase. Миграции применены к общей тестовой БД. |

### Review iterations: 3 (лимит)

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| M1: покрытие списка по длине страницы → ложный `not_found` и release | Major → снят конструкцией | unverified-claim | Безопасность опиралась на непроверенные A1/A2 (живая проба не проведена) | Architect plan → предложение 3 волны |
| M1-r2: пустая страница как конец списка на любой позиции | Major → снят конструкцией | instance-vs-class | Plan Update закрыл экземпляр (короткая страница), не класс «покрытие из формы страницы» | Architect Plan Update; итог — смена подхода |
| Проверка стыка противоречила T11 | Plan defect | unverified-claim | Правило не прогнано на собственных кейсах плана | Architect Plan Update; поймано на Implementer Step 0 |
| m1-m5 (круг 1), m1-m4 (круг 2) | Minor → исправлены/с обоснованием | other | — | — |
| m1-r3..m3-r3 | Minor | other | — | → #277 |
| 429 брокера на refresh отзывает аккаунт | Process/behaviour (вне #90) | other | — | → #275 |

### Process improvement proposals

1. **Доказательство отсутствия сделки и release — после живой пробы** — **вынесено в #274**
2. **429 на `/user-auth/refresh` не отзывает аккаунт** — **вынесено в #275**
3. **Minor третьего круга** — **вынесено в #277**
4. **Перед деплоем: проверить вручную остановленные аккаунты до миграции 0016** — **открыто (2026-10-07, владелец): запрос в PR #267, issuecomment-6025534338**

---

## #100 — ARCH-01: исполнитель команды открытия сделки (2026-10-07)

PR #266 смержен через rebase (4 коммита, голова `b016b5d`), +1206 строк без snapshot, миграция 0017.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Architect | План (другая сессия) | Codex plan review пропущен владельцем; промежуточная форма порта токена до мержа #90. |
| Implementer | Clarify + код | 4 вопроса; draft PR до мержа #90 (решение владельца), затем rebase, порт #90, миграция 0017, коммит 4 (обвязка), `gh pr ready`. |
| Tech Lead | Phase 3 | Аудит опубликован (issuecomment-6025641693). |
| Reviewer | Iteration 1 | Codex не запускался (лимит); владелец пропустил. Claude: 0 Blocker/Major, денежный путь проверен, 5 Minor. |
| Tech Lead | Merge / Done | LGTM — tech-lead. `AskUserQuestion` → rebase. Миграции применены к общей тестовой БД (18). |

### Review iterations: 1

### Findings

| Finding | Severity | Класс | Root cause | Missed at step |
|---------|----------|-------|------------|-----------------|
| m4: поздний `open_trade.fail` прошлой команды совпадает с новой на том же соединении → release при возможно открытом ордере | Minor (сейчас недостижимо: `noTradeSessions`) | other | Принятый риск назвал только поздний `success` | → условие включения сокета в #101 |
| m1-m3, m5 (тест real-режима, abort токена, S5, текст при сбое backend) | Minor | other | — | → #278 |
| Отладочные строки #99 логируют redacted `state` | Minor (вне #100) | other | — | → #279 |

### Process improvement proposals

1. **m4 — обязательное условие включения сокета** — **вынесено в #101** (issuecomment-6025803167)
2. **Minor m1-m3, m5** — **вынесено в #278**
