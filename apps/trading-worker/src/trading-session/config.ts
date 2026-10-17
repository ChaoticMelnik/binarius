import {
  SESSION_MAX_DURATION_MS,
  SESSION_NO_SIGNAL_TIMEOUT_MS,
  SIGNAL_CHART_INTERVAL_MS,
  SIGNAL_SCAN_INTERVALS,
  SIGNAL_SHORTEST_INTERVAL_MS,
  TRADING_SIGNAL_BUDGET_MS,
} from '@binarius/shared';
import { isTimerMs } from '@binarius/broker-socket';

// The session orchestrator's constants (docs/trading-session.md -> Constants and the chain), each
// bounding one thing:
//   TRADING_SESSION_TICK_MS             — the scan interval: the three stop sweeps, the scan, the attempts
//   TRADING_SESSION_BATCH_SIZE          — runnable sessions attempted per tick, one after another
//   TRADING_SESSION_ATTEMPT_TIMEOUT_MS  — how long the tick waits for one attempt: the pairs GET,
//                                         the signal POST, the statements
//   TRADING_SESSION_PAIRS_TIMEOUT_MS    — the pairs GET (a cache read on the backend)
//   TRADING_SESSION_RETRY_MS            — the hold-back after a transient failure or a throw
//   TRADING_SESSION_CANDLE_SLACK_MS     — how long after a candle boundary the signal is asked
//                                         again after no_signal. The backend's cache keeps a
//                                         decision until the boundary on its own clock; both
//                                         processes run on one host (one kernel clock), so the
//                                         two boundaries agree within the slack
//   SESSION_MAX_DURATION_MS (shared)    — the session's deadline from started_at (database clock);
//                                         the start route and the CLI refuse a session that
//                                         cannot fit it in its strategy's worst case
//                                         (sessionFitsDeadline: cycles × steps per cycle, #552)
//   SESSION_NO_SIGNAL_TIMEOUT_MS (shared) — how long a session waits for a signal before it stops
//                                         with no_signal_timeout (#509), from the later of
//                                         started_at and its last intent's change (database clock)
// The chain: both backend calls fit one attempt (PAIRS + SIGNAL_BUDGET < ATTEMPT); a held-back
// session skips at least one tick (TICK < RETRY); the candle wait never skips a candle
// (SLACK < the shortest interval, 5s since #313); RETRY < NO_SIGNAL < MAX_DURATION, and the
// longest candle the bot offers a session on (the scanner's, 15 s) is shorter than NO_SIGNAL, so
// such a session gets several decisions before the limit; a longer candle (a direct POST or the
// CLI only) may get one or two (accepted risk, docs/trading-session.md -> The no-signal limit);
// every *_MS is an integer in [1, MAX_TIMER_MS].
// The link to the shutdown budget is in intents/config.ts.
export const TRADING_SESSION_TICK_MS = 5_000;
const TRADING_SESSION_BATCH_SIZE = 200;
export const TRADING_SESSION_ATTEMPT_TIMEOUT_MS = 10_000;
export const TRADING_SESSION_PAIRS_TIMEOUT_MS = 4_000;
export const TRADING_SESSION_RETRY_MS = 60_000;
export const TRADING_SESSION_CANDLE_SLACK_MS = 2_000;

export interface SessionOrchestratorConfig {
  tickMs: number;
  batchSize: number;
  attemptTimeoutMs: number;
  retryMs: number;
  candleSlackMs: number;
  maxDurationMs: number;
  noSignalTimeoutMs: number;
}

export const TRADING_SESSION_CONFIG: Readonly<SessionOrchestratorConfig> = Object.freeze({
  tickMs: TRADING_SESSION_TICK_MS,
  batchSize: TRADING_SESSION_BATCH_SIZE,
  attemptTimeoutMs: TRADING_SESSION_ATTEMPT_TIMEOUT_MS,
  retryMs: TRADING_SESSION_RETRY_MS,
  candleSlackMs: TRADING_SESSION_CANDLE_SLACK_MS,
  maxDurationMs: SESSION_MAX_DURATION_MS,
  noSignalTimeoutMs: SESSION_NO_SIGNAL_TIMEOUT_MS,
});

const LONGEST_SCAN_CANDLE_MS = Math.max(
  ...SIGNAL_SCAN_INTERVALS.map((interval) => SIGNAL_CHART_INTERVAL_MS[interval]),
);

export function sessionOrchestratorConfigHolds(
  config: SessionOrchestratorConfig,
  pairsTimeoutMs: number = TRADING_SESSION_PAIRS_TIMEOUT_MS,
): boolean {
  return (
    isTimerMs(config.tickMs) &&
    isTimerMs(config.attemptTimeoutMs) &&
    isTimerMs(config.retryMs) &&
    isTimerMs(config.candleSlackMs) &&
    isTimerMs(config.maxDurationMs) &&
    isTimerMs(config.noSignalTimeoutMs) &&
    isTimerMs(pairsTimeoutMs) &&
    Number.isSafeInteger(config.batchSize) &&
    config.batchSize >= 1 &&
    pairsTimeoutMs + TRADING_SIGNAL_BUDGET_MS < config.attemptTimeoutMs &&
    config.tickMs < config.retryMs &&
    config.candleSlackMs < SIGNAL_SHORTEST_INTERVAL_MS &&
    config.retryMs < config.noSignalTimeoutMs &&
    config.noSignalTimeoutMs < config.maxDurationMs &&
    LONGEST_SCAN_CANDLE_MS < config.noSignalTimeoutMs
  );
}

// a constant edited out of order fails at import, not in production
export const TRADING_SESSION_CHAIN_HOLDS = sessionOrchestratorConfigHolds(TRADING_SESSION_CONFIG);
if (!TRADING_SESSION_CHAIN_HOLDS) {
  throw new Error('trading session constants are out of order (see trading-session/config.ts)');
}
