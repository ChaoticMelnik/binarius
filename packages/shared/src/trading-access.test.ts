import { describe, expect, it } from 'vitest';
import { safeParseTradingAccessRequest, safeParseTradingAccessResponse } from './trading-access';
import { UserStatus } from './users';

const body = (tokens: Record<string, unknown>, status: unknown = UserStatus.Active) => ({
  status,
  tokens,
  broker: null,
  brokerUnavailable: 'no_account',
  tradingOpen: false,
});

const view = {
  real: { available: '100.00000000', held: '0.00000000', total: '100.00000000' },
  demo: { available: '10000.00000000', held: '0.00000000', total: '10000.00000000' },
  minTradeAmount: '1.00000000',
  level: { code: 'standard', rank: 1 },
  restSnapshotAgeSec: 3,
  balanceEventAgeSec: null,
  fresh: true,
};

const canonical = { balance: '7', reserved: '2', available: '5' };

describe('safeParseTradingAccessRequest', () => {
  it('accepts a numeric telegram id', () => {
    expect(safeParseTradingAccessRequest({ telegramUserId: '12345' }).success).toBe(true);
  });

  it('accepts a broker account id', () => {
    const input = {
      telegramUserId: '12345',
      brokerAccountId: '0b8f3c62-7a1e-4d2b-9a55-3c1f2e4d5a6b',
    };
    const parsed = safeParseTradingAccessRequest(input);
    expect(parsed.success && parsed.data).toEqual(input);
  });

  it.each([
    ['an empty body', {}],
    ['a broker account id that is not a uuid', { telegramUserId: '1', brokerAccountId: 'abc' }],
    ['a non-numeric id', { telegramUserId: 'abc' }],
    ['a number instead of a string', { telegramUserId: 12345 }],
    ['an id above int8', { telegramUserId: '9223372036854775808' }],
    ['a non-object body', 'telegramUserId=1'],
  ])('refuses %s', (_label, input) => {
    expect(safeParseTradingAccessRequest(input).success).toBe(false);
  });
});

describe('safeParseTradingAccessResponse', () => {
  it('accepts the canonical body', () => {
    const parsed = safeParseTradingAccessResponse(body(canonical));
    expect(parsed.success && parsed.data).toEqual(body(canonical));
  });

  it('accepts a blocked user with their numbers', () => {
    expect(safeParseTradingAccessResponse(body(canonical, UserStatus.Blocked)).success).toBe(true);
  });

  it.each([
    ['all zero', { balance: '0', reserved: '0', available: '0' }],
    ['everything reserved', { balance: '3', reserved: '3', available: '0' }],
    [
      'int8-scale values',
      { balance: '9223372036854775807', reserved: '7', available: '9223372036854775800' },
    ],
  ])('accepts %s', (_label, tokens) => {
    expect(safeParseTradingAccessResponse(body(tokens)).success).toBe(true);
  });

  it('refuses available that is not balance - reserved', () => {
    const parsed = safeParseTradingAccessResponse(body({ ...canonical, available: '7' }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'available must equal balance - reserved',
    ]);
  });

  // a field that fails its own check must never reach BigInt() in the refine
  it.each([
    ['a signed balance', { ...canonical, balance: '-7' }],
    ['a fractional reserved', { ...canonical, reserved: '2.5' }],
    ['an empty available', { ...canonical, available: '' }],
    ['a numeric balance', { ...canonical, balance: 7 }],
    ['a non-numeric reserved', { ...canonical, reserved: 'abc' }],
  ])('refuses %s without a throw', (_label, tokens) => {
    expect(() => safeParseTradingAccessResponse(body(tokens))).not.toThrow();
    expect(safeParseTradingAccessResponse(body(tokens)).success).toBe(false);
  });

  it.each(['balance', 'reserved', 'available'])('refuses a missing %s', (key) => {
    const tokens: Record<string, unknown> = { ...canonical };
    delete tokens[key];
    expect(safeParseTradingAccessResponse(body(tokens)).success).toBe(false);
  });

  it('refuses a missing tokens object', () => {
    expect(safeParseTradingAccessResponse({ status: UserStatus.Active }).success).toBe(false);
  });

  it('refuses a status outside UserStatus', () => {
    expect(safeParseTradingAccessResponse(body(canonical, 'deleted')).success).toBe(false);
  });

  it('strips unknown keys', () => {
    const parsed = safeParseTradingAccessResponse({
      ...body({ ...canonical, ledger: [] }),
      telegramUserId: '1',
    });
    expect(parsed.success && parsed.data).toEqual(body(canonical));
  });
});

describe('the broker section', () => {
  const tokens = canonical;

  it('accepts a snapshot with no reason', () => {
    const input = {
      status: UserStatus.Active,
      tokens,
      broker: view,
      brokerUnavailable: null,
      tradingOpen: false,
    };
    const parsed = safeParseTradingAccessResponse(input);
    expect(parsed.success && parsed.data).toEqual(input);
  });

  it.each([
    ['both null', { broker: null, brokerUnavailable: null }],
    ['a snapshot and a reason', { broker: view, brokerUnavailable: 'refreshing' }],
  ])('refuses %s', (_label, section) => {
    const parsed = safeParseTradingAccessResponse({
      status: UserStatus.Active,
      tokens,
      tradingOpen: false,
      ...section,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a reason outside the list', () => {
    const input = { ...body(tokens), brokerUnavailable: 'timeout' };
    expect(safeParseTradingAccessResponse(input).success).toBe(false);
  });

  it('strips unknown keys of the snapshot', () => {
    const parsed = safeParseTradingAccessResponse({
      status: UserStatus.Active,
      tokens,
      broker: { ...view, brokerAccountId: 'x', lastRefreshError: 'unavailable' },
      brokerUnavailable: null,
      tradingOpen: false,
    });
    expect(parsed.success && parsed.data.broker).toEqual(view);
  });
});

describe('tradingOpen', () => {
  it('accepts true', () => {
    const input = { ...body(canonical), tradingOpen: true };
    const parsed = safeParseTradingAccessResponse(input);
    expect(parsed.success && parsed.data).toEqual(input);
  });

  it('refuses a body without it', () => {
    const input: Record<string, unknown> = body(canonical);
    delete input.tradingOpen;
    expect(safeParseTradingAccessResponse(input).success).toBe(false);
  });

  it('refuses the string false', () => {
    const input = { ...body(canonical), tradingOpen: 'false' };
    expect(safeParseTradingAccessResponse(input).success).toBe(false);
  });
});
