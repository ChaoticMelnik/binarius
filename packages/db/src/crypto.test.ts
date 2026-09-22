import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenCipherError, createTokenCipher } from './crypto';

const key = randomBytes(32);
const cipher = createTokenCipher({ keyId: 'k1', key });

describe('createTokenCipher', () => {
  it('round-trips a token', () => {
    const encrypted = cipher.encrypt('access-token-🔑');
    expect(cipher.decrypt(encrypted)).toBe('access-token-🔑');
    expect(encrypted.length).toBe(12 + 16 + Buffer.byteLength('access-token-🔑'));
  });

  it('uses a fresh IV per call', () => {
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
  });

  it('accepts a view with a byte offset', () => {
    const encrypted = cipher.encrypt('offset');
    const padded = Buffer.concat([Buffer.from([1, 2, 3]), encrypted]);
    expect(cipher.decrypt(padded.subarray(3))).toBe('offset');
  });

  it.each([
    ['a flipped ciphertext byte', (bytes: Buffer) => (bytes[bytes.length - 1] ^= 0x01)],
    ['a flipped tag byte', (bytes: Buffer) => (bytes[12] ^= 0x01)],
    ['a flipped IV byte', (bytes: Buffer) => (bytes[0] ^= 0x01)],
  ])('rejects %s', (_label, tamper) => {
    const bytes = cipher.encrypt('secret');
    tamper(bytes);
    expect(() => cipher.decrypt(bytes)).toThrow(TokenCipherError);
  });

  it('rejects a ciphertext from another key or another key id', () => {
    const encrypted = cipher.encrypt('secret');
    const otherKey = createTokenCipher({ keyId: 'k1', key: randomBytes(32) });
    const otherKeyId = createTokenCipher({ keyId: 'k2', key });
    expect(() => otherKey.decrypt(encrypted)).toThrow(TokenCipherError);
    expect(() => otherKeyId.decrypt(encrypted)).toThrow(TokenCipherError);
  });

  it('rejects a truncated ciphertext', () => {
    expect(() => cipher.decrypt(Buffer.alloc(27))).toThrow('too short');
  });

  it.each([
    ['a short key', { keyId: 'k1', key: randomBytes(16) }],
    ['an empty key id', { keyId: '', key }],
  ])('refuses %s at construction', (_label, options) => {
    expect(() => createTokenCipher(options)).toThrow(TokenCipherError);
  });
});
