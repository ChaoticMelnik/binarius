Review plan

This is a review-only request. Read-only — do not write, edit, or apply any changes to any file.

Issue: <issue number / title>
Goal: <what should be delivered>
Scope:
- <file or module>
Out of scope:
- <explicitly excluded area>

Invariants:
- the project's list: `.claude/skills/architect/SKILL.md` → "Architecture Rules to Enforce in Every Plan" (read it; each one the plan touches must be named and preserved)
- <task-specific invariant that must stay true>

Draft plan:
1. <step>

Review only for gaps, missing invariants, hidden dependencies, missing tests, rollout risks, and wrong assumptions.
Read the scoped files directly. Use CodeGraph first for structural checks if configured; otherwise read files directly.

Mandatory checks (answer each explicitly — this list grows over time; add a new numbered check whenever a real Blocker/Major traces back to something not covered here, never remove one without reason):
1. Does every mutating endpoint have the same authorization pattern as its neighbors in the same file?
2. Is there a read-before-mutate (TOCTOU) pattern? If yes: atomic guard, or an explicitly accepted race condition with a reason?
3. Do nullable parameters change type? If yes: do existing null/undefined records still hit a working fallback path?
4. Do try/catch blocks specify what the catch branch returns and why?
5. Does external input get written to a field with strict numeric/format requirements? If yes: is sanitization explicit in the plan?
6. Does the plan touch a boolean/truthiness gate on a value that can legitimately be empty-string/0/null? If yes: are all falsy cases enumerated?
7. Does a response handler spread a full DB row into JSON? If yes: does the plan verify no sensitive column leaks?
8. Does every new or changed CHECK constraint hold on NULL and on boundary values? Evaluate each one on those rows, do not assume.
9. Does anything the plan allows collide with anything the same plan forbids (a permission and a restriction that cannot both hold on some path)?
10. Does every budget/timeout constant name the operation it bounds, and is the ordering between them checked at import and by a test — in every process that has the mechanism, not only the one named?
11. Is CI-executed tooling checked against the CI runner image's versions, not the local ones?
12. Single source per fact: does any version, list, env value or secret scope now live in two places that can drift apart?
13. If the plan changes the toolchain (Node, TypeScript, ESLint, pnpm, engines): is the intersection of every root devDependency's `engines` stated, and are fresh-clone / stale-cache / incremental scenarios covered?
14. Are every parser and every request/response shape in the domain listed individually in the coverage table?
15. Does the plan rely on a framework default (error body, redaction, retry, timeout, lock mode)? If yes: was it verified by execution, and is the evidence quoted?
16. Is every invariant the plan documents worded no wider than the place that enforces it (cited file/constraint/test)?

Output format:
- findings only
- blocker/major/minor
- short explanation
- file references when possible
- do not implement
