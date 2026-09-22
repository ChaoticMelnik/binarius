import * as z from 'zod';

export const unixMsSchema = z.int().nonnegative();

export type UnixMs = z.infer<typeof unixMsSchema>;

// below this a Unix value cannot be milliseconds (that would be 1973); used only for sources
// whose unit is not confirmed — mappers for confirmed ms fields never call this
const SECONDS_THRESHOLD = 1e11;

export function normalizeUnixMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`not a Unix timestamp: ${value}`);
  }
  return value < SECONDS_THRESHOLD ? Math.round(value * 1000) : value;
}
