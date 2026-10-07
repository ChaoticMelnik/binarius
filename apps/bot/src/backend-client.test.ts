import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OAuthErrorCode,
  PairsCatalogErrorCode,
  TradeAction,
  TradeIntentErrorCode,
  TradeMode,
  UserErrorCode,
  type CreateTradeIntentRequest,
  type UserStartRequest,
} from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import { BackendError, BackendErrorCode, createBackendClient } from './backend-client';
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
  LOGIN,
  PAIRS_RESPONSE,
  PENDING_ACCOUNT_ID,
  SIGNAL_DECIDED,
  SIGNAL_DECISION,
  SIGNAL_FETCH_FAILED,
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

describe('startLogin', () => {
  it('sends the telegram id and returns the parsed response', async () => {
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, LOGIN);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).startLogin('4242')).toEqual(LOGIN);
    expect(capture.url).toBe('/auth/binodex/start');
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242' });
  });

  it('accepts a response without the Mini App url, for an http redirect', async () => {
    const { authorizeUrl, state, expiresAt } = LOGIN;
    const withoutMiniApp = { authorizeUrl, state, expiresAt };
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, withoutMiniApp);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).startLogin('4242')).toEqual(
      withoutMiniApp,
    );
  });

  it('carries the backend error code as the reason', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: OAuthErrorCode.UserBlocked });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).startLogin('4242'),
    );
    expect(error).toMatchObject({ status: 409, reason: OAuthErrorCode.UserBlocked });
  });

  it('refuses an error code that is not a bare code', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: 'Sorry Ada, your account 4242 is blocked' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).startLogin('4242'),
    );
    expect((error as BackendError).reason).toBeUndefined();
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
      json(reply, 200, { level: 'off' });
    });
    expect(
      await createBackendClient({ baseUrl, token: TOKEN }).setNotificationLevel('4242', 'off'),
    ).toEqual({ level: 'off' });
    expect(capture.url).toBe('/users/notification-level');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242', level: 'off' });
  });

  it('reports an unknown level in the answer as a contract violation', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 200, { level: 'daily' });
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
      { ...SIGNAL_DECIDED, decision: { ...SIGNAL_DECISION, version: 'v2' } },
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
