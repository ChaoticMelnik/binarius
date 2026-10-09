import {
  SIGNAL_ALGORITHM_VERSIONS,
  type Candle,
  type SignalDecision,
  type SignalDecisionV1,
  type SignalInterval,
  type SignalParams,
  type SignalParamsV1,
} from '@binarius/shared';
import { createSignalDecider, createSignalDeciderV1 } from './decide';

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

interface SignalJournalEntryBase {
  assetId: number;
  interval: SignalInterval;
  intervalMs: number;
  nowMs: number;
  fetch: SignalJournalFetch;
  series: readonly JournalCandle[];
}

// Everything the decision was computed from: replaySignalJournalEntry recomputes it from this alone.
// The feed writes the current version; a line of an older one stays replayable (#379).
export interface SignalJournalEntry extends SignalJournalEntryBase {
  version: 'v2';
  digits: number;
  params: Readonly<SignalParams>;
  decision: SignalDecision;
}

export interface SignalJournalEntryV1 extends SignalJournalEntryBase {
  version: 'v1';
  params: Readonly<SignalParamsV1>;
  decision: SignalDecisionV1;
}

export type StoredSignalJournalEntry = SignalJournalEntry | SignalJournalEntryV1;

export function toJournalCandle(candle: Candle): JournalCandle {
  return [candle.timestamp, candle.open, candle.high, candle.low, candle.close];
}

export function fromJournalCandle([timestamp, open, high, low, close]: JournalCandle): Candle {
  return { timestamp, open, high, low, close };
}

// Each line is re-decided by the rules of its own version, never by the current decider.
export function replaySignalJournalEntry(entry: SignalJournalEntry): SignalDecision;
export function replaySignalJournalEntry(entry: SignalJournalEntryV1): SignalDecisionV1;
export function replaySignalJournalEntry(
  entry: StoredSignalJournalEntry,
): SignalDecision | SignalDecisionV1;
export function replaySignalJournalEntry(
  entry: StoredSignalJournalEntry,
): SignalDecision | SignalDecisionV1 {
  const candles = entry.series.map(fromJournalCandle);
  const { intervalMs, nowMs } = entry;
  switch (entry.version) {
    case 'v1':
      return createSignalDeciderV1(entry.params).decide({ candles, intervalMs, nowMs });
    case 'v2':
      return createSignalDecider(entry.params).decide({
        candles,
        intervalMs,
        nowMs,
        digits: entry.digits,
      });
    default:
      throw new RangeError(
        `signal journal: entry version ${String((entry as { version: unknown }).version)} is not one of ${SIGNAL_ALGORITHM_VERSIONS.join(', ')}`,
      );
  }
}
