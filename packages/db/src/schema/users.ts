import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, inList, tokenAmount, updatedAt } from './columns';

export const UserStatus = { Active: 'active', Blocked: 'blocked' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

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
    tokenBalance: tokenAmount('token_balance'),
    tokenReserved: tokenAmount('token_reserved'),
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
