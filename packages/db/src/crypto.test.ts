import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenCipherError, createTokenCipher, type TokenContext } from './crypto';

const key = randomBytes(32);
const cipher = createTokenCipher({ keyId: 'k1', key });

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const ctx: TokenContext = { accountId: ACCOUNT_A, field: 'access' };

describe('createTokenCipher', () => {
  it('round-trips a token', () => {
    const encrypted = cipher.encrypt('access-token-🔑', ctx);
    expect(cipher.decrypt(encrypted, ctx)).toBe('access-token-🔑');
    expect(encrypted.length).toBe(12 + 16 + Buffer.byteLength('access-token-🔑'));
  });

  it('uses a fresh IV per call', () => {
    const a = cipher.encrypt('same', ctx);
    const b = cipher.encrypt('same', ctx);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
  });

  it('accepts a view with a byte offset', () => {
    const encrypted = cipher.encrypt('offset', ctx);
    const padded = Buffer.concat([Buffer.from([1, 2, 3]), encrypted]);
    expect(cipher.decrypt(padded.subarray(3), ctx)).toBe('offset');
  });

  // the point of binding the context: a ciphertext moved to another row, or between the
  // access and refresh columns, must fail even though the key is unchanged
  it.each([
    ['another account', { accountId: ACCOUNT_B, field: 'access' } as TokenContext],
    ['the other column', { accountId: ACCOUNT_A, field: 'refresh' } as TokenContext],
  ])('rejects a ciphertext relocated to %s', (_label, otherContext) => {
    const encrypted = cipher.encrypt('secret', ctx);
    expect(() => cipher.decrypt(encrypted, otherContext)).toThrow(TokenCipherError);
  });

  it.each([
    ['a flipped ciphertext byte', (bytes: Buffer) => (bytes[bytes.length - 1] ^= 0x01)],
    ['a flipped tag byte', (bytes: Buffer) => (bytes[12] ^= 0x01)],
    ['a flipped IV byte', (bytes: Buffer) => (bytes[0] ^= 0x01)],
  ])('rejects %s', (_label, tamper) => {
    const bytes = cipher.encrypt('secret', ctx);
    tamper(bytes);
    expect(() => cipher.decrypt(bytes, ctx)).toThrow(TokenCipherError);
  });

  it('rejects a ciphertext from another key or another key id', () => {
    const encrypted = cipher.encrypt('secret', ctx);
    const otherKey = createTokenCipher({ keyId: 'k1', key: randomBytes(32) });
    const otherKeyId = createTokenCipher({ keyId: 'k2', key });
    expect(() => otherKey.decrypt(encrypted, ctx)).toThrow(TokenCipherError);
    expect(() => otherKeyId.decrypt(encrypted, ctx)).toThrow(TokenCipherError);
  });

  it('rejects a truncated ciphertext', () => {
    expect(() => cipher.decrypt(Buffer.alloc(27), ctx)).toThrow('too short');
  });

  it.each([
    ['a short key', { keyId: 'k1', key: randomBytes(16) }],
    ['an empty key id', { keyId: '', key }],
  ])('refuses %s at construction', (_label, options) => {
    expect(() => createTokenCipher(options)).toThrow(TokenCipherError);
  });

  it('refuses an empty account id', () => {
    expect(() => cipher.encrypt('secret', { accountId: '', field: 'access' })).toThrow(
      TokenCipherError,
    );
  });
});
