import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SignalKind, TradeAction, tradeOutcomeOf, type Candle } from '@binarius/shared';
import { DEFAULT_SIGNAL_PARAMS, toJournalCandle } from '@binarius/signal';
import { describe, expect, it, vi } from 'vitest';
import { appendRows, readSeries, seriesPath } from './cache';
import {
  bestOf,
  eraCheck,
  matchAtDelay,
  outcomeGatePasses,
  runCalibrate,
  type LiveTrade,
} from './calibrate';
import { priceIndex } from './price';
import { calibrationPath } from './run';
import { decisionContext, type Market } from './simulate';
import { emptyTally, type Tally } from './stats';
import {
  aggregate,
  cacheWith,
  PAIR,
  quiet,
  secondsPath,
  shadowLine,
  T0,
  tempDir,
  writeJson,
} from './testing';
import { seriesAt } from './window';

const STEP = 5_000;
const seconds = secondsPath(T0, 2 * 3_600);
const price = priceIndex(seconds);
const market: Market = {
  assetId: PAIR.id,
  digits: PAIR.digits,
  price,
  series: {
    '5s': aggregate(seconds, STEP),
    '15s': aggregate(seconds, 15_000),
    '1m': aggregate(seconds, 60_000),
  },
};

const profitOf = (action: TradeAction, entry: number, exit: number) =>
  ({ win: '0.90000000', loss: '-1.00000000', tie: '0.00000000' })[
    tradeOutcomeOf(action, entry, exit)
  ];

// live trades on the moments v2 signalled, each with the journal line the feed would have logged
function liveSession(count: number, onlyWins = false) {
  const trades: LiveTrade[] = [];
  const lines: string[] = [];
  for (let nowMs = T0 + 600_500; trades.length < count; nowMs += STEP) {
    const decision = decisionContext(market, '5s', nowMs).v2();
    if (decision.kind !== SignalKind.Signal) continue;
    const series = seriesAt(market.series['5s']!, STEP, nowMs).map(toJournalCandle);
    // the forming candle was not final when the feed logged it
    const [ts, o, h, l, c] = series[series.length - 1];
    series[series.length - 1] = [ts, o, h + 0.0001, l, c + 0.0001];
    // and the answer's first row opened at the window's first tick
    const [t0, o0, h0, l0, c0] = series[0];
    series[0] = [t0, o0 - 0.00002, h0, Math.min(l0, o0 - 0.00002), c0];
    const signal = {
      assetId: PAIR.id,
      interval: '5s',
      digits: PAIR.digits,
      intervalMs: STEP,
      nowMs,
      source: { kind: 'socket', startTime: series[0][0], closedUntil: nowMs, gaps: 0 },
      version: 'v2',
      params: DEFAULT_SIGNAL_PARAMS,
      series,
      decision: { ...decision, features: { ...decision.features } },
    };
    if (series.at(-1)![0] + STEP <= nowMs) continue;
    const open = nowMs + 900;
    const close = open + 5_000;
    const profit = profitOf(decision.action, price(open)!, price(close)!);
    if (onlyWins && profit !== '0.90000000') continue;
    lines.push(JSON.stringify({ level: 30, time: nowMs, signal, msg: 'signal decision' }));
    trades.push({
      trading_session_id: 's1',
      asset_id: PAIR.id,
      action: decision.action,
      duration_sec: 5,
      created_at_ms: nowMs + 500,
      open_timestamp_ms: open,
      open_price: price(open)!,
      close_timestamp_ms: close,
      close_price: price(close)!,
      profit,
    });
    nowMs += 10_000;
  }
  return { trades, lines };
}

const sessionRows = (candles: readonly Candle[]) =>
  candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close]);

// the owner's session export of the whole path
function sessionDirOf(candles: readonly Candle[] = seconds): string {
  const dir = tempDir();
  writeJson(path.join(dir, 'all_1s.json'), {
    session: 'all',
    asset_id: PAIR.id,
    interval: '1s',
    start_time: 0,
    limit: candles.length,
    rows: sessionRows(candles),
  });
  return dir;
}

function run(setup: { trades: unknown; lines: string[]; dir?: string; sessionDir?: string }) {
  const live = tempDir();
  writeFileSync(path.join(live, 'journal.jsonl'), setup.lines.join('\n') + '\n');
  const dir = setup.dir ?? cacheWith(seconds);
  const out: string[] = [];
  const code = runCalibrate({
    dir,
    journal: path.join(live, 'journal.jsonl'),
    trades: writeJson(path.join(live, 'trades.json'), setup.trades),
    sessionCandles: setup.sessionDir ?? sessionDirOf(),
    io: { out: (l) => out.push(l), err: vi.fn() },
    now: () => T0,
  });
  const counter = (name: string) => Number(new RegExp(`${name} (\\d+)`).exec(out.join('\n'))?.[1]);
  return { code, out, dir, counter };
}

const tally = (wins: number, losses: number): Tally => ({
  ...emptyTally(),
  trades: wins + losses,
  wins,
  losses,
});

describe('calibrate', () => {
  it('C1 a clean set passes every gate, replays every line and writes the headline delay', () => {
    const { code, out, dir, counter } = run(liveSession(6));
    expect(code).toBe(0);
    expect(out[0]).toMatch(
      /^revisions: series_revised 0 \(series_match 6\), price_series_revised 0/,
    );
    expect(out[1]).toMatch(/outcome match .*: 6\/6 = 100.0 %/);
    expect(counter('replayed')).toBe(6);
    expect(counter('unmatched')).toBe(0);
    expect(out.at(-1)).toBe('calibrate: PASS');
    // created_at and open_timestamp share a second, so delay 0 prices the live entry
    const saved = JSON.parse(readFileSync(calibrationPath(dir), 'utf8')) as {
      headlineDelayMs: number;
    };
    expect(saved.headlineDelayMs).toBe(0);
  });

  // #666: the trade log's export reads as the logs and the #381 file did, line for line
  it('C12 a trade-log export (the lines and trades-json) gives the same report as the log lines', () => {
    const session = liveSession(6);
    const asLog = run(session);
    const exportLines = session.lines.map((line) => {
      const { signal } = JSON.parse(line) as { signal: Record<string, unknown> };
      return JSON.stringify({
        decision: { id: 'd' },
        signal,
        session: null,
        trade: null,
        ticks: null,
      });
    });
    const exportTrades = session.trades.map((trade, index) => ({
      ...trade,
      submitted_at_ms: trade.created_at_ms + 40,
      payout: 90,
      intent_id: `intent-${index}`,
      decision_id: `decision-${index}`,
      mode: 'demo',
      amount: '1.00000000',
    }));
    const asExport = run({ trades: exportTrades, lines: exportLines });
    expect(asExport.code).toBe(0);
    expect(asExport.out).toEqual(asLog.out);
  });

  it('C2 a revised closed candle fails the run, and revisions are the first line', () => {
    const dir = cacheWith(seconds);
    const file = seriesPath(dir, PAIR.id, '5s');
    const rows = readSeries(file, quiet);
    const session = liveSession(1);
    const nowMs = (JSON.parse(session.lines[0]) as { signal: { nowMs: number } }).signal.nowMs;
    const target = Math.floor(nowMs / STEP) * STEP - 10 * STEP;
    const changed = rows.map((row) =>
      row.timestamp === target ? { ...row, close: row.close + 0.001, high: row.high + 0.001 } : row,
    );
    writeFileSync(file, '');
    appendRows(file, changed, quiet);
    const { code, out } = run({ ...session, dir });
    expect(code).toBe(1);
    expect(out[0]).toMatch(/^revisions: series_revised 1 .* -> FAIL$/);
    expect(out.at(-1)).toBe('calibrate: FAIL');
  });

  it('C3 the outcome gate passes at 85 % and fails below', () => {
    expect(outcomeGatePasses({ matched: 85, priced: 100 })).toBe(true);
    expect(outcomeGatePasses({ matched: 84, priced: 100 })).toBe(false);
    expect(outcomeGatePasses({ matched: 0, priced: 0 })).toBe(false);
  });

  it('C4 an era is gated from 30 live trades: outside the interval fails it, 29 trades only report', () => {
    const stand = tally(50, 50);
    expect(eraCheck(tally(30, 0), stand)).toEqual({ gated: true, status: 'outside' });
    expect(eraCheck(tally(15, 15), stand)).toEqual({ gated: true, status: 'inside' });
    expect(eraCheck(tally(29, 0), stand)).toEqual({ gated: false, status: 'outside' });
    expect(eraCheck(tally(15, 15), { ...emptyTally(), trades: 2, ties: 2 })).toEqual({
      gated: true,
      status: 'no_stand_evidence',
    });
  });

  it('C5 a trade of the evening of 10-09 is ambiguous and in no comparison', () => {
    const session = liveSession(2);
    const ambiguous = { ...session.trades[0], created_at_ms: Date.UTC(2026, 9, 9, 19, 5) };
    const { counter, out } = run({ ...session, trades: [...session.trades, ambiguous] });
    expect(counter('ambiguous')).toBe(1);
    expect(out[1]).toMatch(/2\/2 = /);
  });

  it('C6 a v2 line matched to a v1-era trade is a version_mismatch', () => {
    const session = liveSession(1);
    const v1Era = Date.UTC(2026, 9, 8, 12);
    const signal = {
      ...(JSON.parse(session.lines[0]) as { signal: Record<string, unknown> }).signal,
      nowMs: v1Era - 500,
    };
    const trade = {
      ...session.trades[0],
      created_at_ms: v1Era,
      open_timestamp_ms: v1Era + 400,
      close_timestamp_ms: v1Era + 5_400,
    };
    const { counter } = run({ trades: [trade], lines: [JSON.stringify({ signal })] });
    expect(counter('version_mismatch')).toBe(1);
    expect(counter('unpriced')).toBe(1);
  });

  it('C7 an empty trades file ends with exit 1, no trades', () => {
    const err: string[] = [];
    const live = tempDir();
    const code = runCalibrate({
      dir: tempDir(),
      journal: path.join(live, 'missing.jsonl'),
      trades: writeJson(path.join(live, 'trades.json'), []),
      sessionCandles: live,
      io: { out: vi.fn(), err: (l) => err.push(l) },
    });
    expect(code).toBe(1);
    expect(err).toEqual(['calibrate: no trades']);
  });

  const trade = (over: Partial<LiveTrade>): LiveTrade => ({
    trading_session_id: 's',
    asset_id: 1,
    action: 'up',
    duration_sec: 5,
    created_at_ms: 10_000,
    open_timestamp_ms: 10_400,
    open_price: 1,
    close_timestamp_ms: 15_400,
    close_price: 2,
    profit: '0.9',
    ...over,
  });
  const shares = (trades: LiveTrade[], at: (ms: number) => number | undefined) =>
    new Map(
      [0, 1_000, 3_000].map((delay) => {
        const results = trades
          .map((t) => matchAtDelay(t, at, delay))
          .filter((m) => m !== undefined);
        return [delay, { matched: results.filter(Boolean).length, priced: results.length }];
      }),
    );

  it("C11 a truncated trades file is the stand's refusal, not a parse crash", () => {
    const live = tempDir();
    const trades = path.join(live, 'trades.json');
    writeFileSync(trades, '[{"id": 1');
    expect(() =>
      runCalibrate({
        dir: tempDir(),
        journal: path.join(live, 'missing.jsonl'),
        trades,
        sessionCandles: live,
        io: { out: vi.fn(), err: vi.fn() },
      }),
    ).toThrow(`calibrate: ${trades} is not a trades export`);
  });

  it('C8 the headline delay is the grid value matching the most live outcomes', () => {
    // a rise between 11 s and 16 s only: entry at created + 1 s sees it
    const rising = (ms: number) => (ms >= 11_000 && ms < 16_000 ? 1 : ms >= 16_000 ? 2 : 1.5);
    const s = shares([trade({})], rising);
    expect(s.get(1_000)).toEqual({ matched: 1, priced: 1 });
    expect(s.get(0)).toEqual({ matched: 0, priced: 1 });
    expect(bestOf([0, 1_000, 3_000], s)).toBe(1_000);
  });

  it('C9 a tie goes to the smaller delay', () => {
    const tied = new Map([
      [0, { matched: 1, priced: 2 }],
      [1_000, { matched: 2, priced: 4 }],
      [3_000, { matched: 0, priced: 1 }],
    ]);
    expect(bestOf([0, 1_000, 3_000], tied)).toBe(0);
  });

  it('C10 a row missing only at created + 3 s leaves 3 s out of its own denominator', () => {
    const at = (ms: number) => (ms >= 13_000 && ms < 14_000 ? undefined : ms / 1_000);
    const s = shares([trade({}), trade({ created_at_ms: 100_000 })], at);
    expect(s.get(0)?.priced).toBe(2);
    expect(s.get(1_000)?.priced).toBe(2);
    expect(s.get(3_000)?.priced).toBe(1);
  });

  it('Q1 Q2 session files equal to the cache match; one changed close is a revision that fails the run', () => {
    const session = liveSession(2);
    const sessionDir = tempDir();
    const rows = seconds
      .slice(600, 1_200)
      .map((c) => [c.timestamp, c.open, c.high, c.low, c.close]);
    // the first row of the owner's answer opened at the window's first tick: not a revision
    rows[0] = [rows[0][0], rows[0][1] + 0.0003, rows[0][2] + 0.0003, rows[0][3], rows[0][4]];
    writeJson(path.join(sessionDir, 'a_1s.json'), {
      session: 'a',
      asset_id: PAIR.id,
      interval: '1s',
      start_time: 0,
      limit: 600,
      rows,
    });
    const clean = run({ ...session, sessionDir });
    expect(clean.counter('price_series_match')).toBe(1);
    expect(clean.code).toBe(0);
    const changed = rows.map((r, i) => (i === 300 ? [r[0], r[1], r[2] + 1, r[3], r[4]] : r));
    writeJson(path.join(sessionDir, 'b_1s.json'), {
      session: 'b',
      asset_id: PAIR.id,
      interval: '1s',
      start_time: 0,
      limit: 600,
      rows: changed,
    });
    writeFileSync(path.join(sessionDir, 'c_1s.json'), '{"rows": 1}');
    const revised = run({ ...session, sessionDir });
    expect(revised.counter('price_series_revised')).toBe(1);
    expect(revised.counter('malformed_session_file')).toBe(1);
    expect(revised.out.join('\n')).toContain(
      `b_1s.json: 1 rows, first ${new Date(seconds[900].timestamp).toISOString()}`,
    );
    expect(revised.code).toBe(1);
  });

  it('Q3 a trade the cache cannot price is priced from its session file', () => {
    const session = liveSession(1);
    const [t] = session.trades;
    const dir = tempDir();
    const gap = (c: { timestamp: number }) =>
      c.timestamp < t.open_timestamp_ms - 2_000 || c.timestamp > t.close_timestamp_ms + 2_000;
    cacheWith(seconds.filter(gap), PAIR, dir);
    const sessionDir = tempDir();
    mkdirSync(sessionDir, { recursive: true });
    const rows = seconds
      .filter((c) => !gap(c))
      .map((c) => [c.timestamp, c.open, c.high, c.low, c.close]);
    writeJson(path.join(sessionDir, 's_1s.json'), {
      session: 's1',
      asset_id: PAIR.id,
      interval: '1s',
      start_time: 0,
      limit: 20,
      rows,
    });
    const { counter } = run({ ...session, dir, sessionDir });
    expect(counter('priced_from_session_file')).toBe(1);
    expect(counter('unpriced')).toBe(0);
  });
  it('E1 an empty stand dir is refused before any gate, naming the traded asset, and saves nothing', () => {
    const dir = tempDir();
    expect(() => run({ ...liveSession(2), dir })).toThrow(
      `calibrate: ${PAIR.id}: not in pairs.json; ${PAIR.id}: no 1s series; ${PAIR.id}: no 5s series - fetch it first`,
    );
    expect(existsSync(calibrationPath(dir))).toBe(false);
  });

  it('E2 one traded asset or one series missing from the cache is refused by name', () => {
    const session = liveSession(2);
    const other = { ...session.trades[0], asset_id: 999 };
    expect(() => run({ ...session, trades: [...session.trades, other] })).toThrow(
      'calibrate: 999: not in pairs.json; 999: no 1s series; 999: no 5s series - fetch it first',
    );
    const dir = cacheWith(seconds);
    rmSync(seriesPath(dir, PAIR.id, '5s'));
    expect(() => run({ ...session, dir })).toThrow(
      `calibrate: ${PAIR.id}: no 5s series - fetch it first`,
    );
    expect(existsSync(calibrationPath(dir))).toBe(false);
  });

  it('E3 a gated era whose stand has no trade fails: no stand evidence', () => {
    const session = liveSession(6);
    const dir = cacheWith(seconds);
    // the 15s cache ends long before the 15 s trades, so the stand decides nothing there
    writeFileSync(seriesPath(dir, PAIR.id, '15s'), '');
    appendRows(seriesPath(dir, PAIR.id, '15s'), aggregate(seconds.slice(0, 600), 15_000), quiet);
    const later = Array.from({ length: 30 }, (_, i): LiveTrade => {
      const created = T0 + 3_600_000 + i * 60_000;
      const open = created + 400;
      const close = open + 15_000;
      return {
        trading_session_id: 's15',
        asset_id: PAIR.id,
        action: TradeAction.Up,
        duration_sec: 15,
        created_at_ms: created,
        open_timestamp_ms: open,
        open_price: price(open)!,
        close_timestamp_ms: close,
        close_price: price(close)!,
        profit: profitOf(TradeAction.Up, price(open)!, price(close)!),
      };
    });
    const { code, out } = run({ ...session, trades: [...session.trades, ...later], dir });
    expect(out[0]).toMatch(/-> ok$/);
    expect(out[1]).toMatch(/-> ok$/);
    expect(out.find((l) => l.includes('v2 15 s:'))).toMatch(
      /live 30 trades .* stand 0 trades .* -> FAIL no stand evidence$/,
    );
    expect(code).toBe(1);
  });

  it('E4 session files and journal lines the cache cannot compare are no revision evidence', () => {
    const session = liveSession(6);
    const dir = cacheWith(seconds.slice(0, 200));
    const sessionDir = sessionDirOf(seconds.slice(600));
    const { code, out, counter } = run({ ...session, dir, sessionDir });
    expect(counter('price_files_not_compared')).toBe(1);
    expect(counter('price_series_match')).toBe(0);
    expect(counter('series_lines_not_compared')).toBe(6);
    expect(counter('series_match')).toBe(0);
    expect(out[0]).toMatch(/-> FAIL no revision evidence$/);
    expect(out[1]).toMatch(/6\/6 = 100.0 %.* -> ok$/);
    expect(code).toBe(1);
  });

  it('E5 E7 an outcome match of 84 % fails the run and saves nothing; a pass saves', () => {
    const session = liveSession(25);
    const flipped = session.trades.map((t, i) =>
      i < 4 ? { ...t, profit: t.profit.startsWith('-') ? '0.90000000' : '-1.00000000' } : t,
    );
    const failed = run({ ...session, trades: flipped });
    expect(failed.out[0]).toMatch(/-> ok$/);
    expect(failed.out[1]).toMatch(/: 21\/25 = 84.0 % .* -> FAIL$/);
    expect(failed.code).toBe(1);
    expect(existsSync(calibrationPath(failed.dir))).toBe(false);
    const passed = run(session);
    expect(passed.code).toBe(0);
    expect(existsSync(calibrationPath(passed.dir))).toBe(true);
  });

  it('E6 a 30-trade era with the live rate outside the stand interval fails; 29 trades pass', () => {
    const session = liveSession(30, true);
    const gated = run(session);
    expect(gated.out.find((l) => l.includes('v2 5 s:'))).toMatch(
      /live 30 trades 30W\/0L\/0T 100.0 %; stand \d+ trades .* -> FAIL$/,
    );
    expect(gated.code).toBe(1);
    const reported = run({ ...session, trades: session.trades.slice(0, 29) });
    expect(reported.out.find((l) => l.includes('v2 5 s:'))).toMatch(/reported, not gated$/);
    expect(reported.code).toBe(0);
  });
  it('E8 a duration with no stand interval counts unsupported_duration and joins no era', () => {
    const session = liveSession(2);
    const odd = { ...session.trades[0], duration_sec: 30 };
    const { counter, out } = run({ ...session, trades: [...session.trades, odd] });
    expect(counter('unsupported_duration')).toBe(1);
    expect(out.some((l) => l.includes('v2 30 s:'))).toBe(false);
  });

  it('E9 a shadow row of the H1 shadow counts h1_shadow, not unsupported_version (#669)', () => {
    const session = liveSession(6);
    const { counter } = run({ ...session, lines: [...session.lines, shadowLine().line] });
    expect(counter('h1_shadow')).toBe(1);
    expect(counter('unsupported_version')).toBe(0);
    expect(counter('replayed')).toBe(6);
  });
});
