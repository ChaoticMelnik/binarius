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

const AAD_SEPARATOR = '|';

// The concatenation is only injective if no component can contain the separator: otherwise
// keyId='k|a' + accountId='b' and keyId='k' + accountId='a|b' produce identical AAD, and a
// ciphertext bound to one context would authenticate under another. `field` is a closed set,
// so only the two caller-supplied components need checking — and they are checked rather
// than assumed, because the assumption is what a comment can get wrong.
function assertAadComponent(value: string, name: string): void {
  if (value.length === 0) throw new TokenCipherError(`${name} must not be empty`);
  if (value.includes(AAD_SEPARATOR)) {
    throw new TokenCipherError(`${name} must not contain ${AAD_SEPARATOR}`);
  }
}

const aadFor = (keyId: string, { accountId, field }: TokenContext): Buffer =>
  Buffer.from([keyId, accountId, field].join(AAD_SEPARATOR), 'utf8');

// Ciphertext layout: iv(12) | tag(16) | data. Key id, account and column are bound as AAD, so a
// ciphertext cannot be replayed under another key after rotation, moved to another account's
// row, or swapped between the access and refresh columns — each of those fails authentication.
export function createTokenCipher(options: { keyId: string; key: Uint8Array }): TokenCipher {
  const { keyId, key } = options;
  if (key.byteLength !== KEY_LENGTH) {
    throw new TokenCipherError(`key must be ${KEY_LENGTH} bytes, got ${key.byteLength}`);
  }
  assertAadComponent(keyId, 'keyId');

  return {
    keyId,
    encrypt(plaintext, context) {
      assertAadComponent(context.accountId, 'context.accountId');
      // a fresh random IV per call is what makes GCM safe under one key
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(aadFor(keyId, context));
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(ciphertext, context) {
      // checked on this side too: a malformed context should say so, not surface as a
      // generic authentication failure the caller cannot distinguish from tampering
      assertAadComponent(context.accountId, 'context.accountId');
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
