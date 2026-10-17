import { and, asc, eq, sql } from 'drizzle-orm';
import {
  AuditAction,
  AuditActorType,
  AuditEntityType,
  BonusRuleKind,
  LinkBonusSkipReason,
  TokenLedgerKind,
  bonusRuleParamsProblem,
  parseBonusRuleParams,
  type BonusRuleParams,
} from '@binarius/shared';
import type { Db } from './client';
import { literal } from './schema/columns';
import { auditLog } from './schema/audit-log';
import { bonusRules } from './schema/bonus-rules';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';
import type { DbExecutor, Tx } from './trade-intent-ops';

// The bonus rule engine (#13, docs/bonus-rules.md). A credit is bound to the version that was
// active when it was written, and a rule change writes no ledger rows, so changing a rule never
// re-credits what was already credited: the dedupe keys of each reference (the starter pack per
// user, the deposit per kind, the inviter's reward per referral) keep a later version from
// paying the same event again.
//
// bonus_rules sits outside the users → … lock chain (Rule 5): applyBonus reads it without a lock
// (the ledger insert's FK takes KEY SHARE on the rule row), and the CLI's writers lock only the
// rows of one code, FOR NO KEY UPDATE, which KEY SHARE does not wait for.

export type BonusRuleRow = typeof bonusRules.$inferSelect;

export type ResolvedBonusRule = {
  [K in BonusRuleKind]: {
    id: string;
    code: string;
    version: number;
    kind: K;
    params: BonusRuleParams<K>;
  };
}[BonusRuleKind];

// An active rule whose params do not fit its kind, or whose kind is not the one the reference
// needs. Never a default, never a partial grant: the caller's transaction rolls back. The rule's
// code rides as `code`, so the log line (name and code, Rule 8) says which rule to fix.
export class InvalidBonusRule extends Error {
  override readonly name = 'InvalidBonusRule';
  readonly code: string;
  constructor(code: string) {
    super(`bonus rule ${code} cannot be applied`);
    this.code = code;
  }
}

// The one active version of a code valid now, by the database clock; undefined when none is.
export async function resolveActiveRule(
  executor: DbExecutor,
  code: string,
): Promise<ResolvedBonusRule | undefined> {
  const [row] = await executor
    .select({
      id: bonusRules.id,
      code: bonusRules.code,
      version: bonusRules.version,
      kind: bonusRules.kind,
      params: bonusRules.params,
    })
    .from(bonusRules)
    .where(
      and(
        eq(bonusRules.code, code),
        eq(bonusRules.isActive, true),
        sql`(${bonusRules.validFrom} is null or ${bonusRules.validFrom} <= now())`,
        sql`(${bonusRules.validTo} is null or ${bonusRules.validTo} > now())`,
      ),
    );
  if (row === undefined) return undefined;
  const params = parseBonusRuleParams(row.kind, row.params);
  if (params === undefined) throw new InvalidBonusRule(code);
  return { ...row, params } as ResolvedBonusRule;
}

// #386 adds { depositEventId }. Each reference pins the rule kind it may be credited under
// (token_ledger_bonus_rule_check) and has its own arbiter, a partial unique index whose predicate
// the conflict clause repeats: a partial unique index is an arbiter only when the conflict clause
// implies its predicate.
export type BonusReference = { brokerAccountId: string } | { referralId: string };

function referenceShape(reference: BonusReference) {
  if ('referralId' in reference) {
    return {
      kind: BonusRuleKind.ReferralReward,
      columns: { referralId: reference.referralId },
      conflict: {
        target: tokenLedger.referralId,
        where: sql`${tokenLedger.referralId} is not null`,
      },
    };
  }
  return {
    kind: BonusRuleKind.LinkBonus,
    columns: { brokerAccountId: reference.brokerAccountId },
    conflict: {
      target: tokenLedger.userId,
      where: sql`${tokenLedger.kind} = ${literal(TokenLedgerKind.Bonus)} and ${tokenLedger.brokerAccountId} is not null`,
    },
  };
}

export type BonusSkipReason =
  typeof LinkBonusSkipReason.NoActiveRule | typeof LinkBonusSkipReason.AlreadyGranted;

export type BonusGrant =
  | { granted: true; tokens: bigint; ruleId: string; version: number }
  | { granted: false; reason: BonusSkipReason };

// The bonus writer (Rule 2): the ledger row and users.token_balance in the caller's transaction,
// which holds the users row FOR NO KEY UPDATE. The rule's id and its amount come from one row
// read, so a grant is never one version's id with another's amount; an activation committed
// between that read and the insert leaves the grant on the version it read.
export async function applyBonus(
  tx: Tx,
  { code, userId, reference }: { code: string; userId: string; reference: BonusReference },
): Promise<BonusGrant> {
  const shape = referenceShape(reference);
  const rule = await resolveActiveRule(tx, code);
  if (rule === undefined) return { granted: false, reason: LinkBonusSkipReason.NoActiveRule };
  if (rule.kind !== shape.kind) throw new InvalidBonusRule(code);
  const { tokens } = rule.params;
  const [row] = await tx
    .insert(tokenLedger)
    .values({
      userId,
      kind: TokenLedgerKind.Bonus,
      balanceDelta: tokens,
      ...shape.columns,
      bonusRuleId: rule.id,
      bonusRuleKind: rule.kind,
    })
    .onConflictDoNothing(shape.conflict)
    .returning({ id: tokenLedger.id });
  if (row === undefined) return { granted: false, reason: LinkBonusSkipReason.AlreadyGranted };

  await tx
    .update(users)
    .set({ tokenBalance: sql`${users.tokenBalance} + ${tokens}` })
    .where(eq(users.id, userId));
  return { granted: true, tokens, ruleId: rule.id, version: rule.version };
}

// --- The CLI's writers (apps/backend/src/cli/bonus-rule.ts) -----------------------------------
// The only writers of bonus_rules besides the seed in 0059. SQL by hand passes them, though the
// triggers still refuse any edit of what a version credits. Each change writes its audit_log row
// in the same transaction (actor `system`, like the bot-text CLI).

export async function listBonusRules(db: DbExecutor): Promise<BonusRuleRow[]> {
  return db.select().from(bonusRules).orderBy(asc(bonusRules.code), asc(bonusRules.version));
}

async function lockCode(tx: Tx, code: string): Promise<BonusRuleRow[]> {
  return tx
    .select()
    .from(bonusRules)
    .where(eq(bonusRules.code, code))
    .orderBy(asc(bonusRules.version))
    .for('no key update');
}

export type CreateBonusRuleVersionResult =
  | { ok: true; row: BonusRuleRow }
  | { ok: false; reason: 'kind_required' }
  | { ok: false; reason: 'kind_mismatch'; kind: BonusRuleKind }
  | { ok: false; reason: 'params_refused'; problem: string };

// Inserted inactive; `activate` makes it the one that credits. Two concurrent first versions of a
// new code both see no row to lock, and the second fails on bonus_rules_code_version_key.
export async function createBonusRuleVersion(
  db: Db,
  { code, kind, params }: { code: string; kind?: BonusRuleKind; params: unknown },
): Promise<CreateBonusRuleVersionResult> {
  return db.transaction(async (tx) => {
    const rows = await lockCode(tx, code);
    const existing = rows[0]?.kind;
    if (existing === undefined && kind === undefined) return { ok: false, reason: 'kind_required' };
    if (existing !== undefined && kind !== undefined && kind !== existing) {
      return { ok: false, reason: 'kind_mismatch', kind: existing };
    }
    const ruleKind = (existing ?? kind) as BonusRuleKind;
    const problem = bonusRuleParamsProblem(ruleKind, params);
    if (problem !== undefined) return { ok: false, reason: 'params_refused', problem };

    const [row] = await tx
      .insert(bonusRules)
      .values({
        code,
        version: (rows.at(-1)?.version ?? 0) + 1,
        kind: ruleKind,
        isActive: false,
        params: params as Record<string, unknown>,
      })
      .returning();
    if (row === undefined) throw new Error('bonus rule insert returned no row');
    await tx.insert(auditLog).values({
      actorType: AuditActorType.System,
      action: AuditAction.BonusRuleVersionCreated,
      entityType: AuditEntityType.BonusRule,
      entityId: row.id,
      payload: { code, version: row.version, kind: row.kind, params: row.params },
    });
    return { ok: true, row };
  });
}

export type ActivateBonusRuleResult =
  | { ok: true; row: BonusRuleRow; previousVersion: number | null }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_active' }
  | { ok: false; reason: 'params_refused'; problem: string };

// Deactivates the current version first, then activates the given one, in one transaction: the
// partial unique index bonus_rules_active_code_idx is never crossed mid-swap.
export async function activateBonusRuleVersion(
  db: Db,
  { code, version }: { code: string; version: number },
): Promise<ActivateBonusRuleResult> {
  return db.transaction(async (tx) => {
    const rows = await lockCode(tx, code);
    const target = rows.find((row) => row.version === version);
    if (target === undefined) return { ok: false, reason: 'not_found' };
    if (target.isActive) return { ok: false, reason: 'already_active' };
    const problem = bonusRuleParamsProblem(target.kind, target.params);
    if (problem !== undefined) return { ok: false, reason: 'params_refused', problem };

    const current = rows.find((row) => row.isActive);
    if (current !== undefined) {
      await tx.update(bonusRules).set({ isActive: false }).where(eq(bonusRules.id, current.id));
    }
    const [row] = await tx
      .update(bonusRules)
      .set({ isActive: true })
      .where(eq(bonusRules.id, target.id))
      .returning();
    if (row === undefined) throw new Error('bonus rule activation returned no row');
    const previousVersion = current?.version ?? null;
    await tx.insert(auditLog).values({
      actorType: AuditActorType.System,
      action: AuditAction.BonusRuleActivated,
      entityType: AuditEntityType.BonusRule,
      entityId: row.id,
      payload: { code, version, previousVersion },
    });
    return { ok: true, row, previousVersion };
  });
}

export type DeactivateBonusRuleResult =
  { ok: true; row: BonusRuleRow } | { ok: false; reason: 'not_found' | 'not_active' };

// Leaves the code with no active version: its grants stop (link_bonus: no_active_rule).
export async function deactivateBonusRule(
  db: Db,
  { code }: { code: string },
): Promise<DeactivateBonusRuleResult> {
  return db.transaction(async (tx) => {
    const rows = await lockCode(tx, code);
    if (rows.length === 0) return { ok: false, reason: 'not_found' };
    const current = rows.find((row) => row.isActive);
    if (current === undefined) return { ok: false, reason: 'not_active' };
    const [row] = await tx
      .update(bonusRules)
      .set({ isActive: false })
      .where(eq(bonusRules.id, current.id))
      .returning();
    if (row === undefined) throw new Error('bonus rule deactivation returned no row');
    await tx.insert(auditLog).values({
      actorType: AuditActorType.System,
      action: AuditAction.BonusRuleDeactivated,
      entityType: AuditEntityType.BonusRule,
      entityId: row.id,
      payload: { code, version: row.version },
    });
    return { ok: true, row };
  });
}
