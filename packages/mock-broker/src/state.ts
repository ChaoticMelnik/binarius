import { randomUUID } from 'node:crypto';
import {
  BrokerTradeSource,
  TradeAction,
  TradeMode,
  type BinaryPairWire,
  type BrokerUserWireInput,
  type ClosedTradeWireInput,
  type OpenTradeRequestWire,
  type OpenTradeWireInput,
  type UnixMs,
  type WidgetSessionRequestWire,
  type WidgetSessionResponseWire,
} from '@binarius/shared';
import type { PriceCurve } from './chart';
import type { MockSocketPayload } from './encoding';
import { FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import type { MockOAuthOptions } from './oauth';
import { parseCents, percentOf, requireCents, wireMoney } from './money';
import { rawPriceAt, roundTo } from './price';

export const MockTradeStatus = { Open: 'open', Closed: 'closed' } as const;
export type MockTradeStatus = (typeof MockTradeStatus)[keyof typeof MockTradeStatus];

export const MockTradeOutcome = { Win: 'win', Loss: 'loss' } as const;
export type MockTradeOutcome = (typeof MockTradeOutcome)[keyof typeof MockTradeOutcome];

export const MockChangeType = {
  TradeOpened: 'trade_opened',
  TradeClosed: 'trade_closed',
  PairUpdated: 'pair_updated',
  TokenRevoked: 'token_revoked',
} as const;
export type MockChangeType = (typeof MockChangeType)[keyof typeof MockChangeType];

// shared's trade schemas know neither field and zod drops unknown keys, so a parse of a fixture
// response does not see them (docs/mock-broker.md -> Drift); broker-web reads both
export type MockOpenTradeWire = OpenTradeWireInput & { close_timestamp: UnixMs; symbol: string };
export type MockClosedTradeWire = ClosedTradeWireInput & { symbol: string };
export type MockTradeWire = MockOpenTradeWire | MockClosedTradeWire;

export type MockChange =
  | { type: typeof MockChangeType.TradeOpened; userId: number; trade: MockOpenTradeWire }
  | { type: typeof MockChangeType.TradeClosed; userId: number; trade: MockClosedTradeWire }
  | { type: typeof MockChangeType.PairUpdated; pair: BinaryPairWire }
  | { type: typeof MockChangeType.TokenRevoked; userId: number };

export interface MockBrokerOptions {
  pairs?: BinaryPairWire[];
  // the x-ratelimit-limit the fixture reports; it never refuses on its own
  rateLimit?: number;
  // how every server->client Socket.IO payload is delivered; 'object' when left out
  socketPayload?: MockSocketPayload;
  // one curve for the chart, a trade's open_price and close_price and price.update (#105); the
  // built-in waves when left out
  pricePath?: PriceCurve;
  // the client credentials and lifetimes of the OAuth and email-login routes (#105)
  oauth?: Partial<MockOAuthOptions>;
}

// the ids of the users the email login registers: far above any id a suite seeds by hand
export const MOCK_EMAIL_USER_ID_FROM = 1_000_000;

export interface MockUserSeed {
  id: number;
  // none: the user signs in through the email login or oauth/token, which issue one
  accessToken?: string;
  email?: string;
  // what login and oauth/token answer as user.is_partner_client; true when left out
  isPartnerClient?: boolean;
  level?: { code: string; rank: number };
  minTradeAmount?: string;
  demo?: { available: string };
  real?: { available: string };
}

export interface MockTradeFilter {
  status?: MockTradeStatus;
  isDemo?: boolean;
  limit: number;
  offset: number;
}

export interface MockSettleInput {
  outcome: MockTradeOutcome;
  // taken as is, even when it contradicts the outcome
  closePrice?: number;
  closeTimestamp?: number;
}

// what a widget-session request asked for, without the session it was answered with: a test proves
// what the client sent without the journal holding the secret
export interface MockWidgetSessionRecord {
  userId: number;
  origin: string;
  mode: string;
  userIp?: string;
}

// the lifetime the live broker's own cashier is built around (binodex/broker-web)
export const MOCK_WIDGET_SESSION_TTL_SEC = 60;

export type OpenTradeResult =
  { ok: true; trade: MockOpenTradeWire } | { ok: false; message: string };

// ids deliberately unlike the symbols: a client keys pairs by id only. Every pair carries is_otc,
// as every pair of the live common.assets_list did (2026-10-02)
export const DEFAULT_PAIRS: readonly BinaryPairWire[] = [
  {
    id: 101,
    symbol: 'EUR/USD',
    is_otc: false,
    type: 'currency',
    digits: 5,
    payout: 85,
    max_payout: 90,
    min_timeframe: 60,
    max_timeframe: 3600,
    scheduled_until: 0,
  },
  {
    id: 202,
    symbol: 'AAPL',
    is_otc: true,
    type: 'stock',
    digits: 2,
    payout: 78,
    max_payout: 85,
    min_timeframe: 5,
    max_timeframe: 3600,
    scheduled_until: 0,
  },
  {
    id: 303,
    symbol: 'BTC/USD',
    is_otc: false,
    type: 'cryptocurrency',
    digits: 2,
    payout: 80,
    max_payout: 88,
    min_timeframe: 30,
    max_timeframe: 3600,
    scheduled_until: 0,
  },
  {
    // unavailable: scheduled_until is read as "not tradable until" (ms epoch, 2100-01-01)
    id: 404,
    symbol: 'GBP/USD',
    is_otc: false,
    type: 'currency',
    digits: 5,
    payout: 82,
    max_payout: 90,
    min_timeframe: 60,
    max_timeframe: 3600,
    scheduled_until: 4_102_444_800_000,
  },
];

export const DEFAULT_RATE_LIMIT = 600;

interface Balance {
  available: bigint;
  held: bigint;
}

interface UserRecord {
  id: number;
  email?: string;
  isPartnerClient: boolean;
  level: { code: string; rank: number };
  minTradeAmount: bigint;
  balances: Record<TradeMode, Balance>;
}

interface TradeRecord {
  id: number;
  userId: number;
  assetId: number;
  symbol: string;
  digits: number;
  action: TradeAction;
  amount: bigint;
  payout: number;
  potentialProfit: bigint;
  openPrice: number;
  openTimestamp: number;
  closeTimestamp: number;
  isDemo: boolean;
  status: MockTradeStatus;
  closePrice?: number;
  profit?: bigint;
}

export interface MockUserProfile {
  id: number;
  email?: string;
  isPartnerClient: boolean;
}

export interface BrokerState {
  readonly rateLimit: number;
  registerUser(seed: MockUserSeed): void;
  // the email login's sign-up: a user with registerUser's defaults under the next id from
  // MOCK_EMAIL_USER_ID_FROM, a partner client (the login carries the partner code)
  registerEmailUser(email: string): number;
  findUserByEmail(email: string): number | undefined;
  userProfile(id: number): MockUserProfile;
  // a further access token of the user; the earlier ones stay valid
  addAccessToken(userId: number, token: string): void;
  revokeToken(token: string): void;
  authenticate(token: string): number | undefined;
  getUser(id: number): BrokerUserWireInput;
  listPairs(): BinaryPairWire[];
  findPair(id: number): BinaryPairWire | undefined;
  updatePair(id: number, patch: { payout?: number; scheduled_until?: number }): void;
  openTrade(userId: number, request: OpenTradeRequestWire): OpenTradeResult;
  listTrades(userId: number, filter: MockTradeFilter): MockTradeWire[];
  settle(tradeId: number, input: MockSettleInput): MockClosedTradeWire;
  // the curve's raw value; priceAt rounds it to the pair's digits
  price(assetId: number, atMs: number): number;
  priceAt(assetId: number, atMs: number): number;
  createWidgetSession(userId: number, request: WidgetSessionRequestWire): WidgetSessionResponseWire;
  readonly widgetSessions: readonly MockWidgetSessionRecord[];
  // every balance or trade change goes through the store and is announced here (#104's socket)
  onChange(listener: (change: MockChange) => void): () => void;
  // A listener runs after the change is committed, so its throw cannot undo the change or reach
  // the HTTP client; it is kept here instead, and MockBroker.close() throws what is left.
  readonly listenerErrors: readonly Error[];
  clearListenerErrors(): void;
}

const modeOf = (isDemo: boolean): TradeMode => (isDemo ? TradeMode.Demo : TradeMode.Real);

function balanceWire({ available, held }: Balance) {
  return {
    available: wireMoney(available),
    held: wireMoney(held),
    total: wireMoney(available + held),
  };
}

function openWire(trade: TradeRecord): MockOpenTradeWire {
  return {
    id: trade.id,
    asset_id: trade.assetId,
    action: trade.action,
    amount: wireMoney(trade.amount),
    payout: trade.payout,
    potential_profit: wireMoney(trade.potentialProfit),
    open_price: trade.openPrice,
    open_timestamp: trade.openTimestamp,
    close_timestamp: trade.closeTimestamp,
    is_demo: trade.isDemo,
    source: BrokerTradeSource.Api,
    broker_client_id: null,
    symbol: trade.symbol,
  };
}

function closedWire(trade: TradeRecord, closePrice: number, profit: bigint): MockClosedTradeWire {
  return {
    id: trade.id,
    asset_id: trade.assetId,
    action: trade.action,
    amount: wireMoney(trade.amount),
    payout: trade.payout,
    open_price: trade.openPrice,
    open_timestamp: trade.openTimestamp,
    close_price: closePrice,
    close_timestamp: trade.closeTimestamp,
    profit: wireMoney(profit),
    is_demo: trade.isDemo,
    source: BrokerTradeSource.Api,
    broker_client_id: null,
    symbol: trade.symbol,
  };
}

function wireOf(trade: TradeRecord): MockTradeWire {
  if (trade.status === MockTradeStatus.Open) return openWire(trade);
  return closedWire(trade, trade.closePrice ?? trade.openPrice, trade.profit ?? 0n);
}

// a close price on the side of the open price the outcome needs, at least one tick away: the
// curve's own price when it already agrees, its mirror image around the open price otherwise
function closePriceFor(
  trade: TradeRecord,
  outcome: MockTradeOutcome,
  closeTs: number,
  price: PriceCurve,
): number {
  const tick = 10 ** -trade.digits;
  const sampled = roundTo(price(trade.assetId, closeTs), trade.digits);
  const rises = (outcome === MockTradeOutcome.Win) === (trade.action === TradeAction.Up);
  const distance = Math.max(Math.abs(sampled - trade.openPrice), tick);
  return roundTo(trade.openPrice + (rises ? distance : -distance), trade.digits);
}

export function createBrokerState(options: MockBrokerOptions = {}): BrokerState {
  const pairs = new Map<number, BinaryPairWire>(
    (options.pairs ?? DEFAULT_PAIRS).map((pair) => [pair.id, { ...pair }]),
  );
  const users = new Map<number, UserRecord>();
  const tokens = new Map<string, number>();
  const trades = new Map<number, TradeRecord>();
  const listeners = new Set<(change: MockChange) => void>();
  const widgetSessions: MockWidgetSessionRecord[] = [];
  const price = options.pricePath ?? rawPriceAt;
  let lastTradeId = 0;
  let lastEmailUser = 0;

  const listenerErrors: Error[] = [];

  const emailIndex = (lowerCased: string): number | undefined =>
    [...users.values()].find((user) => user.email === lowerCased)?.id;

  const emit = (change: MockChange) => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        listenerErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  function userRecord(id: number): UserRecord {
    const user = users.get(id);
    if (user === undefined) throw new RangeError(`unknown mock user ${id}`);
    return user;
  }

  const tokenFree = (token: string) => token !== '' && !tokens.has(token);

  function registerUser(seed: MockUserSeed): void {
    if (users.has(seed.id)) throw new RangeError(`mock user ${seed.id} already exists`);
    if (seed.accessToken !== undefined && !tokenFree(seed.accessToken)) {
      throw new RangeError(`mock user ${seed.id}: the access token is empty or taken`);
    }
    const email = seed.email?.toLowerCase();
    if (email !== undefined && emailIndex(email) !== undefined) {
      throw new RangeError(`mock user ${seed.id}: the email is taken`);
    }
    users.set(seed.id, {
      id: seed.id,
      ...(email === undefined ? {} : { email }),
      isPartnerClient: seed.isPartnerClient ?? true,
      level: { ...(seed.level ?? { code: 'standard', rank: 1 }) },
      minTradeAmount: requireCents(seed.minTradeAmount ?? '1.00', 'minTradeAmount'),
      balances: {
        [TradeMode.Demo]: {
          available: requireCents(seed.demo?.available ?? '10000.00', 'demo.available'),
          held: 0n,
        },
        [TradeMode.Real]: {
          available: requireCents(seed.real?.available ?? '0.00', 'real.available'),
          held: 0n,
        },
      },
    });
    if (seed.accessToken !== undefined) tokens.set(seed.accessToken, seed.id);
  }

  function pairRecord(id: number): BinaryPairWire {
    const pair = pairs.get(id);
    if (pair === undefined) throw new RangeError(`unknown mock asset ${id}`);
    return pair;
  }

  return {
    rateLimit: options.rateLimit ?? DEFAULT_RATE_LIMIT,

    registerUser,

    registerEmailUser(email) {
      lastEmailUser += 1;
      const id = MOCK_EMAIL_USER_ID_FROM + lastEmailUser;
      registerUser({ id, email });
      return id;
    },

    findUserByEmail: (email) => emailIndex(email.toLowerCase()),

    userProfile(id) {
      const user = userRecord(id);
      return {
        id: user.id,
        ...(user.email === undefined ? {} : { email: user.email }),
        isPartnerClient: user.isPartnerClient,
      };
    },

    addAccessToken(userId, token) {
      userRecord(userId);
      if (!tokenFree(token)) {
        throw new RangeError(`mock user ${userId}: the access token is empty or taken`);
      }
      tokens.set(token, userId);
    },

    revokeToken(token) {
      const userId = tokens.get(token);
      if (userId === undefined) return;
      tokens.delete(token);
      emit({ type: MockChangeType.TokenRevoked, userId });
    },

    authenticate: (token) => tokens.get(token),

    getUser(id) {
      const user = userRecord(id);
      return {
        id: user.id,
        level: { ...user.level },
        min_trade_amount: wireMoney(user.minTradeAmount),
        real: balanceWire(user.balances[TradeMode.Real]),
        demo: balanceWire(user.balances[TradeMode.Demo]),
      };
    },

    listPairs: () => [...pairs.values()].map((pair) => ({ ...pair })),

    findPair(id) {
      const pair = pairs.get(id);
      return pair === undefined ? undefined : { ...pair };
    },

    updatePair(id, patch) {
      const pair = pairRecord(id);
      if (patch.payout !== undefined) pair.payout = patch.payout;
      if (patch.scheduled_until !== undefined) pair.scheduled_until = patch.scheduled_until;
      emit({ type: MockChangeType.PairUpdated, pair: { ...pair } });
    },

    openTrade(userId, request) {
      const user = userRecord(userId);
      const amount = parseCents(request.amount);
      if (amount === undefined) return { ok: false, message: FIXTURE_MESSAGES.amountPrecision };
      const pair = pairs.get(request.asset_id);
      if (pair === undefined) return { ok: false, message: LIVE_MESSAGES.unknownAsset };
      const now = Date.now();
      if (pair.scheduled_until > now) {
        return { ok: false, message: FIXTURE_MESSAGES.assetUnavailable };
      }
      if (request.duration < pair.min_timeframe || request.duration > pair.max_timeframe) {
        return { ok: false, message: FIXTURE_MESSAGES.unsupportedDuration };
      }
      if (amount < user.minTradeAmount)
        return { ok: false, message: FIXTURE_MESSAGES.belowMinimum };
      const balance = user.balances[modeOf(request.is_demo)];
      if (amount > balance.available) {
        return { ok: false, message: FIXTURE_MESSAGES.insufficientBalance };
      }

      balance.available -= amount;
      balance.held += amount;
      lastTradeId += 1;
      const trade: TradeRecord = {
        id: lastTradeId,
        userId,
        assetId: pair.id,
        symbol: pair.symbol,
        digits: pair.digits,
        action: request.action,
        amount,
        payout: pair.payout,
        potentialProfit: percentOf(amount, pair.payout),
        openPrice: roundTo(price(pair.id, now), pair.digits),
        openTimestamp: now,
        closeTimestamp: now + request.duration * 1000,
        isDemo: request.is_demo,
        status: MockTradeStatus.Open,
      };
      trades.set(trade.id, trade);
      const wire = openWire(trade);
      emit({ type: MockChangeType.TradeOpened, userId, trade: wire });
      return { ok: true, trade: wire };
    },

    listTrades(userId, filter) {
      return [...trades.values()]
        .filter(
          (trade) =>
            trade.userId === userId &&
            (filter.status === undefined || trade.status === filter.status) &&
            (filter.isDemo === undefined || trade.isDemo === filter.isDemo),
        )
        .sort((a, b) => b.openTimestamp - a.openTimestamp || b.id - a.id)
        .slice(filter.offset, filter.offset + filter.limit)
        .map(wireOf);
    },

    settle(tradeId, input) {
      const trade = trades.get(tradeId);
      if (trade === undefined) throw new RangeError(`unknown mock trade ${tradeId}`);
      if (trade.status !== MockTradeStatus.Open) {
        throw new RangeError(`mock trade ${tradeId} is already settled`);
      }
      const balance = userRecord(trade.userId).balances[modeOf(trade.isDemo)];
      if (input.closeTimestamp !== undefined) trade.closeTimestamp = input.closeTimestamp;
      const won = input.outcome === MockTradeOutcome.Win;
      balance.held -= trade.amount;
      if (won) balance.available += trade.amount + trade.potentialProfit;
      trade.status = MockTradeStatus.Closed;
      trade.closePrice =
        input.closePrice ?? closePriceFor(trade, input.outcome, trade.closeTimestamp, price);
      trade.profit = won ? trade.potentialProfit : -trade.amount;
      const wire = closedWire(trade, trade.closePrice, trade.profit);
      emit({ type: MockChangeType.TradeClosed, userId: trade.userId, trade: wire });
      return wire;
    },

    price,

    priceAt(assetId, atMs) {
      const pair = pairRecord(assetId);
      return roundTo(price(pair.id, atMs), pair.digits);
    },

    createWidgetSession(userId, request) {
      userRecord(userId);
      widgetSessions.push({
        userId,
        origin: request.origin,
        mode: request.mode,
        ...(request.user_ip === undefined ? {} : { userIp: request.user_ip }),
      });
      return { session: `wss_${randomUUID()}`, expires_in: MOCK_WIDGET_SESSION_TTL_SEC };
    },

    widgetSessions,

    listenerErrors,

    clearListenerErrors() {
      listenerErrors.length = 0;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
