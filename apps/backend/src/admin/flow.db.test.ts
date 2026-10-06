import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditAction, auditLog, staffSessions } from '@binarius/db';
import { createTempDatabase, seedStaff, type TempDatabase } from '@binarius/db/testing';
import { buildWebApp } from '@binarius/web/app';
import { createBackendClient } from '@binarius/web/backend-client';
import { buildApp } from '../app';
import { createAdminBot, type AdminBot } from './telegram';
import {
  ADMIN_BOT_INFO,
  callbackUpdate,
  captureApi,
  codeFrom,
  fakeLogger,
  inlineButtons,
  sentPayload,
  staffUser,
  unusedAdminDeps,
  type CapturedApi,
} from './testing';
import { unusedBalanceDeps, unusedPairsDeps } from '../trading/testing';

// The whole path, over HTTP and with real cookies: a browser's form reaches apps/web, which
// calls a listening apps/backend with its bearer, which drives a real grammY bot against a
// real Postgres. The only thing replaced is the Bot API transport.
//
// It is an integration test. No oracle in this feature is proved by it alone — each of those
// has its own case and its own isolating mutation next to the code it guards. What this one
// answers is the question none of them can: that the pieces agree.

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

const WEB_TOKEN = 'admin-web-token-for-the-flow-test';
const ORIGIN = 'http://127.0.0.1:3001';

let tmp: TempDatabase;
let backend: FastifyInstance;
let web: FastifyInstance;
let adminBot: AdminBot;
let api: CapturedApi;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  adminBot = createAdminBot({
    token: '1:flow',
    db: tmp.db,
    logger: fakeLogger(),
    botInfo: ADMIN_BOT_INFO,
  });
  api = captureApi(adminBot.bot);

  backend = buildApp({
    pairs: unusedPairsDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 50,
    trading: {
      db: tmp.db,
      internalApiToken: 'internal',
      onIntentQueued: () => undefined,
      balance: unusedBalanceDeps(),
      realTradingEnabled: false,
    },
    auth: {
      db: tmp.db,
      cipher: {} as never,
      broker: {} as never,
      internalApiToken: 'internal',
      authorizeUrl: 'https://binodex.app/oauth/authorize',
      clientId: 'client-id',
      redirectUri: 'https://bot.example/oauth/callback',
      partnerRef: 'partner-ref',
      linkNotifier: {} as never,
      initDataVerifier: {} as never,
    },
    users: { db: tmp.db, internalApiToken: 'internal' },
    admin: {
      ...unusedAdminDeps(),
      db: tmp.db,
      adminWebToken: WEB_TOKEN,
      telegram: adminBot,
    },
  });
  await backend.listen({ port: 0, host: '127.0.0.1' });

  web = buildWebApp({
    backend: createBackendClient({
      baseUrl: `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`,
      token: WEB_TOKEN,
    }),
    publicOrigin: ORIGIN,
    brokerAuthorizeUrl: 'https://binodex.app/oauth/authorize',
    secureCookies: false,
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await web.close();
  await backend.close();
  await adminBot.stop();
  await tmp.drop();
});

/** grammY is told the bot is polling; the real start() would need a Telegram to poll. */
const pretendPolling = (value: boolean) => {
  Object.defineProperty(adminBot, 'isPolling', { value: () => value, configurable: true });
};

const form = (payload: Record<string, string>, cookies: Record<string, string> = {}) => ({
  headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(payload).toString(),
  cookies,
});

const cookieValue = (response: { cookies: { name: string; value: string }[] }, name: string) =>
  response.cookies.find((entry) => entry.name === name)?.value;

const entries = async (staffId: string) =>
  (
    await tmp.db
      .select({
        action: auditLog.action,
        actorType: auditLog.actorType,
        entityType: auditLog.entityType,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(eq(auditLog.actorId, staffId))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
  ).map((row) => row);

describe('a staff member logs in, looks at the sessions and logs out', () => {
  it('walks the whole path and leaves exactly the entries the matrix names', async () => {
    pretendPolling(true);
    const staff = await seedStaff(tmp.db);
    const before = api.calls.length;

    // 1. the login form
    const started = await web.inject({
      method: 'POST',
      url: '/admin/login',
      ...form({ login: staff.login, password: staff.password }),
    });
    expect([started.statusCode, started.headers.location]).toEqual([303, '/admin/login/confirm']);
    const challengeCookie = cookieValue(started, 'admin_login');
    expect(challengeCookie).toMatch(/^[0-9a-f-]{36}$/);

    // the invitation reached Telegram, with both buttons
    const prompt = sentPayload(api.calls.slice(before), 'sendMessage');
    expect(String(prompt?.text)).toContain(staff.login);
    expect(inlineButtons(prompt).map((button) => button.callback_data)).toEqual([
      `sl:c:${challengeCookie ?? ''}`,
      `sl:d:${challengeCookie ?? ''}`,
    ]);

    // 2. the button, through the real grammY middleware
    const pressed = api.calls.length;
    await adminBot.bot.handleUpdate(
      callbackUpdate(`sl:c:${challengeCookie ?? ''}`, staffUser(staff.telegramUserId)),
    );
    const code = codeFrom(sentPayload(api.calls.slice(pressed), 'sendMessage')?.text);

    // 3. the code
    const confirmed = await web.inject({
      method: 'POST',
      url: '/admin/login/confirm',
      ...form({ code }, { admin_login: challengeCookie ?? '' }),
    });
    expect([confirmed.statusCode, confirmed.headers.location]).toEqual([303, '/admin/sessions']);
    const session = cookieValue(confirmed, 'admin_session');
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 4. the page
    const page = await web.inject({
      method: 'GET',
      url: '/admin/sessions',
      cookies: { admin_session: session ?? '' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(staff.login);
    expect(page.body).not.toContain(String(staff.telegramUserId));
    expect(page.body).not.toContain(session ?? 'unreachable');

    // 5. the way out
    const out = await web.inject({
      method: 'POST',
      url: '/admin/logout',
      ...form({}, { admin_session: session ?? '' }),
    });
    expect([out.statusCode, out.headers.location]).toEqual([303, '/admin/login']);

    // and the session is dead on the server, not only in the browser
    const after = await web.inject({
      method: 'GET',
      url: '/admin/sessions',
      cookies: { admin_session: session ?? '' },
    });
    expect([after.statusCode, after.headers.location]).toEqual([302, '/admin/login']);

    expect(await entries(staff.staffId)).toEqual([
      {
        action: AuditAction.StaffLoginPasswordOk,
        actorType: 'system',
        entityType: 'staff_login_challenge',
        payload: { reused: false, resent: false, ip: expect.any(String) },
      },
      {
        action: AuditAction.StaffLoginTelegramConfirmed,
        actorType: 'system',
        entityType: 'staff_login_challenge',
        payload: { repeat: false },
      },
      {
        action: AuditAction.StaffLoginCompleted,
        actorType: 'admin',
        entityType: 'staff_session',
        payload: { challengeId: challengeCookie, ip: expect.any(String) },
      },
      {
        action: AuditAction.StaffSessionsViewed,
        actorType: 'admin',
        entityType: null,
        payload: { path: '/admin/sessions', sessionId: expect.any(String) },
      },
      {
        action: AuditAction.StaffLogout,
        actorType: 'admin',
        entityType: 'staff_session',
        payload: {},
      },
    ]);
  });

  it('records a refusal from Telegram and refuses the code that never came', async () => {
    pretendPolling(true);
    const staff = await seedStaff(tmp.db);
    const started = await web.inject({
      method: 'POST',
      url: '/admin/login',
      ...form({ login: staff.login, password: staff.password }),
    });
    const challengeId = cookieValue(started, 'admin_login') ?? '';

    await adminBot.bot.handleUpdate(
      callbackUpdate(`sl:d:${challengeId}`, staffUser(staff.telegramUserId)),
    );

    const refused = await web.inject({
      method: 'POST',
      url: '/admin/login/confirm',
      ...form({ code: '123456' }, { admin_login: challengeId }),
    });

    // the attempt is over: the cookie is spent and the form says to start again
    expect([refused.statusCode, refused.headers.location]).toEqual([
      303,
      '/admin/login?reason=expired',
    ]);
    expect(cookieValue(refused, 'admin_login')).toBe('');
    expect((await entries(staff.staffId)).map((entry) => entry.action)).toEqual([
      AuditAction.StaffLoginPasswordOk,
      AuditAction.StaffLoginDenied,
      AuditAction.StaffLoginCodeFailed,
    ]);
    expect(
      await tmp.db.select().from(staffSessions).where(eq(staffSessions.staffId, staff.staffId)),
    ).toEqual([]);
  });

  // fail closed, all the way to the page the staff member sees
  it('says the second factor is unavailable when the bot is not polling', async () => {
    pretendPolling(false);
    const staff = await seedStaff(tmp.db);

    const response = await web.inject({
      method: 'POST',
      url: '/admin/login',
      ...form({ login: staff.login, password: staff.password }),
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain('Telegram');
    expect(cookieValue(response, 'admin_login')).toBeUndefined();
    expect((await entries(staff.staffId)).at(-1)?.payload).toMatchObject({
      reason: 'polling_down',
    });
  });

  it('revokes another staff member’s session from the page', async () => {
    pretendPolling(true);
    const owner = await seedStaff(tmp.db);
    const actor = await seedStaff(tmp.db);
    const ownerSession = await logIn(owner);
    const actorSession = await logIn(actor);
    const [target] = await tmp.db
      .select({ id: staffSessions.id })
      .from(staffSessions)
      .where(eq(staffSessions.staffId, owner.staffId));

    const revoked = await web.inject({
      method: 'POST',
      url: `/admin/sessions/${target?.id ?? ''}/revoke`,
      ...form({}, { admin_session: actorSession }),
    });

    expect([revoked.statusCode, revoked.headers.location]).toEqual([303, '/admin/sessions']);
    const ownerNow = await web.inject({
      method: 'GET',
      url: '/admin/sessions',
      cookies: { admin_session: ownerSession },
    });
    expect([ownerNow.statusCode, ownerNow.headers.location]).toEqual([302, '/admin/login']);
  });
});

async function logIn(staff: {
  login: string;
  password: string;
  telegramUserId: bigint;
}): Promise<string> {
  const started = await web.inject({
    method: 'POST',
    url: '/admin/login',
    ...form({ login: staff.login, password: staff.password }),
  });
  const challengeId = cookieValue(started, 'admin_login') ?? '';
  const pressed = api.calls.length;
  await adminBot.bot.handleUpdate(
    callbackUpdate(`sl:c:${challengeId}`, staffUser(staff.telegramUserId)),
  );
  const code = codeFrom(sentPayload(api.calls.slice(pressed), 'sendMessage')?.text);
  const confirmed = await web.inject({
    method: 'POST',
    url: '/admin/login/confirm',
    ...form({ code }, { admin_login: challengeId }),
  });
  const session = cookieValue(confirmed, 'admin_session');
  if (session === undefined) throw new Error('the login did not produce a session cookie');
  return session;
}
