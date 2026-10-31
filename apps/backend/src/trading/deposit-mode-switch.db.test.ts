import { and, eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BotLanguage,
  AuditAction,
  DepositModeSwitch,
  logOptions,
  NotificationKind,
  NotificationLevel,
  PostbackSource,
  TradeMode,
  type DecimalString,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  auditLog,
  depositEvents,
  notificationJobs,
  planMailingJobs,
  recordPostback,
  stopUserSessions,
  users,
} from '@binarius/db';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { captureApi, callsTo, inlineRows, pushedText } from '../admin/testing';
import { createClientPush } from '../auth/client-push';
import { clientLabelsOf, clientTextsOf } from '../auth/texts';
import { createMailingEngine, type MailingEngine } from '../mailing/engine';
import { HELP_BANNER_PATH } from '../mailing/help-links';
import { createPhotoMedia } from '../mailing/photo-media';
import { createDepositModeSwitcher } from './deposit-mode-switch';

// the Russian texts, the language of every user these tests make (#633)
const RU_TEXTS = clientTextsOf(BotLanguage.Ru);
const RU_LABELS = clientLabelsOf(BotLanguage.Ru);

// #686: a deposit's postback to the message about the switch, through the real operations, the
// mailing engine and the captured Telegram API. No timers: each case drives the ticks itself.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const engines: MailingEngine[] = [];
// a woken pass must not run into the next case
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
});

let n = 0;

function setup({
  demoOnly = false,
  plan,
}: { demoOnly?: boolean; plan?: typeof planMailingJobs } = {}) {
  const push = createClientPush({ token: '123456:AA-deposit-mode-push' });
  const captured = captureApi(push);
  const logger = pino(logOptions('info'), { write: () => {} });
  const mailing = createMailingEngine({
    db: tmp.db,
    push,
    logger,
    cashierUrl: undefined,
    helpLinks: { channelUrl: undefined, reviewsUrl: undefined, managerUrl: undefined },
    photos: {
      help_banner: createPhotoMedia({ path: HELP_BANNER_PATH, name: 'help banner', logger }),
    },
    ...(plan === undefined ? {} : { plan }),
  });
  engines.push(mailing);
  const switcher = createDepositModeSwitcher({
    db: tmp.db,
    demoOnly,
    logger,
    onSwitched: () => mailing.wakePlan(),
  });
  return { mailing, switcher, captured };
}

// a demo user with an active account whose trader id the postbacks name
async function trader() {
  const user = await seedUser(tmp.db);
  const brokerUserId = `x-trader-${String(++n)}`;
  const accountId = await seedBrokerAccount(tmp.db, user.userId, { brokerUserId });
  return { ...user, accountId, brokerUserId };
}

const postback = (brokerUserId: string, paymentId: string, event: 'deposit' | 'ftd') =>
  recordPostback(tmp.db, {
    source: PostbackSource.Binodex,
    query: {
      event,
      id: `x-pb-${String(++n)}`,
      payment_id: paymentId,
      a: brokerUserId,
      amount: '25',
      coin: 'USD',
    },
    secretKeyId: '0123abcd',
  });

const modeOf = async (userId: string) =>
  (await tmp.db.select({ mode: users.tradingMode }).from(users).where(eq(users.id, userId)))[0]!
    .mode;
const jobsOf = (userId: string) =>
  tmp.db
    .select({ status: notificationJobs.status })
    .from(notificationJobs)
    .where(
      and(
        eq(notificationJobs.userId, userId),
        eq(notificationJobs.kind, NotificationKind.RealModeByDeposit),
      ),
    );
const sendsTo = (calls: ReturnType<typeof captureApi>['calls'], telegramUserId: string) =>
  callsTo(calls, 'sendMessage').filter((call) => call.payload.chat_id === telegramUserId);

// the tick switches and wakes the planner; the message goes out on the sender's tick
async function sendAfterSwitch(
  mailing: MailingEngine,
  userId: string,
  captured: ReturnType<typeof captureApi>,
) {
  await until(
    'the woken planner to plan the message',
    async () => (await jobsOf(userId)).length > 0,
  );
  await mailing.sendTick();
  return captured;
}

describe('the switch to real after a deposit, end to end (#686)', () => {
  it('X1 a deposit switches a demo user once, with one audit row and one message; its FTD adds nothing', async () => {
    const user = await trader();
    const { mailing, switcher, captured } = setup();
    const paymentId = `x-pay-${String(++n)}`;
    expect((await postback(user.brokerUserId, paymentId, 'deposit')).outcome).toBe('recorded');

    await switcher.tick();
    expect(await modeOf(user.userId)).toBe(TradeMode.Real);
    const audit = await tmp.db
      .select({ actorType: auditLog.actorType, payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, user.userId),
          eq(auditLog.action, AuditAction.TradingModeChanged),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorType).toBe('system');

    await sendAfterSwitch(mailing, user.userId, captured);
    const sends = sendsTo(captured.calls, user.telegramUserId);
    expect(sends).toHaveLength(1);
    expect(pushedText(sends[0]!.payload)).toBe(RU_TEXTS.realModeByDeposit({ stake: null }).value);
    expect(inlineRows(sends[0]!.payload)).toEqual([
      [
        { text: RU_LABELS.settingsModeButton, callback_data: 'mode' },
        { text: RU_LABELS.menuButton, callback_data: 'menu' },
      ],
    ]);

    expect((await postback(user.brokerUserId, paymentId, 'ftd')).outcome).toBe('repeated');
    await switcher.tick();
    await mailing.planTick();
    await mailing.sendTick();
    expect(sendsTo(captured.calls, user.telegramUserId)).toHaveLength(1);
    expect(
      await tmp.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.entityId, user.userId)),
    ).toHaveLength(1);
  });

  it('X2 a deposit during a session waits for its end, then switches and sends', async () => {
    const user = await trader();
    await seedTradingSession(tmp.db, user.accountId);
    const { mailing, switcher, captured } = setup();
    await postback(user.brokerUserId, `x-pay-${String(++n)}`, 'deposit');

    await switcher.tick();
    expect(await modeOf(user.userId)).toBe(TradeMode.Demo);
    expect(await jobsOf(user.userId)).toEqual([]);

    await stopUserSessions(tmp.db, { telegramUserId: user.telegramUserId });
    await switcher.tick();
    expect(await modeOf(user.userId)).toBe(TradeMode.Real);
    await sendAfterSwitch(mailing, user.userId, captured);
    expect(sendsTo(captured.calls, user.telegramUserId)).toHaveLength(1);
  });

  it('X3 with DEMO_ONLY the deposit is closed demo_only: no switch, no message', async () => {
    const user = await trader();
    const { mailing, switcher, captured } = setup({ demoOnly: true });
    const paymentId = `x-pay-${String(++n)}`;
    await postback(user.brokerUserId, paymentId, 'deposit');
    await switcher.tick();
    expect(await modeOf(user.userId)).toBe(TradeMode.Demo);
    const [row] = await tmp.db
      .select({ modeSwitch: depositEvents.modeSwitch })
      .from(depositEvents)
      .where(eq(depositEvents.paymentId, paymentId));
    expect(row?.modeSwitch).toBe(DepositModeSwitch.DemoOnly);
    await mailing.planTick();
    await mailing.sendTick();
    expect(sendsTo(captured.calls, user.telegramUserId)).toEqual([]);
  });

  it('X4 a user who turned notifications off still gets the message', async () => {
    const user = await trader();
    await tmp.db
      .update(users)
      .set({ notificationLevel: NotificationLevel.Off, realStake: '3' as DecimalString })
      .where(eq(users.id, user.userId));
    const { mailing, switcher, captured } = setup();
    await postback(user.brokerUserId, `x-pay-${String(++n)}`, 'deposit');
    await switcher.tick();
    await sendAfterSwitch(mailing, user.userId, captured);
    const sends = sendsTo(captured.calls, user.telegramUserId);
    expect(sends).toHaveLength(1);
    expect(pushedText(sends[0]!.payload)).toContain('$3.00');
  });

  it('X5 a switch committed during a planner pass in flight is planned by the pass the wake adds', async () => {
    const user = await trader();
    let first = true;
    let reached!: () => void;
    const reachedGate = new Promise<void>((resolve) => (reached = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { mailing, switcher, captured } = setup({
      plan: async (db) => {
        const planned = await planMailingJobs(db);
        if (first) {
          first = false;
          reached();
          await gate;
        }
        return planned;
      },
    });
    await postback(user.brokerUserId, `x-pay-${String(++n)}`, 'deposit');

    const inFlight = mailing.planTick();
    // the first pass has read every kind before the switch
    await reachedGate;
    await switcher.tick();
    expect(await modeOf(user.userId)).toBe(TradeMode.Real);
    expect(await jobsOf(user.userId)).toEqual([]);

    open();
    await inFlight;
    await until('the pass after the one in flight to plan the message', async () =>
      (await jobsOf(user.userId)).some((job) => job.status === 'pending'),
    );
    await mailing.sendTick();
    expect(sendsTo(captured.calls, user.telegramUserId)).toHaveLength(1);
    // no timer ran: neither engine nor switcher was started
    expect(
      (
        await tmp.db.execute<{ n: number }>(
          sql`select count(*)::int as n from notification_jobs where user_id = ${user.userId}`,
        )
      ).rows[0]?.n,
    ).toBe(1);
  });
});
