import * as z from 'zod';
import { idWireSchema, toId } from './ids';
import { moneyWireSchema, positiveDecimalStringSchema, type DecimalString } from './money';
import { unixMsSchema, type UnixMs } from './time';
import { tradeActionSchema, type TradeAction } from './trading';

// --- BinaryPair -------------------------------------------------------------------------------

export const binaryPairWireSchema = z.object({
  // confirmed numeric (#8), unlike the other Binodex ids (see ids.ts)
  id: z.int(),
  symbol: z.string(),
  is_otc: z.boolean().optional(),
  type: z.string(),
  digits: z.int(),
  payout: z.number(),
  max_payout: z.number(),
  min_timeframe: z.int(),
  max_timeframe: z.int(),
  // ms since the epoch, read as "not tradable until"; 0 = no restriction
  scheduled_until: z.number().nonnegative(),
});
export type BinaryPairWire = z.infer<typeof binaryPairWireSchema>;
export const binaryPairsWireSchema = z.array(binaryPairWireSchema);

export interface BinaryPair {
  id: number;
  symbol: string;
  isOtc?: boolean;
  type: string;
  digits: number;
  payout: number;
  maxPayout: number;
  minTimeframe: number;
  maxTimeframe: number;
  scheduledUntil: number;
}

export function toBinaryPair(wire: BinaryPairWire): BinaryPair {
  return {
    id: wire.id,
    symbol: wire.symbol,
    ...(wire.is_otc === undefined ? {} : { isOtc: wire.is_otc }),
    type: wire.type,
    digits: wire.digits,
    payout: wire.payout,
    maxPayout: wire.max_payout,
    minTimeframe: wire.min_timeframe,
    maxTimeframe: wire.max_timeframe,
    scheduledUntil: wire.scheduled_until,
  };
}

// --- BrokerBalance / BrokerUser ---------------------------------------------------------------

export const brokerBalanceWireSchema = z.object({
  available: moneyWireSchema,
  held: moneyWireSchema,
  total: moneyWireSchema,
});
export type BrokerBalanceWire = z.infer<typeof brokerBalanceWireSchema>;
export type BrokerBalanceWireInput = z.input<typeof brokerBalanceWireSchema>;

export interface BrokerBalance {
  available: DecimalString;
  held: DecimalString;
  total: DecimalString;
}

export function toBrokerBalance(wire: BrokerBalanceWire): BrokerBalance {
  return { available: wire.available, held: wire.held, total: wire.total };
}

export const brokerUserLevelWireSchema = z.looseObject({ code: z.string(), rank: z.number() });

export const brokerUserWireSchema = z.object({
  id: idWireSchema,
  level: brokerUserLevelWireSchema,
  min_trade_amount: moneyWireSchema,
  real: brokerBalanceWireSchema,
  demo: brokerBalanceWireSchema,
});
export type BrokerUserWire = z.infer<typeof brokerUserWireSchema>;
export type BrokerUserWireInput = z.input<typeof brokerUserWireSchema>;

export interface BrokerUser {
  id: string;
  level: { code: string; rank: number };
  minTradeAmount: DecimalString;
  real: BrokerBalance;
  demo: BrokerBalance;
}

export function toBrokerUser(wire: BrokerUserWire): BrokerUser {
  return {
    id: toId(wire.id),
    level: { code: wire.level.code, rank: wire.level.rank },
    minTradeAmount: wire.min_trade_amount,
    real: toBrokerBalance(wire.real),
    demo: toBrokerBalance(wire.demo),
  };
}

// --- Candles ----------------------------------------------------------------------------------

const candle5 = z.tuple([unixMsSchema, z.number(), z.number(), z.number(), z.number()]);
const candle6 = z.tuple([unixMsSchema, z.number(), z.number(), z.number(), z.number(), z.number()]);
export const candleWireSchema = z.union([candle6, candle5]);
export const candlesWireSchema = z.array(candleWireSchema);
export type CandleWire = z.infer<typeof candleWireSchema>;

export interface Candle {
  timestamp: UnixMs;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export function toCandle(wire: CandleWire): Candle {
  const [timestamp, open, high, low, close, volume] = wire;
  return {
    timestamp,
    open,
    high,
    low,
    close,
    ...(volume === undefined ? {} : { volume }),
  };
}

// --- Trades -----------------------------------------------------------------------------------

export const BrokerTradeSource = { Api: 'api', Platform: 'platform' } as const;
export type BrokerTradeSource = (typeof BrokerTradeSource)[keyof typeof BrokerTradeSource];

const tradeBaseWireShape = {
  id: idWireSchema,
  asset_id: z.int(),
  action: tradeActionSchema,
  amount: moneyWireSchema,
  payout: z.number(),
  open_price: z.number(),
  open_timestamp: unixMsSchema,
  is_demo: z.boolean(),
  // an unknown label must not make a settled trade unparseable (#18 confirms the full set)
  source: z.string().optional(),
  broker_client_id: z.string().nullable().optional(),
};

export const openTradeWireSchema = z.object({
  ...tradeBaseWireShape,
  potential_profit: moneyWireSchema,
});
export type OpenTradeWire = z.infer<typeof openTradeWireSchema>;
export type OpenTradeWireInput = z.input<typeof openTradeWireSchema>;

export const closedTradeWireSchema = z.object({
  ...tradeBaseWireShape,
  close_price: z.number(),
  close_timestamp: unixMsSchema,
  profit: moneyWireSchema,
});
export type ClosedTradeWire = z.infer<typeof closedTradeWireSchema>;
export type ClosedTradeWireInput = z.input<typeof closedTradeWireSchema>;

interface TradeBase {
  id: string;
  assetId: number;
  action: TradeAction;
  amount: DecimalString;
  payout: number;
  openPrice: number;
  openTimestamp: UnixMs;
  isDemo: boolean;
  source?: BrokerTradeSource | (string & {});
  brokerClientId?: string | null;
}

export interface OpenTrade extends TradeBase {
  potentialProfit: DecimalString;
}

export interface ClosedTrade extends TradeBase {
  closePrice: number;
  closeTimestamp: UnixMs;
  profit: DecimalString;
}

function toTradeBase(wire: OpenTradeWire | ClosedTradeWire): TradeBase {
  return {
    id: toId(wire.id),
    assetId: wire.asset_id,
    action: wire.action,
    amount: wire.amount,
    payout: wire.payout,
    openPrice: wire.open_price,
    openTimestamp: wire.open_timestamp,
    isDemo: wire.is_demo,
    ...(wire.source === undefined ? {} : { source: wire.source }),
    ...(wire.broker_client_id === undefined ? {} : { brokerClientId: wire.broker_client_id }),
  };
}

export function toOpenTrade(wire: OpenTradeWire): OpenTrade {
  return { ...toTradeBase(wire), potentialProfit: wire.potential_profit };
}

export function toClosedTrade(wire: ClosedTradeWire): ClosedTrade {
  return {
    ...toTradeBase(wire),
    closePrice: wire.close_price,
    closeTimestamp: wire.close_timestamp,
    profit: wire.profit,
  };
}

// GET /broker/user/trades answers { trades: [...] } (live, 2026-10-02, an empty list). Closed is
// tried first because it is the member with the extra required fields: an open trade carrying a
// close_timestamp (its expiry) has no close_price/profit and falls through to open.
export const tradeWireSchema = z.union([closedTradeWireSchema, openTradeWireSchema]);
export type TradeWire = z.infer<typeof tradeWireSchema>;
export const tradesListWireSchema = z.object({ trades: z.array(tradeWireSchema) });
export type TradesListWire = z.infer<typeof tradesListWireSchema>;

export type BrokerTrade = OpenTrade | ClosedTrade;

export const isClosedTrade = (trade: BrokerTrade): trade is ClosedTrade => 'profit' in trade;

export function toBrokerTrade(wire: TradeWire): BrokerTrade {
  return 'profit' in wire ? toClosedTrade(wire) : toOpenTrade(wire);
}

// --- Open-trade request (REST: POST /broker/user/trades) --------------------------------------

export interface OpenTradeRequest {
  assetId: number;
  amount: DecimalString;
  action: TradeAction;
  durationSec: number;
  isDemo: boolean;
}

export const openTradeRequestWireSchema = z.object({
  asset_id: z.int(),
  amount: positiveDecimalStringSchema,
  action: tradeActionSchema,
  duration: z.int().positive(),
  is_demo: z.boolean(),
});
export type OpenTradeRequestWire = z.infer<typeof openTradeRequestWireSchema>;

export function toOpenTradeRequestWire(request: OpenTradeRequest): OpenTradeRequestWire {
  return {
    asset_id: request.assetId,
    amount: request.amount,
    action: request.action,
    duration: request.durationSec,
    is_demo: request.isDemo,
  };
}

// --- Chart request (REST: GET /broker/chart) --------------------------------------------------

export interface ChartRequest {
  assetId: number;
  interval: string;
  limit: number;
  startTime: UnixMs;
}

// The live broker (2026-10-02) takes interval only as a count and a unit ("1m"; interval=60 is a
// 400 "Unsupported interval") and refuses a request without start_time.
export const CHART_INTERVAL_PATTERN = /^\d+(ms|s|m|h|d|w|M)$/;

export const chartRequestWireSchema = z.object({
  asset_id: z.int(),
  interval: z.string().regex(CHART_INTERVAL_PATTERN),
  limit: z.int().positive(),
  start_time: unixMsSchema,
});
export type ChartRequestWire = z.infer<typeof chartRequestWireSchema>;

export function toChartRequestWire(request: ChartRequest): ChartRequestWire {
  return {
    asset_id: request.assetId,
    interval: request.interval,
    limit: request.limit,
    start_time: request.startTime,
  };
}

// --- Error envelope (REST) --------------------------------------------------------------------

export const brokerErrorEnvelopeWireSchema = z.looseObject({
  error: z.looseObject({ message: z.string(), details: z.unknown().optional() }),
});
export type BrokerErrorEnvelopeWire = z.infer<typeof brokerErrorEnvelopeWireSchema>;

export interface BrokerError {
  message: string;
  details?: unknown;
}

export function toBrokerError(wire: BrokerErrorEnvelopeWire): BrokerError {
  return {
    message: wire.error.message,
    ...(wire.error.details === undefined ? {} : { details: wire.error.details }),
  };
}

// --- Parsers ----------------------------------------------------------------------------------

export const parseBinaryPair = (input: unknown): BinaryPair =>
  toBinaryPair(binaryPairWireSchema.parse(input));
export const safeParseBinaryPair = (input: unknown) => binaryPairWireSchema.safeParse(input);

export const parseBinaryPairs = (input: unknown): BinaryPair[] =>
  binaryPairsWireSchema.parse(input).map(toBinaryPair);
export const safeParseBinaryPairs = (input: unknown) => binaryPairsWireSchema.safeParse(input);

export const parseBrokerUser = (input: unknown): BrokerUser =>
  toBrokerUser(brokerUserWireSchema.parse(input));
export const safeParseBrokerUser = (input: unknown) => brokerUserWireSchema.safeParse(input);

export const parseBrokerBalance = (input: unknown): BrokerBalance =>
  toBrokerBalance(brokerBalanceWireSchema.parse(input));
export const safeParseBrokerBalance = (input: unknown) => brokerBalanceWireSchema.safeParse(input);

export const parseCandles = (input: unknown): Candle[] =>
  candlesWireSchema.parse(input).map(toCandle);
export const safeParseCandles = (input: unknown) => candlesWireSchema.safeParse(input);

export const parseOpenTrade = (input: unknown): OpenTrade =>
  toOpenTrade(openTradeWireSchema.parse(input));
export const safeParseOpenTrade = (input: unknown) => openTradeWireSchema.safeParse(input);

export const parseClosedTrade = (input: unknown): ClosedTrade =>
  toClosedTrade(closedTradeWireSchema.parse(input));
export const safeParseClosedTrade = (input: unknown) => closedTradeWireSchema.safeParse(input);

export const parseTradesList = (input: unknown): BrokerTrade[] =>
  tradesListWireSchema.parse(input).trades.map(toBrokerTrade);
export const safeParseTradesList = (input: unknown) => tradesListWireSchema.safeParse(input);

export const parseBrokerError = (input: unknown): BrokerError =>
  toBrokerError(brokerErrorEnvelopeWireSchema.parse(input));
export const safeParseBrokerError = (input: unknown) =>
  brokerErrorEnvelopeWireSchema.safeParse(input);

// --- BrokerRestErrorCode ---------------------------------------------------------------------

// The codes of packages/broker-rest's BrokerRestError; here because POST /trading/signal carries
// one to the bot. Told apart by the HTTP status and the transport failure, never by the body
// text. Which rows mean "the broker refused before acting" and which mean "the outcome is
// unknown" is the table in docs/broker-rest.md -> Errors; a REST open that ends unavailable or
// contract_violation may have opened.
export const BrokerRestErrorCode = {
  // 401
  Unauthorized: 'unauthorized',
  // 429; retryAfterSec when Retry-After is an integer
  RateLimited: 'rate_limited',
  // any other 4xx
  Rejected: 'rejected',
  // 5xx, a failed or timed-out fetch, a 2xx body cut mid-flight
  Unavailable: 'unavailable',
  // a 2xx body that is not JSON or fails the schema, and any 3xx
  ContractViolation: 'contract_violation',
  // the caller's signal fired first
  Aborted: 'aborted',
} as const;
export type BrokerRestErrorCode = (typeof BrokerRestErrorCode)[keyof typeof BrokerRestErrorCode];
