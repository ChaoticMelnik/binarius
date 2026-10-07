import { sql } from 'drizzle-orm';
import { bigint, check, pgSequence, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { BOT_TEXT_KEY_PATTERN, BOT_TEXT_SOURCE_MAX } from '@binarius/shared';
import { sqlTextLiteral } from './columns';
import { staff } from './staff';

// One row per overridden client bot text (#299, docs/bot-texts.md → Overrides); a key with no row
// shows the catalog's default. Whether a key is in the catalog is the writer's check, not the
// table's: the loaders ignore an unknown one.

// A version from a sequence rather than +1: a reset deletes the row, and +1 would hand the next
// save the version a stale form read before the reset.
// Capped at 2^53 - 1, so every version is exact as the JS number the column reads it into.
export const botTextOverrideVersionSeq = pgSequence('bot_text_override_version_seq', {
  maxValue: Number.MAX_SAFE_INTEGER,
});

export const botTextOverrides = pgTable(
  'bot_text_overrides',
  {
    key: text('key').primaryKey(),
    source: text('source').notNull(),
    version: bigint('version', { mode: 'number' })
      .notNull()
      .default(sql`nextval('bot_text_override_version_seq')`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // null from the CLI, a staff member's id from the admin section
    updatedByStaffId: uuid('updated_by_staff_id').references(() => staff.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    check(
      'bot_text_overrides_key_check',
      sql`${t.key} ~ ${sqlTextLiteral(BOT_TEXT_KEY_PATTERN.source, 'BOT_TEXT_KEY_PATTERN')}`,
    ),
    check(
      'bot_text_overrides_source_length_check',
      sql`char_length(${t.source}) between 1 and ${sql.raw(String(BOT_TEXT_SOURCE_MAX))}`,
    ),
  ],
);
