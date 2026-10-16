import * as z from 'zod';
import { NUMERIC_FRACTION_DIGITS, NUMERIC_INTEGER_DIGITS, decimalStringSchema } from './money';

// The versioned bonus rules (#13, docs/bonus-rules.md). Lives here rather than in packages/db,
// like TokenLedgerKind: packages/db builds the CHECKs from this object, the CLI parses against it.
export const BonusRuleKind = {
  // the starter pack a confirmed partner link earns (link-bonus-ops.ts)
  LinkBonus: 'link_bonus',
  // the inviter's reward (#116)
  ReferralReward: 'referral_reward',
  // a credit on a confirmed deposit (#386); no version exists until the owner creates one
  DepositBonus: 'deposit_bonus',
} as const;
export type BonusRuleKind = (typeof BonusRuleKind)[keyof typeof BonusRuleKind];
export const bonusRuleKindSchema = z.enum(BonusRuleKind);

export const isBonusRuleKind = (value: string): value is BonusRuleKind =>
  bonusRuleKindSchema.safeParse(value).success;

// A typo guard of the CLI, the same order as TOKEN_ADJUSTMENT_MAX_TOKENS; no CHECK holds it.
export const BONUS_RULE_TOKENS_MAX = 1000n;

// A decimal integer string, never a JSON number: the amount reaches bigint without a float.
const ruleTokensSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, { error: 'expected a positive whole number of tokens as a string' })
  .transform((value) => BigInt(value))
  .refine((value) => value <= BONUS_RULE_TOKENS_MAX, {
    error: `expected at most ${BONUS_RULE_TOKENS_MAX} tokens`,
  });

const fitsNumeric = (value: string) => {
  const [integer = '', fraction = ''] = value.split('.');
  return integer.length <= NUMERIC_INTEGER_DIGITS && fraction.length <= NUMERIC_FRACTION_DIGITS;
};
const nonNegativeDecimalSchema = decimalStringSchema.refine(
  (value) => !value.startsWith('-') && fitsNumeric(value),
  { error: 'expected a non-negative decimal with at most 12 integer and 8 fractional digits' },
);
const positiveDecimalSchema = nonNegativeDecimalSchema.refine((value) => /[1-9]/.test(value), {
  error: 'expected a positive decimal',
});

const fixedTokensParamsSchema = z.strictObject({ tokens: ruleTokensSchema });

// the shape #386 defines (owner, 2026-10-09); the formula over it is #386's
const depositBonusParamsSchema = z.strictObject({
  tokensPerUsd: positiveDecimalSchema,
  minAmountUsd: nonNegativeDecimalSchema,
  maxTokens: positiveDecimalSchema,
});

export const bonusRuleParamsSchemas = {
  [BonusRuleKind.LinkBonus]: fixedTokensParamsSchema,
  [BonusRuleKind.ReferralReward]: fixedTokensParamsSchema,
  [BonusRuleKind.DepositBonus]: depositBonusParamsSchema,
} satisfies Record<BonusRuleKind, z.ZodType>;

export type BonusRuleParams<K extends BonusRuleKind> = z.output<(typeof bonusRuleParamsSchemas)[K]>;

// undefined when the params do not fit their kind: no default, no partial value
export function parseBonusRuleParams<K extends BonusRuleKind>(
  kind: K,
  params: unknown,
): BonusRuleParams<K> | undefined {
  const parsed = bonusRuleParamsSchemas[kind].safeParse(params);
  return parsed.success ? (parsed.data as BonusRuleParams<K>) : undefined;
}

// the first problem, worded for the CLI's refusal line
export function bonusRuleParamsProblem(kind: BonusRuleKind, params: unknown): string | undefined {
  const parsed = bonusRuleParamsSchemas[kind].safeParse(params);
  if (parsed.success) return undefined;
  const [issue] = parsed.error.issues;
  if (issue === undefined) return 'invalid params';
  const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  return `${where}${issue.message}`;
}
