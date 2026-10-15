import { createBrokerRestClient } from '@binarius/broker-rest';
import { startMockBroker } from '@binarius/mock-broker';
import { NoSignalReason } from '@binarius/shared';
import {
  chartWindow,
  createSignalDecider,
  decisionRows,
  SIGNAL_CHART_LIMIT,
  SIGNAL_FETCH_LIMIT,
} from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import { aggregate, secondsPath, T0 } from './testing';
import { seriesAt } from './window';

const STEP = 5_000;

describe('seriesAt', () => {
  it('W1 equals the mock broker answer to the feed request at the same nowMs', async () => {
    const broker = await startMockBroker();
    try {
      const rest = createBrokerRestClient({ baseUrl: broker.url });
      const [pair] = await rest.listPairs();
      const nowMs = Date.now();
      const window = chartWindow(nowMs, STEP, SIGNAL_CHART_LIMIT);
      const feed = await rest.getChart({ assetId: pair.id, interval: '5s', ...window });
      const cache = await rest.getChart({
        assetId: pair.id,
        interval: '5s',
        startTime: window.startTime - 100 * STEP,
        limit: 5_000,
      });
      const rows = seriesAt(cache, STEP, nowMs);
      expect(rows).toHaveLength(SIGNAL_CHART_LIMIT);
      expect(rows).toEqual(feed);
      const decider = createSignalDecider();
      const input = { intervalMs: STEP, nowMs, digits: pair.digits };
      expect(decider.decide({ ...input, candles: rows })).toEqual(
        decider.decide({ ...input, candles: feed }),
      );
    } finally {
      await broker.close();
    }
  });

  it('W2 a gap inside the window reaches the decider as candle_gap', () => {
    const fives = aggregate(secondsPath(T0, 600), STEP).filter((_, i) => i !== 100);
    const nowMs = fives.at(-1)!.timestamp + 2_000;
    const rows = seriesAt(fives, STEP, nowMs);
    expect(rows).toHaveLength(SIGNAL_CHART_LIMIT - 1);
    const decision = createSignalDecider().decide({
      candles: rows,
      intervalMs: STEP,
      nowMs,
      digits: 5,
    });
    expect(decision).toMatchObject({
      reason: NoSignalReason.CandleGap,
      detail: { expectedTimestamp: T0 + 100 * STEP, actualTimestamp: T0 + 101 * STEP },
    });
  });

  it('W3 a window reaching before the cache start is insufficient_candles', () => {
    const fives = aggregate(secondsPath(T0, 600), STEP);
    const nowMs = T0 + 20 * STEP + 2_000;
    const rows = seriesAt(fives, STEP, nowMs);
    expect(rows).toHaveLength(21);
    const decision = createSignalDecider().decide({
      candles: rows,
      intervalMs: STEP,
      nowMs,
      digits: 5,
    });
    expect(decision).toMatchObject({ reason: NoSignalReason.InsufficientCandles });
  });

  // #482: the feed's decision rows, cut from the 300-row answer, are the rows the stand replays
  it.each([
    ['inside a candle', T0 + 580 * STEP + 2_000],
    ['on a boundary', T0 + 580 * STEP],
    ['one step before the boundary', T0 + 581 * STEP - 1],
    ['with the gap just before the window', T0 + 619 * STEP + 2_000],
  ])('W4 decisionRows of the fetch answer equals seriesAt %s', (_, nowMs) => {
    const fives = aggregate(secondsPath(T0, 3_200), STEP).filter((__, i) => i !== 560);
    const answer = seriesAt(fives, STEP, nowMs, SIGNAL_FETCH_LIMIT);
    expect(decisionRows(answer, nowMs, STEP)).toStrictEqual(seriesAt(fives, STEP, nowMs));
  });
});
