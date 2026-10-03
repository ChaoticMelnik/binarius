import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { BrokerAccountStatus, logOptions } from '@binarius/shared';
import {
  brokerBalanceSnapshots,
  createTradeIntent,
  upsertBalanceSnapshot,
  type Db,
} from '@binarius/db';
import {
  createTempDatabase,
  intentRequest,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import {
  balanceTickLimit,
  createBalanceReconciler,
  type BalanceReconcilerConfig,
} from './balance-reconciler';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
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

// the fake token lookup: one answer per account, every call recorded with its options
const tokenAnswers = new Map<string, AccessTokenResult | (() => Promise<AccessTokenResult>)>();
const tokenCalls: { accountId: string; options: AccessTokenOptions }[] = [];
let lines: string[] = [];
beforeEach(() => {
  broker.rest.clearJournal();
  tokenCalls.length = 0;
  lines = [];
});

const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const logsAt = (level: number) => logs().filter((entry) => entry.level === level);
const WARN = 40;
const ERROR = 50;
const INFO = 30;

function reconciler(db: Db = tmp.db, config: Partial<BalanceReconcilerConfig> = {}) {
  return createBalanceReconciler({
    db,
    client: createBrokerRestClient({ baseUrl: broker.url }),
    accessToken: async (accountId, options) => {
      tokenCalls.push({ accountId, options });
      const answer = tokenAnswers.get(accountId) ?? { ok: false, reason: 'account_not_found' };
      return typeof answer === 'function' ? answer() : answer;
    },
    logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    config: { intervalMs: 60_000, maxPerMinute: 200, ...config },
  });
}

let mockSeq = 7_000;
async function linked(
  db: Db = tmp.db,
  patch: { status?: BrokerAccountStatus; accessTokenExpiresAt?: Date; brokerUserId?: string } = {},
) {
  const mockId = ++mockSeq;
  const token = `balance-token-${mockId}`;
  broker.users.register({ id: mockId, accessToken: token });
  const user = await seedUser(db);
  const accountId = await seedBrokerAccount(db, user.userId, {
    brokerUserId: String(mockId),
    ...patch,
  });
  tokenAnswers.set(accountId, { ok: true, accessToken: token });
  return { ...user, accountId, mockId, token };
}

async function rowOf(accountId: string, db: Db = tmp.db) {
  const [row] = await db
    .select()
    .from(brokerBalanceSnapshots)
    .where(eq(brokerBalanceSnapshots.brokerAccountId, accountId));
  return row;
}

async function shift(accountId: string, column: string, by: string, db: Db = tmp.db) {
  await db.execute(
    sql`update broker_balance_snapshots set ${sql.identifier(column)} = now() + ${by}::interval where broker_account_id = ${accountId}`,
  );
}

const userGets = () => broker.rest.journal.filter((entry) => entry.endpoint === 'user');

async function until(condition: () => boolean, what: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const userBody = (mockId: number, patch: Record<string, unknown> = {}) => ({
  ...broker.users.get(mockId),
  ...patch,
});

describe('refresh', () => {
  it('stores the broker user as the snapshot, and the next answer over it', async () => {
    const account = await linked();
    const balance = reconciler();
    expect(await balance.refresh(account.accountId)).toBe('ok');
    expect(userGets()).toHaveLength(1);
    expect(await rowOf(account.accountId)).toMatchObject({
      realAvailable: '0.00000000',
      demoAvailable: '10000.00000000',
      demoHeld: '0.00000000',
      levelCode: 'standard',
      lastRefreshError: null,
      lastRequestedAt: null,
    });

    broker.rest.failNext('user', {
      status: 200,
      body: userBody(account.mockId, {
        demo: { available: '9990.00', held: '10.00', total: '10000.00' },
      }),
    });
    expect(await balance.refresh(account.accountId, { requested: true })).toBe('ok');
    const row = await rowOf(account.accountId);
    expect(row).toMatchObject({ demoAvailable: '9990.00000000', demoHeld: '10.00000000' });
    expect(row!.lastRequestedAt).toBeInstanceOf(Date);
  });

  it('refuses an answer for another broker user and says so in the log', async () => {
    const account = await linked(tmp.db, { brokerUserId: 'someone-else' });
    const balance = reconciler();
    expect(await balance.refresh(account.accountId)).toBe('account_mismatch');
    expect(await rowOf(account.accountId)).toBeUndefined();
    const [warn] = logsAt(WARN);
    expect(warn).toMatchObject({
      accountId: account.accountId,
      expected: 'someone-else',
      received: String(account.mockId),
      msg: 'broker answered for another user, balance not stored',
    });
    expect(lines.join('\n')).not.toContain(account.token);
  });

  it.each([
    ['a 401', { status: 401 }, 'unauthorized', {}],
    ['a 429', { status: 429, retryAfterSec: 7 }, 'rate_limited', { retryAfterSec: 7 }],
    [
      'a 400 with an envelope',
      { status: 400, body: { error: { message: 'amount too small' } } },
      'rejected',
      { detail: 'amount too small' },
    ],
    ['a 503', { status: 503 }, 'unavailable', {}],
    ['a body that is not JSON', { status: 200, body: 'not json' }, 'contract_violation', {}],
  ])('records %s over the stored snapshot', async (_label, script, code, fields) => {
    const account = await linked();
    const balance = reconciler();
    await balance.refresh(account.accountId);
    const before = await rowOf(account.accountId);
    lines = [];

    broker.rest.failNext('user', script);
    expect(await balance.refresh(account.accountId)).toBe(code);

    const after = await rowOf(account.accountId);
    expect(after).toMatchObject({
      demoAvailable: before!.demoAvailable,
      restObservedAt: before!.restObservedAt,
      lastRefreshError: code,
    });
    expect(after!.lastRefreshFailedAt).toBeInstanceOf(Date);
    const warns = logsAt(WARN);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      accountId: account.accountId,
      err: { name: 'BrokerRestError', code },
      msg: 'balance refresh failed',
      ...fields,
    });
    expect(warns[0]!.err).not.toHaveProperty('cause');
    expect(lines.join('\n')).not.toContain(account.token);
    expect(lines.join('\n')).not.toContain(broker.url);
  });

  it('records a value outside the stored domain as a contract violation, by field only', async () => {
    const account = await linked();
    const balance = reconciler();
    await balance.refresh(account.accountId);
    lines = [];

    broker.rest.failNext('user', {
      status: 200,
      body: userBody(account.mockId, {
        real: { available: '1.123456789', held: '0', total: '1.123456789' },
      }),
    });
    expect(await balance.refresh(account.accountId)).toBe('contract_violation');
    expect(await rowOf(account.accountId)).toMatchObject({
      realAvailable: '0.00000000',
      lastRefreshError: 'contract_violation',
    });
    const warns = logsAt(WARN);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      accountId: account.accountId,
      field: 'real.available',
      msg: 'broker balance outside the stored domain',
    });
    expect(lines.join('\n')).not.toContain('1.123456789');
  });

  it.each<[string, AccessTokenResult, string, string | null]>([
    [
      'a pending account',
      { ok: false, reason: 'account_pending' },
      'account_pending',
      'account_pending',
    ],
    [
      'a revoked account',
      { ok: false, reason: 'account_revoked', revokedReason: 'refresh_invalid_grant' },
      'account_revoked',
      'account_revoked',
    ],
    [
      'a key this process lacks',
      { ok: false, reason: 'key_unavailable' },
      'key_unavailable',
      'key_unavailable',
    ],
    [
      'a token that needs an exchange',
      { ok: false, reason: 'refresh_needed' },
      'refresh_needed',
      null,
    ],
    ['a missing account', { ok: false, reason: 'account_not_found' }, 'account_not_found', null],
  ])('does not call the broker for %s', async (_label, answer, outcome, recorded) => {
    const account = await linked();
    const balance = reconciler();
    await balance.refresh(account.accountId);
    broker.rest.clearJournal();
    lines = [];

    tokenAnswers.set(account.accountId, answer);
    expect(await balance.refresh(account.accountId)).toBe(outcome);
    expect(userGets()).toHaveLength(0);
    expect((await rowOf(account.accountId))!.lastRefreshError).toBe(recorded);
    expect(logsAt(WARN)).toEqual([]);
  });

  it('makes one call for concurrent refreshes of an account, and stop() ends them', async () => {
    const first = await linked();
    const second = await linked();
    const balance = reconciler();
    broker.rest.failNext('user', { hang: true });
    const a = balance.refresh(first.accountId);
    const b = balance.refresh(first.accountId, { requested: true });
    await until(() => broker.rest.pendingHangs === 1, 'the hanging request');
    expect(await balance.refresh(second.accountId)).toBe('ok');
    expect(userGets()).toHaveLength(2);

    await balance.stop();
    expect(await a).toBe('aborted');
    expect(await b).toBe('aborted');
    await until(() => broker.rest.pendingHangs === 0, 'the aborted request to close');
    expect(await rowOf(first.accountId)).toBeUndefined();
    expect(logsAt(WARN)).toEqual([]);

    expect(await balance.refresh(second.accountId)).toBe('aborted');
    expect(userGets()).toHaveLength(2);
  });

  it('gives up at the caller’s signal without recording a failure', async () => {
    const account = await linked();
    const balance = reconciler();
    await balance.refresh(account.accountId);
    broker.rest.failNext('user', { hang: true });
    expect(await balance.refresh(account.accountId, { signal: AbortSignal.timeout(50) })).toBe(
      'aborted',
    );
    await until(() => broker.rest.pendingHangs === 0, 'the aborted request to close');
    expect((await rowOf(account.accountId))!.lastRefreshError).toBeNull();
    expect(logsAt(WARN)).toEqual([]);
    await balance.stop();
  });

  it('lets a direct refresh exchange the token', async () => {
    const account = await linked();
    await reconciler().refresh(account.accountId);
    expect(tokenCalls).toEqual([{ accountId: account.accountId, options: { mayRefresh: true } }]);
  });
});

describe('tick', () => {
  let own: TempDatabase;
  beforeEach(async () => {
    own = await createTempDatabase(baseUrl);
  });
  afterEach(() => own.drop());

  const withIntent = async (patch: Parameters<typeof linked>[1] = {}) => {
    const account = await linked(own.db, patch);
    await createTradeIntent(own.db, intentRequest(account.telegramUserId));
    return account;
  };

  // a snapshot the bot asked about a minute ago, observed `age` ago
  const requested = async (age: string, patch: Parameters<typeof linked>[1] = {}) => {
    const account = await linked(own.db, patch);
    await upsertBalanceSnapshot(own.db, {
      brokerAccountId: account.accountId,
      user: {
        id: String(account.mockId),
        level: { code: 'standard', rank: 1 },
        minTradeAmount: '1' as never,
        real: { available: '0' as never, held: '0' as never, total: '0' as never },
        demo: { available: '1' as never, held: '0' as never, total: '1' as never },
      },
      requested: true,
    });
    await shift(account.accountId, 'last_requested_at', '-1 minute', own.db);
    await shift(account.accountId, 'rest_observed_at', age, own.db);
    return account;
  };

  it('refreshes the accounts in work, never exchanging a token, and logs a summary', async () => {
    const intent = await withIntent();
    const asked = await requested('-5 minutes');
    const second = await withIntent();
    await requested('-1 minute').then((a) =>
      shift(a.accountId, 'last_requested_at', '-11 minutes', own.db),
    );
    await requested('-1 minute', { accessTokenExpiresAt: new Date(Date.now() + 30_000) });

    await reconciler(own.db).tick();

    expect(userGets()).toHaveLength(3);
    expect(new Set(tokenCalls.map((call) => call.accountId))).toEqual(
      new Set([intent.accountId, asked.accountId, second.accountId]),
    );
    expect(tokenCalls.every((call) => call.options.mayRefresh === false)).toBe(true);
    expect(logsAt(INFO).find((entry) => entry.msg === 'balance tick')).toMatchObject({
      candidates: 3,
      refreshed: 3,
      failed: 0,
      skipped: 0,
      watched: 4,
      withoutSnapshot: 0,
    });
  });

  it('takes at most the per-tick limit, never-observed accounts first', async () => {
    expect(balanceTickLimit(2, 60_000)).toBe(2);
    expect(balanceTickLimit(1, 10_000)).toBe(1);
    const old = await requested('-50 seconds');
    const first = await withIntent();
    const second = await withIntent();
    const balance = reconciler(own.db, { maxPerMinute: 2 });

    await balance.tick();
    expect(tokenCalls.map((call) => call.accountId).sort()).toEqual(
      [first.accountId, second.accountId].sort(),
    );
    tokenCalls.length = 0;
    await balance.tick();
    expect(tokenCalls.map((call) => call.accountId)[0]).toBe(old.accountId);
  });

  it('stops taking accounts after a 429', async () => {
    await withIntent();
    await withIntent();
    await withIntent();
    broker.rest.failNext('user', { status: 429, retryAfterSec: 3 });
    await reconciler(own.db, { concurrency: 1 }).tick();
    expect(userGets()).toHaveLength(1);
    expect(logsAt(INFO).find((entry) => entry.msg === 'balance tick')).toMatchObject({
      candidates: 3,
      failed: 1,
      refreshed: 0,
    });
  });

  it('warns when a watched snapshot is older than twice the SLA', async () => {
    await requested('-121 seconds');
    broker.rest.failNext('user', { status: 503 });
    await reconciler(own.db).tick();
    expect(
      logsAt(WARN).find((entry) => entry.msg === 'watched broker balances are stale'),
    ).toMatchObject({ watched: 1 });
    expect((logsAt(WARN).at(-1)!.oldestAgeSec as number) >= 121).toBe(true);
  });

  it('moves an account whose failure is recorded behind the healthy ones', async () => {
    const failing = await requested('-5 minutes', { brokerUserId: 'someone-else' });
    const healthy = await requested('-2 minutes');
    const balance = reconciler(own.db, { maxPerMinute: 1 });

    await balance.tick();
    expect(tokenCalls.map((call) => call.accountId)).toEqual([failing.accountId]);
    expect((await rowOf(failing.accountId, own.db))!.lastRefreshError).toBe('account_mismatch');
    tokenCalls.length = 0;
    await balance.tick();
    expect(tokenCalls.map((call) => call.accountId)).toEqual([healthy.accountId]);
  });

  it.each<
    [
      string,
      AccessTokenResult | (() => Promise<AccessTokenResult>),
      boolean,
      { failed: number; skipped: number },
    ]
  >([
    [
      'a key this process lacks, no snapshot',
      { ok: false, reason: 'key_unavailable' },
      false,
      { failed: 1, skipped: 0 },
    ],
    [
      'a token that needs an exchange',
      { ok: false, reason: 'refresh_needed' },
      true,
      { failed: 0, skipped: 1 },
    ],
    [
      'a user blocked after the candidates were listed',
      { ok: false, reason: 'user_blocked' },
      true,
      { failed: 0, skipped: 1 },
    ],
    [
      'an attempt that throws, no snapshot',
      () => Promise.reject(new Error('boom')),
      false,
      { failed: 1, skipped: 0 },
    ],
  ])(
    'holds back an account whose attempt left nothing in its row: %s',
    async (_label, answer, withSnapshot, firstTick) => {
      const stuck = withSnapshot ? await requested('-5 minutes') : await withIntent();
      const healthy = await requested('-2 minutes');
      tokenAnswers.set(stuck.accountId, answer);
      const balance = reconciler(own.db, { maxPerMinute: 1, stalledRetryMs: 100 });

      lines = [];
      await balance.tick();
      expect(tokenCalls.map((call) => call.accountId)).toEqual([stuck.accountId]);
      expect(userGets()).toHaveLength(0);
      expect(logsAt(INFO).find((entry) => entry.msg === 'balance tick')).toMatchObject(firstTick);
      tokenCalls.length = 0;

      await balance.tick();
      expect(tokenCalls.map((call) => call.accountId)).toEqual([healthy.accountId]);
      tokenCalls.length = 0;

      await new Promise((resolve) => setTimeout(resolve, 150));
      await shift(healthy.accountId, 'rest_observed_at', '0 seconds', own.db);
      await balance.tick();
      expect(tokenCalls.map((call) => call.accountId)).toEqual([stuck.accountId]);
      expect(logsAt(WARN).filter((entry) => entry.msg === 'balance refresh failed')).toEqual([]);
    },
  );

  it('logs an unexpected throw by name and code only, and goes on with the next account', async () => {
    const throwing = await withIntent();
    const next = await withIntent();
    tokenAnswers.set(throwing.accountId, () =>
      Promise.reject(
        Object.assign(new Error('insert into broker_balance_snapshots values (…)'), {
          code: '23514',
          detail: 'Failing row contains (secret-ish)',
        }),
      ),
    );
    await reconciler(own.db, { concurrency: 1 }).tick();

    const errors = logsAt(ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      accountId: throwing.accountId,
      err: { name: 'Error', code: '23514' },
      msg: 'balance refresh threw',
    });
    expect(lines.join('\n')).not.toContain('insert into');
    expect(lines.join('\n')).not.toContain('Failing row');
    expect(await rowOf(next.accountId, own.db)).toBeDefined();
  });

  // a behavioural test would not see a second timer: running ??= hides the doubled ticks
  it('arms one timer for a second start()', async () => {
    const balance = reconciler(own.db, { intervalMs: 60_000 });
    const spy = vi.spyOn(globalThis, 'setInterval');
    try {
      balance.start();
      balance.start();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      await balance.stop();
    }
  });

  it('runs on its timer without overlapping ticks, and stays stopped', async () => {
    await withIntent();
    broker.rest.failNext('user', { hang: true });
    const balance = reconciler(own.db, { intervalMs: 20 });
    balance.start();
    await until(() => broker.rest.pendingHangs === 1, 'the first tick to hang');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // later intervals found the tick still running
    expect(userGets()).toHaveLength(1);

    await balance.stop();
    const after = userGets().length;
    balance.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(userGets()).toHaveLength(after);
  });
});
