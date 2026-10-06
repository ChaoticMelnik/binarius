import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBrokerRestClient, type BrokerRestClient } from '@binarius/broker-rest';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { type DecimalString } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  brokerTrades,
  findTradeIntent,
  markIntentAccepted,
  takeIntent,
  tokenLedger,
  type Db,
} from '@binarius/db';
import { createTempDatabase, seedQueuedIntent, type TempDatabase } from '@binarius/db/testing';
import type { AccessTokenOutcome, AccessTokenOptions } from '../broker/access-token';
import { createSettlementCatchup, type SettlementCatchupConfig } from './settlement-catchup';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/trading-worker integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
let broker: MockBroker;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  broker = await startMockBroker();
});
afterAll(async () => {
  await broker.close();
  await tmp.drop();
});
// every case shares this database and a tick lists every overdue intent in it, so a case's
// leftovers are moved out of the queue (an open time a day ahead is never overdue)
afterEach(async () => {
  await tmp.db
    .update(brokerTrades)
    .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint + 86400000` })
    .where(eq(brokerTrades.status, 'open'));
});

const GRACE_MS = 30_000;

function capture() {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    logger,
    lines,
    parsed,
    all: (msg: string) => parsed().filter((l) => l.msg === msg),
    line: (msg: string) => parsed().find((l) => l.msg === msg),
  };
}

// token answers per account; an account without one is refused
const tokenAnswers = new Map<string, AccessTokenOutcome>();
const tokenCalls: { accountId: string; options: AccessTokenOptions | undefined }[] = [];
const tokens = {
  accessToken: (accountId: string, options?: AccessTokenOptions) => {
    tokenCalls.push({ accountId, options });
    return Promise.resolve(
      tokenAnswers.get(accountId) ?? ({ ok: false, reason: 'account_not_found' } as const),
    );
  },
};
afterEach(() => {
  tokenAnswers.clear();
  tokenCalls.length = 0;
});

const catchupOf = (
  logger: pino.Logger,
  config: Partial<SettlementCatchupConfig> = {},
  db: Db = tmp.db,
  rest: Pick<BrokerRestClient, 'listTrades'> = createBrokerRestClient({ baseUrl: broker.url }),
) =>
  createSettlementCatchup({
    db,
    rest,
    tokens,
    logger,
    config: {
      tickMs: 60_000,
      graceMs: GRACE_MS,
      batchSize: 20,
      pageSize: 50,
      maxPages: 2,
      attemptTimeoutMs: 2_000,
      stalledRetryMs: 60_000,
      ...config,
    },
  });

async function tickOnce(logger: pino.Logger, config: Partial<SettlementCatchupConfig> = {}) {
  const catchup = catchupOf(logger, config);
  await catchup.tick();
  await catchup.stop();
}

let brokerUserId = 20_000;

// an accepted intent whose trade the mock broker opened; overdue unless `overdue: false`
async function acceptedAtBroker({ overdue = true, ageMs = 10 * 60_000 } = {}) {
  const token = `catchup-token-${++brokerUserId}`;
  broker.users.register({ id: brokerUserId, accessToken: token });
  const seed = await seedQueuedIntent(tmp.db, { assetId: 101 });
  tokenAnswers.set(seed.brokerAccountId, { ok: true, accessToken: token });
  const taken = (await takeIntent(tmp.db, {
    id: seed.intent.id,
    expectedVersion: seed.intent.version,
    maxAgeMs: 60_000,
  }))!;
  const trade = await createBrokerRestClient({ baseUrl: broker.url }).openTrade(
    { accessToken: token },
    { assetId: 101, amount: '10.00' as DecimalString, action: 'up', durationSec: 60, isDemo: true },
  );
  const intent = (await tmp.db.transaction((tx) =>
    markIntentAccepted(tx, {
      id: taken.id,
      expectedVersion: taken.version,
      transport: 'socket',
      trade,
    }),
  ))!;
  if (overdue) {
    await tmp.db
      .update(brokerTrades)
      .set({ openTimestampMs: sql`(extract(epoch from now()) * 1000)::bigint - ${ageMs}` })
      .where(eq(brokerTrades.intentId, intent.id));
  }
  return { ...seed, intent, trade, token };
}

const statusOf = async (id: string) => (await findTradeIntent(tmp.db, id))!.status;
const tradeRow = async (intentId: string) =>
  (await tmp.db.select().from(brokerTrades).where(eq(brokerTrades.intentId, intentId)))[0]!;
const ledgerKinds = async (intentId: string) =>
  (
    await tmp.db
      .select({ kind: tokenLedger.kind })
      .from(tokenLedger)
      .where(eq(tokenLedger.intentId, intentId))
      .orderBy(tokenLedger.createdAt)
  ).map(({ kind }) => kind);
const askedFor = (accountId: string) => tokenCalls.filter((c) => c.accountId === accountId).length;

describe('createSettlementCatchup (#90)', () => {
  it('settles an overdue intent whose trade closed at the broker', async () => {
    const a = await acceptedAtBroker();
    broker.trades.settle(Number(a.trade.id), { outcome: 'win' });
    const log = capture();
    await tickOnce(log.logger);
    expect(await statusOf(a.intent.id)).toBe('settled');
    expect(await ledgerKinds(a.intent.id)).toEqual(['reserve', 'settle']);
    expect(await tradeRow(a.intent.id)).toMatchObject({ status: 'closed' });
    expect(tokenCalls).toEqual([
      { accountId: a.brokerAccountId, options: expect.objectContaining({ mayRefresh: false }) },
    ]);
    expect(log.line('settlement catch-up tick')).toMatchObject({
      overdue: 1,
      settled: 1,
      left: 0,
      stalled: 0,
      rateLimited: 0,
    });
  });

  it('leaves an intent alone until its expected close plus the grace has passed', async () => {
    const fresh = await acceptedAtBroker({ overdue: false });
    broker.trades.settle(Number(fresh.trade.id), { outcome: 'win' });
    const log = capture();
    await tickOnce(log.logger);
    expect(askedFor(fresh.brokerAccountId)).toBe(0);
    expect(await statusOf(fresh.intent.id)).toBe('accepted');
    expect(log.line('settlement catch-up tick')).toBeUndefined();
  });

  it('applies the other closed trades of the page as well, idempotently', async () => {
    const a = await acceptedAtBroker();
    // a platform trade of the same broker user: no intent behind it
    const platform = await createBrokerRestClient({ baseUrl: broker.url }).openTrade(
      { accessToken: a.token },
      { assetId: 101, amount: '5.00' as DecimalString, action: 'down', durationSec: 60, isDemo: true },
    );
    broker.trades.settle(Number(platform.id), { outcome: 'loss' });
    broker.trades.settle(Number(a.trade.id), { outcome: 'loss' });
    await tickOnce(capture().logger);
    expect(await statusOf(a.intent.id)).toBe('settled');
    // a second pass over the same page debits nothing again
    await tickOnce(capture().logger);
    expect(await ledgerKinds(a.intent.id)).toEqual(['reserve', 'settle']);
  });

  // a page the broker cuts below the limit is not the list's end
  it('reads past a page the broker cut short', async () => {
    const a = await acceptedAtBroker();
    const client = createBrokerRestClient({ baseUrl: broker.url });
    for (let i = 0; i < 2; i += 1) {
      const later = await client.openTrade(
        { accessToken: a.token },
        { assetId: 101, amount: '5.00' as DecimalString, action: 'down', durationSec: 60, isDemo: true },
      );
      broker.trades.settle(Number(later.id), { outcome: 'loss' });
    }
    broker.trades.settle(Number(a.trade.id), { outcome: 'win' });
    const capped: Pick<BrokerRestClient, 'listTrades'> = {
      listTrades: async (auth, filter, options) =>
        (await client.listTrades(auth, filter, options)).slice(0, 2),
    };
    const log = capture();
    const catchup = catchupOf(log.logger, { maxPages: 2 }, tmp.db, capped);
    await catchup.tick();
    await catchup.stop();
    expect(await statusOf(a.intent.id)).toBe('settled');
    expect(log.line('overdue trade not closed at the broker')).toBeUndefined();
  });

  it('holds back an account whose trade is still open, so the next one is reached', async () => {
    const stuck = await acceptedAtBroker({ ageMs: 20 * 60_000 });
    const next = await acceptedAtBroker({ ageMs: 10 * 60_000 });
    broker.trades.settle(Number(next.trade.id), { outcome: 'win' });
    const log = capture();
    const catchup = catchupOf(log.logger, { batchSize: 1, stalledRetryMs: 300 });
    await catchup.tick();
    expect(askedFor(stuck.brokerAccountId)).toBe(1);
    expect(await statusOf(stuck.intent.id)).toBe('accepted');
    expect(log.line('overdue trade not closed at the broker')).toMatchObject({
      intentId: stuck.intent.id,
      brokerTradeId: stuck.trade.id,
      pagesRead: 1,
    });
    await catchup.tick();
    expect(askedFor(next.brokerAccountId)).toBe(1);
    expect(await statusOf(next.intent.id)).toBe('settled');
    expect(askedFor(stuck.brokerAccountId)).toBe(1);
    // once the hold lapses the stuck account is the head of the queue again
    await until('the hold to lapse', async () => {
      await catchup.tick();
      return askedFor(stuck.brokerAccountId) === 2;
    });
    await catchup.stop();
    expect(askedFor(next.brokerAccountId)).toBe(1);
  });

  it.each(['refresh_needed', 'user_blocked'] as const)(
    'holds back an account whose token is refused with %s, one warning per attempt',
    async (refusal) => {
      const a = await acceptedAtBroker();
      tokenAnswers.set(a.brokerAccountId, { ok: false, reason: refusal });
      const log = capture();
      const catchup = catchupOf(log.logger);
      await catchup.tick();
      await catchup.tick();
      await catchup.stop();
      expect(askedFor(a.brokerAccountId)).toBe(1);
      expect(log.all('settlement catch-up token refused')).toEqual([
        expect.objectContaining({
          intentId: a.intent.id,
          brokerAccountId: a.brokerAccountId,
          refusal,
        }),
      ]);
      expect(await statusOf(a.intent.id)).toBe('accepted');
    },
  );

  it('holds back an account when the backend is unreachable', async () => {
    const a = await acceptedAtBroker();
    tokenAnswers.set(a.brokerAccountId, { ok: false, reason: 'backend_unreachable' });
    const log = capture();
    const catchup = catchupOf(log.logger);
    await catchup.tick();
    await catchup.tick();
    await catchup.stop();
    expect(askedFor(a.brokerAccountId)).toBe(1);
    expect(log.line('settlement catch-up token unavailable')).toMatchObject({
      failure: 'backend_unreachable',
    });
  });

  it('ends the tick on rate_limited without holding anyone back', async () => {
    const first = await acceptedAtBroker({ ageMs: 20 * 60_000 });
    const second = await acceptedAtBroker({ ageMs: 10 * 60_000 });
    broker.rest.failNext('tradesList', { status: 429, retryAfterSec: 3 });
    const log = capture();
    const catchup = catchupOf(log.logger);
    await catchup.tick();
    expect(askedFor(first.brokerAccountId)).toBe(1);
    expect(askedFor(second.brokerAccountId)).toBe(0);
    expect(log.line('settlement catch-up trade list failed')).toMatchObject({
      intentId: first.intent.id,
      status: 429,
      retryAfterSec: 3,
    });
    expect(log.line('settlement catch-up tick')).toMatchObject({ rateLimited: 1, stalled: 0 });
    // not held back: the next tick asks for the same account again
    await catchup.tick();
    await catchup.stop();
    expect(askedFor(first.brokerAccountId)).toBe(2);
  });

  it('logs a throwing settlement by name and code only and holds the account back', async () => {
    const a = await acceptedAtBroker();
    broker.trades.settle(Number(a.trade.id), { outcome: 'win' });
    const failing = new Proxy(tmp.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return () => Promise.reject(new Error('connection lost: secret-dsn'));
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const log = capture();
    const catchup = catchupOf(log.logger, {}, failing);
    await catchup.tick();
    await catchup.tick();
    await catchup.stop();
    expect(askedFor(a.brokerAccountId)).toBe(1);
    expect(log.line('settlement catch-up attempt failed')).toMatchObject({
      intentId: a.intent.id,
      err: { name: 'Error' },
    });
    expect(log.lines.join('\n')).not.toContain('secret-dsn');
    expect(await statusOf(a.intent.id)).toBe('accepted');
  });

  // the token source answers an aborted request as backend_unreachable
  it('does not hold back an account when stop() lands in its token fetch', async () => {
    const a = await acceptedAtBroker();
    let entered = false;
    const original = tokens.accessToken;
    tokens.accessToken = (accountId, options) => {
      if (accountId !== a.brokerAccountId) return original(accountId, options);
      entered = true;
      return new Promise<AccessTokenOutcome>((resolve) => {
        options?.signal?.addEventListener('abort', () =>
          resolve({ ok: false, reason: 'backend_unreachable' }),
        );
      });
    };
    try {
      const log = capture();
      const catchup = catchupOf(log.logger);
      void catchup.tick();
      await until('the token fetch to start', () => entered);
      await catchup.stop();
      expect(log.line('settlement catch-up tick')).toMatchObject({ overdue: 1, stalled: 0 });
      expect(log.line('settlement catch-up token unavailable')).toBeUndefined();
    } finally {
      tokens.accessToken = original;
    }
  });

  it('waits for the attempt in flight on stop', async () => {
    const a = await acceptedAtBroker();
    let release!: () => void;
    let entered = false;
    const hanging = new Promise<AccessTokenOutcome>((resolve) => {
      release = () => resolve({ ok: false, reason: 'backend_unreachable' });
    });
    const original = tokens.accessToken;
    tokens.accessToken = (accountId, options) => {
      if (accountId !== a.brokerAccountId) return original(accountId, options);
      entered = true;
      return hanging;
    };
    try {
      const catchup = catchupOf(capture().logger);
      void catchup.tick();
      await until('the attempt to start', () => entered);
      let stoppedAt: 'before' | 'after' = 'before';
      const stopping = catchup.stop().then(() => {
        stoppedAt = 'after';
      });
      // a few turns of the event loop: stop() has had every chance to resolve on its own
      for (let turn = 0; turn < 10; turn += 1) await new Promise(setImmediate);
      expect(stoppedAt).toBe('before');
      release();
      await stopping;
      expect(stoppedAt).toBe('after');
    } finally {
      tokens.accessToken = original;
    }
  });
});
