import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SignalDecisionContext,
  SignalDecisionOutcome,
  SignalKind,
  TradeAction,
  TradeMode,
  decimalStringSchema,
  shadowTicksSampled,
  type DecimalString,
} from '@binarius/shared';
import {
  insertDecisionTicks,
  listDecisionTicksCandidates,
  shadowSampledSql,
  sweepSignalDecisions,
  type DecisionTicksInsert,
} from './decision-ticks-ops';
import { decisionTicks, signalDecisions } from './schema/index';
import { recordSignalDecision } from './signal-decision-ops';
import {
  createTempDatabase,
  decisionFixture,
  seedBrokerTradeFor,
  seedTradingSession,
  seedUserWithAccount,
  shadowDecisionFixture,
  signalRecordFixture,
  type TempDatabase,
} from './testing';
import { createSessionIntent } from './trading-session-ops';

// The keeper's reads and writes (#668, docs/trade-log.md → The ticks around a decision,
// → Retention) on a temporary migrated database. Before each case every row already there is
// moved an hour back, out of the capture horizon and far from the retention cutoffs.
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
beforeEach(async () => {
  await tmp.db.execute(
    sql`update signal_decisions set recorded_at = recorded_at - interval '1 hour'`,
  );
});

const HORIZON_MS = 240_000;
const candidates = (limit = 100) =>
  listDecisionTicksCandidates(tmp.db, { horizonMs: HORIZON_MS, limit });
const sweep = (batch = 500) =>
  sweepSignalDecisions(tmp.db, { retentionDays: 30, shadowRetentionDays: 7, batch });

async function seedSession() {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId);
  return { ...seed, sessionId: session.id };
}

// an intent decision of a fresh session; `profit` settles its broker trade
async function intentDecision(trade?: { profit?: DecimalString }) {
  const session = await seedSession();
  const { intent } = await createSessionIntent(tmp.db, {
    sessionId: session.sessionId,
    step: 1,
    telegramUserId: session.telegramUserId,
    brokerAccountId: session.brokerAccountId,
    mode: TradeMode.Demo,
    assetId: 101,
    amount: decimalStringSchema.parse('1'),
    action: TradeAction.Up,
    durationSec: 15,
    decision: decisionFixture(session, { step: 1 }, signalRecordFixture()),
  });
  if (trade !== undefined) await seedBrokerTradeFor(tmp.db, intent, trade);
  return { session, intent, decisionId: intent.signalDecisionId! };
}

async function sessionDecision(
  outcome: SignalDecisionOutcome,
  context: SignalDecisionContext = SignalDecisionContext.Session,
) {
  const session = await seedSession();
  const input = decisionFixture(session, {
    outcome,
    detail: outcome === SignalDecisionOutcome.Refused ? 'trading_paused' : null,
  });
  const noSignal =
    outcome === SignalDecisionOutcome.NoSignal ? { kind: SignalKind.NoSignal, action: null } : {};
  const start =
    context === SignalDecisionContext.SessionStart
      ? { context, tradingSessionId: null, step: null }
      : {};
  return (await recordSignalDecision(tmp.db, { ...input, ...noSignal, ...start })).id;
}

// a shadow row whose id starts with `head` (four hex digits); nothing references a fresh one
async function shadowDecision(head: string) {
  const { id } = await recordSignalDecision(tmp.db, shadowDecisionFixture());
  const pinned = `${head}${randomUUID().slice(4)}`;
  await tmp.db.update(signalDecisions).set({ id: pinned }).where(eq(signalDecisions.id, id));
  return pinned;
}

const age = (id: string, interval: string) =>
  tmp.db.execute(
    sql`update signal_decisions set recorded_at = now() - ${interval}::interval where id = ${id}`,
  );

const ticksRow = (decisionId: string, patch: Partial<DecisionTicksInsert> = {}) =>
  ({
    decisionId,
    fromMs: 1_759_999_940_000,
    untilMs: 1_760_000_020_000,
    status: 'complete',
    detail: null,
    count: 1,
    ticks: [[1_759_999_950_000, 1_759_999_950_100, 1.1]],
    ...patch,
  }) as DecisionTicksInsert;

const exists = async (ids: string[]) =>
  (
    await tmp.db
      .select({ id: signalDecisions.id })
      .from(signalDecisions)
      .where(inArray(signalDecisions.id, ids))
  ).map((row) => row.id);

describe('listDecisionTicksCandidates (#668)', () => {
  it('K1 an intent decision with its closed trade is a candidate with the close', async () => {
    const { decisionId, intent } = await intentDecision({ profit: '0.85' as DecimalString });
    const found = (await candidates()).find((c) => c.id === decisionId);
    expect(found).toMatchObject({
      context: 'session',
      assetId: 101,
      decidedAtMs: signalRecordFixture().entry.nowMs,
      ticksUntilMs: null,
      intentStatus: 'settled',
      tradeStatus: 'closed',
      closeTimestampMs: expect.any(Number),
    });
    expect(found!.intentUpdatedAtMs).toBeGreaterThanOrEqual(intent.createdAt.getTime());
  });

  it('K2 decisions that are neither an intent nor a shadow row never are', async () => {
    const ids = [
      await sessionDecision(SignalDecisionOutcome.NoSignal),
      await sessionDecision(SignalDecisionOutcome.Refused),
      await sessionDecision(SignalDecisionOutcome.Paused),
      await sessionDecision(SignalDecisionOutcome.NoSignal, SignalDecisionContext.SessionStart),
    ];
    expect(await candidates()).toEqual([]);
    expect(await exists(ids)).toHaveLength(4);
  });

  it('K3 a shadow row is a candidate only when sampled', async () => {
    const sampled = await shadowDecision('0014');
    await shadowDecision('0015');
    expect((await candidates()).map((c) => c.id)).toEqual([sampled]);
    expect((await candidates())[0]).toMatchObject({
      context: 'shadow',
      ticksUntilMs: shadowDecisionFixture().ticksUntilMs,
      intentStatus: null,
    });
  });

  it('K4 a decision with a ticks row is not', async () => {
    const { decisionId } = await intentDecision();
    await insertDecisionTicks(tmp.db, [ticksRow(decisionId)]);
    expect(await candidates()).toEqual([]);
  });

  it('K5 a decision recorded before the horizon is not', async () => {
    const { decisionId } = await intentDecision();
    await age(decisionId, '241 seconds');
    expect(await candidates()).toEqual([]);
    await age(decisionId, '239 seconds');
    expect((await candidates()).map((c) => c.id)).toEqual([decisionId]);
  });

  it('K6 candidates come oldest first, up to the limit', async () => {
    const a = (await intentDecision()).decisionId;
    const b = await shadowDecision('0000');
    const c = (await intentDecision()).decisionId;
    await age(a, '10 seconds');
    await age(b, '30 seconds');
    await age(c, '20 seconds');
    expect((await candidates()).map((row) => row.id)).toEqual([b, c, a]);
    expect((await candidates(2)).map((row) => row.id)).toEqual([b, c]);
  });

  it('K13 the SQL sample is shadowTicksSampled', async () => {
    const ids = Array.from({ length: 200 }, () => randomUUID());
    const { rows } = await tmp.db.execute<{ id: string; sampled: boolean }>(sql`
      select id::text as id, ${shadowSampledSql(sql.raw('id'))} as sampled
      from unnest(array[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]) as id
    `);
    expect(rows).toHaveLength(200);
    for (const row of rows) expect(row.sampled, row.id).toBe(shadowTicksSampled(row.id));
    expect(rows.some((row) => row.sampled)).toBe(true);
  });
});

describe('insertDecisionTicks (#668)', () => {
  it('K7 writes the row once; a second insert of the decision is a no-op', async () => {
    const { decisionId } = await intentDecision();
    expect(await insertDecisionTicks(tmp.db, [ticksRow(decisionId)])).toBe(1);
    expect(
      await insertDecisionTicks(tmp.db, [
        ticksRow(decisionId, { status: 'truncated', detail: 'hole' }),
      ]),
    ).toBe(0);
    const rows = await tmp.db
      .select()
      .from(decisionTicks)
      .where(eq(decisionTicks.decisionId, decisionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'complete', count: 1 });
  });
});

describe('sweepSignalDecisions (#668)', () => {
  it('K8 a shadow row goes after 7 days, not before', async () => {
    const old = await shadowDecision('0015');
    const young = await shadowDecision('0016');
    await age(old, '8 days');
    await age(young, '6 days');
    expect(await sweep()).toEqual({ decisions: 1, ticks: 0 });
    expect(await exists([old, young])).toEqual([young]);
    await age(young, '8 days');
    expect(await sweep()).toEqual({ decisions: 1, ticks: 0 });
  });

  it('K9 any other row without an intent goes after 30 days, not before', async () => {
    const old = [
      await sessionDecision(SignalDecisionOutcome.NoSignal),
      await sessionDecision(SignalDecisionOutcome.Refused),
      await sessionDecision(SignalDecisionOutcome.NoSignal, SignalDecisionContext.SessionStart),
    ];
    const young = await sessionDecision(SignalDecisionOutcome.Paused);
    for (const id of old) await age(id, '31 days');
    await age(young, '29 days');
    expect(await sweep()).toEqual({ decisions: 3, ticks: 0 });
    expect(await exists([...old, young])).toEqual([young]);
  });

  it('K11 a ticks row goes with its decision, in the same batch as rows without one', async () => {
    const withTicks = await shadowDecision('0000');
    const without = await shadowDecision('0017');
    await insertDecisionTicks(tmp.db, [ticksRow(withTicks)]);
    await age(withTicks, '8 days');
    await age(without, '8 days');
    expect(await sweep()).toEqual({ decisions: 2, ticks: 1 });
    expect(await exists([withTicks, without])).toEqual([]);
    const left = await tmp.db
      .select()
      .from(decisionTicks)
      .where(eq(decisionTicks.decisionId, withTicks));
    expect(left).toEqual([]);
  });

  it('K12 batch bounds one statement, oldest first', async () => {
    const ids = [
      await shadowDecision('0018'),
      await shadowDecision('0019'),
      await shadowDecision('001a'),
    ];
    await age(ids[0]!, '10 days');
    await age(ids[1]!, '9 days');
    await age(ids[2]!, '8 days');
    expect(await sweep(2)).toEqual({ decisions: 2, ticks: 0 });
    expect(await exists(ids)).toEqual([ids[2]]);
    expect(await sweep(2)).toEqual({ decisions: 1, ticks: 0 });
    expect(await sweep(2)).toEqual({ decisions: 0, ticks: 0 });
  });

  // last: a sweep that deleted it would fail on every later case through the intent's FK
  it('K10 a row an intent names is kept at any age', async () => {
    const { decisionId } = await intentDecision({ profit: '-1' as DecimalString });
    await age(decisionId, '400 days');
    expect(await sweep()).toEqual({ decisions: 0, ticks: 0 });
    expect(await exists([decisionId])).toEqual([decisionId]);
  });
});
