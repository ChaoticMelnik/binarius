import { randomBytes, randomInt } from 'node:crypto';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { hashToken } from './oauth-ops';
import type { DbExecutor, Tx } from './trade-intent-ops';
import { AuditAction, AuditActorType, AuditEntityType } from '@binarius/shared';
import { auditLog } from './schema/audit-log';
import { sqlLiteralList } from './schema/columns';
import { staff, StaffStatus } from './schema/staff';
import {
  OPEN_CHALLENGE_STATUSES,
  staffLoginChallenges,
  StaffLoginChallengeStatus,
} from './schema/staff-login-challenges';
import { staffSessions } from './schema/staff-sessions';

// --- Policy ------------------------------------------------------------------------------------
// Durations of the domain, not timeouts of an operation: apps/backend/src/timing.ts holds the
// bounds on calls, these hold how long a thing stays valid.

/** How long a staff member has to press the Telegram button and type the code back. */
const STAFF_LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;
/** Absolute lifetime of a session, regardless of activity (owner's decision, 2026-09-29). */
const STAFF_SESSION_TTL_MS = 24 * 60 * 60_000;
/** A session dies this long after its last admin request. */
export const STAFF_SESSION_IDLE_MS = 60 * 60_000;
export const STAFF_MAX_PASSWORD_ATTEMPTS = 5;
const STAFF_LOCKOUT_MS = 15 * 60_000;
export const STAFF_MAX_CODE_ATTEMPTS = 5;

// 32 bytes as base64url is the cookie's whole content and the only thing standing between a
// browser and the admin pages
const SESSION_TOKEN_BYTES = 32;
const CODE_CEILING = 1_000_000;
const CODE_DIGITS = 6;
// closed challenges older than this are swept by the next login, as oauth_states are
const CHALLENGE_RETENTION = sql`interval '1 hour'`;
const CLEANUP_BATCH = 100;

const OPEN_STATUS_LIST = sql`(${sqlLiteralList(OPEN_CHALLENGE_STATUSES)})`;

const afterMs = (ms: number): SQL => sql`now() + (${ms}::int * interval '1 millisecond')`;

/** `locked_until` while a lockout is running, by the database's clock; NULL once it expired. */
const runningLockout = () =>
  sql<Date | null>`case when ${staff.lockedUntil} > now() then ${staff.lockedUntil} end`.mapWith(
    staff.lockedUntil,
  );

/** The running lockout of one account, read inside the caller's transaction. */
async function readRunningLockout(executor: DbExecutor, staffId: string): Promise<Date | null> {
  const [row] = await executor
    .select({ lockedUntil: runningLockout() })
    .from(staff)
    .where(eq(staff.id, staffId));
  return row?.lockedUntil ?? null;
}

/**
 * A session that still answers: not revoked, inside its absolute lifetime, and used recently
 * enough. One fragment, because the list of sessions and the touch that keeps one alive have
 * to agree on what "live" means — a list that showed a session the next request would refuse
 * is a revoke button that lies.
 */
const liveStaffSession = (idleMs: number): SQL =>
  sql`${staffSessions.revokedAt} is null
      and ${staffSessions.expiresAt} > now()
      and ${staffSessions.lastSeenAt} > now() - (${idleMs}::int * interval '1 millisecond')`;

// --- Audit ---------------------------------------------------------------------------------

export interface AuditEntry {
  action: AuditAction;
  actorType: AuditActorType;
  /** the staff member the event is about, when one is known; NULL before that */
  actorId?: string | null;
  entityType?: AuditEntityType;
  entityId?: string;
  /** Only named keys. Never an error object, a password, a code or a token. */
  payload?: Record<string, unknown>;
}

async function writeAuditEntry(executor: DbExecutor, entry: AuditEntry): Promise<void> {
  await executor.insert(auditLog).values({
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    payload: entry.payload ?? {},
  });
}

const staffEvent = (
  action: AuditAction,
  staffId: string | null,
  payload: Record<string, unknown>,
): AuditEntry => ({
  action,
  actorType: AuditActorType.System,
  actorId: staffId,
  ...(staffId === null ? {} : { entityType: AuditEntityType.Staff, entityId: staffId }),
  payload,
});

const challengeEvent = (
  action: AuditAction,
  staffId: string,
  challengeId: string,
  payload: Record<string, unknown>,
): AuditEntry => ({
  action,
  actorType: AuditActorType.System,
  actorId: staffId,
  entityType: AuditEntityType.StaffLoginChallenge,
  entityId: challengeId,
  payload,
});

// --- Step 1: the password --------------------------------------------------------------------

export interface StaffLoginRow {
  id: string;
  login: string;
  passwordHash: string;
  status: StaffStatus;
  telegramUserId: bigint;
  /**
   * The lockout deadline if one is running, by the database's clock — not the raw column. Every
   * other deadline in this feature is evaluated by the database, and a process comparing
   * `locked_until` against its own `Date.now()` would disagree with the CAS in
   * startLoginChallenge under clock skew. An expired lockout reads as `null`, which is exactly
   * what the caller means by "not locked".
   */
  lockedUntil: Date | null;
}

/** Case-insensitive, matching staff_login_lower_idx; disabled accounts are returned too, so
 * the caller can spend the same KDF on them as on a live one. */
export async function findStaffForLogin(
  db: Db,
  login: string,
): Promise<StaffLoginRow | undefined> {
  const [row] = await db
    .select({
      id: staff.id,
      login: staff.login,
      passwordHash: staff.passwordHash,
      status: staff.status,
      telegramUserId: staff.telegramUserId,
      // mapWith is not decoration: `sql<T>` is a type assertion, and without the column's own
      // driver mapping this comes back as the raw `2026-09-29 19:08:40.817068+00` string
      lockedUntil: sql<Date | null>`case when ${staff.lockedUntil} > now() then ${staff.lockedUntil} end`.mapWith(
        staff.lockedUntil,
      ),
    })
    .from(staff)
    .where(sql`lower(${staff.login}) = lower(${login})`);
  return row;
}

export interface PasswordFailure {
  attempts: number;
  locked: boolean;
  /** the row the KDF ran against is no longer there: nothing was counted */
  stateChanged?: true;
  /** with `stateChanged`: the running lockout that is why, or `null` when the row changed */
  lockedUntil?: Date | null;
}

/**
 * One UPDATE, so two wrong passwords racing cannot both read 4 and both write 5. A failure
 * arriving after a lockout has expired restarts the count at 1 rather than continuing from
 * the count that produced the lockout.
 *
 * The same CAS the success path takes, for the same reason: ~250 ms passed inside the KDF, and
 * a reset, a disable or a lockout in that window has to win. Zero rows means the credentials
 * this attempt was judged against are gone — there is nothing left to count against, so the
 * counter and the lockout are left alone; `lockedUntil` says whether a running lockout is why.
 *
 * One counter for both places a password is typed: the login form and the change form (#78),
 * so a stolen session cookie is no faster an oracle for the password than the login page.
 */
export async function countPasswordFailure(
  tx: Tx,
  { staffId, passwordHash }: { staffId: string; passwordHash: string },
): Promise<PasswordFailure> {
  const attempts = sql`case
      when ${staff.lockedUntil} is not null and ${staff.lockedUntil} <= now() then 1
      else ${staff.failedPasswordAttempts} + 1
    end`;
  const [row] = await tx
    .update(staff)
    .set({
      failedPasswordAttempts: attempts,
      lockedUntil: sql`case
          when (${attempts}) >= ${STAFF_MAX_PASSWORD_ATTEMPTS} then ${afterMs(STAFF_LOCKOUT_MS)}
          else null
        end`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(staff.id, staffId),
        eq(staff.passwordHash, passwordHash),
        eq(staff.status, StaffStatus.Active),
        sql`(${staff.lockedUntil} is null or ${staff.lockedUntil} <= now())`,
      ),
    )
    .returning({
      attempts: staff.failedPasswordAttempts,
      lockedUntil: staff.lockedUntil,
    });
  if (row === undefined) {
    return {
      attempts: 0,
      locked: false,
      stateChanged: true,
      lockedUntil: await readRunningLockout(tx, staffId),
    };
  }
  return { attempts: row.attempts, locked: row.lockedUntil !== null };
}

export async function registerPasswordFailure(
  db: Db,
  { staffId, passwordHash, ip }: { staffId: string; passwordHash: string; ip: string },
): Promise<PasswordFailure> {
  return db.transaction(async (tx) => {
    const failure = await countPasswordFailure(tx, { staffId, passwordHash });
    await writeAuditEntry(
      tx,
      staffEvent(
        AuditAction.StaffLoginFailed,
        staffId,
        failure.stateChanged === true
          ? { reason: 'state_changed', ip }
          : { reason: 'wrong_password', attempts: failure.attempts, locked: failure.locked, ip },
      ),
    );
    return failure;
  });
}

/** Why a login was refused before the password was even worth checking. */
export type LoginRefusalReason = 'unknown_login' | 'disabled';

/**
 * A login attempt that ended before a challenge existed. `staffId` is NULL for a login nobody
 * holds — the entered login is deliberately not recorded, because an entry keyed on it would
 * be a log of near-misses against real accounts.
 */
export async function recordLoginRefusal(
  db: Db,
  input: { staffId: string | null; reason: LoginRefusalReason; ip: string },
): Promise<void> {
  await writeAuditEntry(
    db,
    staffEvent(AuditAction.StaffLoginFailed, input.staffId, {
      reason: input.reason,
      ip: input.ip,
    }),
  );
}

/**
 * A locked account, refused without spending a KDF on it. The lockout the caller's lookup saw is
 * read again in the transaction that records it, so the row carries that reading: `null` means it
 * ended in between, nothing was written, and the caller goes on as if there had been none.
 */
export async function recordLoginLockout(
  db: Db,
  input: { staffId: string; ip: string },
): Promise<Date | null> {
  return db.transaction(async (tx) => {
    const lockedUntil = await readRunningLockout(tx, input.staffId);
    if (lockedUntil === null) return null;
    await writeAuditEntry(
      tx,
      staffEvent(AuditAction.StaffLoginLocked, input.staffId, {
        ip: input.ip,
        lockedUntil: lockedUntil.toISOString(),
      }),
    );
    return lockedUntil;
  });
}

export type StartLoginChallengeResult =
  | {
      ok: true;
      challengeId: string;
      expiresAt: Date;
      reused: boolean;
      /** the invitation still has to be delivered to Telegram */
      sendPrompt: boolean;
    }
  | { ok: false; reason: 'state_changed' };

/**
 * The password was right when the KDF ran. That was ~250 ms ago, and in that window the
 * password could have been reset, the account disabled, or a lockout started — so the row is
 * locked and the same three facts are re-checked as a CAS inside the transaction that creates
 * the challenge. Zero rows means the account is no longer the one that was verified.
 *
 * Holding the `staff` row also serialises concurrent logins for one person, which is what
 * makes "reuse the open challenge" a decision rather than a race against
 * staff_login_challenges_open_idx.
 */
export async function startLoginChallenge(
  db: Db,
  input: {
    staffId: string;
    /** the hash verifyPassword was run against */
    passwordHash: string;
    ip: string;
    userAgent: string;
    ttlMs?: number;
  },
): Promise<StartLoginChallengeResult> {
  const ttlMs = input.ttlMs ?? STAFF_LOGIN_CHALLENGE_TTL_MS;
  return db.transaction(async (tx) => {
    await tx
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.id, input.staffId))
      .for('no key update');

    const [claimed] = await tx
      .update(staff)
      .set({ failedPasswordAttempts: 0, lockedUntil: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(staff.id, input.staffId),
          eq(staff.passwordHash, input.passwordHash),
          eq(staff.status, StaffStatus.Active),
          sql`(${staff.lockedUntil} is null or ${staff.lockedUntil} <= now())`,
        ),
      )
      .returning({ id: staff.id });
    if (claimed === undefined) {
      await writeAuditEntry(
        tx,
        staffEvent(AuditAction.StaffLoginFailed, input.staffId, {
          reason: 'state_changed',
          ip: input.ip,
        }),
      );
      return { ok: false, reason: 'state_changed' };
    }

    // by the database's clock, never the process's
    await tx
      .update(staffLoginChallenges)
      .set({ status: StaffLoginChallengeStatus.Expired })
      .where(
        and(
          eq(staffLoginChallenges.staffId, input.staffId),
          inArray(staffLoginChallenges.status, [...OPEN_CHALLENGE_STATUSES]),
          sql`${staffLoginChallenges.expiresAt} <= now()`,
        ),
      );

    // opportunistic sweep, like createOAuthState: SKIP LOCKED keeps concurrent logins from
    // queueing behind each other on the same batch
    await tx.execute(sql`
      delete from ${staffLoginChallenges} where id in (
        select id from ${staffLoginChallenges}
          where ${staffLoginChallenges.status} not in ${OPEN_STATUS_LIST}
            and ${staffLoginChallenges.createdAt} < now() - ${CHALLENGE_RETENTION}
          order by ${staffLoginChallenges.createdAt}
          limit ${CLEANUP_BATCH}
          for update skip locked
      )
    `);

    const [open] = await tx
      .select({
        id: staffLoginChallenges.id,
        expiresAt: staffLoginChallenges.expiresAt,
        promptSentAt: staffLoginChallenges.promptSentAt,
        status: staffLoginChallenges.status,
      })
      .from(staffLoginChallenges)
      .where(
        and(
          eq(staffLoginChallenges.staffId, input.staffId),
          inArray(staffLoginChallenges.status, [...OPEN_CHALLENGE_STATUSES]),
        ),
      );
    if (open !== undefined) {
      // prompt_sent_at is NULL for three reasons: the invitation never left; the process died
      // between sendMessage and markChallengePromptSent (the button may already have been
      // pressed, and re-inviting someone who is holding the code is noise — worse, it would be
      // a send whose failure closes a challenge that has moved on); or another login for the
      // same person is inside its own send right now — the `staff` lock is released at commit
      // and the send runs after it (apps/backend deliverPrompt), so two logins one round-trip
      // apart both see NULL and both send. The third is accepted (docs/staff-login.md → Limits).
      const resent =
        open.promptSentAt === null && open.status === StaffLoginChallengeStatus.Pending;
      await writeAuditEntry(
        tx,
        challengeEvent(AuditAction.StaffLoginPasswordOk, input.staffId, open.id, {
          reused: true,
          resent,
          ip: input.ip,
        }),
      );
      return {
        ok: true,
        challengeId: open.id,
        expiresAt: open.expiresAt,
        reused: true,
        sendPrompt: resent,
      };
    }

    const [created] = await tx
      .insert(staffLoginChallenges)
      .values({
        staffId: input.staffId,
        ip: input.ip,
        userAgent: input.userAgent,
        expiresAt: afterMs(ttlMs),
      })
      .returning({ id: staffLoginChallenges.id, expiresAt: staffLoginChallenges.expiresAt });
    if (created === undefined) throw new Error('staff_login_challenges insert returned no row');
    await writeAuditEntry(
      tx,
      challengeEvent(AuditAction.StaffLoginPasswordOk, input.staffId, created.id, {
        reused: false,
        resent: false,
        ip: input.ip,
      }),
    );
    return {
      ok: true,
      challengeId: created.id,
      expiresAt: created.expiresAt,
      reused: false,
      sendPrompt: true,
    };
  });
}

/** Records that Telegram accepted the invitation, so the next login does not send it again. */
export async function markChallengePromptSent(db: Db, challengeId: string): Promise<void> {
  await db
    .update(staffLoginChallenges)
    .set({ promptSentAt: sql`now()` })
    .where(
      and(
        eq(staffLoginChallenges.id, challengeId),
        sql`${staffLoginChallenges.promptSentAt} is null`,
      ),
    );
}

interface DeliveryFailureFacts {
  challengeId: string;
  staffId: string;
  /** already reduced to identity by the caller; a raw error must never reach the payload */
  err: Record<string, unknown>;
  telegram: Record<string, unknown>;
}

/**
 * A `confirmed` challenge has to say *which* code failed: a second press can issue a new one
 * between this send's CAS and its failure, and that one may well have arrived. An invitation
 * has no identity — one challenge has one invitation — so `pending` carries none. The shape is
 * a union rather than an optional field so the code cannot be left out where it decides.
 */
type DeliveryFailure =
  | (DeliveryFailureFacts & {
      from: typeof StaffLoginChallengeStatus.Pending;
      reason: 'polling_down' | 'prompt_send_failed';
    })
  | (DeliveryFailureFacts & {
      from: typeof StaffLoginChallengeStatus.Confirmed;
      reason: 'code_send_failed';
      code: string;
    });

/**
 * Telegram would not take the message, so nothing can arrive and the staff member should not
 * wait out the window. Closing the challenge is what lets them start again immediately.
 */
export async function failChallengeDelivery(db: Db, input: DeliveryFailure): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [closed] = await tx
      .update(staffLoginChallenges)
      .set({ status: StaffLoginChallengeStatus.Failed })
      .where(
        and(
          eq(staffLoginChallenges.id, input.challengeId),
          eq(staffLoginChallenges.status, input.from),
          input.from === StaffLoginChallengeStatus.Confirmed
            ? eq(staffLoginChallenges.codeHash, hashToken(input.code))
            : undefined,
        ),
      )
      .returning({ id: staffLoginChallenges.id });
    // Zero rows is not nothing happening: the send really did fail, and the challenge moved on
    // under us — the button was pressed while the message was in flight, or the code that did
    // not arrive has already been replaced by a later press whose code did. The row says which
    // of the two it was, so the caller can answer for the challenge that exists rather than the
    // one it tried to close.
    await writeAuditEntry(
      tx,
      challengeEvent(AuditAction.StaffLoginTelegramFailed, input.staffId, input.challengeId, {
        reason: input.reason,
        err: input.err,
        telegram: input.telegram,
        closed: closed !== undefined,
      }),
    );
    return closed !== undefined;
  });
}

// --- The Telegram side -------------------------------------------------------------------------

/** Six digits with their leading zeros; the string is what is hashed and what is sent. */
const generateLoginCode = (): string =>
  String(randomInt(CODE_CEILING)).padStart(CODE_DIGITS, '0');

export interface ConfirmedChallenge {
  staffId: string;
  code: string;
  /** the button was pressed again before the first code was delivered */
  repeat: boolean;
}

/**
 * The button press. Authenticity is decided here and nowhere else: the CAS joins `staff` on
 * the Telegram account the update came from, so a callback replayed from another account
 * matches no row. `code_sent_at IS NULL` is what makes a second press before delivery issue a
 * fresh code and a press after delivery do nothing.
 *
 * `old.status` in RETURNING needs PostgreSQL 18, which compose.yaml and ci.yml both pin. The
 * unqualified form would read the value the same statement just wrote, so `repeat` would be
 * true on the first press as well as the second, and the entry would say the staff member
 * pressed twice every time.
 */
export async function confirmChallengeFromTelegram(
  db: Db,
  input: { challengeId: string; telegramUserId: bigint },
): Promise<ConfirmedChallenge | undefined> {
  const code = generateLoginCode();
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ staff_id: string; repeat: boolean }>(sql`
      update ${staffLoginChallenges} as c
         set status = ${StaffLoginChallengeStatus.Confirmed},
             code_hash = ${hashToken(code)},
             confirmed_at = coalesce(c.confirmed_at, now())
        from ${staff} as s
       where c.id = ${input.challengeId}
         and c.staff_id = s.id
         and s.telegram_user_id = ${input.telegramUserId}
         and s.status = ${StaffStatus.Active}
         and c.status in ${OPEN_STATUS_LIST}
         and c.code_sent_at is null
         and c.expires_at > now()
      returning c.staff_id, (old.status = ${StaffLoginChallengeStatus.Confirmed}) as repeat
    `);
    const row = rows[0];
    if (row === undefined) return undefined;
    await writeAuditEntry(
      tx,
      challengeEvent(
        AuditAction.StaffLoginTelegramConfirmed,
        row.staff_id,
        input.challengeId,
        { repeat: row.repeat },
      ),
    );
    return { staffId: row.staff_id, code, repeat: row.repeat };
  });
}

/**
 * Records that the code reached Telegram; after this a further button press does nothing. Only
 * for the code that actually arrived: a later press can replace it while this send is in
 * flight, and marking then would close the window on a code nobody was given.
 */
export async function markChallengeCodeSent(
  db: Db,
  challengeId: string,
  code: string,
): Promise<void> {
  await db
    .update(staffLoginChallenges)
    .set({ codeSentAt: sql`now()` })
    .where(
      and(
        eq(staffLoginChallenges.id, challengeId),
        sql`${staffLoginChallenges.codeSentAt} is null`,
        eq(staffLoginChallenges.codeHash, hashToken(code)),
      ),
    );
}

/** "Это не я": the same ownership CAS, and an entry that says someone else had the password. */
export async function denyChallengeFromTelegram(
  db: Db,
  input: { challengeId: string; telegramUserId: bigint },
): Promise<{ staffId: string; ip: string } | undefined> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ staff_id: string; ip: string }>(sql`
      update ${staffLoginChallenges} as c
         set status = ${StaffLoginChallengeStatus.Denied}
        from ${staff} as s
       where c.id = ${input.challengeId}
         and c.staff_id = s.id
         and s.telegram_user_id = ${input.telegramUserId}
         and s.status = ${StaffStatus.Active}
         and c.status in ${OPEN_STATUS_LIST}
         and c.expires_at > now()
      returning c.staff_id, c.ip
    `);
    const row = rows[0];
    if (row === undefined) return undefined;
    await writeAuditEntry(
      tx,
      challengeEvent(AuditAction.StaffLoginDenied, row.staff_id, input.challengeId, {
        ip: row.ip,
      }),
    );
    return { staffId: row.staff_id, ip: row.ip };
  });
}

// --- Step 2: the code ----------------------------------------------------------------------

/** Why a code did not produce a session. The statuses are carried through as they are, so
 * the entry says `denied` or `exhausted` rather than one flattened refusal. */
export type CodeRefusalReason =
  | 'wrong_code'
  | 'awaiting_telegram'
  | 'expired'
  | 'disabled'
  | 'unknown'
  | StaffLoginChallengeStatus;

export type CompleteLoginResult =
  | { ok: true; sessionToken: string; expiresAt: Date; staffId: string }
  | { ok: false; reason: CodeRefusalReason; exhausted?: boolean };

/**
 * One CAS decides everything: the attempt is counted, the code is compared, and the status
 * moves to `completed` or `exhausted` in the same statement — so two requests carrying the
 * right code produce one session and one 410, never two sessions.
 *
 * The code is compared in SQL rather than with timingSafeEqual. Five attempts per challenge
 * and a five-minute window make a timing channel on a sha256 of a random six-digit code worth
 * nothing; the password, which is long-lived, is compared in constant time.
 */
export async function completeLogin(
  db: Db,
  input: {
    challengeId: string;
    code: string;
    ip: string;
    userAgent: string;
    sessionTtlMs?: number;
  },
): Promise<CompleteLoginResult> {
  const ttlMs = input.sessionTtlMs ?? STAFF_SESSION_TTL_MS;
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ status: string; staff_id: string; code_attempts: number }>(
      sql`
        update ${staffLoginChallenges} as c
           set code_attempts = c.code_attempts + 1,
               status = case
                 when c.code_hash = ${hashToken(input.code)} then ${StaffLoginChallengeStatus.Completed}
                 when c.code_attempts + 1 >= ${STAFF_MAX_CODE_ATTEMPTS} then ${StaffLoginChallengeStatus.Exhausted}
                 else c.status
               end
          from ${staff} as s
         where c.id = ${input.challengeId}
           and c.staff_id = s.id
           and s.status = ${StaffStatus.Active}
           and c.status = ${StaffLoginChallengeStatus.Confirmed}
           and c.code_sent_at is not null
           and c.expires_at > now()
        returning c.status, c.staff_id, c.code_attempts
      `,
    );
    const row = rows[0];
    if (row === undefined) return refuseCode(tx, input.challengeId, input.ip);

    if (row.status !== StaffLoginChallengeStatus.Completed) {
      const exhausted = row.status === StaffLoginChallengeStatus.Exhausted;
      await writeAuditEntry(
        tx,
        challengeEvent(AuditAction.StaffLoginCodeFailed, row.staff_id, input.challengeId, {
          reason: 'wrong_code',
          attempts: row.code_attempts,
          exhausted,
          ip: input.ip,
        }),
      );
      return { ok: false, reason: 'wrong_code', exhausted };
    }

    const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const [session] = await tx
      .insert(staffSessions)
      .values({
        staffId: row.staff_id,
        tokenHash: hashToken(sessionToken),
        ip: input.ip,
        userAgent: input.userAgent,
        expiresAt: afterMs(ttlMs),
      })
      .returning({ id: staffSessions.id, expiresAt: staffSessions.expiresAt });
    if (session === undefined) throw new Error('staff_sessions insert returned no row');
    await writeAuditEntry(tx, {
      action: AuditAction.StaffLoginCompleted,
      actorType: AuditActorType.Admin,
      actorId: row.staff_id,
      entityType: AuditEntityType.StaffSession,
      entityId: session.id,
      payload: { challengeId: input.challengeId, ip: input.ip },
    });
    return {
      ok: true,
      sessionToken,
      expiresAt: session.expiresAt,
      staffId: row.staff_id,
    };
  });
}

// Zero rows from the CAS: the reason is read back so the caller can answer 409 (wait for
// Telegram) apart from 410 (this attempt is over), and so the entry says which it was.
async function refuseCode(tx: Tx, challengeId: string, ip: string): Promise<CompleteLoginResult> {
  const [row] = await tx
    .select({
      status: staffLoginChallenges.status,
      staffId: staffLoginChallenges.staffId,
      expired: sql<boolean>`${staffLoginChallenges.expiresAt} <= now()`,
      staffStatus: staff.status,
    })
    .from(staffLoginChallenges)
    .innerJoin(staff, eq(staff.id, staffLoginChallenges.staffId))
    .where(eq(staffLoginChallenges.id, challengeId));

  if (row === undefined) {
    await writeAuditEntry(tx, {
      action: AuditAction.StaffLoginCodeFailed,
      actorType: AuditActorType.System,
      actorId: null,
      payload: { reason: 'unknown', ip },
    });
    return { ok: false, reason: 'unknown' };
  }

  const reason = refusalReason(row);
  await writeAuditEntry(
    tx,
    challengeEvent(AuditAction.StaffLoginCodeFailed, row.staffId, challengeId, { reason, ip }),
  );
  return { ok: false, reason };
}

// The order matters: a disabled owner is why the CAS missed even when the challenge itself
// still looks usable, and an expired window outranks the status the row is still carrying.
function refusalReason(row: {
  status: StaffLoginChallengeStatus;
  expired: boolean;
  staffStatus: StaffStatus;
}): CodeRefusalReason {
  if (row.staffStatus !== StaffStatus.Active) return 'disabled';
  if (row.expired) return 'expired';
  // `confirmed` does not ask whether the code was sent. A confirmed challenge with the code
  // already sent cannot miss the CAS on the same snapshot; if the re-read sees one,
  // markChallengeCodeSent committed between the two statements (READ COMMITTED gives each its
  // own snapshot), and the truthful answer is still "wait": the code is live and this
  // submission came first.
  if (
    row.status === StaffLoginChallengeStatus.Pending ||
    row.status === StaffLoginChallengeStatus.Confirmed
  ) {
    return 'awaiting_telegram';
  }
  return row.status;
}

// --- Sessions ----------------------------------------------------------------------------------

export interface StaffContext {
  sessionId: string;
  staffId: string;
  login: string;
}

export interface StaffAuditDescription {
  action: AuditAction;
  entity?: { type: AuditEntityType; id: string };
  payload: Record<string, unknown>;
}

export interface StaffActionResult<T> {
  result: T;
  /** what to record; no row means no data, because the INSERT and the work share a transaction */
  audit: StaffAuditDescription;
}

/**
 * Every authenticated admin request, in one transaction: touch the session (which is also the
 * check that it is still live — no cache, so a revoke is visible to the very next request),
 * run the work, then record it. The entry is written from what the work returned, so the
 * recorded event is the one that happened; if the INSERT fails, the touch and the work roll
 * back together and nothing is answered.
 *
 * `lockStaff` is for every transaction that touches more than its own session row or writes
 * `staff` (the password change, revoke): it takes the owner's `staff` row `FOR NO KEY UPDATE`
 * before the touch, so the order is `staff → sessions` like the CLI's and two such writers of
 * one staff member queue on that row instead of deadlocking on two session rows. Without it
 * the touch is the first statement. It does not order two sessions of different staff members
 * (#151).
 */
export async function runAsStaff<T>(
  db: Db,
  options: { token: string; idleMs?: number; lockStaff?: boolean },
  fn: (tx: Tx, ctx: StaffContext) => Promise<StaffActionResult<T>>,
): Promise<T | undefined> {
  const idleMs = options.idleMs ?? STAFF_SESSION_IDLE_MS;
  const tokenHash = hashToken(options.token);
  return db.transaction(async (tx) => {
    if (options.lockStaff === true) {
      const [owner] = await tx
        .select({ staffId: staffSessions.staffId })
        .from(staffSessions)
        .where(eq(staffSessions.tokenHash, tokenHash));
      if (owner === undefined) return undefined;
      await tx
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.id, owner.staffId))
        .for('no key update');
    }
    // the target table is not aliased: liveStaffSession names its columns through the schema,
    // which renders them qualified by the real table name
    const { rows } = await tx.execute<{ id: string; staff_id: string; login: string }>(sql`
      update ${staffSessions}
         set last_seen_at = now()
        from ${staff} as st
       where ${staffSessions.tokenHash} = ${tokenHash}
         and st.id = ${staffSessions.staffId}
         and st.status = ${StaffStatus.Active}
         and ${liveStaffSession(idleMs)}
      returning ${staffSessions.id}, ${staffSessions.staffId}, st.login
    `);
    const session = rows[0];
    if (session === undefined) return undefined;
    const ctx: StaffContext = {
      sessionId: session.id,
      staffId: session.staff_id,
      login: session.login,
    };
    const { result, audit } = await fn(tx, ctx);
    await writeAuditEntry(tx, {
      action: audit.action,
      actorType: AuditActorType.Admin,
      actorId: ctx.staffId,
      ...(audit.entity === undefined
        ? {}
        : { entityType: audit.entity.type, entityId: audit.entity.id }),
      payload: audit.payload,
    });
    return result;
  });
}

export interface StaffSessionRow {
  id: string;
  login: string;
  displayName: string | null;
  ip: string;
  userAgent: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

/** Every live session of every staff member: this feature has no roles, so everyone sees all. */
export async function listLiveStaffSessions(
  tx: Tx,
  idleMs: number = STAFF_SESSION_IDLE_MS,
): Promise<StaffSessionRow[]> {
  return tx
    .select({
      id: staffSessions.id,
      login: staff.login,
      displayName: staff.displayName,
      ip: staffSessions.ip,
      userAgent: staffSessions.userAgent,
      createdAt: staffSessions.createdAt,
      lastSeenAt: staffSessions.lastSeenAt,
      expiresAt: staffSessions.expiresAt,
    })
    .from(staffSessions)
    .innerJoin(staff, eq(staff.id, staffSessions.staffId))
    .where(liveStaffSession(idleMs))
    .orderBy(staffSessions.createdAt);
}

export interface RevokedSession {
  staffId: string;
}

/**
 * A live session, whoever owns it. A session that never existed, one already revoked and one
 * belonging to nobody are the same answer on purpose: the caller learns nothing about ids it
 * did not already hold.
 */
export async function revokeStaffSession(
  tx: Tx,
  input: { sessionId: string; byStaffId: string; idleMs?: number },
): Promise<RevokedSession | undefined> {
  const [row] = await tx
    .update(staffSessions)
    .set({ revokedAt: sql`now()`, revokedByStaffId: input.byStaffId })
    .where(
      and(
        eq(staffSessions.id, input.sessionId),
        liveStaffSession(input.idleMs ?? STAFF_SESSION_IDLE_MS),
      ),
    )
    .returning({ staffId: staffSessions.staffId });
  return row;
}

/** The staff member's own session, ended by them; unlike revoke, it cannot miss. */
export async function endStaffSession(
  tx: Tx,
  sessionId: string,
  byStaffId: string,
): Promise<void> {
  await tx
    .update(staffSessions)
    .set({ revokedAt: sql`now()`, revokedByStaffId: byStaffId })
    .where(and(eq(staffSessions.id, sessionId), sql`${staffSessions.revokedAt} is null`));
}

export interface StaffPasswordChangeRow {
  staffId: string;
  sessionId: string;
  passwordHash: string;
  /** a running lockout by the database's clock, as in StaffLoginRow; `null` when none */
  lockedUntil: Date | null;
}

/**
 * The hash the change form's KDF needs, read by the caller's live session. Outside runAsStaff
 * and without an audit row on purpose, like findStaffForLogin: the KDF runs between this read
 * and the transaction, and holding the staff and session rows through ~500 ms of scrypt is what
 * the login flow already refuses to do (#68). The transaction re-checks everything by CAS.
 */
export async function findStaffForPasswordChange(
  db: Db,
  { token, idleMs = STAFF_SESSION_IDLE_MS }: { token: string; idleMs?: number },
): Promise<StaffPasswordChangeRow | undefined> {
  const [row] = await db
    .select({
      staffId: staff.id,
      sessionId: staffSessions.id,
      passwordHash: staff.passwordHash,
      lockedUntil: runningLockout(),
    })
    .from(staffSessions)
    .innerJoin(staff, eq(staff.id, staffSessions.staffId))
    .where(
      and(
        eq(staffSessions.tokenHash, hashToken(token)),
        eq(staff.status, StaffStatus.Active),
        liveStaffSession(idleMs),
      ),
    );
  return row;
}

/**
 * The change form's refusal under a running lockout (#78), the same shape as recordLoginLockout:
 * re-read in the recording transaction, `null` when it ended in between. Outside runAsStaff on
 * purpose — a refusal before any work, so a locked staff member hammering the form does not
 * extend the session's idle window; the session id is the pre-read's.
 */
export async function recordPasswordChangeLockout(
  db: Db,
  input: { staffId: string; sessionId: string; ip: string },
): Promise<Date | null> {
  return db.transaction(async (tx) => {
    const lockedUntil = await readRunningLockout(tx, input.staffId);
    if (lockedUntil === null) return null;
    await writeAuditEntry(tx, {
      action: AuditAction.StaffPasswordChangeFailed,
      actorType: AuditActorType.Admin,
      actorId: input.staffId,
      entityType: AuditEntityType.Staff,
      entityId: input.staffId,
      payload: {
        reason: 'locked',
        lockedUntil: lockedUntil.toISOString(),
        ip: input.ip,
        sessionId: input.sessionId,
      },
    });
    return lockedUntil;
  });
}

// --- CLI operations ----------------------------------------------------------------------------

export interface CreatedStaff {
  id: string;
  login: string;
}

export async function createStaffAccount(
  db: Db,
  input: {
    login: string;
    passwordHash: string;
    telegramUserId: bigint;
    displayName?: string | undefined;
  },
): Promise<CreatedStaff> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(staff)
      .values({
        login: input.login,
        passwordHash: input.passwordHash,
        telegramUserId: input.telegramUserId,
        displayName: input.displayName ?? null,
      })
      .returning({ id: staff.id, login: staff.login });
    if (row === undefined) throw new Error('staff insert returned no row');
    await writeAuditEntry(tx, {
      action: AuditAction.StaffCreated,
      actorType: AuditActorType.System,
      actorId: row.id,
      entityType: AuditEntityType.Staff,
      entityId: row.id,
      payload: { via: 'cli' },
    });
    return row;
  });
}

export interface StaffInvalidation {
  closedChallenges: number;
  revokedSessions: number;
}

// staff → staff_login_challenges → staff_sessions, the lock order these three tables are
// written in everywhere. Changing the credentials or the status has to invalidate everything
// issued under the old ones in the same transaction, or a challenge created a moment earlier
// would still walk through to a session.
//
// That order is about the locks a statement takes on purpose. FK KEY SHARE locks on `staff` are
// taken after a session or challenge lock by design — `endStaffSession` and `revokeStaffSession`
// write `revoked_by_staff_id` under a session lock, `completeLogin` inserts a session under a
// challenge lock — and that is safe only while no writer takes `FOR UPDATE` on `staff`: KEY SHARE
// conflicts with that mode and with nothing else any writer here uses. Take `FOR NO KEY UPDATE`,
// as `startLoginChallenge` does.
//
// Those locks serialize a concurrent `completeLogin` against this tail, but they do not keep its
// session out of it: the login holds its own challenge row until it commits, so either this
// transaction closes the challenge first and the login, once it stops waiting, finds it closed
// under it, or this one waits there and afterwards sees the session already committed. A session
// committed by a transaction that began after this one is therefore ordinary here, and that is
// what the revocation timestamp below has to survive (#149).
//
// A writer under a staff session (applyStaffPasswordChange) reaches this through
// runAsStaff({ lockStaff: true }): `staff` first, then its own session (the touch), then the
// challenges and the other sessions — not a cycle with the CLI, because both chains start at
// `staff`.
async function invalidateIssued(
  tx: Tx,
  staffId: string,
  opts: { keepSessionId?: string; revokedByStaffId?: string } = {},
): Promise<StaffInvalidation> {
  const closed = await tx
    .update(staffLoginChallenges)
    .set({ status: StaffLoginChallengeStatus.Expired })
    .where(
      and(
        eq(staffLoginChallenges.staffId, staffId),
        inArray(staffLoginChallenges.status, [...OPEN_CHALLENGE_STATUSES]),
      ),
    )
    .returning({ id: staffLoginChallenges.id });
  // clock_timestamp(), not now(): now() is the transaction's start, and under READ COMMITTED this
  // UPDATE still matches a session committed by a completeLogin that began later. That row's
  // created_at is after our now(), and staff_sessions_revoked_after_created_check then aborts the
  // whole disable or reset (#149); the statement clock is read after the statement's snapshot, so
  // it is later than anything the statement can see. The predicate keeps now() on purpose: it is
  // the same reading of "live" as everywhere else, and stamping one that expired in between is
  // harmless.
  const revoked = await tx
    .update(staffSessions)
    .set({ revokedAt: sql`clock_timestamp()`, revokedByStaffId: opts.revokedByStaffId ?? null })
    .where(
      and(
        eq(staffSessions.staffId, staffId),
        sql`${staffSessions.revokedAt} is null`,
        sql`${staffSessions.expiresAt} > now()`,
        opts.keepSessionId === undefined
          ? undefined
          : sql`${staffSessions.id} <> ${opts.keepSessionId}`,
      ),
    )
    .returning({ id: staffSessions.id });
  return { closedChallenges: closed.length, revokedSessions: revoked.length };
}

export type StaffPasswordChangeResult =
  | ({ ok: true } & StaffInvalidation)
  | { ok: false; reason: 'locked'; lockedUntil: Date }
  | { ok: false; reason: 'state_changed' };

/**
 * The staff member's own password, changed under their session (#78). The same CAS as the
 * login's step 1: the hash the KDF verified against must still be the row's, the account
 * active and not locked. On zero rows the outcome is read back rather than guessed — a lockout
 * that began during the KDF answers as one. The caller's session survives; everything else
 * issued under the old password does not.
 */
export async function applyStaffPasswordChange(
  tx: Tx,
  input: { staffId: string; sessionId: string; passwordHashSeen: string; newPasswordHash: string },
): Promise<StaffPasswordChangeResult> {
  const [changed] = await tx
    .update(staff)
    .set({
      passwordHash: input.newPasswordHash,
      failedPasswordAttempts: 0,
      lockedUntil: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(staff.id, input.staffId),
        eq(staff.passwordHash, input.passwordHashSeen),
        eq(staff.status, StaffStatus.Active),
        sql`(${staff.lockedUntil} is null or ${staff.lockedUntil} <= now())`,
      ),
    )
    .returning({ id: staff.id });
  if (changed === undefined) {
    const lockedUntil = await readRunningLockout(tx, input.staffId);
    return lockedUntil === null
      ? { ok: false, reason: 'state_changed' }
      : { ok: false, reason: 'locked', lockedUntil };
  }
  const counts = await invalidateIssued(tx, input.staffId, {
    keepSessionId: input.sessionId,
    revokedByStaffId: input.staffId,
  });
  return { ok: true, ...counts };
}

export async function disableStaffAccount(
  db: Db,
  login: string,
): Promise<StaffInvalidation | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(staff)
      .set({ status: StaffStatus.Disabled, updatedAt: sql`now()` })
      .where(sql`lower(${staff.login}) = lower(${login})`)
      .returning({ id: staff.id });
    if (row === undefined) return undefined;
    const counts = await invalidateIssued(tx, row.id);
    await writeAuditEntry(tx, {
      action: AuditAction.StaffDisabled,
      actorType: AuditActorType.System,
      actorId: row.id,
      entityType: AuditEntityType.Staff,
      entityId: row.id,
      payload: { via: 'cli', ...counts },
    });
    return counts;
  });
}

export async function resetStaffPassword(
  db: Db,
  input: { login: string; passwordHash: string },
): Promise<StaffInvalidation | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(staff)
      .set({
        passwordHash: input.passwordHash,
        failedPasswordAttempts: 0,
        lockedUntil: null,
        updatedAt: sql`now()`,
      })
      .where(sql`lower(${staff.login}) = lower(${input.login})`)
      .returning({ id: staff.id });
    if (row === undefined) return undefined;
    const counts = await invalidateIssued(tx, row.id);
    await writeAuditEntry(tx, {
      action: AuditAction.StaffPasswordReset,
      actorType: AuditActorType.System,
      actorId: row.id,
      entityType: AuditEntityType.Staff,
      entityId: row.id,
      payload: { via: 'cli', ...counts },
    });
    return counts;
  });
}
