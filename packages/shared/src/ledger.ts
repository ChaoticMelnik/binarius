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

// Moved from packages/db (#341) for the same reason: the deposits page filters by these values.
export const DepositEventStatus = {
  Received: 'received',
  Credited: 'credited',
  Ignored: 'ignored',
  Failed: 'failed',
} as const;
export type DepositEventStatus = (typeof DepositEventStatus)[keyof typeof DepositEventStatus];
export const depositEventStatusSchema = z.enum(DepositEventStatus);

// --- The manual token adjustment (#246) ---------------------------------------------------------

// A policy, not an integrity rule: no CHECK holds it, so changing the number needs no migration.
// The request schema and the writer (adjustTokens) both apply it through checkTokenAdjustment.
export const TOKEN_ADJUSTMENT_MAX_TOKENS = 1000n;
// In code points, as char_length and zod's max() count them; token_ledger_adjustment_note_check
// is built from this constant.
export const TOKEN_LEDGER_NOTE_MAX = 512;

export const TokenAdjustmentProblem = {
  Zero: 'zero',
  OverLimit: 'over_limit',
  NoteEmpty: 'note_empty',
  NoteTooLong: 'note_too_long',
  NoteControlChars: 'note_control_chars',
} as const;
export type TokenAdjustmentProblem =
  (typeof TokenAdjustmentProblem)[keyof typeof TokenAdjustmentProblem];

export function checkTokenDelta(delta: bigint): TokenAdjustmentProblem | null {
  if (delta === 0n) return TokenAdjustmentProblem.Zero;
  const magnitude = delta < 0n ? -delta : delta;
  return magnitude > TOKEN_ADJUSTMENT_MAX_TOKENS ? TokenAdjustmentProblem.OverLimit : null;
}

export function checkTokenNote(note: string): TokenAdjustmentProblem | null {
  if (note.trim() === '') return TokenAdjustmentProblem.NoteEmpty;
  if ([...note].length > TOKEN_LEDGER_NOTE_MAX) return TokenAdjustmentProblem.NoteTooLong;
  return /\p{C}/u.test(note) ? TokenAdjustmentProblem.NoteControlChars : null;
}

export const checkTokenAdjustment = (delta: bigint, note: string): TokenAdjustmentProblem | null =>
  checkTokenDelta(delta) ?? checkTokenNote(note);
