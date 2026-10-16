import { describe, expect, it } from 'vitest';
import {
  BUY_CALLBACK_DATA,
  buyPackageCallbackData,
  decimalStringSchema,
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  type TradingAccessResponse,
  type TradingSessionView,
  demoSignalsCallbackData,
} from '@binarius/shared';
import { BackendError, BackendErrorCode } from './backend-client';
import { createBot } from './bot';
import {
  analysisMoreCallbackData,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  demoDurationCallbackData,
  demoLaunchCallbackData,
  demoPageCallbackData,
  sessionStartCallbackData,
  stakeCallbackData,
  stakeFingerprint,
  stakeMenuCallbackData,
} from './demo';
import { intentCallbackData } from './demo-trade';
import { MODE_CALLBACK_DATA } from './keyboards';
import { MODE_SCREEN_CALLBACK_DATA } from './trading-mode';
import { sessionRefreshCallbackData } from './trading-session';
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
  photoAnswer,
  SESSION_ID,
  sessionView,
  signalsResponse,
  stubSessionResumer,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  userView,
  type ApiCall,
} from './testing';

// The real path (#121, Plan 5 decision 29): every screen a user in real mode can reach, rendered
// through the real handlers on the catalog's default texts, must not call the trade a demo. One
// oracle for the class rather than a list of instances: a new screen reachable in real mode is
// added to SCENES. Staff overrides of the texts are not covered (Rule 36, stated). Sessions run in
// real mode too (#327): the words of a cycle and a session are no longer demo words.
const DEMO_WORDING = /деньги не нужны|это демо|демо-сделк|демо-торговл|демо-сесси|на демо-сч/i;

const NOW = 1_790_000_000_000;
const REAL = accessView({ tradingMode: TradeMode.Real });
const BELOW_FLOOR = PAIR_OTHER_TYPE;
const ANALYSIS = { kind: 'analysis', assetId: PAIR_EURUSD.id, durationSec: 15 } as const;

interface Scene {
  name: string;
  update: ReturnType<typeof callbackUpdate>;
  evaluateSignal?: typeof SIGNAL_DECIDED;
  signals?: ReturnType<typeof signalsResponse>;
  access?: TradingAccessResponse;
  // #327: what the session routes answer; the start refuses mode_not_allowed by default
  startSession?: () => Promise<{ started: TradingSessionView }>;
  readSession?: () => Promise<TradingSessionView>;
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
  press('the durations', 'demo'),
  press('the signals', demoSignalsCallbackData(15), {
    signals: signalsResponse(NOW, { '15s': [[PAIR_EURUSD.id, TradeAction.Up]] }),
  }),
  press('the signals, empty', demoSignalsCallbackData(15), { signals: signalsResponse(NOW) }),
  press('the launch', demoLaunchCallbackData(PAIR_EURUSD.id, 15)),
  press('the launch below the cycle floor', demoLaunchCallbackData(BELOW_FLOOR.id, 15)),
  // #509: the launch on a pair without a signal now, and a signal that could not be read
  press('the launch, no signal', demoLaunchCallbackData(PAIR_EURUSD.id, 15), {
    evaluateSignal: SIGNAL_NO_SIGNAL,
  }),
  press('the launch, fetch_failed', demoLaunchCallbackData(PAIR_EURUSD.id, 15), {
    evaluateSignal: SIGNAL_FETCH_FAILED,
  }),
  press(
    'a real session refused for no signal',
    sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 15),
    { startSession: sessionRefusal(TradingSessionErrorCode.NoSignal) },
  ),
  press(
    'a save from the launch',
    stakePresetCallbackData('5', TradeMode.Demo, {
      kind: 'pair',
      assetId: PAIR_EURUSD.id,
      durationSec: 15,
    }),
  ),
  press(
    'a save from the launch below the cycle floor',
    stakePresetCallbackData('5', TradeMode.Demo, {
      kind: 'pair',
      assetId: BELOW_FLOOR.id,
      durationSec: 15,
    }),
  ),
  press('the types', 'demo:g'),
  press('a type', demoPageCallbackData('currency', 0)),
  press('a pair', demoAssetCallbackData(PAIR_EURUSD.id)),
  press('the summary', demoDurationCallbackData(PAIR_EURUSD.id, 15)),
  press('the analysis, a signal', demoAnalysisCallbackData(PAIR_EURUSD.id, 15)),
  press('the analysis, a rule refusal', demoAnalysisCallbackData(PAIR_EURUSD.id, 15), {
    evaluateSignal: SIGNAL_NO_SIGNAL,
  }),
  press('the analysis, a data refusal', demoAnalysisCallbackData(PAIR_EURUSD.id, 15), {
    evaluateSignal: SIGNAL_DATA_REFUSAL,
  }),
  press('the analysis, fetch_failed', demoAnalysisCallbackData(PAIR_EURUSD.id, 15), {
    evaluateSignal: SIGNAL_FETCH_FAILED,
  }),
  press('the analysis below the cycle floor', demoAnalysisCallbackData(BELOW_FLOOR.id, 15)),
  press(
    '«➕ Ещё»',
    analysisMoreCallbackData(PAIR_EURUSD.id, 15, TradeAction.Up, true, TradeMode.Real),
  ),
  press(
    'the REAL stake press',
    stakeCallbackData(
      PAIR_EURUSD.id,
      15,
      TradeAction.Up,
      STAKE_NONCE,
      stakeFingerprint(BROKER_BALANCE.minTradeAmount, TradeMode.Real),
    ),
  ),
  press('the refresh of a settled real trade', intentCallbackData(INTENT_ID)),
  press(
    'a demo session button of an earlier render',
    sessionStartCallbackData(TradeMode.Demo, PAIR_EURUSD.id, 15),
  ),
  // #327: a real session's start, its refusal for the balance and its end
  press('a real session start', sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 15), {
    startSession: () => Promise.resolve({ started: REAL_SESSION }),
  }),
  press(
    'a real session refused for the balance',
    sessionStartCallbackData(TradeMode.Real, PAIR_EURUSD.id, 15),
    { startSession: sessionRefusal(TradingSessionErrorCode.InsufficientBalance) },
  ),
  press('a stopped real session', sessionRefreshCallbackData(SESSION_ID), {
    readSession: () =>
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
        stakeMenuCallbackData(TradeMode.Real, PAIR_EURUSD.id, 15),
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
  // the mode screen (#474): opened from the card and redrawn in place («↩️ Отмена», «⚙️ Режим»);
  // a switch's result is no scene: after «🎮 Вернуться в демо» the user is in demo
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
      readSession: scene.readSession ?? (() => Promise.resolve(REAL_SESSION)),
    }),
    logger: fakeLogger(),
    botInfo: BOT_INFO,
    now: () => NOW,
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  // the analysis card reads the file_id of the photo it sent (#482)
  api.answers.set('sendPhoto', photoAnswer(CARD_MESSAGE_ID, ['card-file-id']));
  await bot.handleUpdate(scene.update);
  return api.calls.flatMap(wordsOf);
}

// what a user reads: the text or the caption, and every button's label
function wordsOf({ payload }: ApiCall): string[] {
  const rows =
    (payload.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined)
      ?.inline_keyboard ?? [];
  return [payload.text, payload.caption, ...rows.flat().map((button) => button.text)].filter(
    (value): value is string => typeof value === 'string',
  );
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
    ['the launch, no signal', 'По паре сейчас нет сигнала'],
    ['the launch, fetch_failed', 'Не удалось проверить сигнал пары'],
    ['a real session refused for no signal', '🔀 Выбрать другую пару'],
    ['the analysis, a signal', '🚀 Сессия из 5 циклов · REAL'],
    ['«➕ Ещё»', '🚀 Сессия из 5 циклов · REAL'],
    ['the refresh of a settled real trade', '🚀 Сессия из 5 циклов · REAL'],
    // #474: the card's way to the mode screen, and the screen's way back to demo
    ['/menu', '🎮 Вернуться в демо'],
    ['the mode screen of a real user', 'Сейчас: <b>REAL</b>'],
    ['the mode screen in place', '🎮 Вернуться в демо'],
  ])('%s shows «%s»', async (name, expected) => {
    const scene = SCENES.find((candidate) => candidate.name === name)!;
    const words = await shown(scene, scene.access ?? REAL);
    expect(words.some((word) => word.includes(expected))).toBe(true);
  });

  // the control: the same oracle on a demo launch does match, so the pattern cannot go dead
  it('matches the demo launch of a demo user', async () => {
    const words = await shown(
      press('the launch', demoLaunchCallbackData(PAIR_EURUSD.id, 15)),
      accessView({ tradingMode: TradeMode.Demo }),
    );
    expect(words.some((word) => DEMO_WORDING.test(word))).toBe(true);
  });
});
