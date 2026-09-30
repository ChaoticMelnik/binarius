import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDatabase, seedStaff, type SeededStaff, type TempDatabase } from './testing';
import { hashToken } from './oauth-ops';
import {
  completeLogin,
  confirmChallengeFromTelegram,
  createStaffAccount,
  denyChallengeFromTelegram,
  disableStaffAccount,
  endStaffSession,
  failChallengeDelivery,
  findStaffForLogin,
  listLiveStaffSessions,
  markChallengeCodeSent,
  markChallengePromptSent,
  registerPasswordFailure,
  resetStaffPassword,
  revokeStaffSession,
  runAsStaff,
  startLoginChallenge,
  STAFF_MAX_CODE_ATTEMPTS,
  STAFF_MAX_PASSWORD_ATTEMPTS,
  STAFF_SESSION_IDLE_MS,
} from './staff-ops';
import { hashPassword } from './staff-password';
import { auditLog, staff, staffLoginChallenges, staffSessions } from './schema/index';
import { StaffLoginChallengeStatus } from './schema/staff-login-challenges';
import { StaffStatus } from './schema/staff';
import { AuditAction } from './schema/audit-log';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for packages/db integration tests (see README)');
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const IP = '203.0.113.7';
const UA = 'Mozilla/5.0';
const TELEGRAM_FAILURE = { err: { name: 'GrammyError' }, telegram: { method: 'sendMessage' } };

const start = (seeded: SeededStaff, patch: { ttlMs?: number } = {}) =>
  startLoginChallenge(tmp.db, {
    staffId: seeded.staffId,
    passwordHash: seeded.passwordHash,
    ip: IP,
    userAgent: UA,
    ...patch,
  });

/** password accepted, button pressed, code delivered: the state step 2 starts from. */
async function reachCodeEntry(seeded: SeededStaff): Promise<{ challengeId: string; code: string }> {
  const started = await start(seeded);
  if (!started.ok) throw new Error('startLoginChallenge refused a fresh login');
  const confirmed = await confirmChallengeFromTelegram(tmp.db, {
    challengeId: started.challengeId,
    telegramUserId: seeded.telegramUserId,
  });
  if (confirmed === undefined) throw new Error('confirmChallengeFromTelegram refused the press');
  await markChallengeCodeSent(tmp.db, started.challengeId);
  return { challengeId: started.challengeId, code: confirmed.code };
}

const challengeRow = async (id: string) => {
  const [row] = await tmp.db
    .select()
    .from(staffLoginChallenges)
    .where(eq(staffLoginChallenges.id, id));
  if (row === undefined) throw new Error(`no challenge ${id}`);
  return row;
};

const staffRow = async (id: string) => {
  const [row] = await tmp.db.select().from(staff).where(eq(staff.id, id));
  if (row === undefined) throw new Error(`no staff ${id}`);
  return row;
};

const entriesFor = async (staffId: string) =>
  tmp.db
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      payload: auditLog.payload,
    })
    .from(auditLog)
    .where(eq(auditLog.actorId, staffId))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

const sessionCount = async (staffId: string) =>
  (await tmp.db.select({ id: staffSessions.id }).from(staffSessions).where(eq(staffSessions.staffId, staffId)))
    .length;

// listLiveStaffSessions answers with every live session in the database, so a case that
// wants its own row has to ask for it by the token it holds
const sessionIdFor = async (token: string): Promise<string> => {
  const [row] = await tmp.db
    .select({ id: staffSessions.id })
    .from(staffSessions)
    .where(eq(staffSessions.tokenHash, hashToken(token)));
  if (row === undefined) throw new Error('no session for that token');
  return row.id;
};

/** Only the timestamps a test cannot wait for; both move together, so the CHECKs still hold. */
const backdateSession = (sessionId: string, interval: string) =>
  tmp.db
    .update(staffSessions)
    .set({
      createdAt: sql.raw(`now() - interval '${interval}'`),
      lastSeenAt: sql.raw(`now() - interval '${interval}'`),
    })
    .where(eq(staffSessions.id, sessionId));

describe('findStaffForLogin', () => {
  it('matches regardless of case and answers nothing for an unknown login', async () => {
    const seeded = await seedStaff(tmp.db);
    expect((await findStaffForLogin(tmp.db, seeded.login.toUpperCase()))?.id).toBe(seeded.staffId);
    expect(await findStaffForLogin(tmp.db, 'nobody')).toBeUndefined();
  });

  it('returns a disabled account too, so the caller can spend the same work on it', async () => {
    const seeded = await seedStaff(tmp.db, { status: StaffStatus.Disabled });
    expect((await findStaffForLogin(tmp.db, seeded.login))?.status).toBe(StaffStatus.Disabled);
  });
});

describe('registerPasswordFailure', () => {
  it('locks the account on the configured attempt and not before', async () => {
    const seeded = await seedStaff(tmp.db);
    const outcomes = [];
    for (let attempt = 0; attempt < STAFF_MAX_PASSWORD_ATTEMPTS; attempt += 1) {
      outcomes.push(await registerPasswordFailure(tmp.db, {
        staffId: seeded.staffId,
        passwordHash: seeded.passwordHash,
        ip: IP,
      }));
    }
    expect(outcomes.map((o) => o.attempts)).toEqual([1, 2, 3, 4, 5]);
    expect(outcomes.map((o) => o.locked)).toEqual([false, false, false, false, true]);
    expect((await staffRow(seeded.staffId)).lockedUntil).not.toBeNull();
  });

  it('restarts the count at 1 on the first failure after a lockout expired', async () => {
    const seeded = await seedStaff(tmp.db);
    await tmp.db
      .update(staff)
      .set({ failedPasswordAttempts: 5, lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(staff.id, seeded.staffId));
    const outcome = await registerPasswordFailure(tmp.db, {
      staffId: seeded.staffId,
      passwordHash: seeded.passwordHash,
      ip: IP,
    });
    expect(outcome).toEqual({ attempts: 1, locked: false });
    expect((await staffRow(seeded.staffId)).lockedUntil).toBeNull();
  });

  it('records the attempt without the password', async () => {
    const seeded = await seedStaff(tmp.db);
    await registerPasswordFailure(tmp.db, {
      staffId: seeded.staffId,
      passwordHash: seeded.passwordHash,
      ip: IP,
    });
    const [entry] = await entriesFor(seeded.staffId);
    expect(entry).toMatchObject({
      action: AuditAction.StaffLoginFailed,
      actorType: 'system',
      entityType: 'staff',
      payload: { reason: 'wrong_password', attempts: 1, locked: false, ip: IP },
    });
  });
});

describe('startLoginChallenge', () => {
  it('creates one challenge and asks for the invitation to be sent', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    expect(started).toMatchObject({ ok: true, reused: false, sendPrompt: true });
  });

  it('clears the failure counter and the lockout the password survived', async () => {
    const seeded = await seedStaff(tmp.db);
    await registerPasswordFailure(tmp.db, {
      staffId: seeded.staffId,
      passwordHash: seeded.passwordHash,
      ip: IP,
    });
    await start(seeded);
    expect((await staffRow(seeded.staffId)).failedPasswordAttempts).toBe(0);
  });

  // the whole point of the CAS: ~250 ms of KDF happened before this transaction opened
  it('refuses when the password changed while the KDF was running', async () => {
    const seeded = await seedStaff(tmp.db);
    await tmp.db
      .update(staff)
      .set({ passwordHash: await hashPassword('something else', { ln: 10, r: 8, p: 1 }) })
      .where(eq(staff.id, seeded.staffId));

    const started = await start(seeded);

    expect(started).toEqual({ ok: false, reason: 'state_changed' });
    expect(await tmp.db.select().from(staffLoginChallenges).where(eq(staffLoginChallenges.staffId, seeded.staffId))).toEqual([]);
    const actions = (await entriesFor(seeded.staffId)).map((e) => e.action);
    expect(actions).toEqual([AuditAction.StaffLoginFailed]);
  });

  it.each([
    ['the account was disabled', { status: StaffStatus.Disabled }],
    ['a lockout started', { lockedUntil: sql`now() + interval '15 minutes'` }],
  ])('refuses when %s while the KDF was running', async (_label, patch) => {
    const seeded = await seedStaff(tmp.db);
    await tmp.db.update(staff).set(patch).where(eq(staff.id, seeded.staffId));
    expect(await start(seeded)).toEqual({ ok: false, reason: 'state_changed' });
  });

  it('reuses the open challenge and does not ask for a second invitation', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await start(seeded);
    if (!first.ok) throw new Error('unreachable');
    await markChallengePromptSent(tmp.db, first.challengeId);

    const second = await start(seeded);

    expect(second).toMatchObject({ ok: true, challengeId: first.challengeId, reused: true, sendPrompt: false });
    const [, entry] = await entriesFor(seeded.staffId);
    expect(entry?.payload).toMatchObject({ reused: true, resent: false });
  });

  // The other reason prompt_sent_at can be NULL: the process died between a successful
  // sendMessage and markChallengePromptSent, and the button has since been pressed. Re-sending
  // there invites someone who is already holding the code, and a send that then fails would
  // close a challenge that has moved on.
  it('does not re-invite when the button was already pressed', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await start(seeded);
    if (!first.ok) throw new Error('unreachable');
    const confirmed = await confirmChallengeFromTelegram(tmp.db, {
      challengeId: first.challengeId,
      telegramUserId: seeded.telegramUserId,
    });
    expect(confirmed).toBeDefined();
    expect((await challengeRow(first.challengeId)).promptSentAt).toBeNull();

    const second = await start(seeded);

    expect(second).toMatchObject({
      ok: true,
      challengeId: first.challengeId,
      reused: true,
      sendPrompt: false,
    });
    expect((await challengeRow(first.challengeId)).status).toBe(
      StaffLoginChallengeStatus.Confirmed,
    );
  });

  // the process died between the commit and the Bot API call: nothing is in Telegram, and the
  // staff member must not have to wait out the window to try again
  it('asks for the invitation again while it has not been delivered', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await start(seeded);
    if (!first.ok) throw new Error('unreachable');

    const second = await start(seeded);

    expect(second).toMatchObject({ ok: true, challengeId: first.challengeId, reused: true, sendPrompt: true });
    const [, entry] = await entriesFor(seeded.staffId);
    expect(entry?.payload).toMatchObject({ reused: true, resent: true });
  });

  it('expires a challenge whose window closed and issues a new one', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await start(seeded, { ttlMs: 1 });
    if (!first.ok) throw new Error('unreachable');
    await tmp.db
      .update(staffLoginChallenges)
      .set({ createdAt: sql`now() - interval '10 minutes'`, expiresAt: sql`now() - interval '5 minutes'` })
      .where(eq(staffLoginChallenges.id, first.challengeId));

    const second = await start(seeded);

    expect(second).toMatchObject({ ok: true, reused: false });
    expect((await challengeRow(first.challengeId)).status).toBe(StaffLoginChallengeStatus.Expired);
  });

  // two browser tabs: the row lock serialises them, so the second sees the first one's challenge
  it('serialises two concurrent logins onto one challenge', async () => {
    const seeded = await seedStaff(tmp.db);
    const [first, second] = await Promise.all([start(seeded), start(seeded)]);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.challengeId).toBe(first.challengeId);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
  });
});

describe('the Telegram side', () => {
  it('issues a code for the account the update came from', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');

    const confirmed = await confirmChallengeFromTelegram(tmp.db, {
      challengeId: started.challengeId,
      telegramUserId: seeded.telegramUserId,
    });

    expect(confirmed).toMatchObject({ staffId: seeded.staffId, repeat: false });
    expect(confirmed?.code).toMatch(/^\d{6}$/);
    const row = await challengeRow(started.challengeId);
    expect(row.status).toBe(StaffLoginChallengeStatus.Confirmed);
    expect(row.codeHash).toBe(hashToken(confirmed!.code));
    expect(row.confirmedAt).not.toBeNull();
  });

  // authenticity of the press is decided by this CAS and nothing else
  it('refuses a press from another Telegram account', async () => {
    const seeded = await seedStaff(tmp.db);
    const other = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');

    const confirmed = await confirmChallengeFromTelegram(tmp.db, {
      challengeId: started.challengeId,
      telegramUserId: other.telegramUserId,
    });

    expect(confirmed).toBeUndefined();
    const row = await challengeRow(started.challengeId);
    expect(row.status).toBe(StaffLoginChallengeStatus.Pending);
    expect(row.codeHash).toBeNull();
    const actions = (await entriesFor(seeded.staffId)).map((e) => e.action);
    expect(actions).not.toContain(AuditAction.StaffLoginTelegramConfirmed);
  });

  it('issues a fresh code when the button is pressed again before delivery', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');
    const first = await confirmChallengeFromTelegram(tmp.db, {
      challengeId: started.challengeId,
      telegramUserId: seeded.telegramUserId,
    });
    const confirmedAtFirst = (await challengeRow(started.challengeId)).confirmedAt;

    const second = await confirmChallengeFromTelegram(tmp.db, {
      challengeId: started.challengeId,
      telegramUserId: seeded.telegramUserId,
    });

    expect(second).toMatchObject({ repeat: true });
    expect(second?.code).not.toBe(first?.code);
    expect((await challengeRow(started.challengeId)).codeHash).toBe(hashToken(second!.code));
    // the first confirmation's moment is kept: confirmed_at is when the staff member agreed,
    // and the coalesce is what stops the second press from rewriting that answer
    expect((await challengeRow(started.challengeId)).confirmedAt).toEqual(confirmedAtFirst);
  });

  it('does nothing once the code has been delivered', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);

    const again = await confirmChallengeFromTelegram(tmp.db, {
      challengeId,
      telegramUserId: seeded.telegramUserId,
    });

    expect(again).toBeUndefined();
    expect((await challengeRow(challengeId)).codeHash).toBe(hashToken(code));
  });

  it('refuses a press after the window closed', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');
    await tmp.db
      .update(staffLoginChallenges)
      .set({ createdAt: sql`now() - interval '10 minutes'`, expiresAt: sql`now() - interval '5 minutes'` })
      .where(eq(staffLoginChallenges.id, started.challengeId));

    expect(
      await confirmChallengeFromTelegram(tmp.db, {
        challengeId: started.challengeId,
        telegramUserId: seeded.telegramUserId,
      }),
    ).toBeUndefined();
  });

  it('records a denial with the address the attempt came from', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');

    const denied = await denyChallengeFromTelegram(tmp.db, {
      challengeId: started.challengeId,
      telegramUserId: seeded.telegramUserId,
    });

    expect(denied).toEqual({ staffId: seeded.staffId, ip: IP });
    expect((await challengeRow(started.challengeId)).status).toBe(
      StaffLoginChallengeStatus.Denied,
    );
    const entries = await entriesFor(seeded.staffId);
    expect(entries.at(-1)).toMatchObject({
      action: AuditAction.StaffLoginDenied,
      entityType: 'staff_login_challenge',
      payload: { ip: IP },
    });
  });

  it('refuses a denial from another Telegram account', async () => {
    const seeded = await seedStaff(tmp.db);
    const other = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');
    expect(
      await denyChallengeFromTelegram(tmp.db, {
        challengeId: started.challengeId,
        telegramUserId: other.telegramUserId,
      }),
    ).toBeUndefined();
  });

  it('closes the challenge when Telegram would not take the message', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');

    await failChallengeDelivery(tmp.db, {
      challengeId: started.challengeId,
      staffId: seeded.staffId,
      from: StaffLoginChallengeStatus.Pending,
      reason: 'prompt_send_failed',
      ...TELEGRAM_FAILURE,
    });

    expect((await challengeRow(started.challengeId)).status).toBe(
      StaffLoginChallengeStatus.Failed,
    );
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry).toMatchObject({
      action: AuditAction.StaffLoginTelegramFailed,
      payload: { reason: 'prompt_send_failed', err: { name: 'GrammyError' } },
    });
    // a failed challenge is closed, so the next login starts a new one immediately
    expect(await start(seeded)).toMatchObject({ ok: true, reused: false });
  });
});

describe('completeLogin', () => {
  it('creates one session for the right code', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);

    const completed = await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });

    expect(completed).toMatchObject({ ok: true, staffId: seeded.staffId });
    if (!completed.ok) throw new Error('unreachable');
    expect(completed.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await challengeRow(challengeId)).status).toBe(StaffLoginChallengeStatus.Completed);
    expect(await sessionCount(seeded.staffId)).toBe(1);
  });

  it('refuses the same code a second time and creates no second session', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);
    await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });

    const replay = await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });

    expect(replay).toEqual({ ok: false, reason: 'completed' });
    expect(await sessionCount(seeded.staffId)).toBe(1);
  });

  it('answers one session when two requests carry the right code at once', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);

    const [first, second] = await Promise.all([
      completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA }),
      completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA }),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(await sessionCount(seeded.staffId)).toBe(1);
  });

  it('exhausts the challenge after the configured number of wrong codes', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);
    const wrong = code === '000000' ? '111111' : '000000';

    const outcomes = [];
    for (let attempt = 0; attempt < STAFF_MAX_CODE_ATTEMPTS; attempt += 1) {
      outcomes.push(await completeLogin(tmp.db, { challengeId, code: wrong, ip: IP, userAgent: UA }));
    }

    expect(outcomes.map((o) => (o.ok ? 'ok' : o.exhausted))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect((await challengeRow(challengeId)).status).toBe(StaffLoginChallengeStatus.Exhausted);
    // and the right code afterwards is worth nothing
    expect(await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA })).toEqual({
      ok: false,
      reason: 'exhausted',
    });
    expect(await sessionCount(seeded.staffId)).toBe(0);
  });

  it('refuses a code before the button was pressed', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');
    expect(
      await completeLogin(tmp.db, {
        challengeId: started.challengeId,
        code: '123456',
        ip: IP,
        userAgent: UA,
      }),
    ).toEqual({ ok: false, reason: 'awaiting_telegram' });
  });

  it('refuses a code that was issued but not delivered', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');
    const confirmed = await confirmChallengeFromTelegram(tmp.db, {
      challengeId: started.challengeId,
      telegramUserId: seeded.telegramUserId,
    });

    expect(
      await completeLogin(tmp.db, {
        challengeId: started.challengeId,
        code: confirmed!.code,
        ip: IP,
        userAgent: UA,
      }),
    ).toEqual({ ok: false, reason: 'awaiting_telegram' });
  });

  it('refuses a code after the window closed', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);
    await tmp.db
      .update(staffLoginChallenges)
      .set({ createdAt: sql`now() - interval '10 minutes'`, expiresAt: sql`now() - interval '5 minutes'` })
      .where(eq(staffLoginChallenges.id, challengeId));

    expect(await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a code once the owner was disabled', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);
    await tmp.db
      .update(staff)
      .set({ status: StaffStatus.Disabled })
      .where(eq(staff.id, seeded.staffId));

    expect(await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA })).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(await sessionCount(seeded.staffId)).toBe(0);
  });

  it('refuses a challenge id nobody issued, without an owner to attribute it to', async () => {
    const before = await tmp.db.select({ id: auditLog.id }).from(auditLog);
    const result = await completeLogin(tmp.db, {
      challengeId: '00000000-0000-4000-8000-0000000000ff',
      code: '123456',
      ip: IP,
      userAgent: UA,
    });
    const after = await tmp.db
      .select({ action: auditLog.action, actorId: auditLog.actorId })
      .from(auditLog)
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(after.slice(before.length)).toEqual([
      { action: AuditAction.StaffLoginCodeFailed, actorId: null },
    ]);
  });
});

describe('runAsStaff', () => {
  const session = async (seeded: SeededStaff) => {
    const { challengeId, code } = await reachCodeEntry(seeded);
    const completed = await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });
    if (!completed.ok) throw new Error('unreachable');
    return completed.sessionToken;
  };

  const viewSessions = (token: string) =>
    runAsStaff(tmp.db, { token }, async (tx, ctx) => ({
      result: await listLiveStaffSessions(tx),
      audit: {
        action: AuditAction.StaffSessionsViewed,
        payload: { path: '/admin/sessions', sessionId: ctx.sessionId },
      },
    }));

  it('runs the work and records it under the staff member', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await session(seeded);

    const sessions = await viewSessions(token);

    expect(sessions?.some((row) => row.login === seeded.login)).toBe(true);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry).toMatchObject({
      action: AuditAction.StaffSessionsViewed,
      actorType: 'admin',
      payload: { path: '/admin/sessions' },
    });
  });

  it('refuses a token nobody was given', async () => {
    expect(await viewSessions('a'.repeat(43))).toBeUndefined();
  });

  // the whole reason every request re-reads the row instead of trusting a cache
  it('refuses the very next request after the session is revoked', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await session(seeded);
    const own = await sessionIdFor(token);

    await runAsStaff(tmp.db, { token }, async (tx, ctx) => ({
      result: await revokeStaffSession(tx, { sessionId: own, byStaffId: ctx.staffId }),
      audit: { action: AuditAction.StaffSessionRevoked, payload: {} },
    }));

    expect(await viewSessions(token)).toBeUndefined();
  });

  it('refuses a session idle past the window and accepts one inside it', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await session(seeded);
    const own = await sessionIdFor(token);

    await backdateSession(own, '59 minutes');
    expect(await viewSessions(token)).toBeDefined();

    // the request above moved last_seen_at back to now, so the window restarts here
    await backdateSession(own, '61 minutes');
    expect(await viewSessions(token)).toBeUndefined();
  });

  // created_at moves with it: staff_sessions_expires_after_created_check forbids a row that
  // expired before it existed, so backdating expires_at alone would be rejected — correctly
  it('refuses a session past its absolute lifetime however recently it was used', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await session(seeded);
    const own = await sessionIdFor(token);

    await tmp.db
      .update(staffSessions)
      .set({
        createdAt: sql`now() - interval '25 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      .where(eq(staffSessions.id, own));

    expect(await viewSessions(token)).toBeUndefined();
  });

  it('refuses a live session whose owner was disabled', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await session(seeded);
    await tmp.db
      .update(staff)
      .set({ status: StaffStatus.Disabled })
      .where(eq(staff.id, seeded.staffId));

    expect(await viewSessions(token)).toBeUndefined();
  });

  // no entry, no data: the touch, the work and the record share one transaction
  it('rolls the touch and the work back when the entry cannot be written', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await session(seeded);
    const own = await sessionIdFor(token);
    await backdateSession(own, '5 minutes');
    const lastSeenBefore = (
      await tmp.db
        .select({ lastSeenAt: staffSessions.lastSeenAt })
        .from(staffSessions)
        .where(eq(staffSessions.id, own))
    )[0]!.lastSeenAt;

    const failed = await runAsStaff(tmp.db, { token }, async (tx, ctx) => {
      await revokeStaffSession(tx, { sessionId: own, byStaffId: ctx.staffId });
      return {
        result: 'never delivered',
        // an action outside AuditAction: the CHECK refuses the row, which aborts everything
        audit: { action: 'staff_login_maybe' as AuditAction, payload: {} },
      };
    }).then(
      (value) => value,
      (error: unknown) => error,
    );

    expect(failed).toBeInstanceOf(Error);
    const after = await tmp.db
      .select({ lastSeenAt: staffSessions.lastSeenAt, revokedAt: staffSessions.revokedAt })
      .from(staffSessions)
      .where(eq(staffSessions.id, own));
    expect(after[0]?.revokedAt).toBeNull();
    expect(after[0]!.lastSeenAt.getTime()).toBe(lastSeenBefore.getTime());
  });
});

describe('revoking and ending sessions', () => {
  const session = async (seeded: SeededStaff) => {
    const { challengeId, code } = await reachCodeEntry(seeded);
    const completed = await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });
    if (!completed.ok) throw new Error('unreachable');
    return completed.sessionToken;
  };

  it('revokes another staff member’s session', async () => {
    const owner = await seedStaff(tmp.db);
    const other = await seedStaff(tmp.db);
    await session(owner);
    const actorToken = await session(other);
    const [target] = await tmp.db
      .select({ id: staffSessions.id })
      .from(staffSessions)
      .where(eq(staffSessions.staffId, owner.staffId));

    const revoked = await runAsStaff(tmp.db, { token: actorToken }, async (tx, ctx) => ({
      result: await revokeStaffSession(tx, { sessionId: target!.id, byStaffId: ctx.staffId }),
      audit: { action: AuditAction.StaffSessionRevoked, payload: {} },
    }));

    expect(revoked).toEqual({ staffId: owner.staffId });
    const [row] = await tmp.db
      .select({ revokedAt: staffSessions.revokedAt, by: staffSessions.revokedByStaffId })
      .from(staffSessions)
      .where(eq(staffSessions.id, target!.id));
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.by).toBe(other.staffId);
  });

  // An id nobody was issued and one that is already dead answer the same way: the caller
  // learns nothing about ids it does not already hold.
  it.each(['never existed', 'already revoked'])('answers nothing for one that %s', async (kind) => {
    const actor = await seedStaff(tmp.db);
    const victim = await seedStaff(tmp.db);
    const actorToken = await session(actor);
    const victimToken = await session(victim);
    let target = '00000000-0000-4000-8000-0000000000fe';
    if (kind === 'already revoked') {
      target = await sessionIdFor(victimToken);
      await tmp.db
        .update(staffSessions)
        .set({ revokedAt: sql`now()` })
        .where(eq(staffSessions.id, target));
    }

    const result = await runAsStaff(tmp.db, { token: actorToken }, async (tx, ctx) => ({
      result: await revokeStaffSession(tx, { sessionId: target, byStaffId: ctx.staffId }),
      audit: { action: AuditAction.StaffSessionRevoked, payload: { result: 'not_found' } },
    }));

    // the outer call succeeded (the entry was written); the inner revoke found nothing
    expect(result).toBeUndefined();
    const entries = await entriesFor(actor.staffId);
    // a truthful row about an attempt, not a row about a revocation: nothing was revoked, so
    // there is no entity to name and no entry claiming there was
    expect(entries.at(-1)).toMatchObject({
      action: AuditAction.StaffSessionRevoked,
      payload: { result: 'not_found' },
      entityType: null,
      entityId: null,
    });
  });

  it('ends the staff member’s own session', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await session(seeded);

    await runAsStaff(tmp.db, { token }, async (tx, ctx) => {
      await endStaffSession(tx, ctx.sessionId, ctx.staffId);
      return { result: true, audit: { action: AuditAction.StaffLogout, payload: {} } };
    });

    // the column's comment says NULL means the CLI did it, so a self-logout has to name the owner
    const [ended] = await tmp.db
      .select({ revokedByStaffId: staffSessions.revokedByStaffId })
      .from(staffSessions)
      .where(eq(staffSessions.tokenHash, hashToken(token)));
    expect(ended?.revokedByStaffId).toBe(seeded.staffId);

    expect(
      await runAsStaff(tmp.db, { token }, async () => ({
        result: true,
        audit: { action: AuditAction.StaffSessionsViewed, payload: {} },
      })),
    ).toBeUndefined();
  });

  it('lists only live sessions', async () => {
    const seeded = await seedStaff(tmp.db);
    const token = await session(seeded);
    const stale = await session(seeded);
    const [staleRow] = await tmp.db
      .select({ id: staffSessions.id })
      .from(staffSessions)
      .where(eq(staffSessions.tokenHash, hashToken(stale)));
    await tmp.db
      .update(staffSessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(staffSessions.id, staleRow!.id));

    const listed = await runAsStaff(tmp.db, { token }, async (tx) => ({
      result: await listLiveStaffSessions(tx, STAFF_SESSION_IDLE_MS),
      audit: { action: AuditAction.StaffSessionsViewed, payload: {} },
    }));

    expect(listed?.map((row) => row.id)).not.toContain(staleRow!.id);
  });
});

describe('the CLI operations', () => {
  it('creates an account and records who it is', async () => {
    const created = await createStaffAccount(tmp.db, {
      login: 'ada.cli',
      passwordHash: await hashPassword('x', { ln: 10, r: 8, p: 1 }),
      telegramUserId: 995_001n,
      displayName: 'Ада',
    });

    expect(created.login).toBe('ada.cli');
    const entry = (await entriesFor(created.id)).at(-1);
    expect(entry).toMatchObject({
      action: AuditAction.StaffCreated,
      actorType: 'system',
      entityType: 'staff',
      payload: { via: 'cli' },
    });
  });

  it('disables an account, closes its challenge and revokes its sessions', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);
    await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });
    // the completed challenge is closed, so this login opens a second one, in flight when
    // the account is disabled a moment later
    const reopened = await start(seeded);
    if (!reopened.ok) throw new Error('unreachable');

    const counts = await disableStaffAccount(tmp.db, seeded.login.toUpperCase());

    expect(counts).toEqual({ closedChallenges: 1, revokedSessions: 1 });
    expect((await staffRow(seeded.staffId)).status).toBe(StaffStatus.Disabled);
    // the other side of the same column: no staff member is behind a CLI revocation
    const revokedByCli = await tmp.db
      .select({ by: staffSessions.revokedByStaffId, at: staffSessions.revokedAt })
      .from(staffSessions)
      .where(eq(staffSessions.staffId, seeded.staffId));
    expect(revokedByCli).toEqual([{ by: null, at: expect.any(Date) }]);
    expect((await challengeRow(reopened.challengeId)).status).toBe(
      StaffLoginChallengeStatus.Expired,
    );
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry).toMatchObject({
      action: AuditAction.StaffDisabled,
      payload: { via: 'cli', closedChallenges: 1, revokedSessions: 1 },
    });
  });

  // a challenge created under the old password would otherwise still walk through to a session
  it('closes the open challenge when the password is reset', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);

    await resetStaffPassword(tmp.db, {
      login: seeded.login,
      passwordHash: await hashPassword('new one', { ln: 10, r: 8, p: 1 }),
    });

    expect((await challengeRow(challengeId)).status).toBe(StaffLoginChallengeStatus.Expired);
    expect(await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('revokes the sessions the old password produced and clears the lockout', async () => {
    const seeded = await seedStaff(tmp.db);
    const { challengeId, code } = await reachCodeEntry(seeded);
    await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });
    for (let attempt = 0; attempt < STAFF_MAX_PASSWORD_ATTEMPTS; attempt += 1) {
      await registerPasswordFailure(tmp.db, {
        staffId: seeded.staffId,
        passwordHash: seeded.passwordHash,
        ip: IP,
      });
    }

    const counts = await resetStaffPassword(tmp.db, {
      login: seeded.login,
      passwordHash: await hashPassword('new one', { ln: 10, r: 8, p: 1 }),
    });

    expect(counts).toMatchObject({ revokedSessions: 1 });
    const row = await staffRow(seeded.staffId);
    expect([row.failedPasswordAttempts, row.lockedUntil]).toEqual([0, null]);
  });

  it.each([
    ['disable', (login: string) => disableStaffAccount(tmp.db, login)],
    [
      'reset-password',
      async (login: string) =>
        resetStaffPassword(tmp.db, {
          login,
          passwordHash: await hashPassword('x', { ln: 10, r: 8, p: 1 }),
        }),
    ],
  ])('answers nothing when %s names a login that does not exist', async (_label, run) => {
    expect(await run('nobody-here')).toBeUndefined();
  });
});

describe('completeLogin under the code-sent race', () => {
  // The CAS needs code_sent_at, and markChallengeCodeSent can commit between that statement and
  // the re-read (READ COMMITTED: one snapshot per statement). The seam runs it exactly there.
  it('treats a code that arrived while the CAS was running as early, not as over', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');
    const confirmed = await confirmChallengeFromTelegram(tmp.db, {
      challengeId: started.challengeId,
      telegramUserId: seeded.telegramUserId,
    });
    if (confirmed === undefined) throw new Error('unreachable');
    const raced: typeof tmp.db = Object.create(tmp.db, {
      transaction: {
        value: (fn: (tx: unknown) => Promise<unknown>) =>
          tmp.db.transaction(async (tx) => {
            const spied = Object.create(tx) as {
              execute: (...args: unknown[]) => Promise<unknown>;
            };
            spied.execute = async (...args: unknown[]) => {
              const result = await (tx.execute as (...a: unknown[]) => Promise<unknown>)(...args);
              await markChallengeCodeSent(tmp.db, started.challengeId);
              return result;
            };
            return fn(spied);
          }),
      },
    });

    const early = await completeLogin(raced, {
      challengeId: started.challengeId,
      code: confirmed.code,
      ip: IP,
      userAgent: UA,
    });

    expect(early).toEqual({ ok: false, reason: 'awaiting_telegram' });
    const row = await challengeRow(started.challengeId);
    expect([row.status, row.codeAttempts]).toEqual([StaffLoginChallengeStatus.Confirmed, 0]);
    const late = await completeLogin(tmp.db, {
      challengeId: started.challengeId,
      code: confirmed.code,
      ip: IP,
      userAgent: UA,
    });
    expect(late.ok).toBe(true);
  });
});
