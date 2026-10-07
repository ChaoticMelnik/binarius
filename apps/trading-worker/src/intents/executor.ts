import type { OpenTrade, TradeIntentFailureReason, TradeTransport } from '@binarius/shared';
import type { TradeIntentRow } from '@binarius/db';

export type SubmitResult =
  | { outcome: 'accepted'; transport: TradeTransport; trade: OpenTrade }
  | { outcome: 'rejected'; reason: TradeIntentFailureReason; detail?: string }
  | { outcome: 'unknown'; reason: TradeIntentFailureReason; detail?: string };

// The port createTradeCommandExecutor (#100) implements. Contract:
// - resolve with an explicit outcome; `rejected` only when the order certainly did not open,
//   `unknown` whenever it may have (sent, then no answer);
// - `accepted` carries the broker's open trade as received (open_trade.success or the REST
//   body), never a locally built one: the processor checks it against the intent and stores it
//   (#17), and a trade that does not match turns the intent unknown (trade_mismatch);
// - stop waiting when `signal` aborts (the processor enforces its own deadline regardless);
// - `detail` is for logs only: no tokens, no raw broker payloads.
// A throw is treated as `unknown`: the processor cannot know whether the order went out. Only
// the error's name and code reach the log, never its message or stack — a client library's
// error can embed headers or a response body — so a throw carries no diagnostic detail; put
// that in `detail` of an explicit `unknown` result instead.
export interface TradeExecutor {
  submit(intent: TradeIntentRow, signal: AbortSignal): Promise<SubmitResult>;
}
