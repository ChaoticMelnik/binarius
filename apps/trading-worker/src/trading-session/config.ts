import {
  BROKER_BALANCE_SLA_MS,
  SESSION_MAX_DURATION_MS,
  SESSION_NO_SIGNAL_CANDLES,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVALS,
  SIGNAL_SHORTEST_INTERVAL_MS,
} from '@binarius/shared';
import { BROKER_REST_TIMEOUT_MS } from '@binarius/broker-rest';
import { isTimerMs } from '@binarius/broker-socket';

// The session orchestrator's constants (docs/trading-session.md -> Constants and the chain), each
// bounding one thing:
//   TRADING_SESSION_TICK_MS             — the scan interval: the three stop sweeps, the scan, the attempts
//   TRADING_SESSION_BATCH_SIZE          — runnable sessions attempted per tick, one after another
//   TRADING_SESSION_ATTEMPT_TIMEOUT_MS  — how long the tick waits for one attempt: the pairs GET
//                                         and the statements
//   TRADING_SESSION_PAIRS_TIMEOUT_MS    — the pairs GET (a cache read on the backend)
//   TRADING_SESSION_RETRY_MS            — the hold-back after a transient failure or a throw
//   SESSION_MAX_DURATION_MS (shared)    — the session's deadline from started_at (database clock);
//                                         the start route and the CLI refuse a session that
//                                         cannot fit it in its strategy's worst case
//                                         (sessionFitsDeadline: cycles × steps per cycle, #552)
//   TRADING_SESSION_H1_CHECK_MS         — the hold of an H1 session (#670) between the
//                                         orchestrator's checks: its driver opens the trades, the
//                                         orchestrator only stops it (cycles, the sizer, the
//                                         pair, no_signal_timeout - #775)
//   SESSION_NO_SIGNAL_CANDLES (shared)  — how many candles of its duration a session waits on a
//                                         closed pair (the attempt) and without an H1 signal (the
//                                         driver) before no_signal_timeout (#509, in candles since
//                                         #637), from the later of started_at and its last
//                                         intent's change (database clock)
// The chain: the pairs GET fits one attempt (PAIRS < ATTEMPT); a held-back session skips at least
// one tick (TICK < RETRY); an H1 session is checked again no sooner than the next tick and before
// a hold-back would end (TICK <= H1_CHECK < RETRY); the no-signal count is an integer >= 2, so a
// session gets several decisions before the limit; a hold-back never outlives the shortest limit
// (RETRY < NO_SIGNAL x the shortest candle); on the scanner's candles (5 s since #685, the one
// duration an H1 session has) the limit comes before the deadline (NO_SIGNAL x 5 s <
// MAX_DURATION); other durations exist only on v1-v3 rows, which the orchestrator stops
// invalid_settings since #835; NO_SIGNAL x the longest candle (1h) stays a timer value, the bound of the
// SQL ::int cast; the balance wait after a settlement (#696) ends at the no-signal limit counted
// from that settlement, and the backend's REST refresh (its interval at most the SLA) and one GET
// fit before it (BROKER_BALANCE_SLA + BROKER_REST_TIMEOUT < NO_SIGNAL x the shortest candle);
// every *_MS is an integer in [1, MAX_TIMER_MS].
// The link to the shutdown budget is in intents/config.ts.
export const TRADING_SESSION_TICK_MS = 5_000;
const TRADING_SESSION_BATCH_SIZE = 200;
export const TRADING_SESSION_ATTEMPT_TIMEOUT_MS = 10_000;
export const TRADING_SESSION_PAIRS_TIMEOUT_MS = 4_000;
export const TRADING_SESSION_RETRY_MS = 60_000;
export const TRADING_SESSION_H1_CHECK_MS = 5_000;

export interface SessionOrchestratorConfig {
  tickMs: number;
  batchSize: number;
  attemptTimeoutMs: number;
  retryMs: number;
  h1CheckMs: number;
  maxDurationMs: number;
  noSignalCandles: number;
}

export const TRADING_SESSION_CONFIG: Readonly<SessionOrchestratorConfig> = Object.freeze({
  tickMs: TRADING_SESSION_TICK_MS,
  batchSize: TRADING_SESSION_BATCH_SIZE,
  attemptTimeoutMs: TRADING_SESSION_ATTEMPT_TIMEOUT_MS,
  retryMs: TRADING_SESSION_RETRY_MS,
  h1CheckMs: TRADING_SESSION_H1_CHECK_MS,
  maxDurationMs: SESSION_MAX_DURATION_MS,
  noSignalCandles: SESSION_NO_SIGNAL_CANDLES,
});

const LONGEST_SCAN_CANDLE_MS = Math.max(
  ...SIGNAL_SCAN_INTERVALS.map((interval) => SIGNAL_CHART_INTERVAL_MS[interval]),
);
const LONGEST_CANDLE_MS = Math.max(...Object.values(SIGNAL_CHART_INTERVAL_MS));

export function sessionOrchestratorConfigHolds(
  config: SessionOrchestratorConfig,
  pairsTimeoutMs: number = TRADING_SESSION_PAIRS_TIMEOUT_MS,
): boolean {
  return (
    isTimerMs(config.tickMs) &&
    isTimerMs(config.attemptTimeoutMs) &&
    isTimerMs(config.retryMs) &&
    isTimerMs(config.h1CheckMs) &&
    isTimerMs(config.maxDurationMs) &&
    isTimerMs(pairsTimeoutMs) &&
    Number.isSafeInteger(config.batchSize) &&
    config.batchSize >= 1 &&
    pairsTimeoutMs < config.attemptTimeoutMs &&
    config.tickMs < config.retryMs &&
    config.tickMs <= config.h1CheckMs &&
    config.h1CheckMs < config.retryMs &&
    Number.isSafeInteger(config.noSignalCandles) &&
    config.noSignalCandles >= 2 &&
    config.retryMs < config.noSignalCandles * SIGNAL_SHORTEST_INTERVAL_MS &&
    BROKER_BALANCE_SLA_MS + BROKER_REST_TIMEOUT_MS <
      config.noSignalCandles * SIGNAL_SHORTEST_INTERVAL_MS &&
    config.noSignalCandles * LONGEST_SCAN_CANDLE_MS < config.maxDurationMs &&
    isTimerMs(config.noSignalCandles * LONGEST_CANDLE_MS)
  );
}

// a constant edited out of order fails at import, not in production
export const TRADING_SESSION_CHAIN_HOLDS = sessionOrchestratorConfigHolds(TRADING_SESSION_CONFIG);
if (!TRADING_SESSION_CHAIN_HOLDS) {
  throw new Error('trading session constants are out of order (see trading-session/config.ts)');
}
