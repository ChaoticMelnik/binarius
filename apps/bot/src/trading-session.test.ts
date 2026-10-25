import { GrammyError, HttpError, InputFile } from 'grammy';
import type { ApiError, Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { until } from '@binarius/shared/testing';
import {
  buildH1SessionSettings,
  pairLabel,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingModeErrorCode,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  decimalStringSchema,
  formatSignedUsd,
  telegramHtml,
  type PairLabel,
  type SessionSummary,
  type TradingSessionView,
  CONNECT_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  supportUrl,
  BUY_CALLBACK_DATA,
  DEMO_SIGNALS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  sessionStopCallbackData,
  BotLanguage,
  MODE_CALLBACK_DATA,
  SessionStakeStrategy,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import { runWithLanguage, type UserLanguages } from './language';
import {
  cycleStakeCallbackData,
  demoLaunchCallbackData,
  sessionStartCallbackData,
  stakeMenuCallbackData,
} from './demo';
import { sessionDrawing, type SessionTrackRequest } from './session-tracker';
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
  stubSignalWaiter,
  signalsResponse,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  userLanguagesWith,
  type ApiCall,
  inlineRows,
  inlineStyles,
  keyboardRows,
} from './testing';
import {
  sessionStatusText,
  sessionStopReplyText,
  sessionTexts,
  TEXTS,
  textOf,
  LABELS,
} from './texts';
import { sessionCardKeyboard, sessionOutcomeUnknown, START_REFUSALS } from './trading-session';
import { INVITE_CALLBACK_DATA } from './keyboards';
import { MODE_DEMO_CALLBACK_DATA, MODE_REAL_CALLBACK_DATA } from './trading-mode';
import { shareQuery } from './session-share';

const START = sessionStartCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5);
const REAL_START = sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5);
// the sizes of the card's sendPhoto result, smallest first (#321)
const SMALL_FILE_ID = 'AgACAgIAAxkBAAIBsmall';
const CARD_FILE_ID = 'AgACAgIAAxkBAAIBlarge';
// the old status message's buttons (before #536), and the stop under the waiting message
const REFRESH = `session:${SESSION_ID}`;
const STOP = sessionStopCallbackData(SESSION_ID);
const WAITING_STOP = sessionStopCallbackData(SESSION_ID, { waiting: true });
// the stop under the open trade's block (#722)
const CYCLE_STOP = sessionStopCallbackData(SESSION_ID, { cycle: true });

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
    evaluateSignal?: BackendClient['evaluateSignal'];
    // the signals list a cycle door reads (#664): the pair has a signal by default
    readSignals?: BackendClient['readSignals'];
    // no SHARE_STORAGE_CHAT_ID, so no «📤 Поделиться» (#538)
    shareOff?: true;
    // the summary's wait after a 429 (#537)
    sleep?: (ms: number) => Promise<void>;
    languages?: UserLanguages;
  } = {},
) {
  const evaluateSignal = vi.fn<BackendClient['evaluateSignal']>(
    options.evaluateSignal ?? (() => Promise.resolve(SIGNAL_DECIDED)),
  );
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
  const readSignals = vi.fn<BackendClient['readSignals']>(
    options.readSignals ??
      (() =>
        Promise.resolve(signalsResponse(Date.now(), { '5s': [[PAIR_EURUSD.id, TradeAction.Up]] }))),
  );
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
  const signalWaiter = stubSignalWaiter();
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
      readSignals,
    }),
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker,
    sessionResumer,
    signalWaiter,
    ...(options.cashierUrl === null ? {} : { cashierUrl: options.cashierUrl ?? CASHIER_URL }),
    ...(options.shareOff === true ? {} : { shareStorageChatId: -1001234567890 }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.languages === undefined ? {} : { languages: options.languages }),
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
    signalWaiter,
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
  inlineRows(payload) as Button[][];
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
// the reply to «⏹» under the waiting message and to /stop of one session (#536)
const replyOf = (view: TradingSessionView) => sessionStopReplyText(view).value;

// SESSION_VIEW's own pair at the demo's one duration (#685); a demo session's opens the amount
// screen as a new message (#476)
const AGAIN = button(LABELS.sessionAgainButton, demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n'));
// #350: the end of the path under a stopped session, after its refresh and «🔁 Ещё сессия»: the
// signals list (#685)
const TO_SIGNALS = [button(LABELS.toSignalsButton, DEMO_SIGNALS_CALLBACK_DATA)];
const MENU = [button(LABELS.menuButton, MENU_CALLBACK_DATA)];
const NEW_ANALYSIS = [
  button(LABELS.newAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5)),
];
// «👥 Позвать» beside the menu at every end of a session (#115)
const INVITE = [button(LABELS.inviteButton, INVITE_CALLBACK_DATA)];
// «💳 Пополнить» (#27): the cashier Mini App, a step forward on its own row above the invite
// (#475)
const DEPOSIT: Button[] = [{ text: LABELS.depositButton, web_app: { url: CASHIER_URL } }];
const INVITE_MENU = [...INVITE, ...MENU];
// a stopped session's end of the path: under the stop reply, the card and an old status (#536)
const STOPPED_ROWS = [[AGAIN], [...NEW_ANALYSIS, ...TO_SIGNALS], DEPOSIT, INVITE_MENU];
const CONNECT_ROWS = [[button(LABELS.connectButton, CONNECT_CALLBACK_DATA)]];
// #350: a refusal of the start leads back to the analysis and to the menu; a blocked user to support
const MENU_ROW = [button(LABELS.menuButton, MENU_CALLBACK_DATA)];
const BACK = button(LABELS.stakeBackAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5));
const BACK_ROWS = [[BACK, ...MENU_ROW]];
const SUPPORT_ROWS = [[{ text: LABELS.supportButton, url: supportUrl() }]];
// for want of tokens, the deposit (#27) on its own row, the purchase beside the way back (#117)
const BUY_ONLY_ROWS = [[button(LABELS.buyButton, BUY_CALLBACK_DATA), BACK, ...MENU_ROW]];
const BUY_ROWS = [DEPOSIT, ...BUY_ONLY_ROWS];
// a refusal of the pair itself (#745): another pair, or the menu
const OTHER_PAIR_ROWS = [[button(LABELS.otherPairButton, DEMO_SIGNALS_CALLBACK_DATA)], MENU_ROW];
const STAKE_MENU_ROWS = [
  [button(LABELS.stakeMenuButton, stakeMenuCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5))],
];
const EDIT_GONE: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message to edit not found',
};

describe('the session button', () => {
  it('S1 starts a session of five, sends its message without a keyboard (#536), and tracks it', async () => {
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
          cycles: 5,
        },
      ],
    ]);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(statusOf(SESSION_VIEW));
    expect(sent?.text).toContain('🔹 Торговая пара: EUR/USD');
    expect(sent?.parse_mode).toBe('HTML');
    // the «⏹» is under the backend's waiting message
    expect(sent).not.toHaveProperty('reply_markup');
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SESSION_ID,
      telegramUserId: String(USER.id),
      label: 'EUR/USD',
      view: SESSION_VIEW,
    });
  });

  it("hands the tracker an edit of the session message's own id, without a keyboard (#536)", async () => {
    const { press, calls, sessionTracker } = setup();
    await press(START);
    const entry = sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
    await entry.edit({ text: telegramHtml`edited`, picture: STOPPED.signalAction });

    const edit = payloadOf(calls, 'editMessageText');
    expect(edit).toMatchObject({
      chat_id: USER.id,
      message_id: TEXT_CARD_MESSAGE_ID,
      text: 'edited',
      parse_mode: 'HTML',
    });
    // an edit without reply_markup strips an old status message's buttons too
    expect(edit).not.toHaveProperty('reply_markup');

    // #350: a session gone from the backend gets the menu only
    await entry.edit({ text: telegramHtml`gone`, picture: null }, 'not_found');
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
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({
      view: running,
      messageId: TEXT_CARD_MESSAGE_ID,
      record: true,
    });
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
    const status = code === TradingSessionErrorCode.CatalogUnavailable ? 503 : 409;
    const { press, calls, startSession, sessionTracker, logger } = setup({
      startSession: () => Promise.reject(httpError(status, code)),
    });
    await press(START);
    const refusal: {
      text: Parameters<typeof textOf>[0];
      connect?: true;
      stakeMenu?: true;
      buy?: true;
      log?: true;
      otherPair?: true;
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

  // #828: the start never answers no_signal, signal_unavailable or account_not_h1 any more
  it('says no «нет сигнала» on any start refusal, and none waits for a signal', () => {
    for (const refusal of Object.values(START_REFUSALS)) {
      expect(textOf(refusal.text).value).not.toMatch(/нет сигнала|сигнала нет/i);
      expect(refusal).not.toHaveProperty('wait');
    }
    for (const code of ['no_signal', 'signal_unavailable', 'account_not_h1']) {
      expect(Object.hasOwn(START_REFUSALS, code), code).toBe(false);
    }
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
    ['an asset id past int4', 'demo:sess:2147483648:5'],
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

describe("an old status message's «🔄 Обновить» (#536)", () => {
  it('LG2 strips its keyboard and reads or sends nothing', async () => {
    const { press, calls, readSession, readPairs, sessionTracker } = setup();
    await press(REFRESH);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(readSession).not.toHaveBeenCalled();
    expect(readPairs).not.toHaveBeenCalled();
    expect(sessionTracker.track).not.toHaveBeenCalled();
  });
});

describe('«⏹ Остановить сессию» under the waiting message (#536, #587)', () => {
  const open = sessionView({
    ...STOPPED,
    lastIntent: intentView({ status: TradeIntentStatus.Accepted }),
  });
  const NOT_MODIFIED: ApiError = {
    ok: false,
    error_code: 400,
    description:
      'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
  };
  // the one «⏹» drawn again after a stop whose outcome is unknown
  const STOP_AGAIN_ROW = [button(LABELS.sessionStopButton, WAITING_STOP)];
  const pressedIdOf = (update: Update) => update.callback_query?.message?.message_id;

  it("SW1' stops with the pressed message's id, then edits the pressed message in place: the end line under the end of the path", async () => {
    const { pressUpdate, calls, stopSession, readPairs, readSession, sessionTracker, logger } =
      setup();
    const update = callbackUpdate(WAITING_STOP);
    await pressUpdate(update);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edit = payloadOf(calls, 'editMessageText');
    expect(edit).toMatchObject({ chat_id: USER.id, message_id: pressedIdOf(update) });
    expect(edit?.text).toBe(replyOf(STOPPED));
    expect(edit?.text).toBe('⏹ Сессия остановлена по твоей команде.');
    expect(edit?.parse_mode).toBe('HTML');
    expect(rowsOf(edit)).toEqual(STOPPED_ROWS);
    // a press starts no tracking (the session message is tracked from its start, or recovered by
    // #567 once its id is recorded); no catalog: no pair in the reply
    expect(sessionTracker.track).not.toHaveBeenCalled();
    expect(readPairs).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(warnings(logger)).toEqual([]);
  });

  it('SW7 the stop body names the pressed waiting message', async () => {
    const { pressUpdate, stopSession } = setup();
    const update = callbackUpdate(WAITING_STOP);
    await pressUpdate(update);
    expect(stopSession.mock.calls).toEqual([[SESSION_ID, String(USER.id), pressedIdOf(update)]]);
  });

  it("SW2' a session that had already ended: read, and its end line in place", async () => {
    const completed = sessionView({
      ...STOPPED,
      stopReason: TradingSessionStopReason.Completed,
      trades: { ...STOPPED.trades, settled: 5, won: 3, lost: 2 },
      cycles: { planned: 5, closed: 5 },
    });
    const { press, calls, readSession } = setup({
      stopSession: () => Promise.reject(httpError(409, TradingSessionErrorCode.SessionNotActive)),
      readSession: () => Promise.resolve(completed),
    });
    await press(WAITING_STOP);
    expect(readSession).toHaveBeenCalledWith(SESSION_ID, String(USER.id));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      '🏁 Сессия завершена: 5 циклов, 5 сделок — 3 в плюс, 2 в минус',
    );
  });

  it("SW3' a failed stop or read is drawn in place: an unknown stop keeps the «⏹», a missing session or a failed read the menu", async () => {
    const broken = setup({ stopSession: () => Promise.reject(httpError(500)) });
    await broken.press(WAITING_STOP);
    expect(methods(broken.calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(broken.calls, 'editMessageText')?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(payloadOf(broken.calls, 'editMessageText'))).toEqual([STOP_AGAIN_ROW]);
    expect(broken.stopSession).toHaveBeenCalledTimes(1);
    expect(warnings(broken.logger)).toEqual(['trading session not stopped']);

    const missing = setup({ stopSession: () => Promise.reject(httpError(404, 'not_found')) });
    await missing.press(WAITING_STOP);
    expect(methods(missing.calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(missing.calls, 'editMessageText')?.text).toBe(
      TEXTS.sessionStatusUnavailable.value,
    );
    expect(rowsOf(payloadOf(missing.calls, 'editMessageText'))).toEqual([MENU_ROW]);
    expect(warnings(missing.logger)).toEqual([]);

    const unread = setup({
      stopSession: () => Promise.reject(httpError(409, TradingSessionErrorCode.SessionNotActive)),
      readSession: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await unread.press(WAITING_STOP);
    expect(methods(unread.calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(unread.calls, 'editMessageText')?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(payloadOf(unread.calls, 'editMessageText'))).toEqual([MENU_ROW]);
    expect(warnings(unread.logger)).toEqual(['trading session status not read']);
  });

  it("SW4' the edit refused as gone: the same reply as a new message; «not modified»: nothing more; a transport failure: a warning", async () => {
    const gone = setup();
    gone.apiErrors.set('editMessageText', EDIT_GONE);
    await gone.press(WAITING_STOP);
    expect(methods(gone.calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    const sent = payloadOf(gone.calls, 'sendMessage');
    expect(sent?.text).toBe(replyOf(STOPPED));
    expect(rowsOf(sent)).toEqual(STOPPED_ROWS);
    expect(gone.logger.info.mock.calls.map((call) => call[1])).toContain(
      'the pressed message was already gone',
    );
    expect(gone.sessionTracker.track).not.toHaveBeenCalled();

    const failedGone = setup({ stopSession: () => Promise.reject(httpError(500)) });
    failedGone.apiErrors.set('editMessageText', EDIT_GONE);
    await failedGone.press(WAITING_STOP);
    expect(methods(failedGone.calls)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendMessage',
    ]);
    // the pressed message is gone, so the sender has moved on: its next waiting message carries
    // the one «⏹», the new message the menu (#587 round 1)
    expect(rowsOf(payloadOf(failedGone.calls, 'editMessageText'))).toEqual([STOP_AGAIN_ROW]);
    expect(rowsOf(payloadOf(failedGone.calls, 'sendMessage'))).toEqual([MENU_ROW]);

    const shown = setup();
    shown.apiErrors.set('editMessageText', NOT_MODIFIED);
    await shown.press(WAITING_STOP);
    expect(methods(shown.calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(warnings(shown.logger)).toEqual([]);

    const broken = setup();
    broken.apiErrors.set(
      'editMessageText',
      new HttpError("Network request for 'editMessageText' failed!", new Error('reset')),
    );
    await broken.press(WAITING_STOP);
    expect(methods(broken.calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(warnings(broken.logger)).toEqual(['trading session stop reply not drawn']);
  });

  it('SW5 an open trade plays out: the reply says so', async () => {
    const { press, calls } = setup({ stopSession: () => Promise.resolve(open) });
    await press(WAITING_STOP);
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      ['⏹ Сессия остановлена по твоей команде.', '⏳ Открытая сделка доиграет до конца.'].join(
        '\n',
      ),
    );
  });

  it('SW5b a trade whose outcome is unknown: the reply says the broker is asked', async () => {
    const reconciling = sessionView({
      ...STOPPED,
      lastIntent: intentView({ status: TradeIntentStatus.Reconciling }),
    });
    const { press, calls } = setup({ stopSession: () => Promise.resolve(reconciling) });
    await press(WAITING_STOP);
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      ['⏹ Сессия остановлена по твоей команде.', TEXTS.sessionLastTradeChecking.value].join('\n'),
    );
  });

  it('SW6 a real session: the same reply, its again button marked REAL', async () => {
    const realStopped = sessionView({ ...STOPPED, mode: TradeMode.Real });
    const { press, calls } = setup({ stopSession: () => Promise.resolve(realStopped) });
    await press(WAITING_STOP);
    const edit = payloadOf(calls, 'editMessageText');
    expect(edit?.text).toBe(replyOf(realStopped));
    expect(rowsOf(edit)[0]).toEqual([
      button('🔁 Ещё сессия · REAL', sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5)),
    ]);
  });

  it('ignores a press in a group', async () => {
    const { press, calls, stopSession } = setup();
    await press(WAITING_STOP, 'group');
    expect(calls).toEqual([]);
    expect(stopSession).not.toHaveBeenCalled();
  });
});

describe('«⏹ Остановить сессию» under the open trade’s block (#722)', () => {
  const open = sessionView({
    ...STOPPED,
    lastIntent: intentView({ status: TradeIntentStatus.Accepted }),
  });
  const infos = (logger: ReturnType<typeof fakeLogger>) =>
    logger.info.mock.calls.map((call) => call[1] as string);

  it('SC1 stops without the pressed message, answers with a new message under the end of the path, then takes the block’s keyboard off', async () => {
    const { press, calls, stopSession, readPairs, readSession, sessionTracker, logger } = setup();
    await press(CYCLE_STOP);
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'editMessageReplyMarkup',
    ]);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(replyOf(STOPPED));
    expect(sent?.parse_mode).toBe('HTML');
    expect(rowsOf(sent)).toEqual(STOPPED_ROWS);
    // the cycle's blocks are the backend's: no hand-over, no edit of its text
    expect(stopSession.mock.calls).toEqual([[SESSION_ID, String(USER.id), undefined]]);
    expect(payloadOf(calls, 'editMessageReplyMarkup')?.reply_markup).toBeUndefined();
    expect(readPairs).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
    expect(sessionTracker.track).not.toHaveBeenCalled();
    expect(warnings(logger)).toEqual([]);
  });

  it('SC2 a session stopped with its trade open: read on 409, «how it ended» says the trade plays out, the keyboard off', async () => {
    const { press, calls, readSession } = setup({
      stopSession: () => Promise.reject(httpError(409, TradingSessionErrorCode.SessionNotActive)),
      readSession: () => Promise.resolve(open),
    });
    await press(CYCLE_STOP);
    expect(readSession).toHaveBeenCalledWith(SESSION_ID, String(USER.id));
    expect(methods(calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'editMessageReplyMarkup',
    ]);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(replyOf(open));
    expect(payloadOf(calls, 'sendMessage')?.text).toContain(TEXTS.sessionOpenTradePlaysOut.value);
  });

  it('SC3 a failed stop or read: a new message under the menu, the block’s «⏹» left for another press', async () => {
    const broken = setup({ stopSession: () => Promise.reject(httpError(500)) });
    await broken.press(CYCLE_STOP);
    expect(methods(broken.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(broken.calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(payloadOf(broken.calls, 'sendMessage'))).toEqual([MENU_ROW]);
    expect(warnings(broken.logger)).toEqual(['trading session not stopped']);

    const missing = setup({ stopSession: () => Promise.reject(httpError(404, 'not_found')) });
    await missing.press(CYCLE_STOP);
    expect(methods(missing.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(missing.calls, 'sendMessage')?.text).toBe(
      TEXTS.sessionStatusUnavailable.value,
    );
    expect(rowsOf(payloadOf(missing.calls, 'sendMessage'))).toEqual([MENU_ROW]);
    expect(warnings(missing.logger)).toEqual([]);

    const unread = setup({
      stopSession: () => Promise.reject(httpError(409, TradingSessionErrorCode.SessionNotActive)),
      readSession: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await unread.press(CYCLE_STOP);
    expect(methods(unread.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(unread.calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(warnings(unread.logger)).toEqual(['trading session status not read']);
  });

  it.each([
    [
      'gone',
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message to edit not found',
      } as ApiError,
    ],
    [
      'not modified',
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      } as ApiError,
    ],
    ['a transport failure', new HttpError('Network request failed!', new Error('reset'))],
  ])('SC4 the keyboard’s removal refused (%s): logged at info, nothing more', async (_, error) => {
    const run = setup();
    run.apiErrors.set('editMessageReplyMarkup', error);
    await run.press(CYCLE_STOP);
    expect(methods(run.calls)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'editMessageReplyMarkup',
    ]);
    expect(infos(run.logger)).toContain('the keyboard of a pressed button was not removed');
    expect(warnings(run.logger)).toEqual([]);
  });

  it('SC5 a real session: the same reply, its again button marked REAL', async () => {
    const realStopped = sessionView({ ...STOPPED, mode: TradeMode.Real });
    const { press, calls } = setup({ stopSession: () => Promise.resolve(realStopped) });
    await press(CYCLE_STOP);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(replyOf(realStopped));
    expect(rowsOf(sent)[0]).toEqual([
      button('🔁 Ещё сессия · REAL', sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5)),
    ]);
  });

  it('SC6 ignores a press in a group', async () => {
    const { press, calls, stopSession } = setup();
    await press(CYCLE_STOP, 'group');
    expect(calls).toEqual([]);
    expect(stopSession).not.toHaveBeenCalled();
  });

  // issue #722 п. 6: the session can be stopped in every state of its run, by the way each state
  // offers - the waiting message's «⏹» while it waits, the open block's while a trade is open,
  // /stop always
  it.each([
    ['before the first decision', 'command', STOPPED],
    ['waiting for a signal', WAITING_STOP, STOPPED],
    ['a trade open', CYCLE_STOP, open],
    ['between a settlement and the next decision', 'command', STOPPED],
  ] as const)('SC7 %s: stopped, and the answer names how', async (_, entry, view) => {
    const run = setup({
      stopSession: () => Promise.resolve(view),
      stopSessions: () => Promise.resolve([view]),
    });
    if (entry === 'command') await run.send('/stop');
    else await run.press(entry);
    const answered = run.calls.find(
      (call) => call.method === 'sendMessage' || call.method === 'editMessageText',
    );
    expect(answered?.payload.text).toBe(replyOf(view));
    expect(run.stopSession.mock.calls.length + run.stopSessions.mock.calls.length).toBe(1);
  });

  it('SC7 stopped already with its trade open: the open block’s «⏹» answers how it ended', async () => {
    const run = setup({
      stopSession: () => Promise.reject(httpError(409, TradingSessionErrorCode.SessionNotActive)),
      readSession: () => Promise.resolve(open),
    });
    await run.press(CYCLE_STOP);
    expect(payloadOf(run.calls, 'sendMessage')?.text).toBe(replyOf(open));
  });
});

describe("an old status message's «⏹» (before #536)", () => {
  it('LG1 stops the session and draws it in place, under the end of the path, tracked', async () => {
    const { press, calls, stopSession, sessionTracker } = setup();
    await press(STOP);
    // not a waiting message: nothing is handed over
    expect(stopSession.mock.calls).toEqual([[SESSION_ID, String(USER.id), undefined]]);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edit = payloadOf(calls, 'editMessageText');
    expect(edit?.text).toBe(statusOf(STOPPED));
    expect(edit?.text).toContain('⏹ Сессия остановлена по твоей команде.');
    expect(rowsOf(edit)).toEqual(STOPPED_ROWS);
    // done at once: tracked all the same, so its entry sends the summary card (#318)
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({ view: STOPPED });
  });

  // #587: the new message's record wins by its newer id, so nothing names the pressed one
  it('LG1 the old message gone: the session message anew, tracked and recorded on the new message', async () => {
    const { pressUpdate, calls, apiErrors, sessionTracker } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    const update = callbackUpdate(STOP);
    expect(update.callback_query?.message?.message_id).not.toBe(TEXT_CARD_MESSAGE_ID);
    await pressUpdate(update);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf(STOPPED));
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual(STOPPED_ROWS);
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({
      messageId: TEXT_CARD_MESSAGE_ID,
      record: true,
    });
  });

  it('shows how a session that had already ended ended', async () => {
    const completed = sessionView({
      ...STOPPED,
      stopReason: TradingSessionStopReason.Completed,
      cycles: { planned: 5, closed: 5 },
      trades: {
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
    expect(rowsOf(payloadOf(broken.calls, 'sendMessage'))).toEqual([MENU_ROW]);
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

  // #536: the reply to «⏹» under the waiting message; /stop starts no tracking (the session
  // message is tracked from its start, or recovered by #567 once its id is recorded)
  it('B1 one stopped session: the stop reply under the end of the path, nothing tracked', async () => {
    const { send, calls, sessionTracker, readPairs } = setup();
    await send('/stop');
    const sent = onlyMessage(calls);
    expect(sent?.text).toBe(replyOf(STOPPED));
    expect(sent?.parse_mode).toBe('HTML');
    expect(rowsOf(sent)).toEqual(STOPPED_ROWS);
    expect(sessionTracker.track).not.toHaveBeenCalled();
    expect(readPairs).not.toHaveBeenCalled();
  });

  // the acceptance criterion: an open trade is not closed, it plays out
  it('B2 an open trade plays out: the reply says so', async () => {
    const { send, calls, sessionTracker, stopSessions, stopSession, readSession } = setup({
      stopSessions: () => Promise.resolve([open]),
    });
    await send('/stop');
    const sent = onlyMessage(calls);
    expect(sent?.text).toBe(replyOf(open));
    expect(sent?.text).toContain(TEXTS.sessionOpenTradePlaysOut.value);
    expect(stopSessions.mock.calls).toEqual([[String(USER.id)]]);
    expect(stopSession).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
    expect(sessionTracker.track).not.toHaveBeenCalled();
  });

  it('B2b a trade not yet open: the reply says it is still opening', async () => {
    const queued = sessionView({
      ...STOPPED,
      lastIntent: intentView({ status: TradeIntentStatus.Queued }),
    });
    const { send, calls } = setup({ stopSessions: () => Promise.resolve([queued]) });
    await send('/stop');
    expect(onlyMessage(calls)?.text).toBe(
      ['⏹ Сессия остановлена по твоей команде.', TEXTS.sessionLastTradeOpening.value].join('\n'),
    );
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

  it('B7 a group is ignored; /stop@bot and a trailing text are the command', async () => {
    const group = setup();
    await group.send('/stop', 'group');
    expect(group.calls).toEqual([]);
    expect(group.stopSessions).not.toHaveBeenCalled();

    for (const text of [`/stop@${BOT_INFO.username}`, '/stop что-то']) {
      const { send, calls, stopSessions } = setup();
      await send(text);
      expect(onlyMessage(calls)?.text).toBe(replyOf(STOPPED));
      expect(stopSessions).toHaveBeenCalledTimes(1);
    }
  });
});

describe('/stop resets the mode (#473)', () => {
  const RESET = { tradingMode: TradeMode.Demo, changed: true, stoppedSessions: 0 };
  const MODE_ROWS = [[button(LABELS.modeScreenButton, MODE_CALLBACK_DATA), ...MENU]];
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

  it('ST2 a switch out of real: the mode line with the menu first, then the stop reply', async () => {
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
    expect(status?.text).toBe(replyOf(STOPPED));
    expect(sessionTracker.track).not.toHaveBeenCalled();
  });

  it('ST3 a user already in demo gets the message of #122 only', async () => {
    const { send, calls, logger, setTradingMode } = setup({
      setTradingMode: () =>
        Promise.resolve({ tradingMode: TradeMode.Demo, changed: false, stoppedSessions: 0 }),
    });
    await send('/stop');
    expect(sends(calls).map((payload) => payload.text)).toEqual([replyOf(STOPPED)]);
    expect(setTradingMode).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ST4 no users row: nothing to reset, nothing said, no warning', async () => {
    const { send, calls, logger } = setup({
      setTradingMode: () => Promise.reject(httpError(404, TradingModeErrorCode.UserNotFound)),
    });
    await send('/stop');
    expect(sends(calls).map((payload) => payload.text)).toEqual([replyOf(STOPPED)]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ST5 a 4xx refusal: «не переключён» with the menu and a warning, the reply after it', async () => {
    const { send, calls, logger, sessionTracker } = setup({
      setTradingMode: () => Promise.reject(httpError(400)),
    });
    await send('/stop');
    const line = sentText(calls, TEXTS.modeNotReset.value);
    expect(line?.text).toBe('⚠️ Режим не переключён — открой /menu.');
    expect(rowsOf(line)).toEqual([MENU]);
    expect(sentText(calls, TEXTS.modeOutcomeUnknown.value)).toBeUndefined();
    expect(warnings(logger)).toEqual(['trading mode not reset']);
    expect(sentText(calls, replyOf(STOPPED))).toBeDefined();
    expect(sessionTracker.track).not.toHaveBeenCalled();
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
      expect(sentText(calls, replyOf(STOPPED))).toBeDefined();
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

  it('ST8 Telegram refuses the mode line: a warning with its method and code, the reply still sent', async () => {
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
    ).toEqual([TEXTS.modeStopReset.value, replyOf(STOPPED)].sort());
    expect(warnings(logger)).toEqual(['trading mode line not sent']);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'sendMessage',
      telegramErrorCode: 403,
    });
    expect(sessionTracker.track).not.toHaveBeenCalled();
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
  it('leads the end of the path, with its pair and duration', () => {
    const rows = (view: TradingSessionView) => keyboardRows(sessionCardKeyboard(view, CASHIER_URL));
    expect(rows(STOPPED)).toEqual(STOPPED_ROWS);
    expect(rows(STOPPED)[0]).toEqual([
      button(LABELS.sessionAgainButton, `demo:l:${String(PAIR_EURUSD.id)}:5:n`),
    ]);
    // #509: a session the no-signal limit stopped offers another pair: no «🔁 Ещё сессия», no
    // analysis of that pair, «🔀 Выбрать другую пару» on the signals list
    const noSignal = sessionView({
      ...STOPPED,
      stopReason: TradingSessionStopReason.NoSignalTimeout,
    });
    expect(rows(noSignal)).toEqual([
      [button(LABELS.otherPairButton, DEMO_SIGNALS_CALLBACK_DATA)],
      DEPOSIT,
      INVITE_MENU,
    ]);
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
    expect(keyboardRows(sessionCardKeyboard(view, CASHIER_URL))).toEqual(
      keyboardRows(sessionCardKeyboard(STOPPED, CASHIER_URL)),
    );
  });

  // #27: «💳 Пополнить» at the end of a real session too, and nowhere without a cashier
  it('ends a stopped session of either mode with the deposit, the invite and the menu', () => {
    const realStopped = sessionView({ ...STOPPED, mode: TradeMode.Real });
    for (const view of [STOPPED, realStopped]) {
      expect(keyboardRows(sessionCardKeyboard(view, CASHIER_URL)).slice(-2), view.mode).toEqual([
        DEPOSIT,
        INVITE_MENU,
      ]);
    }
    const withoutDeposit = STOPPED_ROWS.filter((row) => row !== DEPOSIT);
    expect(keyboardRows(sessionCardKeyboard(STOPPED, undefined))).toEqual(withoutDeposit);
    expect(keyboardRows(sessionCardKeyboard({ ...STOPPED, settings: null }, undefined))).toEqual([
      INVITE_MENU,
    ]);
  });

  it('is not drawn without settings', () => {
    // without settings only the deposit, the invite and the menu follow: no pair to analyse
    expect(keyboardRows(sessionCardKeyboard({ ...STOPPED, settings: null }, CASHIER_URL))).toEqual([
      DEPOSIT,
      INVITE_MENU,
    ]);
  });

  // #685: the duration is one, so a session of an older duration ends as a 5 s one does
  it.each([15, 60])('a stopped %i-s session offers «🔁 Ещё сессия» at 5 s', (durationSec) => {
    const settings = { ...STOPPED.settings!, durationSec };
    expect(keyboardRows(sessionCardKeyboard({ ...STOPPED, settings }, CASHIER_URL))).toEqual(
      STOPPED_ROWS,
    );
    expect(
      keyboardRows(
        sessionCardKeyboard(
          sessionView({ ...STOPPED, mode: TradeMode.Real, settings }),
          CASHIER_URL,
        ),
      )[0],
    ).toEqual([
      button('🔁 Ещё сессия · REAL', sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5)),
    ]);
  });

  it('no_signal → «🔀 Выбрать другую пару» = demo:sig at any duration', () => {
    for (const durationSec of [5, 15]) {
      const view = sessionView({
        ...STOPPED,
        stopReason: TradingSessionStopReason.NoSignalTimeout,
        settings: { ...STOPPED.settings!, durationSec },
      });
      expect(keyboardRows(sessionCardKeyboard(view, CASHIER_URL))[0]).toEqual([
        button(LABELS.otherPairButton, DEMO_SIGNALS_CALLBACK_DATA),
      ]);
    }
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
      button('$5.00', cycleStakeCallbackData(PAIR_EURUSD.id, 5, '5', 'a')),
    );
    expect(startSession).not.toHaveBeenCalled();
  });

  // #327: a stopped real session's again button is marked REAL and starts a real one
  it('starts a real session again from a stopped real one', async () => {
    const realStopped = sessionView({ ...STOPPED, mode: TradeMode.Real });
    const realAgain = button(
      '🔁 Ещё сессия · REAL',
      sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
    );
    expect(keyboardRows(sessionCardKeyboard(realStopped, CASHIER_URL))[0]).toEqual([realAgain]);
    const { press, startSession } = setup();
    await press(realAgain.callback_data ?? '');
    expect(startSession.mock.calls[0]?.[0]).toMatchObject({ mode: TradeMode.Real });
  });
});

describe('the summary in one message (#318, #537)', () => {
  const DONE = sessionView({
    ...STOPPED,
    trades: { ...STOPPED.trades, settled: 2, won: 1, lost: 1, profit: SUMMARY.result },
    lastIntent: intentView({ status: TradeIntentStatus.Settled }),
    balance: { available: d('9104.12000000'), ageSec: 120, current: false },
  });
  const NO_SIGNAL = sessionView({
    ...STOPPED,
    stopReason: TradingSessionStopReason.NoSignalTimeout,
  });
  const CARD_ROWS = STOPPED_ROWS;
  const captionOf = (view: TradingSessionView, label: PairLabel | null = pairLabel(PAIR_EURUSD)) =>
    sessionTexts.sessionSummaryText(label, PAIR_EURUSD.id, view).value;
  // the tracker's entry of a started session: its summary is what the tracker calls
  const entryOf = async (setupResult: ReturnType<typeof setup>) => {
    await setupResult.press(START);
    return setupResult.sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
  };
  const sendsOf = (scene: ReturnType<typeof setup>) =>
    methods(scene.calls).filter((method) =>
      ['sendPhoto', 'sendMessage', 'editMessageReplyMarkup'].includes(method),
    );
  const photoRefusal = (error_code: number, description: string, retry_after?: number) => ({
    ok: false as const,
    error_code,
    description,
    ...(retry_after === undefined ? {} : { parameters: { retry_after } }),
  });
  // the start's own sendMessage (the session message) comes before the summary
  const summaryText = (scene: ReturnType<typeof setup>) =>
    scene.calls.filter((call) => call.method === 'sendMessage').at(-1)?.payload;

  it('K1 is the end of the path; the invite and the menu alone without settings', () => {
    const rows = (view: TradingSessionView) => keyboardRows(sessionCardKeyboard(view, CASHIER_URL));
    expect(rows(DONE)).toEqual(CARD_ROWS);
    // #475: again and the deposit green on their own rows, the analysis blue, the rest no colour
    expect(inlineStyles({ reply_markup: sessionCardKeyboard(DONE, CASHIER_URL) })).toEqual([
      ['success'],
      ['primary', null],
      ['success'],
      [null, null],
    ]);
    expect(inlineStyles({ reply_markup: sessionCardKeyboard(NO_SIGNAL, CASHIER_URL) })[0]).toEqual([
      'success',
    ]);
    // S4: no empty first row
    expect(rows(sessionView({ ...DONE, settings: null }))).toEqual([DEPOSIT, INVITE_MENU]);
    // #509: under a no_signal_timeout summary, another pair instead of the same one again
    expect(rows(NO_SIGNAL)).toEqual([
      [button(LABELS.otherPairButton, DEMO_SIGNALS_CALLBACK_DATA)],
      DEPOSIT,
      INVITE_MENU,
    ]);
  });

  it("K2' claims, then sends one photo to the status chat: the whole summary as its caption, with sound, the end of the path", async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(scene.claimSessionSummary.mock.calls).toEqual([[SESSION_ID, String(USER.id)]]);
    const sent = scene.calls.slice(before).map((call) => call.method);
    expect(sent).toEqual(['sendPhoto', 'editMessageReplyMarkup']);
    const photo = payloadOf(scene.calls, 'sendPhoto');
    expect(photo?.chat_id).toBe(USER.id);
    expect(photo?.photo).toBeInstanceOf(InputFile);
    expect(photo?.parse_mode).toBe('HTML');
    expect(photo).not.toHaveProperty('disable_notification');
    expect(photo?.caption).toBe(captionOf(DONE));
    const lines = String(photo?.caption).split('\n');
    expect(lines[0]).toBe(`📈 ${pairLabel(PAIR_EURUSD)}`);
    expect(photo?.caption).toContain(`💰 Результат: ${formatSignedUsd(SUMMARY.result)}`);
    expect(photo?.caption).toMatch(/🧪 Демобаланс: \$9.104\.12/);
    expect(photo?.caption).toContain('🕒 Баланс Binodex обновлён');
    // #709: the caption ends with the summary's last line, no referral link
    expect(photo?.caption).not.toContain('t.me/');
    expect(lines.at(-1)).not.toMatch(/^🤖/);
    expect(rowsOf(photo)).toEqual(CARD_ROWS);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('K3 a refused claim sends nothing and logs nothing', async () => {
    const scene = setup({
      readSession: () => Promise.resolve(DONE),
      claimSessionSummary: () => Promise.resolve(null),
    });
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(scene.calls.slice(before)).toEqual([]);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('K4 a failed claim is logged with its backend fields, and nothing is sent', async () => {
    const scene = setup({
      readSession: () => Promise.resolve(DONE),
      claimSessionSummary: () => Promise.reject(httpError(500)),
    });
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(scene.calls.slice(before)).toEqual([]);
    expect(warnings(scene.logger)).toEqual(['trading session summary not sent']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({
      backendStatus: 500,
      sessionId: SESSION_ID,
    });
  });

  it("K5' a photo refused for good goes as the same caption in a text, with the keyboard and «📤 Поделиться»", async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    scene.apiErrors.set('sendPhoto', photoRefusal(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS'));
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(scene.calls.slice(before).map((call) => call.method)).toEqual([
      'sendPhoto',
      'sendMessage',
      'editMessageReplyMarkup',
    ]);
    const text = summaryText(scene);
    expect(text?.text).toBe(captionOf(DONE));
    expect(text?.parse_mode).toBe('HTML');
    expect(text).not.toHaveProperty('disable_notification');
    expect(rowsOf(text)).toEqual(CARD_ROWS);
    expect(payloadOf(scene.calls, 'editMessageReplyMarkup')?.message_id).toBe(TEXT_CARD_MESSAGE_ID);
    expect(warnings(scene.logger)).toEqual(['trading session card refused: sent as text']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'sendPhoto',
      telegramErrorCode: 400,
      sessionId: SESSION_ID,
    });
  });

  // K11 (the caption without the owner's code) went with the link (#709)

  it('K12 a no-signal stop without trades: one text with sound, «🔀 Выбрать другую пару» and the menu, no photo', async () => {
    const scene = setup({
      readSession: () => Promise.resolve(NO_SIGNAL),
      claimSessionSummary: () => Promise.resolve({ result: d('0.00000000'), trades: [] }),
    });
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(NO_SIGNAL);
    expect(scene.calls.slice(before).map((call) => call.method)).toEqual(['sendMessage']);
    const text = summaryText(scene);
    expect(text?.text).toBe(captionOf(NO_SIGNAL));
    expect(text).not.toHaveProperty('disable_notification');
    expect(rowsOf(text)).toEqual([
      [button(LABELS.otherPairButton, DEMO_SIGNALS_CALLBACK_DATA)],
      DEPOSIT,
      INVITE_MENU,
    ]);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('K13 a drawing that throws sends the text, warned', async () => {
    const scene = setup({
      readSession: () => Promise.resolve(DONE),
      // NaN prices do not parse in the contract, but nothing checks the card's model: the
      // renderer's input is the bot's own; a broken trade list throws in the model
      claimSessionSummary: () =>
        Promise.resolve({ ...SUMMARY, trades: [null as unknown as SessionSummary['trades'][0]] }),
    });
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(scene.calls.slice(before).map((call) => call.method)).toEqual([
      'sendMessage',
      'editMessageReplyMarkup',
    ]);
    expect(summaryText(scene)?.text).toBe(captionOf(DONE));
    expect(warnings(scene.logger)).toEqual(['trading session card not drawn']);
  });

  it('K14 a 403 on the photo sends nothing more', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    scene.apiErrors.set('sendPhoto', photoRefusal(403, 'Forbidden: bot was blocked by the user'));
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(scene.calls.slice(before).map((call) => call.method)).toEqual(['sendPhoto']);
    expect(warnings(scene.logger)).toEqual([
      'trading session summary refused: the user is unreachable',
    ]);
  });

  it.each([
    [2, 2_000],
    [30, 5_000],
  ])(
    'K15 a 429 with retry_after %i waits %i ms, then the photo once more and «📤 Поделиться»',
    async (retryAfter, waited) => {
      const slept: number[] = [];
      const scene = setup({
        readSession: () => Promise.resolve(DONE),
        sleep: (ms) => {
          slept.push(ms);
          scene.apiErrors.delete('sendPhoto');
          return Promise.resolve();
        },
      });
      scene.apiErrors.set(
        'sendPhoto',
        photoRefusal(429, 'Too Many Requests: retry later', retryAfter),
      );
      const entry = await entryOf(scene);
      const before = scene.calls.length;
      await entry.summary(DONE);
      expect(slept).toEqual([waited]);
      expect(scene.calls.slice(before).map((call) => call.method)).toEqual([
        'sendPhoto',
        'sendPhoto',
        'editMessageReplyMarkup',
      ]);
      expect(
        scene.calls.filter((call) => call.method === 'sendPhoto').at(-1)?.payload.caption,
      ).toBe(captionOf(DONE));
      expect(scene.logger.warn).not.toHaveBeenCalled();
    },
  );

  it('K16 a second 429 ends it: two photos, no text, warned', async () => {
    const slept: number[] = [];
    const scene = setup({
      readSession: () => Promise.resolve(DONE),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    scene.apiErrors.set('sendPhoto', photoRefusal(429, 'Too Many Requests: retry later', 1));
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(slept).toEqual([1_000]);
    expect(scene.calls.slice(before).map((call) => call.method)).toEqual([
      'sendPhoto',
      'sendPhoto',
    ]);
    expect(warnings(scene.logger)).toEqual(['trading session summary not sent']);
  });

  it('K17 a photo of unknown outcome is neither retried nor sent as a text', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    scene.apiErrors.set('sendPhoto', new HttpError('network', new Error('socket hang up')));
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(scene.calls.slice(before).map((call) => call.method)).toEqual(['sendPhoto']);
    expect(warnings(scene.logger)).toEqual(['trading session summary outcome unknown']);
  });

  it('K17b a 5xx on the photo is an unknown outcome too', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    scene.apiErrors.set('sendPhoto', photoRefusal(502, 'Bad Gateway'));
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(DONE);
    expect(scene.calls.slice(before).map((call) => call.method)).toEqual(['sendPhoto']);
    expect(warnings(scene.logger)).toEqual(['trading session summary outcome unknown']);
  });

  it('K18 a text after a refused photo that is refused too ends it, warned', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    const entry = await entryOf(scene);
    scene.apiErrors.set('sendPhoto', photoRefusal(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS'));
    scene.apiErrors.set('sendMessage', photoRefusal(400, 'Bad Request: chat not found'));
    await entry.summary(DONE);
    expect(warnings(scene.logger)).toEqual([
      'trading session card refused: sent as text',
      'trading session summary not sent',
    ]);
    expect(methods(scene.calls)).not.toContain('editMessageReplyMarkup');
  });

  it('K19 a session that names no asset claims nothing and is an error', async () => {
    const bare = sessionView({ ...NO_SIGNAL, settings: null, lastIntent: null });
    const scene = setup({ readSession: () => Promise.resolve(bare) });
    const entry = await entryOf(scene);
    const before = scene.calls.length;
    await entry.summary(bare);
    expect(scene.claimSessionSummary).not.toHaveBeenCalled();
    expect(scene.calls.slice(before)).toEqual([]);
    expect(scene.logger.error.mock.calls.map((call) => call[1])).toEqual([
      'trading session summary names no asset',
    ]);
  });

  // the card is a photo: an edit of it is refused (demo.test.ts → a press under the session card)
  it('K7 «🔁 Ещё сессия» under the card opens the amount screen by a reply, never an edit', async () => {
    const scene = setup();
    scene.apiErrors.set('editMessageText', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: there is no text in the message to edit',
    });
    const again = keyboardRows(sessionCardKeyboard(DONE, CASHIER_URL))
      .flat()
      .find((key) => key.text === LABELS.sessionAgainButton);
    await scene.press((again as Button | undefined)?.callback_data ?? '');
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(scene.calls, 'sendMessage')?.text).toContain('Выбери сумму сделки 👇');
    expect(scene.startSession).not.toHaveBeenCalled();
    expect(scene.logger.error).not.toHaveBeenCalled();
  });

  // #321, #538: «📤 Поделиться» on top, by one edit after the send; the query names the session only
  const SHARE_ROW = [
    {
      text: LABELS.sessionShareButton,
      switch_inline_query_chosen_chat: {
        query: shareQuery(SESSION_ID),
        allow_user_chats: true,
        allow_group_chats: true,
        allow_channel_chats: true,
      },
    },
  ];

  it("K8 puts «📤 Поделиться» over the summary's own rows, its query the session's id", async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    await (await entryOf(scene)).summary(DONE);
    expect(sendsOf(scene).slice(-2)).toEqual(['sendPhoto', 'editMessageReplyMarkup']);
    const edit = payloadOf(scene.calls, 'editMessageReplyMarkup');
    expect(edit?.chat_id).toBe(USER.id);
    expect(edit?.message_id).toBe(CARD_MESSAGE_ID);
    const rows = rowsOf(edit) as unknown[][];
    expect(rows[0]).toEqual(SHARE_ROW);
    expect(rows.slice(1)).toEqual(CARD_ROWS);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it('K9 a refused edit is a warning only: the summary keeps its keyboard, no retry, no «not sent»', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE) });
    scene.apiErrors.set('editMessageReplyMarkup', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    await (await entryOf(scene)).summary(DONE);
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

  it('K10 without the storage channel the summary goes without «📤 Поделиться», and no warning', async () => {
    const scene = setup({ readSession: () => Promise.resolve(DONE), shareOff: true });
    await (await entryOf(scene)).summary(DONE);
    expect(methods(scene.calls)).toContain('sendPhoto');
    expect(methods(scene.calls)).not.toContain('editMessageReplyMarkup');
    expect(rowsOf(payloadOf(scene.calls, 'sendPhoto'))).toEqual(CARD_ROWS);
    expect(scene.logger.warn).not.toHaveBeenCalled();
  });

  it("K6 without settings, the asset is the last trade's and the keyboard the invite and the menu", async () => {
    const bare = sessionView({ ...DONE, settings: null });
    const scene = setup({ startSession: () => Promise.resolve({ started: bare }) });
    await (await entryOf(scene)).summary(bare);
    const photo = payloadOf(scene.calls, 'sendPhoto');
    expect(photo?.caption).toBe(
      sessionTexts.sessionSummaryText(null, bare.lastIntent!.assetId, bare).value,
    );
    expect(rowsOf(photo)).toEqual([DEPOSIT, INVITE_MENU]);
    expect(rowsOf(payloadOf(scene.calls, 'editMessageReplyMarkup'))).toEqual([
      SHARE_ROW,
      DEPOSIT,
      INVITE_MENU,
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
    expect(payloadOf(calls, 'sendMessage')).not.toHaveProperty('reply_markup');
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
    language: BotLanguage.En,
  };
  const resumed = (scene: ReturnType<typeof setup>, label: PairLabel | null) => {
    const resume = scene.sessionResumer.attach.mock.calls[0]?.[0];
    if (resume === undefined) throw new Error('createBot attached no resume');
    resume(scene.bot.api, tracked, label);
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
      // #508: the owner's language from the list, not the store of an update
      language: BotLanguage.En,
    });
    await entry.edit({ text: telegramHtml`edited`, picture: STOPPED.signalAction });
    const edit = payloadOf(scene.calls, 'editMessageText');
    expect(edit).toMatchObject({
      chat_id: USER.id,
      message_id: RESUMED_MESSAGE_ID,
      text: 'edited',
    });
    expect(edit).not.toHaveProperty('reply_markup');
  });

  it("RS2' the summary goes to the owner's chat", async () => {
    const scene = setup();
    await resumed(scene, pairLabel(PAIR_EURUSD)).summary(DONE);
    expect(payloadOf(scene.calls, 'sendPhoto')?.chat_id).toBe(USER.id);
  });

  it("RS3' the label is what the resume was handed; null names the asset by its id", async () => {
    const scene = setup();
    const entry = resumed(scene, null);
    expect(entry.label).toBeNull();
    await entry.summary(DONE);
    expect(payloadOf(scene.calls, 'sendPhoto')?.caption).toBe(
      sessionTexts.sessionSummaryText(null, PAIR_EURUSD.id, DONE).value,
    );
  });
});

// #568: the session message is the picture of its signal's direction, the text its caption
describe('the session picture (#568)', () => {
  const UP = sessionView({ signalAction: 'up' });
  const DOWN = sessionView({ signalAction: 'down' });
  const UP_STOPPED = sessionView({ ...STOPPED, signalAction: 'up' });
  const LAUNCH = sessionStartCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5, true);
  const PHOTO_REFUSED: ApiError = {
    ok: false,
    error_code: 400,
    description: 'Bad Request: wrong file identifier/HTTP URL specified',
  };
  const NOT_MODIFIED: ApiError = {
    ok: false,
    error_code: 400,
    description:
      'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
  };
  const fileName = (photo: unknown) => (photo instanceof InputFile ? photo.filename : photo);
  const photos = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'sendPhoto').map((call) => fileName(call.payload.photo));
  const media = (calls: readonly ApiCall[]) =>
    calls
      .filter((call) => call.method === 'editMessageMedia')
      .map((call) => call.payload.media as Record<string, unknown>);
  const started = (view: TradingSessionView) =>
    setup({ startSession: () => Promise.resolve({ started: view }) });
  const entryOf = (scene: ReturnType<typeof setup>, index = 0) =>
    scene.sessionTracker.track.mock.calls[index]?.[0] as SessionTrackRequest;

  it('S-photo1 sends the up picture, its caption the session text with the signal fifth, and tracks it', async () => {
    const scene = started(UP);
    await scene.press(START);
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'sendPhoto']);
    const sent = payloadOf(scene.calls, 'sendPhoto');
    expect(fileName(sent?.photo)).toBe('setup-bull.png');
    expect(sent?.caption).toBe(statusOf(UP));
    expect(String(sent?.caption).split('\n')[4]).toBe('📡 Сигнал: ⬆️ Вверх');
    expect(sent?.parse_mode).toBe('HTML');
    expect(sent).not.toHaveProperty('reply_markup');
    expect(entryOf(scene)).toMatchObject({ messageId: CARD_MESSAGE_ID, view: UP });
    // the second start goes by the file_id the first one was answered with
    await scene.press(START);
    expect(photos(scene.calls)).toEqual(['setup-bull.png', CARD_FILE_ID]);
  });

  it('S-photo2 a down signal sends the bear picture', async () => {
    const scene = started(DOWN);
    await scene.press(START);
    const sent = payloadOf(scene.calls, 'sendPhoto');
    expect(fileName(sent?.photo)).toBe('setup-bear.png');
    expect(String(sent?.caption).split('\n')[4]).toBe('📡 Сигнал: ⬇️ Вниз');
  });

  it('S-photo3 a refused photo: the same text as a message, tracked, the launch screen kept, the file_id forgotten', async () => {
    const scene = started(UP);
    await scene.press(START);
    scene.apiErrors.set('sendPhoto', PHOTO_REFUSED);
    await scene.pressUpdate(callbackUpdate(LAUNCH));
    expect(methods(scene.calls).slice(2)).toEqual([
      'answerCallbackQuery',
      'sendPhoto',
      'sendMessage',
    ]);
    expect(payloadOf(scene.calls, 'sendMessage')?.text).toBe(statusOf(UP));
    expect(payloadOf(scene.calls, 'sendMessage')).not.toHaveProperty('reply_markup');
    expect(entryOf(scene, 1)).toMatchObject({ messageId: TEXT_CARD_MESSAGE_ID });
    expect(warnings(scene.logger)).toEqual(['the session photo was refused, sending its text']);
    expect(scene.logger.warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'sendPhoto',
      telegramErrorCode: 400,
      byFileId: true,
    });
    scene.apiErrors.delete('sendPhoto');
    await scene.press(START);
    expect(photos(scene.calls)).toEqual(['setup-bull.png', CARD_FILE_ID, 'setup-bull.png']);
  });

  it('S-photo4 a photo failed in transport: thrown, no second message, nothing tracked', async () => {
    const scene = started(UP);
    scene.apiErrors.set(
      'sendPhoto',
      new HttpError("Network request for 'sendPhoto' failed!", new Error('reset')),
    );
    await expect(scene.press(START)).rejects.toThrow();
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'sendPhoto']);
    expect(scene.sessionTracker.track).not.toHaveBeenCalled();
  });

  it('S-edit1 an edit of a view with a direction is editMessageMedia, without a keyboard', async () => {
    const scene = started(UP);
    await scene.press(START);
    await entryOf(scene).edit(sessionDrawing(pairLabel(PAIR_EURUSD), UP_STOPPED));
    const edit = payloadOf(scene.calls, 'editMessageMedia');
    expect(edit).toMatchObject({ chat_id: USER.id, message_id: CARD_MESSAGE_ID });
    expect(edit).not.toHaveProperty('reply_markup');
    expect(media(scene.calls)).toEqual([
      { type: 'photo', media: CARD_FILE_ID, caption: statusOf(UP_STOPPED), parse_mode: 'HTML' },
    ]);
    expect(methods(scene.calls)).not.toContain('editMessageText');
  });

  it('S-edit2/3 a turn to down uploads the bear picture, then edits by the file_id it answered', async () => {
    const scene = started(UP);
    await scene.press(START);
    scene.answers.set(
      'editMessageMedia',
      photoAnswer(CARD_MESSAGE_ID, ['bear-small', 'bear-large']),
    );
    const entry = entryOf(scene);
    await entry.edit({ text: telegramHtml`down`, picture: DOWN.signalAction });
    await entry.edit({
      text: telegramHtml`down again`,
      picture: DOWN.signalAction,
    });
    await entry.edit({ text: telegramHtml`up`, picture: UP.signalAction });
    expect(media(scene.calls).map((m) => fileName(m.media))).toEqual([
      'setup-bear.png',
      'bear-large',
      CARD_FILE_ID,
    ]);
  });

  it('S-edit4 a refused media edit forgets the file_id and is thrown to the tracker; not modified keeps it', async () => {
    const scene = started(UP);
    await scene.press(START);
    const entry = entryOf(scene);
    scene.apiErrors.set('editMessageMedia', NOT_MODIFIED);
    await expect(
      entry.edit({ text: telegramHtml`same`, picture: UP.signalAction }),
    ).rejects.toBeInstanceOf(GrammyError);
    scene.apiErrors.set('editMessageMedia', PHOTO_REFUSED);
    await expect(
      entry.edit({ text: telegramHtml`stale`, picture: UP.signalAction }),
    ).rejects.toBeInstanceOf(GrammyError);
    scene.apiErrors.delete('editMessageMedia');
    await entry.edit({ text: telegramHtml`again`, picture: UP.signalAction });
    expect(media(scene.calls).map((m) => fileName(m.media))).toEqual([
      CARD_FILE_ID,
      CARD_FILE_ID,
      'setup-bull.png',
    ]);
  });

  it('S-edit5 a session gone: the picture under the menu after a view with a direction, the text after none', async () => {
    const scene = started(UP);
    await scene.press(START);
    const entry = entryOf(scene);
    await entry.edit(
      { text: TEXTS.sessionStatusUnavailable, picture: UP.signalAction },
      'not_found',
    );
    const edit = payloadOf(scene.calls, 'editMessageMedia');
    expect(edit?.media).toMatchObject({
      type: 'photo',
      media: CARD_FILE_ID,
      caption: TEXTS.sessionStatusUnavailable.value,
    });
    expect(rowsOf(edit)).toEqual([MENU]);
    await entry.edit(
      { text: TEXTS.sessionStatusUnavailable, picture: SESSION_VIEW.signalAction },
      'not_found',
    );
    expect(methods(scene.calls).filter((m) => m.startsWith('edit'))).toEqual([
      'editMessageMedia',
      'editMessageText',
    ]);
  });

  it('S-photo5 a view without a direction keeps the text message and its text edit', async () => {
    const scene = started(SESSION_VIEW);
    await scene.press(START);
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    await entryOf(scene).edit({
      text: telegramHtml`stopped`,
      picture: STOPPED.signalAction,
    });
    expect(methods(scene.calls).at(-1)).toBe('editMessageText');
  });

  it("LG1 an old status message's «⏹» draws the caption text with its signal line, in place", async () => {
    const scene = setup({ stopSession: () => Promise.resolve(UP_STOPPED) });
    await scene.press(STOP);
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(scene.calls, 'editMessageText')?.text).toContain('📡 Сигнал: ⬆️ Вверх');
  });
});

describe('an H1 session from the bot (#745, #775): drawn as any session', () => {
  const built = buildH1SessionSettings({
    assetId: PAIR_EURUSD.id,
    cycles: 5,
    stake: { baseStake: d('1.00'), stakeScale: 2 },
    strategy: SessionStakeStrategy.Martingale,
  });
  if (!built.success) throw new Error('fixture: H1 settings');
  const H1 = sessionView({ settings: built.data });
  const H1_UP = sessionView({ settings: built.data, signalAction: 'up' });
  const H1_STOPPED = sessionView({ ...STOPPED, settings: built.data });
  const H1_COMPLETED = sessionView({
    ...STOPPED,
    settings: built.data,
    stopReason: TradingSessionStopReason.Completed,
    cycles: { planned: 5, closed: 5 },
    trades: { settled: 8, rejected: 0, won: 5, lost: 3, tied: 0, profit: d('5') },
  });
  const started = (view: TradingSessionView) =>
    setup({ startSession: () => Promise.resolve({ started: view }) });
  const entryOf = (scene: ReturnType<typeof setup>) =>
    scene.sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;

  it('H1-B7 the session message and its edits carry no keyboard; the old «⏹» path draws in place; the end counts cycles', async () => {
    const photo = started(H1_UP);
    await photo.press(START);
    expect(methods(photo.calls)).toEqual(['answerCallbackQuery', 'sendPhoto']);
    expect(payloadOf(photo.calls, 'sendPhoto')?.caption).toBe(statusOf(H1_UP));
    expect(payloadOf(photo.calls, 'sendPhoto')).not.toHaveProperty('reply_markup');

    const text = started(H1);
    await text.press(START);
    expect(payloadOf(text.calls, 'sendMessage')?.text).toBe(statusOf(H1));
    expect(payloadOf(text.calls, 'sendMessage')).not.toHaveProperty('reply_markup');
    await entryOf(text).edit(sessionDrawing(pairLabel(PAIR_EURUSD), H1));
    expect(payloadOf(text.calls, 'editMessageText')).not.toHaveProperty('reply_markup');

    // a «⏹» with no suffix is an old status message's: the reply in its place, as for any session
    const stop = setup({ stopSession: () => Promise.resolve(H1_STOPPED) });
    await stop.press(STOP);
    expect(methods(stop.calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(payloadOf(stop.calls, 'editMessageText')?.text).toBe(statusOf(H1_STOPPED));

    const line = '🏁 Сессия завершена: 5 циклов, 8 сделок — 5 в плюс, 3 в минус';
    expect(statusOf(H1_COMPLETED)).toContain(line);
    expect(replyOf(H1_COMPLETED).split('\n')[0]).toBe(line);
  });

  it('H1-B8 h1_duration_unsupported is a logged bug', async () => {
    const duration = setup({
      startSession: () =>
        Promise.reject(httpError(409, TradingSessionErrorCode.H1DurationUnsupported)),
    });
    await duration.press(START);
    expect(payloadOf(duration.calls, 'sendMessage')?.text).toBe(TEXTS.sessionPairUnavailable.value);
    expect(warnings(duration.logger)).toEqual(['trading session not started']);
  });

  it('H1-B9 a start without a signal (#796): a text message waiting for one, then the first trade turns it into the picture', async () => {
    const scene = started(H1);
    await scene.press(START);
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(scene.calls, 'sendMessage');
    expect(String(sent?.text).split('\n')[4]).toBe('📡 Ждём сигнал…');
    await entryOf(scene).edit(sessionDrawing(pairLabel(PAIR_EURUSD), H1_UP));
    expect(methods(scene.calls).at(-1)).toBe('editMessageMedia');
    const edit = payloadOf(scene.calls, 'editMessageMedia')?.media as Record<string, unknown>;
    expect(edit).toMatchObject({ type: 'photo', caption: statusOf(H1_UP), parse_mode: 'HTML' });
    expect(String(edit.caption).split('\n')[4]).toBe('📡 Сигнал: ⬆️ Вверх');
  });
});

// #633: the session of a user whose language is English, through the language middleware as
// production answers it; the tracker's summary runs in its entry's language (#508)
describe('the session in English (#633)', () => {
  const en = <T>(run: () => T): T => runWithLanguage(BotLanguage.En, run);
  const CYRILLIC = /[А-Яа-яЁё]/u;
  const english = () => setup({ languages: userLanguagesWith(USER.id, BotLanguage.En) });
  const labelsOf = (payload: Record<string, unknown> | undefined) =>
    rowsOf(payload)
      .flat()
      .map((key) => key.text);
  const DONE = sessionView({
    ...STOPPED,
    trades: { ...STOPPED.trades, settled: 2, won: 1, lost: 1, profit: SUMMARY.result },
    lastIntent: intentView({ status: TradeIntentStatus.Settled }),
  });

  it('EN-8 starts, stops and sums up the session in English, «⏹» included', async () => {
    const scene = english();
    await scene.press(START);
    const started = payloadOf(scene.calls, 'sendMessage');
    expect(started?.text).toBe(en(() => statusOf(SESSION_VIEW)));
    expect(started?.text).not.toMatch(CYRILLIC);
    const entry = scene.sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
    expect(entry.language).toBe(BotLanguage.En);

    const stopped = english();
    await stopped.press(CYCLE_STOP);
    const reply = payloadOf(stopped.calls, 'sendMessage');
    expect(reply?.text).toBe(en(() => replyOf(STOPPED)));
    for (const text of [String(reply?.text), ...labelsOf(reply)]) {
      expect(text).not.toMatch(CYRILLIC);
    }
    expect(labelsOf(reply)).toContain(en(() => LABELS.sessionAgainButton));

    const before = scene.calls.length;
    await runWithLanguage(entry.language, () => entry.summary(DONE));
    const photo = scene.calls.slice(before).find((call) => call.method === 'sendPhoto')?.payload;
    expect(photo?.caption).toBe(
      en(() => sessionTexts.sessionSummaryText(pairLabel(PAIR_EURUSD), PAIR_EURUSD.id, DONE).value),
    );
    const labels = scene.calls.slice(before).flatMap((call) => labelsOf(call.payload));
    expect(labels).toContain(en(() => LABELS.menuButton));
    for (const text of [String(photo?.caption), ...labels]) expect(text).not.toMatch(CYRILLIC);
  });
});
