import { describe, expect, it } from 'vitest';
import {
  REFERRAL_CODE_LENGTH,
  REFERRAL_CODE_PATTERN,
  referralCodeOf,
  referralLinkOf,
  referralPayloadOf,
  userReferralRequestSchema,
  userReferralResponseSchema,
} from './referral';
import { START_PAYLOAD_PATTERN, UserStatus } from './users';

describe('referral payload', () => {
  it('round-trips a code through the payload', () => {
    expect(referralPayloadOf('AbC123xY')).toBe('ref_AbC123xY');
    expect(referralCodeOf(referralPayloadOf('AbC123xY'))).toBe('AbC123xY');
  });

  it('is a usable start payload, so first touch stores it as any other', () => {
    expect(START_PAYLOAD_PATTERN.test(referralPayloadOf('a'.repeat(REFERRAL_CODE_LENGTH)))).toBe(
      true,
    );
  });

  it.each([
    ['no payload', undefined],
    ['another payload', 'promo_AbC123xY'],
    ['a bare prefix', 'ref_'],
    ['a short code', 'ref_abc'],
    ['a long code', 'ref_abcdEFG1x'],
    ['a code with a dash', 'ref_abcd-FG1'],
    ['a code with an underscore', 'ref_abcd_FG1'],
    ['a prefix in another case', 'REF_AbC123xY'],
  ])('has no code in %s', (_label, payload) => {
    expect(referralCodeOf(payload)).toBeUndefined();
  });

  it('pins the code alphabet and length', () => {
    expect(REFERRAL_CODE_PATTERN.test('abcdEFG1')).toBe(true);
    expect(REFERRAL_CODE_PATTERN.test('abcdEFG')).toBe(false);
    expect(REFERRAL_CODE_PATTERN.test('abcdEFG12')).toBe(false);
  });

  it('builds the link Telegram opens with the payload', () => {
    expect(referralLinkOf('binarius_bot', 'AbC123xY')).toBe(
      'https://t.me/binarius_bot?start=ref_AbC123xY',
    );
  });
});

describe('POST /users/referral contract', () => {
  it('takes the Telegram id as a string of digits', () => {
    expect(userReferralRequestSchema.safeParse({ telegramUserId: '42' }).success).toBe(true);
    expect(userReferralRequestSchema.safeParse({ telegramUserId: 42 }).success).toBe(false);
    expect(userReferralRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an active user with a code and a blocked one without', () => {
    const ok = (user: unknown) => userReferralResponseSchema.safeParse({ user }).success;
    expect(ok({ status: UserStatus.Active, code: 'AbC123xY', invited: 0 })).toBe(true);
    expect(ok({ status: UserStatus.Blocked, code: null, invited: 3 })).toBe(true);
    expect(ok({ status: UserStatus.Active, code: 'short', invited: 0 })).toBe(false);
    expect(ok({ status: UserStatus.Active, code: null, invited: 0 })).toBe(false);
    expect(ok({ status: UserStatus.Blocked, code: 'AbC123xY', invited: 0 })).toBe(false);
    expect(ok({ status: UserStatus.Active, code: 'AbC123xY', invited: -1 })).toBe(false);
    expect(ok({ status: UserStatus.Active, code: 'AbC123xY', invited: 1.5 })).toBe(false);
  });
});
