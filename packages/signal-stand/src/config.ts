import { BROKER_RATE_LIMIT_PER_MINUTE } from '@binarius/shared';

// docs/signal-stand.md is the method; every number below is quoted there by name.

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
} as const;
export type TradeInterval = keyof typeof TRADE_INTERVALS;
export const FETCH_INTERVALS = [PRICE_INTERVAL, '5s', '15s', '1m'] as const;

export const OPEN_DELAY_GRID_MS = [0, 1_000, 3_000] as const;
// the plan's live estimate (2 s slack + 0.5-1 s open), used when calibrate has not run
export const FALLBACK_HEADLINE_DELAY_MS = 3_000;

// Copied from apps/trading-worker/src/trading-session/config.ts, which a package cannot import:
// TRADING_SESSION_CANDLE_SLACK_MS, TRADING_SESSION_TICK_MS.
export const DECISION_SLACK_MS = 2_000;
export const SETTLE_TICK_MS = 5_000;

export const IN_SAMPLE_SHARE = 5 / 7;
export const MIN_IN_SAMPLE_TRADES = 100;
export const POOLED_BREAK_EVEN_PAYOUT = 80;

// the 28 pairs of 2026-10-15: the 27 the live sessions traded and the plan's ten (symbols, types
// and payouts: docs/signal-stand.md -> Pairs; the stand reads them only from pairs.json)
export const STAND_ASSET_IDS: readonly number[] = [
  237831086, 364060136, 759228819, 1430524430, 1605169136, 1775154181, 2025372713, 170776436,
  902971489, 210684974, 1357020902, 1492698122, 1493041974, 1560777949, 561905183, 993131238,
  202036987, 901627288, 905901932, 1080246146, 1786057035, 1988152589, 37439809, 539345642,
  727957842, 1202345528, 1798757939, 2126847458,
];

// The stand runs from its own IP outside the three budgeted loops, but a dev stack polling the
// broker from the same machine shares that IP's window: the default leaves it four fifths.
export const STAND_CHAIN_HOLDS = STAND_DEFAULT_GETS_PER_MINUTE < BROKER_RATE_LIMIT_PER_MINUTE;
if (!STAND_CHAIN_HOLDS) {
  throw new RangeError(
    `signal stand: STAND_DEFAULT_GETS_PER_MINUTE (${STAND_DEFAULT_GETS_PER_MINUTE}) must be below BROKER_RATE_LIMIT_PER_MINUTE (${BROKER_RATE_LIMIT_PER_MINUTE})`,
  );
}
