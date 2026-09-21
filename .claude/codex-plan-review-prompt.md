Review plan

This is a review-only request. Read-only — do not write, edit, or apply any changes to any file.

Issue: <issue number / title>
Goal: <what should be delivered>
Scope:
- <file or module>
Out of scope:
- <explicitly excluded area>

Invariants:
- <must stay true>

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

Output format:
- findings only
- blocker/major/minor
- short explanation
- file references when possible
- do not implement
