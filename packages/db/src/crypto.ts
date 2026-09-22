import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class TokenCipherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TokenCipherError';
  }
}

export const TokenField = { Access: 'access', Refresh: 'refresh' } as const;
export type TokenField = (typeof TokenField)[keyof typeof TokenField];

export interface TokenContext {
  /** the broker_accounts row the ciphertext belongs to */
  accountId: string;
  field: TokenField;
}

export interface TokenCipher {
  readonly keyId: string;
  encrypt(plaintext: string, context: TokenContext): Buffer;
  decrypt(ciphertext: Uint8Array, context: TokenContext): string;
}

// `|` cannot occur in a UUID or in either field name, so the concatenation is unambiguous
const aadFor = (keyId: string, { accountId, field }: TokenContext): Buffer =>
  Buffer.from(`${keyId}|${accountId}|${field}`, 'utf8');

// Ciphertext layout: iv(12) | tag(16) | data. Key id, account and column are bound as AAD, so a
// ciphertext cannot be replayed under another key after rotation, moved to another account's
// row, or swapped between the access and refresh columns — each of those fails authentication.
export function createTokenCipher(options: { keyId: string; key: Uint8Array }): TokenCipher {
  const { keyId, key } = options;
  if (key.byteLength !== KEY_LENGTH) {
    throw new TokenCipherError(`key must be ${KEY_LENGTH} bytes, got ${key.byteLength}`);
  }
  if (keyId.length === 0) throw new TokenCipherError('keyId must not be empty');

  return {
    keyId,
    encrypt(plaintext, context) {
      if (context.accountId.length === 0) {
        throw new TokenCipherError('context.accountId must not be empty');
      }
      // a fresh random IV per call is what makes GCM safe under one key
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(aadFor(keyId, context));
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(ciphertext, context) {
      const bytes = Buffer.from(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength);
      if (bytes.length < IV_LENGTH + TAG_LENGTH) {
        throw new TokenCipherError('ciphertext is too short');
      }
      const decipher = createDecipheriv(ALGORITHM, key, bytes.subarray(0, IV_LENGTH));
      decipher.setAAD(aadFor(keyId, context));
      decipher.setAuthTag(bytes.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
      try {
        return Buffer.concat([
          decipher.update(bytes.subarray(IV_LENGTH + TAG_LENGTH)),
          decipher.final(),
        ]).toString('utf8');
      } catch (cause) {
        throw new TokenCipherError('ciphertext authentication failed', { cause });
      }
    },
  };
}
