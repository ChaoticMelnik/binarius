import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  BinaryPair,
  BrokerUser,
  Candle,
  ClosedTrade,
  OpenTrade,
  OpenTradeRequest,
} from './broker';
import type { DecimalString } from './money';
import type { OAuthTokens, WidgetSession, WidgetSessionRequest } from './oauth';
import type { PartnerPositions, PartnerRefLink, PartnerStats, PartnerTraderStats } from './partner';
import type { AssetsUpdate, PriceUpdate, SocketOpenTradeRequest } from './socket';
import type { TradeIntent } from './trading';
import * as shared from './index';

// every field issue #6 lists, on the domain type it belongs to
describe('contract coverage (issue #6)', () => {
  it('TradeIntent', () => {
    expectTypeOf<TradeIntent>().toEqualTypeOf<{
      id: string;
      brokerAccountId: string;
      telegramUserId: string;
      mode: 'demo' | 'real';
      assetId: number;
      amount: DecimalString;
      action: 'up' | 'down';
      durationSec: number;
      clientRequestId: string;
      createdAt: string;
    }>();
  });

  it('OAuth and widget session', () => {
    expectTypeOf<OAuthTokens>().toHaveProperty('accessToken');
    expectTypeOf<OAuthTokens>().toHaveProperty('refreshToken');
    expectTypeOf<OAuthTokens>().toHaveProperty('tokenType');
    expectTypeOf<OAuthTokens>().toHaveProperty('expiresInSec');
    expectTypeOf<OAuthTokens['user']>().toEqualTypeOf<{
      id: string;
      email: string;
      isPartnerClient: boolean;
    }>();
    expectTypeOf<WidgetSessionRequest>().toEqualTypeOf<{ origin: string; mode: 'demo' | 'real' }>();
    expectTypeOf<WidgetSession>().toEqualTypeOf<{ session: string; expiresInSec: number }>();
  });

  it('Broker trading DTOs', () => {
    expectTypeOf<keyof BinaryPair>().toEqualTypeOf<
      | 'id'
      | 'symbol'
      | 'isOtc'
      | 'type'
      | 'digits'
      | 'payout'
      | 'maxPayout'
      | 'minTimeframe'
      | 'maxTimeframe'
      | 'scheduledUntil'
    >();
    expectTypeOf<keyof BrokerUser>().toEqualTypeOf<
      'id' | 'level' | 'minTradeAmount' | 'real' | 'demo'
    >();
    expectTypeOf<BrokerUser['real']>().toEqualTypeOf<{
      available: DecimalString;
      held: DecimalString;
      total: DecimalString;
    }>();
    expectTypeOf<keyof Candle>().toEqualTypeOf<
      'timestamp' | 'open' | 'high' | 'low' | 'close' | 'volume'
    >();
    expectTypeOf<keyof OpenTrade>().toEqualTypeOf<
      | 'id'
      | 'assetId'
      | 'action'
      | 'amount'
      | 'payout'
      | 'potentialProfit'
      | 'openPrice'
      | 'openTimestamp'
      | 'isDemo'
      | 'source'
      | 'brokerClientId'
    >();
    expectTypeOf<keyof ClosedTrade>().toEqualTypeOf<
      | 'id'
      | 'assetId'
      | 'action'
      | 'amount'
      | 'payout'
      | 'openPrice'
      | 'openTimestamp'
      | 'isDemo'
      | 'source'
      | 'brokerClientId'
      | 'closePrice'
      | 'closeTimestamp'
      | 'profit'
    >();
    expectTypeOf<OpenTrade['amount']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<ClosedTrade['profit']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<keyof OpenTradeRequest>().toEqualTypeOf<
      'assetId' | 'amount' | 'action' | 'durationSec' | 'isDemo'
    >();
    expectTypeOf<keyof SocketOpenTradeRequest>().toEqualTypeOf<
      'assetId' | 'amount' | 'action' | 'durationSec'
    >();
  });

  it('Partner DTOs', () => {
    expectTypeOf<keyof PartnerStats>().toEqualTypeOf<
      | 'clicks'
      | 'registrations'
      | 'ftd'
      | 'depositsCount'
      | 'depositsCryptoCount'
      | 'depositsCardCount'
      | 'depositsCardRuCount'
    >();
    expectTypeOf<PartnerTraderStats['balance']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<keyof PartnerTraderStats>().toEqualTypeOf<
      | 'uid'
      | 'balance'
      | 'firstDeposit'
      | 'lastDeposit'
      | 'depositsCount'
      | 'depositsCryptoCount'
      | 'depositsCardCount'
      | 'depositsCardRuCount'
      | 'regRate'
      | 'lastActive'
      | 'deals'
      | 'country'
      | 'links'
    >();
    expectTypeOf<keyof PartnerRefLink>().toEqualTypeOf<'type' | 'region' | 'name' | 'url'>();
    expectTypeOf<PartnerPositions['binary'][number]['source']>().toEqualTypeOf<
      'manual' | 'ai' | 'copy' | 'broker'
    >();
    expectTypeOf<PartnerPositions['futures'][number]['source']>().toEqualTypeOf<
      'manual' | 'ai' | 'copy'
    >();
  });

  it('Socket payloads', () => {
    expectTypeOf<PriceUpdate>().toEqualTypeOf<{
      assetId: number;
      price: number;
      timestamp: number;
    }>();
    expectTypeOf<keyof AssetsUpdate>().toEqualTypeOf<'assetId' | 'payout' | 'scheduledUntil'>();
  });

  it('root index re-exports every module', () => {
    for (const name of [
      'decimalStringSchema',
      'normalizeUnixMs',
      'TradeIntentStatus',
      'parseBinaryPair',
      'parseOAuthTokenResponse',
      'parsePartnerStats',
      'decodeSocketPayload',
    ]) {
      expect(shared).toHaveProperty(name);
    }
  });
});
