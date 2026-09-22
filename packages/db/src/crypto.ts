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

export interface TokenCipher {
  readonly keyId: string;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Uint8Array): string;
}

// Ciphertext layout: iv(12) | tag(16) | data. The key id is bound as AAD, so a ciphertext
// cannot be replayed under another key id after a rotation.
export function createTokenCipher(options: { keyId: string; key: Uint8Array }): TokenCipher {
  const { keyId, key } = options;
  if (key.byteLength !== KEY_LENGTH) {
    throw new TokenCipherError(`key must be ${KEY_LENGTH} bytes, got ${key.byteLength}`);
  }
  if (keyId.length === 0) throw new TokenCipherError('keyId must not be empty');
  const aad = Buffer.from(keyId, 'utf8');

  return {
    keyId,
    encrypt(plaintext) {
      // a fresh random IV per call is what makes GCM safe under one key
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(aad);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(ciphertext) {
      const bytes = Buffer.from(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength);
      if (bytes.length < IV_LENGTH + TAG_LENGTH) {
        throw new TokenCipherError('ciphertext is too short');
      }
      const decipher = createDecipheriv(ALGORITHM, key, bytes.subarray(0, IV_LENGTH));
      decipher.setAAD(aad);
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
