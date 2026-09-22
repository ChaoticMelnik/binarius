import * as z from 'zod';
import {
  binaryPairWireSchema,
  brokerBalanceWireSchema,
  brokerUserWireSchema,
  closedTradeWireSchema,
  toBinaryPair,
  toBrokerBalance,
  toBrokerUser,
  toClosedTrade,
  toOpenTrade,
  openTradeWireSchema,
  type BinaryPair,
  type BinaryPairWire,
  type BrokerBalance,
  type BrokerBalanceWire,
  type BrokerUser,
  type BrokerUserWire,
  type ClosedTrade,
  type OpenTrade,
  type OpenTradeWire,
} from './broker';
import { decimalStringSchema, type DecimalString } from './money';
import { tradeActionSchema, type TradeAction, type TradeMode } from './trading';

// Contract per spike #8 §1 (read from binodex/broker-web, not live-verified). Event maps are typed
// with WIRE payloads: the server may deliver them as bytes, so decode first (decodeSocketPayload),
// then parse, then map to domain types.

export const BrokerSocketEvent = {
  UserAuth: 'user.auth',
  UserAuthSuccess: 'user.auth.success',
  UserAuthError: 'user.auth.error',
  UserDisconnectTokenExpired: 'user.disconnect_token_expired',
  PriceSubscribe: 'price.subscribe',
  PriceUpdate: 'price.update',
  CommonAssetsList: 'common.assets_list',
  CommonAssetsUpdate: 'common.assets_update',
  UserData: 'user.data',
} as const;

export const MAX_PRICE_SUBSCRIPTION_ASSETS = 40;

export type ModeScopedEvent =
  | 'open_trade'
  | 'open_trade.success'
  | 'open_trade.fail'
  | 'close_trade.success'
  | 'update_balance';

export function modeEvent<M extends TradeMode, E extends ModeScopedEvent>(
  mode: M,
  event: E,
): `user.${M}.${E}` {
  return `user.${mode}.${event}`;
}

// --- Client → server payloads -----------------------------------------------------------------

export const userAuthWireSchema = z.object({
  id: z.union([z.int(), z.string().min(1)]),
  token: z.string().min(1),
});
export type UserAuthWire = z.infer<typeof userAuthWireSchema>;

export const priceSubscribeWireSchema = z.object({
  assets: z.array(z.int()).min(1).max(MAX_PRICE_SUBSCRIPTION_ASSETS),
});
export type PriceSubscribeWire = z.infer<typeof priceSubscribeWireSchema>;

// the mode travels in the event name, so unlike the REST body there is no is_demo here
export const socketOpenTradeRequestWireSchema = z.object({
  asset_id: z.int(),
  amount: decimalStringSchema,
  action: tradeActionSchema,
  duration: z.int().positive(),
});
export type SocketOpenTradeRequestWire = z.infer<typeof socketOpenTradeRequestWireSchema>;

export interface SocketOpenTradeRequest {
  assetId: number;
  amount: DecimalString;
  action: TradeAction;
  durationSec: number;
}

export function toSocketOpenTradeRequestWire(
  request: SocketOpenTradeRequest,
): SocketOpenTradeRequestWire {
  return {
    asset_id: request.assetId,
    amount: request.amount,
    action: request.action,
    duration: request.durationSec,
  };
}

// --- Server → client payloads -----------------------------------------------------------------

export const userAuthErrorWireSchema = z.looseObject({ message: z.string() });
export type UserAuthErrorWire = z.infer<typeof userAuthErrorWireSchema>;

// [assetId, price, timestamp]; the timestamp unit is not confirmed — consumers may apply
// normalizeUnixMs. Extra elements are tolerated, fewer than three are rejected (as broker-web does).
export const priceUpdateWireSchema = z.tuple(
  [z.int(), z.number(), z.number().nonnegative()],
  z.unknown(),
);
export type PriceUpdateWire = z.infer<typeof priceUpdateWireSchema>;

export interface PriceUpdate {
  assetId: number;
  price: number;
  timestamp: number;
}

export function toPriceUpdate(wire: PriceUpdateWire): PriceUpdate {
  const [assetId, price, timestamp] = wire;
  return { assetId, price, timestamp };
}

export const assetsListWireSchema = z.array(binaryPairWireSchema);
export type AssetsListWire = z.infer<typeof assetsListWireSchema>;

// #8 leaves open whether the patch is keyed by asset_id or id: either is accepted, both must agree
export const assetsUpdateWireSchema = z
  .looseObject({
    asset_id: z.int().optional(),
    id: z.int().optional(),
    payout: z.number().optional(),
    scheduled_until: z.number().nonnegative().optional(),
  })
  .refine((patch) => patch.asset_id !== undefined || patch.id !== undefined, {
    error: 'assets_update needs asset_id or id',
  })
  .refine(
    (patch) =>
      patch.asset_id === undefined || patch.id === undefined || patch.asset_id === patch.id,
    { error: 'assets_update asset_id and id disagree' },
  );
export type AssetsUpdateWire = z.infer<typeof assetsUpdateWireSchema>;

export interface AssetsUpdate {
  assetId: number;
  payout?: number;
  scheduledUntil?: number;
}

export function toAssetsUpdate(wire: AssetsUpdateWire): AssetsUpdate {
  const assetId = wire.asset_id ?? wire.id;
  if (assetId === undefined) throw new Error('assets_update without asset_id or id');
  return {
    assetId,
    ...(wire.payout === undefined ? {} : { payout: wire.payout }),
    ...(wire.scheduled_until === undefined ? {} : { scheduledUntil: wire.scheduled_until }),
  };
}

export const openTradeFailWireSchema = z.array(
  z.looseObject({ message: z.string(), field: z.string().optional() }),
);
export type OpenTradeFailWire = z.infer<typeof openTradeFailWireSchema>;

export interface OpenTradeFailure {
  message: string;
  field?: string;
}

export function toOpenTradeFailures(wire: OpenTradeFailWire): OpenTradeFailure[] {
  return wire.map((entry) => ({
    message: entry.message,
    ...(entry.field === undefined ? {} : { field: entry.field }),
  }));
}

export const closeTradeSuccessWireSchema = z.looseObject({
  trades: z.array(closedTradeWireSchema),
});
export type CloseTradeSuccessWire = z.infer<typeof closeTradeSuccessWireSchema>;

// --- Event maps (socket.io-client generics) ---------------------------------------------------

export interface BrokerServerToClientEvents {
  'user.auth.success': () => void;
  'user.auth.error': (payload: UserAuthErrorWire) => void;
  'user.disconnect_token_expired': () => void;
  'price.update': (payload: PriceUpdateWire) => void;
  'common.assets_list': (payload: BinaryPairWire[]) => void;
  'common.assets_update': (payload: AssetsUpdateWire) => void;
  'user.data': (payload: BrokerUserWire) => void;
  'user.demo.open_trade.success': (payload: OpenTradeWire) => void;
  'user.real.open_trade.success': (payload: OpenTradeWire) => void;
  'user.demo.open_trade.fail': (payload: OpenTradeFailWire) => void;
  'user.real.open_trade.fail': (payload: OpenTradeFailWire) => void;
  'user.demo.close_trade.success': (payload: CloseTradeSuccessWire) => void;
  'user.real.close_trade.success': (payload: CloseTradeSuccessWire) => void;
  'user.demo.update_balance': (payload: BrokerBalanceWire) => void;
  'user.real.update_balance': (payload: BrokerBalanceWire) => void;
}

export interface BrokerClientToServerEvents {
  'user.auth': (payload: UserAuthWire) => void;
  'price.subscribe': (payload: PriceSubscribeWire) => void;
  'user.demo.open_trade': (payload: SocketOpenTradeRequestWire) => void;
  'user.real.open_trade': (payload: SocketOpenTradeRequestWire) => void;
}

// --- Payload decoding (#8 §1.7) ---------------------------------------------------------------

export class SocketPayloadDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SocketPayloadDecodeError';
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new SocketPayloadDecodeError('socket payload is not valid JSON', { cause });
  }
}

function decodeBytes(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw new SocketPayloadDecodeError('socket payload is not valid UTF-8', { cause });
  }
}

function isByteEnvelope(value: unknown): value is { data: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    Array.isArray((value as { data: unknown }).data)
  );
}

// JSON string, ArrayBuffer, any TypedArray/DataView (respecting its byte offset), or a
// { data: number[] } byte envelope → parsed JSON; anything else is treated as already decoded
export function decodeSocketPayload(raw: unknown): unknown {
  if (typeof raw === 'string') return parseJson(raw);
  if (raw instanceof ArrayBuffer) return parseJson(decodeBytes(new Uint8Array(raw)));
  if (ArrayBuffer.isView(raw)) {
    return parseJson(decodeBytes(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)));
  }
  if (isByteEnvelope(raw)) {
    const bytes = raw.data;
    if (!bytes.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)) {
      throw new SocketPayloadDecodeError('socket byte envelope contains non-byte values');
    }
    return parseJson(decodeBytes(Uint8Array.from(bytes as number[])));
  }
  return raw;
}

export type SafeDecodeResult =
  { ok: true; value: unknown } | { ok: false; error: SocketPayloadDecodeError };

export function safeDecodeSocketPayload(raw: unknown): SafeDecodeResult {
  try {
    return { ok: true, value: decodeSocketPayload(raw) };
  } catch (error) {
    if (error instanceof SocketPayloadDecodeError) return { ok: false, error };
    return {
      ok: false,
      error: new SocketPayloadDecodeError('socket payload decoding failed', { cause: error }),
    };
  }
}

// --- Parsers (decoded payload → domain) ------------------------------------------------------

export const parseUserAuthError = (input: unknown): UserAuthErrorWire =>
  userAuthErrorWireSchema.parse(input);
export const parsePriceUpdate = (input: unknown): PriceUpdate =>
  toPriceUpdate(priceUpdateWireSchema.parse(input));
export const safeParsePriceUpdate = (input: unknown) => priceUpdateWireSchema.safeParse(input);
export const parseAssetsList = (input: unknown): BinaryPair[] =>
  assetsListWireSchema.parse(input).map(toBinaryPair);
export const parseAssetsUpdate = (input: unknown): AssetsUpdate =>
  toAssetsUpdate(assetsUpdateWireSchema.parse(input));
export const safeParseAssetsUpdate = (input: unknown) => assetsUpdateWireSchema.safeParse(input);
export const parseSocketOpenTradeSuccess = (input: unknown): OpenTrade =>
  toOpenTrade(openTradeWireSchema.parse(input));
export const parseOpenTradeFail = (input: unknown): OpenTradeFailure[] =>
  toOpenTradeFailures(openTradeFailWireSchema.parse(input));
export const parseCloseTradeSuccess = (input: unknown): ClosedTrade[] =>
  closeTradeSuccessWireSchema.parse(input).trades.map(toClosedTrade);
export const parseUpdateBalance = (input: unknown): BrokerBalance =>
  toBrokerBalance(brokerBalanceWireSchema.parse(input));
export const parseUserData = (input: unknown): BrokerUser =>
  toBrokerUser(brokerUserWireSchema.parse(input));
