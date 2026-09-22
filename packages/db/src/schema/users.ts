import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, inList, updatedAt } from './columns';

export const UserStatus = { Active: 'active', Blocked: 'blocked' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

// token_balance / token_reserved are caches of token_ledger sums, updated in the same
// transaction as the ledger row; available tokens = token_balance - token_reserved
export const users = pgTable(
  'users',
  {
    id: id(),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull(),
    displayName: text('display_name'),
    languageCode: text('language_code'),
    status: text('status').$type<UserStatus>().notNull().default(UserStatus.Active),
    tokenBalance: bigint('token_balance', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    tokenReserved: bigint('token_reserved', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_telegram_user_id_idx').on(t.telegramUserId),
    inList('users_status_check', t.status, UserStatus),
    check('users_token_balance_check', sql`${t.tokenBalance} >= 0`),
    check(
      'users_token_reserved_check',
      sql`${t.tokenReserved} >= 0 and ${t.tokenReserved} <= ${t.tokenBalance}`,
    ),
  ],
);
