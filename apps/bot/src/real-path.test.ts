import { describe, expect, it } from 'vitest';
import {
  TradeAction,
  TradeIntentStatus,
  TradeMode,
  TradingSessionErrorCode,
  type TradingAccessResponse,
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
  demoSignalsCallbackData,
  sessionStartCallbackData,
  stakeCallbackData,
  stakeFingerprint,
} from './demo';
import { intentCallbackData } from './demo-trade';
import { stakePresetCallbackData } from './stake-picker';
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
  STAKE_NONCE,
  TEXT_CARD_MESSAGE_ID,
  accessView,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  intentView,
  messageAnswer,
  signalsResponse,
  stubSessionTracker,
  stubTracker,
  textUpdate,
  userView,
  type ApiCall,
} from './testing';

// The real path (#121, Plan 5 decision 29): every screen a user in real mode can reach, rendered
// through the real handlers on the catalog's default texts, must not call the trade a demo. One
// oracle for the class rather than a list of instances: a new screen reachable in real mode is
// added to SCENES. Staff overrides of the texts are not covered (Rule 36, stated).
const DEMO_WORDING =
  /деньги не нужны|это демо|демо-сделк|демо-торговл|демо-сесси|автосесси|цикл сделок|запустит цикл|запустить цикл|цикл на этой паре|сессия из/i;

const NOW = 1_790_000_000_000;
const REAL = accessView({ tradingMode: TradeMode.Real });
const BELOW_FLOOR = PAIR_OTHER_TYPE;

interface Scene {
  name: string;
  update: ReturnType<typeof callbackUpdate>;
  evaluateSignal?: typeof SIGNAL_DECIDED;
  signals?: ReturnType<typeof signalsResponse>;
}

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
  press(
    'a save from the launch',
    stakePresetCallbackData('5', { kind: 'pair', assetId: PAIR_EURUSD.id, durationSec: 15 }),
  ),
  press(
    'a save from the launch below the cycle floor',
    stakePresetCallbackData('5', { kind: 'pair', assetId: BELOW_FLOOR.id, durationSec: 15 }),
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
  press('a session button of an earlier render', sessionStartCallbackData(PAIR_EURUSD.id, 15)),
];

async function shown(scene: Scene, access: TradingAccessResponse): Promise<string[]> {
  const bot = createBot({
    intentTracker: stubTracker(),
    sessionTracker: stubSessionTracker(),
    token: '123456:AA-bot-token',
    backend: fakeBackend({
      recordStart: () => Promise.resolve(userView({ hasActiveBrokerAccount: true })),
      readTradingAccess: () => Promise.resolve(access),
      readPairs: () => Promise.resolve(PAIRS_RESPONSE),
      readSignals: () => Promise.resolve(scene.signals ?? signalsResponse(NOW)),
      evaluateSignal: () => Promise.resolve(scene.evaluateSignal ?? SIGNAL_DECIDED),
      setDemoStake: (_id, amount) => Promise.resolve({ saved: amount }),
      createIntent: (request) => Promise.resolve(intentView({ mode: request.mode })),
      readIntent: () =>
        Promise.resolve(intentView({ mode: TradeMode.Real, status: TradeIntentStatus.Settled })),
      startSession: () =>
        Promise.reject(
          new BackendError(BackendErrorCode.HttpStatus, {
            status: 409,
            reason: TradingSessionErrorCode.ModeNotAllowed,
          }),
        ),
    }),
    logger: fakeLogger(),
    botInfo: BOT_INFO,
    now: () => NOW,
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  api.answers.set('sendPhoto', messageAnswer(CARD_MESSAGE_ID));
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
    const words = await shown(scene, REAL);
    expect(words.length, 'the scene sent or edited nothing').toBeGreaterThan(0);
    for (const word of words) expect(word).not.toMatch(DEMO_WORDING);
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
