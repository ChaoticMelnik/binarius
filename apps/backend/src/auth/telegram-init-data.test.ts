import { describe, expect, it } from 'vitest';
import { INIT_DATA_MAX_LENGTH } from '@binarius/shared';
import { createInitDataVerifier, InitDataFailure } from './telegram-init-data';
import { signInitData } from './testing/init-data';

const TOKEN = '7000000001:AAvector-token-for-the-unit-test';
const MAX_AGE_MS = 660_000;
const AUTH_DATE = 1_700_000_000;
const NOW_MS = AUTH_DATE * 1000 + 5_000;
const USER_ID = 279_058_397;

const verifier = createInitDataVerifier({ botToken: TOKEN, maxAgeMs: MAX_AGE_MS });
const verify = (raw: string, nowMs = NOW_MS) => verifier.verify(raw, nowMs);
const sign = (options: Partial<Parameters<typeof signInitData>[0]> = {}) =>
  signInitData({ botToken: TOKEN, telegramUserId: USER_ID, authDate: AUTH_DATE, ...options });

// Signed outside this codebase (Python's hmac, values percent-encoded with %20 as Telegram does,
// a Cyrillic name, and the signature/chat_type fields this code never reads): the verifier and
// the test signer could agree on the same mistake, this string cannot.
const PYTHON_VECTOR =
  'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22%D0%90%D0%B4%D0%B0%20%D0%9B%D0%B0%D0%B2%22%2C%22username%22%3A%22ada%22%2C%22language_code%22%3A%22ru%22%2C%22photo_url%22%3A%22https%3A%2F%2Ft.me%2Fi%2Fuserpic%2F320%2Fx.svg%22%7D&auth_date=1700000000&signature=sig-value_123&chat_type=private&hash=8bc9d89b1777f83e374b3c247fd3169a8932317992558eb5cdc59baed877592e';

const replaceHash = (raw: string, hash: string | null): string => {
  const params = new URLSearchParams(raw);
  if (hash === null) params.delete('hash');
  else params.set('hash', hash);
  return params.toString();
};

describe('the Telegram initData verifier', () => {
  it('accepts initData Telegram signed and returns the user id', () => {
    expect(verify(PYTHON_VECTOR)).toEqual({ ok: true, telegramUserId: BigInt(USER_ID) });
  });

  it('accepts what the test signer produces, so the route tests run on the real check', () => {
    expect(verify(sign())).toEqual({ ok: true, telegramUserId: BigInt(USER_ID) });
  });

  it('signs every field, including the ones it never reads', () => {
    const raw = sign({ fields: { signature: 'abc', start_param: 'ref-1' } });
    expect(verify(raw).ok).toBe(true);
    const params = new URLSearchParams(raw);
    params.set('start_param', 'ref-2');
    expect(verify(params.toString())).toEqual({ ok: false, reason: InitDataFailure.BadSignature });
    const added = new URLSearchParams(raw);
    added.set('chat_type', 'private');
    expect(verify(added.toString())).toEqual({ ok: false, reason: InitDataFailure.BadSignature });
  });

  it('refuses a user swapped into signed initData', () => {
    const params = new URLSearchParams(PYTHON_VECTOR);
    params.set('user', JSON.stringify({ id: 42, first_name: 'Mallory' }));
    expect(verify(params.toString())).toEqual({ ok: false, reason: InitDataFailure.BadSignature });
  });

  it("refuses initData signed with another bot's token", () => {
    const raw = signInitData({
      botToken: '7000000002:AAanother-bot',
      telegramUserId: USER_ID,
      authDate: AUTH_DATE,
    });
    expect(verify(raw)).toEqual({ ok: false, reason: InitDataFailure.BadSignature });
  });

  it.each([
    ['63 characters', 'a'.repeat(63)],
    ['65 characters', 'a'.repeat(65)],
    ['not hex', 'g'.repeat(64)],
    ['upper-case hex', 'A'.repeat(64)],
    ['empty', ''],
  ])('refuses a hash of %s as malformed, without throwing', (_label, hash) => {
    expect(verify(replaceHash(sign(), hash))).toEqual({
      ok: false,
      reason: InitDataFailure.Malformed,
    });
  });

  it('refuses initData without a hash as malformed', () => {
    expect(verify(replaceHash(sign(), null))).toEqual({
      ok: false,
      reason: InitDataFailure.Malformed,
    });
  });

  it.each([
    ['', 'an empty string'],
    ['hash=' + 'a'.repeat(64), 'a hash alone'],
    ['not initData at all', 'free text'],
  ])('refuses %j (%s) as malformed', (raw) => {
    expect(verify(raw)).toEqual({ ok: false, reason: InitDataFailure.Malformed });
  });

  it.each(['user', 'auth_date'])('refuses signed initData without %s as malformed', (field) => {
    expect(verify(sign({ fields: { [field]: null } }))).toEqual({
      ok: false,
      reason: InitDataFailure.Malformed,
    });
  });

  it.each(['1700000000.5', '-1700000000', '1e9', 'soon'])(
    'refuses an auth_date of %s as malformed',
    (authDate) => {
      expect(verify(sign({ fields: { auth_date: authDate } }))).toEqual({
        ok: false,
        reason: InitDataFailure.Malformed,
      });
    },
  );

  it('refuses a repeated key as malformed rather than picking one copy', () => {
    const raw = sign();
    expect(verify(`${raw}&auth_date=${AUTH_DATE}`)).toEqual({
      ok: false,
      reason: InitDataFailure.Malformed,
    });
  });

  it.each([
    ['not JSON', '{id:1'],
    ['JSON null', 'null'],
    ['without an id', JSON.stringify({ first_name: 'Ada' })],
    ['an id of 0', JSON.stringify({ id: 0 })],
    ['a negative id', JSON.stringify({ id: -5 })],
    ['a string id', JSON.stringify({ id: String(USER_ID) })],
    ['a fractional id', JSON.stringify({ id: 1.5 })],
    ['an id of 2^53', `{"id":${2 ** 53}}`],
  ])('refuses a signed user that is %s', (_label, user) => {
    expect(verify(sign({ fields: { user } }))).toEqual({
      ok: false,
      reason: InitDataFailure.BadUser,
    });
  });

  it('accepts an id of 2^53 - 1, the largest that survives JSON.parse', () => {
    const user = `{"id":${Number.MAX_SAFE_INTEGER}}`;
    expect(verify(sign({ fields: { user } }))).toEqual({
      ok: true,
      telegramUserId: BigInt(Number.MAX_SAFE_INTEGER),
    });
  });

  it('accepts initData exactly as old as the limit and refuses it a millisecond later', () => {
    const raw = sign();
    expect(verify(raw, AUTH_DATE * 1000 + MAX_AGE_MS).ok).toBe(true);
    expect(verify(raw, AUTH_DATE * 1000 + MAX_AGE_MS + 1)).toEqual({
      ok: false,
      reason: InitDataFailure.Stale,
    });
  });

  it('checks the signature before the age: forged stale initData is a bad signature', () => {
    const forged = replaceHash(sign(), 'b'.repeat(64));
    expect(verify(forged, AUTH_DATE * 1000 + MAX_AGE_MS + 1)).toEqual({
      ok: false,
      reason: InitDataFailure.BadSignature,
    });
  });

  it('checks the age before the user: stale initData with a bad user is stale', () => {
    const raw = sign({ fields: { user: 'null' } });
    expect(verify(raw, AUTH_DATE * 1000 + MAX_AGE_MS + 1)).toEqual({
      ok: false,
      reason: InitDataFailure.Stale,
    });
  });

  it('accepts an auth_date ahead of this clock', () => {
    expect(verify(sign(), AUTH_DATE * 1000 - 3_600_000).ok).toBe(true);
  });

  it('reads + as a space and %2B as a plus, as Telegram encodes them', () => {
    const raw = sign({ user: { first_name: 'A+B C' } });
    expect(raw).toContain('A%2BB+C');
    expect(verify(raw).ok).toBe(true);
    // a page that re-encodes the plus as a raw + changes the signed value
    expect(verify(raw.replace('A%2BB', 'A+B')).ok).toBe(false);
  });

  it('accepts initData as long as the contract allows', () => {
    const base = sign({ user: { photo_url: '' } });
    const padding = INIT_DATA_MAX_LENGTH - base.length;
    const raw = sign({ user: { photo_url: 'x'.repeat(padding) } });
    expect(raw).toHaveLength(INIT_DATA_MAX_LENGTH);
    expect(verify(raw).ok).toBe(true);
  });
});
