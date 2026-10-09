import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OAuthErrorCode,
  PairsCatalogErrorCode,
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
