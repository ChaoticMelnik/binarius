import { describe, expect, it } from 'vitest';
import { TradeMode } from '@binarius/shared';
import type { TradeIntentRow } from '@binarius/db';
import { realTradingGate, type SubmitResult, type TradeExecutor } from './executor';

const recording = (result: SubmitResult) => {
  const inner = {
    calls: [] as AbortSignal[],
    submit: async (_intent: TradeIntentRow, signal: AbortSignal) => {
      inner.calls.push(signal);
      return result;
    },
  } satisfies TradeExecutor & { calls: AbortSignal[] };
  return inner;
};

const intentIn = (mode: TradeMode) => ({ mode }) as TradeIntentRow;
const accepted: SubmitResult = { outcome: 'accepted', transport: 'socket' };

describe('realTradingGate', () => {
  it('rejects a real intent with the flag off without calling the inner executor', async () => {
    const inner = recording(accepted);
    const gated = realTradingGate(inner, { realTradingEnabled: false });
    expect(await gated.submit(intentIn(TradeMode.Real), new AbortController().signal)).toEqual({
      outcome: 'rejected',
      reason: 'real_trading_disabled',
    });
    expect(inner.calls).toHaveLength(0);
  });

  it('delegates a real intent with the flag on, passing the signal through', async () => {
    const inner = recording(accepted);
    const signal = new AbortController().signal;
    const gated = realTradingGate(inner, { realTradingEnabled: true });
    expect(await gated.submit(intentIn(TradeMode.Real), signal)).toBe(accepted);
    expect(inner.calls).toEqual([signal]);
  });

  it('delegates a demo intent with the flag off', async () => {
    const inner = recording(accepted);
    const gated = realTradingGate(inner, { realTradingEnabled: false });
    expect(await gated.submit(intentIn(TradeMode.Demo), new AbortController().signal)).toBe(
      accepted,
    );
    expect(inner.calls).toHaveLength(1);
  });
});
