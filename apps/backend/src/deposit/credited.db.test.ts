import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBrokerRestClient } from '@binarius/broker-rest';
import {
  BotLanguage,
  BrokerAccountStatus,
  DEPOSIT_CREDITED_PATH,
  DEPOSIT_WIDGET_SESSION_PATH,
  DepositErrorCode,
  NotificationLevel,
  UserStatus,
  formatUsd,
  safeParseDepositCreditedResponse,
  safeParseDepositRefusal,
  type DecimalString,
} from '@binarius/shared';
import { brokerBalanceSnapshots, users, type Db } from '@binarius/db';
import {
  createTempDatabase,
  seedBalanceSnapshot,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { startMockBroker, type MockBroker } from '@binarius/mock-broker';
import { until } from '@binarius/shared/testing';
import { buildApp } from '../app';
import {
  captureApi,
  callsTo,
  inlineButtons,
  pushedText,
  sentPayload,
  unusedAdminDeps,
  unusedPaymentsDeps,
} from '../admin/testing';
import { createClientPush } from '../auth/client-push';
import type { AuthRoutesDeps } from '../auth/routes';
import { DEPOSIT_INIT_DATA_MAX_AGE_MS } from '../auth/oauth-timing';
import { createInitDataVerifier } from '../auth/telegram-init-data';
import { signInitData } from '../auth/testing/init-data';
import { clientLabelsOf, clientTextsOf } from '../auth/texts';
import {
  createBalanceReconciler,
  type BalanceReconciler,
  type BalanceRefreshOptions,
  type BalanceRefreshOutcome,
} from '../broker/balance-reconciler';
import type { UsersRoutesDeps } from '../users/routes';
import {
  PAIRS_TEST_TOKEN,
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSessionDeps,
  unusedSignalDeps,
  unusedSignalsDeps,
} from '../trading/testing';
import type { DepositRoutesDeps } from './routes';
import { unusedDepositDeps } from './testing';

// the Russian texts, the language of every user these tests make (#633)
const RU_TEXTS = clientTextsOf(BotLanguage.Ru);
const RU_LABELS = clientLabelsOf(BotLanguage.Ru);

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const BOT_TOKEN = '5678:credited-test-bot';
const PUSH_TOKEN = '1234:credited-push-bot';

let tmp: TempDatabase;
let broker: MockBroker;
let reconciler: BalanceReconciler;
let app: FastifyInstance;
let captured: ReturnType<typeof captureApi>;
const lines: string[] = [];
const extraApps: FastifyInstance[] = [];
// every refresh the main app asked the real reconciler for, with its options
const refreshCalls: { accountId: string; options: BalanceRefreshOptions | undefined }[] = [];
// the access token and the broker user per account, as ensureFreshAccessToken would hand them out
const tokens = new Map<string, { accessToken: string; brokerUserId: string }>();

let mockSeq = 0;
// a user with one active account the mock broker knows, holding `real` on its real balance
async function payer(real = '1234.50', status: UserStatus = UserStatus.Active) {
  const mockId = ++mockSeq;
  broker.users.register({ id: mockId, accessToken: `token-${mockId}`, real: { available: real } });
  const user = await seedUser(tmp.db, { status });
  const accountId = await seedBrokerAccount(tmp.db, user.userId, { brokerUserId: String(mockId) });
  tokens.set(accountId, { accessToken: `token-${mockId}`, brokerUserId: String(mockId) });
  return { ...user, accountId };
}

const verifier = () =>
  createInitDataVerifier({ botToken: BOT_TOKEN, maxAgeMs: DEPOSIT_INIT_DATA_MAX_AGE_MS });

function depositDeps(overrides: Partial<DepositRoutesDeps>): DepositRoutesDeps {
  return {
    ...unusedDepositDeps(),
    db: tmp.db,
    initDataVerifier: verifier(),
    ...overrides,
  };
}

function testApp(deposit: DepositRoutesDeps): FastifyInstance {
  return buildApp({
    deposit,
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'trace',
    checkTimeoutMs: 20,
    logDestination: { write: (line: string) => void lines.push(line) },
    trading: {
      db: tmp.db,
      internalApiToken: PAIRS_TEST_TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
      demoOnly: false,
    },
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
    payments: unusedPaymentsDeps(),
  });
}

async function extraApp(overrides: Partial<DepositRoutesDeps>): Promise<FastifyInstance> {
  const extra = testApp(depositDeps(overrides));
  extraApps.push(extra);
  await extra.ready();
  return extra;
}

// a push seam of its own whose sends are recorded
function recordedPush() {
  const push = createClientPush({ token: PUSH_TOKEN });
  return { push, captured: captureApi(push) };
}

// a balance seam that answers `outcome` and records its calls
function stubBalance(answer: () => Promise<BalanceRefreshOutcome>) {
  const calls: { accountId: string; options: BalanceRefreshOptions | undefined }[] = [];
  return {
    calls,
    balance: {
      refresh: (accountId: string, options?: BalanceRefreshOptions) => {
        calls.push({ accountId, options });
        return answer();
      },
    },
  };
}

const failing = {
  refresh: (): Promise<BalanceRefreshOutcome> => {
    throw new Error('the balance was refreshed');
  },
};

// a database that fails the test on any use
const noDb = new Proxy({} as Db, {
  get: () => {
    throw new Error('the database was read');
  },
});

const initDataFor = (telegramUserId: string | bigint, authDate?: number) =>
  signInitData({
    botToken: BOT_TOKEN,
    telegramUserId: BigInt(telegramUserId),
    ...(authDate === undefined ? {} : { authDate }),
  });

const hashOf = (initData: string) => new URLSearchParams(initData).get('hash') ?? 'no hash';

const credited = (target: FastifyInstance, payload: object) =>
  target.inject({ method: 'POST', url: DEPOSIT_CREDITED_PATH, payload });
const creditedFor = (telegramUserId: string, target: FastifyInstance = app) =>
  credited(target, { initData: initDataFor(telegramUserId) });

function expectRefusal(
  response: { statusCode: number; json: () => unknown },
  status: number,
  error: DepositErrorCode,
) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({ error });
  expect(safeParseDepositRefusal(response.json()).success).toBe(true);
}

function expectOutcome(
  response: { statusCode: number; json: () => unknown },
  outcome: 'refreshed' | 'pending',
) {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ outcome });
  expect(safeParseDepositCreditedResponse(response.json()).success).toBe(true);
}

const logged = (msg: string) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.msg === msg);
const sendsTo = (calls: ReturnType<typeof captureApi>['calls'], telegramUserId: string) =>
  callsTo(calls, 'sendMessage').filter((call) => call.payload.chat_id === telegramUserId);

const lastRequestedAt = async (accountId: string) => {
  const [row] = await tmp.db
    .select({ at: brokerBalanceSnapshots.lastRequestedAt })
    .from(brokerBalanceSnapshots)
    .where(eq(brokerBalanceSnapshots.brokerAccountId, accountId));
  return row?.at;
};

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  broker = await startMockBroker();
  reconciler = createBalanceReconciler({
    db: tmp.db,
    client: createBrokerRestClient({ baseUrl: broker.url }),
    accessToken: (accountId) => {
      const token = tokens.get(accountId);
      return Promise.resolve(
        token === undefined
          ? { ok: false, reason: 'account_not_found' as const }
          : { ok: true, ...token },
      );
    },
    logger: Fastify({ logger: false }).log,
    config: { intervalMs: 60_000, maxPerMinute: 200 },
  });
  const recorded = recordedPush();
  captured = recorded.captured;
  app = testApp(
    depositDeps({
      balance: {
        refresh: (accountId, options) => {
          refreshCalls.push({ accountId, options });
          return reconciler.refresh(accountId, options);
        },
      },
      clientPush: recorded.push,
    }),
  );
  await app.ready();
});
afterAll(async () => {
  await app.close();
  for (const extra of extraApps) await extra.close();
  await reconciler.stop();
  await broker.close();
  await tmp.drop();
});
beforeEach(() => {
  broker.rest.clearJournal();
});

describe('POST /deposit/credited', () => {
  it('K5 K12 refreshes from the broker and pushes the real balance it wrote, with the menu', async () => {
    const user = await payer('1234.50');
    const response = await creditedFor(user.telegramUserId);
    expectOutcome(response, 'refreshed');

    expect(refreshCalls.filter((call) => call.accountId === user.accountId)).toEqual([
      {
        accountId: user.accountId,
        options: {
          signal: expect.any(AbortSignal) as AbortSignal,
          requested: true,
          mayRefresh: true,
        },
      },
    ]);
    expect(await lastRequestedAt(user.accountId)).toBeInstanceOf(Date);

    const sends = sendsTo(captured.calls, user.telegramUserId);
    expect(sends).toHaveLength(1);
    const payload = sentPayload(sends, 'sendMessage');
    expect(payload?.parse_mode).toBe('HTML');
    expect(pushedText(payload)).toBe(
      RU_TEXTS.depositCredited({
        realBalance: { amount: '1234.50000000' as DecimalString, fresh: true },
      }).value,
    );
    expect(pushedText(payload)).toContain(formatUsd('1234.5'));
    expect(inlineButtons(payload)).toEqual([{ text: RU_LABELS.menuButton, callback_data: 'menu' }]);
  });

  it('K1 refuses on a DEMO_ONLY process before the proof, any read, refresh or push (#396)', async () => {
    const demo = await extraApp({
      demoOnly: true,
      db: noDb,
      initDataVerifier: {
        verify: () => {
          throw new Error('the proof was checked');
        },
      },
      balance: failing,
    });
    expectRefusal(await credited(demo, { initData: 'anything' }), 409, DepositErrorCode.DemoOnly);
  });

  it('K2 refuses a forged, stale or malformed initData before any read or refresh', async () => {
    const strict = await extraApp({ db: noDb, balance: failing });
    const forged = signInitData({ botToken: '1:another-bot', telegramUserId: 42n });
    const stale = initDataFor(
      '42',
      Math.floor((Date.now() - DEPOSIT_INIT_DATA_MAX_AGE_MS - 5_000) / 1000),
    );
    for (const initData of [forged, stale, 'hash=x']) {
      expectRefusal(
        await credited(strict, { initData }),
        401,
        DepositErrorCode.InvalidTelegramAuth,
      );
    }
  });

  it('K6 refuses a body that carries anything but initData, before any refresh', async () => {
    const strict = await extraApp({ db: noDb, balance: failing });
    for (const payload of [
      { initData: initDataFor('42'), amount: 100 },
      { initData: initDataFor('42'), currency: 'USD' },
      {},
      { initData: '' },
    ]) {
      const response = await credited(strict, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'validation' });
    }
  });

  it('K3 holds one Telegram user to three credited events a minute', async () => {
    const { calls, balance } = stubBalance(() => Promise.resolve('aborted'));
    const limited = await extraApp({ balance, clientPush: recordedPush().push });
    const user = await payer();
    for (let i = 0; i < 3; i += 1) {
      expectOutcome(await creditedFor(user.telegramUserId, limited), 'pending');
    }
    expectRefusal(
      await creditedFor(user.telegramUserId, limited),
      429,
      DepositErrorCode.TooManyRequests,
    );
    expect(calls).toHaveLength(3);

    const other = await payer();
    expectOutcome(await creditedFor(other.telegramUserId, limited), 'pending');
  });

  it('K4 answers no_active_account, ambiguous_account and user_blocked without a refresh', async () => {
    const { push, captured: pushes } = recordedPush();
    const strict = await extraApp({ balance: failing, clientPush: push });

    const unknown = await creditedFor('987654321', strict);
    expectRefusal(unknown, 409, DepositErrorCode.NoActiveAccount);

    const bare = await seedUser(tmp.db);
    expectRefusal(
      await creditedFor(bare.telegramUserId, strict),
      409,
      DepositErrorCode.NoActiveAccount,
    );

    const revoked = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, revoked.userId, { status: BrokerAccountStatus.Revoked });
    expectRefusal(
      await creditedFor(revoked.telegramUserId, strict),
      409,
      DepositErrorCode.NoActiveAccount,
    );

    const twice = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, twice.userId);
    await seedBrokerAccount(tmp.db, twice.userId);
    expectRefusal(
      await creditedFor(twice.telegramUserId, strict),
      409,
      DepositErrorCode.AmbiguousAccount,
    );

    const blocked = await payer('5.00', UserStatus.Blocked);
    expectRefusal(
      await creditedFor(blocked.telegramUserId, strict),
      409,
      DepositErrorCode.UserBlocked,
    );
    expect(callsTo(pushes.calls, 'sendMessage')).toEqual([]);
  });

  it.each([
    ['user_blocked', 409, DepositErrorCode.UserBlocked],
    ['account_not_found', 409, DepositErrorCode.NoActiveAccount],
    ['account_pending', 409, DepositErrorCode.TokenUnavailable],
    ['account_revoked', 409, DepositErrorCode.TokenUnavailable],
  ] as const)('K7 answers a refresh %s with %i %s and no push', async (outcome, status, error) => {
    const { push, captured: pushes } = recordedPush();
    const { balance } = stubBalance(() => Promise.resolve(outcome));
    const stubbed = await extraApp({ balance, clientPush: push });
    const user = await payer();
    expectRefusal(await creditedFor(user.telegramUserId, stubbed), status, error);
    expect(callsTo(pushes.calls, 'sendMessage')).toEqual([]);
  });

  it.each([
    'aborted',
    'refresh_needed',
    'unauthorized',
    'rate_limited',
    'rejected',
    'unavailable',
    'contract_violation',
    'account_mismatch',
    'key_unavailable',
  ] as const)('K7 answers a refresh %s with pending, logged, no push', async (outcome) => {
    const { push, captured: pushes } = recordedPush();
    const { balance } = stubBalance(() => Promise.resolve(outcome));
    const stubbed = await extraApp({ balance, clientPush: push });
    const user = await payer();
    lines.length = 0;
    expectOutcome(await creditedFor(user.telegramUserId, stubbed), 'pending');
    expect(callsTo(pushes.calls, 'sendMessage')).toEqual([]);
    expect(logged('credited: the balance was not refreshed')).toEqual([
      expect.objectContaining({ level: 30, accountId: user.accountId, outcome }),
    ]);
  });

  it('K5 marks an account with a snapshot as requested even when the refresh writes nothing', async () => {
    const { balance } = stubBalance(() => Promise.resolve('unavailable'));
    const stubbed = await extraApp({ balance, clientPush: recordedPush().push });
    const user = await payer();
    await seedBalanceSnapshot(tmp.db, user.accountId);
    expect(await lastRequestedAt(user.accountId)).toBeNull();
    expectOutcome(await creditedFor(user.telegramUserId, stubbed), 'pending');
    expect(await lastRequestedAt(user.accountId)).toBeInstanceOf(Date);
  });

  it('answers 500 when the refresh throws, without a push', async () => {
    const { push, captured: pushes } = recordedPush();
    const stubbed = await extraApp({
      balance: { refresh: () => Promise.reject(new Error('the reconciler broke')) },
      clientPush: push,
    });
    const user = await payer();
    const response = await creditedFor(user.telegramUserId, stubbed);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal' });
    expect(callsTo(pushes.calls, 'sendMessage')).toEqual([]);
  });

  it('K8 answers pending at its own budget when the refresh never settles, without a push', async () => {
    const { push, captured: pushes } = recordedPush();
    const { balance } = stubBalance(() => new Promise<BalanceRefreshOutcome>(() => {}));
    const waiting = await extraApp({
      clientPush: push,
      creditedRefreshBudgetMs: 200,
      balance: {
        refresh: (accountId, options) => {
          void balance.refresh(accountId, options);
          // what the reconciler does when the caller's signal fires: its wait ends as aborted
          return new Promise((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve('aborted'));
          });
        },
      },
    });
    const user = await payer();
    const started = Date.now();
    expectOutcome(await creditedFor(user.telegramUserId, waiting), 'pending');
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(callsTo(pushes.calls, 'sendMessage')).toEqual([]);
  });

  it('K9 pushes once per user within the push interval, and again after it', async () => {
    const { push, captured: pushes } = recordedPush();
    const { balance } = stubBalance(() => Promise.resolve('ok'));
    const stubbed = await extraApp({
      balance,
      clientPush: push,
      pushMinIntervalMs: 300,
      creditedPerUserPerMinute: 1_000,
    });
    const user = await payer();
    await seedBalanceSnapshot(tmp.db, user.accountId, { realAvailable: '100' });

    expectOutcome(await creditedFor(user.telegramUserId, stubbed), 'refreshed');
    expectOutcome(await creditedFor(user.telegramUserId, stubbed), 'refreshed');
    expect(sendsTo(pushes.calls, user.telegramUserId)).toHaveLength(1);
    expect(pushedText(sentPayload(pushes.calls, 'sendMessage'))).toContain(formatUsd('100'));

    const started = Date.now();
    await until(
      'a push after the interval',
      async () => {
        expectOutcome(await creditedFor(user.telegramUserId, stubbed), 'refreshed');
        return sendsTo(pushes.calls, user.telegramUserId).length > 1;
      },
      { intervalMs: 50 },
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(sendsTo(pushes.calls, user.telegramUserId)).toHaveLength(2);
  });

  it('K10 still answers refreshed when Telegram fails the push, logging its identity only', async () => {
    const { push, captured: pushes } = recordedPush();
    pushes.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 500,
      description: 'Internal Server Error: secret detail',
    });
    const { balance } = stubBalance(() => Promise.resolve('ok'));
    const stubbed = await extraApp({ balance, clientPush: push });
    const user = await payer();
    lines.length = 0;
    expectOutcome(await creditedFor(user.telegramUserId, stubbed), 'refreshed');
    const [warned, ...more] = logged('the deposit push could not be sent to Telegram');
    expect(more).toEqual([]);
    expect(warned).toMatchObject({
      level: 40,
      err: { name: 'GrammyError' },
      method: 'sendMessage',
      telegramErrorCode: 500,
      push: 'deposit',
    });
    const text = lines.join('\n');
    expect(text).not.toContain('secret detail');
    expect(text).not.toContain('Пополнение');
    expect(text).not.toContain(hashOf(initDataFor(user.telegramUserId)));
  });

  it('K10 marks the user unreachable on a 403', async () => {
    const { push, captured: pushes } = recordedPush();
    pushes.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    const { balance } = stubBalance(() => Promise.resolve('ok'));
    const stubbed = await extraApp({ balance, clientPush: push });
    const user = await payer();
    expectOutcome(await creditedFor(user.telegramUserId, stubbed), 'refreshed');
    const [row] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(row?.at).toBeInstanceOf(Date);
  });

  // the push answers the user's own action, as the push after the site login does
  // #633: the push is in the user's language, read with the account it is about
  it('K-lang pushes the English balance and menu to a user whose language is English', async () => {
    const user = await payer('1234.50');
    await tmp.db.update(users).set({ language: BotLanguage.En }).where(eq(users.id, user.userId));
    expectOutcome(await creditedFor(user.telegramUserId), 'refreshed');
    const payload = sentPayload(sendsTo(captured.calls, user.telegramUserId), 'sendMessage');
    expect(pushedText(payload)).toBe(
      clientTextsOf(BotLanguage.En).depositCredited({
        realBalance: { amount: '1234.50000000' as DecimalString, fresh: true },
      }).value,
    );
    expect(pushedText(payload)).not.toMatch(/[А-Яа-яЁё]/u);
    expect(inlineButtons(payload)).toEqual([
      { text: clientLabelsOf(BotLanguage.En).menuButton, callback_data: 'menu' },
    ]);
  });

  it('K11 pushes to a user whose notification level is off', async () => {
    const { push, captured: pushes } = recordedPush();
    const { balance } = stubBalance(() => Promise.resolve('ok'));
    const stubbed = await extraApp({ balance, clientPush: push });
    const user = await payer();
    await tmp.db
      .update(users)
      .set({ notificationLevel: NotificationLevel.Off })
      .where(eq(users.id, user.userId));
    expectOutcome(await creditedFor(user.telegramUserId, stubbed), 'refreshed');
    expect(sendsTo(pushes.calls, user.telegramUserId)).toHaveLength(1);
  });

  it('never writes the initData to the log', async () => {
    const user = await payer();
    lines.length = 0;
    const initData = initDataFor(user.telegramUserId);
    await credited(app, { initData });
    await credited(app, { initData, amount: 5 });
    expect(lines.join('\n')).not.toContain(hashOf(initData));
  });

  it('shares the plugin ceiling with the widget-session route', async () => {
    const capped = await extraApp({ db: noDb, balance: failing, maxPerMinute: 1 });
    const first = await capped.inject({
      method: 'POST',
      url: DEPOSIT_WIDGET_SESSION_PATH,
      payload: {},
    });
    expect(first.statusCode).toBe(400);
    expectRefusal(await credited(capped, {}), 429, DepositErrorCode.TooManyRequests);
  });
});
