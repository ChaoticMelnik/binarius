import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SAMPLE_INTENT,
  SAMPLE_INTENT_RESPONSE,
  SAMPLE_INTENTS,
  SAMPLE_ME,
  SAMPLE_OVERVIEW,
  SAMPLE_SESSION_ID,
  SAMPLE_USER,
  SAMPLE_USER_ID,
} from './admin/testing';
import { BackendError, BackendErrorCode, createBackendClient } from './backend-client';

const TOKEN = 'admin-web-token-for-tests';
// `+` is a signed space and `%2B` a signed plus: the forward must carry both exactly as given
const INIT_DATA = 'query_id=AA%2BBB&user=%7B%22first_name%22%3A%22A+B%22%7D&auth_date=1&hash=ff';
const CALLBACK = { state: 's'.repeat(43), code: 'c'.repeat(32), initData: INIT_DATA };
const ACCOUNT = {
  id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
  brokerUserId: 'broker-1',
  email: null,
  isPartnerClient: true,
  status: 'pending',
  createdAt: '2026-09-23T09:21:52.000Z',
};

interface Captured {
  url?: string;
  headers?: IncomingMessage['headers'];
  body?: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(
  handle: (response: ServerResponse) => void,
): Promise<{ baseUrl: string; captured: Captured }> {
  const captured: Captured = {};
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      captured.url = request.url;
      captured.headers = request.headers;
      captured.body = body;
      handle(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, captured };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

describe('oauthCallback', () => {
  it('posts the body unchanged to the public callback, without the admin bearer', async () => {
    const { baseUrl, captured } = await serve((response) => {
      json(response, 200, { account: ACCOUNT });
    });
    const answer = await createBackendClient({ baseUrl, token: TOKEN }).oauthCallback(CALLBACK);

    expect(answer).toEqual({ account: ACCOUNT });
    expect(captured.url).toBe('/auth/binodex/callback');
    expect(captured.headers?.authorization).toBeUndefined();
    expect(captured.body).toBe(JSON.stringify(CALLBACK));
    expect((JSON.parse(captured.body ?? '') as { initData: string }).initData).toBe(INIT_DATA);
  });

  it('carries the backend error code and status of a refusal', async () => {
    const { baseUrl } = await serve((response) => {
      json(response, 403, { error: 'telegram_user_mismatch' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).oauthCallback(CALLBACK),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 403,
      reason: 'telegram_user_mismatch',
    });
  });

  it('refuses a 2xx body outside the contract', async () => {
    const { baseUrl } = await serve((response) => {
      json(response, 200, { account: { ...ACCOUNT, id: 'not-a-uuid' } });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).oauthCallback(CALLBACK),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  // its own timeout, not the admin calls' one: the callback is sized against another budget
  it('gives up on a backend that never answers after the callback timeout', async () => {
    const { baseUrl } = await serve(() => {});
    const client = createBackendClient({
      baseUrl,
      token: TOKEN,
      timeoutMs: 60_000,
      oauthCallbackTimeoutMs: 50,
    });
    const error = await rejectionOf(client.oauthCallback(CALLBACK));
    expect(error).toMatchObject({ code: BackendErrorCode.Unreachable });
  });
});

describe('the admin calls', () => {
  it('still carry the bearer', async () => {
    const { baseUrl, captured } = await serve((response) => {
      json(response, 200, { loggedOut: true });
    });
    await createBackendClient({ baseUrl, token: TOKEN }).logout('t'.repeat(43));
    expect(captured.url).toBe('/admin/auth/logout');
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('the read calls (#107)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';

  // a base URL with a path prefix: every path the client sends must stay relative to it
  const prefixed = async (body: unknown, status = 200) => {
    const served = await serve((response) => {
      json(response, status, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the list with the query percent-encoded, under the prefix', async () => {
    const { client, captured } = await prefixed({ me: SAMPLE_ME, users: [], nextCursor: null });
    await client.users(SESSION, { q: 'a&b+c#д', cursor: CURSOR });
    expect(captured.url).toBe(`/api/admin/users?q=a%26b%2Bc%23%D0%B4&cursor=${CURSOR}`);
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
  });

  it('sends no query string for an empty query', async () => {
    const { client, captured } = await prefixed({ me: SAMPLE_ME, users: [], nextCursor: null });
    await client.users(SESSION, {});
    expect(captured.url).toBe('/api/admin/users');
  });

  it('asks for the card and the overview under the prefix', async () => {
    const card = await prefixed(SAMPLE_USER);
    expect(await card.client.user(SESSION, SAMPLE_USER_ID)).toEqual(SAMPLE_USER);
    expect(card.captured.url).toBe(`/api/admin/users/${SAMPLE_USER_ID}`);

    const overview = await prefixed(SAMPLE_OVERVIEW);
    expect(await overview.client.overview(SESSION)).toEqual(SAMPLE_OVERVIEW);
    expect(overview.captured.url).toBe('/api/admin/overview');
  });

  it('carries a missing card as the backend answered it', async () => {
    const { client } = await prefixed({ error: 'not_found' }, 404);
    const error = await rejectionOf(client.user(SESSION, SAMPLE_USER_ID));
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: 'not_found',
    });
  });

  // the views are strict: a column the backend started sending is not silently dropped
  it('refuses a card with a key the contract does not name', async () => {
    const leaked = {
      ...SAMPLE_USER,
      brokerAccounts: [{ ...SAMPLE_USER.brokerAccounts[0], accessTokenEnc: 'x' }],
    };
    const { client } = await prefixed(leaked);
    const error = await rejectionOf(client.user(SESSION, SAMPLE_USER_ID));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the intents calls (#108)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';

  const prefixed = async (body: unknown, status = 200) => {
    const served = await serve((response) => {
      json(response, status, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the list with only the filters given, in the schema order, under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_INTENTS);
    expect(
      await client.intents(SESSION, {
        cursor: CURSOR,
        session: SAMPLE_SESSION_ID,
        status: 'active',
      }),
    ).toEqual(SAMPLE_INTENTS);
    expect(captured.url).toBe(
      `/api/admin/intents?status=active&session=${SAMPLE_SESSION_ID}&cursor=${CURSOR}`,
    );
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
  });

  it('sends no query string for no filters', async () => {
    const { client, captured } = await prefixed(SAMPLE_INTENTS);
    await client.intents(SESSION, {});
    expect(captured.url).toBe('/api/admin/intents');
  });

  it('asks for the card under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_INTENT_RESPONSE);
    expect(await client.intent(SESSION, SAMPLE_INTENT.id)).toEqual(SAMPLE_INTENT_RESPONSE);
    expect(captured.url).toBe(`/api/admin/intents/${SAMPLE_INTENT.id}`);
  });

  it('carries a missing card as the backend answered it', async () => {
    const { client } = await prefixed({ error: 'not_found' }, 404);
    const error = await rejectionOf(client.intent(SESSION, SAMPLE_INTENT.id));
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: 'not_found',
    });
  });

  it.each([
    ['a list row', { ...SAMPLE_INTENTS, intents: [{ ...SAMPLE_INTENT, accessTokenEnc: 'x' }] }],
    ['the list', { ...SAMPLE_INTENTS, extra: 1 }],
  ])('refuses %s with a key the contract does not name', async (_label, body) => {
    const { client } = await prefixed(body);
    const error = await rejectionOf(client.intents(SESSION, {}));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('refuses a card with a key the contract does not name', async () => {
    const { client } = await prefixed({
      ...SAMPLE_INTENT_RESPONSE,
      intent: { ...SAMPLE_INTENT, settings: {} },
    });
    const error = await rejectionOf(client.intent(SESSION, SAMPLE_INTENT.id));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});
