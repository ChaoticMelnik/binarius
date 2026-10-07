import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_CALLBACK_BODY_LIMIT_BYTES, type OAuthCallbackRequest } from '@binarius/shared';
import { buildWebApp } from '../app';
import { BackendError, BackendErrorCode, type BackendClient } from '../backend-client';
import { OAUTH_CLIENT_JS } from './client';
import { TELEGRAM_SDK_URL } from './pages';
import { OAUTH_TEXTS } from './texts';

const ORIGIN = 'https://binarius.example';
const BROKER_AUTHORIZE_URL = 'https://binodex.app/oauth/authorize';
const STATE = 'S'.repeat(43);
const CODE = 'MARKER-CODE';
// `+` is a signed space and `%2B` a signed plus: the forward must carry both exactly as given
const INIT_DATA = 'query_id=AA%2BBB&user=%7B%22first_name%22%3A%22A+B%22%7D&auth_date=1&hash=ff';
const ACCOUNT = {
  id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
  brokerUserId: 'broker-1',
  email: null,
  isPartnerClient: true,
  status: 'pending' as const,
  createdAt: '2026-09-23T09:21:52.000Z',
};

let forwarded: OAuthCallbackRequest[];
let answer: () => Promise<{ account: typeof ACCOUNT }>;
let lines: string[];
let app: FastifyInstance;

beforeEach(() => {
  forwarded = [];
  lines = [];
  answer = () => Promise.resolve({ account: ACCOUNT });
  const unused = () => Promise.reject(new Error('unused'));
  const backend: BackendClient = {
    login: unused,
    confirm: unused,
    sessions: unused,
    revoke: unused,
    logout: unused,
    overview: unused,
    users: unused,
    user: unused,
    oauthCallback: (request) => {
      forwarded.push(request);
      return answer();
    },
  };
  app = buildWebApp({
    backend,
    publicOrigin: ORIGIN,
    brokerAuthorizeUrl: BROKER_AUTHORIZE_URL,
    secureCookies: true,
    logLevel: 'info',
    logDestination: { write: (line) => lines.push(line) },
  });
});
afterEach(() => app.close());

const authorizeUrl = (overrides: Record<string, string | null> = {}, base = BROKER_AUTHORIZE_URL) => {
  const url = new URL(base);
  const params: Record<string, string | null> = {
    client_id: 'client',
    redirect_uri: `${ORIGIN}/oauth/callback`,
    state: STATE,
    ref: 'partner',
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
};

const loginWith = (authorize: string) =>
  app.inject({
    method: 'GET',
    url: `/oauth/login?${new URLSearchParams({ authorize }).toString()}`,
  });

// null sends no Origin header at all
const postCallback = (payload: unknown, origin: string | null = ORIGIN) =>
  app.inject({
    method: 'POST',
    url: '/oauth/callback',
    headers: {
      'content-type': 'application/json',
      ...(origin === null ? {} : { origin }),
    },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

const BODY = { state: STATE, code: CODE, initData: INIT_DATA };

const logged = () => lines.join('\n');

describe('the Mini App pages headers', () => {
  it.each([
    ['the login page', () => loginWith(authorizeUrl())],
    ['the callback page', () => app.inject({ method: 'GET', url: `/oauth/callback?code=${CODE}&state=${STATE}` })],
    ['a refused login link', () => loginWith('nope')],
  ])('%s may be framed by Telegram Web and by nothing else', async (_label, request) => {
    const response = await request();
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self'; form-action 'none'; frame-ancestors https://web.telegram.org; base-uri 'none'",
    );
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  // the admin pages keep their exact policy: the Mini App's is per route, not a loosening
  it('leaves the admin pages unframeable', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  // the policy above allows https://telegram.org as the only script origin besides this one
  it('loads the Telegram SDK from the script origin the policy allows', () => {
    expect(new URL(TELEGRAM_SDK_URL).origin).toBe('https://telegram.org');
  });
});

describe('GET /oauth/login', () => {
  it('renders the page that navigates to the broker URL it was given', async () => {
    const url = authorizeUrl();
    const response = await loginWith(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain(`href="${url.replaceAll('&', '&amp;')}"`);
    expect(response.body).toContain('data-page="login"');
    expect(response.body).toContain(`<script src="${TELEGRAM_SDK_URL}"></script>`);
    expect(response.body).toContain('<script src="/oauth/static/app.js" defer></script>');
  });

  // the backend sends the redirect spelled as registered with the broker, byte for byte
  it.each([
    ['an upper-case host', 'https://Binarius.Example/oauth/callback'],
    ['the default port', 'https://binarius.example:443/oauth/callback'],
  ])('accepts a redirect with %s', async (_label, redirect) => {
    const url = authorizeUrl({ redirect_uri: redirect });
    const response = await loginWith(url);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`href="${new URL(url).href.replaceAll('&', '&amp;')}"`);
  });

  it.each([
    ['no parameter', null, 'missing'],
    ['an overlong value', `${authorizeUrl()}&x=${'a'.repeat(2048)}`, 'too_long'],
    ['not a URL', 'not a url', 'not_url'],
    ['http', authorizeUrl({}, 'http://binodex.app/oauth/authorize'), 'protocol'],
    ['another host', authorizeUrl({}, 'https://evil.example/oauth/authorize'), 'target'],
    ['another path on the broker', authorizeUrl({}, 'https://binodex.app/logout'), 'target'],
    ['no state', authorizeUrl({ state: null }), 'state'],
    ['a state of 257 chars', authorizeUrl({ state: 'a'.repeat(257) }), 'state'],
    ['a redirect to another origin', authorizeUrl({ redirect_uri: 'https://evil.example/oauth/callback' }), 'redirect_uri'],
    ['a redirect to another path', authorizeUrl({ redirect_uri: `${ORIGIN}/admin/login` }), 'redirect_uri'],
    ['no redirect', authorizeUrl({ redirect_uri: null }), 'redirect_uri'],
    ['an unparsable redirect', authorizeUrl({ redirect_uri: 'not-a-url' }), 'redirect_uri'],
    ['a redirect with a query', authorizeUrl({ redirect_uri: `${ORIGIN}/oauth/callback?x=1` }), 'redirect_uri'],
    ['a redirect with a fragment', authorizeUrl({ redirect_uri: `${ORIGIN}/oauth/callback#f` }), 'redirect_uri'],
    ['a redirect with a trailing slash', authorizeUrl({ redirect_uri: `${ORIGIN}/oauth/callback/` }), 'redirect_uri'],
    ['a redirect with credentials', authorizeUrl({ redirect_uri: 'https://u:p@binarius.example/oauth/callback' }), 'redirect_uri'],
    ['a percent-encoded redirect path', authorizeUrl({ redirect_uri: `${ORIGIN}/oauth/%63allback` }), 'redirect_uri'],
  ])('refuses %s, logging the reason and never the value', async (_label, authorize, reason) => {
    const response =
      authorize === null
        ? await app.inject({ method: 'GET', url: '/oauth/login' })
        : await loginWith(authorize);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(OAUTH_TEXTS.refusedLogin);
    expect(response.body).not.toContain('<script');
    const line = lines.find((entry) => entry.includes('a Mini App login link was refused'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ reason });
    expect(logged()).not.toContain(STATE);
    expect(logged()).not.toContain('evil.example');
  });
});

describe('GET /oauth/callback', () => {
  it('renders the callback page without echoing the code or the state', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/oauth/callback?code=${CODE}&state=${STATE}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-page="callback"');
    expect(response.body).not.toContain(CODE);
    expect(response.body).not.toContain(STATE);
    for (const text of [OAUTH_TEXTS.linked, OAUTH_TEXTS.startOver, OAUTH_TEXTS.unknown]) {
      expect(response.body).toContain(text);
    }
  });

  it.each([
    ['a cancelled login', '?error=access_denied&state=x'],
    ['no state', `?code=${CODE}`],
    ['no code', `?state=${STATE}`],
    ['a state over the bound', `?code=${CODE}&state=${'a'.repeat(257)}`],
    ['a code over the bound', `?code=${'c'.repeat(513)}&state=${STATE}`],
  ])('answers %s with the start-over notice', async (_label, query) => {
    const response = await app.inject({ method: 'GET', url: `/oauth/callback${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(OAUTH_TEXTS.refusedCallback);
    expect(response.body).not.toContain('<script');
  });
});

describe('POST /oauth/callback', () => {
  it('forwards the body unchanged and answers linked', async () => {
    const response = await postCallback(BODY);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'linked' });
    expect(forwarded).toEqual([BODY]);
    expect(forwarded[0]?.initData).toBe(INIT_DATA);
  });

  it.each([
    ['no Origin', null],
    ['another origin', 'https://evil.example'],
  ])('refuses %s without calling the backend', async (_label, origin) => {
    const response = await postCallback(BODY, origin);
    expect(response.statusCode).toBe(403);
    expect(forwarded).toEqual([]);
  });

  it.each([
    ['no initData', { state: STATE, code: CODE }],
    ['an empty initData', { ...BODY, initData: '' }],
    ['a state over the bound', { ...BODY, state: 'a'.repeat(257) }],
  ])('refuses %s as validation without calling the backend', async (_label, body) => {
    const response = await postCallback(body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation' });
    expect(forwarded).toEqual([]);
  });

  it('refuses a body over the shared limit before parsing it', async () => {
    const response = await postCallback({
      ...BODY,
      initData: 'i'.repeat(OAUTH_CALLBACK_BODY_LIMIT_BYTES),
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(forwarded).toEqual([]);
  });

  it.each([
    [401, 'invalid_telegram_auth', 'open_from_telegram'],
    [429, 'too_many_requests', 'busy'],
    [400, 'invalid_state', 'start_over'],
    [403, 'telegram_user_mismatch', 'start_over'],
    [400, 'invalid_code', 'start_over'],
    [502, 'broker_unavailable', 'start_over'],
    [502, 'broker_contract_violation', 'start_over'],
    [409, 'user_blocked', 'blocked'],
    [409, 'broker_account_taken', 'taken'],
  ])('turns %i %s into %s', async (status, reason, outcome) => {
    answer = () =>
      Promise.reject(new BackendError(BackendErrorCode.HttpStatus, { status, reason }));
    const response = await postCallback(BODY);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome });
    expect(logged()).not.toContain('"level":50');
  });

  // our own body refused by the backend is drift between the processes, not the user
  it('logs a backend validation refusal as an error and tells the user to start over', async () => {
    answer = () =>
      Promise.reject(
        new BackendError(BackendErrorCode.HttpStatus, { status: 400, reason: 'validation' }),
      );
    const response = await postCallback(BODY);
    expect(response.json()).toEqual({ outcome: 'start_over' });
    const line = lines.find((entry) => entry.includes('refused the forwarded callback'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ level: 50, status: 400, reason: 'validation' });
  });

  it.each([
    ['an unreachable backend', new BackendError(BackendErrorCode.Unreachable, { cause: new Error(INIT_DATA) })],
    ['a 2xx outside the contract', new BackendError(BackendErrorCode.ContractViolation)],
    ['a 500', new BackendError(BackendErrorCode.HttpStatus, { status: 500 })],
    ['a listed code on another status', new BackendError(BackendErrorCode.HttpStatus, { status: 500, reason: 'invalid_state' })],
    ['an unlisted code', new BackendError(BackendErrorCode.HttpStatus, { status: 409, reason: 'account_not_pending' })],
    ['an error that is not the client\'s', new Error(`boom ${CODE}`)],
  ])('answers %s with 500 unknown and one error line naming it', async (_label, error) => {
    answer = () => Promise.reject(error);
    const response = await postCallback(BODY);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ outcome: 'unknown' });
    const line = lines.find((entry) => entry.includes('the callback could not be forwarded'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ level: 50, err: { name: error.name } });
    for (const secret of [CODE, STATE, INIT_DATA, 'auth_date']) {
      expect(logged()).not.toContain(secret);
    }
  });
});

describe('GET /oauth/static/app.js', () => {
  it('serves the page script as cacheable javascript', async () => {
    const response = await app.inject({ method: 'GET', url: '/oauth/static/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.body).toBe(OAUTH_CLIENT_JS);
  });
});
