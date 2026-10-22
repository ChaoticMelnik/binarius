import { describe, expect, it, vi } from 'vitest';
import {
  BrokerBalanceUnavailableReason,
  ButtonRole,
  CONNECT_CALLBACK_DATA,
  decimalStringSchema,
  MENU_CALLBACK_DATA,
  plainTextOf,
  supportUrl,
  TradeMode,
  TradingModeErrorCode,
  UserStatus,
  type BrokerBalanceView,
  MODE_CALLBACK_DATA,
} from '@binarius/shared';
import type { ApiError } from 'grammy/types';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  ACCESS_VIEW,
  BOT_INFO,
  TEXT_CARD_MESSAGE_ID,
  USER,
  accessView,
  brokerBalance,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  messageAnswer,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  WRITE_CALLBACK_PREFIXES,
  type ApiCall,
  inlineRoles,
  inlineRows,
  inlineStyles,
} from './testing';
import {
  MODE_CONFIRM_CALLBACK_DATA,
  MODE_DEMO_CALLBACK_DATA,
  MODE_REAL_CALLBACK_DATA,
  MODE_SCREEN_CALLBACK_DATA,
  SWITCH_REFUSALS,
} from './trading-mode';
import { LABELS, TEXTS, tradingModeConfirm, tradingModeScreen } from './texts';

interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

const d = (value: string) => decimalStringSchema.parse(value);
// ACCESS_VIEW's real balance is 0, below its minimum of 1: a demo user who can switch has money
const real = (available: string): BrokerBalanceView['real'] => ({
  available: d(available),
  held: d('0'),
  total: d(available),
});
const FUNDED = accessView({ broker: brokerBalance({ real: real('100') }) });
const REAL = accessView({
  tradingMode: TradeMode.Real,
  broker: brokerBalance({ real: real('100') }),
});

function setup(
  options: {
    readTradingAccess?: BackendClient['readTradingAccess'];
    setTradingMode?: BackendClient['setTradingMode'];
  } = {},
) {
  const readTradingAccess = vi.fn<BackendClient['readTradingAccess']>(
    options.readTradingAccess ?? (() => Promise.resolve(FUNDED)),
  );
  const setTradingMode = vi.fn<BackendClient['setTradingMode']>(
    options.setTradingMode ??
      ((_id, tradingMode) => Promise.resolve({ tradingMode, changed: true, stoppedSessions: 0 })),
  );
  const logger = fakeLogger();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ readTradingAccess, setTradingMode }),
    logger,
    botInfo: BOT_INFO,
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  const press = (data: string) => bot.handleUpdate(callbackUpdate(data));
  return { press, logger, readTradingAccess, setTradingMode, ...api };
}

const methods = (calls: readonly ApiCall[]) => calls.map((call) => call.method);
const lastPayload = (calls: readonly ApiCall[]) =>
  calls.filter((call) => ['editMessageText', 'sendMessage'].includes(call.method)).at(-1)?.payload;
const lastText = (calls: readonly ApiCall[]) => plainTextOf(lastPayload(calls)?.text as string);
const rowsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  inlineRows(payload) as Button[][];
const carries = (payload: Record<string, unknown> | undefined, data: string) =>
  rowsOf(payload).some((row) => row.some((b) => b.callback_data === data));
const button = (text: string, callback_data: string): Button => ({ text, callback_data });
const lines = (logger: ReturnType<typeof fakeLogger>, level: 'warn' | 'error') =>
  logger[level].mock.calls.map((call) => call[1] as string);

const MENU = [button(LABELS.menuButton, MENU_CALLBACK_DATA)];
// #475: the way back and the menu in one row
const SCREEN_AND_MENU = [[button(LABELS.modeScreenButton, MODE_SCREEN_CALLBACK_DATA), ...MENU]];
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
const STOPS_SESSION = plainTextOf(TEXTS.modeStopsSession);
const SESSION_STOPPED = plainTextOf(TEXTS.modeSessionStopped);
const OUT_OF_BOUNDS_MARK = 'сейчас не подходит к реальному счёту';
// the result's first line: the session line under it is MW1's and MW2's

describe('the mode screen (#474)', () => {
  it('MS1 opens as a new message: the mode, the real balance, the real stake, the warnings', async () => {
    const { press, calls, readTradingAccess } = setup({
      readTradingAccess: () => Promise.resolve({ ...FUNDED, realStake: d('7'), demoStake: d('3') }),
    });
    await press(MODE_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(readTradingAccess.mock.calls).toEqual([[String(USER.id)]]);
    const sent = lastPayload(calls);
    expect(sent?.text).toBe(
      tradingModeScreen({
        mode: TradeMode.Demo,
        broker: FUNDED.broker,
        realStake: d('7'),
        tradingOpen: true,
      }).value,
    );
    expect(lastText(calls)).toBe(
      [
        '⚙️ Режим торговли',
        'Сейчас: DEMO',
        '💵 Реальный баланс: $100.00',
        '💼 Сумма реальной сделки: $7.00',
        '',
        '⚠️ В реальном режиме сделки и сессии идут на реальные деньги. В сессии ставка растёт после проигрыша. Вернуться в демо можно здесь же или командой /stop.',
        STOPS_SESSION,
      ].join('\n'),
    );
    // the way back out of real (#473)
    expect(lastText(calls)).toContain('Вернуться в демо можно здесь же или командой /stop.');
    expect(rowsOf(sent)).toEqual([
      [button(LABELS.modeEnableButton, MODE_CONFIRM_CALLBACK_DATA)],
      MENU,
    ]);
    // #475 Plan Update: the enable step is the screen's step forward, green on its own row
    expect(inlineRoles(sent)).toEqual([[ButtonRole.Forward], [ButtonRole.Nav]]);
    expect(inlineStyles(sent)).toEqual([['success'], [null]]);
  });

  it('MS1b names the broker minimum as the real stake when none is saved, and a stale balance as such', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            broker: brokerBalance({ real: real('100'), fresh: false, restSnapshotAgeSec: 600 }),
          }),
        ),
    });
    await press(MODE_CALLBACK_DATA);
    expect(lastText(calls)).toContain('💼 Сумма реальной сделки: $1.00');
    expect(lastText(calls)).toContain('💵 Реальный баланс: нет свежих данных');
  });

  it('MS2 offers the way back to demo in real mode, without a balance too', async () => {
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
    expect(lastText(calls)).toContain('Сейчас: REAL');
    expect(lastText(calls)).not.toContain('Реальный баланс');
    expect(lastText(calls)).not.toContain('Сумма реальной сделки');
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA), ...MENU],
    ]);
    // #475 Plan Update: «🎮 В демо» secondary beside the menu
    expect(inlineRoles(lastPayload(calls))).toEqual([[ButtonRole.Secondary, ButtonRole.Nav]]);
    expect(inlineStyles(lastPayload(calls))).toEqual([['primary', null]]);
  });

  it('MS3 adds the paused line while the switch is closed, and still offers the enable step', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve({ ...FUNDED, tradingOpen: false }),
    });
    await press(MODE_CALLBACK_DATA);
    expect(lastText(calls).split('\n').at(-1)).toBe(plainTextOf(TEXTS.modePaused));
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
  ])(
    'MS4 without a balance (%s) in demo says why and offers no enable step',
    async (reason, text, rows) => {
      const { press, calls } = setup({
        readTradingAccess: () =>
          Promise.resolve(accessView({ broker: null, brokerUnavailable: reason })),
      });
      await press(MODE_CALLBACK_DATA);
      expect(lastPayload(calls)?.text).toBe(text.value);
      expect(rowsOf(lastPayload(calls))).toEqual(rows);
    },
  );

  it('MS4 sends a blocked user to support', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ status: UserStatus.Blocked })),
    });
    await press(MODE_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.blocked.value);
    expect(rowsOf(lastPayload(calls))).toEqual([
      [{ text: LABELS.supportButton, url: supportUrl() }],
    ]);
  });

  it('MS4 says the service is unavailable and warns when access is not read', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(MODE_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    expect(lines(logger, 'warn')).toEqual(['trading access not read for the mode screen']);
  });
});

describe('the confirm step (#474)', () => {
  it('MC1 names the saved real stake, not the demo one, in place', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve({ ...FUNDED, realStake: d('7'), demoStake: d('3') }),
    });
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(lastPayload(calls)?.text).toBe(
      tradingModeConfirm({
        stake: d('7'),
        minTradeAmount: FUNDED.broker!.minTradeAmount,
        realAvailable: d('100'),
        outOfBounds: false,
      }).value,
    );
    expect(lastText(calls).split('\n')[0]).toBe(
      'Включить реальный режим? Сделки пойдут на реальные деньги на сумму $7.00.',
    );
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.modeConfirmButton, MODE_REAL_CALLBACK_DATA)],
      [button(LABELS.modeCancelButton, MODE_SCREEN_CALLBACK_DATA)],
    ]);
    expect(inlineStyles(lastPayload(calls))).toEqual([['success'], [null]]);
  });

  it('MC2 names the broker minimum without a saved real stake', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve({ ...FUNDED, demoStake: d('3') }),
    });
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(lastText(calls).split('\n')[0]).toBe(
      'Включить реальный режим? Сделки пойдут на реальные деньги на сумму $1.00.',
    );
  });

  it('MC3 refuses at once with the real balance below the minimum: no confirm, no switch', async () => {
    const { press, calls, setTradingMode } = setup({
      readTradingAccess: () => Promise.resolve(ACCESS_VIEW),
    });
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.modeBelowMinimum.value);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    expect(carries(lastPayload(calls), MODE_REAL_CALLBACK_DATA)).toBe(false);
    expect(setTradingMode).not.toHaveBeenCalled();
  });

  it('MC3b lets a real balance equal to the minimum through to the confirm', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ broker: brokerBalance({ real: real('1') }) })),
    });
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(carries(lastPayload(calls), MODE_REAL_CALLBACK_DATA)).toBe(true);
  });

  it('MC4 warns about a saved real stake above the balance and still offers the switch', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve({ ...FUNDED, realStake: d('250') }),
    });
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(lastText(calls).split('\n')).toEqual([
      'Включить реальный режим? Сделки пойдут на реальные деньги на сумму $250.00.',
      `⚠️ Сумма $250.00 ${OUT_OF_BOUNDS_MARK} (доступно $100.00, минимум $1.00) — сделки будут отклоняться, пока не изменишь её в /settings → «${LABELS.settingsStakeRealButton}».`,
      STOPS_SESSION,
    ]);
    expect(carries(lastPayload(calls), MODE_REAL_CALLBACK_DATA)).toBe(true);
  });

  it('MC5 adds no warning for a saved real stake within the bounds', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve({ ...FUNDED, realStake: d('100') }),
    });
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(lastText(calls)).not.toContain(OUT_OF_BOUNDS_MARK);
  });

  it('MC6 says on the screen and in the confirm that a switch stops the active session', async () => {
    const { press, calls } = setup();
    await press(MODE_CALLBACK_DATA);
    expect(lastText(calls).split('\n')).toContain(STOPS_SESSION);
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(lastText(calls).split('\n').at(-1)).toBe(STOPS_SESSION);
  });

  it('MC7 draws the screen instead for a user already in real mode', async () => {
    const { press, calls } = setup({ readTradingAccess: () => Promise.resolve(REAL) });
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(lastText(calls)).toContain('Сейчас: REAL');
    expect(rowsOf(lastPayload(calls))[0]).toEqual([
      button(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA),
      ...MENU,
    ]);
  });

  it('sends the confirm anew when the message is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(MODE_CONFIRM_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
  });
});

describe('the screen in place (#474, `mode:x`)', () => {
  it('MX1 «↩️ Отмена» edits the confirm into the screen and sends nothing new', async () => {
    const { press, calls } = setup();
    await press(MODE_CONFIRM_CALLBACK_DATA);
    calls.length = 0;
    await press(MODE_SCREEN_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edited = lastPayload(calls);
    expect(edited?.text).toBe(
      tradingModeScreen({
        mode: TradeMode.Demo,
        broker: FUNDED.broker,
        realStake: null,
        tradingOpen: true,
      }).value,
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
    expect(lastText(calls)).toContain('Сейчас: DEMO');
  });

  it('sends the screen anew when the message is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(MODE_SCREEN_CALLBACK_DATA);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
  });

  it('is a read, as the confirm is: no write prefix covers them', () => {
    for (const data of [
      MODE_CALLBACK_DATA,
      MODE_SCREEN_CALLBACK_DATA,
      MODE_CONFIRM_CALLBACK_DATA,
    ]) {
      expect(
        WRITE_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix)),
        data,
      ).toBe(false);
    }
  });
});

describe('the switches (#474)', () => {
  it('MW1 says the switch stopped the active session when it did', async () => {
    const { press, calls } = setup({
      setTradingMode: () =>
        Promise.resolve({ tradingMode: TradeMode.Real, changed: true, stoppedSessions: 1 }),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(lastText(calls).split('\n')).toEqual([plainTextOf(TEXTS.modeEnabled), SESSION_STOPPED]);
  });

  it('MW2 says nothing about a session when none was stopped', async () => {
    const { press, calls } = setup({
      setTradingMode: () =>
        Promise.resolve({ tradingMode: TradeMode.Demo, changed: true, stoppedSessions: 0 }),
    });
    await press(MODE_DEMO_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.modeDisabled.value);
  });

  it.each([
    [MODE_REAL_CALLBACK_DATA, TradeMode.Real, TEXTS.modeEnabled],
    [MODE_DEMO_CALLBACK_DATA, TradeMode.Demo, TEXTS.modeDisabled],
  ])('MW3 %s switches to %s with one press and says so with the menu', async (data, mode, text) => {
    const { press, calls, setTradingMode, logger, readTradingAccess } = setup();
    await press(data);
    expect(setTradingMode.mock.calls).toEqual([[String(USER.id), mode]]);
    expect(readTradingAccess).not.toHaveBeenCalled();
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(lastText(calls).split('\n')[0]).toBe(plainTextOf(text));
    expect(rowsOf(lastPayload(calls))).toEqual([MENU]);
    expect(lines(logger, 'warn')).toEqual([]);
  });

  it('MW4 names the mode the server answered, not the one pressed', async () => {
    const { press, calls } = setup({
      setTradingMode: () =>
        Promise.resolve({ tradingMode: TradeMode.Demo, changed: false, stoppedSessions: 0 }),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(lastText(calls).split('\n')[0]).toBe(plainTextOf(TEXTS.modeDisabled));
  });

  it('MW5 maps every refusal code of the contract to a text', () => {
    expect(Object.keys(SWITCH_REFUSALS).sort()).toEqual(Object.values(TradingModeErrorCode).sort());
  });

  it.each([
    ['real_balance_below_minimum', 409, TEXTS.modeBelowMinimum],
    ['balance_unavailable', 409, TEXTS.stakeBalanceMissing],
    ['demo_only', 409, TEXTS.tradingDemoOnly],
  ])(
    'MW5 answers %s with its text and «⚙️ Режим», logging nothing',
    async (reason, status, text) => {
      const { press, calls, logger } = setup({
        setTradingMode: () => Promise.reject(httpError(status, reason)),
      });
      await press(MODE_REAL_CALLBACK_DATA);
      expect(lastPayload(calls)?.text).toBe(text.value);
      expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
      expect(lines(logger, 'warn')).toEqual([]);
      expect(lines(logger, 'error')).toEqual([]);
    },
  );

  it('MW5 says real trades are off on a DEMO_ONLY server', async () => {
    const { press, calls } = setup({
      setTradingMode: () => Promise.reject(httpError(409, 'demo_only')),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(lastText(calls)).toContain('Реальные сделки на этом сервере отключены');
  });

  it('MW5 answers user_not_found as unavailable with a warning', async () => {
    const { press, calls, logger } = setup({
      setTradingMode: () => Promise.reject(httpError(404, 'user_not_found')),
    });
    await press(MODE_DEMO_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    expect(lines(logger, 'warn')).toEqual(['trading mode not changed']);
  });

  it.each([
    ['a 400', httpError(400, 'validation')],
    ['a 409 outside the contract', httpError(409, 'something_else')],
  ])('MW5 answers %s as unavailable with an error', async (_case, error) => {
    const { press, calls, logger, readTradingAccess } = setup({
      setTradingMode: () => Promise.reject(error),
    });
    await press(MODE_REAL_CALLBACK_DATA);
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(rowsOf(lastPayload(calls))).toEqual(SCREEN_AND_MENU);
    expect(lines(logger, 'error')).toEqual(['trading mode not changed']);
    expect(readTradingAccess).not.toHaveBeenCalled();
  });

  // the UPDATE may have committed: the bot reads the mode the backend has rather than infer it
  it.each([
    ['a 500', httpError(500)],
    ['a 503', httpError(503)],
    ['no answer', new BackendError(BackendErrorCode.Unreachable)],
    ['a broken body', new BackendError(BackendErrorCode.ContractViolation)],
  ])(
    'MW6 reads access again on %s and draws the screen with the mode it finds',
    async (_case, error) => {
      const { press, calls, logger, readTradingAccess, setTradingMode } = setup({
        setTradingMode: () => Promise.reject(error),
        readTradingAccess: () => Promise.resolve(REAL),
      });
      await press(MODE_REAL_CALLBACK_DATA);
      expect(setTradingMode).toHaveBeenCalledTimes(1);
      expect(readTradingAccess).toHaveBeenCalledTimes(1);
      expect(lastText(calls)).toContain('Сейчас: REAL');
      expect(lastText(calls)).not.toContain(SESSION_STOPPED);
      expect(rowsOf(lastPayload(calls))[0]).toEqual([
        button(LABELS.modeBackDemoButton, MODE_DEMO_CALLBACK_DATA),
        ...MENU,
      ]);
      expect(lines(logger, 'warn')).toEqual(['trading mode outcome unknown']);
    },
  );

  // the client throws ContractViolation for a 2xx without stoppedSessions (backend-client.test.ts)
  it('MW8 takes a body outside the contract for an unknown outcome, not a refusal', async () => {
    const { press, calls, logger, readTradingAccess } = setup({
      setTradingMode: () => Promise.reject(new BackendError(BackendErrorCode.ContractViolation)),
    });
    await press(MODE_DEMO_CALLBACK_DATA);
    expect(readTradingAccess).toHaveBeenCalledTimes(1);
    expect(lastText(calls)).toContain('Сейчас: DEMO');
    expect(lines(logger, 'error')).toEqual([]);
    expect(lines(logger, 'warn')).toEqual(['trading mode outcome unknown']);
  });

  it('MW7 says the outcome is unknown when that read fails too', async () => {
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
    expect(lastText(calls).split('\n')[0]).toBe(plainTextOf(TEXTS.modeDisabled));
  });
});

// Rule 31: every message of the screen leaves a next step, and none after a failure carries a
// switch, a write, so no «🔄 Повторить» or other button repeats one
describe('the next step under every failure (#474)', () => {
  it.each([
    ['a refusal', () => Promise.reject(httpError(409, 'demo_only'))],
    ['a not-found', () => Promise.reject(httpError(404, 'user_not_found'))],
    ['a contract error', () => Promise.reject(httpError(400, 'validation'))],
    ['an unknown outcome with no read', () => Promise.reject(httpError(500))],
  ] as const)(
    'MR1 after %s offers «⚙️ Режим» and the menu, never a switch',
    async (_case, fail) => {
      const { press, calls } = setup({
        setTradingMode: fail,
        readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      });
      for (const data of [MODE_REAL_CALLBACK_DATA, MODE_DEMO_CALLBACK_DATA]) {
        calls.length = 0;
        await press(data);
        const payload = lastPayload(calls);
        expect(rowsOf(payload)).toEqual(SCREEN_AND_MENU);
        expect(carries(payload, MODE_REAL_CALLBACK_DATA)).toBe(false);
        expect(carries(payload, MODE_DEMO_CALLBACK_DATA)).toBe(false);
      }
    },
  );
});
