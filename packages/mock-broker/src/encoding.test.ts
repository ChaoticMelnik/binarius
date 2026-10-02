import { decodeSocketPayload } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { assertSocketPayload, encodeSocketPayload, MockSocketPayload } from './encoding';

const value = { available: '10.00', list: [1, 'двa'], nested: { ok: true } };

describe('encodeSocketPayload', () => {
  it('produces each form', () => {
    expect(encodeSocketPayload(value, MockSocketPayload.Object)).toBe(value);
    expect(encodeSocketPayload(value, MockSocketPayload.Json)).toBe(JSON.stringify(value));
    const bytes = encodeSocketPayload(value, MockSocketPayload.Bytes);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(String(bytes)).toBe(JSON.stringify(value));
    expect(encodeSocketPayload(value, MockSocketPayload.Envelope)).toEqual({
      data: [...Buffer.from(JSON.stringify(value))],
    });
  });

  it.each(Object.values(MockSocketPayload))(
    '%s decodes back to the value; null stays null',
    (form) => {
      expect(decodeSocketPayload(encodeSocketPayload(value, form))).toEqual(value);
      expect(encodeSocketPayload(null, form)).toBeNull();
    },
  );
});

describe('assertSocketPayload', () => {
  it('accepts the four forms and refuses anything else', () => {
    for (const form of Object.values(MockSocketPayload)) {
      expect(() => assertSocketPayload(form)).not.toThrow();
    }
    expect(() => assertSocketPayload('buffer')).toThrow(RangeError);
    expect(() => assertSocketPayload(undefined)).toThrow(RangeError);
  });
});
