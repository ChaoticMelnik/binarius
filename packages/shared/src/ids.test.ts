import { describe, expect, it } from 'vitest';
import { idWireSchema, toId } from './ids';

describe('ids', () => {
  it.each([7, 0, 'u-1'])('accepts %j and normalizes it to a string', (value) => {
    expect(toId(idWireSchema.parse(value))).toBe(String(value));
  });

  it.each(['', 1.5, null, true])('rejects %j', (value) => {
    expect(idWireSchema.safeParse(value).success).toBe(false);
  });
});
