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
import type { BrokerBalanceView } from './broker-balance';
import type { PairsCatalogView, PairView } from './catalog';
import type { DecimalString } from './money';
import type { OAuthTokens, RefreshedTokens, WidgetSession, WidgetSessionRequest } from './oauth';
import type {
  PartnerErrorWire,
  PartnerPositions,
  PartnerRefLink,
  PartnerStats,
  PartnerTraderStats,
} from './partner';
import type { AssetsUpdate, PriceUpdate, SocketOpenTradeRequest } from './socket';
import type {
  SignalParams,
  TradingSignalErrorCode,
  TradingSignalResponse,
  TradingSignalsResponse,
} from './signal';
import type { TradeIntent, TradeIntentView } from './trading';
import type { AccessTokenRefusal, AccessTokenRequest, AccessTokenResponse } from './access-token';
import type { AccountHaltReason } from './oauth';
import type { TradingAccessResponse } from './trading-access';
import type { TradingSessionRefusal, TradingSessionView } from './trading-session';
import * as accessToken from './access-token';
import * as account from './account';
import * as admin from './admin';
import * as adminTrading from './admin-trading';
import * as adminBotTexts from './admin-bot-texts';
import * as broker from './broker';
import * as botTextTemplate from './bot-text-template';
import * as botTexts from './bot-texts';
import * as botTextFormat from './bot-text-format';
import * as botTextMessages from './bot-text-messages';
import * as botTextVars from './bot-text-vars';
import * as botTextOverrides from './bot-text-overrides';
import * as brokerBalance from './broker-balance';
import * as audit from './audit';
import * as brokerBudget from './broker-budget';
import * as catalog from './catalog';
import * as demoStake from './demo-stake';
import * as env from './env';
import * as ids from './ids';
import * as ledger from './ledger';
import * as linkConfirmation from './link-confirmation';
import * as logging from './logging';
import * as shared from './index';
import * as money from './money';
import * as oauth from './oauth';
import * as partner from './partner';
import * as processModule from './process';
import * as signal from './signal';
import * as socket from './socket';
import * as telegramHtml from './telegram-html';
import * as time from './time';
import * as trading from './trading';
import * as tradingAccess from './trading-access';
import * as tradingSession from './trading-session';
import * as users from './users';

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

  it('TradeIntentView (issue #42)', () => {
    expectTypeOf<TradeIntentView>().toEqualTypeOf<{
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
      status:
        | 'planned'
        | 'reserved'
        | 'queued'
        | 'submitting'
        | 'accepted'
        | 'settled'
        | 'rejected'
        | 'unknown'
        | 'reconciling'
        | 'manual_review';
      version: number;
      tokensReserved: string;
      transport: 'socket' | 'rest_fallback' | null;
      submittedAt: string | null;
      lastError:
        | 'expired'
        | 'executor_not_configured'
        | 'executor_timeout'
        | 'executor_error'
        | 'broker_rejected'
        | 'publish_failed'
        | 'stale_submitting'
        | 'invalid_job'
        | 'processing_failed'
        | 'trading_paused'
        | 'trade_mismatch'
        | 'manual_rejected'
        | 'reconciliation_not_found'
        | 'reconciliation_ambiguous'
        | 'broker_unavailable'
        | 'demo_only'
        | null;
      updatedAt: string;
    }>();
  });

  it('TradingAccessResponse (issue #136)', () => {
    expectTypeOf<TradingAccessResponse>().toEqualTypeOf<{
      status: 'active' | 'blocked';
      tokens: { balance: string; reserved: string; available: string };
      broker: BrokerBalanceView | null;
      brokerUnavailable:
        | 'no_account'
        | 'ambiguous_account'
        | 'account_pending'
        | 'account_revoked'
        | 'user_blocked'
        | 'refreshing'
        | 'broker_unavailable'
        | null;
      tradingOpen: boolean;
      demoStake: DecimalString | null;
    }>();
  });

  it('access token route and halt reason (issue #90)', () => {
    expectTypeOf<AccessTokenRequest>().toEqualTypeOf<{
      mayRefresh: boolean;
      refusedToken?: string | undefined;
    }>();
    expectTypeOf<AccessTokenResponse>().toEqualTypeOf<{ accessToken: string }>();
    expectTypeOf<AccessTokenRefusal>().toEqualTypeOf<
      | 'account_not_found'
      | 'user_blocked'
      | 'account_pending'
      | 'account_revoked'
      | 'key_unavailable'
      | 'refresh_needed'
      | 'refresh_rate_limited'
    >();
    expectTypeOf<AccountHaltReason>().toEqualTypeOf<
      'reconciliation_ambiguous' | 'reconciliation_not_found' | 'trade_mismatch'
    >();
  });

  it('BrokerBalanceView (issue #137)', () => {
    expectTypeOf<BrokerBalanceView>().toEqualTypeOf<{
      real: { available: DecimalString; held: DecimalString; total: DecimalString };
      demo: { available: DecimalString; held: DecimalString; total: DecimalString };
      minTradeAmount: DecimalString;
      level: { code: string; rank: number };
      restSnapshotAgeSec: number;
      balanceEventAgeSec: number | null;
      fresh: boolean;
    }>();
  });

  it('OAuth and widget session', () => {
    expectTypeOf<OAuthTokens>().toHaveProperty('accessToken');
    expectTypeOf<OAuthTokens>().toHaveProperty('refreshToken');
    expectTypeOf<OAuthTokens>().toHaveProperty('tokenType');
    expectTypeOf<OAuthTokens>().toHaveProperty('expiresInSec');
    expectTypeOf<OAuthTokens['user']>().toEqualTypeOf<{
      id: string;
      email: string | null;
      isPartnerClient: boolean;
    }>();
    expectTypeOf<RefreshedTokens>().toEqualTypeOf<{
      accessToken: string;
      refreshToken: string;
      tokenType: string;
      expiresInSec: number;
    }>();
    expectTypeOf<RefreshedTokens>().not.toHaveProperty('user');
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

  it('Pairs catalog view (issue #138)', () => {
    expectTypeOf<keyof PairView>().toEqualTypeOf<keyof BinaryPair>();
    expectTypeOf<keyof PairsCatalogView>().toEqualTypeOf<
      'pairs' | 'fetchedAt' | 'ageMs' | 'fresh'
    >();
  });

  it('Trading signal response (issue #258)', () => {
    expectTypeOf<TradingSignalResponse['outcome']>().toEqualTypeOf<'decided' | 'fetch_failed'>();
    expectTypeOf<
      Extract<TradingSignalResponse, { outcome: 'decided' }>['params']
    >().toEqualTypeOf<SignalParams>();
    expectTypeOf<keyof Extract<TradingSignalResponse, { outcome: 'fetch_failed' }>>().toEqualTypeOf<
      'outcome' | 'code' | 'retryAfterSec'
    >();
    expectTypeOf<
      Extract<TradingSignalResponse, { outcome: 'fetch_failed' }>['code']
    >().toEqualTypeOf<
      | 'unauthorized'
      | 'rate_limited'
      | 'rejected'
      | 'unavailable'
      | 'contract_violation'
      | 'aborted'
    >();
    // the route's refusals before the chart GET (#379)
    expectTypeOf<TradingSignalErrorCode>().toEqualTypeOf<'pair_unknown' | 'catalog_unavailable'>();
  });

  it('Trading signals list (issue #343)', () => {
    expectTypeOf<keyof TradingSignalsResponse>().toEqualTypeOf<'asOf' | 'lists'>();
    expectTypeOf<keyof TradingSignalsResponse['lists'][number]>().toEqualTypeOf<
      'interval' | 'scanned' | 'signals'
    >();
    expectTypeOf<keyof TradingSignalsResponse['lists'][number]['signals'][number]>().toEqualTypeOf<
      'assetId' | 'action' | 'lastCandleTimestamp' | 'decidedAt' | 'ageMs'
    >();
    expectTypeOf<TradingSignalsResponse['lists'][number]['interval']>().toEqualTypeOf<
      '15s' | '5s'
    >();
  });

  it('Trading session view and refusal (issue #283)', () => {
    expectTypeOf<keyof TradingSessionView>().toEqualTypeOf<
      | 'id'
      | 'mode'
      | 'status'
      | 'stopReason'
      | 'settings'
      | 'startedAt'
      | 'endedAt'
      | 'trades'
      | 'lastIntent'
    >();
    expectTypeOf<TradingSessionView['status']>().toEqualTypeOf<'active' | 'paused' | 'stopped'>();
    expectTypeOf<TradingSessionView['trades']>().toEqualTypeOf<{
      planned: number;
      settled: number;
      rejected: number;
      won: number;
      lost: number;
      tied: number;
    }>();
    expectTypeOf<TradingSessionView['lastIntent']>().toEqualTypeOf<TradeIntentView | null>();
    expectTypeOf<TradingSessionRefusal['error']>().toEqualTypeOf<
      | 'user_not_found'
      | 'broker_account_not_found'
      | 'ambiguous_broker_account'
      | 'account_not_confirmed'
      | 'account_revoked'
      | 'account_halted'
      | 'user_blocked'
      | 'insufficient_tokens'
      | 'trading_paused'
      | 'mode_not_allowed'
      | 'demo_only'
      | 'active_session_exists'
      | 'session_too_long'
      | 'balance_unavailable'
      | 'pair_unavailable'
      | 'payout_too_low'
      | 'catalog_unavailable'
      | 'not_found'
      | 'session_not_active'
      | 'stake_precision'
      | 'stake_below_minimum'
      | 'insufficient_demo_balance'
    >();
  });

  it('root index re-exports every module', () => {
    const modules = {
      accessToken,
      account,
      admin,
      adminTrading,
      adminBotTexts,
      ledger,
      audit,
      money,
      time,
      ids,
      trading,
      tradingAccess,
      broker,
      brokerBalance,
      brokerBudget,
      oauth,
      users,
      partner,
      socket,
      env,
      process: processModule,
      logging,
      linkConfirmation,
      telegramHtml,
      catalog,
      demoStake,
      signal,
      tradingSession,
      botTextTemplate,
      botTextFormat,
      botTextVars,
      botTexts,
      botTextMessages,
      botTextOverrides,
    };
    for (const [moduleName, module] of Object.entries(modules)) {
      for (const [key, value] of Object.entries(module)) {
        expect(shared, `${moduleName}.${key}`).toHaveProperty(key, value);
      }
    }
  });
});
