import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  FIRST_SESSION_CHAIN,
  NotificationKind,
  NotificationLevel,
  TokenLedgerKind,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  UserStatus,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  bonusRuleRef,
  createTempDatabase,
  intentRequest,
  lockWaiters,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  SEEDED_REFERRAL_REWARD_TOKENS,
  type TempDatabase,
} from './testing';
import {
  brokerAccounts,
  NotificationJobStatus,
  notificationJobs,
  notificationKinds,
  referrals,
  tokenLedger,
  tradingSessions,
  users,
} from './schema/index';
import { createTradeIntent } from './trade-intent-ops';
import { markTelegramBlocked, setNotificationLevel } from './delivery-ops';
import { setLastAnalysis, setTradingMode } from './user-ops';
import { grantReferralReward, lockReferralInviter } from './referral-reward-ops';
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
// ledger row, as the activation transaction writes them, backdated on the database clock.
async function linked(minutes: number): Promise<Linked> {
  const user = await seedUser(tmp.db);
  const accountId = await seedBrokerAccount(tmp.db, user.userId, { isPartnerClient: true });
  const [row] = await tmp.db
    .insert(tokenLedger)
    .values({
      userId: user.userId,
      kind: TokenLedgerKind.Bonus,
      balanceDelta: 100n,
      brokerAccountId: accountId,
      ...(await bonusRuleRef(tmp.db, 'link_bonus')),
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

// The user's last analysis (#484) `minutes` ago on the database clock, as setLastAnalysis writes
// it but backdated, so the reminder is due without waiting.
async function backdateAnalysis(
  userId: string,
  minutes: number,
  { assetId = 101, durationSec = 15 }: { assetId?: number; durationSec?: number } = {},
): Promise<Date> {
  const [row] = await tmp.db
    .update(users)
    .set({
      lastAnalysisAt: sql`now() - make_interval(secs => ${minutes * 60})`,
      lastAnalysisAssetId: assetId,
      lastAnalysisDurationSec: durationSec,
    })
    .where(eq(users.id, userId))
    .returning({ at: users.lastAnalysisAt });
  return row!.at!;
}

interface Analysed {
  userId: string;
  telegramUserId: bigint;
  accountId: string;
  analysedAt: Date;
}

// a demo user with an active account, whose analysis with a signal was `minutes` ago
async function analysed(
  minutes: number,
  pair: { assetId?: number; durationSec?: number } = {},
): Promise<Analysed> {
  const user = await seedUser(tmp.db);
  const accountId = await seedBrokerAccount(tmp.db, user.userId);
  return {
    userId: user.userId,
    telegramUserId: BigInt(user.telegramUserId),
    accountId,
    analysedAt: await backdateAnalysis(user.userId, minutes, pair),
  };
}

// a due analysis job under the key of the user's current analysis, written past the planner
async function insertAnalysisJob(userId: string): Promise<string> {
  const [job] = await tmp.db
    .insert(notificationJobs)
    .values({
      userId,
      kind: NotificationKind.AnalysisUnused,
      dedupeKey: sql`(select 'analysis_unused:' || extract(epoch from ${users.lastAnalysisAt})::text
        from ${users} where ${users.id} = ${userId})`,
      scheduledAt: sql`now() - interval '1 minute'`,
    })
    .returning({ id: notificationJobs.id });
  return job!.id;
}

const analysisJobsOf = async (userId: string) =>
  (await jobsOf(userId)).filter((job) => job.kind === NotificationKind.AnalysisUnused);

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

  // #121: the chain leads into the demo, so a user in real mode gets none of it
  it('C2r plans nothing for a linked user in real mode, and the step for one in demo', async () => {
    const real = await linked(hours(1) + 1);
    await setTradingMode(tmp.db, BigInt(real.telegramUserId), TradeMode.Real);
    const demo = await linked(hours(1) + 1);
    await planMailingJobs(tmp.db);
    expect(await jobsOf(real.userId)).toEqual([]);
    expect((await jobsOf(demo.userId)).map((job) => job.kind)).toEqual([STEP_1H!.kind]);
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

  it('seeds every kind’s cutoff from the migration, at one moment', async () => {
    const fresh = await createTempDatabase(baseUrl);
    try {
      const rows = await fresh.db.select().from(notificationKinds);
      expect(rows.map((row) => row.kind).sort()).toEqual(Object.values(NotificationKind).sort());
      expect(new Set(rows.map((row) => row.plansFrom.getTime())).size).toBe(1);
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

  // #121: a step planned while the user traded demo is cancelled once they switched to real
  it('C3r cancels at the claim a step whose user switched to real after it was planned', async () => {
    const { jobId, telegramUserId } = await dueJob();
    await setTradingMode(tmp.db, BigInt(telegramUserId), TradeMode.Real);
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(jobId)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('cancels a step that went stale because the next one is due', async () => {
    const user = await linked(hours(24) + 1);
    const [job] = await tmp.db
      .insert(notificationJobs)
      .values({
        userId: user.userId,
        kind: NotificationKind.FirstSession1h,
        dedupeKey: `first_session:${STEP_1H.afterHours}h`,
      })
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
    // the second mailing is the analysis reminder: the chain step has one key per user (#484)
    await backdateAnalysis(user.userId, 11);
    const second = { id: await insertAnalysisJob(user.userId) };

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
      dedupeKey: `first_session:${STEP_72H.afterHours}h`,
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

// #484: the analysis reminder
describe('the analysis reminder: planning', () => {
  beforeAll(() => plansFromMinutesAgo(hours(200)));

  it('A1 plans one job ten minutes after the analysis, with the pair for the button, and nothing earlier', async () => {
    const due = await analysed(11, { assetId: 202, durationSec: 5 });
    const early = await analysed(9);
    await planMailingJobs(tmp.db);

    expect(await jobsOf(early.userId)).toEqual([]);
    const jobs = await jobsOf(due.userId);
    expect(jobs.map((job) => [job.kind, job.status, job.payload])).toEqual([
      [
        NotificationKind.AnalysisUnused,
        NotificationJobStatus.Pending,
        { assetId: 202, durationSec: 5 },
      ],
    ]);
    expect(jobs[0]!.scheduledAt.getTime()).toBe(due.analysedAt.getTime() + 600_000);
    expect(jobs[0]!.dedupeKey).toMatch(/^analysis_unused:\d+\.\d{6}$/);
    expect(jobs[0]!.dedupeKey).toContain(
      `:${String(Math.floor(due.analysedAt.getTime() / 1000))}.`,
    );
  });

  it('A2 plans only the latest analysis: an earlier one’s key never appears', async () => {
    const user = await analysed(15);
    const first = await tmp.db
      .select({
        key: sql<string>`'analysis_unused:' || extract(epoch from ${users.lastAnalysisAt})::text`,
      })
      .from(users)
      .where(eq(users.id, user.userId));
    const second = await backdateAnalysis(user.userId, 11);
    await planMailingJobs(tmp.db);
    const jobs = await analysisJobsOf(user.userId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.scheduledAt.getTime()).toBe(second.getTime() + 600_000);
    expect(jobs[0]!.dedupeKey).not.toBe(first[0]!.key);
  });

  it('A3 plans nothing once a trade or a session followed the analysis', async () => {
    const traded = await analysed(11);
    await createTradeIntent(tmp.db, intentRequest(String(traded.telegramUserId)));
    const cycled = await analysed(11);
    await seedTradingSession(tmp.db, cycled.accountId);
    await planMailingJobs(tmp.db);
    expect(await jobsOf(traded.userId)).toEqual([]);
    expect(await jobsOf(cycled.userId)).toEqual([]);
  });

  it('A3b plans nothing while a session started before the analysis runs, and plans after one that stopped', async () => {
    const running = await analysed(11);
    await seedTradingSession(tmp.db, running.accountId, {
      startedAt: new Date(Date.now() - 2 * 3_600_000),
    });
    const stopped = await analysed(11);
    const session = await seedTradingSession(tmp.db, stopped.accountId, {
      startedAt: new Date(Date.now() - 2 * 3_600_000),
    });
    await tmp.db
      .update(tradingSessions)
      .set({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.Completed,
        endedAt: new Date(Date.now() - 3_600_000),
      })
      .where(eq(tradingSessions.id, session.id));
    await planMailingJobs(tmp.db);
    expect(await jobsOf(running.userId)).toEqual([]);
    expect((await jobsOf(stopped.userId)).map((job) => job.kind)).toEqual([
      NotificationKind.AnalysisUnused,
    ]);
  });

  // a cycle of five short trades ends within minutes: a session started after the analysis and
  // already stopped is an action on it all the same
  it('A3d plans nothing once a session started after the analysis has stopped', async () => {
    const user = await analysed(11);
    const session = await seedTradingSession(tmp.db, user.accountId);
    await tmp.db
      .update(tradingSessions)
      .set({
        status: TradingSessionStatus.Stopped,
        stopReason: TradingSessionStopReason.Completed,
        endedAt: sql`now()`,
      })
      .where(eq(tradingSessions.id, session.id));
    await planMailingJobs(tmp.db);
    expect(await jobsOf(user.userId)).toEqual([]);
  });

  it('A3c plans nothing for a user in real mode, blocked by the admin, or after an analysis with no signal', async () => {
    const real = await analysed(11);
    await setTradingMode(tmp.db, real.telegramUserId, TradeMode.Real);
    const blocked = await analysed(11);
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, blocked.userId));
    const noSignal = await analysed(11);
    await setLastAnalysis(tmp.db, noSignal.telegramUserId, null);
    await planMailingJobs(tmp.db);
    for (const user of [real, blocked, noSignal]) expect(await jobsOf(user.userId)).toEqual([]);
  });

  it('A6 plans nothing for an analysis older than the window', async () => {
    const old = await analysed(61);
    await planMailingJobs(tmp.db);
    expect(await jobsOf(old.userId)).toEqual([]);
  });

  it('A7 plans an analysis once however many planners run, and not again once sent', async () => {
    const user = await analysed(11);
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    const again = await planMailingJobs(tmp.db);
    expect(again[NotificationKind.AnalysisUnused]).toBe(0);
    const [job] = await analysisJobsOf(user.userId);
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Sent, sentAt: sql`now()` })
      .where(eq(notificationJobs.id, job!.id));
    await planMailingJobs(tmp.db);
    expect(await analysisJobsOf(user.userId)).toHaveLength(1);
  });

  it('A8 gives each analysis its own reminder', async () => {
    const user = await analysed(11);
    await planMailingJobs(tmp.db);
    await backdateAnalysis(user.userId, 10.5);
    await planMailingJobs(tmp.db);
    const jobs = await analysisJobsOf(user.userId);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.dedupeKey)).size).toBe(2);
  });

  it('CUT plans nothing for an analysis before the kind’s plans_from, and the job for one after', async () => {
    await plansFromMinutesAgo(30, NotificationKind.AnalysisUnused);
    try {
      const before = await analysed(40);
      const after = await analysed(20);
      await planMailingJobs(tmp.db);
      expect(await jobsOf(before.userId)).toEqual([]);
      expect((await jobsOf(after.userId)).map((job) => job.kind)).toEqual([
        NotificationKind.AnalysisUnused,
      ]);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });
});

describe('the analysis reminder: the claim', () => {
  beforeAll(() => plansFromMinutesAgo(hours(200)));
  // A claim takes the earliest due job of the database, and planned() runs the planner over every
  // user: the earlier cases' facts are cleared and whatever they still plan is drained first.
  beforeEach(async () => {
    await tmp.db
      .update(users)
      .set({ lastAnalysisAt: null, lastAnalysisAssetId: null, lastAnalysisDurationSec: null });
    await planMailingJobs(tmp.db);
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.status, NotificationJobStatus.Pending));
  });

  // a user whose reminder the planner wrote and the sender has not claimed yet
  async function planned(): Promise<Analysed & { jobId: string }> {
    const user = await analysed(11);
    await planMailingJobs(tmp.db);
    const [job] = await analysisJobsOf(user.userId);
    if (job === undefined) throw new Error('nothing planned');
    return { ...user, jobId: job.id };
  }

  it('A4 claims the job of an analysis nobody acted on, with its payload', async () => {
    const user = await planned();
    const { job } = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(job).toMatchObject({
      id: user.jobId,
      kind: NotificationKind.AnalysisUnused,
      payload: { assetId: 101, durationSec: 15 },
      telegramUserId: user.telegramUserId,
    });
  });

  it.each([
    [
      'opened another analysis',
      (user: Analysed) =>
        setLastAnalysis(tmp.db, user.telegramUserId, { assetId: 101, durationSec: 15 }),
    ],
    [
      'created a trade',
      (user: Analysed) => createTradeIntent(tmp.db, intentRequest(String(user.telegramUserId))),
    ],
    ['started a session', (user: Analysed) => seedTradingSession(tmp.db, user.accountId)],
    [
      'switched to real',
      (user: Analysed) => setTradingMode(tmp.db, user.telegramUserId, TradeMode.Real),
    ],
    [
      'was blocked by the admin',
      (user: Analysed) =>
        tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, user.userId)),
    ],
  ] as const)(
    'A4 cancels at the claim the job of a user who %s after it was planned',
    async (_, act) => {
      const user = await planned();
      await act(user);
      expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({
        job: undefined,
        canceled: 1,
      });
      expect((await jobRow(user.jobId)).status).toBe(NotificationJobStatus.Canceled);
    },
  );

  it('A5 cancels the job once an analysis with no signal cleared the fact, and claims nothing after', async () => {
    const user = await planned();
    await setLastAnalysis(tmp.db, user.telegramUserId, null);
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(user.jobId)).status).toBe(NotificationJobStatus.Canceled);
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 0 });
  });

  it('A6 cancels at the claim a job whose window closed before it was sent', async () => {
    const user = await analysed(61);
    const jobId = await insertAnalysisJob(user.userId);
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(jobId)).status).toBe(NotificationJobStatus.Canceled);
  });
});

interface Rewarded {
  inviterId: string;
  inviterTelegramId: bigint;
  inviteeId: string;
  rewardId: string;
  rewardedAt: Date;
}

// An inviter's reward (#116) `minutes` ago: a new invitee, its referral and the reward's ledger
// row, as grantReferralReward writes it but backdated and with any amount. Without `inviter`, a
// new one.
async function rewarded(
  minutes: number,
  {
    tokens = 50n,
    inviter,
  }: { tokens?: bigint; inviter?: { userId: string; telegramUserId: bigint } } = {},
): Promise<Rewarded> {
  let inviterUser = inviter;
  if (inviterUser === undefined) {
    const user = await seedUser(tmp.db);
    inviterUser = { userId: user.userId, telegramUserId: BigInt(user.telegramUserId) };
  }
  const invitee = await seedUser(tmp.db);
  const [referral] = await tmp.db
    .insert(referrals)
    .values({ inviteeUserId: invitee.userId, inviterUserId: inviterUser.userId })
    .returning({ id: referrals.id });
  const [row] = await tmp.db
    .insert(tokenLedger)
    .values({
      userId: inviterUser.userId,
      kind: TokenLedgerKind.Bonus,
      balanceDelta: tokens,
      referralId: referral!.id,
      ...(await bonusRuleRef(tmp.db, 'referral_reward')),
      createdAt: sql`now() - make_interval(secs => ${minutes * 60})`,
    })
    .returning({ id: tokenLedger.id, createdAt: tokenLedger.createdAt });
  return {
    inviterId: inviterUser.userId,
    inviterTelegramId: inviterUser.telegramUserId,
    inviteeId: invitee.userId,
    rewardId: row!.id,
    rewardedAt: row!.createdAt,
  };
}

const rewardJobsOf = async (userId: string) =>
  (await jobsOf(userId)).filter((job) => job.kind === NotificationKind.ReferralRewarded);

describe('the referral reward notification: planning', () => {
  beforeAll(() => plansFromMinutesAgo(hours(200)));

  it('R1 plans one job per reward at the reward’s moment, with the row’s tokens as text', async () => {
    const first = await rewarded(5, { tokens: 50n });
    const inviter = { userId: first.inviterId, telegramUserId: first.inviterTelegramId };
    const second = await rewarded(3, { tokens: 75n, inviter });
    const starterOnly = await linked(5);

    await planMailingJobs(tmp.db);

    const jobs = await rewardJobsOf(first.inviterId);
    expect(
      jobs.map((job) => ({
        dedupeKey: job.dedupeKey,
        payload: job.payload,
        scheduledAt: job.scheduledAt,
        status: job.status,
      })),
    ).toEqual([
      {
        dedupeKey: `referral_rewarded:${first.rewardId}`,
        payload: { tokens: '50' },
        scheduledAt: first.rewardedAt,
        status: NotificationJobStatus.Pending,
      },
      {
        dedupeKey: `referral_rewarded:${second.rewardId}`,
        payload: { tokens: '75' },
        scheduledAt: second.rewardedAt,
        status: NotificationJobStatus.Pending,
      },
    ]);
    expect(await rewardJobsOf(starterOnly.userId)).toEqual([]);
    expect(await jobsOf(first.inviteeId)).toEqual([]);
  });

  it('R2 plans the job for a reward granted by the writer of #116, due at once', async () => {
    const inviter = await seedUser(tmp.db);
    const invitee = await seedUser(tmp.db);
    await tmp.db
      .insert(referrals)
      .values({ inviteeUserId: invitee.userId, inviterUserId: inviter.userId });
    const result = await tmp.db.transaction(async (tx) => {
      const referral = await lockReferralInviter(tx, invitee.userId);
      return grantReferralReward(tx, { referral, account: { isPartnerClient: true } });
    });
    expect(result.rewarded).toBe(true);

    await planMailingJobs(tmp.db);

    const jobs = await rewardJobsOf(inviter.userId);
    expect(jobs.map((job) => job.payload)).toEqual([
      { tokens: String(SEEDED_REFERRAL_REWARD_TOKENS) },
    ]);
    const [due] = await tmp.db
      .execute<{ due: boolean }>(
        sql`select ${jobs[0]!.scheduledAt.toISOString()}::timestamptz <= now() as due`,
      )
      .then((r) => r.rows);
    expect(due?.due).toBe(true);
  });

  it('R3 plans a reward once however many planners run, and not again once sent or canceled', async () => {
    const sent = await rewarded(2);
    const canceled = await rewarded(2);
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    expect(await rewardJobsOf(sent.inviterId)).toHaveLength(1);
    expect(await rewardJobsOf(canceled.inviterId)).toHaveLength(1);

    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Sent, sentAt: sql`now()` })
      .where(eq(notificationJobs.userId, sent.inviterId));
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.userId, canceled.inviterId));
    await planMailingJobs(tmp.db);

    expect((await rewardJobsOf(sent.inviterId)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Sent,
    ]);
    expect((await rewardJobsOf(canceled.inviterId)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Canceled,
    ]);
  });

  it('R4 plans nothing for an inviter blocked by the admin, who blocked the bot or turned notifications off, and plans once they are back on', async () => {
    const adminBlocked = await rewarded(2);
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, adminBlocked.inviterId));
    const unreachable = await rewarded(2);
    await markTelegramBlocked(tmp.db, unreachable.inviterTelegramId);
    const off = await rewarded(2);
    await setNotificationLevel(tmp.db, off.inviterTelegramId, NotificationLevel.Off);

    await planMailingJobs(tmp.db);
    for (const user of [adminBlocked, unreachable, off]) {
      expect(await rewardJobsOf(user.inviterId)).toEqual([]);
    }

    await setNotificationLevel(tmp.db, off.inviterTelegramId, NotificationLevel.All);
    await planMailingJobs(tmp.db);
    expect((await rewardJobsOf(off.inviterId)).map((job) => job.dedupeKey)).toEqual([
      `referral_rewarded:${off.rewardId}`,
    ]);
  });

  it('CUT plans nothing for a reward before the kind’s plans_from, and the job for one after', async () => {
    await plansFromMinutesAgo(30, NotificationKind.ReferralRewarded);
    try {
      const before = await rewarded(40);
      const after = await rewarded(20);
      await planMailingJobs(tmp.db);
      expect(await jobsOf(before.inviterId)).toEqual([]);
      expect((await jobsOf(after.inviterId)).map((job) => job.kind)).toEqual([
        NotificationKind.ReferralRewarded,
      ]);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });
});

describe('the referral reward notification: the claim', () => {
  beforeAll(() => plansFromMinutesAgo(hours(200)));
  // A claim takes the earliest due job of the database: whatever the earlier cases still plan is
  // planned and drained first.
  beforeEach(async () => {
    await tmp.db
      .update(users)
      .set({ lastAnalysisAt: null, lastAnalysisAssetId: null, lastAnalysisDurationSec: null });
    await planMailingJobs(tmp.db);
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.status, NotificationJobStatus.Pending));
  });

  // an inviter whose reward job the planner wrote and the sender has not claimed yet
  async function planned(): Promise<Rewarded & { jobId: string }> {
    const reward = await rewarded(1);
    await planMailingJobs(tmp.db);
    const [job] = await rewardJobsOf(reward.inviterId);
    if (job === undefined) throw new Error('nothing planned');
    return { ...reward, jobId: job.id };
  }

  it('R6 claims the job with its payload and the inviter’s Telegram id', async () => {
    const reward = await planned();
    const { job } = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(job).toMatchObject({
      id: reward.jobId,
      kind: NotificationKind.ReferralRewarded,
      payload: { tokens: '50' },
      telegramUserId: reward.inviterTelegramId,
    });
  });

  it('R7 cancels at the claim once the inviter was blocked by the admin after it was planned', async () => {
    const reward = await planned();
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, reward.inviterId));
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(reward.jobId)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('R7r claims the job of an inviter in real mode: the reward is tokens, not the demo path', async () => {
    const reward = await planned();
    await setTradingMode(tmp.db, reward.inviterTelegramId, TradeMode.Real);
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job?.id).toBe(reward.jobId);
  });

  it('R8 cancels at the claim a job whose key names no reward of this user', async () => {
    const own = await rewarded(30);
    const other = await rewarded(30);
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.status, NotificationJobStatus.Pending));
    const jobs = await tmp.db
      .insert(notificationJobs)
      .values(
        [`referral_rewarded:${other.rewardId}`, `referral_rewarded:${crypto.randomUUID()}`].map(
          (dedupeKey) => ({
            userId: own.inviterId,
            kind: NotificationKind.ReferralRewarded,
            dedupeKey,
            payload: { tokens: '50' },
            scheduledAt: sql`now() - interval '1 minute'`,
          }),
        ),
      )
      .returning({ id: notificationJobs.id });
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 2 });
    for (const job of jobs) {
      expect((await jobRow(job.id)).status).toBe(NotificationJobStatus.Canceled);
    }
  });
});
