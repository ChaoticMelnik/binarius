import { describe, expect, it, vi } from 'vitest';
import {
  BrokerBalanceUnavailableReason,
  CONNECT_CALLBACK_DATA,
  MENU_CALLBACK_DATA,
  plainTextOf,
  supportUrl,
  TradeMode,
  UserStatus,
} from '@binarius/shared';
import type { ApiError } from 'grammy/types';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import { MODE_CALLBACK_DATA } from './keyboards';
import {
  ACCESS_VIEW,
  BOT_INFO,
  TEXT_CARD_MESSAGE_ID,
  USER,
  accessView,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  messageAnswer,
  stubSessionTracker,
  stubTracker,
  WRITE_CALLBACK_PREFIXES,
  type ApiCall,
} from './testing';
import {
  MODE_CONFIRM_CALLBACK_DATA,
  MODE_DEMO_CALLBACK_DATA,
  MODE_REAL_CALLBACK_DATA,
  MODE_SCREEN_CALLBACK_DATA,
} from './trading-mode';
import { LABELS, TEXTS, tradingModeConfirm, tradingModeScreen } from './texts';

interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

function setup(
  options: {
    readTradingAccess?: BackendClient['readTradingAccess'];
    setTradingMode?: BackendClient['setTradingMode'];
  } = {},
) {
  const readTradingAccess = vi.fn(
    options.readTradingAccess ?? (() => Promise.resolve(ACCESS_VIEW)),
  );
  const setTradingMode = vi.fn<BackendClient['setTradingMode']>(
    options.setTradingMode ??
      ((_id, tradingMode) => Promise.resolve({ tradingMode, changed: true })),
  );
  const logger = fakeLogger();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ readTradingAccess, setTradingMode }),
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  const press = (data: string) => bot.handleUpdate(callbackUpdate(data));
  return { press, logger, readTradingAccess, setTradingMode, ...api };
}

const methods = (calls: readonly ApiCall[]) => calls.map((call) => call.method);
const lastPayload = (calls: readonly ApiCall[]) =>
  calls.filter((call) => ['editMessageText', 'sendMessage'].includes(call.method)).at(-1)?.payload;
const rowsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  (payload?.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? [];
const button = (text: string, callback_data: string): Button => ({ text, callback_data });
const lines = (logger: ReturnType<typeof fakeLogger>, level: 'warn' | 'error') =>
  logger[level].mock.calls.map((call) => call[1] as string);

const MENU = [button(LABELS.menuButton, MENU_CALLBACK_DATA)];
const SCREEN_AND_MENU = [[button(LABELS.modeScreenButton, MODE_SCREEN_CALLBACK_DATA)], MENU];
const REAL = accessView({ tradingMode: TradeMode.Real });
const EDIT_GONE: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message to edit not found',
};
const httpError = (status: number, reason?: string) =>
  new BackendError(BackendErrorCode.HttpStatus, {
    status,
    ...(reason === undefined ? {} : { reason }),
  });

describe('the mode screen (#121)', () => {
  it('opens as a new message: the mode, the real balance, the minimum and the enable step', async () => {
    const { press, calls, readTradingAccess } = setup();
    await press(MODE_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(readTradingAccess.mock.calls).toEqual([[String(USER.id)]]);
    const sent = lastPayload(calls);
    expect(sent?.text).toBe(
      tradingModeScreen({ mode: TradeMode.Demo, broker: ACCESS_VIEW.broker, tradingOpen: true })
        .value,
    );
    expect(plainTextOf(sent?.text as string)).toBe(
      [
        '⚙️ Режим торговли',
        'Сейчас: DEMO',
        '💵 Реальный баланс: $0.00',
        'Минимальная ставка брокера: $1.00',
        '',
        plainTextOf(TEXTS.modeWarning),
      ].join('\n'),
    );
    expect(rowsOf(sent)).toEqual([
      [button(LABELS.modeEnableButton, MODE_CONFIRM_CALLBACK_DATA)],
      MENU,
    ]);
  });

  it('offers the way back to demo in real mode', async () => {
    const { press, calls } = setup({ readTradingAccess: () => Promise.resolve(REAL) });
    await press(MODE_CALLBACK_DATA);
    expect(plainTextOf(lastPayload(calls)?.text as string)).toContain('Сейчас: REAL');
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA)],
      MENU,
    ]);
  });

  it('adds the paused line while the switch is closed, and still offers the enable step', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingOpen: false })),
    });
    await press(MODE_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toContain(TEXTS.modePaused.value);
    expect(rowsOf(lastPayload(calls))[0]).toEqual([
      button(LABELS.modeEnableButton, MODE_CONFIRM_CALLBACK_DATA),
    ]);
  });

  it.each([
    [
      BrokerBalanceUnavailableReason.NoAccount,
      TEXTS.accountNone,
      [[button(LABELS.connectButton, CONNECT_CALLBACK_DATA)], MENU],
    ],
    [BrokerBalanceUnavailableReason.AmbiguousAccount, TEXTS.statusAmbiguous, [MENU]],
    [BrokerBalanceUnavailableReason.Refreshing, TEXTS.stakeBalanceMissing, [MENU]],
  ])('without a balance (%s) says why and offers no enable step', async (reason, text, rows) => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ broker: null, brokerUnavailable: reason })),
    });
    await press(MODE_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(text.value);
    expect(rowsOf(lastPayload(calls))).toEqual(rows);
  });

  it('keeps the way back to demo for a user in real mode without a balance', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            tradingMode: TradeMode.Real,
            broker: null,
            brokerUnavailable: BrokerBalanceUnavailableReason.AccountRevoked,
          }),
        ),
    });
    await press(MODE_CALLBACK_DATA);
    const text = plainTextOf(lastPayload(calls)?.text as string);
    expect(text).toContain('Сейчас: REAL');
    expect(text).not.toContain('Реальный баланс');
    expect(rowsOf(lastPayload(calls))[0]).toEqual([
      button(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA),
    ]);
  });

  it('sends a blocked user to support', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ status: UserStatus.Blocked })),
    });
    await press(MODE_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.blocked.value);
    expect(rowsOf(lastPayload(calls))).toEqual([
      [{ text: LABELS.supportButton, url: supportUrl() }],
    ]);
  });

  it('says the service is unavailable and warns when access is not read', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(MODE_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    expect(lines(logger, 'warn')).toEqual(['trading access not read for the mode screen']);
  });
});

describe('the confirm step (#121)', () => {
  it('names the broker minimum the real trade stakes, in place', async () => {
    const { press, calls } = setup();
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(lastPayload(calls)?.text).toBe(
      tradingModeConfirm(ACCESS_VIEW.broker!.minTradeAmount).value,
    );
    expect(plainTextOf(lastPayload(calls)?.text as string)).toBe(
      'Включить реальный режим? Сделки пойдут на реальные деньги по минимальной ставке брокера ($1.00).',
    );
    expect(rowsOf(lastPayload(calls))).toEqual([
      [
        button(LABELS.modeConfirmButton, MODE_REAL_CALLBACK_DATA),
        button(LABELS.modeCancelButton, MODE_SCREEN_CALLBACK_DATA),
      ],
    ]);
  });

  it('draws the screen instead for a user already in real mode', async () => {
    const { press, calls } = setup({ readTradingAccess: () => Promise.resolve(REAL) });
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(rowsOf(lastPayload(calls))[0]).toEqual([
      button(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA),
    ]);
  });

  it('sends the confirm anew when the message is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
  });
});

// Plan Update 4 (review round 1, Major 1): «↩️ Отмена» and «⚙️ Режим» redraw the screen in place,
// so a cancelled confirm keeps no «✅ Подтверждаю»
describe('the screen in place (#121, `mode:x`)', () => {
  const carries = (payload: Record<string, unknown> | undefined, data: string) =>
    rowsOf(payload).some((row) => row.some((b) => b.callback_data === data));

  it('«↩️ Отмена» edits the confirm into the screen and sends nothing new', async () => {
    const { press, calls } = setup();
    await press(MODE_CONFIRM_CALLBACK_DATA);
    calls.length = 0;
    await press(MODE_SCREEN_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = lastPayload(calls);
    expect(edited?.text).toBe(
      tradingModeScreen({ mode: TradeMode.Demo, broker: ACCESS_VIEW.broker, tradingOpen: true })
        .value,
    );
    expect(carries(edited, MODE_REAL_CALLBACK_DATA)).toBe(false);
    expect(rowsOf(edited)[0]).toEqual([
      button(LABELS.modeEnableButton, MODE_CONFIRM_CALLBACK_DATA),
    ]);
  });

  it('«⚙️ Режим» under a refusal edits that message into the screen', async () => {
    const { press, calls } = setup({
      setTradingMode: () => Promise.reject(httpError(409, 'real_balance_below_minimum')),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    calls.length = 0;
    await press(MODE_SCREEN_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(plainTextOf(lastPayload(calls)?.text as string)).toContain('Сейчас: DEMO');
  });

  it('sends the screen anew when the message is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(MODE_SCREEN_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
  });

  it('is a read: no write prefix covers it', () => {
    expect(
      WRITE_CALLBACK_PREFIXES.some((prefix) => MODE_SCREEN_CALLBACK_DATA.startsWith(prefix)),
    ).toBe(false);
  });
});

describe('the switches (#121)', () => {
  it.each([
    [MODE_REAL_CALLBACK_DATA, TradeMode.Real, TEXTS.modeEnabled],
    [MODE_DEMO_CALLBACK_DATA, TradeMode.Demo, TEXTS.modeDisabled],
  ])('%s switches to %s and says so with the menu', async (data, mode, text) => {
    const { press, calls, setTradingMode, logger } = setup();
    await press(data);
    expect(setTradingMode.mock.calls).toEqual([[String(USER.id), mode]]);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(lastPayload(calls)?.text).toBe(text.value);
    expect(rowsOf(lastPayload(calls))).toEqual([MENU]);
    expect(lines(logger, 'warn')).toEqual([]);
  });

  it('names the mode the server answered, not the one pressed', async () => {
    const { press, calls } = setup({
      setTradingMode: () => Promise.resolve({ tradingMode: TradeMode.Demo, changed: false }),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.modeDisabled.value);
  });

  it.each([
    ['real_balance_below_minimum', 409, TEXTS.modeBelowMinimum],
    ['balance_unavailable', 409, TEXTS.stakeBalanceMissing],
    ['demo_only', 409, TEXTS.tradingDemoOnly],
  ])('answers %s with its text and «⚙️ Режим», logging nothing', async (reason, status, text) => {
    const { press, calls, logger } = setup({
      setTradingMode: () => Promise.reject(httpError(status, reason)),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(text.value);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    expect(lines(logger, 'warn')).toEqual([]);
    expect(lines(logger, 'error')).toEqual([]);
  });

  it('answers user_not_found as unavailable with a warning', async () => {
    const { press, calls, logger } = setup({
      setTradingMode: () => Promise.reject(httpError(404, 'user_not_found')),
    });
    await press(MODE_DEMO_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    expect(lines(logger, 'warn')).toEqual(['trading mode not changed']);
  });

  it('answers any other 4xx as unavailable with an error', async () => {
    const { press, calls, logger } = setup({
      setTradingMode: () => Promise.reject(httpError(400, 'validation')),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(lines(logger, 'error')).toEqual(['trading mode not changed']);
  });

  // the UPDATE may have committed: the bot reads the mode the backend has rather than infer it
  it.each([
    ['a 5xx', httpError(500)],
    ['no answer', new BackendError(BackendErrorCode.Unreachable)],
    ['a broken body', new BackendError(BackendErrorCode.ContractViolation)],
  ])(
    'reads access again on %s and draws the screen with the mode it finds',
    async (_case, error) => {
      const { press, calls, logger, readTradingAccess } = setup({
        setTradingMode: () => Promise.reject(error),
        readTradingAccess: () => Promise.resolve(REAL),
      });
      await press(MODE_REAL_CALLBACK_DATA);
      expect(readTradingAccess).toHaveBeenCalledTimes(1);
      expect(plainTextOf(lastPayload(calls)?.text as string)).toContain('Сейчас: REAL');
      expect(rowsOf(lastPayload(calls))[0]).toEqual([
        button(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA),
      ]);
      expect(lines(logger, 'warn')).toEqual(['trading mode outcome unknown']);
    },
  );

  it('says the outcome is unknown when that read fails too', async () => {
    const { press, calls, logger } = setup({
      setTradingMode: () => Promise.reject(httpError(503)),
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.modeOutcomeUnknown.value);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    expect(lines(logger, 'warn')).toEqual([
      'trading mode outcome unknown',
      'trading access not read for the mode screen',
    ]);
  });

  it('sends the result anew when the message is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(MODE_DEMO_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(lastPayload(calls)?.text).toBe(TEXTS.modeDisabled.value);
  });
});
