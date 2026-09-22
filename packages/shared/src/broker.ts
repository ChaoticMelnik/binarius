import * as z from 'zod';
import { decimalStringSchema, type DecimalString } from './money';
import { unixMsSchema, type UnixMs } from './time';
import { tradeActionSchema, type TradeAction } from './trading';

// Binodex does not state whether ids are numeric or strings; both are accepted on the wire and
// normalized to strings losslessly. BinaryPair.id is confirmed numeric (#8).
const idWireSchema = z.union([z.int(), z.string().min(1)]);

const toId = (id: number | string): string => String(id);

// --- BinaryPair -------------------------------------------------------------------------------

export const binaryPairWireSchema = z.object({
  id: z.int(),
  symbol: z.string(),
  is_otc: z.boolean().optional(),
  type: z.string(),
  digits: z.int(),
  payout: z.number(),
  max_payout: z.number(),
  min_timeframe: z.int(),
  max_timeframe: z.int(),
  // unit not confirmed (#8): passed through untouched, 0 means no schedule restriction
  scheduled_until: z.number().nonnegative(),
});
export type BinaryPairWire = z.infer<typeof binaryPairWireSchema>;

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
  available: decimalStringSchema,
  held: decimalStringSchema,
  total: decimalStringSchema,
});
export type BrokerBalanceWire = z.infer<typeof brokerBalanceWireSchema>;

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
  min_trade_amount: decimalStringSchema,
  real: brokerBalanceWireSchema,
  demo: brokerBalanceWireSchema,
});
export type BrokerUserWire = z.infer<typeof brokerUserWireSchema>;

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
  amount: decimalStringSchema,
  payout: z.number(),
  open_price: z.number(),
  open_timestamp: unixMsSchema,
  is_demo: z.boolean(),
  source: z.enum(BrokerTradeSource).optional(),
  broker_client_id: z.string().nullable().optional(),
};

export const openTradeWireSchema = z.object({
  ...tradeBaseWireShape,
  potential_profit: decimalStringSchema,
});
export type OpenTradeWire = z.infer<typeof openTradeWireSchema>;

export const closedTradeWireSchema = z.object({
  ...tradeBaseWireShape,
  close_price: z.number(),
  close_timestamp: unixMsSchema,
  profit: decimalStringSchema,
});
export type ClosedTradeWire = z.infer<typeof closedTradeWireSchema>;

interface TradeBase {
  id: string;
  assetId: number;
  action: TradeAction;
  amount: DecimalString;
  payout: number;
  openPrice: number;
  openTimestamp: UnixMs;
  isDemo: boolean;
  source?: BrokerTradeSource;
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
  amount: decimalStringSchema,
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
  z.array(binaryPairWireSchema).parse(input).map(toBinaryPair);

export const parseBrokerUser = (input: unknown): BrokerUser =>
  toBrokerUser(brokerUserWireSchema.parse(input));
export const safeParseBrokerUser = (input: unknown) => brokerUserWireSchema.safeParse(input);

export const parseBrokerBalance = (input: unknown): BrokerBalance =>
  toBrokerBalance(brokerBalanceWireSchema.parse(input));

export const parseCandles = (input: unknown): Candle[] =>
  candlesWireSchema.parse(input).map(toCandle);
export const safeParseCandles = (input: unknown) => candlesWireSchema.safeParse(input);

export const parseOpenTrade = (input: unknown): OpenTrade =>
  toOpenTrade(openTradeWireSchema.parse(input));
export const safeParseOpenTrade = (input: unknown) => openTradeWireSchema.safeParse(input);

export const parseClosedTrade = (input: unknown): ClosedTrade =>
  toClosedTrade(closedTradeWireSchema.parse(input));
export const safeParseClosedTrade = (input: unknown) => closedTradeWireSchema.safeParse(input);

export const parseBrokerError = (input: unknown): BrokerError =>
  toBrokerError(brokerErrorEnvelopeWireSchema.parse(input));
export const safeParseBrokerError = (input: unknown) =>
  brokerErrorEnvelopeWireSchema.safeParse(input);
