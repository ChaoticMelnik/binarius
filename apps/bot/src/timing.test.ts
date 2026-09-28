import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError } from 'grammy';
import type { ApiError, Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import {
  OAuthErrorCode,
  UserStatus,
  type StartLoginResponse,
  type UserStartView,
} from '@binarius/shared';
import { composeDurationMs, composeServiceValue } from '@binarius/shared/testing';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { CONNECT_CALLBACK_DATA, createBot } from './bot';
import {
  BOT_INFO,
  captureApi,
  connectUpdate,
  fakeLogger,
  startUpdate,
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
  welcomeVideoFileId?: string;
  apiErrors?: readonly (readonly [string, ApiError | HttpError])[];
  answers?: readonly (readonly [string, ApiAnswer])[];
}

const VIEW: UserStartView = {
  telegramUserId: '4242',
  status: UserStatus.Active,
  acquisitionSource: null,
  acquiredAt: null,
  hasActiveBrokerAccount: false,
};

const LOGIN: StartLoginResponse = {
  authorizeUrl: 'https://binodex.app/oauth/authorize?state=abc',
  state: 'abc',
  expiresAt: '2026-09-24T10:10:00.000Z',
};

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
      return (branch.recordStart ?? (() => Promise.resolve(VIEW)))(request);
    },
    startLogin: (telegramUserId) => {
      backend += 1;
      return (branch.startLogin ?? (() => Promise.resolve(LOGIN)))(telegramUserId);
    },
  };
  const bot = createBot({
    token: '123456:AA-bot-token',
    backend: client,
    logger: fakeLogger(),
    botInfo: BOT_INFO,
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
  worstCaseLabel: string,
  declared: Calls,
): Promise<void> {
  const observed = new Map<string, Calls>();
  for (const branch of branches) observed.set(branch.label, await observe(branch));

  for (const branch of branches) {
    expect(observed.get(branch.label), `${handler}: ${branch.label}`).toEqual(branch.expected);
  }

  const seen = branches.map((branch) => observed.get(branch.label) as Calls);
  expect(
    {
      backend: Math.max(...seen.map((calls) => calls.backend)),
      telegram: Math.max(...seen.map((calls) => calls.telegram)),
    },
    `${handler}: HANDLER_CALLS no longer describes the worst of the branches above`,
  ).toEqual(declared);
  expect(observed.get(worstCaseLabel), `${handler}: worst case is "${worstCaseLabel}"`).toEqual(
    declared,
  );
}

// Every terminal branch of /start. A branch missing from this list is the one thing the
// budget cannot be checked against — see the note in timing.ts.
const START_WORST_CASE = 'the video is refused and the text replaces it';
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
    recordStart: () => Promise.resolve({ ...VIEW, status: UserStatus.Blocked }),
    expected: { backend: 1, telegram: 1 },
  },
  {
    label: 'the user already has an account',
    update: startUpdate('/start'),
    recordStart: () => Promise.resolve({ ...VIEW, hasActiveBrokerAccount: true }),
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
  {
    label: START_WORST_CASE,
    update: startUpdate('/start'),
    welcomeVideoFileId: 'not-a-file-id',
    apiErrors: [['sendVideo', VIDEO_REFUSED]],
    expected: { backend: 1, telegram: 2 },
  },
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

const CONNECT_WORST_CASE = 'the query is answered and the link is sent';
const CONNECT_BRANCHES: readonly Branch[] = [
  {
    label: 'the chat is not private',
    update: connectUpdate(CONNECT_CALLBACK_DATA, 'group'),
    expected: { backend: 0, telegram: 0 },
  },
  {
    label: CONNECT_WORST_CASE,
    update: connectUpdate(CONNECT_CALLBACK_DATA),
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'answering the query is refused and the link still goes',
    update: connectUpdate(CONNECT_CALLBACK_DATA),
    apiErrors: [['answerCallbackQuery', QUERY_TOO_OLD]],
    expected: { backend: 1, telegram: 2 },
  },
  {
    label: 'the backend reports a blocked user',
    update: connectUpdate(CONNECT_CALLBACK_DATA),
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
    update: connectUpdate(CONNECT_CALLBACK_DATA),
    startLogin: () =>
      Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status: 500 })),
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
