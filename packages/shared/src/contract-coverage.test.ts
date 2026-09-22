import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  BinaryPair,
  BrokerError,
  BrokerUser,
  Candle,
  ChartRequest,
  ClosedTrade,
  OpenTrade,
  OpenTradeRequest,
} from './broker';
import type { DecimalString } from './money';
import type { OAuthTokens, WidgetSession, WidgetSessionRequest } from './oauth';
import type {
  PartnerErrorWire,
  PartnerPositions,
  PartnerRefLink,
  PartnerStats,
  PartnerTraderStats,
} from './partner';
import type { AssetsUpdate, PriceUpdate, SocketOpenTradeRequest } from './socket';
import type { TradeIntent } from './trading';
import * as broker from './broker';
import * as ids from './ids';
import * as shared from './index';
import * as money from './money';
import * as oauth from './oauth';
import * as partner from './partner';
import * as socket from './socket';
import * as time from './time';
import * as trading from './trading';

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
    expectTypeOf<OpenTrade['source']>().toEqualTypeOf<
      'api' | 'platform' | (string & {}) | undefined
    >();
    expectTypeOf<keyof OpenTradeRequest>().toEqualTypeOf<
      'assetId' | 'amount' | 'action' | 'durationSec' | 'isDemo'
    >();
    expectTypeOf<keyof SocketOpenTradeRequest>().toEqualTypeOf<
      'assetId' | 'amount' | 'action' | 'durationSec'
    >();
    expectTypeOf<keyof ChartRequest>().toEqualTypeOf<
      'assetId' | 'interval' | 'limit' | 'startTime'
    >();
    expectTypeOf<keyof BrokerError>().toEqualTypeOf<'message' | 'details'>();
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
    expectTypeOf<PartnerTraderStats['uid']>().toEqualTypeOf<string>();
    expectTypeOf<PartnerTraderStats['depositsCount']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PartnerErrorWire['code']>().toEqualTypeOf<number | string>();
    expectTypeOf<PartnerErrorWire['reason']>().toEqualTypeOf<string>();
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
    const modules = { money, time, ids, trading, broker, oauth, partner, socket };
    for (const [moduleName, module] of Object.entries(modules)) {
      for (const [key, value] of Object.entries(module)) {
        expect(shared, `${moduleName}.${key}`).toHaveProperty(key, value);
      }
    }
  });
});
