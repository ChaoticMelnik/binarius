import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { START_PAYLOAD_PATTERN, UserStatus } from '@binarius/shared';
import { createdAt, id, inList, tokenAmount, updatedAt } from './columns';

// The CHECK spells the same rule as startPayloadSchema, from the same regex source rather than
// from a copy of it: PostgreSQL's POSIX engine and JavaScript's are not the same engine, so the
// two verdicts are compared row by row over one corpus in user-ops.db.test.ts. Inlined because a
// bound parameter would not survive drizzle-kit's DDL serialization; the guard keeps that safe.
const startPayloadCheckSql = (): ReturnType<typeof sql.raw> => {
  const pattern = START_PAYLOAD_PATTERN.source;
  if (/['\\]/.test(pattern)) {
    throw new Error(`START_PAYLOAD_PATTERN is not inlinable as a SQL literal: ${pattern}`);
  }
  return sql.raw(`'${pattern}'`);
};

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
    tokenBalance: tokenAmount('token_balance'),
    tokenReserved: tokenAmount('token_reserved'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_telegram_user_id_idx').on(t.telegramUserId),
    inList('users_status_check', t.status, UserStatus),
    check(
      'users_acquisition_source_check',
      // `null ~ 'x'` is NULL, which a CHECK accepts, so the NULL case is spelled out
      sql`${t.acquisitionSource} is null or ${t.acquisitionSource} ~ ${startPayloadCheckSql()}`,
    ),
    // the pair is one fact: a source with no time, or a time with no source, is a half-written row
    check(
      'users_acquisition_pair_check',
      sql`(${t.acquisitionSource} is null) = (${t.acquiredAt} is null)`,
    ),
    check('users_token_balance_check', sql`${t.tokenBalance} >= 0`),
    check(
      'users_token_reserved_check',
      sql`${t.tokenReserved} >= 0 and ${t.tokenReserved} <= ${t.tokenBalance}`,
    ),
  ],
);
