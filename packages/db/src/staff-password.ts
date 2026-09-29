import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt from node:crypto rather than argon2: `crypto.argon2` does not exist in Node 22.23.2,
// and every argon2 package is a native module, which this image builds without a toolchain.
//
// The parameters live in the stored string, not in this file, so a rotation is a new hash
// alongside the old ones rather than a migration: verifyPassword reads what each row was
// written with. These are what hashPassword writes today (~250 ms, 128 MiB per hash).
export const SCRYPT_PARAMS = { ln: 17, r: 8, p: 1 } as const;

export interface ScryptParams {
  /** log2 of the CPU/memory cost N */
  ln: number;
  r: number;
  p: number;
}

const ALGORITHM = 'scrypt';
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MIB = 1024 * 1024;

// Bounds on what a stored string may ask for, checked before any work is done: the row is
// trusted input today, but the cost of a hash is entirely in these three numbers, so a row
// that asked for ln=25 would be a way to spend the process rather than a way to log in.
const LN_RANGE = { min: 10, max: 17 } as const;
const R_RANGE = { min: 1, max: 8 } as const;
const P_RANGE = { min: 1, max: 2 } as const;

// `$scrypt$ln=17,r=8,p=1$<salt>$<hash>`, base64 without padding. Parsed strictly: anything
// this does not match is not a hash this module wrote.
const PHC_PATTERN =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

// Node refuses when approximately 128 * N * r exceeds maxmem (default 32 MiB), so it has to be
// raised deliberately. Derived from the parameters rather than fixed, plus a megabyte for
// scrypt's own working buffers: at the bounds above this is 257 MiB, and at the parameters
// hashPassword writes it is 129 MiB. The concurrency limit on top of it (apps/backend
// password-queue.ts) is what bounds the process, not this number.
const maxmemFor = ({ ln, r, p }: ScryptParams): number => 128 * 2 ** ln * r * p + MIB;

const b64 = (buffer: Buffer): string => buffer.toString('base64').replace(/=+$/, '');

const derive = (password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });

export async function hashPassword(
  password: string,
  params: ScryptParams = SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `$${ALGORITHM}$ln=${params.ln},r=${params.r},p=${params.p}$${b64(salt)}$${b64(key)}`;
}

const inRange = (value: number, { min, max }: { min: number; max: number }): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

// Answers only true or false: the caller must not be able to tell a malformed row, an
// out-of-range row and a wrong password apart, and neither must its timing at the resolutions
// a network exposes. A string that does not parse costs no derivation at all — that is the
// point of the ranges, not an optimisation.
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const match = PHC_PATTERN.exec(stored);
  if (match === null) return false;
  const [, ln, r, p, salt = '', expected = ''] = match;
  const params = { ln: Number(ln), r: Number(r), p: Number(p) };
  if (!inRange(params.ln, LN_RANGE) || !inRange(params.r, R_RANGE) || !inRange(params.p, P_RANGE)) {
    return false;
  }
  const expectedKey = Buffer.from(expected, 'base64');
  if (expectedKey.byteLength !== KEY_BYTES) return false;
  const key = await derive(password, Buffer.from(salt, 'base64'), params);
  // equal lengths by construction, but timingSafeEqual throws on a mismatch rather than
  // answering, and a throw here would be a crash on a malformed row
  return key.byteLength === expectedKey.byteLength && timingSafeEqual(key, expectedKey);
}

// A real hash of a password nobody holds, so an unknown login costs the same derivation a
// known one does. Committed rather than generated at import: generating it would cost 250 ms
// of startup, and it protects nothing — it exists to be run against, not to be kept secret.
export const DUMMY_PASSWORD_HASH =
  '$scrypt$ln=17,r=8,p=1$nS3x5rB0TaDDXe7CVR8FUA$P6MUa9G9jEUH5ilzJz1mOZAApkUOwCeTfOevrwhzGz0';

// The alphabet omits 0/O/1/l/I: a generated password is read off a terminal and typed into a
// browser once, and those five are where that goes wrong.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const GENERATED_PASSWORD_LENGTH = 24;

// 24 characters of a 57-character alphabet is about 140 bits. randomInt, not `% length`: a
// modulo of a random byte is biased towards the start of the alphabet.
export function generatePassword(): string {
  let password = '';
  for (let index = 0; index < GENERATED_PASSWORD_LENGTH; index += 1) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}
