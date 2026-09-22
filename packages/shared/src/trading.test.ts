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

type TransitionMap = Readonly<Record<TradeIntentStatus, readonly TradeIntentStatus[]>>;

// the expected terminals are named, not derived from the graph under test
const EXPECTED_TERMINALS: readonly TradeIntentStatus[] = [
  TradeIntentStatus.Settled,
  TradeIntentStatus.Rejected,
];

function statusesThatCannotConclude(transitions: TransitionMap): string[] {
  const concludes = (from: TradeIntentStatus): boolean => {
    const seen = new Set<TradeIntentStatus>();
    const queue: TradeIntentStatus[] = [from];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (EXPECTED_TERMINALS.includes(current)) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...transitions[current]);
    }
    return false;
  };
  return Object.keys(transitions)
    .filter((status) => !concludes(status as TradeIntentStatus))
    .sort();
}

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
    ['planned', 'rejected'],
    ['reserved', 'queued'],
    ['reserved', 'rejected'],
    ['queued', 'submitting'],
    ['queued', 'rejected'],
    ['submitting', 'accepted'],
    ['submitting', 'rejected'],
    ['submitting', 'unknown'],
    ['accepted', 'settled'],
    ['unknown', 'reconciling'],
    ['reconciling', 'accepted'],
    ['reconciling', 'rejected'],
    ['reconciling', 'manual_review'],
    ['manual_review', 'settled'],
    ['manual_review', 'rejected'],
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

  it('makes rejected reachable from every non-terminal state except accepted and unknown', () => {
    const sources = Object.entries(TRADE_INTENT_TRANSITIONS)
      .filter(([, targets]) => targets.includes(TradeIntentStatus.Rejected))
      .map(([from]) => from);
    expect(sources.sort()).toEqual(
      ['manual_review', 'planned', 'queued', 'reconciling', 'reserved', 'submitting'].sort(),
    );
  });

  // #7 derives its "one active intent per account" index from the terminal set, so a status
  // that cannot reach a terminal would block an account permanently. Two separate invariants:
  // the terminal set is exactly these two, AND every status can actually get there. Checking
  // only the first misses a cycle; deriving the terminals from the same graph inside the
  // reachability check would make an accidental dead end look terminal and pass.
  it('has exactly settled and rejected as terminal', () => {
    const stuck = Object.entries(TRADE_INTENT_TRANSITIONS)
      .filter(([, targets]) => targets.length === 0)
      .map(([status]) => status);
    expect(stuck.sort()).toEqual([TradeIntentStatus.Rejected, TradeIntentStatus.Settled].sort());
  });

  it('lets every status reach settled or rejected', () => {
    expect(statusesThatCannotConclude(TRADE_INTENT_TRANSITIONS)).toEqual([]);
  });

  it('would catch a cycle that never concludes', () => {
    const cyclic: TransitionMap = {
      ...TRADE_INTENT_TRANSITIONS,
      reconciling: [TradeIntentStatus.ManualReview],
      manual_review: [TradeIntentStatus.Reconciling],
    };
    expect(statusesThatCannotConclude(cyclic)).toEqual(['manual_review', 'reconciling', 'unknown']);
  });

  it('answers false for a status outside the enum instead of throwing', () => {
    expect(canTransition('bogus' as never, 'rejected')).toBe(false);
  });

  it('marks settled and rejected as terminal', () => {
    for (const status of [TradeIntentStatus.Settled, TradeIntentStatus.Rejected]) {
      expect(TRADE_INTENT_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('keeps manual_review non-terminal so a parked intent can be resolved', () => {
    expect(TRADE_INTENT_TRANSITIONS[TradeIntentStatus.ManualReview]).not.toEqual([]);
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
    ['amount', '0'],
    ['amount', '-1'],
    ['action', 'UP'],
    ['durationSec', 0],
    ['clientRequestId', ''],
    ['createdAt', '1790028496624'],
  ])('rejects %s=%j', (field, value) => {
    expect(safeParseTradeIntent({ ...intent, [field]: value }).success).toBe(false);
  });
});
