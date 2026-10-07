import * as z from 'zod';

// Who wrote the current state of trading_switch (#144, docs/kill-switch.md). #96 appends
// circuit_breaker with its own migration, together with the CHECK that keeps it from opening.
export const TradingSwitchSource = {
  // the seed row of the migration that created the table
  Migration: 'migration',
  // the kill-switch CLI
  Operator: 'operator',
} as const;
export type TradingSwitchSource = (typeof TradingSwitchSource)[keyof typeof TradingSwitchSource];

// trading_switch_reason_length_check holds the same bound; char_length counts code points, so the
// shape below counts them too (the u flag), not UTF-16 units
export const TRADING_SWITCH_REASON_MAX = 200;

const REASON_SHAPE = new RegExp(`^[^\\p{Cc}]{1,${TRADING_SWITCH_REASON_MAX}}$`, 'u');

// The CHECK holds the length only; the content rule (no control characters) lives here, at the
// CLI boundary.
export const tradingSwitchReasonSchema = z
  .string()
  .trim()
  .regex(REASON_SHAPE, {
    error: `expected 1-${TRADING_SWITCH_REASON_MAX} characters without control characters`,
  });
