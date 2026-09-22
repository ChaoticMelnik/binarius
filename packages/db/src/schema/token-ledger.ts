import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, inList, sqlLiteralList, tokenAmount } from './columns';
import { depositEvents } from './deposit-events';
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

// Intents and deposits each have their own FK-checked column, so the polymorphic channel is
// left with exactly one member. A reference whose target the database can check is never
// expressed as a label here: a self-declared `ref_type` is not a control, which is how a
// relabelled row once credited one deposit twice.
export const TokenLedgerRefType = { Manual: 'manual' } as const;
export type TokenLedgerRefType = (typeof TokenLedgerRefType)[keyof typeof TokenLedgerRefType];

export const INTENT_LEDGER_KINDS = [
  TokenLedgerKind.Reserve,
  TokenLedgerKind.Release,
  TokenLedgerKind.Settle,
] as const;

export const TERMINAL_LEDGER_KINDS = [TokenLedgerKind.Release, TokenLedgerKind.Settle] as const;

// every kind comparison below goes through this: a bare 'purchase' in a CASE arm keeps
// compiling after the constant is renamed while silently matching nothing, which would drop
// the row into `else` and invert the rule the arm exists to state
const kind = (value: TokenLedgerKind) => sqlLiteralList([value]);

// Append-only (trigger in drizzle/0001_append_only.sql). Invariants:
// sum(balance_delta) = users.token_balance, sum(reserved_delta) = users.token_reserved.
// An intent gets at most one reserve row and at most one terminal (release | settle) row;
// "a terminal row implies a prior reserve" is an application invariant owned by ARCH-04,
// since the partial uniques give at-most-once, not at-least-once.
//
// Dedupe keys by kind: reserve/release/settle are keyed by intent, purchase and a
// deposit-linked bonus by (deposit, kind). A bonus that names no deposit — a promo — has
// NO database-level dedupe key, and #13 must bring one when it defines those; an
// `adjustment` is a deliberate manual act and carries `note` instead. The ledger is not
// self-protecting for those two.
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
    depositEventId: uuid('deposit_event_id'),
    refType: text('ref_type').$type<TokenLedgerRefType>(),
    refId: uuid('ref_id'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    // both references are composite: proving the target exists is not enough, it must belong
    // to the same user, or one user's ledger row could move another user's money
    foreignKey({
      name: 'token_ledger_intent_owner_fk',
      columns: [t.intentId, t.userId],
      foreignColumns: [tradeIntents.id, tradeIntents.userId],
    }),
    foreignKey({
      name: 'token_ledger_deposit_owner_fk',
      columns: [t.depositEventId, t.userId],
      foreignColumns: [depositEvents.id, depositEvents.userId],
    }),
    inList('token_ledger_kind_check', t.kind, TokenLedgerKind),
    inList('token_ledger_ref_type_check', t.refType, TokenLedgerRefType),
    check('token_ledger_delta_check', sql`${t.balanceDelta} <> 0 or ${t.reservedDelta} <> 0`),
    check('token_ledger_ref_pair_check', sql`(${t.refType} is null) = (${t.refId} is null)`),
    // exactly which reference each kind may carry, and no kind may carry two
    check(
      'token_ledger_reference_check',
      sql`case
            when ${t.kind} in (${sqlLiteralList(INTENT_LEDGER_KINDS)})
              then ${t.intentId} is not null and ${t.depositEventId} is null and ${t.refId} is null
            when ${t.kind} = ${kind(TokenLedgerKind.Purchase)}
              then ${t.depositEventId} is not null and ${t.intentId} is null and ${t.refId} is null
            when ${t.kind} = ${kind(TokenLedgerKind.Bonus)}
              then ${t.intentId} is null and ${t.refId} is null
            else ${t.intentId} is null and ${t.depositEventId} is null
          end`,
    ),
    // each kind moves its deltas in the direction its name promises; settle leaves
    // balance_delta free because a settlement may raise, lower or preserve the balance
    check(
      'token_ledger_delta_shape_check',
      sql`case ${t.kind}
            when ${kind(TokenLedgerKind.Reserve)} then ${t.reservedDelta} > 0 and ${t.balanceDelta} = 0
            when ${kind(TokenLedgerKind.Release)} then ${t.reservedDelta} < 0 and ${t.balanceDelta} = 0
            when ${kind(TokenLedgerKind.Settle)} then ${t.reservedDelta} < 0
            when ${kind(TokenLedgerKind.Purchase)} then ${t.balanceDelta} > 0 and ${t.reservedDelta} = 0
            when ${kind(TokenLedgerKind.Bonus)} then ${t.balanceDelta} > 0 and ${t.reservedDelta} = 0
            else true
          end`,
    ),
    uniqueIndex('token_ledger_reserve_intent_idx')
      .on(t.intentId)
      .where(sql`${t.kind} = ${kind(TokenLedgerKind.Reserve)}`),
    uniqueIndex('token_ledger_terminal_intent_idx')
      .on(t.intentId)
      .where(sql`${t.kind} in (${sqlLiteralList(TERMINAL_LEDGER_KINDS)})`),
    // One row per deposit PER KIND: a deposit admits one purchase and one deposit-linked
    // bonus. Keying on deposit alone would let whichever came first take the only slot and
    // block the other permanently, on a table nothing can delete from.
    // The predicate is index scoping, not semantics — a unique index treats NULLs as
    // distinct, so rows without a deposit never conflict either way.
    uniqueIndex('token_ledger_deposit_event_idx')
      .on(t.depositEventId, t.kind)
      .where(sql`${t.depositEventId} is not null`),
    index('token_ledger_user_created_idx').on(t.userId, t.createdAt),
    index('token_ledger_intent_id_idx').on(t.intentId),
  ],
);
