import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { NotificationLevel, START_PAYLOAD_PATTERN, TradeMode, UserStatus } from '@binarius/shared';
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
    // The user's demo stake (#297): NULL = the broker's minimum at each trade. Written only by
    // setDemoStake; its bounds are checked by checkDemoStake (@binarius/shared), not here.
    demoStake: money('demo_stake'),
    // The mode of the user's next single trade (#121, docs/trading-mode.md). Written only by
    // setTradingMode; a real intent is created only while it is `real` (createInTransaction's
    // reserve UPDATE), a session only while it is `demo` (checkTradingSessionStart).
    tradingMode: text('trading_mode').$type<TradeMode>().notNull().default(TradeMode.Demo),
    tokenBalance: tokenAmount('token_balance'),
    tokenReserved: tokenAmount('token_reserved'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_telegram_user_id_idx').on(t.telegramUserId),
    inList('users_status_check', t.status, UserStatus),
    inList('users_notification_level_check', t.notificationLevel, NotificationLevel),
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
    nullablePositiveNumeric('users_demo_stake_check', t.demoStake),
    check('users_token_balance_check', sql`${t.tokenBalance} >= 0`),
    check(
      'users_token_reserved_check',
      sql`${t.tokenReserved} >= 0 and ${t.tokenReserved} <= ${t.tokenBalance}`,
    ),
  ],
);
