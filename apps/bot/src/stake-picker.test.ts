import { describe, expect, it, vi } from 'vitest';
import {
  ButtonRole,
  pairLabel,
  BrokerBalanceUnavailableReason,
  decimalStringSchema,
  NotificationLevel,
  plainTextOf,
  TradeMode,
  UserStatus,
  type DecimalString,
  type PairLabel,
  CONNECT_CALLBACK_DATA,
  defaultBotTextSource,
  supportUrl,
  demoAnalysisCallbackData,
  MENU_CALLBACK_DATA,
  StakeRefusal,
  BOT_TEXT_DEFAULT_SOURCES,
  BotLanguage,
} from '@binarius/shared';
import { botTextSourcesWith } from '@binarius/shared/testing';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  cycleCustomCallbackData,
  cycleStakeCallbackData,
  cycleStakeScreen,
  demoLaunchCallbackData,
  launchScreen,
  launchStakeCallbackData,
  sessionStartCallbackData,
  stakeMenuCallbackData,
} from './demo';
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
  BROKER_BALANCE,
  TEXT_CARD_MESSAGE_ID,
  USER,
  accessView,
  brokerBalance,
  callbackUpdate,
  photoCallbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  messageAnswer,
  PAIR_EURUSD,
  PAIRS_RESPONSE,
  pairsResponse,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  userView,
  type ApiCall,
  inlineRoles,
  inlineRows,
  inlineStyles,
  keyboardRows,
  stubShownSignals,
  detachedWork,
} from './testing';
import {
  LABELS,
  setBotTextSources,
  settingsText,
  stakePickerText,
  TEXTS,
  userContextOf,
} from './texts';

const pickerContext = (mode: TradeMode = TradeMode.Demo) => ({
  ...userContextOf(USER.first_name, mode, accessView()),
  minStake: d('1'),
  demoAvailable: d('1'),
  realAvailable: d('1'),
});

interface Button {
  text: string;
  callback_data?: string;
}

const SETTINGS: StakeOrigin = { kind: 'settings' };
const ANALYSIS: StakeOrigin = { kind: 'analysis', assetId: 101, durationSec: 5 };
const PAIR: StakeOrigin = { kind: 'pair', assetId: PAIR_EURUSD.id, durationSec: 5 };
const ON_STAKE_STEP: LoginDialogState = { step: 'stake', mode: TradeMode.Demo, origin: SETTINGS };
const d = (value: string): DecimalString => decimalStringSchema.parse(value);

function setup(
  options: {
    readTradingAccess?: BackendClient['readTradingAccess'];
    setStake?: BackendClient['setStake'];
    readPairs?: BackendClient['readPairs'];
    recordStart?: BackendClient['recordStart'];
    dialog?: LoginDialogState;
  } = {},
) {
  const readTradingAccess = vi.fn(
    options.readTradingAccess ?? (() => Promise.resolve(ACCESS_VIEW)),
  );
  const setStake = vi.fn<BackendClient['setStake']>(
    options.setStake ?? ((_id, _mode, amount) => Promise.resolve({ saved: amount })),
  );
  const recordStart = vi.fn(options.recordStart ?? (() => Promise.resolve(userView())));
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
  const logger = fakeLogger();
  const loginDialog = createLoginDialog();
  if (options.dialog !== undefined) loginDialog.set(USER.id, options.dialog);
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ readTradingAccess, setStake, recordStart, readPairs }),
    logger,
    botInfo: BOT_INFO,
    loginDialog,
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
    shownSignals: stubShownSignals(),
    detached: detachedWork(),
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  const press = (data: string) => bot.handleUpdate(callbackUpdate(data));
  const pressOnPhoto = (data: string) => bot.handleUpdate(photoCallbackUpdate(data));
  const type = (text: string) => bot.handleUpdate(textUpdate(text));
  return {
    press,
    pressOnPhoto,
    type,
    logger,
    loginDialog,
    readTradingAccess,
    setStake,
    recordStart,
    readPairs,
    ...api,
  };
}

const payloadOf = (calls: readonly ApiCall[], method: string) =>
  calls.find((call) => call.method === method)?.payload;
const lastPayload = (calls: readonly ApiCall[]) =>
  calls.filter((call) => ['editMessageText', 'sendMessage'].includes(call.method)).at(-1)?.payload;
const rowsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  inlineRows(payload) as Button[][];
const button = (text: string, callback_data: string): Button => ({ text, callback_data });
const preset = (
  amount: string,
  label: string,
  origin: StakeOrigin = SETTINGS,
  mode: TradeMode = TradeMode.Demo,
) => button(label, stakePresetCallbackData(amount, mode, origin));
const BACK_SETTINGS = [button(LABELS.stakeBackSettingsButton, SETTINGS_CALLBACK_DATA)];
const BACK_ANALYSIS = [button(LABELS.stakeBackAnalysisButton, demoAnalysisCallbackData(101, 5))];
const CUSTOM = (origin: StakeOrigin = SETTINGS, mode: TradeMode = TradeMode.Demo) => [
  button(LABELS.stakeCustomButton, stakeCustomCallbackData(mode, origin)),
];
// #475: the retry and the way back in one row
const RETRY_SETTINGS = [
  [
    button(LABELS.stakeMenuButton, stakeOpenCallbackData(TradeMode.Demo, SETTINGS)),
    ...BACK_SETTINGS,
  ],
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
    await press(stakeOpenCallbackData(TradeMode.Demo, SETTINGS));
    const edit = lastPayload(calls);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(edit?.text).toBe(
      stakePickerText({
        user: userContextOf(USER.first_name, TradeMode.Demo, accessView()),
        mode: TradeMode.Demo,
        minTradeAmount: d('1.00000000'),
        demoAvailable: d('10000.00000000'),
        realAvailable: d('100.00000000'),
        presets: 4,
      }).value,
    );
    // #475: the presets as the amount screen draws them, «· риск» and red from $10
    expect(rowsOf(edit)).toEqual([
      [preset('1', '$1.00 ✅'), preset('2', '$2.00'), preset('5', '$5.00')],
      [preset('10', '$10.00 · риск')],
      [...CUSTOM(), ...BACK_SETTINGS],
    ]);
    expect(inlineRoles(edit)).toEqual([
      [ButtonRole.Stake, ButtonRole.Stake, ButtonRole.Stake],
      [ButtonRole.StakeRisk],
      [ButtonRole.Secondary, ButtonRole.Nav],
    ]);
    expect(inlineStyles(edit)).toEqual([
      ['success', 'success', 'success'],
      ['danger'],
      ['primary', null],
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
    await press(stakeOpenCallbackData(TradeMode.Demo, ANALYSIS));
    const edit = lastPayload(calls);
    expect(edit?.text).toContain('Сейчас: $5.00');
    expect(rowsOf(edit)).toEqual([
      [
        preset('1', '$1.00', ANALYSIS),
        preset('2', '$2.00', ANALYSIS),
        preset('5', '$5.00 ✅', ANALYSIS),
      ],
      [
        ...CUSTOM(ANALYSIS),
        button(LABELS.stakeResetButton, stakeResetCallbackData(TradeMode.Demo, ANALYSIS)),
        ...BACK_ANALYSIS,
      ],
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
    await press(stakeOpenCallbackData(TradeMode.Demo, SETTINGS));
    const edit = lastPayload(calls);
    expect(edit?.text).toContain(plainTextOf(TEXTS.stakePickerNoPresets(pickerContext())));
    expect(rowsOf(edit)).toEqual([[...CUSTOM(), ...BACK_SETTINGS]]);
  });

  it.each([
    // #350: the support link, then the way back
    [
      'a blocked user',
      accessView({ status: UserStatus.Blocked }),
      TEXTS.blocked,
      [[{ text: LABELS.supportButton, url: supportUrl() }, ...BACK_SETTINGS]],
    ],
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
    await press(stakeOpenCallbackData(TradeMode.Demo, SETTINGS));
    expect(lastPayload(calls)?.text).toBe(text.value);
    expect(rowsOf(lastPayload(calls))).toEqual(rows);
  });

  it('warns and says the service is unavailable when access is not read', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(stakeOpenCallbackData(TradeMode.Demo, SETTINGS));
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
    await press(stakeOpenCallbackData(TradeMode.Demo, SETTINGS));
    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendMessage',
    ]);
  });

  it.each([
    'stk:o:d:a:0:5',
    'stk:o:r:a:101:6',
    'stk:o:x:s',
    'stk:s:0:d:s',
    'stk:z:r:a:0:5',
    'stk:c:d:a:0:5',
  ])('stops the spinner and calls nothing for the forged %s', async (data) => {
    const { press, calls, readTradingAccess, setStake } = setup();
    await press(data);
    expect(readTradingAccess).not.toHaveBeenCalled();
    expect(setStake).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(
      ['stk:o:r:a:101:6', 'stk:o:x:s'].includes(data) ? [] : ['answerCallbackQuery'],
    );
  });

  it('keeps every picker datum inside the Bot API 64 bytes and reads its origin back', () => {
    const longest: StakeOrigin = { kind: 'analysis', assetId: 2_147_483_647, durationSec: 5 };
    const data = stakePresetCallbackData('999999999999.99999999', TradeMode.Real, longest);
    expect(Buffer.byteLength(data, 'utf8')).toBe(44);
    expect(data).toBe('stk:s:999999999999.99999999:r:a:2147483647:5');
    expect(stakeMenuCallbackData(TradeMode.Demo, 101, 5)).toBe(
      stakeOpenCallbackData(TradeMode.Demo, ANALYSIS),
    );
    expect(stakeOriginOf('a:2147483647:5')).toEqual(longest);
    expect(stakeOriginOf('s')).toEqual(SETTINGS);
    expect(stakeOriginOf('a:0:5')).toBeUndefined();
    expect(stakeOriginOf('x')).toBeUndefined();
  });

  it('reads the launch origin back from the data the launch screen draws', () => {
    const longest = stakePresetCallbackData('999999999999.99999999', TradeMode.Real, {
      kind: 'pair',
      assetId: 2_147_483_647,
      durationSec: 5,
    });
    expect(Buffer.byteLength(longest, 'utf8')).toBe(44);
    expect(launchStakeCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5)).toBe(
      stakeOpenCallbackData(TradeMode.Demo, PAIR),
    );
    expect(stakeOriginOf(`p:${PAIR_EURUSD.id}:5`)).toEqual(PAIR);
    expect(stakeOriginOf('p:0:5')).toBeUndefined();
    // a launch screen from before #382 carried no duration: the legacy handler takes it (#382)
    expect(stakeOriginOf('p:101')).toBeUndefined();
    expect(stakeOriginOf('p:101:120')).toBeUndefined();
  });

  // #685: the duration is one, so an origin drawn with 15 s (or a duration before #313) names the
  // same pair's screen at 5 s
  it("an origin with 15 reads as the pair's screen at 5 s", () => {
    expect(stakeOriginOf('a:101:15')).toEqual({ kind: 'analysis', assetId: 101, durationSec: 5 });
    expect(stakeOriginOf('p:101:15')).toEqual({ kind: 'pair', assetId: 101, durationSec: 5 });
    expect(stakeOriginOf('a:101:300')).toEqual({ kind: 'analysis', assetId: 101, durationSec: 5 });
  });
});

describe('the stake picker opened from a launch screen (#320)', () => {
  const BACK_LAUNCH = [
    button(LABELS.stakeBackLaunchButton, demoLaunchCallbackData(PAIR_EURUSD.id, 5)),
  ];
  // #476: a demo save returns to the amount screen under the saved line; `demoStake` is what the
  // access read after the save says
  const savedCycle = (
    amount: DecimalString | null,
    {
      symbol = pairLabel(PAIR_EURUSD),
      durationSec = 5,
    }: { symbol?: PairLabel | null; durationSec?: 5 } = {},
  ) =>
    cycleStakeScreen({
      step: { assetId: PAIR_EURUSD.id, durationSec, back: 'l' },
      firstName: USER.first_name,
      symbol,
      access: accessView({ demoStake: amount }),
      broker: BROKER_BALANCE,
      saved: { amount, mode: TradeMode.Demo },
    });
  const savedAccess = (demoStake: DecimalString | null) => () =>
    Promise.resolve(accessView({ demoStake }));
  const amount = (value: string, label: string, durationSec: 5 = 5) =>
    button(label, cycleStakeCallbackData(PAIR_EURUSD.id, durationSec, value, 'l'));

  // #761: «💵 Сумма» under the analysis card's «➕ Ещё» (a photo, #482) tries no edit
  it('P-open-photo sends the picker as a new message under the analysis card', async () => {
    const data = stakeMenuCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5);
    const photo = setup();
    await photo.pressOnPhoto(data);
    expect(photo.calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const text = setup();
    await text.press(data);
    const edited = payloadOf(text.calls, 'editMessageText');
    const sent = payloadOf(photo.calls, 'sendMessage');
    expect(edited).toBeDefined();
    expect(sent?.text).toBe(edited?.text);
    expect(sent?.reply_markup).toEqual(edited?.reply_markup);
    expect(photo.logger.warn).not.toHaveBeenCalled();
  });

  it('leads back to the launch screen', async () => {
    const { press, calls } = setup();
    await press(stakeOpenCallbackData(TradeMode.Demo, PAIR));
    expect(rowsOf(lastPayload(calls))).toEqual([
      [preset('1', '$1.00 ✅', PAIR), preset('2', '$2.00', PAIR), preset('5', '$5.00', PAIR)],
      [preset('10', '$10.00 · риск', PAIR)],
      [...CUSTOM(PAIR), ...BACK_LAUNCH],
    ]);
  });

  // #685: a picker opened from a 15 s screen saves as from the same pair's screen at 5 s
  it('an origin with 15: a save draws the amount screen at 5 s, the open leads back to the 5 s analysis', async () => {
    const saved = setup({ readTradingAccess: savedAccess(d('5')) });
    await saved.press(`stk:s:5:d:p:${String(PAIR_EURUSD.id)}:15`);
    expect(lastPayload(saved.calls)?.text).toBe(savedCycle(d('5')).text.value);
    expect(rowsOf(lastPayload(saved.calls))[0]).toEqual([
      amount('1', '$1.00'),
      amount('2', '$2.00'),
      amount('5', '$5.00 ✅'),
    ]);

    const opened = setup();
    await opened.press(`stk:o:d:a:${String(PAIR_EURUSD.id)}:15`);
    expect(rowsOf(lastPayload(opened.calls)).at(-1)?.at(-1)).toEqual(
      button(LABELS.stakeBackAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5)),
    );
  });

  // P-return (#476): a save from a demo launch screen sent before #476 lands on the amount screen
  it('returns a demo save to the amount screen in place, under the saved line (P-return)', async () => {
    const { press, calls, setStake, readPairs } = setup({ readTradingAccess: savedAccess(d('5')) });
    await press(stakePresetCallbackData('5', TradeMode.Demo, PAIR));
    expect(setStake.mock.calls).toEqual([[String(USER.id), TradeMode.Demo, '5']]);
    expect(readPairs).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(lastPayload(calls)?.text).toBe(savedCycle(d('5')).text.value);
    expect(plainTextOf(lastPayload(calls)?.text as string)).toBe(
      `✅ Демо-ставка сохранена: $5.00\n\n🎯 ${pairLabel(PAIR_EURUSD)} · ⏱ 5 с\n🤖 Бот проведёт 5 циклов подряд и перед каждой сделкой проверит сигнал. Это демо: деньги не нужны.\n\nВыбери сумму сделки 👇`,
    );
    expect(rowsOf(lastPayload(calls))).toEqual([
      [amount('1', '$1.00'), amount('2', '$2.00'), amount('5', '$5.00 ✅')],
      [amount('10', '$10.00 · риск')],
      [
        button(LABELS.stakeCustomButton, cycleCustomCallbackData(PAIR_EURUSD.id, 5, 'l')),
        button(LABELS.backToListButton, 'demo:sig'),
      ],
    ]);
  });

  it('marks the minimum after the reset', async () => {
    const { press, calls } = setup();
    await press(stakeResetCallbackData(TradeMode.Demo, PAIR));
    expect(lastPayload(calls)?.text).toBe(savedCycle(null).text.value);
    expect(rowsOf(lastPayload(calls))[0]?.[0]).toEqual(amount('1', '$1.00 ✅'));
  });

  it('returns to the amount screen as a new message after a typed amount', async () => {
    const { type, calls, loginDialog } = setup({
      dialog: { step: 'stake', mode: TradeMode.Demo, origin: PAIR },
      readTradingAccess: savedAccess(d('2.5')),
    });
    await type('2,5');
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(lastPayload(calls)?.text).toBe(savedCycle(d('2.5')).text.value);
    // the saved $2.50 is no preset: its own button, in order
    expect(rowsOf(lastPayload(calls))[0]?.[2]).toEqual(amount('2.5', '$2.50 ✅'));
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  // #121: a save from a launch screen drawn before the user switched to real draws the real launch
  it('returns a user in real mode to the real launch screen', async () => {
    const { press, calls, readTradingAccess } = setup({
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await press(stakePresetCallbackData('5', TradeMode.Demo, PAIR));
    expect(readTradingAccess.mock.calls).toEqual([[String(USER.id)]]);
    const screen = launchScreen({
      assetId: PAIR_EURUSD.id,
      durationSec: 5,
      firstName: USER.first_name,
      symbol: pairLabel(PAIR_EURUSD),
      // the real stake in force (none saved: the minimum); the saved demo stake only in its line
      amount: d('1'),
      saved: { amount: d('5'), mode: TradeMode.Demo },
      mode: TradeMode.Real,
    });
    expect(lastPayload(calls)?.text).toBe(screen.text.value);
    const text = plainTextOf(lastPayload(calls)?.text as string);
    expect(text).toContain('✅ Демо-ставка сохранена: $5.00');
    // #327: the real launch names the real stake in force and starts a real cycle
    expect(text).toContain('💵 Ставка: $1.00');
    expect(text).toContain('Реальный режим: сделки идут на реальные деньги.');
    expect(text.split('$5.00')).toHaveLength(2);
    expect(rowsOf(lastPayload(calls))).toEqual([
      [
        button(
          '🚀 Запустить цикл · REAL',
          sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5, true),
        ),
      ],
      [
        button(
          LABELS.stakeChangeButton,
          launchStakeCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
        ),
        button(LABELS.backToListButton, 'demo:sig'),
      ],
    ]);
  });

  // Plan Update 4 (Major 2): `{stake}` of the real launch is the real stake in force (here the
  // minimum), not the saved demo stake
  it('gives an overridden launch header the minimum as {stake} in real mode', async () => {
    setBotTextSources(
      botTextSourcesWith(BotLanguage.Ru, {
        sourceOf: (key) =>
          key === 'launchHeader' ? '🎯 {subject} {stake}' : defaultBotTextSource.sourceOf(key),
      }),
    );
    try {
      const { press, calls } = setup({
        readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
      });
      await press(stakePresetCallbackData('5', TradeMode.Demo, PAIR));
      expect(plainTextOf(lastPayload(calls)?.text as string)).toContain(
        `🎯 ${pairLabel(PAIR_EURUSD)} · ⏱ 5 с $1.00`,
      );
    } finally {
      setBotTextSources(BOT_TEXT_DEFAULT_SOURCES);
    }
  });

  // #476: no amounts without the balance; «🔄 Повторить» opens the amount screen anew
  it('says the access read failed under the saved line, with a retry, and warns', async () => {
    const { press, calls, logger } = setup({
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(stakePresetCallbackData('5', TradeMode.Demo, PAIR));
    expect(plainTextOf(lastPayload(calls)?.text as string)).toBe(
      `✅ Демо-ставка сохранена: $5.00\n\n${plainTextOf(TEXTS.unavailable)}`,
    );
    expect(rowsOf(lastPayload(calls))).toEqual([
      [
        button(LABELS.demoRetryButton, demoLaunchCallbackData(PAIR_EURUSD.id, 5)),
        button(LABELS.backToListButton, 'demo:sig'),
      ],
    ]);
    expect(warnings(logger)).toEqual(['trading access not read for the launch screen']);
  });

  it('drops the symbol line, keeps the amounts and warns when the catalog is not read', async () => {
    const { press, calls, logger } = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      readTradingAccess: savedAccess(d('5')),
    });
    await press(stakePresetCallbackData('5', TradeMode.Demo, PAIR));
    const screen = savedCycle(d('5'), { symbol: null });
    expect(lastPayload(calls)?.text).toBe(screen.text.value);
    expect(lastPayload(calls)?.text).not.toContain(PAIR_EURUSD.symbol);
    expect(rowsOf(lastPayload(calls))).toEqual(keyboardRows(screen.keyboard));
    expect(warnings(logger)).toEqual(['pairs not read for the launch screen']);
  });

  // #631: a save returns to the cycle at any payout (#379 returned the floor's refusal below 80 %)
  // #327: in real mode the real launch screen, its symbol from the catalog
  it('returns a user in real mode to the real launch screen on a pair paying 79 percent', async () => {
    const { press, calls } = setup({
      readPairs: () => Promise.resolve(pairsResponse({ pairs: [{ ...PAIR_EURUSD, payout: 79 }] })),
      readTradingAccess: () => Promise.resolve(accessView({ tradingMode: TradeMode.Real })),
    });
    await press(stakePresetCallbackData('5', TradeMode.Demo, PAIR));
    const screen = launchScreen({
      assetId: PAIR_EURUSD.id,
      durationSec: 5,
      firstName: USER.first_name,
      symbol: pairLabel(PAIR_EURUSD),
      amount: d('1'),
      saved: { amount: d('5'), mode: TradeMode.Demo },
      mode: TradeMode.Real,
    });
    expect(lastPayload(calls)?.text).toBe(screen.text.value);
    expect(rowsOf(lastPayload(calls))).toEqual(keyboardRows(screen.keyboard));
  });

  it.each([
    [79, 5],
    [80, 5],
  ] as const)(
    'returns the amounts for a pair paying %i percent at %i s',
    async (payout, durationSec) => {
      const { press, calls } = setup({
        readPairs: () => Promise.resolve(pairsResponse({ pairs: [{ ...PAIR_EURUSD, payout }] })),
        readTradingAccess: savedAccess(d('5')),
      });
      await press(stakePresetCallbackData('5', TradeMode.Demo, { ...PAIR, durationSec }));
      const screen = savedCycle(d('5'), { durationSec });
      const payload = lastPayload(calls);
      expect({ text: payload?.text, firstRow: rowsOf(payload)[0] }).toEqual({
        text: screen.text.value,
        firstRow: [
          amount('1', '$1.00', durationSec),
          amount('2', '$2.00', durationSec),
          amount('5', '$5.00 ✅', durationSec),
        ],
      });
    },
  );

  it('offers another try and the way back to the launch on a refusal, reading no catalog', async () => {
    const { press, calls, readPairs } = setup({
      setStake: () =>
        Promise.resolve({
          refused: {
            error: 'stake_below_minimum',
            limits: { minTradeAmount: d('1'), available: d('50'), scale: 2 },
          },
        }),
    });
    await press(stakePresetCallbackData('5', TradeMode.Demo, PAIR));
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.stakeMenuButton, stakeOpenCallbackData(TradeMode.Demo, PAIR)), ...BACK_LAUNCH],
    ]);
    expect(readPairs).not.toHaveBeenCalled();
  });
});

describe('saving a stake', () => {
  it.each([
    [
      'a preset',
      stakePresetCallbackData('5', TradeMode.Demo, ANALYSIS),
      '5',
      '$5.00',
      BACK_ANALYSIS,
    ],
    [
      'the reset',
      stakeResetCallbackData(TradeMode.Demo, SETTINGS),
      null,
      'минимальная ставка брокера',
      BACK_SETTINGS,
    ],
  ])('saves %s and shows it with the way back', async (_case, data, amount, label, back) => {
    const { press, calls, setStake } = setup();
    await press(data);
    expect(setStake.mock.calls).toEqual([[String(USER.id), TradeMode.Demo, amount]]);
    const saved = TEXTS.stakeSaved({
      stake: amount === null ? null : d(amount),
      firstName: USER.first_name,
    });
    expect(lastPayload(calls)?.text).toBe(saved.value);
    expect(plainTextOf(saved)).toContain(label);
    expect(rowsOf(lastPayload(calls))).toEqual([back]);
  });

  it.each([
    [
      'stake_precision',
      TEXTS.stakePrecisionDigits({ digits: '2', minStake: d('1'), demoAvailable: d('50') }),
    ],
    ['stake_below_minimum', TEXTS.stakeBelowMinimum({ minStake: d('1') })],
    [
      'insufficient_balance',
      TEXTS.stakeAboveAvailableAmount({ demoAvailable: d('50'), minStake: d('1') }),
    ],
  ] as const)('words the refusal %s from its limits', async (error, text) => {
    const { press, calls, logger } = setup({
      setStake: () =>
        Promise.resolve({
          refused: { error, limits: { minTradeAmount: d('1'), available: d('50'), scale: 2 } },
        }),
    });
    await press(stakePresetCallbackData('5', TradeMode.Demo, SETTINGS));
    expect(lastPayload(calls)?.text).toBe(text.value);
    expect(rowsOf(lastPayload(calls))).toEqual(RETRY_SETTINGS);
    expect(warnings(logger)).toEqual([]);
  });
});

describe('a typed stake', () => {
  it('opens the prompt in place and puts the user on the stake step, replacing a login', async () => {
    const { press, calls, loginDialog } = setup({ dialog: { step: 'email' } });
    await press(stakeCustomCallbackData(TradeMode.Demo, SETTINGS));
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeInputPrompt.value);
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.stakeBackButton, stakeOpenCallbackData(TradeMode.Demo, SETTINGS))],
    ]);
  });

  it('saves a typed amount canonically as a new message and ends the step', async () => {
    const { type, calls, loginDialog, setStake } = setup({ dialog: ON_STAKE_STEP });
    await type(' 2,50 ');
    expect(setStake.mock.calls).toEqual([[String(USER.id), TradeMode.Demo, '2.5']]);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(lastPayload(calls)?.text).toBe(
      TEXTS.stakeSaved({ stake: d('2.5'), firstName: USER.first_name }).value,
    );
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  it.each(['abc', '-5', '0', '1 000', 'ada@example.test'])(
    'refuses %j as not an amount, saves nothing and keeps the step',
    async (text) => {
      const { type, calls, loginDialog, setStake } = setup({ dialog: ON_STAKE_STEP });
      await type(text);
      expect(setStake).not.toHaveBeenCalled();
      expect(lastPayload(calls)?.text).toBe(TEXTS.stakeInputInvalid.value);
      expect(rowsOf(lastPayload(calls))).toEqual([BACK_SETTINGS]);
      expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
    },
  );

  it('keeps the step for a refusal before the write, so the user types again', async () => {
    const { type, loginDialog } = setup({
      dialog: ON_STAKE_STEP,
      setStake: () =>
        Promise.resolve({
          refused: {
            error: 'stake_precision',
            limits: { minTradeAmount: d('1'), available: d('50'), scale: 2 },
          },
        }),
    });
    await type('1.234');
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
  });

  it('keeps the step and says there is no balance yet on balance_unavailable', async () => {
    const { type, calls, loginDialog } = setup({
      dialog: ON_STAKE_STEP,
      setStake: () => Promise.reject(httpError(409, 'balance_unavailable')),
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
      setStake: () => Promise.reject(error),
    });
    await type('5');
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeSaveUnknown.value);
    expect(rowsOf(lastPayload(calls))).toEqual(RETRY_SETTINGS);
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);
    expect(warnings(logger)).toEqual(['stake save outcome unknown']);
  });

  it.each([
    ['user_not_found', httpError(404, 'user_not_found'), 'warn'],
    ['validation', httpError(400, 'validation'), 'error'],
    ['an unlisted 409', httpError(409, 'something_else'), 'error'],
  ] as const)('ends the step and says unavailable on %s', async (_case, error, level) => {
    const { type, calls, loginDialog, logger } = setup({
      dialog: ON_STAKE_STEP,
      setStake: () => Promise.reject(error),
    });
    await type('5');
    expect(lastPayload(calls)?.text).toBe(TEXTS.unavailable.value);
    expect(loginDialog.get(USER.id)).toBeUndefined();
    expect(level === 'warn' ? warnings(logger) : errors(logger)).toEqual(['stake not saved']);
  });

  it("ends the stake step on the prompt's way back, but leaves a login alone", async () => {
    const stake = setup({ dialog: ON_STAKE_STEP });
    await stake.press(stakeOpenCallbackData(TradeMode.Demo, SETTINGS));
    expect(stake.loginDialog.get(USER.id)).toBeUndefined();

    const login = setup({ dialog: { step: 'email' } });
    await login.press(stakeOpenCallbackData(TradeMode.Demo, SETTINGS));
    expect(login.loginDialog.get(USER.id)).toEqual({ step: 'email' });
  });

  it('sends the login button back to the address, not the stake step to a code', async () => {
    const { press, calls, loginDialog } = setup({ dialog: ON_STAKE_STEP });
    await press('resend');
    expect(lastPayload(calls)?.text).toBe(TEXTS.codeRequestStale.value);
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });
});

describe('a typed stake left by a button or a command (#319)', () => {
  const refused = () =>
    Promise.resolve({
      refused: {
        error: StakeRefusal.BelowMinimum,
        limits: { minTradeAmount: d('1'), available: d('50'), scale: 2 },
      },
    });

  it("ends the step on /settings's way back after a refusal, and a number then saves nothing", async () => {
    const { press, type, calls, loginDialog, setStake } = setup({
      dialog: ON_STAKE_STEP,
      setStake: refused,
    });
    await type('0.5');
    expect(loginDialog.get(USER.id)).toEqual(ON_STAKE_STEP);

    await press(SETTINGS_CALLBACK_DATA);
    expect(loginDialog.get(USER.id)).toBeUndefined();

    const before = calls.length;
    await type('5');
    expect(setStake).toHaveBeenCalledTimes(1);
    expect(calls.slice(before)).toEqual([]);
  });

  it("ends the step on the analysis's way back", async () => {
    const { press, loginDialog } = setup({
      dialog: { step: 'stake', mode: TradeMode.Demo, origin: ANALYSIS },
    });
    await press(demoAnalysisCallbackData(101, 5));
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  it("ends the step on the launch screen's way back", async () => {
    const { press, loginDialog } = setup({
      dialog: { step: 'stake', mode: TradeMode.Demo, origin: PAIR },
    });
    await press(demoLaunchCallbackData(PAIR_EURUSD.id, 5));
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  it('ends the step on any other button', async () => {
    const { press, loginDialog } = setup({ dialog: ON_STAKE_STEP });
    await press(MENU_CALLBACK_DATA);
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  it('ends the step on a command, and a number then saves nothing; a login stays', async () => {
    const stake = setup({ dialog: ON_STAKE_STEP });
    await stake.type('/menu');
    expect(stake.loginDialog.get(USER.id)).toBeUndefined();
    await stake.type('5');
    expect(stake.setStake).not.toHaveBeenCalled();

    const login = setup({ dialog: { step: 'email' } });
    await login.type('/menu');
    expect(login.loginDialog.get(USER.id)).toEqual({ step: 'email' });
  });
});

describe('/settings', () => {
  it('shows both stake lines and «💵 Демо» «💼 Реал» under the levels', async () => {
    const { type, calls } = setup({
      recordStart: () => Promise.resolve(userView({ demoStake: d('2.5'), realStake: d('7') })),
    });
    await type('/settings');
    const sent = lastPayload(calls);
    expect(sent?.text).toBe(
      settingsText(NotificationLevel.All, d('2.5'), d('7'), USER.first_name).value,
    );
    expect(sent?.text).toContain('Сумма демо-сделки: <b>$2.50</b>');
    expect(sent?.text).toContain('Сумма реальной сделки: <b>$7.00</b>');
    expect(rowsOf(sent).at(-2)).toEqual([
      button(LABELS.settingsStakeDemoButton, 'stk:o:d:s'),
      button(LABELS.settingsStakeRealButton, 'stk:o:r:s'),
    ]);
  });

  it('names the broker minimum when no stake is saved', () => {
    expect(settingsText(NotificationLevel.All, null, null, USER.first_name).value).toContain(
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
    expect(lastPayload(calls)?.text).toBe(
      settingsText(NotificationLevel.Off, null, null, USER.first_name).value,
    );
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

// #326: the picker of the real stake, its saves and the old mode-less data
describe('the real stake picker', () => {
  const R = TradeMode.Real;
  // a real balance far from the demo one, so a picker reading the other balance draws other presets
  const REAL_BALANCE = brokerBalance({
    real: { available: d('7'), held: d('0'), total: d('7') },
  });
  const realAccess = (realStake: DecimalString | null = null) =>
    accessView({ broker: REAL_BALANCE, demoStake: d('2'), realStake });
  const BACK_ANALYSIS_ROW = BACK_ANALYSIS;
  const ON_REAL_STEP: LoginDialogState = { step: 'stake', mode: R, origin: SETTINGS };

  it.each([
    ['/settings', SETTINGS, BACK_SETTINGS],
    ['the analysis', ANALYSIS, BACK_ANALYSIS_ROW],
  ] as const)(
    'opened from %s offers presets of the real balance under the real header',
    async (_case, origin, back) => {
      const { press, calls } = setup({ readTradingAccess: () => Promise.resolve(realAccess()) });
      await press(stakeOpenCallbackData(R, origin));
      const edit = lastPayload(calls);
      expect(edit?.text).toBe(
        stakePickerText({
          user: { ...userContextOf(USER.first_name, R, realAccess()), stake: null },
          mode: R,
          minTradeAmount: d('1.00000000'),
          demoAvailable: d('10000.00000000'),
          realAvailable: d('7'),
          presets: 3,
        }).value,
      );
      const text = plainTextOf(edit?.text as string);
      expect(text).toContain('💼 Сумма реальной сделки');
      expect(text).toContain('Реальный баланс: $7.00');
      expect(text).toContain('Сейчас: минимальная ставка брокера ($1.00)');
      expect(text).not.toMatch(/демо/i);
      expect(rowsOf(edit)).toEqual([
        [
          preset('1', '$1.00 ✅', origin, R),
          preset('2', '$2.00', origin, R),
          preset('5', '$5.00', origin, R),
        ],
        [...CUSTOM(origin, R), ...back],
      ]);
    },
  );

  it('marks the saved real stake, not the demo one, and offers the real reset', async () => {
    const { press, calls } = setup({
      readTradingAccess: () => Promise.resolve(realAccess(d('5'))),
    });
    await press(stakeOpenCallbackData(R, SETTINGS));
    const edit = lastPayload(calls);
    expect(plainTextOf(edit?.text as string)).toContain('Сейчас: $5.00');
    expect(rowsOf(edit)).toEqual([
      [
        preset('1', '$1.00', SETTINGS, R),
        preset('2', '$2.00', SETTINGS, R),
        preset('5', '$5.00 ✅', SETTINGS, R),
      ],
      [
        ...CUSTOM(SETTINGS, R),
        button(LABELS.stakeResetButton, stakeResetCallbackData(R, SETTINGS)),
        ...BACK_SETTINGS,
      ],
    ]);
  });

  it('says the real balance covers not even the minimum', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(
          accessView({
            broker: brokerBalance({ real: { available: d('0.5'), held: d('0'), total: d('0.5') } }),
          }),
        ),
    });
    await press(stakeOpenCallbackData(R, SETTINGS));
    const edit = lastPayload(calls);
    expect(edit?.text).toContain(plainTextOf(TEXTS.stakePickerNoPresetsReal(pickerContext(R))));
    expect(rowsOf(edit)).toEqual([[...CUSTOM(SETTINGS, R), ...BACK_SETTINGS]]);
  });

  it.each([
    ['a preset', stakePresetCallbackData('5', R, SETTINGS), '5'],
    ['the reset', stakeResetCallbackData(R, SETTINGS), null],
  ])('saves %s in the real mode and words it as the real stake', async (_case, data, amount) => {
    const { press, calls, setStake } = setup();
    await press(data);
    expect(setStake.mock.calls).toEqual([[String(USER.id), R, amount]]);
    expect(lastPayload(calls)?.text).toBe(
      TEXTS.stakeSavedReal({
        stake: amount === null ? null : d(amount),
        firstName: USER.first_name,
      }).value,
    );
    expect(rowsOf(lastPayload(calls))).toEqual([BACK_SETTINGS]);
  });

  it('prompts for a real amount and saves the typed one in the real mode', async () => {
    const { press, type, calls, loginDialog, setStake } = setup();
    await press(stakeCustomCallbackData(R, SETTINGS));
    expect(loginDialog.get(USER.id)).toEqual(ON_REAL_STEP);
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeInputPromptReal.value);
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.stakeBackButton, stakeOpenCallbackData(R, SETTINGS))],
    ]);
    await type('2,50');
    expect(setStake.mock.calls).toEqual([[String(USER.id), R, '2.5']]);
    expect(lastPayload(calls)?.text).toBe(
      TEXTS.stakeSavedReal({ stake: d('2.5'), firstName: USER.first_name }).value,
    );
    expect(loginDialog.get(USER.id)).toBeUndefined();
  });

  it.each([
    [
      'stake_precision',
      TEXTS.stakePrecisionDigitsReal({ digits: '2', minStake: d('1'), realAvailable: d('7') }),
    ],
    ['stake_below_minimum', TEXTS.stakeBelowMinimum({ minStake: d('1') })],
    [
      'insufficient_balance',
      TEXTS.stakeAboveAvailableAmountReal({ realAvailable: d('7'), minStake: d('1') }),
    ],
  ] as const)('words the real refusal %s from its limits', async (error, text) => {
    const { press, calls } = setup({
      setStake: () =>
        Promise.resolve({
          refused: { error, limits: { minTradeAmount: d('1'), available: d('7'), scale: 2 } },
        }),
    });
    await press(stakePresetCallbackData('10', R, SETTINGS));
    expect(lastPayload(calls)?.text).toBe(text.value);
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.stakeMenuButton, stakeOpenCallbackData(R, SETTINGS)), ...BACK_SETTINGS],
    ]);
  });

  it('names the real balance in the over-balance refusal', () => {
    expect(
      plainTextOf(TEXTS.stakeAboveAvailableAmountReal({ realAvailable: d('7'), minStake: d('1') })),
    ).toBe('⚠️ На реальном счёте доступно $7.00. Выбери сумму поменьше.');
  });

  it('keeps the real step and offers the real picker again when the outcome is unknown', async () => {
    const { type, calls, loginDialog, logger } = setup({
      dialog: ON_REAL_STEP,
      setStake: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await type('5');
    expect(lastPayload(calls)?.text).toBe(TEXTS.stakeSaveUnknown.value);
    expect(rowsOf(lastPayload(calls))).toEqual([
      [button(LABELS.stakeMenuButton, stakeOpenCallbackData(R, SETTINGS)), ...BACK_SETTINGS],
    ]);
    expect(loginDialog.get(USER.id)).toEqual(ON_REAL_STEP);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ mode: R });
    expect(warnings(logger)).toEqual(['stake save outcome unknown']);
  });

  // a launch screen's picker is the demo cycle's; a saved line names the mode of the saved stake
  it.each([
    [TradeMode.Demo, '✅ Демо-ставка сохранена: $5.00'],
    [R, '✅ Реальная ставка сохранена: $5.00'],
  ] as const)(
    'returns a %s save from a launch screen under the line of its mode',
    async (mode, line) => {
      // what access reads after the save: a real save leaves the demo stake unsaved
      const { press, calls } = setup({
        readTradingAccess: () =>
          Promise.resolve(
            mode === R ? accessView({ realStake: d('5') }) : accessView({ demoStake: d('5') }),
          ),
      });
      await press(stakePresetCallbackData('5', mode, PAIR));
      const text = plainTextOf(lastPayload(calls)?.text as string);
      expect(text.split('\n')[0]).toBe(line);
      // a demo user's amount screen marks the demo stake (#476): a real save leaves the minimum
      const marked = rowsOf(lastPayload(calls))
        .flat()
        .filter((key) => key.text.includes('✅'))
        .map((key) => key.text);
      expect(marked).toEqual([mode === R ? '$1.00 ✅' : '$5.00 ✅']);
    },
  );

  it('trades the saved real stake on the real launch after a real save', async () => {
    const { press, calls } = setup({
      readTradingAccess: () =>
        Promise.resolve(accessView({ tradingMode: R, realStake: d('5'), demoStake: d('2') })),
    });
    await press(stakePresetCallbackData('5', R, PAIR));
    const screen = launchScreen({
      assetId: PAIR_EURUSD.id,
      durationSec: 5,
      firstName: USER.first_name,
      symbol: pairLabel(PAIR_EURUSD),
      amount: d('5'),
      saved: { amount: d('5'), mode: R },
      mode: R,
    });
    expect(lastPayload(calls)?.text).toBe(screen.text.value);
  });
});

// #326: data drawn before the mode segment existed loses its keyboard and saves nothing
describe('a stake picker datum without a mode', () => {
  it.each(['stk:o:s', 'stk:s:5:a:101:5', `stk:z:p:${PAIR_EURUSD.id}:15`, 'stk:c:s'])(
    'removes the keyboard of %s and saves nothing',
    async (data) => {
      const { press, calls, readTradingAccess, setStake, loginDialog } = setup();
      await press(data);
      expect(calls.map((call) => call.method)).toContain('editMessageReplyMarkup');
      expect(readTradingAccess).not.toHaveBeenCalled();
      expect(setStake).not.toHaveBeenCalled();
      expect(loginDialog.get(USER.id)).toBeUndefined();
    },
  );
});
