import { sql } from 'drizzle-orm';
import {
  BOT_TEXT_CATALOG,
  BOT_TEXT_SOURCE_MAX,
  BotTextProblemCode,
  BotTextRejectionCode,
  botTextChangeProblems,
  isBotTextKey,
  isBotTextWritable,
  resolveBotTextOverrides,
  type BotTextChangeProblem,
  type BotTextRejection,
} from '@binarius/shared';
import type { Db } from './client';
import { AuditAction, AuditEntityType, auditLog, type AuditActorType } from './schema/audit-log';
import { botTextOverrides } from './schema/bot-text-overrides';
import type { DbExecutor, Tx } from './trade-intent-ops';

// The one writer of bot_text_overrides (#299, docs/bot-texts.md → Overrides): the CLI now, the
// admin section (#300) later. Writers serialize on a table lock, so the check of the whole set
// and the write it allows see the same rows; the loaders' plain SELECT does not wait on it.

export type BotTextOverrideRecord = typeof botTextOverrides.$inferSelect;

export const listBotTextOverrides = (db: DbExecutor): Promise<BotTextOverrideRecord[]> =>
  db.select().from(botTextOverrides).orderBy(botTextOverrides.key);

export interface BotTextActor {
  type: AuditActorType;
  staffId: string | null;
}

export type BotTextWriteResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'unchanged' }
  | { ok: false; reason: 'already_default' }
  | { ok: false; reason: 'refused'; problems: BotTextChangeProblem[] };

export interface SaveBotTextInput {
  key: string;
  source: string;
  // 0 for a key with no override; absent writes over whatever is there
  expectedVersion?: number;
  actor: BotTextActor;
}

export interface ResetBotTextInput {
  key: string;
  expectedVersion?: number;
  actor: BotTextActor;
}

// what the key shows with `rows`: its override in effect, or the default
const effectiveText = (key: string, rows: readonly BotTextOverrideRecord[]): string | null =>
  isBotTextKey(key) ? resolveBotTextOverrides(rows).source.sourceOf(key) : null;

const refused = (key: string, rejection: BotTextRejection): BotTextWriteResult => ({
  ok: false,
  reason: 'refused',
  problems: [{ key, rejection }],
});
const refusedKey = (key: string): BotTextWriteResult =>
  refused(key, {
    code: isBotTextKey(key) ? BotTextRejectionCode.ReadOnlyGroup : BotTextRejectionCode.UnknownKey,
  });

export function saveBotTextOverride(
  db: Db,
  { key, source, expectedVersion, actor }: SaveBotTextInput,
): Promise<BotTextWriteResult> {
  if (!isBotTextWritable(key)) return Promise.resolve(refusedKey(key));
  // before the statement: the CHECK would refuse it as a database error
  if (source.length > BOT_TEXT_SOURCE_MAX) {
    const tooLong = { code: BotTextProblemCode.TooLong, detail: String(source.length) } as const;
    return Promise.resolve(
      refused(key, { code: BotTextRejectionCode.Invalid, problems: [tooLong] }),
    );
  }
  return db.transaction(async (tx) => {
    const rows = await lockedRows(tx);
    const current = rows.find((row) => row.key === key);
    const currentVersion = current?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion };
    }
    // against the row, not the text in effect: re-saving an override the loaders reject changes
    // nothing either
    if ((current?.source ?? BOT_TEXT_CATALOG[key].source) === source) {
      return { ok: false, reason: 'unchanged' };
    }
    const problems = botTextChangeProblems(key, source, rows);
    if (problems.length > 0) return { ok: false, reason: 'refused', problems };
    const [written] = await tx
      .insert(botTextOverrides)
      .values({ key, source, updatedByStaffId: actor.staffId })
      .onConflictDoUpdate({
        target: botTextOverrides.key,
        set: {
          source,
          version: sql`nextval('bot_text_override_version_seq')`,
          updatedAt: sql`now()`,
          updatedByStaffId: actor.staffId,
        },
      })
      .returning();
    const version = written!.version;
    await audit(tx, AuditAction.BotTextSaved, actor, {
      key,
      action: 'save',
      oldText: effectiveText(key, rows),
      newText: effectiveText(key, [...rows.filter((row) => row.key !== key), written!]),
      oldVersion: currentVersion,
      newVersion: version,
    });
    return { ok: true, version };
  });
}

// A key outside the catalog can be reset: a renamed key's row has to be removable.
export function resetBotTextOverride(
  db: Db,
  { key, expectedVersion, actor }: ResetBotTextInput,
): Promise<BotTextWriteResult> {
  if (isBotTextKey(key) && !isBotTextWritable(key)) return Promise.resolve(refusedKey(key));
  return db.transaction(async (tx) => {
    const rows = await lockedRows(tx);
    const current = rows.find((row) => row.key === key);
    if (current === undefined) return { ok: false, reason: 'already_default' };
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      return { ok: false, reason: 'version_conflict', currentVersion: current.version };
    }
    const problems = botTextChangeProblems(key, null, rows);
    if (problems.length > 0) return { ok: false, reason: 'refused', problems };
    await tx.delete(botTextOverrides).where(sql`${botTextOverrides.key} = ${key}`);
    await audit(tx, AuditAction.BotTextReset, actor, {
      key,
      action: 'reset',
      oldText: effectiveText(key, rows),
      newText: effectiveText(key, []),
      oldVersion: current.version,
      newVersion: 0,
    });
    return { ok: true, version: 0 };
  });
}

// The writers' lock: conflicts with itself and with every row write, not with a plain SELECT.
// Exported for the tests that hold it from outside a writer.
export async function lockBotTextOverrides(tx: Tx): Promise<void> {
  await tx.execute(sql`lock table ${botTextOverrides} in share row exclusive mode`);
}

async function lockedRows(tx: Tx): Promise<BotTextOverrideRecord[]> {
  await lockBotTextOverrides(tx);
  return listBotTextOverrides(tx);
}

async function audit(
  tx: Tx,
  action: typeof AuditAction.BotTextSaved | typeof AuditAction.BotTextReset,
  actor: BotTextActor,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorType: actor.type,
    actorId: actor.staffId,
    action,
    entityType: AuditEntityType.BotText,
    payload,
  });
}
