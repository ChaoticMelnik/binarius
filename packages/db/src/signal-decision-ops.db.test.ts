import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignalDecisionContext, SignalDecisionOutcome } from '@binarius/shared';
import { signalDecisions } from './schema/index';
import { recordSignalDecision, signalDecisionInput } from './signal-decision-ops';
import {
  createTempDatabase,
  decisionFixture,
  seedTradingSession,
  seedUserWithAccount,
  signalRecordFixture,
  type TempDatabase,
} from './testing';

// The trade log's writer (#666, docs/trade-log.md), on a temporary migrated database.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

async function seedSession() {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
  return { ...seed, sessionId: session.id };
}

describe('recordSignalDecision (#666)', () => {
  it('SD1 inserts the row with every column of its input', async () => {
    const session = await seedSession();
    const input = decisionFixture(session, {
      outcome: SignalDecisionOutcome.Refused,
      detail: 'trading_paused',
      step: 3,
    });
    const { id } = await recordSignalDecision(tmp.db, input);
    const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
    expect(row).toMatchObject({ ...input, series: [...input.series], result: null });
  });

  it.each([
    [SignalDecisionOutcome.Intent, null],
    [SignalDecisionOutcome.Paused, null],
    [SignalDecisionOutcome.Replayed, null],
    [SignalDecisionOutcome.StakeStop, 'max_session_loss'],
    [SignalDecisionOutcome.Refused, 'client_request_id_conflict'],
  ] as const)(
    'SD2 the builder gives a row the CHECKs accept for a signal recorded as %s',
    async (outcome, detail) => {
      const session = await seedSession();
      await expect(
        recordSignalDecision(tmp.db, decisionFixture(session, { outcome, detail })),
      ).resolves.toMatchObject({ id: expect.any(String) });
    },
  );

  it('SD3 a no_signal entry of the start route, without a session, a tick or a payout', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const record = signalRecordFixture();
    const entry = {
      ...record.entry,
      decision: {
        kind: 'no_signal' as const,
        version: 'v2' as const,
        reason: 'insufficient_candles' as const,
        detail: { closedCandles: 2, required: 50 },
      },
    };
    const input = signalDecisionInput(
      { entry, lastTick: null },
      {
        context: SignalDecisionContext.SessionStart,
        tradingSessionId: null,
        brokerAccountId: seed.brokerAccountId,
        step: null,
        payout: null,
        takenAtMs: entry.nowMs + 3,
        outcome: SignalDecisionOutcome.NoSignal,
        detail: null,
      },
    );
    expect(input).toMatchObject({ kind: 'no_signal', action: null, decidedAtMs: entry.nowMs });
    const { id } = await recordSignalDecision(tmp.db, input);
    const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
    expect(row).toMatchObject({ lastTick: null, payout: null, step: null });
  });

  // the catalog's payout is unbounded (#631): one numeric(8,4) >= 0 cannot hold is stored as NULL
  it.each([
    [-1, null],
    [-0.00001, null],
    [10_000, null],
    [1e21, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [0, 0],
    [1e-7, 0],
    [9999.9999, 9999.9999],
  ])('SD14 a payout of %s is recorded as %s', async (payout, stored) => {
    const session = await seedSession();
    const { id } = await recordSignalDecision(tmp.db, decisionFixture(session, { payout }));
    const [row] = await tmp.db.select().from(signalDecisions).where(eq(signalDecisions.id, id));
    expect(row!.payout).toBe(stored);
  });
});
