// The broker socket client's time constants, each bounding one operation:
//   BROKER_SOCKET_CONNECT_TIMEOUT_MS     — the engine open of one attempt: the WebSocket upgrade
//                                          and the engine.io handshake (socket.io `timeout`); the
//                                          namespace CONNECT after it is not bounded by socket.io
//   BROKER_SOCKET_AUTH_TIMEOUT_MS        — user.auth sent → user.auth.success received; live
//                                          ~50 ms (2026-10-03), the same bound as one REST call
//   BROKER_SOCKET_COMMAND_TIMEOUT_MS     — user.<mode>.open_trade sent → its answer
//                                          (open_trade.success / fail) on the same connection;
//                                          the same bound as one REST call
//   BROKER_SOCKET_RECONNECT_DELAY_MS     — the first wait between attempts (`reconnectionDelay`)
//   BROKER_SOCKET_RECONNECT_DELAY_MAX_MS — the longest wait between attempts
//                                          (`reconnectionDelayMax`)
//   BROKER_SOCKET_RECONNECT_JITTER       — the randomisation of each wait (`randomizationFactor`)
// The chain: every *_MS is an integer in [1, MAX_TIMER_MS], the first wait does not exceed the
// longest one, a handshake is not allowed longer than a connection attempt, and the jitter is in
// [0, 1) — at 1 a wait could shrink to 0. The command timeout is a separate operation, not ordered
// against the others here. The links to the worker's shutdown budget and to the submit deadline's
// floor are in intents/config.ts.
export const BROKER_SOCKET_CONNECT_TIMEOUT_MS = 10_000;
export const BROKER_SOCKET_AUTH_TIMEOUT_MS = 5_000;
export const BROKER_SOCKET_COMMAND_TIMEOUT_MS = 5_000;
export const BROKER_SOCKET_RECONNECT_DELAY_MS = 1_000;
export const BROKER_SOCKET_RECONNECT_DELAY_MAX_MS = 10_000;
export const BROKER_SOCKET_RECONNECT_JITTER = 0.5;

export interface BrokerSocketTiming {
  connectTimeoutMs: number;
  authTimeoutMs: number;
  commandTimeoutMs: number;
  reconnectDelayMs: number;
  reconnectDelayMaxMs: number;
  jitter: number;
}

export const DEFAULT_BROKER_SOCKET_TIMING: Readonly<BrokerSocketTiming> = {
  connectTimeoutMs: BROKER_SOCKET_CONNECT_TIMEOUT_MS,
  authTimeoutMs: BROKER_SOCKET_AUTH_TIMEOUT_MS,
  commandTimeoutMs: BROKER_SOCKET_COMMAND_TIMEOUT_MS,
  reconnectDelayMs: BROKER_SOCKET_RECONNECT_DELAY_MS,
  reconnectDelayMaxMs: BROKER_SOCKET_RECONNECT_DELAY_MAX_MS,
  jitter: BROKER_SOCKET_RECONNECT_JITTER,
};

// Node's setTimeout limit: a longer delay fires after 1 ms, and socket.io's backoff truncates its
// waits to 32 bits
export const MAX_TIMER_MS = 2 ** 31 - 1;

export const isTimerMs = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMER_MS;

export function brokerSocketTimingHolds(timing: BrokerSocketTiming): boolean {
  return (
    isTimerMs(timing.connectTimeoutMs) &&
    isTimerMs(timing.authTimeoutMs) &&
    isTimerMs(timing.commandTimeoutMs) &&
    isTimerMs(timing.reconnectDelayMs) &&
    isTimerMs(timing.reconnectDelayMaxMs) &&
    Number.isFinite(timing.jitter) &&
    timing.reconnectDelayMs <= timing.reconnectDelayMaxMs &&
    timing.authTimeoutMs <= timing.connectTimeoutMs &&
    timing.jitter >= 0 &&
    timing.jitter < 1
  );
}

// a constant edited out of order fails at import, not on the first reconnect in prod
const BROKER_SOCKET_TIMING_CHAIN_HOLDS = brokerSocketTimingHolds(DEFAULT_BROKER_SOCKET_TIMING);
if (!BROKER_SOCKET_TIMING_CHAIN_HOLDS) {
  throw new Error('broker socket timing constants are out of order (see broker/socket-config.ts)');
}

// an override (tests shorten every wait) is held to the same chain
export function resolveBrokerSocketTiming(
  override: Partial<BrokerSocketTiming> = {},
): BrokerSocketTiming {
  const timing = { ...DEFAULT_BROKER_SOCKET_TIMING, ...override };
  if (!brokerSocketTimingHolds(timing)) {
    throw new RangeError('broker socket timing is out of order (see broker/socket-config.ts)');
  }
  return timing;
}
