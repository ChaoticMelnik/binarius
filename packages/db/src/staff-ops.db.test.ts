import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from './client';
import {
  createTempDatabase,
  lockWaiters,
  seedStaff,
  type SeededStaff,
  type TempDatabase,
  TEST_SCRYPT_PARAMS,
} from './testing';
import { hashToken } from './oauth-ops';
import {
  applyStaffPasswordChange,
  completeLogin,
  countPasswordFailure,
  type CompleteLoginResult,
  confirmChallengeFromTelegram,
  createStaffAccount,
  denyChallengeFromTelegram,
  disableStaffAccount,
  endStaffSession,
  failChallengeDelivery,
  findStaffForLogin,
  findStaffForPasswordChange,
  readLiveStaffContext,
  listLiveStaffSessions,
  markChallengeCodeSent,
  markChallengePromptSent,
  recordLoginLockout,
  recordPasswordChangeLockout,
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
import { AuditAction } from '@binarius/shared';
import { until } from '@binarius/shared/testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const IP = '203.0.113.7';
// the change form's lockout row names the pre-read's session; any uuid stands in for it here
const SESSION_ID = '00000000-0000-4000-8000-000000000078';
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
  await markChallengeCodeSent(tmp.db, started.challengeId, confirmed.code);
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
  (
    await tmp.db
      .select({ id: staffSessions.id })
      .from(staffSessions)
      .where(eq(staffSessions.staffId, staffId))
  ).length;

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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** `hook` runs once, right after the transaction's first `UPDATE staff` statement completes. */
function afterStaffUpdate(db: Db, hook: () => Promise<void>): Db {
  return Object.create(db, {
    transaction: {
      value: (fn: (tx: Tx) => Promise<unknown>) =>
        db.transaction(async (tx) => {
          let fired = false;
          const spied: Tx = Object.create(tx);
          spied.update = ((table: Parameters<Tx['update']>[0]) => {
            const builder = tx.update(table);
            if (table !== staff || fired) return builder;
            fired = true;
            const set = builder.set.bind(builder);
            builder.set = (values) => {
              const base = set(values);
              const execute = base.execute;
              base.execute = async (placeholderValues) => {
                const result = await execute.call(base, placeholderValues);
                await hook();
                return result;
              };
              return base;
            };
            return builder;
          }) as Tx['update'];
          return fn(spied);
        }),
    },
  }) as Db;
}

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
      outcomes.push(
        await registerPasswordFailure(tmp.db, {
          staffId: seeded.staffId,
          passwordHash: seeded.passwordHash,
          ip: IP,
        }),
      );
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
    expect(
      await tmp.db
        .select()
        .from(staffLoginChallenges)
        .where(eq(staffLoginChallenges.staffId, seeded.staffId)),
    ).toEqual([]);
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

    expect(second).toMatchObject({
      ok: true,
      challengeId: first.challengeId,
      reused: true,
      sendPrompt: false,
    });
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

    expect(second).toMatchObject({
      ok: true,
      challengeId: first.challengeId,
      reused: true,
      sendPrompt: true,
    });
    const [, entry] = await entriesFor(seeded.staffId);
    expect(entry?.payload).toMatchObject({ reused: true, resent: true });
  });

  it('expires a challenge whose window closed and issues a new one', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await start(seeded, { ttlMs: 1 });
    if (!first.ok) throw new Error('unreachable');
    await tmp.db
      .update(staffLoginChallenges)
      .set({
        createdAt: sql`now() - interval '10 minutes'`,
        expiresAt: sql`now() - interval '5 minutes'`,
      })
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
      .set({
        createdAt: sql`now() - interval '10 minutes'`,
        expiresAt: sql`now() - interval '5 minutes'`,
      })
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
    expect((await challengeRow(started.challengeId)).status).toBe(StaffLoginChallengeStatus.Denied);
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

    expect((await challengeRow(started.challengeId)).status).toBe(StaffLoginChallengeStatus.Failed);
    const entry = (await entriesFor(seeded.staffId)).at(-1);
    expect(entry).toMatchObject({
      action: AuditAction.StaffLoginTelegramFailed,
      payload: { reason: 'prompt_send_failed', err: { name: 'GrammyError' } },
    });
    // a failed challenge is closed, so the next login starts a new one immediately
    expect(await start(seeded)).toMatchObject({ ok: true, reused: false });
  });

  it('closes nothing when the code that failed to send is no longer the current one', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');
    const press = () =>
      confirmChallengeFromTelegram(tmp.db, {
        challengeId: started.challengeId,
        telegramUserId: seeded.telegramUserId,
      });
    const first = await press();
    const second = await press();
    if (first === undefined || second === undefined) throw new Error('unreachable');

    const stale = await failChallengeDelivery(tmp.db, {
      challengeId: started.challengeId,
      staffId: seeded.staffId,
      from: StaffLoginChallengeStatus.Confirmed,
      reason: 'code_send_failed',
      code: first.code,
      ...TELEGRAM_FAILURE,
    });

    expect(stale).toBe(false);
    expect((await challengeRow(started.challengeId)).status).toBe(
      StaffLoginChallengeStatus.Confirmed,
    );
    expect((await entriesFor(seeded.staffId)).at(-1)).toMatchObject({
      action: AuditAction.StaffLoginTelegramFailed,
      payload: { reason: 'code_send_failed', closed: false },
    });

    const current = await failChallengeDelivery(tmp.db, {
      challengeId: started.challengeId,
      staffId: seeded.staffId,
      from: StaffLoginChallengeStatus.Confirmed,
      reason: 'code_send_failed',
      code: second.code,
      ...TELEGRAM_FAILURE,
    });

    expect(current).toBe(true);
    expect((await challengeRow(started.challengeId)).status).toBe(StaffLoginChallengeStatus.Failed);
  });

  it('marks only the current code as sent', async () => {
    const seeded = await seedStaff(tmp.db);
    const started = await start(seeded);
    if (!started.ok) throw new Error('unreachable');
    const press = () =>
      confirmChallengeFromTelegram(tmp.db, {
        challengeId: started.challengeId,
        telegramUserId: seeded.telegramUserId,
      });
    const first = await press();
    const second = await press();
    if (first === undefined || second === undefined) throw new Error('unreachable');

    expect(await markChallengeCodeSent(tmp.db, started.challengeId, first.code)).toBe(false);
    expect((await challengeRow(started.challengeId)).codeSentAt).toBeNull();

    expect(await markChallengeCodeSent(tmp.db, started.challengeId, second.code)).toBe(true);
    expect((await challengeRow(started.challengeId)).codeSentAt).not.toBeNull();
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
      outcomes.push(
        await completeLogin(tmp.db, { challengeId, code: wrong, ip: IP, userAgent: UA }),
      );
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
      .set({
        createdAt: sql`now() - interval '10 minutes'`,
        expiresAt: sql`now() - interval '5 minutes'`,
      })
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

    expect(counts).toEqual({ closedChallenges: 1, closedLinks: 0, revokedSessions: 1 });
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
      payload: { via: 'cli', closedChallenges: 1, closedLinks: 0, revokedSessions: 1 },
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

describe('the CLI operations racing a completeLogin', () => {
  // READ COMMITTED gives every statement its own snapshot, so the revoking UPDATE sees the
  // session a login that began later has already committed — and that row's created_at is after
  // now(), which is the revoking transaction's start. Stamped with now(), revoked_at trips
  // staff_sessions_revoked_after_created_check and aborts the whole operation, leaving the
  // account as it was and the session that was just issued live (#149).
  const paths = [
    {
      label: 'disable',
      action: AuditAction.StaffDisabled,
      run: async (db: Db, seeded: SeededStaff) => {
        const counts = await disableStaffAccount(db, seeded.login);
        const staffRowCarriesTheOperation = async () =>
          expect((await staffRow(seeded.staffId)).status).toBe(StaffStatus.Disabled);
        return { counts, staffRowCarriesTheOperation };
      },
    },
    {
      label: 'reset-password',
      action: AuditAction.StaffPasswordReset,
      run: async (db: Db, seeded: SeededStaff) => {
        const passwordHash = await hashPassword('new one', { ln: 10, r: 8, p: 1 });
        const counts = await resetStaffPassword(db, { login: seeded.login, passwordHash });
        const staffRowCarriesTheOperation = async () =>
          expect((await staffRow(seeded.staffId)).passwordHash).toBe(passwordHash);
        return { counts, staffRowCarriesTheOperation };
      },
    },
  ];

  it.each(paths)(
    'revokes the session $label raced with, instead of aborting on the revoked_at CHECK',
    async ({ action, run }) => {
      const seeded = await seedStaff(tmp.db);
      const { challengeId, code } = await reachCodeEntry(seeded);
      let login: CompleteLoginResult | undefined;
      // another connection, committing while the CLI transaction holds the staff row
      const raced = afterStaffUpdate(tmp.db, async () => {
        login = await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });
      });

      const { counts, staffRowCarriesTheOperation } = await run(raced, seeded);

      // both of these are the race itself: a seam that stopped firing leaves no session to
      // revoke, and the case would otherwise pass on no race at all
      expect(login).toMatchObject({ ok: true });
      expect(counts).toEqual({ closedChallenges: 0, closedLinks: 0, revokedSessions: 1 });
      if (login === undefined || !login.ok) throw new Error('unreachable');
      await staffRowCarriesTheOperation();
      const [row] = await tmp.db
        .select({
          createdAt: staffSessions.createdAt,
          revokedAt: staffSessions.revokedAt,
          revokedBy: staffSessions.revokedByStaffId,
        })
        .from(staffSessions)
        .where(eq(staffSessions.staffId, seeded.staffId));
      if (row === undefined) throw new Error('the raced login left no session');
      const { createdAt, revokedAt, revokedBy } = row;
      if (revokedAt === null) throw new Error('the raced session was not revoked');
      expect(revokedAt.getTime()).toBeGreaterThanOrEqual(createdAt.getTime());
      expect(revokedBy).toBeNull();
      expect(
        await runAsStaff(tmp.db, { token: login.sessionToken }, async () => ({
          result: 'served',
          audit: { action: AuditAction.StaffSessionsViewed, payload: {} },
        })),
      ).toBeUndefined();
      // not the last entry: this transaction began before the login's, and created_at is now()
      const entry = (await entriesFor(seeded.staffId)).find((written) => written.action === action);
      expect(entry).toMatchObject({
        actorType: 'system',
        entityType: 'staff',
        payload: { via: 'cli', closedChallenges: 0, closedLinks: 0, revokedSessions: 1 },
      });
    },
  );
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
              await markChallengeCodeSent(tmp.db, started.challengeId, confirmed.code);
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

describe('changing your own password (#78)', () => {
  const session = async (seeded: SeededStaff) => {
    const { challengeId, code } = await reachCodeEntry(seeded);
    const completed = await completeLogin(tmp.db, { challengeId, code, ip: IP, userAgent: UA });
    if (!completed.ok) throw new Error('unreachable');
    return completed.sessionToken;
  };

  const newHash = (password = 'brand new password') => hashPassword(password, TEST_SCRYPT_PARAMS);

  const served = (token: string) =>
    runAsStaff(tmp.db, { token }, async () => ({
      result: 'served',
      audit: { action: AuditAction.StaffSessionsViewed, payload: {} },
    }));

  const change = (
    token: string,
    seeded: SeededStaff,
    newPasswordHash: string,
    beforeWrite: () => Promise<void> = async () => {},
  ) =>
    runAsStaff(tmp.db, { token, lockStaff: true }, async (tx, ctx) => {
      await beforeWrite();
      const result = await applyStaffPasswordChange(tx, {
        staffId: ctx.staffId,
        sessionId: ctx.sessionId,
        passwordHashSeen: seeded.passwordHash,
        newPasswordHash,
      });
      return {
        result,
        audit: { action: AuditAction.StaffPasswordChanged, payload: { sessionId: ctx.sessionId } },
      };
    });

  const revoke = (
    token: string,
    sessionId: string,
    beforeWrite: () => Promise<void> = async () => {},
  ) =>
    runAsStaff(tmp.db, { token, lockStaff: true }, async (tx, ctx) => {
      await beforeWrite();
      return {
        result: await revokeStaffSession(tx, { sessionId, byStaffId: ctx.staffId }),
        audit: { action: AuditAction.StaffSessionRevoked, payload: {} },
      };
    });

  const sessionState = async (sessionId: string) => {
    const [row] = await tmp.db
      .select({ revokedAt: staffSessions.revokedAt, revokedBy: staffSessions.revokedByStaffId })
      .from(staffSessions)
      .where(eq(staffSessions.id, sessionId));
    if (row === undefined) throw new Error(`no session ${sessionId}`);
    return row;
  };

  type Settled = { ok: unknown } | { err: unknown };
  const settle = (work: Promise<unknown>): Promise<Settled> =>
    work.then(
      (ok) => ({ ok }),
      (error: { cause?: { code?: unknown }; code?: unknown }) => ({
        err: error.cause?.code ?? error.code ?? String(error),
      }),
    );

  /** Returns once the other side is queued behind a lock this transaction holds. */
  const waitForLockWaiter = () =>
    until(
      'the other transaction to queue behind a lock',
      async () => (await lockWaiters(tmp.db)) > 0,
    );

  describe('findStaffForPasswordChange', () => {
    it('reads the hash by a live session and no lockout', async () => {
      const seeded = await seedStaff(tmp.db);
      const token = await session(seeded);

      expect(await findStaffForPasswordChange(tmp.db, { token })).toEqual({
        staffId: seeded.staffId,
        sessionId: await sessionIdFor(token),
        passwordHash: seeded.passwordHash,
        lockedUntil: null,
      });
    });

    it('reports a running lockout by the database clock and hides an expired one', async () => {
      const seeded = await seedStaff(tmp.db);
      const token = await session(seeded);

      await tmp.db
        .update(staff)
        .set({ lockedUntil: sql`now() + interval '15 minutes'` })
        .where(eq(staff.id, seeded.staffId));
      expect((await findStaffForPasswordChange(tmp.db, { token }))?.lockedUntil).toBeInstanceOf(
        Date,
      );

      await tmp.db
        .update(staff)
        .set({ lockedUntil: sql`now() - interval '1 minute'` })
        .where(eq(staff.id, seeded.staffId));
      expect((await findStaffForPasswordChange(tmp.db, { token }))?.lockedUntil).toBeNull();
    });

    it('answers nothing for a token nobody holds or a revoked session', async () => {
      const seeded = await seedStaff(tmp.db);
      const token = await session(seeded);
      expect(await findStaffForPasswordChange(tmp.db, { token: 'b'.repeat(43) })).toBeUndefined();

      await tmp.db
        .update(staffSessions)
        .set({ revokedAt: sql`now()` })
        .where(eq(staffSessions.id, await sessionIdFor(token)));
      expect(await findStaffForPasswordChange(tmp.db, { token })).toBeUndefined();
    });

    it('answers nothing for a session idle past the window', async () => {
      const seeded = await seedStaff(tmp.db);
      const token = await session(seeded);
      await backdateSession(await sessionIdFor(token), '61 minutes');

      expect(await findStaffForPasswordChange(tmp.db, { token })).toBeUndefined();
    });

    it('answers nothing for a session past its absolute lifetime', async () => {
      const seeded = await seedStaff(tmp.db);
      const token = await session(seeded);
      await tmp.db
        .update(staffSessions)
        .set({
          createdAt: sql`now() - interval '25 hours'`,
          expiresAt: sql`now() - interval '1 hour'`,
        })
        .where(eq(staffSessions.id, await sessionIdFor(token)));

      expect(await findStaffForPasswordChange(tmp.db, { token })).toBeUndefined();
    });

    it('answers nothing once the owner is disabled', async () => {
      const seeded = await seedStaff(tmp.db);
      const token = await session(seeded);
      await tmp.db
        .update(staff)
        .set({ status: StaffStatus.Disabled })
        .where(eq(staff.id, seeded.staffId));

      expect(await findStaffForPasswordChange(tmp.db, { token })).toBeUndefined();
    });
  });

  // the republish route's session check (#361); here for this block's session helper
  describe('readLiveStaffContext', () => {
    const seen = async (token: string) => {
      const [row] = await tmp.db
        .select({ lastSeenAt: staffSessions.lastSeenAt })
        .from(staffSessions)
        .where(eq(staffSessions.id, await sessionIdFor(token)));
      return row?.lastSeenAt.toISOString();
    };
    const auditRows = async () => (await tmp.db.select({ id: auditLog.id }).from(auditLog)).length;

    it('L1 answers the staff member of a live session without touching it or writing a row', async () => {
      const seeded = await seedStaff(tmp.db);
      const token = await session(seeded);
      await backdateSession(await sessionIdFor(token), '5 minutes');
      const before = await seen(token);
      const rows = await auditRows();

      expect(await readLiveStaffContext(tmp.db, { token })).toEqual({
        sessionId: await sessionIdFor(token),
        staffId: seeded.staffId,
        login: seeded.login,
      });
      expect(await seen(token)).toBe(before);
      expect(await auditRows()).toBe(rows);
    });

    it.each([
      ['a token nobody holds', async () => 'b'.repeat(43)],
      [
        'a revoked session',
        async (token: string) => {
          await tmp.db
            .update(staffSessions)
            .set({ revokedAt: sql`now()` })
            .where(eq(staffSessions.id, await sessionIdFor(token)));
          return token;
        },
      ],
      [
        'a session idle past the window',
        async (token: string) => {
          await backdateSession(await sessionIdFor(token), '61 minutes');
          return token;
        },
      ],
      [
        'a session past its absolute lifetime',
        async (token: string) => {
          await tmp.db
            .update(staffSessions)
            .set({
              createdAt: sql`now() - interval '25 hours'`,
              expiresAt: sql`now() - interval '1 hour'`,
            })
            .where(eq(staffSessions.id, await sessionIdFor(token)));
          return token;
        },
      ],
    ])('L2 answers nothing for %s', async (_name, spoil) => {
      const seeded = await seedStaff(tmp.db);
      const token = await spoil(await session(seeded));
      expect(await readLiveStaffContext(tmp.db, { token })).toBeUndefined();
    });

    it('L2 answers nothing once the owner is disabled', async () => {
      const seeded = await seedStaff(tmp.db);
      const token = await session(seeded);
      await tmp.db
        .update(staff)
        .set({ status: StaffStatus.Disabled })
        .where(eq(staff.id, seeded.staffId));
      expect(await readLiveStaffContext(tmp.db, { token })).toBeUndefined();
    });
  });

  describe('applyStaffPasswordChange', () => {
    it('replaces the hash, clears the counter and revokes everything else the old password issued', async () => {
      const seeded = await seedStaff(tmp.db);
      const current = await session(seeded);
      const other = await session(seeded);
      const third = await session(seeded);
      const expired = await session(seeded);
      await tmp.db
        .update(staffSessions)
        .set({
          createdAt: sql`now() - interval '25 hours'`,
          expiresAt: sql`now() - interval '1 hour'`,
        })
        .where(eq(staffSessions.id, await sessionIdFor(expired)));
      const open = await start(seeded);
      if (!open.ok) throw new Error('unreachable');
      await tmp.db
        .update(staff)
        .set({ failedPasswordAttempts: 3 })
        .where(eq(staff.id, seeded.staffId));
      const hash = await newHash();

      const result = await change(current, seeded, hash);

      expect(result).toEqual({ ok: true, closedChallenges: 1, closedLinks: 0, revokedSessions: 2 });
      const row = await staffRow(seeded.staffId);
      expect([row.passwordHash, row.failedPasswordAttempts, row.lockedUntil]).toEqual([
        hash,
        0,
        null,
      ]);
      for (const token of [other, third]) {
        const state = await sessionState(await sessionIdFor(token));
        expect(state.revokedAt).not.toBeNull();
        expect(state.revokedBy).toBe(seeded.staffId);
        expect(await served(token)).toBeUndefined();
      }
      expect((await sessionState(await sessionIdFor(expired))).revokedAt).toBeNull();
      expect((await sessionState(await sessionIdFor(current))).revokedAt).toBeNull();
      expect(await served(current)).toBe('served');
      expect((await challengeRow(open.challengeId)).status).toBe(StaffLoginChallengeStatus.Expired);
    });

    it('refuses when the hash changed under the KDF and leaves every session alive', async () => {
      const seeded = await seedStaff(tmp.db);
      const current = await session(seeded);
      const other = await session(seeded);
      const elsewhere = await newHash('set by somebody else');
      await tmp.db
        .update(staff)
        .set({ passwordHash: elsewhere })
        .where(eq(staff.id, seeded.staffId));

      expect(await change(current, seeded, await newHash())).toEqual({
        ok: false,
        reason: 'state_changed',
      });
      expect((await staffRow(seeded.staffId)).passwordHash).toBe(elsewhere);
      expect(await served(other)).toBe('served');
    });

    it('answers a lockout that began under the KDF as one and changes nothing', async () => {
      const seeded = await seedStaff(tmp.db);
      const current = await session(seeded);
      const other = await session(seeded);
      await tmp.db
        .update(staff)
        .set({ lockedUntil: sql`now() + interval '15 minutes'` })
        .where(eq(staff.id, seeded.staffId));

      expect(await change(current, seeded, await newHash())).toEqual({
        ok: false,
        reason: 'locked',
        lockedUntil: (await staffRow(seeded.staffId)).lockedUntil,
      });
      expect((await staffRow(seeded.staffId)).passwordHash).toBe(seeded.passwordHash);
      expect(await served(other)).toBe('served');
    });
  });

  // the change form's failures go through the same CAS as the login's, and zero rows has to say
  // whether a lockout or a changed row is why: the route answers the first 429, the second 401
  describe('countPasswordFailure on a row that is no longer the one the KDF saw', () => {
    const count = (seeded: SeededStaff) =>
      tmp.db.transaction((tx) =>
        countPasswordFailure(tx, { staffId: seeded.staffId, passwordHash: seeded.passwordHash }),
      );

    it('reports a running lockout with its deadline and counts nothing', async () => {
      const seeded = await seedStaff(tmp.db);
      await tmp.db
        .update(staff)
        .set({ failedPasswordAttempts: 5, lockedUntil: sql`now() + interval '15 minutes'` })
        .where(eq(staff.id, seeded.staffId));
      const before = await staffRow(seeded.staffId);

      expect(await count(seeded)).toEqual({
        attempts: 0,
        locked: false,
        stateChanged: true,
        lockedUntil: before.lockedUntil,
      });
      expect((await staffRow(seeded.staffId)).failedPasswordAttempts).toBe(5);
    });

    it('reports a changed hash as state_changed without a deadline', async () => {
      const seeded = await seedStaff(tmp.db);
      await tmp.db
        .update(staff)
        .set({ passwordHash: await newHash('set elsewhere') })
        .where(eq(staff.id, seeded.staffId));

      expect(await count(seeded)).toEqual({
        attempts: 0,
        locked: false,
        stateChanged: true,
        lockedUntil: null,
      });
    });

    it('reports an expired lockout over a changed hash as a changed row, not a lockout', async () => {
      const seeded = await seedStaff(tmp.db);
      await tmp.db
        .update(staff)
        .set({
          passwordHash: await newHash('set elsewhere'),
          failedPasswordAttempts: 5,
          lockedUntil: sql`now() - interval '1 second'`,
        })
        .where(eq(staff.id, seeded.staffId));

      expect(await count(seeded)).toEqual({
        attempts: 0,
        locked: false,
        stateChanged: true,
        lockedUntil: null,
      });
    });

    it('keeps the login row for a locked account as it was', async () => {
      const seeded = await seedStaff(tmp.db);
      await tmp.db
        .update(staff)
        .set({ lockedUntil: sql`now() + interval '15 minutes'` })
        .where(eq(staff.id, seeded.staffId));

      await registerPasswordFailure(tmp.db, {
        staffId: seeded.staffId,
        passwordHash: seeded.passwordHash,
        ip: IP,
      });

      expect((await entriesFor(seeded.staffId)).at(-1)).toMatchObject({
        action: AuditAction.StaffLoginFailed,
        payload: { reason: 'state_changed', ip: IP },
      });
      expect(Object.keys((await entriesFor(seeded.staffId)).at(-1)!.payload as object)).toEqual([
        'ip',
        'reason',
      ]);
    });
  });

  // review round 2, n1: the refusal under a lockout re-reads it in the transaction that records
  // it, so a lockout the caller's snapshot saw but that ended since is not a refusal
  describe.each([
    {
      name: 'recordLoginLockout',
      action: AuditAction.StaffLoginLocked,
      record: (seeded: SeededStaff) =>
        recordLoginLockout(tmp.db, { staffId: seeded.staffId, ip: IP }),
      extra: {},
    },
    {
      name: 'recordPasswordChangeLockout',
      action: AuditAction.StaffPasswordChangeFailed,
      record: (seeded: SeededStaff) =>
        recordPasswordChangeLockout(tmp.db, {
          staffId: seeded.staffId,
          sessionId: SESSION_ID,
          ip: IP,
        }),
      extra: { reason: 'locked', sessionId: SESSION_ID },
    },
  ])('$name', ({ action, record, extra }) => {
    const lockFor = (seeded: SeededStaff, interval: string) =>
      tmp.db
        .update(staff)
        .set({ failedPasswordAttempts: 5, lockedUntil: sql.raw(`now() ${interval}`) })
        .where(eq(staff.id, seeded.staffId));

    it('records a running lockout with the deadline it reads, and returns it', async () => {
      const seeded = await seedStaff(tmp.db);
      await lockFor(seeded, "+ interval '15 minutes'");
      const { lockedUntil } = await staffRow(seeded.staffId);

      expect(await record(seeded)).toEqual(lockedUntil);

      const entries = (await entriesFor(seeded.staffId)).filter((entry) => entry.action === action);
      expect(entries.map((entry) => entry.payload)).toEqual([
        { ...extra, ip: IP, lockedUntil: lockedUntil?.toISOString() },
      ]);
    });

    it('writes nothing and returns null once the lockout has ended', async () => {
      const seeded = await seedStaff(tmp.db);
      await lockFor(seeded, "- interval '1 second'");

      expect(await record(seeded)).toBeNull();

      expect((await entriesFor(seeded.staffId)).filter((entry) => entry.action === action)).toEqual(
        [],
      );
    });
  });

  // staff → sessions for every writer of the domain: without lockStaff each of these pairs
  // deadlocks (40P01), because the request holds its own session row before it reaches staff
  describe('the lock order staff → sessions', () => {
    it('serialises a change against a CLI reset that starts while the change holds staff', async () => {
      const seeded = await seedStaff(tmp.db);
      const current = await session(seeded);
      const other = await session(seeded);
      const cliHash = await newHash('the operator chose this');
      let cli: Promise<Settled> | undefined;

      const request = await settle(
        change(current, seeded, await newHash(), async () => {
          cli = settle(resetStaffPassword(tmp.db, { login: seeded.login, passwordHash: cliHash }));
          await waitForLockWaiter();
        }),
      );

      expect(request).toEqual({
        ok: { ok: true, closedChallenges: 0, closedLinks: 0, revokedSessions: 1 },
      });
      expect(await cli).toEqual({
        ok: { closedChallenges: 0, closedLinks: 0, revokedSessions: 1 },
      });
      expect((await staffRow(seeded.staffId)).passwordHash).toBe(cliHash);
      expect((await sessionState(await sessionIdFor(current))).revokedAt).not.toBeNull();
      expect((await sessionState(await sessionIdFor(other))).revokedBy).toBe(seeded.staffId);
    });

    it('lets the second of two self-changes find its session revoked by the first', async () => {
      const seeded = await seedStaff(tmp.db);
      const first = await session(seeded);
      const second = await session(seeded);
      const firstHash = await newHash('from the first device');
      const secondHash = await newHash('from the second device');
      let late: Promise<Settled> | undefined;

      const early = await settle(
        change(first, seeded, firstHash, async () => {
          late = settle(change(second, seeded, secondHash));
          await waitForLockWaiter();
        }),
      );

      expect(early).toEqual({
        ok: { ok: true, closedChallenges: 0, closedLinks: 0, revokedSessions: 1 },
      });
      expect(await late).toEqual({ ok: undefined });
      expect((await staffRow(seeded.staffId)).passwordHash).toBe(firstHash);
      expect(await served(first)).toBe('served');
    });

    it('serialises a change from one session against revoking that session from another', async () => {
      const seeded = await seedStaff(tmp.db);
      const changing = await session(seeded);
      const revoking = await session(seeded);
      const changingId = await sessionIdFor(changing);
      const hash = await newHash();
      let revoked: Promise<Settled> | undefined;

      const changed = await settle(
        change(changing, seeded, hash, async () => {
          revoked = settle(revoke(revoking, changingId));
          await waitForLockWaiter();
        }),
      );

      expect(changed).toEqual({
        ok: { ok: true, closedChallenges: 0, closedLinks: 0, revokedSessions: 1 },
      });
      expect(await revoked).toEqual({ ok: undefined });
      expect((await staffRow(seeded.staffId)).passwordHash).toBe(hash);
      expect(await served(changing)).toBe('served');
      expect(await served(revoking)).toBeUndefined();
    });

    it('serialises the same pair when the revoke takes staff first', async () => {
      const seeded = await seedStaff(tmp.db);
      const changing = await session(seeded);
      const revoking = await session(seeded);
      const changingId = await sessionIdFor(changing);
      const hash = await newHash();
      let changed: Promise<Settled> | undefined;

      const revoked = await settle(
        revoke(revoking, changingId, async () => {
          changed = settle(change(changing, seeded, hash));
          await waitForLockWaiter();
        }),
      );

      expect(revoked).toEqual({ ok: { staffId: seeded.staffId } });
      expect(await changed).toEqual({ ok: undefined });
      expect((await staffRow(seeded.staffId)).passwordHash).toBe(seeded.passwordHash);
      expect(await served(changing)).toBeUndefined();
      expect(await served(revoking)).toBe('served');
    });
  });
});
