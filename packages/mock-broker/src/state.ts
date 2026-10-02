import {
  BrokerTradeSource,
  TradeAction,
  TradeMode,
  type BinaryPairWire,
  type BrokerUserWire,
  type ClosedTradeWire,
  type OpenTradeRequestWire,
  type OpenTradeWire,
  type UnixMs,
} from '@binarius/shared';
import { FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import { formatCents, parseCents, percentOf, requireCents } from './money';
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
export type MockOpenTradeWire = OpenTradeWire & { close_timestamp: UnixMs; symbol: string };
export type MockClosedTradeWire = ClosedTradeWire & { symbol: string };
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
}

export interface MockUserSeed {
  id: number;
  accessToken: string;
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

export interface BrokerState {
  readonly rateLimit: number;
  registerUser(seed: MockUserSeed): void;
  revokeToken(token: string): void;
  authenticate(token: string): number | undefined;
  getUser(id: number): BrokerUserWire;
  listPairs(): BinaryPairWire[];
  findPair(id: number): BinaryPairWire | undefined;
  updatePair(id: number, patch: { payout?: number; scheduled_until?: number }): void;
  openTrade(userId: number, request: OpenTradeRequestWire): OpenTradeResult;
  listTrades(userId: number, filter: MockTradeFilter): MockTradeWire[];
  settle(tradeId: number, input: MockSettleInput): MockClosedTradeWire;
  priceAt(assetId: number, atMs: number): number;
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
    available: formatCents(available),
    held: formatCents(held),
    total: formatCents(available + held),
  };
}

function openWire(trade: TradeRecord): MockOpenTradeWire {
  return {
    id: trade.id,
    asset_id: trade.assetId,
    action: trade.action,
    amount: formatCents(trade.amount),
    payout: trade.payout,
    potential_profit: formatCents(trade.potentialProfit),
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
    amount: formatCents(trade.amount),
    payout: trade.payout,
    open_price: trade.openPrice,
    open_timestamp: trade.openTimestamp,
    close_price: closePrice,
    close_timestamp: trade.closeTimestamp,
    profit: formatCents(profit),
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
function closePriceFor(trade: TradeRecord, outcome: MockTradeOutcome, closeTs: number): number {
  const tick = 10 ** -trade.digits;
  const sampled = roundTo(rawPriceAt(trade.assetId, closeTs), trade.digits);
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
  let lastTradeId = 0;

  const listenerErrors: Error[] = [];

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

  function pairRecord(id: number): BinaryPairWire {
    const pair = pairs.get(id);
    if (pair === undefined) throw new RangeError(`unknown mock asset ${id}`);
    return pair;
  }

  return {
    rateLimit: options.rateLimit ?? DEFAULT_RATE_LIMIT,

    registerUser(seed) {
      if (users.has(seed.id)) throw new RangeError(`mock user ${seed.id} already exists`);
      if (seed.accessToken === '' || tokens.has(seed.accessToken)) {
        throw new RangeError(`mock user ${seed.id}: the access token is empty or taken`);
      }
      users.set(seed.id, {
        id: seed.id,
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
      tokens.set(seed.accessToken, seed.id);
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
        min_trade_amount: formatCents(user.minTradeAmount),
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
        openPrice: roundTo(rawPriceAt(pair.id, now), pair.digits),
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
        input.closePrice ?? closePriceFor(trade, input.outcome, trade.closeTimestamp);
      trade.profit = won ? trade.potentialProfit : -trade.amount;
      const wire = closedWire(trade, trade.closePrice, trade.profit);
      emit({ type: MockChangeType.TradeClosed, userId: trade.userId, trade: wire });
      return wire;
    },

    priceAt(assetId, atMs) {
      const pair = pairRecord(assetId);
      return roundTo(rawPriceAt(pair.id, atMs), pair.digits);
    },

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
