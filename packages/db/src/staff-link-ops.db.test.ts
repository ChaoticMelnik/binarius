import { createHash } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditAction, LinkState } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import { type Db } from './client';
import {
  createTempDatabase,
  lockWaiters,
  seedStaff,
  type SeededStaff,
  type TempDatabase,
  TEST_SCRYPT_PARAMS,
} from './testing';
import {
  completeLinkLogin,
  type CompleteLinkLoginResult,
  findStaffByTelegram,
  inspectLoginLink,
  issueLoginLink,
  recordStaffBotRefusal,
  STAFF_LOGIN_LINK_MAX_PER_WINDOW,
} from './staff-link-ops';
import {
  applyStaffPasswordChange,
  disableStaffAccount,
  resetStaffPassword,
  runAsStaff,
  type StaffInvalidation,
} from './staff-ops';
import { hashPassword } from './staff-password';
import { auditLog, staff, staffLoginLinks, staffSessions } from './schema/index';
import { StaffStatus } from './schema/staff';
import { StaffLoginLinkStatus } from './schema/staff-login-links';

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
const UA = 'Mozilla/5.0';
const NOBODY = 999_999_001n;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const issue = async (seeded: SeededStaff) => {
  const issued = await issueLoginLink(tmp.db, { telegramUserId: seeded.telegramUserId });
  if (!issued.ok) throw new Error(`issueLoginLink refused: ${issued.reason}`);
  return issued;
};

const complete = (token: string, db: Db = tmp.db) =>
  completeLinkLogin(db, { token, ip: IP, userAgent: UA });

const linkRow = async (id: string) => {
  const [row] = await tmp.db.select().from(staffLoginLinks).where(eq(staffLoginLinks.id, id));
  if (row === undefined) throw new Error(`no link ${id}`);
  return row;
};

const linksOf = (staffId: string) =>
  tmp.db
    .select()
    .from(staffLoginLinks)
    .where(eq(staffLoginLinks.staffId, staffId))
    .orderBy(asc(staffLoginLinks.createdAt), asc(staffLoginLinks.id));

const entriesFor = (staffId: string) =>
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

const auditCount = async () =>
  (await tmp.db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]?.n ?? 0;

const sessionsOf = (staffId: string) =>
  tmp.db
    .select({
      id: staffSessions.id,
      revokedAt: staffSessions.revokedAt,
      lifetime: sql<string>`(${staffSessions.expiresAt} - ${staffSessions.createdAt})::text`,
      revokedAfterCreated: sql<
        boolean | null
      >`${staffSessions.revokedAt} >= ${staffSessions.createdAt}`,
    })
    .from(staffSessions)
    .where(eq(staffSessions.staffId, staffId));

/** `hook` runs once, right after the transaction's first UPDATE of `table` completes. */
function afterUpdateOf(db: Db, table: unknown, hook: () => Promise<void>): Db {
  return Object.create(db, {
    transaction: {
      value: (fn: (tx: Tx) => Promise<unknown>) =>
        db.transaction(async (tx) => {
          let fired = false;
          const spied: Tx = Object.create(tx);
          spied.update = ((target: Parameters<Tx['update']>[0]) => {
            const builder = tx.update(target);
            if (target !== table || fired) return builder;
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

/** `hook` runs once, right after the transaction's first INSERT into `table` completes. */
function afterInsertInto(db: Db, table: unknown, hook: () => Promise<void>): Db {
  return Object.create(db, {
    transaction: {
      value: (fn: (tx: Tx) => Promise<unknown>) =>
        db.transaction(async (tx) => {
          let fired = false;
          const spied: Tx = Object.create(tx);
          spied.insert = ((target: Parameters<Tx['insert']>[0]) => {
            const builder = tx.insert(target);
            if (target !== table || fired) return builder;
            fired = true;
            const values = builder.values.bind(builder);
            builder.values = ((rows: never) => {
              const base = values(rows);
              const execute = base.execute;
              base.execute = async (placeholderValues) => {
                const result = await execute.call(base, placeholderValues);
                await hook();
                return result;
              };
              return base;
            }) as typeof builder.values;
            return builder;
          }) as Tx['insert'];
          return fn(spied);
        }),
    },
  }) as Db;
}

describe('findStaffByTelegram', () => {
  it('finds an active and a disabled account and nothing for a stranger', async () => {
    const active = await seedStaff(tmp.db);
    const disabled = await seedStaff(tmp.db, { status: StaffStatus.Disabled });

    expect(await findStaffByTelegram(tmp.db, active.telegramUserId)).toEqual({
      id: active.staffId,
      status: StaffStatus.Active,
    });
    expect(await findStaffByTelegram(tmp.db, disabled.telegramUserId)).toEqual({
      id: disabled.staffId,
      status: StaffStatus.Disabled,
    });
    expect(await findStaffByTelegram(tmp.db, NOBODY)).toBeUndefined();
  });
});

describe('recordStaffBotRefusal', () => {
  it('records the refusal against the known account', async () => {
    const disabled = await seedStaff(tmp.db, { status: StaffStatus.Disabled });

    await recordStaffBotRefusal(tmp.db, { staffId: disabled.staffId, via: 'start' });

    expect(await entriesFor(disabled.staffId)).toEqual([
      {
        action: AuditAction.StaffLoginLinkRefused,
        actorType: 'system',
        entityType: 'staff',
        entityId: disabled.staffId,
        payload: { reason: 'disabled', via: 'start' },
      },
    ]);
  });
});

describe('issueLoginLink', () => {
  it('stores only the hash of the token and records the issue', async () => {
    const seeded = await seedStaff(tmp.db);

    const issued = await issue(seeded);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await linkRow(issued.linkId);
    expect(row.status).toBe(StaffLoginLinkStatus.Issued);
    expect(row.tokenHash).toBe(createHash('sha256').update(issued.token, 'utf8').digest('hex'));
    expect(row.tokenHash).not.toBe(issued.token);
    expect(JSON.stringify(row)).not.toContain(issued.token);
    // five minutes by the database's clock
    const [ttl] = await tmp.db
      .select({
        ttl: sql<string>`(${staffLoginLinks.expiresAt} - ${staffLoginLinks.createdAt})::text`,
      })
      .from(staffLoginLinks)
      .where(eq(staffLoginLinks.id, issued.linkId));
    expect(ttl?.ttl).toBe('00:05:00');
    expect(await entriesFor(seeded.staffId)).toEqual([
      {
        action: AuditAction.StaffLoginLinkIssued,
        actorType: 'system',
        entityType: 'staff_login_link',
        entityId: issued.linkId,
        payload: { superseded: 0 },
      },
    ]);
    expect(JSON.stringify(await entriesFor(seeded.staffId))).not.toContain(issued.token);
  });

  it('supersedes the previous link with the next press', async () => {
    const seeded = await seedStaff(tmp.db);
    const first = await issue(seeded);

    const second = await issue(seeded);

    expect((await linkRow(first.linkId)).status).toBe(StaffLoginLinkStatus.Superseded);
    expect((await linkRow(second.linkId)).status).toBe(StaffLoginLinkStatus.Issued);
    expect((await entriesFor(seeded.staffId)).at(-1)?.payload).toEqual({ superseded: 1 });
    expect(await complete(first.token)).toEqual({ ok: false, state: LinkState.Unavailable });
    expect((await entriesFor(seeded.staffId)).at(-1)).toMatchObject({
      action: AuditAction.StaffLoginLinkRefused,
      entityType: 'staff_login_link',
      entityId: first.linkId,
      payload: { reason: 'superseded', via: 'web', ip: IP },
    });
  });

  // the staff row lock serialises them: no 23505 from staff_login_links_live_idx
  it('settles two simultaneous presses into one live link', async () => {
    const seeded = await seedStaff(tmp.db);

    const results = await Promise.all([
      issueLoginLink(tmp.db, { telegramUserId: seeded.telegramUserId }),
      issueLoginLink(tmp.db, { telegramUserId: seeded.telegramUserId }),
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect((await linksOf(seeded.staffId)).map((row) => row.status).sort()).toEqual([
      StaffLoginLinkStatus.Issued,
      StaffLoginLinkStatus.Superseded,
    ]);
  });

  it('issues nothing and records nothing for a stranger', async () => {
    const before = await auditCount();

    expect(await issueLoginLink(tmp.db, { telegramUserId: NOBODY })).toEqual({
      ok: false,
      reason: 'not_staff',
    });
    expect(await auditCount()).toBe(before);
  });

  // the refusal's row is the bot handler's, written after its reply (recordStaffBotRefusal)
  it('issues nothing to a disabled account and leaves the row to the caller', async () => {
    const disabled = await seedStaff(tmp.db, { status: StaffStatus.Disabled });

    expect(await issueLoginLink(tmp.db, { telegramUserId: disabled.telegramUserId })).toEqual({
      ok: false,
      reason: 'disabled',
      staffId: disabled.staffId,
    });
    expect(await linksOf(disabled.staffId)).toEqual([]);
    expect(await entriesFor(disabled.staffId)).toEqual([]);
  });

  it(`refuses press ${STAFF_LOGIN_LINK_MAX_PER_WINDOW + 1} within the window and keeps the live link`, async () => {
    const seeded = await seedStaff(tmp.db);
    let last = await issue(seeded);
    for (let press = 2; press <= STAFF_LOGIN_LINK_MAX_PER_WINDOW; press += 1) {
      last = await issue(seeded);
    }

    expect(await issueLoginLink(tmp.db, { telegramUserId: seeded.telegramUserId })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
    expect((await linkRow(last.linkId)).status).toBe(StaffLoginLinkStatus.Issued);
    expect(await linksOf(seeded.staffId)).toHaveLength(STAFF_LOGIN_LINK_MAX_PER_WINDOW);
    expect((await entriesFor(seeded.staffId)).at(-1)).toMatchObject({
      action: AuditAction.StaffLoginLinkRefused,
      entityType: 'staff',
      entityId: seeded.staffId,
      payload: { reason: 'rate_limited', via: 'button' },
    });
  });

  it('counts only the window: links older than it do not hold the next press back', async () => {
    const seeded = await seedStaff(tmp.db);
    for (let press = 1; press <= STAFF_LOGIN_LINK_MAX_PER_WINDOW; press += 1) await issue(seeded);
    await tmp.db
      .update(staffLoginLinks)
      .set({
        createdAt: sql`now() - interval '16 minutes'`,
        expiresAt: sql`now() - interval '11 minutes'`,
      })
      .where(eq(staffLoginLinks.staffId, seeded.staffId));

    expect((await issueLoginLink(tmp.db, { telegramUserId: seeded.telegramUserId })).ok).toBe(true);
  });

  // owner's answer В4: a password lockout does not shut the bot path
  it('issues a link and lets it in while a password lockout is running', async () => {
    const seeded = await seedStaff(tmp.db);
    await tmp.db
      .update(staff)
      .set({ lockedUntil: sql`now() + interval '15 minutes'`, failedPasswordAttempts: 5 })
      .where(eq(staff.id, seeded.staffId));

    const issued = await issue(seeded);

    expect(await complete(issued.token)).toMatchObject({ ok: true });
  });
});

describe('inspectLoginLink', () => {
  it('reads a live link without spending it or writing a row', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);
    const rowBefore = await linkRow(issued.linkId);
    const before = await auditCount();

    expect(await inspectLoginLink(tmp.db, issued.token)).toBe(LinkState.Live);
    expect(await inspectLoginLink(tmp.db, issued.token)).toBe(LinkState.Live);

    expect(await linkRow(issued.linkId)).toEqual(rowBefore);
    expect(await auditCount()).toBe(before);
    expect(await complete(issued.token)).toMatchObject({ ok: true });
  });

  it('says used, expired and unavailable as complete would', async () => {
    const seeded = await seedStaff(tmp.db);
    const used = await issue(seeded);
    await complete(used.token);
    const expired = await issue(seeded);
    await tmp.db
      .update(staffLoginLinks)
      .set({
        createdAt: sql`now() - interval '6 minutes'`,
        expiresAt: sql`now() - interval '1 minute'`,
      })
      .where(eq(staffLoginLinks.id, expired.linkId));
    // read before the next press: that supersedes every issued link, an expired one included
    expect(await inspectLoginLink(tmp.db, expired.token)).toBe(LinkState.Expired);
    const superseded = await issue(seeded);
    await issue(seeded);

    expect(await inspectLoginLink(tmp.db, used.token)).toBe(LinkState.Used);
    expect(await inspectLoginLink(tmp.db, expired.token)).toBe(LinkState.Unavailable);
    expect(await inspectLoginLink(tmp.db, superseded.token)).toBe(LinkState.Unavailable);
    expect(await inspectLoginLink(tmp.db, 'n'.repeat(43))).toBe(LinkState.Unavailable);
  });
});

describe('completeLinkLogin', () => {
  it('creates a session with the code login’s lifetime, spends the link and records it', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);

    const result = await complete(issued.token);

    if (!result.ok) throw new Error(`refused: ${result.state}`);
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.staffId).toBe(seeded.staffId);
    const sessions = await sessionsOf(seeded.staffId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.lifetime).toBe('1 day');
    const row = await linkRow(issued.linkId);
    expect(row.status).toBe(StaffLoginLinkStatus.Used);
    expect(row.usedAt).not.toBeNull();
    expect((await entriesFor(seeded.staffId)).at(-1)).toEqual({
      action: AuditAction.StaffLoginLinkCompleted,
      actorType: 'admin',
      entityType: 'staff_session',
      entityId: sessions[0]?.id,
      payload: { linkId: issued.linkId, ip: IP },
    });
    expect(
      await runAsStaff(tmp.db, { token: result.sessionToken }, async () => ({
        result: 'served',
        audit: { action: AuditAction.StaffSessionsViewed, payload: {} },
      })),
    ).toBe('served');
  });

  it('refuses the same link a second time as used, and records it', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);
    await complete(issued.token);

    expect(await complete(issued.token)).toEqual({ ok: false, state: LinkState.Used });
    expect(await sessionsOf(seeded.staffId)).toHaveLength(1);
    expect((await entriesFor(seeded.staffId)).at(-1)).toMatchObject({
      action: AuditAction.StaffLoginLinkRefused,
      entityId: issued.linkId,
      payload: { reason: 'used', via: 'web', ip: IP },
    });
  });

  it('turns two simultaneous opens into exactly one session', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);

    const results = await Promise.all([complete(issued.token), complete(issued.token)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, state: LinkState.Used }]);
    expect(await sessionsOf(seeded.staffId)).toHaveLength(1);
  });

  it('refuses a link past its five minutes, by the database’s clock', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);
    await tmp.db
      .update(staffLoginLinks)
      .set({
        createdAt: sql`now() - interval '6 minutes'`,
        expiresAt: sql`now() - interval '1 minute'`,
      })
      .where(eq(staffLoginLinks.id, issued.linkId));

    expect(await complete(issued.token)).toEqual({ ok: false, state: LinkState.Expired });
    expect(await sessionsOf(seeded.staffId)).toEqual([]);
    expect((await linkRow(issued.linkId)).status).toBe(StaffLoginLinkStatus.Issued);
    expect((await entriesFor(seeded.staffId)).at(-1)?.payload).toEqual({
      reason: 'expired',
      via: 'web',
      ip: IP,
    });
  });

  // opening it again after logging in tells the truth however late it is
  it('says used, not expired, for a used link past its five minutes', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);
    await complete(issued.token);
    await tmp.db
      .update(staffLoginLinks)
      .set({
        createdAt: sql`now() - interval '6 minutes'`,
        expiresAt: sql`now() - interval '1 minute'`,
        usedAt: sql`now() - interval '5 minutes'`,
      })
      .where(eq(staffLoginLinks.id, issued.linkId));

    expect(await complete(issued.token)).toEqual({ ok: false, state: LinkState.Used });
  });

  // owner's answer В5: rows are about known staff members; the route logs the rest
  it('refuses a token nobody was issued without writing a row', async () => {
    const before = await auditCount();

    expect(await complete('u'.repeat(43))).toEqual({ ok: false, state: LinkState.Unavailable });
    expect(await auditCount()).toBe(before);
  });

  // Defence in depth: every writer of staff.status in this codebase closes the links in the same
  // transaction (invalidateIssued), so only a writer that forgot to would leave one issued under
  // a disabled owner. The CAS still refuses it.
  it('refuses a link still issued under a disabled owner', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);
    await tmp.db
      .update(staff)
      .set({ status: StaffStatus.Disabled })
      .where(eq(staff.id, seeded.staffId));

    expect(await inspectLoginLink(tmp.db, issued.token)).toBe(LinkState.Unavailable);
    expect(await complete(issued.token)).toEqual({ ok: false, state: LinkState.Unavailable });
    expect(await sessionsOf(seeded.staffId)).toEqual([]);
    expect((await linkRow(issued.linkId)).status).toBe(StaffLoginLinkStatus.Issued);
    expect((await entriesFor(seeded.staffId)).at(-1)?.payload).toMatchObject({
      reason: 'disabled',
    });
  });
});

describe('the credentials changing under an issued link', () => {
  type Change = (
    seeded: SeededStaff,
  ) => Promise<{
    pending: { linkId: string; token: string };
    counts: StaffInvalidation | undefined;
  }>;

  const changes: [string, Change, string][] = [
    [
      'disable',
      async (seeded) => {
        const pending = await issue(seeded);
        return { pending, counts: await disableStaffAccount(tmp.db, seeded.login) };
      },
      'disabled',
    ],
    [
      'reset-password',
      async (seeded) => {
        const pending = await issue(seeded);
        const passwordHash = await hashPassword('reset password', TEST_SCRYPT_PARAMS);
        return {
          pending,
          counts: await resetStaffPassword(tmp.db, { login: seeded.login, passwordHash }),
        };
      },
      'revoked',
    ],
    [
      'the own password change',
      async (seeded) => {
        // the session the change is made under comes first; the link it must close, after
        const own = await complete((await issue(seeded)).token);
        if (!own.ok) throw new Error('unreachable');
        const pending = await issue(seeded);
        const newPasswordHash = await hashPassword('brand new password', TEST_SCRYPT_PARAMS);
        const counts = await runAsStaff(
          tmp.db,
          { token: own.sessionToken, lockStaff: true },
          async (tx, ctx) => {
            const changed = await applyStaffPasswordChange(tx, {
              staffId: ctx.staffId,
              sessionId: ctx.sessionId,
              passwordHashSeen: seeded.passwordHash,
              newPasswordHash,
            });
            if (!changed.ok) throw new Error(`the change was refused: ${changed.reason}`);
            return {
              result: changed,
              audit: { action: AuditAction.StaffPasswordChanged, payload: {} },
            };
          },
        );
        return { pending, counts };
      },
      'revoked',
    ],
  ];

  it.each(changes)(
    '%s revokes the issued link, which then opens nothing',
    async (_label, change, reason) => {
      const seeded = await seedStaff(tmp.db);

      const { pending, counts } = await change(seeded);

      expect(counts).toMatchObject({ closedLinks: 1 });
      expect((await linkRow(pending.linkId)).status).toBe(StaffLoginLinkStatus.Revoked);
      expect(await complete(pending.token)).toEqual({ ok: false, state: LinkState.Unavailable });
      expect((await entriesFor(seeded.staffId)).at(-1)).toMatchObject({
        action: AuditAction.StaffLoginLinkRefused,
        entityId: pending.linkId,
        payload: { reason, via: 'web' },
      });
    },
  );
});

describe('the CLI racing a login by link (Rule 5)', () => {
  // The CLI has closed the link and holds it: the login's CAS waits on the row and, once the CLI
  // commits, finds it revoked.
  it('a disable that reaches the link first leaves the login with nothing', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);
    let login: Promise<CompleteLinkLoginResult> | undefined;
    const raced = afterUpdateOf(tmp.db, staffLoginLinks, async () => {
      login = complete(issued.token);
      await until('the login waits on the link row', async () => (await lockWaiters(tmp.db)) >= 1);
    });

    const counts = await disableStaffAccount(raced, seeded.login);

    expect(counts).toEqual({ closedChallenges: 0, closedLinks: 1, revokedSessions: 0 });
    expect(await login).toEqual({ ok: false, state: LinkState.Unavailable });
    expect(await sessionsOf(seeded.staffId)).toEqual([]);
    expect((await linkRow(issued.linkId)).status).toBe(StaffLoginLinkStatus.Revoked);
  });

  // The login holds the link and has inserted its session: the CLI's UPDATE of `staff` does not
  // wait (the FK's KEY SHARE is compatible with NO KEY UPDATE), its UPDATE of the links does, and
  // afterwards it revokes the session the login committed — with revoked_at not before its
  // created_at (clock_timestamp(), the class of #149).
  it('a login that holds the link first is revoked by the disable behind it', async () => {
    const seeded = await seedStaff(tmp.db);
    const issued = await issue(seeded);
    let cli: Promise<StaffInvalidation | undefined> | undefined;
    const raced = afterInsertInto(tmp.db, staffSessions, async () => {
      cli = disableStaffAccount(tmp.db, seeded.login);
      await until('the CLI waits on the link row', async () => (await lockWaiters(tmp.db)) >= 1);
    });

    const login = await complete(issued.token, raced);

    expect(login).toMatchObject({ ok: true });
    expect(await cli).toEqual({ closedChallenges: 0, closedLinks: 0, revokedSessions: 1 });
    const sessions = await sessionsOf(seeded.staffId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revokedAt).not.toBeNull();
    expect(sessions[0]?.revokedAfterCreated).toBe(true);
    expect((await linkRow(issued.linkId)).status).toBe(StaffLoginLinkStatus.Used);
  });
});
