import { asc, eq, sql } from 'drizzle-orm';
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
  hashPassword,
  resetStaffPassword,
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

const build = (
  patch: Record<string, unknown> = {},
  logs?: { write(line: string): void },
): FastifyInstance => {
  telegram = stubTelegram(true);
  derivations = 0;
  return buildApp({
    pairs: unusedPairsDeps(),
    signal: unusedSignalDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: logs === undefined ? 'silent' : 'error',
    ...(logs === undefined ? {} : { logDestination: logs }),
    checkTimeoutMs: 50,
    trading: {
      db: tmp.db,
      internalApiToken: 'internal',
      onIntentQueued: () => undefined,
      balance: unusedBalanceDeps(),
      realTradingEnabled: false,
      accessToken: unusedAccessTokenDeps(),
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
  await markChallengeCodeSent(tmp.db, challengeId, confirmed.code);
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
    .where(eq(auditLog.actorId, staffId))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

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
      expect((await login({ login: seeded.login, password: 'no', ...CLIENT })).statusCode).toBe(
        401,
      );
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

  // The other side of the lockout flag: an expired one is not a lockout. The database decides
  // that, so a process whose clock drifts cannot refuse a login the CAS would have accepted.
  it('lets the login through once the lockout has expired', async () => {
    const seeded = await seedStaff(tmp.db);
    await tmp.db
      .update(staff)
      .set({ failedPasswordAttempts: 5, lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(staff.id, seeded.staffId));

    const response = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect(response.statusCode).toBe(200);
  });

  // The failure path takes the same CAS the success path does: ~250 ms of KDF happened, and a
  // reset in that window means the counter would otherwise be charged to credentials this
  // attempt was never judged against.
  it('counts nothing when the password was reset while the KDF was running', async () => {
    await app.close();
    const seeded = await seedStaff(tmp.db);
    app = build({
      verify: async (stored: string, password: string) => {
        const answer = await verifyPassword(stored, password);
        await resetStaffPassword(tmp.db, {
          login: seeded.login,
          passwordHash: await hashPassword('something else', { ln: 10, r: 8, p: 1 }),
        });
        return answer;
      },
    });

    const response = await login({ login: seeded.login, password: 'wrong', ...CLIENT });

    expect([response.statusCode, response.json()]).toEqual([
      401,
      { error: AdminErrorCode.InvalidCredentials },
    ]);
    const [row] = await tmp.db
      .select({ attempts: staff.failedPasswordAttempts, lockedUntil: staff.lockedUntil })
      .from(staff)
      .where(eq(staff.id, seeded.staffId));
    expect([row?.attempts, row?.lockedUntil]).toEqual([0, null]);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry?.payload).toMatchObject({ reason: 'state_changed' });
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
    expect(
      (await login({ login: seeded.login, password: seeded.password, ...CLIENT })).statusCode,
    ).toBe(200);

    const over = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([over.statusCode, over.json()]).toEqual([
      429,
      { error: AdminErrorCode.TooManyAttempts },
    ]);
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
    // and the challenge is closed, so the next attempt starts a new one. The sim has to be
    // healthy again for this to say anything: while it still fails, a reused challenge and a
    // fresh one both answer 503 and the two worlds are indistinguishable.
    const [closed] = await tmp.db
      .select({ id: staffLoginChallenges.id })
      .from(staffLoginChallenges)
      .where(eq(staffLoginChallenges.staffId, seeded.staffId));
    telegram.failWith(undefined);
    const next = await login({ login: seeded.login, password: seeded.password, ...CLIENT });
    expect(next.statusCode).toBe(200);
    expect(next.json().challengeId).not.toBe(closed?.id);
    expect(telegram.prompts).toHaveLength(1);
  });

  // prompt_sent_at is NULL because the process died after sendMessage, and the button has been
  // pressed since. Re-sending would invite someone already holding the code; worse, a send that
  // then fails closes a challenge that has moved on.
  it('does not re-invite a challenge whose button was already pressed', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await login({ login: seeded.login, password: seeded.password, ...CLIENT });
    const { challengeId } = first.json<{ challengeId: string }>();
    // the crash: the message went out, the row never recorded it
    await tmp.db
      .update(staffLoginChallenges)
      .set({ promptSentAt: null })
      .where(eq(staffLoginChallenges.id, challengeId));
    await confirmChallengeFromTelegram(tmp.db, {
      challengeId,
      telegramUserId: seeded.telegramUserId,
    });
    // the sim stays healthy on purpose: with it failing, a re-send and no send at all both end
    // in an empty `prompts`, and the two worlds would be indistinguishable
    telegram.prompts.length = 0;

    const again = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([again.statusCode, again.json<{ challengeId: string }>().challengeId]).toEqual([
      200,
      challengeId,
    ]);
    expect(telegram.prompts).toEqual([]);
    const [row] = await tmp.db
      .select({ status: staffLoginChallenges.status })
      .from(staffLoginChallenges)
      .where(eq(staffLoginChallenges.id, challengeId));
    expect(row?.status).toBe(StaffLoginChallengeStatus.Confirmed);
  });

  // The residual race the fix above cannot close: the invitation is in flight when the button
  // is pressed. The send then fails, the CAS pending -> failed matches nothing, and the
  // challenge is alive with the code already on its way — so 503 would be a lie.
  it('answers 200 when the send failed but the challenge moved on by itself', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await login({ login: seeded.login, password: seeded.password, ...CLIENT });
    const { challengeId } = first.json<{ challengeId: string }>();
    // the same crash, but this time the button is pressed while the re-send is in flight
    await tmp.db
      .update(staffLoginChallenges)
      .set({ promptSentAt: null })
      .where(eq(staffLoginChallenges.id, challengeId));
    telegram.prompts.length = 0;
    telegram.failWith(Object.assign(new Error('chat not found'), { name: 'GrammyError' }));
    telegram.beforeSend(async (id) => {
      await confirmChallengeFromTelegram(tmp.db, {
        challengeId: id,
        telegramUserId: seeded.telegramUserId,
      });
    });

    const again = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([again.statusCode, again.json<{ challengeId: string }>().challengeId]).toEqual([
      200,
      challengeId,
    ]);
    const [row] = await tmp.db
      .select({ status: staffLoginChallenges.status })
      .from(staffLoginChallenges)
      .where(eq(staffLoginChallenges.id, challengeId));
    expect(row?.status).toBe(StaffLoginChallengeStatus.Confirmed);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry?.payload).toMatchObject({ reason: 'prompt_send_failed', closed: false });
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

  // path (c): the challenge is reused and its invitation was already delivered, so nothing is
  // owed — the gate still has to be asked, or the login answers 200 for a factor that cannot come
  it('refuses a reused challenge while the bot is not polling', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await login({ login: seeded.login, password: seeded.password, ...CLIENT });
    expect(first.statusCode).toBe(200);
    expect(telegram.prompts).toHaveLength(1);
    telegram.setPolling(false);

    const again = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([again.statusCode, again.json()]).toEqual([
      503,
      { error: AdminErrorCode.TelegramUnavailable },
    ]);
    const [row] = await tmp.db
      .select({ status: staffLoginChallenges.status })
      .from(staffLoginChallenges)
      .where(eq(staffLoginChallenges.id, first.json<{ challengeId: string }>().challengeId));
    expect(row?.status).toBe(StaffLoginChallengeStatus.Failed);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry?.payload).toMatchObject({ reason: 'polling_down', closed: true });
    expect(telegram.prompts).toHaveLength(1);
  });

  // path (d): the code is already in Telegram, so completeLogin needs no poller — the gate is
  // asked, records what it saw, and the CAS pending -> failed matches nothing
  it('keeps a challenge whose button was already pressed, even while the bot is not polling', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await login({ login: seeded.login, password: seeded.password, ...CLIENT });
    const { challengeId } = first.json<{ challengeId: string }>();
    const confirmed = await confirmChallengeFromTelegram(tmp.db, {
      challengeId,
      telegramUserId: seeded.telegramUserId,
    });
    if (confirmed === undefined) throw new Error('the button press matched no challenge');
    await markChallengeCodeSent(tmp.db, challengeId, confirmed.code);
    telegram.setPolling(false);

    const again = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect([again.statusCode, again.json<{ challengeId: string }>().challengeId]).toEqual([
      200,
      challengeId,
    ]);
    const [row] = await tmp.db
      .select({ status: staffLoginChallenges.status })
      .from(staffLoginChallenges)
      .where(eq(staffLoginChallenges.id, challengeId));
    expect(row?.status).toBe(StaffLoginChallengeStatus.Confirmed);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry?.payload).toMatchObject({ reason: 'polling_down', closed: false });
    const done = await confirm({ challengeId, code: confirmed.code, ...CLIENT });
    expect(done.statusCode).toBe(200);
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

  // The fifth wrong code is the one that exhausts the challenge, and completeLogin already
  // computed that. Answering 401 there sends the staff member back to a form that can only
  // fail, and they learn it one round trip later.
  it('answers 410 on the attempt that exhausts the challenge, not 401', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);
    const wrong = code === '000000' ? '111111' : '000000';

    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await confirm({ challengeId, code: wrong, ...CLIENT })).statusCode);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 410]);
    // and the one after it, which was already 410 before this change
    expect((await confirm({ challengeId, code, ...CLIENT })).statusCode).toBe(410);
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

    expect([response.statusCode, response.json()]).toEqual([
      200,
      { revoked: true, current: false },
    ]);
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

    expect([response.statusCode, response.json()]).toEqual([
      404,
      { error: AdminErrorCode.NotFound },
    ]);
  });

  // The shape of the id says nothing about whether the caller may ask: with the check in front
  // of runAsStaff, anyone holding the bearer learned "no such session" without a live session.
  it('answers 401, not 404, for a malformed id with no live session', async () => {
    const response = await withSession('POST', '/admin/sessions/not-a-uuid/revoke', 'x'.repeat(43));

    expect([response.statusCode, response.json()]).toEqual([
      401,
      { error: AdminErrorCode.SessionInvalid },
    ]);
  });

  // the matrix names a row for "a revoke that found nothing", and a malformed id is one of
  // those; what it must not carry is the id itself, which is arbitrary input
  it('records a malformed id as a miss, without repeating it', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await withSession('POST', '/admin/sessions/not-a-uuid/revoke', token);

    expect(response.statusCode).toBe(404);
    const entries = await entriesFor(seeded.staffId);
    const revokes = entries.filter((entry) => entry.action === AuditAction.StaffSessionRevoked);
    expect(revokes).toEqual([
      expect.objectContaining({ payload: { result: 'not_found', current: false } }),
    ]);
    expect(JSON.stringify(revokes)).not.toContain('not-a-uuid');
  });

  // the entry is about what happened, not about what was asked for
  it('records a miss as a miss, with no session to point at', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    await withSession('POST', '/admin/sessions/00000000-0000-4000-8000-0000000000fb/revoke', token);

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

// what the login route puts in the log is only provable by reading the log; the HTTP response
// says nothing about it either way
describe('what reaches the backend log', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, write: (line: string) => void lines.push(line) };
  };
  const lineWith = (lines: readonly string[], msg: string) =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === msg);

  it('names the challenge when a login arrives while the bot is not polling', async () => {
    await app.close();
    const logs = capture();
    app = build({}, logs);
    const seeded = await seedStaff(tmp.db);
    telegram.setPolling(false);

    const response = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect(response.statusCode).toBe(503);
    const [row] = await tmp.db
      .select({ id: staffLoginChallenges.id })
      .from(staffLoginChallenges)
      .where(eq(staffLoginChallenges.staffId, seeded.staffId));
    expect(
      lineWith(logs.lines, 'a staff login arrived while the bot was not polling'),
    ).toMatchObject({ challengeId: row?.id });
  });

  it('names a refused invitation by identity, never by its message', async () => {
    await app.close();
    const logs = capture();
    app = build({}, logs);
    const seeded = await seedStaff(tmp.db);
    telegram.failWith(Object.assign(new Error('chat not found'), { name: 'GrammyError' }));

    const response = await login({ login: seeded.login, password: seeded.password, ...CLIENT });

    expect(response.statusCode).toBe(503);
    expect(lineWith(logs.lines, 'the staff login invitation could not be delivered')).toMatchObject(
      { err: { name: 'GrammyError' }, method: 'sendMessage' },
    );
    // redact paths scrub keys, not strings: a message interpolated into the text of a log line
    // is the one shape nothing downstream can clean
    expect(logs.lines.join('')).not.toContain('chat not found');
    expect(logs.lines.join('')).not.toContain(seeded.password);
  });
});
