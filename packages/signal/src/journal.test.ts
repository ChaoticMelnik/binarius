import { readFileSync } from 'node:fs';
import { SIGNAL_ALGORITHM_VERSIONS, type Candle } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_PARAMS } from './config';
import { createSignalDecider, createSignalDeciderV1, type SignalDecider } from './decide';
import { SIGNAL_CHART_LIMIT } from './feed-config';
import {
  fromJournalCandle,
  replaySignalJournalEntry,
  toJournalCandle,
  type SignalJournalEntry,
  type SignalJournalEntryV1,
  type StoredSignalJournalEntry,
} from './journal';
import { burst, closedNow, INTERVAL_MS, mildRise, seriesFrom, trending } from './testing';

const defaultDecider = createSignalDecider();
const DIGITS = 2;

function entryFor(
  candles: readonly Candle[],
  nowMs: number,
  decider: SignalDecider = defaultDecider,
): SignalJournalEntry {
  return {
    assetId: 101,
    interval: '1m',
    digits: DIGITS,
    intervalMs: INTERVAL_MS,
    nowMs,
    fetch: {
      startTime: candles[0]?.timestamp ?? 0,
      limit: SIGNAL_CHART_LIMIT,
      rows: candles.length,
      durationMs: 3,
    },
    version: decider.version,
    params: decider.params,
    series: candles.map(toJournalCandle),
    decision: decider.decide({ candles, intervalMs: INTERVAL_MS, nowMs, digits: DIGITS }),
  };
}

function entryForV1(candles: readonly Candle[], nowMs: number): SignalJournalEntryV1 {
  const decider = createSignalDeciderV1();
  const { assetId, interval, intervalMs, fetch, series } = entryFor(candles, nowMs);
  return {
    assetId,
    interval,
    intervalMs,
    nowMs,
    fetch,
    series,
    version: decider.version,
    params: decider.params,
    decision: decider.decide({ candles, intervalMs: INTERVAL_MS, nowMs }),
  };
}

// what a reader of the log line gets back
const throughLine = <E extends StoredSignalJournalEntry>(entry: E): E =>
  JSON.parse(JSON.stringify(entry)) as E;

const withGap = (): Candle[] => {
  const series = trending(61, 0.5);
  series.splice(30, 1);
  return series;
};

const withNaNClose = (): Candle[] => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + 0.5 * i);
  closes[40] = Number.NaN;
  return seriesFrom(closes);
};

const staleNow = (series: readonly Candle[]): number =>
  closedNow(series) + (DEFAULT_SIGNAL_PARAMS.maxStaleIntervals + 1) * INTERVAL_MS;

describe('signal journal', () => {
  it('J1 a journal candle is a 5-tuple without volume and reads back as the candle without it', () => {
    const candle: Candle = {
      timestamp: 1_760_000_000_000,
      open: 1.1,
      high: 1.3,
      low: 1.0,
      close: 1.2,
      volume: 42,
    };
    const tuple = toJournalCandle(candle);
    expect(tuple).toStrictEqual([1_760_000_000_000, 1.1, 1.3, 1.0, 1.2]);
    expect(fromJournalCandle(tuple)).toStrictEqual({
      timestamp: 1_760_000_000_000,
      open: 1.1,
      high: 1.3,
      low: 1.0,
      close: 1.2,
    });
  });

  const rising = mildRise();
  const flat = seriesFrom(Array<number>(60).fill(100), { wick: 0 });
  const gap = withGap();
  const few = trending(10, 0.5);
  const nan = withNaNClose();
  const variants: [string, SignalJournalEntry, Record<string, unknown>][] = [
    ['a rising series', entryFor(rising, closedNow(rising)), { kind: 'signal', action: 'up' }],
    ['a flat series', entryFor(flat, closedNow(flat)), { reason: 'volatility_too_low' }],
    ['a missing candle', entryFor(gap, closedNow(gap)), { reason: 'candle_gap' }],
    ['ten candles', entryFor(few, closedNow(few)), { reason: 'insufficient_candles' }],
    ['a clock three intervals on', entryFor(rising, staleNow(rising)), { reason: 'stale' }],
    [
      'a non-finite price (null on the line, still non_finite at the same index on replay)',
      entryFor(nan, closedNow(nan)),
      { reason: 'invalid_candle', detail: { index: 40, problem: 'non_finite' } },
    ],
    [
      'a decider with maxAtrPct 0.05',
      entryFor(
        rising,
        closedNow(rising),
        createSignalDecider({ ...DEFAULT_SIGNAL_PARAMS, maxAtrPct: 0.05 }),
      ),
      { reason: 'volatility_too_high' },
    ],
  ];

  it.each(variants)('J2 %s replays from the line to the logged decision', (_, entry, expected) => {
    expect(entry.decision).toMatchObject(expected);
    const line = throughLine(entry);
    expect(replaySignalJournalEntry(line)).toStrictEqual(entry.decision);
  });

  it('J3 an entry of an unknown algorithm version is refused', () => {
    const entry = {
      ...entryFor(rising, closedNow(rising)),
      version: 'v0',
    } as unknown as SignalJournalEntry;
    expect(SIGNAL_ALGORITHM_VERSIONS).not.toContain('v0');
    expect(() => replaySignalJournalEntry(entry)).toThrow(
      new RangeError('signal journal: entry version v0 is not one of v1, v2'),
    );
  });

  // a line the v1 code on main wrote before v2 existed (fixtures/v1-signal-line.json, #379)
  it('J4 a stored v1 line replays to its recorded decision', () => {
    const stored = JSON.parse(
      readFileSync(new URL('./fixtures/v1-signal-line.json', import.meta.url), 'utf8'),
    ) as StoredSignalJournalEntry;
    expect(stored.version).toBe('v1');
    expect(stored.decision).toMatchObject({ kind: 'signal', action: 'up' });
    expect(replaySignalJournalEntry(stored)).toStrictEqual(stored.decision);
  });

  it('J5 one series replays by the rules of each line: v1 signal up, v2 rsi_overbought', () => {
    const series = burst();
    const nowMs = closedNow(series);
    const v1 = throughLine(entryForV1(series, nowMs));
    const v2 = throughLine(entryFor(series, nowMs));
    expect(replaySignalJournalEntry(v1)).toMatchObject({ kind: 'signal', action: 'up' });
    expect(replaySignalJournalEntry(v1)).toStrictEqual(v1.decision);
    expect(replaySignalJournalEntry(v2)).toMatchObject({ reason: 'rsi_overbought' });
    expect(replaySignalJournalEntry(v2)).toStrictEqual(v2.decision);
  });

  it('J6 a v2 line without digits throws instead of deciding', () => {
    const line: Partial<SignalJournalEntry> = throughLine(entryFor(rising, closedNow(rising)));
    delete line.digits;
    expect(() => replaySignalJournalEntry(line as SignalJournalEntry)).toThrow(RangeError);
  });
});
