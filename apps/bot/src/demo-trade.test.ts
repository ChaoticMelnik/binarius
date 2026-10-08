import { HttpError } from 'grammy';
import type { ApiError } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrokerBalanceUnavailableReason,
  PairsCatalogErrorCode,
  TradeAction,
  TradeIntentErrorCode,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  decimalStringSchema,
  defaultBotTextSource,
  UserStatus,
  type PairsCatalogResponse,
  type TelegramHtml,
  type TradingAccessResponse,
  CONNECT_CALLBACK_DATA,
  DEMO_CALLBACK_DATA,
} from '@binarius/shared';
import { telegramHtml } from '@binarius/shared';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { createBot } from './bot';
import {
  DEMO_GROUPS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  stakeCallbackData,
  stakeFingerprint,
  stakeMenuCallbackData,
} from './demo';
import { intentCallbackData } from './demo-trade';
import type { IntentTrackRequest } from './intent-tracker';
import { createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  ACCESS_VIEW,
  BOT_INFO,
  INTENT_ID,
  INTENT_VIEW,
  PAIR_CLOSED,
  PAIR_EURUSD,
  PAIRS_RESPONSE,
  STAKE_FINGERPRINT,
  STAKE_NONCE,
  TEXT_CARD_MESSAGE_ID,
  USER,
  accessView,
  callbackUpdate,
  captureApi,
  fakeBackend,
  fakeLogger,
  intentView,
  stubText,
  stubTextSource,
  messageAnswer,
  pairsResponse,
  stubSessionTracker,
  stubTracker,
  type ApiCall,
} from './testing';
import { intentStatusText, LABELS, setBotTextSource, TEXTS } from './texts';

const NOW = 1_790_000_000_000;
const STAKE = stakeCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, STAKE_NONCE, STAKE_FINGERPRINT);
const REFRESH = intentCallbackData(INTENT_ID);

interface Button {
  text: string;
  callback_data?: string;
}

function setup(
  options: {
    readPairs?: BackendClient['readPairs'];
    readTradingAccess?: BackendClient['readTradingAccess'];
    createIntent?: BackendClient['createIntent'];
    readIntent?: BackendClient['readIntent'];
    dialog?: LoginDialogState;
  } = {},
) {
  const readPairs = vi.fn(options.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)));
  const readTradingAccess = vi.fn(
    options.readTradingAccess ?? (() => Promise.resolve(ACCESS_VIEW)),
  );
  const createIntent = vi.fn<BackendClient['createIntent']>(
    options.createIntent ?? (() => Promise.resolve(INTENT_VIEW)),
  );
  const readIntent = vi.fn<BackendClient['readIntent']>(
    options.readIntent ?? (() => Promise.resolve(INTENT_VIEW)),
  );
  const logger = fakeLogger();
  const intentTracker = stubTracker();
  const loginDialog = createLoginDialog();
  if (options.dialog !== undefined) loginDialog.set(USER.id, options.dialog);
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: fakeBackend({ readPairs, readTradingAccess, createIntent, readIntent }),
    logger,
    botInfo: BOT_INFO,
    loginDialog,
    now: () => NOW,
    intentTracker,
    sessionTracker: stubSessionTracker(),
  });
  const api = captureApi(bot);
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  const press = (data: string, chatType?: string) =>
    bot.handleUpdate(callbackUpdate(data, chatType));
  return {
    press,
    logger,
    loginDialog,
    intentTracker,
    readPairs,
    readTradingAccess,
    createIntent,
    readIntent,
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

const REFRESH_ROWS = [[button(LABELS.refreshIntentButton, REFRESH)]];
const CONNECT_ROWS = [[button(LABELS.connectButton, CONNECT_CALLBACK_DATA)]];
const BACK_GROUPS = button(LABELS.demoBackGroupsButton, DEMO_GROUPS_CALLBACK_DATA);
const STAKE_MENU_ROWS = [
  [button(LABELS.stakeMenuButton, stakeMenuCallbackData(PAIR_EURUSD.id, 5))],
];
const BACK_DURATIONS = button(
  LABELS.demoBackDurationsButton,
  demoAssetCallbackData(PAIR_EURUSD.id),
);

const httpError = (status: number, reason?: string) =>
  new BackendError(BackendErrorCode.HttpStatus, {
    status,
    ...(reason === undefined ? {} : { reason }),
  });
const statusOf = (view = INTENT_VIEW) => intentStatusText(PAIR_EURUSD.symbol, view).value;

const EDIT_GONE: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message to edit not found',
};
const EDIT_NOT_MODIFIED: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message is not modified: specified new message content is the same',
};
const QUERY_TOO_OLD: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: query is too old',
};

describe('the stake button', () => {
  it('creates the intent with the button nonce as its key, sends the status, and tracks it', async () => {
    const { press, calls, createIntent, readPairs, readTradingAccess, intentTracker } = setup();
    await press(STAKE);

    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(readPairs).toHaveBeenCalledTimes(1);
    expect(readTradingAccess).toHaveBeenCalledWith(String(USER.id));
    expect(createIntent.mock.calls).toEqual([
      [
        {
          telegramUserId: String(USER.id),
          mode: TradeMode.Demo,
          assetId: PAIR_EURUSD.id,
          // the backend's string as received, never computed
          amount: ACCESS_VIEW.broker?.minTradeAmount,
          action: TradeAction.Up,
          durationSec: 5,
          clientRequestId: `demo:${USER.id}:${STAKE_NONCE}`,
        },
      ],
    ]);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(statusOf());
    expect(sent?.text).toContain('ждёт отправки');
    expect(sent?.parse_mode).toBe('HTML');
    expect(rowsOf(sent)).toEqual(REFRESH_ROWS);
    expect(intentTracker.track).toHaveBeenCalledTimes(1);
    expect(intentTracker.track.mock.calls[0]?.[0]).toMatchObject({
      intentId: INTENT_ID,
      telegramUserId: String(USER.id),
      symbol: PAIR_EURUSD.symbol,
      view: INTENT_VIEW,
    });
  });

  it("hands the tracker an edit of the status message's own id, keeping its button", async () => {
    const { press, calls, intentTracker } = setup();
    await press(STAKE);
    const entry = intentTracker.track.mock.calls[0]?.[0] as IntentTrackRequest;
    await entry.edit(telegramHtml`edited`);

    const edit = payloadOf(calls, 'editMessageText');
    expect(edit).toMatchObject({
      chat_id: USER.id,
      message_id: TEXT_CARD_MESSAGE_ID,
      text: 'edited',
      parse_mode: 'HTML',
    });
    expect(rowsOf(edit)).toEqual(REFRESH_ROWS);
  });

  it('sends the same key when the same button is pressed twice, and shows the replay', async () => {
    const answers = [INTENT_VIEW, intentView({ status: TradeIntentStatus.Submitting })];
    const { press, calls, createIntent, intentTracker } = setup({
      createIntent: () => Promise.resolve(answers.shift() ?? answers[0]!),
    });
    await press(STAKE);
    await press(STAKE);

    const keys = createIntent.mock.calls.map(([request]) => request.clientRequestId);
    expect(keys).toEqual([`demo:${USER.id}:${STAKE_NONCE}`, `demo:${USER.id}:${STAKE_NONCE}`]);
    const sent = calls.filter((call) => call.method === 'sendMessage');
    expect(sent.at(-1)?.payload.text).toBe(
      statusOf(intentView({ status: TradeIntentStatus.Submitting })),
    );
    // the tracker ignores an id it already follows; after a restart it would start here
    expect(intentTracker.track).toHaveBeenCalledTimes(2);
  });

  it('keys a button of another render by its own nonce', async () => {
    const { press, createIntent } = setup();
    await press(
      stakeCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, 'aaaaaaaaaaaa', STAKE_FINGERPRINT),
    );
    expect(createIntent.mock.calls[0]?.[0].clientRequestId).toBe(`demo:${USER.id}:aaaaaaaaaaaa`);
  });

  it.each([
    intentView({
      status: TradeIntentStatus.Rejected,
      lastError: TradeIntentFailureReason.ExecutorNotConfigured,
    }),
    intentView({ status: TradeIntentStatus.Accepted }),
    intentView({ status: TradeIntentStatus.Settled }),
  ])('shows a replay already at $status and does not track it', async (intent) => {
    const { press, calls, intentTracker } = setup({
      createIntent: () => Promise.resolve(intent),
    });
    await press(STAKE);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf(intent));
    expect(intentTracker.track).not.toHaveBeenCalled();
  });

  it.each([
    [TradeIntentErrorCode.UserBlocked, 409, TEXTS.blocked, []],
    [TradeIntentErrorCode.BrokerAccountNotFound, 404, TEXTS.accountNone, CONNECT_ROWS],
    [TradeIntentErrorCode.AmbiguousBrokerAccount, 409, TEXTS.statusAmbiguous, []],
    [TradeIntentErrorCode.AccountRevoked, 409, TEXTS.accountRevoked, CONNECT_ROWS],
    [TradeIntentErrorCode.AccountNotConfirmed, 409, TEXTS.stakeAccountNotConfirmed, []],
    [TradeIntentErrorCode.AccountHalted, 409, TEXTS.stakeAccountHalted, []],
    [TradeIntentErrorCode.InsufficientTokens, 409, TEXTS.stakeInsufficientTokens, []],
    [TradeIntentErrorCode.ActiveIntentExists, 409, TEXTS.stakeActiveIntent, []],
    [TradeIntentErrorCode.ClientRequestIdConflict, 409, TEXTS.stakeButtonUsed, []],
    [TradeIntentErrorCode.TradingPaused, 409, TEXTS.tradingPaused, []],
    [TradeIntentErrorCode.BalanceUnavailable, 409, TEXTS.stakeBalanceMissing, []],
    [TradeIntentErrorCode.StakePrecision, 409, TEXTS.stakePrecision, STAKE_MENU_ROWS],
    [
      TradeIntentErrorCode.StakeBelowMinimum,
      409,
      TEXTS.stakeBelowMinimum('$1.00'),
      STAKE_MENU_ROWS,
    ],
    [TradeIntentErrorCode.InsufficientDemoBalance, 409, TEXTS.stakeAboveAvailable, STAKE_MENU_ROWS],
  ] as const)(
    'answers %s with its text, asks once, and logs nothing',
    async (reason, status, text: TelegramHtml, rows: readonly Button[][]) => {
      const { press, calls, createIntent, logger, intentTracker } = setup({
        createIntent: () => Promise.reject(httpError(status, reason)),
      });
      await press(STAKE);
      expect(createIntent).toHaveBeenCalledTimes(1);
      const sent = payloadOf(calls, 'sendMessage');
      expect(sent?.text).toBe(text.value);
      expect(rowsOf(sent)).toEqual(rows);
      expect(warnings(logger)).toEqual([]);
      expect(intentTracker.track).not.toHaveBeenCalled();
    },
  );

  // #297: the amount is the saved stake, and the button only trades the amount it showed
  describe('the saved stake', () => {
    const saved = (demoStake: string) => () =>
      Promise.resolve(accessView({ demoStake: decimalStringSchema.parse(demoStake) }));
    const stakeFor = (fingerprint: string) =>
      stakeCallbackData(PAIR_EURUSD.id, 5, TradeAction.Up, STAKE_NONCE, fingerprint);

    it('trades the saved stake, not the broker minimum', async () => {
      const { press, createIntent } = setup({ readTradingAccess: saved('2.5') });
      await press(stakeFor(stakeFingerprint(decimalStringSchema.parse('2.5'))));
      expect(createIntent.mock.calls[0]?.[0].amount).toBe('2.5');
    });

    it('trades the broker minimum without a saved stake', async () => {
      const { press, createIntent } = setup();
      await press(STAKE);
      expect(createIntent.mock.calls[0]?.[0].amount).toBe('1.00000000');
    });

    it.each([
      ['drawn for the minimum, the stake saved since', saved('2.5'), STAKE],
      [
        'drawn for a stake, reset since',
        () => Promise.resolve(ACCESS_VIEW),
        stakeFor(stakeFingerprint(decimalStringSchema.parse('2.5'))),
      ],
      [
        'drawn without an amount',
        () => Promise.resolve(ACCESS_VIEW),
        stakeFor(stakeFingerprint(null)),
      ],
      [
        'from before the fingerprint',
        () => Promise.resolve(ACCESS_VIEW),
        `demo:stake:${PAIR_EURUSD.id}:5:up:${STAKE_NONCE}`,
      ],
    ])('refuses a button %s and creates nothing', async (_case, readTradingAccess, data) => {
      const { press, calls, createIntent, logger } = setup({ readTradingAccess });
      await press(data);
      expect(createIntent).not.toHaveBeenCalled();
      const sent = payloadOf(calls, 'sendMessage');
      expect(sent?.text).toBe(TEXTS.stakeAmountChanged.value);
      expect(rowsOf(sent)).toEqual([
        [button(LABELS.stakeBackAnalysisButton, demoAnalysisCallbackData(PAIR_EURUSD.id, 5))],
      ]);
      expect(warnings(logger)).toEqual([]);
    });

    it('names the minimum of this press when the backend refuses the stake below it', async () => {
      const { press, calls } = setup({
        readTradingAccess: () =>
          Promise.resolve(
            accessView({
              demoStake: decimalStringSchema.parse('2'),
              broker: { ...ACCESS_VIEW.broker!, minTradeAmount: decimalStringSchema.parse('5') },
            }),
          ),
        createIntent: () => Promise.reject(httpError(409, TradeIntentErrorCode.StakeBelowMinimum)),
      });
      await press(stakeFor(stakeFingerprint(decimalStringSchema.parse('2'))));
      expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.stakeBelowMinimum('$5.00').value);
    });
  });

  // the refusal names its text by key and reads it when it answers (#240)
  describe('with another text source', () => {
    afterEach(() => setBotTextSource(defaultBotTextSource));

    it('answers a refusal from the source in place', async () => {
      setBotTextSource(stubTextSource('stakeInsufficientTokens'));
      const { press, calls } = setup({
        createIntent: () => Promise.reject(httpError(409, TradeIntentErrorCode.InsufficientTokens)),
      });
      await press(STAKE);
      expect(payloadOf(calls, 'sendMessage')?.text).toBe(stubText('stakeInsufficientTokens'));
    });
  });

  it.each([
    ['user_not_found', httpError(404, TradeIntentErrorCode.UserNotFound)],
    ['validation', httpError(400, 'validation')],
    ['a bare 404', httpError(404)],
    ['a 401', httpError(401)],
  ])('says the service is unavailable on %s, asks once, and warns', async (_case, error) => {
    const { press, calls, createIntent, logger } = setup({
      createIntent: () => Promise.reject(error),
    });
    await press(STAKE);
    expect(createIntent).toHaveBeenCalledTimes(1);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(warnings(logger)).toEqual(['trade intent not created']);
  });

  it.each([
    ['unreachable', new BackendError(BackendErrorCode.Unreachable)],
    ['a 500', httpError(500)],
    ['a broken body', new BackendError(BackendErrorCode.ContractViolation)],
  ])('asks again with the same key when the outcome is %s', async (_case, error) => {
    const answers: (() => ReturnType<BackendClient['createIntent']>)[] = [
      () => Promise.reject(error),
      () => Promise.resolve(INTENT_VIEW),
    ];
    const { press, calls, createIntent, intentTracker, logger } = setup({
      createIntent: () => answers.shift()!(),
    });
    await press(STAKE);
    expect(createIntent).toHaveBeenCalledTimes(2);
    expect(createIntent.mock.calls[1]).toEqual(createIntent.mock.calls[0]);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf());
    expect(intentTracker.track).toHaveBeenCalledTimes(1);
    expect(warnings(logger)).toEqual([]);
  });

  it('says the outcome is unknown when the retry fails the same way, and warns once', async () => {
    const { press, calls, createIntent, logger, intentTracker } = setup({
      createIntent: () => Promise.reject(httpError(503)),
    });
    await press(STAKE);
    expect(createIntent).toHaveBeenCalledTimes(2);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.stakeOutcomeUnknown.value);
    expect(warnings(logger)).toEqual(['trade intent not created']);
    expect(intentTracker.track).not.toHaveBeenCalled();
  });

  const catalogOf =
    (patch: Partial<PairsCatalogResponse>): BackendClient['readPairs'] =>
    () =>
      Promise.resolve(pairsResponse(patch));

  type TradeFailureCase = [
    string,
    BackendClient['readPairs'],
    string,
    TelegramHtml,
    readonly (readonly Button[])[],
  ];
  it.each<TradeFailureCase>([
    [
      'the catalog is unavailable',
      () =>
        Promise.reject(httpError(503, PairsCatalogErrorCode.Unavailable)) as ReturnType<
          BackendClient['readPairs']
        >,
      STAKE,
      TEXTS.demoCatalogUnavailable,
      [[BACK_DURATIONS, BACK_GROUPS]],
    ],
    [
      'the catalog is stale',
      catalogOf({ fresh: false }),
      STAKE,
      TEXTS.demoCatalogStale,
      [[BACK_DURATIONS, BACK_GROUPS]],
    ],
    [
      'the pair is gone',
      catalogOf({ pairs: [PAIR_CLOSED] }),
      STAKE,
      TEXTS.demoPairMissing,
      [[BACK_GROUPS]],
    ],
    [
      'the pair is closed',
      catalogOf({ pairs: [PAIR_CLOSED] }),
      stakeCallbackData(PAIR_CLOSED.id, 5, TradeAction.Up, STAKE_NONCE, STAKE_FINGERPRINT),
      TEXTS.demoPairClosed(PAIR_CLOSED.symbol),
      [[BACK_GROUPS]],
    ],
    [
      "the duration is outside the pair's bounds",
      catalogOf({ pairs: [{ ...PAIR_EURUSD, maxTimeframe: 10 }] }),
      stakeCallbackData(PAIR_EURUSD.id, 15, TradeAction.Up, STAKE_NONCE, STAKE_FINGERPRINT),
      TEXTS.demoDurationUnsupported(PAIR_EURUSD.symbol),
      [[BACK_DURATIONS, BACK_GROUPS]],
    ],
  ])('creates nothing and says why when %s', async (_case, readPairs, data, text, rows) => {
    const { press, calls, createIntent, logger } = setup({ readPairs });
    await press(data);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(text.value);
    // no «🔄 Повторить» with the stake data: that would be a second stake button
    expect(rowsOf(sent)).toEqual(rows);
    expect(createIntent).not.toHaveBeenCalled();
    expect(warnings(logger)).toEqual([]);
  });

  it('warns and creates nothing when the catalog read fails', async () => {
    const { press, calls, createIntent, logger } = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(STAKE);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(createIntent).not.toHaveBeenCalled();
    expect(warnings(logger)).toEqual(['demo catalog not read']);
  });

  it('warns and creates nothing when the access read fails', async () => {
    const { press, calls, createIntent, logger } = setup({
      readTradingAccess: () => Promise.reject(httpError(500)),
    });
    await press(STAKE);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(createIntent).not.toHaveBeenCalled();
    expect(warnings(logger)).toEqual(['trading access not read']);
  });

  type AccessCase = [string, TradingAccessResponse, TelegramHtml, readonly (readonly Button[])[]];
  it.each<AccessCase>([
    ['a blocked user', accessView({ status: UserStatus.Blocked }), TEXTS.blocked, []],
    [
      'no account',
      accessView({ broker: null, brokerUnavailable: BrokerBalanceUnavailableReason.NoAccount }),
      TEXTS.accountNone,
      CONNECT_ROWS,
    ],
    [
      'more than one account',
      accessView({
        broker: null,
        brokerUnavailable: BrokerBalanceUnavailableReason.AmbiguousAccount,
      }),
      TEXTS.statusAmbiguous,
      [],
    ],
    ...Object.values(BrokerBalanceUnavailableReason)
      .filter(
        (reason) =>
          reason !== BrokerBalanceUnavailableReason.NoAccount &&
          reason !== BrokerBalanceUnavailableReason.AmbiguousAccount,
      )
      .map(
        (reason) =>
          [
            `no snapshot (${reason})`,
            accessView({ broker: null, brokerUnavailable: reason }),
            TEXTS.stakeBalanceMissing,
            [],
          ] satisfies AccessCase,
      ),
  ])('creates nothing for %s', async (_case, access, text, rows) => {
    const { press, calls, createIntent } = setup({
      readTradingAccess: () => Promise.resolve(access),
    });
    await press(STAKE);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(text.value);
    expect(rowsOf(sent)).toEqual(rows);
    expect(createIntent).not.toHaveBeenCalled();
  });

  it.each(['demo:stake:0:5:up:0123456789ab', 'demo:stake:2147483648:5:up:0123456789ab'])(
    'only stops the spinner on forged data %s',
    async (data) => {
      const { press, calls, readPairs, readTradingAccess, createIntent } = setup();
      await press(data);
      expect(methods(calls)).toEqual(['answerCallbackQuery']);
      expect(readPairs).not.toHaveBeenCalled();
      expect(readTradingAccess).not.toHaveBeenCalled();
      expect(createIntent).not.toHaveBeenCalled();
    },
  );

  it('does nothing outside a private chat', async () => {
    const { press, calls, createIntent } = setup();
    await press(STAKE, 'group');
    expect(calls).toEqual([]);
    expect(createIntent).not.toHaveBeenCalled();
  });

  it.each([DEMO_CALLBACK_DATA, demoAssetCallbackData(PAIR_EURUSD.id)])(
    'leaves %s to the demo screens',
    async (data) => {
      const { press, createIntent, readTradingAccess } = setup();
      await press(data);
      expect(createIntent).not.toHaveBeenCalled();
      expect(readTradingAccess).not.toHaveBeenCalled();
    },
  );

  it('logs a refused answer to the query and still sends the status', async () => {
    const { press, calls, apiErrors, logger } = setup();
    apiErrors.set('answerCallbackQuery', QUERY_TOO_OLD);
    await press(STAKE);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(statusOf());
    expect(warnings(logger)).toEqual(['answering the callback query failed']);
  });

  it('leaves the email dialog where it was', async () => {
    const step: LoginDialogState = { step: 'code', email: 'ada@example.test' };
    const { press, loginDialog } = setup({ dialog: step });
    await press(STAKE);
    expect(loginDialog.get(USER.id)).toEqual(step);
  });
});

describe('the refresh button', () => {
  const submitting = intentView({ status: TradeIntentStatus.Submitting });

  it('reads the intent as its presser and edits the status in place, symbol from the catalog', async () => {
    const { press, calls, readIntent, intentTracker } = setup({
      readIntent: () => Promise.resolve(submitting),
    });
    await press(REFRESH);
    expect(readIntent).toHaveBeenCalledWith(INTENT_ID, String(USER.id));
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const edit = payloadOf(calls, 'editMessageText');
    expect(edit?.text).toBe(statusOf(submitting));
    expect(rowsOf(edit)).toEqual(REFRESH_ROWS);
    expect(intentTracker.track).not.toHaveBeenCalled();
  });

  it('stands the asset id in for the symbol when the catalog cannot say', async () => {
    const { press, calls } = setup({
      readPairs: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    await press(REFRESH);
    expect(payloadOf(calls, 'editMessageText')?.text).toBe(
      intentStatusText(null, INTENT_VIEW).value,
    );
    expect(payloadOf(calls, 'editMessageText')?.text).toContain(`актив #${PAIR_EURUSD.id}`);
  });

  it('says the status is unavailable for an id that is not the presser’s, without a warning', async () => {
    const { press, calls, logger } = setup({
      readIntent: () => Promise.reject(httpError(404, 'not_found')),
    });
    await press(REFRESH);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.intentStatusUnavailable.value);
    expect(warnings(logger)).toEqual([]);
  });

  it.each([
    ['a 500', httpError(500)],
    ['a bare 404', httpError(404)],
    ['validation', httpError(400, 'validation')],
    ['unreachable', new BackendError(BackendErrorCode.Unreachable)],
  ])('says the service is unavailable and warns on %s', async (_case, error) => {
    const { press, calls, logger } = setup({ readIntent: () => Promise.reject(error) });
    await press(REFRESH);
    expect(payloadOf(calls, 'sendMessage')?.text).toBe(TEXTS.unavailable.value);
    expect(warnings(logger)).toEqual(['trade intent status not read']);
  });

  it.each(['intent:not-a-uuid', `intent:${INTENT_ID.toUpperCase()}`])(
    'does not answer %s: the pattern refuses it',
    async (data) => {
      const { press, calls, readIntent } = setup();
      await press(data);
      expect(calls).toEqual([]);
      expect(readIntent).not.toHaveBeenCalled();
    },
  );

  it('is done when the message already shows the status', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_NOT_MODIFIED);
    await press(REFRESH);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
  });

  it('sends the status anew with its button when the message is gone', async () => {
    const { press, calls, apiErrors } = setup();
    apiErrors.set('editMessageText', EDIT_GONE);
    await press(REFRESH);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    const sent = payloadOf(calls, 'sendMessage');
    expect(sent?.text).toBe(statusOf());
    expect(rowsOf(sent)).toEqual(REFRESH_ROWS);
  });

  it('sends nothing more and warns when the edit fails in transport', async () => {
    const { press, calls, apiErrors, logger } = setup();
    apiErrors.set(
      'editMessageText',
      new HttpError("Network request for 'editMessageText' failed!", new Error('aborted')),
    );
    await press(REFRESH);
    expect(methods(calls)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(warnings(logger)).toEqual(['trade intent message not edited']);
  });

  it('does nothing outside a private chat', async () => {
    const { press, calls, readIntent } = setup();
    await press(REFRESH, 'group');
    expect(calls).toEqual([]);
    expect(readIntent).not.toHaveBeenCalled();
  });
});
