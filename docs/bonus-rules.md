# Bonus rules (#13)

Every bonus credit in `token_ledger` is made under a **versioned rule** and names the version it
was made under. A rule is never edited: a change is a new version, which `activate` makes the
one that credits. What was credited before keeps its version and its amount.

| Component | Where | Role |
|---|---|---|
| Kinds and params | `packages/shared/src/bonus.ts` | `BonusRuleKind`, the params schema of each kind, `BONUS_RULE_TOKENS_MAX` |
| Table | `packages/db/src/schema/bonus-rules.ts`, `drizzle/0059_bonus_rules.sql` | versions, the immutability triggers, the seed |
| Engine | `packages/db/src/bonus-rule-ops.ts` | `resolveActiveRule`, `applyBonus` (the bonus writer), the CLI's writers |
| Starter pack | `packages/db/src/link-bonus-ops.ts` | `grantLinkBonus` → `applyBonus('link_bonus', …)` ([binodex-oauth.md](binodex-oauth.md) → The starter pack) |
| CLI | `apps/backend/src/cli/bonus-rule.ts` | `list`, `new-version`, `activate`, `deactivate` |

## The model

- **A version** is a `bonus_rules` row: `code`, `version` (from 1, unique per code), `kind`,
  `params` (jsonb), `is_active`, optional `valid_from` / `valid_to`.
- **Immutable.** The triggers `bonus_rules_immutable`, `bonus_rules_no_delete` and
  `bonus_rules_no_truncate` refuse an UPDATE of `id`, `code`, `version`, `kind`, `priority`,
  `params` or `created_at`, every DELETE and every TRUNCATE (`bonus_rules rows are immutable`,
  P0001). Only `is_active`, `valid_from`, `valid_to` and `updated_at` change. `priority` is the
  skeleton's column (#7) and nothing reads it.
- **One active version per code** — the partial unique index `bonus_rules_active_code_idx`. A
  new version is inserted inactive (the column's default is `false`, so a row inserted by hand
  stays off too).
- **Resolution.** `resolveActiveRule(tx, code)` takes the active version of the code with
  `valid_from` at or before and `valid_to` after `now()` of the crediting transaction — the
  database clock. None → no grant (`no_active_rule`).
- **Params are parsed at read** by the kind's schema. An active version whose params do not
  parse, or whose kind is not the one the reference needs, throws `InvalidBonusRule` (name, and
  the rule's code as `code`): the caller's transaction rolls back. There is no default amount and
  no partial grant.

| Kind | Params | Who credits |
|---|---|---|
| `link_bonus` | `{ "tokens": "<1..1000>" }` | `grantLinkBonus`, the starter pack |
| `referral_reward` | `{ "tokens": "<1..1000>" }` | `grantReferralReward`, the inviter's reward ([referrals.md → The reward](referrals.md#the-reward), #116) |
| `deposit_bonus` | `{ "tokensPerUsd": "<decimal > 0>", "minAmountUsd": "<decimal ≥ 0>", "maxTokens": "<decimal > 0>" }` | #386; the formula over these is #386's |

Tokens are decimal strings, never JSON numbers: the amount reaches `bigint` without a float
(Rule 2). `1000` is `BONUS_RULE_TOKENS_MAX`, a typo guard of the same order as the manual
adjustment's cap, not a CHECK. Every object is strict: an unknown key is refused.

## The ledger side

- `token_ledger.bonus_rule_id` and `bonus_rule_kind`, with the composite FK
  `token_ledger_bonus_rule_fk (bonus_rule_id, bonus_rule_kind) → bonus_rules (id, kind)`.
- `token_ledger_bonus_rule_check`: a `bonus` names a rule **of the kind its reference
  requires** — a starter pack (a `broker_account_id`) a `link_bonus` rule, a deposit-linked bonus
  a `deposit_bonus` rule, an inviter's reward (a `referral_id`, #116) a `referral_reward` rule —
  and a bonus that names no reference (a promo) is refused. Every other kind names no rule.
- Each reference keeps its own dedupe key: the starter pack one per user
  (`token_ledger_link_bonus_user_idx`), a deposit one bonus per deposit
  (`token_ledger_deposit_event_idx`), an inviter's reward one per referral
  (`token_ledger_referral_idx`). `applyBonus` takes the reference as `{ brokerAccountId }` or
  `{ referralId }`; the reference picks the rule kind it accepts and the `ON CONFLICT` arbiter. A rule change does not widen them, so a later version never
  credits the same event again.
- **What a rule change does:** the next credit uses the new version. **What it does not do:**
  write any ledger row, or touch a credit already made — those keep the version they name.
- `applyBonus` writes the ledger row and `users.token_balance` in the caller's transaction
  (Rule 2). The rule's id and its amount come from one row read; an activation committed between
  that read and the insert leaves the grant on the version it read. `bonus_rules` is outside the
  `users → …` lock chain: the grant reads it without a lock (the FK takes `KEY SHARE`), and the CLI
  locks one code's rows `FOR NO KEY UPDATE`, which does not wait for it.

## The CLI

`pnpm --filter @binarius/backend bonus-rule …`, inside the backend container on a stand
(`docker compose exec backend …`, README → Bonus rules). Exit 0 done, 1 refused or failed, 2 not
understood. Every change writes one `audit_log` row in its transaction (actor `system`, entity
`bonus_rule`): `bonus_rule_version_created` (code, version, kind, params),
`bonus_rule_activated` (code, version, previousVersion), `bonus_rule_deactivated` (code,
version). A refusal writes nothing.

```bash
bonus-rule list
bonus-rule new-version link_bonus --params '{"tokens": "150"}'
bonus-rule activate link_bonus 2
bonus-rule deactivate link_bonus
bonus-rule new-version deposit_bonus --kind deposit_bonus --params '{"tokensPerUsd": "1", "minAmountUsd": "10", "maxTokens": "500"}'
```

- `new-version` inserts version = last + 1, inactive. `--kind` is required for a code with no
  versions and must equal the code's kind otherwise. Params are checked before the insert.
- `activate` deactivates the current version and activates the given one in one transaction;
  it refuses an unknown version, the active one, and one whose params no longer parse.
- `deactivate` leaves the code with no active version: its grants stop. For `link_bonus`, an
  account is then activated without a pack (`no_active_rule`) and the backend logs
  `link_bonus_no_active_rule` (warn) with `userId` and `brokerAccountId`.
- The CLI is the only writer besides the seed. SQL by hand passes it, but not the triggers.

**The deposit rule.** No `deposit_bonus` version exists until the owner creates one with
`new-version` above. Activate it only after #386 (the deposit credit) is in; the authenticity
(#142) is the URL secret ([postbacks.md](postbacks.md) → Authenticity). Before #386 nothing reads
it.

## Migration 0059 and the deploy

- **Guards.** The migration raises, and the backend container does not start, if `bonus_rules`
  is not empty (nothing in the code ever wrote it, so a row there was inserted by hand and is not
  guessed into a version) or if a `bonus` row names no broker account (only starter packs are
  backfilled). **Before the deploy:** `select count(*) from bonus_rules` on production is `0`.
- **Seed.** `link_bonus` v1 `{ "tokens": "100" }` and `referral_reward` v1 `{ "tokens": "50" }`,
  both active (owner, 2026-10-08). No `deposit_bonus` version.
- **Backfill — the one sanctioned bypass of `token_ledger_append_only`** (Architecture Rules,
  Rule 3). The starter packs credited before 0059 were 100 tokens under the hard-coded constant
  that `link_bonus` v1 now holds. The migration disables the trigger, sets `bonus_rule_id` /
  `bonus_rule_kind` on every `bonus` row with a `broker_account_id`, and enables the trigger again,
  before adding the CHECK and the FK. The migrator runs the pending migrations in one transaction,
  so a failure leaves the trigger enabled and nothing written; `bonus-rules-migration.db.test.ts`
  proves both triggers enabled afterwards and an UPDATE refused again.
