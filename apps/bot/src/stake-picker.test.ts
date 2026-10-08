import { describe, expect, it, vi } from 'vitest';
import {
  BrokerBalanceUnavailableReason,
  decimalStringSchema,
  NotificationLevel,
  UserStatus,
  type DecimalString,
} from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot, CONNECT_CALLBACK_DATA } from './bot';
import { demoAnalysisCallbackData, stakeMenuCallbackData } from './demo';
import { createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  SETTINGS_CALLBACK_DATA,
  stakeCustomCallbackData,
  stakeOpenCallbackData,
  stakeOriginOf,
  stakePresetCallbackData,
  stakeResetCallbackData,
  type StakeOrigin,
} from './stake-picker';
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
  stubSessionTracker,
  stubTracker,
  textUpdate,
  userView,
  type ApiCall,
} from './testing';
import { LABELS, settingsText, stakePickerText, TEXTS } from './texts';

interface Button {
  text: string;
  callback_data?: string;
}

const SETTINGS: StakeOrigin = { kind: 'settings' };
const ANALYSIS: StakeOrigin = { kind: 'analysis', assetId: 101, durationSec: 5 };
const ON_STAKE_STEP: LoginDialogState = { step: 'stake', origin: SETTINGS };
const d = (value: string): DecimalString => decimalStringSchema.parse(value);

function setup(
  options: {
    readTradingAccess?: BackendClient['readTradingAccess'];
    setDemoStake?: BackendClient['setDemoStake'];
    recordStart?: BackendClient['recordStart'];
    dialog?: LoginDialogState;
  } = {},
) {
  const readTradingAccess = vi.fn(
    options.readTradingAccess ?? (() => Promise.resolve(ACCESS_VIEW)),
  );
  const setDemoStake = vi.fn<BackendClient['setDemoStake']>(
    options.setDemoStake ?? ((_id, amount) => Promise.resolve({ saved: amount })),
  );
  const recordStart = vi.fn(options.recordStart ?? (() => Promise.resolve(userView())));
  const logger = fakeLogger();
  const loginDialog = createLoginDialog();
  if (options.dialog !== undefined) loginDialog.set(USER.id, options.dialog);
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ readTradingAccess, setDemoStake, recordStart }),
    logger,
    botInfo: BOT_INFO,
    loginDialog,
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  const press = (data: string) => bot.handleUpdate(callbackUpdate(data));
  const type = (text: string) => bot.handleUpdate(textUpdate(text));
  return { press, type, logger, loginDialog, readTradingAccess, setDemoStake, recordStart, ...api };
}

const lastPayload = (calls: readonly ApiCall[]) =>
  calls.filter((call) => ['editMessageText', 'sendMessage'].includes(call.method)).at(-1)?.payload;
const rowsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  (payload?.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? [];
const button = (text: string, callback_data: string): Button => ({ text, callback_data });
const preset = (amount: string, label: string, origin: StakeOrigin = SETTINGS) =>
  button(label, stakePresetCallbackData(amount, origin));
const BACK_SETTINGS = [button(LABELS.stakeBackSettingsButton, SETTINGS_CALLBACK_DATA)];
const BACK_ANALYSIS = [button(LABELS.stakeBackAnalysisButton, demoAnalysisCallbackData(101, 5))];
const CUSTOM = (origin: StakeOrigin = SETTINGS) => [
  button(LABELS.stakeCustomButton, stakeCustomCallbackData(origin)),
];
const RETRY_SETTINGS = [
  [button(LABELS.stakeMenuButton, stakeOpenCallbackData(SETTINGS))],
  BACK_SETTINGS,
];
const httpError = (status: number, reason?: string) =>
  new BackendError(BackendErrorCode.HttpStatus, {
    status,
    ...(reason === undefined ? {} : { reason }),
  });
const errors = (logger: ReturnType<typeof fakeLogger>) =>
  logger.error.mock.calls.map((call) => call[1] as string);
const warnings = (logger: ReturnType<typeof fakeLogger>) =>
  logger.warn.mock.calls.map((call) => call[1] as string);

describe('the stake picker', () => {
  it('offers the presets of the minimum, the current one marked, then custom and back', async () => {
    const { press, calls } = setup();
    await press(stakeOpenCallbackData(SETTINGS));
    const edit = lastPayload(calls);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(edit?.text).toBe(
      stakePickerText({
        stake: null,
        minTradeAmount: '1.00000000',
        demoAvailable: '10000.00000000',
        presets: 4,
      }).value,
    );
    expect(rowsOf(edit)).toEqual([
      [preset('1', '$1.00 ✅'), preset('2', '$2.00'), preset('5', '$5.00'), preset('10', '$10.00')],
      CUSTOM(),
      BACK_SETTINGS,
    ]);
  });

  it('marks the saved stake, offers the reset, and drops presets above the demo balance', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            demoStake: d('5'),
            broker: brokerBalance({
              demo: { available: d('7'), held: d('0'), total: d('7') },
            }),
          }),
        ),
    });
    await press(stakeOpenCallbackData(ANALYSIS));
    const edit = lastPayload(calls);
    expect(edit?.text).toContain('Сейчас: $5.00');
    expect(rowsOf(edit)).toEqual([
      [
        preset('1', '$1.00', ANALYSIS),
        preset('2', '$2.00', ANALYSIS),
        preset('5', '$5.00 ✅', ANALYSIS),
      ],
      CUSTOM(ANALYSIS),
      [button(LABELS.stakeResetButton, stakeResetCallbackData(ANALYSIS))],
      BACK_ANALYSIS,
    ]);
  });

  it('says the balance covers not even the minimum, and still offers custom', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            broker: brokerBalance({ demo: { available: d('0.5'), held: d('0'), total: d('0.5') } }),
          }),
        ),
    });
    await press(stakeOpenCallbackData(SETTINGS));
    const edit = lastPayload(calls);
    expect(edit?.text).toContain(TEXTS.stakePickerNoPresets.value);
    expect(rowsOf(edit)).toEqual([CUSTOM(), BACK_SETTINGS]);
  });

  it.each([
    ['a blocked user', accessView({ status: UserStatus.Blocked }), TEXTS.blocked, [BACK_SETTINGS]],
    [
      'no account',
      accessView({ broker: null, brokerUnavailable: BrokerBalanceUnavailableReason.NoAccount }),
      TEXTS.accountNone,
      [[button(LABELS.connectButton, CONNECT_CALLBACK_DATA)], BACK_SETTINGS],
    ],
    [
      'two accounts',
      accessView({
        broker: null,
        brokerUnavailable: BrokerBalanceUnavailableReason.AmbiguousAccount,
      }),
      TEXTS.statusAmbiguous,
      [BACK_SETTINGS],
    ],
    [
      'no balance yet',
      accessView({ broker: null, brokerUnavailable: BrokerBalanceUnavailableReason.Refreshing }),
      TEXTS.stakeBalanceMissing,
      [BACK_SETTINGS],
    ],
  ])('says what the stake press would for %s', async (_case, access, text, rows) => {
    const { press, calls } = setup({ readTradingAccess: () => Promise.resolve(access) });
    await press(stakeOpenCallbackData(SETTINGS));
    expect(lastPayload(calls)?.text).toBe(text.value);
    expect(rowsOf(lastPayload(calls))).toEqual(rows);
  });

  it('warns and says the service is unavailable when access is not read', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(stakeOpenCallbackData(SETTINGS));
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(warnings(logger)).toEqual(['trading access not read for the stake picker']);
  });

  it('sends the picker anew when its message is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    await press(stakeOpenCallbackData(SETTINGS));
    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendMessage',
    ]);
  });

  it.each(['stk:o:a:0:5', 'stk:o:a:101:6', 'stk:s:0:s', 'stk:z:a:0:5', 'stk:c:a:0:5'])(
    'stops the spinner and calls nothing for the forged %s',
    async (data) => {
      const { press, calls, readTradingAccess, setDemoStake } = setup();
      await press(data);
      expect(readTradingAccess).not.toHaveBeenCalled();
      expect(setDemoStake).not.toHaveBeenCalled();
      expect(calls.map((call) => call.method)).toEqual(
        data === 'stk:o:a:101:6' ? [] : ['answerCallbackQuery'],
      );
    },
  );

  it('keeps every picker datum inside the Bot API 64 bytes and reads its origin back', () => {
    const longest: StakeOrigin = { kind: 'analysis', assetId: 2_147_483_647, durationSec: 15 };
    const data = stakePresetCallbackData('999999999999.99999999', longest);
    expect(Buffer.byteLength(data, 'utf8')).toBe(43);
    expect(stakeMenuCallbackData(101, 5)).toBe(stakeOpenCallbackData(ANALYSIS));
    expect(stakeOriginOf('a:2147483647:15')).toEqual(longest);
    expect(stakeOriginOf('s')).toEqual(SETTINGS);
    expect(stakeOriginOf('a:0:5')).toBeUndefined();
    expect(stakeOriginOf('x')).toBeUndefined();
  });
});

describe('saving a stake', () => {
  it.each([
    ['a preset', stakePresetCallbackData('5', ANALYSIS), '5', '$5.00', BACK_ANALYSIS],
    [
      'the reset',
      stakeResetCallbackData(SETTINGS),
      null,
      'минимальная ставка брокера',
      BACK_SETTINGS,
    ],
  ])('saves %s and shows it with the way back', async (_case, data, amount, label, back) => {
    const { press, calls, setDemoStake } = setup();
    await press(data);
    expect(setDemoStake.mock.calls).toEqual([[String(USER.id), amount]]);
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeSaved(label).value);
    expect(rowsOf(lastPayload(calls))).toEqual([back]);
  });

  it.each([
    ['stake_precision', TEXTS.stakePrecisionDigits('2')],
    ['stake_below_minimum', TEXTS.stakeBelowMinimum('$1.00')],
    ['insufficient_demo_balance', TEXTS.stakeAboveAvailableAmount('$50.00')],
  ] as const)('words the refusal %s from its limits', async (error, text) => {
    const { press, calls, logger } = setup({
      setDemoStake: () =>
        Promise.resolve({
          refused: { error, limits: { minTradeAmount: d('1'), demoAvailable: d('50'), scale: 2 } },
        }),
    });
    await press(stakePresetCallbackData('5', SETTINGS));
    expect(lastPayload(calls)?.text).toBe(text.value);
    expect(rowsOf(lastPayload(calls))).toEqual(RETRY_SETTINGS);
    expect(warnings(logger)).toEqual([]);
  });
});

describe('a typed stake', () => {
  it('opens the prompt in place and puts the user on the stake step, replacing a login', async () => {
    const { press, calls, loginDialog } = setup({ dialog: { step: 'email' } });
    await press(stakeCustomCallbackData(SETTINGS));
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeInputPrompt.value);
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.stakeBackButton, stakeOpenCallbackData(SETTINGS))],
    ]);
  });

  it('saves a typed amount canonically as a new message and ends the step', async () => {
    const { type, calls, loginDialog, setDemoStake } = setup({ dialog: ON_STAKE_STEP });
    await type(' 2,50 ');
    expect(setDemoStake.mock.calls).toEqual([[String(USER.id), '2.5']]);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeSaved('$2.50').value);
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  it.each(['abc', '-5', '0', '1 000', 'ada@example.test'])(
    'refuses %j as not an amount, saves nothing and keeps the step',
    async (text) => {
      const { type, calls, loginDialog, setDemoStake } = setup({ dialog: ON_STAKE_STEP });
      await type(text);
      expect(setDemoStake).not.toHaveBeenCalled();
      expect(lastPayload(calls)?.text).toBe(TEXTS.stakeInputInvalid.value);
      expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
    },
  );

  it('keeps the step for a refusal before the write, so the user types again', async () => {
    const { type, loginDialog } = setup({
      dialog: ON_STAKE_STEP,
      setDemoStake: () =>
        Promise.resolve({
          refused: {
            error: 'stake_precision',
            limits: { minTradeAmount: d('1'), demoAvailable: d('50'), scale: 2 },
          },
        }),
    });
    await type('1.234');
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
  });

  it('keeps the step and says there is no balance yet on balance_unavailable', async () => {
    const { type, calls, loginDialog } = setup({
      dialog: ON_STAKE_STEP,
      setDemoStake: () => Promise.reject(httpError(409, 'balance_unavailable')),
    });
    await type('5');
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeBalanceMissing.value);
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
  });

  it.each([
    ['unreachable', new BackendError(BackendErrorCode.Unreachable)],
    ['a 500', httpError(500)],
    ['a broken body', new BackendError(BackendErrorCode.ContractViolation, { status: 200 })],
  ])('keeps the step and offers another try when the outcome is %s', async (_case, error) => {
    const { type, calls, loginDialog, logger } = setup({
      dialog: ON_STAKE_STEP,
      setDemoStake: () => Promise.reject(error),
    });
    await type('5');
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeSaveUnknown.value);
    expect(rowsOf(lastPayload(calls))).toEqual(RETRY_SETTINGS);
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
    expect(warnings(logger)).toEqual(['demo stake save outcome unknown']);
  });

  it.each([
    ['user_not_found', httpError(404, 'user_not_found'), 'warn'],
    ['validation', httpError(400, 'validation'), 'error'],
    ['an unlisted 409', httpError(409, 'something_else'), 'error'],
  ] as const)('ends the step and says unavailable on %s', async (_case, error, level) => {
    const { type, calls, loginDialog, logger } = setup({
      dialog: ON_STAKE_STEP,
      setDemoStake: () => Promise.reject(error),
    });
    await type('5');
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(loginDialog.get(USER.id)).toBeUndefined();
    expect(level === 'warn' ? warnings(logger) : errors(logger)).toEqual(['demo stake not saved']);
  });

  it("ends the stake step on the prompt's way back, but leaves a login alone", async () => {
    const stake = setup({ dialog: ON_STAKE_STEP });
    await stake.press(stakeOpenCallbackData(SETTINGS));
    expect(stake.loginDialog.get(USER.id)).toBeUndefined();

    const login = setup({ dialog: { step: 'email' } });
    await login.press(stakeOpenCallbackData(SETTINGS));
    expect(login.loginDialog.get(USER.id)).toEqual({ step: 'email' });
  });

  it('sends the login button back to the address, not the stake step to a code', async () => {
    const { press, calls, loginDialog } = setup({ dialog: ON_STAKE_STEP });
    await press('resend');
    expect(lastPayload(calls)?.text).toBe(TEXTS.codeRequestStale.value);
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
  });
});

describe('/settings', () => {
  it('shows the stake line and «💵 Изменить» under the levels', async () => {
    const { type, calls } = setup({
      recordStart: () => Promise.resolve(userView({ demoStake: d('2.5') })),
    });
    await type('/settings');
    const sent = lastPayload(calls);
    expect(sent?.text).toBe(settingsText(NotificationLevel.All, '2.5').value);
    expect(sent?.text).toContain('Сумма демо-сделки: <b>$2.50</b>');
    expect(rowsOf(sent).at(-1)).toEqual([
      button(LABELS.settingsStakeButton, stakeOpenCallbackData(SETTINGS)),
    ]);
  });

  it('names the broker minimum when no stake is saved', () => {
    expect(settingsText(NotificationLevel.All, null).value).toContain(
      'Сумма демо-сделки: <b>минимальная ставка брокера</b>',
    );
  });

  it("re-renders /settings in place from the picker's way back", async () => {
    const { press, calls, recordStart } = setup({
      recordStart: () => Promise.resolve(userView({ notificationLevel: NotificationLevel.Off })),
    });
    await press(SETTINGS_CALLBACK_DATA);
    expect(recordStart).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(lastPayload(calls)?.text).toBe(settingsText(NotificationLevel.Off, null).value);
  });

  it.each([
    [
      'the read fails',
      () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      TEXTS.unavailable,
    ],
    [
      'the user is blocked',
      () => Promise.resolve(userView({ status: UserStatus.Blocked })),
      TEXTS.blocked,
    ],
  ] as const)('answers with a new message when %s', async (_case, recordStart, text) => {
    const { press, calls } = setup({ recordStart });
    await press(SETTINGS_CALLBACK_DATA);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(lastPayload(calls)?.text).toBe(text.value);
  });
});
