import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError } from 'grammy';
import type { ApiError, Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { confirmCallbackData, OAuthErrorCode, UserStatus } from '@binarius/shared';
import { composeDurationMs, composeServiceValue } from '@binarius/shared/testing';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { CONNECT_CALLBACK_DATA, OAUTH_CALLBACK_DATA, RESEND_CALLBACK_DATA, createBot } from './bot';
import { createLoginDialog, type LoginDialogState } from './login-dialog';
import {
  BOT_INFO,
  CODE,
  CODE_SENT,
  CONFIRMED,
  EMAIL,
  LOGIN,
  PENDING_ACCOUNT_ID,
  USER,
  USER_VIEW,
  captureApi,
  callbackUpdate,
  fakeLogger,
  startUpdate,
  textUpdate,
  type ApiAnswer,
} from './testing';
import { COMPOSE_STOP_GRACE_PERIOD_MS, GRAMMY_POLLING_BACKOFF_MS, HANDLER_CALLS } from './timing';

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
  startLogin?: BackendClient['startLogin'];
  confirmLogin?: BackendClient['confirmLogin'];
  sendEmailCode?: BackendClient['sendEmailCode'];
  emailLogin?: BackendClient['emailLogin'];
  welcomeVideoFileId?: string;
  apiErrors?: readonly (readonly [string, ApiError | HttpError])[];
  answers?: readonly (readonly [string, ApiAnswer])[];
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
  for (const [method, failure] of branch.apiErrors ?? []) api.apiErrors.set(method, failure);
  for (const [method, answer] of branch.answers ?? []) api.answers.set(method, answer);
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

// Every terminal branch of /start. A branch missing from this list is the one thing the
// budget cannot be checked against — see the note in timing.ts.
const START_WORST_CASE: Branch = {
  label: 'the video is refused and the text replaces it',
  update: startUpdate('/start'),
  welcomeVideoFileId: 'not-a-file-id',
  apiErrors: [['sendVideo', VIDEO_REFUSED]],
  expected: { backend: 1, telegram: 2 },
};

const START_BRANCHES: readonly Branch[] = [
  {
    label: 'the update carries no sender',
    update: withoutSender(startUpdate('/start')),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the chat is not private',
    update: startUpdate('/start', 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: 'the backend refuses the start',
    update: startUpdate('/start'),
    recordStart: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the user is blocked',
    update: startUpdate('/start'),
    recordStart: () => Promise.resolve({ ...USER_VIEW, status: UserStatus.Blocked }),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'a link waits for confirmation',
    update: startUpdate('/start'),
    recordStart: () =>
      Promise.resolve({
        ...USER_VIEW,
        pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email: 'ada@example.test' }],
      }),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'a link without an email waits for confirmation beside an active account',
    update: startUpdate('/start'),
    recordStart: () =>
      Promise.resolve({
        ...USER_VIEW,
        hasActiveBrokerAccount: true,
        pendingBrokerAccounts: [{ id: PENDING_ACCOUNT_ID, email: null }],
      }),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the user already has an account',
    update: startUpdate('/start'),
    recordStart: () => Promise.resolve({ ...USER_VIEW, hasActiveBrokerAccount: true }),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'no video is configured',
    update: startUpdate('/start'),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the video is sent',
    update: startUpdate('/start'),
    welcomeVideoFileId: 'BAACAgIAAxkB',
    expected: { backend: 1, telegram: 1 },
  },
  START_WORST_CASE,
  {
    // delivery is unknown, so nothing is sent after it
    label: 'the video call fails in transport',
    update: startUpdate('/start'),
    welcomeVideoFileId: 'BAACAgIAAxkB',
    apiErrors: [['sendVideo', videoTimedOut()]],
    expected: { backend: 1, telegram: 1 },
  },
  {
    // neither a refusal nor the transport: the branch rethrows into bot.catch, and whatever it
    // sent before that still has to fit the budget
    label: 'the video call fails for a reason the transport cannot produce',
    update: startUpdate('/start'),
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
  label: 'the query is answered and the pack is reported',
  update: CONFIRM_UPDATE,
  expected: { backend: 1, telegram: 2 },
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
  {
    label: 'the link is confirmed without a pack for a non-partner account',
    update: CONFIRM_UPDATE,
    confirmLogin: () =>
      Promise.resolve({ ...CONFIRMED, grant: { granted: false, reason: 'not_partner_client' } }),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the link is confirmed without a pack already paid',
    update: CONFIRM_UPDATE,
    confirmLogin: () =>
      Promise.resolve({ ...CONFIRMED, grant: { granted: false, reason: 'already_granted' } }),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'answering the query is refused and the outcome still goes',
    update: CONFIRM_UPDATE,
    apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
    expected: { backend: 1, telegram: 2 },
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
    update: textUpdate('/help'),
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
  label: 'an invalid code is rechecked and no account is active',
  update: textUpdate(CODE),
  dialog: ON_CODE_STEP,
  emailLogin: refusedWith(400, OAuthErrorCode.InvalidCode),
  expected: { backend: 2, telegram: 1 },
};

const CODE_STEP_BRANCHES: readonly Branch[] = [
  {
    label: 'the text is not a code',
    update: textUpdate('c'.repeat(65)),
    dialog: ON_CODE_STEP,
    expected: { backend: 0, telegram: 1 },
  },
  {
    label: 'the login pays the pack',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the login pays no pack',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: () =>
      Promise.resolve({ ...CONFIRMED, grant: { granted: false, reason: 'already_granted' } }),
    expected: { backend: 1, telegram: 1 },
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
    label: 'an invalid code is rechecked and the account is active',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: refusedWith(400, OAuthErrorCode.InvalidCode),
    recordStart: () => Promise.resolve({ ...USER_VIEW, hasActiveBrokerAccount: true }),
    expected: { backend: 2, telegram: 1 },
  },
  {
    label: 'an unreachable login is rechecked and the account is active',
    update: textUpdate(CODE),
    dialog: ON_CODE_STEP,
    emailLogin: unreachable,
    recordStart: () => Promise.resolve({ ...USER_VIEW, hasActiveBrokerAccount: true }),
    expected: { backend: 2, telegram: 1 },
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

describe('what the handlers do, against what HANDLER_CALLS declares', () => {
  it('/start', async () => {
    await checkHandler('start', START_BRANCHES, START_WORST_CASE, HANDLER_CALLS.start);
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

  it('the confirm button', async () => {
    await checkHandler('confirm', CONFIRM_BRANCHES, CONFIRM_WORST_CASE, HANDLER_CALLS.confirm);
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
