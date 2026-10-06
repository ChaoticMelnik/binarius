import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError } from 'grammy';
import type { ApiError, Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import {
  BrokerBalanceUnavailableReason,
  confirmCallbackData,
  NotificationLevel,
  OAuthErrorCode,
  TradeAction,
  TRADING_ACCESS_BUDGET_MS,
  TRADING_SIGNAL_BUDGET_MS,
  UserErrorCode,
  UserStatus,
  type TradingAccessResponse,
} from '@binarius/shared';
import { composeDurationMs, composeServiceValue } from '@binarius/shared/testing';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import {
  CONNECT_CALLBACK_DATA,
  LEVEL_CURRENT_CALLBACK_DATA,
  OAUTH_CALLBACK_DATA,
  RESEND_CALLBACK_DATA,
  createBot,
  levelCallbackData,
} from './bot';
import {
  DEMO_CALLBACK_DATA,
  DEMO_GROUPS_CALLBACK_DATA,
  demoAnalysisCallbackData,
  demoAssetCallbackData,
  demoDurationCallbackData,
  demoPageCallbackData,
  stakeCallbackData,
} from './demo';
import { createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  ACCESS_VIEW,
  ACCOUNT_VIEW,
  BOT_INFO,
  CARD_MESSAGE_ID,
  CODE,
  CODE_SENT,
  CONFIRMED,
  EMAIL,
  LINK_ACTIVE,
  LINK_PENDING,
  LINK_REVOKED,
  LOGIN,
  PAIR_CLOSED,
  PAIR_EURUSD,
  PAIRS_RESPONSE,
  SIGNAL_DATA_REFUSAL,
  SIGNAL_DECIDED,
  SIGNAL_FETCH_FAILED,
  SIGNAL_NO_SIGNAL,
  PENDING_ACCOUNT_ID,
  USER,
  TEXT_CARD_MESSAGE_ID,
  USER_VIEW,
  captureApi,
  callbackUpdate,
  failFromSecondCall,
  chatMemberUpdate,
  fakeLogger,
  messageAnswer,
  textUpdate,
  accessView,
  accountView,
  brokerBalance,
  pairsResponse,
  type ApiAnswer,
} from './testing';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  COMPOSE_STOP_GRACE_PERIOD_MS,
  GRAMMY_POLLING_BACKOFF_MS,
  HANDLER_CALLS,
} from './timing';

// HANDLER_BUDGET_MS is computed from HANDLER_CALLS, so nothing here recomputes it: what this
// file asserts is that HANDLER_CALLS still describes the handlers, that the two numbers this
// project does not own (compose's stop_grace_period, grammY's polling backoff) are still what
// timing.ts says they are, and nothing else.

const composeYaml = readFileSync(
  fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  'utf8',
);
const grammyBotJs = fileURLToPath(new URL('../node_modules/grammy/out/bot.js', import.meta.url));

interface Calls {
  backend: number;
  telegram: number;
}

interface Branch {
  label: string;
  update: Update;
  expected: Calls;
  recordStart?: BackendClient['recordStart'];
  readAccount?: BackendClient['readAccount'];
  startLogin?: BackendClient['startLogin'];
  confirmLogin?: BackendClient['confirmLogin'];
  sendEmailCode?: BackendClient['sendEmailCode'];
  emailLogin?: BackendClient['emailLogin'];
  recordChatMember?: BackendClient['recordChatMember'];
  setNotificationLevel?: BackendClient['setNotificationLevel'];
  readTradingAccess?: BackendClient['readTradingAccess'];
  readPairs?: BackendClient['readPairs'];
  evaluateSignal?: BackendClient['evaluateSignal'];
  welcomeVideoFileId?: string;
  apiErrors?: readonly (readonly [string, ApiError | HttpError])[];
  answers?: readonly (readonly [string, ApiAnswer])[];
  // the result's edit refused after «⏳» was edited (#126)
  failSecondEdit?: ApiError | HttpError;
  // the step the user is on when the update arrives
  dialog?: LoginDialogState;
}

const VIDEO_REFUSED: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: wrong file identifier/HTTP URL specified',
};
const QUERY_TOO_OLD: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: query is too old',
};
const videoTimedOut = (): HttpError =>
  new HttpError(
    "Network request for 'sendVideo' failed!",
    new Error('The operation was aborted due to timeout'),
  );
const PHOTO_REFUSED: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: IMAGE_PROCESS_FAILED',
};
const PIN_REFUSED: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: not enough rights to manage pinned messages in the chat',
};
const photoTimedOut = (): HttpError =>
  new HttpError(
    "Network request for 'sendPhoto' failed!",
    new Error('The operation was aborted due to timeout'),
  );
const textCardTimedOut = (): HttpError =>
  new HttpError(
    "Network request for 'sendMessage' failed!",
    new Error('The operation was aborted due to timeout'),
  );
const photoFailsUnexpectedly: ApiAnswer = () => {
  throw new TypeError('sentinel');
};

// What happens once the account card is due, shared by the confirm button and the code step:
// the Telegram calls each outcome makes, and what the scene programs to get there.
interface CardOutcome {
  label: string;
  telegram: number;
  scene: Pick<Branch, 'apiErrors' | 'answers'>;
}

const PHOTO_REFUSED_OUTCOME: CardOutcome = {
  label: 'the photo is refused and the text card is sent and pinned instead',
  telegram: 4,
  scene: { apiErrors: [['sendPhoto', PHOTO_REFUSED]] },
};

const CARD_OUTCOMES: readonly CardOutcome[] = [
  { label: 'the card is sent and pinned', telegram: 3, scene: {} },
  {
    label: 'the old pins are not cleared',
    telegram: 3,
    scene: { apiErrors: [['unpinAllChatMessages', PIN_REFUSED]] },
  },
  {
    label: 'the card is not pinned',
    telegram: 3,
    scene: { apiErrors: [['pinChatMessage', PIN_REFUSED]] },
  },
  // delivery is unknown, so nothing is sent or pinned after it
  {
    label: 'the photo call fails in transport',
    telegram: 1,
    scene: { apiErrors: [['sendPhoto', photoTimedOut()]] },
  },
  // the same for the text sent in place of a refused photo
  {
    label: 'the photo is refused and the text card fails in transport',
    telegram: 2,
    scene: {
      apiErrors: [
        ['sendPhoto', PHOTO_REFUSED],
        ['sendMessage', textCardTimedOut()],
      ],
    },
  },
  // rethrown into bot.catch
  {
    label: 'the photo call fails for a reason the transport cannot produce',
    telegram: 1,
    scene: { answers: [['sendPhoto', photoFailsUnexpectedly]] },
  },
];

const withoutSender = (update: Update): Update => {
  const copy = structuredClone(update) as { message?: { from?: unknown } };
  delete copy.message?.from;
  return copy as Update;
};

// Runs one terminal branch through the real handlers and counts what leaves the process.
async function observe(branch: Branch): Promise<Calls> {
  let backend = 0;
  const client: BackendClient = {
    recordStart: (request) => {
      backend += 1;
      return (branch.recordStart ?? (() => Promise.resolve(USER_VIEW)))(request);
    },
    readAccount: (telegramUserId) => {
      backend += 1;
      return (branch.readAccount ?? (() => Promise.resolve(ACCOUNT_VIEW)))(telegramUserId);
    },
    startLogin: (telegramUserId) => {
      backend += 1;
      return (branch.startLogin ?? (() => Promise.resolve(LOGIN)))(telegramUserId);
    },
    confirmLogin: (telegramUserId, accountId) => {
      backend += 1;
      return (branch.confirmLogin ?? (() => Promise.resolve(CONFIRMED)))(telegramUserId, accountId);
    },
    sendEmailCode: (telegramUserId, email) => {
      backend += 1;
      return (branch.sendEmailCode ?? (() => Promise.resolve(CODE_SENT)))(telegramUserId, email);
    },
    emailLogin: (telegramUserId, email, code) => {
      backend += 1;
      return (branch.emailLogin ?? (() => Promise.resolve(CONFIRMED)))(telegramUserId, email, code);
    },
    recordChatMember: (telegramUserId, status) => {
      backend += 1;
      return (branch.recordChatMember ?? (() => Promise.resolve({ recorded: true })))(
        telegramUserId,
        status,
      );
    },
    setNotificationLevel: (telegramUserId, level) => {
      backend += 1;
      return (branch.setNotificationLevel ?? (() => Promise.resolve({ level })))(
        telegramUserId,
        level,
      );
    },
    readTradingAccess: (telegramUserId) => {
      backend += 1;
      return (branch.readTradingAccess ?? (() => Promise.resolve(ACCESS_VIEW)))(telegramUserId);
    },
    readPairs: () => {
      backend += 1;
      return (branch.readPairs ?? (() => Promise.resolve(PAIRS_RESPONSE)))();
    },
    evaluateSignal: (assetId, interval) => {
      backend += 1;
      return (branch.evaluateSignal ?? (() => Promise.resolve(SIGNAL_DECIDED)))(assetId, interval);
    },
    createIntent: () => Promise.reject(new Error('not used by these branches')),
    readIntent: () => Promise.reject(new Error('not used by these branches')),
  };
  const loginDialog = createLoginDialog();
  if (branch.dialog !== undefined) loginDialog.set(USER.id, branch.dialog);
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: client,
    logger: fakeLogger(),
    botInfo: BOT_INFO,
    loginDialog,
    ...(branch.welcomeVideoFileId === undefined
      ? {}
      : { welcomeVideoFileId: branch.welcomeVideoFileId }),
  });
  const api = captureApi(bot);
  api.answers.set('sendPhoto', messageAnswer(CARD_MESSAGE_ID));
  api.answers.set('sendMessage', messageAnswer(TEXT_CARD_MESSAGE_ID));
  for (const [method, failure] of branch.apiErrors ?? []) api.apiErrors.set(method, failure);
  for (const [method, answer] of branch.answers ?? []) api.answers.set(method, answer);
  if (branch.failSecondEdit !== undefined) {
    failFromSecondCall(api, 'editMessageText', branch.failSecondEdit);
  }
  // a branch that rethrows reaches the polling loop as a rejection; the calls it made before
  // that still have to fit in the budget
  await bot.handleUpdate(branch.update).catch(() => undefined);
  return { backend, telegram: api.calls.length };
}

async function checkHandler(
  handler: string,
  branches: readonly Branch[],
  worstCase: Branch,
  declared: Calls,
): Promise<void> {
  // A label only names its branch in the assertion messages below; the observations are keyed
  // by position, and the worst case is the branch object itself. Two branches sharing a label
  // used to collapse into one observation, leaving a listed branch checked twice and another
  // not at all — so the duplicate is caught here instead.
  expect(
    new Set(branches.map((branch) => branch.label)).size,
    `${handler}: branch labels must be unique`,
  ).toBe(branches.length);

  const seen: Calls[] = [];
  for (const branch of branches) seen.push(await observe(branch));

  branches.forEach((branch, index) => {
    expect(seen[index], `${handler}: ${branch.label}`).toEqual(branch.expected);
  });

  expect(
    {
      backend: Math.max(...seen.map((calls) => calls.backend)),
      telegram: Math.max(...seen.map((calls) => calls.telegram)),
    },
    `${handler}: HANDLER_CALLS no longer describes the worst of the branches above`,
  ).toEqual(declared);

  const worst = branches.indexOf(worstCase);
  expect(worst, `${handler}: the worst case must be one of the branches above`).not.toBe(-1);
  expect(seen[worst], `${handler}: worst case is "${worstCase.label}"`).toEqual(declared);
}

// Every terminal branch of /start and /menu, which share one path (answerHome). A branch missing
// from this list is the one thing the budget cannot be checked against — see the note in
// timing.ts.
const ACTIVE_VIEW = { ...USER_VIEW, hasActiveBrokerAccount: true };

function homeBranches(command: '/start' | '/menu'): { branches: Branch[]; worst: Branch } {
  const update = (chatType?: string) => textUpdate(command, chatType);
  const active = { update: update(), recordStart: () => Promise.resolve(ACTIVE_VIEW) };
  const access =
    (patch: Partial<TradingAccessResponse>): BackendClient['readTradingAccess'] =>
    () =>
      Promise.resolve(accessView(patch));
  const worst: Branch = {
    label: `the account is active and ${PHOTO_REFUSED_OUTCOME.label}`,
    ...active,
    ...PHOTO_REFUSED_OUTCOME.scene,
    expected: { backend: 2, telegram: PHOTO_REFUSED_OUTCOME.telegram },
  };
  const branches: Branch[] = [
    {
      label: 'the update carries no sender',
      update: withoutSender(update()),
      expected: { backend: 0, telegram: 0 },
    },
    {
      label: 'the chat is not private',
      update: update('group'),
      expected: { backend: 0, telegram: 0 },
    },
    {
      label: 'the backend refuses the start',
      update: update(),
      recordStart: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      expected: { backend: 1, telegram: 1 },
    },
    {
      label: 'the user is blocked',
      update: update(),
      recordStart: () => Promise.resolve({ ...USER_VIEW, status: UserStatus.Blocked }),
      expected: { backend: 1, telegram: 1 },
    },
    {
      label: 'a link waits for confirmation',
      update: update(),
      recordStart: () =>
        Promise.resolve({
          ...USER_VIEW,
          pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email: 'ada@example.test' }],
        }),
      expected: { backend: 1, telegram: 1 },
    },
    {
      label: 'a link without an email waits for confirmation beside an active account',
      update: update(),
      recordStart: () =>
        Promise.resolve({
          ...ACTIVE_VIEW,
          pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email: null }],
        }),
      expected: { backend: 1, telegram: 1 },
    },
    worst,
    ...CARD_OUTCOMES.map((outcome): Branch => ({
      label: `the account is active and ${outcome.label}`,
      ...active,
      ...outcome.scene,
      expected: { backend: 2, telegram: outcome.telegram },
    })),
    {
      label: 'the access read fails',
      ...active,
      readTradingAccess: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      expected: { backend: 2, telegram: 1 },
    },
    {
      label: 'the access finds the user blocked',
      ...active,
      readTradingAccess: access({
        status: UserStatus.Blocked,
        broker: null,
        brokerUnavailable: BrokerBalanceUnavailableReason.UserBlocked,
      }),
      expected: { backend: 2, telegram: 1 },
    },
    {
      label: 'the access says no account is active',
      ...active,
      readTradingAccess: access({
        broker: null,
        brokerUnavailable: BrokerBalanceUnavailableReason.NoAccount,
      }),
      expected: { backend: 2, telegram: 1 },
    },
    {
      label: 'the access has no snapshot',
      ...active,
      readTradingAccess: access({
        broker: null,
        brokerUnavailable: BrokerBalanceUnavailableReason.BrokerUnavailable,
      }),
      expected: { backend: 2, telegram: 3 },
    },
    {
      label: 'the snapshot is stale',
      ...active,
      readTradingAccess: access({
        broker: brokerBalance({ restSnapshotAgeSec: 600, fresh: false }),
      }),
      expected: { backend: 2, telegram: 3 },
    },
    {
      label: 'no video is configured',
      update: update(),
      expected: { backend: 1, telegram: 1 },
    },
    {
      label: 'the video is sent',
      update: update(),
      welcomeVideoFileId: 'BAACAgIAAxkB',
      expected: { backend: 1, telegram: 1 },
    },
    {
      label: 'the video is refused and the text replaces it',
      update: update(),
      welcomeVideoFileId: 'not-a-file-id',
      apiErrors: [['sendVideo', VIDEO_REFUSED]],
      expected: { backend: 1, telegram: 2 },
    },
    {
      // delivery is unknown, so nothing is sent after it
      label: 'the video call fails in transport',
      update: update(),
      welcomeVideoFileId: 'BAACAgIAAxkB',
      apiErrors: [['sendVideo', videoTimedOut()]],
      expected: { backend: 1, telegram: 1 },
    },
    {
      // neither a refusal nor the transport: the branch rethrows into bot.catch, and whatever it
      // sent before that still has to fit the budget
      label: 'the video call fails for a reason the transport cannot produce',
      update: update(),
      welcomeVideoFileId: 'BAACAgIAAxkB',
      answers: [
        [
          'sendVideo',
          () => {
            throw new TypeError('sentinel');
          },
        ],
      ],
      expected: { backend: 1, telegram: 1 },
    },
  ];
  return { branches, worst };
}

const START = homeBranches('/start');
const MENU = homeBranches('/menu');

const EDIT_REFUSED: ApiError = {
  ok: false,
  error_code: 400,
  description: "Bad Request: message can't be edited",
};

const EDIT_NOT_MODIFIED: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: message is not modified',
};

const CATALOG_UNAVAILABLE = () =>
  Promise.reject(
    new BackendError(BackendErrorCode.HttpStatus, { status: 503, reason: 'catalog_unavailable' }),
  );
const CATALOG_STALE = () => Promise.resolve(pairsResponse({ ageMs: 90_000, fresh: false }));
const CATALOG_UNREACHABLE = () => Promise.reject(new BackendError(BackendErrorCode.Unreachable));

// The catalog's three failures, each answered with a text and the retry button.
const catalogBranches = (update: () => Update, telegram: number): Branch[] => [
  {
    label: 'the catalog is unavailable',
    update: update(),
    readPairs: CATALOG_UNAVAILABLE,
    expected: { backend: 1, telegram },
  },
  {
    label: 'the catalog is stale',
    update: update(),
    readPairs: CATALOG_STALE,
    expected: { backend: 1, telegram },
  },
  {
    label: 'the catalog read fails',
    update: update(),
    readPairs: CATALOG_UNREACHABLE,
    expected: { backend: 1, telegram },
  },
];

const DEMO_WORST_CASE: Branch = {
  label: 'the query is answered and the types are sent',
  update: callbackUpdate(DEMO_CALLBACK_DATA),
  expected: { backend: 1, telegram: 2 },
};

const DEMO_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: callbackUpdate(DEMO_CALLBACK_DATA, 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  DEMO_WORST_CASE,
  {
    label: 'answering the query is refused and the types still go',
    update: callbackUpdate(DEMO_CALLBACK_DATA),
    apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
    expected: { backend: 1, telegram: 2 },
  },
  ...catalogBranches(() => callbackUpdate(DEMO_CALLBACK_DATA), 2),
  // rethrown into bot.catch
  {
    label: 'the message fails in transport',
    update: callbackUpdate(DEMO_CALLBACK_DATA),
    apiErrors: [
      [
        'sendMessage',
        new HttpError(
          "Network request for 'sendMessage' failed!",
          new Error('The operation was aborted due to timeout'),
        ),
      ],
    ],
    expected: { backend: 1, telegram: 2 },
  },
];

// Every demo screen after the first is one message edited in place, so its branches share the
// edit's outcomes; `forged` is data the pattern matches and the schema refuses.
function demoScreenBranches(
  data: string,
  forged: string | undefined,
  own: readonly Omit<Branch, 'update'>[],
): { branches: Branch[]; worst: Branch } {
  const update = () => callbackUpdate(data);
  const worst: Branch = {
    label: 'the edit is refused as gone and the screen is sent anew',
    update: update(),
    apiErrors: [['editMessageText', EDIT_REFUSED]],
    expected: { backend: 1, telegram: 3 },
  };
  const branches: Branch[] = [
    {
      label: 'the chat is not private',
      update: callbackUpdate(data, 'group'),
      expected: { backend: 0, telegram: 0 },
    },
    ...(forged === undefined
      ? []
      : [
          {
            label: 'the data is forged',
            update: callbackUpdate(forged),
            expected: { backend: 0, telegram: 1 },
          },
        ]),
    ...catalogBranches(update, 2),
    { label: 'the screen is edited', update: update(), expected: { backend: 1, telegram: 2 } },
    {
      label: 'answering the query is refused and the screen is still edited',
      update: update(),
      apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
      expected: { backend: 1, telegram: 2 },
    },
    worst,
    {
      label: 'the edit is refused as not modified',
      update: update(),
      apiErrors: [['editMessageText', EDIT_NOT_MODIFIED]],
      expected: { backend: 1, telegram: 2 },
    },
    // rethrown into bot.catch
    {
      label: 'the edit is refused for an unlisted reason',
      update: update(),
      apiErrors: [
        [
          'editMessageText',
          { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        ],
      ],
      expected: { backend: 1, telegram: 2 },
    },
    {
      label: 'the edit fails in transport',
      update: update(),
      apiErrors: [
        [
          'editMessageText',
          new HttpError(
            "Network request for 'editMessageText' failed!",
            new Error('The operation was aborted due to timeout'),
          ),
        ],
      ],
      expected: { backend: 1, telegram: 2 },
    },
    ...own.map((branch): Branch => ({ ...branch, update: update() })),
  ];
  return { branches, worst };
}

const onlyPairs =
  (...pairs: (typeof PAIR_EURUSD)[]) =>
  () =>
    Promise.resolve(pairsResponse({ pairs }));

const DEMO_GROUPS = demoScreenBranches(DEMO_GROUPS_CALLBACK_DATA, undefined, [
  { label: 'the catalog is empty', readPairs: onlyPairs(), expected: { backend: 1, telegram: 2 } },
]);
const DEMO_PAGE = demoScreenBranches(demoPageCallbackData('currency', 0), 'demo:t:bond:0', [
  {
    label: 'no pair of the type is open',
    readPairs: onlyPairs(PAIR_CLOSED),
    expected: { backend: 1, telegram: 2 },
  },
]);
const pairBranches = (
  extra: readonly Omit<Branch, 'update'>[] = [],
): readonly Omit<Branch, 'update'>[] => [
  { label: 'the pair is gone', readPairs: onlyPairs(), expected: { backend: 1, telegram: 2 } },
  {
    label: 'the pair is closed',
    readPairs: onlyPairs({ ...PAIR_EURUSD, scheduledUntil: PAIR_CLOSED.scheduledUntil }),
    expected: { backend: 1, telegram: 2 },
  },
  ...extra,
];
const DEMO_ASSET = demoScreenBranches(
  demoAssetCallbackData(PAIR_EURUSD.id),
  'demo:a:0',
  pairBranches([
    {
      label: 'the pair admits no duration',
      readPairs: onlyPairs({ ...PAIR_EURUSD, minTimeframe: 5, maxTimeframe: 30 }),
      expected: { backend: 1, telegram: 2 },
    },
  ]),
);
const unsupported = {
  label: 'the duration no longer fits the pair',
  readPairs: onlyPairs({ ...PAIR_EURUSD, maxTimeframe: 120 }),
  expected: { backend: 1, telegram: 2 },
};
const DEMO_DURATION = demoScreenBranches(
  demoDurationCallbackData(PAIR_EURUSD.id, 300),
  'demo:d:2147483648:300',
  pairBranches([unsupported]),
);
// «📊 Анализ» (#126): the check, «⏳» edited in place of the summary, the signal, the result in
// place of «⏳». Its edits are two, so the shared screen branches do not describe it.
const EDIT_TRANSPORT = new HttpError(
  "Network request for 'editMessageText' failed!",
  new Error('The operation was aborted due to timeout'),
);
const analysisUpdate = () => callbackUpdate(demoAnalysisCallbackData(PAIR_EURUSD.id, 300));
const DEMO_ANALYSIS_WORST_CASE: Branch = {
  label: '«⏳» is refused as gone and sent anew, then the result is sent',
  update: analysisUpdate(),
  apiErrors: [['editMessageText', EDIT_REFUSED]],
  expected: { backend: 2, telegram: 4 },
};
const DEMO_ANALYSIS = {
  worst: DEMO_ANALYSIS_WORST_CASE,
  branches: [
    {
      label: 'the chat is not private',
      update: callbackUpdate(demoAnalysisCallbackData(PAIR_EURUSD.id, 300), 'group'),
      expected: { backend: 0, telegram: 0 },
    },
    {
      label: 'the data is forged',
      update: callbackUpdate('demo:an:0:300'),
      expected: { backend: 0, telegram: 1 },
    },
    ...catalogBranches(analysisUpdate, 2),
    ...pairBranches([unsupported]).map((branch): Branch => ({
      ...branch,
      update: analysisUpdate(),
    })),
    {
      label: '«⏳» and the result are edited',
      update: analysisUpdate(),
      expected: { backend: 2, telegram: 3 },
    },
    {
      label: 'answering the query is refused and the analysis still goes',
      update: analysisUpdate(),
      apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
      expected: { backend: 2, telegram: 3 },
    },
    DEMO_ANALYSIS_WORST_CASE,
    {
      label: '«⏳» and the result are refused as not modified',
      update: analysisUpdate(),
      apiErrors: [['editMessageText', EDIT_NOT_MODIFIED]],
      expected: { backend: 2, telegram: 3 },
    },
    // rethrown into bot.catch
    {
      label: '«⏳» is refused for an unlisted reason',
      update: analysisUpdate(),
      apiErrors: [
        [
          'editMessageText',
          { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        ],
      ],
      expected: { backend: 1, telegram: 2 },
    },
    {
      label: '«⏳» fails in transport and nothing more is done',
      update: analysisUpdate(),
      apiErrors: [['editMessageText', EDIT_TRANSPORT]],
      expected: { backend: 1, telegram: 2 },
    },
    {
      label: 'the result edit is refused as gone and the result is sent anew',
      update: analysisUpdate(),
      failSecondEdit: EDIT_REFUSED,
      expected: { backend: 2, telegram: 4 },
    },
    {
      label: 'the result edit fails in transport',
      update: analysisUpdate(),
      failSecondEdit: EDIT_TRANSPORT,
      expected: { backend: 2, telegram: 3 },
    },
    {
      label: 'the signal call fails',
      update: analysisUpdate(),
      evaluateSignal: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
      expected: { backend: 2, telegram: 3 },
    },
    {
      label: 'the broker rate-limits the candles',
      update: analysisUpdate(),
      evaluateSignal: () => Promise.resolve(SIGNAL_FETCH_FAILED),
      expected: { backend: 2, telegram: 3 },
    },
    {
      label: 'the decision is a rule refusal',
      update: analysisUpdate(),
      evaluateSignal: () => Promise.resolve(SIGNAL_NO_SIGNAL),
      expected: { backend: 2, telegram: 3 },
    },
    {
      label: 'the decision is a data refusal',
      update: analysisUpdate(),
      evaluateSignal: () => Promise.resolve(SIGNAL_DATA_REFUSAL),
      expected: { backend: 2, telegram: 3 },
    },
  ] satisfies Branch[],
};

// the stake button until #127 (#126)
const stakeUpdate = (chatType?: string) =>
  callbackUpdate(stakeCallbackData(PAIR_EURUSD.id, 300, TradeAction.Up), chatType);
const STAKE_PLACEHOLDER_WORST_CASE: Branch = {
  label: 'the query is answered and the placeholder is sent',
  update: stakeUpdate(),
  expected: { backend: 0, telegram: 2 },
};
const STAKE_PLACEHOLDER_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: stakeUpdate('group'),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the data is forged',
    update: callbackUpdate('demo:stake:0:300:up'),
    expected: { backend: 0, telegram: 1 },
  },
  STAKE_PLACEHOLDER_WORST_CASE,
  {
    label: 'answering the query is refused and the placeholder still goes',
    update: stakeUpdate(),
    apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
    expected: { backend: 0, telegram: 2 },
  },
];

const OAUTH_WORST_CASE: Branch = {
  label: 'the query is answered and the link is sent',
  update: callbackUpdate(OAUTH_CALLBACK_DATA),
  expected: { backend: 1, telegram: 2 },
};

const OAUTH_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: callbackUpdate(OAUTH_CALLBACK_DATA, 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  OAUTH_WORST_CASE,
  {
    label: 'answering the query is refused and the link still goes',
    update: callbackUpdate(OAUTH_CALLBACK_DATA),
    apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the backend reports a blocked user',
    update: callbackUpdate(OAUTH_CALLBACK_DATA),
    startLogin: () =>
      Promise.reject(
        new BackendError(BackendErrorCode.HttpStatus, {
          status: 409,
          reason: OAuthErrorCode.UserBlocked,
        }),
      ),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the backend fails for any other reason',
    update: callbackUpdate(OAUTH_CALLBACK_DATA),
    startLogin: () =>
      Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 500 })),
    expected: { backend: 1, telegram: 2 },
  },
];

const confirmRefused = (status: number, reason?: string) => () =>
  Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status, reason }));

const CONFIRM_UPDATE = callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID));

const CONFIRM_WORST_CASE: Branch = {
  label: `the query is answered and ${PHOTO_REFUSED_OUTCOME.label}`,
  update: CONFIRM_UPDATE,
  ...PHOTO_REFUSED_OUTCOME.scene,
  expected: { backend: 1, telegram: 1 + PHOTO_REFUSED_OUTCOME.telegram },
};

const CONFIRM_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: callbackUpdate(confirmCallbackData(PENDING_ACCOUNT_ID), 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  {
    // matches the trigger, fails the uuid schema: the spinner is stopped and nothing else
    label: 'the callback data does not carry a uuid',
    update: callbackUpdate(`confirm:${'-'.repeat(36)}`),
    expected: { backend: 0, telegram: 1 },
  },
  CONFIRM_WORST_CASE,
  ...CARD_OUTCOMES.map((outcome): Branch => ({
    label: `the query is answered and ${outcome.label}`,
    update: CONFIRM_UPDATE,
    ...outcome.scene,
    expected: { backend: 1, telegram: 1 + outcome.telegram },
  })),
  {
    label: 'the link is confirmed without a pack for a non-partner account',
    update: CONFIRM_UPDATE,
    confirmLogin: () =>
      Promise.resolve({ ...CONFIRMED, grant: { granted: false, reason: 'not_partner_client' } }),
    expected: { backend: 1, telegram: 4 },
  },
  {
    label: 'the link is confirmed without a pack already paid',
    update: CONFIRM_UPDATE,
    confirmLogin: () =>
      Promise.resolve({ ...CONFIRMED, grant: { granted: false, reason: 'already_granted' } }),
    expected: { backend: 1, telegram: 4 },
  },
  {
    label: 'answering the query is refused and the card still goes',
    update: CONFIRM_UPDATE,
    apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
    expected: { backend: 1, telegram: 4 },
  },
  {
    label: 'the backend no longer finds the link',
    update: CONFIRM_UPDATE,
    confirmLogin: confirmRefused(404, OAuthErrorCode.BrokerAccountNotFound),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the link is no longer pending',
    update: CONFIRM_UPDATE,
    confirmLogin: confirmRefused(409, OAuthErrorCode.AccountNotPending),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the backend reports a blocked user',
    update: CONFIRM_UPDATE,
    confirmLogin: confirmRefused(409, OAuthErrorCode.UserBlocked),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the backend fails for any other reason',
    update: CONFIRM_UPDATE,
    confirmLogin: confirmRefused(500),
    expected: { backend: 1, telegram: 2 },
  },
];

const CONNECT_WORST_CASE: Branch = {
  label: 'the query is answered and the address is asked for',
  update: callbackUpdate(CONNECT_CALLBACK_DATA),
  expected: { backend: 0, telegram: 2 },
};

const CONNECT_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: callbackUpdate(CONNECT_CALLBACK_DATA, 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  CONNECT_WORST_CASE,
  {
    label: 'answering the query is refused and the address is still asked for',
    update: callbackUpdate(CONNECT_CALLBACK_DATA),
    apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
    expected: { backend: 0, telegram: 2 },
  },
];

const refusedWith = (status: number, reason?: string) => () =>
  Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status, reason }));
const unreachable = () => Promise.reject(new BackendError(BackendErrorCode.Unreachable));

const ON_EMAIL_STEP: LoginDialogState = { step: 'email' };
const ON_CODE_STEP: LoginDialogState = { step: 'code', email: EMAIL };

const EMAIL_STEP_WORST_CASE: Branch = {
  label: 'the code is sent',
  update: textUpdate(EMAIL),
  dialog: ON_EMAIL_STEP,
  expected: { backend: 1, telegram: 1 },
};

// The text handler serves both steps; these are the branches of the address step, and the
// ones that end before any step is looked at.
const EMAIL_STEP_BRANCHES: readonly Branch[] = [
  {
    label: 'the user is not in a dialog',
    update: textUpdate(EMAIL),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the text is a command',
    update: textUpdate('/unknown'),
    dialog: ON_EMAIL_STEP,
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the chat is not private',
    update: textUpdate(EMAIL, 'group'),
    dialog: ON_EMAIL_STEP,
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the update carries no sender',
    update: withoutSender(textUpdate(EMAIL)),
    dialog: ON_EMAIL_STEP,
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the text is not an address',
    update: textUpdate('ada at example'),
    dialog: ON_EMAIL_STEP,
    expected: { backend: 0, telegram: 1 },
  },
  EMAIL_STEP_WORST_CASE,
  ...[
    OAuthErrorCode.InvalidEmail,
    OAuthErrorCode.TooManyAttempts,
    OAuthErrorCode.TooManyRequests,
    OAuthErrorCode.UserBlocked,
  ].map((reason): Branch => ({
    label: `the backend refuses with ${reason}`,
    update: textUpdate(EMAIL),
    dialog: ON_EMAIL_STEP,
    sendEmailCode: refusedWith(400, reason),
    expected: { backend: 1, telegram: 1 },
  })),
  ...(
    [
      [401, 'unauthorized'],
      [400, 'validation'],
    ] as const
  ).map(([status, reason]): Branch => ({
    label: `the backend refuses before the letter with ${status} ${reason}`,
    update: textUpdate(EMAIL),
    dialog: ON_EMAIL_STEP,
    sendEmailCode: refusedWith(status, reason),
    expected: { backend: 1, telegram: 1 },
  })),
  {
    label: 'the backend fails for any other reason',
    update: textUpdate(EMAIL),
    dialog: ON_EMAIL_STEP,
    sendEmailCode: unreachable,
    expected: { backend: 1, telegram: 1 },
  },
];

const CODE_STEP_WORST_CASE: Branch = {
  label: `an invalid code is rechecked, the account is active, and ${PHOTO_REFUSED_OUTCOME.label}`,
  update: textUpdate(CODE),
  dialog: ON_CODE_STEP,
  emailLogin: refusedWith(400, OAuthErrorCode.InvalidCode),
  recordStart: () => Promise.resolve({ ...USER_VIEW, hasActiveBrokerAccount: true }),
  ...PHOTO_REFUSED_OUTCOME.scene,
  expected: { backend: 2, telegram: PHOTO_REFUSED_OUTCOME.telegram },
};

const CODE_STEP_BRANCHES: readonly Branch[] = [
  {
    label: 'the text is not a code',
    update: textUpdate('c'.repeat(65)),
    dialog: ON_CODE_STEP,
    expected: { backend: 0, telegram: 1 },
  },
  ...[...CARD_OUTCOMES, PHOTO_REFUSED_OUTCOME].map((outcome): Branch => ({
    label: `the login pays the pack and ${outcome.label}`,
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    ...outcome.scene,
    expected: { backend: 1, telegram: outcome.telegram },
  })),
  {
    label: 'the login pays no pack',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: () =>
      Promise.resolve({ ...CONFIRMED, grant: { granted: false, reason: 'already_granted' } }),
    expected: { backend: 1, telegram: 3 },
  },
  ...[
    OAuthErrorCode.TooManyAttempts,
    OAuthErrorCode.TooManyRequests,
    OAuthErrorCode.UserBlocked,
    OAuthErrorCode.BrokerAccountTaken,
  ].map((reason): Branch => ({
    // a definite refusal: no recheck, whether it ends the dialog or keeps the step
    label: `the login is refused with ${reason}`,
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: refusedWith(409, reason),
    expected: { backend: 1, telegram: 1 },
  })),
  CODE_STEP_WORST_CASE,
  {
    label: 'an invalid code is rechecked and no account is active',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: refusedWith(400, OAuthErrorCode.InvalidCode),
    expected: { backend: 2, telegram: 1 },
  },
  ...CARD_OUTCOMES.map((outcome): Branch => ({
    label: `an invalid code is rechecked, the account is active, and ${outcome.label}`,
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: refusedWith(400, OAuthErrorCode.InvalidCode),
    recordStart: () => Promise.resolve({ ...USER_VIEW, hasActiveBrokerAccount: true }),
    ...outcome.scene,
    expected: { backend: 2, telegram: outcome.telegram },
  })),
  {
    label: 'an unreachable login is rechecked and the account is active',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: unreachable,
    recordStart: () => Promise.resolve({ ...USER_VIEW, hasActiveBrokerAccount: true }),
    expected: { backend: 2, telegram: 3 },
  },
  {
    label: 'a failed login is rechecked and no account is active',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: refusedWith(500),
    expected: { backend: 2, telegram: 1 },
  },
  {
    label: 'the recheck fails',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: refusedWith(400, OAuthErrorCode.InvalidCode),
    recordStart: unreachable,
    expected: { backend: 2, telegram: 1 },
  },
  {
    label: 'the recheck finds the user blocked',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: unreachable,
    recordStart: () => Promise.resolve({ ...USER_VIEW, status: UserStatus.Blocked }),
    expected: { backend: 2, telegram: 1 },
  },
];

const RESEND_WORST_CASE: Branch = {
  label: 'the query is answered and a new code is sent',
  update: callbackUpdate(RESEND_CALLBACK_DATA),
  dialog: ON_CODE_STEP,
  expected: { backend: 1, telegram: 2 },
};

const RESEND_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: callbackUpdate(RESEND_CALLBACK_DATA, 'group'),
    dialog: ON_CODE_STEP,
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the user is not in a dialog',
    update: callbackUpdate(RESEND_CALLBACK_DATA),
    expected: { backend: 0, telegram: 2 },
  },
  {
    label: 'the user has no address yet',
    update: callbackUpdate(RESEND_CALLBACK_DATA),
    dialog: ON_EMAIL_STEP,
    expected: { backend: 0, telegram: 2 },
  },
  RESEND_WORST_CASE,
  ...[OAuthErrorCode.TooManyAttempts, OAuthErrorCode.TooManyRequests].map((reason): Branch => ({
    label: `a new code is refused with ${reason}`,
    update: callbackUpdate(RESEND_CALLBACK_DATA),
    dialog: ON_CODE_STEP,
    sendEmailCode: refusedWith(429, reason),
    expected: { backend: 1, telegram: 2 },
  })),
  {
    label: 'a new code is refused before the letter with 401',
    update: callbackUpdate(RESEND_CALLBACK_DATA),
    dialog: ON_CODE_STEP,
    sendEmailCode: refusedWith(401, 'unauthorized'),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the backend fails for any other reason',
    update: callbackUpdate(RESEND_CALLBACK_DATA),
    dialog: ON_CODE_STEP,
    sendEmailCode: unreachable,
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'answering the query is refused and the code still goes',
    update: callbackUpdate(RESEND_CALLBACK_DATA),
    dialog: ON_CODE_STEP,
    apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
    expected: { backend: 1, telegram: 2 },
  },
];

const MY_CHAT_MEMBER_WORST_CASE: Branch = {
  label: 'the user blocks the bot',
  update: chatMemberUpdate('kicked'),
  expected: { backend: 1, telegram: 0 },
};

const MY_CHAT_MEMBER_BRANCHES: readonly Branch[] = [
  MY_CHAT_MEMBER_WORST_CASE,
  {
    label: 'the user unblocks the bot',
    update: chatMemberUpdate('member'),
    expected: { backend: 1, telegram: 0 },
  },
  {
    label: 'another status',
    update: chatMemberUpdate('left'),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the chat is not private',
    update: chatMemberUpdate('kicked', { chatType: 'group' }),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the backend fails',
    update: chatMemberUpdate('kicked'),
    recordChatMember: unreachable,
    expected: { backend: 1, telegram: 0 },
  },
];

// Every terminal branch of /account: one read, one message, whatever the read said.
const ACCOUNT_WORST_CASE: Branch = {
  label: 'an active link is shown',
  update: textUpdate('/account'),
  readAccount: () => Promise.resolve(accountView({ accounts: [LINK_ACTIVE] })),
  expected: { backend: 1, telegram: 1 },
};

const ACCOUNT_BRANCHES: readonly Branch[] = [
  {
    label: 'the update carries no sender',
    update: withoutSender(textUpdate('/account')),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the chat is not private',
    update: textUpdate('/account', 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  ACCOUNT_WORST_CASE,
  {
    label: 'a link waits for confirmation beside a revoked one',
    update: textUpdate('/account'),
    readAccount: () => Promise.resolve(accountView({ accounts: [LINK_PENDING, LINK_REVOKED] })),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the user has no link',
    update: textUpdate('/account'),
    readAccount: () => Promise.resolve(ACCOUNT_VIEW),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the user is blocked',
    update: textUpdate('/account'),
    readAccount: () =>
      Promise.resolve(accountView({ status: UserStatus.Blocked, accounts: [LINK_ACTIVE] })),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the backend has no users row',
    update: textUpdate('/account'),
    readAccount: () =>
      Promise.reject(
        new BackendError(BackendErrorCode.HttpStatus, {
          status: 404,
          reason: UserErrorCode.UserNotFound,
        }),
      ),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the backend is unreachable',
    update: textUpdate('/account'),
    readAccount: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    expected: { backend: 1, telegram: 1 },
  },
];

// Every terminal branch of /settings: one read, one message (#120).
const SETTINGS_WORST_CASE: Branch = {
  label: 'the levels are shown',
  update: textUpdate('/settings'),
  expected: { backend: 1, telegram: 1 },
};

const SETTINGS_BRANCHES: readonly Branch[] = [
  {
    label: 'the update carries no sender',
    update: withoutSender(textUpdate('/settings')),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the chat is not private',
    update: textUpdate('/settings', 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the backend is unreachable',
    update: textUpdate('/settings'),
    recordStart: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the user is blocked',
    update: textUpdate('/settings'),
    recordStart: () => Promise.resolve({ ...USER_VIEW, status: UserStatus.Blocked }),
    expected: { backend: 1, telegram: 1 },
  },
  SETTINGS_WORST_CASE,
];

const LEVEL_UPDATE = callbackUpdate(levelCallbackData(NotificationLevel.Off));

// A level pressed: answer ∥ set, then the edit — or, when the edit is refused, a new message.
const LEVEL_WORST_CASE: Branch = {
  label: 'the edit is refused and the message is sent anew',
  update: LEVEL_UPDATE,
  apiErrors: [['editMessageText', EDIT_REFUSED]],
  expected: { backend: 1, telegram: 3 },
};

const LEVEL_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: callbackUpdate(levelCallbackData(NotificationLevel.Off), 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the backend fails',
    update: LEVEL_UPDATE,
    setNotificationLevel: () =>
      Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 500 })),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the message is edited',
    update: LEVEL_UPDATE,
    expected: { backend: 1, telegram: 2 },
  },
  LEVEL_WORST_CASE,
  {
    label: 'the edit is refused as not modified',
    update: LEVEL_UPDATE,
    apiErrors: [['editMessageText', EDIT_NOT_MODIFIED]],
    expected: { backend: 1, telegram: 2 },
  },
  // rethrown into bot.catch
  {
    label: 'the edit is refused for an unlisted reason',
    update: LEVEL_UPDATE,
    apiErrors: [
      [
        'editMessageText',
        { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      ],
    ],
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the edit fails in transport',
    update: LEVEL_UPDATE,
    apiErrors: [
      [
        'editMessageText',
        new HttpError(
          "Network request for 'editMessageText' failed!",
          new Error('The operation was aborted due to timeout'),
        ),
      ],
    ],
    expected: { backend: 1, telegram: 2 },
  },
  // rethrown into bot.catch
  {
    label: 'the edit fails for a reason the transport cannot produce',
    update: LEVEL_UPDATE,
    answers: [
      [
        'editMessageText',
        () => {
          throw new TypeError('sentinel');
        },
      ],
    ],
    expected: { backend: 1, telegram: 2 },
  },
];

const LEVEL_CURRENT_WORST_CASE: Branch = {
  label: 'the selected level is pressed',
  update: callbackUpdate(LEVEL_CURRENT_CALLBACK_DATA),
  expected: { backend: 0, telegram: 1 },
};

const SUPPORT_WORST_CASE: Branch = {
  label: 'the support message is sent',
  update: textUpdate('/support'),
  expected: { backend: 0, telegram: 1 },
};

const SUPPORT_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: textUpdate('/support', 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  SUPPORT_WORST_CASE,
];

const HELP_WORST_CASE: Branch = {
  label: 'the help message is sent',
  update: textUpdate('/help'),
  expected: { backend: 0, telegram: 1 },
};

const HELP_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: textUpdate('/help', 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  HELP_WORST_CASE,
];

describe('what the handlers do, against what HANDLER_CALLS declares', () => {
  it('/settings', async () => {
    await checkHandler('settings', SETTINGS_BRANCHES, SETTINGS_WORST_CASE, HANDLER_CALLS.settings);
  });

  it('a level button', async () => {
    await checkHandler('level', LEVEL_BRANCHES, LEVEL_WORST_CASE, HANDLER_CALLS.level);
  });

  it('the selected level button', async () => {
    await checkHandler(
      'levelCurrent',
      [LEVEL_CURRENT_WORST_CASE],
      LEVEL_CURRENT_WORST_CASE,
      HANDLER_CALLS.levelCurrent,
    );
  });

  it('/support', async () => {
    await checkHandler('support', SUPPORT_BRANCHES, SUPPORT_WORST_CASE, HANDLER_CALLS.support);
  });

  it('/help', async () => {
    await checkHandler('help', HELP_BRANCHES, HELP_WORST_CASE, HANDLER_CALLS.help);
  });

  it('/start', async () => {
    await checkHandler('start', START.branches, START.worst, HANDLER_CALLS.start);
  });

  it('/menu', async () => {
    await checkHandler('menu', MENU.branches, MENU.worst, HANDLER_CALLS.menu);
  });

  it('the demo button', async () => {
    await checkHandler('demo', DEMO_BRANCHES, DEMO_WORST_CASE, HANDLER_CALLS.demo);
  });

  it('the demo types', async () => {
    await checkHandler(
      'demoGroups',
      DEMO_GROUPS.branches,
      DEMO_GROUPS.worst,
      HANDLER_CALLS.demoGroups,
    );
  });

  it('a demo page', async () => {
    await checkHandler('demoPage', DEMO_PAGE.branches, DEMO_PAGE.worst, HANDLER_CALLS.demoPage);
  });

  it('a demo asset', async () => {
    await checkHandler('demoAsset', DEMO_ASSET.branches, DEMO_ASSET.worst, HANDLER_CALLS.demoAsset);
  });

  it('a demo duration', async () => {
    await checkHandler(
      'demoDuration',
      DEMO_DURATION.branches,
      DEMO_DURATION.worst,
      HANDLER_CALLS.demoDuration,
    );
  });

  it('the demo analysis', async () => {
    await checkHandler(
      'demoAnalysis',
      DEMO_ANALYSIS.branches,
      DEMO_ANALYSIS.worst,
      HANDLER_CALLS.demoAnalysis,
    );
  });

  it('the stake placeholder', async () => {
    await checkHandler(
      'stakePlaceholder',
      STAKE_PLACEHOLDER_BRANCHES,
      STAKE_PLACEHOLDER_WORST_CASE,
      HANDLER_CALLS.stakePlaceholder,
    );
  });

  it('the connect button', async () => {
    await checkHandler('connect', CONNECT_BRANCHES, CONNECT_WORST_CASE, HANDLER_CALLS.connect);
  });

  it('the oauth button', async () => {
    await checkHandler('oauth', OAUTH_BRANCHES, OAUTH_WORST_CASE, HANDLER_CALLS.oauth);
  });

  it('a text on the address step', async () => {
    await checkHandler(
      'emailStep',
      EMAIL_STEP_BRANCHES,
      EMAIL_STEP_WORST_CASE,
      HANDLER_CALLS.emailStep,
    );
  });

  it('a text on the code step', async () => {
    await checkHandler(
      'codeStep',
      CODE_STEP_BRANCHES,
      CODE_STEP_WORST_CASE,
      HANDLER_CALLS.codeStep,
    );
  });

  it('the resend button', async () => {
    await checkHandler('resend', RESEND_BRANCHES, RESEND_WORST_CASE, HANDLER_CALLS.resend);
  });

  it('/account', async () => {
    await checkHandler('account', ACCOUNT_BRANCHES, ACCOUNT_WORST_CASE, HANDLER_CALLS.account);
  });

  it('the confirm button', async () => {
    await checkHandler('confirm', CONFIRM_BRANCHES, CONFIRM_WORST_CASE, HANDLER_CALLS.confirm);
  });

  it('a my_chat_member update', async () => {
    await checkHandler(
      'myChatMember',
      MY_CHAT_MEMBER_BRANCHES,
      MY_CHAT_MEMBER_WORST_CASE,
      HANDLER_CALLS.myChatMember,
    );
  });
});

describe('the bounds shared with the backend', () => {
  // the backend's upper estimate of POST /trading/access: a shorter wait here would read a broker
  // GET inside its budget as an outage
  it('waits for /trading/access at least as long as the backend budgets the route', () => {
    expect(TRADING_ACCESS_BUDGET_MS).toBeLessThanOrEqual(BACKEND_REQUEST_TIMEOUT_MS);
  });

  // the same for POST /trading/signal (#126): the analysis would read a slow chart as unavailable
  it('waits for /trading/signal at least as long as the backend budgets the route', () => {
    expect(TRADING_SIGNAL_BUDGET_MS).toBeLessThanOrEqual(BACKEND_REQUEST_TIMEOUT_MS);
  });
});

describe('the bounds this project does not own', () => {
  it('matches the stop_grace_period compose gives the bot service', () => {
    expect(composeDurationMs(composeServiceValue(composeYaml, 'bot', 'stop_grace_period'))).toBe(
      COMPOSE_STOP_GRACE_PERIOD_MS,
    );
  });

  it('matches the sleep grammY takes after a failed getUpdates', () => {
    const match = /let sleepSeconds = (\d+);/.exec(readFileSync(grammyBotJs, 'utf8'));
    expect(
      match === null ? null : Number(match[1]) * 1000,
      'grammY changed the sleep in handlePollingError (node_modules/grammy/out/bot.js). This is ' +
        'a grammY upgrade, not a broken test: bot.stop() does not interrupt that sleep, so the ' +
        'drain waits it out. Update GRAMMY_POLLING_BACKOFF_MS in timing.ts and re-check it ' +
        'against SHUTDOWN_BUDGET_MS before touching this assertion.',
    ).toBe(GRAMMY_POLLING_BACKOFF_MS);
  });
});
