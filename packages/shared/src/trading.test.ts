import { describe, expect, it } from 'vitest';
import {
  TRADE_INTENT_TRANSITIONS,
  TradeIntentStatus,
  canTransition,
  parseTradeIntent,
  safeParseTradeIntent,
  tradeIntentStatusSchema,
} from './trading';

const intent = {
  id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
  brokerAccountId: 'acc-1',
  telegramUserId: '42',
  mode: 'demo',
  assetId: 7,
  amount: '10.00',
  action: 'up',
  durationSec: 60,
  clientRequestId: 'req-1',
  createdAt: '2026-09-22T09:21:52.000Z',
};

describe('TradeIntentStatus', () => {
  it('lists every ARCH-03 state exactly once', () => {
    expect(tradeIntentStatusSchema.options).toEqual([
      'planned',
      'reserved',
      'queued',
      'submitting',
      'accepted',
      'settled',
      'rejected',
      'unknown',
      'reconciling',
      'manual_review',
    ]);
  });

  it('has a transition entry for every status', () => {
    expect(Object.keys(TRADE_INTENT_TRANSITIONS).sort()).toEqual(
      [...tradeIntentStatusSchema.options].sort(),
    );
  });

  it.each([
    ['planned', 'reserved'],
    ['reserved', 'queued'],
    ['queued', 'submitting'],
    ['submitting', 'accepted'],
    ['submitting', 'rejected'],
    ['submitting', 'unknown'],
    ['accepted', 'settled'],
    ['unknown', 'reconciling'],
    ['reconciling', 'accepted'],
    ['reconciling', 'rejected'],
    ['reconciling', 'manual_review'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['planned', 'accepted'],
    ['submitting', 'settled'],
    ['unknown', 'accepted'],
    ['settled', 'planned'],
    ['rejected', 'reconciling'],
    ['manual_review', 'accepted'],
    ['accepted', 'accepted'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('marks settled, rejected and manual_review as terminal', () => {
    for (const status of [
      TradeIntentStatus.Settled,
      TradeIntentStatus.Rejected,
      TradeIntentStatus.ManualReview,
    ]) {
      expect(TRADE_INTENT_TRANSITIONS[status]).toEqual([]);
    }
  });
});

describe('parseTradeIntent', () => {
  it('accepts the ARCH-03 shape', () => {
    expect(parseTradeIntent(intent)).toEqual(intent);
  });

  it('accepts an ISO timestamp with an offset', () => {
    expect(
      safeParseTradeIntent({ ...intent, createdAt: '2026-09-22T12:21:52+03:00' }).success,
    ).toBe(true);
  });

  it.each([
    ['id', 'not-a-uuid'],
    ['brokerAccountId', ''],
    ['mode', 'live'],
    ['assetId', 0],
    ['assetId', 1.5],
    ['amount', 10],
    ['amount', '10,00'],
    ['action', 'UP'],
    ['durationSec', 0],
    ['clientRequestId', ''],
    ['createdAt', '1790028496624'],
  ])('rejects %s=%j', (field, value) => {
    expect(safeParseTradeIntent({ ...intent, [field]: value }).success).toBe(false);
  });
});
