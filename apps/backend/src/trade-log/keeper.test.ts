import { describe, expect, it, vi } from 'vitest';
import type { DecisionTicksCandidate, DecisionTicksInsert } from '@binarius/db';
import { createTickStore, type TickStore } from '../market-data/ticks';
import { createTradeLogKeeper, type TradeLogKeeperDeps } from './keeper';

// The keeper's capture and sweep (#668) on fake operations, a fake clock and a real tick store:
// one case per row of the ending table in docs/trade-log.md.
const AT = 1_760_000_000_000;
const BEFORE = 60_000;
const AFTER = 5_000;
const MAX_WAIT = 170_000;
const SKEW = 2_000;

const candidate = (patch: Partial<DecisionTicksCandidate> = {}): DecisionTicksCandidate => ({
  id: 'd-1',
  context: 'session',
  assetId: 101,
  decidedAtMs: AT,
  ticksUntilMs: null,
  intentStatus: 'settled',
  intentUpdatedAtMs: AT + 15_400,
  tradeStatus: 'closed',
  closeTimestampMs: AT + 15_000,
  ...patch,
});

// a tick each second over [from, until], received 100 ms after its broker time
function fill(store: TickStore, from: number, until: number, assetId = 101): void {
  for (let at = from; at <= until; at += 1_000) {
    store.push(assetId, { price: 1 + (at - AT) / 1e7, timestamp: at }, at + 100);
  }
}

interface Logged {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg: string;
}

function harness(
  options: {
    candidates?: DecisionTicksCandidate[] | (() => Promise<DecisionTicksCandidate[]>);
    insert?: (rows: DecisionTicksInsert[]) => Promise<number>;
    sweep?: () => Promise<{ decisions: number; ticks: number }>;
    ticks?: TickStore | null;
    config?: TradeLogKeeperDeps['config'];
  } = {},
) {
  const clock = { now: AT };
  const store = options.ticks === undefined ? createTickStore() : options.ticks;
  const inserted: DecisionTicksInsert[][] = [];
  const logs: Logged[] = [];
  const log = (level: Logged['level']) => (fields: Record<string, unknown>, msg: string) => {
    logs.push({ level, fields, msg });
  };
  const list = options.candidates ?? [candidate()];
  const candidates = vi.fn(typeof list === 'function' ? list : () => Promise.resolve(list));
  const sweep = vi.fn(options.sweep ?? (() => Promise.resolve({ decisions: 0, ticks: 0 })));
  const keeper = createTradeLogKeeper({
    db: {} as TradeLogKeeperDeps['db'],
    ticks: store ?? undefined,
    ops: {
      candidates: () => candidates(),
      insert: (_db, rows) => {
        inserted.push(rows);
        return options.insert === undefined ? Promise.resolve(rows.length) : options.insert(rows);
      },
      sweep: () => sweep(),
    },
    logger: { info: log('info'), warn: log('warn'), error: log('error') } as never,
    now: () => clock.now,
    config: {
      beforeMs: BEFORE,
      afterCloseMs: AFTER,
      maxWaitMs: MAX_WAIT,
      skewMarginMs: SKEW,
      insertChunk: 50,
      sweepBatch: 10,
      sweepMaxBatches: 3,
      ...options.config,
    },
  });
  const rows = () => inserted.flat();
  return { keeper, clock, store: store!, rows, inserted, logs, candidates, sweep };
}

describe('the trade log keeper: capture (#668)', () => {
  it('C1 T1 a sampled shadow row is captured over [decided - 60 s, ticks_until]', async () => {
    const h = harness({
      candidates: [
        candidate({
          context: 'shadow',
          ticksUntilMs: AT + 7_000,
          intentStatus: null,
          intentUpdatedAtMs: null,
          tradeStatus: null,
          closeTimestampMs: null,
        }),
      ],
    });
    fill(h.store, AT - 65_000, AT + 9_000);
    h.clock.now = AT + 9_100;
    await h.keeper.capture();
    const [row] = h.rows();
    expect(row).toMatchObject({
      decisionId: 'd-1',
      fromMs: AT - BEFORE,
      untilMs: AT + 7_000,
      status: 'complete',
      detail: null,
      count: 68,
    });
    expect(row!.ticks[0]).toEqual([AT - BEFORE, AT - BEFORE + 100, 1 - BEFORE / 1e7]);
    expect(row!.ticks.at(-1)?.[0]).toBe(AT + 7_000);
    expect(h.logs).toEqual([
      {
        level: 'info',
        msg: 'trade log ticks',
        fields: {
          scanned: 1,
          captured: { complete: 1, truncated: 0, unavailable: 0 },
          waiting: 0,
          invalidWindow: 0,
        },
      },
    ]);
  });

  it('C2 T3 an intent with a closed broker trade ends 5 s after the close', async () => {
    const h = harness();
    fill(h.store, AT - 65_000, AT + 25_000);
    h.clock.now = AT + 25_100;
    await h.keeper.capture();
    expect(h.rows()).toMatchObject([
      { fromMs: AT - BEFORE, untilMs: AT + 15_000 + AFTER, status: 'complete', count: 81 },
    ]);
  });

  it('C3 T4 a rejected intent without a trade ends 5 s after its updated_at', async () => {
    const h = harness({
      candidates: [
        candidate({
          intentStatus: 'rejected',
          intentUpdatedAtMs: AT + 900,
          tradeStatus: null,
          closeTimestampMs: null,
        }),
      ],
    });
    fill(h.store, AT - 65_000, AT + 10_000);
    h.clock.now = AT + 10_100;
    await h.keeper.capture();
    expect(h.rows()).toMatchObject([{ untilMs: AT + 900 + AFTER, status: 'complete' }]);
  });

  it('C4 T6 an intent still in flight before the max wait waits, without a line', async () => {
    const h = harness({
      candidates: [
        candidate({ intentStatus: 'accepted', tradeStatus: 'open', closeTimestampMs: null }),
        candidate({ id: 'd-2', intentStatus: null, intentUpdatedAtMs: null, tradeStatus: null }),
      ],
    });
    fill(h.store, AT - 65_000, AT + 100_000);
    h.clock.now = AT + MAX_WAIT - 1;
    await h.keeper.capture();
    expect(h.rows()).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('C5 T7 an intent still in flight at the max wait is cut there, truncated', async () => {
    const h = harness({
      candidates: [
        candidate({ intentStatus: 'manual_review', tradeStatus: null, closeTimestampMs: null }),
        // a trade longer than the max wait is cut at it as well
        candidate({ id: 'd-2', closeTimestampMs: AT + MAX_WAIT }),
      ],
    });
    fill(h.store, AT - 65_000, AT + MAX_WAIT + 2_000);
    h.clock.now = AT + MAX_WAIT + 2_500;
    await h.keeper.capture();
    expect(h.rows()).toMatchObject([
      { decisionId: 'd-1', untilMs: AT + MAX_WAIT, status: 'truncated', detail: 'max_wait' },
      { decisionId: 'd-2', untilMs: AT + MAX_WAIT, status: 'truncated', detail: 'max_wait' },
    ]);
  });

  it('C6 T8 a due window waits until the watermark or the clock passes its end', async () => {
    const byClock = harness();
    fill(byClock.store, AT - 65_000, AT + 19_000);
    byClock.clock.now = AT + 20_000 + SKEW - 1;
    await byClock.keeper.capture();
    expect(byClock.rows()).toEqual([]);
    byClock.clock.now = AT + 20_000 + SKEW;
    await byClock.keeper.capture();
    expect(byClock.rows()).toMatchObject([{ untilMs: AT + 20_000, status: 'complete' }]);

    const byWatermark = harness();
    fill(byWatermark.store, AT - 65_000, AT + 20_000);
    byWatermark.clock.now = AT + 20_000;
    await byWatermark.keeper.capture();
    expect(byWatermark.rows()).toMatchObject([{ untilMs: AT + 20_000, status: 'complete' }]);
  });

  it('C7 a store that started inside the window writes truncated/uncovered', async () => {
    const h = harness();
    fill(h.store, AT - 30_000, AT + 25_000);
    h.clock.now = AT + 25_100;
    await h.keeper.capture();
    expect(h.rows()).toMatchObject([{ status: 'truncated', detail: 'uncovered', count: 51 }]);
  });

  it('C8 a socket drop inside the window writes truncated/hole', async () => {
    const h = harness();
    fill(h.store, AT - 65_000, AT);
    h.store.onDrop();
    fill(h.store, AT + 5_000, AT + 25_000);
    h.clock.now = AT + 25_100;
    await h.keeper.capture();
    expect(h.rows()).toMatchObject([{ status: 'truncated', detail: 'hole' }]);
  });

  it('C9 no ticks under whole coverage writes unavailable/quiet, never complete', async () => {
    const h = harness({ candidates: [candidate({ assetId: 202 })] });
    fill(h.store, AT - 65_000, AT + 25_000);
    h.clock.now = AT + 25_000 + SKEW;
    await h.keeper.capture();
    expect(h.rows()).toMatchObject([
      { status: 'unavailable', detail: 'quiet', count: 0, ticks: [] },
    ]);
  });

  it('C10 T9 a failed insert is a warn and the next chunk is still written', async () => {
    let calls = 0;
    const h = harness({
      candidates: [candidate(), candidate({ id: 'd-2' })],
      config: { insertChunk: 1 },
      insert: (rows) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(rows.length);
      },
    });
    fill(h.store, AT - 65_000, AT + 25_000);
    h.clock.now = AT + 25_100;
    await h.keeper.capture();
    expect(h.inserted.map((chunk) => chunk.map((row) => row.decisionId))).toEqual([
      ['d-1'],
      ['d-2'],
    ]);
    const warn = h.logs.find((entry) => entry.level === 'warn');
    expect(warn).toMatchObject({ msg: 'trade log ticks insert failed', fields: { rows: 1 } });
    expect(warn?.fields).toHaveProperty('err');
    expect(h.logs.find((entry) => entry.msg === 'trade log ticks')?.fields).toMatchObject({
      captured: { complete: 1, truncated: 0, unavailable: 0 },
    });
  });

  it('C11 T10 a failed candidates query is an error and the tick ends', async () => {
    const h = harness({ candidates: () => Promise.reject(new Error('down')) });
    await expect(h.keeper.capture()).resolves.toBeUndefined();
    expect(h.logs).toMatchObject([{ level: 'error', msg: 'trade log ticks tick failed' }]);
  });

  it('C12 T11 stop() between chunks leaves the rest unwritten and waits for the chunk in flight', async () => {
    let stopping: Promise<void> | undefined;
    const h = harness({
      candidates: [candidate(), candidate({ id: 'd-2' })],
      config: { insertChunk: 1 },
      insert: (rows) => {
        stopping ??= h.keeper.stop();
        return Promise.resolve(rows.length);
      },
    });
    fill(h.store, AT - 65_000, AT + 25_000);
    h.clock.now = AT + 25_100;
    await h.keeper.capture();
    await stopping;
    expect(h.inserted).toHaveLength(1);
    await h.keeper.capture();
    expect(h.candidates).toHaveBeenCalledTimes(1);
  });

  it('C13 T13 a row another backend wrote first is not an error; an invalid window is warned once', async () => {
    const h = harness({
      candidates: [
        candidate(),
        candidate({
          id: 'bad',
          context: 'shadow',
          ticksUntilMs: null,
          intentStatus: null,
          tradeStatus: null,
        }),
      ],
      insert: () => Promise.resolve(0),
    });
    fill(h.store, AT - 65_000, AT + 25_000);
    h.clock.now = AT + 25_100;
    await h.keeper.capture();
    await h.keeper.capture();
    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([]);
    expect(h.logs.filter((entry) => entry.msg === 'trade log ticks invalid window')).toHaveLength(
      1,
    );
    expect(h.logs.find((entry) => entry.msg === 'trade log ticks')?.fields).toMatchObject({
      invalidWindow: 1,
    });
    expect(h.rows().map((row) => row.decisionId)).toEqual(['d-1', 'd-1']);
  });

  it('C15 without a tick store no capture runs and start() arms the sweep only', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ ticks: null, config: { scanMs: 1_000, sweepMs: 5_000 } });
      h.keeper.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.candidates).not.toHaveBeenCalled();
      expect(h.sweep).toHaveBeenCalledTimes(1);
      await h.keeper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the trade log keeper: sweep (#668)', () => {
  it('C14 repeats full batches up to the max, stops at a short one, logs the totals', async () => {
    const full = harness({ sweep: () => Promise.resolve({ decisions: 10, ticks: 1 }) });
    await full.keeper.sweep();
    expect(full.sweep).toHaveBeenCalledTimes(3);
    expect(full.logs).toEqual([
      { level: 'info', msg: 'trade log sweep', fields: { decisions: 30, ticks: 3, batches: 3 } },
    ]);

    const answers = [10, 4];
    const short = harness({
      sweep: () => Promise.resolve({ decisions: answers.shift() ?? 0, ticks: 0 }),
    });
    await short.keeper.sweep();
    expect(short.sweep).toHaveBeenCalledTimes(2);

    const empty = harness();
    await empty.keeper.sweep();
    expect(empty.logs).toEqual([]);

    const failing = harness({ sweep: () => Promise.reject(new Error('locked')) });
    await failing.keeper.sweep();
    expect(failing.logs).toMatchObject([{ level: 'error', msg: 'trade log sweep failed' }]);

    let stopping: Promise<void> | undefined;
    const stopped = harness({
      sweep: () => {
        stopping ??= stopped.keeper.stop();
        return Promise.resolve({ decisions: 10, ticks: 0 });
      },
    });
    await stopped.keeper.sweep();
    await stopping;
    expect(stopped.sweep).toHaveBeenCalledTimes(1);
  });
});
