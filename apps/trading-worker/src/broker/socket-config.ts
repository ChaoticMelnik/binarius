// The broker socket client's time constants, each bounding one operation:
//   BROKER_SOCKET_CONNECT_TIMEOUT_MS     — the engine open of one attempt: the WebSocket upgrade
//                                          and the engine.io handshake (socket.io `timeout`); the
//                                          namespace CONNECT after it is not bounded by socket.io
//   BROKER_SOCKET_AUTH_TIMEOUT_MS        — user.auth sent → user.auth.success received; live
//                                          ~50 ms (2026-10-03), the same bound as one REST call
//   BROKER_SOCKET_RECONNECT_DELAY_MS     — the first wait between attempts (`reconnectionDelay`)
//   BROKER_SOCKET_RECONNECT_DELAY_MAX_MS — the longest wait between attempts
//                                          (`reconnectionDelayMax`)
//   BROKER_SOCKET_RECONNECT_JITTER       — the randomisation of each wait (`randomizationFactor`)
// The chain: every *_MS is a positive integer, the first wait does not exceed the longest one, a
// handshake is not allowed longer than a connection attempt, and the jitter is a factor socket.io
// accepts. The link to the
// worker's shutdown budget comes with the client's place in index.ts (#101).
export const BROKER_SOCKET_CONNECT_TIMEOUT_MS = 10_000;
export const BROKER_SOCKET_AUTH_TIMEOUT_MS = 5_000;
export const BROKER_SOCKET_RECONNECT_DELAY_MS = 1_000;
export const BROKER_SOCKET_RECONNECT_DELAY_MAX_MS = 10_000;
export const BROKER_SOCKET_RECONNECT_JITTER = 0.5;

export interface BrokerSocketTiming {
  connectTimeoutMs: number;
  authTimeoutMs: number;
  reconnectDelayMs: number;
  reconnectDelayMaxMs: number;
  jitter: number;
}

export const DEFAULT_BROKER_SOCKET_TIMING: Readonly<BrokerSocketTiming> = {
  connectTimeoutMs: BROKER_SOCKET_CONNECT_TIMEOUT_MS,
  authTimeoutMs: BROKER_SOCKET_AUTH_TIMEOUT_MS,
  reconnectDelayMs: BROKER_SOCKET_RECONNECT_DELAY_MS,
  reconnectDelayMaxMs: BROKER_SOCKET_RECONNECT_DELAY_MAX_MS,
  jitter: BROKER_SOCKET_RECONNECT_JITTER,
};

const isPositiveMs = (value: number) => Number.isSafeInteger(value) && value > 0;

export function brokerSocketTimingHolds(timing: BrokerSocketTiming): boolean {
  return (
    isPositiveMs(timing.connectTimeoutMs) &&
    isPositiveMs(timing.authTimeoutMs) &&
    isPositiveMs(timing.reconnectDelayMs) &&
    isPositiveMs(timing.reconnectDelayMaxMs) &&
    Number.isFinite(timing.jitter) &&
    timing.reconnectDelayMs <= timing.reconnectDelayMaxMs &&
    timing.authTimeoutMs <= timing.connectTimeoutMs &&
    timing.jitter >= 0 &&
    timing.jitter <= 1
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
