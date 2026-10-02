import { describe, expect, it } from 'vitest';
import {
  USER_ACCOUNT_LIST_LIMIT,
  isPendingLink,
  safeParseUserAccountRequest,
  safeParseUserAccountResponse,
  type LinkedAccountView,
} from './account';
import { BrokerAccountStatus } from './oauth';
import { UserStatus } from './users';

const PENDING_ID = '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01';

const response = (accounts: unknown[], status: string = UserStatus.Active) => ({
  user: { status, accounts },
});

describe('safeParseUserAccountRequest', () => {
  it('accepts a numeric telegram id', () => {
    expect(safeParseUserAccountRequest({ telegramUserId: '12345' }).success).toBe(true);
  });

  it.each([
    ['an empty body', {}],
    ['a non-numeric id', { telegramUserId: 'abc' }],
    ['a number instead of a string', { telegramUserId: 12345 }],
  ])('refuses %s', (_label, body) => {
    expect(safeParseUserAccountRequest(body).success).toBe(false);
  });
});

describe('safeParseUserAccountResponse', () => {
  it('accepts each member, with an address and without one', () => {
    const accounts = [
      { status: BrokerAccountStatus.Pending, id: PENDING_ID, email: 'new@example.test' },
      { status: BrokerAccountStatus.Pending, id: PENDING_ID, email: null },
      { status: BrokerAccountStatus.Active, email: 'ada@example.test' },
      { status: BrokerAccountStatus.Active, email: null },
      { status: BrokerAccountStatus.Revoked, email: 'old@example.test' },
      { status: BrokerAccountStatus.Revoked, email: null },
    ];
    const parsed = safeParseUserAccountResponse(response(accounts));
    expect(parsed.success && parsed.data.user.accounts).toEqual(accounts);
  });

  it('accepts a blocked user and an empty list', () => {
    const parsed = safeParseUserAccountResponse(response([], UserStatus.Blocked));
    expect(parsed.success && parsed.data.user).toEqual({
      status: UserStatus.Blocked,
      accounts: [],
    });
  });

  it.each([BrokerAccountStatus.Active, BrokerAccountStatus.Revoked])(
    'strips a stray id from a %s member',
    (status) => {
      const parsed = safeParseUserAccountResponse(
        response([{ status, id: PENDING_ID, email: 'ada@example.test' }]),
      );
      expect(parsed.success).toBe(true);
      expect(parsed.success && Object.keys(parsed.data.user.accounts[0] ?? {})).toEqual([
        'status',
        'email',
      ]);
    },
  );

  it.each([
    ['a pending member without an id', [{ status: BrokerAccountStatus.Pending, email: null }]],
    [
      'a pending member with an id that is not a uuid',
      [{ status: BrokerAccountStatus.Pending, id: 'x', email: null }],
    ],
    ['an unknown status', [{ status: 'halted', email: null }]],
    ['a member without email', [{ status: BrokerAccountStatus.Active }]],
  ])('refuses %s', (_label, accounts) => {
    expect(safeParseUserAccountResponse(response(accounts)).success).toBe(false);
  });

  it('refuses a body without accounts and an unknown user status', () => {
    expect(safeParseUserAccountResponse({ user: { status: UserStatus.Active } }).success).toBe(
      false,
    );
    expect(safeParseUserAccountResponse(response([], 'deleted')).success).toBe(false);
  });

  it(`holds at most ${USER_ACCOUNT_LIST_LIMIT} accounts`, () => {
    const active = { status: BrokerAccountStatus.Active, email: null };
    const atLimit = Array.from({ length: USER_ACCOUNT_LIST_LIMIT }, () => active);
    expect(safeParseUserAccountResponse(response(atLimit)).success).toBe(true);
    expect(safeParseUserAccountResponse(response([...atLimit, active])).success).toBe(false);
  });
});

describe('isPendingLink', () => {
  it.each<[LinkedAccountView, boolean]>([
    [{ status: BrokerAccountStatus.Pending, id: PENDING_ID, email: null }, true],
    [{ status: BrokerAccountStatus.Active, email: null }, false],
    [{ status: BrokerAccountStatus.Revoked, email: null }, false],
  ])('%o → %s', (account, expected) => {
    expect(isPendingLink(account)).toBe(expected);
  });
});
