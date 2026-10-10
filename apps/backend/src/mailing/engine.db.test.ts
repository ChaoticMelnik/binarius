import { eq, sql } from 'drizzle-orm';
import { HttpError } from 'grammy';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FIRST_SESSION_CHAIN,
  logOptions,
  NotificationKind,
  TokenLedgerKind,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  LINK_BONUS_RULE_CODE,
  MAILING_OUTCOME_UNKNOWN,
  NotificationJobStatus,
  notificationJobs,
  notificationKinds,
  tokenLedger,
  users,
} from '@binarius/db';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { captureApi, callsTo, inlineButtons } from '../admin/testing';
import { createClientPush } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';
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
const WARN = 40;
const ERROR = 50;

interface Linked {
  userId: string;
  telegramUserId: string;
  accountId: string;
}

// connected `minutes` ago: an active account and the starter pack's ledger row, backdated
async function linked(minutes: number): Promise<Linked> {
  const user = await seedUser(tmp.db);
  const accountId = await seedBrokerAccount(tmp.db, user.userId, { isPartnerClient: true });
  await tmp.db.insert(tokenLedger).values({
    userId: user.userId,
    kind: TokenLedgerKind.Bonus,
    balanceDelta: 100n,
    brokerAccountId: accountId,
    note: LINK_BONUS_RULE_CODE,
    createdAt: sql`now() - make_interval(mins => ${minutes})`,
  });
  return { ...user, accountId };
}

// a user whose last step is due
const dueUser = () => linked(72 * 60 + 1);

function engine(
  config: Partial<MailingConfig> = {},
  clock = { now: 0 },
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
    now: () => clock.now,
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
      expect(payload.text).toBe(texts[kind].value);
      expect(payload.text).toContain(`«${CLIENT_LABELS.demoButton}»`);
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
