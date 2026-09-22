import { describe, expect, it } from 'vitest';
import {
  parsePartnerError,
  parsePartnerPositions,
  parsePartnerRefLinks,
  parsePartnerStats,
  parsePartnerTraderStats,
  safeParsePartnerPositions,
  safeParsePartnerStats,
  safeParsePartnerTraderStats,
} from './partner';

const envelope = <T>(data: T) => ({ code: 200, message: 'ok', data });

const statsWire = {
  clicks: 10,
  registrations: 3,
  FTD: 1,
  depositsCount: 2,
  depositsCryptoCount: 1,
  depositsCardCount: 1,
  depositsCardRuCount: 0,
  unexpected: 'kept',
};

const traderWire = {
  uid: 'tr-1',
  balance: '125.40',
  firstDeposit: { type: 'card', at: '2026-09-01' },
  lastDeposit: null,
  depositsCount: 2,
  depositsCryptoCount: 1,
  depositsCardCount: 1,
  depositsCardRuCount: 0,
  country: 'DE',
};

describe('Partner stats', () => {
  it('maps the counters and renames FTD', () => {
    expect(parsePartnerStats(envelope(statsWire))).toEqual({
      clicks: 10,
      registrations: 3,
      ftd: 1,
      depositsCount: 2,
      depositsCryptoCount: 1,
      depositsCardCount: 1,
      depositsCardRuCount: 0,
    });
  });

  it('accepts a string envelope code', () => {
    expect(safeParsePartnerStats({ ...envelope(statsWire), code: '200' }).success).toBe(true);
  });

  it.each([
    ['clicks', '10'],
    ['depositsCardRuCount', undefined],
    ['FTD', 1.5],
  ])('rejects %s=%j', (field, value) => {
    expect(safeParsePartnerStats(envelope({ ...statsWire, [field]: value })).success).toBe(false);
  });
});

describe('Partner trader stats', () => {
  it('keeps balance as a decimal string and preserves absent vs null deposit marks', () => {
    const stats = parsePartnerTraderStats(envelope(traderWire));
    expect(stats).toEqual({
      uid: 'tr-1',
      balance: '125.40',
      firstDeposit: { type: 'card', at: '2026-09-01' },
      lastDeposit: null,
      depositsCount: 2,
      depositsCryptoCount: 1,
      depositsCardCount: 1,
      depositsCardRuCount: 0,
      country: 'DE',
    });
    expect(stats).not.toHaveProperty('links');
  });

  it('rejects a numeric balance', () => {
    expect(safeParsePartnerTraderStats(envelope({ ...traderWire, balance: 125.4 })).success).toBe(
      false,
    );
  });

  it('normalizes a numeric uid to a string and rejects an empty one', () => {
    expect(parsePartnerTraderStats(envelope({ ...traderWire, uid: 42 })).uid).toBe('42');
    expect(safeParsePartnerTraderStats(envelope({ ...traderWire, uid: '' })).success).toBe(false);
  });

  it('tolerates absent deposit counters', () => {
    const stats = parsePartnerTraderStats(
      envelope({ uid: 'tr-1', balance: '125.40', firstDeposit: null }),
    );
    expect(stats).toEqual({ uid: 'tr-1', balance: '125.40', firstDeposit: null });
  });
});

describe('Partner ref links and positions', () => {
  it('maps ref links', () => {
    expect(
      parsePartnerRefLinks(envelope([{ type: 'default', region: 'eu', name: 'main', url: 'u' }])),
    ).toEqual([{ type: 'default', region: 'eu', name: 'main', url: 'u' }]);
  });

  it('keeps the two source unions separate', () => {
    expect(
      parsePartnerPositions(
        envelope({ binary: [{ source: 'broker', id: 1 }], futures: [{ source: 'copy' }] }),
      ),
    ).toEqual({ binary: [{ source: 'broker' }], futures: [{ source: 'copy' }] });
    expect(
      safeParsePartnerPositions(envelope({ binary: [], futures: [{ source: 'broker' }] })).success,
    ).toBe(false);
  });

  it('parses the error envelope', () => {
    expect(parsePartnerError({ code: 401, message: 'denied', reason: 'bad token' })).toMatchObject({
      reason: 'bad token',
    });
  });
});
