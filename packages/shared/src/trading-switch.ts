import * as z from 'zod';

// Who wrote the current state of trading_switch (#144, docs/kill-switch.md).
export const TradingSwitchSource = {
  // the seed row of the migration that created the table
  Migration: 'migration',
  // the kill-switch CLI
  Operator: 'operator',
  // the worker's circuit breaker (#96): it only ever closes, and
  // trading_switch_open_source_check refuses an open row with this source
  CircuitBreaker: 'circuit_breaker',
} as const;
export type TradingSwitchSource = (typeof TradingSwitchSource)[keyof typeof TradingSwitchSource];

// the sources that may leave trading open: the seed and the operator, never an automatic closer
export const TRADING_SWITCH_OPENING_SOURCES = [
  TradingSwitchSource.Migration,
  TradingSwitchSource.Operator,
] as const;

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
