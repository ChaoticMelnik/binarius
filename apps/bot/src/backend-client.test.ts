import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OAuthErrorCode, UserStatus, type UserStartRequest } from '@binarius/shared';
import { BackendError, BackendErrorCode, createBackendClient } from './backend-client';

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
  if (running !== undefined) await new Promise<void>((resolve) => running.close(() => resolve()));
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
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
  const { port } = started.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, capture };
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

const userView = {
  telegramUserId: '4242',
  status: UserStatus.Active,
  acquisitionSource: 'src_ab-CD9',
  acquiredAt: '2026-09-24T10:00:00.000Z',
  hasActiveBrokerAccount: false,
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('recordStart', () => {
  it('posts the request under the internal bearer and returns the view', async () => {
    const { baseUrl, capture } = await serve((_request, response) => {
      json(response, 200, { user: userView });
    });
    const client = createBackendClient({ baseUrl, token: TOKEN });

    expect(await client.recordStart(request)).toEqual(userView);
    expect(capture.url).toBe('/users/start');
    expect(capture.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(capture.body ?? '')).toEqual(request);
  });

  it('keeps a path prefix on the base URL', async () => {
    const { baseUrl, capture } = await serve((_request, response) => {
      json(response, 200, { user: userView });
    });
    await createBackendClient({ baseUrl: `${baseUrl}/api`, token: TOKEN }).recordStart(request);
    expect(capture.url).toBe('/api/users/start');
  });

  it('reports a body that does not match the contract', async () => {
    const { baseUrl } = await serve((_request, response) => {
      json(response, 200, { user: { telegramUserId: '4242' } });
    });
    const error = await rejection(
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
    const error = await rejection(
      createBackendClient({ baseUrl, token: TOKEN }).recordStart(request),
    );
    expect((error as BackendError).code).toBe(BackendErrorCode.ContractViolation);
  });

  it.each([401, 500])('reports HTTP %s with the status', async (status) => {
    const { baseUrl } = await serve((_request, response) => {
      json(response, status, { error: 'internal' });
    });
    const error = await rejection(
      createBackendClient({ baseUrl, token: TOKEN }).recordStart(request),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status, reason: 'internal' });
  });

  it('gives up on a server that never answers', async () => {
    const { baseUrl } = await serve(() => {});
    const started = Date.now();
    const error = await rejection(
      createBackendClient({ baseUrl, token: TOKEN, timeoutMs: 150 }).recordStart(request),
    );
    expect((error as BackendError).code).toBe(BackendErrorCode.Unreachable);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reports a backend that is not listening', async () => {
    const { baseUrl } = await serve(() => {});
    const dead = baseUrl;
    const running = server;
    server = undefined;
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    const error = await rejection(
      createBackendClient({ baseUrl: dead, token: TOKEN }).recordStart(request),
    );
    expect((error as BackendError).code).toBe(BackendErrorCode.Unreachable);
  });
});

describe('startLogin', () => {
  it('sends the telegram id and returns the parsed response', async () => {
    const response = {
      authorizeUrl: 'https://binodex.app/oauth/authorize?state=abc',
      state: 'abc',
      expiresAt: '2026-09-24T10:10:00.000Z',
    };
    const { baseUrl, capture } = await serve((_request, reply) => {
      json(reply, 200, response);
    });
    expect(await createBackendClient({ baseUrl, token: TOKEN }).startLogin('4242')).toEqual(
      response,
    );
    expect(capture.url).toBe('/auth/binodex/start');
    expect(JSON.parse(capture.body ?? '')).toEqual({ telegramUserId: '4242' });
  });

  it('carries the backend error code as the reason', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: OAuthErrorCode.UserBlocked });
    });
    const error = await rejection(
      createBackendClient({ baseUrl, token: TOKEN }).startLogin('4242'),
    );
    expect(error).toMatchObject({ status: 409, reason: OAuthErrorCode.UserBlocked });
  });

  it('refuses an error code that is not a bare code', async () => {
    const { baseUrl } = await serve((_request, reply) => {
      json(reply, 409, { error: 'Sorry Ada, your account 4242 is blocked' });
    });
    const error = await rejection(
      createBackendClient({ baseUrl, token: TOKEN }).startLogin('4242'),
    );
    expect((error as BackendError).reason).toBeUndefined();
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
    const error = (await rejection(
      createBackendClient({ baseUrl, token: TOKEN }).recordStart(request),
    )) as BackendError;

    expect(error.message).not.toContain('SECRET-BODY');
    expect(JSON.stringify(error)).not.toContain('SECRET-BODY');
    expect(JSON.stringify({ ...error })).not.toContain('SECRET-BODY');
    expect(error.stack ?? '').not.toContain('SECRET-BODY');
  });
});
