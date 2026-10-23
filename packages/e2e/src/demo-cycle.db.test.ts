import { randomBytes } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import {
  cycleStakeLabel,
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
  SessionStakeStrategy,
  TokenLedgerKind,
  TRADING_INTENTS_DEAD_LETTER_QUEUE,
  TradeIntentStatus,
  TradeMode,
  TradeTransport,
  TradingSessionStatus,
  TradingSessionStopReason,
  type DecimalString,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import { watchSockets, type TradingWorker } from '@binarius/trading-worker/e2e';
import { startE2eBackend, type E2eBackend } from './harness/backend';
import { startE2eBot, type E2eBot } from './harness/bot';
import { startE2eBroker, tradesOf } from './harness/broker';
import { e2eReads } from './harness/db';
import {
  E2E_BROKER_USER_ID,
  E2E_EMAIL,
  E2E_PAIR,
  REDIS_URL,
  TEST_DATABASE_URL,
} from './harness/env';
import { logSink } from './harness/logs';
import { createTelegram } from './harness/telegram';
import { startE2eWorker } from './harness/worker';

// #105: the demo cycle end to end, in one process (docs/e2e-demo-cycle.md). The backend, the worker
// and the bot are their production compositions over one Postgres, one Redis and the mock broker;
// only Telegram and the broker are stand-ins. Every oracle is observable from outside: the
// database, the mock broker's trades, balance, journal and sockets, what the bot and the backend
// sent to Telegram, and the three processes' log lines.

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

// In the order the plan gives: the bot's trackers poll the backend, the worker's stop waits for
// its sockets and attempts, the backend drains its loops, and only then the broker goes.
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

// the mock's min_trade_amount: the amount the analysis card marks as in effect without a saved stake
const MIN_STAKE = '1' as DecimalString;

const lastOf = (calls: ApiCall[], method: string) =>
  calls.filter((call) => call.method === method).at(-1)?.payload;
const labelsOf = (payload: Record<string, unknown> | undefined) =>
  inlineButtons(payload).map((button) => button.text);
const textOf = (call: ApiCall) => String(call.payload.text ?? call.payload.caption ?? '');
const isSummary = (call: ApiCall) =>
  call.method === 'sendMessage' && labelsOf(call.payload).includes(LABELS.menuButton);
// by its data: the open block's «⏹» has the same label and `:c` (#722)
const isWaiting = (call: ApiCall) =>
  call.method === 'sendMessage' &&
  inlineButtons(call.payload).some((button) => /:w$/.test(button.callback_data ?? ''));
const OPEN_MARK = 'сделка открыта';

it('runs /start → the email login → a demo session → its result', async () => {
  const reads = e2eReads(tmp.db);
  const telegramUserId = BigInt(USER.id);
  const botCalls = bot.telegram.calls;
  const sockets = watchSockets(broker);
  onTestFinished(() => {
    sockets.stop();
  });

  // S1 /start
  await bot.start();
  expect(labelsOf(lastOf(botCalls, 'sendMessage'))).toContain(LABELS.connectButton);
  const user = await reads.userRow(telegramUserId);
  if (user === undefined) throw new Error('/start recorded no user');
  expect(user).toMatchObject({ status: 'active', tokenBalance: 0n, demoStake: null });

  // S2 the address
  await bot.press(LABELS.connectButton);
  await bot.send(E2E_EMAIL);
  const code = broker.oauth.codeFor(E2E_EMAIL);
  if (code === undefined) throw new Error('the broker sent no code');
  expect(String(lastOf(botCalls, 'sendMessage')?.text)).toContain(E2E_EMAIL);
  expect(broker.rest.journal.filter((record) => record.endpoint === 'emailSendCode')).toEqual([
    expect.objectContaining({ bodyKeys: ['client_id', 'client_secret', 'email'] }),
  ]);

  // S3 the code: the account card, pinned, with the starter pack
  await bot.send(code);
  const card = botCalls.filter((call) => call.method === 'sendPhoto').at(-1);
  if (card === undefined) throw new Error('no account card');
  expect(String(card.payload.caption)).toContain('100');
  expect(labelsOf(card.payload)).toContain(LABELS.demoButton);
  expect(lastOf(botCalls, 'pinChatMessage')?.message_id).toBe(bot.telegram.messageIdOf(card));
  const account = await reads.accountOf(user.id);
  expect(account).toMatchObject({
    status: 'active',
    brokerUserId: String(E2E_BROKER_USER_ID),
    email: E2E_EMAIL,
    isPartnerClient: true,
  });
  expect(broker.rest.journal.filter((record) => record.endpoint === 'emailLogin')).toHaveLength(1);
  expect(await readTokenBalance(tmp.db, telegramUserId)).toMatchObject({
    balance: 100n,
    reserved: 0n,
  });
  if (account === undefined) throw new Error('no broker account');

  // S4 the manual door: type, pair, its summary at 5 s (#685), analysis
  await bot.press(LABELS.demoButton);
  await bot.press(LABELS.demoManualButton);
  const groups = lastOf(botCalls, 'editMessageText');
  expect(labelsOf(groups)).toEqual([groupButtonLabel('currency', 1)]);
  await bot.press(groupButtonLabel('currency', 1));
  const pairButton = pairButtonLabel(pairLabel({ symbol: E2E_PAIR.symbol }), E2E_PAIR.payout);
  await bot.press(pairButton);
  const screen = botCalls.filter((call) => call.method === 'editMessageText').at(-1);
  if (screen === undefined) throw new Error('no summary screen');
  await bot.press(LABELS.demoAnalysisButton);
  const analysis = botCalls.filter((call) => call.method === 'sendPhoto').at(-1);
  if (analysis === undefined || analysis === card) throw new Error('no analysis card');
  // the signal: the card offers the broker's minimum as the amount in effect
  expect(labelsOf(analysis.payload)).toContain(cycleStakeLabel(MIN_STAKE, true));
  expect(lastOf(botCalls, 'deleteMessage')?.message_id).toBe(bot.telegram.messageIdOf(screen));
  expect(
    broker.rest.journal.filter((record) => record.endpoint === 'chart').map((r) => r.query),
  ).toContainEqual(expect.objectContaining({ asset_id: String(E2E_PAIR.id), interval: '5s' }));
  expect(await reads.userRow(telegramUserId)).toMatchObject({
    lastAnalysisAssetId: E2E_PAIR.id,
    lastAnalysisDurationSec: 5,
  });

  // S5 the amount starts the session
  await bot.press(cycleStakeLabel(MIN_STAKE, true));
  const status = botCalls.filter((call) => call.method === 'sendPhoto').at(-1);
  if (status === undefined || status === analysis) throw new Error('no status message');
  expect(String(status.payload.caption)).toMatch(/(?<!\d)5 с/);
  expect(lastOf(botCalls, 'deleteMessage')?.message_id).toBe(bot.telegram.messageIdOf(analysis));
  const started = await reads.sessionOf(account.id);
  if (started === undefined) throw new Error('no session');
  expect(started).toMatchObject({
    status: TradingSessionStatus.Active,
    mode: TradeMode.Demo,
    startSignalAction: 'up',
    settings: {
      version: 3,
      assetId: E2E_PAIR.id,
      durationSec: 5,
      cycles: 5,
      stake: {
        strategy: SessionStakeStrategy.Martingale,
        baseStake: '1',
        stakeScale: 2,
        limits: { maxSteps: 4, maxStake: '12', maxSessionLoss: '20' },
      },
    },
  });
  expect(Number((await reads.userRow(telegramUserId))?.demoStake)).toBe(1);
  await until(
    'the status message id is stored',
    async () =>
      (await reads.sessionOf(account.id))?.statusMessageId === bot.telegram.messageIdOf(status),
  );
  // no waiting message to wait for: the mock gives a signal on every candle, and the waiting
  // message goes only after a no_signal decision (#722)

  // S6 the cycles: one loss, then wins; each trade is settled once the worker holds it - the
  // first two once the backend showed their open block (#700): step 1 a new message, step 2 its edit
  const amounts = [1, 2.18, 1, 1, 1, 1];
  const openShown = [
    (call: ApiCall) =>
      call.method === 'sendMessage' && textOf(call).startsWith(`⚡ Цикл 1 Шаг 1\n<pre>⏳`),
    (call: ApiCall) =>
      call.method === 'editMessageText' && textOf(call).includes(`⚡ Цикл 1 Шаг 2\n<pre>⏳`),
  ];
  for (let n = 1; n <= amounts.length; n += 1) {
    await until(
      `trade ${n} open at the broker`,
      () => tradesOf(broker, E2E_BROKER_USER_ID).length >= n,
    );
    const trade = tradesOf(broker, E2E_BROKER_USER_ID)[n - 1];
    expect(trade).toMatchObject({
      is_demo: true,
      asset_id: E2E_PAIR.id,
      action: 'up',
      amount: amounts[n - 1],
    });
    await until(
      `intent ${n} accepted`,
      async () => (await reads.intentsOf(started.id))[n - 1]?.status === TradeIntentStatus.Accepted,
    );
    const shown = openShown[n - 1];
    if (shown !== undefined) {
      await until(`trade ${n}'s open block`, () => backend.push.calls.some(shown));
    }
    broker.trades.settle(Number(trade?.id), {
      outcome: n === 1 ? MockTradeOutcome.Loss : MockTradeOutcome.Win,
    });
    await until(
      `intent ${n} settled`,
      async () => (await reads.intentsOf(started.id))[n - 1]?.status === TradeIntentStatus.Settled,
    );
  }
  await until(
    'the session stops',
    async () => (await reads.sessionOf(account.id))?.status === TradingSessionStatus.Stopped,
  );
  expect(await reads.sessionOf(account.id)).toMatchObject({
    stopReason: TradingSessionStopReason.Completed,
    endedAt: expect.any(Date),
  });
  const intents = await reads.intentsOf(started.id);
  expect(
    intents.map((intent) => [intent.clientRequestId, intent.status, intent.transport]),
  ).toEqual(
    amounts.map((_, index) => [
      `session:${started.id}:${index + 1}`,
      TradeIntentStatus.Settled,
      TradeTransport.Socket,
    ]),
  );
  const brokerTrades = await reads.tradesOf(intents.map((intent) => intent.id));
  expect(brokerTrades.map((trade) => Number(trade.profit))).toEqual([
    -1, 1.85, 0.85, 0.85, 0.85, 0.85,
  ]);
  expect(
    tradesOf(broker, E2E_BROKER_USER_ID).map((trade) => ('profit' in trade ? trade.profit : null)),
  ).toEqual([-1, 1.85, 0.85, 0.85, 0.85, 0.85]);
  expect(broker.users.get(E2E_BROKER_USER_ID).demo).toEqual({
    available: 10004.25,
    held: 0,
    total: 10004.25,
  });
  expect(sockets.stop().worst).toBe(1);

  // S7 the backend's messages: the cycles silent, with the «⏹» only on an open block (#722), every
  // waiting message gone, then the final mark - and no text summary: the bot tracks the session
  // (#537)
  const push = backend.push.calls;
  await until('the notices are closed', async () =>
    Boolean((await reads.sessionOf(account.id))?.finalNoticeSentAt),
  );
  const cycles = push.filter(
    (call) => call.method === 'sendMessage' && textOf(call).startsWith('⚡'),
  );
  expect(cycles).toHaveLength(5);
  for (const call of cycles) {
    expect(call.payload).toMatchObject({ disable_notification: true });
  }
  // every send or edit of a cycle message: the open block's «⏹» `:c` with the block, no keyboard
  // without it - an edit into the result takes the «⏹» off
  const sessionId = (await reads.sessionOf(account.id))!.id;
  for (const call of push.filter(
    (other) =>
      (other.method === 'sendMessage' || other.method === 'editMessageText') &&
      textOf(other).startsWith('⚡'),
  )) {
    if (textOf(call).includes(OPEN_MARK)) {
      expect(inlineButtons(call.payload)).toEqual([
        { text: LABELS.sessionStopButton, callback_data: `session:stop:${sessionId}:c` },
      ]);
    } else {
      expect(call.payload.reply_markup).toBeUndefined();
    }
  }
  // the first cycle's message: its open block, the open block of step 2, the result of each (#700)
  const firstCycle = push.filter(
    (call) =>
      call.method === 'editMessageText' &&
      call.payload.message_id === backend.push.messageIdOf(cycles[0]!),
  );
  expect(firstCycle.map((call) => textOf(call).match(/[🟢🔴⚪⏳]/gu))).toEqual([
    ['🔴'],
    ['🔴', '⏳'],
    ['🔴', '🟢'],
  ]);
  expect(textOf(cycles[0]!)).toContain('сделка открыта');
  // the lost step 1 carries the adaptive line at once; the cycle's last text holds it once, between
  // the loss and the win (#718)
  const ADAPTIVE = '🔄 Адаптивная ставка включена';
  expect(textOf(firstCycle[0]!)).toContain(`</pre>\n\n${ADAPTIVE}`);
  expect(textOf(firstCycle.at(-1)!).match(/[🟢🔴🔄]/gu)).toEqual(['🔴', '🔄', '🟢']);
  // an open block at most once a trade, each before its result; none is left in the chat
  const shownLast = new Map<unknown, string>();
  for (const call of push) {
    if (call.method === 'sendMessage') shownLast.set(backend.push.messageIdOf(call), textOf(call));
    if (call.method === 'editMessageText') shownLast.set(call.payload.message_id, textOf(call));
  }
  expect([...shownLast.values()].filter((text) => text.includes('⏳'))).toEqual([]);
  const opens = push.filter(
    (call) =>
      (call.method === 'sendMessage' || call.method === 'editMessageText') &&
      textOf(call).includes(OPEN_MARK),
  );
  expect(opens.length).toBeGreaterThanOrEqual(2);
  expect(opens.length).toBeLessThanOrEqual(amounts.length);
  // every waiting message is deleted after it went out and before the next message the backend
  // sends, or at all when nothing follows it; there is one only after a no_signal decision (#722)
  const waiting = push.filter(isWaiting);
  if ((await reads.noSignalCountOf(sessionId)) === 0) expect(waiting).toEqual([]);
  for (const call of waiting) {
    const sent = push.indexOf(call);
    const deleted = push.findIndex(
      (other) =>
        other.method === 'deleteMessage' &&
        other.payload.message_id === backend.push.messageIdOf(call),
    );
    const nextSend = push.findIndex(
      (other, index) => index > sent && other.method === 'sendMessage',
    );
    expect(deleted).toBeGreaterThan(sent);
    if (nextSend !== -1) {
      expect(deleted, 'the waiting message is deleted before the next message').toBeLessThan(
        nextSend,
      );
    }
  }

  // S8 the bot: the status message finished, then the summary in one message - the card's photo
  // with the whole summary as its caption, with sound
  await until('the summary is sent', () =>
    botCalls.some((call) => call.method === 'sendPhoto' && textOf(call).startsWith('📈')),
  );
  const marks = await reads.sessionOf(account.id);
  expect(marks?.finalNoticeSentAt).not.toBeNull();
  expect(marks?.summarySentAt).not.toBeNull();
  expect(push.filter(isSummary)).toEqual([]);
  const finished = lastOf(botCalls, 'editMessageMedia');
  expect(finished?.message_id).toBe(bot.telegram.messageIdOf(status));
  expect(JSON.stringify(finished)).toContain('🏁');
  const summary = botCalls.filter((call) => call.method === 'sendPhoto').at(-1)!;
  expect(summary.payload).not.toHaveProperty('disable_notification');
  const caption = textOf(summary).split('\n');
  expect(caption[0]).toBe(`📈 ${pairLabel({ symbol: E2E_PAIR.symbol })}`);
  expect(textOf(summary)).toContain('+$4.25');
  expect(textOf(summary)).toMatch(/🧪 Демобаланс: \$10.004\.25/);
  // #709: no referral link in the caption, and the claim creates no code
  expect(textOf(summary)).not.toContain('t.me/');
  expect(await reads.referralCodeOf(user.id)).toBeUndefined();
  expect(labelsOf(summary.payload)).toContain(LABELS.menuButton);

  // S9 the tokens: the pack less one per trade, nothing left reserved
  expect(await readTokenBalance(tmp.db, telegramUserId)).toMatchObject({
    balance: 94n,
    reserved: 0n,
  });
  const ledger = await reads.ledgerOf(user.id);
  const kinds = ledger.map((row) => row.kind);
  expect(kinds.filter((kind) => kind === TokenLedgerKind.Bonus)).toHaveLength(1);
  expect(kinds.filter((kind) => kind === TokenLedgerKind.Reserve)).toHaveLength(6);
  expect(kinds.filter((kind) => kind === TokenLedgerKind.Settle)).toHaveLength(6);
  expect(kinds).toHaveLength(13);

  // S10 no process logged an error
  expect(Object.values(logs).flatMap((sink) => sink.errorLines())).toEqual([]);
}, 120_000);
