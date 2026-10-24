import { eq } from 'drizzle-orm';
import {
  BOT_TEXT_CATALOG,
  BOT_TEXT_OVERRIDE_ROWS_MAX,
  adminBotTextReason,
  type AdminBotTextOverrideView,
  type AdminBotTextView,
  type BotLanguage,
  type BotTextKey,
  type BotTextRejection,
  type ResolvedBotTexts,
} from '@binarius/shared';
import { botTextOverrides } from './schema/bot-text-overrides';
import { staff } from './schema/staff';
import type { Tx } from './trade-intent-ops';

// The admin section «Тексты бота» (#300; docs/admin-pages.md → Bot texts): the rows the loaders
// read, with who wrote them. Locks nothing; the writes go through applyBotTextSave/Reset.

export interface AdminBotTextOverrideRow {
  language: BotLanguage;
  key: string;
  source: string;
  version: number;
  updatedAt: Date;
  // null: written by the CLI
  updatedByLogin: string | null;
}

// the same rows as listBotTextOverrides: the first BOT_TEXT_OVERRIDE_ROWS_MAX by (language, key)
export const listBotTextOverridesForAdmin = (tx: Tx): Promise<AdminBotTextOverrideRow[]> =>
  tx
    .select({
      language: botTextOverrides.language,
      key: botTextOverrides.key,
      source: botTextOverrides.source,
      version: botTextOverrides.version,
      updatedAt: botTextOverrides.updatedAt,
      updatedByLogin: staff.login,
    })
    .from(botTextOverrides)
    .leftJoin(staff, eq(staff.id, botTextOverrides.updatedByStaffId))
    .orderBy(botTextOverrides.language, botTextOverrides.key)
    .limit(BOT_TEXT_OVERRIDE_ROWS_MAX);

const reasonOf = (rejection: BotTextRejection | undefined, key: string): string | null =>
  rejection === undefined ? null : adminBotTextReason(rejection, key);

export const toAdminBotTextOverrideView = (
  row: AdminBotTextOverrideRow,
  rejection: BotTextRejection | undefined,
): AdminBotTextOverrideView => ({
  language: row.language,
  key: row.key,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
  updatedByLogin: row.updatedByLogin,
  rejection: reasonOf(rejection, row.key),
});

// The key in the language `resolved` was resolved for: its row, its rejection and its fragments'
// texts are that language's.
export function toAdminBotTextView(
  key: BotTextKey,
  rows: readonly AdminBotTextOverrideRow[],
  resolved: ResolvedBotTexts,
): AdminBotTextView {
  const { language } = resolved;
  const row = rows.find((candidate) => candidate.language === language && candidate.key === key);
  return {
    language,
    key,
    override:
      row === undefined
        ? null
        : {
            source: row.source,
            version: row.version,
            updatedAt: row.updatedAt.toISOString(),
            updatedByLogin: row.updatedByLogin,
          },
    rejection: reasonOf(resolved.rejected.get(key), key),
    fragments: Object.entries(BOT_TEXT_CATALOG[key].fragments).map(([placeholder, fragment]) => ({
      placeholder,
      key: fragment,
      source: resolved.source.sourceOf(fragment as BotTextKey),
      overridden: resolved.texts.has(fragment as BotTextKey),
    })),
  };
}
