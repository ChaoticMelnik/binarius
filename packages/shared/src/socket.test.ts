import { describe, expect, it } from 'vitest';
import {
  BrokerSocketEvent,
  MAX_PRICE_SUBSCRIPTION_ASSETS,
  SocketPayloadDecodeError,
  decodeSocketPayload,
  modeEvent,
  parseAssetsUpdate,
  parseCloseTradeSuccess,
  parseOpenTradeFail,
  parsePriceUpdate,
  parseUserData,
  priceSubscribeWireSchema,
  safeDecodeSocketPayload,
  safeParseAssetsUpdate,
  safeParsePriceUpdate,
  socketOpenTradeRequestWireSchema,
  toSocketOpenTradeRequestWire,
  userAuthWireSchema,
} from './socket';
import type { DecimalString } from './money';

describe('event names', () => {
  it('builds mode-scoped names for both modes', () => {
    expect(modeEvent('demo', 'open_trade')).toBe('user.demo.open_trade');
    expect(modeEvent('real', 'open_trade.fail')).toBe('user.real.open_trade.fail');
    expect(modeEvent('real', 'update_balance')).toBe('user.real.update_balance');
  });

  it('keeps the fixed names from #8', () => {
    expect(BrokerSocketEvent).toEqual({
      UserAuth: 'user.auth',
      UserAuthSuccess: 'user.auth.success',
      UserAuthError: 'user.auth.error',
      UserDisconnectTokenExpired: 'user.disconnect_token_expired',
      PriceSubscribe: 'price.subscribe',
      PriceUpdate: 'price.update',
      CommonAssetsList: 'common.assets_list',
      CommonAssetsUpdate: 'common.assets_update',
      UserData: 'user.data',
    });
  });
});

describe('client → server payloads', () => {
  it('limits price subscriptions to 40 assets', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(priceSubscribeWireSchema.safeParse({ assets: ids(40) }).success).toBe(true);
    expect(priceSubscribeWireSchema.safeParse({ assets: ids(41) }).success).toBe(false);
    expect(priceSubscribeWireSchema.safeParse({ assets: [] }).success).toBe(false);
    expect(MAX_PRICE_SUBSCRIPTION_ASSETS).toBe(40);
  });

  it('encodes the socket open-trade body without is_demo', () => {
    const wire = toSocketOpenTradeRequestWire({
      assetId: 91,
      amount: '10.00' as DecimalString,
      action: 'down',
      durationSec: 60,
    });
    expect(wire).toEqual({ asset_id: 91, amount: '10.00', action: 'down', duration: 60 });
    expect(socketOpenTradeRequestWireSchema.safeParse({ ...wire, is_demo: true }).success).toBe(
      true,
    );
    expect(Object.keys(wire)).not.toContain('is_demo');
  });

  it('validates the auth handshake', () => {
    expect(userAuthWireSchema.safeParse({ id: 7, token: 't' }).success).toBe(true);
    expect(userAuthWireSchema.safeParse({ id: 'u', token: '' }).success).toBe(false);
  });
});

describe('server → client payloads', () => {
  it('parses price updates with at least three elements', () => {
    expect(parsePriceUpdate([91, 1.08765, 1790028496624])).toEqual({
      assetId: 91,
      price: 1.08765,
      timestamp: 1790028496624,
    });
    expect(safeParsePriceUpdate([91, 1.08765, 1790028496624, 'extra']).success).toBe(true);
    expect(safeParsePriceUpdate([91, 1.08765]).success).toBe(false);
  });

  it.each([
    [
      { asset_id: 91, payout: 80 },
      { assetId: 91, payout: 80 },
    ],
    [
      { id: 91, scheduled_until: 0 },
      { assetId: 91, scheduledUntil: 0 },
    ],
    [{ asset_id: 91, id: 91 }, { assetId: 91 }],
  ])('parses assets_update %j', (wire, domain) => {
    expect(parseAssetsUpdate(wire)).toEqual(domain);
  });

  it.each([{ payout: 80 }, { asset_id: 91, id: 92 }])('rejects assets_update %j', (wire) => {
    expect(safeParseAssetsUpdate(wire).success).toBe(false);
  });

  it('parses open_trade.fail as an array, including empty', () => {
    expect(
      parseOpenTradeFail([{ message: 'too small', field: 'amount' }, { message: 'x' }]),
    ).toEqual([{ message: 'too small', field: 'amount' }, { message: 'x' }]);
    expect(parseOpenTradeFail([])).toEqual([]);
  });

  it('parses close_trade.success and user.data', () => {
    const trade = {
      id: 1,
      asset_id: 91,
      action: 'up',
      amount: '10.00',
      payout: 85,
      open_price: 1.1,
      open_timestamp: 1790028496624,
      is_demo: true,
      close_price: 1.2,
      close_timestamp: 1790028556624,
      profit: '8.50',
    };
    expect(parseCloseTradeSuccess({ trades: [trade] })).toHaveLength(1);
    const balance = { available: '1.00', held: '0', total: '1.00' };
    expect(
      parseUserData({
        id: 1,
        level: { code: 'c', rank: 0 },
        min_trade_amount: '1',
        real: balance,
        demo: balance,
      }).id,
    ).toBe('1');
  });
});

describe('decodeSocketPayload', () => {
  const json = '{"a":1}';
  const bytes = new TextEncoder().encode(json);

  it.each([
    ['JSON string', json],
    ['ArrayBuffer', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)],
    ['Uint8Array', bytes],
    ['byte envelope', { data: Array.from(bytes) }],
    ['already decoded', { a: 1 }],
  ])('decodes a %s', (_label, raw) => {
    expect(decodeSocketPayload(raw)).toEqual({ a: 1 });
  });

  it('respects a typed-array view offset', () => {
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 2);
    const view = new Uint8Array(padded.buffer, 2, bytes.length);
    expect(decodeSocketPayload(view)).toEqual({ a: 1 });
  });

  it('passes arrays and primitives through', () => {
    expect(decodeSocketPayload([1, 2])).toEqual([1, 2]);
    expect(decodeSocketPayload(5)).toBe(5);
  });

  it.each([
    ['malformed JSON', '{"a":'],
    ['non-byte envelope values', { data: [300, -1] }],
    ['invalid UTF-8', new Uint8Array([0xff, 0xfe])],
  ])('throws SocketPayloadDecodeError on %s', (_label, raw) => {
    expect(() => decodeSocketPayload(raw)).toThrow(SocketPayloadDecodeError);
    const result = safeDecodeSocketPayload(raw);
    expect(result.ok).toBe(false);
  });

  it('safe variant returns the value', () => {
    expect(safeDecodeSocketPayload(json)).toEqual({ ok: true, value: { a: 1 } });
  });
});
