# Audit Log

---

## #2 — Bootstrap pnpm monorepo skeleton (2026-09-22)

PR #45, rebase-merged as `722d288` + `513dfb9`.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | OK: Codex ready, `gh auth` valid, `main` current. Gap: token scopes not checked against the issue's file list; `workflow` scope was missing and surfaced only at push. |
| Tech Lead | `/clarify` | 4 questions: scope (all 4 Todo issues), branching (wait for #2 to merge), autonomy (continue through the batch), #6/#7 strictly sequential. |
| Tech Lead | Merge order | #2 → #3 → #6 → #7 (#7 depends on #2 + #6 and needs #3's Postgres for its acceptance check). |
| Architect | `/clarify` | 4 questions (ESM, per-package Vitest test, flat ESLint, `tsc -b`) + 1 follow-up after Codex (Node 22). |
| Architect | Plan + Codex plan review | Posted before In Progress. Codex Major (Vitest 5 requires Node ≥ 22.12, Node 20 EOL) verified via `npm view` and folded in; 3 Codex Minors folded in. |
| Implementer | `/clarify` | 4 questions (README, caret deps, single commit, `index.test.ts`). |
| Implementer | Branch / commit / PR | `feat/2-bootstrap-pnpm-monorepo`, `#2: bootstrap pnpm monorepo skeleton`, PR #45 with `Closes #2` and test plan; files staged by name. Push required switching `origin` to SSH (see preflight gap). |
| Implementer | Deviation flagged | `typescript ~6.0.3` instead of caret: `typescript-eslint@8.70.1` peer-caps at `<6.1.0`, latest is 7.0.2. |
| Reviewer | Iteration 1 | Codex + security + code-review high + simplify. 1 Major (entry points at unbuilt `dist/`, independently reproduced) + 5 Minor → PR comment, issue → Todo. |
| Architect | Plan Update + Codex re-check | `/clarify` 3 questions (exports → src, root-only engines, all Minors in scope). Codex re-check 3 Minors (CI masks the guard, Node range admits 23/25, `--filter` command doesn't exist) folded in. |
| Implementer | Iteration 1 fix | `/clarify` 3 questions. 20 files, lockfile untouched. Deviation flagged: `tsBuildInfoFile` into `dist/` (TS6305 from composite up-to-date semantics), verified with fresh-clone and stale-cache replays. |
| Reviewer | Re-review | Codex + security + code-review high + simplify: no Blocker/Major, cosmetic nits only. CI green, single run. Per-merge `AskUserQuestion` → rebase merge, branch deleted. Done only after `state == MERGED`. |

### Review iterations: 1

### Findings

| Finding | Severity | Root cause | Missed at step |
|---------|----------|------------|-----------------|
| `packages/shared`/`packages/db` entry points at `./dist/index.*`, built only by `tsc -b` under `typecheck`; real cross-package imports fail on standalone `pnpm test` / fresh clone | Major | Entry points added on Codex suggestion without a build guarantee; placeholder tests cannot observe resolution; plan's verification ran typecheck before test, masking the order dependency | Architect Step 6/7, Implementer Step 5 |
| `engines.node >=22.12.0` below ESLint 10's Node-22 floor (`22.13.0`) and admitting Node 23/25 (excluded by Vitest 5) | Minor | Floor derived from one tool's `engines`, not the toolchain intersection | Architect Step 6 |
| CI ran twice per PR commit; `node-version` hardcoded beside `.node-version`; `engines` copied into 7 manifests | Minor | First-draft defaults, no "single source per fact" pass | Architect Step 6 |
| `tsBuildInfoFile` default beside `tsconfig.json`; composite `tsc -b` trusts the cache and never stats outputs → TS6305 after `rm -rf */dist` | Deviation (caught in implementation) | TypeScript composite semantics; Plan Update named only the fresh-clone scenario | Architect Plan Update |
| `gh` OAuth token lacked `workflow` scope for `.github/workflows/ci.yml` | Process | Preflight checks auth validity, not required scopes | Tech Lead Phase 0 |

### Process improvement proposals

1. Architect validation checklist: every `package.json` entry point must resolve to committed source or to output produced by a step the check command itself runs.
2. Implementer self-review: run the check command once from a build-output-free state (`rm -rf **/dist` first) before committing.
3. Architect: when setting `engines`, record `npm view <tool> engines` for every root devDependency and state the intersection in the plan.
4. Architect, tooling/build plans: enumerate fresh-clone, stale-cache, and incremental scenarios explicitly.
5. Architect checklist for config issues: "single source per fact" (workflow triggers, Node version, engines).
6. Tech Lead preflight: if the plan's file list includes `.github/workflows/*`, verify the `workflow` scope or an SSH remote before implementation.
7. Reviewer: do not run the check command concurrently with a spawned `/code-review` agent on the same tree; its recipe runs `pnpm typecheck` regardless of the prompt.
8. Hardening follow-ups surfaced (owner decides whether to file): `emitDeclarationOnly` in `tsconfig.base.json`; CI `concurrency` group; `.npmrc` `engine-strict=true`; replace deprecated `tseslint.config()` with `defineConfig`; cosmetic cleanups (dead top-level `types`, `*.tsbuildinfo` gitignore line, README/CI comment wording).

---

## #3 — Docker Compose dev-окружение (2026-09-22)

PR #47, rebase-merged as `c073c19` + `27b63ad` + `c0ccbd3`.

### Process audit

| Role | Step | Result |
|------|------|--------|
| Tech Lead | Preflight | Docker absent on the dev machine — found during the architect pass, not Phase 0. Owner chose Colima + docker CLI (Homebrew); `docker-buildx` added later so the local builder matches CI. |
| Architect | `/clarify` | 4 questions (Docker, container scope, healthcheck depth, env contract). |
| Architect | Plan + Codex plan review | Codex 7 Major + 4 Minor (placeholder liveness, YAML shallow merge, pg connect timeout, URI-encoded credentials, LAN ports, `quit()` rejection, env validation depth) — all verified and folded in before posting. |
| Implementer | `/clarify` | 4 questions (timeout-test technique, CI job placement, container user, commit granularity). |
| Implementer | Build / verify | Real `up --wait`, degraded path, watch restart on own and shared `src`, graceful `down`. Two plan errors found and flagged: `lazyConnect` + no offline queue failed the first probe; `localhost` resolves to `::1` on Alpine. |
| Reviewer | Iteration 1 | Codex + security + code-review high + simplify. CI red (`initial_sync` rejected by the runner's Compose) + failure-path steps dying on the same validation → 2 Major, 10 Minor → Todo. Two review agents died on an API 403 and were relaunched on another model. |
| Architect | Plan Update 1 + Codex re-check | `/clarify` 4 questions. Codex 5 Minors folded in (`${VAR}` still injects `""` → valueless entries; root manifest before `pnpm fetch` for the Corepack pin; `%FF`/IPv6 host checks; `LogLevel` import site; log the failing check's error). |
| Implementer | Iteration 1 | `/clarify` 3 questions; empirical check of valueless-entry semantics; 12 files; owner-confirmed `HEALTH_TIMEOUT_MS` env instead of a constant. |
| Reviewer | Re-review 1 | No Blocker/Major; Minors → LGTM. Codex ran in background mode after a foreground timeout. Owner chose one more iteration on Minors 1–4 at the merge checkpoint. |
| Architect | Plan Update 2 + Codex re-check | `/clarify` 4 questions. Codex attempt 1 failed (no network in sandbox; context inlined on retry); re-check: probe comment must not promise a body; `down -v` noted as destructive (dev volume empty until #7). |
| Implementer | Iteration 2 | `/clarify` 3 questions; 6 files. Found and reverted the shared `image:` tag (concurrent one-tag builds collide under the classic builder). Fail-fast check needed to run without `tsx watch`. |
| Reviewer | Re-review 2 | All four passes clean (Codex re-run in background after a 10-minute foreground kill). Per-merge `AskUserQuestion` → rebase merge, branch deleted. Done after `state == MERGED`. |

### Review iterations: 2 (1 reviewer-returned, 1 owner-requested)

### Findings

| Finding | Severity | Root cause | Missed at step |
|---------|----------|------------|-----------------|
| `initial_sync` rejected by the CI runner's Compose | Major | Compose features verified only against Homebrew's version | Architect Step 7, Implementer Step 5 |
| CI failure-path steps died on the same validation | Major | Diagnostics assumed compose itself cannot fail pre-build | Architect Step 6 |
| `env_file` on the shared anchor leaked `.env` into every container | Minor | Two injection paths for one contract | Architect Step 6 |
| `${VAR:-}` injected `""` for secrets | Minor | Interpolation semantics assumed | Architect Step 6 |
| `lazyConnect` first-probe failure; `localhost` → `::1` | Minor (pre-review) | Client/probe details not exercised until the real stack ran | Architect Step 6 |
| `HEALTH_TIMEOUT_MS` env vs fixed probe timeout | Minor | Clarify-driven change altered an invariant held only in prose | Implementer clarify |
| Shared `image:` tag collided under the classic builder | Minor | Optional suggestion accepted without local reproduction | Reviewer Step 4 |
| Docker / buildx absent locally | Process | Preflight did not check the runtimes the acceptance criteria need | Tech Lead Phase 0 |

### Process improvement proposals

1. Architect: for CI-executed tooling, verify every feature against the runner image's version, not the local one.
2. Architect: diagnostic/cleanup CI steps must tolerate the failure they exist to diagnose.
3. Architect: apply "single source per fact" to env delivery and secrets scoping, not only versions.
4. Architect: verify Compose interpolation/env semantics with `docker compose config` before planning; probes target `127.0.0.1`; lazily-connecting clients cannot pass their own first check.
5. Implementer: when a clarify answer changes a plan constraint, state the affected invariant in the PR body.
6. Reviewer: re-verify "optional improvement" suggestions like findings before folding them into a Plan Update; two simplify sub-agents recommended the exact CI breaker.
7. Tech Lead preflight: verify every runtime the acceptance criteria exercise, including plugin parity with CI.
8. Codex checkpoints: inline all context (no network in the sandbox); run long reviews in background mode and poll `status`/`result`.
9. Follow-up candidates: consolidated in the iteration-2 LGTM comment on PR #47.

---

## #6 — Shared contracts: money, trading, broker, oauth, partner, socket (2026-09-22)

### Process audit
| Role | Step | Result |
|------|------|--------|
| Architect | Plan + Codex plan review | Plan posted before In Progress (8-question clarify); Codex Blocker (string-only wire money) folded in |
| Architect | Plan Update after review | Posted before re-implementation (4-question clarify); Codex re-check attempt 1 died mid-run, attempt 2 hit the Codex usage limit — partial result accepted by owner decision; M3 withdrawn after `tsc --listFiles` verification |
| Implementer | Branch / commits / PR | `feat/6-shared-contracts`; `#6:` commits; PR #48 with `Closes #6`, test plan, iteration section; In Review right after push; diff limited to `packages/shared` |
| Implementer | Check command | Green both iterations (16/187 → 17/233 tests); prettier clean; nine subpaths verified through tsx |
| Reviewer | Iteration 1 | Codex + security + code-review high + simplify; M1, M2 valid, M3 false positive; returned to Todo |
| Reviewer | Rerun | Codex + three agents; all first-review findings closed; no Blocker/Major; 6 Minors; LGTM; merge asked via AskUserQuestion |
| Tech-lead | Merge / Done | Rebase merge `243902a`, branch deleted; Done only after `state == MERGED` |
| Tech-lead | Process | Commit/push autonomy was exercised while the waiver lived only in unmerged PR #1; surfaced to the owner, PR #1 merged 2026-09-22 |

### Review iterations: 1

### Findings
| Finding | Severity | Root cause | Missed at step |
|---------|----------|------------|-----------------|
| Partner `uid` string-only vs `int \| string` id policy | Major | Id policy stated in prose, no shared primitive | Architect plan (entity list) |
| No pre-submit failure edge in the transition table | Major | Table transcribed from the plan's reading of ARCH-03, not derived from the diagram | Architect clarify |
| d.ts "collides with auto-included `@types/node`" | Major (false positive) | Reviewer assumed TS ≤5 defaults; TS 6 defaults `types` to `[]` | Reviewer Step 4 (verify tooling claims) |
| `assets_update` union proposal does not narrow | Minor | Narrowing asserted without a probe | Architect plan (tsc probe) |
| Nine missing `safeParseX`, untyped chart params | Minor | Parsers/params not enumerated in the coverage table | Architect plan |
| Rerun Minors: `canTransition` prototype keys, Partner `source` strict, `asset_id` positivity, decoder comment, weak tests, envelope marker | Minor | Constraint changes applied to the named entity only; comment written from assumption | Implementer self-review |
| Autonomy waiver only in unmerged PR #1 | Process | CLAUDE.md change never merged; harness loads the checked-out branch's copy | Tech-lead Phase 0 |
| Codex usage limit mid-pipeline | Process | Shared quota, reset 15:18 | Tech-lead Phase 0 |

### Process improvement proposals
1. Phase 0 preflight: `git diff origin/main -- .claude/CLAUDE.md` must be empty; check Codex quota/reset time with availability.
2. Reviewer: verify tooling-level claims with the tool before labeling a Major; severity re-verification applies to own findings.
3. Architect: back every type-inference claim with a `tsc` probe; enumerate every parser and request shape in the domain coverage table.
4. Implementer self-review: when relaxing or tightening a constraint, grep the domain for the same construct before committing.

---

## #7 — Drizzle-схема ядра домена (2026-09-22)

### Process audit
| Role | Step | Result |
|------|------|--------|
| Architect | Plan + Codex review | План до In Progress; Codex дал 8 Major, все учтены до реализации |
| Architect | Plan Updates ×3 | Каждый до начала правок, каждый с Codex-перепроверкой. Итерация 3: Codex нашёл 1 Blocker + 1 Major + 2 Minor **в самом плане**; итерация 4: 5 Minor, два из них предотвратили ухудшение тестов |
| Implementer | Branch / commits / PR | `feat/7-drizzle-schema`, 8 коммитов `#7:`, PR #49 с `Closes #7`; кросс-пакетная правка вынесена отдельным коммитом |
| Implementer | Check command | Зелёный на каждой итерации; 68 → 359 тестов |
| Reviewer | Итерации 1–4 | Codex + security + code-review high (+ simplify на первой). Возвраты: 8 Major → 2 Major → 1 Major → 0 |
| Reviewer | Финал | Blocker/Major нет у всех троих, Codex чист два круга подряд; 43 конверсии сверены парсером |
| Tech-lead | Merge / Done | Rebase `686aa2b` после подтверждения владельца; Done только после `state == MERGED` |

### Review iterations: 4

### Findings
| Finding | Severity | Root cause | Missed at step |
|---------|----------|------------|-----------------|
| MATCH SIMPLE в композитном FK `deposit_events` | Major | Семантика match не была указана в плане | Architect |
| `manual_review` как терминальный статус | Major | Один предикат использован для двух разных вопросов | Architect (перенесено из итерации 1) |
| `bonus` занимает единственный слот депозита | Major | Разрешение и ограничение из одного плана не проверены на совместимость | Architect |
| CHECK, проходящий на NULL (дважды: в коде и в плане, который его чинил) | Major | Предикат описан прозой, а не выполнен | Architect |
| TRUNCATE мимо row-level триггеров | Major | Область действия механизма не проверена | Architect |
| Литералы статусов вне одного файла (дважды) | Minor | Правило применено к сущности, а не к домену | Implementer |
| 23 констрейнта без тестов | Major (скрытый) | Чеклист утверждал покрытие, которое никто не проверял | Architect + Implementer |
| Комментарий обещает больше, чем DDL (×4) | Minor | Комментарий не считался предметом проверки | Reviewer |

### Process improvement proposals
1. Таблица охвата перечисляет инварианты со статусом enforced / partially enforced / stated — «N из M» четырежды маскировало неполноту.
2. Каждый CHECK выполняется на NULL/boundary-случаях до попадания в план (введено после итерации 1, сработало на итерации 2 — поймало ошибку в самом Plan Update).
3. Разрешение и ограничение из одного плана проверяются на совместимость.
4. Перенос правила — `grep` по домену, а не по названному файлу.
5. Покрытие проверок обеспечивается исполняемым гейтом, а не утверждением в чеклисте: поведенческая версия при добавлении нашла 23 непокрытых констрейнта.
