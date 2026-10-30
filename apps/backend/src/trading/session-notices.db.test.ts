import { randomUUID } from 'node:crypto';
import { eq, isNull, sql } from 'drizzle-orm';
import { HttpError, InputFile } from 'grammy';
import type { ApiError } from 'grammy/types';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BotLanguage,
  SignalDecisionOutcome,
  TradeAction,
  TradeIntentStatus,
  TradingSessionStopReason,
  BOT_TEXT_LIMIT,
  buildH1SessionSettings,
  botTextMessageOverflows,
  H1_R1_PARAMS,
  decimalStringSchema,
  isH1Settings,
  defaultBotTextSource,
  logOptions,
  plainTextOf,
  type BinaryPair,
  type BotTextKey,
  type BrokerUser,
  type DecimalString,
  type PairsCatalogView,
  type TradingSessionSettings,
  SessionStakeStrategy,
  BOT_TEXT_DEFAULT_SOURCES,
} from '@binarius/shared';
import { closedTradeFor, openTradeFor, until, botTextSourcesWith } from '@binarius/shared/testing';
import { createH1Detector } from '@binarius/signal';
import {
  claimSessionTradeNotice,
  claimSummaryFallback,
  clearSessionWaitingMessage,
  createSessionIntent,
  markIntentAccepted,
  markTelegramReachable,
  SESSION_NOTICE_CHANNEL,
  recordSessionCycleMessage,
  recordSessionStatusMessage,
  recordSignalDecision,
  releaseSummaryFallback,
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
  decisionFixture,
  noSignalDecisionFixture,
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
  pushedText,
  type ApiCall,
  type CapturedApi,
} from '../admin/testing';
import { createClientPush } from '../auth/client-push';
import { createScanMedia } from './scan-media';
import { clientLabelsOf, clientTextsOf, setBotTextSources } from '../auth/texts';
import type { BalanceRefreshOutcome } from '../broker/balance-reconciler';
import {
  SESSION_NOTICE_CHAT_GAP_MS,
  SESSION_NOTICE_HOLD_MS,
  SESSION_NOTICE_SEND_PER_SECOND,
  SESSION_NOTICE_WAKE_GAP_MS,
} from '../timing';
import { h1DriverDecisionInput } from '../h1/driver';
import { createSessionNoticeListener, type SessionNoticeListener } from './session-notice-listener';
import {
  createSessionNoticeSender,
  type SessionNoticeConfig,
  type SessionNoticeSender,
  type SessionNoticeSenderDeps,
} from './session-notices';
import { readFinishedSessionView } from './session-view';

// the Russian texts, the language of every user these tests make (#633)
const RU_TEXTS = clientTextsOf(BotLanguage.Ru);
const RU_LABELS = clientLabelsOf(BotLanguage.Ru);

// The session notices' sender (#464, docs/bot-session.md → Trade messages) against a temporary
// migrated database and an intercepted Telegram API. A session the bot tracks no status message of
// gets the backend's fallback text summary on the tick of its final mark (#537), so the cases
// without a status message read that text as the session's summary. Each case starts with every older session
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
// both marks (#537): an older session left to the fallback would send its text summary here
beforeEach(async () => {
  await tmp.db
    .update(tradingSessions)
    .set({
      finalNoticeSentAt: sql`coalesce(${tradingSessions.finalNoticeSentAt}, now())`,
      summarySentAt: sql`now()`,
    })
    .where(isNull(tradingSessions.summarySentAt));
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
      // the intent's row of the decision log, in its transaction, as the orchestrator writes it:
      // it ends the session's wait for a signal (#722)
      decision: decisionFixture(
        { sessionId: target.session.id, brokerAccountId: target.seed.brokerAccountId },
        { step: target.step },
      ),
    })
  ).intent;
}

// the orchestrator's decision of the session's next step (#722): `no_signal` makes the session
// wait for a signal, and the waiting message is due; any other outcome ends the wait
const decide = (target: Target, outcome: SignalDecisionOutcome, detail: string | null = null) => {
  const session = { sessionId: target.session.id, brokerAccountId: target.seed.brokerAccountId };
  const facts = { step: target.step + 1, outcome, detail };
  return recordSignalDecision(
    tmp.db,
    outcome === SignalDecisionOutcome.NoSignal
      ? noSignalDecisionFixture(session, facts)
      : decisionFixture(session, facts),
  );
};
const noSignal = (target: Target) => decide(target, SignalDecisionOutcome.NoSignal);
// the next step settled, then no signal for the one after: the session waits again (#722)
async function settledWaiting(target: Target, profit: string): Promise<void> {
  await settled(target, profit);
  await noSignal(target);
}

// the next step open at the broker, at step/10 (#700)
async function opened(target: Target) {
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
  return { intent, open, closePrice: target.step / 10 + 0.0001 };
}

// an open trade settled at `profit`, closed 0.0001 above its open price
async function settle(
  { intent, open, closePrice }: Awaited<ReturnType<typeof opened>>,
  profit: string,
): Promise<void> {
  await tmp.db.transaction((tx) =>
    settleIntent(tx, {
      id: intent.id,
      from: TradeIntentStatus.Accepted,
      trade: closedTradeFor(open, { profit: profit as DecimalString, closePrice }),
    }),
  );
}

// the next step settled at `profit`, opened at step/10 and closed 0.0001 above
async function settled(target: Target, profit: string): Promise<void> {
  await settle(await opened(target), profit);
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
  patch: Partial<Omit<SessionNoticeSenderDeps, 'logger' | 'push'>> & {
    config?: Partial<SessionNoticeConfig>;
  } = {},
  clock = { now: 0 },
  level: 'info' | 'debug' = 'info',
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
  // the waiting message (#860): the animation answered with its id and the file's id
  captured.answers.set('sendAnimation', (payload) => {
    messageIds += 1;
    answered.set(payload, messageIds);
    return { message_id: messageIds, animation: { file_id: RADAR_FILE_ID } };
  });
  const lines: string[] = [];
  const logger = pino(logOptions(level), { write: (line: string) => void lines.push(line) });
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
    media: createScanMedia(logger),
    logger,
    now: () => clock.now,
    sleep: async () => {},
    ...patch,
    // the gap per chat (#660) off, as the pace is with a sleep that does nothing; the G-tests
    // turn it on
    config: { chatGapMs: 0, ...patch.config },
  });
  senders.push(notices);
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { notices, captured, push, logs, refreshCalls };
}
// A step skipped for a cooling chat arms a timer that wakes its sender (#723): every sender is
// stopped after its case, so none ticks under a later case's sessions
const senders: SessionNoticeSender[] = [];
afterEach(async () => {
  await Promise.all(senders.splice(0).map((notices) => notices.stop()));
});

let messageIds = 0;
const RADAR_FILE_ID = 'radar-file-id';
// the id each answered send got, by its recorded payload
const answered = new WeakMap<object, number>();
// the edits Telegram applied (a refused one is recorded as a call too)
const edited = new WeakSet<object>();

// the waiting message (#536): its «⏹» by its data, `:w` - the open block's has the same label
// and `:c` (#722)
const isWaiting = (call: ApiCall) =>
  inlineButtons(call.payload).some((button) =>
    /^session:stop:[0-9a-f-]{36}:w$/.test(button.callback_data ?? ''),
  );
// the open block's «⏹» (#722)
const CYCLE_STOP = (target: Target) => [
  { text: RU_LABELS.sessionStopButton, callback_data: `session:stop:${target.session.id}:c` },
];
// the trades' messages and the summary; the waiting messages are waitingTo's
const sendsTo = (calls: readonly ApiCall[], target: Target) =>
  callsTo(calls, 'sendMessage').filter(
    (call) => call.payload.chat_id === target.seed.telegramUserId && !isWaiting(call),
  );
const waitingTo = (calls: readonly ApiCall[], target: Target) =>
  callsTo(calls, 'sendAnimation').filter(
    (call) => call.payload.chat_id === target.seed.telegramUserId && isWaiting(call),
  );
const deletesTo = (calls: readonly ApiCall[], target: Target) =>
  callsTo(calls, 'deleteMessage')
    .filter((call) => call.payload.chat_id === target.seed.telegramUserId)
    .map((call) => Number(call.payload.message_id));
const textsTo = (calls: readonly ApiCall[], target: Target) =>
  sendsTo(calls, target).map((call) => pushedText(call.payload));
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
    if (id !== undefined) shown.set(id, pushedText(call.payload));
  }
  return [...shown.values()];
}
const rowOf = async (target: Target) =>
  (
    await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, target.session.id))
  )[0]!;
// The fallback summary's balance refresh is not waited for (#870): a tick starts it and skips the
// session, a later tick sends the summary. `ticks` until the summary step of `target` is closed.
async function untilSummary(target: Target, ticks: () => Promise<unknown>) {
  await ticks();
  await until('the fallback summary', async () => {
    if ((await rowOf(target)).summarySentAt !== null) return true;
    await ticks();
    return false;
  });
}
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
// the calls to the user in order, a send as its kind: what the chat goes through
const sequenceOf = (calls: readonly ApiCall[], target: Target) =>
  calls
    .filter((call) => call.payload.chat_id === target.seed.telegramUserId)
    .map((call) =>
      call.method === 'sendAnimation'
        ? 'waiting'
        : call.method === 'sendMessage'
          ? /Цикл/.test(pushedText(call.payload))
            ? 'trade'
            : 'summary'
          : call.method,
    );
// each method's next calls answer these failures, in order; the rest go through
function failNext(captured: CapturedApi, plan: Partial<Record<string, (ApiError | HttpError)[]>>) {
  const errors = new Map<string, ApiError | HttpError>();
  errors.get = (method: string) => plan[method]?.shift();
  captured.apiErrors = errors;
}

describe('the session notices (#464)', () => {
  it('D1 a finished five-trade session without a status message: five silent messages in order, then the fallback summary with sound (#537)', async () => {
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
    expect(trades.map((call) => pushedText(call.payload))).toEqual([
      '⚡ Цикл 1 Шаг 1\n<pre>🟢 $5.00 → +$9.60\n📊 0.10000 → 0.10010</pre>',
      '⚡ Цикл 2 Шаг 1\n<pre>🔴 $5.00 → -$5.00\n📊 0.20000 → 0.20010</pre>',
      '⚡ Цикл 3 Шаг 1\n<pre>⚪ $5.00 → $0.00\n↩️ ставка вернулась\n📊 0.30000 → 0.30010</pre>',
      '⚡ Цикл 4 Шаг 1\n<pre>🟢 $5.00 → +$9.25\n📊 0.40000 → 0.40010</pre>',
      '⚡ Цикл 5 Шаг 1\n<pre>🔴 $5.00 → -$5.00\n📊 0.50000 → 0.50010</pre>',
    ]);
    const summary = sends[5]!;
    expect(summary.payload.disable_notification).toBeUndefined();
    expect(inlineButtons(summary.payload)).toEqual([
      { text: RU_LABELS.menuButton, callback_data: 'menu' },
    ]);
    expect(pushedText(summary.payload).split('\n')).toEqual([
      '📈 EUR/USD',
      '🏁 Сессия завершена: 5 циклов, 5 сделок — 2 в плюс, 2 в минус, 1 в ноль',
      '💰 Результат: -$1.15',
      '🧪 Демобаланс: $10 002.50',
    ]);
    // the snapshot is newer than the last settle: no broker call
    expect(refreshCalls).toHaveLength(0);
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 5,
      finalNoticeSentAt: expect.any(Date),
      summarySentAt: expect.any(Date),
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
    await untilSummary(target, () => second.notices.tick());
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
    await untilSummary(target, () =>
      Promise.all([a.notices.tick(), b.notices.tick(), a.notices.tick(), b.notices.tick()]),
    );
    const texts = [...textsTo(a.captured.calls, target), ...textsTo(b.captured.calls, target)];
    expect(texts).toHaveLength(4);
    expect(new Set(texts).size).toBe(4);
  });

  it("D5' a user who blocked the bot: the trades claimed, both marks set, nothing is sent, no balance read (#537)", async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await stop(target);
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, target.seed.userId));
    const { notices, captured, refreshCalls } = sender();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 1,
      finalNoticeSentAt: expect.any(Date),
    });
    // one statement: the summary step closed with the final mark, to the microsecond - the
    // fallback's claim of a blocked user would write a later now()
    const [marks] = await tmp.db
      .select({
        same: sql<boolean>`${tradingSessions.summarySentAt} = ${tradingSessions.finalNoticeSentAt}`,
      })
      .from(tradingSessions)
      .where(eq(tradingSessions.id, target.session.id));
    expect(marks?.same).toBe(true);
    expect(refreshCalls).toHaveLength(0);
  });

  it("D6 each session's notices go to its owner only", async () => {
    const first = await seedSession();
    const second = await seedSession();
    await settledWaiting(first, '4.6');
    await settled(second, '-5');
    await settledWaiting(second, '-5');
    const { notices, captured } = sender();
    await notices.tick();
    expect(textsTo(captured.calls, first)).toHaveLength(1);
    expect(textsTo(captured.calls, first)[0]).toContain('🟢');
    expect(textsTo(captured.calls, second)).toHaveLength(2);
    expect(textsTo(captured.calls, second).every((text) => text.includes('🔴'))).toBe(true);
    // and each its own waiting message (#536) under them
    expect(waitingTo(captured.calls, first)).toHaveLength(1);
    expect(waitingTo(captured.calls, second)).toHaveLength(1);
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(3);
    expect(callsTo(captured.calls, 'sendAnimation')).toHaveLength(2);
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
    await untilSummary(target, () => notices.tick());
    const texts = textsTo(captured.calls, target);
    expect(texts).toHaveLength(3);
    expect(texts[1]).toContain('⚡ Цикл 2 Шаг 1\n<pre>🔴');
    expect(texts[2]).toBe(
      [
        '📈 EUR/USD',
        RU_TEXTS.sessionStopManualReview.value,
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
    await until('the refresh', () => refreshCalls.length > 0);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]![0]).toBe(target.seed.brokerAccountId);
    expect(refreshCalls[0]![1]).toMatchObject({ mayRefresh: false });
    expect(refreshCalls[0]![1]).not.toHaveProperty('requested');
    // the tick did not wait for it (#870): the trade, no summary yet
    expect(textsTo(captured.calls, target)).toHaveLength(1);
    expect((await rowOf(target)).summarySentAt).toBeNull();
    await untilSummary(target, () => notices.tick());
    // the refresh did not answer 'ok': the stored balance with its age, and no second GET
    expect(textsTo(captured.calls, target).at(-1)).toMatch(/🧪 Демобаланс: .*\n🕒/);
    expect(refreshCalls).toHaveLength(1);
  });
});

// #633: every notice in the owner's language, read with the session each tick
describe('the session notices in English (#633)', () => {
  it('D-lang the open block and its «⏹», the settled block, the waiting message and the fallback summary', async () => {
    const target = await seedSession();
    await tmp.db
      .update(users)
      .set({ language: BotLanguage.En })
      .where(eq(users.id, target.seed.userId));
    const EN_LABELS = clientLabelsOf(BotLanguage.En);
    const CYRILLIC = /[А-Яа-яЁё]/u;
    const { notices, captured } = sender();

    const trade = await opened(target);
    await notices.tick();
    const [open] = sendsTo(captured.calls, target);
    expect(pushedText(open!.payload)).toContain('⚡ Cycle 1 Step 1\n<pre>⏳ $5.00 · ');
    expect(inlineButtons(open!.payload)).toEqual([
      { text: EN_LABELS.sessionStopButton, callback_data: `session:stop:${target.session.id}:c` },
    ]);

    await settle(trade, '4.6');
    await noSignal(target);
    await notices.tick();
    expect(pushedText(editsTo(captured.calls, target)[0]!.payload)).toContain(
      '<pre>🟢 $5.00 → +$9.60',
    );
    const [waiting] = waitingTo(captured.calls, target);
    expect(waiting!.payload.caption).toBe(
      `${clientTextsOf(BotLanguage.En).sessionWaitingSignal.value}\n\n` +
        '🛰 <b>Scanning EUR/USD</b> · waiting for the price to move\n' +
        '⏳ Quotes  ⏳ Price movement  ⏳ Signal selection',
    );
    expect(inlineButtons(waiting!.payload)[0]?.text).toBe(EN_LABELS.sessionStopButton);

    await stop(target);
    await snapshot(target);
    await notices.tick();
    await notices.tick();
    const summary = sendsTo(captured.calls, target).at(-1)!;
    expect(pushedText(summary.payload).split('\n').slice(0, 2)).toEqual([
      '📈 EUR/USD',
      '🏁 Session completed: 1 cycle, 1 trade — 1 won, 0 lost',
    ]);
    expect(inlineButtons(summary.payload)).toEqual([
      { text: EN_LABELS.menuButton, callback_data: 'menu' },
    ]);
    for (const call of [
      ...callsTo(captured.calls, 'sendMessage'),
      ...editsTo(captured.calls, target),
    ]) {
      if (call.payload.chat_id !== target.seed.telegramUserId) continue;
      expect(pushedText(call.payload)).not.toMatch(CYRILLIC);
    }
    expect(String(waiting!.payload.caption)).not.toMatch(CYRILLIC);
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
});

const ADAPTIVE = '🔄 Адаптивная ставка';
// the heads of a message: its blocks' «⚡ Цикл N Шаг M» and the adaptive line
const heads = (text: string) =>
  text.split('\n').filter((line) => line.startsWith('⚡') || line.startsWith('🔄'));
const loss = (step: number, cycle = 1, at = step) =>
  `⚡ Цикл ${cycle} Шаг ${step}\n<pre>🔴 $5.00 → -$5.00\n📊 ${(at / 10).toFixed(5)} → ${(at / 10 + 0.0001).toFixed(5)}</pre>`;

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
    // the lost step 1 carries the adaptive line under it at once (#718)
    expect(pushedText(sendsTo(captured.calls, target)[0]!.payload)).toBe(
      [loss(1), ADAPTIVE].join('\n\n'),
    );
    const edits = editsTo(captured.calls, target);
    expect(edits).toHaveLength(2);
    const id = answered.get(sendsTo(captured.calls, target)[0]!.payload);
    for (const edit of edits) {
      expect(edit.payload.message_id).toBe(id);
      expect(edit.payload.parse_mode).toBe('HTML');
      expect(edit.payload.reply_markup).toBeUndefined();
    }
    expect(pushedText(edits[0]!.payload)).toBe([loss(1), ADAPTIVE, loss(2)].join('\n\n'));
    expect(pushedText(edits[1]!.payload)).toBe(
      [
        loss(1),
        ADAPTIVE,
        loss(2),
        '⚡ Цикл 1 Шаг 3\n<pre>🟢 $5.00 → +$9.60\n📊 0.30000 → 0.30010</pre>',
      ].join('\n\n'),
    );
    expect(await cycleStateOf(target)).toEqual({ messageId: id, from: 0 });

    await settled(target, '-5');
    await notices.tick();
    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(2);
    expect(pushedText(sends[1]!.payload)).toBe([loss(1, 2, 4), ADAPTIVE].join('\n\n'));
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
    expect(pushedText(editsTo(captured.calls, target)[0]!.payload)).toContain(
      '⚪ $5.00 → $0.00\n↩️ ставка вернулась',
    );
  });

  it('D19 a lost step 1 and a stop before step 2: the line stays under it, the summary follows (#718)', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    await settled(target, '-5');
    await stop(target, TradingSessionStopReason.UserStopped);
    await notices.tick();
    await notices.tick();
    const chat = chatOf(captured.calls, target);
    expect(chat).toHaveLength(2);
    expect(chat[0]).toBe([loss(1), ADAPTIVE].join('\n\n'));
    expect(chat[1]).toContain('⏹ Сессия остановлена по твоей команде.');
    expect(editsTo(captured.calls, target)).toEqual([]);
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
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
    expect(heads(pushedText(edit?.payload))).toEqual([
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
      expect(pushedText(sends[1]!.payload)).toBe([loss(1), ADAPTIVE, loss(2)].join('\n\n'));
      const id = answered.get(sends[1]!.payload);
      expect(await cycleStateOf(target)).toEqual({ messageId: id, from: 0 });
      expect(messagesOf(logs(), WARN)).toEqual([
        'session trade notice edited anew: the cycle message is gone',
      ]);

      await settled(target, '-5');
      await notices.tick();
      const edits = editsTo(captured.calls, target);
      expect(edits.at(-1)?.payload.message_id).toBe(id);
      expect(heads(pushedText(edits.at(-1)?.payload))).toEqual([
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
    expect(pushedText(sends[1]!.payload)).toBe([loss(1), ADAPTIVE, loss(2)].join('\n\n'));
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
    // a loss's block of about 450 characters: eight of them fit in BOT_TEXT_LIMIT, nine do not —
    // 4079, inside the Bot API's 4096; a session holds up to MAX_SESSION_SUMMARY_TRADES trades, so
    // a split takes such an override
    const PAD = 'ж'.repeat(395);
    const source = {
      sourceOf: (key: BotTextKey) =>
        key === 'sessionTradeLost'
          ? `${PAD}\n${defaultBotTextSource.sourceOf(key)}`
          : defaultBotTextSource.sourceOf(key),
    };
    afterEach(() => setBotTextSources(BOT_TEXT_DEFAULT_SOURCES));

    it('splits a cycle only between blocks: no block lost, each message within the limit', async () => {
      expect(botTextMessageOverflows(source)).toEqual([]);
      setBotTextSources(botTextSourcesWith(BotLanguage.Ru, source));
      const target = await seedSession(MARTINGALE);
      const { notices, captured, logs } = sender();
      for (let step = 0; step < 12; step += 1) {
        await settled(target, '-5');
        await notices.tick();
      }
      const chat = chatOf(captured.calls, target);
      expect(chat).toHaveLength(2);
      for (const text of chat) {
        expect(plainTextOf(text).length).toBeLessThanOrEqual(BOT_TEXT_LIMIT);
      }
      const steps = (text: string) => heads(text).filter((line) => line.startsWith('⚡'));
      expect(steps(chat[0]!)).toEqual(
        Array.from({ length: 8 }, (_, i) => `⚡ Цикл 1 Шаг ${i + 1}`),
      );
      expect(steps(chat[1]!)).toEqual([
        '⚡ Цикл 1 Шаг 9',
        '⚡ Цикл 1 Шаг 10',
        '⚡ Цикл 1 Шаг 11',
        '⚡ Цикл 1 Шаг 12',
      ]);
      // the first message is not edited after the split
      const first = answered.get(sendsTo(captured.calls, target)[0]!.payload);
      const editsOfFirst = editsTo(captured.calls, target).filter(
        (call) => call.payload.message_id === first,
      );
      expect(editsOfFirst).toHaveLength(7);
      expect(await cycleStateOf(target)).toEqual({
        messageId: answered.get(sendsTo(captured.calls, target)[1]!.payload),
        from: 8,
      });
      expect(
        logs().filter(
          (entry) =>
            entry.level === INFO &&
            entry.msg === 'session trade notice split: the cycle message is full',
        ),
      ).toEqual([expect.objectContaining({ sessionId: target.session.id, claimed: 8, from: 8 })]);
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
    await untilSummary(target, () => next.notices.tick());
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

  it("D23 the gone-edit warn carries the error's name, the method and its code (#620)", async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured, logs } = sender();
    await settled(target, '-5');
    await notices.tick();
    await settled(target, '-5');
    captured.apiErrors.set('editMessageText', refusal('Bad Request: message to edit not found'));
    await notices.tick();
    captured.apiErrors.delete('editMessageText');
    const gone = logs().find(
      (entry) => entry.msg === 'session trade notice edited anew: the cycle message is gone',
    );
    expect(gone).toMatchObject({
      level: WARN,
      sessionId: target.session.id,
      claimed: 1,
      err: { name: 'GrammyError' },
      method: 'editMessageText',
      telegramErrorCode: 400,
    });
  });
});

// #509: a session the no-signal limit stopped tells why, trades or not
describe('the summary of a no_signal_timeout stop (#509)', () => {
  const OTHER_PAIR = (data: string) => ({
    text: RU_LABELS.otherPairButton,
    callback_data: data,
  });
  const MENU = { text: RU_LABELS.menuButton, callback_data: 'menu' };
  // #637: 20 candles of the session's signal interval, the candle in seconds
  const stopLine = (candleSec: number) =>
    `⏳ Сессия остановлена: по паре не было сигнала 20 свечей по ${String(candleSec)} с. Выбери другую пару.`;

  async function seedOf(durationSec: number): Promise<Target> {
    const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, {
      settings: sessionSettings({ assetId: ASSET, durationSec }),
    });
    return { seed, session, step: 0 };
  }

  it('D10 without a trade or a status message: one fallback summary with sound, the reason and «🔀 Выбрать другую пару»', async () => {
    const target = await seedOf(15);
    await stop(target, TradingSessionStopReason.NoSignalTimeout);
    const { notices, captured } = sender();
    await notices.tick();
    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.disable_notification).toBeUndefined();
    expect(pushedText(sends[0]!.payload).split('\n')).toEqual(['📈 EUR/USD', stopLine(15)]);
    expect(inlineButtons(sends[0]!.payload)).toEqual([OTHER_PAIR('demo:sig'), MENU]);
    expect(await rowOf(target)).toMatchObject({
      finalNoticeSentAt: expect.any(Date),
      summarySentAt: expect.any(Date),
    });
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
  });

  it("D11' without a trade, another reason sends nothing and sets both marks in one statement (#537)", async () => {
    const target = await seedOf(15);
    await stop(target, TradingSessionStopReason.UserStopped);
    const { notices, captured } = sender();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    const row = await rowOf(target);
    expect(row.finalNoticeSentAt).toBeInstanceOf(Date);
    expect(row.summarySentAt).toEqual(row.finalNoticeSentAt);
  });

  it('D12 with a trade: the summary carries the reason, the total and the same keyboard', async () => {
    const target = await seedOf(60);
    await settled(target, '4.6');
    await stop(target, TradingSessionStopReason.NoSignalTimeout);
    const { notices, captured } = sender();
    await untilSummary(target, () => notices.tick());
    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(2);
    const summary = sends[1]!;
    expect(pushedText(summary.payload).split('\n').slice(0, 3)).toEqual([
      '📈 EUR/USD',
      stopLine(60),
      '📊 Итог: 1 сделка — 1 в плюс, 0 в минус',
    ]);
    // the signals list at every duration (#685)
    expect(inlineButtons(summary.payload)).toEqual([OTHER_PAIR('demo:sig'), MENU]);
  });
});

// #537 (docs/bot-session.md → The summary in one message, The fallback): the sender closes a
// finished session's notices; the summary is the bot's, the backend's text only its fallback
describe('the final mark and the fallback summary (#537)', () => {
  const MENU = { text: RU_LABELS.menuButton, callback_data: 'menu' };
  const tracked = (target: Target) =>
    tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: 1 })
      .where(eq(tradingSessions.id, target.session.id));
  const markAgo = (target: Target, minutes: number) =>
    tmp.db
      .update(tradingSessions)
      .set({ finalNoticeSentAt: sql`now() - make_interval(mins => ${minutes})` })
      .where(eq(tradingSessions.id, target.session.id));
  // a no-signal stop without a trade: its one message is the summary
  async function noSignal(): Promise<Target> {
    const target = await seedSession();
    await stop(target, TradingSessionStopReason.NoSignalTimeout);
    return target;
  }
  const summaryLog = (logs: Record<string, unknown>[]) =>
    logs.filter((entry) => String(entry.msg).startsWith('session summary'));

  it("D1' a tracked session: its trades, the final mark, no text summary and no balance read - the bot's summary follows", async () => {
    const target = await seedSession();
    await tracked(target);
    for (const profit of ['4.6', '-5']) await settled(target, profit);
    await snapshot(target);
    await settled(target, '0');
    await stop(target);
    const { notices, captured, refreshCalls } = sender();
    await notices.tick();
    await notices.tick();
    const texts = textsTo(captured.calls, target);
    expect(texts).toHaveLength(3);
    expect(texts.every((text) => text.startsWith('⚡'))).toBe(true);
    expect(refreshCalls).toEqual([]);
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 3,
      finalNoticeSentAt: expect.any(Date),
      summarySentAt: null,
    });
  });

  it("D10' a tracked no-signal stop without a trade: the final mark alone, the summary step left to the bot", async () => {
    const target = await noSignal();
    await tracked(target);
    const { notices, captured } = sender();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    expect(await rowOf(target)).toMatchObject({
      finalNoticeSentAt: expect.any(Date),
      summarySentAt: null,
    });
  });

  it('F2 a tracked session with a fresh mark gets nothing; F3 past the grace, the text summary once', async () => {
    const target = await noSignal();
    await tracked(target);
    const { notices, captured, refreshCalls } = sender();
    await notices.tick();
    await markAgo(target, 29);
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    await markAgo(target, 31);
    await notices.tick();
    const sends = sendsTo(captured.calls, target);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload.disable_notification).toBeUndefined();
    expect(pushedText(sends[0]!.payload).split('\n')[0]).toBe('📈 EUR/USD');
    expect(inlineButtons(sends[0]!.payload).at(-1)).toEqual(MENU);
    expect((await rowOf(target)).summarySentAt).toBeInstanceOf(Date);
    // a stop without a trade has no balance after a trade to ask for
    expect(refreshCalls).toEqual([]);
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
  });

  it('F2 the grace is the config’s', async () => {
    const target = await noSignal();
    await tracked(target);
    const { notices, captured } = sender({ config: { summaryFallbackMs: 60_000 } });
    await notices.tick();
    await markAgo(target, 2);
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
  });

  it('F4 a user who blocked the bot after the mark: the step closed without a call or a balance read', async () => {
    const target = await seedSession();
    await settled(target, '4.6');
    await snapshot(target);
    await tracked(target);
    await stop(target);
    const { notices, captured, refreshCalls } = sender();
    await notices.tick();
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, target.seed.userId));
    await markAgo(target, 31);
    await notices.tick();
    expect(textsTo(captured.calls, target)).toHaveLength(1);
    expect(refreshCalls).toEqual([]);
    expect((await rowOf(target)).summarySentAt).toBeInstanceOf(Date);
  });

  it('F5 429: the mark is taken back, nothing goes until the pause has passed, then the summary once', async () => {
    const clock = { now: 1_000_000 };
    const target = await noSignal();
    const { notices, captured, logs } = sender({}, clock);
    failFirst(captured, 1, telegramError(429, 5));
    await notices.tick();
    expect(await rowOf(target)).toMatchObject({
      finalNoticeSentAt: expect.any(Date),
      summarySentAt: null,
    });
    expect(messagesOf(logs(), WARN)).toEqual(['session notices paused: Telegram asked to wait']);
    clock.now += 4_000;
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    clock.now += 1_000;
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(2);
    expect((await rowOf(target)).summarySentAt).toBeInstanceOf(Date);
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(2);
  });

  it('F6 another 4xx: tried again on later ticks, then dropped with its mark kept', async () => {
    const target = await noSignal();
    const { notices, captured, logs } = sender();
    failFirst(captured, 10, refusal('Bad Request: chat not found'));
    for (let tick = 0; tick < 4; tick += 1) await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(3);
    expect(summaryLog(logs()).map((entry) => entry.msg)).toEqual([
      'session summary refused',
      'session summary refused',
      'session summary dropped',
    ]);
    expect((await rowOf(target)).summarySentAt).toBeInstanceOf(Date);
  });

  it('F7 an unknown outcome: the mark stays, no second call', async () => {
    const target = await noSignal();
    const { notices, captured, logs } = sender();
    failFirst(captured, 10, new HttpError('network', new Error('socket hang up')));
    await notices.tick();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    expect(summaryLog(logs()).map((entry) => entry.msg)).toEqual([
      'session summary outcome unknown',
    ]);
    expect((await rowOf(target)).summarySentAt).toBeInstanceOf(Date);
  });

  it('F7 403: the user is marked unreachable, the mark stays', async () => {
    const target = await noSignal();
    const { notices, captured } = sender();
    failFirst(captured, 10, telegramError(403));
    await notices.tick();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    const [user] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, target.seed.userId));
    expect(user?.at).toBeInstanceOf(Date);
    expect((await rowOf(target)).summarySentAt).toBeInstanceOf(Date);
  });

  it('F9 the bot claimed first: nothing', async () => {
    const target = await noSignal();
    await tracked(target);
    const { notices, captured } = sender();
    await notices.tick();
    await tmp.db
      .update(tradingSessions)
      .set({ summarySentAt: sql`now()` })
      .where(eq(tradingSessions.id, target.session.id));
    await markAgo(target, 31);
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
  });

  it('F10 a summary that cannot be built: the step closed, an error, no retry', async () => {
    const seed = await seedUserWithAccount(tmp.db, { balance: 50n });
    const session = await seedTradingSession(tmp.db, seed.brokerAccountId, { settings: {} });
    const target: Target = { seed, session, step: 0 };
    await stop(target, TradingSessionStopReason.NoSignalTimeout);
    const { notices, captured, logs } = sender();
    await notices.tick();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    expect(
      logs()
        .filter((entry) => entry.msg === 'session summary not built')
        .map((entry) => entry.sessionId),
    ).toEqual([target.session.id]);
    expect((await rowOf(target)).summarySentAt).toBeInstanceOf(Date);
  });

  it('F12 stop() before the fallback: nothing claimed', async () => {
    const target = await noSignal();
    await tracked(target);
    const { notices, captured } = sender();
    await notices.tick();
    await markAgo(target, 31);
    await notices.stop();
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(0);
    expect((await rowOf(target)).summarySentAt).toBeNull();
  });

  it('F13 the list is bounded by scan and read oldest mark first', async () => {
    const older = await noSignal();
    const newer = await noSignal();
    await tracked(older);
    await tracked(newer);
    const { notices, captured } = sender({ config: { scan: 1 } });
    await notices.tick();
    await notices.tick();
    await markAgo(newer, 40);
    await markAgo(older, 50);
    await notices.tick();
    expect(sendsTo(captured.calls, older)).toHaveLength(1);
    expect(sendsTo(captured.calls, newer)).toHaveLength(0);
    await notices.tick();
    expect(sendsTo(captured.calls, newer)).toHaveLength(1);
  });

  // #870: the summary's balance refresh is not waited for in the tick
  // a finished session without a status message whose balance predates its trade (D9)
  async function needsBalance(): Promise<Target> {
    const target = await seedSession();
    await snapshot(target);
    await settled(target, '4.6');
    await stop(target);
    return target;
  }
  // a finished session without a status message, its balance after its trade
  async function current(): Promise<Target> {
    const target = await seedSession();
    await settled(target, '-5');
    await stop(target);
    await snapshot(target);
    return target;
  }
  const summaryOf = (calls: readonly ApiCall[], target: Target) =>
    textsTo(calls, target).find((text) => text.startsWith('📈'));
  const AGED = /🧪 Демобаланс: .*\n🕒/;
  // a broker GET as the reconciler's: answers when the test releases it, or 'aborted' by its
  // signal
  function heldBalance() {
    const calls: string[] = [];
    const pending: ((outcome: BalanceRefreshOutcome) => void)[] = [];
    let answered = 0;
    const balance: SessionNoticeSenderDeps['balance'] = {
      refresh: (accountId, options) => {
        calls.push(accountId);
        return new Promise<BalanceRefreshOutcome>((resolve) => {
          const answer = (outcome: BalanceRefreshOutcome) => {
            answered += 1;
            resolve(outcome);
          };
          pending.push(answer);
          options?.signal?.addEventListener('abort', () => answer('aborted'), { once: true });
        });
      },
    };
    const release = (outcome: BalanceRefreshOutcome) => {
      for (const answer of pending.splice(0)) answer(outcome);
    };
    return { calls, balance, release, answered: () => answered };
  }

  it('F14 a slow broker holds no other summary: the tick returns, the summary goes after the answer', async () => {
    const slow = await needsBalance();
    const other = await current();
    const held = heldBalance();
    const { notices, captured } = sender({ balance: held.balance });
    await notices.tick();
    await until('the refresh', () => held.calls.length === 1);
    expect(held.calls).toEqual([slow.seed.brokerAccountId]);
    expect(summaryOf(captured.calls, other)).toBeDefined();
    expect(held.answered()).toBe(0);
    await notices.tick();
    expect(summaryOf(captured.calls, slow)).toBeUndefined();
    held.release('aborted');
    await untilSummary(slow, () => notices.tick());
    expect(summaryOf(captured.calls, slow)).toMatch(AGED);
    expect(held.calls).toHaveLength(1);
  });

  it("F15 a refresh that answers 'ok': the summary with the balance it wrote, no age", async () => {
    const target = await needsBalance();
    const refreshCalls: string[] = [];
    const balance: SessionNoticeSenderDeps['balance'] = {
      refresh: async (accountId) => {
        refreshCalls.push(accountId);
        await upsertBalanceSnapshot(tmp.db, {
          brokerAccountId: accountId,
          user: brokerUser,
          requested: false,
        });
        return 'ok';
      },
    };
    const { notices, captured } = sender({ balance });
    await untilSummary(target, () => notices.tick());
    const summary = summaryOf(captured.calls, target);
    expect(summary).toMatch(/🧪 Демобаланс: /);
    expect(summary).not.toContain('🕒');
    expect(refreshCalls).toHaveLength(1);
  });

  it('F16 a 429 after the refresh: the claim back, the pause, then the summary - no second GET', async () => {
    const clock = { now: 1_000_000 };
    const target = await needsBalance();
    const { notices, captured, refreshCalls } = sender({}, clock);
    await notices.tick();
    await until('the refresh', () => refreshCalls.length === 1);
    failFirst(captured, 1, telegramError(429, 5));
    await until('the refused summary', async () => {
      await notices.tick();
      return callsTo(captured.calls, 'sendMessage').length === 2;
    });
    expect((await rowOf(target)).summarySentAt).toBeNull();
    clock.now += 5_000;
    await untilSummary(target, () => notices.tick());
    expect(summaryOf(captured.calls, target)).toMatch(AGED);
    expect(refreshCalls).toHaveLength(1);
  });

  it('F17 a refresh that rejects: a warning, no hold, the summary with the stored balance', async () => {
    const target = await needsBalance();
    const balance: SessionNoticeSenderDeps['balance'] = {
      refresh: () => Promise.reject(new Error('refresh refused by the test')),
    };
    const { notices, captured, logs } = sender({ balance });
    await notices.tick();
    await until('the warning', () =>
      logs().some((entry) => entry.msg === 'session summary balance refresh failed'),
    );
    expect(
      logs().find((entry) => entry.msg === 'session summary balance refresh failed'),
    ).toMatchObject({ level: WARN, sessionId: target.session.id });
    await untilSummary(target, () => notices.tick());
    expect(summaryOf(captured.calls, target)).toMatch(AGED);
    expect(logs().filter((entry) => entry.msg === 'session notices failed for a session')).toEqual(
      [],
    );
  });

  it('F18 stop() with the refresh in flight: it waits for no answer, claims nothing; a new sender asks again', async () => {
    const target = await needsBalance();
    const held = heldBalance();
    const first = sender({ balance: held.balance });
    await first.notices.tick();
    await until('the refresh', () => held.calls.length === 1);
    await first.notices.stop();
    expect(held.answered()).toBe(0);
    held.release('unavailable');
    expect((await rowOf(target)).summarySentAt).toBeNull();
    expect(summaryOf(first.captured.calls, target)).toBeUndefined();
    const next = sender();
    await untilSummary(target, () => next.notices.tick());
    expect(next.refreshCalls).toHaveLength(1);
    expect(summaryOf(next.captured.calls, target)).toMatch(AGED);
  });

  it('F19 the refreshes kept are at most scan: the oldest dropped asks again, both summaries go', async () => {
    const first = await needsBalance();
    const second = await needsBalance();
    const held = heldBalance();
    const { notices, captured } = sender({ balance: held.balance, config: { scan: 1 } });
    await notices.tick();
    await until('the first refresh', () => held.calls.length === 1);
    await notices.tick();
    expect(held.calls).toHaveLength(1);
    // the second's mark the oldest: it is listed next and its refresh drops the first's
    await markAgo(second, 1);
    await notices.tick();
    await until('the second refresh', () => held.calls.length === 2);
    held.release('unavailable');
    await untilSummary(second, () => notices.tick());
    await until('the first refresh again', async () => {
      await notices.tick();
      return held.calls.length === 3;
    });
    held.release('unavailable');
    await untilSummary(first, () => notices.tick());
    expect(held.calls).toEqual([
      first.seed.brokerAccountId,
      second.seed.brokerAccountId,
      first.seed.brokerAccountId,
    ]);
    expect(summaryOf(captured.calls, first)).toMatch(AGED);
    expect(summaryOf(captured.calls, second)).toMatch(AGED);
  });

  // The sender's db with a hook on the target's view read: `onView` runs once the view's SQL has
  // returned and before the sender sees the view, while `armed`; then every microtask runs, so
  // the refresh's `done` is set before the sender goes on. `after` - what the sender took from
  // its db once the hook fired
  function viewHook(target: Target, onView: () => Promise<void> | void) {
    const hook = { armed: false, fired: false, after: [] as string[] };
    const transaction: TempDatabase['db']['transaction'] = async (fn, config) => {
      const result = await tmp.db.transaction(fn, config);
      if (
        hook.armed &&
        typeof result === 'object' &&
        result !== null &&
        'trades' in result &&
        'id' in result &&
        result.id === target.session.id
      ) {
        hook.armed = false;
        hook.fired = true;
        await onView();
        await new Promise((resolve) => setImmediate(resolve));
      }
      return result;
    };
    const db = new Proxy(tmp.db, {
      get: (object, key, receiver) => {
        if (hook.fired) hook.after.push(String(key));
        return key === 'transaction'
          ? transaction
          : (Reflect.get(object, key, receiver) as unknown);
      },
    });
    return { db, hook };
  }

  it("F20 a refresh that answers 'ok' during the view's read: no summary that tick, the next without an age", async () => {
    const target = await needsBalance();
    const held = heldBalance();
    const { db, hook } = viewHook(target, async () => {
      await upsertBalanceSnapshot(tmp.db, {
        brokerAccountId: target.seed.brokerAccountId,
        user: brokerUser,
        requested: false,
      });
      held.release('ok');
    });
    const { notices, captured } = sender({ db, balance: held.balance });
    await notices.tick();
    await until('the refresh', () => held.calls.length === 1);
    hook.armed = true;
    await notices.tick();
    expect(hook.fired).toBe(true);
    expect(summaryOf(captured.calls, target)).toBeUndefined();
    expect((await rowOf(target)).summarySentAt).toBeNull();
    await notices.tick();
    const summary = summaryOf(captured.calls, target);
    expect(summary).toMatch(/🧪 Демобаланс: /);
    expect(summary).not.toContain('🕒');
    expect(held.calls).toHaveLength(1);
  });

  it('F21 a claim lost after the refresh: its entry gone, a summary given back asks again', async () => {
    const target = await needsBalance();
    const held = heldBalance();
    let foreign: { claimedAt: string } | undefined;
    const { db, hook } = viewHook(target, async () => {
      foreign = await claimSummaryFallback(tmp.db, { sessionId: target.session.id });
    });
    const { notices, captured } = sender({ db, balance: held.balance });
    await notices.tick();
    await until('the refresh', () => held.calls.length === 1);
    held.release('unavailable');
    hook.armed = true;
    await notices.tick();
    expect(hook.fired).toBe(true);
    expect(foreign).toBeDefined();
    expect(summaryOf(captured.calls, target)).toBeUndefined();
    await releaseSummaryFallback(tmp.db, {
      sessionId: target.session.id,
      claimedAt: foreign!.claimedAt,
    });
    await notices.tick();
    await until('the refresh again', () => held.calls.length === 2);
    expect(summaryOf(captured.calls, target)).toBeUndefined();
    held.release('unavailable');
    await untilSummary(target, () => notices.tick());
    expect(summaryOf(captured.calls, target)).toMatch(AGED);
  });

  // a refresh's GET follows its account's read: the db read it starts with shows it at once
  it("F22 stop() during the view's read: no refresh starts, nothing is claimed", async () => {
    const target = await needsBalance();
    const held = heldBalance();
    const { db, hook } = viewHook(target, () => {
      // not awaited: stop() waits for the tick this hook runs in
      void notices.stop();
    });
    const { notices, captured } = sender({ db, balance: held.balance });
    hook.armed = true;
    await notices.tick();
    expect(hook.fired).toBe(true);
    expect(hook.after).toEqual([]);
    expect(held.calls).toEqual([]);
    expect(summaryOf(captured.calls, target)).toBeUndefined();
    expect((await rowOf(target)).summarySentAt).toBeNull();
  });
});

// The waiting message (#536, docs/bot-session.md → The waiting message): «🔎 Ждём сигнал…» with
// its «⏹» under the session's messages, always the last of them.
describe('the waiting message (#536)', () => {
  // every trade here is followed by a no_signal decision, so the session waits under it (#722);
  // the #722 describe below takes the other decisions
  const settled = settledWaiting;
  // the caption without a scanner (#860): the session pair waits for a move, no stage passed
  const WAITING_CAPTION =
    `${RU_TEXTS.sessionWaitingSignal.value}\n\n` +
    '🛰 <b>Сканирую EUR/USD</b> · жду движение цены\n' +
    '⏳ Котировки  ⏳ Движение цены  ⏳ Отбор сигнала';
  const STOP = (target: Target) => ({
    text: RU_LABELS.sessionStopButton,
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
    await noSignal(target);
    const run = sender();
    await run.notices.tick();
    const [sent] = waitingTo(run.captured.calls, target);
    if (sent === undefined) throw new Error('no waiting message');
    return { target, run, id: answered.get(sent.payload)! };
  }

  it('W1 under a recorded status message: one silent waiting message with its «⏹», once', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await noSignal(target);
    const { notices, captured } = sender();
    await notices.tick();
    const sent = waitingTo(captured.calls, target);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      caption: WAITING_CAPTION,
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
    await noSignal(target);
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

  it("W5 a finished session with a last trade: the delete, the trade, then the final mark - the bot's summary after them (#537)", async () => {
    const { target, run } = await waiting();
    await settled(target, '4.6');
    await stop(target);
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'trade']);
    expect(await rowOf(target)).toMatchObject({
      finalNoticeSentAt: expect.any(Date),
      summarySentAt: null,
    });
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
    await noSignal(target);
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
      await noSignal(target);
      const { notices, captured, logs } = sender();
      failNext(captured, { sendAnimation: [failure()] });
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
    await noSignal(target);
    const { notices, captured, logs } = sender({ config: { maxAttempts: 3 } });
    failNext(captured, {
      sendAnimation: [telegramError(400), telegramError(400), telegramError(400)],
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
    await noSignal(target);
    const { notices, captured } = sender({}, clock);
    failNext(captured, { sendAnimation: [telegramError(429, 5)] });
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
    await noSignal(target);
    const { notices, captured, logs } = sender();
    failNext(captured, { sendAnimation: [telegramError(403)] });
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
    await noSignal(target);
    const { notices, captured, logs } = sender();
    const answer = captured.answers.get('sendAnimation')!;
    captured.answers.set('sendAnimation', async (payload) => {
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
    await noSignal(target);
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
    await noSignal(other);
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
    await noSignal(target);
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
    await noSignal(target);
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
  it("W26 a stop that took the waiting message over: no delete; the final mark next, the bot's summary after it (#537)", async () => {
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
    ]);
    expect((await rowOf(traded.target)).finalNoticeSentAt).toBeInstanceOf(Date);
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
        await noSignal(a);
        const answer = b.run.captured.answers.get('sendAnimation')!;
        let done = false;
        b.run.captured.answers.set('sendAnimation', async (payload) => {
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

  it('W27 a hand-over between the list read and the session’s turn, before a new cycle message: no delete, the trade, then the final mark', async () => {
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
    expect((await rowOf(run.target)).finalNoticeSentAt).toBeNull();
    await run.run.notices.tick();
    expect(sequenceOf(run.run.captured.calls, run.target)).toEqual(['waiting', 'trade']);
    expect((await rowOf(run.target)).finalNoticeSentAt).toBeInstanceOf(Date);
  });

  it('W28 the 409 clear between the list read and a stale delete: no delete, the final mark in the same tick', async () => {
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
    ]);
    expect((await rowOf(run.target)).finalNoticeSentAt).toBeInstanceOf(Date);
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
    await noSignal(target);
    const { notices, captured, logs } = sender();
    const answer = captured.answers.get('sendAnimation')!;
    captured.answers.set('sendAnimation', (payload) =>
      inlineButtons(payload).length > 0 && waitingTo(captured.calls, target).length === 1
        ? { message_id: 0, animation: { file_id: RADAR_FILE_ID } }
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
    await noSignal(target);
    const { notices, captured, logs } = sender();
    const answer = captured.answers.get('sendAnimation')!;
    captured.answers.set('sendAnimation', async (payload) => {
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
      await noSignal(target);
      await settled(target, '4.6');
      // what the backend before #536 left: the trade claimed and sent in a cycle message
      await claimSessionTradeNotice(tmp.db, { sessionId: target.session.id, claimed: 0 });
      await recordSessionCycleMessage(tmp.db, {
        sessionId: target.session.id,
        cursor: 1,
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
    const answer = run.captured.answers.get('sendAnimation')!;
    run.captured.answers.set('sendAnimation', (payload) => {
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

// #775: an H1 session's messages are any session's: the trade blocks, the open block, the waiting
// message after the driver's no_signal row, the final mark
describe('an H1 session is messaged as any session (#775)', () => {
  const h1Settings = () => {
    const built = buildH1SessionSettings({
      assetId: ASSET,
      cycles: 5,
      stake: { baseStake: decimalStringSchema.parse('5'), stakeScale: 0 },
      strategy: SessionStakeStrategy.Martingale,
    });
    if (!built.success) throw new Error('fixture settings do not parse');
    return built.data;
  };
  const STATUS_ID = 1;
  const statusMessage = (target: Target) =>
    tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: STATUS_ID })
      .where(eq(tradingSessions.id, target.session.id));
  // the driver's own waiting row: its builder over a flat window, the detector's no_signal
  const driverNoSignal = (target: Target) => {
    const settings = h1Settings();
    if (!isH1Settings(settings)) throw new Error('fixture: H1 settings');
    const closes = new Float64Array(H1_R1_PARAMS.sdWindowSec + 1).fill(1.1);
    const decision = createH1Detector(H1_R1_PARAMS).decide({
      closes,
      at: H1_R1_PARAMS.sdWindowSec,
    });
    const f = Date.now() - 1_000;
    return recordSignalDecision(
      tmp.db,
      h1DriverDecisionInput(
        {
          sessionId: target.session.id,
          brokerAccountId: target.seed.brokerAccountId,
          settings,
          assetId: ASSET,
          f,
          takenAtMs: f + 320,
          decision,
          payout: 92,
          digits: 5,
          symbol: 'EUR/USD',
          closedBy: 'tick',
          closedAtMs: f + 300,
          series: Array.from(closes),
          lastTick: null,
        },
        target.step + 1,
        SignalDecisionOutcome.NoSignal,
        null,
      ),
    );
  };

  it("H1-N1′ its settled trades get their step blocks and the cycle message, as a martingale session's", async () => {
    const target = await seedSession(h1Settings());
    const { notices, captured } = sender();
    await settled(target, '-5');
    await settled(target, '4.6');
    await settled(target, '4.6');
    await notices.tick();
    await notices.tick();
    expect(chatOf(captured.calls, target).map(heads)).toEqual([
      ['⚡ Цикл 1 Шаг 1', ADAPTIVE, '⚡ Цикл 1 Шаг 2'],
      ['⚡ Цикл 2 Шаг 1'],
    ]);
    expect((await rowOf(target)).notifiedTrades).toBe(3);
  });

  it('H1-N2′ its open trade gets the open block with its «⏹»', async () => {
    const target = await seedSession(h1Settings());
    await statusMessage(target);
    await opened(target);
    const { notices, captured } = sender();
    await notices.tick();
    const [open] = sendsTo(captured.calls, target);
    expect(pushedText(open!.payload)).toContain('<pre>⏳');
    expect(inlineButtons(open!.payload)).toEqual([
      {
        text: RU_LABELS.sessionStopButton,
        callback_data: `session:stop:${target.session.id}:c`,
      },
    ]);
    expect((await rowOf(target)).openNoticeIntentId).not.toBeNull();
  });

  it("H1-N3′ the waiting message after the driver's no_signal row; the intent's row deletes it", async () => {
    const target = await seedSession(h1Settings());
    await statusMessage(target);
    await driverNoSignal(target);
    const { notices, captured } = sender();
    await notices.tick();
    const [waiting] = waitingTo(captured.calls, target);
    expect(waiting).toBeDefined();
    expect(inlineButtons(waiting!.payload)).toEqual([
      {
        text: RU_LABELS.sessionStopButton,
        callback_data: `session:stop:${target.session.id}:w`,
      },
    ]);
    await opened(target);
    await notices.tick();
    expect(deletesTo(captured.calls, target)).toEqual([answered.get(waiting!.payload)]);
    expect((await rowOf(target)).waitingMessageId).toBeNull();
  });

  it("H1-N4′ the finish: the final mark; a CLI session's fallback summary counts cycles", async () => {
    const target = await seedSession(h1Settings());
    for (const profit of ['4.6', '4.6', '-5', '4.6', '4.6', '4.6']) await settled(target, profit);
    await stop(target);
    const { notices, captured } = sender();
    await notices.tick();
    await notices.tick();
    expect(await rowOf(target)).toMatchObject({
      notifiedTrades: 6,
      finalNoticeSentAt: expect.any(Date),
      summarySentAt: expect.any(Date),
    });
    const summary = textsTo(captured.calls, target).find((text) => text.startsWith('📈'));
    expect(summary?.split('\n')[1]).toBe(
      '🏁 Сессия завершена: 5 циклов, 6 сделок — 5 в плюс, 1 в минус',
    );
  });
});

// #700: the open trade's block, sent at the open and edited into its result at the settle
describe("the open trade's block (#700)", () => {
  const OPEN_MARK = '<pre>⏳';
  const openBlock = (step: number, cycle = 1, at = step) =>
    `⚡ Цикл ${cycle} Шаг ${step}\n${OPEN_MARK} $5.00 · ⬆️ Вверх\n📊 ${(at / 10).toFixed(5)} → …</pre>`;
  const STATUS_ID = 1;
  const statusMessage = (target: Target) =>
    tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: STATUS_ID })
      .where(eq(tradingSessions.id, target.session.id));
  const markOf = async (target: Target) => (await rowOf(target)).openNoticeIntentId;
  // every call to the user that showed an open block
  const openCallsTo = (calls: readonly ApiCall[], target: Target) =>
    calls.filter(
      (call) =>
        call.payload.chat_id === target.seed.telegramUserId &&
        (call.method === 'sendMessage' || call.method === 'editMessageText') &&
        pushedText(call.payload).includes(OPEN_MARK),
    );
  const sequenceOf = (calls: readonly ApiCall[], target: Target) =>
    calls
      .filter((call) => call.payload.chat_id === target.seed.telegramUserId)
      .map((call) =>
        call.method === 'sendAnimation'
          ? 'waiting'
          : call.method === 'sendMessage'
            ? pushedText(call.payload).includes(OPEN_MARK)
              ? 'open'
              : 'trade'
            : call.method,
      );
  async function blocked(target: Target) {
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, target.seed.userId));
  }

  it('O1 open: one silent message with the block without a result and its «⏹» (#722); settled: the same message edited into the result, the «⏹» off', async () => {
    const target = await seedSession();
    const { notices, captured } = sender();
    const trade = await opened(target);
    await notices.tick();
    const [sent] = sendsTo(captured.calls, target);
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    expect(pushedText(sent!.payload)).toBe(openBlock(1));
    expect(sent!.payload).toMatchObject({ disable_notification: true, parse_mode: 'HTML' });
    expect(inlineButtons(sent!.payload)).toEqual(CYCLE_STOP(target));
    expect(await rowOf(target)).toMatchObject({
      openNoticeIntentId: trade.intent.id,
      cycleMessageId: answered.get(sent!.payload),
      cycleMessageFrom: 0,
      notifiedTrades: 0,
    });
    await notices.tick();
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);

    await settle(trade, '-5');
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    const [edit] = editsTo(captured.calls, target);
    expect(edit?.payload.message_id).toBe(answered.get(sent!.payload));
    // an edit without reply_markup takes the keyboard off (Bot API)
    expect(edit?.payload.reply_markup).toBeUndefined();
    expect(chatOf(captured.calls, target)).toEqual([loss(1)]);
  });

  it('O2 a settled step and the next one open in one tick: the cycle message, then its edit with the open block last', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    await settled(target, '-5');
    const second = await opened(target);
    await notices.tick();
    // the next step's intent ended the wait (#722): no waiting message, the «⏹» on the open block
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'editMessageText']);
    expect(chatOf(captured.calls, target)).toEqual([
      [loss(1), ADAPTIVE, openBlock(2)].join('\n\n'),
    ]);
    expect(inlineButtons(sendsTo(captured.calls, target)[0]!.payload)).toEqual([]);
    expect(inlineButtons(editsTo(captured.calls, target)[0]!.payload)).toEqual(CYCLE_STOP(target));
    await settle(second, '-5');
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([
      'trade',
      'editMessageText',
      'editMessageText',
    ]);
    expect(editsTo(captured.calls, target)[1]!.payload.reply_markup).toBeUndefined();
    expect(chatOf(captured.calls, target)).toEqual([[loss(1), ADAPTIVE, loss(2)].join('\n\n')]);
  });

  it('O2 a cycle message of an earlier cycle: the open step 1 of a new cycle sends anew', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    await settled(target, '4.6');
    await notices.tick();
    await opened(target);
    await notices.tick();
    expect(sendsTo(captured.calls, target).map((call) => pushedText(call.payload))).toEqual([
      expect.stringContaining('⚡ Цикл 1 Шаг 1'),
      openBlock(1, 2, 2),
    ]);
  });

  it('O3 a trade settled before the tick: its result block at once, no open block', async () => {
    const target = await seedSession();
    const { notices, captured } = sender();
    await settle(await opened(target), '-5');
    await notices.tick();
    expect(openCallsTo(captured.calls, target)).toEqual([]);
    expect(chatOf(captured.calls, target)).toEqual([loss(1)]);
    expect(await markOf(target)).toBeNull();
  });

  it('O4 a restart between the open block and the settle: the block is not sent again, the result edits it', async () => {
    const target = await seedSession();
    const first = sender();
    const trade = await opened(target);
    await first.notices.tick();
    await first.notices.stop();
    const second = sender();
    await second.notices.tick();
    expect(
      second.captured.calls.filter((c) => c.payload.chat_id === target.seed.telegramUserId),
    ).toEqual([]);
    await settle(trade, '-5');
    await second.notices.tick();
    expect(editsTo(second.captured.calls, target)).toHaveLength(1);
    expect(editsTo(second.captured.calls, target)[0]!.payload.message_id).toBe(
      answered.get(sendsTo(first.captured.calls, target)[0]!.payload),
    );
    expect(sendsTo(second.captured.calls, target)).toEqual([]);
  });

  it('O5 two senders ticking together send the open block once', async () => {
    const target = await seedSession();
    await opened(target);
    const a = sender();
    const b = sender();
    await Promise.all([a.notices.tick(), b.notices.tick(), a.notices.tick(), b.notices.tick()]);
    expect([
      ...openCallsTo(a.captured.calls, target),
      ...openCallsTo(b.captured.calls, target),
    ]).toHaveLength(1);
  });

  it.each([
    ['a 5xx', () => telegramError(502)],
    [
      'a transport failure',
      () => new HttpError("Network request for 'sendMessage' failed!", new Error('timed out')),
    ],
  ])(
    'O6 %s: the outcome is unknown, nothing recorded, the block never sent again; the result goes as a new message',
    async (_name, failure) => {
      const target = await seedSession();
      const trade = await opened(target);
      const { notices, captured, logs } = sender();
      failFirst(captured, 1, failure());
      await notices.tick();
      await notices.tick();
      expect(openCallsTo(captured.calls, target)).toHaveLength(1);
      expect(messagesOf(logs(), WARN)).toEqual(['session open notice outcome unknown']);
      expect(await rowOf(target)).toMatchObject({
        openNoticeIntentId: trade.intent.id,
        cycleMessageId: null,
      });
      await settle(trade, '-5');
      await notices.tick();
      expect(sendsTo(captured.calls, target).map((call) => pushedText(call.payload))).toEqual([
        openBlock(1),
        loss(1),
      ]);
    },
  );

  it('O7 429: the claim is taken back, nothing goes until the pause has passed, then the block once', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    const trade = await opened(target);
    const { notices, captured, logs } = sender({}, clock);
    captured.apiErrors.set('sendMessage', telegramError(429, 30));
    await notices.tick();
    expect(await markOf(target)).toBeNull();
    expect(messagesOf(logs(), WARN)).toContain('session notices paused: Telegram asked to wait');
    captured.apiErrors.delete('sendMessage');
    clock.now += 29_999;
    await notices.tick();
    expect(openCallsTo(captured.calls, target)).toHaveLength(1);
    clock.now += 1;
    await notices.tick();
    await notices.tick();
    expect(openCallsTo(captured.calls, target)).toHaveLength(2);
    expect(await markOf(target)).toBe(trade.intent.id);
    expect((await rowOf(target)).cycleMessageId).toBe(
      answered.get(openCallsTo(captured.calls, target)[1]!.payload),
    );
  });

  it('O8 another 4xx: tried again on later ticks, then dropped; the result still comes', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    const { notices, captured, logs } = sender({ config: { maxAttempts: 3 } });
    failFirst(captured, 3, telegramError(400));
    for (let i = 0; i < 4; i += 1) await notices.tick();
    expect(messagesOf(logs(), WARN)).toEqual([
      'session open notice refused',
      'session open notice refused',
      'session open notice dropped',
    ]);
    expect(openCallsTo(captured.calls, target)).toHaveLength(3);
    expect(await markOf(target)).toBe(trade.intent.id);
    await settle(trade, '-5');
    await notices.tick();
    expect(chatOf(captured.calls, target)).toEqual([loss(1)]);
  });

  it('O9 403: the user is marked unreachable; the result is claimed without a call', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    const { notices, captured } = sender();
    captured.apiErrors.set('sendMessage', telegramError(403));
    await notices.tick();
    expect(await markOf(target)).toBe(trade.intent.id);
    const [user] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, target.seed.userId));
    expect(user?.at).toBeInstanceOf(Date);
    await settle(trade, '-5');
    await notices.tick();
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
  });

  it('O10 an edit refused as gone: the cycle in a new message with the open block, recorded; the result edits it', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured, logs } = sender();
    await settled(target, '-5');
    await notices.tick();
    const second = await opened(target);
    captured.apiErrors.set('editMessageText', refusal('Bad Request: message to edit not found'));
    await notices.tick();
    captured.apiErrors.delete('editMessageText');
    expect(messagesOf(logs(), WARN)).toContain(
      'session open notice edited anew: the cycle message is gone',
    );
    const anew = sendsTo(captured.calls, target)[1]!;
    expect(pushedText(anew.payload)).toBe([loss(1), ADAPTIVE, openBlock(2)].join('\n\n'));
    // the gone edit's new message carries the open block's «⏹» too (#722)
    expect(inlineButtons(anew.payload)).toEqual(CYCLE_STOP(target));
    expect(await rowOf(target)).toMatchObject({
      cycleMessageId: answered.get(anew.payload),
      cycleMessageFrom: 0,
    });
    await settle(second, '-5');
    await notices.tick();
    expect(editsTo(captured.calls, target).at(-1)!.payload.message_id).toBe(
      answered.get(anew.payload),
    );
  });

  it('O12 an H1 session (#775) with an open trade: its open block and its claim, as any', async () => {
    const built = buildH1SessionSettings({
      assetId: ASSET,
      cycles: 5,
      stake: { baseStake: decimalStringSchema.parse('5'), stakeScale: 0 },
      strategy: SessionStakeStrategy.Martingale,
    });
    if (!built.success) throw new Error('fixture settings do not parse');
    const target = await seedSession(built.data);
    await statusMessage(target);
    const { intent } = await opened(target);
    const { notices, captured } = sender();
    await notices.tick();
    await notices.tick();
    expect(openCallsTo(captured.calls, target)).toHaveLength(1);
    expect(sequenceOf(captured.calls, target)).toEqual(['open']);
    expect(await markOf(target)).toBe(intent.id);
  });

  it('O13 the waiting message: deleted before the open block’s new message, not sent under it (#722); the result’s edit takes the «⏹» off, the next no_signal brings the waiting message back', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await noSignal(target);
    const { notices, captured } = sender();
    await notices.tick();
    const trade = await opened(target);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'open']);
    expect(inlineButtons(sendsTo(captured.calls, target)[0]!.payload)).toEqual(CYCLE_STOP(target));
    await settle(trade, '-5');
    await notices.tick();
    expect(editsTo(captured.calls, target)[0]!.payload.reply_markup).toBeUndefined();
    await noSignal(target);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'open',
      'editMessageText',
      'waiting',
    ]);
  });

  it('O14 a session stopped with its trade open: the open block without a «⏹» (#722), the result, then the final mark', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    await stop(target, TradingSessionStopReason.UserStopped);
    const { notices, captured } = sender();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['open']);
    // the list read the session stopped: no dead button (#722, В2)
    expect(sendsTo(captured.calls, target)[0]!.payload.reply_markup).toBeUndefined();
    expect((await rowOf(target)).finalNoticeSentAt).toBeNull();
    await settle(trade, '-5');
    await notices.tick();
    expect(chatOf(captured.calls, target)[0]).toBe(loss(1));
    expect((await rowOf(target)).finalNoticeSentAt).toBeInstanceOf(Date);
  });

  it('O15 fixed: each open block a new message of its own cycle', async () => {
    const target = await seedSession();
    const { notices, captured } = sender();
    await settle(await opened(target), '-5');
    await notices.tick();
    await opened(target);
    await notices.tick();
    expect(sendsTo(captured.calls, target).map((call) => pushedText(call.payload))).toEqual([
      loss(1),
      openBlock(1, 2, 2),
    ]);
  });

  it('O16 a user who blocked the bot: the block claimed without a call, the result too', async () => {
    const target = await seedSession();
    await blocked(target);
    const trade = await opened(target);
    const { notices, captured } = sender();
    await notices.tick();
    expect(await markOf(target)).toBe(trade.intent.id);
    await settle(trade, '-5');
    await notices.tick();
    expect(captured.calls.filter((c) => c.payload.chat_id === target.seed.telegramUserId)).toEqual(
      [],
    );
    expect((await rowOf(target)).notifiedTrades).toBe(1);
  });

  it('O17 a block that cannot be built: logged, the block is not sent again, the result comes', async () => {
    const target = await seedSession();
    const trade = await opened(target);
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
    expect(openCallsTo(captured.calls, target)).toEqual([]);
    expect(
      logs()
        .filter((entry) => entry.level === 50)
        .map((entry) => entry.msg),
    ).toEqual(['session open notice not built']);
    await settle(trade, '-5');
    await notices.tick();
    expect(chatOf(captured.calls, target)).toEqual([loss(1)]);
  });

  it('O18 a tie at step 1: no line under it; step 2 opens and settles under the line, which stays one (#718)', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    const tie =
      '⚡ Цикл 1 Шаг 1\n<pre>⚪ $5.00 → $0.00\n↩️ ставка вернулась\n📊 0.10000 → 0.10010</pre>';
    await settled(target, '0');
    await notices.tick();
    expect(chatOf(captured.calls, target)).toEqual([tie]);
    const second = await opened(target);
    await notices.tick();
    expect(chatOf(captured.calls, target)).toEqual([[tie, ADAPTIVE, openBlock(2)].join('\n\n')]);
    await settle(second, '-5');
    await notices.tick();
    expect(chatOf(captured.calls, target)).toEqual([[tie, ADAPTIVE, loss(2)].join('\n\n')]);
    expect(sendsTo(captured.calls, target)).toHaveLength(1);
  });

  it('O19 martingale: an open step 1 without the line; settled as a loss, the line under it (#718)', async () => {
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender();
    const trade = await opened(target);
    await notices.tick();
    expect(chatOf(captured.calls, target)).toEqual([openBlock(1)]);
    await settle(trade, '-5');
    await notices.tick();
    expect(chatOf(captured.calls, target)).toEqual([[loss(1), ADAPTIVE].join('\n\n')]);
  });
});

// #722 (docs/bot-session.md → The waiting message): the waiting message only while the session
// waits for a signal - its latest decision is no_signal - and the «⏹» under the open trade's block
describe('the waiting message by the decision log, «⏹» under the open block (#722)', () => {
  const OPEN_MARK = '<pre>⏳';
  const STATUS_ID = 1;
  const statusMessage = (target: Target) =>
    tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: STATUS_ID })
      .where(eq(tradingSessions.id, target.session.id));
  // a live waiting message on the status message's slot, as #536 left it at the deploy
  const liveWaiting = (target: Target, messageId = 900) =>
    tmp.db
      .update(tradingSessions)
      .set({ waitingMessageId: messageId, waitingAfterMessage: STATUS_ID })
      .where(eq(tradingSessions.id, target.session.id));
  const waitingIdOf = async (target: Target) => (await rowOf(target)).waitingMessageId;
  const sequenceOf = (calls: readonly ApiCall[], target: Target) =>
    calls
      .filter((call) => call.payload.chat_id === target.seed.telegramUserId)
      .map((call) =>
        call.method === 'sendAnimation'
          ? 'waiting'
          : call.method === 'sendMessage'
            ? pushedText(call.payload).includes(OPEN_MARK)
              ? 'open'
              : 'trade'
            : call.method === 'editMessageText' && pushedText(call.payload).includes(OPEN_MARK)
              ? 'edit-open'
              : call.method,
      );
  const block = (target: Target) =>
    tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, target.seed.userId));

  it('X1 a started session without a decision: nothing; after no_signal one waiting message; an open trade without one: none', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured } = sender();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([]);
    await noSignal(target);
    await notices.tick();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting']);

    const opening = await seedSession();
    await statusMessage(opening);
    await opened(opening);
    await notices.tick();
    await notices.tick();
    expect(sequenceOf(captured.calls, opening)).toEqual(['open']);
  });

  it('X2 the intent row ends the wait: at step 1 the delete, then the open block in a new message; at step 2 the delete, then the edit (В1)', async () => {
    const target = await seedSession(MARTINGALE);
    await statusMessage(target);
    await noSignal(target);
    const { notices, captured } = sender();
    await notices.tick();
    await opened(target).then((trade) => settle(trade, '-5'));
    await noSignal(target);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
    await opened(target);
    await notices.tick();
    // never two «⏹»: the waiting message goes before the edit that puts the block's on
    expect(sequenceOf(captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
      'deleteMessage',
      'edit-open',
    ]);
    expect(inlineButtons(editsTo(captured.calls, target)[0]!.payload)).toEqual(CYCLE_STOP(target));
    expect(await waitingIdOf(target)).toBeNull();
  });

  it('X2 at step 1: the waiting message deleted before the open block’s new message, which carries the «⏹»', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await noSignal(target);
    const { notices, captured } = sender();
    await notices.tick();
    await opened(target);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'open']);
    expect(inlineButtons(sendsTo(captured.calls, target)[0]!.payload)).toEqual(CYCLE_STOP(target));
  });

  it('X5 a signal right after every settlement: five trades, no waiting message at all', async () => {
    const target = await seedSession();
    await statusMessage(target);
    const { notices, captured } = sender();
    for (let step = 0; step < 5; step += 1) {
      const trade = await opened(target);
      await notices.tick();
      await settle(trade, '4.6');
      await notices.tick();
    }
    expect(waitingTo(captured.calls, target)).toEqual([]);
    expect(sequenceOf(captured.calls, target).filter((kind) => kind === 'open')).toHaveLength(5);
  });

  it('X6 two senders at once: one waiting message, then one open block', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await noSignal(target);
    const first = sender();
    const second = sender();
    await Promise.all([first.notices.tick(), second.notices.tick()]);
    const calls = () => [...first.captured.calls, ...second.captured.calls];
    expect(waitingTo(calls(), target)).toHaveLength(1);
    await opened(target);
    await Promise.all([first.notices.tick(), second.notices.tick()]);
    expect(
      sendsTo(calls(), target).filter((call) => pushedText(call.payload).includes(OPEN_MARK)),
    ).toHaveLength(1);
    expect(waitingTo(calls(), target)).toHaveLength(1);
  });

  it.each([
    ['its latest decision an intent', SignalDecisionOutcome.Intent],
    ['no decision at all', undefined],
  ] as const)(
    'X8 the deploy: a live waiting message with %s is deleted once on the first tick, then nothing',
    async (_, outcome) => {
      const target = await seedSession();
      await statusMessage(target);
      if (outcome !== undefined) await decide(target, outcome);
      await liveWaiting(target);
      const { notices, captured } = sender();
      await notices.tick();
      await notices.tick();
      expect(sequenceOf(captured.calls, target)).toEqual(['deleteMessage']);
      expect(deletesTo(captured.calls, target)).toEqual([900]);
      expect(await waitingIdOf(target)).toBeNull();
    },
  );

  it('X8 the deploy: a live waiting message of a session that waits is left as it is', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await noSignal(target);
    await liveWaiting(target);
    const { notices, captured } = sender();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([]);
    expect(await waitingIdOf(target)).toBe(900);
  });

  it('X9 a blocked user: the live waiting message of a session that no longer waits keeps its id without a call; once reachable, deleted first', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await liveWaiting(target);
    await decide(target, SignalDecisionOutcome.Intent);
    await block(target);
    const { notices, captured } = sender();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([]);
    expect(await waitingIdOf(target)).toBe(900);
    await markTelegramReachable(tmp.db, BigInt(target.seed.telegramUserId));
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['deleteMessage']);
  });

  it.each([
    ['refused', SignalDecisionOutcome.Refused, 'fixture_refusal'],
    ['a stake stop', SignalDecisionOutcome.StakeStop, 'fixture_stop'],
    ['replayed', SignalDecisionOutcome.Replayed, null],
  ] as const)(
    'X10 a decision %s after no_signal: the live waiting message deleted, none sent',
    async (_, outcome, detail) => {
      const target = await seedSession();
      await statusMessage(target);
      await noSignal(target);
      const { notices, captured } = sender();
      await notices.tick();
      await decide(target, outcome, detail);
      await notices.tick();
      await notices.tick();
      expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
      expect(await waitingIdOf(target)).toBeNull();
    },
  );

  it('X11 the intent row between the claim and the record (В4): recorded, deleted as stale on the next tick, not sent again', async () => {
    const target = await seedSession();
    await statusMessage(target);
    await noSignal(target);
    const { notices, captured } = sender();
    const answer = captured.answers.get('sendAnimation')!;
    captured.answers.set('sendAnimation', async (payload) => {
      if (isWaiting({ method: 'sendAnimation', payload } as ApiCall)) {
        await decide(target, SignalDecisionOutcome.Intent);
      }
      return answer(payload);
    });
    await notices.tick();
    const [sent] = waitingTo(captured.calls, target);
    expect(await waitingIdOf(target)).toBe(answered.get(sent!.payload));
    await notices.tick();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage']);
    expect(deletesTo(captured.calls, target)).toEqual([answered.get(sent!.payload)]);
    expect(await waitingIdOf(target)).toBeNull();
  });

  it('X12 a martingale step settled and the next one decided without no_signal: the edit of the result, then the stale delete, then no waiting message', async () => {
    const target = await seedSession(MARTINGALE);
    await statusMessage(target);
    const { notices, captured } = sender();
    await settledWaiting(target, '-5');
    await notices.tick();
    await settled(target, '-5');
    await notices.tick();
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([
      'trade',
      'waiting',
      'editMessageText',
      'deleteMessage',
    ]);
  });
});

describe('the gap per chat (#660)', () => {
  // each trade followed by a no_signal decision: the session waits under it (#722)
  const settled = settledWaiting;
  const GAP = SESSION_NOTICE_CHAT_GAP_MS;
  const gapOn = { config: { chatGapMs: GAP } };
  const markStatus = (target: Target) =>
    tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: 1 })
      .where(eq(tradingSessions.id, target.session.id));

  it('G1 one step per chat within the gap: a backlog of three trades goes one a tick', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    for (const profit of ['4.6', '-5', '0']) await settled(target, profit);
    const { notices, captured } = sender(gapOn, clock);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade']);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
    clock.now += GAP - 1;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade']);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
    clock.now += 1;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'trade']);
    clock.now += GAP;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'trade', 'trade']);
    expect((await rowOf(target)).notifiedTrades).toBe(3);
    // the waiting message is a step of its own: the next gap
    clock.now += GAP;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'trade', 'trade', 'waiting']);
  });

  it('G2 the gap is per chat: one tick sends a step to each of two chats, oldest first', async () => {
    const clock = { now: 1_000_000 };
    const older = await seedSession();
    const newer = await seedSession();
    for (const profit of ['4.6', '-5', '0']) {
      await settled(older, profit);
      await settled(newer, profit);
    }
    const { notices, captured } = sender(gapOn, clock);
    await notices.tick();
    expect(sequenceOf(captured.calls, older)).toEqual(['trade']);
    expect(sequenceOf(captured.calls, newer)).toEqual(['trade']);
    expect(callsTo(captured.calls, 'sendMessage').map((call) => call.payload.chat_id)).toEqual([
      older.seed.telegramUserId,
      newer.seed.telegramUserId,
    ]);
  });

  it('G3 a new cycle message under a live waiting message: the delete and the message in one step, the waiting message on a later tick', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    await markStatus(target);
    await noSignal(target);
    const { notices, captured } = sender(gapOn, clock);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting']);
    await settled(target, '4.6');
    clock.now += GAP;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'trade']);
    clock.now += GAP - 1;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'trade']);
    clock.now += 1;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([
      'waiting',
      'deleteMessage',
      'trade',
      'waiting',
    ]);
  });

  it('G4 an edit refused as gone: the edit, the delete and the new message in one step, the waiting message on a later tick', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession(MARTINGALE);
    const { notices, captured } = sender(gapOn, clock);
    await settled(target, '-5');
    await notices.tick();
    clock.now += GAP;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'waiting']);
    await settled(target, '-5');
    failNext(captured, { editMessageText: [refusal('Bad Request: message to edit not found')] });
    clock.now += GAP;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([
      'trade',
      'waiting',
      'editMessageText',
      'deleteMessage',
      'trade',
    ]);
    clock.now += GAP;
    await notices.tick();
    expect(sequenceOf(captured.calls, target).at(-1)).toBe('waiting');
  });

  it('G5 the gap runs from the step’s last message, and a refused send marks the chat too', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    await markStatus(target);
    await noSignal(target);
    const run = sender(
      {
        ...gapOn,
        sleep: async (ms) => {
          clock.now += ms;
        },
      },
      clock,
    );
    const sentAt: number[] = [];
    const answer = run.captured.answers.get('sendMessage')!;
    run.captured.answers.set('sendMessage', (payload) => {
      sentAt.push(clock.now);
      return answer(payload);
    });
    await run.notices.tick();
    await settled(target, '4.6');
    clock.now += GAP;
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'trade']);
    const tradeAt = sentAt.at(-1)!;
    // the pace before the delete and the one before the send
    expect(tradeAt).toBeGreaterThan(clock.now - 1 - 2 * (1000 / SESSION_NOTICE_SEND_PER_SECOND));
    clock.now = tradeAt + GAP - 1;
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target)).toHaveLength(3);
    clock.now = tradeAt + GAP;
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target).at(-1)).toBe('waiting');

    // a refused send: put back, and tried again not before the gap
    await settled(target, '-5');
    clock.now += GAP;
    failNext(run.captured, { sendMessage: [telegramError(400)] });
    const before = sequenceOf(run.captured.calls, target).length;
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target).slice(before)).toEqual([
      'deleteMessage',
      'trade',
    ]);
    expect((await rowOf(target)).notifiedTrades).toBe(1);
    const refusedAt = clock.now;
    clock.now = refusedAt + GAP - 1;
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target).slice(before)).toEqual([
      'deleteMessage',
      'trade',
    ]);
    clock.now = refusedAt + GAP;
    await run.notices.tick();
    expect(sequenceOf(run.captured.calls, target).slice(before)).toEqual([
      'deleteMessage',
      'trade',
      'trade',
    ]);
    expect((await rowOf(target)).notifiedTrades).toBe(2);
  });

  it('G6 a user who blocked the bot: every trade claimed in one tick, the gap does not hold them', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    for (const profit of ['4.6', '-5', '0']) await settled(target, profit);
    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.id, target.seed.userId));
    const { notices, captured } = sender(gapOn, clock);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual([]);
    expect((await rowOf(target)).notifiedTrades).toBe(3);
  });

  it('G7 a finished session’s last trade and the final mark in one tick; the fallback summary in the same chat waits for the gap', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    await settled(target, '4.6');
    await stop(target);
    await snapshot(target);
    const { notices, captured } = sender(gapOn, clock);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade']);
    expect(await rowOf(target)).toMatchObject({
      finalNoticeSentAt: expect.any(Date),
      summarySentAt: null,
    });
    clock.now += GAP;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['trade', 'summary']);
  });

  it('G7b a stale waiting message’s delete does not start the gap: the new waiting message in the same turn', async () => {
    const clock = { now: 1_000_000 };
    const target = await seedSession();
    await markStatus(target);
    await noSignal(target);
    const { notices, captured } = sender(gapOn, clock);
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting']);
    messageIds += 1;
    expect(
      await recordSessionStatusMessage(tmp.db, {
        id: target.session.id,
        telegramUserId: target.seed.telegramUserId,
        messageId: messageIds,
      }),
    ).toBe(true);
    clock.now += GAP;
    await notices.tick();
    expect(sequenceOf(captured.calls, target)).toEqual(['waiting', 'deleteMessage', 'waiting']);
  });

  it('G8 a 429 pauses the whole sender as before: no chat goes until the pause has passed, then the same trade first', async () => {
    const clock = { now: 1_000_000 };
    const first = await seedSession();
    await settled(first, '4.6');
    const second = await seedSession();
    await settled(second, '-5');
    const { notices, captured } = sender(gapOn, clock);
    failNext(captured, { sendMessage: [telegramError(429, 5)] });
    await notices.tick();
    expect(sequenceOf(captured.calls, first)).toEqual(['trade']);
    expect(sequenceOf(captured.calls, second)).toEqual([]);
    clock.now += 4_999;
    await notices.tick();
    expect(sequenceOf(captured.calls, first)).toEqual(['trade']);
    expect(sequenceOf(captured.calls, second)).toEqual([]);
    clock.now += 1;
    await notices.tick();
    expect(callsTo(captured.calls, 'sendMessage').map((call) => call.payload.chat_id)).toEqual([
      first.seed.telegramUserId,
      first.seed.telegramUserId,
      second.seed.telegramUserId,
    ]);
    expect((await rowOf(first)).notifiedTrades).toBe(1);
    expect((await rowOf(second)).notifiedTrades).toBe(1);
  });
});

describe('the hold-back of a thrown turn (#660)', () => {
  const GAP = SESSION_NOTICE_CHAT_GAP_MS;
  const ERROR = 50;
  const failed = (logs: Record<string, unknown>[]) =>
    logs.filter(
      (entry) => entry.level === ERROR && entry.msg === 'session notices failed for a session',
    );
  // two finished sessions without a status message, their balances current: each gets the
  // fallback summary; once their notices are closed, every UPDATE of `held`'s row throws, so its
  // summary's claim does. A rejected balance refresh no longer throws in the turn (#870, F17).
  async function throwingSummary() {
    const held = await seedSession();
    await settled(held, '4.6');
    await stop(held);
    await snapshot(held);
    const other = await seedSession();
    await settled(other, '-5');
    await stop(other);
    await snapshot(other);
    const failHeld = async () => {
      await tmp.db.execute(sql`
        create function test_fail_summary() returns trigger language plpgsql as $$
        begin raise exception 'summary claim refused by the test'; end $$`);
      await tmp.db.execute(
        sql.raw(`create trigger test_fail_summary before update on trading_sessions
        for each row when (old.id = '${held.session.id}') execute function test_fail_summary()`),
      );
    };
    const unfail = async () => {
      await tmp.db.execute(sql`drop trigger if exists test_fail_summary on trading_sessions`);
      await tmp.db.execute(sql`drop function if exists test_fail_summary()`);
    };
    return { held, other, failHeld, unfail };
  }

  it('HB1 a fallback summary that throws holds its session out of the lists; a newer session goes on; tried again after the hold', async () => {
    const clock = { now: 1_000_000 };
    const { held, other, failHeld, unfail } = await throwingSummary();
    const { notices, captured, logs } = sender({ config: { chatGapMs: GAP } }, clock);
    await notices.tick();
    expect((await rowOf(held)).finalNoticeSentAt).toBeInstanceOf(Date);
    await failHeld();
    try {
      clock.now += GAP;
      await notices.tick();
      expect(failed(logs())).toEqual([
        expect.objectContaining({ sessionId: held.session.id, holdMs: SESSION_NOTICE_HOLD_MS }),
      ]);
      expect(sequenceOf(captured.calls, other)).toEqual(['trade', 'summary']);
      clock.now += GAP;
      await notices.tick();
      clock.now += SESSION_NOTICE_HOLD_MS - 2 * GAP - 1;
      await notices.tick();
      expect(failed(logs())).toHaveLength(1);
      clock.now += 1 + GAP;
      await notices.tick();
      expect(failed(logs())).toHaveLength(2);
    } finally {
      await unfail();
    }
    expect(sequenceOf(captured.calls, held)).toEqual(['trade']);
  });

  it('HB2 a statement that throws in the first pass holds its session; a newer session’s trade goes in the same tick; after the hold the trade goes', async () => {
    const clock = { now: 1_000_000 };
    const held = await seedSession();
    await settled(held, '4.6');
    const other = await seedSession();
    await settled(other, '-5');
    const { notices, captured, logs } = sender({ config: { chatGapMs: GAP } }, clock);
    await tmp.db.execute(sql`
      create function test_fail_notice() returns trigger language plpgsql as $$
      begin raise exception 'notice claim refused by the test'; end $$`);
    await tmp.db.execute(
      sql.raw(`create trigger test_fail_notice before update on trading_sessions
      for each row when (old.id = '${held.session.id}') execute function test_fail_notice()`),
    );
    try {
      await notices.tick();
      expect(failed(logs())).toEqual([
        expect.objectContaining({ sessionId: held.session.id, holdMs: SESSION_NOTICE_HOLD_MS }),
      ]);
      expect(sequenceOf(captured.calls, other)).toEqual(['trade']);
      clock.now += GAP;
      await notices.tick();
      expect(failed(logs())).toHaveLength(1);
    } finally {
      await tmp.db.execute(sql`drop trigger test_fail_notice on trading_sessions`);
      await tmp.db.execute(sql`drop function test_fail_notice()`);
    }
    await notices.tick();
    expect(sequenceOf(captured.calls, held)).toEqual([]);
    clock.now += SESSION_NOTICE_HOLD_MS;
    await notices.tick();
    expect(sequenceOf(captured.calls, held)).toEqual(['trade']);
    expect((await rowOf(held)).notifiedTrades).toBe(1);
  });

  it('HB3 the hold is in memory: a new sender tries at once; a throw after the hold holds the session again for the whole hold', async () => {
    const clock = { now: 1_000_000 };
    const { failHeld, unfail } = await throwingSummary();
    const first = sender({ config: { chatGapMs: GAP } }, clock);
    await first.notices.tick();
    await failHeld();
    try {
      clock.now += GAP;
      await first.notices.tick();
      expect(failed(first.logs())).toHaveLength(1);
      const restarted = sender({ config: { chatGapMs: GAP } }, clock);
      await restarted.notices.tick();
      expect(failed(restarted.logs())).toHaveLength(1);

      clock.now += SESSION_NOTICE_HOLD_MS;
      await first.notices.tick();
      expect(failed(first.logs())).toHaveLength(2);
      clock.now += SESSION_NOTICE_HOLD_MS - 1;
      await first.notices.tick();
      expect(failed(first.logs())).toHaveLength(2);
    } finally {
      await unfail();
    }
  });
});

describe('the wake (#723)', () => {
  const OPEN_MARK = '<pre>⏳';
  const WAKE_GAP = SESSION_NOTICE_WAKE_GAP_MS;
  const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const made: { notices: SessionNoticeSender; listener?: SessionNoticeListener }[] = [];
  afterEach(async () => {
    for (const { notices, listener } of made.splice(0)) {
      await listener?.stop();
      await notices.stop();
    }
  });
  const timeouts = () =>
    process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

  // the sender on the real clock and sleep, its tick lines at debug; with `listen`, the listener
  // on the test database wakes it, as index.ts wires them; start() is never called, so every tick
  // the case does not call is a woken one
  async function wakeful(config: Partial<SessionNoticeConfig> = {}, listen = true) {
    const built = sender(
      { now: () => performance.now(), sleep: realSleep, config: { chatGapMs: 0, ...config } },
      undefined,
      'debug',
    );
    const ticks = () => built.logs().filter((line) => line.msg === 'session notice tick');
    if (!listen) {
      made.push({ notices: built.notices });
      return { ...built, ticks, listener: undefined };
    }
    const lines: string[] = [];
    const listener = createSessionNoticeListener({
      pool: tmp.pool,
      channel: SESSION_NOTICE_CHANNEL,
      onNotification: (sessionId) => built.notices.wake(sessionId),
      logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    });
    made.push({ notices: built.notices, listener });
    listener.start();
    await until('the listener', () => lines.some((line) => line.includes('listening')));
    return { ...built, ticks, listener };
  }
  const openSendsTo = (calls: readonly ApiCall[], target: Target) =>
    sendsTo(calls, target).filter((call) => pushedText(call.payload).includes(OPEN_MARK));

  it('K1 a settle wakes the sender: the result edits the message within a second, no tick called', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    const { notices, captured, ticks } = await wakeful();
    await notices.tick();
    expect(openSendsTo(captured.calls, target)).toHaveLength(1);
    await settle(trade, '-5');
    const settledAt = Date.now();
    await until('the result', () => editsTo(captured.calls, target).length === 1);
    expect(Date.now() - settledAt).toBeLessThan(1_000);
    expect(pushedText(editsTo(captured.calls, target)[0]!.payload)).not.toContain(OPEN_MARK);
    // a tick's line follows its calls
    await until('the line of the woken tick', () => ticks().length === 2);
    expect(ticks().map((line) => line.woken)).toEqual([0, 1]);
    // the woken tick read its session alone (#870)
    expect(ticks().map((line) => line.sessions)).toEqual(['all', 1]);
  });

  it('K2 an accept wakes the sender: the open block is sent within a second, no tick called', async () => {
    const target = await seedSession();
    const { captured, ticks } = await wakeful();
    await opened(target);
    const acceptedAt = Date.now();
    await until('the open block', () => openSendsTo(captured.calls, target).length === 1);
    expect(Date.now() - acceptedAt).toBeLessThan(1_000);
    await until('the line of the woken tick', () => ticks().length === 1);
    expect(ticks().map((line) => line.woken)).toEqual([1]);
    expect(ticks().map((line) => line.sessions)).toEqual([1]);
  });

  it('K3 wakes during a tick merge into one more tick right after it', async () => {
    const target = await seedSession();
    await opened(target);
    const { notices, captured, ticks } = await wakeful({}, false);
    let release: () => void = () => {};
    const answer = captured.answers.get('sendMessage')!;
    captured.answers.set('sendMessage', (payload) => {
      const result = answer(payload);
      return new Promise((resolve) => {
        release = () => resolve(result);
      });
    });
    const inFlight = notices.tick();
    await until('the held send', () => openSendsTo(captured.calls, target).length === 1);
    notices.wake();
    notices.wake();
    notices.wake();
    release();
    await inFlight;
    await until('the woken tick', () => ticks().length === 2);
    // a wake without a session's id reads the lists whole (#870)
    expect(ticks()[1]).toMatchObject({ woken: 3, pending: 0, sessions: 'all' });
    expect(captured.calls).toHaveLength(1);
  });

  it('K4 a lost notification: the tick serves the settle', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    const { notices, captured, ticks, listener } = await wakeful();
    await notices.tick();
    await listener!.stop();
    await settle(trade, '-5');
    expect(editsTo(captured.calls, target)).toEqual([]);
    await notices.tick();
    expect(editsTo(captured.calls, target)).toHaveLength(1);
    expect(ticks().map((line) => line.woken)).toEqual([0, 0]);
  });

  it('K5 a woken step whose chat is cooling goes at the end of the gap, with no tick called', async () => {
    // wider than the floor and the manual tick with the settle after it, so the woken tick finds
    // the chat cooling
    const GAP = 500;
    const target = await seedSession();
    const trade = await opened(target);
    const { notices, captured, ticks } = await wakeful({ chatGapMs: GAP });
    const at = new WeakMap<object, number>();
    for (const method of ['sendMessage', 'editMessageText']) {
      const answer = captured.answers.get(method)!;
      captured.answers.set(method, (payload) => {
        at.set(payload, performance.now());
        return answer(payload);
      });
    }
    await notices.tick();
    const [open] = openSendsTo(captured.calls, target);
    await settle(trade, '-5');
    const settledAt = Date.now();
    await until('the result', () => editsTo(captured.calls, target).length >= 1);
    expect(Date.now() - settledAt).toBeLessThan(1_000);
    const [edit] = editsTo(captured.calls, target);
    expect(at.get(edit!.payload)! - at.get(open!.payload)!).toBeGreaterThanOrEqual(GAP);
    expect(editsTo(captured.calls, target)).toHaveLength(1);
    // the woken tick skipped the cooling chat; the end of its gap woke the next one, whose line
    // follows its edit
    await until('the line of the tick that edited', () => ticks().length === 3);
    expect(ticks().map((line) => line.woken)).toEqual([0, 1, 1]);
    // the end of the gap woke the skipped session by its id (#870)
    expect(ticks().map((line) => line.sessions)).toEqual(['all', 1, 1]);
  });

  it('K6 woken ticks while Telegram asked to wait are empty, and stop once the wakes stop', async () => {
    const target = await seedSession();
    await opened(target);
    const { notices, captured, ticks } = await wakeful({}, false);
    failFirst(captured, 1, telegramError(429, 2));
    await notices.tick();
    const paused = () => ticks().filter((line) => line.paused === true);
    const startedAt = performance.now();
    for (let i = 0; i < 20; i += 1) {
      notices.wake();
      await realSleep(10);
    }
    await until('a paused tick', () => paused().length >= 1);
    const seen = paused().length;
    expect(seen).toBeLessThanOrEqual(Math.floor((performance.now() - startedAt) / WAKE_GAP) + 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(paused()).toHaveLength(seen);
    expect(callsTo(captured.calls, 'sendMessage')).toHaveLength(1);
  });

  it('K7 woken ticks start no closer than the floor', async () => {
    const { notices, ticks } = await wakeful({}, false);
    const startedAt = performance.now();
    for (let i = 0; i < 10; i += 1) {
      notices.wake();
      await realSleep(20);
    }
    await until('the tick on the floor', () => ticks().length >= 2);
    await new Promise((resolve) => setTimeout(resolve, WAKE_GAP + 100));
    // the first wake ticks at once, every later tick on the floor: a slow loop only widens the bound
    const spanMs = performance.now() - startedAt;
    expect(ticks().length).toBeLessThanOrEqual(Math.floor(spanMs / WAKE_GAP) + 1);
    expect(ticks().reduce((sum, line) => sum + Number(line.woken), 0)).toBe(10);
  });

  it('K8 stop() clears the timer for the end of a gap; a wake after stop() ticks nothing', async () => {
    const target = await seedSession();
    const trade = await opened(target);
    const { notices, ticks } = await wakeful({ chatGapMs: 2_000 });
    await notices.tick();
    await settle(trade, '-5');
    await until('the woken tick that skipped the chat', () => ticks().length === 2);
    const before = timeouts();
    const stopping = notices.stop();
    expect(timeouts()).toBe(before - 1);
    await stopping;
    notices.wake();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ticks()).toHaveLength(2);
  });

  it('K8b a wake during the tick stop() ends arms no tick after it', async () => {
    const target = await seedSession();
    await opened(target);
    const { notices, captured, ticks } = await wakeful({}, false);
    let release: () => void = () => {};
    const answer = captured.answers.get('sendMessage')!;
    captured.answers.set('sendMessage', (payload) => {
      const result = answer(payload);
      return new Promise((resolve) => {
        release = () => resolve(result);
      });
    });
    void notices.tick();
    await until('the held send', () => captured.calls.length === 1);
    notices.wake();
    const stopping = notices.stop();
    release();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 300));
    // the tick stop() ended returned before its line, and its finally armed nothing
    expect(ticks()).toEqual([]);
  });

  // #870: a woken tick reads the woken sessions only; the interval's tick reads every session
  it("K9 a wake by one session's id serves that session alone; the interval's tick the other", async () => {
    const woken = await seedSession();
    await opened(woken);
    const other = await seedSession();
    await opened(other);
    const { notices, captured, ticks } = await wakeful({}, false);
    notices.wake(woken.session.id);
    await until('the woken tick', () => ticks().length === 1);
    expect(ticks()[0]).toMatchObject({ woken: 1, sessions: 1, pending: 1 });
    expect(openSendsTo(captured.calls, woken)).toHaveLength(1);
    expect(sequenceOf(captured.calls, other)).toEqual([]);
    await notices.tick();
    expect(openSendsTo(captured.calls, other)).toHaveLength(1);
    expect(ticks()[1]).toMatchObject({ sessions: 'all' });
  });

  it("K10 a settle that finishes a session: its woken tick closes its notices and lists its fallback by id; other finished sessions wait for the interval's tick", async () => {
    const finishing = await seedSession();
    const trade = await opened(finishing);
    const waiting = await seedSession();
    await settled(waiting, '-5');
    await stop(waiting);
    // its notices closed, its fallback summary due: in the fallback's list alone
    const closed = await seedSession();
    await settled(closed, '-5');
    await stop(closed);
    await snapshot(closed);
    await tmp.db
      .update(tradingSessions)
      .set({ notifiedTrades: 1, finalNoticeSentAt: sql`now()` })
      .where(eq(tradingSessions.id, closed.session.id));
    const { notices, captured, ticks, refreshCalls } = await wakeful();
    await stop(finishing);
    await settle(trade, '4.6');
    await until('the woken tick', () => ticks().length === 1);
    expect(ticks()[0]).toMatchObject({ woken: 1, sessions: 1, pending: 1, fallback: 1 });
    expect((await rowOf(finishing)).finalNoticeSentAt).toBeInstanceOf(Date);
    await until('the refresh', () => refreshCalls.length === 1);
    expect(refreshCalls[0]![0]).toBe(finishing.seed.brokerAccountId);
    expect(sequenceOf(captured.calls, waiting)).toEqual([]);
    expect((await rowOf(waiting)).finalNoticeSentAt).toBeNull();
    expect(sequenceOf(captured.calls, closed)).toEqual([]);
    await notices.tick();
    expect(textsTo(captured.calls, waiting)).toHaveLength(1);
    expect((await rowOf(waiting)).finalNoticeSentAt).toBeInstanceOf(Date);
    expect(sequenceOf(captured.calls, closed)).toEqual(['summary']);
  });

  it('K11 a payload that is no session id, or more than scan sessions woken, reads the lists whole', async () => {
    const { notices, ticks, logs } = await wakeful({ scan: 2 }, false);
    notices.wake('x');
    await until('the tick of a foreign payload', () => ticks().length === 1);
    notices.wake('');
    await until('the tick of an empty payload', () => ticks().length === 2);
    notices.wake(randomUUID());
    notices.wake(randomUUID());
    await until('the tick of two', () => ticks().length === 3);
    for (let i = 0; i < 3; i += 1) notices.wake(randomUUID());
    await until('the tick of three', () => ticks().length === 4);
    expect(ticks().map((line) => line.sessions)).toEqual(['all', 'all', 2, 'all']);
    expect(logs().filter((entry) => entry.msg === 'session notice tick failed')).toEqual([]);
  });

  it('K12 a wake by id during the tick that served the session: one more tick by id, nothing to send', async () => {
    const target = await seedSession();
    await opened(target);
    const { notices, captured, ticks } = await wakeful({}, false);
    let release: () => void = () => {};
    const answer = captured.answers.get('sendMessage')!;
    captured.answers.set('sendMessage', (payload) => {
      const result = answer(payload);
      return new Promise((resolve) => {
        release = () => resolve(result);
      });
    });
    const inFlight = notices.tick();
    await until('the held send', () => openSendsTo(captured.calls, target).length === 1);
    notices.wake(target.session.id);
    release();
    await inFlight;
    await until('the woken tick', () => ticks().length === 2);
    expect(ticks()[1]).toMatchObject({ woken: 1, sessions: 1, pending: 0 });
    expect(captured.calls).toHaveLength(1);
  });

  it("K13 the interval's tick during a woken tick runs whole right after it", async () => {
    const woken = await seedSession();
    await opened(woken);
    const other = await seedSession();
    await opened(other);
    const { notices, captured, ticks } = await wakeful({}, false);
    let release: () => void = () => {};
    const answer = captured.answers.get('sendMessage')!;
    captured.answers.set('sendMessage', (payload) => {
      const result = answer(payload);
      return new Promise((resolve) => {
        release = () => {
          captured.answers.set('sendMessage', answer);
          resolve(result);
        };
      });
    });
    notices.wake(woken.session.id);
    await until('the held send', () => openSendsTo(captured.calls, woken).length === 1);
    const whole = notices.tick();
    release();
    await whole;
    expect(ticks().map((line) => line.sessions)).toEqual([1, 'all']);
    expect(openSendsTo(captured.calls, other)).toHaveLength(1);
  });
});

// The waiting message's caption (#860, docs/bot-session.md → The waiting message): the scanner's
// animation with the session pair's scan, and the pass that edits its caption.
describe("the waiting message's caption (#860)", () => {
  const STATUS_ID = 1;
  const listOf = (pct?: number) => ({
    scanned: 3,
    signals: [],
    summary: {
      streaming: true,
      scanning: ASSET,
      closeness: pct === undefined ? [] : [{ assetId: ASSET, pct }],
    },
  });
  const captionOf = (pct: number) =>
    `${RU_TEXTS.sessionWaitingSignal.value}\n\n` +
    `🛰 <b>Сканирую EUR/USD</b> · движение ${String(pct)} % от порога сигнала\n` +
    '✅ Котировки  ✅ Движение цены  ⏳ Отбор сигнала';
  const scan = { list: listOf(64) };
  const scanner = { fresh: () => scan.list };
  beforeEach(() => {
    scan.list = listOf(64);
  });
  const STOP = (target: Target) => [
    { text: RU_LABELS.sessionStopButton, callback_data: `session:stop:${target.session.id}:w` },
  ];
  const statusMessage = (target: Target) =>
    tmp.db
      .update(tradingSessions)
      .set({ statusMessageId: STATUS_ID })
      .where(eq(tradingSessions.id, target.session.id));
  async function waitingTarget(settings?: TradingSessionSettings): Promise<Target> {
    const target = await seedSession(settings);
    await statusMessage(target);
    await noSignal(target);
    return target;
  }
  const captionsTo = (calls: readonly ApiCall[], target?: Target) =>
    callsTo(calls, 'editMessageCaption').filter(
      (call) => target === undefined || call.payload.chat_id === target.seed.telegramUserId,
    );
  const waitingIdOf = async (target: Target) => (await rowOf(target)).waitingMessageId;
  // `count` sessions, each with a live waiting message the run's first tick sent, by id; the
  // pacer's sleep calls `hook.at` when it is set
  async function waitingRun(
    count: number,
    patch: Parameters<typeof sender>[0] = {},
    clock = { now: 0 },
    level: 'info' | 'debug' = 'info',
  ) {
    const targets: Target[] = [];
    for (let i = 0; i < count; i += 1) targets.push(await waitingTarget());
    const hook: { at?: () => void | Promise<void> } = {};
    let sleeps = 0;
    const run = sender(
      {
        scanner,
        sleep: async () => {
          sleeps += 1;
          await hook.at?.();
        },
        ...patch,
      },
      clock,
      level,
    );
    await run.notices.tick();
    for (const target of targets) expect(waitingTo(run.captured.calls, target)).toHaveLength(1);
    targets.sort((a, b) => (a.session.id < b.session.id ? -1 : 1));
    return { targets, run, hook, sleeps: () => sleeps };
  }

  it('WC1 the waiting message is the animation with the pair’s scan; the second send names the file by its id', async () => {
    const { targets, run } = await waitingRun(2);
    const [first, second] = callsTo(run.captured.calls, 'sendAnimation');
    expect(first!.payload.animation).toBeInstanceOf(InputFile);
    expect(second!.payload.animation).toBe(RADAR_FILE_ID);
    for (const target of targets) {
      const [sent] = waitingTo(run.captured.calls, target);
      expect(sent!.payload).toMatchObject({
        caption: captionOf(64),
        parse_mode: 'HTML',
        disable_notification: true,
      });
      expect(inlineButtons(sent!.payload)).toEqual(STOP(target));
      expect(await waitingIdOf(target)).toBe(answered.get(sent!.payload));
    }
  });

  it('WC2 the pass edits a caption whose figures changed, with its «⏹»; the same caption again is not sent', async () => {
    const { targets, run } = await waitingRun(1);
    const [target] = targets;
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toEqual([]);
    scan.list = listOf(71);
    await run.notices.captions();
    const edits = captionsTo(run.captured.calls, target);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.payload).toMatchObject({
      message_id: await waitingIdOf(target!),
      caption: captionOf(71),
      parse_mode: 'HTML',
    });
    expect(inlineButtons(edits[0]!.payload)).toEqual(STOP(target!));
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(1);
  });

  it('WC3 the pass edits at most its count of sessions, round by id', async () => {
    const { targets, run } = await waitingRun(5, { config: { captionEditsPerPass: 3 } });
    const chats = () =>
      captionsTo(run.captured.calls).map((call) =>
        targets.findIndex((target) => target.seed.telegramUserId === call.payload.chat_id),
      );
    for (const [pct, expected] of [
      [71, [0, 1, 2]],
      [72, [0, 1, 2, 3, 4]],
      [73, [0, 1, 2, 3, 4, 0, 1, 2]],
    ] as const) {
      scan.list = listOf(pct);
      await run.notices.captions();
      expect(chats()).toEqual(expected);
    }
  });

  it('WC3b a pass that yields at its second session begins the next pass with it', async () => {
    const clock = { now: 0 };
    const { targets, run, hook } = await waitingRun(2, {}, clock, 'debug');
    const chats = () =>
      captionsTo(run.captured.calls).map((call) =>
        targets.findIndex((target) => target.seed.telegramUserId === call.payload.chat_id),
      );
    clock.now = 10_000;
    scan.list = listOf(71);
    hook.at = () => {
      if (captionsTo(run.captured.calls).length === 1) {
        hook.at = undefined;
        run.notices.wake();
      }
    };
    await run.notices.captions();
    expect(chats()).toEqual([0]);
    const ticks = () => run.logs().filter((line) => line.msg === 'session notice tick');
    await until('the woken tick', () => ticks().length === 2);
    scan.list = listOf(72);
    await run.notices.captions();
    expect(chats()).toEqual([0, 1]);
    scan.list = listOf(73);
    await run.notices.captions();
    expect(chats()).toEqual([0, 1, 0, 1]);
  });

  it('WC3c a page that ended at the last id begins the round again in the same pass', async () => {
    const { targets, run } = await waitingRun(3, { config: { captionEditsPerPass: 3 } });
    const chats = () =>
      captionsTo(run.captured.calls).map((call) =>
        targets.findIndex((target) => target.seed.telegramUserId === call.payload.chat_id),
      );
    scan.list = listOf(71);
    await run.notices.captions();
    expect(chats()).toEqual([0, 1, 2]);
    scan.list = listOf(72);
    await run.notices.captions();
    expect(chats()).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('WC4 a wake in the pace before an edit ends the pass; the woken tick follows at once', async () => {
    const clock = { now: 0 };
    const { run, hook } = await waitingRun(3, {}, clock, 'debug');
    clock.now = 10_000;
    scan.list = listOf(71);
    hook.at = () => {
      if (captionsTo(run.captured.calls).length === 1) {
        hook.at = undefined;
        run.notices.wake();
      }
    };
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(1);
    const lines = () => run.logs().filter((line) => line.msg === 'session notice tick');
    await until('the woken tick', () => lines().length === 2);
    expect(lines()[1]).toMatchObject({ woken: 1 });
    expect(run.logs().find((line) => line.msg === 'session waiting captions')).toMatchObject({
      listed: 3,
      edited: 1,
      yielded: true,
    });
  });

  it('WC4b a wake from the answer to an edit: no pace and no edit after it', async () => {
    const { run, sleeps } = await waitingRun(3);
    scan.list = listOf(71);
    const answer = run.captured.answers.get('editMessageCaption');
    run.captured.answers.set('editMessageCaption', (payload) => {
      run.notices.wake();
      return answer === undefined ? true : answer(payload);
    });
    const before = sleeps();
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(1);
    expect(sleeps() - before).toBe(1);
  });

  it('WC4c the interval’s tick during a pass does not end it; the tick runs right after it', async () => {
    const clock = { now: 0 };
    const { run, hook } = await waitingRun(3, {}, clock, 'debug');
    clock.now = 10_000;
    scan.list = listOf(71);
    hook.at = () => {
      if (captionsTo(run.captured.calls).length === 1) {
        hook.at = undefined;
        void run.notices.tick();
      }
    };
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(3);
    expect(run.logs().find((line) => line.msg === 'session waiting captions')).toMatchObject({
      edited: 3,
      yielded: false,
    });
    const ticks = () => run.logs().filter((line) => line.msg === 'session notice tick');
    await until('the tick after the pass', () => ticks().length === 2);
  });

  it('WC5 a 429 on an edit pauses the pass: none until the retry, then the next sessions, and the paused one in the next round', async () => {
    const clock = { now: 10_000 };
    const { targets, run } = await waitingRun(3, {}, clock, 'debug');
    scan.list = listOf(71);
    failNext(run.captured, { editMessageCaption: [telegramError(429, 5)] });
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(1);
    const passes = () => run.logs().filter((line) => line.msg === 'session waiting captions');
    expect(passes()).toHaveLength(1);
    clock.now += 4_000;
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(1);
    expect(passes()).toHaveLength(1);
    clock.now += 1_000;
    const chats = () =>
      captionsTo(run.captured.calls).map((call) =>
        targets.findIndex((target) => target.seed.telegramUserId === call.payload.chat_id),
      );
    await run.notices.captions();
    expect(chats()).toEqual([0, 1, 2]);
    scan.list = listOf(72);
    await run.notices.captions();
    expect(chats()).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('WC6 an edit refused as gone (a text waiting message of the backend before #860): deleted, its id dropped, the animation on the next tick', async () => {
    const { targets, run } = await waitingRun(1);
    const [target] = targets;
    const id = await waitingIdOf(target!);
    scan.list = listOf(71);
    failNext(run.captured, {
      editMessageCaption: [refusal('Bad Request: there is no caption in the message to edit')],
    });
    await run.notices.captions();
    expect(deletesTo(run.captured.calls, target!)).toEqual([id]);
    expect(await waitingIdOf(target!)).toBeNull();
    expect(messagesOf(run.logs(), INFO)).toContain(
      'session waiting caption not edited: the message is gone',
    );
    await run.notices.tick();
    expect(waitingTo(run.captured.calls, target!)).toHaveLength(2);
    expect(waitingTo(run.captured.calls, target!)[1]!.payload.caption).toBe(captionOf(71));
  });

  it('WC7 a waiting message the stop route took over between the list and the edit is not edited', async () => {
    const { targets, run, hook } = await waitingRun(1);
    const [target] = targets;
    const id = (await waitingIdOf(target!))!;
    scan.list = listOf(71);
    hook.at = async () => {
      hook.at = undefined;
      await clearSessionWaitingMessage(tmp.db, { sessionId: target!.session.id, messageId: id });
    };
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toEqual([]);
    expect(messagesOf(run.logs(), INFO)).toContain(
      'session waiting caption taken over: not edited',
    );
  });

  it('WC8 a 403 on an edit marks the user unreachable; the next pass leaves the session out', async () => {
    const { targets, run } = await waitingRun(1);
    const [target] = targets;
    scan.list = listOf(71);
    failNext(run.captured, { editMessageCaption: [telegramError(403)] });
    await run.notices.captions();
    expect(messagesOf(run.logs(), WARN)).toEqual([
      'session waiting caption refused: the user is unreachable',
    ]);
    const [user] = await tmp.db
      .select({ at: users.telegramBlockedAt })
      .from(users)
      .where(eq(users.id, target!.seed.userId));
    expect(user?.at).toBeInstanceOf(Date);
    scan.list = listOf(72);
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(1);
  });

  it('WC9 another 4xx on an edit: tried on later passes, then left until the next waiting message', async () => {
    const { run } = await waitingRun(1, { config: { maxAttempts: 3 } });
    scan.list = listOf(71);
    failNext(run.captured, {
      editMessageCaption: [telegramError(400), telegramError(400), telegramError(400)],
    });
    for (let pass = 0; pass < 4; pass += 1) await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(3);
    expect(messagesOf(run.logs(), WARN)).toEqual([
      'session waiting caption not edited',
      'session waiting caption not edited',
      'session waiting caption dropped',
    ]);
  });

  it('WC9 an edit whose outcome is a 5xx: logged, edited again on the next pass', async () => {
    const { run } = await waitingRun(1);
    scan.list = listOf(71);
    failNext(run.captured, { editMessageCaption: [telegramError(502)] });
    await run.notices.captions();
    expect(messagesOf(run.logs(), WARN)).toEqual(['session waiting caption edit outcome unknown']);
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toHaveLength(2);
  });

  it('WC10 a cooling chat is skipped by the pass, and an edit marks its chat for the next step', async () => {
    const GAP = 1_000;
    const clock = { now: 0 };
    const { targets, run } = await waitingRun(1, { config: { chatGapMs: GAP } }, clock);
    const [cool] = targets;
    clock.now = 4_800;
    const hot = await waitingTarget();
    await run.notices.tick();
    expect(waitingTo(run.captured.calls, hot)).toHaveLength(1);
    clock.now = 5_000;
    scan.list = listOf(71);
    await run.notices.captions();
    expect(captionsTo(run.captured.calls, hot)).toEqual([]);
    expect(captionsTo(run.captured.calls, cool)).toHaveLength(1);
    await settled(cool!, '4.6');
    clock.now = 5_100;
    await run.notices.tick();
    expect(sendsTo(run.captured.calls, cool!)).toEqual([]);
    clock.now = 6_000;
    await run.notices.tick();
    expect(sendsTo(run.captured.calls, cool!)).toHaveLength(1);
  });

  it('WC11 an animation refused for its file forgets the id: the next send uploads the file', async () => {
    const { run } = await waitingRun(1);
    const target = await waitingTarget();
    failNext(run.captured, {
      sendAnimation: [refusal('Bad Request: wrong file identifier/HTTP URL specified')],
    });
    await run.notices.tick();
    expect(messagesOf(run.logs(), WARN)).toEqual(['session waiting message refused']);
    await run.notices.tick();
    const sends = waitingTo(run.captured.calls, target);
    expect(sends.map((call) => typeof call.payload.animation)).toEqual(['string', 'object']);
    expect(sends[1]!.payload.animation).toBeInstanceOf(InputFile);
  });

  it('WC12 a pass called during a tick does nothing; after stop() too', async () => {
    const { run, hook } = await waitingRun(1);
    scan.list = listOf(71);
    await waitingTarget();
    let during: Promise<void> | undefined;
    hook.at = () => {
      hook.at = undefined;
      during = run.notices.captions();
    };
    await run.notices.tick();
    await during;
    expect(during).toBeDefined();
    expect(captionsTo(run.captured.calls)).toEqual([]);
    await run.notices.stop();
    await run.notices.captions();
    expect(captionsTo(run.captured.calls)).toEqual([]);
  });

  it('WC13 stop() during a pass: the edit in flight, nothing after it', async () => {
    const { run, hook } = await waitingRun(3);
    scan.list = listOf(71);
    let stopping: Promise<void> | undefined;
    hook.at = () => {
      if (captionsTo(run.captured.calls).length === 1) {
        hook.at = undefined;
        stopping = run.notices.stop();
      }
    };
    await run.notices.captions();
    await stopping;
    expect(captionsTo(run.captured.calls)).toHaveLength(1);
  });

  it('WC13 start() runs the pass on its timer; stop() clears it', async () => {
    const { run } = await waitingRun(1, { config: { captionMs: 30, tickMs: 60_000 } });
    scan.list = listOf(71);
    run.notices.start();
    await until('the timer’s pass', () => captionsTo(run.captured.calls).length === 1);
    const timeouts = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    const before = timeouts();
    await run.notices.stop();
    // the tick's interval and the pass's
    expect(before - timeouts()).toBe(2);
  });

  it('WC14 without a scanner the pair waits for a move; settings that cannot be read: the header alone, never edited', async () => {
    const plain = await waitingTarget();
    const unread = await seedSession();
    await tmp.db
      .update(tradingSessions)
      .set({ settings: sql`'{}'::jsonb` })
      .where(eq(tradingSessions.id, unread.session.id));
    await statusMessage(unread);
    await noSignal(unread);
    const { notices, captured } = sender();
    await notices.tick();
    expect(waitingTo(captured.calls, plain)[0]!.payload.caption).toBe(
      `${RU_TEXTS.sessionWaitingSignal.value}\n\n` +
        '🛰 <b>Сканирую EUR/USD</b> · жду движение цены\n' +
        '⏳ Котировки  ⏳ Движение цены  ⏳ Отбор сигнала',
    );
    expect(waitingTo(captured.calls, unread)[0]!.payload.caption).toBe(
      RU_TEXTS.sessionWaitingSignal.value,
    );
    await notices.captions();
    expect(captionsTo(captured.calls)).toEqual([]);
  });

  it('WC15 an English session’s caption is English', async () => {
    const target = await waitingTarget();
    await tmp.db.update(users).set({ language: 'en' }).where(eq(users.id, target.seed.userId));
    const { notices, captured } = sender({ scanner });
    await notices.tick();
    expect(waitingTo(captured.calls, target)[0]!.payload.caption).toBe(
      `${clientTextsOf(BotLanguage.En).sessionWaitingSignal.value}\n\n` +
        '🛰 <b>Scanning EUR/USD</b> · movement at 64 % of the signal threshold\n' +
        '✅ Quotes  ✅ Price movement  ⏳ Signal selection',
    );
  });

  it('WC16 the captions shown are kept at most captionMemo: above it the round evicts the entries it needs, each edited again', async () => {
    const { targets, run } = await waitingRun(3, { config: { captionMemo: 2 } });
    const chats = () =>
      captionsTo(run.captured.calls).map((call) =>
        targets.findIndex((target) => target.seed.telegramUserId === call.payload.chat_id),
      );
    scan.list = listOf(71);
    await run.notices.captions();
    expect(chats()).toEqual([0, 1, 2]);
    await run.notices.captions();
    expect(chats()).toEqual([0, 1, 2, 0, 1, 2]);
  });
});
