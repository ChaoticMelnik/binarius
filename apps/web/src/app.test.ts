import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminErrorCode, type StaffSessionView } from '@binarius/shared';
import { buildWebApp } from './app';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { SESSION_COOKIE, CHALLENGE_COOKIE } from './admin/routes';
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
}

let calls: Calls;
let lines: string[];
let app: FastifyInstance;

const build = (backend: Partial<BackendClient> = {}, secureCookies = false): FastifyInstance => {
  calls = { login: [], confirm: [], sessions: [], revoke: [], logout: [] };
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
    ...backend,
  };
  return buildWebApp({
    backend: client,
    publicOrigin: ORIGIN,
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

  it('truncates a user agent the column would refuse', async () => {
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
    expect((calls.login[0] as { userAgent: string }).userAgent).toHaveLength(512);
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

  it('writes no access line for a page it served', async () => {
    await get('/admin/login');
    expect(lines).toEqual([]);
  });
});

describe('the pages that are not routes', () => {
  it('redirects the bare prefix to the list', async () => {
    const response = await get('/admin');
    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/sessions']);
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
