import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_TEXT_CATALOG,
  botTextOverridesResponseSchema,
  BrokerAccountStatus,
  DemoStakeRefusal,
  INT4_MAX,
  LinkBonusSkipReason,
  MAX_SESSION_TRADES,
  MomentumDirection,
  NotificationLevel,
  OAuthErrorCode,
  PairsCatalogErrorCode,
  REFERRAL_CODE_LENGTH,
  RULE_REFUSAL_REASONS,
  safeParseChatMemberResponse,
  safeParseConfirmLoginResponse,
  safeParseDemoStakeRefusal,
  safeParseEmailLoginResponse,
  safeParseEmailSendCodeResponse,
  safeParseNotificationLevelResponse,
  safeParsePairsCatalogResponse,
  safeParseSessionSummaryResponse,
  safeParseTradeIntentView,
  safeParseTradingAccessResponse,
  safeParseTradingSessionRefusal,
  safeParseTradingSessionResponse,
  safeParseTradingSessionsStoppedResponse,
  safeParseSetTradingModeResponse,
  safeParseTradingSignalResponse,
  safeParseTradingSignalsResponse,
  safeParseUserAccountResponse,
  safeParseUserStartResponse,
  SIGNAL_ALGORITHM_VERSION,
  SIGNAL_SCAN_INTERVALS,
  SignalFeedOutcome,
  SignalKind,
  TELEGRAM_MESSAGE_LIMIT,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeTransport,
  TradingSessionStatus,
  TradingSessionStopReason,
  TrendDirection,
  USER_ACCOUNT_LIST_LIMIT,
  UserStatus,
  userReferralResponseSchema,
  TradeAction,
  TradeIntentErrorCode,
  TradeMode,
  TradingSessionErrorCode,
  UserErrorCode,
  type CreateTradeIntentRequest,
  type CreateTradingSessionRequest,
  type UserStartRequest,
  type DecimalString,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import {
  BackendError,
  BackendErrorCode,
  createBackendClient,
  MAX_BACKEND_BODY_BYTES,
  MAX_BOT_TEXTS_BODY_BYTES,
  type BackendClient,
} from './backend-client';
import {
  ACCESS_VIEW,
  BROKER_BALANCE,
  CODE,
  CODE_SENT,
  CONFIRMED,
  EMAIL,
  INTENT_ID,
  INTENT_VIEW,
  LINK_ACTIVE,
  LINK_PENDING,
  LINK_REVOKED,
  PAIRS_RESPONSE,
  PENDING_ACCOUNT_ID,
  SIGNAL_DECIDED,
  SIGNAL_DECISION,
  SIGNAL_FETCH_FAILED,
  SESSION_ID,
  SESSION_VIEW,
  closeServer,
  listen,
  accountView,
  rejectionOf,
  userView,
} from './testing';

const TOKEN = 'internal-token-for-tests';

interface Capture {
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  body?: string;
}

let server: Server | undefined;
afterEach(async () => {
  const running = server;
  server = undefined;
  await closeServer(running);
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<{ baseUrl: string; capture: Capture }> {
  const capture: Capture = {};
  const started = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      capture.method = request.method;
      capture.url = request.url;
      capture.authorization = request.headers.authorization;
      capture.contentType = request.headers['content-type'];
      capture.body = Buffer.concat(chunks).toString('utf8');
      handler(request, response, capture.body);
    });
  });
  server = started;
  return { baseUrl: await listen(started), capture };
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const request: UserStartRequest = {
  telegramUserId: '4242',
  displayName: 'Ada',
  startPayload: 'src_ab-CD9',
};

const view = userView({
  acquisitionSource: 'src_ab-CD9',
  acquiredAt: '2026-09-24T10:00:00.000Z',
});

describe('recordStart', () => {
  it('posts the request under the internal bearer and returns the view', async () => {
    const { baseUrl, capture } = await serve((_request, response) => {
      json(response, 200, { user: view });
    });
    const client = createBackendClient({ baseUrl, token: TOKEN });

    expect(await client.recordStart(request)).toEqual(view);
    expect(capture.method).toBe('POST');
    expect(capture.contentType).toBe('application/json');
    expect(capture.url).toBe('/users/start');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual(request);
  });

  it('keeps a path prefix on the base URL', async () => {
    const { baseUrl, capture } = await serve((_request, response) => {
      json(response, 200, { user: view });
    });
    await createBackendClient({ baseUrl: `${baseUrl}/api`, token: TOKEN }).recordStart(request);
    expect(capture.url).toBe('/api/users/start');
  });

  it('reports a body that does not match the contract', async () => {
    const { baseUrl } = await serve((_request, response) => {
      json(response, 200, { user: { telegramUserId: '4242' } });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).recordStart(request),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).code).toBe(BackendErrorCode.ContractViolation);
  });

  it('reports a body that is not JSON at all', async () => {
    const { baseUrl } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('<html>proxy error</html>');
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).recordStart(request),
    );
    expect((error as BackendError).code).toBe(BackendErrorCode.ContractViolation);
  });

  it.each([401, 500])('reports HTTP %s with the status', async (status) => {
    const { baseUrl } = await serve((_request, response) => {
      json(response, status, { error: 'internal' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).recordStart(request),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status, reason: 'internal' });
  });

  it('gives up on a server that never answers', async () => {
    const { baseUrl } = await serve(() => {});
    const started = Date.now();
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN, timeoutMs: 150 }).recordStart(request),
    );
    expect((error as BackendError).code).toBe(BackendErrorCode.Unreachable);
    expect(Date.now() - started).toBeLessThan(UNIT_WAIT_CEILING_MS);
  });

  it.each([200, 500])(
    'reports a %s whose body then stalls as unreachable, with the status',
    async (status) => {
      // AbortSignal.timeout stays attached through the body, so this rejects response.json()
      // with the abort — a slow backend, not a contract the route broke
      const { baseUrl } = await serve((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.write('{"user":');
      });
      const started = Date.now();
      const error = await rejectionOf(
        createBackendClient({ baseUrl, token: TOKEN, timeoutMs: 150 }).recordStart(request),
      );
      expect(error).toMatchObject({ code: BackendErrorCode.Unreachable, status });
      expect(Date.now() - started).toBeLessThan(UNIT_WAIT_CEILING_MS);
    },
  );

  it('reports a backend that is not listening', async () => {
    const { baseUrl } = await serve(() => {});
    const dead = baseUrl;
    const running = server;
    server = undefined;
    await closeServer(running);
    const error = await rejectionOf(
      createBackendClient({ baseUrl: dead, token: TOKEN }).recordStart(request),
    );
    expect((error as BackendError).code).toBe(BackendErrorCode.Unreachable);
  });
});

describe('readAccount', () => {
  const account = accountView({ accounts: [LINK_PENDING, LINK_ACTIVE, LINK_REVOKED] });

  it('posts the telegram id under the internal bearer and returns the view', async () => {
    const { baseUrl, capture } = await serve((_request, response) => {
      json(response, 200, { user: account });
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).readAccount('4242')).toEqual(
      account,
    );
    expect(capture.url).toBe('/users/account');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242' });
  });

  it('reports a body without accounts as a contract violation', async () => {
    const { baseUrl } = await serve((_request, response) => {
      json(response, 200, { user: { status: account.status } });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readAccount('4242'),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).code).toBe(BackendErrorCode.ContractViolation);
  });

  it('carries user_not_found as the reason of a 404', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 404, { error: UserErrorCode.UserNotFound });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readAccount('4242'),
    );
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: UserErrorCode.UserNotFound,
    });
  });

  it('carries a 500 as its status, without the body', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 500, { message: 'ada@example.test is broken' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readAccount('4242'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 500 });
    expect((error as BackendError).reason).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('ada@example.test');
  });
});

describe('readReferral (#115)', () => {
  const view = { status: 'active', code: 'AbC123xY', invited: 2 };

  it('posts the telegram id to /users/referral under the internal bearer', async () => {
    const { baseUrl, capture } = await serve((_request, response) => {
      json(response, 200, { user: view });
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).readReferral('4242')).toEqual(view);
    expect(capture.url).toBe('/users/referral');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242' });
  });

  it('reports a malformed code as a contract violation', async () => {
    const { baseUrl } = await serve((_request, response) => {
      json(response, 200, { user: { ...view, code: 'ref_AbC123xY' } });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readReferral('4242'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries user_not_found as the reason of a 404', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 404, { error: UserErrorCode.UserNotFound });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readReferral('4242'),
    );
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: UserErrorCode.UserNotFound,
    });
  });
});

describe('confirmLogin', () => {
  it('sends both identities and returns the parsed response', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, CONFIRMED);
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).confirmLogin('4242', PENDING_ACCOUNT_ID),
    ).toEqual(CONFIRMED);
    expect(capture.url).toBe('/auth/binodex/confirm');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({
      telegramUserId: '4242',
      accountId: PENDING_ACCOUNT_ID,
    });
  });

  // the grant is what the bot prints, so a confirm answer without one is not a success
  it('reports an answer that carries no grant as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { account: CONFIRMED.account });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).confirmLogin('4242', PENDING_ACCOUNT_ID),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries the backend error code as the reason', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: OAuthErrorCode.AccountNotPending });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).confirmLogin('4242', PENDING_ACCOUNT_ID),
    );
    expect(error).toMatchObject({ status: 409, reason: OAuthErrorCode.AccountNotPending });
  });

  it('refuses an error code that is not a bare code', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: 'Sorry Ada, your account 4242 is not pending' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).confirmLogin('4242', PENDING_ACCOUNT_ID),
    );
    expect((error as BackendError).reason).toBeUndefined();
  });
});

describe('sendEmailCode', () => {
  it('sends the telegram id and the address under the bearer and returns the answer', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, CODE_SENT);
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).sendEmailCode('4242', EMAIL),
    ).toEqual(CODE_SENT);
    expect(capture.url).toBe('/auth/binodex/email/send-code');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242', email: EMAIL });
  });

  // the route answers `codeSent: true` or an error; anything else is not a sent code
  it('reports an answer that does not say the code was sent as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { codeSent: false });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).sendEmailCode('4242', EMAIL),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it.each([
    [400, OAuthErrorCode.InvalidEmail],
    [429, OAuthErrorCode.TooManyAttempts],
  ])('carries a %i %s as the reason', async (status, reason) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, status, { error: reason });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).sendEmailCode('4242', EMAIL),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status, reason });
  });
});

describe('recordChatMember', () => {
  it('posts the id and the status under the bearer and returns the answer', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, { recorded: true });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).recordChatMember('4242', 'kicked'),
    ).toEqual({ recorded: true });
    expect(capture.url).toBe('/users/chat-member');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242', status: 'kicked' });
  });

  it('reports an answer without recorded as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, {});
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).recordChatMember('4242', 'member'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('setNotificationLevel', () => {
  it('posts the id and the level under the bearer and returns the answer', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, { level: 'off', demoStake: '2.5' });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).setNotificationLevel('4242', 'off'),
    ).toEqual({ level: 'off', demoStake: '2.5' });
    expect(capture.url).toBe('/users/notification-level');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242', level: 'off' });
  });

  it('reports an unknown level in the answer as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { level: 'daily', demoStake: null });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).setNotificationLevel('4242', 'reduced'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries user_not_found as the reason of a 404', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 404, { error: UserErrorCode.UserNotFound });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).setNotificationLevel('4242', 'all'),
    );
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: UserErrorCode.UserNotFound,
    });
  });
});

describe('setDemoStake (#297)', () => {
  const LIMITS = { minTradeAmount: '1', demoAvailable: '50', scale: 2 };

  it.each([['2.5'], [null]])(
    'posts %s under the bearer and returns the saved stake',
    async (amount) => {
      const { baseUrl, capture } = await serve((_request, reply) => {
        json(reply, 200, { demoStake: amount });
      });
      expect(
        await createBackendClient({ baseUrl, token: TOKEN }).setDemoStake(
          '4242',
          amount as DecimalString | null,
        ),
      ).toEqual({ saved: amount });
      expect(capture.url).toBe('/trading/demo-stake');
      expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242', amount });
    },
  );

  it('returns a bounds refusal with its limits', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: 'stake_below_minimum', limits: LIMITS });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).setDemoStake(
        '4242',
        '0.5' as DecimalString,
      ),
    ).toEqual({ refused: { error: 'stake_below_minimum', limits: LIMITS } });
  });

  it.each([
    ['a bounds refusal without its limits', 409, { error: 'stake_precision' }],
    ['a 200 without the stake', 200, {}],
  ])('reports %s as a contract violation', async (_case, status, body) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, status, body);
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).setDemoStake('4242', '5' as DecimalString),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation, status });
  });

  it.each([
    [409, 'balance_unavailable'],
    [404, 'user_not_found'],
    [400, 'validation'],
  ])('throws a %i %s with its reason and nothing else of the body', async (status, reason) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, status, { error: reason, limits: LIMITS, issues: ['x'] });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).setDemoStake('4242', '5' as DecimalString),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status, reason });
  });
});

describe('setTradingMode (#121)', () => {
  it.each([
    ['real', true],
    ['demo', false],
  ] as const)('posts %s under the bearer and returns the answer', async (mode, changed) => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, { tradingMode: mode, changed });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).setTradingMode('4242', mode),
    ).toEqual({ tradingMode: mode, changed });
    expect(capture.url).toBe('/trading/mode');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242', mode });
  });

  it.each([
    ['without changed', { tradingMode: 'real' }],
    ['with an unknown mode', { tradingMode: 'paper', changed: true }],
  ])('reports a 200 %s as a contract violation', async (_case, body) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, body);
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).setTradingMode('4242', 'real'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it.each([
    [409, 'real_balance_below_minimum'],
    [409, 'balance_unavailable'],
    [409, 'demo_only'],
    [404, 'user_not_found'],
    [400, 'validation'],
  ])('throws a %i %s with its reason', async (status, reason) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, status, { error: reason, issues: ['x'] });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).setTradingMode('4242', 'real'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status, reason });
  });
});

describe('readTradingAccess', () => {
  it('posts only the telegram id under the bearer and returns the whole answer', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, ACCESS_VIEW);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).readTradingAccess('4242')).toEqual(
      ACCESS_VIEW,
    );
    expect(capture.url).toBe('/trading/access');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242' });
  });

  it.each([
    [
      'available is not balance - reserved',
      { tokens: { balance: '5', reserved: '1', available: '5' } },
    ],
    ['both broker and brokerUnavailable are set', { brokerUnavailable: 'refreshing' }],
    ['fresh disagrees with the ages', { broker: { ...BROKER_BALANCE, fresh: false } }],
    ['tradingOpen is missing', { tradingOpen: undefined }],
  ])('reports a body where %s as a contract violation', async (_case, patch) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { ...ACCESS_VIEW, ...patch });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readTradingAccess('4242'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries user_not_found as the reason of a 404', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 404, { error: UserErrorCode.UserNotFound });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readTradingAccess('4242'),
    );
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: UserErrorCode.UserNotFound,
    });
  });

  it('carries a 500 as its status, without the body', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 500, { message: 'balance 10000.00000000 is broken' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readTradingAccess('4242'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 500 });
    expect((error as BackendError).reason).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('10000');
  });
});

describe('readBotTexts (#299)', () => {
  const OVERRIDES = { overrides: [{ key: 'welcome', source: 'Привет', version: 3 }] };

  it('C1 sends a GET to /bot-texts under the bearer and returns the rows', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, OVERRIDES);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).readBotTexts()).toEqual(
      OVERRIDES.overrides,
    );
    expect(capture.method).toBe('GET');
    expect(capture.url).toBe('/bot-texts');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    [
      'a field the allowlist does not have',
      { overrides: [{ ...OVERRIDES.overrides[0], updatedAt: 'x' }] },
    ],
    ['a malformed key', { overrides: [{ key: 'Welcome', source: 'x', version: 1 }] }],
    ['no list', {}],
  ])('C2 reports %s as a contract violation', async (_label, body) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, body);
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readBotTexts());
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('C3 carries a failed status as an error', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 503, {});
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readBotTexts());
    expect(error).toMatchObject({ status: 503 });
  });
});

describe('readSignals', () => {
  const SIGNALS = {
    asOf: 1_760_000_016_000,
    lists: [
      {
        interval: '15s',
        scanned: 13,
        signals: [
          {
            assetId: 101,
            action: 'up',
            lastCandleTimestamp: 1_760_000_000_000,
            decidedAt: 1_760_000_015_500,
            ageMs: 1_000,
          },
        ],
      },
      { interval: '5s', scanned: 4, signals: [] },
    ],
  };

  it('sends a GET under the bearer and returns the parsed answer', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, SIGNALS);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).readSignals()).toEqual(SIGNALS);
    expect(capture.method).toBe('GET');
    expect(capture.url).toBe('/trading/signals');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(capture.body).toBe('');
  });

  it('reports an answer that fails the schema as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { ...SIGNALS, lists: [{ ...SIGNALS.lists[1], interval: '1m' }] });
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readSignals());
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('reports the flat body from before #382 as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { asOf: SIGNALS.asOf, ...SIGNALS.lists[0] });
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readSignals());
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries a non-2xx as its status', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 401, { error: 'unauthorized' });
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readSignals());
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 401 });
  });
});

describe('readPairs', () => {
  it('sends a GET under the bearer with no body and no content-type, and returns the whole answer', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, PAIRS_RESPONSE);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).readPairs()).toEqual(
      PAIRS_RESPONSE,
    );
    expect(capture.method).toBe('GET');
    expect(capture.url).toBe('/trading/pairs');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(capture.contentType).toBeUndefined();
    expect(capture.body).toBe('');
  });

  // without it a backend older than #125 would read as fresh
  it('reports an answer without fresh as a contract violation', async () => {
    const withoutFresh: Partial<typeof PAIRS_RESPONSE> = { ...PAIRS_RESPONSE };
    delete withoutFresh.fresh;
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, withoutFresh);
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readPairs());
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries a 503 catalog_unavailable as its status and reason', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 503, { error: PairsCatalogErrorCode.Unavailable });
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readPairs());
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 503,
      reason: PairsCatalogErrorCode.Unavailable,
    });
  });

  it('carries a 500 as its status, without the body', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 500, { message: 'EUR/USD SECRET-BODY' });
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readPairs());
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 500 });
    expect((error as BackendError).reason).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('SECRET-BODY');
  });

  it('gives up on a server that never answers', async () => {
    const { baseUrl } = await serve(() => {});
    const started = Date.now();
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN, timeoutMs: 150 }).readPairs(),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.Unreachable });
    expect(Date.now() - started).toBeLessThan(UNIT_WAIT_CEILING_MS);
  });
});

describe('evaluateSignal', () => {
  it('posts the asset and the interval under the bearer and returns a decision whole', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, SIGNAL_DECIDED);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).evaluateSignal(101, '5m')).toEqual(
      SIGNAL_DECIDED,
    );
    expect(capture.method).toBe('POST');
    expect(capture.url).toBe('/trading/signal');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ assetId: 101, interval: '5m' });
  });

  it('returns a fetch_failed answer as an answer, not an error', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, SIGNAL_FETCH_FAILED);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).evaluateSignal(101, '1m')).toEqual(
      SIGNAL_FETCH_FAILED,
    );
  });

  // a bare decision is what the decider returns; the route wraps it with the outcome and params
  it.each([
    ['a bare decision without outcome', SIGNAL_DECISION],
    [
      'an unknown reason',
      {
        ...SIGNAL_DECIDED,
        decision: { kind: 'no_signal', version: 'v1', reason: 'moon_phase', features: {} },
      },
    ],
    [
      'a decision of another version',
      { ...SIGNAL_DECIDED, decision: { ...SIGNAL_DECISION, version: 'v1' } },
    ],
  ])('reports %s as a contract violation', async (_case, body) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, body);
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).evaluateSignal(101, '1m'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries a 400 validation as its status and reason', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 400, { error: 'validation', issues: [{ path: ['interval'] }] });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).evaluateSignal(101, '1m'),
    );
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 400,
      reason: 'validation',
    });
  });

  it('carries a 500 as its status, without the body', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 500, { message: 'EUR/USD SECRET-BODY' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).evaluateSignal(101, '1m'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 500 });
    expect((error as BackendError).reason).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('SECRET-BODY');
  });

  it('gives up on a server that never answers', async () => {
    const { baseUrl } = await serve(() => {});
    const started = Date.now();
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN, timeoutMs: 150 }).evaluateSignal(101, '1m'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.Unreachable });
    expect(Date.now() - started).toBeLessThan(UNIT_WAIT_CEILING_MS);
  });
});

describe('createIntent', () => {
  const intentRequest: CreateTradeIntentRequest = {
    telegramUserId: '4242',
    mode: TradeMode.Demo,
    assetId: 101,
    amount: INTENT_VIEW.amount,
    action: TradeAction.Up,
    durationSec: 60,
    clientRequestId: 'demo:4242:0123456789ab',
  };

  it.each([201, 200])('posts the request under the bearer; %i returns the view', async (status) => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, status, { intent: INTENT_VIEW });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).createIntent(intentRequest),
    ).toEqual(INTENT_VIEW);
    expect(capture.method).toBe('POST');
    expect(capture.url).toBe('/trading/intents');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual(intentRequest);
  });

  it.each([
    ['no intent', { view: INTENT_VIEW }],
    ['a status outside the enum', { intent: { ...INTENT_VIEW, status: 'open' } }],
    ['a numeric amount', { intent: { ...INTENT_VIEW, amount: 1 } }],
  ])('reports a body with %s as a contract violation', async (_name, body) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 201, body);
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).createIntent(intentRequest),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries a 409 as its status and reason', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: TradeIntentErrorCode.ActiveIntentExists });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).createIntent(intentRequest),
    );
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 409,
      reason: TradeIntentErrorCode.ActiveIntentExists,
    });
  });

  it('carries a 500 as its status, without the body', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 500, { message: 'SECRET-BODY' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).createIntent(intentRequest),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 500 });
    expect((error as BackendError).reason).toBeUndefined();
  });
});

describe('readIntent', () => {
  it('sends a GET of the id with the owner in the query, and returns the view', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, { intent: INTENT_VIEW });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).readIntent(INTENT_ID, '4242'),
    ).toEqual(INTENT_VIEW);
    expect(capture.method).toBe('GET');
    expect(capture.url).toBe(`/trading/intents/${INTENT_ID}?telegramUserId=4242`);
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(capture.contentType).toBeUndefined();
  });

  it('keeps an id that is not a path segment inside its segment', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 404, { error: 'not_found' });
    });
    await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readIntent('../x?y', '4242'));
    expect(capture.url).toBe('/trading/intents/..%2Fx%3Fy?telegramUserId=4242');
  });

  it('carries a 404 not_found as its reason', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 404, { error: 'not_found' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readIntent(INTENT_ID, '4242'),
    );
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: 'not_found',
    });
  });

  it('reports a broken body as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { intent: { ...INTENT_VIEW, lastError: 'whatever' } });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readIntent(INTENT_ID, '4242'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

// #284
describe('startSession', () => {
  const sessionRequest: CreateTradingSessionRequest = {
    telegramUserId: '4242',
    assetId: 101,
    durationSec: 60,
    trades: 5,
  };
  const startWith = async (status: number, body: unknown) => {
    const served = await serve((_request, reply) => {
      json(reply, status, body);
    });
    return {
      ...served,
      start: () =>
        createBackendClient({ baseUrl: served.baseUrl, token: TOKEN }).startSession(sessionRequest),
    };
  };

  it('posts the request under the bearer; 201 returns the session as started', async () => {
    const { start, capture } = await startWith(201, { session: SESSION_VIEW });
    expect(await start()).toEqual({ started: SESSION_VIEW });
    expect(capture.method).toBe('POST');
    expect(capture.url).toBe('/trading/sessions');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual(sessionRequest);
  });

  it.each([
    ['no session', { intent: SESSION_VIEW }],
    ['a status outside the enum', { session: { ...SESSION_VIEW, status: 'running' } }],
  ])('reports a 201 with %s as a contract violation', async (_name, body) => {
    const { start } = await startWith(201, body);
    expect(await rejectionOf(start())).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('returns the active session a 409 active_session_exists carries', async () => {
    const { start } = await startWith(409, {
      error: TradingSessionErrorCode.ActiveSessionExists,
      session: SESSION_VIEW,
    });
    expect(await start()).toEqual({ active: SESSION_VIEW });
  });

  it('returns null when the active session ended before the backend read it', async () => {
    const { start } = await startWith(409, {
      error: TradingSessionErrorCode.ActiveSessionExists,
      session: null,
    });
    expect(await start()).toEqual({ active: null });
  });

  // the code alone is not the contract: the outcome is not known, so the caller retries
  it.each([
    ['a session that is not a view', { error: 'active_session_exists', session: 'x' }],
    ['no session at all', { error: 'active_session_exists' }],
  ])('reports a 409 active_session_exists with %s as a contract violation', async (_n, body) => {
    const { start } = await startWith(409, body);
    expect(await rejectionOf(start())).toMatchObject({
      code: BackendErrorCode.ContractViolation,
      status: 409,
    });
  });

  it.each([
    [409, TradingSessionErrorCode.InsufficientTokens],
    [503, TradingSessionErrorCode.CatalogUnavailable],
    [404, TradingSessionErrorCode.BrokerAccountNotFound],
  ])('carries a %i %s as its status and reason', async (status, reason) => {
    const { start } = await startWith(status, { error: reason });
    expect(await rejectionOf(start())).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status,
      reason,
    });
  });

  it('carries a 500 as its status, without the body', async () => {
    const { start } = await startWith(500, { message: 'SECRET-BODY', session: SESSION_VIEW });
    const error = await rejectionOf(start());
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 500 });
    expect((error as BackendError).reason).toBeUndefined();
  });
});

describe('readSession', () => {
  it('sends a GET of the id with the owner in the query, and returns the view', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, { session: SESSION_VIEW });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).readSession(SESSION_ID, '4242'),
    ).toEqual(SESSION_VIEW);
    expect(capture.method).toBe('GET');
    expect(capture.url).toBe(`/trading/sessions/${SESSION_ID}?telegramUserId=4242`);
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(capture.contentType).toBeUndefined();
  });

  it('keeps an id that is not a path segment inside its segment', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 404, { error: 'not_found' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readSession('../x?y', '4242'),
    );
    expect(capture.url).toBe('/trading/sessions/..%2Fx%3Fy?telegramUserId=4242');
    expect(error).toMatchObject({ status: 404, reason: 'not_found' });
  });

  it('reports a broken body as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { session: { ...SESSION_VIEW, trades: null } });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).readSession(SESSION_ID, '4242'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('stopSession', () => {
  it('posts the owner to the stop path and returns the view', async () => {
    const stopped = {
      ...SESSION_VIEW,
      status: 'stopped',
      stopReason: 'user_stopped',
      endedAt: SESSION_VIEW.startedAt,
    };
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, { session: stopped });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).stopSession(SESSION_ID, '4242'),
    ).toEqual(stopped);
    expect(capture.method).toBe('POST');
    expect(capture.url).toBe(`/trading/sessions/${SESSION_ID}/stop`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242' });
  });

  it('carries a 409 session_not_active as its reason', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: TradingSessionErrorCode.SessionNotActive });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).stopSession(SESSION_ID, '4242'),
    );
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 409,
      reason: TradingSessionErrorCode.SessionNotActive,
    });
  });
});

describe('claimSessionSummary (#318)', () => {
  const SUMMARY = {
    result: '-0.15000000',
    trades: [
      { profit: '0.85000000', openPrice: 1.1, closePrice: 1.2 },
      { profit: '-1.00000000', openPrice: 1.2, closePrice: 1.1 },
    ],
  };
  const claim = (baseUrl: string) =>
    createBackendClient({ baseUrl, token: TOKEN }).claimSessionSummary(SESSION_ID, '4242');

  it('posts the owner to the summary path and returns the summary', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, { summary: SUMMARY });
    });
    expect(await claim(baseUrl)).toEqual(SUMMARY);
    expect(capture.method).toBe('POST');
    expect(capture.url).toBe(`/trading/sessions/${SESSION_ID}/summary`);
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242' });
  });

  it('answers null for the 409 summary_unavailable', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: 'summary_unavailable' });
    });
    expect(await claim(baseUrl)).toBeNull();
  });

  it('throws any other refusal with its status and code, a 409 of another code included', async () => {
    for (const [status, error] of [
      [409, 'session_not_active'],
      [400, 'validation'],
      [500, undefined],
    ] as const) {
      const { baseUrl } = await serve((_request, reply) => {
        json(reply, status, error === undefined ? {} : { error });
      });
      expect(await rejectionOf(claim(baseUrl))).toMatchObject({
        code: BackendErrorCode.HttpStatus,
        status,
        reason: error,
      });
      const running = server;
      server = undefined;
      await closeServer(running);
    }
  });

  it('reports a broken 2xx as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { summary: { ...SUMMARY, trades: [] } });
    });
    expect(await rejectionOf(claim(baseUrl))).toMatchObject({
      code: BackendErrorCode.ContractViolation,
      status: 200,
    });
  });
});

describe('stopSessions (#122)', () => {
  const stopped = {
    ...SESSION_VIEW,
    status: 'stopped',
    stopReason: 'user_stopped',
    endedAt: SESSION_VIEW.startedAt,
  };

  it('posts the owner to the stop-all path under the bearer and returns the views', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, { sessions: [stopped, { ...stopped, id: INTENT_ID }] });
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).stopSessions('4242')).toEqual([
      stopped,
      { ...stopped, id: INTENT_ID },
    ]);
    expect(capture.method).toBe('POST');
    expect(capture.url).toBe('/trading/sessions/stop');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242' });
  });

  it('returns an empty list as it is', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { sessions: [] });
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).stopSessions('4242')).toEqual([]);
  });

  it('reports a broken body as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { session: stopped });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).stopSessions('4242'),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('carries a 500 as its status, without the body', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 500, { error: 'internal' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).stopSessions('4242'),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 500 });
  });
});

describe('emailLogin', () => {
  it('sends the telegram id, the address and the code and returns the grant', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, CONFIRMED);
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).emailLogin('4242', EMAIL, CODE),
    ).toEqual(CONFIRMED);
    expect(capture.url).toBe('/auth/binodex/email/login');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({
      telegramUserId: '4242',
      email: EMAIL,
      code: CODE,
    });
  });

  // the grant is what the bot prints, so a login answer without one is not a success
  it('reports an answer that carries no grant as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { account: CONFIRMED.account });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).emailLogin('4242', EMAIL, CODE),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it.each([
    [400, OAuthErrorCode.InvalidCode],
    [429, OAuthErrorCode.TooManyAttempts],
    [409, OAuthErrorCode.BrokerAccountTaken],
  ])('carries a %i %s as the reason', async (status, reason) => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, status, { error: reason });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).emailLogin('4242', EMAIL, CODE),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status, reason });
  });

  // the request body holds the address and the code; a backend that echoed them in a 400 must
  // not hand them to whatever logs the error
  it('keeps a body that echoes the code out of the error', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 400, {
        error: 'validation',
        detail: 'SECRET-CODE',
        issues: [{ path: ['code'], message: 'SECRET-CODE' }],
      });
    });
    const error = (await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).emailLogin('4242', EMAIL, 'SECRET-CODE'),
    )) as BackendError;

    expect(error).toMatchObject({ status: 400, reason: 'validation' });
    expect(error.message).not.toContain('SECRET-CODE');
    expect(JSON.stringify({ ...error })).not.toContain('SECRET-CODE');
    expect(error.stack ?? '').not.toContain('SECRET-CODE');
  });
});

describe('BackendError carries no response body', () => {
  it('keeps the body out of the message, the fields and the serialized error', async () => {
    const { baseUrl } = await serve((_request, response) => {
      json(response, 500, {
        error: 'internal',
        detail: 'SECRET-BODY',
        issues: [{ path: ['displayName'], message: 'SECRET-BODY' }],
      });
    });
    const error = (await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).recordStart(request),
    )) as BackendError;

    expect(error.message).not.toContain('SECRET-BODY');
    expect(JSON.stringify(error)).not.toContain('SECRET-BODY');
    expect(JSON.stringify({ ...error })).not.toContain('SECRET-BODY');
    expect(error.stack ?? '').not.toContain('SECRET-BODY');
  });
});

// #234: the client reads at most a ceiling of a body, counted as it arrives
describe('body size', () => {
  const noop = (): void => {};
  const CHUNK = ' '.repeat(64 * 1024);

  // own servers: closeServer does not drop the connections a body still holds open
  let held: Server | undefined;
  afterEach(async () => {
    const running = held;
    held = undefined;
    if (running === undefined) return;
    running.closeAllConnections();
    await new Promise<void>((resolve) => running.close(() => resolve()));
  });
  const hold = async (answer: (response: ServerResponse) => void): Promise<string> => {
    const started = createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => answer(response));
    });
    held = started;
    return listen(started);
  };

  // `body` as JSON, then whitespace (still valid JSON) until the whole is longer than `atLeast`
  const padded = (response: ServerResponse, status: number, body: unknown, atLeast: number) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.on('error', noop);
    const head = JSON.stringify(body);
    response.write(head);
    for (let written = Buffer.byteLength(head); written <= atLeast; written += CHUNK.length) {
      response.write(CHUNK);
    }
    response.end();
  };

  // a body with no end: written as fast as the client reads it
  const endless = (response: ServerResponse, status: number, head: string) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.on('error', noop);
    response.write(head);
    const pump = (): void => {
      let more = true;
      while (more) more = response.write(CHUNK);
      response.once('drain', pump);
    };
    pump();
  };

  const OVERRIDES = { overrides: [{ key: 'welcome', source: 'Привет', version: 3 }] };

  it('(a) refuses a 2xx longer than the ceiling as a contract violation with no cause', async () => {
    const baseUrl = await hold((response) => {
      padded(response, 200, { user: view }, MAX_BACKEND_BODY_BYTES);
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).recordStart(request),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
    expect((error as BackendError).cause).toBeUndefined();
  });

  it('(b) reports an error status whose body never ends by its status, without a reason', async () => {
    const baseUrl = await hold((response) => {
      endless(response, 409, '{"error":"user_blocked",');
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN, timeoutMs: 60_000 }).recordStart(request),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 409 });
    expect((error as BackendError).reason).toBeUndefined();
  }, 2_000);

  it('(e) reads GET /bot-texts past the common ceiling, up to its own', async () => {
    const baseUrl = await hold((response) => {
      padded(response, 200, OVERRIDES, 2 * MAX_BACKEND_BODY_BYTES);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).readBotTexts()).toEqual(
      OVERRIDES.overrides,
    );
  });

  it('(f) refuses GET /bot-texts longer than its own ceiling as a contract violation', async () => {
    const baseUrl = await hold((response) => {
      padded(response, 200, OVERRIDES, MAX_BOT_TEXTS_BODY_BYTES);
    });
    const error = await rejectionOf(createBackendClient({ baseUrl, token: TOKEN }).readBotTexts());
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  // (c) The longest answer of every method under named assumptions. A task that adds a
  // BackendClient method adds its row here; the gate below reds otherwise (Architecture Rule 26).
  // Every assumption is in UTF-8 BYTES, not characters. A field the schema bounds in characters
  // holds the most bytes the schema admits: control characters (6 bytes each in JSON) where it
  // accepts them. A field held to an assumption is filled with 4-byte characters, which JSON
  // carries unescaped, so its wire size is the assumed bytes.
  describe('(c) the samples table', () => {
    // false if a user has 100 pending links: userStartViewSchema.pendingBrokerAccounts is unbounded
    const ASSUMED_LONGEST_LIST = 100;
    // false if the broker lists more than 300 binary pairs; the live broker gives 144
    // (docs/broker-rest.md); also bounds a signals list, one signal per scanned pair
    const ASSUMED_LONGEST_PAIRS = 300;
    // false for a string with no max() and no bounding writer that is longer: a broker user id, a
    // balance level code, acquisitionSource
    const ASSUMED_LONGEST_FREE_STRING = 2048;
    // a pair's symbol and type: the broker's are short (EUR/USD; the live catalog of 144 pairs,
    // docs/broker-rest.md); false once the broker sends one longer than 64 bytes. A catalog that
    // grows past the ceiling then fails loudly as contract_violation, not silently.
    const ASSUMED_LONGEST_PAIR_STRING = 64;
    // false for a longer address: the OAuth path stores user.email as any string (oauth-ops.ts)
    const ASSUMED_LONGEST_EMAIL = 254;
    // the sessions POST /trading/sessions/stop returns, one active session per account at most
    // (trading_sessions_active_account_idx); false if a user has more than 10 linked accounts:
    // broker_accounts bounds no count per user
    const ASSUMED_USER_BROKER_ACCOUNTS = 10;
    // one text in GET /bot-texts; false for a text longer than Telegram's limit in 4-byte
    // characters: the CHECK allows it, the loader refuses it
    const ASSUMED_LONGEST_BOT_TEXT_BYTES = 4 * TELEGRAM_MESSAGE_LIMIT;

    const bytesLong = (bytes: number): string =>
      '\u{1F600}'.repeat(Math.floor(bytes / 4)) + 'x'.repeat(bytes % 4);
    const controlChars = (units: number): string => '\x01'.repeat(units);
    const longest = <T extends string>(values: readonly T[]): T =>
      values.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));

    const UUID = '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01';
    const DATETIME = '2026-10-07T10:00:00.123456789+14:00';
    // users.telegram_user_id is bigint
    const TELEGRAM_ID = '9223372036854775807';
    // numeric(20,8), the domain of every money column
    const DECIMAL = '-999999999999.99999999';
    const AMOUNT = '999999999999.99999999';
    const TOKENS = '9223372036854775807';
    const NUMBER = -2.2250738585072014e-308;
    const NONNEGATIVE_NUMBER = 1.7976931348623157e308;
    const INT = -Number.MAX_SAFE_INTEGER;
    const NONNEGATIVE_INT = Number.MAX_SAFE_INTEGER;
    const FREE = bytesLong(ASSUMED_LONGEST_FREE_STRING);
    const ADDRESS = bytesLong(ASSUMED_LONGEST_EMAIL);

    const BROKER_ACCOUNT = {
      id: UUID,
      brokerUserId: FREE,
      email: ADDRESS,
      isPartnerClient: false,
      status: longest(Object.values(BrokerAccountStatus)),
      createdAt: DATETIME,
    };
    const LOGIN = {
      account: BROKER_ACCOUNT,
      grant: { granted: false, reason: longest(Object.values(LinkBonusSkipReason)) },
    };
    const INTENT = {
      id: UUID,
      brokerAccountId: UUID,
      telegramUserId: TELEGRAM_ID,
      mode: longest(Object.values(TradeMode)),
      assetId: INT4_MAX,
      amount: AMOUNT,
      action: longest(Object.values(TradeAction)),
      durationSec: INT4_MAX,
      // the writer's max(128) characters (createTradeIntentRequestSchema)
      clientRequestId: controlChars(128),
      createdAt: DATETIME,
      status: longest(Object.values(TradeIntentStatus)),
      version: NONNEGATIVE_INT,
      tokensReserved: TOKENS,
      transport: longest(Object.values(TradeTransport)),
      submittedAt: DATETIME,
      lastError: longest(Object.values(TradeIntentFailureReason)),
      updatedAt: DATETIME,
    };
    const SESSION = {
      id: UUID,
      mode: longest(Object.values(TradeMode)),
      status: longest(Object.values(TradingSessionStatus)),
      stopReason: longest(Object.values(TradingSessionStopReason)),
      settings: {
        version: 1,
        assetId: INT4_MAX,
        durationSec: INT4_MAX,
        trades: MAX_SESSION_TRADES,
        stake: { baseStake: AMOUNT, stakeScale: 8 },
      },
      startedAt: DATETIME,
      endedAt: DATETIME,
      trades: {
        planned: NONNEGATIVE_INT,
        settled: NONNEGATIVE_INT,
        rejected: NONNEGATIVE_INT,
        won: NONNEGATIVE_INT,
        lost: NONNEGATIVE_INT,
        tied: NONNEGATIVE_INT,
        profit: DECIMAL,
      },
      lastIntent: INTENT,
      balance: { available: DECIMAL, ageSec: NONNEGATIVE_INT, current: false },
    };
    const PAIR = {
      id: INT,
      symbol: 's'.repeat(ASSUMED_LONGEST_PAIR_STRING),
      isOtc: false,
      type: 't'.repeat(ASSUMED_LONGEST_PAIR_STRING),
      digits: INT,
      payout: NUMBER,
      maxPayout: NUMBER,
      minTimeframe: INT,
      maxTimeframe: INT,
      scheduledUntil: NONNEGATIVE_NUMBER,
    };
    const FEATURES = {
      emaFast: NUMBER,
      emaSlow: NUMBER,
      emaSlowSlope: NUMBER,
      rsi: NUMBER,
      atr: NUMBER,
      atrPct: NUMBER,
      lastClose: NUMBER,
      lastCandleTimestamp: NUMBER,
      closedCandles: NONNEGATIVE_INT,
      trend: longest(Object.values(TrendDirection)),
      momentum: longest(Object.values(MomentumDirection)),
      atrTicks: NUMBER,
    };
    const BALANCE = { available: DECIMAL, held: DECIMAL, total: DECIMAL };
    const intentOf = (input: unknown) =>
      safeParseTradeIntentView((input as { intent?: unknown } | null)?.intent);

    type Row = {
      parse: (input: unknown) => { success: boolean };
      sample: unknown;
      limit?: number;
    };
    const rows: { [K in keyof BackendClient]: Row } = {
      recordStart: {
        parse: safeParseUserStartResponse,
        sample: {
          user: {
            telegramUserId: TELEGRAM_ID,
            status: longest(Object.values(UserStatus)),
            acquisitionSource: FREE,
            acquiredAt: DATETIME,
            hasActiveBrokerAccount: false,
            pendingBrokerAccounts: Array.from({ length: ASSUMED_LONGEST_LIST }, () => ({
              id: UUID,
              email: ADDRESS,
            })),
            notificationLevel: longest(Object.values(NotificationLevel)),
            demoStake: DECIMAL,
          },
        },
      },
      // an active user's: a code where a blocked one has null
      readReferral: {
        parse: (input) => userReferralResponseSchema.safeParse(input),
        sample: {
          user: {
            status: UserStatus.Active,
            code: 'A'.repeat(REFERRAL_CODE_LENGTH),
            invited: NONNEGATIVE_INT,
          },
        },
      },
      readAccount: {
        parse: safeParseUserAccountResponse,
        sample: {
          user: {
            status: longest(Object.values(UserStatus)),
            accounts: Array.from({ length: USER_ACCOUNT_LIST_LIMIT }, () => ({
              status: BrokerAccountStatus.Pending,
              id: UUID,
              email: ADDRESS,
            })),
          },
        },
      },
      confirmLogin: { parse: safeParseConfirmLoginResponse, sample: LOGIN },
      sendEmailCode: { parse: safeParseEmailSendCodeResponse, sample: { codeSent: true } },
      emailLogin: { parse: safeParseEmailLoginResponse, sample: LOGIN },
      recordChatMember: { parse: safeParseChatMemberResponse, sample: { recorded: false } },
      setNotificationLevel: {
        parse: safeParseNotificationLevelResponse,
        sample: { level: longest(Object.values(NotificationLevel)), demoStake: DECIMAL },
      },
      readTradingAccess: {
        parse: safeParseTradingAccessResponse,
        sample: {
          status: longest(Object.values(UserStatus)),
          tokens: {
            balance: TOKENS,
            reserved: '1000000000000000000',
            available: '8223372036854775807',
          },
          broker: {
            real: BALANCE,
            demo: BALANCE,
            minTradeAmount: DECIMAL,
            level: { code: FREE, rank: NONNEGATIVE_NUMBER },
            restSnapshotAgeSec: NONNEGATIVE_INT,
            balanceEventAgeSec: NONNEGATIVE_INT,
            fresh: false,
          },
          brokerUnavailable: null,
          tradingOpen: false,
          demoStake: DECIMAL,
          tradingMode: longest(Object.values(TradeMode)),
        },
      },
      readPairs: {
        parse: safeParsePairsCatalogResponse,
        sample: {
          pairs: Array.from({ length: ASSUMED_LONGEST_PAIRS }, () => PAIR),
          fetchedAt: NONNEGATIVE_INT,
          ageMs: NONNEGATIVE_INT,
          fresh: false,
        },
      },
      evaluateSignal: {
        parse: safeParseTradingSignalResponse,
        // a rule refusal: the reason and the features both
        sample: {
          outcome: SignalFeedOutcome.Decided,
          params: {
            emaFast: NONNEGATIVE_INT,
            emaSlow: NONNEGATIVE_INT,
            slopeLookback: NONNEGATIVE_INT,
            rsiPeriod: NONNEGATIVE_INT,
            rsiBand: NONNEGATIVE_NUMBER,
            atrPeriod: NONNEGATIVE_INT,
            minAtrPct: NONNEGATIVE_NUMBER,
            maxAtrPct: NONNEGATIVE_NUMBER,
            minClosedCandles: NONNEGATIVE_INT,
            maxStaleIntervals: NONNEGATIVE_INT,
            rsiExtremeBand: NONNEGATIVE_NUMBER,
            minAtrTicks: NONNEGATIVE_INT,
          },
          decision: {
            kind: SignalKind.NoSignal,
            version: SIGNAL_ALGORITHM_VERSION,
            reason: longest(RULE_REFUSAL_REASONS),
            features: FEATURES,
          },
        },
      },
      readSignals: {
        parse: safeParseTradingSignalsResponse,
        // one list per scanned interval
        sample: {
          asOf: NONNEGATIVE_INT,
          lists: SIGNAL_SCAN_INTERVALS.map((interval) => ({
            interval,
            scanned: NONNEGATIVE_INT,
            signals: Array.from({ length: ASSUMED_LONGEST_PAIRS }, () => ({
              assetId: INT4_MAX,
              action: longest(Object.values(TradeAction)),
              lastCandleTimestamp: NUMBER,
              decidedAt: NONNEGATIVE_INT,
              ageMs: NONNEGATIVE_INT,
            })),
          })),
        },
      },
      createIntent: { parse: intentOf, sample: { intent: INTENT } },
      readIntent: { parse: intentOf, sample: { intent: INTENT } },
      // the 409 active_session_exists body: the 2xx's session plus the error code, so the larger
      startSession: {
        parse: safeParseTradingSessionRefusal,
        sample: { error: TradingSessionErrorCode.ActiveSessionExists, session: SESSION },
      },
      readSession: { parse: safeParseTradingSessionResponse, sample: { session: SESSION } },
      stopSession: { parse: safeParseTradingSessionResponse, sample: { session: SESSION } },
      stopSessions: {
        parse: safeParseTradingSessionsStoppedResponse,
        sample: { sessions: Array.from({ length: ASSUMED_USER_BROKER_ACCOUNTS }, () => SESSION) },
      },
      // the 2xx: the 409 summary_unavailable carries its code alone
      claimSessionSummary: {
        parse: safeParseSessionSummaryResponse,
        sample: {
          summary: {
            result: DECIMAL,
            trades: Array.from({ length: MAX_SESSION_TRADES }, () => ({
              profit: DECIMAL,
              openPrice: NUMBER,
              closePrice: NUMBER,
            })),
          },
        },
      },
      // the bounds 409: larger than the 2xx's lone stake
      setDemoStake: {
        parse: safeParseDemoStakeRefusal,
        sample: {
          error: longest(Object.values(DemoStakeRefusal)),
          limits: { minTradeAmount: DECIMAL, demoAvailable: DECIMAL, scale: NONNEGATIVE_INT },
        },
      },
      // the 2xx: every refusal carries its code alone
      setTradingMode: {
        parse: safeParseSetTradingModeResponse,
        sample: { tradingMode: longest(Object.values(TradeMode)), changed: false },
      },
      // Reds when the catalog grows to about 500 keys: then the ceiling is revisited, not the
      // assumption.
      readBotTexts: {
        parse: (input) => botTextOverridesResponseSchema.safeParse(input),
        sample: {
          overrides: Object.keys(BOT_TEXT_CATALOG).map((key) => ({
            key,
            source: bytesLong(ASSUMED_LONGEST_BOT_TEXT_BYTES),
            version: NONNEGATIVE_INT,
          })),
        },
        limit: MAX_BOT_TEXTS_BODY_BYTES,
      },
    };
    const methods = Object.keys(rows) as (keyof BackendClient)[];

    it('has a row for every client method', () => {
      const client = createBackendClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN });
      expect(Object.keys(rows).sort()).toEqual(Object.keys(client).sort());
    });

    it.each(methods)('%s: the sample passes the parser the method reads it with', (method) => {
      const row = rows[method];
      expect(row.parse(row.sample).success, method).toBe(true);
    });

    it.each(methods)(
      '%s: leaves the longest answer under the declared assumptions far below its ceiling',
      (method) => {
        const row = rows[method];
        expect(Buffer.byteLength(JSON.stringify(row.sample)), method).toBeLessThan(
          row.limit ?? MAX_BACKEND_BODY_BYTES / 4,
        );
      },
    );
  });
});
