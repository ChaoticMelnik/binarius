import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  cycleStakeLabel,
  DEMO_DURATION_LABELS,
  groupButtonLabel,
  inlineButtons,
  LABELS,
  pairButtonLabel,
  USER,
  type ApiCall,
} from '@binarius/bot/e2e';
import { OutboxTopic, readTokenBalance } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { MockTradeOutcome, type MockBroker } from '@binarius/mock-broker';
import {
  pairLabel,
  REFERRAL_CODE_LENGTH,
  REFERRAL_PAYLOAD_PREFIX,
  TokenLedgerKind,
  TRADING_INTENTS_DEAD_LETTER_QUEUE,
  TradeIntentStatus,
  TradeMode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type DecimalString,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import type { TradingWorker } from '@binarius/trading-worker/e2e';
import { startE2eBackend, type E2eBackend } from './harness/backend';
import { startE2eBot, type E2eBot } from './harness/bot';
import { startE2eBroker, tradesOf } from './harness/broker';
import { e2eReads } from './harness/db';
import {
  E2E_BROKER_USER_ID,
  E2E_EMAIL,
  E2E_PAIR,
  E2E_USER_B,
  E2E_USER_C,
  REDIS_URL,
  TEST_DATABASE_URL,
} from './harness/env';
import { logSink } from './harness/logs';
import { depositQuery, postback } from './harness/postbacks';
import { createTelegram } from './harness/telegram';
import { startE2eWorker } from './harness/worker';

// #106: the demo cycle's events delivered twice (docs/e2e-demo-cycle.md → Repeated events). The bot
// does not dedupe updates, so a repeat is held by the backend and the database; each oracle is a
// positive count read after the repeat, not "nothing changed" from an empty start.

const queuePrefix = `e2e-${randomBytes(4).toString('hex')}`;
const logs = { backend: logSink('backend'), worker: logSink('worker'), bot: logSink('bot') };
let tmp: TempDatabase;
let broker: MockBroker;
let backend: E2eBackend;
let worker: TradingWorker;
let bot: E2eBot;

beforeAll(async () => {
  tmp = await createTempDatabase(TEST_DATABASE_URL);
  broker = await startE2eBroker();
  const telegram = createTelegram();
  backend = await startE2eBackend({
    db: tmp.db,
    pool: tmp.pool,
    redisUrl: REDIS_URL,
    brokerUrl: broker.url,
    queuePrefix,
    logs: logs.backend,
    telegram,
  });
  worker = startE2eWorker({
    databaseUrl: tmp.url,
    redisUrl: REDIS_URL,
    backendUrl: backend.url,
    brokerUrl: broker.url,
    queuePrefix,
    logs: logs.worker,
  });
  bot = startE2eBot({ backendUrl: backend.url, logs: logs.bot, telegram });
});

// demo-cycle.db.test.ts's order: the bot's trackers, the worker, the backend's loops, the broker
afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };
  await step(async () => bot?.stop());
  await step(async () => {
    if (worker === undefined) return;
    const shutdown = await worker.shutdown('SIGTERM');
    if (shutdown !== 'clean') throw new Error(`the worker shutdown was ${shutdown}`);
  });
  await step(async () => backend?.stop());
  await step(async () => broker?.close());
  await step(async () => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    for (const name of [...Object.values(OutboxTopic), TRADING_INTENTS_DEAD_LETTER_QUEUE]) {
      const queue = new Queue(name, { connection: redis, prefix: queuePrefix });
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await redis.quit();
  });
  await step(async () => tmp?.drop());
  if (failures.length > 0) throw new AggregateError(failures, 'the teardown failed');
});

const MIN_STAKE = '1' as DecimalString;
const CYCLES = 5;

const labelsOf = (payload: Record<string, unknown> | undefined) =>
  inlineButtons(payload).map((button) => button.text);
const inChat = (calls: ApiCall[], chatId: number, method: string) =>
  calls.filter((call) => call.method === method && call.payload.chat_id === chatId);
const journalOf = (endpoint: string) =>
  broker.rest.journal.filter((record) => record.endpoint === endpoint);
const REFERRAL_PAYLOAD = new RegExp(
  `${REFERRAL_PAYLOAD_PREFIX}[A-Za-z0-9]{${REFERRAL_CODE_LENGTH}}`,
);

it('repeats the cycle events: /start, the login texts, the amount press, the postbacks', async () => {
  const reads = e2eReads(tmp.db);
  const telegramUserId = BigInt(USER.id);
  const botCalls = bot.telegram.calls;
  const lastIn = (chatId: number, method: string) => inChat(botCalls, chatId, method).at(-1);
  const userRow = async (id: number) => {
    const row = await reads.userRow(BigInt(id));
    if (row === undefined) throw new Error(`no users row for ${id}`);
    return row;
  };

  // S1 /start
  const s1 = await bot.start();
  expect(labelsOf(lastIn(USER.id, 'sendMessage')?.payload)).toContain(LABELS.connectButton);
  const user = await userRow(USER.id);
  expect(user).toMatchObject({ status: 'active', tokenBalance: 0n, acquisitionSource: null });

  // R1 the same /start again, then two first-touch payloads: the first one is kept
  const welcomes = inChat(botCalls, USER.id, 'sendMessage').length;
  await bot.replay(s1);
  expect(inChat(botCalls, USER.id, 'sendMessage')).toHaveLength(welcomes + 1);
  expect(labelsOf(lastIn(USER.id, 'sendMessage')?.payload)).toContain(LABELS.connectButton);
  expect(await userRow(USER.id)).toMatchObject({
    id: user.id,
    createdAt: user.createdAt,
    status: 'active',
    tokenBalance: 0n,
    acquisitionSource: null,
    acquiredAt: null,
  });
  expect(await reads.usersCount()).toBe(1);
  await bot.start('promo-a');
  const touched = await userRow(USER.id);
  expect(touched.acquisitionSource).toBe('promo-a');
  expect(touched.acquiredAt).toBeInstanceOf(Date);
  await bot.start('promo-b');
  expect(await userRow(USER.id)).toMatchObject({
    acquisitionSource: 'promo-a',
    acquiredAt: touched.acquiredAt,
  });
  expect(await reads.usersCount()).toBe(1);

  // S2 the address
  await bot.press(LABELS.connectButton);
  const address = await bot.send(E2E_EMAIL);
  const code = broker.oauth.codeFor(E2E_EMAIL);
  if (code === undefined) throw new Error('the broker sent no code');
  expect(journalOf('emailSendCode')).toHaveLength(1);

  // R3a the address again on the code step: one failed code attempt, no second email, the code
  // still good
  const beforeAddress = botCalls.length;
  await bot.replay(address);
  expect(journalOf('emailSendCode')).toHaveLength(1);
  expect(journalOf('emailLogin')).toHaveLength(1);
  expect(broker.oauth.codeFor(E2E_EMAIL)).toBe(code);
  expect(botCalls.length).toBeGreaterThan(beforeAddress);
  expect(labelsOf(lastIn(USER.id, 'sendMessage')?.payload)).toEqual(
    expect.arrayContaining([LABELS.resendButton, LABELS.changeEmailButton]),
  );

  // S3 the code: the account card
  const codeUpdate = await bot.send(code);
  const card = lastIn(USER.id, 'sendPhoto');
  expect(labelsOf(card?.payload)).toContain(LABELS.demoButton);
  const account = await reads.accountOf(user.id);
  if (account === undefined) throw new Error('no broker account');
  expect(account).toMatchObject({ status: 'active', brokerUserId: String(E2E_BROKER_USER_ID) });
  expect(journalOf('emailLogin')).toHaveLength(2);
  expect(await readTokenBalance(tmp.db, telegramUserId)).toMatchObject({
    balance: 100n,
    reserved: 0n,
  });

  // R3b the code again after the login: a text outside the dialog is ignored
  const beforeCode = botCalls.length;
  await bot.replay(codeUpdate);
  expect(botCalls).toHaveLength(beforeCode);
  expect(journalOf('emailLogin')).toHaveLength(2);
  expect(await reads.accountsOf(user.id)).toHaveLength(1);
  const bonuses = (await reads.ledgerOf(user.id)).filter(
    (row) => row.kind === TokenLedgerKind.Bonus,
  );
  expect(bonuses).toHaveLength(1);
  expect(await readTokenBalance(tmp.db, telegramUserId)).toMatchObject({
    balance: 100n,
    reserved: 0n,
  });

  // R2 B's invite link: A, who exists, gets no referral; C, new, gets one, and keeps it on a repeat
  await bot.startAs(E2E_USER_B);
  await bot.sendAs(E2E_USER_B, '/invite');
  const payload = JSON.stringify(lastIn(E2E_USER_B.id, 'sendMessage')?.payload).match(
    REFERRAL_PAYLOAD,
  )?.[0];
  if (payload === undefined) throw new Error("no invite link on B's screen");
  const userB = await userRow(E2E_USER_B.id);
  const cardsOfA = inChat(botCalls, USER.id, 'sendPhoto').length;
  await bot.start(payload);
  expect(inChat(botCalls, USER.id, 'sendPhoto')).toHaveLength(cardsOfA + 1);
  expect(await reads.referralsOf(userB.id)).toHaveLength(0);
  expect((await userRow(USER.id)).acquisitionSource).toBe('promo-a');
  const c1 = await bot.startAs(E2E_USER_C, payload);
  expect(labelsOf(lastIn(E2E_USER_C.id, 'sendMessage')?.payload)).toContain(LABELS.connectButton);
  const userC = await userRow(E2E_USER_C.id);
  expect(userC.acquisitionSource).toBe(payload);
  const [referral] = await reads.referralsOf(userB.id);
  expect(await reads.referralsOf(userB.id)).toEqual([
    expect.objectContaining({ inviteeUserId: userC.id }),
  ]);
  await bot.replay(c1);
  expect(await reads.referralsOf(userB.id)).toEqual([
    expect.objectContaining({ id: referral?.id, inviteeUserId: userC.id }),
  ]);
  expect(await reads.usersCount()).toBe(3);

  // R4 the broker's postbacks: a delivery, its re-delivery, a second event of the same payment,
  // and one more with another amount
  const keys = { id: 'e2e-pb-1', payment_id: 'e2e-pay-1', a: String(E2E_BROKER_USER_ID) };
  const deliveries = async () =>
    (await reads.deliveriesOf(keys.payment_id)).map((row) => [row.event, row.outcome]);
  expect(await postback(backend.url, depositQuery(keys))).toEqual({
    status: 200,
    body: { outcome: 'recorded' },
  });
  const [deposit] = await reads.depositsOf(keys.payment_id);
  expect(deposit).toMatchObject({
    status: 'received',
    brokerUserId: String(E2E_BROKER_USER_ID),
    userId: user.id,
    brokerAccountId: account.id,
    currency: 'USD',
  });
  expect(Number(deposit?.amount)).toBe(50);
  expect(await postback(backend.url, depositQuery(keys))).toEqual({
    status: 200,
    body: { outcome: 'duplicate' },
  });
  expect(await deliveries()).toEqual([['deposit', 'recorded']]);
  expect(
    await postback(backend.url, depositQuery({ ...keys, id: 'e2e-pb-2' }, { event: 'ftd' })),
  ).toEqual({ status: 200, body: { outcome: 'repeated' } });
  expect(await deliveries()).toEqual([
    ['deposit', 'recorded'],
    ['ftd', 'repeated'],
  ]);
  expect(await reads.depositsOf(keys.payment_id)).toEqual([
    expect.objectContaining({ id: deposit?.id }),
  ]);
  expect(
    await postback(backend.url, depositQuery({ ...keys, id: 'e2e-pb-3' }, { amount: '60' })),
  ).toEqual({ status: 200, body: { outcome: 'repeated' } });
  expect(await deliveries()).toHaveLength(3);
  const deposits = await reads.depositsOf(keys.payment_id);
  expect(deposits).toEqual([expect.objectContaining({ id: deposit?.id })]);
  expect(Number(deposits[0]?.amount)).toBe(50);
  const postbackIds = ['e2e-pb-1', 'e2e-pb-2', 'e2e-pb-3'];
  expect(
    logs.backend.lines
      .filter(
        (line) => line.msg === 'postback received' && postbackIds.includes(String(line.postbackId)),
      )
      .map((line) => line.outcome),
  ).toEqual(['recorded', 'duplicate', 'repeated', 'repeated']);
  const mismatched = logs.backend.lines.filter(
    (line) => line.msg === 'postback repeated with different fields',
  );
  expect(mismatched).toEqual([
    expect.objectContaining({ postbackId: 'e2e-pb-3', mismatch: ['amount'] }),
  ]);
  expect(mismatched[0]).not.toHaveProperty('amount');
  expect(await readTokenBalance(tmp.db, telegramUserId)).toMatchObject({
    balance: 100n,
    reserved: 0n,
  });
  expect(await reads.ledgerOf(user.id)).toHaveLength(1);

  // S4–S5 the manual door to the amount, which starts the session
  await bot.press(LABELS.demoButton);
  await bot.press(LABELS.demoManualButton);
  await bot.press(groupButtonLabel('currency', 1));
  await bot.press(pairButtonLabel(pairLabel({ symbol: E2E_PAIR.symbol }), E2E_PAIR.payout));
  await bot.press(DEMO_DURATION_LABELS[15]);
  await bot.press(LABELS.demoAnalysisButton);
  const stake = await bot.press(cycleStakeLabel(MIN_STAKE, true));
  expect(String(lastIn(USER.id, 'sendPhoto')?.payload.caption)).toContain('15 с');
  const [started, ...others] = await reads.sessionsOf(account.id);
  if (started === undefined) throw new Error('no session');
  expect(others).toEqual([]);
  expect(started).toMatchObject({ status: TradingSessionStatus.Active, mode: TradeMode.Demo });
  expect(Number((await userRow(USER.id)).demoStake)).toBe(1);

  // R5 the amount press again while the session runs: 409 active_session_exists, the bot shows the
  // running session in a new message; status_message_id is not read (#591 changes its rule)
  const photos = inChat(botCalls, USER.id, 'sendPhoto').length;
  await bot.replay(stake);
  expect(inChat(botCalls, USER.id, 'sendPhoto')).toHaveLength(photos + 1);
  expect(String(lastIn(USER.id, 'sendPhoto')?.payload.caption)).toContain('15 с');
  expect(await reads.sessionsOf(account.id)).toEqual([
    expect.objectContaining({
      id: started.id,
      status: TradingSessionStatus.Active,
      settings: started.settings,
      startSignalAction: 'up',
    }),
  ]);
  expect(Number((await userRow(USER.id)).demoStake)).toBe(1);

  // the cycles: wins only, each trade settled once the worker holds it; /start in the middle (R6)
  for (let n = 1; n <= CYCLES; n += 1) {
    await until(
      `trade ${n} open at the broker`,
      () => tradesOf(broker, E2E_BROKER_USER_ID).length >= n,
    );
    await until(
      `intent ${n} accepted`,
      async () => (await reads.intentsOf(started.id))[n - 1]?.status === TradeIntentStatus.Accepted,
    );
    // the repeated press opened no intent of its own
    if (n === 1) expect(await reads.intentsOf(started.id)).toHaveLength(1);
    const trade = tradesOf(broker, E2E_BROKER_USER_ID)[n - 1];
    broker.trades.settle(Number(trade?.id), { outcome: MockTradeOutcome.Win });
    await until(
      `intent ${n} settled`,
      async () => (await reads.intentsOf(started.id))[n - 1]?.status === TradeIntentStatus.Settled,
    );

    if (n === 1) {
      // R6 /start mid-session: the card again, pinned; the session goes on
      await bot.start();
      const home = lastIn(USER.id, 'sendPhoto');
      expect(labelsOf(home?.payload)).toContain(LABELS.demoButton);
      expect(lastIn(USER.id, 'pinChatMessage')?.payload.message_id).toBe(
        home === undefined ? undefined : bot.telegram.messageIdOf(home),
      );
      expect(await reads.sessionsOf(account.id)).toEqual([
        expect.objectContaining({ id: started.id, status: TradingSessionStatus.Active }),
      ]);
      expect(await reads.usersCount()).toBe(3);
    }
  }
  await until('the session stops', async () =>
    (await reads.sessionsOf(account.id)).every(
      (session) => session.status === TradingSessionStatus.Stopped,
    ),
  );

  // the totals: every repeat left its count where the first delivery put it
  expect(await reads.sessionsOf(account.id)).toEqual([
    expect.objectContaining({ id: started.id, stopReason: TradingSessionStopReason.Completed }),
  ]);
  expect(await readTokenBalance(tmp.db, telegramUserId)).toMatchObject({
    balance: 95n,
    reserved: 0n,
  });
  const kinds = (await reads.ledgerOf(user.id)).map((row) => row.kind);
  expect(kinds.filter((kind) => kind === TokenLedgerKind.Bonus)).toHaveLength(1);
  expect(kinds.filter((kind) => kind === TokenLedgerKind.Reserve)).toHaveLength(CYCLES);
  expect(kinds.filter((kind) => kind === TokenLedgerKind.Settle)).toHaveLength(CYCLES);
  expect(kinds).toHaveLength(1 + 2 * CYCLES);
  expect(await reads.intentsOf(started.id)).toHaveLength(CYCLES);
  expect(await reads.accountsOf(user.id)).toHaveLength(1);
  expect(await reads.usersCount()).toBe(3);
  expect(await reads.referralsOf(userB.id)).toHaveLength(1);
  expect(await reads.depositsOf(keys.payment_id)).toHaveLength(1);
  expect(await reads.deliveriesOf(keys.payment_id)).toHaveLength(3);
  expect(journalOf('emailSendCode')).toHaveLength(1);
  expect(journalOf('emailLogin')).toHaveLength(2);
  expect(
    tradesOf(broker, E2E_BROKER_USER_ID).map((trade) => ('profit' in trade ? trade.profit : null)),
  ).toEqual(Array.from({ length: CYCLES }, () => 0.85));

  // the logs: the failed code and the other amount are warnings, no process wrote an error
  expect(Object.values(logs).flatMap((sink) => sink.errorLines())).toEqual([]);
}, 120_000);
