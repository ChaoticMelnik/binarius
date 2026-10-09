import { describe, expect, it } from 'vitest';
import type { TradeIntentRow } from '@binarius/db';
import { openTradeFor } from '@binarius/shared/testing';
import type { SubmitResult, TradeExecutor } from '../intents/executor';
import { observeExecutor } from './observe-executor';

const intent = {
  id: 'intent-1',
  mode: 'demo',
  assetId: 101,
  action: 'up',
  amount: '1',
} as unknown as TradeIntentRow;

function observed(result: SubmitResult | Error) {
  const records: [string, boolean][] = [];
  const executor: TradeExecutor = {
    submit: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
  const wrapped = observeExecutor(executor, {
    rest: (id, failed) => {
      records.push([id, failed]);
    },
  });
  return { wrapped, records };
}

const signal = new AbortController().signal;

describe('observeExecutor (#96)', () => {
  it('D1 a submit the broker left without an answer is a failure', async () => {
    const result: SubmitResult = { outcome: 'unknown', reason: 'broker_unavailable' };
    const { wrapped, records } = observed(result);
    expect(await wrapped.submit(intent, signal)).toBe(result);
    expect(records).toEqual([['intent-1', true]]);
  });

  it('D2 another unknown reason is not counted', async () => {
    const { wrapped, records } = observed({ outcome: 'unknown', reason: 'executor_error' });
    await wrapped.submit(intent, signal);
    expect(records).toEqual([]);
  });

  it.each<SubmitResult>([
    {
      outcome: 'accepted',
      transport: 'socket',
      trade: openTradeFor({ mode: 'demo', assetId: 101, action: 'up', amount: '1' as never }),
    },
    { outcome: 'rejected', reason: 'broker_rejected' },
  ])('D3 an answered submit is an answer: $outcome', async (result) => {
    const { wrapped, records } = observed(result);
    expect(await wrapped.submit(intent, signal)).toBe(result);
    expect(records).toEqual([['intent-1', false]]);
  });

  it('D4 a throw passes on unchanged and counts nothing', async () => {
    const boom = new TypeError('executor bug');
    const { wrapped, records } = observed(boom);
    await expect(wrapped.submit(intent, signal)).rejects.toBe(boom);
    expect(records).toEqual([]);
  });
});
