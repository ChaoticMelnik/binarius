import { describe, expect, it } from 'vitest';
import {
  parseStarsInvoicePayload,
  STAR_PACKAGES,
  starPackageOf,
  STARS_PAYLOAD_MAX_BYTES,
  starsInvoicePayload,
  starsInvoiceResponseSchema,
  starsPaidRequestSchema,
  starsPaidResponseSchema,
  starsPreCheckoutRequestSchema,
  STAR_REFUND_REASON_MAX,
  starRefundReasonSchema,
} from './stars';

const USER_ID = '6c1f6a2e-3b7d-4c55-9a51-2f6b8e7d9a10';

// S10: the invoice payload has one format and one parser (#117, docs/stars.md)
describe('the Stars invoice payload', () => {
  it.each(STAR_PACKAGES.map((pack) => [pack.code]))(
    'round-trips the package %s and the user',
    (code) => {
      const payload = starsInvoicePayload(code, USER_ID);
      expect(parseStarsInvoicePayload(payload)).toEqual({ packageCode: code, userId: USER_ID });
    },
  );

  it('stays within the Bot API’s 128 bytes for the longest code the parser accepts', () => {
    const longest = `stars:${'z'.repeat(16)}:${USER_ID}`;
    expect(parseStarsInvoicePayload(longest)).toBeDefined();
    expect(new TextEncoder().encode(longest).length).toBeLessThanOrEqual(STARS_PAYLOAD_MAX_BYTES);
  });

  it('keeps an unknown package code, which the credit holds rather than the parser refuses', () => {
    expect(parseStarsInvoicePayload(`stars:p999:${USER_ID}`)).toEqual({
      packageCode: 'p999',
      userId: USER_ID,
    });
  });

  it.each([
    '',
    'stars',
    `stars::${USER_ID}`,
    `stars:p50:`,
    `stars:p50:${USER_ID}:x`,
    `stars:P50:${USER_ID}`,
    `stars:${'z'.repeat(17)}:${USER_ID}`,
    `stars:p50:${USER_ID.toUpperCase()}`,
    `stars:p50:${USER_ID.slice(1)}`,
    ` stars:p50:${USER_ID}`,
    `stars:p50:${USER_ID}\n`,
    `other:p50:${USER_ID}`,
  ])('refuses %j', (payload) => {
    expect(parseStarsInvoicePayload(payload)).toBeUndefined();
  });
});

describe('the packages', () => {
  it('are the owner’s three, each code unique and found by its code', () => {
    expect(STAR_PACKAGES.map((pack) => [pack.code, pack.tokens, pack.stars])).toEqual([
      ['p50', 50n, 100],
      ['p150', 150n, 250],
      ['p500', 500n, 750],
    ]);
    for (const pack of STAR_PACKAGES) expect(starPackageOf(pack.code)).toBe(pack);
    expect(starPackageOf('p999')).toBeUndefined();
  });
});

describe('the route schemas', () => {
  it('refuses an invoice answer whose payload the parser refuses', () => {
    const pack = { code: 'p50', tokens: '50', stars: 100 };
    expect(
      starsInvoiceResponseSchema.safeParse({
        payload: starsInvoicePayload('p50', USER_ID),
        package: pack,
      }).success,
    ).toBe(true);
    expect(
      starsInvoiceResponseSchema.safeParse({ payload: 'stars:p50:x', package: pack }).success,
    ).toBe(false);
  });

  it('bounds the payload Telegram returns by its bytes, not its characters', () => {
    const base = { telegramUserId: '4242', currency: 'XTR', totalAmount: 100 };
    expect(
      starsPreCheckoutRequestSchema.safeParse({ ...base, invoicePayload: 'я'.repeat(64) }).success,
    ).toBe(true);
    expect(
      starsPreCheckoutRequestSchema.safeParse({ ...base, invoicePayload: 'я'.repeat(65) }).success,
    ).toBe(false);
  });

  it('takes a charge id of 1-255 characters and a positive whole amount', () => {
    const paid = {
      telegramUserId: '4242',
      telegramPaymentChargeId: 'c',
      providerPaymentChargeId: null,
      invoicePayload: starsInvoicePayload('p50', USER_ID),
      currency: 'XTR',
      totalAmount: 100,
      paidAt: 1_790_000_000,
    };
    expect(starsPaidRequestSchema.safeParse(paid).success).toBe(true);
    for (const patch of [
      { telegramPaymentChargeId: '' },
      { telegramPaymentChargeId: 'c'.repeat(256) },
      { totalAmount: 0 },
      { totalAmount: 1.5 },
      { paidAt: 0 },
    ]) {
      expect(
        starsPaidRequestSchema.safeParse({ ...paid, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it('carries the numbers with a credit and none with a hold', () => {
    expect(
      starsPaidResponseSchema.safeParse({ outcome: 'credited', tokens: '50', balance: '57' })
        .success,
    ).toBe(true);
    expect(starsPaidResponseSchema.safeParse({ outcome: 'credited' }).success).toBe(false);
    expect(starsPaidResponseSchema.safeParse({ outcome: 'held' }).success).toBe(true);
  });
});

// #118: refunds
describe('the refund contracts', () => {
  it('takes a reason of 1-200 code points without control characters, trimmed', () => {
    expect(starRefundReasonSchema.parse('  просьба  ')).toBe('просьба');
    expect(starRefundReasonSchema.safeParse('я'.repeat(STAR_REFUND_REASON_MAX)).success).toBe(true);
    for (const bad of ['', '   ', 'я'.repeat(STAR_REFUND_REASON_MAX + 1), 'a\nb', 'a\tb']) {
      expect(starRefundReasonSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
