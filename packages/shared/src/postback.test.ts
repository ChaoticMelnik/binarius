import { describe, expect, it } from 'vitest';
import {
  POSTBACK_QUERY_MAX_KEYS,
  POSTBACK_QUERY_VALUE_MAX,
  POSTBACK_URL_SECRET_PATTERN,
  PostbackRejectReason,
  classifyPostback,
  postbackQuerySchema,
  postbackResponseSchema,
} from './postback';

const complete = {
  event: 'deposit',
  id: 'pb-1',
  payment_id: 'pay-1',
  a: '101962',
  amount: '10.50',
  coin: 'USD',
  sub_id: 'x',
};

describe('classifyPostback', () => {
  it('reads a complete Deposit delivery', () => {
    expect(classifyPostback(complete)).toEqual({
      kind: 'deposit',
      postbackId: 'pb-1',
      event: 'deposit',
      paymentId: 'pay-1',
      traderId: '101962',
      amount: '10.50',
      coin: 'USD',
    });
  });

  it('reads an FTD delivery without a coin', () => {
    const rest: Record<string, string> = { ...complete, event: 'ftd' };
    delete rest.coin;
    expect(classifyPostback(rest)).toEqual({
      kind: 'deposit',
      postbackId: 'pb-1',
      event: 'ftd',
      paymentId: 'pay-1',
      traderId: '101962',
      amount: '10.50',
    });
  });

  it.each([
    ['no id', { ...complete, id: undefined }, { reason: PostbackRejectReason.MissingPostbackId }],
    ['an empty id', { ...complete, id: '' }, { reason: PostbackRejectReason.MissingPostbackId }],
    [
      'no id and no event',
      { ...complete, id: undefined, event: undefined },
      { reason: PostbackRejectReason.MissingPostbackId },
    ],
    [
      'no event',
      { ...complete, event: undefined },
      { reason: PostbackRejectReason.UnknownEvent, postbackId: 'pb-1' },
    ],
    [
      'an unknown event',
      { ...complete, event: 'Deposit' },
      { reason: PostbackRejectReason.UnknownEvent, postbackId: 'pb-1' },
    ],
    [
      'no payment id and no trader',
      { ...complete, payment_id: undefined, a: undefined },
      { reason: PostbackRejectReason.MissingPaymentId, postbackId: 'pb-1', event: 'deposit' },
    ],
    [
      'no trader and a bad amount',
      { ...complete, a: '', amount: 'x' },
      { reason: PostbackRejectReason.MissingTraderId, postbackId: 'pb-1', event: 'deposit' },
    ],
    [
      'no amount',
      { ...complete, amount: undefined },
      { reason: PostbackRejectReason.InvalidAmount, postbackId: 'pb-1', event: 'deposit' },
    ],
  ])('refuses %s', (_name, query, expected) => {
    const defined = Object.fromEntries(
      Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    expect(classifyPostback(defined)).toEqual({ kind: 'rejected', ...expected });
  });

  it.each(['10', '10.50', '0.00000001', '999999999999.99999999'])(
    'accepts the amount %j',
    (amount) => {
      expect(classifyPostback({ ...complete, amount })).toMatchObject({ kind: 'deposit', amount });
    },
  );

  it.each(['0', '-1', '1e5', '1,000', '1000000000000', '1.000000001', ' 10'])(
    'refuses the amount %j',
    (amount) => {
      expect(classifyPostback({ ...complete, amount })).toMatchObject({
        kind: 'rejected',
        reason: PostbackRejectReason.InvalidAmount,
      });
    },
  );

  it('keeps a coin other than USD as delivered', () => {
    expect(classifyPostback({ ...complete, coin: 'EUR' })).toMatchObject({ coin: 'EUR' });
  });
});

describe('postbackQuerySchema', () => {
  it('accepts a flat map at the bounds', () => {
    const query = Object.fromEntries(
      Array.from({ length: POSTBACK_QUERY_MAX_KEYS }, (_, i) => [
        `k${i}`,
        'v'.repeat(POSTBACK_QUERY_VALUE_MAX),
      ]),
    );
    expect(postbackQuerySchema.safeParse(query).success).toBe(true);
  });

  it.each([
    ['an array value', { a: ['1', '2'] }],
    ['a value over the bound', { a: 'v'.repeat(POSTBACK_QUERY_VALUE_MAX + 1) }],
    ['a key over the bound', { ['k'.repeat(65)]: 'v' }],
    [
      'too many keys',
      Object.fromEntries(
        Array.from({ length: POSTBACK_QUERY_MAX_KEYS + 1 }, (_, i) => [`k${i}`, 'v']),
      ),
    ],
  ])('refuses %s', (_name, query) => {
    expect(postbackQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('POSTBACK_URL_SECRET_PATTERN', () => {
  it.each(['a'.repeat(32), 'A-z_9'.repeat(10), 'f'.repeat(128)])('accepts %j', (value) => {
    expect(POSTBACK_URL_SECRET_PATTERN.test(value)).toBe(true);
  });

  it.each([
    'a'.repeat(31),
    'f'.repeat(129),
    `${'a'.repeat(32)}/`,
    `${'a'.repeat(32)} `,
    `${'a'.repeat(31)}.`,
  ])('refuses %j', (value) => {
    expect(POSTBACK_URL_SECRET_PATTERN.test(value)).toBe(false);
  });
});

describe('postbackResponseSchema', () => {
  it('carries the outcome and an optional reason only', () => {
    expect(postbackResponseSchema.safeParse({ outcome: 'duplicate' }).success).toBe(true);
    expect(
      postbackResponseSchema.safeParse({ outcome: 'rejected', reason: 'invalid_amount' }).success,
    ).toBe(true);
    expect(
      postbackResponseSchema.safeParse({ outcome: 'recorded', depositEventId: 'x' }).success,
    ).toBe(false);
  });
});
