import { InputFile } from 'grammy';
import type { ApiError } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import {
  TradeIntentStatus,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  decimalStringSchema,
  formatSignedUsd,
  plainTextOf,
  telegramHtml,
  type SessionSummary,
  type TradingSessionView,
  CONNECT_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  supportUrl,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  DEMO_SIGNALS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  sessionStartCallbackData,
  stakeMenuCallbackData,
} from './demo';
import type { SessionTrackRequest } from './session-tracker';
import {
  BOT_INFO,
  CARD_MESSAGE_ID,
  PAIR_EURUSD,
  PAIRS_RESPONSE,
  SESSION_ID,
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
import { INVITE_CALLBACK_DATA } from './keyboards';
import { INLINE_QUERY_LIMIT, shareQuery } from './session-share';

const START = sessionStartCallbackData(PAIR_EURUSD.id, 5);
// the sizes of the card's sendPhoto result, smallest first (#321)
const SMALL_FILE_ID = 'AgACAgIAAxkBAAIBsmall';
const CARD_FILE_ID = 'AgACAgIAAxkBAAIBlarge';
const REFRESH = sessionRefreshCallbackData(SESSION_ID);
const STOP = sessionStopCallbackData(SESSION_ID);

interface Button {
  text: string;
  callback_data?: string;
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
  } = {},
) {
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
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
  const logger = fakeLogger();
  const sessionTracker = stubSessionTracker();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({
      readPairs,
      startSession,
      readSession,
      stopSession,
      claimSessionSummary,
      stopSessions,
    }),
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker,
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  api.answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, [SMALL_FILE_ID, CARD_FILE_ID]));
  const press = (data: string, chatType?: string) =>
    bot.handleUpdate(callbackUpdate(data, chatType));
  const send = (text: string, chatType?: string) => bot.handleUpdate(textUpdate(text, chatType));
  return {
    press,
    send,
    logger,
    sessionTracker,
    readPairs,
    startSession,
    readSession,
    stopSession,
    claimSessionSummary,
    stopSessions,
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
const statusOf = (view: TradingSessionView) => sessionStatusText(PAIR_EURUSD.symbol, view).value;

const LIVE_ROWS = [
  [button(LABELS.sessionRefreshButton, REFRESH), button(LABELS.sessionStopButton, STOP)],
];
// SESSION_VIEW's own pair and duration
const AGAIN = button(LABELS.sessionAgainButton, sessionStartCallbackData(PAIR_EURUSD.id, 15));
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
const STOPPED_ROWS = [
  [button(LABELS.sessionRefreshButton, REFRESH)],
  [AGAIN],
  newAnalysis(15),
  toSignals(15),
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
// a failed read of the session, after the refresh or the stop: its refresh, never the stop again
const SESSION_REFRESH_ROWS = [[button(LABELS.sessionRefreshButton, REFRESH)], MENU_ROW];
const STAKE_MENU_ROWS = [
  [button(LABELS.stakeMenuButton, stakeMenuCallbackData(PAIR_EURUSD.id, 5))],
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
      [{ telegramUserId: String(USER.id), assetId: PAIR_EURUSD.id, durationSec: 5, trades: 5 }],
    ]);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(statusOf(SESSION_VIEW));
    expect(sent?.parse_mode).toBe('HTML');
    expect(rowsOf(sent)).toEqual(LIVE_ROWS);
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SESSION_ID,
      telegramUserId: String(USER.id),
      symbol: PAIR_EURUSD.symbol,
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
    await entry.edit(telegramHtml`gone`, SESSION_VIEW, 'not_found');
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
    const status = code === TradingSessionErrorCode.CatalogUnavailable ? 503 : 409;
    const { press, calls, startSession, sessionTracker, logger } = setup({
      startSession: () => Promise.reject(httpError(status, code)),
    });
    await press(START);
    const refusal: {
      text: Parameters<typeof textOf>[0];
      connect?: true;
      stakeMenu?: true;
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
            : BACK_ROWS,
    );
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(sessionTracker.track).not.toHaveBeenCalled();
    expect(warnings(logger)).toEqual(refusal.log === true ? ['trading session not started'] : []);
  });

  // #297: the saved stake refused against the snapshot; the picker opens from the same analysis
  it('answers the three stake refusals with «💵 Сумма» for the pressed pair', () => {
    for (const code of [
      TradingSessionErrorCode.StakePrecision,
      TradingSessionErrorCode.StakeBelowMinimum,
      TradingSessionErrorCode.InsufficientDemoBalance,
    ]) {
      expect(START_REFUSALS[code], code).toMatchObject({ stakeMenu: true });
    }
    expect(STAKE_MENU_ROWS[0]?.[0]?.callback_data).toMatch(/^stk:o:a:\d+:\d+$/);
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
    expect(START_REFUSALS[TradingSessionErrorCode.ModeNotAllowed]).toEqual({
      text: 'unavailable',
      log: true,
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
      symbol: PAIR_EURUSD.symbol,
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

describe('«🔁 Ещё сессия»', () => {
  it('is on a stopped session only, with its pair and duration', () => {
    const rows = (view: TradingSessionView) => sessionKeyboard(view).inline_keyboard;
    expect(rows(STOPPED)).toEqual(STOPPED_ROWS);
    expect(
      rows(sessionView({ ...STOPPED, settings: { ...STOPPED.settings!, durationSec: 5 } })),
    ).toEqual([
      [button(LABELS.sessionRefreshButton, REFRESH)],
      [button(LABELS.sessionAgainButton, sessionStartCallbackData(PAIR_EURUSD.id, 5))],
      newAnalysis(5),
      toSignals(5),
      INVITE,
      MENU,
    ]);
    // S5: the live session's keyboard has no invite
    expect(rows(SESSION_VIEW)).toEqual(LIVE_ROWS);
    expect(rows(sessionView({ status: TradingSessionStatus.Paused }))).toEqual(LIVE_ROWS);
  });

  it('is not drawn without settings or on a duration the demo no longer offers', () => {
    const refresh = [button(LABELS.sessionRefreshButton, REFRESH)];
    // without settings only the invite and the menu follow: no pair to analyse
    expect(sessionKeyboard({ ...STOPPED, settings: null }).inline_keyboard).toEqual([
      refresh,
      INVITE,
      MENU,
    ]);
    // an old duration: no «🔁 Ещё сессия» and no «📊 Новый анализ», the signals and the menu stay
    expect(
      sessionKeyboard({ ...STOPPED, settings: { ...STOPPED.settings!, durationSec: 60 } })
        .inline_keyboard,
    ).toEqual([refresh, TO_DURATIONS, INVITE, MENU]);
  });

  it('starts a new session of the same pair and duration through the session button', async () => {
    const { press, startSession } = setup();
    await press(AGAIN.callback_data ?? '');
    expect(startSession.mock.calls).toEqual([
      [{ telegramUserId: String(USER.id), assetId: PAIR_EURUSD.id, durationSec: 15, trades: 5 }],
    ]);
  });
});

describe('the summary card (#318)', () => {
  const DONE = sessionView({
    ...STOPPED,
    trades: { ...STOPPED.trades, settled: 2, won: 1, lost: 1, profit: SUMMARY.result },
    lastIntent: intentView({ status: TradeIntentStatus.Settled }),
  });
  const CARD_ROWS = [[AGAIN], newAnalysis(15), toSignals(15), INVITE, MENU];
  // the tracker's entry of a refresh on a done session: its card is what the tracker calls
  const entryOf = async (setupResult: ReturnType<typeof setup>) => {
    await setupResult.press(REFRESH);
    return setupResult.sessionTracker.track.mock.calls[0]?.[0] as SessionTrackRequest;
  };

  it('K1 is the stopped status keyboard without «🔄 Обновить»; the invite and the menu alone without settings', () => {
    const rows = (view: TradingSessionView) => sessionCardKeyboard(view).inline_keyboard;
    expect(rows(DONE)).toEqual(CARD_ROWS);
    // S4: no empty first row
    expect(rows(sessionView({ ...DONE, settings: null }))).toEqual([INVITE, MENU]);
    expect(
      rows(sessionView({ ...DONE, settings: { ...DONE.settings!, durationSec: 60 } })),
    ).toEqual([TO_DURATIONS, INVITE, MENU]);
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
        symbol: PAIR_EURUSD.symbol,
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
  it('K7 «🔁 Ещё сессия» under the card starts a session by a reply, never an edit', async () => {
    const scene = setup();
    scene.apiErrors.set('editMessageText', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: there is no text in the message to edit',
    });
    const again = sessionCardKeyboard(DONE)
      .inline_keyboard.flat()
      .find((key) => key.text === LABELS.sessionAgainButton);
    await scene.press((again as Button | undefined)?.callback_data ?? '');
    expect(methods(scene.calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(scene.calls, 'sendMessage')?.text).toBe(statusOf(SESSION_VIEW));
    expect(scene.startSession).toHaveBeenCalledTimes(1);
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
    expect(rowsOf(photo)).toEqual([INVITE, MENU]);
    expect(rowsOf(payloadOf(scene.calls, 'editMessageReplyMarkup'))).toEqual([
      SHARE_ROW,
      INVITE,
      MENU,
    ]);
  });
});
