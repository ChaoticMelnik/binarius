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

function engine(config: Partial<MailingConfig> = {}, clock = { now: 0 }) {
  const push = createClientPush({ token: PUSH_TOKEN });
  const captured = captureApi(push);
  const lines: string[] = [];
  const mailing = createMailingEngine({
    db: tmp.db,
    push,
    logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    config,
    now: () => clock.now,
    sleep: async () => {},
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
    const stopped = first.mailing.stop();
    release();
    await Promise.all([tick, stopped]);
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
