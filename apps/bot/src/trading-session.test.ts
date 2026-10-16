import { GrammyError, HttpError, InputFile } from 'grammy';
import type { ApiError, Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { until } from '@binarius/shared/testing';
import {
  pairLabel,
  TradeIntentStatus,
  TradeMode,
  TradingModeErrorCode,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  decimalStringSchema,
  formatSignedUsd,
  plainTextOf,
  telegramHtml,
  type PairLabel,
  type SessionSummary,
  type TradingSessionView,
  CONNECT_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  supportUrl,
  BUY_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  cycleStakeCallbackData,
  demoAnalysisCallbackData,
  demoLaunchCallbackData,
  sessionStartCallbackData,
  stakeMenuCallbackData,
} from './demo';
import type { SessionTrackRequest } from './session-tracker';
import {
  ACCESS_VIEW,
  BOT_INFO,
  CARD_MESSAGE_ID,
  CASHIER_URL,
  PAIR_EURUSD,
  PAIRS_RESPONSE,
  SESSION_ID,
  SIGNAL_DECIDED,
  SESSION_VIEW,
  TEXT_CARD_MESSAGE_ID,
  USER,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  intentView,
  messageAnswer,
  photoAnswer,
  sessionView,
  stubSessionResumer,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  type ApiCall,
} from './testing';
import { sessionAssetLabel, sessionStatusText, TEXTS, textOf, LABELS } from './texts';
import {
  sessionCardKeyboard,
  sessionOutcomeUnknown,
  sessionKeyboard,
  sessionRefreshCallbackData,
  sessionStopCallbackData,
  START_REFUSALS,
} from './trading-session';
import { INVITE_CALLBACK_DATA, MODE_CALLBACK_DATA } from './keyboards';
import { MODE_DEMO_CALLBACK_DATA, MODE_REAL_CALLBACK_DATA } from './trading-mode';
import { INLINE_QUERY_LIMIT, shareQuery } from './session-share';

const START = sessionStartCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5);
const REAL_START = sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5);
// the sizes of the card's sendPhoto result, smallest first (#321)
const SMALL_FILE_ID = 'AgACAgIAAxkBAAIBsmall';
const CARD_FILE_ID = 'AgACAgIAAxkBAAIBlarge';
const REFRESH = sessionRefreshCallbackData(SESSION_ID);
const STOP = sessionStopCallbackData(SESSION_ID);

interface Button {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}

const STOPPED = sessionView({
  status: TradingSessionStatus.Stopped,
  stopReason: TradingSessionStopReason.UserStopped,
  endedAt: '2026-10-07T10:05:00.000Z',
});
const d = (value: string) => decimalStringSchema.parse(value);
const SUMMARY: SessionSummary = {
  result: d('-0.15000000'),
  trades: [
    { profit: d('0.85000000'), openPrice: 1.1, closePrice: 1.2 },
    { profit: d('-1.00000000'), openPrice: 1.2, closePrice: 1.1 },
  ],
};

function setup(
  options: {
    readPairs?: BackendClient['readPairs'];
    startSession?: BackendClient['startSession'];
    readSession?: BackendClient['readSession'];
    stopSession?: BackendClient['stopSession'];
    claimSessionSummary?: BackendClient['claimSessionSummary'];
    stopSessions?: BackendClient['stopSessions'];
    setTradingMode?: BackendClient['setTradingMode'];
    // null: a bot whose origin is not https, so no «💳 Пополнить» (#27)
    cashierUrl?: string | null;
    readTradingAccess?: BackendClient['readTradingAccess'];
    // the pair's signal at a cycle door's press (#509): a signal by default
    evaluateSignal?: BackendClient['evaluateSignal'];
  } = {},
) {
  const evaluateSignal = vi.fn<BackendClient['evaluateSignal']>(
    options.evaluateSignal ?? (() => Promise.resolve(SIGNAL_DECIDED)),
  );
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
  // the amount screen behind a demo «🔁 Ещё сессия» (#476)
  const readTradingAccess = vi.fn<BackendClient['readTradingAccess']>(
    options.readTradingAccess ?? (() => Promise.resolve(ACCESS_VIEW)),
  );
  const startSession = vi.fn<BackendClient['startSession']>(
    options.startSession ?? (() => Promise.resolve({ started: SESSION_VIEW })),
  );
  const readSession = vi.fn<BackendClient['readSession']>(
    options.readSession ?? (() => Promise.resolve(SESSION_VIEW)),
  );
  const stopSession = vi.fn<BackendClient['stopSession']>(
    options.stopSession ?? (() => Promise.resolve(STOPPED)),
  );
  const claimSessionSummary = vi.fn<BackendClient['claimSessionSummary']>(
    options.claimSessionSummary ?? (() => Promise.resolve(SUMMARY)),
  );
  const stopSessions = vi.fn<BackendClient['stopSessions']>(
    options.stopSessions ?? (() => Promise.resolve([STOPPED])),
  );
  // a demo user by default: /stop changes no mode (#473)
  const setTradingMode = vi.fn<BackendClient['setTradingMode']>(
    options.setTradingMode ??
      (() => Promise.resolve({ tradingMode: TradeMode.Demo, changed: false, stoppedSessions: 0 })),
  );
  const logger = fakeLogger();
  const sessionTracker = stubSessionTracker();
  const sessionResumer = stubSessionResumer();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({
      readPairs,
      startSession,
      readSession,
      stopSession,
      claimSessionSummary,
      stopSessions,
      setTradingMode,
      readTradingAccess,
      evaluateSignal,
    }),
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker,
    sessionResumer,
    ...(options.cashierUrl === null ? {} : { cashierUrl: options.cashierUrl ?? CASHIER_URL }),
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  api.answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, [SMALL_FILE_ID, CARD_FILE_ID]));
  const press = (data: string, chatType?: string) =>
    bot.handleUpdate(callbackUpdate(data, chatType));
  const send = (text: string, chatType?: string) => bot.handleUpdate(textUpdate(text, chatType));
  // the launch screen's scenes (#418) read the pressed message's id from the update they built
  const pressUpdate = (update: Update) => bot.handleUpdate(update);
  return {
    bot,
    press,
    pressUpdate,
    send,
    logger,
    sessionTracker,
    sessionResumer,
    readPairs,
    startSession,
    readSession,
    stopSession,
    claimSessionSummary,
    stopSessions,
    setTradingMode,
    evaluateSignal,
    ...api,
  };
}

const methods = (calls: readonly ApiCall[]) => calls.map((call) => call.method);
const payloadOf = (calls: readonly ApiCall[], method: string) =>
  calls.find((call) => call.method === method)?.payload;
const rowsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  (payload?.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? [];
const button = (text: string, callback_data: string): Button => ({ text, callback_data });
const warnings = (logger: ReturnType<typeof fakeLogger>) =>
  logger.warn.mock.calls.map((call) => call[1] as string);
const httpError = (status: number, reason?: string) =>
  new BackendError(BackendErrorCode.HttpStatus, {
    status,
    ...(reason === undefined ? {} : { reason }),
  });
const statusOf = (view: TradingSessionView) =>
  sessionStatusText(pairLabel(PAIR_EURUSD), view).value;

const LIVE_ROWS = [
  [button(LABELS.sessionRefreshButton, REFRESH), button(LABELS.sessionStopButton, STOP)],
];
// SESSION_VIEW's own pair and duration; a demo session's opens the amount screen as a new message
// (#476)
const AGAIN = button(LABELS.sessionAgainButton, demoLaunchCallbackData(PAIR_EURUSD.id, 15, 'n'));
// #350: the end of the path under a stopped session, after its refresh and «🔁 Ещё сессия»
// the list of the session's duration; the duration screen for one the demo no longer offers (#382)
const toSignals = (durationSec: 5 | 15) => [
  button(LABELS.toSignalsButton, `${DEMO_SIGNALS_CALLBACK_DATA}:${String(durationSec)}`),
];
const TO_DURATIONS = [button(LABELS.toSignalsButton, DEMO_SIGNALS_CALLBACK_DATA)];
const MENU = [button(LABELS.menuButton, MENU_CALLBACK_DATA)];
const newAnalysis = (durationSec: 5 | 15) => [
  button(LABELS.newAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, durationSec)),
];
// «👥 Пригласить друга» right above the menu at every end of a session (#115)
const INVITE = [button(LABELS.inviteButton, INVITE_CALLBACK_DATA)];
// «💳 Пополнить» (#27): the cashier Mini App, right above the invite at the end of a session
const DEPOSIT: Button[] = [{ text: LABELS.depositButton, web_app: { url: CASHIER_URL } }];
const STOPPED_ROWS = [
  [button(LABELS.sessionRefreshButton, REFRESH)],
  [AGAIN],
  newAnalysis(15),
  toSignals(15),
  DEPOSIT,
  INVITE,
  MENU,
];
const CONNECT_ROWS = [[button(LABELS.connectButton, CONNECT_CALLBACK_DATA)]];
// #350: a refusal of the start leads back to the analysis and to the menu; a blocked user to support
const MENU_ROW = [button(LABELS.menuButton, MENU_CALLBACK_DATA)];
const BACK_ROWS = [
  [button(LABELS.stakeBackAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5))],
  MENU_ROW,
];
const SUPPORT_ROWS = [[{ text: LABELS.supportButton, url: supportUrl() }]];
// for want of tokens, the purchase, then the deposit (#27), above the way back (#117)
const BUY_ONLY_ROWS = [[button(LABELS.buyButton, BUY_CALLBACK_DATA)], ...BACK_ROWS];
const BUY_ROWS = [[button(LABELS.buyButton, BUY_CALLBACK_DATA)], DEPOSIT, ...BACK_ROWS];
// a failed read of the session, after the refresh or the stop: its refresh, never the stop again
const SESSION_REFRESH_ROWS = [[button(LABELS.sessionRefreshButton, REFRESH)], MENU_ROW];
// #509: no signal on the pair, the signals of the same duration and the menu
const OTHER_PAIR_ROWS = [
  [button(LABELS.otherPairButton, `${DEMO_SIGNALS_CALLBACK_DATA}:5`)],
  MENU_ROW,
];
const STAKE_MENU_ROWS = [
  [button(LABELS.stakeMenuButton, stakeMenuCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5))],
];
const EDIT_GONE: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message to edit not found',
};

describe('the session button', () => {
  it('starts a session of five, sends its status with both buttons, and tracks it', async () => {
    const { press, calls, startSession, sessionTracker } = setup();
    await press(START);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(startSession.mock.calls).toEqual([
      [
        {
          telegramUserId: String(USER.id),
          mode: TradeMode.Demo,
          assetId: PAIR_EURUSD.id,
          durationSec: 5,
          trades: 5,
        },
      ],
    ]);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(statusOf(SESSION_VIEW));
    expect(sent?.text).toContain('EUR/USD OTC · ⏱');
    expect(sent?.parse_mode).toBe('HTML');
    expect(rowsOf(sent)).toEqual(LIVE_ROWS);
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SESSION_ID,
      telegramUserId: String(USER.id),
      label: 'EUR/USD OTC',
      view: SESSION_VIEW,
    });
  });

  it("hands the tracker an edit of the status message's own id, its keyboard following the view", async () => {
    const { press, calls, sessionTracker } = setup();
    await press(START);
    const entry = sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
    await entry.edit(telegramHtml`edited`, STOPPED);

    const edit = payloadOf(calls, 'editMessageText');
    expect(edit).toMatchObject({
      chat_id: USER.id,
      message_id: TEXT_CARD_MESSAGE_ID,
      text: 'edited',
    });
    expect(rowsOf(edit)).toEqual(STOPPED_ROWS);

    // #350: a session gone from the backend gets the menu only
    await entry.edit(telegramHtml`gone`, null, 'not_found');
    expect(
      rowsOf(calls.filter((call) => call.method === 'editMessageText').at(-1)?.payload),
    ).toEqual([MENU]);
  });

  it('shows the session already running in a new message and moves tracking to it', async () => {
    const running = sessionView({ lastIntent: intentView({ status: TradeIntentStatus.Accepted }) });
    const { press, calls, sessionTracker } = setup({
      startSession: () => Promise.resolve({ active: running }),
    });
    await press(START);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf(running));
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({ view: running });
  });

  it('asks for another press when the active session ended before the backend read it', async () => {
    const { press, calls, sessionTracker } = setup({
      startSession: () => Promise.resolve({ active: null }),
    });
    await press(START);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.sessionJustEnded.value);
    // #350: the start is a write; the analysis' session button starts the next one
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(BACK_ROWS);
    expect(sessionTracker.track).not.toHaveBeenCalled();
  });

  it.each(
    (Object.keys(START_REFUSALS) as TradingSessionErrorCode[]).map((code) => [code] as const),
  )('answers the refusal %s with its text, once, untracked', async (code) => {
    const status =
      code === TradingSessionErrorCode.CatalogUnavailable ||
      code === TradingSessionErrorCode.SignalUnavailable
        ? 503
        : 409;
    const { press, calls, startSession, sessionTracker, logger } = setup({
      startSession: () => Promise.reject(httpError(status, code)),
    });
    await press(START);
    const refusal: {
      text: Parameters<typeof textOf>[0];
      connect?: true;
      stakeMenu?: true;
      buy?: true;
      otherPair?: true;
      log?: true;
    } = START_REFUSALS[code];
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(textOf(refusal.text).value);
    expect(rowsOf(sent)).toEqual(
      refusal.text === 'blocked'
        ? SUPPORT_ROWS
        : refusal.connect === true
          ? CONNECT_ROWS
          : refusal.stakeMenu === true
            ? STAKE_MENU_ROWS
            : refusal.buy === true
              ? BUY_ROWS
              : refusal.otherPair === true
                ? OTHER_PAIR_ROWS
                : BACK_ROWS,
    );
    // only the refusal for want of tokens offers the purchase (#117)
    expect(
      rowsOf(sent)
        .flat()
        .some((row) => row.callback_data === BUY_CALLBACK_DATA),
    ).toBe(code === TradingSessionErrorCode.InsufficientTokens);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track).not.toHaveBeenCalled();
    expect(warnings(logger)).toEqual(refusal.log === true ? ['trading session not started'] : []);
  });

  // #27: «💳 Пополнить» under the purchase in both modes; none on an origin that is not https
  it('puts the deposit under the purchase of a real refusal for want of tokens, and none without a cashier', async () => {
    const refuse = () => Promise.reject(httpError(409, TradingSessionErrorCode.InsufficientTokens));
    const real = setup({ startSession: refuse });
    await real.press(sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5));
    expect(rowsOf(payloadOf(real.calls, 'sendMessage'))).toEqual(BUY_ROWS);
    const bare = setup({ startSession: refuse, cashierUrl: null });
    await bare.press(START);
    expect(rowsOf(payloadOf(bare.calls, 'sendMessage'))).toEqual(BUY_ONLY_ROWS);
  });

  // #297: the saved stake refused against the snapshot; the picker opens from the same analysis
  it('answers the three stake refusals with «💵 Сумма» for the pressed pair', () => {
    for (const code of [
      TradingSessionErrorCode.StakePrecision,
      TradingSessionErrorCode.StakeBelowMinimum,
      TradingSessionErrorCode.InsufficientBalance,
    ]) {
      expect(START_REFUSALS[code], code).toMatchObject({ stakeMenu: true });
    }
    expect(STAKE_MENU_ROWS[0]?.[0]?.callback_data).toMatch(/^stk:o:d:a:\d+:\d+$/);
  });

  // #379: an old analysis message or «🔁 Ещё сессия» on a pair whose payout fell below the floor
  it('answers payout_too_low with its own text and the way back to the analysis', () => {
    expect(START_REFUSALS[TradingSessionErrorCode.PayoutTooLow]).toEqual({
      text: 'sessionPayoutTooLow',
    });
    expect(plainTextOf(TEXTS.sessionPayoutTooLow)).toBe(
      '🚫 Выплата по паре сейчас ниже порога — сессия на ней не запускается. Открой анализ заново.',
    );
  });

  it('answers the closed switch and the missing tokens with their own texts', () => {
    expect(START_REFUSALS[TradingSessionErrorCode.TradingPaused].text).toBe('tradingPaused');
    expect(START_REFUSALS[TradingSessionErrorCode.DemoOnly]).toEqual({ text: 'tradingDemoOnly' });
    expect(START_REFUSALS[TradingSessionErrorCode.InsufficientTokens].text).toBe(
      'sessionInsufficientTokens',
    );
    // #327: a button drawn in the other mode, or a switch since the render: not a bug
    expect(START_REFUSALS[TradingSessionErrorCode.ModeNotAllowed]).toEqual({
      text: 'stakeAmountChanged',
    });
  });

  // #327: a real press sends its mode, its stake refusal names the real account and opens the
  // real picker
  describe('in real mode', () => {
    it('sends mode real for a real button and shows the real header', async () => {
      const realView = sessionView({ mode: TradeMode.Real });
      const { press, calls, startSession } = setup({
        startSession: () => Promise.resolve({ started: realView }),
      });
      await press(REAL_START);
      expect(startSession.mock.calls[0]?.[0]).toMatchObject({ mode: TradeMode.Real });
      const text = payloadOf(calls, 'sendMessage')?.text;
      expect(text).toBe(statusOf(realView));
      expect(text).toMatch(/^💼 <b>Реальная сессия<\/b>/);
    });

    it('answers insufficient_balance with the real text and the real picker', async () => {
      const { press, calls, logger } = setup({
        startSession: () =>
          Promise.reject(httpError(409, TradingSessionErrorCode.InsufficientBalance)),
      });
      await press(REAL_START);
      const sent = payloadOf(calls, 'sendMessage');
      expect(sent?.text).toBe(TEXTS.stakeAboveAvailableReal.value);
      expect(rowsOf(sent)).toEqual([
        [button(LABELS.stakeMenuButton, stakeMenuCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5))],
      ]);
      expect(warnings(logger)).toEqual([]);
    });

    it('answers mode_not_allowed as «режим изменился», once, without a warning', async () => {
      const { press, calls, startSession, logger } = setup({
        startSession: () => Promise.reject(httpError(409, TradingSessionErrorCode.ModeNotAllowed)),
      });
      await press(REAL_START);
      expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.stakeAmountChanged.value);
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(warnings(logger)).toEqual([]);
    });
  });

  it('does not retry the 503 catalog_unavailable: it is a refusal, not an unknown outcome', async () => {
    const { press, calls, startSession } = setup({
      startSession: () =>
        Promise.reject(httpError(503, TradingSessionErrorCode.CatalogUnavailable)),
    });
    await press(START);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.demoCatalogUnavailable.value);
  });

  // #509: the start route answers it before createTradingSession, as catalog_unavailable
  it('does not retry the 503 signal_unavailable: one POST, its own text', async () => {
    const { press, calls, startSession } = setup({
      startSession: () => Promise.reject(httpError(503, TradingSessionErrorCode.SignalUnavailable)),
    });
    await press(START);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.sessionSignalUnavailable.value);
    expect(sessionOutcomeUnknown(httpError(503, TradingSessionErrorCode.SignalUnavailable))).toBe(
      false,
    );
  });

  it('counts any other 5xx, no answer and a broken body as unknown', () => {
    expect(sessionOutcomeUnknown(httpError(503, TradingSessionErrorCode.CatalogUnavailable))).toBe(
      false,
    );
    expect(sessionOutcomeUnknown(httpError(503))).toBe(true);
    expect(sessionOutcomeUnknown(httpError(500))).toBe(true);
    expect(sessionOutcomeUnknown(new BackendError(BackendErrorCode.Unreachable))).toBe(true);
    expect(sessionOutcomeUnknown(new BackendError(BackendErrorCode.ContractViolation))).toBe(true);
    expect(sessionOutcomeUnknown(httpError(409, TradingSessionErrorCode.PairUnavailable))).toBe(
      false,
    );
    expect(sessionOutcomeUnknown(new TypeError('bug'))).toBe(false);
  });

  it('asks once more on an unknown outcome and shows what the retry learns', async () => {
    const answers = [
      () => Promise.reject(httpError(500)),
      () => Promise.resolve({ started: SESSION_VIEW }),
    ];
    const { press, calls, startSession, sessionTracker } = setup({
      startSession: () => (answers.shift() ?? answers[0]!)(),
    });
    await press(START);
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(startSession.mock.calls[1]).toEqual(startSession.mock.calls[0]);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf(SESSION_VIEW));
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
  });

  it('shows the session a lost first answer had created', async () => {
    const answers = [
      () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      () => Promise.resolve({ active: SESSION_VIEW }),
    ];
    const { press, calls } = setup({ startSession: () => (answers.shift() ?? answers[0]!)() });
    await press(START);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf(SESSION_VIEW));
  });

  it('says the outcome is unknown and warns when the retry is unknown too', async () => {
    const { press, calls, startSession, logger } = setup({
      startSession: () => Promise.reject(httpError(500)),
    });
    await press(START);
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.sessionOutcomeUnknown.value);
    expect(warnings(logger)).toEqual(['trading session not started']);
  });

  it('answers a code the bot does not know, or a prototype key, as unavailable', async () => {
    for (const reason of ['validation', '__proto__', 'toString']) {
      const { press, calls, logger } = setup({
        startSession: () => Promise.reject(httpError(400, reason)),
      });
      await press(START);
      expect(payloadOf(calls, 'sendMessage')?.text, reason).toBe(TEXTS.unavailable.value);
      expect(rowsOf(payloadOf(calls, 'sendMessage')), reason).toEqual(BACK_ROWS);
      expect(warnings(logger), reason).toEqual(['trading session not started']);
    }
  });

  it.each([
    ['a forged asset id', 'demo:sess:0:5'],
    ['an asset id past int4', 'demo:sess:2147483648:15'],
  ])('only stops the spinner for %s', async (_case, data) => {
    const { press, calls, startSession, readPairs } = setup();
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery']);
    expect(startSession).not.toHaveBeenCalled();
    expect(readPairs).not.toHaveBeenCalled();
  });

  it('names the asset by its id when the catalog cannot say', async () => {
    const { press, calls } = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(START);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(sessionStatusText(null, SESSION_VIEW).value);
  });

  it('ignores a press in a group', async () => {
    const { press, calls, startSession } = setup();
    await press(START, 'group');
    expect(calls).toEqual([]);
    expect(startSession).not.toHaveBeenCalled();
  });
});

describe("the session's refresh button", () => {
  it('reads the session and edits it in place, tracking a live one on this message', async () => {
    const { press, calls, readSession, sessionTracker } = setup();
    await press(REFRESH);
    expect(readSession).toHaveBeenCalledWith(SESSION_ID, String(USER.id));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edit = payloadOf(calls, 'editMessageText');
    expect(edit?.text).toBe(statusOf(SESSION_VIEW));
    expect(rowsOf(edit)).toEqual(LIVE_ROWS);
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    const entry = sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
    await entry.edit(telegramHtml`again`, SESSION_VIEW);
    const second = calls.filter((call) => call.method === 'editMessageText')[1];
    expect(second?.payload).toMatchObject({
      chat_id: USER.id,
      message_id: (edit as { message_id?: number } | undefined)?.message_id,
    });
  });

  it('tracks a session that is done too, so its entry sends the summary card once (#318)', async () => {
    const { press, calls, sessionTracker } = setup({ readSession: () => Promise.resolve(STOPPED) });
    await press(REFRESH);
    expect(rowsOf(payloadOf(calls, 'editMessageText'))).toEqual(STOPPED_ROWS);
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({ view: STOPPED });
  });

  it('sends the status anew when the message is gone, and tracks the new one', async () => {
    const { press, calls, apiErrors, sessionTracker } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(REFRESH);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf(SESSION_VIEW));
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
  });

  it('says the status is unavailable on a 404, and warns on any other failure', async () => {
    const missing = setup({ readSession: () => Promise.reject(httpError(404, 'not_found')) });
    await missing.press(REFRESH);
    expect(payloadOf(missing.calls, 'sendMessage')?.text).toBe(
      TEXTS.sessionStatusUnavailable.value,
    );
    expect(rowsOf(payloadOf(missing.calls, 'sendMessage'))).toEqual([MENU_ROW]);
    expect(warnings(missing.logger)).toEqual([]);

    const broken = setup({
      readSession: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await broken.press(REFRESH);
    expect(payloadOf(broken.calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(payloadOf(broken.calls, 'sendMessage'))).toEqual(SESSION_REFRESH_ROWS);
    expect(warnings(broken.logger)).toEqual(['trading session status not read']);
  });
});

describe("the session's stop button", () => {
  it('stops the session and shows it stopped in place, without the stop button', async () => {
    const { press, calls, stopSession, sessionTracker } = setup();
    await press(STOP);
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID, String(USER.id));
    const edit = payloadOf(calls, 'editMessageText');
    expect(edit?.text).toBe(statusOf(STOPPED));
    expect(edit?.text).toContain('⏹ Сессия остановлена по твоей команде.');
    expect(edit?.text).not.toContain('доиграет');
    expect(rowsOf(edit)).toEqual(STOPPED_ROWS);
    // done at once: tracked all the same, so its entry sends the summary card (#318)
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({ view: STOPPED });
  });

  it('says an open trade plays out, and keeps following it', async () => {
    const open = sessionView({
      ...STOPPED,
      lastIntent: intentView({ status: TradeIntentStatus.Accepted }),
    });
    const { press, calls, sessionTracker } = setup({ stopSession: () => Promise.resolve(open) });
    await press(STOP);
    expect(payloadOf(calls, 'editMessageText')?.text).toContain(
      '⏳ Открытая сделка доиграет до конца.',
    );
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
  });

  it('shows how a session that had already ended ended', async () => {
    const completed = sessionView({
      ...STOPPED,
      stopReason: TradingSessionStopReason.Completed,
      trades: {
        planned: 5,
        settled: 5,
        rejected: 0,
        won: 3,
        lost: 2,
        tied: 0,
        profit: decimalStringSchema.parse('0.7'),
      },
    });
    const { press, calls, readSession } = setup({
      stopSession: () => Promise.reject(httpError(409, TradingSessionErrorCode.SessionNotActive)),
      readSession: () => Promise.resolve(completed),
    });
    await press(STOP);
    expect(readSession).toHaveBeenCalledWith(SESSION_ID, String(USER.id));
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(statusOf(completed));
  });

  it('says the status is unavailable on a 404 and warns on any other failure, without a retry', async () => {
    const missing = setup({ stopSession: () => Promise.reject(httpError(404, 'not_found')) });
    await missing.press(STOP);
    expect(payloadOf(missing.calls, 'sendMessage')?.text).toBe(
      TEXTS.sessionStatusUnavailable.value,
    );

    const broken = setup({ stopSession: () => Promise.reject(httpError(500)) });
    await broken.press(STOP);
    expect(broken.stopSession).toHaveBeenCalledTimes(1);
    expect(payloadOf(broken.calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(payloadOf(broken.calls, 'sendMessage'))).toEqual(SESSION_REFRESH_ROWS);
    expect(warnings(broken.logger)).toEqual(['trading session not stopped']);
  });

  it('ignores a press in a group', async () => {
    const { press, calls, stopSession } = setup();
    await press(STOP, 'group');
    expect(calls).toEqual([]);
    expect(stopSession).not.toHaveBeenCalled();
  });
});

describe('/stop (#122)', () => {
  const open = sessionView({
    ...STOPPED,
    lastIntent: intentView({ status: TradeIntentStatus.Accepted }),
  });
  const onlyMessage = (calls: readonly ApiCall[]) => {
    expect(methods(calls)).toEqual(['sendMessage']);
    return payloadOf(calls, 'sendMessage');
  };

  it('B1 one stopped session without a trade: its status and keyboard, tracked for the card', async () => {
    const { send, calls, sessionTracker } = setup();
    await send('/stop');
    const sent = onlyMessage(calls);
    expect(sent?.text).toBe(statusOf(STOPPED));
    expect(sent?.parse_mode).toBe('HTML');
    expect(rowsOf(sent)).toEqual(STOPPED_ROWS);
    // done at once: tracked all the same, so its entry sends the summary card (#318), as «⏹»
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({ view: STOPPED });
  });

  // the acceptance criterion: an open trade is not closed, it plays out and is followed
  it('B2 an open trade plays out: the status says so and tracking moves to the new message', async () => {
    const { send, calls, sessionTracker, stopSessions, stopSession, readSession } = setup({
      stopSessions: () => Promise.resolve([open]),
    });
    await send('/stop');
    const sent = onlyMessage(calls);
    expect(sent?.text).toBe(statusOf(open));
    expect(sent?.text).toContain(TEXTS.sessionOpenTradePlaysOut.value);
    expect(stopSessions.mock.calls).toEqual([[String(USER.id)]]);
    expect(stopSession).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();

    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    const entry = sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
    expect(entry).toMatchObject({
      sessionId: open.id,
      telegramUserId: String(USER.id),
      label: pairLabel(PAIR_EURUSD),
      view: open,
    });
    await entry.edit(telegramHtml`edited`, open);
    expect(payloadOf(calls, 'editMessageText')).toMatchObject({
      chat_id: USER.id,
      message_id: TEXT_CARD_MESSAGE_ID,
    });
  });

  it('B3 no active session: the text and the menu, nothing tracked', async () => {
    const { send, calls, sessionTracker } = setup({ stopSessions: () => Promise.resolve([]) });
    await send('/stop');
    const sent = onlyMessage(calls);
    expect(sent?.text).toBe(TEXTS.sessionNoneActive.value);
    expect(rowsOf(sent)).toEqual([MENU]);
    expect(sessionTracker.track).not.toHaveBeenCalled();
  });

  it('B4 two sessions: the count and the menu, nothing tracked', async () => {
    const { send, calls, sessionTracker } = setup({
      stopSessions: () => Promise.resolve([open, STOPPED]),
    });
    await send('/stop');
    const sent = onlyMessage(calls);
    expect(sent?.text).toBe(TEXTS.sessionsStopped({ count: '2' }).value);
    expect(sent?.text).toContain('2');
    expect(rowsOf(sent)).toEqual([MENU]);
    expect(sessionTracker.track).not.toHaveBeenCalled();
  });

  it('B5 a failed stop: unavailable with the menu only, a warning, no repeat', async () => {
    for (const error of [
      new BackendError(BackendErrorCode.Unreachable),
      httpError(500),
      new BackendError(BackendErrorCode.ContractViolation),
    ]) {
      const { send, calls, logger, stopSessions, sessionTracker } = setup({
        stopSessions: () => Promise.reject(error),
      });
      await send('/stop');
      const sent = onlyMessage(calls);
      expect(sent?.text).toBe(TEXTS.unavailable.value);
      expect(rowsOf(sent)).toEqual([MENU]);
      expect(warnings(logger)).toEqual(['trading sessions not stopped']);
      expect(stopSessions).toHaveBeenCalledTimes(1);
      expect(sessionTracker.track).not.toHaveBeenCalled();
    }
  });

  it('B6 a failed catalog names the asset by its id', async () => {
    const { send, calls } = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await send('/stop');
    expect(onlyMessage(calls)?.text).toBe(sessionStatusText(null, STOPPED).value);
  });

  it('B7 a group is ignored; /stop@bot and a trailing text are the command', async () => {
    const group = setup();
    await group.send('/stop', 'group');
    expect(group.calls).toEqual([]);
    expect(group.stopSessions).not.toHaveBeenCalled();

    for (const text of [`/stop@${BOT_INFO.username}`, '/stop что-то']) {
      const { send, calls, stopSessions } = setup();
      await send(text);
      expect(onlyMessage(calls)?.text).toBe(statusOf(STOPPED));
      expect(stopSessions).toHaveBeenCalledTimes(1);
    }
  });
});

describe('/stop resets the mode (#473)', () => {
  const RESET = { tradingMode: TradeMode.Demo, changed: true, stoppedSessions: 0 };
  const MODE_ROWS = [[button(LABELS.modeScreenButton, MODE_CALLBACK_DATA)], MENU];
  const sends = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload);
  const sentText = (calls: readonly ApiCall[], text: string) =>
    sends(calls).find((payload) => payload.text === text);

  it('ST1 the switch is asked only once the stop has answered', async () => {
    let answerStop: (sessions: TradingSessionView[]) => void = () => undefined;
    const { send, stopSessions, setTradingMode } = setup({
      stopSessions: () =>
        new Promise((resolve) => {
          answerStop = resolve;
        }),
      setTradingMode: () => Promise.resolve(RESET),
    });
    const handled = send('/stop');
    // a switch beside the stop would be asked in the same turn as it
    await until('the stop', () => stopSessions.mock.calls.length === 1);
    expect(setTradingMode).not.toHaveBeenCalled();
    answerStop([STOPPED]);
    await handled;
    expect(setTradingMode.mock.calls).toEqual([[String(USER.id), TradeMode.Demo]]);
  });

  it('ST2 a switch out of real: the mode line with the menu first, then the stopped status', async () => {
    const { send, calls, sessionTracker } = setup({
      setTradingMode: () => Promise.resolve({ ...RESET, stoppedSessions: 1 }),
    });
    await send('/stop');
    const [line, status] = sends(calls);
    expect(methods(calls)).toEqual(['sendMessage', 'sendMessage']);
    expect(line?.text).toBe(TEXTS.modeStopReset.value);
    expect(line?.text).toBe('🎮 Режим: DEMO — следующие сделки пойдут на демо.');
    expect(rowsOf(line)).toEqual([MENU]);
    // the switch's own count is not read: the stop before it answered for the session
    expect(status?.text).toBe(statusOf(STOPPED));
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
  });

  it('ST3 a user already in demo gets the message of #122 only', async () => {
    const { send, calls, logger, setTradingMode } = setup({
      setTradingMode: () =>
        Promise.resolve({ tradingMode: TradeMode.Demo, changed: false, stoppedSessions: 0 }),
    });
    await send('/stop');
    expect(sends(calls).map((payload) => payload.text)).toEqual([statusOf(STOPPED)]);
    expect(setTradingMode).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ST4 no users row: nothing to reset, nothing said, no warning', async () => {
    const { send, calls, logger } = setup({
      setTradingMode: () => Promise.reject(httpError(404, TradingModeErrorCode.UserNotFound)),
    });
    await send('/stop');
    expect(sends(calls).map((payload) => payload.text)).toEqual([statusOf(STOPPED)]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ST5 a 4xx refusal: «не переключён» with the menu and a warning, the status after it', async () => {
    const { send, calls, logger, sessionTracker } = setup({
      setTradingMode: () => Promise.reject(httpError(400)),
    });
    await send('/stop');
    const line = sentText(calls, TEXTS.modeNotReset.value);
    expect(line?.text).toBe('⚠️ Режим не переключён — открой /menu.');
    expect(rowsOf(line)).toEqual([MENU]);
    expect(sentText(calls, TEXTS.modeOutcomeUnknown.value)).toBeUndefined();
    expect(warnings(logger)).toEqual(['trading mode not reset']);
    expect(sentText(calls, statusOf(STOPPED))).toBeDefined();
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
  });

  it('ST6 a 5xx, no answer, a body off the contract or any throw: the outcome is unknown', async () => {
    for (const error of [
      httpError(500),
      httpError(503),
      new BackendError(BackendErrorCode.Unreachable, { status: 200 }),
      new BackendError(BackendErrorCode.ContractViolation),
      new Error('not the client'),
    ]) {
      const { send, calls, logger } = setup({ setTradingMode: () => Promise.reject(error) });
      await send('/stop');
      const line = sentText(calls, TEXTS.modeOutcomeUnknown.value);
      expect(rowsOf(line)).toEqual(MODE_ROWS);
      expect(sentText(calls, TEXTS.modeNotReset.value)).toBeUndefined();
      expect(warnings(logger)).toEqual(['trading mode outcome unknown']);
      expect(sentText(calls, statusOf(STOPPED))).toBeDefined();
    }
  });

  it('ST7 a failed stop: the switch is asked all the same, its line and unavailable', async () => {
    const { send, calls, logger, setTradingMode } = setup({
      stopSessions: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      setTradingMode: () => Promise.resolve(RESET),
    });
    await send('/stop');
    expect(setTradingMode).toHaveBeenCalledTimes(1);
    // the order is ST2's
    expect(
      sends(calls)
        .map((payload) => payload.text)
        .sort(),
    ).toEqual([TEXTS.modeStopReset.value, TEXTS.unavailable.value].sort());
    expect(warnings(logger)).toEqual(['trading sessions not stopped']);
  });

  it('ST8 Telegram refuses the mode line: a warning with its method and code, the status still sent', async () => {
    const { send, calls, logger, sessionTracker, answers } = setup({
      setTradingMode: () => Promise.resolve(RESET),
    });
    const sendAnswer = messageAnswer(TEXT_CARD_MESSAGE_ID);
    answers.set('sendMessage', (payload, signal) => {
      if (payload.text === TEXTS.modeStopReset.value) {
        throw new GrammyError(
          'refused',
          { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
          'sendMessage',
          payload,
        );
      }
      return sendAnswer(payload, signal);
    });
    await send('/stop');
    expect(
      sends(calls)
        .map((payload) => payload.text)
        .sort(),
    ).toEqual([TEXTS.modeStopReset.value, statusOf(STOPPED)].sort());
    expect(warnings(logger)).toEqual(['trading mode line not sent']);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'sendMessage',
      telegramErrorCode: 403,
    });
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
  });

  it('ST9 no keyboard of /stop carries a switch: the screen is a read, the switches stay on it', async () => {
    const outcomes: BackendClient['setTradingMode'][] = [
      () => Promise.resolve(RESET),
      () => Promise.reject(httpError(400)),
      () => Promise.reject(httpError(500)),
    ];
    for (const setTradingMode of outcomes) {
      const { send, calls } = setup({ setTradingMode });
      await send('/stop');
      const data = sends(calls).flatMap((payload) =>
        rowsOf(payload).flatMap((row) => row.map((key) => key.callback_data)),
      );
      expect(data).not.toContain(MODE_REAL_CALLBACK_DATA);
      expect(data).not.toContain(MODE_DEMO_CALLBACK_DATA);
    }
  });
});

describe('«🔁 Ещё сессия»', () => {
  it('is on a stopped session only, with its pair and duration', () => {
    const rows = (view: TradingSessionView) => sessionKeyboard(view, CASHIER_URL).inline_keyboard;
    expect(rows(STOPPED)).toEqual(STOPPED_ROWS);
    expect(
      rows(sessionView({ ...STOPPED, settings: { ...STOPPED.settings!, durationSec: 5 } })),
    ).toEqual([
      [button(LABELS.sessionRefreshButton, REFRESH)],
      [button(LABELS.sessionAgainButton, `demo:l:${String(PAIR_EURUSD.id)}:5:n`)],
      newAnalysis(5),
      toSignals(5),
      DEPOSIT,
      INVITE,
      MENU,
    ]);
    // #509: a session the no-signal limit stopped offers another pair: no «🔁 Ещё сессия», no
    // analysis of that pair, «🔀 Выбрать другую пару» on the signals of its duration
    const noSignal = sessionView({
      ...STOPPED,
      stopReason: TradingSessionStopReason.NoSignalTimeout,
    });
    expect(rows(noSignal)).toEqual([
      [button(LABELS.sessionRefreshButton, REFRESH)],
      [button(LABELS.otherPairButton, `${DEMO_SIGNALS_CALLBACK_DATA}:15`)],
      DEPOSIT,
      INVITE,
      MENU,
    ]);
    // S5: the live session's keyboard has no invite
    expect(rows(SESSION_VIEW)).toEqual(LIVE_ROWS);
    expect(rows(sessionView({ status: TradingSessionStatus.Paused }))).toEqual(LIVE_ROWS);
  });

  // #450: a martingale limit's stop prints its own line and keeps the stopped session's keyboard
  it.each([
    [TradingSessionStopReason.MaxStepsExceeded, 'лимита повышений ставки'],
    [TradingSessionStopReason.MaxStakeExceeded, 'лимит размера ставки'],
    [TradingSessionStopReason.MaxSessionLossExceeded, 'лимит убытка сессии'],
    [TradingSessionStopReason.SessionDurationExceeded, 'истёк час на сессию'],
  ])('shows the stop %s with its text', (stopReason, words) => {
    const view = sessionView({ ...STOPPED, stopReason });
    expect(statusOf(view)).toContain(words);
    expect(statusOf(view)).not.toContain(TEXTS.sessionStopStakeStop.value);
    expect(sessionKeyboard(view, CASHIER_URL).inline_keyboard).toEqual(
      sessionKeyboard(STOPPED, CASHIER_URL).inline_keyboard,
    );
  });

  // #27: «💳 Пополнить» at the end of a real session too, and nowhere without a cashier
  it('ends a stopped session of either mode with the deposit, the invite and the menu', () => {
    const realStopped = sessionView({ ...STOPPED, mode: TradeMode.Real });
    for (const view of [STOPPED, realStopped]) {
      expect(sessionKeyboard(view, CASHIER_URL).inline_keyboard.slice(-3), view.mode).toEqual([
        DEPOSIT,
        INVITE,
        MENU,
      ]);
      expect(sessionCardKeyboard(view, CASHIER_URL).inline_keyboard.slice(-3), view.mode).toEqual([
        DEPOSIT,
        INVITE,
        MENU,
      ]);
    }
    const withoutDeposit = STOPPED_ROWS.filter((row) => row !== DEPOSIT);
    expect(sessionKeyboard(STOPPED, undefined).inline_keyboard).toEqual(withoutDeposit);
    expect(sessionKeyboard({ ...STOPPED, settings: null }, undefined).inline_keyboard).toEqual([
      [button(LABELS.sessionRefreshButton, REFRESH)],
      INVITE,
      MENU,
    ]);
    expect(sessionKeyboard(SESSION_VIEW, CASHIER_URL).inline_keyboard).toEqual(LIVE_ROWS);
  });

  it('is not drawn without settings or on a duration the demo no longer offers', () => {
    const refresh = [button(LABELS.sessionRefreshButton, REFRESH)];
    // without settings only the deposit, the invite and the menu follow: no pair to analyse
    expect(sessionKeyboard({ ...STOPPED, settings: null }, CASHIER_URL).inline_keyboard).toEqual([
      refresh,
      DEPOSIT,
      INVITE,
      MENU,
    ]);
    // an old duration: no «🔁 Ещё сессия» and no «📊 Новый анализ», the signals and the menu stay
    expect(
      sessionKeyboard(
        { ...STOPPED, settings: { ...STOPPED.settings!, durationSec: 60 } },
        CASHIER_URL,
      ).inline_keyboard,
    ).toEqual([refresh, TO_DURATIONS, DEPOSIT, INVITE, MENU]);
  });

  // #476: the door «again opens the amount screen»; the session starts from an amount
  it('opens the amount screen of the same pair and duration as a new message, starting nothing', async () => {
    const { press, startSession, calls } = setup();
    await press(AGAIN.callback_data ?? '');
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toContain('Выбери сумму сделки 👇');
    // the screen's own presses edit it: it carries the analysis's way back
    expect(rowsOf(sent).flat()).toContainEqual(
      button('$5.00', cycleStakeCallbackData(PAIR_EURUSD.id, 15, '5', 'a')),
    );
    expect(startSession).not.toHaveBeenCalled();
  });

  // #327: a stopped real session's again button is marked REAL and starts a real one
  it('starts a real session again from a stopped real one', async () => {
    const realStopped = sessionView({ ...STOPPED, mode: TradeMode.Real });
    const realAgain = button(
      '🔁 Ещё сессия · REAL',
      sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 15),
    );
    expect(sessionKeyboard(realStopped, CASHIER_URL).inline_keyboard[1]).toEqual([realAgain]);
    expect(sessionCardKeyboard(realStopped, CASHIER_URL).inline_keyboard[0]).toEqual([realAgain]);
    const { press, startSession } = setup();
    await press(realAgain.callback_data ?? '');
    expect(startSession.mock.calls[0]?.[0]).toMatchObject({ mode: TradeMode.Real });
  });
});

describe('the summary card (#318)', () => {
  const DONE = sessionView({
    ...STOPPED,
    trades: { ...STOPPED.trades, settled: 2, won: 1, lost: 1, profit: SUMMARY.result },
    lastIntent: intentView({ status: TradeIntentStatus.Settled }),
  });
  const CARD_ROWS = [[AGAIN], newAnalysis(15), toSignals(15), DEPOSIT, INVITE, MENU];
  // the tracker's entry of a refresh on a done session: its card is what the tracker calls
  const entryOf = async (setupResult: ReturnType<typeof setup>) => {
    await setupResult.press(REFRESH);
    return setupResult.sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
  };

  it('K1 is the stopped status keyboard without «🔄 Обновить»; the invite and the menu alone without settings', () => {
    const rows = (view: TradingSessionView) =>
      sessionCardKeyboard(view, CASHIER_URL).inline_keyboard;
    expect(rows(DONE)).toEqual(CARD_ROWS);
    // S4: no empty first row
    expect(rows(sessionView({ ...DONE, settings: null }))).toEqual([DEPOSIT, INVITE, MENU]);
    expect(
      rows(sessionView({ ...DONE, settings: { ...DONE.settings!, durationSec: 60 } })),
    ).toEqual([TO_DURATIONS, DEPOSIT, INVITE, MENU]);
    // #509: under a no_signal_timeout card, another pair instead of the same one again
    expect(
      rows(sessionView({ ...DONE, stopReason: TradingSessionStopReason.NoSignalTimeout })),
    ).toEqual([
      [button(LABELS.otherPairButton, `${DEMO_SIGNALS_CALLBACK_DATA}:15`)],
      DEPOSIT,
      INVITE,
      MENU,
    ]);
  });

  it('K2 claims, then sends one PNG to the status chat with its caption and keyboard', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    const entry = await entryOf(scene);
    await entry.card(DONE);
    expect(scene.claimSessionSummary.mock.calls).toEqual([[SESSION_ID, String(USER.id)]]);
    const photo = payloadOf(scene.calls, 'sendPhoto');
    expect(photo?.chat_id).toBe(USER.id);
    expect(photo?.photo).toBeInstanceOf(InputFile);
    expect(photo?.parse_mode).toBe('HTML');
    expect(photo?.caption).toBe(
      TEXTS.sessionCardCaption({
        symbol: pairLabel(PAIR_EURUSD),
        profit: SUMMARY.result,
        botUsername: BOT_INFO.username,
      }).value,
    );
    expect(photo?.caption).toContain(`@${BOT_INFO.username}`);
    expect(photo?.caption).toContain(formatSignedUsd(SUMMARY.result));
    expect(rowsOf(photo)).toEqual(CARD_ROWS);
    expect(
      rowsOf(photo)
        .flat()
        .some((key) => key.callback_data === REFRESH),
    ).toBe(false);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('K3 a refused claim sends nothing and logs nothing', async () => {
    const scene = setup({
      readSession: () => Promise.resolve(DONE),
      claimSessionSummary: () => Promise.resolve(null),
    });
    await (await entryOf(scene)).card(DONE);
    expect(methods(scene.calls)).not.toContain('sendPhoto');
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('K4 a failed claim is logged with its backend fields, and nothing is sent', async () => {
    const scene = setup({
      readSession: () => Promise.resolve(DONE),
      claimSessionSummary: () => Promise.reject(httpError(500)),
    });
    await (await entryOf(scene)).card(DONE);
    expect(methods(scene.calls)).not.toContain('sendPhoto');
    expect(warnings(scene.logger)).toEqual(['trading session card not sent']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({
      backendStatus: 500,
      sessionId: SESSION_ID,
    });
  });

  it('K5 a refused photo is logged with its Telegram fields, once, with no retry', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    scene.apiErrors.set('sendPhoto', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });
    await (await entryOf(scene)).card(DONE);
    expect(methods(scene.calls).filter((method) => method === 'sendPhoto')).toHaveLength(1);
    expect(warnings(scene.logger)).toEqual(['trading session card not sent']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'sendPhoto',
      telegramErrorCode: 400,
      sessionId: SESSION_ID,
    });
  });

  // the card is a photo: an edit of it is refused (demo.test.ts → a press under the session card)
  it('K7 «🔁 Ещё сессия» under the card opens the amount screen by a reply, never an edit', async () => {
    const scene = setup();
    scene.apiErrors.set('editMessageText', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: there is no text in the message to edit',
    });
    const again = sessionCardKeyboard(DONE, CASHIER_URL)
      .inline_keyboard.flat()
      .find((key) => key.text === LABELS.sessionAgainButton);
    await scene.press((again as Button | undefined)?.callback_data ?? '');
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(scene.calls, 'sendMessage')?.text).toContain('Выбери сумму сделки 👇');
    expect(scene.startSession).not.toHaveBeenCalled();
    expect(scene.logger.error).not.toHaveBeenCalled();
  });

  // #321: «📤 Поделиться» on top, by one edit after the send, since the file id exists only then
  const SHARE_ROW = [
    {
      text: LABELS.sessionShareButton,
      switch_inline_query_chosen_chat: {
        query: shareQuery(SESSION_ID, CARD_FILE_ID),
        allow_user_chats: true,
        allow_group_chats: true,
        allow_channel_chats: true,
      },
    },
  ];

  it("K8 puts «📤 Поделиться» over the card's own rows, with the largest size's file id", async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    await (await entryOf(scene)).card(DONE);
    const sends = methods(scene.calls).filter((method) =>
      ['sendPhoto', 'editMessageReplyMarkup'].includes(method),
    );
    expect(sends).toEqual(['sendPhoto', 'editMessageReplyMarkup']);
    const edit = payloadOf(scene.calls, 'editMessageReplyMarkup');
    expect(edit?.chat_id).toBe(USER.id);
    expect(edit?.message_id).toBe(CARD_MESSAGE_ID);
    const rows = rowsOf(edit) as unknown[][];
    expect(rows[0]).toEqual(SHARE_ROW);
    expect(rows.slice(1)).toEqual(CARD_ROWS);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('K9 a refused edit is a warning only: the card keeps its keyboard, no retry, no «not sent»', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    scene.apiErrors.set('editMessageReplyMarkup', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    await (await entryOf(scene)).card(DONE);
    expect(
      methods(scene.calls).filter((method) => method === 'editMessageReplyMarkup'),
    ).toHaveLength(1);
    expect(rowsOf(payloadOf(scene.calls, 'sendPhoto'))).toEqual(CARD_ROWS);
    expect(warnings(scene.logger)).toEqual(['trading session share button not attached']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'editMessageReplyMarkup',
      telegramErrorCode: 400,
      sessionId: SESSION_ID,
    });
  });

  it.each([
    ['the result has no photo sizes', [], 'no_file_id'],
    [
      'the query would pass the inline query limit',
      ['x'.repeat(INLINE_QUERY_LIMIT - shareQuery(SESSION_ID, '').length + 1)],
      'query_too_long',
    ],
  ] as const)('K10 no edit when %s, and a warning', async (_label, fileIds, reason) => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    scene.answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, fileIds));
    await (await entryOf(scene)).card(DONE);
    expect(methods(scene.calls)).toContain('sendPhoto');
    expect(methods(scene.calls)).not.toContain('editMessageReplyMarkup');
    expect(warnings(scene.logger)).toEqual(['trading session share button not attached']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toEqual({ sessionId: SESSION_ID, reason });
  });

  it('K11 a query exactly at the limit still gets the button', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    const longest = 'x'.repeat(INLINE_QUERY_LIMIT - shareQuery(SESSION_ID, '').length);
    scene.answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, [longest]));
    await (await entryOf(scene)).card(DONE);
    expect(methods(scene.calls)).toContain('editMessageReplyMarkup');
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it("K6 without settings, the asset is the last trade's and the keyboard the invite and the menu", async () => {
    const bare = sessionView({ ...DONE, settings: null });
    const scene = setup({ readSession: () => Promise.resolve(bare) });
    await (await entryOf(scene)).card(bare);
    const photo = payloadOf(scene.calls, 'sendPhoto');
    expect(photo?.caption).toBe(
      TEXTS.sessionCardCaption({
        symbol: sessionAssetLabel(null, bare.lastIntent!.assetId),
        profit: SUMMARY.result,
        botUsername: BOT_INFO.username,
      }).value,
    );
    expect(rowsOf(photo)).toEqual([DEPOSIT, INVITE, MENU]);
    expect(rowsOf(payloadOf(scene.calls, 'editMessageReplyMarkup'))).toEqual([
      SHARE_ROW,
      DEPOSIT,
      INVITE,
      MENU,
    ]);
  });
});

// #418: «🚀 Запустить цикл» carries the launch token; once the session's status is sent the start
// deletes the launch screen, and only then
describe('the launch screen after the start (#418)', () => {
  const LAUNCH = sessionStartCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5, true);
  const REAL_LAUNCH = sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5, true);
  const refusal = (error_code: number, description: string): ApiError => ({
    ok: false,
    error_code,
    description,
  });
  const DELETE_FORBIDDEN = refusal(400, "Bad Request: message can't be deleted");
  const infos = (logger: ReturnType<typeof fakeLogger>) =>
    logger.info.mock.calls.map((call) => call[1] as string);
  const deleted = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'deleteMessage').length;

  async function launch(
    data = LAUNCH,
    options: Parameters<typeof setup>[0] = {},
    errors: readonly (readonly [string, ApiError | HttpError])[] = [],
  ) {
    const scene = setup(options);
    for (const [method, error] of errors) scene.apiErrors.set(method, error);
    const update = callbackUpdate(data);
    await scene.pressUpdate(update);
    const pressed = { chat_id: USER.id, message_id: update.callback_query?.message?.message_id };
    return { ...scene, pressed };
  }

  it('deletes the pressed launch screen after the status is sent and tracked', async () => {
    const { calls, pressed, sessionTracker, logger } = await launch();
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'deleteMessage']);
    expect(payloadOf(calls, 'deleteMessage')).toEqual(pressed);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf(SESSION_VIEW));
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(LIVE_ROWS);
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({ view: SESSION_VIEW });
    expect(warnings(logger)).toEqual([]);
  });

  it('deletes the real launch screen after the real status (#327)', async () => {
    const realView = sessionView({ mode: TradeMode.Real });
    const { calls, pressed, startSession } = await launch(REAL_LAUNCH, {
      startSession: () => Promise.resolve({ started: realView }),
    });
    expect(startSession.mock.calls[0]?.[0]).toMatchObject({ mode: TradeMode.Real });
    expect(payloadOf(calls, 'sendMessage')?.text).toMatch(/^💼 <b>Реальная сессия<\/b>/);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'deleteMessage']);
    expect(payloadOf(calls, 'deleteMessage')).toEqual(pressed);
  });

  it('deletes it after the status of a session already running', async () => {
    const { calls, pressed } = await launch(LAUNCH, {
      startSession: () => Promise.resolve({ active: SESSION_VIEW }),
    });
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'deleteMessage']);
    expect(payloadOf(calls, 'deleteMessage')).toEqual(pressed);
  });

  it('keeps it when the active session ended before the backend read it', async () => {
    const { calls } = await launch(LAUNCH, {
      startSession: () => Promise.resolve({ active: null }),
    });
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.sessionJustEnded.value);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(BACK_ROWS);
  });

  it.each([
    ['payout_too_low', LAUNCH, TradingSessionErrorCode.PayoutTooLow],
    ['mode_not_allowed', REAL_LAUNCH, TradingSessionErrorCode.ModeNotAllowed],
    ['demo_only', REAL_LAUNCH, TradingSessionErrorCode.DemoOnly],
  ])('keeps it on the refusal %s', async (_case, data, code) => {
    const { calls } = await launch(data, {
      startSession: () => Promise.reject(httpError(409, code)),
    });
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(deleted(calls)).toBe(0);
  });

  it('keeps it when the outcome stays unknown after the retry', async () => {
    const { calls } = await launch(LAUNCH, {
      startSession: () => Promise.reject(httpError(500)),
    });
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.sessionOutcomeUnknown.value);
    expect(deleted(calls)).toBe(0);
  });

  it.each([
    ["the server's spelling", DELETE_FORBIDDEN],
    ["tdlib's spelling", refusal(400, "Bad Request: Message can't be deleted for everyone")],
  ])('strips the keyboard when the delete is forbidden, %s', async (_case, error) => {
    const { calls, pressed, logger } = await launch(LAUNCH, {}, [['deleteMessage', error]]);
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'deleteMessage',
      'editMessageReplyMarkup',
    ]);
    expect(payloadOf(calls, 'editMessageReplyMarkup')).toEqual(pressed);
    expect(warnings(logger)).toEqual([]);
  });

  it('does nothing more when the launch screen is already gone', async () => {
    const { calls, logger } = await launch(LAUNCH, {}, [
      ['deleteMessage', refusal(400, 'Bad Request: message to delete not found')],
    ]);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'deleteMessage']);
    expect(infos(logger)).toContain('the launch screen was already gone');
    expect(warnings(logger)).toEqual([]);
  });

  it.each([
    ['another refusal', refusal(429, 'Too Many Requests: retry after 1')],
    [
      'a transport failure',
      new HttpError("Network request for 'deleteMessage' failed!", new Error('socket hang up')),
    ],
  ])('warns and does nothing more on %s of the delete', async (_case, error) => {
    const { calls, logger } = await launch(LAUNCH, {}, [['deleteMessage', error]]);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'deleteMessage']);
    expect(warnings(logger)).toEqual(['the launch screen was not deleted']);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('retry after');
  });

  it.each([
    ['refused', refusal(400, "Bad Request: message can't be edited")],
    [
      'failed in transport',
      new HttpError("Network request for 'editMessageReplyMarkup' failed!", new Error('reset')),
    ],
  ])('warns when the strip after a forbidden delete is %s', async (_case, error) => {
    const { calls, logger } = await launch(LAUNCH, {}, [
      ['deleteMessage', DELETE_FORBIDDEN],
      ['editMessageReplyMarkup', error],
    ]);
    expect(methods(calls).at(-1)).toBe('editMessageReplyMarkup');
    expect(warnings(logger)).toEqual(['the launch screen keyboard was not removed']);
  });

  it('deletes nothing for the plain session button, demo or real', async () => {
    for (const data of [START, REAL_START]) {
      const { calls } = await launch(data, {
        startSession: () =>
          Promise.resolve({
            started: data === REAL_START ? sessionView({ mode: TradeMode.Real }) : SESSION_VIEW,
          }),
      });
      expect(methods(calls), data).toEqual(['answerCallbackQuery', 'sendMessage']);
    }
  });
});

describe('the resume of a tracked session after a restart (#567)', () => {
  const DONE = sessionView({
    ...STOPPED,
    trades: { ...STOPPED.trades, settled: 1, won: 1, profit: SUMMARY.result },
    lastIntent: intentView({ status: TradeIntentStatus.Settled }),
  });
  const RESUMED_MESSAGE_ID = 4321;
  const tracked = {
    id: SESSION_ID,
    telegramUserId: String(USER.id),
    messageId: RESUMED_MESSAGE_ID,
    assetId: PAIR_EURUSD.id,
    startedAt: '2026-10-07T10:00:00.000Z',
  };
  const resumed = (scene: ReturnType<typeof setup>, label: PairLabel | null) => {
    const resume = scene.sessionResumer.attach.mock.calls[0]?.[0];
    if (resume === undefined) throw new Error('createBot attached no resume');
    resume(scene.bot.api, 'resumed_bot', tracked, label);
    expect(scene.sessionTracker.track).toHaveBeenCalledTimes(1);
    return scene.sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
  };

  it("RS1 tracks the session on the list's message: no view, not recorded again, the deadline from its start", async () => {
    const scene = setup();
    const entry = resumed(scene, pairLabel(PAIR_EURUSD));
    expect(entry).toMatchObject({
      sessionId: SESSION_ID,
      telegramUserId: String(USER.id),
      messageId: RESUMED_MESSAGE_ID,
      label: pairLabel(PAIR_EURUSD),
      view: null,
      record: false,
      startedAt: Date.parse(tracked.startedAt),
    });
    await entry.edit(telegramHtml`edited`, STOPPED);
    const edit = payloadOf(scene.calls, 'editMessageText');
    expect(edit).toMatchObject({
      chat_id: USER.id,
      message_id: RESUMED_MESSAGE_ID,
      text: 'edited',
    });
    expect(rowsOf(edit)).toEqual(STOPPED_ROWS);
  });

  it("RS2 the card goes to the owner's chat with the resume's bot username", async () => {
    const scene = setup();
    await resumed(scene, pairLabel(PAIR_EURUSD)).card(DONE);
    const photo = payloadOf(scene.calls, 'sendPhoto');
    expect(photo?.chat_id).toBe(USER.id);
    expect(photo?.caption).toContain('@resumed_bot');
  });

  it('RS3 the label is what the resume was handed; null names the asset by its id', async () => {
    const scene = setup();
    const entry = resumed(scene, null);
    expect(entry.label).toBeNull();
    await entry.card(DONE);
    expect(payloadOf(scene.calls, 'sendPhoto')?.caption).toBe(
      TEXTS.sessionCardCaption({
        symbol: sessionAssetLabel(null, PAIR_EURUSD.id),
        profit: SUMMARY.result,
        botUsername: 'resumed_bot',
      }).value,
    );
  });
});
