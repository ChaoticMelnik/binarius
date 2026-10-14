import { describe, expect, it } from 'vitest';
import {
  DepositErrorCode,
  safeParseDepositRefusal,
  safeParseDepositWidgetSessionRequest,
  safeParseDepositWidgetSessionResponse,
} from './deposit';
import { INIT_DATA_MAX_LENGTH } from './oauth';

describe('deposit widget-session request', () => {
  it('takes initData with an optional client IP', () => {
    expect(safeParseDepositWidgetSessionRequest({ initData: 'a=1' }).success).toBe(true);
    expect(
      safeParseDepositWidgetSessionRequest({ initData: 'a=1', clientIp: '203.0.113.7' }).success,
    ).toBe(true);
  });

  it.each([
    {},
    { initData: '' },
    { initData: 'x'.repeat(INIT_DATA_MAX_LENGTH + 1) },
    { initData: 'a=1', clientIp: '' },
    { initData: 'a=1', clientIp: 'x'.repeat(46) },
    // strict: a field the route does not read is refused, not ignored
    { initData: 'a=1', accountId: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01' },
  ])('refuses %j', (value) => {
    expect(safeParseDepositWidgetSessionRequest(value).success).toBe(false);
  });
});

describe('deposit widget-session response', () => {
  const ok = {
    session: 'wss_1',
    expiresInSec: 60,
    widgetUrl: 'https://binodex.app/embed/pay?mode=deposit&client_id=c',
    widgetOrigin: 'https://binodex.app',
  };

  it('accepts the allowlisted shape', () => {
    expect(safeParseDepositWidgetSessionResponse(ok).success).toBe(true);
  });

  it.each([
    { ...ok, widgetUrl: 'http://binodex.app/embed/pay' },
    { ...ok, widgetOrigin: 'javascript:alert(1)' },
    { ...ok, expiresInSec: 0 },
    { ...ok, region: 'ru' },
  ])('refuses %j', (value) => {
    expect(safeParseDepositWidgetSessionResponse(value).success).toBe(false);
  });
});

describe('deposit refusal', () => {
  it('names every code and nothing else', () => {
    for (const error of Object.values(DepositErrorCode)) {
      expect(safeParseDepositRefusal({ error }).success).toBe(true);
    }
    expect(safeParseDepositRefusal({ error: 'internal' }).success).toBe(false);
  });
});
