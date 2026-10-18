import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  BotLanguage,
  DEFAULT_BOT_LANGUAGE,
  NotificationLevel,
  START_PAYLOAD_PATTERN,
  TradeMode,
  UserStatus,
} from '@binarius/shared';
import {
  createdAt,
  id,
  inList,
  money,
  nullablePositiveNumeric,
  sqlTextLiteral,
  tokenAmount,
  updatedAt,
} from './columns';

// token_balance / token_reserved are caches of token_ledger sums, updated in the same
// transaction as the ledger row; available tokens = token_balance - token_reserved.
// users_token_reserved_check is a non-deferrable cross-column CHECK, so it is evaluated per
// statement: a settlement must move both columns in one UPDATE, not in two.
export const users = pgTable(
  'users',
  {
    id: id(),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull(),
    displayName: text('display_name'),
    languageCode: text('language_code'),
    // The language of the bot's texts (#508, docs/bot-texts.md → Languages): botLanguageOf
    // (language_code) when recordUserStart inserts the row, then only setUserLanguage, the
    // user's own choice in the bot. language_code above keeps following Telegram.
    language: text('language').$type<BotLanguage>().notNull().default(DEFAULT_BOT_LANGUAGE),
    status: text('status').$type<UserStatus>().notNull().default(UserStatus.Active),
    // Where this user came from: the raw start payload of the first /start that carried one
    // (first touch), and the database clock at that moment. A /start without a payload leaves
    // both NULL, so an organic first visit does not spend the attribution slot on nothing.
    acquisitionSource: text('acquisition_source'),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }),
    // When the bot learned it cannot reach this user (#119): a `kicked` chat-member update or a
    // 403 on a send. NULL = deliverable. Independent of `status`, which is the admin block.
    // A sender reads it only through deliverable() (delivery-ops.ts); the admin user card (#107)
    // shows it.
    telegramBlockedAt: timestamp('telegram_blocked_at', { withTimezone: true }),
    // The user's choice in /settings (#120), a preference rather than a deliverability fact:
    // written only by setNotificationLevel; a sender reads it only through deliverable() or
    // acceptsMailing(); /users/start shows it to /settings and the admin user card (#107)
    // displays it.
    notificationLevel: text('notification_level')
      .$type<NotificationLevel>()
      .notNull()
      .default(NotificationLevel.All),
    // The user's stake of each mode (#297 demo, #326 real): NULL = the broker's minimum at each
    // trade. Written only by setStake; the bounds are checked by checkStake (@binarius/shared)
    // against that mode's balance, not here.
    demoStake: money('demo_stake'),
    realStake: money('real_stake'),
    // The mode of the user's next single trade (#121, docs/trading-mode.md). Written only by
    // setTradingMode; a real intent is created only while it is `real` (createInTransaction's
    // reserve UPDATE), a session through the route only while it is `demo`
    // (checkTradingSessionStart; the CLI session-start does not read it).
    tradingMode: text('trading_mode').$type<TradeMode>().notNull().default(TradeMode.Demo),
    // The user's last analysis (#484, docs/mailing.md → The analysis reminder): when the bot
    // last showed the analysis card with a signal, of which pair and duration; all NULL after an
    // analysis with no signal. Written only by setLastAnalysis, from POST /trading/signal; read by
    // the analysis reminder's scenario.
    lastAnalysisAt: timestamp('last_analysis_at', { withTimezone: true }),
    lastAnalysisAssetId: integer('last_analysis_asset_id'),
    lastAnalysisDurationSec: integer('last_analysis_duration_sec'),
    tokenBalance: tokenAmount('token_balance'),
    tokenReserved: tokenAmount('token_reserved'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_telegram_user_id_idx').on(t.telegramUserId),
    inList('users_status_check', t.status, UserStatus),
    inList('users_notification_level_check', t.notificationLevel, NotificationLevel),
    inList('users_language_check', t.language, BotLanguage),
    inList('users_trading_mode_check', t.tradingMode, TradeMode),
    // The CHECK spells the same rule as startPayloadSchema, from the same regex source rather
    // than from a copy of it: PostgreSQL's POSIX engine and JavaScript's are not the same
    // engine, so the two verdicts are compared row by row over one corpus in
    // user-ops.db.test.ts.
    check(
      'users_acquisition_source_check',
      // `null ~ 'x'` is NULL, which a CHECK accepts, so the NULL case is spelled out
      sql`${t.acquisitionSource} is null or ${t.acquisitionSource} ~ ${sqlTextLiteral(START_PAYLOAD_PATTERN.source, 'START_PAYLOAD_PATTERN')}`,
    ),
    // the pair is one fact: a source with no time, or a time with no source, is a half-written row
    check(
      'users_acquisition_pair_check',
      sql`(${t.acquisitionSource} is null) = (${t.acquiredAt} is null)`,
    ),
    // one fact: all three or none. `is not null` is spelled out: `null > 0` is NULL, which a CHECK
    // accepts, so a half-written row would pass a bare `> 0`
    check(
      'users_last_analysis_check',
      sql`(${t.lastAnalysisAt} is null and ${t.lastAnalysisAssetId} is null
        and ${t.lastAnalysisDurationSec} is null)
        or (${t.lastAnalysisAt} is not null and ${t.lastAnalysisAssetId} is not null
          and ${t.lastAnalysisDurationSec} is not null and ${t.lastAnalysisAssetId} > 0
          and ${t.lastAnalysisDurationSec} > 0)`,
    ),
    nullablePositiveNumeric('users_demo_stake_check', t.demoStake),
    nullablePositiveNumeric('users_real_stake_check', t.realStake),
    check('users_token_balance_check', sql`${t.tokenBalance} >= 0`),
    check(
      'users_token_reserved_check',
      sql`${t.tokenReserved} >= 0 and ${t.tokenReserved} <= ${t.tokenBalance}`,
    ),
  ],
);
