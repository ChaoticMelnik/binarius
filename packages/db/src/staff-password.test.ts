import { scrypt } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DUMMY_PASSWORD_HASH,
  generatePassword,
  hashPassword,
  passwordVerifier,
  SCRYPT_PARAMS,
  verifyPassword,
  WRITTEN_SCRYPT_PARAMS,
} from './staff-password';

// The real scrypt, counted: whether a derivation ran is read off the call, not off the clock.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});
const derivations = vi.mocked(scrypt);

// Cheap parameters everywhere the test only needs a real hash; the cases about cost say so.
const CHEAP = { ln: 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';
const verifyCheap = passwordVerifier([CHEAP]);

// Well-formed field values. A malformed-string case built with a short key would be refused
// by the key-length check before the format was ever consulted, and would pass whatever the
// parser did — so every such case carries a salt and a key of the right size.
const b64 = (buffer: Buffer): string => buffer.toString('base64').replace(/=+$/, '');
const SALT = b64(Buffer.alloc(16, 1));
const KEY = b64(Buffer.alloc(32, 2));

describe('hashPassword', () => {
  it('writes the parameters it used into the string', async () => {
    const stored = await hashPassword(PASSWORD, CHEAP);
    expect(stored.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
    expect(stored.split('$')).toHaveLength(5);
  });

  it('salts: the same password twice is two different strings that both verify', async () => {
    const [first, second] = await Promise.all([
      hashPassword(PASSWORD, CHEAP),
      hashPassword(PASSWORD, CHEAP),
    ]);
    expect(first).not.toBe(second);
    expect(await verifyCheap(first, PASSWORD)).toBe(true);
    expect(await verifyCheap(second, PASSWORD)).toBe(true);
  });

  it('pins the parameters production writes', () => {
    expect(SCRYPT_PARAMS).toEqual({ ln: 17, r: 8, p: 1 });
  });

  it('writes a 16-byte salt and a 32-byte key as base64 without padding', async () => {
    const [, , , salt, key] = (await hashPassword(PASSWORD, CHEAP)).split('$');
    expect(salt).not.toContain('=');
    expect(key).not.toContain('=');
    expect(Buffer.from(salt ?? '', 'base64')).toHaveLength(16);
    expect(Buffer.from(key ?? '', 'base64')).toHaveLength(32);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and refuses a wrong one', async () => {
    const stored = await hashPassword(PASSWORD, CHEAP);
    expect(await verifyCheap(stored, PASSWORD)).toBe(true);
    expect(await verifyCheap(stored, `${PASSWORD} `)).toBe(false);
    expect(await verifyCheap(stored, '')).toBe(false);
  });

  it('pins the parameter sets production accepts to the one hashPassword writes', () => {
    expect(WRITTEN_SCRYPT_PARAMS).toEqual([SCRYPT_PARAMS]);
  });

  // One case at the production cost (~250 ms per derivation): the list holds the set
  // hashPassword writes by default in fact, not only by the equality of two objects.
  it('round-trips a hash written at the production cost', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(stored, PASSWORD)).toBe(true);
    expect(await verifyPassword(stored, `${PASSWORD} `)).toBe(false);
  });

  // The finding of #155: the fixtures' cost is cheaper than any row this module wrote in
  // production, so production refuses it — before any derivation — even with the right password.
  it('refuses a hash written at the fixture cost, without deriving anything', async () => {
    const stored = await hashPassword(PASSWORD, CHEAP);
    derivations.mockClear();
    expect(await verifyPassword(stored, PASSWORD)).toBe(false);
    expect(derivations).not.toHaveBeenCalled();
  });

  // The cost is not a constant in this file, it is whatever the row says. A set appended to
  // the accepted list at a rotation has to keep verifying, or a rotation would lock everyone out.
  it.each([
    { ln: 15, r: 8, p: 1 },
    { ln: 12, r: 1, p: 1 },
    { ln: 12, r: 8, p: 2 },
  ])('reads ln=$ln,r=$r,p=$p back out of the string', async (params) => {
    const stored = await hashPassword(PASSWORD, params);
    expect(stored).toContain(`ln=${params.ln},r=${params.r},p=${params.p}`);
    expect(await passwordVerifier([CHEAP, params])(stored, PASSWORD)).toBe(true);
  });

  // Not a formatting preference: the cost of a derivation is entirely in these numbers, and
  // node's scrypt does not refuse a large one — it computes the maxmem it needs from them and
  // then spends it (measured: ln=25 runs, it does not throw). So a row whose set is not in the
  // list is a way to choose its own cost, and the list is the only thing in the way.
  //
  // Each case is a hash this module really wrote at those parameters, checked with the right
  // password: the answer has to be `false` because the parameters are refused, and it would be
  // `true` for every one of them if the list were not consulted. A fabricated string would
  // answer `false` either way and prove nothing.
  it.each([
    ['ln cheaper than the list', { ln: 9, r: 8, p: 1 }],
    ['ln dearer than the list', { ln: 18, r: 8, p: 1 }],
    ['a set differing only in r', { ln: 10, r: 1, p: 1 }],
    ['a set differing only in p', { ln: 10, r: 8, p: 2 }],
  ])('refuses %s even when the password is right', async (_label, params) => {
    const stored = await hashPassword(PASSWORD, params);
    derivations.mockClear();
    expect(await verifyCheap(stored, PASSWORD)).toBe(false);
    expect(derivations).not.toHaveBeenCalled();
  });

  it('refuses to build a verifier from an empty list', () => {
    expect(() => passwordVerifier([])).toThrow(RangeError);
  });

  it.each([
    ['empty', ''],
    ['not a PHC string', 'hunter2'],
    ['another KDF', `$argon2id$v=19$m=65536,t=3,p=4$${SALT}$${KEY}`],
    ['no parameters', `$scrypt$$${SALT}$${KEY}`],
    ['missing the hash', `$scrypt$ln=10,r=8,p=1$${SALT}`],
    ['an extra field', `$scrypt$ln=10,r=8,p=1$${SALT}$${KEY}$x`],
    ['base64url instead of base64', `$scrypt$ln=10,r=8,p=1$-${SALT.slice(1)}$${KEY}`],
    ['trailing newline', `$scrypt$ln=10,r=8,p=1$${SALT}$${KEY}\n`],
  ])('refuses %s', async (_label, stored) => {
    expect(await verifyCheap(stored, PASSWORD)).toBe(false);
  });

  // A truncated row, not a password. Written at the parameters production uses, so the answer
  // has to come from the length rather than from a derivation nobody should have paid for.
  it('refuses a key that is not 32 bytes, without deriving anything', async () => {
    derivations.mockClear();
    expect(await verifyPassword(`$scrypt$ln=17,r=8,p=1$${SALT}$aGFzaA`, PASSWORD)).toBe(false);
    expect(derivations).not.toHaveBeenCalled();
  });
});

describe('DUMMY_PASSWORD_HASH', () => {
  // It exists to be derived against, so `false` is not enough to check: a malformed string
  // also answers false, in a millisecond, and would give the unknown-login path away by how
  // fast it came back. The derivation is what has to happen, so the case counts the scrypt
  // call, and the fields are checked to decode to the sizes this module writes. The parameters
  // are read off the call too, so the cost paid is the one the row asks for.
  it('is a hash this module really runs, and matches nothing anyone would type', async () => {
    const [, algorithm, params, salt = '', key = ''] = DUMMY_PASSWORD_HASH.split('$');
    expect([algorithm, params]).toEqual(['scrypt', 'ln=17,r=8,p=1']);
    expect(Buffer.from(salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);

    derivations.mockClear();
    expect(await verifyPassword(DUMMY_PASSWORD_HASH, PASSWORD)).toBe(false);
    expect(derivations).toHaveBeenCalledTimes(1);
    expect(derivations.mock.calls[0]?.[3]).toMatchObject({ N: 2 ** 17, r: 8, p: 1 });

    expect(await verifyPassword(DUMMY_PASSWORD_HASH, '')).toBe(false);
  });

  it('is written with the parameters production uses', () => {
    expect(DUMMY_PASSWORD_HASH).toContain(
      `ln=${SCRYPT_PARAMS.ln},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`,
    );
  });
});

describe('generatePassword', () => {
  it('is 24 characters of the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(24);
      expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    }
  });

  it('does not repeat itself', () => {
    const generated = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(generated.size).toBe(50);
  });
});
