import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  FIRST_SESSION_CHAIN,
  NotificationKind,
  NotificationLevel,
  TOKEN_NUDGES,
  TokenLedgerKind,
  UserStatus,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  createTempDatabase,
  lockWaiters,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  type TempDatabase,
} from './testing';
import {
  brokerAccounts,
  NotificationJobStatus,
  notificationJobs,
  notificationKinds,
  tokenLedger,
  users,
} from './schema/index';
import { LINK_BONUS_RULE_CODE, LINK_BONUS_TOKENS } from './link-bonus-ops';
import { markTelegramBlocked, setNotificationLevel } from './delivery-ops';
import {
  claimMailingJob,
  MAILING_OUTCOME_UNKNOWN,
  planMailingJobs,
  settleMailingJob,
} from './mailing-ops';

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

const SCAN = 50;
const [STEP_1H, STEP_24H, STEP_72H] = FIRST_SESSION_CHAIN;

// The cutoff of every kind, `minutes` before now() on the database clock.
const plansFromMinutesAgo = async (minutes: number, kind?: NotificationKind): Promise<void> => {
  await tmp.db
    .update(notificationKinds)
    .set({ plansFrom: sql`now() - make_interval(mins => ${minutes})` })
    .where(kind === undefined ? undefined : eq(notificationKinds.kind, kind));
};

interface Linked {
  userId: string;
  telegramUserId: bigint;
  accountId: string;
  linkedAt: Date;
}

// A user whose account was connected `minutes` ago: an active account and the starter pack's
// ledger row, as the activation transaction writes them, backdated on the database clock. The
// cached balance is the pack, as grantLinkBonus leaves it, or `balance` — what the settles of the
// trades spent since would leave (the token nudges read the cache only).
async function linked(minutes: number, balance = LINK_BONUS_TOKENS): Promise<Linked> {
  const user = await seedUser(tmp.db, { balance });
  const accountId = await seedBrokerAccount(tmp.db, user.userId, { isPartnerClient: true });
  const [row] = await tmp.db
    .insert(tokenLedger)
    .values({
      userId: user.userId,
      kind: TokenLedgerKind.Bonus,
      balanceDelta: LINK_BONUS_TOKENS,
      brokerAccountId: accountId,
      note: LINK_BONUS_RULE_CODE,
      createdAt: sql`now() - make_interval(mins => ${minutes})`,
    })
    .returning({ createdAt: tokenLedger.createdAt });
  return {
    userId: user.userId,
    telegramUserId: BigInt(user.telegramUserId),
    accountId,
    linkedAt: row!.createdAt,
  };
}

const jobsOf = (userId: string) =>
  tmp.db
    .select()
    .from(notificationJobs)
    .where(eq(notificationJobs.userId, userId))
    .orderBy(notificationJobs.scheduledAt);

const jobRow = async (id: string) => {
  const [row] = await tmp.db.select().from(notificationJobs).where(eq(notificationJobs.id, id));
  if (row === undefined) throw new Error(`no notification_jobs row ${id}`);
  return row;
};

const hours = (n: number) => n * 60;

describe('planMailingJobs', () => {
  beforeAll(() => plansFromMinutesAgo(hours(200)));

  it('C1 plans the step that is due, at the link time plus its offset, and nothing earlier', async () => {
    const early = await linked(30);
    const first = await linked(hours(1) + 1);
    const second = await linked(hours(24) + 1);
    const third = await linked(hours(72) + 1);

    await planMailingJobs(tmp.db);

    expect(await jobsOf(early.userId)).toEqual([]);
    for (const [user, step] of [
      [first, STEP_1H],
      [second, STEP_24H],
      [third, STEP_72H],
    ] as const) {
      const jobs = await jobsOf(user.userId);
      // the earlier steps are stale once this one is due: one job, this step's
      expect(jobs.map((job) => [job.kind, job.status, job.dedupeKey])).toEqual([
        [step.kind, NotificationJobStatus.Pending, `first_session:${step.afterHours}h`],
      ]);
      expect(jobs[0]!.scheduledAt.getTime()).toBe(
        user.linkedAt.getTime() + step.afterHours * 3_600_000,
      );
    }
  });

  it('M1 plans a step once however many times it runs', async () => {
    const user = await linked(hours(1) + 1);
    const first = await planMailingJobs(tmp.db);
    const again = await planMailingJobs(tmp.db);
    expect(first[NotificationKind.FirstSession1h]).toBeGreaterThanOrEqual(1);
    expect(again[NotificationKind.FirstSession1h]).toBe(0);
    expect(await jobsOf(user.userId)).toHaveLength(1);
  });

  it('M2 plans a step once when two planners run at the same time', async () => {
    const user = await linked(hours(24) + 1);
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    expect((await jobsOf(user.userId)).map((job) => job.kind)).toEqual([
      NotificationKind.FirstSession24h,
    ]);
  });

  it('C2 plans nothing for a user who cannot or may not get the step', async () => {
    const revoked = await linked(hours(1) + 1);
    await tmp.db
      .update(brokerAccounts)
      .set({ status: BrokerAccountStatus.Revoked })
      .where(eq(brokerAccounts.id, revoked.accountId));
    const adminBlocked = await linked(hours(1) + 1);
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, adminBlocked.userId));
    const withSession = await linked(hours(1) + 1);
    await seedTradingSession(tmp.db, withSession.accountId);
    const off = await linked(hours(1) + 1);
    await setNotificationLevel(tmp.db, off.telegramUserId, NotificationLevel.Off);
    const unreachable = await linked(hours(1) + 1);
    await markTelegramBlocked(tmp.db, unreachable.telegramUserId);
    // a user with an account but no starter pack: nothing to count from
    const noPack = await seedUser(tmp.db);
    await seedBrokerAccount(tmp.db, noPack.userId);

    await planMailingJobs(tmp.db);

    const ids = [revoked, adminBlocked, withSession, off, unreachable].map((user) => user.userId);
    const jobs = await tmp.db
      .select()
      .from(notificationJobs)
      .where(inArray(notificationJobs.userId, [...ids, noPack.userId]));
    expect(jobs).toEqual([]);
  });

  // #202, owner 2026-10-10: accounts connected before the engine's deploy get no reminders.
  // Each kind's cutoff is placed inside its own step window, so an account on either side of it
  // is due for that step.
  it('CUT plans nothing for an account connected before the kind’s plans_from, and the step for one after', async () => {
    const before: Linked[] = [];
    const after: Linked[] = [];
    for (const step of FIRST_SESSION_CHAIN) {
      await plansFromMinutesAgo(hours(step.afterHours) + 30, step.kind);
      before.push(await linked(hours(step.afterHours) + 40));
      after.push(await linked(hours(step.afterHours) + 20));
    }

    await planMailingJobs(tmp.db);

    for (const user of before) expect(await jobsOf(user.userId)).toEqual([]);
    expect(
      (await Promise.all(after.map((user) => jobsOf(user.userId)))).map((jobs) =>
        jobs.map((job) => job.kind),
      ),
    ).toEqual(FIRST_SESSION_CHAIN.map((step) => [step.kind]));
    await plansFromMinutesAgo(hours(200));
  });

  it('CUT plans nothing for a kind without its notification_kinds row', async () => {
    await tmp.db
      .delete(notificationKinds)
      .where(eq(notificationKinds.kind, NotificationKind.FirstSession1h));
    try {
      const user = await linked(hours(1) + 1);
      await planMailingJobs(tmp.db);
      expect(await jobsOf(user.userId)).toEqual([]);
    } finally {
      await tmp.db.insert(notificationKinds).values({
        kind: NotificationKind.FirstSession1h,
        plansFrom: sql`now() - interval '200 hours'`,
      });
    }
  });

  it('seeds every kind’s cutoff from the migration, the chain’s at one moment', async () => {
    const fresh = await createTempDatabase(baseUrl);
    try {
      const rows = await fresh.db.select().from(notificationKinds);
      expect(rows.map((row) => row.kind).sort()).toEqual(Object.values(NotificationKind).sort());
      const chain: readonly NotificationKind[] = FIRST_SESSION_CHAIN.map((step) => step.kind);
      const chainRows = rows.filter((row) => chain.includes(row.kind));
      expect(new Set(chainRows.map((row) => row.plansFrom.getTime())).size).toBe(1);
    } finally {
      await fresh.drop();
    }
  });
});

describe('claimMailingJob', () => {
  // every claim takes the earliest due job of the database: the cases start from no pending one
  beforeEach(async () => {
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.status, NotificationJobStatus.Pending));
  });

  // a due job of the last step, which applies while the user is active, has an active account
  // and has no session
  async function dueJob(
    patch: { userLevel?: NotificationLevel } = {},
  ): Promise<Linked & { jobId: string }> {
    const user = await linked(hours(72) + 1);
    if (patch.userLevel !== undefined) {
      await tmp.db
        .update(users)
        .set({ notificationLevel: patch.userLevel })
        .where(eq(users.id, user.userId));
    }
    const [job] = await tmp.db
      .insert(notificationJobs)
      .values({
        userId: user.userId,
        kind: NotificationKind.FirstSession72h,
        dedupeKey: `first_session:${STEP_72H.afterHours}h`,
        scheduledAt: sql`now() - interval '1 minute'`,
      })
      .returning({ id: notificationJobs.id });
    return { ...user, jobId: job!.id };
  }

  it('marks the job sent with an unknown outcome before the send, and never claims it again', async () => {
    const { jobId, telegramUserId } = await dueJob();
    const { job, canceled } = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(canceled).toBe(0);
    expect(job).toMatchObject({
      id: jobId,
      kind: NotificationKind.FirstSession72h,
      telegramUserId,
    });
    const row = await jobRow(jobId);
    expect(row.status).toBe(NotificationJobStatus.Sent);
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.lastError).toBe(MAILING_OUTCOME_UNKNOWN);
    // M11 at the database: the claim committed, whatever became of the send
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toBeUndefined();

    await settleMailingJob(tmp.db, jobId, { kind: 'delivered' });
    expect((await jobRow(jobId)).lastError).toBeNull();
  });

  it('takes a job not yet due later, not now', async () => {
    const { jobId } = await dueJob();
    await tmp.db
      .update(notificationJobs)
      .set({ scheduledAt: sql`now() + interval '1 minute'` })
      .where(eq(notificationJobs.id, jobId));
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toBeUndefined();
  });

  // The earlier job is held by another transaction, as a second sender's claim would hold it:
  // a claim skips it rather than waiting to send it too, and two claims never take one job.
  it('M2 skips a job another claim holds, and never gives two claims one job', async () => {
    const held = await dueJob();
    const free = await dueJob();
    const client = await tmp.pool.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from notification_jobs where id = $1 for update', [held.jobId]);
      let settled = false;
      const claims = Promise.all([
        claimMailingJob(tmp.db, { scan: SCAN }),
        claimMailingJob(tmp.db, { scan: SCAN }),
      ]).finally(() => {
        settled = true;
      });
      await until(
        'both claims to finish, or one to wait on the held job',
        async () => settled || (await lockWaiters(tmp.db)) > 0,
      );
      await client.query('rollback');
      const ids = (await claims).map((claim) => claim.job?.id ?? null);
      expect(ids.sort()).toEqual([free.jobId, null].sort());
    } finally {
      client.release();
    }
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job?.id).toBe(held.jobId);
  });

  it('M3/C3 cancels at the claim a step whose user started a session after it was planned', async () => {
    for (const step of FIRST_SESSION_CHAIN) {
      const user = await linked(hours(step.afterHours) + 1);
      const [planned] = await tmp.db
        .insert(notificationJobs)
        .values({
          userId: user.userId,
          kind: step.kind,
          dedupeKey: `first_session:${step.afterHours}h`,
          scheduledAt: sql`now() - interval '1 minute'`,
        })
        .returning({ id: notificationJobs.id });
      await seedTradingSession(tmp.db, user.accountId);

      expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({
        job: undefined,
        canceled: 1,
      });
      expect((await jobRow(planned!.id)).status).toBe(NotificationJobStatus.Canceled);
    }
  });

  it('cancels a step that went stale because the next one is due', async () => {
    const user = await linked(hours(24) + 1);
    const [job] = await tmp.db
      .insert(notificationJobs)
      .values({ userId: user.userId, kind: NotificationKind.FirstSession1h })
      .returning({ id: notificationJobs.id });
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(job!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('M4 never takes a job of a user who turned notifications off, and the switch cancels it', async () => {
    const pending = await dueJob();
    await setNotificationLevel(tmp.db, pending.telegramUserId, NotificationLevel.Off);
    expect((await jobRow(pending.jobId)).status).toBe(NotificationJobStatus.Canceled);

    // a job written after the switch stays pending and untaken
    const late = await dueJob({ userLevel: NotificationLevel.Off });
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toBeUndefined();
    expect((await jobRow(late.jobId)).status).toBe(NotificationJobStatus.Pending);
  });

  it('M5 holds a reduced user’s second mailing until the window has passed', async () => {
    const user = await dueJob({ userLevel: NotificationLevel.Reduced });
    const [second] = await tmp.db
      .insert(notificationJobs)
      .values({ userId: user.userId, kind: NotificationKind.FirstSession72h })
      .returning({ id: notificationJobs.id });

    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job?.id).toBe(user.jobId);
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toBeUndefined();
    expect((await jobRow(second!.id)).status).toBe(NotificationJobStatus.Pending);

    // the first mailing moved out of the window
    await tmp.db
      .update(notificationJobs)
      .set({ sentAt: sql`now() - interval '25 hours'` })
      .where(eq(notificationJobs.id, user.jobId));
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job?.id).toBe(second!.id);
  });

  it('M6 never takes a job of a user who blocked the bot', async () => {
    const user = await dueJob();
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, user.userId));
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toBeUndefined();
  });
});

describe('settleMailingJob', () => {
  beforeEach(async () => {
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.status, NotificationJobStatus.Pending));
  });

  async function claimed(): Promise<string> {
    const user = await linked(hours(72) + 1);
    await tmp.db.insert(notificationJobs).values({
      userId: user.userId,
      kind: NotificationKind.FirstSession72h,
      scheduledAt: sql`now() - interval '1 minute'`,
    });
    const { job } = await claimMailingJob(tmp.db, { scan: SCAN });
    if (job === undefined) throw new Error('nothing claimed');
    return job.id;
  }

  const inFuture = async (id: string) => {
    const [row] = await tmp.db
      .select({ ok: sql<boolean>`${notificationJobs.scheduledAt} > now()` })
      .from(notificationJobs)
      .where(eq(notificationJobs.id, id));
    return row!.ok;
  };

  it('fails a refused job for good, with the attempt counted', async () => {
    const id = await claimed();
    await settleMailingJob(tmp.db, id, { kind: 'refused', lastError: 'GrammyError:403' });
    expect(await jobRow(id)).toMatchObject({
      status: NotificationJobStatus.Failed,
      sentAt: null,
      attempts: 1,
      lastError: 'GrammyError:403',
    });
  });

  it('puts a deferred job back without counting an attempt', async () => {
    const id = await claimed();
    await settleMailingJob(tmp.db, id, {
      kind: 'deferred',
      lastError: 'GrammyError:429',
      afterMs: 30_000,
    });
    expect(await jobRow(id)).toMatchObject({
      status: NotificationJobStatus.Pending,
      sentAt: null,
      attempts: 0,
    });
    expect(await inFuture(id)).toBe(true);
  });

  it('retries a job later until its last attempt, then fails it', async () => {
    const id = await claimed();
    const retry = {
      kind: 'retry',
      lastError: 'GrammyError:400',
      afterMs: 300_000,
      maxAttempts: 2,
    } as const;
    await settleMailingJob(tmp.db, id, retry);
    expect(await jobRow(id)).toMatchObject({ status: NotificationJobStatus.Pending, attempts: 1 });
    expect(await inFuture(id)).toBe(true);

    await tmp.db
      .update(notificationJobs)
      .set({ scheduledAt: sql`now() - interval '1 minute'` })
      .where(eq(notificationJobs.id, id));
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job?.id).toBe(id);
    await settleMailingJob(tmp.db, id, retry);
    expect(await jobRow(id)).toMatchObject({ status: NotificationJobStatus.Failed, attempts: 2 });
  });

  it('leaves a row the claim no longer holds alone', async () => {
    const id = await claimed();
    await settleMailingJob(tmp.db, id, { kind: 'delivered' });
    await settleMailingJob(tmp.db, id, { kind: 'refused', lastError: 'GrammyError:403' });
    expect(await jobRow(id)).toMatchObject({ status: NotificationJobStatus.Sent, lastError: null });
    expect(
      await tmp.db
        .select()
        .from(notificationJobs)
        .where(and(eq(notificationJobs.id, id), eq(notificationJobs.attempts, 0))),
    ).toHaveLength(1);
  });
});

// #123: the cached balance against the starter pack, one push for the highest threshold reached.
describe('the low-token nudge', () => {
  const [HALF, LOW, OUT] = TOKEN_NUDGES;
  const TOKEN_KINDS: readonly NotificationKind[] = TOKEN_NUDGES.map((nudge) => nudge.kind);

  const cancelPending = () =>
    tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.status, NotificationJobStatus.Pending));

  // the earlier cases' users are planned and set aside once, so a claim here takes this block's own
  beforeAll(async () => {
    await plansFromMinutesAgo(hours(200));
    await planMailingJobs(tmp.db);
    await cancelPending();
  });
  beforeEach(cancelPending);

  const tokenJobsOf = async (userId: string) =>
    (await jobsOf(userId)).filter((job) => TOKEN_KINDS.includes(job.kind));

  const setBalance = (userId: string, balance: bigint) =>
    tmp.db.update(users).set({ tokenBalance: balance }).where(eq(users.id, userId));

  const insertJob = async (
    userId: string,
    kind: NotificationKind,
    status: NotificationJobStatus = NotificationJobStatus.Pending,
  ) => {
    const nudge = TOKEN_NUDGES.find((n) => n.kind === kind)!;
    const [job] = await tmp.db
      .insert(notificationJobs)
      .values({
        userId,
        kind,
        status,
        dedupeKey: `tokens:${nudge.usedPercent}`,
        scheduledAt: sql`now() - interval '1 minute'`,
      })
      .returning({ id: notificationJobs.id });
    return job!.id;
  };

  it('T1 plans the one nudge whose band holds the balance, now, once', async () => {
    const started = (await tmp.db.execute<{ at: string }>(sql`select now()::text as at`)).rows[0]!
      .at;
    const cases = [
      [100n, []],
      [51n, []],
      [50n, [HALF]],
      [21n, [HALF]],
      [20n, [LOW]],
      [1n, [LOW]],
      [0n, [OUT]],
    ] as const;
    const seeded = await Promise.all(cases.map(([balance]) => linked(0, balance)));

    await planMailingJobs(tmp.db);
    const again = await planMailingJobs(tmp.db);

    for (const [i, [, expected]] of cases.entries()) {
      const jobs = await tokenJobsOf(seeded[i]!.userId);
      expect(jobs.map((job) => [job.kind, job.status, job.dedupeKey])).toEqual(
        expected.map((nudge) => [
          nudge.kind,
          NotificationJobStatus.Pending,
          `tokens:${nudge.usedPercent}`,
        ]),
      );
      for (const job of jobs) {
        expect(job.scheduledAt.getTime()).toBeGreaterThanOrEqual(new Date(started).getTime());
      }
    }
    for (const kind of TOKEN_KINDS) expect(again[kind]).toBe(0);
  });

  it('T2 gives a user past several thresholds at the deploy one push, the highest, and never a lower one later', async () => {
    // connected long before the kinds were switched on, as at the deploy
    const at90 = await linked(hours(100), 10n);
    const at100 = await linked(hours(100), 0n);
    for (const kind of TOKEN_KINDS) await plansFromMinutesAgo(0, kind);
    try {
      await planMailingJobs(tmp.db);
      expect((await tokenJobsOf(at90.userId)).map((job) => job.kind)).toEqual([LOW.kind]);
      expect((await tokenJobsOf(at100.userId)).map((job) => job.kind)).toEqual([OUT.kind]);

      // an adjustment lifts the balances back into the lower bands
      await setBalance(at90.userId, 40n);
      await setBalance(at100.userId, 15n);
      await planMailingJobs(tmp.db);
      expect((await tokenJobsOf(at90.userId)).map((job) => job.kind)).toEqual([LOW.kind]);
      expect((await tokenJobsOf(at100.userId)).map((job) => job.kind)).toEqual([OUT.kind]);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });

  it('T3 plans nothing for a user without the starter pack, blocked by the admin, or unreachable', async () => {
    const noPack = await seedUser(tmp.db, { balance: 0n });
    await seedBrokerAccount(tmp.db, noPack.userId);
    const adminBlocked = await linked(0, 0n);
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, adminBlocked.userId));
    const off = await linked(0, 0n);
    await setNotificationLevel(tmp.db, off.telegramUserId, NotificationLevel.Off);

    await planMailingJobs(tmp.db);

    for (const userId of [noPack.userId, adminBlocked.userId, off.userId]) {
      expect(await tokenJobsOf(userId)).toEqual([]);
    }
  });

  it('T4 sends only the highest of two nudges planned before the send, and cancels the lower', async () => {
    const user = await linked(0, 0n);
    const lower = await insertJob(user.userId, HALF.kind);
    const higher = await insertJob(user.userId, OUT.kind);

    const { job, canceled } = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(job?.id).toBe(higher);
    expect(canceled).toBe(1);
    expect((await jobRow(lower)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('T5 cancels a lower nudge once a higher one has a job, whatever the balance', async () => {
    // the 80 % push went out, then an adjustment lifted the balance back to the 50 % band
    const user = await linked(0, 40n);
    await insertJob(user.userId, LOW.kind, NotificationJobStatus.Sent);
    const lower = await insertJob(user.userId, HALF.kind);

    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(lower)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('T6 cancels a nudge whose user got tokens back before the send', async () => {
    const user = await linked(0, 50n);
    await planMailingJobs(tmp.db);
    const [planned] = await tokenJobsOf(user.userId);
    expect(planned?.kind).toBe(HALF.kind);
    await setBalance(user.userId, 80n);

    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(planned!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('CUT plans nothing for a nudge without its notification_kinds row', async () => {
    await tmp.db.delete(notificationKinds).where(eq(notificationKinds.kind, OUT.kind));
    try {
      const user = await linked(0, 0n);
      await planMailingJobs(tmp.db);
      expect(await tokenJobsOf(user.userId)).toEqual([]);
    } finally {
      await tmp.db.insert(notificationKinds).values({
        kind: OUT.kind,
        plansFrom: sql`now() - interval '200 hours'`,
      });
    }
  });
});
