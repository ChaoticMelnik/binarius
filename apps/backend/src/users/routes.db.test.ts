import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  NotificationLevel,
  TelegramChatMemberStatus,
  UserErrorCode,
  UserStatus,
} from '@binarius/shared';
import { createTempDatabase, seedBrokerAccount, type TempDatabase } from '@binarius/db/testing';
import { NotificationJobStatus, brokerAccounts, notificationJobs, users } from '@binarius/db';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import {
  unusedAccessTokenDeps,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
} from '../trading/testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const TOKEN = 'internal-token-for-tests';
let tmp: TempDatabase;
let app: ReturnType<typeof buildApp>;

const testApp = (logs?: { write(line: string): void }) =>
  buildApp({
    pairs: unusedPairsDeps(),
    signal: unusedSignalDeps(),
    admin: unusedAdminDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    // trace, so a level below production's info cannot hide a line from the log test
    logLevel: logs === undefined ? 'silent' : 'trace',
    ...(logs === undefined ? {} : { logDestination: logs }),
    checkTimeoutMs: 20,
    trading: {
      db: tmp.db,
      internalApiToken: TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: unusedAccessTokenDeps(),
    },
    auth: {
      db: tmp.db,
      cipher: {} as never,
      broker: {} as never,
      internalApiToken: TOKEN,
      authorizeUrl: 'https://binodex.app/oauth/authorize',
      clientId: 'client-id',
      redirectUri: 'https://bot.example/oauth/callback',
      partnerRef: 'partner-ref',
      linkNotifier: {} as never,
      initDataVerifier: {} as never,
    },
    users: { db: tmp.db, internalApiToken: TOKEN },
  });

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  app = testApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await tmp.drop();
});

let seq = 0;
const nextTelegramUserId = (): string => String(600_000 + ++seq);

// null, not undefined: an explicit undefined would fall back to the default parameter and the
// "no header" case would have tested the happy path
const post = (payload: unknown, authorization: string | null = `Bearer ${TOKEN}`) =>
  app.inject({
    method: 'POST',
    url: '/users/start',
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: JSON.stringify(payload),
  });

const body = (telegramUserId: string, patch: Record<string, unknown> = {}) => ({
  telegramUserId,
  displayName: 'Ada',
  ...patch,
});

describe('POST /users/start authorization', () => {
  it.each([
    ['no header', null],
    ['another bearer', 'Bearer some-other-token'],
    ['a non-bearer scheme', `Basic ${TOKEN}`],
  ])('refuses %s', async (_label, authorization) => {
    const response = await post(body(nextTelegramUserId()), authorization);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('writes nothing when the call is refused', async () => {
    const telegramUserId = nextTelegramUserId();
    await post(body(telegramUserId), null);
    const rows = await tmp.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
    expect(rows).toEqual([]);
  });
});

describe('POST /users/start validation', () => {
  it.each([
    ['an empty body', {}],
    ['a non-numeric telegram id', { telegramUserId: 'abc', displayName: 'Ada' }],
    ['an empty display name', { telegramUserId: '600001', displayName: '  ' }],
    [
      'a payload outside the pattern',
      { telegramUserId: '600001', displayName: 'A', startPayload: 'a b' },
    ],
    [
      'a language code outside the pattern',
      { telegramUserId: '600001', displayName: 'A', languageCode: 'en_US' },
    ],
  ])('refuses %s with 400', async (_label, payload) => {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
  });
});

describe('POST /users/start', () => {
  it('answers with exactly the view for a first-time user', async () => {
    const telegramUserId = nextTelegramUserId();
    const response = await post(body(telegramUserId, { languageCode: 'ru' }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        telegramUserId,
        status: UserStatus.Active,
        acquisitionSource: null,
        acquiredAt: null,
        hasActiveBrokerAccount: false,
        pendingBrokerAccounts: [],
        notificationLevel: NotificationLevel.All,
      },
    });
  });

  it('records the first payload through the route and keeps it on the next /start', async () => {
    const telegramUserId = nextTelegramUserId();
    const first = await post(body(telegramUserId, { startPayload: 'src_route' }));
    const firstUser = first.json().user as { acquisitionSource: string; acquiredAt: string };
    expect(firstUser.acquisitionSource).toBe('src_route');
    expect(Date.parse(firstUser.acquiredAt)).not.toBeNaN();

    const second = await post(body(telegramUserId, { startPayload: 'src_other' }));
    expect(second.json().user).toMatchObject({
      acquisitionSource: 'src_route',
      acquiredAt: firstUser.acquiredAt,
    });
  });

  it('reports a blocked user without unblocking them', async () => {
    const telegramUserId = nextTelegramUserId();
    await post(body(telegramUserId));
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));

    const response = await post(body(telegramUserId));
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ status: UserStatus.Blocked });
    const [row] = await tmp.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
    expect(row?.status).toBe(UserStatus.Blocked);
  });

  it('reports an active broker account once the user has one', async () => {
    const telegramUserId = nextTelegramUserId();
    const created = await post(body(telegramUserId));
    expect(created.json().user.hasActiveBrokerAccount).toBe(false);

    const [row] = await tmp.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
    await seedBrokerAccount(tmp.db, row!.id, { status: BrokerAccountStatus.Active });

    const after = await post(body(telegramUserId));
    expect(after.json().user.hasActiveBrokerAccount).toBe(true);
  });

  it('lists a link waiting for confirmation, and stops once it is confirmed', async () => {
    const telegramUserId = nextTelegramUserId();
    await post(body(telegramUserId));
    const [row] = await tmp.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
    const accountId = await seedBrokerAccount(tmp.db, row!.id, {
      status: BrokerAccountStatus.Pending,
    });

    const pending = await post(body(telegramUserId));
    expect(pending.json().user).toMatchObject({
      hasActiveBrokerAccount: false,
      pendingBrokerAccounts: [{ id: accountId, email: null }],
    });

    await tmp.db
      .update(brokerAccounts)
      .set({ status: BrokerAccountStatus.Active })
      .where(eq(brokerAccounts.id, accountId));
    const after = await post(body(telegramUserId));
    expect(after.json().user).toMatchObject({
      hasActiveBrokerAccount: true,
      pendingBrokerAccounts: [],
    });
  });
});

// --- POST /users/chat-member (#119) ------------------------------------------------------------

const postChatMember = (
  payload: unknown,
  authorization: string | null = `Bearer ${TOKEN}`,
  instance = app,
) =>
  instance.inject({
    method: 'POST',
    url: '/users/chat-member',
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: JSON.stringify(payload),
  });

const started = async (
  telegramUserId = nextTelegramUserId(),
): Promise<{ telegramUserId: string; userId: string }> => {
  expect((await post(body(telegramUserId))).statusCode).toBe(200);
  const [row] = await tmp.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  if (row === undefined) throw new Error('no users row after /users/start');
  return { telegramUserId, userId: row.id };
};

const blockedAtOf = async (telegramUserId: string) => {
  const [row] = await tmp.db
    .select({ at: users.telegramBlockedAt })
    .from(users)
    .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  return row?.at;
};

const kicked = (telegramUserId: string) => ({
  telegramUserId,
  status: TelegramChatMemberStatus.Kicked,
});

describe('POST /users/chat-member authorization', () => {
  it.each([
    ['no header', null],
    ['another bearer', 'Bearer some-other-token'],
    ['a non-bearer scheme', `Basic ${TOKEN}`],
  ])('refuses %s and writes nothing', async (_label, authorization) => {
    const { telegramUserId } = await started();
    const response = await postChatMember(kicked(telegramUserId), authorization);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(await blockedAtOf(telegramUserId)).toBeNull();
  });
});

describe('POST /users/chat-member validation', () => {
  it.each([
    ['an empty body', {}],
    ['a status the backend does not take', { telegramUserId: '600001', status: 'left' }],
    ['a non-numeric telegram id', { telegramUserId: 'abc', status: 'kicked' }],
  ])('refuses %s with 400', async (_label, payload) => {
    const response = await postChatMember(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
  });
});

describe('POST /users/chat-member', () => {
  it('marks a started user on kicked and cancels their pending job', async () => {
    const { telegramUserId, userId } = await started();
    const [job] = await tmp.db
      .insert(notificationJobs)
      .values({ userId, kind: 'test' })
      .returning({ id: notificationJobs.id });

    const response = await postChatMember(kicked(telegramUserId));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recorded: true });
    expect(await blockedAtOf(telegramUserId)).toBeInstanceOf(Date);
    const [after] = await tmp.db
      .select({ status: notificationJobs.status })
      .from(notificationJobs)
      .where(and(eq(notificationJobs.id, job!.id), eq(notificationJobs.userId, userId)));
    expect(after?.status).toBe(NotificationJobStatus.Canceled);
  });

  it('clears the mark on member', async () => {
    const { telegramUserId } = await started();
    await postChatMember(kicked(telegramUserId));
    const response = await postChatMember({
      telegramUserId,
      status: TelegramChatMemberStatus.Member,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recorded: true });
    expect(await blockedAtOf(telegramUserId)).toBeNull();
  });

  it('answers recorded: false for an unknown id and creates no row', async () => {
    const telegramUserId = nextTelegramUserId();
    const response = await postChatMember(kicked(telegramUserId));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recorded: false });
    expect(await blockedAtOf(telegramUserId)).toBeUndefined();
  });

  it('is cleared by the next /users/start', async () => {
    const { telegramUserId } = await started();
    await postChatMember(kicked(telegramUserId));
    expect(await blockedAtOf(telegramUserId)).toBeInstanceOf(Date);
    await post(body(telegramUserId));
    expect(await blockedAtOf(telegramUserId)).toBeNull();
  });

  it('logs the block without the Telegram id or the request body', async () => {
    // long and distinctive, so no timestamp or pid in the log can contain it by chance
    const { telegramUserId } = await started('7351902468135792');
    const lines: string[] = [];
    const instance = testApp({ write: (line: string) => void lines.push(line) });
    await instance.ready();
    try {
      const response = await postChatMember(kicked(telegramUserId), undefined, instance);
      expect(response.statusCode).toBe(200);
    } finally {
      await instance.close();
    }
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.filter((line) => line.msg === 'the user blocked the bot')).toEqual([
      expect.objectContaining({ level: 30, recorded: true, canceledJobs: 0 }),
    ]);
    expect(lines.join('\n')).not.toContain(telegramUserId);
  });
});

// --- POST /users/notification-level (#120) -----------------------------------------------------

const postLevel = (
  payload: unknown,
  authorization: string | null = `Bearer ${TOKEN}`,
  instance = app,
) =>
  instance.inject({
    method: 'POST',
    url: '/users/notification-level',
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    payload: JSON.stringify(payload),
  });

const levelOf = async (telegramUserId: string) => {
  const [row] = await tmp.db
    .select({ level: users.notificationLevel })
    .from(users)
    .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  return row?.level;
};

describe('POST /users/notification-level authorization', () => {
  it.each([
    ['no header', null],
    ['another bearer', 'Bearer some-other-token'],
    ['a non-bearer scheme', `Basic ${TOKEN}`],
  ])('refuses %s and writes nothing', async (_label, authorization) => {
    const { telegramUserId } = await started();
    const response = await postLevel(
      { telegramUserId, level: NotificationLevel.Off },
      authorization,
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(await levelOf(telegramUserId)).toBe(NotificationLevel.All);
  });
});

describe('POST /users/notification-level validation', () => {
  it.each([
    ['an empty body', {}],
    ['an unknown level', { telegramUserId: '600001', level: 'daily' }],
    ['a non-numeric telegram id', { telegramUserId: 'abc', level: 'off' }],
  ])('refuses %s with 400', async (_label, payload) => {
    const response = await postLevel(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
  });
});

describe('POST /users/notification-level', () => {
  it('stores off and cancels a pending job, then all, and /users/start reports it', async () => {
    const { telegramUserId, userId } = await started();
    const [job] = await tmp.db
      .insert(notificationJobs)
      .values({ userId, kind: 'test' })
      .returning({ id: notificationJobs.id });

    const off = await postLevel({ telegramUserId, level: NotificationLevel.Off });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ level: NotificationLevel.Off });
    expect(await levelOf(telegramUserId)).toBe(NotificationLevel.Off);
    const [after] = await tmp.db
      .select({ status: notificationJobs.status })
      .from(notificationJobs)
      .where(eq(notificationJobs.id, job!.id));
    expect(after?.status).toBe(NotificationJobStatus.Canceled);

    const reduced = await postLevel({ telegramUserId, level: NotificationLevel.Reduced });
    expect(reduced.json()).toEqual({ level: NotificationLevel.Reduced });
    expect((await post(body(telegramUserId))).json().user).toMatchObject({
      notificationLevel: NotificationLevel.Reduced,
    });

    const all = await postLevel({ telegramUserId, level: NotificationLevel.All });
    expect(all.json()).toEqual({ level: NotificationLevel.All });
    expect(await levelOf(telegramUserId)).toBe(NotificationLevel.All);
  });

  it('answers 404 user_not_found for an unknown id and creates no row', async () => {
    const telegramUserId = nextTelegramUserId();
    const response = await postLevel({ telegramUserId, level: NotificationLevel.Off });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: UserErrorCode.UserNotFound });
    expect(await levelOf(telegramUserId)).toBeUndefined();
  });

  it('logs the level at info without the Telegram id or the request body', async () => {
    const { telegramUserId } = await started('7351902468135793');
    const lines: string[] = [];
    const instance = testApp({ write: (line: string) => void lines.push(line) });
    await instance.ready();
    try {
      const response = await postLevel(
        { telegramUserId, level: NotificationLevel.Off },
        undefined,
        instance,
      );
      expect(response.statusCode).toBe(200);
    } finally {
      await instance.close();
    }
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.filter((line) => line.msg === 'notification level set')).toEqual([
      expect.objectContaining({ level: 30, notificationLevel: 'off', canceledJobs: 0 }),
    ]);
    expect(lines.join('\n')).not.toContain(telegramUserId);
  });
});
