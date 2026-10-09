import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_BOT_TEXT_BODY_LIMIT_BYTES,
  adminBotTextOverrideViewSchema,
  adminBotTextPreviewResponseSchema,
  adminBotTextResetResponseSchema,
  adminBotTextResponseSchema,
  adminBotTextSaveResponseSchema,
  adminBotTextsResponseSchema,
  BOT_TEXT_CATALOG,
  ADMIN_SEARCH_MAX_LENGTH,
  ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS,
  AdminErrorCode,
  adminAuditEntryViewSchema,
  adminAuditResponseSchema,
  AuditAction,
  AuditActorType,
  AuditEntityType,
  adminIntentResponseSchema,
  adminIntentsResponseSchema,
  adminLedgerEntrySchema,
  adminOverviewResponseSchema,
  adminTokensResponseSchema,
  adminTradeIntentViewSchema,
  adminTradingSessionsResponseSchema,
  adminTradingSessionViewSchema,
  adminUserResponseSchema,
  adminUsersResponseSchema,
  staffSessionsResponseSchema,
  TokenLedgerKind,
  TradeIntentStatus,
  type LogLevel,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  auditLog,
  botTextOverrides,
  saveBotTextOverride,
  confirmChallengeFromTelegram,
  markChallengeCodeSent,
  staff,
  staffLoginChallenges,
  StaffLoginChallengeStatus,
  staffSessions,
  StaffStatus,
  tokenLedger,
  tradeIntents,
  hashPassword,
  resetStaffPassword,
  verifyPassword,
} from '@binarius/db';
import {
  createTempDatabase,
  lockWaiters,
  seedBrokerAccount,
  seedQueuedIntent,
  seedStaff,
  seedTradingSession,
  seedUser,
  TEST_SCRYPT_PARAMS,
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
  unusedSignalsDeps,
  unusedSessionDeps,
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
// the same for the new password's hash (#78), at the fixtures' cheap parameters
let hashCalls: number;

const build = (
  patch: Record<string, unknown> = {},
  logs?: { write(line: string): void },
  level: LogLevel = 'error',
): FastifyInstance => {
  telegram = stubTelegram(true);
  derivations = 0;
  hashCalls = 0;
  return buildApp({
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    logLevel: logs === undefined ? 'silent' : level,
    ...(logs === undefined ? {} : { logDestination: logs }),
    checkTimeoutMs: 50,
    trading: {
      db: tmp.db,
      internalApiToken: 'internal',
      onIntentQueued: () => undefined,
      balance: unusedBalanceDeps(),
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
      hash: (password: string) => {
        hashCalls += 1;
        return hashPassword(password, TEST_SCRYPT_PARAMS);
      },
      ...patch,
    },
  });
};

beforeEach(() => {
  app = build();
});

/** A promise the test settles itself: the seams below hold a request open on it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
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
    ['POST', '/admin/auth/password'],
    ['GET', '/admin/overview'],
    ['GET', '/admin/users'],
    ['GET', '/admin/users/00000000-0000-4000-8000-00000000000a'],
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
    const last = (await entriesFor(seeded.staffId)).at(-1);
    expect(last?.action).toBe(AuditAction.StaffLoginLocked);
    expect(last?.payload).toEqual({
      ip: CLIENT.ip,
      lockedUntil: (await staffRow(seeded.staffId)).lockedUntil?.toISOString(),
    });
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
    const { promise: held, resolve: release } = deferred();
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

const postAsStaff = (url: string, token: string | undefined, body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url,
    headers: token === undefined ? BEARER : { ...BEARER, 'x-staff-session': token },
    payload: body,
  });

const staffRow = async (id: string) => {
  const [row] = await tmp.db.select().from(staff).where(eq(staff.id, id));
  if (row === undefined) throw new Error(`no staff ${id}`);
  return row;
};

/** Holds the staff row as CLI and startLoginChallenge would, until `release` is called. */
async function holdStaffRow(staffId: string): Promise<{ release: () => Promise<void> }> {
  const { promise: gate, resolve: release } = deferred();
  const { promise: lockTaken, resolve: taken } = deferred();
  const holder = tmp.db.transaction(async (tx) => {
    await tx.select({ id: staff.id }).from(staff).where(eq(staff.id, staffId)).for('no key update');
    taken();
    await gate;
  });
  await lockTaken;
  return {
    release: async () => {
      release();
      await holder;
    },
  };
}

/** True once the request queued behind a lock; false if it finished without waiting. */
async function queuedBehindLock(pending: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void pending.finally(() => {
    settled = true;
  });
  let waiting = false;
  await until('the request to queue behind the staff row or finish', async () => {
    waiting = (await lockWaiters(tmp.db)) > 0;
    return settled || waiting;
  });
  return waiting && !settled;
}

describe('POST /admin/auth/password (#78)', () => {
  const PASSWORD_URL = '/admin/auth/password';
  const NEW_PASSWORD = 'a brand new staff password';
  const change = (token: string | undefined, body: Record<string, unknown>) =>
    postAsStaff(PASSWORD_URL, token, body);
  const valid = (seeded: SeededStaff) => ({
    currentPassword: seeded.password,
    newPassword: NEW_PASSWORD,
    ...CLIENT,
  });

  const passwordRows = (staffId: string) =>
    tmp.db
      .select({
        action: auditLog.action,
        actorType: auditLog.actorType,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorId, staffId),
          inArray(auditLog.action, [
            AuditAction.StaffPasswordChanged,
            AuditAction.StaffPasswordChangeFailed,
          ]),
        ),
      )
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

  const passwordPayloads = async (staffId: string) =>
    (await passwordRows(staffId)).map((written) => written.payload);

  const ownSessionId = async (token: string) =>
    (await withSession('GET', '/admin/sessions', token)).json<{ me: { sessionId: string } }>().me
      .sessionId;

  it('changes the password, keeps the current session and ends every other one', async () => {
    const seeded = await seedStaff(tmp.db);
    const current = await openSession(seeded);
    const other = await openSession(seeded);
    const sessionId = await ownSessionId(current);
    derivations = 0;

    const response = await change(current, valid(seeded));

    expect(response.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(response.body) as object)).toEqual([
      'changed',
      'revokedSessions',
    ]);
    expect(response.json()).toEqual({ changed: true, revokedSessions: 1 });
    expect([derivations, hashCalls]).toEqual([1, 1]);
    const newHash = (await staffRow(seeded.staffId)).passwordHash;
    expect(await verifyPassword(newHash, NEW_PASSWORD)).toBe(true);

    const rows = await passwordRows(seeded.staffId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AuditAction.StaffPasswordChanged,
      actorType: AuditActorType.Admin,
      entityType: AuditEntityType.Staff,
      entityId: seeded.staffId,
      payload: { sessionId, closedChallenges: 0, revokedSessions: 1, ip: CLIENT.ip },
    });
    expect(Object.keys(rows[0]!.payload as object).sort()).toEqual([
      'closedChallenges',
      'ip',
      'revokedSessions',
      'sessionId',
    ]);
    const written = JSON.stringify(rows) + response.body;
    for (const secret of [seeded.password, NEW_PASSWORD, seeded.passwordHash, newHash, current]) {
      expect(written).not.toContain(secret);
    }

    expect((await withSession('GET', '/admin/sessions', other)).statusCode).toBe(401);
    expect((await withSession('GET', '/admin/sessions', current)).statusCode).toBe(200);
    expect(
      (await login({ login: seeded.login, password: NEW_PASSWORD, ...CLIENT })).statusCode,
    ).toBe(200);
    expect(
      (await login({ login: seeded.login, password: seeded.password, ...CLIENT })).statusCode,
    ).toBe(401);
  });

  it('refuses a wrong current password after one derivation and counts it as a login failure', async () => {
    const seeded = await seedStaff(tmp.db);
    const current = await openSession(seeded);
    const other = await openSession(seeded);
    const sessionId = await ownSessionId(current);
    derivations = 0;

    const response = await change(current, {
      ...valid(seeded),
      currentPassword: 'not the password',
    });

    expect([response.statusCode, response.json()]).toEqual([
      401,
      { error: AdminErrorCode.InvalidCredentials },
    ]);
    expect([derivations, hashCalls]).toEqual([1, 0]);
    const row = await staffRow(seeded.staffId);
    expect([row.passwordHash, row.failedPasswordAttempts]).toEqual([seeded.passwordHash, 1]);
    const rows = await passwordRows(seeded.staffId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AuditAction.StaffPasswordChangeFailed,
      actorType: AuditActorType.Admin,
      entityType: AuditEntityType.Staff,
      entityId: seeded.staffId,
    });
    expect(rows[0]!.payload).toEqual({
      reason: 'wrong_password',
      attempts: 1,
      locked: false,
      ip: CLIENT.ip,
      sessionId,
    });
    const written = JSON.stringify(rows) + response.body;
    for (const secret of ['not the password', NEW_PASSWORD, seeded.passwordHash, current]) {
      expect(written).not.toContain(secret);
    }
    expect((await withSession('GET', '/admin/sessions', other)).statusCode).toBe(200);
  });

  // a stolen cookie is no faster an oracle for the password than the login form
  it('shares the lockout with the login: five wrong in the form lock both', async () => {
    const seeded = await seedStaff(tmp.db);
    const current = await openSession(seeded);
    const wrong = { ...valid(seeded), currentPassword: 'not the password' };
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect((await change(current, wrong)).statusCode).toBe(401);
    }

    const fifth = await change(current, wrong);
    expect(fifth.statusCode).toBe(401);
    expect((await passwordRows(seeded.staffId)).at(-1)?.payload).toMatchObject({
      reason: 'wrong_password',
      attempts: 5,
      locked: true,
    });
    derivations = 0;

    const sixth = await change(current, valid(seeded));

    expect([sixth.statusCode, sixth.json()]).toEqual([
      429,
      { error: AdminErrorCode.TooManyAttempts },
    ]);
    expect([derivations, hashCalls]).toEqual([0, 0]);
    expect((await passwordRows(seeded.staffId)).at(-1)?.payload).toMatchObject({
      reason: 'locked',
      lockedUntil: (await staffRow(seeded.staffId)).lockedUntil?.toISOString(),
      ip: CLIENT.ip,
    });
    expect((await staffRow(seeded.staffId)).passwordHash).toBe(seeded.passwordHash);
    const atLogin = await login({ login: seeded.login, password: seeded.password, ...CLIENT });
    expect([atLogin.statusCode, atLogin.json()]).toEqual([
      429,
      { error: AdminErrorCode.TooManyAttempts },
    ]);
  });

  it.each([
    ['the new password equals the current one', (s: SeededStaff) => ({ newPassword: s.password })],
    ['the new password is empty', () => ({ newPassword: '' })],
    ['the new password is too long', () => ({ newPassword: 'n'.repeat(257) })],
    ['the current password is missing', () => ({ currentPassword: undefined })],
  ])('refuses a body where %s before any derivation or row', async (_label, patch) => {
    const seeded = await seedStaff(tmp.db);
    const current = await openSession(seeded);
    derivations = 0;

    const response = await change(current, { ...valid(seeded), ...patch(seeded) });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe(AdminErrorCode.Validation);
    expect(response.body).not.toContain(seeded.password);
    expect(response.body).not.toContain(NEW_PASSWORD);
    expect([derivations, hashCalls]).toEqual([0, 0]);
    expect(await passwordRows(seeded.staffId)).toEqual([]);
  });

  it('names the same-as-current refusal on newPassword with a custom issue', async () => {
    const seeded = await seedStaff(tmp.db);
    const current = await openSession(seeded);

    const response = await change(current, { ...valid(seeded), newPassword: seeded.password });

    expect(
      response
        .json<{ issues: { code: string; path: string[] }[] }>()
        .issues.map((issue) => [issue.code, issue.path]),
    ).toEqual([['custom', ['newPassword']]]);
  });

  // review round 1, M1: once a lockout has committed, a guess in flight must not say whether it
  // was right — not by its status, not by how many derivations it cost
  describe('a row that changes while the guess is in flight', () => {
    const lockNow = (staffId: string) =>
      tmp.db
        .update(staff)
        .set({ failedPasswordAttempts: 5, lockedUntil: sql`now() + interval '15 minutes'` })
        .where(eq(staff.id, staffId));
    const replaceHash = async (staffId: string) =>
      tmp.db
        .update(staff)
        .set({ passwordHash: await hashPassword('set elsewhere', TEST_SCRYPT_PARAMS) })
        .where(eq(staff.id, staffId));
    const guesses = [
      ['a wrong', () => 'not the password'],
      ['a right', (s: SeededStaff) => s.password],
    ] as const;
    /** the real verify, counted, with `before` run once ahead of the first derivation */
    const verifyAfter = (before: () => Promise<unknown>) => {
      let fired = false;
      return async (stored: string, password: string) => {
        derivations += 1;
        if (!fired) {
          fired = true;
          await before();
        }
        return verifyPassword(stored, password);
      };
    };

    it.each(guesses)(
      'answers %s guess caught by a lockout under verify with one 429 after one derivation',
      async (_label, guess) => {
        const seeded = await seedStaff(tmp.db);
        const current = await openSession(seeded);
        const other = await openSession(seeded);
        const sessionId = await ownSessionId(current);
        await app.close();
        app = build({ verify: verifyAfter(() => lockNow(seeded.staffId)) });

        const response = await change(current, {
          ...valid(seeded),
          currentPassword: guess(seeded),
        });

        expect([response.statusCode, response.json()]).toEqual([
          429,
          { error: AdminErrorCode.TooManyAttempts },
        ]);
        expect([derivations, hashCalls]).toEqual([1, 0]);
        const row = await staffRow(seeded.staffId);
        expect([row.passwordHash, row.failedPasswordAttempts]).toEqual([seeded.passwordHash, 5]);
        expect(await passwordPayloads(seeded.staffId)).toEqual([
          {
            reason: 'locked',
            lockedUntil: row.lockedUntil?.toISOString(),
            ip: CLIENT.ip,
            sessionId,
          },
        ]);
        expect((await withSession('GET', '/admin/sessions', other)).statusCode).toBe(200);
      },
    );

    it('refuses a guess that waited for the slot while a lockout committed, before deriving', async () => {
      const seeded = await seedStaff(tmp.db);
      const current = await openSession(seeded);
      const sessionId = await ownSessionId(current);
      await app.close();
      const queue = createPasswordQueue({ concurrency: 1, queueMax: 1 });
      const { promise: held, resolve: release } = deferred();
      let hashing = false;
      app = build({
        passwordQueue: queue,
        hash: async (password: string) => {
          hashCalls += 1;
          hashing = true;
          await held;
          return hashPassword(password, TEST_SCRYPT_PARAMS);
        },
      });

      // the right guess holds the only slot inside its new hash; the wrong one queues behind it
      const right = change(current, valid(seeded));
      await until('the right guess to reach its new hash', () => hashing);
      const wrong = change(current, { ...valid(seeded), currentPassword: 'not the password' });
      await until('the wrong guess to wait for the slot', () => queue.waiting === 1);
      await lockNow(seeded.staffId);
      release();
      const answers = await Promise.all([right, wrong]);

      expect(answers.map((answer) => [answer.statusCode, answer.json()])).toEqual([
        [429, { error: AdminErrorCode.TooManyAttempts }],
        [429, { error: AdminErrorCode.TooManyAttempts }],
      ]);
      // the right guess is the accepted residual window (its hash was already running); the
      // queued wrong one never reached the KDF
      expect([derivations, hashCalls]).toEqual([1, 1]);
      const lockedUntil = (await staffRow(seeded.staffId)).lockedUntil?.toISOString();
      expect(await passwordPayloads(seeded.staffId)).toEqual([
        { reason: 'locked', lockedUntil, ip: CLIENT.ip, sessionId },
        { reason: 'locked', lockedUntil, ip: CLIENT.ip, sessionId },
      ]);
      expect((await staffRow(seeded.staffId)).passwordHash).toBe(seeded.passwordHash);
    });

    it('answers a hash replaced under the new hash with 401 and a state_changed row', async () => {
      const seeded = await seedStaff(tmp.db);
      const current = await openSession(seeded);
      const sessionId = await ownSessionId(current);
      await app.close();
      app = build({
        hash: async (password: string) => {
          hashCalls += 1;
          await replaceHash(seeded.staffId);
          return hashPassword(password, TEST_SCRYPT_PARAMS);
        },
      });

      const response = await change(current, valid(seeded));

      expect([response.statusCode, response.json()]).toEqual([
        401,
        { error: AdminErrorCode.InvalidCredentials },
      ]);
      expect([derivations, hashCalls]).toEqual([1, 1]);
      expect((await staffRow(seeded.staffId)).failedPasswordAttempts).toBe(0);
      expect(await passwordPayloads(seeded.staffId)).toEqual([
        { reason: 'state_changed', ip: CLIENT.ip, sessionId },
      ]);
    });

    it.each(guesses)(
      'answers %s guess whose hash was replaced under verify with 401 after one derivation',
      async (_label, guess) => {
        const seeded = await seedStaff(tmp.db);
        const current = await openSession(seeded);
        const sessionId = await ownSessionId(current);
        await app.close();
        app = build({ verify: verifyAfter(() => replaceHash(seeded.staffId)) });

        const response = await change(current, {
          ...valid(seeded),
          currentPassword: guess(seeded),
        });

        expect([response.statusCode, response.json()]).toEqual([
          401,
          { error: AdminErrorCode.InvalidCredentials },
        ]);
        expect([derivations, hashCalls]).toEqual([1, 0]);
        expect((await staffRow(seeded.staffId)).failedPasswordAttempts).toBe(0);
        expect(await passwordPayloads(seeded.staffId)).toEqual([
          { reason: 'state_changed', ip: CLIENT.ip, sessionId },
        ]);
      },
    );

    // n4: an expired lockout is no lockout, so a row changed under it is still a changed row
    it('answers a hash replaced over an expired lockout with 401, not 429', async () => {
      const seeded = await seedStaff(tmp.db);
      const current = await openSession(seeded);
      const sessionId = await ownSessionId(current);
      await app.close();
      app = build({
        verify: verifyAfter(async () => {
          await replaceHash(seeded.staffId);
          await tmp.db
            .update(staff)
            .set({ failedPasswordAttempts: 5, lockedUntil: sql`now() - interval '1 second'` })
            .where(eq(staff.id, seeded.staffId));
        }),
      });

      const response = await change(current, valid(seeded));

      expect([response.statusCode, response.json()]).toEqual([
        401,
        { error: AdminErrorCode.InvalidCredentials },
      ]);
      expect((await staffRow(seeded.staffId)).failedPasswordAttempts).toBe(5);
      expect(await passwordPayloads(seeded.staffId)).toEqual([
        { reason: 'state_changed', ip: CLIENT.ip, sessionId },
      ]);
    });

    // a real reset revokes every session, the changing one included: the touch finds nothing
    it('answers a CLI reset under the new hash with session_invalid and no row', async () => {
      const seeded = await seedStaff(tmp.db);
      const current = await openSession(seeded);
      await app.close();
      app = build({
        hash: async (password: string) => {
          hashCalls += 1;
          await resetStaffPassword(tmp.db, {
            login: seeded.login,
            passwordHash: await hashPassword('the operator chose this', TEST_SCRYPT_PARAMS),
          });
          return hashPassword(password, TEST_SCRYPT_PARAMS);
        },
      });

      const response = await change(current, valid(seeded));

      expect([response.statusCode, response.json()]).toEqual([
        401,
        { error: AdminErrorCode.SessionInvalid },
      ]);
      expect(await passwordRows(seeded.staffId)).toEqual([]);
    });
  });

  it.each([
    ['no session header', () => Promise.resolve(undefined)],
    ['a token of the wrong shape', () => Promise.resolve('not-a-token')],
    ['a token nobody was given', () => Promise.resolve('a'.repeat(43))],
  ])('answers session_invalid for %s, before any derivation or row', async (_label, tokenOf) => {
    const seeded = await seedStaff(tmp.db);
    derivations = 0;

    const response = await change(await tokenOf(), valid(seeded));

    expect([response.statusCode, response.json()]).toEqual([
      401,
      { error: AdminErrorCode.SessionInvalid },
    ]);
    expect([derivations, hashCalls]).toEqual([0, 0]);
  });

  it('answers session_invalid for a session that was logged out, with no derivation or row', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    await withSession('POST', '/admin/auth/logout', token);
    derivations = 0;

    const response = await change(token, valid(seeded));

    expect([response.statusCode, response.json()]).toEqual([
      401,
      { error: AdminErrorCode.SessionInvalid },
    ]);
    expect([derivations, hashCalls]).toEqual([0, 0]);
    expect(await passwordRows(seeded.staffId)).toEqual([]);
  });

  it('refuses while the scrypt queue is full, before it derives anything', async () => {
    const { promise: held, resolve: release } = deferred();
    let inFlight = 0;
    const seeded = await seedStaff(tmp.db);
    const current = await openSession(seeded);
    await app.close();
    app = build({
      passwordQueue: createPasswordQueue({ concurrency: 1, queueMax: 0 }),
      verify: async (stored: string, password: string) => {
        inFlight += 1;
        await held;
        return verifyPassword(stored, password);
      },
    });
    const blocking = change(current, valid(seeded));
    await until('the first change to hold the only slot', () => inFlight === 1);

    const refused = await change(current, { ...valid(seeded), newPassword: 'another one' });

    expect([refused.statusCode, refused.json()]).toEqual([
      429,
      { error: AdminErrorCode.TooManyAttempts },
    ]);
    expect([inFlight, hashCalls]).toEqual([1, 0]);
    expect(await passwordRows(seeded.staffId)).toEqual([]);
    release();
    expect((await blocking).statusCode).toBe(200);
  });

  // staff → sessions (runAsStaff lockStaff): both routes that touch more than their own session
  // row wait for a holder of the staff row instead of taking a session row first
  it.each([
    ['a change', (s: SeededStaff) => valid(s), 200],
    ['a wrong current password', (s: SeededStaff) => ({ ...valid(s), currentPassword: 'no' }), 401],
  ])(
    'queues %s behind a held staff row before it touches its session',
    async (_l, body, status) => {
      const seeded = await seedStaff(tmp.db);
      const current = await openSession(seeded);
      const sessionId = await ownSessionId(current);
      const holder = await holdStaffRow(seeded.staffId);

      const pending = change(current, body(seeded));

      expect(await queuedBehindLock(pending)).toBe(true);
      // the session row is still free: the request waits on staff, not after its touch
      const free = await tmp.db.transaction(async (tx) =>
        tx.execute(
          sql`select id from staff_sessions where id = ${sessionId} for no key update nowait`,
        ),
      );
      expect(free.rows).toHaveLength(1);
      await holder.release();
      expect((await pending).statusCode).toBe(status);
    },
  );

  it('makes the revoke route queue behind a held staff row as well', async () => {
    const seeded = await seedStaff(tmp.db);
    const current = await openSession(seeded);
    const other = await openSession(seeded);
    const otherId = await ownSessionId(other);
    const holder = await holdStaffRow(seeded.staffId);

    const pending = withSession('POST', `/admin/sessions/${otherId}/revoke`, current);

    expect(await queuedBehindLock(pending)).toBe(true);
    await holder.release();
    expect((await pending).json()).toEqual({ revoked: true, current: false });
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

const auditCount = async () =>
  (await tmp.db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]?.n ?? 0;

const lastEntry = async (staffId: string) => {
  const [row] = await tmp.db
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      payload: auditLog.payload,
    })
    .from(auditLog)
    .where(eq(auditLog.actorId, staffId))
    .orderBy(sql`${auditLog.createdAt} desc, ${auditLog.id} desc`)
    .limit(1);
  return row;
};

// one more row for this staff member, and only one
const readOnce = async (staffId: string, url: string, token: string) => {
  const before = (await entriesFor(staffId)).length;
  const response = await withSession('GET', url, token);
  expect((await entriesFor(staffId)).length).toBe(before + 1);
  return response;
};

describe('the read pages (#107)', () => {
  // A user created by the OAuth login carries only its Telegram id; its account was never
  // revoked, halted or rotated and has no address.
  const seedBareUserWithAccount = async () => {
    const user = await seedUser(tmp.db);
    const brokerUserId = `b107-${randomUUID()}`;
    const accountId = await seedBrokerAccount(tmp.db, user.userId, { brokerUserId });
    return { ...user, brokerUserId, accountId };
  };

  it.each(['/admin/overview', '/admin/users', '/admin/users/00000000-0000-4000-8000-00000000000a'])(
    'refuses %s without a live session and writes nothing',
    async (url) => {
      const before = await auditCount();
      for (const headers of [BEARER, { ...BEARER, 'x-staff-session': 'a'.repeat(43) }]) {
        const response = await app.inject({ method: 'GET', url, headers });
        expect([response.statusCode, response.json()]).toEqual([
          401,
          { error: AdminErrorCode.SessionInvalid },
        ]);
      }
      expect(await auditCount()).toBe(before);
    },
  );

  it('answers the overview with exactly its wire keys and records the read', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await readOnce(seeded.staffId, '/admin/overview', token);

    expect(response.statusCode).toBe(200);
    const raw = response.json<Record<string, Record<string, unknown>>>();
    expect(Object.keys(raw)).toEqual(['me', 'overview']);
    expect(Object.keys(raw.overview ?? {})).toEqual([
      'users',
      'intents',
      'activeWindowMinutes',
      'dayStartsAt',
      'asOf',
    ]);
    const body = adminOverviewResponseSchema.parse(raw);
    expect(body.me).toMatchObject({ staffId: seeded.staffId, login: seeded.login });
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.OverviewViewed,
      actorType: AuditActorType.Admin,
      entityType: null,
      entityId: null,
      payload: { path: '/admin/overview' },
    });
  });

  it('finds a user by broker id, drops unknown query keys and records q and by', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedBareUserWithAccount();

    const response = await readOnce(
      seeded.staffId,
      `/admin/users?q=${encodeURIComponent(target.brokerUserId)}&utm_source=mail`,
      token,
    );

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ users: Record<string, unknown>[] }>();
    expect(Object.keys(raw)).toEqual(['me', 'users', 'nextCursor']);
    expect(Object.keys(raw.users[0] ?? {})).toEqual([
      'id',
      'telegramUserId',
      'displayName',
      'status',
      'tokenBalance',
      'createdAt',
      'updatedAt',
    ]);
    const body = adminUsersResponseSchema.parse(raw);
    expect(body.users.map((u) => u.id)).toEqual([target.userId]);
    expect(body.users[0]?.displayName).toBeNull();
    expect(body.nextCursor).toBeNull();
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/users',
      q: target.brokerUserId,
      by: 'broker_user_id',
    });
  });

  it('records the cursor it was given', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const { userId } = await seedUser(tmp.db);

    const response = await readOnce(seeded.staffId, `/admin/users?cursor=${userId}`, token);

    expect(response.statusCode).toBe(200);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/users',
      cursor: userId,
    });
  });

  it.each([
    ['q over the limit', `q=${'a'.repeat(ADMIN_SEARCH_MAX_LENGTH + 1)}`],
    ['a control character', 'q=a%07b'],
    ['a cursor that is not a uuid', 'cursor=bad'],
    ['q twice', 'q=a&q=b'],
  ])('refuses %s with 400 before the session, writing nothing', async (_label, query) => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const before = await auditCount();

    const response = await withSession('GET', `/admin/users?${query}`, token);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe(AdminErrorCode.Validation);
    expect(await auditCount()).toBe(before);
  });

  it('answers the card with exactly its wire keys, nulls included, and names the user', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedBareUserWithAccount();

    const response = await readOnce(seeded.staffId, `/admin/users/${target.userId}`, token);

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ user: object; brokerAccounts: object[] }>();
    expect(Object.keys(raw)).toEqual(['me', 'user', 'brokerAccounts', 'intents', 'ledger']);
    expect(Object.keys(raw.user)).toEqual([
      'id',
      'telegramUserId',
      'displayName',
      'languageCode',
      'status',
      'acquisitionSource',
      'acquiredAt',
      'telegramBlockedAt',
      'notificationLevel',
      'demoStake',
      'tokens',
      'createdAt',
      'updatedAt',
    ]);
    expect(Object.keys(raw.brokerAccounts[0] ?? {})).toEqual([
      'id',
      'brokerUserId',
      'email',
      'isPartnerClient',
      'status',
      'authRevokedReason',
      'tradingHalted',
      'haltedReason',
      'accessTokenExpiresAt',
      'tokenRotatedAt',
      'createdAt',
      'updatedAt',
    ]);
    expect(response.body).not.toMatch(/Enc|Hash|KeyId|_enc|_hash|key_id/);
    const body = adminUserResponseSchema.parse(raw);
    expect(body.user).toMatchObject({
      displayName: null,
      languageCode: null,
      acquisitionSource: null,
      acquiredAt: null,
      telegramBlockedAt: null,
      demoStake: null,
    });
    expect(body.brokerAccounts[0]).toMatchObject({
      id: target.accountId,
      email: null,
      authRevokedReason: null,
      haltedReason: null,
      tokenRotatedAt: null,
    });
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.UserViewed,
      actorType: AuditActorType.Admin,
      entityType: AuditEntityType.User,
      entityId: target.userId,
      payload: { path: '/admin/users/:id', result: 'found', userId: target.userId },
    });
  });

  it('records an id that is not a uuid as a miss, without repeating it', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await readOnce(seeded.staffId, '/admin/users/not-a-uuid', token);

    expect([response.statusCode, response.json()]).toEqual([
      404,
      { error: AdminErrorCode.NotFound },
    ]);
    const entry = await lastEntry(seeded.staffId);
    expect(entry).toMatchObject({ action: AuditAction.UserViewed, entityId: null });
    expect(entry?.payload).toEqual({ path: '/admin/users/:id', result: 'not_found' });
  });

  it('records a uuid with no row as a miss that names the id', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const missing = randomUUID();

    const response = await readOnce(seeded.staffId, `/admin/users/${missing}`, token);

    expect(response.statusCode).toBe(404);
    const entry = await lastEntry(seeded.staffId);
    expect(entry).toMatchObject({ action: AuditAction.UserViewed, entityId: null });
    expect(entry?.payload).toEqual({
      path: '/admin/users/:id',
      result: 'not_found',
      userId: missing,
    });
  });

  it('refuses the next read once the session has ended', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    expect((await withSession('GET', '/admin/users', token)).statusCode).toBe(200);
    await withSession('POST', '/admin/auth/logout', token);

    expect((await withSession('GET', '/admin/users', token)).statusCode).toBe(401);
  });
});

describe('the intents pages (#108)', () => {
  // a queued intent of a fresh user, attached to a session of its account
  const seedIntentInSession = async () => {
    const seeded = await seedQueuedIntent(tmp.db);
    const session = await seedTradingSession(tmp.db, seeded.brokerAccountId);
    await tmp.db
      .update(tradeIntents)
      .set({ tradingSessionId: session.id })
      .where(eq(tradeIntents.id, seeded.intent.id));
    return { ...seeded, tradingSessionId: session.id };
  };

  const INTENT_KEYS = Object.keys(adminTradeIntentViewSchema.shape).sort();

  it.each(['/admin/intents', '/admin/intents/00000000-0000-4000-8000-00000000000a'])(
    'refuses %s without a live session and writes nothing',
    async (url) => {
      const before = await auditCount();
      for (const headers of [BEARER, { ...BEARER, 'x-staff-session': 'a'.repeat(43) }]) {
        const response = await app.inject({ method: 'GET', url, headers });
        expect([response.statusCode, response.json()]).toEqual([
          401,
          { error: AdminErrorCode.SessionInvalid },
        ]);
      }
      expect(await auditCount()).toBe(before);
    },
  );

  it('lists with exactly the wire keys and records only the filters it was given', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedIntentInSession();

    const response = await readOnce(
      seeded.staffId,
      `/admin/intents?status=active&user=${target.userId}&utm_source=mail`,
      token,
    );

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ intents: Record<string, unknown>[] }>();
    expect(Object.keys(raw)).toEqual(['me', 'intents', 'nextCursor']);
    expect(Object.keys(raw.intents[0] ?? {}).sort()).toEqual(INTENT_KEYS);
    expect(response.body).not.toMatch(/Enc|Hash|KeyId|_enc|_hash|key_id/);
    const body = adminIntentsResponseSchema.parse(raw);
    expect(body.intents.map((i) => i.id)).toEqual([target.intent.id]);
    expect(body.intents[0]).toMatchObject({
      userId: target.userId,
      telegramUserId: target.telegramUserId,
      tradingSessionId: target.tradingSessionId,
    });
    expect(body.nextCursor).toBeNull();
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.IntentsViewed,
      actorType: AuditActorType.Admin,
      entityType: null,
      entityId: null,
      payload: { path: '/admin/intents', status: 'active', userId: target.userId },
    });
  });

  it('filters by trading session and records it as tradingSessionId', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedIntentInSession();
    const newer = await seedIntentInSession();

    const response = await readOnce(
      seeded.staffId,
      `/admin/intents?session=${target.tradingSessionId}&mode=demo&cursor=${newer.intent.id}`,
      token,
    );

    expect(response.statusCode).toBe(200);
    const body = adminIntentsResponseSchema.parse(response.json());
    expect(body.intents.map((i) => i.id)).toEqual([target.intent.id]);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/intents',
      mode: 'demo',
      tradingSessionId: target.tradingSessionId,
      cursor: newer.intent.id,
    });
  });

  it.each([
    ['an unknown status', 'status=bogus'],
    ['an empty status', 'status='],
    ['a session that is not a uuid', 'session=x'],
    ['a user of blanks', 'user=%20'],
    ['a cursor that is not a uuid', 'cursor=bad'],
    ['status twice', 'status=queued&status=settled'],
  ])('refuses %s with 400 before the session, writing nothing', async (_label, query) => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const before = await auditCount();

    const response = await withSession('GET', `/admin/intents?${query}`, token);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe(AdminErrorCode.Validation);
    expect(await auditCount()).toBe(before);
  });

  it('answers the card with exactly its wire keys and names the intent', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedIntentInSession();

    const response = await readOnce(seeded.staffId, `/admin/intents/${target.intent.id}`, token);

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ intent: object }>();
    expect(Object.keys(raw)).toEqual(['me', 'intent']);
    expect(Object.keys(raw.intent).sort()).toEqual(INTENT_KEYS);
    expect(response.body).not.toMatch(/Enc|Hash|KeyId|_enc|_hash|key_id/);
    const body = adminIntentResponseSchema.parse(raw);
    expect(body.intent).toMatchObject({
      id: target.intent.id,
      userId: target.userId,
      tradingSessionId: target.tradingSessionId,
      reconcileClaimedAt: null,
    });
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.IntentViewed,
      actorType: AuditActorType.Admin,
      entityType: AuditEntityType.TradeIntent,
      entityId: target.intent.id,
      payload: { path: '/admin/intents/:id', result: 'found', intentId: target.intent.id },
    });
  });

  it('records an id that is not a uuid as a miss, without repeating it', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await readOnce(seeded.staffId, '/admin/intents/not-a-uuid', token);

    expect([response.statusCode, response.json()]).toEqual([
      404,
      { error: AdminErrorCode.NotFound },
    ]);
    const entry = await lastEntry(seeded.staffId);
    expect(entry).toMatchObject({ action: AuditAction.IntentViewed, entityId: null });
    expect(entry?.payload).toEqual({ path: '/admin/intents/:id', result: 'not_found' });
  });

  it('records a uuid with no row as a miss that names the id', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const missing = randomUUID();

    const response = await readOnce(seeded.staffId, `/admin/intents/${missing}`, token);

    expect(response.statusCode).toBe(404);
    const entry = await lastEntry(seeded.staffId);
    expect(entry).toMatchObject({ action: AuditAction.IntentViewed, entityId: null });
    expect(entry?.payload).toEqual({
      path: '/admin/intents/:id',
      result: 'not_found',
      intentId: missing,
    });
  });

  it('refuses the next read once the session has ended', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedQueuedIntent(tmp.db);
    const card = `/admin/intents/${target.intent.id}`;
    expect((await withSession('GET', '/admin/intents', token)).statusCode).toBe(200);
    expect((await withSession('GET', card, token)).statusCode).toBe(200);
    await withSession('POST', '/admin/auth/logout', token);

    expect((await withSession('GET', '/admin/intents', token)).statusCode).toBe(401);
    expect((await withSession('GET', card, token)).statusCode).toBe(401);
  });
});

describe('the trading sessions page, the card section and the overview breakdown (#330)', () => {
  const SESSION_KEYS = Object.keys(adminTradingSessionViewSchema.shape);
  const INTENT_KEYS = Object.keys(adminTradeIntentViewSchema.shape).sort();

  it('refuses /admin/trading-sessions without a live session and writes nothing', async () => {
    const before = await auditCount();
    for (const headers of [BEARER, { ...BEARER, 'x-staff-session': 'a'.repeat(43) }]) {
      const response = await app.inject({ method: 'GET', url: '/admin/trading-sessions', headers });
      expect([response.statusCode, response.json()]).toEqual([
        401,
        { error: AdminErrorCode.SessionInvalid },
      ]);
    }
    expect(await auditCount()).toBe(before);
  });

  it('lists sessions with exactly the wire keys, drops unknown query keys, records the path', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const owner = await seedUser(tmp.db);
    const brokerUserId = `b330-${randomUUID()}`;
    const accountId = await seedBrokerAccount(tmp.db, owner.userId, { brokerUserId });
    const session = await seedTradingSession(tmp.db, accountId);

    const response = await readOnce(seeded.staffId, '/admin/trading-sessions?utm=1', token);

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ sessions: Record<string, unknown>[] }>();
    expect(Object.keys(raw)).toEqual(['me', 'sessions', 'nextCursor']);
    const row = raw.sessions.find((s) => s.id === session.id);
    expect(Object.keys(row ?? {})).toEqual(SESSION_KEYS);
    expect(response.body).not.toMatch(/Enc|Hash|KeyId|_enc|_hash|key_id|summary/i);
    const body = adminTradingSessionsResponseSchema.parse(raw);
    expect(body.sessions.find((s) => s.id === session.id)).toMatchObject({
      id: session.id,
      brokerAccountId: accountId,
      brokerUserId,
      userId: owner.userId,
      telegramUserId: owner.telegramUserId,
      status: 'active',
      stopReason: null,
    });
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.TradingSessionsViewed,
      actorType: AuditActorType.Admin,
      entityType: null,
      entityId: null,
      payload: { path: '/admin/trading-sessions' },
    });
  });

  it('records the cursor it was given', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const cursor = randomUUID();

    const response = await readOnce(
      seeded.staffId,
      `/admin/trading-sessions?cursor=${cursor}`,
      token,
    );

    expect(response.statusCode).toBe(200);
    expect(adminTradingSessionsResponseSchema.parse(response.json()).sessions).toEqual([]);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/trading-sessions',
      cursor,
    });
  });

  it.each([
    ['a cursor that is not a uuid', 'cursor=bad'],
    ['cursor twice', `cursor=${randomUUID()}&cursor=${randomUUID()}`],
  ])('refuses %s with 400 before the session, writing nothing', async (_label, query) => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const before = await auditCount();

    const response = await withSession('GET', `/admin/trading-sessions?${query}`, token);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe(AdminErrorCode.Validation);
    expect(await auditCount()).toBe(before);
  });

  it('refuses the next read once the session has ended', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    expect((await withSession('GET', '/admin/trading-sessions', token)).statusCode).toBe(200);
    await withSession('POST', '/admin/auth/logout', token);

    expect((await withSession('GET', '/admin/trading-sessions', token)).statusCode).toBe(401);
  });

  it("puts only the user's own intents into the card, with exact keys, in the one user_viewed row", async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedQueuedIntent(tmp.db);
    await seedQueuedIntent(tmp.db);

    const response = await readOnce(seeded.staffId, `/admin/users/${target.userId}`, token);

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ intents: { recent: object[] } }>();
    expect(Object.keys(raw.intents)).toEqual(['recent', 'total', 'active']);
    expect(Object.keys(raw.intents.recent[0] ?? {}).sort()).toEqual(INTENT_KEYS);
    const body = adminUserResponseSchema.parse(raw);
    expect(body.intents.recent.map((i) => i.id)).toEqual([target.intent.id]);
    expect(body.intents).toMatchObject({ total: 1, active: 1 });
    expect(await lastEntry(seeded.staffId)).toMatchObject({
      action: AuditAction.UserViewed,
      payload: { path: '/admin/users/:id', result: 'found', userId: target.userId },
    });
  });

  it('answers the overview intents with exactly their keys, every status included', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await readOnce(seeded.staffId, '/admin/overview', token);

    const raw = response.json<{ overview: { intents: { byStatus: object } } }>();
    expect(Object.keys(raw.overview.intents)).toEqual(['total', 'today', 'byStatus', 'active']);
    expect(Object.keys(raw.overview.intents.byStatus)).toEqual(Object.values(TradeIntentStatus));
    adminOverviewResponseSchema.parse(raw);
  });
});

describe('the token ledger page and the card section (#109)', () => {
  const ENTRY_KEYS = Object.keys(adminLedgerEntrySchema.shape);

  // no writer yet (#246): written directly, every reference and the ref pair left null
  const insertAdjustment = async (userId: string) => {
    const [row] = await tmp.db
      .insert(tokenLedger)
      .values({ userId, kind: TokenLedgerKind.Adjustment, balanceDelta: -3n, reservedDelta: 0n })
      .returning({ id: tokenLedger.id });
    if (row === undefined) throw new Error('insertAdjustment: insert returned no row');
    return row.id;
  };

  it('refuses /admin/tokens without a live session and writes nothing', async () => {
    const before = await auditCount();
    for (const headers of [BEARER, { ...BEARER, 'x-staff-session': 'a'.repeat(43) }]) {
      const response = await app.inject({ method: 'GET', url: '/admin/tokens', headers });
      expect([response.statusCode, response.json()]).toEqual([
        401,
        { error: AdminErrorCode.SessionInvalid },
      ]);
    }
    expect(await auditCount()).toBe(before);
  });

  it('lists the ledger with exactly the wire keys, drops unknown query keys, records the user', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedQueuedIntent(tmp.db);
    const adjustmentId = await insertAdjustment(target.userId);
    await seedQueuedIntent(tmp.db);

    const response = await readOnce(
      seeded.staffId,
      `/admin/tokens?user=${target.userId}&utm=1`,
      token,
    );

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ entries: Record<string, unknown>[] }>();
    expect(Object.keys(raw)).toEqual(['me', 'entries', 'nextCursor']);
    for (const entry of raw.entries) expect(Object.keys(entry)).toEqual(ENTRY_KEYS);
    const body = adminTokensResponseSchema.parse(raw);
    expect(body.entries.map((e) => [e.id, e.kind])).toEqual([
      [adjustmentId, TokenLedgerKind.Adjustment],
      [expect.any(String), TokenLedgerKind.Reserve],
    ]);
    expect(body.entries[0]).toMatchObject({
      userId: target.userId,
      telegramUserId: target.telegramUserId,
      balanceDelta: '-3',
      intentId: null,
      note: null,
    });
    expect(body.entries[1]).toMatchObject({ intentId: target.intent.id, reservedDelta: '1' });
    expect(body.nextCursor).toBeNull();
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.TokensViewed,
      actorType: AuditActorType.Admin,
      entityType: null,
      entityId: null,
      payload: { path: '/admin/tokens', userId: target.userId },
    });
  });

  it('records the kind and the cursor it was given, and nothing it was not', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const cursor = randomUUID();

    const page = await readOnce(seeded.staffId, `/admin/tokens?kind=bonus&cursor=${cursor}`, token);
    expect(page.statusCode).toBe(200);
    expect(adminTokensResponseSchema.parse(page.json()).entries).toEqual([]);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/tokens',
      kind: 'bonus',
      cursor,
    });

    expect((await readOnce(seeded.staffId, '/admin/tokens', token)).statusCode).toBe(200);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({ path: '/admin/tokens' });
  });

  it.each([
    ['an unknown kind', 'kind=bogus'],
    ['kind twice', 'kind=bonus&kind=reserve'],
    ['a user that is not a uuid', 'user=not-a-uuid'],
    ['a cursor that is not a uuid', 'cursor=bad'],
  ])('refuses %s with 400 before the session, writing nothing', async (_label, query) => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const before = await auditCount();

    const response = await withSession('GET', `/admin/tokens?${query}`, token);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe(AdminErrorCode.Validation);
    expect(await auditCount()).toBe(before);
  });

  it("puts only the user's own ledger rows into the card, with exact keys, in the one user_viewed row", async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const target = await seedQueuedIntent(tmp.db);
    const adjustmentId = await insertAdjustment(target.userId);
    const other = await seedQueuedIntent(tmp.db);
    await insertAdjustment(other.userId);

    const response = await readOnce(seeded.staffId, `/admin/users/${target.userId}`, token);

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ ledger: { recent: object[] } }>();
    expect(Object.keys(raw.ledger)).toEqual(['recent']);
    for (const entry of raw.ledger.recent) expect(Object.keys(entry)).toEqual(ENTRY_KEYS);
    const body = adminUserResponseSchema.parse(raw);
    expect(body.ledger.recent.map((e) => e.id)).toEqual([adjustmentId, expect.any(String)]);
    expect(body.ledger.recent.every((e) => e.userId === target.userId)).toBe(true);
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.UserViewed,
      actorType: AuditActorType.Admin,
      entityType: AuditEntityType.User,
      entityId: target.userId,
      payload: { path: '/admin/users/:id', result: 'found', userId: target.userId },
    });
  });

  it('refuses the next read once the session has ended', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    expect((await withSession('GET', '/admin/tokens', token)).statusCode).toBe(200);
    await withSession('POST', '/admin/auth/logout', token);

    expect((await withSession('GET', '/admin/tokens', token)).statusCode).toBe(401);
  });
});

describe('the audit log page (#110)', () => {
  const ENTRY_KEYS = Object.keys(adminAuditEntryViewSchema.shape);

  it('refuses /admin/audit without a live session and writes nothing', async () => {
    const before = await auditCount();
    for (const headers of [BEARER, { ...BEARER, 'x-staff-session': 'a'.repeat(43) }]) {
      const response = await app.inject({ method: 'GET', url: '/admin/audit', headers });
      expect([response.statusCode, response.json()]).toEqual([
        401,
        { error: AdminErrorCode.SessionInvalid },
      ]);
    }
    expect(await auditCount()).toBe(before);
  });

  it('answers with exactly the wire keys, drops unknown query keys and records the read', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);

    const response = await readOnce(seeded.staffId, '/admin/audit?utm=1', token);

    expect(response.statusCode).toBe(200);
    const raw = response.json<{ entries: Record<string, unknown>[] }>();
    expect(Object.keys(raw)).toEqual(['me', 'entries', 'nextCursor']);
    expect(raw.entries.length).toBeGreaterThan(0);
    for (const entry of raw.entries) expect(Object.keys(entry)).toEqual(ENTRY_KEYS);
    const body = adminAuditResponseSchema.parse(raw);
    expect(body.me).toMatchObject({ staffId: seeded.staffId, login: seeded.login });
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.AuditLogViewed,
      actorType: AuditActorType.Admin,
      entityType: null,
      entityId: null,
      payload: { path: '/admin/audit' },
    });
  });

  it('shows its own row on the next request, not in its own answer', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const url = `/admin/audit?action=audit_log_viewed&actorId=${seeded.staffId}`;

    const first = adminAuditResponseSchema.parse(
      (await readOnce(seeded.staffId, url, token)).json(),
    );
    expect(first.entries).toEqual([]);

    const second = adminAuditResponseSchema.parse(
      (await readOnce(seeded.staffId, url, token)).json(),
    );
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({
      action: AuditAction.AuditLogViewed,
      actorType: AuditActorType.Admin,
      actorId: seeded.staffId,
      actorLogin: seeded.login,
      payloadTruncated: false,
    });
    expect(second.entries[0]?.payload).toContain('"path": "/admin/audit"');
  });

  it('records every filter and the cursor it was given, and nothing it was not', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const query = {
      action: AuditAction.UserViewed,
      entityType: AuditEntityType.User,
      entityId: randomUUID(),
      actorId: randomUUID(),
      from: '2026-10-01',
      to: '2026-10-07',
      cursor: randomUUID(),
    };

    const page = await readOnce(
      seeded.staffId,
      `/admin/audit?${new URLSearchParams(query).toString()}`,
      token,
    );
    expect(page.statusCode).toBe(200);
    expect(adminAuditResponseSchema.parse(page.json()).entries).toEqual([]);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({ path: '/admin/audit', ...query });

    await readOnce(seeded.staffId, '/admin/audit?from=2026-10-01', token);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/audit',
      from: '2026-10-01',
    });
  });

  it('carries a long payload as a preview cut in SQL, flagged', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const writer = randomUUID();
    // no writer is needed: the action is in the CHECK; audit_log only takes INSERTs
    await tmp.db.insert(auditLog).values({
      actorType: AuditActorType.System,
      actorId: writer,
      action: AuditAction.BotTextSaved,
      entityType: AuditEntityType.BotText,
      payload: { key: 'k', oldText: 'x', newText: 'я'.repeat(20_000) },
    });

    const response = await readOnce(seeded.staffId, `/admin/audit?actorId=${writer}`, token);

    const body = adminAuditResponseSchema.parse(response.json());
    expect(body.entries).toHaveLength(1);
    expect([...(body.entries[0]?.payload ?? '')]).toHaveLength(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS);
    expect(body.entries[0]?.payloadTruncated).toBe(true);
    expect(body.entries[0]?.actorLogin).toBeNull();
  });

  it.each([
    ['an unknown action', 'action=bogus'],
    ['action twice', 'action=staff_logout&action=user_viewed'],
    ['an unknown entity type', 'entityType=bogus'],
    ['an entity id that is not a uuid', 'entityId=x'],
    ['an actor id that is not a uuid', 'actorId=cli'],
    ['an impossible date', 'from=2026-13-01'],
    ['from after to', 'from=2026-10-07&to=2026-10-06'],
    ['a cursor that is not a uuid', 'cursor=bad'],
  ])('refuses %s with 400 before the session, writing nothing', async (_label, query) => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    const before = await auditCount();

    const response = await withSession('GET', `/admin/audit?${query}`, token);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe(AdminErrorCode.Validation);
    expect(await auditCount()).toBe(before);
  });

  it('refuses the next read once the session has ended', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    expect((await withSession('GET', '/admin/audit', token)).statusCode).toBe(200);
    await withSession('POST', '/admin/auth/logout', token);

    expect((await withSession('GET', '/admin/audit', token)).statusCode).toBe(401);
  });
});

describe('the bot texts pages (#300)', () => {
  const textUrl = (key: string, action = '') =>
    `/admin/bot-texts/${encodeURIComponent(key)}${action === '' ? '' : `/${action}`}`;
  const botTextRows = () => tmp.db.select().from(botTextOverrides).orderBy(botTextOverrides.key);
  const cliSave = (key: string, source: string) =>
    saveBotTextOverride(tmp.db, {
      key,
      source,
      actor: { type: AuditActorType.System, staffId: null },
    });
  const signedIn = async () => {
    const seeded = await seedStaff(tmp.db);
    return { seeded, token: await openSession(seeded) };
  };
  const post = async (token: string, url: string, body: Record<string, unknown>) => {
    const response = await postAsStaff(url, token, body);
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  };

  beforeEach(async () => {
    await tmp.db.delete(botTextOverrides);
  });

  it.each([
    ['GET', '/admin/bot-texts', undefined],
    ['GET', '/admin/bot-texts/welcome', undefined],
    ['POST', '/admin/bot-texts/welcome/preview', { source: 'x' }],
    ['POST', '/admin/bot-texts/welcome/save', { source: 'x', expectedVersion: 0 }],
    ['POST', '/admin/bot-texts/welcome/reset', { expectedVersion: 0 }],
  ] as const)(
    'T1 refuses %s %s without a live session and writes nothing',
    async (method, url, payload) => {
      const before = await auditCount();
      for (const headers of [BEARER, { ...BEARER, 'x-staff-session': 'a'.repeat(43) }]) {
        const response = await app.inject({
          method,
          url,
          headers,
          ...(payload === undefined ? {} : { payload }),
        });
        expect([response.statusCode, response.json()]).toEqual([
          401,
          { error: AdminErrorCode.SessionInvalid },
        ]);
      }
      expect(await auditCount()).toBe(before);
    },
  );

  it('T2 lists the rows with who wrote them and why the loaders reject one', async () => {
    const { seeded, token } = await signedIn();
    await cliSave('connectButton', 'Жми');
    await post(token, textUrl('welcome', 'save'), { source: 'Привет', expectedVersion: 0 });
    await tmp.db.insert(botTextOverrides).values({ key: 'startCommand', source: 'Старт\nещё' });

    const response = await readOnce(seeded.staffId, '/admin/bot-texts', token);
    const body = adminBotTextsResponseSchema.parse(response.json());
    expect(Object.keys(response.json<object>())).toEqual(['me', 'overrides']);
    expect(Object.keys(body.overrides[0]!).sort()).toEqual(
      Object.keys(adminBotTextOverrideViewSchema.shape).sort(),
    );
    expect(body.overrides).toMatchObject([
      { key: 'connectButton', updatedByLogin: null, rejection: null },
      { key: 'startCommand', rejection: 'Перенос строки в однострочном тексте' },
      { key: 'welcome', updatedByLogin: seeded.login, rejection: null },
    ]);
    expect(await lastEntry(seeded.staffId)).toMatchObject({
      action: AuditAction.BotTextsViewed,
      entityType: null,
      payload: { path: '/admin/bot-texts' },
    });
  });

  it('T3 answers the editor with the fragments in effect; a key outside the catalog is a 404', async () => {
    const { seeded, token } = await signedIn();
    await cliSave('connectButton', 'Жми');
    const response = await readOnce(seeded.staffId, textUrl('welcome'), token);
    expect(adminBotTextResponseSchema.parse(response.json()).text).toMatchObject({
      key: 'welcome',
      override: null,
      rejection: null,
      fragments: [{ placeholder: 'connectButton', source: 'Жми', overridden: true }],
    });
    expect(await lastEntry(seeded.staffId)).toEqual({
      action: AuditAction.BotTextViewed,
      actorType: AuditActorType.Admin,
      entityType: AuditEntityType.BotText,
      entityId: null,
      payload: { path: '/admin/bot-texts/:key', key: 'welcome', result: 'found' },
    });

    for (const [key, payload] of [
      ['not a key', { path: '/admin/bot-texts/:key', result: 'not_found' }],
      ['zzz', { path: '/admin/bot-texts/:key', result: 'not_found', key: 'zzz' }],
    ] as const) {
      const missing = await readOnce(seeded.staffId, textUrl(key), token);
      expect([missing.statusCode, missing.json()]).toEqual([
        404,
        { error: AdminErrorCode.NotFound },
      ]);
      expect(await lastEntry(seeded.staffId)).toMatchObject({ entityType: null, payload });
    }
  });

  it('T4 renders a preview with the sample and the fragments in effect, and writes no row', async () => {
    const { seeded, token } = await signedIn();
    await cliSave('connectButton', 'Жми');
    const preview = async (key: string, source: string) => {
      const { body } = await post(token, textUrl(key, 'preview'), { source });
      const parsed = adminBotTextPreviewResponseSchema.parse(body);
      const entry = await lastEntry(seeded.staffId);
      return { parsed, entry };
    };

    const codeSent = await preview('codeSent', '<b>Код на {email}</b>');
    expect(codeSent.parsed).toMatchObject({
      outcome: 'rendered',
      rendered: { kind: 'html', telegramHtml: '<b>Код на ada@example.com</b>' },
    });
    expect(codeSent.entry).toMatchObject({
      action: AuditAction.BotTextPreviewed,
      entityType: AuditEntityType.BotText,
      payload: { path: '/admin/bot-texts/:key/preview', key: 'codeSent', result: 'rendered' },
    });
    expect(JSON.stringify((await preview('welcome', 'Нажми «{connectButton}»')).parsed)).toContain(
      'Нажми «Жми»',
    );
    expect((await preview('connectButton', 'Жми сюда')).parsed).toMatchObject({
      rendered: { kind: 'plain', text: 'Жми сюда' },
    });

    // #358 A2: every variable of the key at its registry sample
    expect((await preview('statusTokens', '{firstName}, {tokens}')).parsed).toMatchObject({
      rendered: { kind: 'html', telegramHtml: 'Ада, 12' },
    });
    // A3: a variable the key does not have is refused with what it may hold
    expect((await preview('codeSent', 'Код на {realBalance}')).parsed).toMatchObject({
      outcome: 'refused',
      problems: [
        {
          key: 'codeSent',
          reason:
            'Переменная {realBalance} недоступна в этом тексте. Доступны: {email}, {firstName}',
        },
      ],
    });

    const broken = await preview('welcome', '<b>тест');
    expect(broken.parsed).toMatchObject({
      outcome: 'refused',
      problems: [{ key: 'welcome', reason: 'Битый HTML: <b> is never closed' }],
    });
    expect(broken.entry?.payload).toMatchObject({ result: 'refused' });
    expect(await botTextRows()).toMatchObject([{ key: 'connectButton' }]);
  });

  it('T5 saves under the session: one audit row with both texts, the staff member as writer', async () => {
    const { seeded, token } = await signedIn();
    const before = (await entriesFor(seeded.staffId)).length;
    const { status, body } = await post(token, textUrl('welcome', 'save'), {
      source: 'Привет',
      expectedVersion: 0,
    });
    const saved = adminBotTextSaveResponseSchema.parse(body);
    if (saved.outcome !== 'saved') throw new Error(`expected saved, got ${saved.outcome}`);
    expect(status).toBe(200);
    expect(saved.text.override).toMatchObject({
      source: 'Привет',
      version: saved.version,
      updatedByLogin: seeded.login,
    });
    expect(await botTextRows()).toMatchObject([
      { key: 'welcome', updatedByStaffId: seeded.staffId, version: saved.version },
    ]);
    expect((await entriesFor(seeded.staffId)).length).toBe(before + 1);
    const entry = await lastEntry(seeded.staffId);
    expect(entry).toMatchObject({
      action: AuditAction.BotTextSaved,
      actorType: AuditActorType.Admin,
      entityType: AuditEntityType.BotText,
      entityId: null,
    });
    expect(entry?.payload).toEqual({
      path: '/admin/bot-texts/:key/save',
      result: 'saved',
      key: 'welcome',
      action: 'save',
      oldText: BOT_TEXT_CATALOG.welcome.source,
      newText: 'Привет',
      oldVersion: 0,
      newVersion: saved.version,
    });
  });

  it('T6 answers a stale version with the text there now and writes nothing', async () => {
    const { seeded, token } = await signedIn();
    const theirs = await cliSave('welcome', 'Чужой');
    if (!theirs.ok) throw new Error('the seed save failed');
    const { body } = await post(token, textUrl('welcome', 'save'), {
      source: 'Мой',
      expectedVersion: 0,
    });
    expect(adminBotTextSaveResponseSchema.parse(body)).toMatchObject({
      outcome: 'version_conflict',
      currentVersion: theirs.version,
      currentSource: 'Чужой',
    });
    expect(await botTextRows()).toMatchObject([{ source: 'Чужой', version: theirs.version }]);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/bot-texts/:key/save',
      key: 'welcome',
      result: 'version_conflict',
    });
  });

  it('T7 reports an unchanged text and T8 a fragment that breaks its host, each with its row', async () => {
    const { seeded, token } = await signedIn();
    const save = (key: string, source: string, expectedVersion: number) =>
      post(token, textUrl(key, 'save'), { source, expectedVersion });

    const same = await save('welcome', BOT_TEXT_CATALOG.welcome.source, 0);
    expect(same.body).toMatchObject({ outcome: 'unchanged' });
    expect((await lastEntry(seeded.staffId))?.payload).toMatchObject({ result: 'unchanged' });

    const button = await cliSave('connectButton', 'A');
    if (!button.ok) throw new Error('the seed save failed');
    await cliSave('welcome', `${'я'.repeat(1022)} {connectButton}`);
    const breaking = await save('connectButton', 'AB', button.version);
    expect(adminBotTextSaveResponseSchema.parse(breaking.body)).toMatchObject({
      outcome: 'refused',
      problems: [{ key: 'welcome', reason: expect.stringContaining('welcome') }],
    });
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/bot-texts/:key/save',
      key: 'connectButton',
      result: 'refused',
    });
  });

  it.each(['preview', 'save', 'reset'])(
    'T9 keeps a commands key read-only on %s, before the writer',
    async (action) => {
      const { seeded, token } = await signedIn();
      const { status, body } = await post(token, textUrl('startCommand', action), {
        ...(action === 'reset' ? {} : { source: 'Старт' }),
        ...(action === 'preview' ? {} : { expectedVersion: 0 }),
      });
      expect([status, body.outcome]).toEqual([200, 'read_only']);
      expect(await botTextRows()).toEqual([]);
      expect((await lastEntry(seeded.staffId))?.payload).toMatchObject({
        key: 'startCommand',
        result: 'read_only',
      });
    },
  );

  it('T10 resets: the row goes, the default is the new text; a stale version, a default, an orphan', async () => {
    const { seeded, token } = await signedIn();
    const reset = (key: string, expectedVersion: number) =>
      post(token, textUrl(key, 'reset'), { expectedVersion });
    const saved = await cliSave('welcome', 'Привет');
    if (!saved.ok) throw new Error('the seed save failed');

    expect((await reset('welcome', saved.version + 1000)).body).toMatchObject({
      outcome: 'version_conflict',
      currentVersion: saved.version,
      currentSource: 'Привет',
    });
    const done = adminBotTextResetResponseSchema.parse(
      (await reset('welcome', saved.version)).body,
    );
    expect(done).toMatchObject({ outcome: 'reset', text: { key: 'welcome', override: null } });
    expect(await botTextRows()).toEqual([]);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/bot-texts/:key/reset',
      result: 'reset',
      key: 'welcome',
      action: 'reset',
      oldText: 'Привет',
      newText: BOT_TEXT_CATALOG.welcome.source,
      oldVersion: saved.version,
      newVersion: 0,
    });
    expect((await reset('welcome', 0)).body).toMatchObject({ outcome: 'already_default' });
    expect((await lastEntry(seeded.staffId))?.payload).toMatchObject({ result: 'already_default' });

    const button = await cliSave('connectButton', 'A');
    if (!button.ok) throw new Error('the seed save failed');
    await cliSave('welcome', `${'я'.repeat(1022)} {connectButton}`);
    expect((await reset('connectButton', button.version)).body).toMatchObject({
      outcome: 'refused',
      problems: [{ key: 'welcome' }],
    });

    await tmp.db.insert(botTextOverrides).values({ key: 'zzz', source: 'x' });
    const [orphan] = await tmp.db
      .select()
      .from(botTextOverrides)
      .where(eq(botTextOverrides.key, 'zzz'));
    const removed = await reset('zzz', orphan!.version);
    expect(adminBotTextResetResponseSchema.parse(removed.body)).toMatchObject({
      outcome: 'reset',
      text: null,
    });
    expect((await lastEntry(seeded.staffId))?.payload).toMatchObject({
      key: 'zzz',
      result: 'reset',
      oldText: 'x',
      newText: null,
    });
  });

  it('T11 refuses a body over the limit or outside the schema before the session, without a row', async () => {
    const { token } = await signedIn();
    const before = await auditCount();
    const huge = await post(token, textUrl('welcome', 'save'), {
      source: 'a'.repeat(ADMIN_BOT_TEXT_BODY_LIMIT_BYTES),
      expectedVersion: 0,
    });
    expect(huge.status).toBe(413);
    const wrong = await post(token, textUrl('welcome', 'save'), { source: 5, expectedVersion: 0 });
    expect([wrong.status, wrong.body.error]).toEqual([400, AdminErrorCode.Validation]);
    expect(await auditCount()).toBe(before);
  });

  it('T12 answers a save of a key outside the catalog with a 404 and a row naming it', async () => {
    const { seeded, token } = await signedIn();
    const { status, body } = await post(token, textUrl('zzz', 'save'), {
      source: 'x',
      expectedVersion: 0,
    });
    expect([status, body]).toEqual([404, { error: AdminErrorCode.NotFound }]);
    expect((await lastEntry(seeded.staffId))?.payload).toEqual({
      path: '/admin/bot-texts/:key/save',
      key: 'zzz',
      result: 'not_found',
    });
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

  // at 'info', so the request lines themselves are in what is searched (#78)
  it.each([
    ['a password change', 'the current password', 200],
    ['a refused password change', 'not the password', 401],
  ])('keeps both passwords, both hashes and the token out of %s', async (_label, typed, status) => {
    const seeded = await seedStaff(tmp.db);
    const token = await openSession(seeded);
    await app.close();
    const logs = capture();
    app = build({}, logs, 'info');
    const current = typed === 'the current password' ? seeded.password : typed;
    const newPassword = 'a brand new staff password';

    const response = await postAsStaff('/admin/auth/password', token, {
      currentPassword: current,
      newPassword,
      ...CLIENT,
    });

    expect(response.statusCode).toBe(status);
    expect(lineWith(logs.lines, 'request completed')).toMatchObject({
      res: { statusCode: status },
    });
    const newHash = (await staffRow(seeded.staffId)).passwordHash;
    const written = logs.lines.join('');
    for (const secret of [current, newPassword, seeded.passwordHash, newHash, token]) {
      expect(written).not.toContain(secret);
    }
  });
});
