import { describe, expect, it } from 'vitest';
import { normalizeUnixMs, unixMsSchema } from './time';

describe('unixMsSchema', () => {
  it.each([0, 1, 1790028496624])('accepts %d', (value) => {
    expect(unixMsSchema.parse(value)).toBe(value);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1790028496624'])(
    'rejects %j',
    (value) => {
      expect(unixMsSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('normalizeUnixMs', () => {
  it('keeps millisecond values', () => {
    expect(normalizeUnixMs(1790028496624)).toBe(1790028496624);
  });

  it('scales second values', () => {
    expect(normalizeUnixMs(1790028496)).toBe(1790028496000);
  });

  it('treats the threshold itself as milliseconds', () => {
    expect(normalizeUnixMs(1e11)).toBe(1e11);
    expect(normalizeUnixMs(1e11 - 1)).toBe((1e11 - 1) * 1000);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %j', (value) => {
    expect(() => normalizeUnixMs(value)).toThrow(RangeError);
  });
});
