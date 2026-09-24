Review diff

This is a review-only request. Read-only — do not write, edit, or apply any changes to any file.

Issue: <issue number>
Goal: <what this PR does>
Branch: <branch name>
Scope: the whole feature — `git diff origin/main...HEAD` (the PR diff from its merge base, inlined below). Never an iteration's diff: a defect whose two halves sit in different commits is invisible to a review of either commit alone.
Out of scope: <files/areas>
Accepted risks (from the plan — do not re-raise): <list, or "none">

Invariants:
- the project's list: `.claude/skills/architect/SKILL.md` → "Architecture Rules to Enforce in Every Plan" (read it; flag any change that breaks one)
- <task-specific invariant from the plan>
- check command (`pnpm check`) passes

The inlined diff is the starting point, not the only source of truth.
Read the scoped files directly. Use CodeGraph first for structural context if configured; inspect adjacent impact zones when it matters. The sandbox has no network: do not try `gh` or URLs.

Check only for:
- correctness bugs in the changed logic
- regression risk for existing behavior
- a broken invariant from the list above
- a fix that closes one occurrence of a defect class while another occurrence of the same construct remains (search the tree for it)
- a comment, doc or README sentence that promises more than the code or DDL enforces
- a change to what reaches the logs without a test that reads the log itself (not the HTTP response)
- a command added to documentation that does not work as written

Process docs (only when the diff touches `.claude/**` or `audits.md`) — look for contradictions:
- (a) between the skills (`architect`, `implementer`, `reviewer`, `tech-lead`, `github`): the same status transition, the same step order, the same check command described differently;
- (b) between the skills and `.claude/CLAUDE.md`;
- (c) between the project `.claude/CLAUDE.md` and the global `~/.claude/CLAUDE.md` inlined below (the sandbox cannot read it). A (c) contradiction is reported as "project section governs" and does not block the merge; it feeds the proposed edit of the global file.
Example of the class this must catch: `.claude/CLAUDE.md` said a returned issue goes "→ In Progress" while reviewer Step 6a sent it "→ Todo".

<global ~/.claude/CLAUDE.md, inlined — only for a process-docs diff>

Output format:
- findings only
- blocker/major/minor
- do not implement

<the diff>
