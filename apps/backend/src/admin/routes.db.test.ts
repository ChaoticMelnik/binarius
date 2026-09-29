import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminErrorCode, staffSessionsResponseSchema } from '@binarius/shared';
import {
  AuditAction,
  auditLog,
  confirmChallengeFromTelegram,
  markChallengeCodeSent,
  staff,
  staffLoginChallenges,
  StaffLoginChallengeStatus,
  staffSessions,
  StaffStatus,
  verifyPassword,
} from '@binarius/db';
import {
  createTempDatabase,
  seedStaff,
  TEST_STAFF_PASSWORD,
  type SeededStaff,
  type TempDatabase,
} from '@binarius/db/testing';
import { buildApp } from '../app';
import { createPasswordQueue } from './password-queue';
import { stubTelegram, unusedAdminDeps } from './testing';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for apps/backend integration tests (see README)');
}

const WEB_TOKEN = 'admin-web-token-for-tests';
const BEARER = { authorization: `Bearer ${WEB_TOKEN}` };
const CLIENT = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0' };

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

let app: FastifyInstance;
let telegram: ReturnType<typeof stubTelegram>;
// counts derivations and still runs the real one: the oracles below are about how many happen
let derivations: number;

const build = (patch: Record<string, unknown> = {}): FastifyInstance => {
  telegram = stubTelegram(true);
  derivations = 0;
  return buildApp({
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: 'silent',
    checkTimeoutMs: 50,
    trading: { db: tmp.db, internalApiToken: 'internal', onIntentQueued: () => undefined },
    auth: {
      db: tmp.db,
      cipher: {} as never,
      broker: {} as never,
      internalApiToken: 'internal',
      authorizeUrl: 'https://binodex.app/oauth/authorize',
      clientId: 'client-id',
      redirectUri: 'https://bot.example/oauth/callback',
      partnerRef: 'partner-ref',
    },
    users: { db: tmp.db, internalApiToken: 'internal' },
    admin: {
      ...unusedAdminDeps(),
      db: tmp.db,
      adminWebToken: WEB_TOKEN,
      telegram,
      verify: (stored, password) => {
        derivations += 1;
        return verifyPassword(stored, password);
      },
      ...patch,
    },
  });
};

beforeEach(() => {
  app = build();
});
afterEach(() => app.close());

const login = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/admin/auth/login', headers: BEARER, payload: body });

const confirm = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/admin/auth/confirm', headers: BEARER, payload: body });

const withSession = (method: 'GET' | 'POST', url: string, token: string) =>
  app.inject({ method, url, headers: { ...BEARER, 'x-staff-session': token } });

/** Password accepted, button pressed, code delivered: the state step 2 starts from. */
async function reachCodeEntry(seeded: SeededStaff): Promise<{ challengeId: string; code: string }> {
  const response = await login({ login: seeded.login, password: seeded.password, ...CLIENT });
  const { challengeId } = response.json<{ challengeId: string }>();
  const confirmed = await confirmChallengeFromTelegram(tmp.db, {
    challengeId,
    telegramUserId: seeded.telegramUserId,
  });
  if (confirmed === undefined) throw new Error('the button press matched no challenge');
  await markChallengeCodeSent(tmp.db, challengeId);
  return { challengeId, code: confirmed.code };
}

async function openSession(seeded: SeededStaff): Promise<string> {
  const { challengeId, code } = await reachCodeEntry(seeded);
  const response = await confirm({ challengeId, code, ...CLIENT });
  return response.json<{ sessionToken: string }>().sessionToken;
}

const entriesFor = async (staffId: string) =>
  tmp.db
    .select({ action: auditLog.action, payload: auditLog.payload })
    .from(auditLog)
    .where(eq(auditLog.actorId, staffId));

describe('the narrow bearer', () => {
  it.each([
    ['POST', '/admin/auth/login'],
    ['POST', '/admin/auth/confirm'],
    ['GET', '/admin/sessions'],
    ['POST', '/admin/sessions/00000000-0000-4000-8000-00000000000a/revoke'],
    ['POST', '/admin/auth/logout'],
  ])('refuses %s %s without it', async (method, url) => {
    const response = await app.inject({ method: method as 'GET' | 'POST', url, payload: {} });
    expect([response.statusCode, response.json()]).toEqual([
      401,
      { error: AdminErrorCode.Unauthorized },
    ]);
  });

  it('refuses the internal token, which is a different secret', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/sessions',
      headers: { authorization: 'Bearer internal' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /admin/auth/login', () => {
  it('creates a challenge and asks Telegram for the invitation', async () => {
    const seeded = await seedStaff(tmp.db);

    const response = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ challengeId: string; expiresAt: string }>();
    expect(body.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(telegram.prompts).toEqual([
      expect.objectContaining({ challengeId: body.challengeId, login: seeded.login }),
    ]);
    expect((await challengeRow(body.challengeId)).promptSentAt).not.toBeNull();
  });

  it('matches the login case-insensitively', async () => {
    const seeded = await seedStaff(tmp.db);
    const response = await login({
      login: seeded.login.toUpperCase(),
      password: seeded.password,
      ...CLIENT,
    });
    expect(response.statusCode).toBe(200);
  });

  // an unknown login and a wrong password have to be one answer, and cost the same
  it('answers a login nobody holds exactly as it answers a wrong password', async () => {
    const seeded = await seedStaff(tmp.db);

    const unknown = await login({ login: 'nobody.here', password: 'whatever', ...CLIENT });
    const derivationsAfterUnknown = derivations;
    const wrong = await login({ login: seeded.login, password: 'not it', ...CLIENT });

    expect([unknown.statusCode, unknown.json()]).toEqual([
      401,
      { error: AdminErrorCode.InvalidCredentials },
    ]);
    expect([wrong.statusCode, wrong.json()]).toEqual([
      401,
      { error: AdminErrorCode.InvalidCredentials },
    ]);
    // one derivation each: the unknown login runs against DUMMY_PASSWORD_HASH
    expect([derivationsAfterUnknown, derivations]).toEqual([1, 2]);
  });

  it('answers a disabled account the same way, and records why', async () => {
    const seeded = await seedStaff(tmp.db, { status: StaffStatus.Disabled });

    const response = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([response.statusCode, response.json()]).toEqual([
      401,
      { error: AdminErrorCode.InvalidCredentials },
    ]);
    expect(await entriesFor(seeded.staffId)).toEqual([
      expect.objectContaining({
        action: AuditAction.StaffLoginFailed,
        payload: { reason: 'disabled', ip: CLIENT.ip },
      }),
    ]);
  });

  it('closes the door on a login name after five misses, without deriving a sixth time', async () => {
    const unknown = `nobody-${Date.now()}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login({ login: unknown, password: 'x', ...CLIENT })).statusCode).toBe(401);
    }
    const before = derivations;

    const sixth = await login({ login: unknown, password: 'x', ...CLIENT });

    expect([sixth.statusCode, sixth.json()]).toEqual([
      429,
      { error: AdminErrorCode.TooManyAttempts },
    ]);
    expect(derivations).toBe(before);
  });

  it('locks the account after five wrong passwords and stops deriving', async () => {
    const seeded = await seedStaff(tmp.db);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login({ login: seeded.login, password: 'no', ...CLIENT })).statusCode).toBe(401);
    }
    const before = derivations;

    const locked = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([locked.statusCode, locked.json()]).toEqual([
      429,
      { error: AdminErrorCode.TooManyAttempts },
    ]);
    // the right password would have opened the account, and it was never derived
    expect(derivations).toBe(before);
    const actions = (await entriesFor(seeded.staffId)).map((entry) => entry.action);
    expect(actions.at(-1)).toBe(AuditAction.StaffLoginLocked);
  });

  // the derivation is held open, so the second request really is concurrent with the first
  it('refuses while the scrypt queue is full, before it derives anything', async () => {
    await app.close();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    app = build({
      passwordQueue: createPasswordQueue({ concurrency: 1, queueMax: 0 }),
      verify: async (stored: string, password: string) => {
        inFlight += 1;
        await held;
        return verifyPassword(stored, password);
      },
    });
    const seeded = await seedStaff(tmp.db);
    const blocking = login({ login: seeded.login, password: seeded.password, ...CLIENT });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const refused = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([refused.statusCode, refused.json()]).toEqual([
      429,
      { error: AdminErrorCode.TooManyAttempts },
    ]);
    // the refusal never reached the KDF: one derivation is in flight, and it is the first one
    expect(inFlight).toBe(1);
    release();
    expect((await blocking).statusCode).toBe(200);
  });

  // the whole point of the route ceiling: it is taken before the body is read
  it('refuses everything once the route ceiling is reached', async () => {
    await app.close();
    app = build({ loginMaxPerMinute: 1 });
    const seeded = await seedStaff(tmp.db);
    expect((await login({ login: seeded.login, password: seeded.password, ...CLIENT })).statusCode).toBe(
      200,
    );

    const over = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([over.statusCode, over.json()]).toEqual([429, { error: AdminErrorCode.TooManyAttempts }]);
  });

  it('answers 503 and closes the challenge while the bot is not polling', async () => {
    const seeded = await seedStaff(tmp.db);
    telegram.setPolling(false);

    const response = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([response.statusCode, response.json()]).toEqual([
      503,
      { error: AdminErrorCode.TelegramUnavailable },
    ]);
    expect(telegram.prompts).toEqual([]);
    const [row] = await tmp.db
      .select({ status: staffLoginChallenges.status })
      .from(staffLoginChallenges)
      .where(eq(staffLoginChallenges.staffId, seeded.staffId));
    expect(row?.status).toBe(StaffLoginChallengeStatus.Failed);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry?.payload).toMatchObject({ reason: 'polling_down' });
  });

  it('answers 503 and closes the challenge when the invitation is refused', async () => {
    const seeded = await seedStaff(tmp.db);
    telegram.failWith(Object.assign(new Error('chat not found'), { name: 'GrammyError' }));

    const response = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect(response.statusCode).toBe(503);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry?.payload).toMatchObject({
      reason: 'prompt_send_failed',
      err: { name: 'GrammyError' },
    });
    // the error's own message names the chat; a durable row must not carry it
    expect(JSON.stringify(entry?.payload)).not.toContain('chat not found');
    // and the challenge is closed, so the next attempt starts a new one immediately
    expect((await login({ login: seeded.login, password: seeded.password, ...CLIENT })).statusCode).toBe(
      503,
    );
  });

  it('reuses the open challenge and does not send a second invitation', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    const second = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect(second.json<{ challengeId: string }>().challengeId).toBe(
      first.json<{ challengeId: string }>().challengeId,
    );
    expect(telegram.prompts).toHaveLength(1);
  });

  it.each([
    ['a login outside the pattern', { login: 'ada l', password: 'x', ...CLIENT }],
    ['no password', { login: 'ada', ...CLIENT }],
    ['a password over the bound', { login: 'ada', password: 'p'.repeat(257), ...CLIENT }],
    ['no ip', { login: 'ada', password: 'x', userAgent: 'ua' }],
  ])('refuses %s without deriving anything', async (_label, body) => {
    const response = await login(body);
    expect([response.statusCode, response.json<{ error: string }>().error]).toEqual([
      400,
      AdminErrorCode.Validation,
    ]);
    expect(derivations).toBe(0);
  });
});

describe('POST /admin/auth/confirm', () => {
  it('answers a session token for the delivered code', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);

    const response = await confirm({ challengeId, code, ...CLIENT });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ sessionToken: string; expiresAt: string }>();
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it.each([
    ['a wrong code', 401, AdminErrorCode.InvalidCode],
    ['the right code twice', 410, AdminErrorCode.ChallengeUnavailable],
  ])('answers %s with %i', async (kind, status, error) => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);
    if (kind === 'the right code twice') await confirm({ challengeId, code, ...CLIENT });
    const sent = kind === 'a wrong code' ? (code === '000000' ? '111111' : '000000') : code;

    const response = await confirm({ challengeId, code: sent, ...CLIENT });

    expect([response.statusCode, response.json()]).toEqual([status, { error }]);
  });

  it('answers 409 while the button has not been pressed', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId } = await login({
      login: seeded.login,
      password: seeded.password,
      ...CLIENT,
    }).then((response) => response.json<{ challengeId: string }>());

    const response = await confirm({ challengeId, code: '123456', ...CLIENT });

    expect([response.statusCode, response.json()]).toEqual([
      409,
      { error: AdminErrorCode.AwaitingTelegram },
    ]);
  });

  it('answers 410 for a challenge id nobody was issued', async () => {
    const response = await confirm({
      challengeId: '00000000-0000-4000-8000-0000000000ee',
      code: '123456',
      ...CLIENT,
    });
    expect([response.statusCode, response.json()]).toEqual([
      410,
      { error: AdminErrorCode.ChallengeUnavailable },
    ]);
  });

  it('refuses everything once the confirm ceiling is reached', async () => {
    await app.close();
    app = build({ confirmMaxPerMinute: 0 });
    const response = await confirm({
      challengeId: '00000000-0000-4000-8000-0000000000ef',
      code: '123456',
      ...CLIENT,
    });
    expect([response.statusCode, response.json()]).toEqual([
      429,
      { error: AdminErrorCode.TooManyAttempts },
    ]);
  });
});

describe('GET /admin/sessions', () => {
  it('lists the live sessions and names the caller', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await withSession('GET', '/admin/sessions', token);

    expect(response.statusCode).toBe(200);
    const body = staffSessionsResponseSchema.parse(response.json());
    expect(body.me).toEqual({
      staffId: seeded.staffId,
      login: seeded.login,
      sessionId: expect.any(String),
    });
    const own = body.sessions.find((row) => row.id === body.me.sessionId);
    expect(own).toMatchObject({ login: seeded.login, current: true, ip: CLIENT.ip });
  });

  // the allowlist, read off the wire rather than off the projection
  it('never puts a hash or a Telegram id on the wire', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const body = (await withSession('GET', '/admin/sessions', token)).body;

    for (const forbidden of ['tokenHash', 'token_hash', 'passwordHash', 'telegramUserId']) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).not.toContain(String(seeded.telegramUserId));
  });

  it.each([
    ['no header', undefined],
    ['a token of the wrong shape', 'not-a-token'],
    ['a token nobody was given', 'a'.repeat(43)],
  ])('refuses %s', async (_label, token) => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/sessions',
      headers: token === undefined ? BEARER : { ...BEARER, 'x-staff-session': token },
    });
    expect([response.statusCode, response.json()]).toEqual([
      401,
      { error: AdminErrorCode.SessionInvalid },
    ]);
  });

  it('records the read under the staff member', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    await withSession('GET', '/admin/sessions', token);

    const entry = (await entriesFor(seeded.staffId)).at(-1);

    expect(entry?.action).toBe(AuditAction.StaffSessionsViewed);
    expect(entry?.payload).toMatchObject({ path: '/admin/sessions' });
  });
});

describe('POST /admin/sessions/:id/revoke', () => {
  it('revokes another staff member’s session and says it was not the current one', async () => {
    const owner = await seedStaff(tmp.db);
    const actor = await seedStaff(tmp.db);
    const ownerToken = await openSession(owner);
    const actorToken = await openSession(actor);
    const [target] = await tmp.db
      .select({ id: staffSessions.id })
      .from(staffSessions)
      .where(eq(staffSessions.staffId, owner.staffId));

    const response = await withSession('POST', `/admin/sessions/${target!.id}/revoke`, actorToken);

    expect([response.statusCode, response.json()]).toEqual([200, { revoked: true, current: false }]);
    // and the revoked session is refused on its very next request
    expect((await withSession('GET', '/admin/sessions', ownerToken)).statusCode).toBe(401);
  });

  it('says so when the caller revoked its own session', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const own = (await withSession('GET', '/admin/sessions', token)).json<{
      me: { sessionId: string };
    }>().me.sessionId;

    const response = await withSession('POST', `/admin/sessions/${own}/revoke`, token);

    expect([response.statusCode, response.json()]).toEqual([200, { revoked: true, current: true }]);
  });

  it.each([
    ['an id nobody was issued', '00000000-0000-4000-8000-0000000000fa'],
    ['an id that is not a uuid', 'not-a-uuid'],
  ])('answers 404 for %s', async (_label, target) => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await withSession('POST', `/admin/sessions/${target}/revoke`, token);

    expect([response.statusCode, response.json()]).toEqual([404, { error: AdminErrorCode.NotFound }]);
  });

  // the entry is about what happened, not about what was asked for
  it('records a miss as a miss, with no session to point at', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    await withSession(
      'POST',
      '/admin/sessions/00000000-0000-4000-8000-0000000000fb/revoke',
      token,
    );

    // scoped to this test's own actor: the table is shared by every case in the file
    const entries = await tmp.db
      .select({
        action: auditLog.action,
        entityId: auditLog.entityId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(eq(auditLog.actorId, seeded.staffId));

    expect(entries.filter((entry) => entry.action === AuditAction.StaffSessionRevoked)).toEqual([
      expect.objectContaining({
        entityId: null,
        payload: expect.objectContaining({ result: 'not_found' }),
      }),
    ]);
  });
});

describe('POST /admin/auth/logout', () => {
  it('ends the session and refuses the next request with it', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await withSession('POST', '/admin/auth/logout', token);

    expect([response.statusCode, response.json()]).toEqual([200, { loggedOut: true }]);
    expect((await withSession('GET', '/admin/sessions', token)).statusCode).toBe(401);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry?.action).toBe(AuditAction.StaffLogout);
  });

  it('refuses a session that was already ended', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    await withSession('POST', '/admin/auth/logout', token);

    const again = await withSession('POST', '/admin/auth/logout', token);

    expect([again.statusCode, again.json()]).toEqual([
      401,
      { error: AdminErrorCode.SessionInvalid },
    ]);
  });
});

describe('a disabled account', () => {
  it('loses its live session on the very next request', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    expect((await withSession('GET', '/admin/sessions', token)).statusCode).toBe(200);

    await tmp.db
      .update(staff)
      .set({ status: StaffStatus.Disabled })
      .where(eq(staff.id, seeded.staffId));

    expect((await withSession('GET', '/admin/sessions', token)).statusCode).toBe(401);
  });
});

describe('the password the fixtures use', () => {
  it('is what seedStaff wrote, so a wrong-password case is really wrong', async () => {
    const seeded = await seedStaff(tmp.db);
    expect(seeded.password).toBe(TEST_STAFF_PASSWORD);
    expect(await verifyPassword(seeded.passwordHash, seeded.password)).toBe(true);
  });
});

const challengeRow = async (id: string) => {
  const [row] = await tmp.db
    .select()
    .from(staffLoginChallenges)
    .where(eq(staffLoginChallenges.id, id));
  if (row === undefined) throw new Error(`no challenge ${id}`);
  return row;
};
