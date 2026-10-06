import { describe, expect, it } from 'vitest';
import { TradeAction, TradeMode, type DecimalString } from '@binarius/shared';
import { openTradeFor } from '@binarius/shared/testing';
import type { TradeIntentRow } from '@binarius/db';
import { parseEnv } from '../env';
import { buildExecutor, realTradingGate, type SubmitResult, type TradeExecutor } from './executor';

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
const accepted: SubmitResult = {
  outcome: 'accepted',
  transport: 'socket',
  trade: openTradeFor({
    mode: TradeMode.Demo,
    assetId: 91,
    action: TradeAction.Up,
    amount: '10.00' as DecimalString,
  }),
};

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

describe('buildExecutor', () => {
  const REQUIRED = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    BACKEND_URL: 'http://backend:3000',
    INTERNAL_API_TOKEN: 'internal-token-for-tests-0123456789',
    BROKER_API_BASE_URL: 'https://api.binodex.app',
  };

  it('rejects a real intent with REAL_TRADING_ENABLED unset, without calling the inner one', async () => {
    const inner = recording(accepted);
    const executor = buildExecutor(parseEnv(REQUIRED), inner);
    expect(await executor.submit(intentIn(TradeMode.Real), new AbortController().signal)).toEqual({
      outcome: 'rejected',
      reason: 'real_trading_disabled',
    });
    expect(inner.calls).toHaveLength(0);
  });

  it('delegates a real intent with REAL_TRADING_ENABLED=true, passing the signal through', async () => {
    const inner = recording(accepted);
    const signal = new AbortController().signal;
    const executor = buildExecutor(parseEnv({ ...REQUIRED, REAL_TRADING_ENABLED: 'true' }), inner);
    expect(await executor.submit(intentIn(TradeMode.Real), signal)).toBe(accepted);
    expect(inner.calls).toEqual([signal]);
  });

  it('delegates a demo intent with the flag off', async () => {
    const inner = recording(accepted);
    const executor = buildExecutor(parseEnv(REQUIRED), inner);
    expect(await executor.submit(intentIn(TradeMode.Demo), new AbortController().signal)).toBe(
      accepted,
    );
    expect(inner.calls).toHaveLength(1);
  });
});
