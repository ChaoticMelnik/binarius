import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerRestError } from '@binarius/broker-rest';
import type { BrokerUser, DecimalString } from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import {
  brokerBalanceSnapshots,
  brokerTrades,
  createTradeIntent,
  markIntentAccepted,
  rejectIntent,
  settleClosedTrades,
  takeIntent,
  type TradeIntentRow,
} from '@binarius/db';
import {
  brokerAccountRow,
  createTempDatabase,
  intentRequest,
  seedQueuedIntent,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import type { AccessTokenOptions, AccessTokenOutcome } from '../broker/access-token';
import { createBalanceCheck } from './balance-check';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(async () => {
  await tmp.drop();
});

const money = (value: string) => value as DecimalString;
// the stake every seeded intent carries (intentRequest), so held '10' is exactly our open trade
const STAKE = '10';
const SECRET_HELD = '1234.56780000';

const userOf = (id: string, { demo = '0', real = '0' }: { demo?: string; real?: string }) =>
  ({
    id,
    level: { code: 'standard', rank: 1 },
    minTradeAmount: money('1'),
    demo: { available: money('100'), held: money(demo), total: money('100') },
    real: { available: money('100'), held: money(real), total: money('100') },
  }) satisfies BrokerUser;

async function take(intent: TradeIntentRow) {
  const taken = await takeIntent(tmp.db, {
    id: intent.id,
    expectedVersion: intent.version,
    maxAgeMs: 60_000,
  });
  if (taken === undefined) throw new Error('take failed');
  return taken;
}

async function accept(intent: TradeIntentRow) {
  const taken = await take(intent);
  const open = openTradeFor(taken);
  await tmp.db.transaction((tx) =>
    markIntentAccepted(tx, {
      id: taken.id,
      expectedVersion: taken.version,
      transport: 'socket',
      trade: open,
    }),
  );
  return open;
}

// an account with one accepted demo intent and its open trade of STAKE
async function withOpenTrade(patch: Parameters<typeof seedQueuedIntent>[1] = {}) {
  const seed = await seedQueuedIntent(tmp.db, patch);
  const open = await accept(seed.intent);
  const { brokerUserId } = await brokerAccountRow(tmp.db, seed.brokerAccountId);
  return { ...seed, open, brokerUserId };
}

function harness(
  answer: (signal: AbortSignal | undefined) => Promise<BrokerUser>,
  token: AccessTokenOutcome = { ok: true, accessToken: 'SECRET-token' },
) {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
  const tokenCalls: AccessTokenOptions[] = [];
  let gets = 0;
  const check = createBalanceCheck({
    db: tmp.db,
    rest: {
      getUser: (_auth, options) => {
        gets += 1;
        return answer(options?.signal);
      },
    },
    tokens: {
      accessToken: (_id, options = {}) => {
        tokenCalls.push(options);
        return Promise.resolve(token);
      },
    },
    logger,
  });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    run: (brokerAccountId: string, signal = new AbortController().signal) =>
      check.check(brokerAccountId, signal),
    tokenCalls,
    gets: () => gets,
    lines,
    all: (msg: string) => parsed().filter((entry) => entry.msg === msg),
  };
}

const snapshotOf = async (brokerAccountId: string) =>
  (
    await tmp.db
      .select()
      .from(brokerBalanceSnapshots)
      .where(eq(brokerBalanceSnapshots.brokerAccountId, brokerAccountId))
  )[0];

describe('createBalanceCheck (#92)', () => {
  it('B1 alerts when the broker holds more than our open trades, with no amount in any line', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf(a.brokerUserId, { demo: SECRET_HELD }));
    expect(await h.run(a.brokerAccountId)).toBe('mismatch');
    expect(h.all('broker balance mismatch')).toEqual([
      expect.objectContaining({
        level: 50,
        brokerAccountId: a.brokerAccountId,
        mode: 'demo',
        direction: 'broker_holds_more',
      }),
    ]);
    expect(Object.keys(h.all('broker balance mismatch')[0]!).sort()).toEqual(
      ['brokerAccountId', 'direction', 'hostname', 'level', 'mode', 'msg', 'pid', 'time'].sort(),
    );
    const text = h.lines.join('\n');
    expect(text).not.toContain('1234.5678');
    expect(text).not.toContain(STAKE + '.');
    expect(text).not.toContain('SECRET');
    // the snapshot is the broker's answer
    expect((await snapshotOf(a.brokerAccountId))?.demoHeld).toBe(SECRET_HELD);
  });

  it('B2 is quiet when held equals our open trades', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf(a.brokerUserId, { demo: STAKE }));
    expect(await h.run(a.brokerAccountId)).toBe('compared');
    expect(h.all('broker balance mismatch')).toEqual([]);
  });

  it('B3 is quiet when the broker holds less', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf(a.brokerUserId, { demo: '0' }));
    expect(await h.run(a.brokerAccountId)).toBe('compared');
    expect(h.all('broker balance mismatch')).toEqual([]);
  });

  it('B4 does not compare a mode whose trade is past its expected close', async () => {
    const a = await withOpenTrade();
    await tmp.db
      .update(brokerTrades)
      .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint - 120000` })
      .where(eq(brokerTrades.intentId, a.intent.id));
    const h = harness(async () => userOf(a.brokerUserId, { demo: SECRET_HELD }));
    expect(await h.run(a.brokerAccountId)).toBe('compared');
    expect(h.all('balance check not compared')).toEqual([
      expect.objectContaining({ mode: 'demo', reason: 'settlement_pending' }),
    ]);
    expect(h.all('broker balance mismatch')).toEqual([]);
  });

  it('B5 does not compare a mode with an intent in flight', async () => {
    const seed = await seedQueuedIntent(tmp.db);
    await take(seed.intent);
    const { brokerUserId } = await brokerAccountRow(tmp.db, seed.brokerAccountId);
    const h = harness(async () => userOf(brokerUserId, { demo: SECRET_HELD }));
    expect(await h.run(seed.brokerAccountId)).toBe('compared');
    expect(h.all('balance check not compared')).toEqual([
      expect.objectContaining({ mode: 'demo', reason: 'intent_unresolved' }),
    ]);
  });

  // in flight at the first read, rejected by the second: the broker may hold a trade the
  // rejection never saw, so the first read alone must keep the mode out
  it('B5b does not compare a mode whose intent was in flight at the first read', async () => {
    const seed = await seedQueuedIntent(tmp.db);
    const taken = await take(seed.intent);
    const { brokerUserId } = await brokerAccountRow(tmp.db, seed.brokerAccountId);
    const h = harness(async () => {
      await tmp.db.transaction((tx) =>
        rejectIntent(tx, { id: taken.id, from: 'submitting', reason: 'broker_rejected' }),
      );
      return userOf(brokerUserId, { demo: SECRET_HELD });
    });
    await h.run(seed.brokerAccountId);
    expect(h.all('balance check not compared')).toEqual([
      expect.objectContaining({ mode: 'demo', reason: 'intent_unresolved' }),
    ]);
    expect(h.all('broker balance mismatch')).toEqual([]);
  });

  it('B6 does not compare a mode whose trade settled during the GET', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => {
      await settleClosedTrades(tmp.db, {
        brokerAccountId: a.brokerAccountId,
        trades: [closedTradeFor(a.open)],
      });
      return userOf(a.brokerUserId, { demo: SECRET_HELD });
    });
    await h.run(a.brokerAccountId);
    expect(h.all('balance check not compared')).toEqual([
      expect.objectContaining({ mode: 'demo', reason: 'trades_changed' }),
    ]);
    expect(h.all('broker balance mismatch')).toEqual([]);
  });

  it('B6b does not compare a mode where a 5 s trade opened and settled during the GET (#313)', async () => {
    const seed = await seedUserWithAccount(tmp.db);
    const { brokerUserId } = await brokerAccountRow(tmp.db, seed.brokerAccountId);
    const h = harness(async () => {
      const { intent } = await createTradeIntent(
        tmp.db,
        intentRequest(seed.telegramUserId, { durationSec: 5 }),
      );
      const open = await accept(intent);
      await settleClosedTrades(tmp.db, {
        brokerAccountId: seed.brokerAccountId,
        trades: [closedTradeFor(open)],
      });
      // the broker still counts it: its settlement trails the close
      return userOf(brokerUserId, { demo: STAKE });
    });
    await h.run(seed.brokerAccountId);
    expect(h.all('balance check not compared')).toEqual([
      expect.objectContaining({ mode: 'demo', reason: 'trades_changed' }),
    ]);
    expect(h.all('broker balance mismatch')).toEqual([]);
  });

  it('B7 writes nothing and compares nothing for another user’s answer', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf('someone-else', { demo: SECRET_HELD }));
    expect(await h.run(a.brokerAccountId)).toBe('failed');
    expect(await snapshotOf(a.brokerAccountId)).toBeUndefined();
    expect(h.all('broker answered for another user, balance not stored')).toHaveLength(1);
    expect(h.all('broker balance mismatch')).toEqual([]);
  });

  it('B8 writes nothing and compares nothing for a held outside the stored domain', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf(a.brokerUserId, { demo: '1234567890123' }));
    expect(await h.run(a.brokerAccountId)).toBe('failed');
    expect(await snapshotOf(a.brokerAccountId)).toBeUndefined();
    expect(h.all('broker balance outside the stored domain')).toEqual([
      expect.objectContaining({ field: 'demo.held' }),
    ]);
  });

  it.each<AccessTokenOutcome>([
    { ok: false, reason: 'account_revoked' },
    { ok: false, reason: 'backend_unreachable' },
  ])('B9 makes no GET when the token is not handed out: %o', async (token) => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf(a.brokerUserId, {}), token);
    expect(await h.run(a.brokerAccountId)).toBe('failed');
    expect(h.gets()).toBe(0);
    expect(h.all('balance check failed')).toEqual([expect.objectContaining({ reason: 'token' })]);
  });

  it('B10 ends rate_limited on a 429, and failed on another broker error', async () => {
    const a = await withOpenTrade();
    const limited = harness(() =>
      Promise.reject(new BrokerRestError('rate_limited', { status: 429, retryAfterSec: 3 })),
    );
    expect(await limited.run(a.brokerAccountId)).toBe('rate_limited');
    const refused = harness(() =>
      Promise.reject(new BrokerRestError('unauthorized', { status: 401, detail: 'SECRET text' })),
    );
    expect(await refused.run(a.brokerAccountId)).toBe('failed');
    expect(refused.all('balance check failed')).toEqual([
      expect.objectContaining({ reason: 'broker', code: 'unauthorized', status: 401 }),
    ]);
    expect(refused.lines.join('\n')).not.toContain('SECRET');
  });

  it('B11 asks for the token with mayRefresh: false and the caller’s signal', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf(a.brokerUserId, { demo: STAKE }));
    const signal = new AbortController().signal;
    await h.run(a.brokerAccountId, signal);
    expect(h.tokenCalls).toEqual([{ mayRefresh: false, signal }]);
  });

  it('B12 does nothing for an already aborted signal', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf(a.brokerUserId, {}));
    expect(await h.run(a.brokerAccountId, AbortSignal.abort())).toBe('aborted');
    expect(h.tokenCalls).toEqual([]);
  });

  it('B13 alerts only for the mode that differs', async () => {
    const a = await withOpenTrade();
    const h = harness(async () => userOf(a.brokerUserId, { demo: SECRET_HELD, real: '0' }));
    expect(await h.run(a.brokerAccountId)).toBe('mismatch');
    expect(h.all('broker balance mismatch')).toEqual([expect.objectContaining({ mode: 'demo' })]);
  });
});
