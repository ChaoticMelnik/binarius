import {
  safeDecodeSocketPayload,
  safeParseAssetsList,
  safeParseAssetsUpdate,
  safeParseCloseTradeSuccess,
  safeParseOpenTradeFail,
  safeParsePriceUpdate,
  safeParseSocketOpenTradeSuccess,
  safeParseUpdateBalance,
  safeParseUserAuthError,
  safeParseUserData,
  toAssetsUpdate,
  toBinaryPair,
  toBrokerBalance,
  toBrokerUser,
  toOpenTradeFailures,
  toPriceUpdate,
  toSocketClosedTrade,
  toSocketOpenTrade,
  TradeMode,
  type AssetsUpdate,
  type BinaryPair,
  type BinaryPairWire,
  type BrokerBalance,
  type BrokerServerToClientEvents,
  type BrokerUser,
  type CloseTradeSuccessWire,
  type ClosedTrade,
  type OpenTrade,
  type OpenTradeFailure,
  type PriceUpdate,
  type UserAuthErrorWire,
} from '@binarius/shared';

export const BrokerEventType = {
  AuthSuccess: 'auth_success',
  AuthError: 'auth_error',
  TokenExpired: 'token_expired',
  PriceUpdate: 'price_update',
  AssetsList: 'assets_list',
  AssetsUpdate: 'assets_update',
  UserData: 'user_data',
  OpenTradeSuccess: 'open_trade_success',
  OpenTradeFail: 'open_trade_fail',
  CloseTradeSuccess: 'close_trade_success',
  BalanceUpdate: 'balance_update',
} as const;
export type BrokerEventType = (typeof BrokerEventType)[keyof typeof BrokerEventType];

export type BrokerEvent =
  | { type: typeof BrokerEventType.AuthSuccess }
  | { type: typeof BrokerEventType.AuthError; message: string }
  | { type: typeof BrokerEventType.TokenExpired }
  | { type: typeof BrokerEventType.PriceUpdate; update: PriceUpdate }
  | { type: typeof BrokerEventType.AssetsList; pairs: BinaryPair[] }
  | { type: typeof BrokerEventType.AssetsUpdate; update: AssetsUpdate }
  | { type: typeof BrokerEventType.UserData; user: BrokerUser }
  | { type: typeof BrokerEventType.OpenTradeSuccess; mode: TradeMode; trade: OpenTrade }
  | { type: typeof BrokerEventType.OpenTradeFail; mode: TradeMode; failures: OpenTradeFailure[] }
  | { type: typeof BrokerEventType.CloseTradeSuccess; mode: TradeMode; trades: ClosedTrade[] }
  | { type: typeof BrokerEventType.BalanceUpdate; mode: TradeMode; balance: BrokerBalance };

export const BrokerEventProblemKind = {
  UnknownEvent: 'unknown_event',
  MissingPayload: 'missing_payload',
  Decode: 'decode',
  Schema: 'schema',
} as const;
export type BrokerEventProblemKind =
  (typeof BrokerEventProblemKind)[keyof typeof BrokerEventProblemKind];

export interface BrokerEventIssue {
  code: string;
  path: string;
}

// plain data on purpose: no Error, no message, no payload value, so a caller may log it whole
export type BrokerEventProblem =
  | {
      kind:
        | typeof BrokerEventProblemKind.UnknownEvent
        | typeof BrokerEventProblemKind.MissingPayload
        | typeof BrokerEventProblemKind.Decode;
      event: string;
    }
  | {
      kind: typeof BrokerEventProblemKind.Schema;
      event: string;
      issues: BrokerEventIssue[];
      issueCount: number;
      // the refused payload's keys and types (describeShape), never a value
      shape: string;
    };

export type NormalizedBrokerEvent =
  | { ok: true; event: BrokerEvent; extraArgs: number }
  | { ok: false; problem: BrokerEventProblem; extraArgs: number };

export const MAX_EVENT_NAME_LENGTH = 100;
export const MAX_REPORTED_ISSUES = 10;

interface WireIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
}

type SafeParseResult<W> =
  { success: true; data: W } | { success: false; error: { readonly issues: readonly WireIssue[] } };

type ParseOutcome = { ok: true; event: BrokerEvent } | { ok: false; issues: readonly WireIssue[] };

type Handler =
  | {
      payload: false;
      type: typeof BrokerEventType.AuthSuccess | typeof BrokerEventType.TokenExpired;
    }
  | { payload: true; parse: (decoded: unknown) => ParseOutcome };

function payloadHandler<W>(
  safeParse: (input: unknown) => SafeParseResult<W>,
  toEvent: (wire: W) => BrokerEvent,
): Handler {
  return {
    payload: true,
    parse: (decoded) => {
      const result = safeParse(decoded);
      return result.success
        ? { ok: true, event: toEvent(result.data) }
        : { ok: false, issues: result.error.issues };
    },
  };
}

const openTradeSuccess = (mode: TradeMode): Handler =>
  payloadHandler(safeParseSocketOpenTradeSuccess, (wire) => ({
    type: BrokerEventType.OpenTradeSuccess,
    mode,
    trade: toSocketOpenTrade(wire, mode),
  }));

const openTradeFail = (mode: TradeMode): Handler =>
  payloadHandler(safeParseOpenTradeFail, (wire) => ({
    type: BrokerEventType.OpenTradeFail,
    mode,
    failures: toOpenTradeFailures(wire),
  }));

const closeTradeSuccess = (mode: TradeMode): Handler =>
  payloadHandler(safeParseCloseTradeSuccess, (wire: CloseTradeSuccessWire) => ({
    type: BrokerEventType.CloseTradeSuccess,
    mode,
    trades: wire.trades.map((trade) => toSocketClosedTrade(trade, mode)),
  }));

const balanceUpdate = (mode: TradeMode): Handler =>
  payloadHandler(safeParseUpdateBalance, (wire) => ({
    type: BrokerEventType.BalanceUpdate,
    mode,
    balance: toBrokerBalance(wire),
  }));

// literal keys checked by `satisfies`: a server→client event added to shared fails tsc here
const HANDLERS = {
  'user.auth.success': { payload: false, type: BrokerEventType.AuthSuccess },
  // the wire object is loose; only message is kept so extra broker keys never reach a log
  'user.auth.error': payloadHandler(safeParseUserAuthError, (wire: UserAuthErrorWire) => ({
    type: BrokerEventType.AuthError,
    message: wire.message,
  })),
  'user.disconnect_token_expired': { payload: false, type: BrokerEventType.TokenExpired },
  'price.update': payloadHandler(safeParsePriceUpdate, (wire) => ({
    type: BrokerEventType.PriceUpdate,
    update: toPriceUpdate(wire),
  })),
  'common.assets_list': payloadHandler(safeParseAssetsList, (wire: BinaryPairWire[]) => ({
    type: BrokerEventType.AssetsList,
    pairs: wire.map(toBinaryPair),
  })),
  'common.assets_update': payloadHandler(safeParseAssetsUpdate, (wire) => ({
    type: BrokerEventType.AssetsUpdate,
    update: toAssetsUpdate(wire),
  })),
  'user.data': payloadHandler(safeParseUserData, (wire) => ({
    type: BrokerEventType.UserData,
    user: toBrokerUser(wire),
  })),
  'user.demo.open_trade.success': openTradeSuccess(TradeMode.Demo),
  'user.real.open_trade.success': openTradeSuccess(TradeMode.Real),
  'user.demo.open_trade.fail': openTradeFail(TradeMode.Demo),
  'user.real.open_trade.fail': openTradeFail(TradeMode.Real),
  'user.demo.close_trade.success': closeTradeSuccess(TradeMode.Demo),
  'user.real.close_trade.success': closeTradeSuccess(TradeMode.Real),
  'user.demo.update_balance': balanceUpdate(TradeMode.Demo),
  'user.real.update_balance': balanceUpdate(TradeMode.Real),
} satisfies Record<keyof BrokerServerToClientEvents, Handler>;

const isKnownEvent = (event: string): event is keyof typeof HANDLERS =>
  Object.hasOwn(HANDLERS, event);

const SHAPE_MAX_DEPTH = 3;
export const SHAPE_MAX_KEYS = 20;
export const SHAPE_MAX_KEY_LENGTH = 40;
export const SHAPE_MAX_LENGTH = 600;

// What a payload the schema refused looks like (#354): the types of its values, arrays by their
// length and first element, objects by their sorted keys — never a value, so the problem can be
// logged whole. A key name is the broker's text and stays: no user data travels in it.
export function describeShape(value: unknown): string {
  return shapeOf(value, 0).slice(0, SHAPE_MAX_LENGTH);
}

function shapeOf(value: unknown, depth: number): string {
  if (value === null) return 'null';
  // a binary attachment by its size: its indices would be one key per byte
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `bytes[${value.byteLength}]`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[0]';
    return depth >= SHAPE_MAX_DEPTH
      ? `[${value.length}]`
      : `[${value.length}: ${shapeOf(value[0], depth + 1)}]`;
  }
  if (typeof value === 'object') {
    if (depth >= SHAPE_MAX_DEPTH) return '{…}';
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const shown = keys
      .slice(0, SHAPE_MAX_KEYS)
      .map((key) => `${key.slice(0, SHAPE_MAX_KEY_LENGTH)}: ${shapeOf(record[key], depth + 1)}`);
    const more = keys.length > SHAPE_MAX_KEYS ? [`…+${keys.length - SHAPE_MAX_KEYS}`] : [];
    return `{${[...shown, ...more].join(', ')}}`;
  }
  return typeof value;
}

function schemaProblem(
  event: string,
  issues: readonly WireIssue[],
  decoded: unknown,
): BrokerEventProblem {
  return {
    kind: BrokerEventProblemKind.Schema,
    event,
    issues: issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join('.'),
    })),
    issueCount: issues.length,
    shape: describeShape(decoded),
  };
}

// takes what socket.onAny hands over; reads args[0] only and never calls a trailing ack
export function normalizeBrokerEvent(
  event: string,
  args: readonly unknown[],
): NormalizedBrokerEvent {
  const name = event.slice(0, MAX_EVENT_NAME_LENGTH);
  if (!isKnownEvent(event)) {
    return {
      ok: false,
      problem: { kind: BrokerEventProblemKind.UnknownEvent, event: name },
      extraArgs: args.length,
    };
  }
  const handler: Handler = HANDLERS[event];
  if (!handler.payload) {
    // the live broker sends user.auth.success as [null]: a null/undefined first argument is
    // "no payload", so only a real value there counts as extra
    const extraArgs = args.length > 0 && args[0] == null ? args.length - 1 : args.length;
    return { ok: true, event: { type: handler.type }, extraArgs };
  }
  const extraArgs = Math.max(args.length - 1, 0);
  if (args[0] === undefined) {
    return {
      ok: false,
      problem: { kind: BrokerEventProblemKind.MissingPayload, event: name },
      extraArgs,
    };
  }
  const decoded = safeDecodeSocketPayload(args[0]);
  if (!decoded.ok) {
    return { ok: false, problem: { kind: BrokerEventProblemKind.Decode, event: name }, extraArgs };
  }
  const parsed = handler.parse(decoded.value);
  if (!parsed.ok) {
    return { ok: false, problem: schemaProblem(name, parsed.issues, decoded.value), extraArgs };
  }
  return { ok: true, event: parsed.event, extraArgs };
}
