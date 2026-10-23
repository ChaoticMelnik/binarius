import { eq, sql } from 'drizzle-orm';
import { HttpError } from 'grammy';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BotLanguage,
  DepositModeSwitch,
  FIRST_SESSION_CHAIN,
  logOptions,
  NotificationKind,
  PostbackSource,
  TradeMode,
  type DecimalString,
  TOKEN_NUDGES,
  TokenLedgerKind,
  TradingSessionStatus,
  TradingSessionStopReason,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  depositEvents,
  MAILING_OUTCOME_UNKNOWN,
  NotificationJobStatus,
  notificationJobs,
  notificationKinds,
  referrals,
  tokenLedger,
  tradingSessions,
  users,
} from '@binarius/db';
import {
  bonusRuleRef,
  createTempDatabase,
  seedBrokerAccount,
  sessionSettings,
  seedTradingSession,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { captureApi, callsTo, inlineButtons, inlineRows, pushedText } from '../admin/testing';
import { createClientPush } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS, clientTextsOf } from '../auth/texts';
import { MAILING_SEND_PER_SECOND } from '../timing';
import { createMailingEngine, type MailingConfig } from './engine';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  // every kind plans for the accounts these cases backdate
  await tmp.db.update(notificationKinds).set({ plansFrom: sql`now() - interval '200 hours'` });
});
afterAll(() => tmp.drop());

// each case starts with no job waiting, so a claim can only take the case's own
beforeEach(async () => {
  await tmp.db
    .update(notificationJobs)
    .set({ status: NotificationJobStatus.Canceled })
    .where(eq(notificationJobs.status, NotificationJobStatus.Pending));
});

const PUSH_TOKEN = '123456:AA-mailing-push-token';
const CASHIER_URL = 'https://web.example/cashier';
const WARN = 40;
const ERROR = 50;

interface Linked {
  userId: string;
  telegramUserId: string;
  accountId: string;
}

// connected `minutes` ago: an active account and the starter pack's ledger row, backdated. The
// balance is the whole pack, so no low-token nudge (#123), or `balance`.
async function linked(minutes: number, balance = 100n): Promise<Linked> {
  const user = await seedUser(tmp.db, { balance });
  const accountId = await seedBrokerAccount(tmp.db, user.userId, { isPartnerClient: true });
  await tmp.db.insert(tokenLedger).values({
    userId: user.userId,
    kind: TokenLedgerKind.Bonus,
    balanceDelta: 100n,
    brokerAccountId: accountId,
    ...(await bonusRuleRef(tmp.db, 'link_bonus')),
    createdAt: sql`now() - make_interval(mins => ${minutes})`,
  });
  return { ...user, accountId };
}

// a user whose last step is due
const dueUser = () => linked(72 * 60 + 1);

// 'default': the engine's own clock, which the case then probes by stepping the wall clock
function engine(
  config: Partial<MailingConfig> = {},
  clock: { now: number } | 'default' = { now: 0 },
  sleep: (ms: number) => Promise<void> = async () => {},
) {
  const push = createClientPush({ token: PUSH_TOKEN });
  const captured = captureApi(push);
  const lines: string[] = [];
  const mailing = createMailingEngine({
    db: tmp.db,
    push,
    logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    config,
    cashierUrl: CASHIER_URL,
    ...(clock === 'default' ? {} : { now: () => clock.now }),
    sleep,
  });
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { mailing, captured, push, logs };
}

const jobsOf = (userId: string) =>
  tmp.db.select().from(notificationJobs).where(eq(notificationJobs.userId, userId));

const sendsTo = (calls: ReturnType<typeof captureApi>['calls'], telegramUserId: string) =>
  callsTo(calls, 'sendMessage').filter((call) => call.payload.chat_id === telegramUserId);

describe('the first-session chain through the engine', () => {
  it.each(FIRST_SESSION_CHAIN.map((step) => [step.kind, step.afterHours] as const))(
    'sends %s once, as Telegram HTML with the demo button',
    async (kind, afterHours) => {
      const user = await linked(afterHours * 60 + 1);
      const { mailing, captured } = engine();
      await mailing.planTick();
      await mailing.sendTick();
      await mailing.sendTick();

      const sends = sendsTo(captured.calls, user.telegramUserId);
      expect(sends).toHaveLength(1);
      const payload = sends[0]!.payload;
      const texts = {
        [NotificationKind.FirstSession1h]: CLIENT_TEXTS.firstSessionReminder1h,
        [NotificationKind.FirstSession24h]: CLIENT_TEXTS.firstSessionReminder24h,
        [NotificationKind.FirstSession72h]: CLIENT_TEXTS.firstSessionReminder72h,
      };
      expect(pushedText(payload)).toBe(texts[kind].value);
      expect(pushedText(payload)).toContain(`«${CLIENT_LABELS.demoButton}»`);
      expect(payload.parse_mode).toBe('HTML');
      expect(inlineButtons(payload)).toEqual([
        { text: CLIENT_LABELS.demoButton, callback_data: 'demo' },
      ]);
      const [job] = await jobsOf(user.userId);
      expect(job).toMatchObject({ kind, status: NotificationJobStatus.Sent, lastError: null });
      await mailing.stop();
    },
  );

  it('sends nothing to a user who started a session after the step was planned', async () => {
    const user = await dueUser();
    const { mailing, captured } = engine();
    await mailing.planTick();
    await seedTradingSession(tmp.db, user.accountId);
    await mailing.sendTick();
    expect(sendsTo(captured.calls, user.telegramUserId)).toEqual([]);
    expect((await jobsOf(user.userId)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Canceled,
    ]);
    await mailing.stop();
  });
});

// #484
describe('the analysis reminder through the engine', () => {
  // a demo user whose analysis of `pair` was 11 minutes ago, as setLastAnalysis writes it
  async function analysed(pair = { assetId: 202, durationSec: 5 }) {
    const user = await seedUser(tmp.db);
    await tmp.db
      .update(users)
      .set({
        lastAnalysisAt: sql`now() - interval '11 minutes'`,
        lastAnalysisAssetId: pair.assetId,
        lastAnalysisDurationSec: pair.durationSec,
      })
      .where(eq(users.id, user.userId));
    return user;
  }

  it('E1 sends one reminder, as Telegram HTML with the sound on and a new analysis of the pair', async () => {
    const user = await analysed();
    const { mailing, captured } = engine();
    await mailing.planTick();
    await mailing.sendTick();
    await mailing.planTick();
    await mailing.sendTick();

    const sends = sendsTo(captured.calls, user.telegramUserId);
    expect(sends).toHaveLength(1);
    const payload = sends[0]!.payload;
    expect(pushedText(payload)).toBe(CLIENT_TEXTS.analysisUnusedReminder.value);
    expect(payload.parse_mode).toBe('HTML');
    expect(payload).not.toHaveProperty('disable_notification');
    expect(inlineButtons(payload)).toEqual([
      { text: CLIENT_LABELS.newAnalysisButton, callback_data: 'demo:an:202:5' },
    ]);
    const [job] = await jobsOf(user.userId);
    expect(job).toMatchObject({
      kind: NotificationKind.AnalysisUnused,
      status: NotificationJobStatus.Sent,
      lastError: null,
    });
    await mailing.stop();
  });

  it('E2 a payload that does not build is logged as not built and retried, nothing is sent', async () => {
    const user = await analysed();
    const [row] = await tmp.db
      .insert(notificationJobs)
      .values({
        userId: user.userId,
        kind: NotificationKind.AnalysisUnused,
        dedupeKey: sql`(select 'analysis_unused:' || extract(epoch from ${users.lastAnalysisAt})::text
          from ${users} where ${users.id} = ${user.userId})`,
        payload: {},
        scheduledAt: sql`now() - interval '1 minute'`,
      })
      .returning({ id: notificationJobs.id });
    const { mailing, captured, logs } = engine();
    await mailing.sendTick();

    expect(sendsTo(captured.calls, user.telegramUserId)).toEqual([]);
    expect(logs().filter((line) => line.msg === 'mailing not built')).toMatchObject([
      { level: ERROR, jobId: row!.id, kind: NotificationKind.AnalysisUnused },
    ]);
    const [job] = await jobsOf(user.userId);
    expect(job).toMatchObject({ status: NotificationJobStatus.Pending, attempts: 1 });
    await mailing.stop();
  });
});

// #576
describe('the referral reward notification through the engine', () => {
  // an inviter whose invitee's activation granted `tokens` a minute ago, as grantReferralReward
  // writes it but with any amount
  async function rewarded(tokens: bigint) {
    const inviter = await seedUser(tmp.db);
    const invitee = await seedUser(tmp.db);
    const [referral] = await tmp.db
      .insert(referrals)
      .values({ inviteeUserId: invitee.userId, inviterUserId: inviter.userId })
      .returning({ id: referrals.id });
    const [reward] = await tmp.db
      .insert(tokenLedger)
      .values({
        userId: inviter.userId,
        kind: TokenLedgerKind.Bonus,
        balanceDelta: tokens,
        referralId: referral!.id,
        ...(await bonusRuleRef(tmp.db, 'referral_reward')),
        createdAt: sql`now() - interval '1 minute'`,
      })
      .returning({ id: tokenLedger.id });
    return { inviter, invitee, rewardId: reward!.id };
  }

  it('E-R1 sends one notification with the ledger row’s amount and the /invite button', async () => {
    // not the rule's 50: the amount must come from the row
    const { inviter, invitee } = await rewarded(75n);
    const { mailing, captured } = engine();
    await mailing.planTick();
    await mailing.sendTick();
    await mailing.planTick();
    await mailing.sendTick();

    const sends = sendsTo(captured.calls, inviter.telegramUserId);
    expect(sends).toHaveLength(1);
    const payload = sends[0]!.payload;
    expect(pushedText(payload)).toBe(CLIENT_TEXTS.referralRewarded({ rewardTokens: '75' }).value);
    expect(pushedText(payload)).toContain('+75');
    expect(pushedText(payload)).toContain(`«${CLIENT_LABELS.inviteMoreButton}»`);
    expect(payload.parse_mode).toBe('HTML');
    expect(payload).not.toHaveProperty('disable_notification');
    expect(inlineButtons(payload)).toEqual([
      { text: CLIENT_LABELS.inviteMoreButton, callback_data: 'cmd:invite' },
    ]);
    const [job] = await jobsOf(inviter.userId);
    expect(job).toMatchObject({
      kind: NotificationKind.ReferralRewarded,
      status: NotificationJobStatus.Sent,
      lastError: null,
    });
    expect(sendsTo(captured.calls, invitee.telegramUserId)).toEqual([]);
    await mailing.stop();
  });

  it('E-R2 a payload that does not build is logged as not built and retried, nothing is sent', async () => {
    const { inviter, rewardId } = await rewarded(50n);
    // the planner would write this key itself; the job is written first, with no payload
    const [row] = await tmp.db
      .insert(notificationJobs)
      .values({
        userId: inviter.userId,
        kind: NotificationKind.ReferralRewarded,
        dedupeKey: `referral_rewarded:${rewardId}`,
        payload: {},
        scheduledAt: sql`now() - interval '1 minute'`,
      })
      .returning({ id: notificationJobs.id });
    const { mailing, captured, logs } = engine();
    await mailing.sendTick();

    expect(sendsTo(captured.calls, inviter.telegramUserId)).toEqual([]);
    expect(logs().filter((line) => line.msg === 'mailing not built')).toMatchObject([
      { level: ERROR, jobId: row!.id, kind: NotificationKind.ReferralRewarded },
    ]);
    const [job] = await jobsOf(inviter.userId);
    expect(job).toMatchObject({ status: NotificationJobStatus.Pending, attempts: 1 });
    await mailing.stop();
  });
});

describe('the sender’s failures', () => {
  it('M7 marks a user who blocked the bot on 403, fails the job and cancels the rest', async () => {
    const user = await dueUser();
    const { mailing, captured } = engine();
    await mailing.planTick();
    const [other] = await tmp.db
      .insert(notificationJobs)
      .values({
        userId: user.userId,
        kind: NotificationKind.FirstSession72h,
        scheduledAt: sql`now() + interval '1 hour'`,
      })
      .returning({ id: notificationJobs.id });
    captured.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    await mailing.sendTick();

    const jobs = await jobsOf(user.userId);
    expect(jobs.find((job) => job.id !== other!.id)).toMatchObject({
      status: NotificationJobStatus.Failed,
      sentAt: null,
      attempts: 1,
      lastError: 'GrammyError:403',
    });
    expect(jobs.find((job) => job.id === other!.id)?.status).toBe(NotificationJobStatus.Canceled);
    const [row] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(row?.at).toBeInstanceOf(Date);
    await mailing.stop();
  });

  it('M8 puts the job back on 429 and sends nothing until Telegram’s pause has passed', async () => {
    const clock = { now: 1_000_000 };
    const first = await dueUser();
    const { mailing, captured } = engine({}, clock);
    await mailing.planTick();
    captured.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 30',
      parameters: { retry_after: 30 },
    });
    await mailing.sendTick();
    const [job] = await jobsOf(first.userId);
    expect(job).toMatchObject({
      status: NotificationJobStatus.Pending,
      sentAt: null,
      attempts: 0,
      lastError: 'GrammyError:429',
    });
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);

    captured.apiErrors.delete('sendMessage');
    const second = await dueUser();
    await mailing.planTick();
    clock.now += 29_999;
    await mailing.sendTick();
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);

    clock.now += 1;
    await mailing.sendTick();
    expect(sendsTo(captured.calls, second.telegramUserId)).toHaveLength(1);
    await mailing.stop();
  });

  it('M9 never sends again a job whose send ended without Telegram’s answer', async () => {
    const user = await dueUser();
    const { mailing, captured, logs } = engine();
    await mailing.planTick();
    captured.apiErrors.set(
      'sendMessage',
      new HttpError("Network request for 'sendMessage' failed!", new Error('timed out')),
    );
    await mailing.sendTick();
    captured.apiErrors.delete('sendMessage');
    await mailing.planTick();
    await mailing.sendTick();

    expect(sendsTo(captured.calls, user.telegramUserId)).toHaveLength(1);
    expect(await jobsOf(user.userId)).toMatchObject([
      { status: NotificationJobStatus.Sent, lastError: MAILING_OUTCOME_UNKNOWN },
    ]);
    const warned = logs().filter((entry) => entry.level === WARN);
    expect(warned.map((entry) => entry.transportError)).toEqual([{ name: 'Error' }]);
    // identity only: no message, no payload
    expect(JSON.stringify(warned)).not.toContain('timed out');
    await mailing.stop();
  });

  it('never sends again a job Telegram answered with a 5xx: it may have been delivered', async () => {
    const user = await dueUser();
    const { mailing, captured } = engine();
    await mailing.planTick();
    captured.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 502,
      description: 'Bad Gateway',
    });
    await mailing.sendTick();
    captured.apiErrors.delete('sendMessage');
    await mailing.planTick();
    await mailing.sendTick();

    expect(sendsTo(captured.calls, user.telegramUserId)).toHaveLength(1);
    expect(await jobsOf(user.userId)).toMatchObject([
      { status: NotificationJobStatus.Sent, attempts: 0, lastError: MAILING_OUTCOME_UNKNOWN },
    ]);
    await mailing.stop();
  });

  it('tries a job Telegram refused otherwise again later, counting the attempt', async () => {
    const user = await dueUser();
    const { mailing, captured } = engine();
    await mailing.planTick();
    captured.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });
    await mailing.sendTick();
    await mailing.sendTick();
    expect(sendsTo(captured.calls, user.telegramUserId)).toHaveLength(1);
    expect(await jobsOf(user.userId)).toMatchObject([
      { status: NotificationJobStatus.Pending, attempts: 1, lastError: 'GrammyError:400' },
    ]);
    await mailing.stop();
  });
});

// Fails every update of a `sent` row, which is what settleMailingJob writes, and nothing else the
// sender does: the claim updates `pending` rows, the 403 mark `users` and `pending` rows.
async function failingSettles<T>(run: () => Promise<T>): Promise<T> {
  await tmp.db.execute(sql`
    create function test_fail_settle() returns trigger language plpgsql as $$
    begin raise exception 'settle refused by the test'; end $$`);
  await tmp.db.execute(sql`
    create trigger test_fail_settle before update on notification_jobs
    for each row when (old.status = 'sent') execute function test_fail_settle()`);
  try {
    return await run();
  } finally {
    await tmp.db.execute(sql`drop trigger test_fail_settle on notification_jobs`);
    await tmp.db.execute(sql`drop function test_fail_settle()`);
  }
}

const notSettled = (logs: Record<string, unknown>[]) =>
  logs.filter((entry) => entry.level === ERROR && entry.msg === 'mailing not settled');

describe('a settle that fails', () => {
  it('still pauses for Telegram’s 429 and never sends the job again', async () => {
    const clock = { now: 1_000_000 };
    const first = await dueUser();
    const { mailing, captured, logs } = engine({}, clock);
    await mailing.planTick();
    captured.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 30',
      parameters: { retry_after: 30 },
    });
    await failingSettles(() => mailing.sendTick());
    captured.apiErrors.delete('sendMessage');

    const second = await dueUser();
    await mailing.planTick();
    await mailing.sendTick();
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);
    clock.now += 30_000;
    await mailing.sendTick();
    expect(sendsTo(captured.calls, second.telegramUserId)).toHaveLength(1);
    expect(sendsTo(captured.calls, first.telegramUserId)).toHaveLength(1);
    expect(await jobsOf(first.userId)).toMatchObject([
      { status: NotificationJobStatus.Sent, lastError: MAILING_OUTCOME_UNKNOWN },
    ]);
    const failed = notSettled(logs());
    expect(failed).toHaveLength(1);
    // identity only: neither the failed SQL nor the database's message
    expect(JSON.stringify(failed)).not.toContain('notification_jobs');
    expect(JSON.stringify(failed)).not.toContain('settle refused');
    await mailing.stop();
  });

  it('still marks a user who blocked the bot on 403', async () => {
    const user = await dueUser();
    const { mailing, captured, logs } = engine();
    await mailing.planTick();
    captured.apiErrors.set('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    await failingSettles(() => mailing.sendTick());

    const [row] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(row?.at).toBeInstanceOf(Date);
    expect(await jobsOf(user.userId)).toMatchObject([
      { status: NotificationJobStatus.Sent, lastError: MAILING_OUTCOME_UNKNOWN },
    ]);
    expect(notSettled(logs())).toHaveLength(1);
    await mailing.stop();
  });
});

describe('the rate', () => {
  it('M10 spaces the engine’s own sends 1000 / perSecond apart', async () => {
    for (let index = 0; index < 3; index += 1) await dueUser();
    const clock = { now: 0 };
    const { mailing, captured } = engine({ perSecond: 2 }, clock, async (ms) => {
      clock.now += ms;
    });
    const sentAt: number[] = [];
    captured.answers.set('sendMessage', () => {
      sentAt.push(clock.now);
      return { message_id: 1 };
    });
    await mailing.planTick();
    await mailing.sendTick();
    expect(sentAt.length).toBeGreaterThanOrEqual(3);
    expect(sentAt.map((at, index) => at - index * 500)).toEqual(sentAt.map(() => 0));
    await mailing.stop();
  });
});

// Date.now under the case's control, the way NTP steps a wall clock: moved by `offset`, and by
// `perRead` more on every read. Installed before the engine is built, so a clock the engine takes
// by reference is this one too.
function mockWallClock() {
  const start = Date.now();
  const wall = { offset: 0, perRead: 0 };
  let reads = 0;
  const spy = vi
    .spyOn(Date, 'now')
    .mockImplementation(() => start + wall.offset + wall.perRead * ++reads);
  return { wall, restore: () => spy.mockRestore() };
}

describe('the clock', () => {
  it('spaces the sends on a monotonic clock: a wall clock stepped back stretches no gap', async () => {
    await dueUser();
    await dueUser();
    const { wall, restore } = mockWallClock();
    try {
      const slept: number[] = [];
      const { mailing, captured } = engine({}, 'default', async (ms) => {
        slept.push(ms);
      });
      await mailing.planTick();
      wall.perRead = -60_000;
      await mailing.sendTick();
      expect(callsTo(captured.calls, 'sendMessage').length).toBeGreaterThanOrEqual(2);
      // the sleep returns at once, so each gap adds to the next: the n-th wait is at most n gaps,
      // where a wall clock stepped back 60 s on every read would ask for a minute more each time
      const gap = 1000 / MAILING_SEND_PER_SECOND;
      slept.forEach((ms, index) => expect(ms).toBeLessThanOrEqual((index + 1) * gap));
      await mailing.stop();
    } finally {
      restore();
    }
  });

  it('holds Telegram’s pause on a monotonic clock: a wall clock stepped on does not end it', async () => {
    await dueUser();
    const { wall, restore } = mockWallClock();
    try {
      const { mailing, captured } = engine({}, 'default');
      await mailing.planTick();
      captured.apiErrors.set('sendMessage', {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 30',
        parameters: { retry_after: 30 },
      });
      await mailing.sendTick();
      captured.apiErrors.delete('sendMessage');
      await dueUser();
      await mailing.planTick();
      wall.offset = 600_000;
      await mailing.sendTick();
      expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);
      await mailing.stop();
    } finally {
      restore();
    }
  });
});

describe('the tick’s log', () => {
  it('counts what Telegram answered apart: delivered, refused, deferred, retried, unknown', async () => {
    await dueUser();
    await dueUser();
    const { mailing, captured, logs } = engine();
    let call = 0;
    captured.answers.set('sendMessage', () => {
      call += 1;
      if (call === 2) {
        throw new HttpError("Network request for 'sendMessage' failed!", new Error('timed out'));
      }
      return { message_id: call };
    });
    await mailing.planTick();
    await mailing.sendTick();
    expect(logs().filter((entry) => entry.msg === 'mailing tick')).toMatchObject([
      { delivered: 1, refused: 0, deferred: 0, retry: 0, unknown: 1, canceled: 0 },
    ]);
    await mailing.stop();
  });
});

describe('a restart', () => {
  it('M11 sends every step once across a stop in the middle of a batch and a new engine', async () => {
    const users = [await dueUser(), await dueUser(), await dueUser()];
    const first = engine();
    await first.mailing.planTick();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.captured.answers.set('sendMessage', async () => {
      await held;
      return { message_id: 1 };
    });
    const tick = first.mailing.sendTick();
    await until('the first send to start', () => first.captured.calls.length === 1);
    let stopReturned = false;
    const stopped = first.mailing.stop().then(() => {
      stopReturned = true;
    });
    // a stop that did not wait would have returned by the time the check phase runs
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopReturned).toBe(false);
    release();
    await stopped;
    // stop() returned after the settle, not only after the send
    const target = users.find(
      (user) => user.telegramUserId === first.captured.calls[0]!.payload.chat_id,
    );
    expect(await jobsOf(target!.userId)).toMatchObject([
      { status: NotificationJobStatus.Sent, lastError: null },
    ]);
    await tick;
    expect(callsTo(first.captured.calls, 'sendMessage')).toHaveLength(1);

    const second = engine();
    await second.mailing.planTick();
    await second.mailing.sendTick();
    await second.mailing.sendTick();
    const sent = [...first.captured.calls, ...second.captured.calls];
    for (const user of users) expect(sendsTo(sent, user.telegramUserId)).toHaveLength(1);
    await second.mailing.stop();
  });
});

describe('the batch', () => {
  it('sends at most the batch in one tick and the rest in the next', async () => {
    const users = [await dueUser(), await dueUser(), await dueUser()];
    const { mailing, captured } = engine({ sendBatch: 2 });
    await mailing.planTick();
    await mailing.sendTick();
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(2);
    await mailing.sendTick();
    for (const user of users) expect(sendsTo(captured.calls, user.telegramUserId)).toHaveLength(1);
    await mailing.stop();
  });
});

// the message's sent_at, so the `reduced` window counts it
it('writes sent_at on the database clock', async () => {
  const user = await dueUser();
  const { mailing } = engine();
  await mailing.planTick();
  await mailing.sendTick();
  const [row] = await tmp.db
    .select({ recent: sql<boolean>`${notificationJobs.sentAt} > now() - interval '1 minute'` })
    .from(notificationJobs)
    .where(eq(notificationJobs.userId, user.userId));
  expect(row?.recent).toBe(true);
  await mailing.stop();
});

// #123
describe('the low-token nudge through the engine', () => {
  const [, LOW, OUT] = TOKEN_NUDGES;
  const seeded: string[] = [];
  const nudged = async (balance: bigint) => {
    const user = await linked(0, balance);
    seeded.push(user.userId);
    return user;
  };
  const setBalance = (userId: string, balance: bigint) =>
    tmp.db.update(users).set({ tokenBalance: balance }).where(eq(users.id, userId));
  // the planner takes a canceled nudge back: a later case's planTick must not reach these users
  afterEach(async () => {
    for (const userId of seeded.splice(0)) await setBalance(userId, 100n);
  });

  const cashierRows = [
    [{ text: CLIENT_LABELS.depositButton, web_app: { url: CASHIER_URL } }],
    [{ text: CLIENT_LABELS.buyButton, callback_data: 'buy' }],
  ];

  it.each([
    [LOW.kind, 20n, CLIENT_TEXTS.tokensLow({ nudgeTokens: '20' })],
    [OUT.kind, 0n, CLIENT_TEXTS.tokensOut({ nudgeTokens: '0' })],
  ] as const)('sends %s once, with the cashier and the purchase', async (kind, balance, text) => {
    const user = await nudged(balance);
    const { mailing, captured } = engine();
    await mailing.planTick();
    await mailing.sendTick();
    await mailing.planTick();
    await mailing.sendTick();

    const sends = sendsTo(captured.calls, user.telegramUserId);
    expect(sends).toHaveLength(1);
    const payload = sends[0]!.payload;
    expect(pushedText(payload)).toBe(text.value);
    expect(payload.parse_mode).toBe('HTML');
    expect(inlineRows(payload)).toEqual(cashierRows);
    expect((await jobsOf(user.userId)).map((job) => [job.kind, job.status])).toEqual([
      [kind, NotificationJobStatus.Sent],
    ]);
    await mailing.stop();
  });

  it('sends only the 100 % nudge after a jump from 51 to 0', async () => {
    const user = await nudged(51n);
    const { mailing, captured } = engine();
    await mailing.planTick();
    await setBalance(user.userId, 0n);
    await mailing.planTick();
    await mailing.sendTick();
    await mailing.planTick();
    await mailing.sendTick();

    const sends = sendsTo(captured.calls, user.telegramUserId);
    expect(sends.map((send) => pushedText(send.payload))).toEqual([
      CLIENT_TEXTS.tokensOut({ nudgeTokens: '0' }).value,
    ]);
    expect((await jobsOf(user.userId)).map((job) => job.kind)).toEqual([OUT.kind]);
    await mailing.stop();
  });

  it('cancels a nudge whose balance went back up, plans it again once spent, and sends it once', async () => {
    const user = await nudged(0n);
    const { mailing, captured } = engine();
    await mailing.planTick();
    await setBalance(user.userId, 80n);
    await mailing.sendTick();
    expect((await jobsOf(user.userId)).map((job) => job.status)).toEqual([
      NotificationJobStatus.Canceled,
    ]);

    await setBalance(user.userId, 0n);
    await mailing.planTick();
    await mailing.sendTick();
    await mailing.planTick();
    await mailing.sendTick();

    expect(sendsTo(captured.calls, user.telegramUserId)).toHaveLength(1);
    expect((await jobsOf(user.userId)).map((job) => [job.kind, job.status])).toEqual([
      [OUT.kind, NotificationJobStatus.Sent],
    ]);
    await mailing.stop();
  });
});

// #686: the message after the switch to real, in the user's language
describe('the real-mode notification through the engine', () => {
  let n = 0;
  async function switched(language: BotLanguage) {
    const user = await seedUser(tmp.db, { tradingMode: TradeMode.Real });
    const brokerUserId = `e-mr-trader-${String(++n)}`;
    const accountId = await seedBrokerAccount(tmp.db, user.userId, { brokerUserId });
    await tmp.db
      .update(users)
      .set({ language, realStake: '5' as DecimalString })
      .where(eq(users.id, user.userId));
    await tmp.db.insert(depositEvents).values({
      userId: user.userId,
      brokerAccountId: accountId,
      source: PostbackSource.Binodex,
      brokerUserId,
      paymentId: `e-mr-pay-${String(n)}`,
      amount: '10' as DecimalString,
      modeSwitch: DepositModeSwitch.Switched,
      modeSwitchAt: sql`now()`,
    });
    return user;
  }

  it.each([
    [BotLanguage.En, '⚙️ Trading mode', '🏠 Menu'],
    [BotLanguage.Ru, '⚙️ Режим торговли', '🏠 В меню'],
  ])(
    'E-MR sends one message in %s with the mode screen and the menu',
    async (language, mode, menu) => {
      const user = await switched(language);
      const { mailing, captured } = engine();
      await mailing.planTick();
      await mailing.sendTick();
      await mailing.sendTick();

      const sends = sendsTo(captured.calls, user.telegramUserId);
      expect(sends).toHaveLength(1);
      const payload = sends[0]!.payload;
      expect(pushedText(payload)).toBe(
        clientTextsOf(language).realModeByDeposit({ stake: '5.00000000' as DecimalString }).value,
      );
      expect(pushedText(payload)).toContain('$5.00');
      expect(payload.parse_mode).toBe('HTML');
      expect(inlineRows(payload)).toEqual([
        [
          { text: mode, callback_data: 'mode' },
          { text: menu, callback_data: 'menu' },
        ],
      ]);
      const jobs = (await jobsOf(user.userId)).filter(
        (job) => job.kind === NotificationKind.RealModeByDeposit,
      );
      expect(jobs.map((job) => [job.status, job.lastError])).toEqual([
        [NotificationJobStatus.Sent, null],
      ]);
    },
  );
});

// #124 (docs/mailing.md → Retention)
describe('the retention messages through the engine', () => {
  it('E-RT sends the last session’s result with «🔁 Запустить снова», the cycle door of its pair', async () => {
    const user = await seedUser(tmp.db);
    const accountId = await seedBrokerAccount(tmp.db, user.userId);
    // a session that stopped with no settled trade: the result still prints its zero counts
    await tmp.db.insert(tradingSessions).values({
      brokerAccountId: accountId,
      mode: TradeMode.Demo,
      settings: sessionSettings({ assetId: 202, durationSec: 5 }),
      status: TradingSessionStatus.Stopped,
      stopReason: TradingSessionStopReason.Completed,
      startedAt: sql`now() - interval '25 hours'`,
      endedAt: sql`now() - interval '24 hours 1 minute'`,
    });
    const { mailing, captured } = engine();
    await mailing.planTick();
    await mailing.sendTick();
    await mailing.sendTick();

    const sends = sendsTo(captured.calls, user.telegramUserId);
    expect(sends).toHaveLength(1);
    const payload = sends[0]!.payload;
    expect(pushedText(payload)).toBe(
      CLIENT_TEXTS.sessionIdleReminder({ result: '0 сделок — 0 в плюс, 0 в минус' }).value,
    );
    expect(payload.parse_mode).toBe('HTML');
    expect(inlineRows(payload)).toEqual([
      [{ text: '🔁 Запустить снова', callback_data: 'demo:l:202:5:n' }],
    ]);
    expect((await jobsOf(user.userId)).map((job) => [job.kind, job.status, job.lastError])).toEqual(
      [[NotificationKind.SessionIdle24h, NotificationJobStatus.Sent, null]],
    );
    await mailing.stop();
  });
});
