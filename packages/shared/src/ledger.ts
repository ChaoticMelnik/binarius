import * as z from 'zod';

// Lives here rather than in packages/db, like UserStatus: the admin pages type a ledger row and
// build a filter from the values; packages/db builds the CHECKs from these same objects.
export const TokenLedgerKind = {
  Purchase: 'purchase',
  Bonus: 'bonus',
  Reserve: 'reserve',
  Release: 'release',
  Settle: 'settle',
  Adjustment: 'adjustment',
} as const;
export type TokenLedgerKind = (typeof TokenLedgerKind)[keyof typeof TokenLedgerKind];
export const tokenLedgerKindSchema = z.enum(TokenLedgerKind);

// Intents, deposits and broker accounts each have their own FK-checked column, so the polymorphic channel is
// left with exactly one member. A reference whose target the database can check is never
// expressed as a label here: a self-declared `ref_type` is not a control, which is how a
// relabelled row once credited one deposit twice.
export const TokenLedgerRefType = { Manual: 'manual' } as const;
export type TokenLedgerRefType = (typeof TokenLedgerRefType)[keyof typeof TokenLedgerRefType];
export const tokenLedgerRefTypeSchema = z.enum(TokenLedgerRefType);
