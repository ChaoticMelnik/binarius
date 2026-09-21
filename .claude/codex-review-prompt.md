Review diff

Issue: <issue number>
Goal: <what this PR does>
Branch: <branch name>
Scope: <files>
Out of scope: <files/areas>

Invariants:
- <must stay true>
- check command passes

Changed files and local patch are starting hints, not the only source of truth.
Read the scoped files directly via MCP. Use CodeGraph first for structural context if configured; inspect adjacent impact zones when it matters.

Check only for:
- correctness bugs in the changed logic
- regression risk for existing behavior
- [ЗАПОЛНИТЬ доменные инварианты, когда появятся]

Output format:
- findings only
- blocker/major/minor
- do not implement
