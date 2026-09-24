import { describe, expect, it } from 'vitest';
import { START_PAYLOAD_CORPUS } from './testing';
import {
  LANGUAGE_CODE_PATTERN,
  START_PAYLOAD_PATTERN,
  UserStatus,
  languageCodeSchema,
  safeParseUserStartRequest,
  safeParseUserStartResponse,
  startPayloadSchema,
  userStatusSchema,
} from './users';

const request = (patch: Record<string, unknown> = {}) => ({
  telegramUserId: '12345',
  displayName: 'Ada',
  ...patch,
});

const view = (patch: Record<string, unknown> = {}) => ({
  telegramUserId: '12345',
  status: UserStatus.Active,
  acquisitionSource: null,
  acquiredAt: null,
  hasActiveBrokerAccount: false,
  ...patch,
});

describe('userStatusSchema', () => {
  it('accepts the two members and nothing else', () => {
    expect(userStatusSchema.safeParse(UserStatus.Active).success).toBe(true);
    expect(userStatusSchema.safeParse(UserStatus.Blocked).success).toBe(true);
    expect(userStatusSchema.safeParse('pending').success).toBe(false);
  });
});

describe('startPayloadSchema', () => {
  // the same corpus the live CHECK is run against in packages/db/src/user-ops.db.test.ts
  it.each(START_PAYLOAD_CORPUS)('$label → $valid', ({ value, valid }) => {
    expect(startPayloadSchema.safeParse(value).success).toBe(valid);
    expect(START_PAYLOAD_PATTERN.test(value)).toBe(valid);
  });
});

describe('languageCodeSchema', () => {
  it.each(['ru', 'en-US', 'zh-Hant-TW', 'ast'])('accepts %s', (value) => {
    expect(languageCodeSchema.safeParse(value).success).toBe(true);
    expect(LANGUAGE_CODE_PATTERN.test(value)).toBe(true);
  });

  it.each(['r', 'engl', 'en_US', 'русский', '', 'en-', `en-${'a'.repeat(34)}`])(
    'rejects %j',
    (value) => {
      expect(languageCodeSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('userStartRequestSchema', () => {
  it('accepts the minimal request and both optional fields', () => {
    expect(safeParseUserStartRequest(request()).success).toBe(true);
    const full = safeParseUserStartRequest(
      request({ languageCode: 'en-US', startPayload: 'src_ab-CD9' }),
    );
    expect(full.success && full.data).toEqual({
      telegramUserId: '12345',
      displayName: 'Ada',
      languageCode: 'en-US',
      startPayload: 'src_ab-CD9',
    });
  });

  it('trims the display name before measuring it', () => {
    const parsed = safeParseUserStartRequest(request({ displayName: '  Ada Lovelace  ' }));
    expect(parsed.success && parsed.data.displayName).toBe('Ada Lovelace');
    expect(safeParseUserStartRequest(request({ displayName: '   ' })).success).toBe(false);
  });

  it.each([
    ['a missing telegram id', { telegramUserId: undefined }],
    ['a non-numeric telegram id', { telegramUserId: 'abc' }],
    ['a missing display name', { displayName: undefined }],
    ['a display name of 257 characters', { displayName: 'a'.repeat(257) }],
    ['a language code outside the pattern', { languageCode: 'en_US' }],
    ['a payload outside the pattern', { startPayload: 'a+b' }],
    ['a null payload instead of an absent one', { startPayload: null }],
  ])('rejects %s', (_label, patch) => {
    expect(safeParseUserStartRequest(request(patch)).success).toBe(false);
  });

  it('accepts a display name of exactly 256 characters', () => {
    expect(safeParseUserStartRequest(request({ displayName: 'a'.repeat(256) })).success).toBe(true);
  });

  it('ignores unknown keys, as the adjacent request schemas do', () => {
    const parsed = safeParseUserStartRequest(request({ isAdmin: true }));
    expect(parsed.success && parsed.data).not.toHaveProperty('isAdmin');
  });
});

describe('userStartResponseSchema', () => {
  it('accepts a view with and without attribution', () => {
    expect(safeParseUserStartResponse({ user: view() }).success).toBe(true);
    expect(
      safeParseUserStartResponse({
        user: view({
          status: UserStatus.Blocked,
          acquisitionSource: 'src_ab-CD9',
          acquiredAt: '2026-09-24T10:00:00.000Z',
          hasActiveBrokerAccount: true,
        }),
      }).success,
    ).toBe(true);
  });

  it.each([
    ['the envelope is missing', { ...view() }],
    ['the status is unknown', { user: view({ status: 'pending' }) }],
    ['acquiredAt carries no offset', { user: view({ acquiredAt: '2026-09-24T10:00:00' }) }],
    [
      'hasActiveBrokerAccount is absent',
      { user: { ...view(), hasActiveBrokerAccount: undefined } },
    ],
  ])('rejects a body where %s', (_label, body) => {
    expect(safeParseUserStartResponse(body).success).toBe(false);
  });
});
