import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BonusRuleKind,
  BotLanguage,
  BrokerAccountStatus,
  DEMO_TO_REAL_CHAIN,
  DEMO_TO_REAL_SESSIONS,
  DepositEventStatus,
  DepositModeSwitch,
  FIRST_SESSION_CHAIN,
  HELP_LINKS_AFTER_MS,
  NotificationKind,
  NotificationLevel,
  PostbackSource,
  TOKEN_NUDGES,
  TokenLedgerKind,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  UserStatus,
  WEEKLY_SUMMARY_HOUR_UTC,
  type DecimalString,
  type TradingSessionSettings,
  type UnixMs,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  bonusRuleRef,
  closeTradingSwitch,
  createTempDatabase,
  intentRequest,
  lockWaiters,
  seedBalanceSnapshot,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  sessionSettings,
  SEEDED_REFERRAL_REWARD_TOKENS,
  type TempDatabase,
} from './testing';
import {
  bonusRules,
  brokerAccounts,
  brokerBalanceSnapshots,
  BrokerTradeStatus,
  brokerTrades,
  depositEvents,
  NotificationJobStatus,
  notificationJobs,
  notificationKinds,
  referrals,
  tokenLedger,
  tradeIntents,
  tradingSessions,
  tradingSwitch,
  users,
} from './schema/index';
import {
  MAILING_SCENARIOS,
  weeklyAnchor,
  weeklyKey,
  weeklyRange,
  weeklySummaryAt,
  weeklyTimely,
  type MailingScenario,
} from './mailing-scenarios';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createTradeIntent } from './trade-intent-ops';
import { DEPOSIT_BONUS_RULE_CODE } from './bonus-rule-ops';
import { markTelegramBlocked, markTelegramReachable, setNotificationLevel } from './delivery-ops';
import { setLastAnalysis, setTradingMode } from './user-ops';
import { grantReferralReward, lockReferralInviter } from './referral-reward-ops';
import {
  creditStarPayment,
  recordStarRefund,
  StarsCreditSource,
  StarsRefundEvidence,
  StarsRefundSource,
} from './star-payment-ops';
import {
  claimMailingJob,
  MAILING_OUTCOME_UNKNOWN,
  planMailingJobs,
  planMailingKind,
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
// The help push (#879) shares the chain's fact: a case that counts a linked user's every job plans
// without it, and its own cases are in «the help push».
const CHAIN_ERA_KINDS = Object.values(NotificationKind).filter(
  (kind) => kind !== NotificationKind.HelpLinks,
);

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
// cached balance is the whole pack, as grantLinkBonus leaves it, so no low-token nudge (#123) is
// planned, or `balance`: what the settles of the trades spent since would leave.
async function linked(
  minutes: number,
  { balance = 100n, pack = 100n }: { balance?: bigint; pack?: bigint } = {},
): Promise<Linked> {
  const user = await seedUser(tmp.db, { balance });
  const accountId = await seedBrokerAccount(tmp.db, user.userId, { isPartnerClient: true });
  const [row] = await tmp.db
    .insert(tokenLedger)
    .values({
      userId: user.userId,
      kind: TokenLedgerKind.Bonus,
      balanceDelta: pack,
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

    await planMailingJobs(tmp.db, { kinds: CHAIN_ERA_KINDS });

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
    const plan = () => planMailingJobs(tmp.db, { kinds: CHAIN_ERA_KINDS });
    await Promise.all([plan(), plan(), plan()]);
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

    await planMailingJobs(tmp.db, { kinds: CHAIN_ERA_KINDS });

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
    // a row with no broker account that is not a reward either
    const adjusted = await seedUser(tmp.db);
    await tmp.db.insert(tokenLedger).values({
      userId: adjusted.userId,
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: 30n,
      note: 'R1',
      createdAt: sql`now() - interval '5 minutes'`,
    });

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
    expect(await rewardJobsOf(adjusted.userId)).toEqual([]);
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

// #123 (docs/mailing.md → The low-token nudge): the cached balance against the user's own starter
// pack, one push for the highest threshold reached.
describe('the low-token nudge', () => {
  const [HALF, LOW, OUT] = TOKEN_NUDGES;
  const TOKEN_KINDS: readonly NotificationKind[] = TOKEN_NUDGES.map((nudge) => nudge.kind);
  const keyOf = (nudge: (typeof TOKEN_NUDGES)[number]) => `tokens:${nudge.usedPercent}`;

  // `failed`, not `canceled`: the planner takes a canceled nudge back, and a set-aside job must not
  // come back into a later case's claim
  const setAsidePending = () =>
    tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Failed })
      .where(eq(notificationJobs.status, NotificationJobStatus.Pending));

  // the earlier cases' users are planned and set aside once, so a claim here takes this block's own
  beforeAll(async () => {
    await plansFromMinutesAgo(hours(200));
    await tmp.db
      .update(users)
      .set({ lastAnalysisAt: null, lastAnalysisAssetId: null, lastAnalysisDurationSec: null });
    await planMailingJobs(tmp.db);
    await setAsidePending();
  });
  beforeEach(setAsidePending);

  const tokenJobsOf = async (userId: string) =>
    (await jobsOf(userId)).filter((job) => TOKEN_KINDS.includes(job.kind));

  const setBalance = (userId: string, balance: bigint) =>
    tmp.db.update(users).set({ tokenBalance: balance }).where(eq(users.id, userId));

  const insertJob = async (
    userId: string,
    nudge: (typeof TOKEN_NUDGES)[number],
    status: NotificationJobStatus = NotificationJobStatus.Pending,
  ) => {
    const [job] = await tmp.db
      .insert(notificationJobs)
      .values({
        userId,
        kind: nudge.kind,
        status,
        dedupeKey: keyOf(nudge),
        payload: { tokens: '0' },
        scheduledAt: sql`now() - interval '1 minute'`,
      })
      .returning({ id: notificationJobs.id });
    return job!.id;
  };

  const dbNow = async () =>
    new Date((await tmp.db.execute<{ at: string }>(sql`select now()::text as at`)).rows[0]!.at);

  it('T1 plans the one nudge whose band holds the balance, now, with its threshold, once', async () => {
    const started = await dbNow();
    const cases = [
      [100n, []],
      [51n, []],
      [50n, [[HALF, '50']]],
      [21n, [[HALF, '50']]],
      [20n, [[LOW, '20']]],
      [1n, [[LOW, '20']]],
      [0n, [[OUT, '0']]],
    ] as const;
    const seeded = await Promise.all(cases.map(([balance]) => linked(0, { balance })));

    await planMailingJobs(tmp.db);
    const again = await planMailingJobs(tmp.db);

    for (const [i, [, expected]] of cases.entries()) {
      const jobs = await tokenJobsOf(seeded[i]!.userId);
      expect(jobs.map((job) => [job.kind, job.status, job.dedupeKey, job.payload])).toEqual(
        expected.map(([nudge, tokens]) => [
          nudge.kind,
          NotificationJobStatus.Pending,
          keyOf(nudge),
          { tokens },
        ]),
      );
      for (const job of jobs) {
        expect(job.scheduledAt.getTime()).toBeGreaterThanOrEqual(started.getTime());
      }
    }
    for (const kind of TOKEN_KINDS) expect(again[kind]).toBe(0);
  });

  it('T2 gives a user past several thresholds at the deploy one push, the highest, and no lower one while it waits', async () => {
    // connected long before the kinds were switched on, as at the deploy
    const at90 = await linked(hours(100), { balance: 10n });
    const at100 = await linked(hours(100), { balance: 0n });
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

  it('T3 plans nothing for a user blocked by the admin, off, or who blocked the bot', async () => {
    const adminBlocked = await linked(0, { balance: 0n });
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, adminBlocked.userId));
    const off = await linked(0, { balance: 0n });
    await setNotificationLevel(tmp.db, off.telegramUserId, NotificationLevel.Off);
    const botBlocked = await linked(0, { balance: 0n });
    await markTelegramBlocked(tmp.db, botBlocked.telegramUserId);

    await planMailingJobs(tmp.db);

    for (const user of [adminBlocked, off, botBlocked]) {
      expect(await tokenJobsOf(user.userId)).toEqual([]);
    }
  });

  it('T3b cancels at the claim the nudge of a user the admin blocked after it was planned', async () => {
    const user = await linked(0, { balance: 0n });
    await planMailingJobs(tmp.db);
    const [planned] = await tokenJobsOf(user.userId);
    await tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, user.userId));

    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(planned!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('T4 sends only the highest of two nudges planned before the send, and cancels the lower', async () => {
    const user = await linked(0, { balance: 0n });
    const lower = await insertJob(user.userId, HALF);
    const higher = await insertJob(user.userId, OUT);

    const { job, canceled } = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(job).toMatchObject({ id: higher, kind: OUT.kind, tradingMode: TradeMode.Demo });
    expect(canceled).toBe(1);
    expect((await jobRow(lower)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('T5 cancels a lower nudge once a higher one has a job, whatever the balance', async () => {
    // the 80 % push went out, then a credit lifted the balance back to the 50 % band
    const user = await linked(0, { balance: 40n });
    await insertJob(user.userId, LOW, NotificationJobStatus.Sent);
    const lower = await insertJob(user.userId, HALF);

    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(lower)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('T6 cancels a nudge whose user got tokens back before the send', async () => {
    const user = await linked(0, { balance: 50n });
    await planMailingJobs(tmp.db);
    const [planned] = await tokenJobsOf(user.userId);
    expect(planned?.kind).toBe(HALF.kind);
    await setBalance(user.userId, 80n);

    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(planned!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('T7 plans a canceled nudge again once the balance is back in its band, and sends it once', async () => {
    const user = await linked(0, { balance: 0n });
    await planMailingJobs(tmp.db);
    const [planned] = await tokenJobsOf(user.userId);
    expect(planned?.kind).toBe(OUT.kind);
    // a credit lifts the balance before the send; the user spends it again
    await setBalance(user.userId, 80n);
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    await setBalance(user.userId, 0n);
    // the spending took an hour, and the canceled row carries a stale payload: the job comes back
    // for the moment it is planned again, with the planner's payload
    await tmp.db
      .update(notificationJobs)
      .set({ scheduledAt: sql`now() - interval '1 hour'`, payload: { tokens: '99' } })
      .where(eq(notificationJobs.id, planned!.id));
    const replanStarted = await dbNow();

    expect((await planMailingJobs(tmp.db))[OUT.kind]).toBe(1);
    const [replanned] = await tokenJobsOf(user.userId);
    expect(replanned).toMatchObject({
      id: planned!.id,
      status: NotificationJobStatus.Pending,
      payload: { tokens: '0' },
    });
    expect(replanned!.scheduledAt.getTime()).toBeGreaterThanOrEqual(replanStarted.getTime());

    const { job } = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(job?.id).toBe(planned!.id);
    await settleMailingJob(tmp.db, job!.id, { kind: 'delivered' });
    expect((await planMailingJobs(tmp.db))[OUT.kind]).toBe(0);
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 0 });
    expect((await tokenJobsOf(user.userId)).map((j) => [j.kind, j.status, j.lastError])).toEqual([
      [OUT.kind, NotificationJobStatus.Sent, null],
    ]);
  });

  it('T8 lets a canceled higher nudge bar no lower one, at planning and at the claim', async () => {
    const user = await linked(0, { balance: 30n });
    await insertJob(user.userId, OUT, NotificationJobStatus.Canceled);
    await insertJob(user.userId, LOW, NotificationJobStatus.Canceled);

    await planMailingJobs(tmp.db);
    const half = (await tokenJobsOf(user.userId)).find((job) => job.kind === HALF.kind);
    expect(half?.status).toBe(NotificationJobStatus.Pending);

    const { job, canceled } = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(job?.id).toBe(half!.id);
    expect(canceled).toBe(0);
  });

  it.each([
    NotificationJobStatus.Sent,
    NotificationJobStatus.Failed,
    NotificationJobStatus.Pending,
  ])('T9 a %s higher nudge still bars a lower one at planning', async (status) => {
    const user = await linked(0, { balance: 30n });
    await insertJob(user.userId, LOW, status);

    await planMailingJobs(tmp.db);

    expect((await tokenJobsOf(user.userId)).map((job) => job.kind)).toEqual([LOW.kind]);
  });

  it.each([
    NotificationJobStatus.Sent,
    NotificationJobStatus.Failed,
    NotificationJobStatus.Pending,
  ])('T10 never takes back a %s nudge: only a canceled one is planned again', async (status) => {
    const user = await linked(0, { balance: 0n });
    const id = await insertJob(user.userId, OUT, status);
    const before = await jobRow(id);

    expect((await planMailingJobs(tmp.db))[OUT.kind]).toBe(0);

    expect(await jobRow(id)).toEqual(before);
  });

  it('T11 does not take a canceled nudge back for a user who is off or blocked the bot', async () => {
    const off = await linked(0, { balance: 0n });
    const botBlocked = await linked(0, { balance: 0n });
    await planMailingJobs(tmp.db);
    await setNotificationLevel(tmp.db, off.telegramUserId, NotificationLevel.Off);
    await markTelegramBlocked(tmp.db, botBlocked.telegramUserId);
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.userId, botBlocked.userId));

    await planMailingJobs(tmp.db);

    for (const user of [off, botBlocked]) {
      expect((await tokenJobsOf(user.userId)).map((job) => [job.kind, job.status])).toEqual([
        [OUT.kind, NotificationJobStatus.Canceled],
      ]);
    }
  });

  it('T12 leaves a canceled first-session step canceled: only the nudges are planned again', async () => {
    const user = await linked(hours(72) + 1);
    await planMailingJobs(tmp.db, { kinds: CHAIN_ERA_KINDS });
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.userId, user.userId));

    expect((await planMailingJobs(tmp.db, { kinds: CHAIN_ERA_KINDS }))[STEP_72H.kind]).toBe(0);

    expect((await jobsOf(user.userId)).map((job) => [job.kind, job.status])).toEqual([
      [STEP_72H.kind, NotificationJobStatus.Canceled],
    ]);
  });

  it('T13 counts the thresholds from the user’s own pack, at its floor', async () => {
    const cases = [
      [38n, undefined],
      [37n, [HALF, '37']],
      [16n, [HALF, '37']],
      [15n, [LOW, '15']],
      [0n, [OUT, '0']],
    ] as const;
    const seeded = await Promise.all(cases.map(([balance]) => linked(0, { balance, pack: 75n })));

    await planMailingJobs(tmp.db);

    for (const [i, [, expected]] of cases.entries()) {
      expect((await tokenJobsOf(seeded[i]!.userId)).map((job) => [job.kind, job.payload])).toEqual(
        expected === undefined ? [] : [[expected[0].kind, { tokens: expected[1] }]],
      );
    }
  });

  it('T14 plans nothing for a user without the starter pack, and cancels at the claim a job written for one', async () => {
    // tokens from a referral reward only, all spent: the reward is a bonus row too, but not the
    // pack (no broker account on it), so there is nothing to count from
    const rewardedOnly = await rewarded(1, { tokens: 10n });
    await setBalance(rewardedOnly.inviterId, 0n);
    const noPack = await seedUser(tmp.db, { balance: 0n });
    await seedBrokerAccount(tmp.db, noPack.userId);

    await planMailingJobs(tmp.db);

    for (const userId of [rewardedOnly.inviterId, noPack.userId]) {
      expect(await tokenJobsOf(userId)).toEqual([]);
    }

    // the pack row is append-only, so such a job is not one the planner could have written; the
    // reward's own notification is set aside first
    await setAsidePending();
    const written = await insertJob(noPack.userId, OUT);
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(written)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('T15 plans and claims the nudge of a user in real mode, with the mode', async () => {
    const user = await linked(0, { balance: 0n });
    await setTradingMode(tmp.db, user.telegramUserId, TradeMode.Real);

    await planMailingJobs(tmp.db);
    const [planned] = await tokenJobsOf(user.userId);
    expect(planned?.kind).toBe(OUT.kind);

    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toMatchObject({
      id: planned!.id,
      tradingMode: TradeMode.Real,
    });
  });

  it('T16 plans the band a Stars refund lowered the balance into', async () => {
    const user = await linked(0, { balance: 60n });
    const charge = `charge-nudge-${user.userId}`;
    await tmp.db.transaction((tx) =>
      creditStarPayment(tx, {
        telegramPaymentChargeId: charge,
        providerPaymentChargeId: null,
        packageCode: 'p50',
        userId: user.userId,
        currency: 'XTR',
        totalAmount: 100,
        payerTelegramUserId: user.telegramUserId,
        paidAt: new Date(),
        source: StarsCreditSource.Bot,
      }),
    );
    // the purchase is spent down to where the user started, as the trades' settles would leave it
    await setBalance(user.userId, 60n);
    await planMailingJobs(tmp.db);
    expect(await tokenJobsOf(user.userId)).toEqual([]);

    const refund = await tmp.db.transaction((tx) =>
      recordStarRefund(tx, {
        telegramPaymentChargeId: charge,
        source: StarsRefundSource.Cli,
        telegramAnswer: StarsRefundEvidence.Refunded,
      }),
    );
    expect(refund).toMatchObject({ outcome: 'refunded', taken: 50n });
    await planMailingJobs(tmp.db);

    expect((await tokenJobsOf(user.userId)).map((job) => [job.kind, job.payload])).toEqual([
      [LOW.kind, { tokens: '20' }],
    ]);
  });

  it('CUT plans nothing for a nudge without its notification_kinds row', async () => {
    await tmp.db.delete(notificationKinds).where(eq(notificationKinds.kind, OUT.kind));
    try {
      const user = await linked(0, { balance: 0n });
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

// #686 (docs/mailing.md → The real-mode notification): one job per deposit that switched the user
// to real, an important kind. Last in the file: its beforeEach takes every earlier user out of
// reach, so a claim here takes only this suite's jobs.
describe('the real-mode notification (#686)', () => {
  const KIND = NotificationKind.RealModeByDeposit;
  let n = 0;

  beforeAll(() => plansFromMinutesAgo(hours(200)));
  beforeEach(async () => {
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(sql`${users.telegramBlockedAt} is null`);
  });

  // a user in real whose deposit switched them `minutes` ago, as the pass leaves it
  async function switched({
    minutes = 1,
    realStake,
    minTradeAmount,
    level,
  }: {
    minutes?: number;
    realStake?: string;
    minTradeAmount?: string;
    level?: NotificationLevel;
  } = {}) {
    const user = await seedUser(tmp.db, { tradingMode: TradeMode.Real });
    const brokerUserId = `mr-trader-${String(++n)}`;
    const accountId = await seedBrokerAccount(tmp.db, user.userId, { brokerUserId });
    if (realStake !== undefined) {
      await tmp.db
        .update(users)
        .set({ realStake: realStake as DecimalString })
        .where(eq(users.id, user.userId));
    }
    if (minTradeAmount !== undefined) {
      await seedBalanceSnapshot(tmp.db, accountId, { minTradeAmount });
    }
    if (level !== undefined) {
      await tmp.db.update(users).set({ notificationLevel: level }).where(eq(users.id, user.userId));
    }
    const [row] = await tmp.db
      .insert(depositEvents)
      .values({
        userId: user.userId,
        brokerAccountId: accountId,
        source: PostbackSource.Binodex,
        brokerUserId,
        paymentId: `mr-pay-${String(n)}`,
        amount: '10' as DecimalString,
        modeSwitch: DepositModeSwitch.Switched,
        modeSwitchAt: sql`now() - make_interval(secs => ${minutes * 60})`,
      })
      .returning({ id: depositEvents.id, modeSwitchAt: depositEvents.modeSwitchAt });
    return {
      userId: user.userId,
      telegramUserId: BigInt(user.telegramUserId),
      accountId,
      brokerUserId,
      depositEventId: row!.id,
      switchedAt: row!.modeSwitchAt!,
    };
  }
  const modeJobsOf = async (userId: string) =>
    (await jobsOf(userId)).filter((job) => job.kind === KIND);

  it('MR1 plans one job per switched deposit at its moment, with the real stake in use', async () => {
    const saved = await switched({ realStake: '7', minTradeAmount: '1' });
    const minimum = await switched({ minTradeAmount: '2.5' });
    const none = await switched();
    // another outcome is no fact
    const already = await switched();
    await tmp.db
      .update(depositEvents)
      .set({ modeSwitch: DepositModeSwitch.AlreadyReal })
      .where(eq(depositEvents.id, already.depositEventId));

    await planMailingJobs(tmp.db);

    for (const [user, stake] of [
      [saved, '7.00000000'],
      [minimum, '2.50000000'],
      [none, null],
    ] as const) {
      expect(
        (await modeJobsOf(user.userId)).map((job) => ({
          dedupeKey: job.dedupeKey,
          payload: job.payload,
          scheduledAt: job.scheduledAt,
          status: job.status,
        })),
      ).toEqual([
        {
          dedupeKey: `real_mode_by_deposit:${user.depositEventId}`,
          payload: { stake },
          scheduledAt: user.switchedAt,
          status: NotificationJobStatus.Pending,
        },
      ]);
    }
    expect(await modeJobsOf(already.userId)).toEqual([]);
  });

  it('MR2 plans and claims for a user at `off` and at `reduced` inside the window, not for one who blocked the bot', async () => {
    const off = await switched({ level: NotificationLevel.Off });
    const reduced = await switched({ level: NotificationLevel.Reduced });
    // another mailing sent to the reduced user an hour ago: inside the window
    await tmp.db.insert(notificationJobs).values({
      userId: reduced.userId,
      kind: NotificationKind.ReferralRewarded,
      dedupeKey: `mr-window-${String(++n)}`,
      status: NotificationJobStatus.Sent,
      scheduledAt: sql`now() - interval '1 hour'`,
      sentAt: sql`now() - interval '1 hour'`,
    });
    const unreachable = await switched();
    await markTelegramBlocked(tmp.db, unreachable.telegramUserId);

    await planMailingJobs(tmp.db);

    expect(await modeJobsOf(off.userId)).toHaveLength(1);
    expect(await modeJobsOf(reduced.userId)).toHaveLength(1);
    expect(await modeJobsOf(unreachable.userId)).toEqual([]);
    const claimed = [
      (await claimMailingJob(tmp.db, { scan: SCAN })).job?.telegramUserId,
      (await claimMailingJob(tmp.db, { scan: SCAN })).job?.telegramUserId,
    ];
    expect(claimed.sort()).toEqual([off.telegramUserId, reduced.telegramUserId].sort());
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toBeUndefined();
  });

  it('MR3 its sent row does not hold a reduced user’s next mailing, and another mailing does not hold it', async () => {
    const first = await switched({ level: NotificationLevel.Reduced, minutes: 3 });
    await planMailingJobs(tmp.db);
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job?.kind).toBe(KIND);
    const reward = await rewarded(1, {
      inviter: { userId: first.userId, telegramUserId: first.telegramUserId },
    });
    await planMailingJobs(tmp.db);
    const ordinary = (await claimMailingJob(tmp.db, { scan: SCAN })).job;
    expect(ordinary).toMatchObject({ kind: NotificationKind.ReferralRewarded });
    expect(ordinary?.payload).toEqual({ tokens: '50' });
    expect(reward.inviterId).toBe(first.userId);

    // the other way round: a reward sent first, the switch after it
    const second = await switched({ level: NotificationLevel.Reduced, minutes: 0 });
    await tmp.db.insert(notificationJobs).values({
      userId: second.userId,
      kind: NotificationKind.ReferralRewarded,
      dedupeKey: `mr-window-${String(++n)}`,
      status: NotificationJobStatus.Sent,
      scheduledAt: sql`now() - interval '1 minute'`,
      sentAt: sql`now() - interval '1 minute'`,
    });
    await planMailingJobs(tmp.db);
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toMatchObject({
      kind: KIND,
      telegramUserId: second.telegramUserId,
    });
  });

  it('MR4 cancels at the claim once the user is back in demo or blocked by the admin', async () => {
    const demo = await switched();
    const blocked = await switched();
    await planMailingJobs(tmp.db);
    await setTradingMode(tmp.db, demo.telegramUserId, TradeMode.Demo);
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, blocked.userId));
    expect(await claimMailingJob(tmp.db, { scan: SCAN })).toEqual({ job: undefined, canceled: 2 });
    for (const user of [demo, blocked]) {
      expect((await modeJobsOf(user.userId)).map((job) => job.status)).toEqual([
        NotificationJobStatus.Canceled,
      ]);
    }
  });

  it('MR5 `off` keeps the job; blocking the bot cancels it, and the unblock plans it again while the user is in real', async () => {
    const real = await switched();
    const demo = await switched();
    await planMailingJobs(tmp.db);

    await setNotificationLevel(tmp.db, real.telegramUserId, NotificationLevel.Off);
    expect((await modeJobsOf(real.userId)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Pending,
    ]);

    for (const user of [real, demo]) await markTelegramBlocked(tmp.db, user.telegramUserId);
    for (const user of [real, demo]) {
      expect((await modeJobsOf(user.userId)).map((job) => job.status)).toEqual([
        NotificationJobStatus.Canceled,
      ]);
    }
    await setTradingMode(tmp.db, demo.telegramUserId, TradeMode.Demo);
    for (const user of [real, demo]) await markTelegramReachable(tmp.db, user.telegramUserId);
    await planMailingJobs(tmp.db);
    expect((await modeJobsOf(real.userId)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Pending,
    ]);
    expect((await modeJobsOf(demo.userId)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Canceled,
    ]);
  });

  it('CUT plans nothing for a switch before the kind’s plans_from, and the job for one after', async () => {
    await plansFromMinutesAgo(30, KIND);
    try {
      const before = await switched({ minutes: 40 });
      const after = await switched({ minutes: 20 });
      await planMailingJobs(tmp.db);
      expect(await modeJobsOf(before.userId)).toEqual([]);
      expect(await modeJobsOf(after.userId)).toHaveLength(1);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });

  it('MR7 cancels at the claim a job whose key names no switched deposit of this user', async () => {
    const own = await switched();
    const other = await switched();
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, other.userId));
    const jobs = await tmp.db
      .insert(notificationJobs)
      .values(
        [
          `real_mode_by_deposit:${other.depositEventId}`,
          `real_mode_by_deposit:${crypto.randomUUID()}`,
        ].map((dedupeKey) => ({
          userId: own.userId,
          kind: KIND,
          dedupeKey,
          payload: { stake: null },
          scheduledAt: sql`now() - interval '5 minutes'`,
        })),
      )
      .returning({ id: notificationJobs.id });
    const claim = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(claim.canceled).toBe(2);
    for (const job of jobs) {
      expect((await jobRow(job.id)).status).toBe(NotificationJobStatus.Canceled);
    }
  });

  it('MR8 the claim carries the user’s language', async () => {
    const user = await switched();
    await tmp.db.update(users).set({ language: BotLanguage.En }).where(eq(users.id, user.userId));
    await planMailingJobs(tmp.db);
    expect((await claimMailingJob(tmp.db, { scan: SCAN })).job).toMatchObject({
      kind: KIND,
      telegramUserId: user.telegramUserId,
      language: BotLanguage.En,
    });
  });

  it('MR9 plans one job however many planners run', async () => {
    const user = await switched();
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    expect(await modeJobsOf(user.userId)).toHaveLength(1);
  });
});

// ---- Retention (#124, docs/mailing.md → Retention) ---------------------------------------------
// Offsets are literals, not the constants, so a changed constant reddens them. Each block sets the
// earlier pending jobs aside (`failed`, so the planner does not take them back), and a claim here
// runs with every other pending job set aside, so it can only take or cancel the case's own.

const kindJobsOf = async (userId: string, kind: NotificationKind) =>
  (await jobsOf(userId)).filter((job) => job.kind === kind);

const pendingOf = async (userId: string, kind: NotificationKind) =>
  (await kindJobsOf(userId, kind)).filter((job) => job.status === NotificationJobStatus.Pending);

const setAsidePendingJobs = (except?: string) =>
  tmp.db
    .update(notificationJobs)
    .set({ status: NotificationJobStatus.Failed })
    .where(
      and(
        eq(notificationJobs.status, NotificationJobStatus.Pending),
        except === undefined ? undefined : ne(notificationJobs.id, except),
      ),
    );

const claimOnly = async (jobId: string) => {
  await setAsidePendingJobs(jobId);
  return claimMailingJob(tmp.db, { scan: SCAN });
};

const minutesAgo = (minutes: number) => sql`now() - make_interval(secs => ${minutes * 60})`;

interface Retained {
  userId: string;
  telegramUserId: bigint;
  accountId: string;
}

// a user with an active account and no starter pack, so neither the chain nor a token nudge
async function retained({
  balance = 5n,
  tradingMode,
}: { balance?: bigint; tradingMode?: TradeMode } = {}): Promise<Retained> {
  const user = await seedUser(tmp.db, { balance, tradingMode });
  const accountId = await seedBrokerAccount(tmp.db, user.userId);
  return { userId: user.userId, telegramUserId: BigInt(user.telegramUserId), accountId };
}

const stoppedSession = async (
  accountId: string,
  {
    started,
    ended,
    settings,
    mode = TradeMode.Demo,
  }: { started: number; ended: number; settings?: unknown; mode?: TradeMode },
) => {
  const [row] = await tmp.db
    .insert(tradingSessions)
    .values({
      brokerAccountId: accountId,
      mode,
      settings: (settings ?? sessionSettings({ durationSec: 5 })) as TradingSessionSettings,
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
      startedAt: minutesAgo(started),
      endedAt: minutesAgo(ended),
    })
    .returning();
  return row!;
};

let retentionSeq = 0;
// A trade written directly, settled with its closed broker trade, or rejected
async function trade(
  user: Retained,
  {
    createdAt,
    sessionId,
    mode = TradeMode.Demo,
    profit = '1',
    status = TradeIntentStatus.Settled,
  }: {
    createdAt: SQL;
    sessionId?: string;
    mode?: TradeMode;
    profit?: string;
    status?: typeof TradeIntentStatus.Settled | typeof TradeIntentStatus.Rejected;
  },
): Promise<void> {
  const n = ++retentionSeq;
  const [intent] = await tmp.db
    .insert(tradeIntents)
    .values({
      brokerAccountId: user.accountId,
      userId: user.userId,
      tradingSessionId: sessionId,
      mode,
      assetId: 101,
      amount: '1' as DecimalString,
      action: TradeAction.Up,
      durationSec: 5,
      clientRequestId: `retention-${String(n)}`,
      status,
      tokensReserved: 0n,
      createdAt,
    })
    .returning({ id: tradeIntents.id });
  if (status !== TradeIntentStatus.Settled) return;
  await tmp.db.insert(brokerTrades).values({
    brokerAccountId: user.accountId,
    intentId: intent!.id,
    brokerTradeId: `retention-trade-${String(n)}`,
    mode,
    assetId: 101,
    action: TradeAction.Up,
    amount: '1' as DecimalString,
    openPrice: 1,
    openTimestampMs: 1 as UnixMs,
    closePrice: 1,
    closeTimestampMs: 2 as UnixMs,
    profit: profit as DecimalString,
    status: BrokerTradeStatus.Closed,
    raw: {},
  });
}

const insertJob = async (
  userId: string,
  kind: NotificationKind,
  dedupeKey: string,
  { status, minutes = 0 }: { status: NotificationJobStatus; minutes?: number },
) => {
  const [row] = await tmp.db
    .insert(notificationJobs)
    .values({
      userId,
      kind,
      dedupeKey,
      status,
      scheduledAt: minutesAgo(minutes + 1),
      sentAt: status === NotificationJobStatus.Sent ? minutesAgo(minutes) : null,
    })
    .returning();
  return row!;
};

const openTrading = () => tmp.db.update(tradingSwitch).set({ tradingEnabled: true });

const retentionSetup = () => {
  beforeAll(async () => {
    await plansFromMinutesAgo(hours(200));
    await planMailingJobs(tmp.db);
    await setAsidePendingJobs();
  });
  beforeEach(() => setAsidePendingJobs());
};

describe('retention: inactive_3d', () => {
  retentionSetup();
  const KIND = NotificationKind.Inactive3d;

  // A demo user whose one session started `started` minutes ago and stopped a minute later; its
  // session_idle_24h job is already settled (canceled), so it neither plans nor holds this one
  async function inactiveUser(started = hours(100)) {
    const user = await retained();
    const session = await stoppedSession(user.accountId, { started, ended: started - 1 });
    await insertJob(user.userId, NotificationKind.SessionIdle24h, `session_idle:${session.id}`, {
      status: NotificationJobStatus.Canceled,
    });
    return { ...user, session };
  }

  // the same at a balance of 0, so tokens_out_2d can apply
  async function inactiveUserAt0() {
    const user = await retained({ balance: 0n });
    const session = await stoppedSession(user.accountId, { started: hours(100), ended: hours(100) - 1 });
    await insertJob(user.userId, NotificationKind.SessionIdle24h, `session_idle:${session.id}`, {
      status: NotificationJobStatus.Canceled,
    });
    return { ...user, session };
  }

  it('RT1 plans one job 72 h after the last activity, keyed by its moment, and nothing at 71 h', async () => {
    const due = await inactiveUser(hours(72) + 2);
    const early = await inactiveUser(hours(71));
    await planMailingJobs(tmp.db);

    const jobs = await kindJobsOf(due.userId, KIND);
    const epoch = await tmp.db.execute<{ epoch: string }>(
      sql`select extract(epoch from ${tradingSessions.endedAt})::text as epoch
        from ${tradingSessions} where ${tradingSessions.id} = ${due.session.id}`,
    );
    expect(jobs.map((job) => [job.status, job.dedupeKey, job.payload])).toEqual([
      [NotificationJobStatus.Pending, `inactive_3d:${epoch.rows[0]!.epoch}`, {}],
    ]);
    expect(jobs[0]!.scheduledAt.getTime()).toBe(due.session.endedAt!.getTime() + 72 * 3_600_000);
    expect(await kindJobsOf(early.userId, KIND)).toEqual([]);
  });

  it('RT2d counts the newest session’s end as activity', async () => {
    const user = await retained();
    const session = await stoppedSession(user.accountId, { started: hours(100), ended: hours(10) });
    await insertJob(user.userId, NotificationKind.SessionIdle24h, `session_idle:${session.id}`, {
      status: NotificationJobStatus.Canceled,
    });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT2a counts a trade as activity', async () => {
    const user = await inactiveUser();
    await trade(user, { createdAt: minutesAgo(hours(10)), status: TradeIntentStatus.Rejected });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT2b counts a balance request (the bot’s menu and trading screens) as activity', async () => {
    const user = await inactiveUser();
    await seedBalanceSnapshot(tmp.db, user.accountId);
    await tmp.db
      .update(brokerBalanceSnapshots)
      .set({ lastRequestedAt: minutesAgo(hours(10)) })
      .where(eq(brokerBalanceSnapshots.brokerAccountId, user.accountId));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT2c counts an analysis as activity', async () => {
    const user = await inactiveUser();
    await backdateAnalysis(user.userId, hours(10));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT3 cancels at the claim a job whose user started a session after it was planned', async () => {
    const user = await inactiveUser();
    await planMailingJobs(tmp.db);
    const [planned] = await kindJobsOf(user.userId, KIND);
    await seedTradingSession(tmp.db, user.accountId);
    expect(await claimOnly(planned!.id)).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(planned!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('RT4 plans nothing within 7 days of a sent one', async () => {
    const user = await inactiveUser();
    await insertJob(user.userId, KIND, 'inactive_3d:earlier', {
      status: NotificationJobStatus.Sent,
      minutes: hours(24 * 6),
    });
    await planMailingJobs(tmp.db);
    expect(await pendingOf(user.userId, KIND)).toEqual([]);
  });

  it('RT4b plans once the sent one is older than 7 days', async () => {
    const user = await inactiveUser();
    await insertJob(user.userId, KIND, 'inactive_3d:earlier', {
      status: NotificationJobStatus.Sent,
      minutes: hours(24 * 8),
    });
    await planMailingJobs(tmp.db);
    expect(await pendingOf(user.userId, KIND)).toHaveLength(1);
  });

  it('RT4c is not held by another kind sent within the 7 days', async () => {
    const user = await inactiveUser();
    await insertJob(user.userId, NotificationKind.AnalysisUnused, 'analysis_unused:earlier', {
      status: NotificationJobStatus.Sent,
      minutes: hours(48),
    });
    await planMailingJobs(tmp.db);
    expect(await pendingOf(user.userId, KIND)).toHaveLength(1);
  });

  it.each([
    ['RT5a', NotificationKind.SessionIdle24h, `session_idle:${randomUUID()}`],
    ['RT5b', NotificationKind.TokensOut2d, 'tokens_out_2d'],
  ] as const)('%s plans nothing while a %s job is pending', async (_id, kind, key) => {
    const user = await inactiveUser();
    await insertJob(user.userId, kind, key, { status: NotificationJobStatus.Pending });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it.each([
    ['RT5c', NotificationKind.SessionIdle24h, `session_idle:${randomUUID()}`],
    ['RT5d', NotificationKind.TokensOut2d, 'tokens_out_2d'],
  ] as const)('%s plans nothing once a %s job was sent after the last activity', async (_id, kind, key) => {
    const user = await inactiveUser();
    await insertJob(user.userId, kind, key, { status: NotificationJobStatus.Sent, minutes: hours(76) });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT5e is not held by a specific job sent before the last activity, an earlier spell', async () => {
    const user = await inactiveUser();
    await insertJob(user.userId, NotificationKind.SessionIdle24h, `session_idle:${randomUUID()}`, {
      status: NotificationJobStatus.Sent,
      minutes: hours(110),
    });
    await planMailingJobs(tmp.db);
    expect(await pendingOf(user.userId, KIND)).toHaveLength(1);
  });

  it('RT6a plans nothing for a user in real mode', async () => {
    const user = await inactiveUser();
    await setTradingMode(tmp.db, user.telegramUserId, TradeMode.Real);
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT6b plans nothing for a user blocked by the admin', async () => {
    const user = await inactiveUser();
    await tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, user.userId));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT6c plans nothing once the account is revoked, the session staying on it', async () => {
    const user = await inactiveUser();
    await tmp.db
      .update(brokerAccounts)
      .set({ status: BrokerAccountStatus.Revoked })
      .where(eq(brokerAccounts.id, user.accountId));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT6d plans nothing while trading is closed', async () => {
    const user = await inactiveUser();
    await closeTradingSwitch(tmp.db);
    try {
      await planMailingJobs(tmp.db);
    } finally {
      await openTrading();
    }
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT7 plans nothing for a user who never ran a session', async () => {
    const user = await retained();
    await backdateAnalysis(user.userId, hours(100));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT8 CUT plans nothing for activity before the kind’s plans_from, and the job for activity after', async () => {
    await plansFromMinutesAgo(hours(100) + 30, KIND);
    try {
      const before = await inactiveUser(hours(100) + 40);
      const after = await inactiveUser(hours(100) + 20);
      await planMailingJobs(tmp.db);
      expect(await kindJobsOf(before.userId, KIND)).toEqual([]);
      expect(await kindJobsOf(after.userId, KIND)).toHaveLength(1);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });

  it('RT10 plans only the specific job in a pass where both are due, and nothing after it is sent', async () => {
    const user = await retained();
    await stoppedSession(user.accountId, { started: hours(100), ended: hours(100) - 1 });
    await planMailingJobs(tmp.db);
    expect((await jobsOf(user.userId)).map((job) => [job.kind, job.status])).toEqual([
      [NotificationKind.SessionIdle24h, NotificationJobStatus.Pending],
    ]);
    const [specific] = await jobsOf(user.userId);
    const { job } = await claimOnly(specific!.id);
    await settleMailingJob(tmp.db, job!.id, { kind: 'delivered' });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  // a sent tokens_out (#123) `sent` minutes ago at a balance of 0, so tokens_out_2d is coming
  const tokensOutSent = (userId: string, sent: number) =>
    insertJob(userId, NotificationKind.TokensOut, 'tokens:100', {
      status: NotificationJobStatus.Sent,
      minutes: sent,
    });

  it('RT10b plans nothing while a tokens_out_2d is coming, before it is due', async () => {
    const user = await inactiveUserAt0();
    await tokensOutSent(user.userId, hours(47));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RT10c plans once the coming tokens_out_2d no longer applies (a refill)', async () => {
    const user = await inactiveUserAt0();
    await tokensOutSent(user.userId, hours(47));
    await tmp.db.insert(tokenLedger).values({
      userId: user.userId,
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: 5n,
      note: 'retention test',
      createdAt: minutesAgo(hours(40)),
    });
    await planMailingJobs(tmp.db);
    expect(await pendingOf(user.userId, KIND)).toHaveLength(1);
  });

  it('RT10d is not held by a session_idle_24h its cutoff never plans', async () => {
    await plansFromMinutesAgo(hours(90), NotificationKind.SessionIdle24h);
    try {
      const user = await retained();
      await stoppedSession(user.accountId, { started: hours(100), ended: hours(100) - 1 });
      await planMailingJobs(tmp.db);
      expect((await jobsOf(user.userId)).map((job) => [job.kind, job.status])).toEqual([
        [KIND, NotificationJobStatus.Pending],
      ]);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });

  // a job of the current spell written past the planner, as one planned before a specific one; its
  // session starts and stops at one moment, so the key is the same whether the activity counts the
  // session's start or its end
  async function insertInactiveJob(userId: string, sessionId: string): Promise<string> {
    const [job] = await tmp.db
      .insert(notificationJobs)
      .values({
        userId,
        kind: KIND,
        dedupeKey: sql`(select 'inactive_3d:' || extract(epoch from ${tradingSessions.endedAt})::text
          from ${tradingSessions} where ${tradingSessions.id} = ${sessionId})`,
        scheduledAt: minutesAgo(hours(28)),
      })
      .returning({ id: notificationJobs.id });
    return job!.id;
  }

  it('RT11 cancels a planned job once the specific one was sent in an earlier claim', async () => {
    const user = await retained();
    const session = await stoppedSession(user.accountId, { started: hours(100), ended: hours(100) });
    const inactive = await insertInactiveJob(user.userId, session.id);
    const specific = await insertJob(user.userId, NotificationKind.SessionIdle24h, `session_idle:${session.id}`, {
      status: NotificationJobStatus.Pending,
      minutes: hours(76),
    });
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Failed })
      .where(
        and(
          eq(notificationJobs.status, NotificationJobStatus.Pending),
          ne(notificationJobs.userId, user.userId),
        ),
      );
    const first = await claimMailingJob(tmp.db, { scan: 1 });
    expect([first.job?.id, first.canceled]).toEqual([specific.id, 0]);
    await settleMailingJob(tmp.db, specific.id, { kind: 'delivered' });
    expect(await claimMailingJob(tmp.db, { scan: 1 })).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(inactive)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('RT11b cancels a planned job in the scan that claims the pending specific one', async () => {
    const user = await retained();
    const session = await stoppedSession(user.accountId, { started: hours(100), ended: hours(100) });
    const inactive = await insertInactiveJob(user.userId, session.id);
    await insertJob(user.userId, NotificationKind.SessionIdle24h, `session_idle:${session.id}`, {
      status: NotificationJobStatus.Pending,
      minutes: hours(76),
    });
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Failed })
      .where(
        and(
          eq(notificationJobs.status, NotificationJobStatus.Pending),
          ne(notificationJobs.userId, user.userId),
        ),
      );
    const { job, canceled } = await claimMailingJob(tmp.db, { scan: SCAN });
    expect([job?.kind, canceled]).toEqual([NotificationKind.SessionIdle24h, 1]);
    expect((await jobRow(inactive)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('RT12 cancels a planned job at the claim while a specific one is coming', async () => {
    const user = await retained();
    const session = await stoppedSession(user.accountId, { started: hours(100), ended: hours(100) });
    const inactive = await insertInactiveJob(user.userId, session.id);
    expect(await claimOnly(inactive)).toEqual({ job: undefined, canceled: 1 });
  });

  it('RT13 is not held by a newest session that was a real one: it has no session_idle_24h', async () => {
    const user = await retained();
    await stoppedSession(user.accountId, {
      started: hours(100),
      ended: hours(100) - 1,
      mode: TradeMode.Real,
    });
    await planMailingJobs(tmp.db);
    expect((await jobsOf(user.userId)).map((job) => [job.kind, job.status])).toEqual([
      [KIND, NotificationJobStatus.Pending],
    ]);
  });

  it('RT9 plans one job when two planners run at the same time', async () => {
    const user = await inactiveUser();
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    expect(await kindJobsOf(user.userId, KIND)).toHaveLength(1);
  });
});

describe('retention: session_idle_24h', () => {
  retentionSetup();
  const KIND = NotificationKind.SessionIdle24h;

  async function idleUser(
    ended = hours(24) + 1,
    settings: unknown = sessionSettings({ durationSec: 5 }),
  ) {
    const user = await retained();
    const session = await stoppedSession(user.accountId, { started: ended + 30, ended, settings });
    return { ...user, session };
  }

  it('RS1 plans one job 24 h after the newest session stopped, with its pair and settled trades, and nothing at 23 h', async () => {
    const due = await idleUser();
    for (const profit of ['1', '2', '-1', '0']) {
      await trade(due, { createdAt: sql`now()`, sessionId: due.session.id, profit });
    }
    await trade(due, {
      createdAt: sql`now()`,
      sessionId: due.session.id,
      status: TradeIntentStatus.Rejected,
    });
    const early = await idleUser(hours(23));
    await planMailingJobs(tmp.db);

    const jobs = await kindJobsOf(due.userId, KIND);
    expect(jobs.map((job) => [job.status, job.dedupeKey, job.payload])).toEqual([
      [
        NotificationJobStatus.Pending,
        `session_idle:${due.session.id}`,
        { assetId: 101, durationSec: 5, settled: 4, won: 2, lost: 1, tied: 1 },
      ],
    ]);
    expect(jobs[0]!.scheduledAt.getTime()).toBe(due.session.endedAt!.getTime() + 24 * 3_600_000);
    expect(await kindJobsOf(early.userId, KIND)).toEqual([]);
  });

  it('RS1b counts only the newest session’s trades', async () => {
    const user = await retained();
    const older = await stoppedSession(user.accountId, { started: hours(50), ended: hours(49) });
    const newest = await stoppedSession(user.accountId, { started: hours(26), ended: hours(25) });
    await trade(user, { createdAt: sql`now()`, sessionId: older.id, profit: '-1' });
    await trade(user, { createdAt: sql`now()`, sessionId: older.id, profit: '-1' });
    await trade(user, { createdAt: sql`now()`, sessionId: newest.id, profit: '1' });
    await planMailingJobs(tmp.db);
    expect((await kindJobsOf(user.userId, KIND)).map((job) => job.payload)).toEqual([
      { assetId: 101, durationSec: 5, settled: 1, won: 1, lost: 0, tied: 0 },
    ]);
  });

  it('RS2 plans nothing while the newest session runs, however long ago an older one stopped', async () => {
    const user = await retained();
    await stoppedSession(user.accountId, { started: hours(31), ended: hours(30) });
    await seedTradingSession(tmp.db, user.accountId);
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RS3 cancels at the claim a job whose user started a session after it was planned', async () => {
    const user = await idleUser();
    await planMailingJobs(tmp.db);
    const [planned] = await kindJobsOf(user.userId, KIND);
    await seedTradingSession(tmp.db, user.accountId);
    expect(await claimOnly(planned!.id)).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(planned!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('RS3b cancels at the claim a job whose user started a real session after it was planned', async () => {
    const user = await idleUser();
    await planMailingJobs(tmp.db);
    const [planned] = await kindJobsOf(user.userId, KIND);
    await stoppedSession(user.accountId, { started: 10, ended: 5, mode: TradeMode.Real });
    expect(await claimOnly(planned!.id)).toEqual({ job: undefined, canceled: 1 });
  });

  it('RS8 plans nothing for a demo user whose newest session, stopped 24 h ago, was a real one', async () => {
    const user = await retained();
    const real = await stoppedSession(user.accountId, {
      started: hours(24) + 31,
      ended: hours(24) + 1,
      mode: TradeMode.Real,
    });
    await trade(user, { createdAt: sql`now()`, sessionId: real.id, mode: TradeMode.Real });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RS8b plans nothing for an older demo session when a real one started since', async () => {
    const user = await retained();
    await stoppedSession(user.accountId, { started: hours(31), ended: hours(30) });
    await stoppedSession(user.accountId, {
      started: hours(26),
      ended: hours(25),
      mode: TradeMode.Real,
    });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RS4 carries no pair when the session’s settings do not name it', async () => {
    const user = await idleUser(hours(24) + 1, { durationSec: 5 });
    await planMailingJobs(tmp.db);
    expect((await kindJobsOf(user.userId, KIND)).map((job) => job.payload)).toEqual([
      { assetId: null, durationSec: 5, settled: 0, won: 0, lost: 0, tied: 0 },
    ]);
  });

  it('RS5a plans nothing for a user in real mode', async () => {
    const user = await idleUser();
    await setTradingMode(tmp.db, user.telegramUserId, TradeMode.Real);
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RS5b plans nothing for a user blocked by the admin', async () => {
    const user = await idleUser();
    await tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, user.userId));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RS5c plans nothing once the account is revoked, the session staying on it', async () => {
    const user = await idleUser();
    await tmp.db
      .update(brokerAccounts)
      .set({ status: BrokerAccountStatus.Revoked })
      .where(eq(brokerAccounts.id, user.accountId));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RS5d plans nothing while trading is closed', async () => {
    const user = await idleUser();
    await closeTradingSwitch(tmp.db);
    try {
      await planMailingJobs(tmp.db);
    } finally {
      await openTrading();
    }
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RS6 CUT plans nothing for a session stopped before the kind’s plans_from, and the job for one after', async () => {
    await plansFromMinutesAgo(hours(30), KIND);
    try {
      const before = await idleUser(hours(30) + 10);
      const after = await idleUser(hours(30) - 10);
      await planMailingJobs(tmp.db);
      expect(await kindJobsOf(before.userId, KIND)).toEqual([]);
      expect(await kindJobsOf(after.userId, KIND)).toHaveLength(1);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });

  it('RS7 plans one job when two planners run at the same time', async () => {
    const user = await idleUser();
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    expect(await kindJobsOf(user.userId, KIND)).toHaveLength(1);
  });
});

describe('retention: weekly_summary', () => {
  retentionSetup();
  const KIND = NotificationKind.WeeklySummary;

  const moment = (text: string) => sql`${text}::timestamptz`;
  const utcEpoch = (iso: string) => String(Date.parse(iso) / 1000);

  // The planner and the claim at a literal moment: the scenario built over it (weeklySummaryAt),
  // through the planner's own statement. A Wednesday of 2025, whose week no real clock sees as the
  // previous one, so a real-clock pass of another test plans nothing for these users.
  const NOW = '2025-10-22 12:00:00+00';
  const planWeekly = (now = NOW) => planMailingKind(tmp.db, KIND, weeklySummaryAt(moment(now)));
  // the claim's test of the job (appliesByKind) at `now`, under UTC: the zones are RW2's
  const appliesAt = (jobId: string, now: string) =>
    tmp.db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'UTC'`);
      const scenario = weeklySummaryAt(moment(now));
      const result = await tx.execute<{ applies: boolean }>(
        sql`select coalesce(${scenario.stillApplies} and ${scenario.keyApplies}, false) as applies
          from ${notificationJobs} join ${users} on ${users.id} = ${notificationJobs.userId}
          where ${notificationJobs.id} = ${jobId}`,
      );
      return result.rows[0]!.applies;
    });
  const weeklyPlansFrom = (at: string) =>
    tmp.db
      .update(notificationKinds)
      .set({ plansFrom: sql`${at}::timestamptz` })
      .where(eq(notificationKinds.kind, KIND));
  beforeAll(() => weeklyPlansFrom('2025-01-01 00:00:00+00'));

  // the anchor's instant, the key and whether the week is still the previous one at `now`, under
  // the session's time zone `zone`
  const weekOf = (zone: string, now: string) =>
    tmp.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local time zone '${zone}'`));
      const result = await tx.execute<{ at: string; key: string; timely: boolean }>(
        sql`select extract(epoch from ${weeklyAnchor(moment(now))} at time zone 'UTC')::bigint::text
            as at, ${weeklyKey(moment(now))} as key, ${weeklyTimely(moment(now))} as timely`,
      );
      return result.rows[0]!;
    });

  const PROBES = [
    ['2026-10-25 23:59:59+00', '2026-10-19T10:00:00Z', 'weekly_summary:2026-W42', true],
    ['2026-10-26 00:00:00+00', '2026-10-19T10:00:00Z', 'weekly_summary:2026-W42', false],
    ['2026-10-26 05:00:00+00', '2026-10-19T10:00:00Z', 'weekly_summary:2026-W42', false],
    ['2026-10-26 09:59:59+00', '2026-10-19T10:00:00Z', 'weekly_summary:2026-W42', false],
    ['2026-10-26 10:00:00+00', '2026-10-26T10:00:00Z', 'weekly_summary:2026-W43', true],
    ['2027-01-04 10:00:00+00', '2027-01-04T10:00:00Z', 'weekly_summary:2026-W53', true],
    ['2025-01-06 10:00:00+00', '2025-01-06T10:00:00Z', 'weekly_summary:2025-W01', true],
  ] as const;

  it('RW1 anchors on the latest passed Monday 10:00 UTC, keys the ISO week before it, and holds it until the next Monday 00:00', async () => {
    for (const [now, at, key, timely] of PROBES) {
      expect(await weekOf('UTC', now)).toEqual({ at: utcEpoch(at), key, timely });
    }
  });

  it('RW1r counts the ISO week before the anchor, Monday 00:00 in, the next Monday 00:00 out', async () => {
    const inside = await tmp.db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'UTC'`);
      const now = moment('2026-10-21 12:00:00+00');
      const result = await tx.execute<{ inside: boolean[] }>(
        sql`select array[
          ${weeklyRange(now, moment('2026-10-12 00:00:00+00'))},
          ${weeklyRange(now, moment('2026-10-18 23:59:59.999999+00'))},
          ${weeklyRange(now, moment('2026-10-19 00:00:00+00'))},
          ${weeklyRange(now, moment('2026-10-11 23:59:59.999999+00'))}] as inside`,
      );
      return result.rows[0]!.inside;
    });
    expect(inside).toEqual([true, true, false, false]);
  });

  it.each(['Europe/Moscow', 'America/Los_Angeles'])(
    'RW2 gives the same anchor, key and timeliness around Monday 00:00 and 10:00 UTC under %s',
    async (zone) => {
      for (const [now, at, key, timely] of PROBES.slice(0, 5)) {
        expect(await weekOf(zone, now)).toEqual({ at: utcEpoch(at), key, timely });
      }
    },
  );

  // a moment `minutes` after the start of the week summarised at `now`, through the anchor
  const inWeek = (minutes: number, now = NOW) =>
    sql`(${weeklyAnchor(moment(now))} - make_interval(hours => ${WEEKLY_SUMMARY_HOUR_UTC})
      - interval '7 days' + make_interval(mins => ${minutes})) at time zone 'UTC'`;

  it('RW3 plans one job with the week’s settled demo trades, under the week’s key', async () => {
    const user = await retained();
    for (const profit of ['1', '3', '-1', '0']) {
      await trade(user, { createdAt: inWeek(hours(24)), profit });
    }
    await trade(user, { createdAt: inWeek(hours(24)), status: TradeIntentStatus.Rejected });
    await trade(user, { createdAt: inWeek(hours(24)), mode: TradeMode.Real });
    await trade(user, { createdAt: inWeek(-hours(24)) });
    await planWeekly();

    const jobs = await kindJobsOf(user.userId, KIND);
    expect(jobs.map((job) => [job.status, job.dedupeKey, job.payload])).toEqual([
      [NotificationJobStatus.Pending, 'weekly_summary:2025-W42', { settled: 4, won: 2, lost: 1, tied: 1 }],
    ]);
    const anchor = await tmp.db.execute<{ at: Date }>(
      sql`select ${weeklyAnchor(moment(NOW))} at time zone 'UTC' as at`,
    );
    expect(jobs[0]!.scheduledAt.getTime()).toBe(new Date(anchor.rows[0]!.at).getTime());
  });

  it('RW4 plans nothing without a settled demo trade in the week', async () => {
    const user = await retained();
    await trade(user, { createdAt: inWeek(-hours(24)) });
    await planWeekly();
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RW4b plans for one settled trade in the week', async () => {
    const user = await retained();
    await trade(user, { createdAt: inWeek(hours(24)), profit: '-1' });
    await planWeekly();
    expect((await kindJobsOf(user.userId, KIND)).map((job) => job.payload)).toEqual([
      { settled: 1, won: 0, lost: 1, tied: 0 },
    ]);
  });

  it('RW5a plans nothing for a user in real mode', async () => {
    const user = await retained({ tradingMode: TradeMode.Real });
    await trade(user, { createdAt: inWeek(hours(24)) });
    await planWeekly();
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RW5b plans nothing for a user blocked by the admin', async () => {
    const user = await retained();
    await trade(user, { createdAt: inWeek(hours(24)) });
    await tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, user.userId));
    await planWeekly();
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RW6 cancels at the claim a job of an earlier week still pending', async () => {
    const user = await retained();
    const job = await insertJob(user.userId, KIND, 'weekly_summary:2020-W01', {
      status: NotificationJobStatus.Pending,
    });
    expect(await claimOnly(job.id)).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(job.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('RW7 CUT plans nothing for a week anchored before the kind’s plans_from', async () => {
    await weeklyPlansFrom('2025-10-20 10:00:01+00');
    try {
      const user = await retained();
      await trade(user, { createdAt: inWeek(hours(24)) });
      await planWeekly();
      expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
    } finally {
      await weeklyPlansFrom('2025-01-01 00:00:00+00');
    }
  });

  // two trades: one is RW4b's boundary
  it('RW8 plans one job when two planners run at the same time', async () => {
    const user = await retained();
    await trade(user, { createdAt: inWeek(hours(24)) });
    await trade(user, { createdAt: inWeek(hours(25)) });
    await Promise.all([planWeekly(), planWeekly()]);
    expect(await kindJobsOf(user.userId, KIND)).toHaveLength(1);
  });

  it('RW9 plans nothing on Monday before 10:00 UTC, and the week just ended at 10:00', async () => {
    const user = await retained();
    await trade(user, { createdAt: inWeek(hours(24)) });
    await trade(user, { createdAt: inWeek(hours(24) + 7 * hours(24)) });
    await trade(user, { createdAt: inWeek(hours(25) + 7 * hours(24)), profit: '-1' });
    await planWeekly('2025-10-27 05:00:00+00');
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
    await planWeekly('2025-10-27 10:00:00+00');
    expect((await kindJobsOf(user.userId, KIND)).map((job) => [job.dedupeKey, job.payload])).toEqual([
      ['weekly_summary:2025-W43', { settled: 2, won: 1, lost: 1, tied: 0 }],
    ]);
  });

  // two trades: one is RW4b's boundary
  it('RW10 cancels at the claim from the next Monday 00:00 UTC a job still pending', async () => {
    const user = await retained();
    await trade(user, { createdAt: inWeek(hours(24)) });
    await trade(user, { createdAt: inWeek(hours(25)) });
    await planWeekly();
    const [job] = await kindJobsOf(user.userId, KIND);
    expect(await appliesAt(job!.id, '2025-10-26 23:59:59+00')).toBe(true);
    expect(await appliesAt(job!.id, '2025-10-27 00:00:00+00')).toBe(false);
    expect(await appliesAt(job!.id, '2025-10-27 05:00:00+00')).toBe(false);
  });

  it('RW11 the engine plans and claims the scenario over now()', () => {
    const dialect = new PgDialect();
    const render = (scenario: MailingScenario) =>
      [scenario.facts, scenario.dedupeKey, scenario.payload!, scenario.stillApplies, scenario.keyApplies].map(
        (part) => dialect.sqlToQuery(part),
      );
    expect(render(MAILING_SCENARIOS[KIND])).toEqual(render(weeklySummaryAt(sql`now()`)));
  });
});

describe('retention: tokens_out_2d', () => {
  retentionSetup();
  const KIND = NotificationKind.TokensOut2d;

  // a linked user whose tokens_out (#123) was sent `sent` minutes ago, the balance `balance`
  async function outUser(sent: number, { balance = 0n }: { balance?: bigint } = {}) {
    const user = await linked(hours(100), { balance });
    const job = await insertJob(user.userId, NotificationKind.TokensOut, 'tokens:100', {
      status: NotificationJobStatus.Sent,
      minutes: sent,
    });
    return { ...user, sentAt: job.sentAt! };
  }

  const adjust = (userId: string, delta: bigint, createdAt: SQL) =>
    tmp.db.insert(tokenLedger).values({
      userId,
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: delta,
      note: 'retention test',
      createdAt,
    });

  it('RZ1 plans one job 48 h after the sent tokens_out at a balance of 0, and nothing at 47 h', async () => {
    const due = await outUser(hours(48) + 1);
    const early = await outUser(hours(47));
    await planMailingJobs(tmp.db);

    const jobs = await kindJobsOf(due.userId, KIND);
    expect(jobs.map((job) => [job.status, job.dedupeKey, job.payload])).toEqual([
      [NotificationJobStatus.Pending, 'tokens_out_2d', {}],
    ]);
    expect(jobs[0]!.scheduledAt.getTime()).toBe(due.sentAt.getTime() + 48 * 3_600_000);
    expect(await kindJobsOf(early.userId, KIND)).toEqual([]);
  });

  it('RZ2a plans nothing after a tokens_out that failed', async () => {
    const user = await linked(hours(100), { balance: 0n });
    await insertJob(user.userId, NotificationKind.TokensOut, 'tokens:100', {
      status: NotificationJobStatus.Failed,
      minutes: hours(49),
    });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RZ2b plans nothing after another nudge', async () => {
    const user = await linked(hours(100), { balance: 0n });
    await insertJob(user.userId, NotificationKind.TokensLow, 'tokens:80', {
      status: NotificationJobStatus.Sent,
      minutes: hours(49),
    });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RZ3 plans nothing, ever, once the balance moved after the send, even back to 0', async () => {
    const user = await outUser(hours(49));
    await adjust(user.userId, 50n, minutesAgo(hours(30)));
    await adjust(user.userId, -50n, minutesAgo(hours(20)));
    await planMailingJobs(tmp.db);
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RZ3b plans nothing once a credit made just before the send was spent after it', async () => {
    const user = await outUser(hours(49));
    await adjust(user.userId, 50n, sql`now() - make_interval(secs => ${hours(49) * 60 + 1})`);
    await adjust(user.userId, -50n, minutesAgo(hours(48)));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RZ4 plans nothing for a balance above 0', async () => {
    const user = await outUser(hours(49), { balance: 100n });
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RZ5 plans nothing for a user blocked by the admin', async () => {
    const user = await outUser(hours(49));
    await tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, user.userId));
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
  });

  it('RZ6 cancels at the claim a job whose user got tokens after it was planned', async () => {
    const user = await outUser(hours(49));
    await planMailingJobs(tmp.db);
    const [planned] = await kindJobsOf(user.userId, KIND);
    await adjust(user.userId, 50n, sql`now()`);
    await tmp.db.update(users).set({ tokenBalance: 50n }).where(eq(users.id, user.userId));
    expect(await claimOnly(planned!.id)).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(planned!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('RZ7 plans and claims the job of a user in real mode', async () => {
    const user = await outUser(hours(49));
    await setTradingMode(tmp.db, user.telegramUserId, TradeMode.Real);
    await planMailingJobs(tmp.db);
    const [planned] = await kindJobsOf(user.userId, KIND);
    expect((await claimOnly(planned!.id)).job).toMatchObject({ id: planned!.id, kind: KIND });
  });

  it('RZ8 plans nothing more once the job was sent', async () => {
    const user = await outUser(hours(49));
    await planMailingJobs(tmp.db);
    const [planned] = await kindJobsOf(user.userId, KIND);
    expect((await claimOnly(planned!.id)).job?.id).toBe(planned!.id);
    await planMailingJobs(tmp.db);
    expect((await kindJobsOf(user.userId, KIND)).map((job) => [job.id, job.status])).toEqual([
      [planned!.id, NotificationJobStatus.Sent],
    ]);
  });

  it('RZ9 CUT plans nothing for a send before the kind’s plans_from, and the job for one after', async () => {
    await plansFromMinutesAgo(hours(49), KIND);
    try {
      const before = await outUser(hours(50));
      const after = await outUser(hours(48) + 30);
      await planMailingJobs(tmp.db);
      expect(await kindJobsOf(before.userId, KIND)).toEqual([]);
      expect(await kindJobsOf(after.userId, KIND)).toHaveLength(1);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });

  it('RZ10 plans one job when two planners run at the same time', async () => {
    const user = await outUser(hours(49));
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    expect(await kindJobsOf(user.userId, KIND)).toHaveLength(1);
  });
});

describe('the help push (#879)', () => {
  retentionSetup();
  const KIND = NotificationKind.HelpLinks;
  const WITHOUT = Object.values(NotificationKind).filter((kind) => kind !== KIND);
  const OFFSET_MIN = HELP_LINKS_AFTER_MS / 60_000;

  const helpJobOf = async (userId: string) => {
    const [job, ...rest] = await kindJobsOf(userId, KIND);
    expect(rest).toEqual([]);
    return job;
  };

  it('HL1 plans one job HELP_LINKS_AFTER after the connect, under the constant key, and none before', async () => {
    const due = await linked(OFFSET_MIN + 1);
    const early = await linked(OFFSET_MIN - 1);
    await planMailingJobs(tmp.db);

    const jobs = await kindJobsOf(due.userId, KIND);
    expect(jobs.map((job) => [job.status, job.dedupeKey, job.payload])).toEqual([
      [NotificationJobStatus.Pending, 'help_links', {}],
    ]);
    expect(jobs[0]!.scheduledAt.getTime()).toBe(due.linkedAt.getTime() + HELP_LINKS_AFTER_MS);
    expect(await kindJobsOf(early.userId, KIND)).toEqual([]);
  });

  it('HL2 plans one job per user however many planners run, and none for a second account', async () => {
    const user = await linked(OFFSET_MIN + 1);
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    await seedBrokerAccount(tmp.db, user.userId);
    expect((await planMailingJobs(tmp.db))[KIND]).toBe(0);
    expect(await kindJobsOf(user.userId, KIND)).toHaveLength(1);
  });

  it('HL3 plans and claims the job of a user in real mode with a session: the links are for everyone', async () => {
    const user = await linked(OFFSET_MIN + 1);
    await setTradingMode(tmp.db, user.telegramUserId, TradeMode.Real);
    await seedTradingSession(tmp.db, user.accountId);
    await planMailingJobs(tmp.db);
    const job = await helpJobOf(user.userId);
    expect((await claimOnly(job!.id)).job).toMatchObject({ id: job!.id, kind: KIND });
  });

  it('HL4 plans nothing without an active account, and cancels at the claim once it is revoked', async () => {
    const revoke = (accountId: string) =>
      tmp.db
        .update(brokerAccounts)
        .set({ status: BrokerAccountStatus.Revoked })
        .where(eq(brokerAccounts.id, accountId));
    const never = await linked(OFFSET_MIN + 1);
    await revoke(never.accountId);
    const later = await linked(OFFSET_MIN + 1);
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(never.userId, KIND)).toEqual([]);

    const job = await helpJobOf(later.userId);
    await revoke(later.accountId);
    expect(await claimOnly(job!.id)).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(job!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('HL5 plans nothing for a user blocked by the admin, and cancels at the claim once blocked', async () => {
    const block = (userId: string) =>
      tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, userId));
    const never = await linked(OFFSET_MIN + 1);
    await block(never.userId);
    const later = await linked(OFFSET_MIN + 1);
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(never.userId, KIND)).toEqual([]);

    const job = await helpJobOf(later.userId);
    await block(later.userId);
    expect(await claimOnly(job!.id)).toEqual({ job: undefined, canceled: 1 });
  });

  it('HL6 plans nothing for a user at off or who blocked the bot', async () => {
    const off = await linked(OFFSET_MIN + 1);
    await setNotificationLevel(tmp.db, off.telegramUserId, NotificationLevel.Off);
    const unreachable = await linked(OFFSET_MIN + 1);
    await markTelegramBlocked(tmp.db, unreachable.telegramUserId);
    await planMailingJobs(tmp.db);
    expect(await kindJobsOf(off.userId, KIND)).toEqual([]);
    expect(await kindJobsOf(unreachable.userId, KIND)).toEqual([]);
  });

  it('HL7 is an ordinary kind: off cancels its pending job, reduced holds it for the window', async () => {
    const off = await linked(OFFSET_MIN + 1);
    const reduced = await linked(OFFSET_MIN + 1);
    await planMailingJobs(tmp.db);
    const offJob = await helpJobOf(off.userId);
    await setNotificationLevel(tmp.db, off.telegramUserId, NotificationLevel.Off);
    expect((await jobRow(offJob!.id)).status).toBe(NotificationJobStatus.Canceled);

    const job = await helpJobOf(reduced.userId);
    await setNotificationLevel(tmp.db, reduced.telegramUserId, NotificationLevel.Reduced);
    // another mailing sent inside the window
    await insertJob(reduced.userId, NotificationKind.AnalysisUnused, 'analysis_unused:1', {
      status: NotificationJobStatus.Sent,
      minutes: hours(1),
    });
    expect((await claimOnly(job!.id)).job).toBeUndefined();
    expect((await jobRow(job!.id)).status).toBe(NotificationJobStatus.Pending);
  });

  it('HL8 plans nothing for the kind when the process leaves it out of `kinds`', async () => {
    const user = await linked(OFFSET_MIN + 1);
    const planned = await planMailingJobs(tmp.db, { kinds: WITHOUT });
    expect(planned[KIND]).toBe(0);
    expect(await kindJobsOf(user.userId, KIND)).toEqual([]);
    expect((await planMailingJobs(tmp.db))[KIND]).toBeGreaterThanOrEqual(1);
    expect(await kindJobsOf(user.userId, KIND)).toHaveLength(1);
  });

  it('HL9 neither claims nor cancels a job of a kind left out of `kinds`; with it, claims it', async () => {
    const user = await linked(OFFSET_MIN + 1);
    await planMailingJobs(tmp.db);
    const job = await helpJobOf(user.userId);
    await setAsidePendingJobs(job!.id);
    // revoked: a claim that read the job would cancel it
    const revoked = await linked(OFFSET_MIN + 1);
    await planMailingJobs(tmp.db);
    const stale = await helpJobOf(revoked.userId);
    await tmp.db
      .update(brokerAccounts)
      .set({ status: BrokerAccountStatus.Revoked })
      .where(eq(brokerAccounts.id, revoked.accountId));
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Failed })
      .where(
        and(
          eq(notificationJobs.status, NotificationJobStatus.Pending),
          ne(notificationJobs.id, job!.id),
          ne(notificationJobs.id, stale!.id),
        ),
      );

    expect(await claimMailingJob(tmp.db, { scan: SCAN, kinds: WITHOUT })).toEqual({
      job: undefined,
      canceled: 0,
    });
    expect((await jobRow(job!.id)).status).toBe(NotificationJobStatus.Pending);
    expect((await jobRow(stale!.id)).status).toBe(NotificationJobStatus.Pending);

    const claimed = await claimMailingJob(tmp.db, { scan: SCAN });
    expect(claimed.job).toMatchObject({ id: job!.id, kind: KIND });
    expect(claimed.canceled).toBe(1);
  });

  it('HL10 CUT plans nothing for a connect before the kind’s plans_from, and the job for one after', async () => {
    await plansFromMinutesAgo(OFFSET_MIN + 30, KIND);
    try {
      const before = await linked(OFFSET_MIN + 40);
      const after = await linked(OFFSET_MIN + 20);
      await planMailingJobs(tmp.db);
      expect(await kindJobsOf(before.userId, KIND)).toEqual([]);
      expect(await kindJobsOf(after.userId, KIND)).toHaveLength(1);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });

  it('HL11 plans nothing more once the job was sent or canceled', async () => {
    const sent = await linked(OFFSET_MIN + 1);
    const canceled = await linked(OFFSET_MIN + 1);
    await planMailingJobs(tmp.db);
    const sentJob = await helpJobOf(sent.userId);
    expect((await claimOnly(sentJob!.id)).job?.id).toBe(sentJob!.id);
    const canceledJob = await helpJobOf(canceled.userId);
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.id, canceledJob!.id));

    expect((await planMailingJobs(tmp.db))[KIND]).toBe(0);
    expect((await kindJobsOf(sent.userId, KIND)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Sent,
    ]);
    expect((await kindJobsOf(canceled.userId, KIND)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Canceled,
    ]);
  });
});

describe('the demo-to-real chain (#880)', () => {
  retentionSetup();
  const [DR_1H, DR_24H, DR_72H] = DEMO_TO_REAL_CHAIN;
  const KINDS: NotificationKind[] = DEMO_TO_REAL_CHAIN.map((step) => step.kind);
  let bonusVersion = 100;

  // the user's chain jobs, in scheduled order
  const chainJobsOf = async (userId: string) =>
    (await jobsOf(userId)).filter((job) => KINDS.includes(job.kind));

  // A demo user whose DEMO_TO_REAL_SESSIONS-th stopped demo session ended `thirdEnded` minutes ago,
  // the earlier ones 20 and 10 minutes before it; `sessions` more or fewer, on `accountId`.
  async function demoUser(
    thirdEnded: number,
    {
      sessions = DEMO_TO_REAL_SESSIONS,
      tradingMode,
    }: { sessions?: number; tradingMode?: TradeMode } = {},
  ) {
    const user = await retained({ tradingMode });
    const ended: Date[] = [];
    for (let i = 0; i < sessions; i++) {
      const at = thirdEnded + (DEMO_TO_REAL_SESSIONS - 1 - i) * 10;
      const session = await stoppedSession(user.accountId, { started: at + 5, ended: at });
      ended.push(session.endedAt!);
    }
    return { ...user, thirdEndedAt: ended[DEMO_TO_REAL_SESSIONS - 1] };
  }

  const deposit = async (
    user: Retained,
    { attributed = true, status }: { attributed?: boolean; status?: DepositEventStatus } = {},
  ) => {
    const [account] = await tmp.db
      .select({ brokerUserId: brokerAccounts.brokerUserId })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, user.accountId));
    await tmp.db.insert(depositEvents).values({
      userId: attributed ? user.userId : null,
      brokerAccountId: attributed ? user.accountId : null,
      source: PostbackSource.Binodex,
      brokerUserId: account!.brokerUserId,
      paymentId: `dr-pay-${randomUUID()}`,
      amount: '10' as DecimalString,
      ...(status === undefined ? {} : { status }),
    });
  };

  const depositBonus = async (patch: {
    isActive?: boolean;
    kind?: BonusRuleKind;
    validTo?: SQL;
    params?: Record<string, unknown>;
  }) => {
    await tmp.db.insert(bonusRules).values({
      code: DEPOSIT_BONUS_RULE_CODE,
      version: ++bonusVersion,
      kind: patch.kind ?? BonusRuleKind.DepositBonus,
      isActive: patch.isActive ?? true,
      params: patch.params ?? DR_BONUS,
      ...(patch.validTo === undefined ? {} : { validTo: patch.validTo }),
    });
  };
  const DR_BONUS = { tokensPerUsd: '0.5', minAmountUsd: '10', maxTokens: '500' };
  const switchOffBonuses = () =>
    tmp.db
      .update(bonusRules)
      .set({ isActive: false })
      .where(eq(bonusRules.code, DEPOSIT_BONUS_RULE_CODE));

  const NO_TRADES = { sessions: 3, settled: 0, won: 0, lost: 0, tied: 0, profit: '0', bonus: null };

  it('DR1 plans the 1 h step an hour after the third demo session, with the facts, and nothing before', async () => {
    const due = await demoUser(hours(1) + 1);
    const early = await demoUser(hours(1) - 1);
    await planMailingJobs(tmp.db);

    const jobs = await chainJobsOf(due.userId);
    expect(jobs.map((job) => [job.kind, job.status, job.dedupeKey, job.payload])).toEqual([
      [DR_1H.kind, NotificationJobStatus.Pending, 'demo_to_real:1h', NO_TRADES],
    ]);
    expect(jobs[0]!.scheduledAt.getTime()).toBe(due.thirdEndedAt!.getTime() + 3_600_000);
    expect(await chainJobsOf(early.userId)).toEqual([]);
  });

  it('DR2 plans nothing with two stopped demo sessions, a real third one or a third still running', async () => {
    const two = await demoUser(hours(1) + 1, { sessions: 2 });
    const realThird = await demoUser(hours(1) + 30, { sessions: 2 });
    await stoppedSession(realThird.accountId, {
      started: hours(1) + 5,
      ended: hours(1) + 1,
      mode: TradeMode.Real,
    });
    const running = await demoUser(hours(1) + 30, { sessions: 2 });
    await seedTradingSession(tmp.db, running.accountId);
    await planMailingJobs(tmp.db);
    for (const user of [two, realThird, running]) {
      expect(await chainJobsOf(user.userId)).toEqual([]);
    }
  });

  it('DR3 counts from the third session: a fourth one moves nothing, and the facts count all four', async () => {
    const user = await demoUser(hours(1) + 30);
    await stoppedSession(user.accountId, { started: 10, ended: 5 });
    await planMailingJobs(tmp.db);
    const jobs = await chainJobsOf(user.userId);
    expect(jobs.map((job) => [job.kind, (job.payload as { sessions: number }).sessions])).toEqual([
      [DR_1H.kind, 4],
    ]);
    expect(jobs[0]!.scheduledAt.getTime()).toBe(user.thirdEndedAt!.getTime() + 3_600_000);
  });

  it('DR4 plans nothing after a deposit of any status, cancels at the claim once one is recorded, and ignores an unattributed one', async () => {
    const paid = await demoUser(hours(1) + 1);
    await deposit(paid, { status: DepositEventStatus.Ignored });
    const later = await demoUser(hours(1) + 1);
    const unattributed = await demoUser(hours(1) + 1);
    await deposit(unattributed, { attributed: false });
    await planMailingJobs(tmp.db);
    expect(await chainJobsOf(paid.userId)).toEqual([]);
    expect(await chainJobsOf(unattributed.userId)).toHaveLength(1);

    const [job] = await chainJobsOf(later.userId);
    await deposit(later);
    expect(await claimOnly(job!.id)).toEqual({ job: undefined, canceled: 1 });
    expect((await jobRow(job!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('DR5 a step is stale once the next is due: only the latest is planned, and a pending earlier one is canceled', async () => {
    const at25h = await demoUser(hours(25));
    const at73h = await demoUser(hours(73));
    await planMailingJobs(tmp.db);
    expect((await chainJobsOf(at25h.userId)).map((job) => job.kind)).toEqual([DR_24H.kind]);
    expect((await chainJobsOf(at73h.userId)).map((job) => job.kind)).toEqual([DR_72H.kind]);

    const stale = await demoUser(hours(25));
    const job = await insertJob(stale.userId, DR_1H.kind, 'demo_to_real:1h', {
      status: NotificationJobStatus.Pending,
    });
    expect(await claimOnly(job.id)).toEqual({ job: undefined, canceled: 1 });
  });

  it('DR6a plans nothing for a user blocked by the admin, and cancels at the claim once blocked', async () => {
    const block = (userId: string) =>
      tmp.db.update(users).set({ status: UserStatus.Blocked }).where(eq(users.id, userId));
    const never = await demoUser(hours(1) + 1);
    await block(never.userId);
    const later = await demoUser(hours(1) + 1);
    await planMailingJobs(tmp.db);
    expect(await chainJobsOf(never.userId)).toEqual([]);
    const [job] = await chainJobsOf(later.userId);
    await block(later.userId);
    expect(await claimOnly(job!.id)).toEqual({ job: undefined, canceled: 1 });
  });

  it('DR6b plans nothing without an active account, and cancels at the claim once it is revoked', async () => {
    const revoke = (accountId: string) =>
      tmp.db
        .update(brokerAccounts)
        .set({ status: BrokerAccountStatus.Revoked })
        .where(eq(brokerAccounts.id, accountId));
    const never = await demoUser(hours(1) + 1);
    await revoke(never.accountId);
    const later = await demoUser(hours(1) + 1);
    await planMailingJobs(tmp.db);
    expect(await chainJobsOf(never.userId)).toEqual([]);
    const [job] = await chainJobsOf(later.userId);
    await revoke(later.accountId);
    expect(await claimOnly(job!.id)).toEqual({ job: undefined, canceled: 1 });
  });

  it('DR6c plans nothing while trading is switched off, and cancels at the claim', async () => {
    const never = await demoUser(hours(1) + 1);
    await closeTradingSwitch(tmp.db);
    try {
      await planMailingJobs(tmp.db);
    } finally {
      await openTrading();
    }
    expect(await chainJobsOf(never.userId)).toEqual([]);

    await planMailingJobs(tmp.db);
    const [job] = await chainJobsOf(never.userId);
    await closeTradingSwitch(tmp.db);
    try {
      expect(await claimOnly(job!.id)).toEqual({ job: undefined, canceled: 1 });
    } finally {
      await openTrading();
    }
  });

  it('DR7 the bonus is the active deposit_bonus version’s params; inactive, expired or of another kind is none', async () => {
    const bonusOf = async (setUp: () => Promise<unknown>) => {
      const user = await demoUser(hours(1) + 1);
      await setUp();
      try {
        await planMailingJobs(tmp.db);
      } finally {
        await switchOffBonuses();
      }
      const [job] = await chainJobsOf(user.userId);
      return (job!.payload as { bonus: unknown }).bonus;
    };
    // every case runs before the one assertion: a failing case leaves no deposit_bonus version of
    // its own as the code's newest, so the later cases read what they would anyway
    const bonuses = [
      await bonusOf(() => depositBonus({})),
      await bonusOf(() => depositBonus({ isActive: false })),
      await bonusOf(() => depositBonus({ validTo: sql`now() - interval '1 minute'` })),
      await bonusOf(() =>
        depositBonus({ kind: BonusRuleKind.LinkBonus, params: { tokens: '100' } }),
      ),
      await bonusOf(async () => {}),
    ];
    expect(bonuses).toEqual([DR_BONUS, null, null, null, null]);
  });

  it('DR8 plans for a user in real mode as well: the chain is about the deposit, not the mode', async () => {
    const user = await demoUser(hours(1) + 1, { tradingMode: TradeMode.Real });
    await planMailingJobs(tmp.db);
    expect((await chainJobsOf(user.userId)).map((job) => job.kind)).toEqual([DR_1H.kind]);
  });

  it('DR9 CUT plans nothing for a third session that ended before plans_from, even with a fourth after', async () => {
    await plansFromMinutesAgo(hours(1) + 30, DR_1H.kind);
    try {
      const before = await demoUser(hours(1) + 40);
      await stoppedSession(before.accountId, { started: hours(1) + 10, ended: hours(1) + 5 });
      const after = await demoUser(hours(1) + 20);
      await planMailingJobs(tmp.db);
      expect(await chainJobsOf(before.userId)).toEqual([]);
      expect(await chainJobsOf(after.userId)).toHaveLength(1);
    } finally {
      await plansFromMinutesAgo(hours(200));
    }
  });

  it('DR10a is an ordinary kind under reduced: another mailing inside the window holds the step', async () => {
    const user = await demoUser(hours(1) + 1);
    await planMailingJobs(tmp.db);
    const [job] = await chainJobsOf(user.userId);
    await setNotificationLevel(tmp.db, user.telegramUserId, NotificationLevel.Reduced);
    await insertJob(user.userId, NotificationKind.AnalysisUnused, 'analysis_unused:dr', {
      status: NotificationJobStatus.Sent,
      minutes: hours(1),
    });
    expect((await claimOnly(job!.id)).job).toBeUndefined();
    expect((await jobRow(job!.id)).status).toBe(NotificationJobStatus.Pending);
  });

  it('DR10b off cancels the pending step and plans nothing', async () => {
    const user = await demoUser(hours(1) + 1);
    const never = await demoUser(hours(1) + 1);
    await setNotificationLevel(tmp.db, never.telegramUserId, NotificationLevel.Off);
    await planMailingJobs(tmp.db);
    expect(await chainJobsOf(never.userId)).toEqual([]);
    const [job] = await chainJobsOf(user.userId);
    await setNotificationLevel(tmp.db, user.telegramUserId, NotificationLevel.Off);
    expect((await jobRow(job!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('DR10c a user who blocked the bot gets nothing, and the pending step is canceled', async () => {
    const user = await demoUser(hours(1) + 1);
    const never = await demoUser(hours(1) + 1);
    await markTelegramBlocked(tmp.db, never.telegramUserId);
    await planMailingJobs(tmp.db);
    expect(await chainJobsOf(never.userId)).toEqual([]);
    const [job] = await chainJobsOf(user.userId);
    await markTelegramBlocked(tmp.db, user.telegramUserId);
    expect((await jobRow(job!.id)).status).toBe(NotificationJobStatus.Canceled);
  });

  it('DR11 one chain per user: sessions of a second account count, and a canceled step is not planned again', async () => {
    const user = await demoUser(hours(1) + 30, { sessions: 2 });
    const second = await seedBrokerAccount(tmp.db, user.userId);
    await stoppedSession(second, { started: hours(1) + 5, ended: hours(1) + 1 });
    await Promise.all([planMailingJobs(tmp.db), planMailingJobs(tmp.db)]);
    const jobs = await chainJobsOf(user.userId);
    expect(jobs.map((job) => [job.kind, job.dedupeKey])).toEqual([[DR_1H.kind, 'demo_to_real:1h']]);
    await tmp.db
      .update(notificationJobs)
      .set({ status: NotificationJobStatus.Canceled })
      .where(eq(notificationJobs.id, jobs[0]!.id));
    expect((await planMailingJobs(tmp.db))[DR_1H.kind]).toBe(0);
  });

  it('DR12 sums the user’s settled demo trades, single and session ones, to the last digit', async () => {
    const user = await demoUser(hours(1) + 1);
    const [session] = await tmp.db
      .select({ id: tradingSessions.id })
      .from(tradingSessions)
      .where(eq(tradingSessions.brokerAccountId, user.accountId))
      .limit(1);
    await trade(user, { createdAt: sql`now()`, sessionId: session!.id, profit: '-1.7515' });
    await trade(user, { createdAt: sql`now()`, profit: '0.25' });
    await trade(user, { createdAt: sql`now()`, profit: '0' });
    await trade(user, { createdAt: sql`now()`, profit: '5', mode: TradeMode.Real });
    await trade(user, { createdAt: sql`now()`, status: TradeIntentStatus.Rejected });
    await planMailingJobs(tmp.db);
    const [job] = await chainJobsOf(user.userId);
    expect(job!.payload).toEqual({
      sessions: 3,
      settled: 3,
      won: 1,
      lost: 1,
      tied: 1,
      profit: '-1.50150000',
      bonus: null,
    });
  });

  // A payload that fails whenever Postgres computes it: the planner must leave a key that already
  // has a job out in WHERE, since the SELECT list is built before the conflict check. Only for
  // `userId`: tmp.db is shared by the file, so the trap must not reach another user.
  const trapped = (kind: NotificationKind, userId: string) => {
    const scenario = MAILING_SCENARIOS[kind];
    return planMailingKind(tmp.db, kind, {
      ...scenario,
      stillApplies: sql`(${scenario.stillApplies} and ${users.id} = ${userId})`,
      payload: sql`jsonb_build_object('n', 1 / (${users.id} is null)::int)`,
    });
  };

  it('DR13 the planner computes no payload for a key that already has a job', async () => {
    const user = await demoUser(hours(73));
    await planMailingJobs(tmp.db);
    expect((await chainJobsOf(user.userId)).map((job) => job.kind)).toEqual([DR_72H.kind]);
    expect(await trapped(DR_72H.kind, user.userId)).toBe(0);

    // a replansCanceled kind: a pending job leaves the key out as well
    const [, , OUT] = TOKEN_NUDGES;
    const spent = await linked(0, { balance: 0n });
    expect(await planMailingKind(tmp.db, OUT.kind)).toBeGreaterThanOrEqual(1);
    expect((await jobsOf(spent.userId)).map((job) => job.kind)).toContain(OUT.kind);
    expect(await trapped(OUT.kind, spent.userId)).toBe(0);
  });
});
