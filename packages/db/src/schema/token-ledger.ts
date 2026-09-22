import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, inList, sqlLiteralList, tokenAmount } from './columns';
import { tradeIntents } from './trade-intents';
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

// Intent references live in intent_id, which is FK-checked; ref_type must not offer
// trade_intent, or a purchase row could carry an unchecked intent reference and bypass both
// the composite FK and the deposit uniqueness by mislabelling itself.
export const TokenLedgerRefType = {
  DepositEvent: 'deposit_event',
  Manual: 'manual',
} as const;
export type TokenLedgerRefType = (typeof TokenLedgerRefType)[keyof typeof TokenLedgerRefType];

export const INTENT_LEDGER_KINDS = [
  TokenLedgerKind.Reserve,
  TokenLedgerKind.Release,
  TokenLedgerKind.Settle,
] as const;

// Append-only (trigger in drizzle/0001_append_only.sql). Invariants:
// sum(balance_delta) = users.token_balance, sum(reserved_delta) = users.token_reserved.
// An intent gets at most one reserve row and at most one terminal (release | settle) row;
// "a terminal row implies a prior reserve" is an application invariant owned by ARCH-04,
// since the partial uniques give at-most-once, not at-least-once.
export const tokenLedger = pgTable(
  'token_ledger',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<TokenLedgerKind>().notNull(),
    balanceDelta: tokenAmount('balance_delta'),
    reservedDelta: tokenAmount('reserved_delta'),
    intentId: uuid('intent_id'),
    refType: text('ref_type').$type<TokenLedgerRefType>(),
    refId: uuid('ref_id'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    // the ledger row and the intent it settles must belong to the same user
    foreignKey({
      name: 'token_ledger_intent_owner_fk',
      columns: [t.intentId, t.userId],
      foreignColumns: [tradeIntents.id, tradeIntents.userId],
    }),
    inList('token_ledger_kind_check', t.kind, TokenLedgerKind),
    inList('token_ledger_ref_type_check', t.refType, TokenLedgerRefType),
    check('token_ledger_delta_check', sql`${t.balanceDelta} <> 0 or ${t.reservedDelta} <> 0`),
    check('token_ledger_ref_pair_check', sql`(${t.refType} is null) = (${t.refId} is null)`),
    check(
      'token_ledger_reference_check',
      sql`case when ${t.kind} in (${sqlLiteralList(INTENT_LEDGER_KINDS)})
            then ${t.intentId} is not null and ${t.refType} is null and ${t.refId} is null
            else ${t.intentId} is null
          end`,
    ),
    // each kind moves its deltas in the direction its name promises; settle leaves
    // balance_delta free because a settlement may raise, lower or preserve the balance
    check(
      'token_ledger_delta_shape_check',
      sql`case ${t.kind}
            when 'reserve' then ${t.reservedDelta} > 0 and ${t.balanceDelta} = 0
            when 'release' then ${t.reservedDelta} < 0 and ${t.balanceDelta} = 0
            when 'settle' then ${t.reservedDelta} < 0
            when 'purchase' then ${t.balanceDelta} > 0 and ${t.reservedDelta} = 0
            when 'bonus' then ${t.balanceDelta} > 0 and ${t.reservedDelta} = 0
            else true
          end`,
    ),
    uniqueIndex('token_ledger_reserve_intent_idx')
      .on(t.intentId)
      .where(sql`${t.kind} = 'reserve'`),
    uniqueIndex('token_ledger_terminal_intent_idx')
      .on(t.intentId)
      .where(sql`${t.kind} in ('release', 'settle')`),
    // one credit per deposit event; the deposit's existence and ownership stay with #12
    uniqueIndex('token_ledger_deposit_ref_idx')
      .on(t.refId)
      .where(sql`${t.refType} = 'deposit_event'`),
    index('token_ledger_user_created_idx').on(t.userId, t.createdAt),
    index('token_ledger_intent_id_idx').on(t.intentId),
    index('token_ledger_ref_id_idx').on(t.refId),
  ],
);
