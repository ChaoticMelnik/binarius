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
