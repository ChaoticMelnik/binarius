import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, inList } from './columns';
import { users } from './users';

export const TokenLedgerKind = {
  Purchase: 'purchase',
  Bonus: 'bonus',
  Reserve: 'reserve',
  Release: 'release',
  Settle: 'settle',
  Adjustment: 'adjustment',
} as const;
export type TokenLedgerKind = (typeof TokenLedgerKind)[keyof typeof TokenLedgerKind];

export const TokenLedgerRefType = {
  TradeIntent: 'trade_intent',
  DepositEvent: 'deposit_event',
  Manual: 'manual',
} as const;
export type TokenLedgerRefType = (typeof TokenLedgerRefType)[keyof typeof TokenLedgerRefType];

// Append-only (trigger in drizzle/0001_append_only.sql). Invariants:
// sum(balance_delta) = users.token_balance, sum(reserved_delta) = users.token_reserved.
// An intent gets at most one reserve row and at most one terminal (release | settle) row.
export const tokenLedger = pgTable(
  'token_ledger',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<TokenLedgerKind>().notNull(),
    balanceDelta: bigint('balance_delta', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    reservedDelta: bigint('reserved_delta', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    refType: text('ref_type').$type<TokenLedgerRefType>(),
    refId: uuid('ref_id'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    inList('token_ledger_kind_check', t.kind, TokenLedgerKind),
    inList('token_ledger_ref_type_check', t.refType, TokenLedgerRefType),
    check('token_ledger_delta_check', sql`${t.balanceDelta} <> 0 or ${t.reservedDelta} <> 0`),
    check('token_ledger_ref_pair_check', sql`(${t.refType} is null) = (${t.refId} is null)`),
    check(
      'token_ledger_intent_ref_check',
      sql`${t.kind} not in ('reserve', 'release', 'settle') or (${t.refType} = 'trade_intent' and ${t.refId} is not null)`,
    ),
    uniqueIndex('token_ledger_reserve_ref_idx')
      .on(t.refId)
      .where(sql`${t.kind} = 'reserve'`),
    uniqueIndex('token_ledger_terminal_ref_idx')
      .on(t.refId)
      .where(sql`${t.kind} in ('release', 'settle')`),
    index('token_ledger_user_created_idx').on(t.userId, t.createdAt),
    index('token_ledger_ref_id_idx').on(t.refId),
  ],
);
