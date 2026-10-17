import {
  BrokerSocketEvent,
  safeParseBrokerEmailSendCodeResponse,
  safeParseBrokerError,
  safeParseOAuthTokenResponse,
  safeParseRefreshTokenResponse,
} from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import { io } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import { MOCK_OAUTH_DEFAULTS, type MockOAuthOptions } from './oauth';
import { startMockBroker, type MockBroker } from './server';
import { MOCK_EMAIL_USER_ID_FROM } from './state';

const EMAIL = 'ada@example.test';
const KNOWN_ID = 7001;
const REDIRECT = 'https://binarius.example/auth/callback';
const credentials = {
  client_id: MOCK_OAUTH_DEFAULTS.clientId,
  client_secret: MOCK_OAUTH_DEFAULTS.clientSecret,
};

let broker: MockBroker;

async function start(oauth: Partial<MockOAuthOptions> = {}) {
  broker = await startMockBroker({ oauth });
  broker.users.register({ id: KNOWN_ID, email: EMAIL });
}

beforeEach(() => start());

afterEach(async () => {
  await broker.close();
});

async function post(path: string, body: Record<string, unknown>, form = false) {
  const response = await fetch(`${broker.url}/v1/broker/${path}`, {
    method: 'POST',
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
    },
    body: form
      ? new URLSearchParams(body as Record<string, string>).toString()
      : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

const sendCode = (email = EMAIL, extra: Record<string, unknown> = {}) =>
  post('user-auth/email/send-code', { ...credentials, email, ...extra });
const emailLogin = (code: string, email = EMAIL, extra: Record<string, unknown> = {}) =>
  post('user-auth/email/login', { ...credentials, email, code, partner_code: 'ref', ...extra });
const refresh = (refreshToken: string) =>
  post('user-auth/refresh', { refresh_token: refreshToken });
const exchange = (code: string, extra: Record<string, string> = {}) =>
  post(
    'oauth/token',
    { ...credentials, grant_type: 'authorization_code', code, redirect_uri: REDIRECT, ...extra },
    true,
  );

async function getUser(token: string) {
  const response = await fetch(`${broker.url}/v1/broker/user`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as { id?: number } };
}

function expectRefusal(answer: { status: number; body: unknown }, status: number, message: string) {
  expect(answer.status).toBe(status);
  const parsed = safeParseBrokerError(answer.body);
  expect(parsed.success && parsed.data.error.message).toBe(message);
}

async function login(email = EMAIL) {
  expect((await sendCode(email)).status).toBe(200);
  const code = broker.oauth.codeFor(email);
  if (code === undefined) throw new Error('no code was sent');
  const answer = await emailLogin(code, email);
  expect(answer.status).toBe(200);
  const parsed = safeParseOAuthTokenResponse(answer.body);
  if (!parsed.success) throw new Error('the login answer breaks the contract');
  return parsed.data;
}

describe('the email login', () => {
  it('O1 signs a known address in; REST and the socket take the access token', async () => {
    const sent = await sendCode();
    expect(sent.status).toBe(200);
    expect(safeParseBrokerEmailSendCodeResponse(sent.body).success).toBe(true);
    const pair = await login();
    expect(pair.user).toEqual({ id: KNOWN_ID, email: EMAIL, is_partner_client: true });
    expect(pair.expires_in).toBe(MOCK_OAUTH_DEFAULTS.expiresInSec);
    expect(pair.token_type).toBe('Bearer');
    expect(await getUser(pair.access_token)).toMatchObject({ status: 200, body: { id: KNOWN_ID } });

    const socket = io(broker.url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    try {
      const outcome = new Promise<string>((resolve) => {
        socket.once(BrokerSocketEvent.UserAuthSuccess, () => resolve('success'));
        socket.once(BrokerSocketEvent.UserAuthError, () => resolve('error'));
      });
      socket.emit(BrokerSocketEvent.UserAuth, { id: KNOWN_ID, token: pair.access_token });
      expect(await outcome).toBe('success');
    } finally {
      socket.disconnect();
    }
  });

  it('O2 signs an unknown address up as a partner client with the defaults', async () => {
    const pair = await login('New@Example.test');
    const id = MOCK_EMAIL_USER_ID_FROM + 1;
    expect(pair.user).toEqual({ id, email: 'new@example.test', is_partner_client: true });
    const user = await getUser(pair.access_token);
    expect(user.status).toBe(200);
    expect(user.body).toMatchObject({ id, demo: { available: 10000 } });
  });

  it('O3 refuses a wrong code, a used code and an expired one', async () => {
    await sendCode();
    const code = broker.oauth.codeFor(EMAIL) ?? '';
    expectRefusal(await emailLogin('999999'), 400, LIVE_MESSAGES.invalidEmailCode);
    expectRefusal(await emailLogin(code, 'bob@example.test'), 400, LIVE_MESSAGES.invalidEmailCode);
    expect((await emailLogin(code)).status).toBe(200);
    expectRefusal(await emailLogin(code), 400, LIVE_MESSAGES.invalidEmailCode);

    await broker.close();
    await start({ codeTtlMs: 1 });
    await sendCode();
    const sentBy = Date.now();
    const short = broker.oauth.codeFor(EMAIL) ?? '';
    // the code lives 1 ms past its send, and the send was answered by sentBy
    await until('the code is past its TTL', () => Date.now() > sentBy + 1);
    expectRefusal(await emailLogin(short), 400, LIVE_MESSAGES.invalidEmailCode);
  });

  it('O4 refuses wrong client credentials on every route that takes them', async () => {
    const wrong = { client_secret: 'nope' };
    expectRefusal(await sendCode(EMAIL, wrong), 401, LIVE_MESSAGES.invalidClientCredentials);
    await sendCode();
    const code = broker.oauth.codeFor(EMAIL) ?? '';
    expectRefusal(
      await emailLogin(code, EMAIL, wrong),
      401,
      LIVE_MESSAGES.invalidClientCredentials,
    );
    const authorization = broker.oauth.issueCode({ userId: KNOWN_ID, redirectUri: REDIRECT });
    expectRefusal(
      await exchange(authorization, wrong),
      401,
      LIVE_MESSAGES.invalidClientCredentials,
    );
    // neither refusal consumed anything
    expect((await emailLogin(code)).status).toBe(200);
    expect((await exchange(authorization)).status).toBe(200);
  });

  it('O5 refuses a foreign partner code before the code, which stays usable', async () => {
    await broker.close();
    await start({ partnerCode: 'ours' });
    await sendCode();
    const code = broker.oauth.codeFor(EMAIL) ?? '';
    expectRefusal(
      await emailLogin(code, EMAIL, { partner_code: 'theirs' }),
      400,
      FIXTURE_MESSAGES.partnerCodeForeign,
    );
    expect((await emailLogin(code, EMAIL, { partner_code: 'ours' })).status).toBe(200);
  });

  it('refuses an address it does not take and a login without a code', async () => {
    expectRefusal(await sendCode('not-an-address'), 400, LIVE_MESSAGES.emailRequired);
    expectRefusal(
      await post('user-auth/email/login', { ...credentials, email: EMAIL }),
      400,
      LIVE_MESSAGES.codeRequired,
    );
  });
});

describe('the refresh', () => {
  it('O6 rotates the pair; a replay kills the family, earlier access tokens stay valid', async () => {
    const first = await login();
    const rotated = await refresh(first.refresh_token);
    expect(rotated.status).toBe(200);
    const parsed = safeParseRefreshTokenResponse(rotated.body);
    if (!parsed.success) throw new Error('the refresh answer breaks the contract');
    expect(rotated.body).not.toHaveProperty('user');
    expect((await getUser(parsed.data.access_token)).status).toBe(200);
    expect((await getUser(first.access_token)).status).toBe(200);

    expectRefusal(await refresh(first.refresh_token), 401, LIVE_MESSAGES.refreshInvalidToken);
    expectRefusal(await refresh(parsed.data.refresh_token), 401, LIVE_MESSAGES.refreshInvalidToken);
    expectRefusal(await refresh('unknown'), 401, LIVE_MESSAGES.refreshInvalidToken);
    expectRefusal(await post('user-auth/refresh', {}), 400, LIVE_MESSAGES.refreshTokenRequired);
  });
});

describe('oauth/token', () => {
  it('O7 exchanges a code once, for its redirect_uri only, and has no refresh grant', async () => {
    const code = broker.oauth.issueCode({ userId: KNOWN_ID, redirectUri: REDIRECT });
    expectRefusal(
      await exchange(code, { redirect_uri: 'https://elsewhere.example/cb' }),
      400,
      LIVE_MESSAGES.invalidAuthorizationCode,
    );
    const answer = await exchange(code);
    expect(answer.status).toBe(200);
    const parsed = safeParseOAuthTokenResponse(answer.body);
    expect(parsed.success && parsed.data.user).toEqual({
      id: KNOWN_ID,
      email: EMAIL,
      is_partner_client: true,
    });
    expectRefusal(await exchange(code), 400, LIVE_MESSAGES.invalidAuthorizationCode);
    expectRefusal(
      await exchange(code, { grant_type: 'refresh_token' }),
      400,
      LIVE_MESSAGES.codeRequired,
    );
    expect(() => broker.oauth.issueCode({ userId: 99, redirectUri: REDIRECT })).toThrow(
      /unknown mock user/,
    );
  });
});

describe('the journal and the scripts', () => {
  it('O8 journals the four routes by body keys, with no code and no token', async () => {
    const pair = await login();
    await refresh(pair.refresh_token);
    const authorization = broker.oauth.issueCode({ userId: KNOWN_ID, redirectUri: REDIRECT });
    await exchange(authorization);
    const code = broker.oauth.codeFor(EMAIL) ?? '';
    expect(broker.rest.journal.map(({ endpoint, bodyKeys }) => ({ endpoint, bodyKeys }))).toEqual([
      { endpoint: 'emailSendCode', bodyKeys: ['client_id', 'client_secret', 'email'] },
      {
        endpoint: 'emailLogin',
        bodyKeys: ['client_id', 'client_secret', 'code', 'email', 'partner_code'],
      },
      { endpoint: 'refresh', bodyKeys: ['refresh_token'] },
      {
        endpoint: 'oauthToken',
        bodyKeys: ['client_id', 'client_secret', 'code', 'grant_type', 'redirect_uri'],
      },
    ]);
    const journal = JSON.stringify(broker.rest.journal);
    for (const secret of [code, authorization, pair.access_token, pair.refresh_token]) {
      expect(journal).not.toContain(secret);
    }
  });

  it('O9 plays a script on the login before anything else', async () => {
    await sendCode();
    const code = broker.oauth.codeFor(EMAIL) ?? '';
    broker.rest.failNext('emailLogin', { status: 503 });
    expect((await emailLogin(code)).status).toBe(503);
    expect((await emailLogin(code)).status).toBe(200);
  });

  it('keeps a form body refused on the routes that take JSON', async () => {
    const response = await fetch(`${broker.url}/v1/broker/user-auth/email/send-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...credentials, email: EMAIL }).toString(),
    });
    expect(response.status).toBe(400);
  });
});
