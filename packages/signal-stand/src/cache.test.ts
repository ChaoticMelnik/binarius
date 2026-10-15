import { appendFileSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  appendRows,
  firstTimestamp,
  lastTimestamp,
  readPairs,
  readSeries,
  seriesPath,
  StandError,
  writePairs,
} from './cache';
import { PAIR, secondsPath, T0, tempDir } from './testing';

const file = () => seriesPath(tempDir(), PAIR.id, '1s');

describe('cache', () => {
  it('reads back what was appended, ascending, with its first and last timestamps', () => {
    const path = file();
    const rows = secondsPath(T0, 5);
    appendRows(path, rows.slice(0, 2), vi.fn());
    appendRows(path, rows.slice(2), vi.fn());
    expect(readSeries(path, vi.fn())).toEqual(rows);
    expect(firstTimestamp(path)).toBe(T0);
    expect(lastTimestamp(path)).toBe(T0 + 4_000);
  });

  it('F5 a broken last line is dropped with one warning; a broken middle line is an error', () => {
    const path = file();
    appendRows(path, secondsPath(T0, 3), vi.fn());
    appendFileSync(path, '[1791');
    const warn = vi.fn();
    expect(readSeries(path, warn)).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastTimestamp(path)).toBe(T0 + 2_000);
    appendRows(path, secondsPath(T0 + 3_000, 1), warn);
    expect(readSeries(path, vi.fn())).toHaveLength(4);
    appendFileSync(path, '{"x":1}\n');
    appendRows(path, secondsPath(T0 + 4_000, 1), vi.fn());
    expect(() => readSeries(path, vi.fn())).toThrow(StandError);
    expect(() => readSeries(path, vi.fn())).toThrow(/line 5 is not a candle row/);
  });

  it('F6 a row at or before its predecessor is skipped', () => {
    const path = file();
    const rows = secondsPath(T0, 3);
    appendRows(path, [rows[0], rows[1], rows[1], rows[0], rows[2]], vi.fn());
    const warn = vi.fn();
    expect(readSeries(path, warn).map((row) => row.timestamp)).toEqual([
      T0,
      T0 + 1_000,
      T0 + 2_000,
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 rows not after'));
  });

  it('F7 pairs.json keeps the other pairs when some are fetched again', () => {
    const dir = tempDir();
    writePairs(dir, [PAIR, { ...PAIR, id: 7, symbol: 'X' }]);
    writePairs(dir, [{ ...PAIR, payout: 80, fetchedAt: T0 + 1 }]);
    expect(readPairs(dir)).toEqual([
      { ...PAIR, id: 7, symbol: 'X' },
      { ...PAIR, payout: 80, fetchedAt: T0 + 1 },
    ]);
    expect(readFileSync(`${dir}/pairs.json`, 'utf8')).toContain('"digits": 5');
  });
});
