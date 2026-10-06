import type { Candle } from '@binarius/shared';
import { SIGNAL_ALGORITHM_VERSION, type SignalParams } from './config';
import { createSignalDecider, type SignalDecision } from './decide';
import type { SignalInterval } from './feed-config';

// volume is never read by the decider, so the line does not carry it
export type JournalCandle = readonly [
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
];

export interface SignalJournalFetch {
  startTime: number;
  limit: number;
  rows: number;
  durationMs: number;
}

// Everything the decision was computed from: replaySignalJournalEntry recomputes it from this alone.
export interface SignalJournalEntry {
  assetId: number;
  interval: SignalInterval;
  intervalMs: number;
  nowMs: number;
  fetch: SignalJournalFetch;
  version: typeof SIGNAL_ALGORITHM_VERSION;
  params: Readonly<SignalParams>;
  series: readonly JournalCandle[];
  decision: SignalDecision;
}

export function toJournalCandle(candle: Candle): JournalCandle {
  return [candle.timestamp, candle.open, candle.high, candle.low, candle.close];
}

export function fromJournalCandle([timestamp, open, high, low, close]: JournalCandle): Candle {
  return { timestamp, open, high, low, close };
}

export function replaySignalJournalEntry(entry: SignalJournalEntry): SignalDecision {
  // a line of another version cannot be re-decided by this code without silently changing it
  if (entry.version !== SIGNAL_ALGORITHM_VERSION) {
    throw new RangeError(
      `signal journal: entry version ${String(entry.version)} is not ${SIGNAL_ALGORITHM_VERSION}`,
    );
  }
  return createSignalDecider(entry.params).decide({
    candles: entry.series.map(fromJournalCandle),
    intervalMs: entry.intervalMs,
    nowMs: entry.nowMs,
  });
}
