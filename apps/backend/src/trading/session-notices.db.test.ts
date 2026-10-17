import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TradeAction,
  TradeIntentStatus,
  TradingSessionStopReason,
  botTextMessageOverflows,
  decimalStringSchema,
  defaultBotTextSource,
  logOptions,
  plainTextOf,
  TELEGRAM_MESSAGE_LIMIT,
  type BinaryPair,
  type BotTextKey,
  type BrokerUser,
  type DecimalString,
  type PairsCatalogView,
  type TradingSessionSettings,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import {
  claimSessionTradeNotice,
  clearSessionWaitingMessage,
  createSessionIntent,
  markIntentAccepted,
  markTelegramReachable,
  recordSessionCycleMessage,
  recordSessionStatusMessage,
  settleIntent,
  stopTradingSession,
  takeIntent,
  transitionIntent,
  tradingSessions,
  upsertBalanceSnapshot,
  users,
  type TradeIntentRow,
} from '@binarius/db';
import {
  createTempDatabase,
  seedTradingSession,
  seedUserWithAccount,
  sessionSettings,
  type SeededAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import {
  callsTo,
  captureApi,
  inlineButtons,
  type ApiCall,
  type CapturedApi,
} from '../admin/testing';
import { createClientPush } from '../auth/client-push';
import { CLIENT_LABELS, CLIENT_TEXTS, setBotTextSource } from '../auth/texts';
import type { BalanceRefreshOutcome } from '../broker/balance-reconciler';
import { SESSION_NOTICE_SEND_PER_SECOND } from '../timing';
import {
  createSessionNoticeSender,
  type SessionNoticeConfig,
  type SessionNoticeSenderDeps,
} from './session-notices';
import { readFinishedSessionView } from './session-view';

// The session notices' sender (#464, docs/bot-session.md → Trade messages) against a temporary
// migrated database and an intercepted Telegram API. Each case starts with every older session
// marked, so a tick serves only the case's own.
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
beforeEach(async () => {
  await tmp.db
    .update(tradingSessions)
    .set({ finalNoticeSentAt: sql`now()` })
    .where(isNull(tradingSessions.finalNoticeSentAt));
});

const PUSH_TOKEN = '123456:AA-session-notice-token';
const ASSET = 101;
const pair: BinaryPair = {
  id: ASSET,
  symbol: 'EUR/USD',
  isOtc: true,
  type: 'forex',
  digits: 5,
  payout: 85,
  maxPayout: 90,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
};
const catalogView: PairsCatalogView = { pairs: [pair], fetchedAt: 0, ageMs: 0, fresh: true };
const brokerUser: BrokerUser = {
  id: 'broker-user',
  level: { code: 'standard', rank: 1 },
  minTradeAmount: decimalStringSchema.parse('1.00000000'),
  real: {
    available: decimalStringSchema.parse('100'),
    held: decimalStringSchema.parse('0'),
    total: decimalStringSchema.parse('100'),
  },
  demo: {
    available: decimalStringSchema.parse('10002.5'),
    held: decimalStringSchema.parse('0'),
    total: decimalStringSchema.parse('10002.5'),
  },
};

interface Target {
  seed: SeededAccount;
  session: { id: string };
  step: number;
}

// settings v2 under martingale (#450): its trades' messages are one per cycle (#551)
const MARTINGALE: TradingSessionSettings = {
  version: 2,
  assetId: ASSET,
  durationSec: 60,
  trades: 20,
  stake: {
    strategy: 'martingale',
    baseStake: '5' as DecimalString,
    stakeScale: 0,
    limits: {
      maxSteps: 4,
      maxStake: '60' as DecimalString,
      maxSessionLoss: '100' as DecimalString,
      maxSessionDurationMs: 3_600_000,
    },
  },
};

async function seedSession(settings?: TradingSessionSettings): Promise<Target> {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId, {
    settings:
      settings ??
      sessionSettings({
        assetId: ASSET,
        stake: { baseStake: '5' as DecimalString, stakeScale: 0 },
      }),
  });
  return { seed, session, step: 0 };
}

async function nextIntent(target: Target): Promise<TradeIntentRow> {
  target.step += 1;
  return (
    await createSessionIntent(tmp.db, {
      sessionId: target.session.id,
      step: target.step,
      telegramUserId: target.seed.telegramUserId,
      brokerAccountId: target.seed.brokerAccountId,
      mode: 'demo',
      assetId: ASSET,
      amount: decimalStringSchema.parse('5'),
      action: TradeAction.Up,
      durationSec: 60,
    })
  ).intent;
}

// the next step settled at `profit`, opened at step/10 and closed 0.0001 above
async function settled(target: Target, profit: string): Promise<void> {
  const intent = await nextIntent(target);
  const taken = (await takeIntent(tmp.db, {
    id: intent.id,
    expectedVersion: intent.version,
    maxAgeMs: 60_000,
  }))!;
  const open = openTradeFor(intent, { openPrice: target.step / 10 });
  await tmp.db.transaction((tx) =>
    markIntentAccepted(tx, {
      id: taken.id,
      expectedVersion: taken.version,
      transport: 'rest_fallback',
      trade: open,
    }),
  );
  await tmp.db.transaction((tx) =>
    settleIntent(tx, {
      id: intent.id,
      from: TradeIntentStatus.Accepted,
      trade: closedTradeFor(open, {
        profit: profit as DecimalString,
        closePrice: target.step / 10 + 0.0001,
      }),
    }),
  );
}

const stop = (
  target: Target,
  reason: TradingSessionStopReason = TradingSessionStopReason.Completed,
) => stopTradingSession(tmp.db, { id: target.session.id, reason });

const snapshot = (target: Target) =>
  upsertBalanceSnapshot(tmp.db, {
    brokerAccountId: target.seed.brokerAccountId,
    user: brokerUser,
    requested: false,
  });

function sender(
  patch: Partial<Omit<SessionNoticeSenderDeps, 'db' | 'logger' | 'push'>> & {
    config?: Partial<SessionNoticeConfig>;
  } = {},
  clock = { now: 0 },
) {
  const push = createClientPush({ token: PUSH_TOKEN });
  const captured = captureApi(push);
  // Telegram answers a sent message with its id, growing
  captured.answers.set('sendMessage', (payload) => {
    messageIds += 1;
    answered.set(payload, messageIds);
    return { message_id: messageIds };
  });
  captured.answers.set('editMessageText', (payload) => {
    edited.add(payload);
    return true;
  });
  const lines: string[] = [];
  const refreshCalls: Parameters<SessionNoticeSenderDeps['balance']['refresh']>[] = [];
  const notices = createSessionNoticeSender({
    db: tmp.db,
    push,
    catalog: { read: () => catalogView },
    balance: {
      refresh: (...args) => {
        refreshCalls.push(args);
        return Promise.resolve<BalanceRefreshOutcome>('unavailable');
      },
    },
    logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    now: () => clock.now,
    sleep: async () => {},
    ...patch,
  });
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { notices, captured, push, logs, refreshCalls };
}

let messageIds = 0;
// the id each answered send got, by its recorded payload
const answered = new WeakMap<object, number>();
// the edits Telegram applied (a refused one is recorded as a call too)
const edited = new WeakSet<object>();

// the waiting message (#536) carries the one keyboard of the sender's silent messages
const isWaiting = (call: ApiCall) =>
  inlineButtons(call.payload).some((button) =>
    (button.callback_data ?? '').startsWith('session:stop:'),
  );
// the trades' messages and the summary; the waiting messages are waitingTo's
const sendsTo = (calls: readonly ApiCall[], target: Target) =>
  callsTo(calls, 'sendMessage').filter(
    (call) => call.payload.chat_id === target.seed.telegramUserId && !isWaiting(call),
  );
const waitingTo = (calls: readonly ApiCall[], target: Target) =>
  callsTo(calls, 'sendMessage').filter(
    (call) => call.payload.chat_id === target.seed.telegramUserId && isWaiting(call),
  );
const deletesTo = (calls: readonly ApiCall[], target: Target) =>
  callsTo(calls, 'deleteMessage')
    .filter((call) => call.payload.chat_id === target.seed.telegramUserId)
    .map((call) => Number(call.payload.message_id));
const textsTo = (calls: readonly ApiCall[], target: Target) =>
  sendsTo(calls, target).map((call) => String(call.payload.text));
const editsTo = (calls: readonly ApiCall[], target: Target) =>
  callsTo(calls, 'editMessageText').filter(
    (call) => call.payload.chat_id === target.seed.telegramUserId,
  );
// what the user sees of the trades and the summary: every message by its id, at its last text
function chatOf(calls: readonly ApiCall[], target: Target): string[] {
  const shown = new Map<number, string>();
  for (const call of calls) {
    if (call.payload.chat_id !== target.seed.telegramUserId || isWaiting(call)) continue;
    const id =
      call.method === 'sendMessage'
        ? answered.get(call.payload)
        : edited.has(call.payload)
          ? Number(call.payload.message_id)
          : undefined;
    if (id !== undefined) shown.set(id, String(call.payload.text));
  }
  return [...shown.values()];
}
const rowOf = async (target: Target) =>
  (
    await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, target.session.id))
  )[0]!;
const telegramError = (error_code: number, retry_after?: number): ApiError => ({
  ok: false,
  error_code,
  description: `refused ${error_code}`,
  ...(retry_after === undefined ? {} : { parameters: { retry_after } }),
});
// the first `times` sends answer `failure`, the rest go through
function failFirst(captured: CapturedApi, times: number, failure: ApiError | HttpError) {
  let left = times;
  const errors = new Map<string, ApiError | HttpError>();
  errors.get = (method: string) => {
    if (method !== 'sendMessage' || left === 0) return undefined;
    left -= 1;
    return failure;
  };
  captured.apiErrors = errors;
}
// a 400 with Telegram's own wording
const refusal = (description: string): ApiError => ({ ok: false, error_code: 400, description });
const cycleStateOf = async (target: Target) => {
  const row = await rowOf(target);
  return { messageId: row.cycleMessageId, from: row.cycleMessageFrom };
};
const INFO = 30;
const WARN = 40;
const messagesOf = (logs: Record<string, unknown>[], level: number) =>
  logs.filter((entry) => entry.level === level).map((entry) => entry.msg);

describe('the session notices (#464)', () => {
  it('D1 a finished five-trade session: five silent messages in order, then the summary with sound', async () => {
    const target = await seedSession();
    for (const profit of ['4.6', '-5', '0', '4.25', '-5']) await settled(target, profit);
    await stop(target);
    await snapshot(target);
    const { notices, captured, refreshCalls } = sender();
    await notices.tick();

    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(6);
    const trades = sends.slice(0, 5);
    for (const call of trades) {
      expect(call.payload.disable_notification).toBe(true);
      expect(call.payload.reply_markup).toBeUndefined();
      expect(call.payload.parse_mode).toBe('HTML');
    }
    expect(trades.map((call) => String(call.payload.text))).toEqual([
      '⚡ Цикл 1 Шаг 1\n<pre>🟢 Ставка: $5.00 → +$4.60\n📊 Цена: 0.10000 → 0.10010</pre>',
      '⚡ Цикл 2 Шаг 1\n<pre>🔴 Ставка: $5.00 → -$5.00\n📊 Цена: 0.20000 → 0.20010</pre>',
      '⚡ Цикл 3 Шаг 1\n<pre>⚪ Ставка: $5.00 → $0.00, ставка вернулась\n📊 Цена: 0.30000 → 0.30010</pre>',
      '⚡ Цикл 4 Шаг 1\n<pre>🟢 Ставка: $5.00 → +$4.25\n📊 Цена: 0.40000 → 0.40010</pre>',
      '⚡ Цикл 5 Шаг 1\n<pre>🔴 Ставка: $5.00 → -$5.00\n📊 Цена: 0.50000 → 0.50010</pre>',
    ]);
    const summary = sends[5]!;
    expect(summary.payload.disable_notification).toBeUndefined();
    expect(inlineButtons(summary.payload)).toEqual([
      { text: CLIENT_LABELS.menuButton, callback_data: 'menu' },
    ]);
    expect(String(summary.payload.text).split('\n')).toEqual([
      '📈 EUR/USD OTC',
      '🏁 Сессия завершена: 5 циклов, 5 сделок — 2 в плюс, 2 в минус, 1 в ноль',
      '💰 Результат: -$1.15',
      '🧪 Демобаланс: $10 002.50',
    ]);
    // the snapshot is newer than the last settle: no broker call
    expect(refreshCalls).toHaveLength(0);
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 5,
      finalNoticeSentAt: expect.any(Date),
    });
    // a second tick has nothing to send
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(6);
  });

  it('D2 a restarted sender goes on from the cursor: no repeat, no gap', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await settled(target, '-5');
    const first = sender();
    await first.notices.tick();
    await first.notices.stop();
    for (const profit of ['0', '4.6', '-5']) await settled(target, profit);
    await stop(target);
    const second = sender();
    await second.notices.tick();
    const cycles = [
      ...textsTo(first.captured.calls, target),
      ...textsTo(second.captured.calls, target),
    ].map((text) => /Цикл (\d+)/.exec(text)?.[1] ?? 'summary');
    expect(cycles).toEqual(['1', '2', '3', '4', '5', 'summary']);
  });

  it('D3 two senders ticking together send each trade and the summary once', async () => {
    const target = await seedSession();
    for (const profit of ['4.6', '-5', '0']) await settled(target, profit);
    await stop(target);
    const a = sender();
    const b = sender();
    await Promise.all([a.notices.tick(), b.notices.tick(), a.notices.tick(), b.notices.tick()]);
    const texts = [...textsTo(a.captured.calls, target), ...textsTo(b.captured.calls, target)];
    expect(texts).toHaveLength(4);
    expect(new Set(texts).size).toBe(4);
  });

  it('D5 a user who blocked the bot: the trades and the summary are claimed, nothing is sent', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await stop(target);
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, target.seed.userId));
    const { notices, captured } = sender();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 1,
      finalNoticeSentAt: expect.any(Date),
    });
  });

  it("D6 each session's notices go to its owner only", async () => {
    const first = await seedSession();
    const second = await seedSession();
    await settled(first, '4.6');
    await settled(second, '-5');
    await settled(second, '-5');
    const { notices, captured } = sender();
    await notices.tick();
    expect(textsTo(captured.calls, first)).toHaveLength(1);
    expect(textsTo(captured.calls, first)[0]).toContain('🟢');
    expect(textsTo(captured.calls, second)).toHaveLength(2);
    expect(textsTo(captured.calls, second).every((text) => text.includes('🔴'))).toBe(true);
    // and each its own waiting message (#536) under them
    expect(waitingTo(captured.calls, first)).toHaveLength(1);
    expect(waitingTo(captured.calls, second)).toHaveLength(1);
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(5);
  });

  it('D7 a trade on manual review: the trades before it, no summary; once settled, it and then the summary', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    const review = await nextIntent(target);
    let row = (await takeIntent(tmp.db, {
      id: review.id,
      expectedVersion: review.version,
      maxAgeMs: 60_000,
    }))!;
    for (const [from, to] of [
      [TradeIntentStatus.Submitting, TradeIntentStatus.Unknown],
      [TradeIntentStatus.Unknown, TradeIntentStatus.Reconciling],
      [TradeIntentStatus.Reconciling, TradeIntentStatus.ManualReview],
    ] as const) {
      row = (await transitionIntent(tmp.db, {
        id: row.id,
        from,
        to,
        expectedVersion: row.version,
      }))!;
    }
    await stop(target, TradingSessionStopReason.ManualReview);
    const { notices, captured } = sender();
    await notices.tick();
    expect(textsTo(captured.calls, target)).toHaveLength(1);
    expect((await rowOf(target)).finalNoticeSentAt).toBeNull();

    await tmp.db.transaction((tx) =>
      settleIntent(tx, {
        id: review.id,
        from: TradeIntentStatus.ManualReview,
        trade: closedTradeFor(openTradeFor(review, { openPrice: 0.7 }), {
          profit: '-5' as DecimalString,
          closePrice: 0.6,
        }),
      }),
    );
    await notices.tick();
    const texts = textsTo(captured.calls, target);
    expect(texts).toHaveLength(3);
    expect(texts[1]).toContain('⚡ Цикл 2 Шаг 1\n<pre>🔴');
    expect(texts[2]).toBe(
      [
        '📈 EUR/USD OTC',
        CLIENT_TEXTS.sessionStopManualReview.value,
        '📊 Итог: 2 сделки — 1 в плюс, 1 в минус',
        '💰 Результат: -$0.40',
      ].join('\n'),
    );
  });

  it('D8 views read while the sender runs change nothing: each trade once', async () => {
    const target = await seedSession();
    for (const profit of ['4.6', '-5', '0']) await settled(target, profit);
    await stop(target);
    const { notices, captured } = sender();
    const balance = { refresh: () => Promise.resolve<BalanceRefreshOutcome>('unavailable') };
    const read = () =>
      readFinishedSessionView(
        { db: tmp.db, balance },
        target.session.id,
        target.seed.telegramUserId,
      );
    await Promise.all([read(), notices.tick(), read(), read(), notices.tick(), read()]);
    await notices.tick();
    expect(textsTo(captured.calls, target)).toHaveLength(4);
  });

  it('D9 the summary asks the broker once, without a token exchange, when the balance predates the last trade', async () => {
    const target = await seedSession();
    await snapshot(target);
    await settled(target, '4.6');
    await stop(target);
    const { notices, captured, refreshCalls } = sender();
    await notices.tick();
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]![0]).toBe(target.seed.brokerAccountId);
    expect(refreshCalls[0]![1]).toMatchObject({ mayRefresh: false });
    expect(refreshCalls[0]![1]).not.toHaveProperty('requested');
    // the refresh did not answer 'ok': the stored balance with its age
    expect(textsTo(captured.calls, target).at(-1)).toMatch(/🧪 Демобаланс: .*\n🕒/);
  });
});

describe('every way a send ends (#464)', () => {
  it('D4 sent: the cursor stays and the next trade follows in the same tick', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await settled(target, '-5');
    const { notices, captured } = sender();
    await notices.tick();
    expect(textsTo(captured.calls, target)).toHaveLength(2);
    expect((await rowOf(target)).notifiedTrades).toBe(2);
  });

  it('D4 429: the trade is put back, nothing goes until the pause has passed, then it goes once', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    await settled(target, '4.6');
    await settled(target, '-5');
    const { notices, captured, logs } = sender({}, clock);
    captured.apiErrors.set('sendMessage', telegramError(429, 30));
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    expect((await rowOf(target)).notifiedTrades).toBe(0);
    expect(messagesOf(logs(), WARN)).toContain('session notices paused: Telegram asked to wait');

    captured.apiErrors.delete('sendMessage');
    clock.now += 29_999;
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    clock.now += 1;
    await notices.tick();
    const texts = textsTo(captured.calls, target);
    expect(texts).toHaveLength(3);
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toContain('Цикл 2');
  });

  it('D4 another 4xx: tried again on later ticks, then dropped so the later trades go', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await settled(target, '-5');
    const { notices, captured, logs } = sender({ config: { maxAttempts: 3 } });
    // trade 1 three times, then trade 2 once
    failFirst(captured, 4, telegramError(400));
    await notices.tick();
    await notices.tick();
    expect((await rowOf(target)).notifiedTrades).toBe(0);
    await notices.tick();
    expect(messagesOf(logs(), WARN)).toEqual([
      'session trade notice refused',
      'session trade notice refused',
      'session trade notice dropped',
      'session trade notice refused',
    ]);
    // the third refusal leaves the trade claimed; the second trade is refused in turn
    expect((await rowOf(target)).notifiedTrades).toBe(1);
    await notices.tick();
    expect((await rowOf(target)).notifiedTrades).toBe(2);
    const cycles = textsTo(captured.calls, target).map((text) => /Цикл (\d+)/.exec(text)?.[1]);
    expect(cycles).toEqual(['1', '1', '1', '2', '2']);
  });

  it.each([
    ['a 5xx', () => telegramError(502)],
    [
      'a transport failure',
      () => new HttpError("Network request for 'sendMessage' failed!", new Error('timed out')),
    ],
  ])(
    'D4 %s: the outcome is unknown, the trade is never sent again, the next one goes',
    async (_name, failure) => {
      const target = await seedSession();
      await settled(target, '4.6');
      await settled(target, '-5');
      const { notices, captured, logs } = sender();
      failFirst(captured, 1, failure());
      await notices.tick();
      await notices.tick();
      const cycles = textsTo(captured.calls, target).map((text) => /Цикл (\d+)/.exec(text)?.[1]);
      expect(cycles).toEqual(['1', '2']);
      expect((await rowOf(target)).notifiedTrades).toBe(2);
      expect(messagesOf(logs(), WARN)).toContain('session trade notice outcome unknown');
    },
  );

  it('D4 403: the user is marked unreachable and the later trades are claimed without a call', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await settled(target, '-5');
    await stop(target);
    const { notices, captured } = sender();
    captured.apiErrors.set('sendMessage', telegramError(403));
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    const [user] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, target.seed.userId));
    expect(user?.at).toBeInstanceOf(Date);
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 2,
      finalNoticeSentAt: expect.any(Date),
    });
  });

  it('D4 a message that cannot be built: logged, the claimed trade is not sent again', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    let reads = 0;
    const { notices, captured, logs } = sender({
      catalog: {
        read: () => {
          reads += 1;
          if (reads === 1) throw new TypeError('bug');
          return catalogView;
        },
      },
    });
    await notices.tick();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
    expect(
      logs()
        .filter((entry) => entry.level === 50)
        .map((entry) => entry.msg),
    ).toEqual(['session trade notice not built']);
  });

  it('D4 stop() mid-tick: the send in flight ends, nothing is claimed after it', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await settled(target, '-5');
    let release: () => void = () => {};
    let sleeping = false;
    const { notices, captured } = sender({
      config: { perSecond: 1 },
      sleep: () => {
        sleeping = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const ticking = notices.tick();
    while (!sleeping) await new Promise((resolve) => setImmediate(resolve));
    const stopping = notices.stop();
    release();
    await Promise.all([ticking, stopping]);
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
  });

  it('D4 the summary refused with 429: its mark is taken back and it goes once after the pause', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    await settled(target, '4.6');
    await stop(target);
    const { notices, captured } = sender({}, clock);
    await notices.tick();
    // the trade went; now the summary is refused
    const trades = sendsTo(captured.calls, target).length;
    expect(trades).toBe(2);
    await tmp.db
      .update(tradingSessions)
      .set({ finalNoticeSentAt: null })
      .where(inArray(tradingSessions.id, [target.session.id]));
    captured.apiErrors.set('sendMessage', telegramError(429, 5));
    await notices.tick();
    expect((await rowOf(target)).finalNoticeSentAt).toBeNull();
    captured.apiErrors.delete('sendMessage');
    clock.now += 5_000;
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(4);
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(4);
  });
});

const ADAPTIVE = '🔄 Адаптивная ставка включена';
// the heads of a message: its blocks' «⚡ Цикл N Шаг M» and the adaptive line
const heads = (text: string) =>
  text.split('\n').filter((line) => line.startsWith('⚡') || line.startsWith('🔄'));
const loss = (step: number, cycle = 1, at = step) =>
  `⚡ Цикл ${cycle} Шаг ${step}\n<pre>🔴 Ставка: $5.00 → -$5.00\n📊 Цена: ${(at / 10).toFixed(5)} → ${(at / 10 + 0.0001).toFixed(5)}</pre>`;

describe('a martingale cycle is one message (#551)', () => {
  it('D13 L, L, W: one silent message, two edits listing every step, then a new cycle sends anew', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    await settled(target, '-5');
    await notices.tick();
    await settled(target, '-5');
    await notices.tick();
    await settled(target, '4.6');
    await notices.tick();

    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    const edits = editsTo(captured.calls, target);
    expect(edits).toHaveLength(2);
    const id = answered.get(sendsTo(captured.calls, target)[0]!.payload);
    for (const edit of edits) {
      expect(edit.payload.message_id).toBe(id);
      expect(edit.payload.parse_mode).toBe('HTML');
      expect(edit.payload.reply_markup).toBeUndefined();
    }
    expect(String(edits[0]!.payload.text)).toBe([loss(1), ADAPTIVE, loss(2)].join('\n\n'));
    expect(String(edits[1]!.payload.text)).toBe(
      [
        loss(1),
        ADAPTIVE,
        loss(2),
        '⚡ Цикл 1 Шаг 3\n<pre>🟢 Ставка: $5.00 → +$4.60\n📊 Цена: 0.30000 → 0.30010</pre>',
      ].join('\n\n'),
    );
    expect(await cycleStateOf(target)).toEqual({ messageId: id, from: 0 });

    await settled(target, '-5');
    await notices.tick();
    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(2);
    expect(String(sends[1]!.payload.text)).toBe(loss(1, 2, 4));
    expect(sends[1]!.payload.disable_notification).toBe(true);
    expect(await cycleStateOf(target)).toEqual({
      messageId: answered.get(sends[1]!.payload),
      from: 3,
    });
  });

  it('D14 a tie at step 1 is step 2 of the same cycle: an edit with the adaptive line at the same stake', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    await settled(target, '0');
    await settled(target, '-5');
    await notices.tick();
    expect(chatOf(captured.calls, target).map(heads)).toEqual([
      ['⚡ Цикл 1 Шаг 1', ADAPTIVE, '⚡ Цикл 1 Шаг 2'],
    ]);
    expect(String(editsTo(captured.calls, target)[0]!.payload.text)).toContain(
      '⚪ Ставка: $5.00 → $0.00, ставка вернулась',
    );
  });

  it('D15 a restarted sender edits the saved cycle message: nothing new is sent', async () => {
    const target = await seedSession(MARTINGALE);
    await settled(target, '-5');
    const first = sender();
    await first.notices.tick();
    await first.notices.stop();
    await settled(target, '-5');
    const second = sender();
    await second.notices.tick();
    expect(sendsTo(second.captured.calls, target)).toHaveLength(0);
    const [edit] = editsTo(second.captured.calls, target);
    expect(edit?.payload.message_id).toBe(
      answered.get(sendsTo(first.captured.calls, target)[0]!.payload),
    );
    expect(heads(String(edit?.payload.text))).toEqual([
      '⚡ Цикл 1 Шаг 1',
      ADAPTIVE,
      '⚡ Цикл 1 Шаг 2',
    ]);
  });

  it.each([
    'Bad Request: message to edit not found',
    "Bad Request: message can't be edited",
    'Bad Request: there is no text in the message to edit',
  ])(
    'D16 an edit refused «%s»: the gone message’s blocks go anew in the same tick, and the next step edits them',
    async (description) => {
      const target = await seedSession(MARTINGALE);
      const { notices, captured, logs } = sender();
      await settled(target, '-5');
      await notices.tick();
      await settled(target, '-5');
      captured.apiErrors.set('editMessageText', refusal(description));
      await notices.tick();
      captured.apiErrors.delete('editMessageText');
      const sends = sendsTo(captured.calls, target);
      expect(sends).toHaveLength(2);
      expect(String(sends[1]!.payload.text)).toBe([loss(1), ADAPTIVE, loss(2)].join('\n\n'));
      const id = answered.get(sends[1]!.payload);
      expect(await cycleStateOf(target)).toEqual({ messageId: id, from: 0 });
      expect(messagesOf(logs(), WARN)).toEqual([
        'session trade notice edited anew: the cycle message is gone',
      ]);

      await settled(target, '-5');
      await notices.tick();
      const edits = editsTo(captured.calls, target);
      expect(edits.at(-1)?.payload.message_id).toBe(id);
      expect(heads(String(edits.at(-1)?.payload.text))).toEqual([
        '⚡ Цикл 1 Шаг 1',
        ADAPTIVE,
        '⚡ Цикл 1 Шаг 2',
        '⚡ Цикл 1 Шаг 3',
      ]);
    },
  );

  it('D17 an edit answered «message is not modified» counts as shown: no second call', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured, logs } = sender();
    await settled(target, '-5');
    await notices.tick();
    await settled(target, '-5');
    captured.apiErrors.set(
      'editMessageText',
      refusal(
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
      ),
    );
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    expect(editsTo(captured.calls, target)).toHaveLength(1);
    expect((await rowOf(target)).notifiedTrades).toBe(2);
    expect(messagesOf(logs(), WARN)).toEqual([]);
  });

  it('D18 a first step whose send outcome is unknown records nothing: the next step sends the cycle anew', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured, logs } = sender();
    await settled(target, '-5');
    failFirst(
      captured,
      1,
      new HttpError("Network request for 'sendMessage' failed!", new Error('timed out')),
    );
    await notices.tick();
    expect(await cycleStateOf(target)).toEqual({ messageId: null, from: null });
    expect(messagesOf(logs(), WARN)).toEqual(['session trade notice outcome unknown']);
    await settled(target, '-5');
    await notices.tick();
    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(2);
    expect(editsTo(captured.calls, target)).toHaveLength(0);
    expect(String(sends[1]!.payload.text)).toBe([loss(1), ADAPTIVE, loss(2)].join('\n\n'));
    expect(await cycleStateOf(target)).toEqual({
      messageId: answered.get(sends[1]!.payload),
      from: 0,
    });
  });

  it.each([
    ['a 5xx', () => telegramError(502)],
    [
      'a transport failure',
      () => new HttpError("Network request for 'editMessageText' failed!", new Error('timed out')),
    ],
  ])(
    'D19 an edit whose outcome is %s stays claimed; the next edit shows its block',
    async (_name, failure) => {
      const target = await seedSession(MARTINGALE);
      const { notices, captured, logs } = sender();
      await settled(target, '-5');
      await notices.tick();
      await settled(target, '-5');
      captured.apiErrors.set('editMessageText', failure());
      await notices.tick();
      captured.apiErrors.delete('editMessageText');
      expect((await rowOf(target)).notifiedTrades).toBe(2);
      expect(messagesOf(logs(), WARN)).toEqual(['session trade notice edit outcome unknown']);
      expect(logs().find((entry) => entry.level === WARN)).toMatchObject({
        method: 'editMessageText',
      });
      await settled(target, '-5');
      await notices.tick();
      expect(sendsTo(captured.calls, target)).toHaveLength(1);
      expect(chatOf(captured.calls, target).map(heads)).toEqual([
        ['⚡ Цикл 1 Шаг 1', ADAPTIVE, '⚡ Цикл 1 Шаг 2', '⚡ Цикл 1 Шаг 3'],
      ]);
    },
  );

  describe('D20 the length limit, under an override the registry accepts', () => {
    // a loss's block of about 440 characters: nine of them fit in 4096, ten do not; a session
    // holds up to MAX_SESSION_SUMMARY_TRADES trades, so a split takes such an override
    const PAD = 'ж'.repeat(380);
    const source = {
      sourceOf: (key: BotTextKey) =>
        key === 'sessionTradeLost'
          ? `${PAD}\n${defaultBotTextSource.sourceOf(key)}`
          : defaultBotTextSource.sourceOf(key),
    };
    afterEach(() => setBotTextSource(defaultBotTextSource));

    it('splits a cycle only between blocks: no block lost, each message within the limit', async () => {
      expect(botTextMessageOverflows(source)).toEqual([]);
      setBotTextSource(source);
      const target = await seedSession(MARTINGALE);
      const { notices, captured, logs } = sender();
      for (let step = 0; step < 12; step += 1) {
        await settled(target, '-5');
        await notices.tick();
      }
      const chat = chatOf(captured.calls, target);
      expect(chat).toHaveLength(2);
      for (const text of chat) {
        expect(plainTextOf(text).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      }
      const steps = (text: string) => heads(text).filter((line) => line.startsWith('⚡'));
      expect(steps(chat[0]!)).toEqual(
        Array.from({ length: 9 }, (_, i) => `⚡ Цикл 1 Шаг ${i + 1}`),
      );
      expect(steps(chat[1]!)).toEqual(['⚡ Цикл 1 Шаг 10', '⚡ Цикл 1 Шаг 11', '⚡ Цикл 1 Шаг 12']);
      // the first message is not edited after the split
      const first = answered.get(sendsTo(captured.calls, target)[0]!.payload);
      const editsOfFirst = editsTo(captured.calls, target).filter(
        (call) => call.payload.message_id === first,
      );
      expect(editsOfFirst).toHaveLength(8);
      expect(await cycleStateOf(target)).toEqual({
        messageId: answered.get(sendsTo(captured.calls, target)[1]!.payload),
        from: 9,
      });
      expect(
        logs().filter(
          (entry) =>
            entry.level === INFO &&
            entry.msg === 'session trade notice split: the cycle message is full',
        ),
      ).toEqual([expect.objectContaining({ sessionId: target.session.id, claimed: 9, from: 9 })]);
    });
  });

  it('D21 a send answered without a usable message_id: not recorded, the next step sends anew', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured, logs } = sender();
    captured.answers.set('sendMessage', () => ({ message_id: 0 }));
    await settled(target, '-5');
    await notices.tick();
    expect(await cycleStateOf(target)).toEqual({ messageId: null, from: null });
    expect(messagesOf(logs(), WARN)).toEqual(['session trade notice not recorded: no message id']);
    await settled(target, '-5');
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(2);
    expect(editsTo(captured.calls, target)).toHaveLength(0);
  });

  it("D22 stop() during a finished session's last step: the step ends, the summary waits for the next start - no balance read, no mark", async () => {
    const target = await seedSession(MARTINGALE);
    // a balance older than the last settle: a summary's view would ask the broker (D9)
    await snapshot(target);
    await settled(target, '-5');
    const first = sender();
    await first.notices.tick();
    await settled(target, '-5');
    await stop(target);
    // the worst path of a step: the edit finds the message gone, the new message goes
    first.captured.apiErrors.set(
      'editMessageText',
      refusal('Bad Request: message to edit not found'),
    );
    const answer = first.captured.answers.get('sendMessage')!;
    let stopping: Promise<void> | undefined;
    first.captured.answers.set('sendMessage', (payload) => {
      stopping ??= first.notices.stop();
      return answer(payload);
    });
    await first.notices.tick();
    await stopping;

    expect(first.refreshCalls).toEqual([]);
    const sends = sendsTo(first.captured.calls, target);
    expect(sends).toHaveLength(2);
    for (const send of sends) expect(send.payload.disable_notification).toBe(true);
    const row = await rowOf(target);
    expect(row.finalNoticeSentAt).toBeNull();
    expect(row.notifiedTrades).toBe(2);
    expect(await cycleStateOf(target)).toEqual({
      messageId: answered.get(sends[1]!.payload),
      from: 0,
    });
    expect(messagesOf(first.logs(), WARN)).toEqual([
      'session trade notice edited anew: the cycle message is gone',
    ]);

    const next = sender();
    await next.notices.tick();
    const summaries = sendsTo(next.captured.calls, target);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.payload.disable_notification).toBeUndefined();
    expect(next.refreshCalls).toHaveLength(1);
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
  });

  it('D4-edit 429: the step is put back, the sender pauses, then edits once', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession(MARTINGALE);
    const { notices, captured, logs } = sender({}, clock);
    await settled(target, '-5');
    await notices.tick();
    await settled(target, '-5');
    captured.apiErrors.set('editMessageText', telegramError(429, 30));
    await notices.tick();
    expect((await rowOf(target)).notifiedTrades).toBe(1);
    expect(messagesOf(logs(), WARN)).toContain('session notices paused: Telegram asked to wait');
    captured.apiErrors.delete('editMessageText');
    clock.now += 30_000;
    await notices.tick();
    expect((await rowOf(target)).notifiedTrades).toBe(2);
    expect(editsTo(captured.calls, target)).toHaveLength(2);
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
  });

  it('D4-edit another 4xx: retried, then dropped; the next step’s edit shows the dropped block', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured, logs } = sender({ config: { maxAttempts: 3 } });
    await settled(target, '-5');
    await notices.tick();
    await settled(target, '-5');
    captured.apiErrors.set('editMessageText', refusal('Bad Request: something else'));
    await notices.tick();
    await notices.tick();
    expect((await rowOf(target)).notifiedTrades).toBe(1);
    await notices.tick();
    expect((await rowOf(target)).notifiedTrades).toBe(2);
    expect(messagesOf(logs(), WARN)).toEqual([
      'session trade notice refused',
      'session trade notice refused',
      'session trade notice dropped',
    ]);
    captured.apiErrors.delete('editMessageText');
    await settled(target, '-5');
    await notices.tick();
    expect(chatOf(captured.calls, target).map(heads)).toEqual([
      ['⚡ Цикл 1 Шаг 1', ADAPTIVE, '⚡ Цикл 1 Шаг 2', '⚡ Цикл 1 Шаг 3'],
    ]);
  });

  it('D4-edit 403: the user is marked unreachable, the later steps are claimed without a call', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    await settled(target, '-5');
    await notices.tick();
    await settled(target, '-5');
    await settled(target, '-5');
    captured.apiErrors.set('editMessageText', telegramError(403));
    await notices.tick();
    expect(editsTo(captured.calls, target)).toHaveLength(1);
    const [user] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, target.seed.userId));
    expect(user?.at).toBeInstanceOf(Date);
    expect((await rowOf(target)).notifiedTrades).toBe(3);
  });
});

// #509: a session the no-signal limit stopped tells why, trades or not
describe('the summary of a no_signal_timeout stop (#509)', () => {
  const OTHER_PAIR = (data: string) => ({
    text: CLIENT_LABELS.otherPairButton,
    callback_data: data,
  });
  const MENU = { text: CLIENT_LABELS.menuButton, callback_data: 'menu' };
  const STOP_LINE = '⏳ Сессия остановлена: 2 мин по паре не было сигнала. Выбери другую пару.';

  async function seedOf(durationSec: number): Promise<Target> {
    const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, {
      settings: sessionSettings({ assetId: ASSET, durationSec }),
    });
    return { seed, session, step: 0 };
  }

  it('D10 without a trade: one summary with sound, the reason and «🔀 Выбрать другую пару» of its duration', async () => {
    const target = await seedOf(15);
    await stop(target, TradingSessionStopReason.NoSignalTimeout);
    const { notices, captured } = sender();
    await notices.tick();
    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.disable_notification).toBeUndefined();
    expect(String(sends[0]!.payload.text).split('\n')).toEqual(['📈 EUR/USD OTC', STOP_LINE]);
    expect(inlineButtons(sends[0]!.payload)).toEqual([OTHER_PAIR('demo:sig:15'), MENU]);
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
  });

  it('D11 without a trade, another reason sends nothing and marks the session', async () => {
    const target = await seedOf(15);
    await stop(target, TradingSessionStopReason.UserStopped);
    const { notices, captured } = sender();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
  });

  it('D12 with a trade: the summary carries the reason, the total and the same keyboard', async () => {
    const target = await seedOf(60);
    await settled(target, '4.6');
    await stop(target, TradingSessionStopReason.NoSignalTimeout);
    const { notices, captured } = sender();
    await notices.tick();
    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(2);
    const summary = sends[1]!;
    expect(String(summary.payload.text).split('\n').slice(0, 3)).toEqual([
      '📈 EUR/USD OTC',
      STOP_LINE,
      '📊 Итог: 1 сделка — 1 в плюс, 0 в минус',
    ]);
    // 60 s is no duration the scanner lists: the duration screen
    expect(inlineButtons(summary.payload)).toEqual([OTHER_PAIR('demo:sig'), MENU]);
  });
});

// The waiting message (#536, docs/bot-session.md → The waiting message): «🔎 Ждём сигнал…» with
// its «⏹» under the session's messages, always the last of them.
describe('the waiting message (#536)', () => {
  const STOP = (target: Target) => ({
    text: CLIENT_LABELS.sessionStopButton,
    callback_data: `session:stop:${target.session.id}:w`,
  });
  // the bot recorded its status message (#567); id 1, below every id the harness answers a send
  // with, as the session's first message in its chat
  const STATUS_ID = 1;
  const statusMessage = (target: Target) =>
    tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: STATUS_ID })
      .where(eq(tradingSessions.id, target.session.id));
  const waitingOf = async (target: Target) => {
    const row = await rowOf(target);
    return { messageId: row.waitingMessageId, slot: row.waitingAfterMessage };
  };
  // the calls to the user in order, a send as its kind: what the chat goes through
  const sequenceOf = (calls: readonly ApiCall[], target: Target) =>
    calls
      .filter((call) => call.payload.chat_id === target.seed.telegramUserId)
      .map((call) =>
        call.method === 'sendMessage'
          ? isWaiting(call)
            ? 'waiting'
            : /Цикл/.test(String(call.payload.text))
              ? 'trade'
              : 'summary'
          : call.method,
      );
  // each method's next calls answer these failures, in order; the rest go through
  function failNext(
    captured: CapturedApi,
    plan: Partial<Record<string, (ApiError | HttpError)[]>>,
  ) {
    const errors = new Map<string, ApiError | HttpError>();
    errors.get = (method: string) => plan[method]?.shift();
    captured.apiErrors = errors;
  }
  const transport = () =>
    new HttpError("Network request for 'deleteMessage' failed!", new Error('timed out'));
  const blockedAt = async (target: Target) => {
    const [user] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, target.seed.userId));
    return user?.at;
  };
  async function blocked(target: Target) {
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, target.seed.userId));
  }
  // a session whose waiting message the first tick sent
  async function waiting() {
    const target = await seedSession();
    await statusMessage(target);
    const run = sender();
    await run.notices.tick();
    const [sent] = waitingTo(run.captured.calls, target);
    if (sent === undefined) throw new Error('no waiting message');
    return { target, run, id: answered.get(sent.payload)! };
  }

  it('W1 under a recorded status message: one silent waiting message with its «⏹», once', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured } = sender();
    await notices.tick();
    const sent = waitingTo(captured.calls, target);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      text: CLIENT_TEXTS.sessionWaitingSignal.value,
      parse_mode: 'HTML',
      disable_notification: true,
    });
    expect(inlineButtons(sent[0]!.payload)).toEqual([STOP(target)]);
    // the slot is the session's latest message, here its status message (#587)
    expect(await waitingOf(target)).toEqual({
      messageId: answered.get(sent[0]!.payload),
      slot: STATUS_ID,
    });
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting']);
  });

  it('W2 with no status message and no trade: none; after the first trade’s message: under it', async () => {
    const target = await seedSession();
    const { notices, captured } = sender();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([]);
    await settled(target, '4.6');
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'waiting']);
  });

  it('W2 a trade settled before the first waiting message: the trade first, the waiting message under it', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await settled(target, '4.6');
    const { notices, captured } = sender();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'waiting']);
    const [trade] = sendsTo(captured.calls, target);
    expect((await waitingOf(target)).slot).toBe(answered.get(trade!.payload));
  });

  it('W3 a new cycle message: the waiting message deleted before it and sent again after it', async () => {
    const { target, run, id } = await waiting();
    await settled(target, '4.6');
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
    expect(deletesTo(run.captured.calls, target)).toEqual([id]);
    const [trade] = sendsTo(run.captured.calls, target);
    const next = waitingTo(run.captured.calls, target)[1]!;
    expect(await waitingOf(target)).toEqual({
      messageId: answered.get(next.payload),
      slot: answered.get(trade!.payload),
    });
  });

  it('W4 the edit of a step leaves the waiting message where it is', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    await settled(target, '-5');
    await notices.tick();
    const before = await waitingOf(target);
    await settled(target, '-5');
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'waiting', 'editMessageText']);
    expect(await waitingOf(target)).toEqual(before);
  });

  it('W5 a stop: deleted on the next tick, before the summary; never sent again', async () => {
    const { target, run, id } = await waiting();
    await stop(target, TradingSessionStopReason.UserStopped);
    await run.notices.tick();
    expect(deletesTo(run.captured.calls, target)).toEqual([id]);
    // no trade: no summary, the mark alone, after the delete
    expect(await rowOf(target)).toMatchObject({
      waitingMessageId: null,
      finalNoticeSentAt: expect.any(Date),
    });
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
  });

  it('W5 a finished session with a last trade: the delete, the trade, the summary - the summary last', async () => {
    const { target, run } = await waiting();
    await settled(target, '4.6');
    await stop(target);
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'summary',
    ]);
  });

  it('W6 a delete whose outcome is unknown holds the summary; the next tick deletes, then the summary', async () => {
    const { target, run, id } = await waiting();
    await stop(target, TradingSessionStopReason.UserStopped);
    failNext(run.captured, { deleteMessage: [telegramError(502)] });
    await run.notices.tick();
    expect(await rowOf(target)).toMatchObject({ waitingMessageId: id, finalNoticeSentAt: null });
    expect(messagesOf(run.logs(), WARN)).toEqual([
      'session waiting message delete outcome unknown',
    ]);
    await run.notices.tick();
    expect(deletesTo(run.captured.calls, target)).toEqual([id, id]);
    expect(await rowOf(target)).toMatchObject({
      waitingMessageId: null,
      finalNoticeSentAt: expect.any(Date),
    });
  });

  it('W6 three unknown outcomes: the id is dropped and the summary goes', async () => {
    const { target, run, id } = await waiting();
    await stop(target, TradingSessionStopReason.UserStopped);
    failNext(run.captured, { deleteMessage: [transport(), transport(), transport()] });
    await run.notices.tick();
    await run.notices.tick();
    expect((await rowOf(target)).finalNoticeSentAt).toBeNull();
    await run.notices.tick();
    expect(deletesTo(run.captured.calls, target)).toEqual([id, id, id]);
    expect(messagesOf(run.logs(), WARN)).toEqual([
      'session waiting message delete outcome unknown',
      'session waiting message delete outcome unknown',
      'session waiting message delete dropped',
    ]);
    expect(await rowOf(target)).toMatchObject({
      waitingMessageId: null,
      finalNoticeSentAt: expect.any(Date),
    });
  });

  it('W7 a 429 on the delete before a new cycle message: the trade is put back, then all goes after the pause', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured } = sender({}, clock);
    await notices.tick();
    await settled(target, '4.6');
    failNext(captured, { deleteMessage: [telegramError(429, 5)] });
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
    expect((await rowOf(target)).notifiedTrades).toBe(0);
    clock.now += 5_000;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
  });

  it('W7b a delete whose outcome is unknown before a new cycle message: the trade is put back; the next tick deletes first, then the trade, then the waiting message', async () => {
    const { target, run, id } = await waiting();
    await settled(target, '4.6');
    failNext(run.captured, { deleteMessage: [transport()] });
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
    expect(await rowOf(target)).toMatchObject({ notifiedTrades: 0, waitingMessageId: id });
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
    expect(deletesTo(run.captured.calls, target)).toEqual([id, id]);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
  });

  it('W7b three unknown outcomes of the delete: the third drops the id, then the trade and the waiting message', async () => {
    const { target, run, id } = await waiting();
    await settled(target, '4.6');
    failNext(run.captured, { deleteMessage: [transport(), transport(), transport()] });
    await run.notices.tick();
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'deleteMessage',
    ]);
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'deleteMessage',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
    expect(deletesTo(run.captured.calls, target)).toEqual([id, id, id]);
    expect(messagesOf(run.logs(), WARN)).toEqual([
      'session waiting message delete outcome unknown',
      'session waiting message delete outcome unknown',
      'session waiting message delete dropped',
    ]);
  });

  it.each([
    ['a 5xx', () => telegramError(502)],
    [
      'a transport failure',
      () => new HttpError("Network request for 'sendMessage' failed!", new Error('timed out')),
    ],
  ])(
    'W8 a send whose outcome is %s: nothing recorded, no second one on its slot; the next cycle message gets one',
    async (_name, failure) => {
      const target = await seedSession();
      await statusMessage(target);
      const { notices, captured, logs } = sender();
      failNext(captured, { sendMessage: [failure()] });
      await notices.tick();
      await notices.tick();
      expect(await waitingOf(target)).toEqual({ messageId: null, slot: STATUS_ID });
      expect(messagesOf(logs(), WARN)).toEqual(['session waiting message outcome unknown']);
      expect(sequenceOf(captured.calls, target)).toEqual(['waiting']);
      await settled(target, '4.6');
      await notices.tick();
      // nothing to delete: its id was never known
      expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'trade', 'waiting']);
    },
  );

  it('W9 another 4xx on the send: tried again on later ticks, then its slot is left', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured, logs } = sender({ config: { maxAttempts: 3 } });
    failNext(captured, {
      sendMessage: [telegramError(400), telegramError(400), telegramError(400)],
    });
    for (let tick = 0; tick < 4; tick += 1) await notices.tick();
    expect(waitingTo(captured.calls, target)).toHaveLength(3);
    expect(messagesOf(logs(), WARN)).toEqual([
      'session waiting message refused',
      'session waiting message refused',
      'session waiting message dropped',
    ]);
    expect(await waitingOf(target)).toEqual({ messageId: null, slot: STATUS_ID });
  });

  it('W9 a 429 on the send: the slot is freed, and it goes once after the pause', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured } = sender({}, clock);
    failNext(captured, { sendMessage: [telegramError(429, 5)] });
    await notices.tick();
    expect(await waitingOf(target)).toEqual({ messageId: null, slot: null });
    clock.now += 5_000;
    await notices.tick();
    await notices.tick();
    expect(waitingTo(captured.calls, target)).toHaveLength(2);
    expect((await waitingOf(target)).messageId).toEqual(expect.any(Number));
  });

  it('W10 a 403 on the send: the user is marked unreachable and the slot freed; once reachable, one waiting message', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured, logs } = sender();
    failNext(captured, { sendMessage: [telegramError(403)] });
    await notices.tick();
    await notices.tick();
    expect(waitingTo(captured.calls, target)).toHaveLength(1);
    expect(messagesOf(logs(), WARN)).toEqual([
      'session waiting message refused: the user is unreachable',
    ]);
    expect(await blockedAt(target)).toBeInstanceOf(Date);
    expect(await waitingOf(target)).toEqual({ messageId: null, slot: null });
    await markTelegramReachable(tmp.db, BigInt(target.seed.telegramUserId));
    await notices.tick();
    await notices.tick();
    expect(waitingTo(captured.calls, target)).toHaveLength(2);
    expect((await waitingOf(target)).messageId).toEqual(expect.any(Number));
  });

  it('W11 a session stopped between the send and its record: the message just sent is deleted', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured, logs } = sender();
    const answer = captured.answers.get('sendMessage')!;
    captured.answers.set('sendMessage', async (payload) => {
      if (inlineButtons(payload).length > 0) {
        await stop(target, TradingSessionStopReason.UserStopped);
      }
      return answer(payload);
    });
    await notices.tick();
    const [sent] = waitingTo(captured.calls, target);
    expect(deletesTo(captured.calls, target)).toEqual([answered.get(sent!.payload)]);
    expect(messagesOf(logs(), INFO)).toContain('session waiting message removed: not recorded');
    expect(await waitingOf(target)).toEqual({ messageId: null, slot: STATUS_ID });
    await notices.tick();
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
  });

  it('W12 an edit refused as gone: the waiting message deleted, the new message, the waiting message after it', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    await settled(target, '-5');
    await notices.tick();
    await settled(target, '-5');
    failNext(captured, { editMessageText: [refusal('Bad Request: message to edit not found')] });
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([
      'trade',
      'waiting',
      'editMessageText',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
  });

  it('W13 stop() during the pace before the claim: nothing is claimed or sent', async () => {
    const target = await seedSession();
    await statusMessage(target);
    let release: () => void = () => {};
    let sleeping = false;
    const { notices, captured } = sender({
      config: { perSecond: 1 },
      sleep: () => {
        sleeping = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    // the pacer's first call does not sleep: the first session's send goes, the second's waits
    const other = await seedSession();
    await statusMessage(other);
    const ticking = notices.tick();
    while (!sleeping) await new Promise((resolve) => setImmediate(resolve));
    const stopping = notices.stop();
    release();
    await Promise.all([ticking, stopping]);
    // one of the two went before the sleep; the one after it claimed nothing
    expect(waitingTo(captured.calls, target).length + waitingTo(captured.calls, other).length).toBe(
      1,
    );
    const slots = [(await waitingOf(target)).slot, (await waitingOf(other)).slot];
    expect(slots.filter((slot) => slot === null)).toHaveLength(1);
  });

  it('W14 a user who blocked the bot: none sent; a live one is dropped without a call', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await blocked(target);
    const { notices, captured } = sender();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([]);

    const { target: live, run } = await waiting();
    await blocked(live);
    await stop(live, TradingSessionStopReason.UserStopped);
    await run.notices.tick();
    expect(deletesTo(run.captured.calls, live)).toEqual([]);
    expect(await rowOf(live)).toMatchObject({
      waitingMessageId: null,
      finalNoticeSentAt: expect.any(Date),
    });
  });

  it.each([
    ["Bad Request: message can't be deleted", WARN, 'session waiting message not deleted'],
    [
      "Bad Request: message can't be deleted for everyone",
      WARN,
      'session waiting message not deleted',
    ],
    ['Bad Request: message to delete not found', INFO, 'session waiting message already gone'],
  ])(
    'W15 a delete refused «%s»: the id is dropped, logged once, the summary goes',
    async (description, level, message) => {
      const { target, run } = await waiting();
      await stop(target, TradingSessionStopReason.UserStopped);
      failNext(run.captured, { deleteMessage: [refusal(description)] });
      await run.notices.tick();
      expect(messagesOf(run.logs(), level).filter((msg) => msg === message)).toHaveLength(1);
      expect(await rowOf(target)).toMatchObject({
        waitingMessageId: null,
        finalNoticeSentAt: expect.any(Date),
      });
    },
  );

  it('W16 two senders at once: one waiting message on the slot', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const first = sender();
    const second = sender();
    await Promise.all([first.notices.tick(), second.notices.tick()]);
    expect(
      waitingTo(first.captured.calls, target).length +
        waitingTo(second.captured.calls, target).length,
    ).toBe(1);
  });

  // the trade's send after the waiting message was deleted: the new message is not recorded
  it.each([
    ['a 5xx', (captured: CapturedApi) => failNext(captured, { sendMessage: [telegramError(502)] })],
    [
      'no usable message_id',
      (captured: CapturedApi) => {
        const answer = captured.answers.get('sendMessage')!;
        let first = true;
        captured.answers.set('sendMessage', (payload) => {
          if (first) {
            first = false;
            return { message_id: 0 };
          }
          return answer(payload);
        });
      },
    ],
  ])(
    'W17 the waiting message deleted, then a new cycle message not recorded (%s): the waiting message under it in the same tick',
    async (_name, arrange) => {
      const { target, run, id } = await waiting();
      await settled(target, '4.6');
      arrange(run.captured);
      await run.notices.tick();
      expect(sequenceOf(run.captured.calls, target)).toEqual([
        'waiting',
        'deleteMessage',
        'trade',
        'waiting',
      ]);
      expect(deletesTo(run.captured.calls, target)).toEqual([id]);
      const next = waitingTo(run.captured.calls, target)[1]!;
      expect((await rowOf(target)).cycleMessageId).toBeNull();
      expect((await waitingOf(target)).messageId).toBe(answered.get(next.payload));
    },
  );

  // a state production reaches: a second sender claimed the next trade while the first one's
  // message was on its way, so the first one's record is refused (#536 round 2, Minor 4)
  it('W17 the waiting message deleted, then a new cycle message whose record a second sender refused: no waiting message in that tick, one on the next', async () => {
    const { target, run } = await waiting();
    await settled(target, '4.6');
    await settled(target, '-5');
    const answer = run.captured.answers.get('sendMessage')!;
    let first = true;
    run.captured.answers.set('sendMessage', async (payload) => {
      if (first && inlineButtons(payload).length === 0) {
        first = false;
        await claimSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 1 });
      }
      return answer(payload);
    });
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'trade']);
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 2,
      cycleMessageId: null,
      waitingMessageId: null,
      waitingAfterMessage: null,
    });
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
    expect((await rowOf(target)).cycleMessageId).toBeNull();
  });

  it('W17 the waiting message deleted, then the new cycle message refused three times: none while it is retried, then under it', async () => {
    const { target, run } = await waiting();
    await settled(target, '4.6');
    failNext(run.captured, {
      sendMessage: [telegramError(400), telegramError(400), telegramError(400)],
    });
    await run.notices.tick();
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'trade',
    ]);
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'trade',
      'trade',
      'waiting',
    ]);
    expect(messagesOf(run.logs(), WARN)).toEqual([
      'session trade notice refused',
      'session trade notice refused',
      'session trade notice dropped',
    ]);
  });

  it('W17 the waiting message deleted, then a 403 on the new cycle message: nothing more; once reachable, one waiting message', async () => {
    const { target, run } = await waiting();
    await settled(target, '4.6');
    failNext(run.captured, { sendMessage: [telegramError(403)] });
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'trade']);
    expect(await blockedAt(target)).toBeInstanceOf(Date);
    await markTelegramReachable(tmp.db, BigInt(target.seed.telegramUserId));
    await run.notices.tick();
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
  });

  // #587: the waiting message is still in the chat, so its id is kept while the session runs
  it('W17 a 403 on the delete before a new cycle message: the user is marked, the trade counts as sent without a call, the id kept', async () => {
    const { target, run, id } = await waiting();
    await settled(target, '4.6');
    failNext(run.captured, { deleteMessage: [telegramError(403)] });
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
    expect(await blockedAt(target)).toBeInstanceOf(Date);
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 1,
      waitingMessageId: id,
      waitingAfterMessage: STATUS_ID,
    });
  });

  // #587 finding 1: the waiting message a blocked user still has is deleted first once the user is
  // reachable again, never a second «⏹» beside it
  it('W22 a 403 on the delete keeps the id while the session runs; after the unblock the next trade deletes it first: one «⏹»', async () => {
    const { target, run, id } = await waiting();
    await settled(target, '4.6');
    failNext(run.captured, { deleteMessage: [telegramError(403)] });
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
    expect(await waitingOf(target)).toEqual({ messageId: id, slot: STATUS_ID });
    expect(await blockedAt(target)).toBeInstanceOf(Date);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
    expect(messagesOf(run.logs(), WARN)).toEqual([
      'session waiting message refused: the user is unreachable',
    ]);
    await markTelegramReachable(tmp.db, BigInt(target.seed.telegramUserId));
    await run.notices.tick();
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
    await settled(target, '4.6');
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
    expect(deletesTo(run.captured.calls, target)).toEqual([id, id]);
    const [trade] = sendsTo(run.captured.calls, target);
    const next = waitingTo(run.captured.calls, target)[1]!;
    expect(await waitingOf(target)).toEqual({
      messageId: answered.get(next.payload),
      slot: answered.get(trade!.payload),
    });
  });

  it('W14b the flag read with the list: a trade of the running session is claimed without a call and the id kept; after the stop it is dropped without a call', async () => {
    const { target, run, id } = await waiting();
    await blocked(target);
    await settled(target, '4.6');
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting']);
    expect(await rowOf(target)).toMatchObject({ notifiedTrades: 1, waitingMessageId: id });
    await stop(target, TradingSessionStopReason.UserStopped);
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting']);
    expect(await rowOf(target)).toMatchObject({
      waitingMessageId: null,
      waitingAfterMessage: null,
      finalNoticeSentAt: expect.any(Date),
    });
  });

  // #587 finding 5: a relaunch's status message, recorded by the bot's first poll, is newer than
  // the waiting message's slot, so the waiting message moves under it
  it('W25 a newer status message recorded (a relaunch): the waiting message deleted and sent again under it', async () => {
    const { target, run, id } = await waiting();
    messageIds += 1;
    const relaunch = messageIds;
    expect(
      await recordSessionStatusMessage(tmp.db, {
        id: target.session.id,
        telegramUserId: target.seed.telegramUserId,
        messageId: relaunch,
      }),
    ).toBe(true);
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'waiting']);
    expect(deletesTo(run.captured.calls, target)).toEqual([id]);
    const next = waitingTo(run.captured.calls, target)[1]!;
    expect(await waitingOf(target)).toEqual({
      messageId: answered.get(next.payload),
      slot: relaunch,
    });
    await run.notices.tick();
    expect(waitingTo(run.captured.calls, target)).toHaveLength(2);
  });

  // #587 finding 6: the bot's «⏹» hands the waiting message over; the bot draws its reply there
  it('W26 a stop that took the waiting message over: no delete; the summary next, or the mark alone', async () => {
    const quiet = await waiting();
    await stopTradingSession(tmp.db, {
      id: quiet.target.session.id,
      reason: TradingSessionStopReason.UserStopped,
      waitingMessageId: quiet.id,
    });
    await quiet.run.notices.tick();
    await quiet.run.notices.tick();
    expect(sequenceOf(quiet.run.captured.calls, quiet.target)).toEqual(['waiting']);
    expect((await rowOf(quiet.target)).finalNoticeSentAt).toBeInstanceOf(Date);

    const traded = await waiting();
    await settled(traded.target, '4.6');
    await traded.run.notices.tick();
    const tradeWaiting = waitingTo(traded.run.captured.calls, traded.target)[1]!;
    await stopTradingSession(tmp.db, {
      id: traded.target.session.id,
      reason: TradingSessionStopReason.UserStopped,
      waitingMessageId: answered.get(tradeWaiting.payload)!,
    });
    await traded.run.notices.tick();
    expect(sequenceOf(traded.run.captured.calls, traded.target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
      'summary',
    ]);
  });

  // #587 round 1, Major 1: the sender's row is from the tick's list; a session served before it
  // gives the «⏹» time to hand the waiting message over, and the bot then draws in place of it
  async function handedOverMidTick(onWaitingToA: (b: Target, id: number) => Promise<void>) {
    const a = await seedSession();
    const b = await waiting();
    return {
      a,
      ...b,
      arm: async () => {
        await statusMessage(a);
        const answer = b.run.captured.answers.get('sendMessage')!;
        let done = false;
        b.run.captured.answers.set('sendMessage', async (payload) => {
          const toA = payload.chat_id === a.seed.telegramUserId;
          if (!done && toA && inlineButtons(payload).length > 0) {
            done = true;
            await onWaitingToA(b.target, b.id);
          }
          return answer(payload);
        });
      },
    };
  }

  it('W27 a hand-over between the list read and the session’s turn, before a new cycle message: no delete, the trade, then the summary', async () => {
    const run = await handedOverMidTick(async (b, id) => {
      await stopTradingSession(tmp.db, {
        id: b.session.id,
        reason: TradingSessionStopReason.UserStopped,
        waitingMessageId: id,
      });
    });
    await settled(run.target, '4.6');
    await run.arm();
    await run.run.notices.tick();
    expect(deletesTo(run.run.captured.calls, run.target)).toEqual([]);
    expect(sequenceOf(run.run.captured.calls, run.target)).toEqual(['waiting', 'trade']);
    expect(messagesOf(run.run.logs(), INFO)).toContain(
      'session waiting message taken over: not deleted',
    );
    await run.run.notices.tick();
    expect(sequenceOf(run.run.captured.calls, run.target)).toEqual(['waiting', 'trade', 'summary']);
    expect((await rowOf(run.target)).finalNoticeSentAt).toBeInstanceOf(Date);
  });

  it('W28 the 409 clear between the list read and a stale delete: no delete, the summary in the same tick', async () => {
    let live = 0;
    const run = await handedOverMidTick(async (b) => {
      await clearSessionWaitingMessage(tmp.db, { sessionId: b.session.id, messageId: live });
    });
    await settled(run.target, '4.6');
    await run.run.notices.tick();
    expect(sequenceOf(run.run.captured.calls, run.target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
    live = (await waitingOf(run.target)).messageId!;
    await stop(run.target);
    await run.arm();
    await run.run.notices.tick();
    expect(deletesTo(run.run.captured.calls, run.target)).toEqual([run.id]);
    expect(sequenceOf(run.run.captured.calls, run.target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
      'summary',
    ]);
    expect(messagesOf(run.run.logs(), INFO)).toContain(
      'session waiting message taken over: not deleted',
    );
  });

  // docs/bot-session.md risk 82 (a): what the re-read cannot close is logged
  it('W29 a hand-over during the delete call itself: the delete made, the clear finds the id gone, logged; the mark all the same', async () => {
    const { target, run, id } = await waiting();
    await stop(target, TradingSessionStopReason.UserStopped);
    run.captured.answers.set('deleteMessage', async () => {
      await clearSessionWaitingMessage(tmp.db, { sessionId: target.session.id, messageId: id });
      return true;
    });
    await run.notices.tick();
    expect(deletesTo(run.captured.calls, target)).toEqual([id]);
    expect(messagesOf(run.logs(), WARN)).toContain(
      'session waiting message deleted after the stop took it over',
    );
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
  });

  // #587 finding 3 (#584 m3): both lines are read from the log
  it('W23 a waiting send answered without a usable message_id: logged, the slot claimed with no id, nothing more until a new message of the session', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured, logs } = sender();
    const answer = captured.answers.get('sendMessage')!;
    captured.answers.set('sendMessage', (payload) =>
      inlineButtons(payload).length > 0 && waitingTo(captured.calls, target).length === 1
        ? { message_id: 0 }
        : answer(payload),
    );
    await notices.tick();
    await notices.tick();
    expect(messagesOf(logs(), WARN)).toEqual([
      'session waiting message not recorded: no message id',
    ]);
    expect(await waitingOf(target)).toEqual({ messageId: null, slot: STATUS_ID });
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting']);
    await settled(target, '4.6');
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'trade', 'waiting']);
  });

  it('W24 a refused record whose clean-up delete fails: logged, the message stays, the summary still goes', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured, logs } = sender();
    const answer = captured.answers.get('sendMessage')!;
    captured.answers.set('sendMessage', async (payload) => {
      if (inlineButtons(payload).length > 0) {
        await stop(target, TradingSessionStopReason.UserStopped);
      }
      return answer(payload);
    });
    failNext(captured, { deleteMessage: [telegramError(502)] });
    await notices.tick();
    const [sent] = waitingTo(captured.calls, target);
    expect(deletesTo(captured.calls, target)).toEqual([answered.get(sent!.payload)]);
    expect(messagesOf(logs(), WARN)).toEqual(['session waiting message not removed']);
    expect(await waitingOf(target)).toEqual({ messageId: null, slot: STATUS_ID });
    await notices.tick();
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
  });

  // No backfill (owner 2026-10-17): at the deploy the columns are NULL, so every running session
  // with an anchor is due on the sender's first tick, at the sender's pace
  it('W21 sessions running at the deploy: one waiting message each on the first tick, at the sender’s pace', async () => {
    const targets: Target[] = [];
    for (let i = 0; i < 3; i += 1) {
      const target = await seedSession();
      await statusMessage(target);
      await settled(target, '4.6');
      // what the backend before #536 left: the trade claimed and sent in a cycle message
      await claimSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 0 });
      await recordSessionCycleMessage(tmp.db, {
        sessionId: target.session.id,
        claimed: 0,
        messageId: 900 + i,
        from: 0,
      });
      expect(await waitingOf(target)).toEqual({ messageId: null, slot: null });
      targets.push(target);
    }
    const clock = { now: 0 };
    const run = sender(
      {
        sleep: async (ms) => {
          clock.now += ms;
        },
      },
      clock,
    );
    const sentAt = new Map<unknown, number>();
    const answer = run.captured.answers.get('sendMessage')!;
    run.captured.answers.set('sendMessage', (payload) => {
      if (inlineButtons(payload).length > 0) sentAt.set(payload.chat_id, clock.now);
      return answer(payload);
    });
    await run.notices.tick();
    for (const target of targets) {
      expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting']);
      const [sent] = waitingTo(run.captured.calls, target);
      expect(inlineButtons(sent!.payload)).toEqual([STOP(target)]);
      expect(await waitingOf(target)).toEqual({
        messageId: answered.get(sent!.payload),
        slot: 900 + targets.indexOf(target),
      });
    }
    const times = targets.map((target) => sentAt.get(target.seed.telegramUserId)!);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(
        1000 / SESSION_NOTICE_SEND_PER_SECOND - 1e-9,
      );
    }
    await run.notices.tick();
    for (const target of targets) {
      expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting']);
    }
  });

  it('W19 no status message, the first trade’s send outcome unknown: one waiting message on the next tick', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    const { notices, captured } = sender();
    failNext(captured, { sendMessage: [telegramError(502)] });
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade']);
    await notices.tick();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'waiting']);
    expect(await rowOf(target)).toMatchObject({ cycleMessageId: null, notifiedTrades: 1 });
  });
});
