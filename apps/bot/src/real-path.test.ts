import { describe, expect, it } from 'vitest';
import {
  BUY_CALLBACK_DATA,
  buyPackageCallbackData,
  decimalStringSchema,
  sessionStopCallbackData,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type TradingAccessResponse,
  type TradingSessionView,
  demoAnalysisCallbackData,
  MODE_CALLBACK_DATA,
} from '@binarius/shared';
import { BackendError, BackendErrorCode } from './backend-client';
import { createBot } from './bot';
import {
  analysisMoreCallbackData,
  demoAssetCallbackData,
  demoLaunchCallbackData,
  demoPageCallbackData,
  sessionStartCallbackData,
  stakeCallbackData,
  stakeFingerprint,
  stakeMenuCallbackData,
} from './demo';
import { intentCallbackData } from './demo-trade';
import { MODE_SCREEN_CALLBACK_DATA } from './trading-mode';
import {
  stakeCustomCallbackData,
  stakePresetCallbackData,
  stakeResetCallbackData,
} from './stake-picker';
import {
  BOT_INFO,
  BROKER_BALANCE,
  CARD_MESSAGE_ID,
  INTENT_ID,
  PAIR_EURUSD,
  PAIR_OTHER_TYPE,
  PAIRS_RESPONSE,
  SIGNAL_DATA_REFUSAL,
  SIGNAL_DECIDED,
  SIGNAL_FETCH_FAILED,
  SIGNAL_NO_SIGNAL,
  LINK_ACTIVE,
  STAKE_NONCE,
  STARS_INVOICE,
  TEXT_CARD_MESSAGE_ID,
  accessView,
  accountView,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  intentView,
  messageAnswer,
  animationAnswer,
  SCAN_FILE_ID,
  SCAN_MESSAGE_ID,
  photoAnswer,
  SESSION_ID,
  sessionView,
  signalsResponse,
  stubSessionResumer,
  stubSignalWaiter,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  userView,
  type ApiCall,
  stubShownSignals,
} from './testing';

// The real path (#121, Plan 5 decision 29): every screen a user in real mode can reach, rendered
// through the real handlers on the catalog's default texts, must not call the trade a demo. One
// oracle for the class rather than a list of instances: a new screen reachable in real mode is
// added to SCENES. Staff overrides of the texts are not covered (Rule 36, stated). Sessions run in
// real mode too (#327): the words of a cycle and a session are no longer demo words.
const DEMO_WORDING = /деньги не нужны|это демо|демо-сделк|демо-торговл|демо-сесси|на демо-сч/i;

const NOW = 1_790_000_000_000;
const REAL = accessView({ tradingMode: TradeMode.Real });
// a pair paying 70 %: no payout refuses it since #631
const LOW_PAYOUT = PAIR_OTHER_TYPE;
const ANALYSIS = { kind: 'analysis', assetId: PAIR_EURUSD.id, durationSec: 5 } as const;
// both pairs of the launch scenes have a signal now (#664: the door reads the list)
const WITH_SIGNALS = signalsResponse(NOW, {
  '5s': [
    [PAIR_EURUSD.id, TradeAction.Up],
    [PAIR_OTHER_TYPE.id, TradeAction.Down],
  ],
});

interface Scene {
  name: string;
  update: ReturnType<typeof callbackUpdate>;
  evaluateSignal?: typeof SIGNAL_DECIDED;
  signals?: ReturnType<typeof signalsResponse>;
  access?: TradingAccessResponse;
  // #327: what the session routes answer; the start refuses mode_not_allowed by default
  startSession?: () => Promise<{ started: TradingSessionView }>;
  stopSession?: () => Promise<TradingSessionView>;
}

const sessionRefusal = (reason: TradingSessionErrorCode) => () =>
  Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 409, reason }));
const REAL_SESSION = sessionView({ mode: TradeMode.Real });

const press = (name: string, data: string, patch: Partial<Scene> = {}): Scene => ({
  name,
  update: callbackUpdate(data),
  ...patch,
});

const SCENES: Scene[] = [
  { name: '/menu', update: textUpdate('/menu') },
  press('the signals from the card', 'demo'),
  press('the signals', 'demo:sig', {
    signals: signalsResponse(NOW, { '5s': [[PAIR_EURUSD.id, TradeAction.Up]] }),
  }),
  press('the signals, empty', 'demo:sig', { signals: signalsResponse(NOW) }),
  press('the launch', demoLaunchCallbackData(PAIR_EURUSD.id, 5), { signals: WITH_SIGNALS }),
  press('the launch at a 70 % payout', demoLaunchCallbackData(LOW_PAYOUT.id, 5), {
    signals: WITH_SIGNALS,
  }),
  // #664, #828: the door drawn without a signal (`n`) on a pair without one waits for it, with the
  // other pairs
  press('the launch, no signal', demoLaunchCallbackData(PAIR_EURUSD.id, 5, 'n'), {
    signals: signalsResponse(NOW, { '5s': [[LOW_PAYOUT.id, TradeAction.Up]] }),
  }),
  press(
    'a save from the launch',
    stakePresetCallbackData('5', TradeMode.Demo, {
      kind: 'pair',
      assetId: PAIR_EURUSD.id,
      durationSec: 5,
    }),
  ),
  press(
    'a save from the launch at a 70 % payout',
    stakePresetCallbackData('5', TradeMode.Demo, {
      kind: 'pair',
      assetId: LOW_PAYOUT.id,
      durationSec: 5,
    }),
  ),
  press('the types', 'demo:g'),
  press('a type', demoPageCallbackData('currency', 0)),
  press('a pair', demoAssetCallbackData(PAIR_EURUSD.id)),
  press('the summary of an old button', `demo:d:${String(PAIR_EURUSD.id)}:5`),
  press('the analysis, a signal', demoAnalysisCallbackData(PAIR_EURUSD.id, 5)),
  press('the analysis, a rule refusal', demoAnalysisCallbackData(PAIR_EURUSD.id, 5), {
    evaluateSignal: SIGNAL_NO_SIGNAL,
  }),
  press('the analysis, a data refusal', demoAnalysisCallbackData(PAIR_EURUSD.id, 5), {
    evaluateSignal: SIGNAL_DATA_REFUSAL,
  }),
  press('the analysis, fetch_failed', demoAnalysisCallbackData(PAIR_EURUSD.id, 5), {
    evaluateSignal: SIGNAL_FETCH_FAILED,
  }),
  press('the analysis at a 70 % payout', demoAnalysisCallbackData(LOW_PAYOUT.id, 5)),
  press('«➕ Ещё»', analysisMoreCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, TradeMode.Real)),
  press(
    'the REAL stake press',
    stakeCallbackData(
      PAIR_EURUSD.id,
      5,
      TradeAction.Up,
      STAKE_NONCE,
      stakeFingerprint(BROKER_BALANCE.minTradeAmount, TradeMode.Real),
    ),
  ),
  press('the refresh of a settled real trade', intentCallbackData(INTENT_ID)),
  press(
    'a demo session button of an earlier render',
    sessionStartCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 5),
  ),
  // #327: a real session's start, its refusal for the balance and its end
  press('a real session start', sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5), {
    startSession: () => Promise.resolve({ started: REAL_SESSION }),
  }),
  press(
    'a real session refused for the balance',
    sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
    { startSession: sessionRefusal(TradingSessionErrorCode.InsufficientBalance) },
  ),
  // the stop under the waiting message (#536): the reply's «🔁 Ещё сессия» in real
  press('a stopped real session', sessionStopCallbackData(SESSION_ID, { waiting: true }), {
    stopSession: () =>
      Promise.resolve(
        sessionView({
          ...REAL_SESSION,
          status: TradingSessionStatus.Stopped,
          stopReason: TradingSessionStopReason.StakeStop,
          endedAt: '2026-10-07T10:30:00.000Z',
        }),
      ),
  }),
  // #326: the real picker opened from a real expansion, without and with a saved real stake.
  // /settings is no scene: it names both modes by the owner's decision 1.
  ...[null, decimalStringSchema.parse('5')].flatMap((realStake) => {
    const access = accessView({ tradingMode: TradeMode.Real, realStake });
    const at = `, the real stake ${realStake ?? 'unset'}`;
    return [
      press(
        `«💵 Сумма» of a real expansion${at}`,
        stakeMenuCallbackData(TradeMode.Real, PAIR_EURUSD.id, 5),
        { access },
      ),
      press(`a real preset${at}`, stakePresetCallbackData('5', TradeMode.Real, ANALYSIS), {
        access,
      }),
      press(`the real reset${at}`, stakeResetCallbackData(TradeMode.Real, ANALYSIS), { access }),
      press(`the real custom prompt${at}`, stakeCustomCallbackData(TradeMode.Real, ANALYSIS), {
        access,
      }),
    ];
  }),
  // the mode screen (#474): opened from /settings (#686) and redrawn in place («↩️ Отмена», «⚙️ Режим»);
  // a switch's result is no scene: after «🎮 В демо» the user is in demo
  press('the mode screen of a real user', MODE_CALLBACK_DATA),
  press('the mode screen in place', MODE_SCREEN_CALLBACK_DATA),
  // the purchase (#117): the same screens in both modes
  { name: '/buy', update: textUpdate('/buy') },
  press('the buy button', BUY_CALLBACK_DATA),
  press('a package', buyPackageCallbackData('p150')),
];

async function shown(scene: Scene, access: TradingAccessResponse): Promise<string[]> {
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    sessionResumer: stubSessionResumer(),
    signalWaiter: stubSignalWaiter(),
    shownSignals: stubShownSignals(),
    token: '123456:AA-bot-token',
    backend: fakeBackend({
      recordStart: () => Promise.resolve(userView({ hasActiveBrokerAccount: true })),
      readTradingAccess: () => Promise.resolve(access),
      readPairs: () => Promise.resolve(PAIRS_RESPONSE),
      readSignals: () => Promise.resolve(scene.signals ?? signalsResponse(NOW)),
      evaluateSignal: () => Promise.resolve(scene.evaluateSignal ?? SIGNAL_DECIDED),
      setStake: (_id, _mode, amount) => Promise.resolve({ saved: amount }),
      readAccount: () => Promise.resolve(accountView({ accounts: [LINK_ACTIVE] })),
      createStarsInvoice: () => Promise.resolve(STARS_INVOICE),
      createIntent: (request) => Promise.resolve(intentView({ mode: request.mode })),
      readIntent: () =>
        Promise.resolve(intentView({ mode: TradeMode.Real, status: TradeIntentStatus.Settled })),
      startSession: scene.startSession ?? sessionRefusal(TradingSessionErrorCode.ModeNotAllowed),
      readSession: () => Promise.resolve(REAL_SESSION),
      stopSession: scene.stopSession ?? (() => Promise.resolve(REAL_SESSION)),
    }),
    logger: fakeLogger(),
    botInfo: BOT_INFO,
    now: () => NOW,
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  api.answers.set('sendAnimation', animationAnswer(SCAN_MESSAGE_ID, SCAN_FILE_ID));
  // the analysis card reads the file_id of the photo it sent (#482)
  api.answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, ['card-file-id']));
  await bot.handleUpdate(scene.update);
  return api.calls.flatMap(wordsOf);
}

// what a user reads: the text or the caption (a media edit's in its media, #859), and every
// button's label
function wordsOf({ payload }: ApiCall): string[] {
  const rows =
    (payload.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined)
      ?.inline_keyboard ?? [];
  const media = payload.media as { caption?: unknown } | undefined;
  return [
    payload.text,
    payload.caption,
    media?.caption,
    ...rows.flat().map((button) => button.text),
  ].filter((value): value is string => typeof value === 'string');
}

describe('the real path (#121)', () => {
  it.each(SCENES)('$name never calls the trade a demo', async (scene) => {
    const words = await shown(scene, scene.access ?? REAL);
    expect(words.length, 'the scene sent or edited nothing').toBeGreaterThan(0);
    for (const word of words) expect(word).not.toMatch(DEMO_WORDING);
  });

  // #327: what a real session shows in place of the demo words
  it.each([
    ['a real session start', 'Реальная сессия'],
    ['a real session refused for the balance', 'На реальном счёте недостаточно средств'],
    ['a stopped real session', '🔁 Ещё сессия · REAL'],
    ['a stopped real session', 'проверь баланс в /account'],
    ['a demo session button of an earlier render', 'Режим или сумма сделки изменились'],
    ['the launch', '🚀 Запустить цикл · REAL'],
    ['the launch, no signal', 'Проверяю сигнал по EUR/USD'],
    ['the launch, no signal', 'Сигнал уже есть по другим парам'],
    ['the analysis, a rule refusal', 'Проверяю сигнал…'],
    ['the analysis, a signal', '🚀 Сессия из 5 циклов · REAL'],
    ['«➕ Ещё»', '🚀 Сессия из 5 циклов · REAL'],
    ['the refresh of a settled real trade', '🚀 Сессия из 5 циклов · REAL'],
    // the card's entry (#121; since #686 the card has no mode button), and the mode screen's way
    // back to demo (#474)
    ['/menu', '🚀 Торговать'],
    ['the mode screen of a real user', 'Сейчас: <b>REAL</b>'],
    ['the mode screen in place', '🎮 В демо'],
  ])('%s shows «%s»', async (name, expected) => {
    const scene = SCENES.find((candidate) => candidate.name === name)!;
    const words = await shown(scene, scene.access ?? REAL);
    expect(words.some((word) => word.includes(expected))).toBe(true);
  });

  // the control: the same oracle on a demo launch does match, so the pattern cannot go dead
  it('matches the demo launch of a demo user', async () => {
    const words = await shown(
      press('the launch', demoLaunchCallbackData(PAIR_EURUSD.id, 5), { signals: WITH_SIGNALS }),
      accessView({ tradingMode: TradeMode.Demo }),
    );
    expect(words.some((word) => DEMO_WORDING.test(word))).toBe(true);
  });
});
