import { and, eq, sql } from 'drizzle-orm';
import {
  BOT_TEXT_DEFAULT_SOURCES,
  BOT_TEXT_OVERRIDE_ROWS_MAX,
  BOT_TEXT_SOURCE_MAX,
  BotTextProblemCode,
  BotTextRejectionCode,
  botTextChangeProblems,
  isBotTextKey,
  resolveBotTextOverridesOf,
  type AdminBotProfileMethodResult,
  type BotLanguage,
  type BotTextChangeProblem,
  type BotTextKey,
  type BotTextRejection,
  AuditAction,
  AuditActorType,
  AuditEntityType,
} from '@binarius/shared';
import type { Db } from './client';
import { auditLog } from './schema/audit-log';
import { botTextOverrides } from './schema/bot-text-overrides';
import type { DbExecutor, Tx } from './trade-intent-ops';

// The one writer of bot_text_overrides (#299, docs/bot-texts.md → Overrides): the CLI, and the
// admin section (#300) inside runAsStaff. Writers serialize on a table lock, so the check of the
// whole set and the write it allows see the same rows; the loaders' plain SELECT does not wait on
// it.

export type BotTextOverrideRecord = typeof botTextOverrides.$inferSelect;

// The first BOT_TEXT_OVERRIDE_ROWS_MAX by (language, key): the bot's wire schema takes no more, so
// the route and the backend's loader read the same rows. The writer cannot get near it (one row per
// catalog key and language); only rows inserted by hand can.
export const listBotTextOverrides = (db: DbExecutor): Promise<BotTextOverrideRecord[]> =>
  db
    .select()
    .from(botTextOverrides)
    .orderBy(botTextOverrides.language, botTextOverrides.key)
    .limit(BOT_TEXT_OVERRIDE_ROWS_MAX);

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
  language: BotLanguage;
  key: string;
  source: string;
  // 0 for a key with no override; absent writes over whatever is there
  expectedVersion?: number;
  actor: BotTextActor;
}

export interface ResetBotTextInput {
  language: BotLanguage;
  key: string;
  expectedVersion?: number;
  actor: BotTextActor;
}

export interface BotTextAuditPayload {
  language: BotLanguage;
  key: string;
  action: 'save' | 'reset';
  oldText: string | null;
  newText: string | null;
  oldVersion: number;
  newVersion: number;
}

// The writer without its audit row, for a caller that records the request itself in the same
// transaction (the admin section, inside runAsStaff). version_conflict carries the text there now,
// so a page can show what it would overwrite.
export type BotTextApplyResult =
  | { ok: true; version: number; audit: BotTextAuditPayload }
  | { ok: false; reason: 'version_conflict'; currentVersion: number; currentSource: string }
  | { ok: false; reason: 'unchanged' }
  | { ok: false; reason: 'already_default' }
  | { ok: false; reason: 'refused'; problems: BotTextChangeProblem[] };

export interface ApplyBotTextSaveInput {
  language: BotLanguage;
  key: string;
  source: string;
  expectedVersion?: number;
  staffId: string | null;
}

export interface ApplyBotTextResetInput {
  language: BotLanguage;
  key: string;
  expectedVersion?: number;
}

// what the key shows in `language` with `rows`: its override in effect, or the language's default
const effectiveText = (
  language: BotLanguage,
  key: string,
  rows: readonly BotTextOverrideRecord[],
): string | null =>
  isBotTextKey(key) ? resolveBotTextOverridesOf(language, rows).source.sourceOf(key) : null;

const isRowOf =
  (language: BotLanguage, key: string) =>
  (row: BotTextOverrideRecord): boolean =>
    row.language === language && row.key === key;

const refused = (key: string, rejection: BotTextRejection): BotTextApplyResult => ({
  ok: false,
  reason: 'refused',
  problems: [{ key, rejection }],
});

export async function applyBotTextSave(
  tx: Tx,
  { language, key, source, expectedVersion, staffId }: ApplyBotTextSaveInput,
): Promise<BotTextApplyResult> {
  if (!isBotTextKey(key)) return refused(key, { code: BotTextRejectionCode.UnknownKey });
  // before the statement: the CHECK would refuse it as a database error
  if (source.length > BOT_TEXT_SOURCE_MAX) {
    const tooLong = { code: BotTextProblemCode.TooLong, detail: String(source.length) } as const;
    return refused(key, { code: BotTextRejectionCode.Invalid, problems: [tooLong] });
  }
  const rows = await lockedRows(tx);
  const current = rows.find(isRowOf(language, key));
  const currentVersion = current?.version ?? 0;
  const currentSource = current?.source ?? BOT_TEXT_DEFAULT_SOURCES[language].sourceOf(key);
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    return { ok: false, reason: 'version_conflict', currentVersion, currentSource };
  }
  // against the row, not the text in effect: re-saving an override the loaders reject changes
  // nothing either
  if (currentSource === source) return { ok: false, reason: 'unchanged' };
  const problems = botTextChangeProblems(language, key, source, rows);
  if (problems.length > 0) return { ok: false, reason: 'refused', problems };
  const [written] = await tx
    .insert(botTextOverrides)
    .values({ language, key, source, updatedByStaffId: staffId })
    .onConflictDoUpdate({
      target: [botTextOverrides.language, botTextOverrides.key],
      set: {
        source,
        version: sql`nextval('bot_text_override_version_seq')`,
        updatedAt: sql`now()`,
        updatedByStaffId: staffId,
      },
    })
    .returning();
  const version = written!.version;
  return {
    ok: true,
    version,
    audit: {
      language,
      key,
      action: 'save',
      oldText: effectiveText(language, key, rows),
      newText: effectiveText(language, key, [
        ...rows.filter((row) => !isRowOf(language, key)(row)),
        written!,
      ]),
      oldVersion: currentVersion,
      newVersion: version,
    },
  };
}

// A key outside the catalog can be reset: a renamed key's row has to be removable.
export async function applyBotTextReset(
  tx: Tx,
  { language, key, expectedVersion }: ApplyBotTextResetInput,
): Promise<BotTextApplyResult> {
  const rows = await lockedRows(tx);
  const current = rows.find(isRowOf(language, key));
  if (current === undefined) return { ok: false, reason: 'already_default' };
  if (expectedVersion !== undefined && expectedVersion !== current.version) {
    return {
      ok: false,
      reason: 'version_conflict',
      currentVersion: current.version,
      currentSource: current.source,
    };
  }
  const problems = botTextChangeProblems(language, key, null, rows);
  if (problems.length > 0) return { ok: false, reason: 'refused', problems };
  await tx
    .delete(botTextOverrides)
    .where(and(eq(botTextOverrides.language, language), eq(botTextOverrides.key, key)));
  return {
    ok: true,
    version: 0,
    audit: {
      language,
      key,
      action: 'reset',
      // a key outside the catalog shows nothing: the row's text is the only copy the audit keeps
      oldText: isBotTextKey(key) ? effectiveText(language, key, rows) : current.source,
      newText: effectiveText(language, key, []),
      oldVersion: current.version,
      newVersion: 0,
    },
  };
}

// The CLI's writers: the change and its audit row in a transaction of their own.
export function saveBotTextOverride(
  db: Db,
  { language, key, source, expectedVersion, actor }: SaveBotTextInput,
): Promise<BotTextWriteResult> {
  return db.transaction(async (tx) =>
    recorded(
      tx,
      AuditAction.BotTextSaved,
      actor,
      await applyBotTextSave(tx, {
        language,
        key,
        source,
        expectedVersion,
        staffId: actor.staffId,
      }),
    ),
  );
}

export function resetBotTextOverride(
  db: Db,
  { language, key, expectedVersion, actor }: ResetBotTextInput,
): Promise<BotTextWriteResult> {
  return db.transaction(async (tx) =>
    recorded(
      tx,
      AuditAction.BotTextReset,
      actor,
      await applyBotTextReset(tx, { language, key, expectedVersion }),
    ),
  );
}

async function recorded(
  tx: Tx,
  action: typeof AuditAction.BotTextSaved | typeof AuditAction.BotTextReset,
  actor: BotTextActor,
  result: BotTextApplyResult,
): Promise<BotTextWriteResult> {
  if (result.ok) {
    await tx.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.staffId,
      action,
      entityType: AuditEntityType.BotText,
      payload: { ...result.audit },
    });
    return { ok: true, version: result.version };
  }
  if (result.reason === 'version_conflict') {
    return { ok: false, reason: result.reason, currentVersion: result.currentVersion };
  }
  return result;
}

export interface BotProfilePublishRecord {
  staffId: string;
  path: string;
  trigger: 'save' | 'reset' | 'republish';
  // the key whose save or reset published, and the one language it published; none for a
  // republish, which publishes every language
  key?: BotTextKey;
  language?: BotLanguage;
  methods: readonly AdminBotProfileMethodResult[];
}

/**
 * The admin's publish of the command menu and the profile (#361), on its own after the Bot API
 * calls: a row inside the write's transaction could not carry their result, and the calls never
 * run inside one. Written whatever Telegram answered.
 */
export async function recordBotProfilePublish(
  db: DbExecutor,
  { staffId, path, trigger, key, language, methods }: BotProfilePublishRecord,
): Promise<void> {
  await db.insert(auditLog).values({
    actorType: AuditActorType.Admin,
    actorId: staffId,
    action: AuditAction.BotProfilePublished,
    entityType: AuditEntityType.BotText,
    payload: {
      path,
      trigger,
      ...(key === undefined ? {} : { key }),
      ...(language === undefined ? {} : { language }),
      methods,
    },
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
