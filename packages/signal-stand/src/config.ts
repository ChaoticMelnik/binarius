import {
  BROKER_RATE_LIMIT_PER_MINUTE,
  H1_ENTRY_WINDOW_SEC,
  H1_EXPIRY_SEC,
  H1_MIN_PAYOUT_PCT,
} from '@binarius/shared';

// docs/signal-stand.md is the method; every number below is quoted there by name. The fourth
// command, h1 (#667), replays the H1 detector on the 1s series over the grid at the end.

export const STAND_PAGE_LIMIT = 5_000;
export const STAND_DEFAULT_GETS_PER_MINUTE = 120;
export const STAND_DEFAULT_DAYS = 14;
// the broker's history depth observed on 2026-10-15 (1s and 5s from 720 h back)
export const STAND_MAX_DAYS = 30;

// the price series: a stand constant, not a SignalInterval (no decider ever reads 1s candles)
export const PRICE_INTERVAL = '1s';
export const PRICE_STEP_MS = 1_000;

// the trade intervals the stand decides on, with the trade each one models
export const TRADE_INTERVALS = {
  '5s': { intervalMs: 5_000, durationSec: 5 },
  '15s': { intervalMs: 15_000, durationSec: 15 },
  '1m': { intervalMs: 60_000, durationSec: 60 },
} as const;
export type TradeInterval = keyof typeof TRADE_INTERVALS;
export const FETCH_INTERVALS = [PRICE_INTERVAL, '5s', '15s', '1m'] as const;

// openDelay counts from the decision moment D (a boundary + DECISION_SLACK_MS): 0 is the open
// inside D's own second (the expected case), 1 000 the open in the next second, 3 000 a late entry
// kept as a sensitivity point, never the expected headline
export const OPEN_DELAY_GRID_MS = [0, 1_000, 3_000] as const;
// used when calibrate has not run: the live open is D + 0.4 s (median, p95 0.93 s), inside D's 1 s
// bucket; calibrate chooses from the grid
export const FALLBACK_HEADLINE_DELAY_MS = 0;

// Copied from apps/trading-worker/src/trading-session/config.ts, which a package cannot import:
// TRADING_SESSION_CANDLE_SLACK_MS, TRADING_SESSION_TICK_MS, TRADING_SESSION_ATTEMPT_TIMEOUT_MS.
export const DECISION_SLACK_MS = 2_000;
export const SETTLE_TICK_MS = 5_000;
export const ATTEMPT_WINDOW_MS = 10_000;

export const IN_SAMPLE_SHARE = 5 / 7;
export const MIN_IN_SAMPLE_TRADES = 100;
export const POOLED_BREAK_EVEN_PAYOUT = 80;
// #483's product floor, fixed before the data: a filter keeping fewer of v2's trades empties
// «Сигналы сейчас», so it cannot be `better` whatever its rate
export const MIN_KEPT_SHARE_PCT = 10;

// #379's merge (2026-10-09 16:13 UTC); the deploy time is not known, so the evening of 10-09 is
// neither era
export const V2_MERGED_AT = Date.UTC(2026, 9, 9, 16, 13);
export const V2_FIRST_CLEAN_AT = Date.UTC(2026, 9, 10);
// set from one sample: 443/494 on 2026-10-15
export const CALIBRATE_MIN_OUTCOME_MATCH_PCT = 85;
export const CALIBRATE_MIN_ERA_TRADES = 30;
export const PRICE_SHIFT_GRID_MS = [-1_000, 0, 1_000] as const;

// the 28 pairs of 2026-10-15: the 27 the live sessions traded and the plan's ten (symbols, types
// and payouts: docs/signal-stand.md -> Pairs; the stand reads them only from pairs.json)
export const STAND_ASSET_IDS: readonly number[] = [
  237831086, 364060136, 759228819, 1430524430, 1605169136, 1775154181, 2025372713, 170776436,
  902971489, 210684974, 1357020902, 1492698122, 1493041974, 1560777949, 561905183, 993131238,
  202036987, 901627288, 905901932, 1080246146, 1786057035, 1988152589, 37439809, 539345642,
  727957842, 1202345528, 1798757939, 2126847458,
];

// H1 (#667): the backtest's two thresholds, the ends of the entry window and the expiry with a
// longer one kept as a sensitivity point
export const H1_THRESHOLD_GRID = [1, 2] as const;
export const H1_ENTRY_DELAY_GRID_SEC = [H1_ENTRY_WINDOW_SEC.from, H1_ENTRY_WINDOW_SEC.to] as const;
export const H1_EXPIRY_GRID_SEC = [H1_EXPIRY_SEC, 15] as const;
export const H1_POOLED_PAYOUTS = { h1: H1_MIN_PAYOUT_PCT, all: POOLED_BREAK_EVEN_PAYOUT } as const;

// The stand runs from its own IP outside the three budgeted loops, but a dev stack polling the
// broker from the same machine shares that IP's window: the default leaves it four fifths.
export const STAND_CHAIN_HOLDS = STAND_DEFAULT_GETS_PER_MINUTE < BROKER_RATE_LIMIT_PER_MINUTE;
if (!STAND_CHAIN_HOLDS) {
  throw new RangeError(
    `signal stand: STAND_DEFAULT_GETS_PER_MINUTE (${STAND_DEFAULT_GETS_PER_MINUTE}) must be below BROKER_RATE_LIMIT_PER_MINUTE (${BROKER_RATE_LIMIT_PER_MINUTE})`,
  );
}
