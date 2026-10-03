import { describe, expect, it } from 'vitest';
import { START_PAYLOAD_CORPUS } from './testing';
import {
  LANGUAGE_CODE_PATTERN,
  NotificationLevel,
  START_PAYLOAD_PATTERN,
  TelegramChatMemberStatus,
  UserStatus,
  languageCodeSchema,
  safeParseChatMemberRequest,
  safeParseChatMemberResponse,
  safeParseNotificationLevelRequest,
  safeParseNotificationLevelResponse,
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
  pendingBrokerAccounts: [],
  notificationLevel: NotificationLevel.All,
  ...patch,
});

const PENDING_ID = '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01';

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

// The three odd rows below pin the wording in users.ts, not a preference and not conformance:
// this pattern is an approximation of an IETF tag, so x- and i- tags are dropped and a lone
// singleton is kept. Narrowing it later has to change that comment, the docs and these rows.
describe('languageCodeSchema', () => {
  it.each(['ru', 'en-US', 'zh-Hant-TW', 'ast', 'en-a'])('accepts %s', (value) => {
    expect(languageCodeSchema.safeParse(value).success).toBe(true);
    expect(LANGUAGE_CODE_PATTERN.test(value)).toBe(true);
  });

  it.each([
    'r',
    'engl',
    'en_US',
    'русский',
    '',
    'en-',
    'x-private',
    'i-klingon',
    `en-${'a'.repeat(34)}`,
  ])('rejects %j', (value) => {
    expect(languageCodeSchema.safeParse(value).success).toBe(false);
  });
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

  it.each(Object.values(NotificationLevel))('carries notificationLevel %s', (notificationLevel) => {
    expect(safeParseUserStartResponse({ user: view({ notificationLevel }) })).toMatchObject({
      success: true,
      data: { user: { notificationLevel } },
    });
  });

  it('accepts pending accounts with and without an email', () => {
    const pendingBrokerAccounts = [
      { id: PENDING_ID, email: 'ada@example.test' },
      { id: PENDING_ID, email: null },
    ];
    expect(safeParseUserStartResponse({ user: view({ pendingBrokerAccounts }) })).toMatchObject({
      success: true,
      data: { user: { pendingBrokerAccounts } },
    });
  });

  it.each([
    ['the envelope is missing', { ...view() }],
    ['the status is unknown', { user: view({ status: 'pending' }) }],
    ['acquiredAt carries no offset', { user: view({ acquiredAt: '2026-09-24T10:00:00' }) }],
    [
      'hasActiveBrokerAccount is absent',
      { user: { ...view(), hasActiveBrokerAccount: undefined } },
    ],
    ['pendingBrokerAccounts is absent', { user: { ...view(), pendingBrokerAccounts: undefined } }],
    ['notificationLevel is absent', { user: { ...view(), notificationLevel: undefined } }],
    ['notificationLevel is unknown', { user: view({ notificationLevel: 'daily' }) }],
    [
      'a pending account id is not a uuid',
      { user: view({ pendingBrokerAccounts: [{ id: 'broker-1', email: null }] }) },
    ],
    [
      'a pending account has no email key',
      { user: view({ pendingBrokerAccounts: [{ id: PENDING_ID }] }) },
    ],
  ])('rejects a body where %s', (_label, body) => {
    expect(safeParseUserStartResponse(body).success).toBe(false);
  });
});

describe('chatMemberRequestSchema', () => {
  it.each(Object.values(TelegramChatMemberStatus))('accepts %s with a decimal id', (status) => {
    expect(safeParseChatMemberRequest({ telegramUserId: '12345', status })).toEqual({
      success: true,
      data: { telegramUserId: '12345', status },
    });
  });

  it.each([
    ['a status Telegram uses but the backend does not take', { status: 'left' }],
    ['a non-numeric telegram id', { telegramUserId: 'abc' }],
    ['a missing status', { status: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(
      safeParseChatMemberRequest({
        telegramUserId: '12345',
        status: TelegramChatMemberStatus.Kicked,
        ...patch,
      }).success,
    ).toBe(false);
  });

  it('ignores unknown keys', () => {
    const parsed = safeParseChatMemberRequest({
      telegramUserId: '12345',
      status: TelegramChatMemberStatus.Member,
      chatId: '1',
    });
    expect(parsed.success && parsed.data).not.toHaveProperty('chatId');
  });
});

describe('chatMemberResponseSchema', () => {
  it('accepts both answers and refuses a body without recorded', () => {
    expect(safeParseChatMemberResponse({ recorded: true }).success).toBe(true);
    expect(safeParseChatMemberResponse({ recorded: false }).success).toBe(true);
    expect(safeParseChatMemberResponse({}).success).toBe(false);
  });
});

describe('notificationLevelRequestSchema', () => {
  it.each(Object.values(NotificationLevel))('accepts %s with a decimal id', (level) => {
    expect(safeParseNotificationLevelRequest({ telegramUserId: '12345', level })).toEqual({
      success: true,
      data: { telegramUserId: '12345', level },
    });
  });

  it.each([
    ['an unknown level', { level: 'daily' }],
    ['a missing level', { level: undefined }],
    ['a non-numeric telegram id', { telegramUserId: 'abc' }],
  ])('rejects %s', (_label, patch) => {
    expect(
      safeParseNotificationLevelRequest({
        telegramUserId: '12345',
        level: NotificationLevel.Off,
        ...patch,
      }).success,
    ).toBe(false);
  });
});

describe('notificationLevelResponseSchema', () => {
  it('accepts a level and refuses a body without one or with an unknown one', () => {
    expect(safeParseNotificationLevelResponse({ level: NotificationLevel.Off }).success).toBe(true);
    expect(safeParseNotificationLevelResponse({}).success).toBe(false);
    expect(safeParseNotificationLevelResponse({ level: 'daily' }).success).toBe(false);
  });
});
