import { SIGNAL_CHART_INTERVAL_MS } from '@binarius/shared';
import {
  createSignalDecider,
  createSignalDeciderV1,
  replaySignalJournalEntry,
  toJournalCandle,
  type StoredSignalJournalEntry,
} from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import { parseJournalLine } from './journal-line';
import { aggregate, PAIR, secondsPath, T0 } from './testing';
import { seriesAt } from './window';

const STEP = SIGNAL_CHART_INTERVAL_MS['5s'];
const fives = aggregate(secondsPath(T0, 3_600), STEP);
const nowMs = T0 + 1_800_000 + 2_500;
const candles = seriesAt(fives, STEP, nowMs);

const fetch = { startTime: candles[0].timestamp, limit: 60, rows: candles.length, durationMs: 80 };

// v2-fetch is a v2 line written before #405; v2 and v2-rest carry its source
function entry(version: 'v1' | 'v2' | 'v2-rest' | 'v2-fetch' = 'v2'): StoredSignalJournalEntry {
  const base = {
    assetId: PAIR.id,
    interval: '5s' as const,
    intervalMs: STEP,
    nowMs,
    series: candles.map(toJournalCandle),
  };
  if (version === 'v1') {
    const decider = createSignalDeciderV1();
    return {
      ...base,
      fetch,
      version,
      params: decider.params,
      decision: decider.decide({ candles, intervalMs: STEP, nowMs }),
    };
  }
  const decider = createSignalDecider();
  const v2 = {
    ...base,
    version: 'v2' as const,
    digits: PAIR.digits,
    params: decider.params,
    decision: decider.decide({ candles, intervalMs: STEP, nowMs, digits: PAIR.digits }),
  };
  if (version === 'v2-fetch') return { ...v2, fetch };
  if (version === 'v2-rest') return { ...v2, source: { kind: 'rest', ...fetch } };
  return {
    ...v2,
    source: { kind: 'socket', startTime: candles[0].timestamp, closedUntil: nowMs, gaps: 2 },
  };
}

const pino = (signal: unknown) =>
  JSON.stringify({
    level: 30,
    time: nowMs,
    pid: 36,
    hostname: 'h',
    signal,
    msg: 'signal decision',
  });

describe('parseJournalLine', () => {
  it('J1 a pino line yields its signal entry', () => {
    expect(parseJournalLine(pino(entry('v2')))).toEqual({ kind: 'entry', entry: entry('v2') });
  });

  it('J2 a bare entry is accepted', () => {
    expect(parseJournalLine(JSON.stringify(entry('v2')))).toEqual({
      kind: 'entry',
      entry: entry('v2'),
    });
  });

  it('J3 a line without signal, a broken entry or no JSON is malformed_line', () => {
    expect(parseJournalLine(JSON.stringify({ level: 30, msg: 'signal decision' }))).toEqual({
      kind: 'malformed_line',
    });
    expect(parseJournalLine(pino({ ...entry('v2'), decision: { kind: 'maybe' } }))).toEqual({
      kind: 'malformed_line',
    });
    expect(parseJournalLine('{"level":30,')).toEqual({ kind: 'malformed_line' });
    expect(parseJournalLine(pino({ ...entry('v2'), version: 'v9' }))).toEqual({
      kind: 'unsupported_version',
      version: 'v9',
    });
  });

  it('J4 a v1 line and a v2 line replay to their own decision', () => {
    for (const version of ['v1', 'v2'] as const) {
      const parsed = parseJournalLine(pino(entry(version)));
      if (parsed.kind !== 'entry') throw new Error(`expected an entry, got ${parsed.kind}`);
      expect(parsed.entry.version).toBe(version);
      expect(replaySignalJournalEntry(parsed.entry)).toEqual(parsed.entry.decision);
    }
  });

  // #405: a v2 line carries source; one written before it carries fetch, and still parses
  it.each(['v2', 'v2-rest', 'v2-fetch'] as const)(
    'JL %s parses whole and replays to its decision',
    (version) => {
      const line = entry(version);
      const parsed = parseJournalLine(pino(line));
      expect(parsed).toStrictEqual({ kind: 'entry', entry: line });
      if (parsed.kind !== 'entry') throw new Error(`expected an entry, got ${parsed.kind}`);
      expect(replaySignalJournalEntry(parsed.entry)).toEqual(line.decision);
    },
  );

  it('JL a v2 line with neither source nor fetch, or a socket source without gaps, is malformed', () => {
    const bare: Record<string, unknown> = { ...entry('v2-fetch') };
    delete bare.fetch;
    expect(parseJournalLine(pino(bare))).toEqual({ kind: 'malformed_line' });
    expect(
      parseJournalLine(pino({ ...entry('v2'), source: { kind: 'socket', startTime: 0 } })),
    ).toEqual({ kind: 'malformed_line' });
  });
});
