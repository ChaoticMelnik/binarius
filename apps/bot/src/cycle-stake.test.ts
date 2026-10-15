import { describe, expect, it, vi } from 'vitest';
import {
  CONNECT_CALLBACK_DATA,
  decimalStringSchema,
  plainTextOf,
  StakeErrorCode,
  TradeMode,
  TradingSessionErrorCode,
  type DecimalString,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  CYCLE_STAKE_PATTERN,
  cycleCustomCallbackData,
  cycleStakeCallbackData,
  demoAnalysisCallbackData,
  demoLaunchCallbackData,
  demoSignalsCallbackData,
  SESSION_START_PATTERN,
} from './demo';
import { createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  BOT_INFO,
  PAIR_EURUSD,
  PAIRS_RESPONSE,
  SESSION_VIEW,
  TEXT_CARD_MESSAGE_ID,
  USER,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  messageAnswer,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  type ApiCall,
} from './testing';
import { LABELS, sessionStatusText, TEXTS, textOf } from './texts';
import { START_REFUSALS } from './trading-session';

// The amount screen's presses (#476, cycle-stake.ts) through createBot: the save, then the start,
// the refusals of each, and the typed amount's step.

interface Button {
  text: string;
  callback_data?: string;
}

const d = (value: string): DecimalString => decimalStringSchema.parse(value);
const PRESS = cycleStakeCallbackData(PAIR_EURUSD.id, 15, '5', 'l');
const ON_STEP: LoginDialogState = {
  step: 'cycleStake',
  assetId: PAIR_EURUSD.id,
  durationSec: 15,
  back: 'l',
};
const BACK_LIST = { text: LABELS.backToListButton, callback_data: demoSignalsCallbackData(15) };
const AMOUNTS_AGAIN = {
  text: LABELS.stakeMenuButton,
  callback_data: demoLaunchCallbackData(PAIR_EURUSD.id, 15, 'n'),
};
const STARTED = {
  telegramUserId: String(USER.id),
  mode: TradeMode.Demo,
  assetId: PAIR_EURUSD.id,
  durationSec: 15,
  trades: 5,
};
const httpError = (status: number, reason: string) =>
  new BackendError(BackendErrorCode.HttpStatus, { status, reason });
const unreachable = () => Promise.reject(new BackendError(BackendErrorCode.Unreachable));

function setup(
  options: {
    setStake?: BackendClient['setStake'];
    startSession?: BackendClient['startSession'];
    dialog?: LoginDialogState;
  } = {},
) {
  const setStake = vi.fn<BackendClient['setStake']>(
    options.setStake ?? ((_id, _mode, amount) => Promise.resolve({ saved: amount })),
  );
  const startSession = vi.fn<BackendClient['startSession']>(
    options.startSession ?? (() => Promise.resolve({ started: SESSION_VIEW })),
  );
  const readPairs = vi.fn(() => Promise.resolve(PAIRS_RESPONSE));
  const logger = fakeLogger();
  const loginDialog = createLoginDialog();
  if (options.dialog !== undefined) loginDialog.set(USER.id, options.dialog);
  const sessionTracker = stubSessionTracker();
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ setStake, startSession, readPairs }),
    logger,
    botInfo: BOT_INFO,
    loginDialog,
    intentTracker: stubTracker(),
    sessionTracker,
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  return {
    press: (data: string) => bot.handleUpdate(callbackUpdate(data)),
    type: (text: string) => bot.handleUpdate(textUpdate(text)),
    setStake,
    startSession,
    readPairs,
    logger,
    loginDialog,
    sessionTracker,
    ...api,
  };
}

const methods = (calls: readonly ApiCall[]) => calls.map((call) => call.method);
const payloadOf = (calls: readonly ApiCall[], method: string) =>
  calls.find((call) => call.method === method)?.payload;
const rowsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  (payload?.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? [];
const warnings = (logger: ReturnType<typeof fakeLogger>) =>
  logger.warn.mock.calls.map((call) => call[1] as string);
const STATUS = sessionStatusText(PAIR_EURUSD.symbol, SESSION_VIEW).value;

describe('an amount of the amount screen', () => {
  it('saves the amount as the demo stake, then starts the cycle (C-save)', async () => {
    const { press, setStake, startSession, calls, sessionTracker } = setup();
    await press(PRESS);
    expect(setStake.mock.calls).toEqual([[String(USER.id), TradeMode.Demo, '5']]);
    expect(startSession.mock.calls).toEqual([[STARTED]]);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(STATUS);
    expect(sessionTracker.track).toHaveBeenCalledTimes(1);
  });

  it('starts only once the save has answered (C-order)', async () => {
    const { press, setStake, startSession } = setup();
    await press(PRESS);
    expect(setStake.mock.invocationCallOrder[0]).toBeLessThan(
      startSession.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('deletes the amount screen after the status is sent (C-delete)', async () => {
    const { press, calls } = setup();
    await press(PRESS);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage', 'deleteMessage']);
  });

  it('keeps the analysis way back in the data of a screen drawn from the analysis', async () => {
    const { press, setStake, startSession } = setup();
    await press(cycleStakeCallbackData(PAIR_EURUSD.id, 5, '2.5', 'a'));
    expect(setStake.mock.calls).toEqual([[String(USER.id), TradeMode.Demo, '2.5']]);
    expect(startSession.mock.calls[0]?.[0]).toMatchObject({ durationSec: 5 });
  });

  it('starts nothing on a refused save and says why, with the amounts again (C-bounds)', async () => {
    const { press, startSession, calls } = setup({
      setStake: () =>
        Promise.resolve({
          refused: {
            error: 'insufficient_balance',
            limits: { minTradeAmount: d('1'), available: d('3'), scale: 2 },
          },
        }),
    });
    await press(PRESS);
    expect(startSession).not.toHaveBeenCalled();
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(
      TEXTS.stakeAboveAvailableAmount({ demoAvailable: d('3'), minStake: d('1') }).value,
    );
    expect(rowsOf(sent)).toEqual([[AMOUNTS_AGAIN], [BACK_LIST]]);
  });

  it('starts nothing on a save of unknown outcome, and warns', async () => {
    const { press, startSession, calls, logger } = setup({ setStake: unreachable });
    await press(PRESS);
    expect(startSession).not.toHaveBeenCalled();
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(TEXTS.stakeSaveUnknown.value);
    expect(rowsOf(sent)).toEqual([[AMOUNTS_AGAIN], [BACK_LIST]]);
    expect(warnings(logger)).toEqual(['stake save outcome unknown']);
  });

  it('says the balance is missing on balance_unavailable', async () => {
    const { press, startSession, calls } = setup({
      setStake: () => Promise.reject(httpError(409, StakeErrorCode.BalanceUnavailable)),
    });
    await press(PRESS);
    expect(startSession).not.toHaveBeenCalled();
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.stakeBalanceMissing.value);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual([[BACK_LIST]]);
  });

  it.each([
    ['a user before /start', 'warn', httpError(404, StakeErrorCode.UserNotFound)],
    ['an answer the bot never provokes', 'error', httpError(400, 'invalid_request')],
  ] as const)('says unavailable for %s and logs it at %s', async (_label, level, error) => {
    const { press, startSession, calls, logger } = setup({ setStake: () => Promise.reject(error) });
    await press(PRESS);
    expect(startSession).not.toHaveBeenCalled();
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(logger[level].mock.calls.map((call) => call[1])).toEqual(['stake not saved']);
  });

  it('asks the start once on an unknown outcome and keeps the screen (C-unknown)', async () => {
    const { press, startSession, calls } = setup({ startSession: unreachable });
    await press(PRESS);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.sessionOutcomeUnknown.value);
  });

  it('shows the running session on a second press (C-double)', async () => {
    const { press, calls, setStake } = setup({
      startSession: () => Promise.resolve({ active: SESSION_VIEW }),
    });
    await press(cycleStakeCallbackData(PAIR_EURUSD.id, 15, '10', 'l'));
    // the amount is saved even so (accepted risk 2 of the plan): the session keeps its own
    expect(setStake).toHaveBeenCalledTimes(1);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(STATUS);
  });

  it('says the session just ended when the active one is gone (C-null)', async () => {
    const { press, calls } = setup({ startSession: () => Promise.resolve({ active: null }) });
    await press(PRESS);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.sessionJustEnded.value);
    expect(rowsOf(payloadOf(calls, 'sendMessage')).flat()).toContainEqual({
      text: LABELS.stakeBackAnalysisButton,
      callback_data: demoAnalysisCallbackData(PAIR_EURUSD.id, 15),
    });
  });

  // C-mode, C-floor, C-refusals: every start refusal by the session path's own table
  it.each(
    Object.entries(START_REFUSALS).filter(
      ([code]) => code !== TradingSessionErrorCode.ActiveSessionExists,
    ),
  )('answers the start refusal %s with its text, the amount saved', async (code, refusal) => {
    const { press, calls, setStake } = setup({
      startSession: () => Promise.reject(httpError(409, code)),
    });
    await press(PRESS);
    expect(setStake).toHaveBeenCalledTimes(1);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(textOf(refusal.text).value);
  });

  it.each([
    ['an asset id the backend would refuse', 'demo:sa:0:15:5:l'],
    ['an amount the schema refuses', 'demo:sa:101:15:0:l'],
  ])('only stops the spinner on %s (C-forged)', async (_label, data) => {
    const { press, calls, setStake } = setup();
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery']);
    expect(setStake).not.toHaveBeenCalled();
  });

  it.each([
    ['13 digits', 'demo:sa:101:15:1234567890123:l'],
    ['9 fraction digits', 'demo:sa:101:15:1.123456789:l'],
    ['a duration the demo does not offer', 'demo:sa:101:30:5:l'],
    ['the token n, which only opens a screen', 'demo:sa:101:15:5:n'],
  ])('matches no handler with %s (C-forged)', async (_label, data) => {
    expect(CYCLE_STAKE_PATTERN.exec(data)).toBeNull();
    const { press, calls, setStake } = setup();
    await press(data);
    expect(calls).toEqual([]);
    expect(setStake).not.toHaveBeenCalled();
  });

  it('is not the session button, whose data starts without a save', () => {
    expect(SESSION_START_PATTERN.exec(PRESS)).toBeNull();
    expect(CYCLE_STAKE_PATTERN.exec(PRESS)).not.toBeNull();
  });

  it('ends a typed amount step left open', async () => {
    const { press, loginDialog } = setup({ dialog: ON_STEP });
    await press(PRESS);
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });
});

describe('«✏️ Своя сумма» of the amount screen', () => {
  it.each(['l', 'a'] as const)(
    'asks for the amount in place, the way back to the screen (%s)',
    async (back) => {
      const { press, calls, loginDialog } = setup();
      await press(cycleCustomCallbackData(PAIR_EURUSD.id, 15, back));
      expect(loginDialog.get(USER.id)).toEqual({ ...ON_STEP, back });
      expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
      const edited = payloadOf(calls, 'editMessageText');
      expect(edited?.text).toBe(TEXTS.stakeInputPrompt.value);
      expect(rowsOf(edited)).toEqual([
        [
          {
            text: LABELS.stakeBackButton,
            callback_data: demoLaunchCallbackData(PAIR_EURUSD.id, 15, back),
          },
        ],
      ]);
    },
  );

  it('replaces a login the user had open, and a login replaces it (T-replace)', async () => {
    const { press, loginDialog } = setup({ dialog: { step: 'email' } });
    await press(cycleCustomCallbackData(PAIR_EURUSD.id, 15, 'l'));
    expect(loginDialog.get(USER.id)?.step).toBe('cycleStake');
    await press(CONNECT_CALLBACK_DATA);
    expect(loginDialog.get(USER.id)).toEqual({ step: 'email' });
  });

  it('only stops the spinner on an id the backend would refuse', async () => {
    const { press, calls, loginDialog } = setup();
    await press('demo:sc:0:15:l');
    expect(methods(calls)).toEqual(['answerCallbackQuery']);
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });
});

describe('a typed amount of the cycle', () => {
  it('saves it and starts the cycle at once, deleting nothing (T-start)', async () => {
    const { type, setStake, startSession, calls, loginDialog } = setup({ dialog: ON_STEP });
    await type('7');
    expect(setStake.mock.calls).toEqual([[String(USER.id), TradeMode.Demo, '7']]);
    expect(startSession.mock.calls).toEqual([[STARTED]]);
    expect(methods(calls)).toEqual(['sendMessage']);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(STATUS);
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  it('keeps the step on a text that is no amount, so the next one starts (T-invalid)', async () => {
    const { type, setStake, startSession, calls, loginDialog } = setup({ dialog: ON_STEP });
    await type('abc');
    expect(setStake).not.toHaveBeenCalled();
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.stakeInputInvalid.value);
    expect(rowsOf(payloadOf(calls, 'sendMessage'))).toEqual([
      [{ text: LABELS.stakeBackButton, callback_data: demoLaunchCallbackData(PAIR_EURUSD.id, 15) }],
    ]);
    expect(loginDialog.get(USER.id)).toEqual(ON_STEP);
    await type('7,5');
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(setStake.mock.calls).toEqual([[String(USER.id), TradeMode.Demo, '7.5']]);
  });

  it('keeps the step on a bounds refusal and says why, starting nothing', async () => {
    const { type, startSession, calls, loginDialog } = setup({
      dialog: ON_STEP,
      setStake: () =>
        Promise.resolve({
          refused: {
            error: 'stake_below_minimum',
            limits: { minTradeAmount: d('1'), available: d('50'), scale: 2 },
          },
        }),
    });
    await type('0.5');
    expect(startSession).not.toHaveBeenCalled();
    expect(plainTextOf(payloadOf(calls, 'sendMessage')?.text as string)).toBe(
      plainTextOf(TEXTS.stakeBelowMinimum({ minStake: d('1') })),
    );
    expect(loginDialog.get(USER.id)).toEqual(ON_STEP);
  });

  it('keeps the step on a save of unknown outcome', async () => {
    const { type, startSession, loginDialog } = setup({ dialog: ON_STEP, setStake: unreachable });
    await type('7');
    expect(startSession).not.toHaveBeenCalled();
    expect(loginDialog.get(USER.id)).toEqual(ON_STEP);
  });

  it('ends the step on a refusal the bot cannot act on', async () => {
    const { type, loginDialog } = setup({
      dialog: ON_STEP,
      setStake: () => Promise.reject(httpError(404, StakeErrorCode.UserNotFound)),
    });
    await type('7');
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  it('asks the start once more on an unknown outcome (C-typed-unknown)', async () => {
    const { type, startSession, calls } = setup({ dialog: ON_STEP, startSession: unreachable });
    await type('7');
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.sessionOutcomeUnknown.value);
  });
});
