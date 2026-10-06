import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OAuthErrorCode, UserErrorCode, type UserStartRequest } from '@binarius/shared';
import { UNIT_WAIT_CEILING_MS } from '@binarius/shared/testing';
import { BackendError, BackendErrorCode, createBackendClient } from './backend-client';
import {
  CODE,
  CODE_SENT,
  CONFIRMED,
  EMAIL,
  LINK_ACTIVE,
  LINK_PENDING,
  LINK_REVOKED,
  LOGIN,
  PENDING_ACCOUNT_ID,
  closeServer,
  listen,
  accountView,
  rejectionOf,
  userView,
} from './testing';

const TOKEN = 'internal-token-for-tests';

interface Capture {
  url?: string;
  authorization?: string;
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
      capture.url = request.url;
      capture.authorization = request.headers.authorization;
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
