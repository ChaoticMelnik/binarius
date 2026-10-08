import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_SEARCH_MAX_LENGTH,
  ADMIN_USER_RECENT_INTENTS,
  AdminErrorCode,
  adminLoginRequestSchema,
  CLIENT_USER_AGENT_MAX_LENGTH,
  TradeIntentStatus,
  UNNAMED_ERROR_MESSAGE,
  type AdminIntentsQuery,
  type AdminTradingSessionsQuery,
  type AdminUsersQuery,
  type StaffSessionView,
} from '@binarius/shared';
import { buildWebApp } from './app';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { SESSION_COOKIE, CHALLENGE_COOKIE } from './admin/routes';
import {
  SAMPLE_INTENT,
  SAMPLE_INTENT_RESPONSE,
  SAMPLE_INTENTS,
  SAMPLE_LIST_ITEM,
  SAMPLE_ME,
  SAMPLE_OVERVIEW,
  SAMPLE_SESSION_ID,
  SAMPLE_TRADING_SESSION,
  SAMPLE_TRADING_SESSION_NULLS,
  SAMPLE_TRADING_SESSIONS,
  SAMPLE_USER,
  SAMPLE_USER_ID,
} from './admin/testing';
import { TEXTS } from './admin/texts';

const ORIGIN = 'http://127.0.0.1:3001';
// what light-my-request puts in the header when the case does not set one; asserted rather
// than ignored, because the point is that the header reaches the backend unchanged
const INJECTED_AGENT = 'lightMyRequest';
const TOKEN = 'a'.repeat(43);
const CHALLENGE_ID = '00000000-0000-4000-8000-00000000000a';
const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();

const VIEW: StaffSessionView = {
  id: '00000000-0000-4000-8000-00000000000b',
  login: 'ada',
  displayName: 'Ада',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  createdAt: '2026-09-29T08:00:00.000Z',
  lastSeenAt: '2026-09-29T08:30:00.000Z',
  expiresAt: '2026-09-30T08:00:00.000Z',
  current: true,
};

const httpFailure = (status: number, code?: string) =>
  new BackendError(BackendErrorCode.HttpStatus, {
    status,
    ...(code === undefined ? {} : { reason: code }),
  });

interface Calls {
  login: unknown[];
  confirm: unknown[];
  sessions: unknown[];
  revoke: unknown[][];
  logout: unknown[];
  overview: unknown[];
  users: [string, AdminUsersQuery][];
  user: unknown[][];
  intents: [string, AdminIntentsQuery][];
  intent: unknown[][];
  tradingSessions: [string, AdminTradingSessionsQuery][];
}

let calls: Calls;
let lines: string[];
let app: FastifyInstance;

const build = (backend: Partial<BackendClient> = {}, secureCookies = false): FastifyInstance => {
  calls = {
    login: [],
    confirm: [],
    sessions: [],
    revoke: [],
    logout: [],
    overview: [],
    users: [],
    user: [],
    intents: [],
    intent: [],
    tradingSessions: [],
  };
  lines = [];
  const client: BackendClient = {
    login: async (request) => {
      calls.login.push(request);
      return { challengeId: CHALLENGE_ID, expiresAt: IN_AN_HOUR() };
    },
    confirm: async (request) => {
      calls.confirm.push(request);
      return { sessionToken: TOKEN, expiresAt: IN_AN_HOUR() };
    },
    sessions: async (token) => {
      calls.sessions.push(token);
      return { me: { staffId: VIEW.id, login: 'ada', sessionId: VIEW.id }, sessions: [VIEW] };
    },
    revoke: async (token, id) => {
      calls.revoke.push([token, id]);
      return { revoked: true, current: false };
    },
    logout: async (token) => {
      calls.logout.push(token);
      return { loggedOut: true };
    },
    overview: async (token) => {
      calls.overview.push(token);
      return SAMPLE_OVERVIEW;
    },
    users: async (token, query) => {
      calls.users.push([token, query]);
      return { me: SAMPLE_ME, users: [SAMPLE_LIST_ITEM], nextCursor: null };
    },
    user: async (token, id) => {
      calls.user.push([token, id]);
      return SAMPLE_USER;
    },
    intents: async (token, query) => {
      calls.intents.push([token, query]);
      return SAMPLE_INTENTS;
    },
    intent: async (token, id) => {
      calls.intent.push([token, id]);
      return SAMPLE_INTENT_RESPONSE;
    },
    tradingSessions: async (token, query) => {
      calls.tradingSessions.push([token, query]);
      return SAMPLE_TRADING_SESSIONS;
    },
    oauthCallback: async () => {
      throw new Error('the admin pages never forward an OAuth callback');
    },
    ...backend,
  };
  return buildWebApp({
    backend: client,
    publicOrigin: ORIGIN,
    brokerAuthorizeUrl: 'https://binodex.app/oauth/authorize',
    secureCookies,
    logLevel: 'info',
    logDestination: { write: (line) => lines.push(line) },
  });
};

beforeEach(() => {
  app = build();
});
afterEach(() => app.close());

const post = (url: string, payload: Record<string, string> = {}, cookies?: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
    ...(cookies === undefined ? {} : { cookies }),
  });

const get = (url: string, cookies?: Record<string, string>) =>
  app.inject({ method: 'GET', url, ...(cookies === undefined ? {} : { cookies }) });

const cookieOf = (response: Awaited<ReturnType<typeof get>>, name: string) =>
  response.cookies.find((entry) => entry.name === name);

describe('the origin check', () => {
  // the browser sends no Origin on a plain navigation, so a GET cannot require one
  it('lets every GET through without one', async () => {
    expect((await get('/admin/login')).statusCode).toBe(200);
  });

  it.each([
    ['no Origin', undefined],
    ['another site', 'https://evil.example'],
    // a near miss: the same host on the wrong scheme is a different origin
    ['the wrong scheme', 'https://127.0.0.1:3001'],
  ])('refuses a POST with %s, without calling the backend', async (_label, origin) => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(origin === undefined ? {} : { origin }),
      },
      payload: 'login=ada&password=x',
    });

    expect(response.statusCode).toBe(403);
    expect(calls.login).toEqual([]);
  });
});

describe('the response headers', () => {
  it('serves pages as html and the stylesheet as css', async () => {
    expect((await get('/admin/login')).headers['content-type']).toBe('text/html; charset=utf-8');
    expect((await get('/admin/static/app.css')).headers['content-type']).toBe(
      'text/css; charset=utf-8',
    );
  });

  it.each([
    ['content-security-policy', "default-src 'none'"],
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'no-referrer'],
    ['cache-control', 'no-store'],
  ])('sets %s on a page', async (header, expected) => {
    expect(String((await get('/admin/login')).headers[header])).toContain(expected);
  });

  // the http half is the point: without the gate there would be nothing to express it with
  it('sends HSTS only when the pages are served over https', async () => {
    expect((await get('/admin/login')).headers['strict-transport-security']).toBeUndefined();
    await app.close();
    app = build({}, true);
    expect((await get('/admin/login')).headers['strict-transport-security']).toBe(
      'max-age=31536000',
    );
  });

  // the one exception: a stylesheet that is never personal may be cached
  it('lets the stylesheet be cached', async () => {
    expect((await get('/admin/static/app.css')).headers['cache-control']).toBe(
      'public, max-age=3600',
    );
  });
});

describe('POST /admin/login', () => {
  it('passes what the browser showed us and sets the challenge cookie', async () => {
    const response = await post('/admin/login', { login: 'ada', password: 'secret' });

    expect(calls.login).toEqual([
      { login: 'ada', password: 'secret', ip: expect.any(String), userAgent: INJECTED_AGENT },
    ]);
    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/login/confirm']);
    const cookie = cookieOf(response, CHALLENGE_COOKIE);
    expect(cookie).toMatchObject({ value: CHALLENGE_ID, path: '/admin/login', httpOnly: true });
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
  });

  it('truncates a user agent to the bound the backend’s schema enforces', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'a'.repeat(600),
      },
      payload: 'login=ada&password=x',
    });
    expect((calls.login[0] as { userAgent: string }).userAgent).toHaveLength(
      CLIENT_USER_AGENT_MAX_LENGTH,
    );
    // the forwarded value against the real schema, not against a number copied into this file
    expect(adminLoginRequestSchema.safeParse(calls.login[0]).success).toBe(true);
  });

  it.each([
    [401, AdminErrorCode.InvalidCredentials, TEXTS.invalidCredentials],
    [429, AdminErrorCode.TooManyAttempts, TEXTS.tooManyAttempts],
    [503, AdminErrorCode.TelegramUnavailable, TEXTS.telegramUnavailable],
  ])('shows the message for %i %s', async (status, code, message) => {
    await app.close();
    app = build({ login: () => Promise.reject(httpFailure(status, code)) });

    const response = await post('/admin/login', { login: 'ada', password: 'x' });

    expect(response.statusCode).toBe(status);
    expect(response.body).toContain(message);
    expect(cookieOf(response, CHALLENGE_COOKIE)).toBeUndefined();
  });

  // the whole reason the mapping is keyed on the pair: this 401 is our bearer, not a password
  it('treats a refused bearer as our own fault, not the staff member’s', async () => {
    await app.close();
    app = build({ login: () => Promise.reject(httpFailure(401, AdminErrorCode.Unauthorized)) });

    const response = await post('/admin/login', { login: 'ada', password: 'x' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain(TEXTS.errorTitle);
    expect(response.body).not.toContain(TEXTS.invalidCredentials);
  });

  it.each([
    ['an unreachable backend', new BackendError(BackendErrorCode.Unreachable)],
    ['a body that breaks the contract', new BackendError(BackendErrorCode.ContractViolation)],
    ['a validation refusal', httpFailure(400, AdminErrorCode.Validation)],
  ])('answers 500 for %s', async (_label, error) => {
    await app.close();
    app = build({ login: () => Promise.reject(error) });
    expect((await post('/admin/login', { login: 'ada', password: 'x' })).statusCode).toBe(500);
  });

  it('refuses a malformed form before calling the backend', async () => {
    const response = await post('/admin/login', { login: 'a b', password: 'x' });
    expect([response.statusCode, calls.login]).toEqual([400, []]);
  });
});

describe('the confirm step', () => {
  it('sends the code with the challenge from the cookie and opens the session', async () => {
    const response = await post(
      '/admin/login/confirm',
      { code: '123456' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );

    expect(calls.confirm).toEqual([
      {
        challengeId: CHALLENGE_ID,
        code: '123456',
        ip: expect.any(String),
        userAgent: INJECTED_AGENT,
      },
    ]);
    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/sessions']);
    expect(cookieOf(response, SESSION_COOKIE)).toMatchObject({
      value: TOKEN,
      path: '/admin',
      httpOnly: true,
    });
    // the challenge cookie is spent
    expect(cookieOf(response, CHALLENGE_COOKIE)?.value).toBe('');
  });

  // the only source of the cookie's lifetime is what the backend said about the session
  it('takes the cookie lifetime from the backend’s expiry', async () => {
    await app.close();
    app = build({
      confirm: () =>
        Promise.resolve({
          sessionToken: TOKEN,
          expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        }),
    });

    const response = await post(
      '/admin/login/confirm',
      { code: '123456' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );

    const maxAge = cookieOf(response, SESSION_COOKIE)?.maxAge ?? 0;
    expect(maxAge).toBeGreaterThan(7_100);
    expect(maxAge).toBeLessThanOrEqual(7_200);
  });

  it('marks the cookie Secure only when the pages are served over https', async () => {
    // the "only" half first: the documented local origin is http://127.0.0.1:3001, where a
    // browser drops a Secure cookie and the login silently never sticks
    const plain = await post(
      '/admin/login/confirm',
      { code: '123456' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );
    expect(cookieOf(plain, SESSION_COOKIE)?.secure).toBeFalsy();
    expect(cookieOf(plain, CHALLENGE_COOKIE)?.secure).toBeFalsy();

    await app.close();
    app = build({}, true);
    const secured = await post(
      '/admin/login/confirm',
      { code: '123456' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );
    expect(cookieOf(secured, SESSION_COOKIE)?.secure).toBe(true);
  });

  it('sends anyone with no challenge cookie back to the form', async () => {
    const response = await get('/admin/login/confirm');
    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
  });

  // Forwarded as-is, a value undici refuses turns every page into an opaque 500 that never
  // clears the cookie causing it — a loop the staff member cannot leave. A cookie of the wrong
  // shape is treated as no cookie, and dropped.
  it('treats a malformed challenge cookie as none, and clears it', async () => {
    const response = await get('/admin/login/confirm', { [CHALLENGE_COOKIE]: 'not a uuid\u0000' });

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(response, CHALLENGE_COOKIE)?.value).toBe('');
    expect(calls.confirm).toEqual([]);
  });

  it.each([
    [401, AdminErrorCode.InvalidCode, TEXTS.invalidCode],
    [409, AdminErrorCode.AwaitingTelegram, TEXTS.awaitingTelegram],
    [429, AdminErrorCode.TooManyAttempts, TEXTS.tooManyCodeAttempts],
  ])('shows the message for %i %s', async (status, code, message) => {
    await app.close();
    app = build({ confirm: () => Promise.reject(httpFailure(status, code)) });

    const response = await post(
      '/admin/login/confirm',
      { code: '123456' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );

    expect(response.statusCode).toBe(status);
    expect(response.body).toContain(message);
  });

  // this attempt is over; keeping the cookie would loop the staff member through a form that
  // can only fail
  it('drops the challenge cookie and says so when the attempt is gone', async () => {
    await app.close();
    app = build({
      confirm: () => Promise.reject(httpFailure(410, AdminErrorCode.ChallengeUnavailable)),
    });

    const response = await post(
      '/admin/login/confirm',
      { code: '123456' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );

    expect([response.statusCode, response.headers.location]).toEqual([
      303,
      '/admin/login?reason=expired',
    ]);
    expect(cookieOf(response, CHALLENGE_COOKIE)?.value).toBe('');
    expect((await get('/admin/login?reason=expired')).body).toContain(TEXTS.expiredChallenge);
  });

  it('refuses a code that is not six digits before calling the backend', async () => {
    const response = await post(
      '/admin/login/confirm',
      { code: '12345' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );
    expect([response.statusCode, calls.confirm]).toEqual([400, []]);
  });
});

describe('the sessions page', () => {
  it('renders the table and sends the cookie through', async () => {
    const response = await get('/admin/sessions', { [SESSION_COOKIE]: TOKEN });

    expect(response.statusCode).toBe(200);
    expect(calls.sessions).toEqual([TOKEN]);
    expect(response.body).toContain('203.0.113.7');
    expect(response.body).toContain(TEXTS.currentSession);
  });

  // the other half of the shape check: a session cookie undici would refuse never reaches the
  // backend, and the browser is told to drop it instead of retrying it on every page
  it('treats a malformed session cookie as none, and clears it', async () => {
    const response = await get('/admin/sessions', { [SESSION_COOKIE]: 'not-a-session-token' });

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
    expect(calls.sessions).toEqual([]);
  });

  // the cell a staff member does not control, filled by whoever logged in
  it('escapes a user agent that is markup', async () => {
    await app.close();
    app = build({
      sessions: () =>
        Promise.resolve({
          me: { staffId: VIEW.id, login: 'ada', sessionId: VIEW.id },
          sessions: [{ ...VIEW, userAgent: '<script>alert(1)</script>' }],
        }),
    });

    const response = await get('/admin/sessions', { [SESSION_COOKIE]: TOKEN });

    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.body).not.toContain('<script>alert(1)</script>');
  });

  it('sends anyone with no cookie to the form', async () => {
    const response = await get('/admin/sessions');
    expect([response.statusCode, response.headers.location, calls.sessions]).toEqual([
      302,
      '/admin/login',
      [],
    ]);
  });

  // a 401 is not one thing: session_invalid is the staff member's session ending, and
  // unauthorized is our own bearer being refused. Dropping their cookie over our
  // misconfiguration would log them out of a session that is still live.
  it('treats a refused bearer as our own fault, and leaves the cookie alone', async () => {
    await app.close();
    app = build({ sessions: () => Promise.reject(httpFailure(401, AdminErrorCode.Unauthorized)) });

    const response = await get('/admin/sessions', { [SESSION_COOKIE]: TOKEN });

    expect(response.statusCode).toBe(500);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });

  it('drops a session the backend no longer knows', async () => {
    await app.close();
    app = build({ sessions: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)) });

    const response = await get('/admin/sessions', { [SESSION_COOKIE]: TOKEN });

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
  });
});

describe('the read pages (#107)', () => {
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';
  const withCookie = { [SESSION_COOKIE]: TOKEN };

  // the href of the link whose text is `label`, as a browser would read it back
  const hrefOf = (body: string, label: string): string | undefined => {
    const match = new RegExp(`<a href="([^"]*)"\\s*>\\s*${label}\\s*</a`).exec(body);
    return match?.[1]?.replaceAll('&amp;', '&');
  };

  it.each([
    ['/admin/overview', 'overview'],
    ['/admin/users', 'users'],
    [`/admin/users/${SAMPLE_USER_ID}`, 'user'],
    ['/admin/sessions', 'sessions'],
  ])('%s carries the nav and the login from the answer', async (url) => {
    const response = await get(url, withCookie);

    expect(response.statusCode).toBe(200);
    for (const href of ['/admin/overview', '/admin/users', '/admin/sessions']) {
      expect(response.body).toContain(`<a href="${href}"`);
    }
    expect(response.body).toContain('<nav');
    expect(response.body).toContain('action="/admin/logout"');
    expect(response.body).toContain(`ada — ${TEXTS.logoutSubmit}`);
  });

  it.each(['/admin/overview', '/admin/users', `/admin/users/${SAMPLE_USER_ID}`])(
    '%s treats a malformed session cookie as none, before the backend is asked',
    async (url) => {
      const response = await get(url, { [SESSION_COOKIE]: 'not-a-session-token' });

      expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
      expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
      expect([calls.overview, calls.users, calls.user]).toEqual([[], [], []]);
    },
  );

  it('prints the active window the answer carries, with the proxy caption', async () => {
    await app.close();
    app = build({
      overview: () =>
        Promise.resolve({
          ...SAMPLE_OVERVIEW,
          overview: { ...SAMPLE_OVERVIEW.overview, activeWindowMinutes: 42 as 15 },
        }),
    });

    const response = await get('/admin/overview', withCookie);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(TEXTS.overviewActiveNowHint(42));
  });

  it('carries q and the cursor through the next link, encoded once', async () => {
    await app.close();
    app = build({
      users: (token, query) => {
        calls.users.push([token, query]);
        return Promise.resolve({ me: SAMPLE_ME, users: [SAMPLE_LIST_ITEM], nextCursor: CURSOR });
      },
    });

    const first = await get(`/admin/users?q=${encodeURIComponent('a&b+c#д')}`, withCookie);
    const next = hrefOf(first.body, TEXTS.usersNext);
    expect(next).toBe(`/admin/users?q=a%26b%2Bc%23%D0%B4&cursor=${CURSOR}`);
    await get(next ?? '', withCookie);

    expect(calls.users.map(([, query]) => query)).toEqual([
      { q: 'a&b+c#д' },
      { q: 'a&b+c#д', cursor: CURSOR },
    ]);
    expect(hrefOf((await get(next ?? '', withCookie)).body, TEXTS.usersFirst)).toBe(
      '/admin/users?q=a%26b%2Bc%23%D0%B4',
    );
  });

  it('shows no next link without a cursor', async () => {
    const response = await get('/admin/users', withCookie);
    expect(response.body).not.toContain(TEXTS.usersNext);
  });

  it('drops a malformed cursor and keeps the search', async () => {
    const response = await get('/admin/users?cursor=bad&q=a%26b', withCookie);

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/users?q=a%26b']);
    expect(calls.users).toEqual([]);
    await get(response.headers.location as string, withCookie);
    expect(calls.users).toEqual([[TOKEN, { q: 'a&b' }]]);
  });

  it('asks for the whole list when the search box was emptied', async () => {
    await get('/admin/users?q=', withCookie);
    expect(calls.users).toEqual([[TOKEN, {}]]);
  });

  it.each([
    [
      'q over the limit, even with a bad cursor',
      `cursor=bad&q=${'a'.repeat(ADMIN_SEARCH_MAX_LENGTH + 1)}`,
    ],
    ['a control character', 'q=a%07b'],
    ['q twice', 'q=a&q=b'],
  ])('refuses %s with the form, before the backend is asked', async (_label, query) => {
    const response = await get(`/admin/users?${query}`, withCookie);

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(calls.users).toEqual([]);
    expect(response.body).toContain(TEXTS.badSearch);
    expect(response.body).toContain('<form class="search"');
    // no answer from the backend, so no login to show: the account block is left out
    expect(response.body).toContain('<nav');
    expect(response.body).not.toContain('action="/admin/logout"');
  });

  it('escapes a display name that is markup, in the list and on the card', async () => {
    await app.close();
    const name = '<script>alert(1)</script>';
    app = build({
      users: () =>
        Promise.resolve({
          me: SAMPLE_ME,
          users: [{ ...SAMPLE_LIST_ITEM, displayName: name }],
          nextCursor: null,
        }),
      user: () =>
        Promise.resolve({ ...SAMPLE_USER, user: { ...SAMPLE_USER.user, displayName: name } }),
    });

    for (const url of ['/admin/users', `/admin/users/${SAMPLE_USER_ID}`]) {
      const body = (await get(url, withCookie)).body;
      expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(body).not.toContain(name);
    }
  });

  it('renders the card: tokens, the default stake and the account', async () => {
    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    expect(calls.user).toEqual([[TOKEN, SAMPLE_USER_ID]]);
    expect(response.body).toContain(TEXTS.demoStakeDefault);
    expect(response.body).toContain('broker-7');
    expect(response.body).toContain(`<dd>${SAMPLE_USER.user.tokens.available}</dd>`);
  });

  it('answers an id that is not a uuid with 404, before the backend is asked', async () => {
    const response = await get('/admin/users/not-a-uuid', withCookie);

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain(TEXTS.userNotFoundTitle);
    expect(calls.user).toEqual([]);
  });

  it('answers a user the backend did not find with 404', async () => {
    await app.close();
    app = build({ user: () => Promise.reject(httpFailure(404, AdminErrorCode.NotFound)) });

    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain(TEXTS.userNotFoundTitle);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });

  it('drops a session the backend no longer knows', async () => {
    await app.close();
    app = build({ users: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)) });

    const response = await get('/admin/users', withCookie);

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
  });

  it.each([
    ['an unreachable backend', new BackendError(BackendErrorCode.Unreachable)],
    ['a refused bearer', httpFailure(401, AdminErrorCode.Unauthorized)],
    ['a refused query', httpFailure(400, AdminErrorCode.Validation)],
  ])('treats %s as our own failure and keeps the cookie', async (_label, failure) => {
    await app.close();
    app = build({ user: () => Promise.reject(failure) });

    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    expect(response.statusCode).toBe(500);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });
});

describe('the intents pages (#108)', () => {
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';
  const USER = SAMPLE_USER_ID;
  const withCookie = { [SESSION_COOKIE]: TOKEN };

  // the href of the link whose text is `label`, as a browser would read it back
  const hrefOf = (body: string, label: string): string | undefined => {
    const match = new RegExp(`<a href="([^"]*)"\\s*>\\s*${label}\\s*</a`).exec(body);
    return match?.[1]?.replaceAll('&amp;', '&');
  };

  it.each(['/admin/intents', `/admin/intents/${SAMPLE_INTENT.id}`])(
    '%s marks Заявки as the current page and carries the login',
    async (url) => {
      const response = await get(url, withCookie);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatch(/<a href="\/admin\/intents"\s+aria-current="page"/);
      for (const href of ['/admin/overview', '/admin/users', '/admin/sessions']) {
        expect(response.body).toContain(`<a href="${href}"`);
      }
      expect(response.body).toContain(`ada — ${TEXTS.logoutSubmit}`);
    },
  );

  it('asks for the whole list when every field of the form was left empty', async () => {
    const response = await get('/admin/intents?status=&mode=&user=&session=', withCookie);

    expect(response.statusCode).toBe(200);
    expect(calls.intents).toEqual([[TOKEN, {}]]);
  });

  it('carries every filter and the cursor through the next link, and keeps them in the form', async () => {
    await app.close();
    app = build({
      intents: (token, query) => {
        calls.intents.push([token, query]);
        return Promise.resolve({ ...SAMPLE_INTENTS, nextCursor: CURSOR });
      },
    });
    const filters = { status: 'active', mode: 'real', user: USER, session: SAMPLE_SESSION_ID };

    const first = await get(`/admin/intents?${new URLSearchParams(filters)}`, withCookie);
    expect(first.body).toMatch(/<option value="active"\s+selected/);
    expect(first.body).toMatch(/<option value="real"\s+selected/);
    expect(first.body).toContain(`name="user" value="${USER}"`);
    expect(first.body).toContain(`name="session" value="${SAMPLE_SESSION_ID}"`);
    const next = hrefOf(first.body, TEXTS.intentsNext);
    expect(next).toBe(`/admin/intents?${new URLSearchParams({ ...filters, cursor: CURSOR })}`);
    const second = await get(next ?? '', withCookie);

    expect(calls.intents.map(([, query]) => query)).toEqual([
      filters,
      { ...filters, cursor: CURSOR },
    ]);
    expect(hrefOf(second.body, TEXTS.intentsFirst)).toBe(
      `/admin/intents?${new URLSearchParams(filters)}`,
    );
  });

  it('drops a malformed cursor and keeps the filters', async () => {
    const response = await get('/admin/intents?cursor=bad&status=queued', withCookie);

    expect([response.statusCode, response.headers.location]).toEqual([
      302,
      '/admin/intents?status=queued',
    ]);
    expect(calls.intents).toEqual([]);
  });

  it.each([
    ['an unknown status, even with a bad cursor', 'cursor=bad&status=bogus'],
    ['a user of blanks', 'user=%20'],
    ['a session of blanks', 'session=%20'],
    ['a user that is not a uuid', 'user=4242'],
    ['status twice', 'status=queued&status=settled'],
  ])('refuses %s with the form, before the backend is asked', async (_label, query) => {
    const response = await get(`/admin/intents?${query}`, withCookie);

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(calls.intents).toEqual([]);
    expect(response.body).toContain(TEXTS.badFilter);
    expect(response.body).toContain('action="/admin/intents"');
    // no answer from the backend, so no login to show: the account block is left out
    expect(response.body).toContain('<nav');
    expect(response.body).not.toContain('action="/admin/logout"');
  });

  it('lists an intent with links to its card and its user', async () => {
    const response = await get('/admin/intents', withCookie);

    expect(response.body).toContain(`<a href="/admin/intents/${SAMPLE_INTENT.id}">`);
    expect(response.body).toContain(`<a href="/admin/users/${USER}">4242</a>`);
    expect(response.body).toContain('<code>broker_rejected</code>');
    expect(response.body).not.toContain(TEXTS.intentsNext);
  });

  it('says so when there are no intents', async () => {
    await app.close();
    app = build({ intents: () => Promise.resolve({ ...SAMPLE_INTENTS, intents: [] }) });

    const response = await get(`/admin/intents?session=${SAMPLE_SESSION_ID}`, withCookie);

    expect(response.body).toContain(TEXTS.intentsEmpty);
    expect(hrefOf(response.body, TEXTS.intentsFirst)).toBe(
      `/admin/intents?session=${SAMPLE_SESSION_ID}`,
    );
  });

  it('renders the card: every field, the user, and the intents of its session', async () => {
    const response = await get(`/admin/intents/${SAMPLE_INTENT.id}`, withCookie);

    expect(calls.intent).toEqual([[TOKEN, SAMPLE_INTENT.id]]);
    expect(response.body.match(/<dt>/g)).toHaveLength(Object.keys(SAMPLE_INTENT).length);
    expect(response.body).toContain(`<a href="/admin/users/${USER}">${USER}</a>`);
    expect(hrefOf(response.body, TEXTS.intentsOfSession)).toBe(
      `/admin/intents?session=${SAMPLE_SESSION_ID}`,
    );
    expect(response.body).toContain(SAMPLE_INTENT.brokerAccountId);
  });

  it('prints none for every null, offers no session link without a session, and escapes text', async () => {
    await app.close();
    app = build({
      intent: () =>
        Promise.resolve({
          ...SAMPLE_INTENT_RESPONSE,
          intent: {
            ...SAMPLE_INTENT,
            clientRequestId: 'a<b>',
            transport: null,
            submittedAt: null,
            lastError: null,
            tradingSessionId: null,
            reconcileClaimedAt: null,
          },
        }),
    });

    const response = await get(`/admin/intents/${SAMPLE_INTENT.id}`, withCookie);

    expect(response.body.match(/<dd>\s*—\s*<\/dd>/g)).toHaveLength(5);
    expect(response.body).not.toContain(TEXTS.intentsOfSession);
    expect(response.body).toContain('a&lt;b&gt;');
    expect(response.body).not.toContain('a<b>');
  });

  it('answers an id that is not a uuid with 404, before the backend is asked', async () => {
    const response = await get('/admin/intents/not-a-uuid', withCookie);

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain(TEXTS.intentNotFoundTitle);
    expect(calls.intent).toEqual([]);
  });

  it('answers an intent the backend did not find with 404', async () => {
    await app.close();
    app = build({ intent: () => Promise.reject(httpFailure(404, AdminErrorCode.NotFound)) });

    const response = await get(`/admin/intents/${SAMPLE_INTENT.id}`, withCookie);

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain(TEXTS.intentNotFoundTitle);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });

  it.each(['/admin/intents', `/admin/intents/${SAMPLE_INTENT.id}`])(
    '%s drops a session the backend no longer knows',
    async (url) => {
      await app.close();
      const gone = () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid));
      app = build({ intents: gone, intent: gone });

      const response = await get(url, withCookie);

      expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
      expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
    },
  );

  it.each(['/admin/intents', `/admin/intents/${SAMPLE_INTENT.id}`])(
    '%s treats a failure of its own as a 500 and keeps the cookie',
    async (url) => {
      await app.close();
      const failed = () => Promise.reject(httpFailure(500));
      app = build({ intents: failed, intent: failed });

      const response = await get(url, withCookie);

      expect(response.statusCode).toBe(500);
      expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
    },
  );

  it.each(['/admin/intents', `/admin/intents/${SAMPLE_INTENT.id}`])(
    '%s treats a malformed session cookie as none, before the backend is asked',
    async (url) => {
      const response = await get(url, { [SESSION_COOKIE]: 'not-a-session-token' });

      expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
      expect([calls.intents, calls.intent]).toEqual([[], []]);
    },
  );
});

describe('the trading sessions page, the card section and the overview breakdown (#330)', () => {
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';
  const withCookie = { [SESSION_COOKIE]: TOKEN };

  // the href of the link whose text is `label`, as a browser would read it back
  const hrefOf = (body: string, label: string): string | undefined => {
    const match = new RegExp(`<a href="([^"]*)"\\s*>\\s*${label}\\s*</a`).exec(body);
    return match?.[1]?.replaceAll('&amp;', '&');
  };
  const navOf = (body: string): string[] =>
    [...(/<nav[^>]*>([\s\S]*?)<\/nav>/.exec(body)?.[1] ?? '').matchAll(/>\s*([^<]+?)\s*<\/a/g)].map(
      (m) => m[1] ?? '',
    );
  const NAV_LABELS = [
    TEXTS.navOverview,
    TEXTS.navUsers,
    TEXTS.navSessions,
    TEXTS.navIntents,
    TEXTS.navTradingSessions,
  ];

  it.each([
    '/admin/overview',
    '/admin/users',
    `/admin/users/${SAMPLE_USER_ID}`,
    '/admin/sessions',
    '/admin/intents',
    `/admin/intents/${SAMPLE_INTENT.id}`,
    '/admin/trading-sessions',
  ])('%s carries the five nav items in order, staff sessions named as such', async (url) => {
    const response = await get(url, withCookie);

    expect(response.statusCode).toBe(200);
    expect(NAV_LABELS).toEqual([
      'Сводка',
      'Пользователи',
      'Сессии сотрудников',
      'Заявки',
      'Торговые сессии',
    ]);
    expect(navOf(response.body)).toEqual(NAV_LABELS);
    expect(response.body).toContain('<a href="/admin/trading-sessions"');
  });

  it('marks Торговые сессии as the current page and carries the login', async () => {
    const response = await get('/admin/trading-sessions', withCookie);

    expect(response.body).toMatch(/<a href="\/admin\/trading-sessions"\s+aria-current="page"/);
    expect(response.body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(response.body).toContain(`ada — ${TEXTS.logoutSubmit}`);
  });

  it('lists a session: its intents, its user, settings v1, and none for every null', async () => {
    const response = await get('/admin/trading-sessions', withCookie);

    expect(calls.tradingSessions).toEqual([[TOKEN, {}]]);
    expect(response.body).toContain(
      `<a href="/admin/intents?session=${SAMPLE_TRADING_SESSION.id}">${TEXTS.tradingSessionIntents}</a>`,
    );
    expect(response.body).toContain(
      `<a href="/admin/intents?session=${SAMPLE_TRADING_SESSION_NULLS.id}">${TEXTS.tradingSessionIntents}</a>`,
    );
    expect(response.body).toContain(`<a href="/admin/users/${SAMPLE_USER_ID}">4242</a>`);
    expect(response.body).toContain('<code>rejected_twice</code>');
    expect(response.body).toMatch(/<td>101<\/td>\s*<td>60<\/td>\s*<td>5<\/td>\s*<td>1\.5<\/td>/);
    expect(response.body).not.toContain(TEXTS.tradingSessionsNext);
    expect(response.body).not.toContain(TEXTS.tradingSessionsFirst);
  });

  it('prints none in the four settings cells, the reason, the end and the decision of a bare session', async () => {
    await app.close();
    app = build({
      tradingSessions: () =>
        Promise.resolve({ ...SAMPLE_TRADING_SESSIONS, sessions: [SAMPLE_TRADING_SESSION_NULLS] }),
    });

    const response = await get('/admin/trading-sessions', withCookie);

    expect(response.statusCode).toBe(200);
    expect(response.body.match(/<td>\s*—\s*<\/td>/g)).toHaveLength(7);
  });

  it('escapes a broker id that is markup', async () => {
    await app.close();
    app = build({
      tradingSessions: () =>
        Promise.resolve({
          ...SAMPLE_TRADING_SESSIONS,
          sessions: [{ ...SAMPLE_TRADING_SESSION, brokerUserId: 'a<b>' }],
        }),
    });

    const response = await get('/admin/trading-sessions', withCookie);

    expect(response.body).toContain('a&lt;b&gt;');
    expect(response.body).not.toContain('a<b>');
  });

  it('says so when there are no sessions', async () => {
    await app.close();
    app = build({
      tradingSessions: () => Promise.resolve({ ...SAMPLE_TRADING_SESSIONS, sessions: [] }),
    });

    const response = await get('/admin/trading-sessions', withCookie);

    expect(response.body).toContain(TEXTS.tradingSessionsEmpty);
    expect(hrefOf(response.body, TEXTS.tradingSessionsFirst)).toBe('/admin/trading-sessions');
  });

  it('carries the cursor through the next link, and offers the first page from there', async () => {
    await app.close();
    app = build({
      tradingSessions: (token, query) => {
        calls.tradingSessions.push([token, query]);
        return Promise.resolve({ ...SAMPLE_TRADING_SESSIONS, nextCursor: CURSOR });
      },
    });

    const first = await get('/admin/trading-sessions', withCookie);
    const next = hrefOf(first.body, TEXTS.tradingSessionsNext);
    expect(next).toBe(`/admin/trading-sessions?cursor=${CURSOR}`);
    const second = await get(next ?? '', withCookie);

    expect(calls.tradingSessions.map(([, query]) => query)).toEqual([{}, { cursor: CURSOR }]);
    expect(hrefOf(second.body, TEXTS.tradingSessionsFirst)).toBe('/admin/trading-sessions');
  });

  it('asks for the first page when the cursor is empty', async () => {
    await get('/admin/trading-sessions?cursor=', withCookie);
    expect(calls.tradingSessions).toEqual([[TOKEN, {}]]);
  });

  it.each([
    ['a cursor that is not a uuid', 'cursor=bad'],
    ['a cursor twice', `cursor=${CURSOR}&cursor=${CURSOR}`],
  ])('drops %s with a redirect, before the backend is asked', async (_label, query) => {
    const response = await get(`/admin/trading-sessions?${query}`, withCookie);

    expect([response.statusCode, response.headers.location]).toEqual([
      302,
      '/admin/trading-sessions',
    ]);
    expect(calls.tradingSessions).toEqual([]);
  });

  it('drops a session the backend no longer knows, and keeps the cookie on its own failure', async () => {
    await app.close();
    app = build({
      tradingSessions: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
    });
    const gone = await get('/admin/trading-sessions', withCookie);
    expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(gone, SESSION_COOKIE)?.value).toBe('');

    await app.close();
    app = build({ tradingSessions: () => Promise.reject(httpFailure(500)) });
    const failed = await get('/admin/trading-sessions', withCookie);
    expect(failed.statusCode).toBe(500);
    expect(cookieOf(failed, SESSION_COOKIE)).toBeUndefined();
  });

  it('treats a malformed session cookie as none, before the backend is asked', async () => {
    const response = await get('/admin/trading-sessions', {
      [SESSION_COOKIE]: 'not-a-session-token',
    });

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(calls.tradingSessions).toEqual([]);
  });

  it('renders the trading section of the card: counts, the recent intents, all of them', async () => {
    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    expect(response.body).toContain(`<h2>${TEXTS.userTrading}</h2>`);
    expect(response.body).toContain(TEXTS.userIntentsCounts(3, 1));
    expect(TEXTS.userIntentsCounts(3, 1)).toBe('Всего заявок: 3, активных: 1');
    expect(response.body).toContain(TEXTS.userIntentsRecent(ADMIN_USER_RECENT_INTENTS));
    expect(response.body).toContain(`<a href="/admin/intents/${SAMPLE_INTENT.id}">`);
    expect(hrefOf(response.body, TEXTS.userIntentsAll)).toBe(
      `/admin/intents?user=${SAMPLE_USER_ID}`,
    );
    // the section follows the accounts
    expect(response.body.indexOf(TEXTS.userTrading)).toBeGreaterThan(
      response.body.indexOf(TEXTS.userBrokerAccounts),
    );
  });

  it('keeps the section and the link to all intents without accounts and without intents', async () => {
    await app.close();
    app = build({
      user: () =>
        Promise.resolve({
          ...SAMPLE_USER,
          brokerAccounts: [],
          intents: { recent: [], total: 0, active: 0 },
        }),
    });

    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    expect(response.body).toContain(TEXTS.userNoAccounts);
    expect(response.body).toContain(`<h2>${TEXTS.userTrading}</h2>`);
    expect(response.body).toContain(TEXTS.userIntentsCounts(0, 0));
    expect(response.body).toContain(TEXTS.intentsEmpty);
    expect(response.body).not.toContain(TEXTS.userIntentsRecent(ADMIN_USER_RECENT_INTENTS));
    expect(hrefOf(response.body, TEXTS.userIntentsAll)).toBe(
      `/admin/intents?user=${SAMPLE_USER_ID}`,
    );
  });

  it('prints the overview breakdown in the order of the constant, and the active count', async () => {
    const response = await get('/admin/overview', withCookie);
    const { byStatus, active } = SAMPLE_OVERVIEW.overview.intents;

    const rows = [
      ...response.body.matchAll(/<dt><code>([a-z_]+)<\/code><\/dt>\s*<dd>(\d+)<\/dd>/g),
    ].map((m) => [m[1], Number(m[2])]);
    expect(rows).toEqual(Object.values(TradeIntentStatus).map((s) => [s, byStatus[s]]));
    expect(response.body).toContain(`<h3>${TEXTS.overviewIntentsByStatus}</h3>`);
    expect(response.body).toMatch(
      new RegExp(
        `<dt>${TEXTS.overviewIntentsActive.replace(/[()]/g, '\\$&')}</dt>\\s*<dd>${active}</dd>`,
      ),
    );
  });
});

describe('revoking', () => {
  it('goes back to the list after revoking someone else’s session', async () => {
    const response = await post(
      `/admin/sessions/${VIEW.id}/revoke`,
      {},
      { [SESSION_COOKIE]: TOKEN },
    );
    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/sessions']);
    expect(calls.revoke).toEqual([[TOKEN, VIEW.id]]);
  });

  it('drops the cookie when the caller revoked its own session', async () => {
    await app.close();
    app = build({ revoke: () => Promise.resolve({ revoked: true, current: true }) });

    const response = await post(
      `/admin/sessions/${VIEW.id}/revoke`,
      {},
      { [SESSION_COOKIE]: TOKEN },
    );

    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/login']);
    expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
  });

  it('refuses a session id that is not a uuid before the backend is asked', async () => {
    const response = await post(
      '/admin/sessions/not-a-uuid/revoke',
      {},
      { [SESSION_COOKIE]: TOKEN },
    );

    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/sessions']);
    expect(calls.revoke).toEqual([]);
  });

  it('treats a session that was already gone as nothing to report', async () => {
    await app.close();
    app = build({ revoke: () => Promise.reject(httpFailure(404, AdminErrorCode.NotFound)) });

    const response = await post(
      `/admin/sessions/${VIEW.id}/revoke`,
      {},
      { [SESSION_COOKIE]: TOKEN },
    );

    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/sessions']);
  });
});

describe('logging out', () => {
  it('ends the session and drops the cookie', async () => {
    const response = await post('/admin/logout', {}, { [SESSION_COOKIE]: TOKEN });
    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/login']);
    expect(calls.logout).toEqual([TOKEN]);
    expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
  });

  it('is done when the backend says the session is already gone', async () => {
    await app.close();
    app = build({ logout: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)) });

    const response = await post('/admin/logout', {}, { [SESSION_COOKIE]: TOKEN });

    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/login']);
    expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
  });

  it('answers 500 for a refused bearer rather than calling it a logout', async () => {
    await app.close();
    app = build({ logout: () => Promise.reject(httpFailure(401, AdminErrorCode.Unauthorized)) });

    const response = await post('/admin/logout', {}, { [SESSION_COOKIE]: TOKEN });

    expect(response.statusCode).toBe(500);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });

  // the session is still live on the server: clearing the cookie would make the logout look
  // done when it was never recorded
  it('keeps the cookie when the backend could not end the session', async () => {
    await app.close();
    app = build({ logout: () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)) });

    const response = await post('/admin/logout', {}, { [SESSION_COOKIE]: TOKEN });

    expect(response.statusCode).toBe(500);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });
});

describe('what reaches the log', () => {
  it('names an error without quoting it, and never the cookie', async () => {
    await app.close();
    app = build({
      sessions: () => Promise.reject(new Error('backend said: token=super-secret')),
    });

    const response = await get('/admin/sessions', { [SESSION_COOKIE]: TOKEN });

    expect(response.statusCode).toBe(500);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const failure = logged.find((line) => line.msg === 'the admin backend call could not be used');
    expect(failure?.err).toEqual({ name: 'Error' });
    expect(lines.join('')).not.toContain('super-secret');
    expect(lines.join('')).not.toContain(TOKEN);
  });

  // Fastify's own lines and a positional error: the logger's serializer and hook keep them to
  // the whitelist, with no override in this app
  const leaky = () =>
    Object.assign(new TypeError('message with MARKER-SECRET'), {
      code: 'E_LEAKY',
      detail: 'DETAIL-SECRET',
      cause: Object.assign(new Error('CAUSE-SECRET'), { code: '23505' }),
    });
  const WHITELISTED = {
    name: 'TypeError',
    code: 'E_LEAKY',
    cause: { name: 'Error', code: '23505' },
  };
  const loggedLines = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const expectNoSecret = () => {
    for (const secret of ['MARKER-SECRET', 'DETAIL-SECRET', 'CAUSE-SECRET', '    at ']) {
      expect(lines.join('')).not.toContain(secret);
    }
  };

  it('logs a rejection after the reply was sent by the whitelist', async () => {
    app.get('/sent-then-failed', async (_request, reply) => {
      await reply.send('ok');
      throw leaky();
    });
    expect((await get('/sent-then-failed')).statusCode).toBe(200);
    const entry = loggedLines().find(
      (line) => line.msg === 'Promise errored, but reply.sent = true was set',
    );
    expect(entry?.err).toStrictEqual(WHITELISTED);
    expectNoSecret();
  });

  it('logs an error passed to the request logger positionally with a fixed message', async () => {
    app.get('/positional', async (request) => {
      request.log.error(leaky());
      return 'ok';
    });
    expect((await get('/positional')).statusCode).toBe(200);
    const entry = loggedLines().find((line) => line.msg === UNNAMED_ERROR_MESSAGE);
    expect(entry?.err).toStrictEqual(WHITELISTED);
    expectNoSecret();
  });

  it('writes no access line for a page it served', async () => {
    await get('/admin/login');
    expect(lines).toEqual([]);
  });
});

describe('the pages that are not routes', () => {
  it('redirects the bare prefix to the overview', async () => {
    const response = await get('/admin');
    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/overview']);
  });

  it('answers an unknown path with a page rather than JSON', async () => {
    const response = await get('/admin/nope?token=secret');
    expect([response.statusCode, response.headers['content-type']]).toEqual([
      404,
      'text/html; charset=utf-8',
    ]);
    expect(response.body).toContain(TEXTS.notFoundTitle);
    expect(lines.join('')).not.toContain('secret');
  });
});

describe('an expiry the backend reports as already past', () => {
  const past = () => new Date(Date.now() - 1_000).toISOString();

  it('is our own failure on the login step: 500, no cookie, the error named in the log', async () => {
    await app.close();
    app = build({ login: () => Promise.resolve({ challengeId: CHALLENGE_ID, expiresAt: past() }) });

    const response = await post('/admin/login', { login: 'ada', password: 'secret' });

    expect(response.statusCode).toBe(500);
    expect(cookieOf(response, CHALLENGE_COOKIE)).toBeUndefined();
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      logged.find((line) => line.msg === 'the admin backend call could not be used')?.err,
    ).toEqual({ name: 'ExpiryInThePast' });
  });

  // The fixture is computed inside the stub, not before the request: taken a few milliseconds
  // earlier it would already be negative by the time secondsUntil reads it, and a negative
  // remainder cannot tell `> 0` from `>= 0` — the boundary this case exists for.
  it('is our own failure inside the last second too: a remainder that rounds down to zero is not a cookie with Max-Age=0', async () => {
    await app.close();
    app = build({
      login: () =>
        Promise.resolve({
          challengeId: CHALLENGE_ID,
          expiresAt: new Date(Date.now() + 999).toISOString(),
        }),
    });

    const response = await post('/admin/login', { login: 'ada', password: 'secret' });

    expect(response.statusCode).toBe(500);
    expect(cookieOf(response, CHALLENGE_COOKIE)).toBeUndefined();
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      logged.find((line) => line.msg === 'the admin backend call could not be used')?.err,
    ).toEqual({ name: 'ExpiryInThePast' });
  });

  it('is our own failure on the confirm step too, and leaves both cookies alone', async () => {
    await app.close();
    app = build({ confirm: () => Promise.resolve({ sessionToken: TOKEN, expiresAt: past() }) });

    const response = await post(
      '/admin/login/confirm',
      { code: '123456' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );

    expect(response.statusCode).toBe(500);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
    expect(cookieOf(response, CHALLENGE_COOKIE)).toBeUndefined();
  });
});
