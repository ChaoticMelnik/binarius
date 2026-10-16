import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TradeAction,
  TradeIntentStatus,
  TradingSessionStopReason,
  decimalStringSchema,
  logOptions,
  type BinaryPair,
  type BrokerUser,
  type DecimalString,
  type PairsCatalogView,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor } from '@binarius/shared/testing';
import {
  createSessionIntent,
  markIntentAccepted,
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
import { CLIENT_LABELS, CLIENT_TEXTS } from '../auth/texts';
import type { BalanceRefreshOutcome } from '../broker/balance-reconciler';
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

async function seedSession(): Promise<Target> {
  const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
  const session = await seedTradingSession(tmp.db, seed.brokerAccountId, {
    settings: sessionSettings({
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

const sendsTo = (calls: readonly ApiCall[], target: Target) =>
  callsTo(calls, 'sendMessage').filter(
    (call) => call.payload.chat_id === target.seed.telegramUserId,
  );
const textsTo = (calls: readonly ApiCall[], target: Target) =>
  sendsTo(calls, target).map((call) => String(call.payload.text));
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
      '🏁 Сессия завершена: 5 сделок — 2 в плюс, 2 в минус, 1 в ноль',
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
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(3);
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
