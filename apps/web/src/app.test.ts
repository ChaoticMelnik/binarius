import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_SEARCH_MAX_LENGTH,
  ADMIN_USER_RECENT_INTENTS,
  ADMIN_USER_RECENT_LEDGER,
  AdminErrorCode,
  BOT_TEXT_CATALOG,
  BOT_TEXT_VARS,
  BOT_TEXT_GROUP_TITLES,
  BOT_TEXT_SOURCE_MAX,
  BotTextGroup,
  AuditAction,
  AuditEntityType,
  BrokerAccountStatus,
  adminChangePasswordRequestSchema,
  adminConfirmRequestSchema,
  adminLinkCompleteRequestSchema,
  adminLinkInspectRequestSchema,
  adminLoginRequestSchema,
  CLIENT_USER_AGENT_MAX_LENGTH,
  DepositEventStatus,
  TOKEN_ADJUSTMENT_MAX_TOKENS,
  TOKEN_LEDGER_NOTE_MAX,
  TokenLedgerKind,
  TradeIntentStatus,
  UNNAMED_ERROR_MESSAGE,
  type AdminAuditQuery,
  type AdminBrokerAccountsQuery,
  type AdminDepositsQuery,
  type AdminIntentsQuery,
  type AdminTokensQuery,
  type AdminTradingSessionsQuery,
  type AdminUsersQuery,
  type StaffSessionView,
} from '@binarius/shared';
import { buildWebApp } from './app';
import { BackendError, BackendErrorCode, type BackendClient } from './backend-client';
import { SESSION_COOKIE, CHALLENGE_COOKIE } from './admin/routes';
import {
  SAMPLE_ADJUSTED,
  SAMPLE_AUDIT,
  SAMPLE_AUDIT_ENTRY_NULLS,
  SAMPLE_BOT_TEXT,
  SAMPLE_BOT_TEXTS,
  SAMPLE_BROKER_ACCOUNT_HALTED,
  SAMPLE_BROKER_ACCOUNT_ITEM,
  SAMPLE_BROKER_ACCOUNTS,
  SAMPLE_DEPOSIT,
  SAMPLE_DEPOSIT_UNOWNED,
  SAMPLE_DEPOSITS,
  SAMPLE_PUBLISHED,
  SAMPLE_PUBLISHED_QUERY,
  SAMPLE_INTENT,
  SAMPLE_INTENT_RESPONSE,
  SAMPLE_INTENTS,
  SAMPLE_LEDGER_ADJUSTMENT,
  SAMPLE_LEDGER_ENTRY,
  SAMPLE_LIST_ITEM,
  SAMPLE_ME,
  SAMPLE_OVERVIEW,
  SAMPLE_SESSION_ID,
  SAMPLE_TOKENS,
  SAMPLE_TRADING_SESSION,
  SAMPLE_TRADING_SESSION_NULLS,
  SAMPLE_TRADING_SESSIONS,
  SAMPLE_USER,
  SAMPLE_USER_ID,
  sampleAdjustmentRefusal,
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
  inspectLoginLink: string[];
  completeLoginLink: unknown[];
  sessions: unknown[];
  revoke: unknown[][];
  logout: unknown[];
  overview: unknown[];
  users: [string, AdminUsersQuery][];
  user: unknown[][];
  intents: [string, AdminIntentsQuery][];
  intent: unknown[][];
  tradingSessions: [string, AdminTradingSessionsQuery][];
  tokens: [string, AdminTokensQuery][];
  deposits: [string, AdminDepositsQuery][];
  adjustTokens: unknown[][];
  brokerAccounts: [string, AdminBrokerAccountsQuery][];
  audit: [string, AdminAuditQuery][];
  changePassword: unknown[][];
  botTexts: unknown[];
  botText: unknown[][];
  previewBotText: unknown[][];
  saveBotText: unknown[][];
  resetBotText: unknown[][];
  publishBotProfile: unknown[];
}

let calls: Calls;
let lines: string[];
let app: FastifyInstance;

const build = (backend: Partial<BackendClient> = {}, secureCookies = false): FastifyInstance => {
  calls = {
    login: [],
    confirm: [],
    inspectLoginLink: [],
    completeLoginLink: [],
    sessions: [],
    revoke: [],
    logout: [],
    overview: [],
    users: [],
    user: [],
    intents: [],
    intent: [],
    tradingSessions: [],
    tokens: [],
    deposits: [],
    adjustTokens: [],
    brokerAccounts: [],
    audit: [],
    changePassword: [],
    botTexts: [],
    botText: [],
    previewBotText: [],
    saveBotText: [],
    resetBotText: [],
    publishBotProfile: [],
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
    inspectLoginLink: async (token) => {
      calls.inspectLoginLink.push(token);
      return { state: 'live' };
    },
    completeLoginLink: async (request) => {
      calls.completeLoginLink.push(request);
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
    tokens: async (token, query) => {
      calls.tokens.push([token, query]);
      return SAMPLE_TOKENS;
    },
    deposits: async (token, query) => {
      calls.deposits.push([token, query]);
      return SAMPLE_DEPOSITS;
    },
    adjustTokens: async (token, id, request) => {
      calls.adjustTokens.push([token, id, request]);
      return SAMPLE_ADJUSTED;
    },
    brokerAccounts: async (token, query) => {
      calls.brokerAccounts.push([token, query]);
      return SAMPLE_BROKER_ACCOUNTS;
    },
    audit: async (token, query) => {
      calls.audit.push([token, query]);
      return SAMPLE_AUDIT;
    },
    // 3 is no fake's count of other sessions: a redirect built from the list would show
    changePassword: async (token, request) => {
      calls.changePassword.push([token, request]);
      return { changed: true, revokedSessions: 3 };
    },
    botTexts: async (token) => {
      calls.botTexts.push(token);
      return SAMPLE_BOT_TEXTS;
    },
    botText: async (token, key) => {
      calls.botText.push([token, key]);
      return { me: SAMPLE_ME, text: SAMPLE_BOT_TEXT };
    },
    previewBotText: async (token, key, request) => {
      calls.previewBotText.push([token, key, request]);
      return {
        me: SAMPLE_ME,
        text: SAMPLE_BOT_TEXT,
        outcome: 'rendered',
        rendered: { kind: 'html', telegramHtml: '<b>Привет</b> <a href="javascript:x">тут</a>' },
      };
    },
    saveBotText: async (token, key, request) => {
      calls.saveBotText.push([token, key, request]);
      return {
        me: SAMPLE_ME,
        text: SAMPLE_BOT_TEXT,
        outcome: 'saved',
        version: 8,
        published: [],
      };
    },
    resetBotText: async (token, key, request) => {
      calls.resetBotText.push([token, key, request]);
      return { me: SAMPLE_ME, text: SAMPLE_BOT_TEXT, outcome: 'reset', published: [] };
    },
    publishBotProfile: async (token) => {
      calls.publishBotProfile.push(token);
      return { me: SAMPLE_ME, published: SAMPLE_PUBLISHED };
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

const post = (
  url: string,
  payload: Record<string, string> = {},
  cookies?: Record<string, string>,
) =>
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
    // what a browser sends on its own form POSTs under no-referrer: accepting it is never the fix
    ['the literal null a browser sends under no-referrer', 'null'],
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
    ['cache-control', 'no-store'],
  ])('sets %s on a page', async (header, expected) => {
    expect(String((await get('/admin/login')).headers[header])).toContain(expected);
  });

  // under no-referrer a browser serialises the Origin of its own form POSTs as `null` and the
  // origin check refuses them (#241); same-origin keeps the real Origin
  it.each([
    ['a page', '/admin/login', 200],
    ['a redirect', '/admin/sessions', 302],
    ['the not-found handler', '/admin/nope', 404],
  ])('sends referrer-policy same-origin on %s', async (_label, url, status) => {
    const response = await get(url);
    expect(response.statusCode).toBe(status);
    expect(response.headers['referrer-policy']).toBe('same-origin');
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

  // every value the gate lets through must parse under the backend's own schema: a cookie the
  // gate passes and the schema refuses comes back on every retry (#152)
  it.each([
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '00000000-0000-0000-0000-000000000001',
    'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
  ])('forwards the challenge cookie %s in a body the backend’s schema reads', async (value) => {
    await post('/admin/login/confirm', { code: '123456' }, { [CHALLENGE_COOKIE]: value });

    expect(calls.confirm).toEqual([expect.objectContaining({ challengeId: value })]);
    // the forwarded body against the real schema, not against a pattern copied into this file
    expect(adminConfirmRequestSchema.safeParse(calls.confirm[0]).success).toBe(true);
  });

  it('drops the challenge cookie and starts over when the backend refuses the forwarded body (#152)', async () => {
    await app.close();
    app = build({ confirm: () => Promise.reject(httpFailure(400, AdminErrorCode.Validation)) });

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
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      logged.find((line) => line.msg === 'the backend refused the forwarded confirm as malformed'),
    ).toMatchObject({ level: 50, status: 400, reason: AdminErrorCode.Validation });
    expect(lines.join('')).not.toContain(CHALLENGE_ID);
    // without the cookie the form is not offered again: the loop is broken
    const next = await get('/admin/login/confirm');
    expect([next.statusCode, next.headers.location]).toEqual([302, '/admin/login']);
  });

  // the branch is keyed on the pair: any other refusal is our own fault and leaves the cookie
  it.each([
    ['a 400 with another code', httpFailure(400, 'something_else')],
    ['a refused bearer', httpFailure(401, AdminErrorCode.Unauthorized)],
  ])('answers 500 and keeps the challenge cookie for %s', async (_label, error) => {
    await app.close();
    app = build({ confirm: () => Promise.reject(error) });

    const response = await post(
      '/admin/login/confirm',
      { code: '123456' },
      { [CHALLENGE_COOKIE]: CHALLENGE_ID },
    );

    expect(response.statusCode).toBe(500);
    expect(cookieOf(response, CHALLENGE_COOKIE)).toBeUndefined();
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

// docs/staff-login.md → Logging in by a link from the bot (#448)
describe('the login link', () => {
  // `-` and `_` on purpose: a backend schema narrower than the shared pattern refuses these
  const LINK = 'Ab-_' + 'x'.repeat(39);
  const LINK_URL = `/admin/login/link/${LINK}`;

  // Telegram's preview, a prefetch or a prerender must not spend the link
  it('shows the «Войти» page on GET and spends nothing', async () => {
    const response = await get(LINK_URL);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(TEXTS.linkSubmit);
    expect(response.body).toContain('method="post"');
    // the token stays in the URL; the page does not repeat it
    expect(response.body).not.toContain(LINK);
    expect(calls.inspectLoginLink).toEqual([LINK]);
    expect(calls.completeLoginLink).toEqual([]);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });

  it.each([
    ['used', TEXTS.linkUsed],
    ['expired', TEXTS.linkExpired],
    ['unavailable', TEXTS.linkUnavailable],
  ] as const)('refuses a %s link on GET with 410', async (state, message) => {
    await app.close();
    app = build({
      inspectLoginLink: async (token) => {
        calls.inspectLoginLink.push(token);
        return { state };
      },
    });

    const response = await get(LINK_URL);

    expect([response.statusCode, response.body.includes(message)]).toEqual([410, true]);
    expect(response.body).not.toContain(TEXTS.linkSubmit);
    expect(calls.completeLoginLink).toEqual([]);
  });

  it.each([
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(44)],
    ['outside base64url', `${'a'.repeat(42)}.`],
  ])('answers 404 to a token %s without calling the backend', async (_label, token) => {
    const read = await get(`/admin/login/link/${token}`);
    const spent = await post(`/admin/login/link/${token}`);

    expect([read.statusCode, spent.statusCode]).toEqual([404, 404]);
    expect(read.body).toContain(TEXTS.linkUnavailable);
    expect([calls.inspectLoginLink, calls.completeLoginLink]).toEqual([[], []]);
  });

  it('creates the session on POST, sets the cookie as the code login does, and goes in', async () => {
    const response = await post(LINK_URL);

    expect([response.statusCode, response.headers.location]).toEqual([303, '/admin/sessions']);
    const cookie = cookieOf(response, SESSION_COOKIE);
    expect(cookie).toMatchObject({ value: TOKEN, httpOnly: true, path: '/admin', sameSite: 'Lax' });
    // the lifetime is the backend's expiry, an hour in this fake
    expect(cookie?.maxAge).toBeGreaterThan(3_500);
    expect(cookie?.maxAge).toBeLessThanOrEqual(3_600);
    expect(calls.completeLoginLink).toEqual([
      { token: LINK, ip: '127.0.0.1', userAgent: INJECTED_AGENT },
    ]);
  });

  // every token the path check lets through must parse under the backend's own schemas — the
  // shared pattern is one object in both processes (Rule 17), and this is what holds it there
  it('forwards bodies the backend’s schemas read', async () => {
    await get(LINK_URL);
    await post(LINK_URL);

    expect(
      adminLinkInspectRequestSchema.safeParse({ token: calls.inspectLoginLink[0] }).success,
    ).toBe(true);
    expect(adminLinkCompleteRequestSchema.safeParse(calls.completeLoginLink[0]).success).toBe(true);
  });

  it('refuses a POST from another origin without spending the link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: LINK_URL,
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '',
    });

    expect(response.statusCode).toBe(403);
    expect(calls.completeLoginLink).toEqual([]);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });

  it.each([
    [AdminErrorCode.LinkUsed, TEXTS.linkUsed],
    [AdminErrorCode.LinkExpired, TEXTS.linkExpired],
    [AdminErrorCode.LinkUnavailable, TEXTS.linkUnavailable],
  ])('shows the refusal for 410 %s on POST, with no cookie', async (code, message) => {
    await app.close();
    app = build({ completeLoginLink: () => Promise.reject(httpFailure(410, code)) });

    const response = await post(LINK_URL);

    expect([response.statusCode, response.body.includes(message)]).toEqual([410, true]);
    expect(cookieOf(response, SESSION_COOKIE)).toBeUndefined();
  });

  it('says to wait on 429', async () => {
    await app.close();
    app = build({
      completeLoginLink: () => Promise.reject(httpFailure(429, AdminErrorCode.TooManyAttempts)),
    });

    const response = await post(LINK_URL);

    expect([response.statusCode, response.body.includes(TEXTS.tooManyAttempts)]).toEqual([
      429,
      true,
    ]);
  });

  // the URL is the credential for five minutes: no log line may carry it, on success or failure
  it('logs neither the token nor the path, on success and on a backend failure', async () => {
    await post(LINK_URL);
    const onSuccess = lines.join('');
    await app.close();
    app = build({
      inspectLoginLink: () => Promise.reject(httpFailure(401, AdminErrorCode.Unauthorized)),
      completeLoginLink: () => Promise.reject(httpFailure(400, AdminErrorCode.Validation)),
    });
    const read = await get(LINK_URL);
    const spent = await post(LINK_URL);

    expect([read.statusCode, spent.statusCode]).toEqual([500, 500]);
    expect(lines.length).toBeGreaterThan(0);
    for (const written of [onSuccess, lines.join('')]) {
      expect(written).not.toContain(LINK);
      expect(written).not.toContain('/admin/login/link');
    }
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
    app = build({
      sessions: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
    });

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
    // the shared accounts table (#342): the account id first, no owner column on the card; the
    // section alone, since the deposits section prints the same account id
    const section = response.body.slice(
      response.body.indexOf(`<h2>${TEXTS.userBrokerAccounts}</h2>`),
      response.body.indexOf(`<h2>${TEXTS.userTrading}</h2>`),
    );
    expect(section).toMatch(
      new RegExp(
        `<tr>\\s*<td><code>${SAMPLE_BROKER_ACCOUNT_ITEM.id}</code></td>\\s*<td>broker-7</td>`,
      ),
    );
    expect(section).toMatch(new RegExp(`<tr>\\s*<th>${TEXTS.columnAccountId}</th>`));
    expect(section).not.toContain(`<th>${TEXTS.columnTelegramId}</th>`);
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
    TEXTS.navTokens,
    TEXTS.navAudit,
    TEXTS.navBotTexts,
    TEXTS.navDeposits,
    TEXTS.navBrokerAccounts,
  ];

  it.each([
    '/admin/overview',
    '/admin/users',
    `/admin/users/${SAMPLE_USER_ID}`,
    '/admin/sessions',
    '/admin/intents',
    `/admin/intents/${SAMPLE_INTENT.id}`,
    '/admin/trading-sessions',
    '/admin/tokens',
    '/admin/audit',
    '/admin/bot-texts',
    '/admin/deposits',
    '/admin/broker-accounts',
  ])('%s carries the ten nav items in order, staff sessions named as such', async (url) => {
    const response = await get(url, withCookie);

    expect(response.statusCode).toBe(200);
    expect(NAV_LABELS).toEqual([
      'Сводка',
      'Пользователи',
      'Сессии сотрудников',
      'Заявки',
      'Торговые сессии',
      'Токены',
      'Аудит',
      'Тексты бота',
      'Депозиты',
      'Брокерские аккаунты',
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
          // "Последние 20" is the ledger and the deposits sections' caption too (#109, #341)
          ledger: { recent: [] },
          deposits: { recent: [] },
        }),
    });

    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    const accountsSection = response.body.slice(
      response.body.indexOf(`<h2>${TEXTS.userBrokerAccounts}</h2>`),
      response.body.indexOf(`<h2>${TEXTS.userTrading}</h2>`),
    );
    expect(accountsSection).toContain(`<p>${TEXTS.brokerAccountsEmpty}</p>`);
    expect(accountsSection).not.toContain('<table');
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

describe('the token ledger page and the card section (#109)', () => {
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';
  const USER = SAMPLE_USER_ID;
  const withCookie = { [SESSION_COOKIE]: TOKEN };

  // the href of the link whose text is `label`, as a browser would read it back
  const hrefOf = (body: string, label: string): string | undefined => {
    const match = new RegExp(`<a href="([^"]*)"\\s*>\\s*${label}\\s*</a`).exec(body);
    return match?.[1]?.replaceAll('&amp;', '&');
  };
  // the body rows of the one table on the page
  const rowsOf = (body: string): string[] => body.split('<tr>').slice(2);

  it('marks Токены as the current page and carries the login', async () => {
    const response = await get('/admin/tokens', withCookie);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/<a href="\/admin\/tokens"\s+aria-current="page"/);
    expect(response.body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(response.body).toContain(`ada — ${TEXTS.logoutSubmit}`);
  });

  it('asks for the whole list when every field of the form was left empty', async () => {
    const response = await get('/admin/tokens?kind=&user=', withCookie);

    expect(response.statusCode).toBe(200);
    expect(calls.tokens).toEqual([[TOKEN, {}]]);
  });

  it('offers every kind in the form, an empty option first, and selects the filter', async () => {
    const response = await get('/admin/tokens?kind=settle', withCookie);

    const options = [...response.body.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(['', ...Object.values(TokenLedgerKind)]);
    expect(response.body).toMatch(/<option value="settle"\s+selected/);
    expect(response.body.match(/\sselected/g)).toHaveLength(1);
    expect(calls.tokens).toEqual([[TOKEN, { kind: 'settle' }]]);
  });

  it('carries both filters and the cursor through the next link, and keeps them in the form', async () => {
    await app.close();
    app = build({
      tokens: (token, query) => {
        calls.tokens.push([token, query]);
        return Promise.resolve({ ...SAMPLE_TOKENS, nextCursor: CURSOR });
      },
    });
    const filters = { user: USER, kind: 'bonus' };

    const first = await get(`/admin/tokens?${new URLSearchParams(filters)}`, withCookie);
    expect(first.body).toContain(`name="user" value="${USER}"`);
    expect(first.body).not.toContain(TEXTS.tokensFirst);
    const next = hrefOf(first.body, TEXTS.tokensNext);
    expect(next).toBe(`/admin/tokens?${new URLSearchParams({ ...filters, cursor: CURSOR })}`);
    const second = await get(next ?? '', withCookie);

    expect(calls.tokens.map(([, query]) => query)).toEqual([
      filters,
      { ...filters, cursor: CURSOR },
    ]);
    expect(hrefOf(second.body, TEXTS.tokensFirst)).toBe(
      `/admin/tokens?${new URLSearchParams(filters)}`,
    );
  });

  it('drops a malformed cursor and keeps the filters', async () => {
    const response = await get('/admin/tokens?cursor=bad&kind=bonus', withCookie);

    expect([response.statusCode, response.headers.location]).toEqual([
      302,
      '/admin/tokens?kind=bonus',
    ]);
    expect(calls.tokens).toEqual([]);
  });

  it.each([
    ['an unknown kind, even with a bad cursor', 'cursor=bad&kind=bogus'],
    ['a user of blanks', 'user=%20'],
    ['a user that is not a uuid', 'user=not-a-uuid'],
    ['kind twice', 'kind=bonus&kind=reserve'],
  ])('refuses %s with the form, before the backend is asked', async (_label, query) => {
    const response = await get(`/admin/tokens?${query}`, withCookie);

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(calls.tokens).toEqual([]);
    expect(response.body).toContain(TEXTS.tokensBadFilter);
    expect(response.body).toContain('action="/admin/tokens"');
    // no answer from the backend, so no login to show: the account block is left out
    expect(response.body).toContain('<nav');
    expect(response.body).not.toContain('action="/admin/logout"');
  });

  it('lists a reserve with its intent, an adjustment with its sign, no reference and its note as text', async () => {
    const response = await get('/admin/tokens', withCookie);

    const rows = rowsOf(response.body);
    expect(rows).toHaveLength(2);
    const [reserve = '', adjustment = ''] = rows;
    expect(reserve).toContain(`<a href="/admin/users/${USER}">4242</a>`);
    expect(reserve).toContain('<code>reserve</code>');
    expect(reserve).toContain(
      `<a href="/admin/intents/${SAMPLE_INTENT.id}">${SAMPLE_INTENT.id}</a>`,
    );
    expect(reserve).toMatch(/<td class="num">0<\/td>\s*<td class="num">1<\/td>/);
    expect(adjustment).toContain('<code>adjustment</code>');
    expect(adjustment).toMatch(
      /<td class="num">-3<\/td>\s*<td class="num">0<\/td>\s*<td>\s*—\s*<\/td>/,
    );
    expect(adjustment).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.body).not.toContain(SAMPLE_LEDGER_ADJUSTMENT.note);
    expect(response.body).not.toContain(TEXTS.tokensNext);
    expect(response.body).not.toContain(TEXTS.tokensFirst);
  });

  it('prints a deposit, an account and a manual reference as ids, and none for a missing note', async () => {
    const deposit = '00000000-0000-4000-8000-0000000000d7';
    const account = '00000000-0000-4000-8000-0000000000d8';
    const ref = '00000000-0000-4000-8000-0000000000d9';
    await app.close();
    app = build({
      tokens: () =>
        Promise.resolve({
          ...SAMPLE_TOKENS,
          entries: [
            { ...SAMPLE_LEDGER_ADJUSTMENT, kind: 'purchase', depositEventId: deposit, note: null },
            { ...SAMPLE_LEDGER_ADJUSTMENT, kind: 'bonus', brokerAccountId: account },
            { ...SAMPLE_LEDGER_ADJUSTMENT, refType: 'manual', refId: ref },
          ],
        }),
    });

    const response = await get('/admin/tokens', withCookie);

    const [purchase = '', bonus = '', manual = ''] = rowsOf(response.body);
    expect(purchase).toMatch(
      new RegExp(`<td><code>${deposit}</code></td>\\s*<td>\\s*—\\s*</td>\\s*</tr>`),
    );
    expect(bonus).toContain(`<td><code>${account}</code></td>`);
    expect(manual).toContain(`<td><code>manual:${ref}</code></td>`);
  });

  it('says so when there are no entries, and keeps the filter in the first-page link', async () => {
    await app.close();
    app = build({ tokens: () => Promise.resolve({ ...SAMPLE_TOKENS, entries: [] }) });

    const response = await get(`/admin/tokens?user=${USER}`, withCookie);

    expect(response.body).toContain(TEXTS.tokensEmpty);
    expect(hrefOf(response.body, TEXTS.tokensFirst)).toBe(`/admin/tokens?user=${USER}`);
  });

  it('drops a session the backend no longer knows, and keeps the cookie on its own failure', async () => {
    await app.close();
    app = build({ tokens: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)) });
    const gone = await get('/admin/tokens', withCookie);
    expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(gone, SESSION_COOKIE)?.value).toBe('');

    await app.close();
    app = build({ tokens: () => Promise.reject(httpFailure(500)) });
    const failed = await get('/admin/tokens', withCookie);
    expect(failed.statusCode).toBe(500);
    expect(cookieOf(failed, SESSION_COOKIE)).toBeUndefined();
  });

  it('treats a malformed session cookie as none, before the backend is asked', async () => {
    const response = await get('/admin/tokens', { [SESSION_COOKIE]: 'not-a-session-token' });

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(calls.tokens).toEqual([]);
  });

  it('renders the ledger section of the card after the trading section, with a link to all entries', async () => {
    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    const ledgerAt = response.body.indexOf(`<h2>${TEXTS.userLedger}</h2>`);
    expect(ledgerAt).toBeGreaterThan(response.body.indexOf(`<h2>${TEXTS.userTrading}</h2>`));
    const section = response.body.slice(ledgerAt);
    expect(TEXTS.userLedgerRecent(ADMIN_USER_RECENT_LEDGER)).toBe('Последние 20');
    expect(section).toContain(TEXTS.userLedgerRecent(ADMIN_USER_RECENT_LEDGER));
    expect(section).toContain(`<code>${SAMPLE_LEDGER_ENTRY.kind}</code>`);
    expect(hrefOf(section, TEXTS.userLedgerAll)).toBe(`/admin/tokens?user=${SAMPLE_USER_ID}`);
  });

  it('keeps the section and the link to all entries for a user without ledger rows', async () => {
    await app.close();
    // the deposits section below carries the same caption (#341)
    app = build({
      user: () =>
        Promise.resolve({ ...SAMPLE_USER, ledger: { recent: [] }, deposits: { recent: [] } }),
    });

    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    const section = response.body.slice(response.body.indexOf(`<h2>${TEXTS.userLedger}</h2>`));
    expect(section).toContain(TEXTS.tokensEmpty);
    expect(section).not.toContain(TEXTS.userLedgerRecent(ADMIN_USER_RECENT_LEDGER));
    expect(hrefOf(section, TEXTS.userLedgerAll)).toBe(`/admin/tokens?user=${SAMPLE_USER_ID}`);
  });
});

describe('the audit log page (#110)', () => {
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';
  const ACTOR = SAMPLE_ME.staffId;
  const withCookie = { [SESSION_COOKIE]: TOKEN };
  const FILTERS = {
    action: AuditAction.UserViewed,
    entityType: AuditEntityType.User,
    entityId: SAMPLE_USER_ID,
    actorId: ACTOR,
    from: '2026-10-01',
    to: '2026-10-07',
  };

  // the href of the link whose text is `label`, as a browser would read it back
  const hrefOf = (body: string, label: string): string | undefined => {
    const match = new RegExp(`<a href="([^"]*)"\\s*>\\s*${label}\\s*</a`).exec(body);
    return match?.[1]?.replaceAll('&amp;', '&');
  };
  // the body rows of the one table on the page
  const rowsOf = (body: string): string[] => body.split('<tr>').slice(2);
  const optionsOf = (body: string, name: string): (string | undefined)[] => {
    const select = new RegExp(`<select name="${name}">([\\s\\S]*?)</select>`).exec(body)?.[1] ?? '';
    return [...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  };

  it('marks Аудит as the current page and carries the login', async () => {
    const response = await get('/admin/audit', withCookie);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(
      /<a href="\/admin\/audit"\s+aria-current="page"\s*>\s*Аудит\s*<\/a\s*>/,
    );
    expect(response.body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(response.body).toContain(`ada — ${TEXTS.logoutSubmit}`);
  });

  it('asks for the whole log when every field of the form was left empty', async () => {
    const response = await get('/admin/audit?action=&entityType=&entityId=&from=&to=', withCookie);

    expect(response.statusCode).toBe(200);
    expect(calls.audit).toEqual([[TOKEN, {}]]);
  });

  it('offers every action and every entity type, an empty option first, and selects the filters', async () => {
    const response = await get('/admin/audit?action=staff_logout&entityType=bot_text', withCookie);

    expect(optionsOf(response.body, 'action')).toEqual(['', ...Object.values(AuditAction)]);
    expect(optionsOf(response.body, 'entityType')).toEqual(['', ...Object.values(AuditEntityType)]);
    expect(response.body).toMatch(/<option value="staff_logout"\s+selected/);
    expect(response.body).toMatch(/<option value="bot_text"\s+selected/);
    expect(response.body.match(/\sselected/g)).toHaveLength(2);
  });

  it('carries every filter and the cursor through the next link, and keeps them in the form', async () => {
    await app.close();
    app = build({
      audit: (token, query) => {
        calls.audit.push([token, query]);
        return Promise.resolve({ ...SAMPLE_AUDIT, nextCursor: CURSOR });
      },
    });

    const first = await get(`/admin/audit?${new URLSearchParams(FILTERS)}`, withCookie);
    expect(first.body).toContain(`name="entityId" value="${SAMPLE_USER_ID}"`);
    expect(first.body).toContain('name="from" type="date" value="2026-10-01"');
    expect(first.body).toContain('name="to" type="date" value="2026-10-07"');
    expect(first.body).not.toContain(TEXTS.auditFirst);
    const next = hrefOf(first.body, TEXTS.auditNext);
    expect(next).toBe(`/admin/audit?${new URLSearchParams({ ...FILTERS, cursor: CURSOR })}`);
    const second = await get(next ?? '', withCookie);

    expect(calls.audit.map(([, query]) => query)).toEqual([
      FILTERS,
      { ...FILTERS, cursor: CURSOR },
    ]);
    expect(hrefOf(second.body, TEXTS.auditFirst)).toBe(
      `/admin/audit?${new URLSearchParams(FILTERS)}`,
    );
  });

  it('drops a malformed cursor and keeps the filters', async () => {
    const response = await get('/admin/audit?cursor=bad&action=staff_logout', withCookie);

    expect([response.statusCode, response.headers.location]).toEqual([
      302,
      '/admin/audit?action=staff_logout',
    ]);
    expect(calls.audit).toEqual([]);
  });

  it.each([
    ['an unknown action, even with a bad cursor', 'cursor=bad&action=bogus'],
    ['an unknown action', 'action=bogus'],
    ['an entity id of blanks', 'entityId=%20'],
    ['an actor id that is not a uuid', 'actorId=cli'],
    ['from after to', 'from=2026-10-07&to=2026-10-06'],
    ['action twice', 'action=staff_logout&action=user_viewed'],
  ])('refuses %s with the form, before the backend is asked', async (_label, query) => {
    const response = await get(`/admin/audit?${query}`, withCookie);

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(calls.audit).toEqual([]);
    expect(response.body).toContain(TEXTS.auditBadFilter);
    expect(response.body).toContain('action="/admin/audit"');
    // no answer from the backend, so no login to show: the account block is left out
    expect(response.body).toContain('<nav');
    expect(response.body).not.toContain('action="/admin/logout"');
  });

  it('renders a staff row with links, a system row as text, and an intent row linking its card', async () => {
    const response = await get('/admin/audit', withCookie);

    const [staffRow = '', systemRow = '', intentRow = ''] = rowsOf(response.body);
    expect(staffRow).toContain('ada <code>admin</code>');
    expect(staffRow).toContain(
      `<a href="/admin/audit?actorId=${ACTOR}">${TEXTS.auditActorAll}</a>`,
    );
    expect(staffRow).toContain('<code>user_viewed</code>');
    expect(staffRow).toContain(
      `<code>user</code> <a href="/admin/users/${SAMPLE_USER_ID}">${SAMPLE_USER_ID}</a>`,
    );
    expect(staffRow).toContain(
      '<code class="payload">{&quot;path&quot;: &quot;/admin/users/:id&quot;, &quot;result&quot;: &quot;found&quot;}</code>',
    );
    expect(staffRow).not.toContain(TEXTS.auditPayloadTruncated);

    expect(systemRow).toContain('cli <code>system</code>');
    expect(response.body).not.toContain('href="/admin/audit?actorId=cli"');
    expect(systemRow).toMatch(/<td>\s*— —\s*<\/td>/);
    expect(systemRow).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(systemRow).not.toContain('<script>');
    expect(systemRow).toContain(TEXTS.auditPayloadTruncated);

    expect(intentRow).toContain(
      `<code>trade_intent</code> <a href="/admin/intents/${SAMPLE_INTENT.id}">${SAMPLE_INTENT.id}</a>`,
    );
  });

  it('prints none for a row with neither login nor actor id, and a user type without an id as text', async () => {
    await app.close();
    app = build({
      audit: () =>
        Promise.resolve({
          ...SAMPLE_AUDIT,
          entries: [{ ...SAMPLE_AUDIT_ENTRY_NULLS, actorId: null, entityType: 'user' }],
        }),
    });

    const response = await get('/admin/audit', withCookie);

    const [only = ''] = rowsOf(response.body);
    expect(only).toMatch(/<td>\s*— <code>system<\/code>\s*<\/td>/);
    expect(only).toMatch(/<td>\s*<code>user<\/code> —\s*<\/td>/);
    expect(response.body).not.toContain('href="/admin/users/null"');
  });

  it('shows the actor filter with a reset link and a hidden field only when it is set', async () => {
    const filtered = await get(`/admin/audit?actorId=${ACTOR}&action=staff_logout`, withCookie);
    expect(filtered.body).toContain(TEXTS.auditActorFilter(ACTOR));
    expect(filtered.body).toContain(`<input type="hidden" name="actorId" value="${ACTOR}"`);
    expect(hrefOf(filtered.body, TEXTS.auditActorReset)).toBe('/admin/audit?action=staff_logout');

    const plain = await get('/admin/audit', withCookie);
    expect(plain.body).not.toContain(TEXTS.auditActorFilter(ACTOR));
    expect(plain.body).not.toContain('name="actorId"');
  });

  it('says so when there are no entries, and keeps the filters in the first-page link', async () => {
    await app.close();
    app = build({ audit: () => Promise.resolve({ ...SAMPLE_AUDIT, entries: [] }) });

    const response = await get('/admin/audit?action=staff_logout', withCookie);

    expect(response.body).toContain(TEXTS.auditEmpty);
    expect(hrefOf(response.body, TEXTS.auditFirst)).toBe('/admin/audit?action=staff_logout');
  });

  it.each([
    ['with accounts and rows', SAMPLE_USER],
    [
      'without accounts or rows',
      {
        ...SAMPLE_USER,
        brokerAccounts: [],
        intents: { recent: [], total: 0, active: 0 },
        ledger: { recent: [] },
        deposits: { recent: [] },
      },
    ],
  ])('links the user card %s to the audit of that user', async (_label, user) => {
    await app.close();
    app = build({ user: () => Promise.resolve(user) });

    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    const section = response.body.slice(response.body.indexOf(`<h2>${TEXTS.userAudit}</h2>`));
    expect(section.length).toBeLessThan(response.body.length);
    expect(hrefOf(section, TEXTS.userAuditAll)).toBe(
      `/admin/audit?entityType=user&entityId=${SAMPLE_USER_ID}`,
    );
  });

  it('drops a session the backend no longer knows, and keeps the cookie on its own failure', async () => {
    await app.close();
    app = build({ audit: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)) });
    const gone = await get('/admin/audit', withCookie);
    expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(gone, SESSION_COOKIE)?.value).toBe('');

    await app.close();
    app = build({ audit: () => Promise.reject(httpFailure(500)) });
    const failed = await get('/admin/audit', withCookie);
    expect(failed.statusCode).toBe(500);
    expect(cookieOf(failed, SESSION_COOKIE)).toBeUndefined();
  });

  it('treats a malformed session cookie as none, before the backend is asked', async () => {
    const response = await get('/admin/audit', { [SESSION_COOKIE]: 'not-a-session-token' });

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(calls.audit).toEqual([]);
  });
});

describe('the deposits page and the card section (#341)', () => {
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';
  const USER = SAMPLE_USER_ID;
  const withCookie = { [SESSION_COOKIE]: TOKEN };

  // the href of the link whose text is `label`, as a browser would read it back
  const hrefOf = (body: string, label: string): string | undefined => {
    const match = new RegExp(`<a href="([^"]*)"\\s*>\\s*${label}\\s*</a`).exec(body);
    return match?.[1]?.replaceAll('&amp;', '&');
  };
  // the body rows of the one table on the page
  const rowsOf = (body: string): string[] => body.split('<tr>').slice(2);
  // the cells of a row, whitespace inside each trimmed
  const cellsOf = (row: string): string[] =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => (m[1] ?? '').trim());

  it('marks Депозиты as the current page, right before «Брокерские аккаунты», and carries the login', async () => {
    const response = await get('/admin/deposits', withCookie);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/<a href="\/admin\/deposits"\s+aria-current="page"/);
    expect(response.body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(response.body).toContain(`ada — ${TEXTS.logoutSubmit}`);
    const nav = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(response.body)?.[1] ?? '';
    expect(nav.trimEnd()).toMatch(
      /aria-current="page"\s*>\s*Депозиты\s*<\/a\s*>\s*<a href="\/admin\/broker-accounts"\s*>\s*Брокерские аккаунты\s*<\/a\s*>$/,
    );
  });

  it('asks for the whole list when every field of the form was left empty', async () => {
    const response = await get('/admin/deposits?status=&user=', withCookie);

    expect(response.statusCode).toBe(200);
    expect(calls.deposits).toEqual([[TOKEN, {}]]);
  });

  it('offers every status in the form, an empty option first, and selects the filter', async () => {
    const response = await get('/admin/deposits?status=credited', withCookie);

    const options = [...response.body.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(['', ...Object.values(DepositEventStatus)]);
    expect(response.body).toMatch(/<option value="credited"\s+selected/);
    expect(response.body.match(/\sselected/g)).toHaveLength(1);
    expect(calls.deposits).toEqual([[TOKEN, { status: 'credited' }]]);
  });

  it('carries both filters and the cursor through the next link, and keeps them in the form', async () => {
    await app.close();
    app = build({
      deposits: (token, query) => {
        calls.deposits.push([token, query]);
        return Promise.resolve({ ...SAMPLE_DEPOSITS, nextCursor: CURSOR });
      },
    });
    const filters = { user: USER, status: 'credited' };

    const first = await get(`/admin/deposits?${new URLSearchParams(filters)}`, withCookie);
    expect(first.body).toContain(`name="user" value="${USER}"`);
    expect(first.body).not.toContain(TEXTS.depositsFirst);
    const next = hrefOf(first.body, TEXTS.depositsNext);
    expect(next).toBe(`/admin/deposits?${new URLSearchParams({ ...filters, cursor: CURSOR })}`);
    const second = await get(next ?? '', withCookie);

    expect(calls.deposits.map(([, query]) => query)).toEqual([
      filters,
      { ...filters, cursor: CURSOR },
    ]);
    expect(hrefOf(second.body, TEXTS.depositsFirst)).toBe(
      `/admin/deposits?${new URLSearchParams(filters)}`,
    );
  });

  it('drops a malformed cursor and keeps the filters', async () => {
    const response = await get('/admin/deposits?cursor=bad&status=credited', withCookie);

    expect([response.statusCode, response.headers.location]).toEqual([
      302,
      '/admin/deposits?status=credited',
    ]);
    expect(calls.deposits).toEqual([]);
  });

  it.each([
    ['an unknown status, even with a bad cursor', 'cursor=bad&status=bogus'],
    ['an unknown status', 'status=bogus'],
    ['a user of blanks', 'user=%20'],
    ['a user that is not a uuid', 'user=not-a-uuid'],
    ['status twice', 'status=credited&status=failed'],
  ])('refuses %s with the form, before the backend is asked', async (_label, query) => {
    const response = await get(`/admin/deposits?${query}`, withCookie);

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(calls.deposits).toEqual([]);
    expect(response.body).toContain(TEXTS.depositsBadFilter);
    expect(response.body).toContain('action="/admin/deposits"');
    // no answer from the backend, so no login to show: the account block is left out
    expect(response.body).toContain('<nav');
    expect(response.body).not.toContain('action="/admin/logout"');
  });

  it("lists an owned deposit with its owner's link and the amount as sent, an unowned one with none", async () => {
    const response = await get('/admin/deposits', withCookie);

    const rows = rowsOf(response.body);
    expect(rows).toHaveLength(2);
    const [owned = '', unowned = ''] = rows;
    expect(cellsOf(owned)).toEqual([
      `<time datetime="${SAMPLE_DEPOSIT.createdAt}">${SAMPLE_DEPOSIT.createdAt}</time>`,
      `<a href="/admin/users/${USER}">4242</a>`,
      `<code>${SAMPLE_DEPOSIT.brokerAccountId}</code>`,
      '<code>broker-7</code>',
      '<code>pay-1</code>',
      '10.50000000',
      'USD',
      '<code>credited</code>',
      `<time datetime="${SAMPLE_DEPOSIT.processedAt}">${SAMPLE_DEPOSIT.processedAt}</time>`,
    ]);
    expect(owned).toContain('<td class="num">10.50000000</td>');
    expect(cellsOf(unowned)).toEqual([
      `<time datetime="${SAMPLE_DEPOSIT_UNOWNED.createdAt}">${SAMPLE_DEPOSIT_UNOWNED.createdAt}</time>`,
      TEXTS.none,
      TEXTS.none,
      '<code>trader-&lt;b&gt;</code>',
      '<code>pay-2</code>',
      '5.00000000',
      TEXTS.none,
      '<code>received</code>',
      TEXTS.none,
    ]);
    expect(response.body).not.toContain(SAMPLE_DEPOSIT_UNOWNED.brokerUserId);
    expect(response.body).not.toContain(TEXTS.depositsNext);
    expect(response.body).not.toContain(TEXTS.depositsFirst);
  });

  it('prints none for the owner of a deposit that names only an account, and the account id', async () => {
    await app.close();
    app = build({
      deposits: () =>
        Promise.resolve({
          ...SAMPLE_DEPOSITS,
          deposits: [{ ...SAMPLE_DEPOSIT, userId: null, telegramUserId: null }],
        }),
    });

    const response = await get('/admin/deposits', withCookie);

    const [row = ''] = rowsOf(response.body);
    const cells = cellsOf(row);
    expect(cells[1]).toBe(TEXTS.none);
    expect(cells[2]).toBe(`<code>${SAMPLE_DEPOSIT.brokerAccountId}</code>`);
    expect(row).not.toContain('/admin/users/');
  });

  it('says so when there are no deposits, and keeps the filter in the form and the first-page link', async () => {
    await app.close();
    app = build({ deposits: () => Promise.resolve({ ...SAMPLE_DEPOSITS, deposits: [] }) });

    const response = await get(`/admin/deposits?user=${USER}`, withCookie);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(TEXTS.depositsEmpty);
    expect(response.body).toContain(`name="user" value="${USER}"`);
    expect(hrefOf(response.body, TEXTS.depositsFirst)).toBe(`/admin/deposits?user=${USER}`);
  });

  it('drops a session the backend no longer knows, and keeps the cookie on its own failure', async () => {
    await app.close();
    app = build({
      deposits: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
    });
    const gone = await get('/admin/deposits', withCookie);
    expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(gone, SESSION_COOKIE)?.value).toBe('');

    await app.close();
    app = build({ deposits: () => Promise.reject(httpFailure(500)) });
    const failed = await get('/admin/deposits', withCookie);
    expect(failed.statusCode).toBe(500);
    expect(cookieOf(failed, SESSION_COOKIE)).toBeUndefined();
  });

  it('treats a malformed session cookie as none, before the backend is asked', async () => {
    const response = await get('/admin/deposits', { [SESSION_COOKIE]: 'not-a-session-token' });

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(calls.deposits).toEqual([]);
  });

  it('renders the deposits section of the card between the ledger and the audit, with a link to all deposits', async () => {
    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    const ledgerAt = response.body.indexOf(`<h2>${TEXTS.userLedger}</h2>`);
    const depositsAt = response.body.indexOf(`<h2>${TEXTS.userDeposits}</h2>`);
    const auditAt = response.body.indexOf(`<h2>${TEXTS.userAudit}</h2>`);
    expect(ledgerAt).toBeGreaterThan(-1);
    expect(depositsAt).toBeGreaterThan(ledgerAt);
    expect(auditAt).toBeGreaterThan(depositsAt);
    const section = response.body.slice(depositsAt, auditAt);
    expect(section).toContain(TEXTS.userDepositsRecent(ADMIN_USER_RECENT_LEDGER));
    expect(section).toContain('<code>broker-7</code>');
    expect(section).toContain('<td class="num">10.50000000</td>');
    expect(hrefOf(section, TEXTS.userDepositsAll)).toBe(`/admin/deposits?user=${SAMPLE_USER_ID}`);
  });

  it('keeps the section and the link to all deposits for a user without deposits', async () => {
    await app.close();
    app = build({ user: () => Promise.resolve({ ...SAMPLE_USER, deposits: { recent: [] } }) });

    const response = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);

    const section = response.body.slice(
      response.body.indexOf(`<h2>${TEXTS.userDeposits}</h2>`),
      response.body.indexOf(`<h2>${TEXTS.userAudit}</h2>`),
    );
    expect(section).toContain(TEXTS.depositsEmpty);
    expect(section).not.toContain(TEXTS.userDepositsRecent(ADMIN_USER_RECENT_LEDGER));
    expect(hrefOf(section, TEXTS.userDepositsAll)).toBe(`/admin/deposits?user=${SAMPLE_USER_ID}`);
  });
});

describe('the broker accounts page (#342)', () => {
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';
  const withCookie = { [SESSION_COOKIE]: TOKEN };

  const hrefOf = (body: string, label: string): string | undefined => {
    const match = new RegExp(`<a href="([^"]*)"\\s*>\\s*${label}\\s*</a`).exec(body);
    return match?.[1]?.replaceAll('&amp;', '&');
  };
  const rowsOf = (body: string): string[] => body.split('<tr>').slice(2);
  const cellsOf = (row: string): string[] =>
    [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => (m[1] ?? '').trim());
  const time = (iso: string) => `<time datetime="${iso}">${iso}</time>`;
  const CHECKBOX_UNCHECKED = /<input\s+type="checkbox"\s+name="halted"\s+value="true"\s*\/>/;
  const CHECKBOX_CHECKED =
    /<input\s+type="checkbox"\s+name="halted"\s+value="true"\s+checked\s*\/>/;

  it('marks «Брокерские аккаунты» as the current page, last in the nav, and carries the login', async () => {
    const response = await get('/admin/broker-accounts', withCookie);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/<a href="\/admin\/broker-accounts"\s+aria-current="page"/);
    expect(response.body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(response.body).toContain(`ada — ${TEXTS.logoutSubmit}`);
    const nav = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(response.body)?.[1] ?? '';
    expect(nav.trimEnd()).toMatch(/>\s*Брокерские аккаунты\s*<\/a\s*>$/);
  });

  it.each([
    ['every field left empty', 'status='],
    ['a blank halted', 'halted='],
    ['both blank', 'status=&halted='],
  ])('asks for the whole list with %s', async (_label, query) => {
    const response = await get(`/admin/broker-accounts?${query}`, withCookie);

    expect(response.statusCode).toBe(200);
    expect(calls.brokerAccounts).toEqual([[TOKEN, {}]]);
  });

  it('offers every status by its code with the Russian label, an empty option first, and selects the filter', async () => {
    const response = await get('/admin/broker-accounts?status=revoked', withCookie);

    const options = [...response.body.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map(
      (m) => [m[1], m[2]],
    );
    expect(options).toEqual([
      ['', TEXTS.brokerAccountsFilterAny],
      ...Object.values(BrokerAccountStatus).map((s) => [s, TEXTS.accountStatus[s]]),
    ]);
    expect(response.body).toMatch(/<option value="revoked"\s+selected/);
    expect(response.body.match(/\sselected/g)).toHaveLength(1);
    expect(response.body).toMatch(CHECKBOX_UNCHECKED);
    expect(calls.brokerAccounts).toEqual([[TOKEN, { status: 'revoked' }]]);
  });

  it('carries both filters and the cursor through the next link, and keeps them in the form', async () => {
    await app.close();
    app = build({
      brokerAccounts: (token, query) => {
        calls.brokerAccounts.push([token, query]);
        return Promise.resolve({ ...SAMPLE_BROKER_ACCOUNTS, nextCursor: CURSOR });
      },
    });
    const filters = { status: 'active', halted: 'true' };

    const first = await get(`/admin/broker-accounts?${new URLSearchParams(filters)}`, withCookie);
    expect(first.body).toMatch(/<option value="active"\s+selected/);
    expect(first.body).toMatch(CHECKBOX_CHECKED);
    expect(first.body).not.toContain(TEXTS.brokerAccountsFirst);
    const next = hrefOf(first.body, TEXTS.brokerAccountsNext);
    expect(next).toBe(
      `/admin/broker-accounts?${new URLSearchParams({ ...filters, cursor: CURSOR })}`,
    );
    const second = await get(next ?? '', withCookie);

    expect(calls.brokerAccounts.map(([, query]) => query)).toEqual([
      filters,
      { ...filters, cursor: CURSOR },
    ]);
    expect(hrefOf(second.body, TEXTS.brokerAccountsFirst)).toBe(
      `/admin/broker-accounts?${new URLSearchParams(filters)}`,
    );
  });

  it('drops a malformed cursor and keeps the filters', async () => {
    const response = await get('/admin/broker-accounts?cursor=bad&status=active', withCookie);

    expect([response.statusCode, response.headers.location]).toEqual([
      302,
      '/admin/broker-accounts?status=active',
    ]);
    expect(calls.brokerAccounts).toEqual([]);
  });

  it.each([
    ['a halted from a checkbox without a value, even with a bad cursor', 'cursor=bad&halted=on'],
    ['a halted from a checkbox without a value', 'halted=on'],
    ['halted false', 'halted=false'],
    ['halted twice', 'halted=true&halted=true'],
    ['an unknown status', 'status=bogus'],
    ['status twice', 'status=active&status=revoked'],
  ])('refuses %s with the form, before the backend is asked', async (_label, query) => {
    const response = await get(`/admin/broker-accounts?${query}`, withCookie);

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(calls.brokerAccounts).toEqual([]);
    expect(response.body).toContain(TEXTS.brokerAccountsBadFilter);
    expect(response.body).toContain('action="/admin/broker-accounts"');
    // no answer from the backend, so no login to show: the account block is left out
    expect(response.body).toContain('<nav');
    expect(response.body).not.toContain('action="/admin/logout"');
  });

  it("lists each account with its owner's link, its id, the status label and none for what is empty", async () => {
    const response = await get('/admin/broker-accounts', withCookie);

    const [headRow = ''] = response.body.split('<tr>').slice(1);
    expect(headRow).toMatch(
      new RegExp(`^\\s*<th>${TEXTS.columnTelegramId}</th>\\s*<th>${TEXTS.columnAccountId}</th>`),
    );
    const rows = rowsOf(response.body);
    expect(rows).toHaveLength(2);
    const [halted = '', active = ''] = rows;
    const h = SAMPLE_BROKER_ACCOUNT_HALTED;
    expect(cellsOf(halted)).toEqual([
      `<a href="/admin/users/${SAMPLE_USER_ID}">4242</a>`,
      `<code>${h.id}</code>`,
      'broker-&lt;b&gt;',
      TEXTS.none,
      TEXTS.no,
      TEXTS.accountStatus.revoked,
      'refresh_invalid_grant',
      TEXTS.yes,
      'trade_mismatch',
      time(h.accessTokenExpiresAt),
      TEXTS.none,
      time(h.createdAt),
      time(h.updatedAt),
    ]);
    const a = SAMPLE_BROKER_ACCOUNT_ITEM;
    expect(cellsOf(active)).toEqual([
      `<a href="/admin/users/${SAMPLE_USER_ID}">4242</a>`,
      `<code>${a.id}</code>`,
      'broker-7',
      'ada@example.com',
      TEXTS.yes,
      TEXTS.accountStatus.active,
      TEXTS.none,
      TEXTS.no,
      TEXTS.none,
      time(a.accessTokenExpiresAt),
      TEXTS.none,
      time(a.createdAt),
      time(a.updatedAt),
    ]);
    expect(response.body).not.toContain(h.brokerUserId);
    expect(response.body).not.toContain(TEXTS.brokerAccountsNext);
    expect(response.body).not.toContain(TEXTS.brokerAccountsFirst);
  });

  it('says so when there are no accounts, and keeps the filter in the form and the first-page link', async () => {
    await app.close();
    app = build({
      brokerAccounts: () => Promise.resolve({ ...SAMPLE_BROKER_ACCOUNTS, accounts: [] }),
    });

    const response = await get('/admin/broker-accounts?halted=true', withCookie);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`<p>${TEXTS.brokerAccountsEmpty}</p>`);
    expect(response.body).not.toContain('<table');
    expect(response.body).toMatch(CHECKBOX_CHECKED);
    expect(hrefOf(response.body, TEXTS.brokerAccountsFirst)).toBe(
      '/admin/broker-accounts?halted=true',
    );
  });

  it('drops a session the backend no longer knows, and keeps the cookie on its own failure', async () => {
    await app.close();
    app = build({
      brokerAccounts: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
    });
    const gone = await get('/admin/broker-accounts', withCookie);
    expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(gone, SESSION_COOKIE)?.value).toBe('');

    await app.close();
    app = build({ brokerAccounts: () => Promise.reject(httpFailure(500)) });
    const failed = await get('/admin/broker-accounts', withCookie);
    expect(failed.statusCode).toBe(500);
    expect(cookieOf(failed, SESSION_COOKIE)).toBeUndefined();
  });

  it('treats a malformed session cookie as none, before the backend is asked', async () => {
    const response = await get('/admin/broker-accounts', {
      [SESSION_COOKIE]: 'not-a-session-token',
    });

    expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
    expect(calls.brokerAccounts).toEqual([]);
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

describe('the password page (#79)', () => {
  const withCookie = { [SESSION_COOKIE]: TOKEN };
  const CURRENT = 'CURRENT-SECRET';
  const NEW = 'NEW-SECRET';
  const OTHER = 'OTHER-SECRET';
  const SECRETS = [CURRENT, NEW, OTHER];
  const valid = { currentPassword: CURRENT, newPassword: NEW, newPasswordRepeat: NEW };
  const ADA_ELSEWHERE: StaffSessionView = {
    ...VIEW,
    id: '00000000-0000-4000-8000-0000000000c1',
    current: false,
  };
  const BOB: StaffSessionView = {
    ...VIEW,
    id: '00000000-0000-4000-8000-0000000000c2',
    login: 'bob',
    current: false,
  };

  const rebuild = async (backend: Partial<BackendClient>) => {
    await app.close();
    app = build(backend);
  };
  const expectNoSecret = (text: string) => {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  };
  const expectFormWithoutAccount = (body: string, message: string) => {
    expect(body).toContain(message);
    expect(body).toContain('action="/admin/password"');
    expect(body).toContain('<nav');
    expect(body).not.toContain(TEXTS.logoutSubmit);
    expectNoSecret(body);
  };
  const postRaw = (payload: string) =>
    app.inject({
      method: 'POST',
      url: '/admin/password',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload,
      cookies: withCookie,
    });

  describe('GET', () => {
    it('renders the form under the login, counting only the caller’s other sessions', async () => {
      await rebuild({
        sessions: async (token) => {
          calls.sessions.push(token);
          return {
            me: { staffId: VIEW.id, login: 'ada', sessionId: VIEW.id },
            sessions: [VIEW, ADA_ELSEWHERE, BOB],
          };
        },
      });

      const response = await get('/admin/password', withCookie);

      expect(response.statusCode).toBe(200);
      expect(calls.sessions).toEqual([TOKEN]);
      expect(response.body).toContain(`ada — ${TEXTS.logoutSubmit}`);
      expect(response.body).toContain(`<a href="/admin/password">${TEXTS.passwordLink}</a>`);
      expect(response.body).toContain(TEXTS.passwordRevokesOthers(1));
      for (const [name, autocomplete] of [
        ['currentPassword', 'current-password'],
        ['newPassword', 'new-password'],
        ['newPasswordRepeat', 'new-password'],
      ]) {
        expect(response.body).toMatch(
          new RegExp(
            `<input\\s+name="${name}"\\s+type="password"\\s+autocomplete="${autocomplete}"\\s+required\\s*/>`,
          ),
        );
      }
      expect(response.body).not.toContain('value=');
    });

    it('says there is no other session when the caller has none', async () => {
      const response = await get('/admin/password', withCookie);
      expect(response.body).toContain(TEXTS.noOtherSessions);
    });

    it.each(['/admin/sessions', '/admin/overview', '/admin/audit'])(
      '%s links to the password page from the account block',
      async (url) => {
        const response = await get(url, withCookie);
        expect(response.body).toContain(`<a href="/admin/password">${TEXTS.passwordLink}</a>`);
      },
    );

    it('leaves the link out with the account block of a page built without the backend', async () => {
      const response = await get(
        `/admin/users?q=${'x'.repeat(ADMIN_SEARCH_MAX_LENGTH + 1)}`,
        withCookie,
      );
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(TEXTS.passwordLink);
    });

    it('sends no cookie to login, and clears one of the wrong shape, before the backend is asked', async () => {
      const none = await get('/admin/password');
      expect([none.statusCode, none.headers.location]).toEqual([302, '/admin/login']);
      const malformed = await get('/admin/password', { [SESSION_COOKIE]: 'not-a-session-token' });
      expect([malformed.statusCode, malformed.headers.location]).toEqual([302, '/admin/login']);
      expect(cookieOf(malformed, SESSION_COOKIE)?.value).toBe('');
      expect(calls.sessions).toEqual([]);
    });

    it.each([
      ['0', 0],
      ['3', 3],
      ['9007199254740991', 9007199254740991],
    ])('shows the result for ?changed=%s', async (query, count) => {
      const response = await get(`/admin/password?changed=${query}`, withCookie);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(TEXTS.passwordChanged(count));
    });

    it.each([
      'changed=9007199254740992',
      'changed=2&changed=2',
      'changed=x',
      'changed=-1',
      'changed=',
    ])('shows no result for ?%s', async (query) => {
      const response = await get(`/admin/password?${query}`, withCookie);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(TEXTS.passwordChanged(0).split(':')[0]);
    });

    it('clears the cookie of a session that is gone, and keeps it when our bearer is refused', async () => {
      await rebuild({
        sessions: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
      });
      const gone = await get('/admin/password', withCookie);
      expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);
      expect(cookieOf(gone, SESSION_COOKIE)?.value).toBe('');

      await rebuild({
        sessions: () => Promise.reject(httpFailure(401, AdminErrorCode.Unauthorized)),
      });
      const refused = await get('/admin/password', withCookie);
      expect(refused.statusCode).toBe(500);
      expect(refused.body).toContain(TEXTS.errorBody);
      expect(refused.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('POST', () => {
    it('changes the password with one backend call and redirects to the count it revoked', async () => {
      const response = await post('/admin/password', valid, withCookie);

      expect([response.statusCode, response.headers.location]).toEqual([
        303,
        '/admin/password?changed=3',
      ]);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(calls.changePassword).toEqual([
        [
          TOKEN,
          {
            currentPassword: CURRENT,
            newPassword: NEW,
            ip: expect.any(String),
            userAgent: INJECTED_AGENT,
          },
        ],
      ]);
      expect(adminChangePasswordRequestSchema.safeParse(calls.changePassword[0]?.[1]).success).toBe(
        true,
      );
      expect(calls.sessions).toEqual([]);
    });

    it('carries a count of zero into the redirect', async () => {
      await rebuild({ changePassword: async () => ({ changed: true, revokedSessions: 0 }) });
      const response = await post('/admin/password', valid, withCookie);
      expect(response.headers.location).toBe('/admin/password?changed=0');
    });

    it('refuses two different new passwords before the backend is asked', async () => {
      const response = await post(
        '/admin/password',
        { ...valid, newPasswordRepeat: OTHER },
        withCookie,
      );

      expect(response.statusCode).toBe(400);
      expectFormWithoutAccount(response.body, TEXTS.passwordMismatch);
      expect(calls.changePassword).toEqual([]);
      expect(calls.sessions).toEqual([]);
    });

    it('refuses a new password equal to the current one, by the shared schema', async () => {
      const response = await post(
        '/admin/password',
        { currentPassword: CURRENT, newPassword: CURRENT, newPasswordRepeat: CURRENT },
        withCookie,
      );

      expect(response.statusCode).toBe(400);
      expectFormWithoutAccount(response.body, TEXTS.passwordSameAsCurrent);
      expect(calls.changePassword).toEqual([]);
    });

    const long = 'x'.repeat(257);
    it.each([
      ['an empty new password', 'currentPassword=c&newPassword=&newPasswordRepeat='],
      [
        'a new password over the bound',
        `currentPassword=c&newPassword=${long}&newPasswordRepeat=${long}`,
      ],
      [
        'two equal passwords over the bound',
        `currentPassword=${long}&newPassword=${long}&newPasswordRepeat=${long}`,
      ],
      [
        'a field sent twice',
        `currentPassword=${CURRENT}&currentPassword=${OTHER}&newPassword=${NEW}&newPasswordRepeat=${NEW}`,
      ],
    ])('refuses %s as a bad request', async (_label, payload) => {
      const response = await postRaw(payload);

      expect(response.statusCode).toBe(400);
      expectFormWithoutAccount(response.body, TEXTS.badRequest);
      expect(response.body).not.toContain(TEXTS.passwordSameAsCurrent);
      expect(calls.changePassword).toEqual([]);
    });

    it('answers a wrong current password with the form, keeping the session', async () => {
      await rebuild({
        changePassword: () => Promise.reject(httpFailure(401, AdminErrorCode.InvalidCredentials)),
      });
      const response = await post('/admin/password', valid, withCookie);

      expect(response.statusCode).toBe(401);
      expectFormWithoutAccount(response.body, TEXTS.invalidCurrentPassword);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(calls.sessions).toEqual([]);
    });

    it('answers a lockout with the form', async () => {
      await rebuild({
        changePassword: () => Promise.reject(httpFailure(429, AdminErrorCode.TooManyAttempts)),
      });
      const response = await post('/admin/password', valid, withCookie);

      expect(response.statusCode).toBe(429);
      expectFormWithoutAccount(response.body, TEXTS.tooManyAttempts);
    });

    it.each([
      ['401 unauthorized', httpFailure(401, AdminErrorCode.Unauthorized)],
      ['400 validation', httpFailure(400, AdminErrorCode.Validation)],
      ['404', httpFailure(404)],
      ['429 without the code', httpFailure(429)],
    ])('treats %s as our own failure, keeping the cookie', async (_label, failure) => {
      await rebuild({ changePassword: () => Promise.reject(failure) });
      const response = await post('/admin/password', valid, withCookie);

      expect(response.statusCode).toBe(500);
      expect(response.body).toContain(TEXTS.errorBody);
      expect(response.body).not.toContain(TEXTS.outcomeUnknownBody);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('sends a session that is gone to login', async () => {
      await rebuild({
        changePassword: () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
      });
      const response = await post('/admin/password', valid, withCookie);

      expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/login']);
      expect(cookieOf(response, SESSION_COOKIE)?.value).toBe('');
    });

    it.each([
      [
        'unreachable',
        new BackendError(BackendErrorCode.Unreachable),
        { name: 'BackendError', code: 'unreachable' },
      ],
      [
        'a 2xx outside the contract',
        new BackendError(BackendErrorCode.ContractViolation),
        { name: 'BackendError', code: 'contract_violation' },
      ],
      ['a 502', httpFailure(502), { name: 'BackendError', code: 'http_status' }],
      ['a throw', new Error(`backend said: ${NEW}`), { name: 'Error' }],
    ])('says the outcome is unknown when %s, keeping the cookie', async (_label, failure, err) => {
      await rebuild({ changePassword: () => Promise.reject(failure) });
      const response = await post('/admin/password', valid, withCookie);

      expect(response.statusCode).toBe(500);
      expect(response.body).toContain(TEXTS.outcomeUnknownBody);
      expect(response.body).not.toContain(TEXTS.errorBody);
      expect(response.headers['set-cookie']).toBeUndefined();
      const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const entry = logged.find((line) => line.msg === 'the password change outcome is unknown');
      expect(entry?.err).toEqual(err);
      expectNoSecret(response.body);
    });

    it('sends no cookie to login, and clears one of the wrong shape, before the backend is asked', async () => {
      const none = await post('/admin/password', valid);
      expect([none.statusCode, none.headers.location]).toEqual([302, '/admin/login']);
      const malformed = await post('/admin/password', valid, {
        [SESSION_COOKIE]: 'not-a-session-token',
      });
      expect([malformed.statusCode, malformed.headers.location]).toEqual([302, '/admin/login']);
      expect(cookieOf(malformed, SESSION_COOKIE)?.value).toBe('');
      expect(calls.changePassword).toEqual([]);
    });
  });

  it('writes none of the passwords or the cookie to the log', async () => {
    await post('/admin/password', valid, withCookie);
    await post('/admin/password', { ...valid, newPasswordRepeat: OTHER }, withCookie);
    await rebuild({
      changePassword: () => Promise.reject(httpFailure(401, AdminErrorCode.InvalidCredentials)),
    });
    await post('/admin/password', valid, withCookie);
    const kept = [...lines];
    await rebuild({ changePassword: () => Promise.reject(new Error(`backend said: ${NEW}`)) });
    await post('/admin/password', valid, withCookie);

    const all = [...kept, ...lines].join('');
    expect(all).toContain('the password change outcome is unknown');
    expectNoSecret(all);
    expect(all).not.toContain(TOKEN);
  });
});

describe('the bot texts pages (#300)', () => {
  const withCookie = { [SESSION_COOKIE]: TOKEN };
  const form = (version = '7', source = 'Привет') => ({ source, version });
  const rebuild = async (backend: Partial<BackendClient>) => {
    await app.close();
    app = build(backend);
  };
  const answering = (outcome: Record<string, unknown>) =>
    ({ me: SAMPLE_ME, text: SAMPLE_BOT_TEXT, ...outcome }) as never;
  const textareaOf = (body: string) => /<textarea[^>]*>([\s\S]*?)<\/textarea/.exec(body)?.[1];
  const versionsOf = (body: string) =>
    [...body.matchAll(/name="version" value="(\d+)"/g)].map((match) => match[1]);

  // «Депозиты» (#341) and «Брокерские аккаунты» (#342) were appended after it
  it('W1 puts «Тексты бота» in the nav right before «Депозиты» and marks it current', async () => {
    const response = await get('/admin/bot-texts', withCookie);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(
      /<a href="\/admin\/bot-texts"\s+aria-current="page"\s*>\s*Тексты бота\s*<\/a\s*>\s*<a href="\/admin\/deposits"\s*>\s*Депозиты\s*<\/a\s*>\s*<a href="\/admin\/broker-accounts"\s*>\s*Брокерские аккаунты\s*<\/a\s*>\s*<\/nav>/,
    );
  });

  it('W2 lists the groups in catalog order with each key state, and the orphans with «Удалить»', async () => {
    const { body } = await get('/admin/bot-texts', withCookie);
    const titles = Object.values(BotTextGroup).map((group) =>
      body.indexOf(`<h2>${BOT_TEXT_GROUP_TITLES[group]}</h2>`),
    );
    expect(titles.every((at, index) => at > (titles[index - 1] ?? -1))).toBe(true);
    expect(body).toContain('<a href="/admin/bot-texts/welcome">welcome</a>');
    expect(body).toContain(BOT_TEXT_CATALOG.welcome.description);
    expect(body).toContain(TEXTS.botTextChanged(7, 'ada'));
    expect(body).toContain(TEXTS.botTextChanged(3, null));
    expect(body).toContain(TEXTS.botTextRejected('Пустой текст'));
    expect(body).not.toContain('Только чтение');
    // #361: one hint and one «Опубликовать заново», right above the command descriptions
    const republish = '<form method="post" action="/admin/bot-texts/publish">';
    expect(body.split(republish)).toHaveLength(2);
    expect(body.split(TEXTS.botProfileHint)).toHaveLength(2);
    const groups = Object.values(BotTextGroup);
    const commandsAt = body.indexOf(`<h2>${BOT_TEXT_GROUP_TITLES[BotTextGroup.Commands]}</h2>`);
    const previous = groups[groups.indexOf(BotTextGroup.Commands) - 1]!;
    expect(body.indexOf(republish)).toBeLessThan(commandsAt);
    expect(body.indexOf(republish)).toBeGreaterThan(
      body.indexOf(`<h2>${BOT_TEXT_GROUP_TITLES[previous]}</h2>`),
    );
    expect(body).not.toContain('class="publish"');
    expect(body).toContain(TEXTS.botTextOrphansHeading);
    expect(body).toMatch(
      /<form method="post" action="\/admin\/bot-texts\/zzz\/reset">\s*<input type="hidden" name="version" value="9" \/>/,
    );
    const removed = await get('/admin/bot-texts?notice=removed', withCookie);
    expect(removed.body).toContain(TEXTS.botTextsNotice.removed);
    const junk = await get('/admin/bot-texts?notice=toString', withCookie);
    expect(junk.body).not.toContain('class="notice"');

    const republished = await get(
      `/admin/bot-texts?notice=republished&publish=${SAMPLE_PUBLISHED_QUERY}`,
      withCookie,
    );
    expect(republished.body).toContain(TEXTS.botTextsNotice.republished);
    expect(republished.body).toMatch(
      /<li>\s*Меню команд \(setMyCommands\):\s*опубликовано\s*<\/li>/,
    );
    expect(republished.body).toMatch(
      /<li class="error">\s*Описание бота \(setMyDescription\):\s*ошибка — GrammyError, Telegram 400\s*<\/li>/,
    );
    expect(republished.body).toContain(TEXTS.botProfilePublishFailedHint);
    expect(republished.body).not.toMatch(/<style|<script/);
    for (const query of ['publish=junk', 'publish=setMyCommands%3Aok&publish=setMyCommands%3Aok']) {
      const ignored = await get(`/admin/bot-texts?notice=republished&${query}`, withCookie);
      expect(ignored.body).not.toContain('class="publish"');
      // «Опубликовано заново:» over nothing has no plain counterpart: no notice at all
      expect(ignored.body).not.toContain('class="notice"');
    }

    await rebuild({ botTexts: async () => ({ me: SAMPLE_ME, overrides: [] }) });
    const empty = await get('/admin/bot-texts', withCookie);
    expect(empty.body).not.toContain(TEXTS.botTextOrphansHeading);
  });

  it('W3 renders the editor: the text escaped after one line feed, its version, the hints, the forms', async () => {
    const response = await get('/admin/bot-texts/welcome?notice=saved', withCookie);
    const { body } = response;
    expect(response.statusCode).toBe(200);
    expect(calls.botText).toEqual([[TOKEN, 'welcome']]);
    expect(textareaOf(body)).toBe('\nПривет, &lt;b&gt;друг&lt;/b&gt;');
    expect(body).toContain(`maxlength="${BOT_TEXT_SOURCE_MAX}"`);
    expect(versionsOf(body)).toEqual(['7', '7']);
    expect(body).toContain('<a href="/admin/bot-texts/connectButton">connectButton</a>');
    expect(body).toContain(TEXTS.botTextFragmentChanged);
    expect(body).toContain(TEXTS.botTextDefaultSource);
    expect(body).toContain('formaction="/admin/bot-texts/welcome/preview"');
    expect(body).toContain('action="/admin/bot-texts/welcome/save"');
    expect(body).toContain('action="/admin/bot-texts/welcome/reset"');
    expect(body).toContain(TEXTS.botTextNotice.saved);
    expect(TEXTS.botTextNotice.saved).toContain('35 с');

    await rebuild({
      botText: async () => ({
        me: SAMPLE_ME,
        text: { key: 'codeSent', override: null, rejection: null, fragments: [] },
      }),
    });
    const fresh = await get('/admin/bot-texts/codeSent', withCookie);
    // W3 (#358): the panel lists the key's variables from the registry, one line each
    expect(fresh.body).toContain(
      TEXTS.botTextVariable('email', BOT_TEXT_VARS.email.description, 'ada@example.com'),
    );
    expect(fresh.body).toContain(
      '{firstName} — Имя пользователя из Telegram; в предпросмотре: Ада',
    );
    expect(versionsOf(fresh.body)).toEqual(['0']);
    expect(fresh.body).not.toContain('/reset"');

    await rebuild({
      botText: async () => ({
        me: SAMPLE_ME,
        text: { key: 'connectButton', override: null, rejection: null, fragments: [] },
      }),
    });
    const fragment = await get('/admin/bot-texts/connectButton', withCookie);
    expect(fragment.body).toMatch(
      new RegExp(`${TEXTS.botTextUsedIn}\\s*<a href="/admin/bot-texts/welcome">welcome</a>`),
    );
  });

  it('W3 edits a commands or a profile key with «Опубликовать заново», and 404s a key outside the catalog', async () => {
    const editorOf = async (key: string) => {
      await rebuild({
        botText: async (token, asked) => {
          calls.botText.push([token, asked]);
          return { me: SAMPLE_ME, text: { key, override: null, rejection: null, fragments: [] } };
        },
      });
      return (await get(`/admin/bot-texts/${key}`, withCookie)).body;
    };
    const start = await editorOf('startCommand');
    expect(start).toContain('<textarea');
    expect(start).toContain('action="/admin/bot-texts/startCommand/save"');
    expect(start).toContain('<form method="post" action="/admin/bot-texts/startCommand/publish">');
    expect(start).toContain(TEXTS.botProfileCommandHint);
    const profile = await editorOf('profileDescription');
    expect(profile).toContain('action="/admin/bot-texts/profileDescription/publish"');
    expect(profile).toContain(TEXTS.botProfileProfileHint);
    expect(profile).not.toContain(TEXTS.botProfileCommandHint);
    await rebuild({});
    const welcome = (await get('/admin/bot-texts/welcome', withCookie)).body;
    expect(welcome).not.toContain('/publish"');
    expect(welcome).not.toContain(TEXTS.botProfileCommandHint);

    const shown = await get(
      `/admin/bot-texts/welcome?notice=published&publish=setMyCommands%3AHttpError.ETIMEDOUT`,
      withCookie,
    );
    expect(shown.body).toContain(TEXTS.botTextNotice.published);
    expect(shown.body).toContain('ошибка — HttpError (ETIMEDOUT)');
    // a publish notice without a result that decodes falls back to the plain one
    const editorAt = async (query: string) =>
      (await get(`/admin/bot-texts/welcome?${query}`, withCookie)).body;
    const junk = await editorAt('notice=published&publish=junk');
    expect(junk).toContain(TEXTS.botTextNotice.saved);
    expect(junk).not.toContain(TEXTS.botTextNotice.published);
    expect(await editorAt('notice=reset_published')).toContain(TEXTS.botTextNotice.reset);
    expect(await editorAt('notice=republished')).not.toContain('class="notice"');
    // and a result shows only under a publish notice
    expect(await editorAt('notice=saved&publish=setMyCommands%3Aok')).not.toContain(
      'class="publish"',
    );

    const missing = await get('/admin/bot-texts/zzz', withCookie);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain(TEXTS.botTextNotFoundTitle);
    expect(calls.botText).toEqual(Array.from({ length: 6 }, () => [TOKEN, 'welcome']));
  });

  it('W4 previews: CRLF normalized, the bubble converted, the draft kept, no inline style or script', async () => {
    const response = await post(
      '/admin/bot-texts/welcome/preview',
      form('7', 'a\r\nb\r\n'),
      withCookie,
    );
    expect(response.statusCode).toBe(200);
    expect(calls.previewBotText).toEqual([[TOKEN, 'welcome', { source: 'a\nb' }]]);
    expect(response.body).toContain('<div class="tg-bubble"><b>Привет</b> тут</div>');
    expect(response.body).not.toContain('javascript:');
    expect(textareaOf(response.body)).toBe('\na\nb');
    expect(response.body).not.toMatch(/<style|<script/);

    await rebuild({
      previewBotText: async () =>
        answering({ outcome: 'refused', problems: [{ key: 'welcome', reason: 'Битый HTML: x' }] }),
    });
    const refused = await post('/admin/bot-texts/welcome/preview', form('7', '<b>x'), withCookie);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('Битый HTML: x');
    expect(textareaOf(refused.body)).toBe('\n&lt;b&gt;x');

    await rebuild({
      previewBotText: async () =>
        answering({ outcome: 'rendered', rendered: { kind: 'plain', text: 'Жми' } }),
    });
    const plain = await post(
      '/admin/bot-texts/connectButton/preview',
      form('3', 'Жми'),
      withCookie,
    );
    expect(plain.body).toContain('<div class="tg-bubble"><span class="tg-label">Жми</span></div>');
  });

  // #373 M1: a page built after a POST belongs to the editing session opened on the submitted
  // version; the fake answers with a fresher one
  describe('W9 keeps the submitted version on every page after a POST', () => {
    const fresher = {
      ...SAMPLE_BOT_TEXT,
      override: { ...SAMPLE_BOT_TEXT.override!, version: 12 },
    };
    const problems = [{ key: 'welcome', reason: 'Пустой текст' }];
    const answer = (outcome: Record<string, unknown>) =>
      ({ me: SAMPLE_ME, text: fresher, ...outcome }) as never;

    it.each([
      [
        'preview rendered',
        'preview',
        'previewBotText',
        { outcome: 'rendered', rendered: { kind: 'plain', text: 'x' } },
      ],
      ['preview refused', 'preview', 'previewBotText', { outcome: 'refused', problems }],
      ['save unchanged', 'save', 'saveBotText', { outcome: 'unchanged' }],
      ['save refused', 'save', 'saveBotText', { outcome: 'refused', problems }],
      ['reset refused', 'reset', 'resetBotText', { outcome: 'refused', problems }],
    ] as const)('%s', async (_label, action, method, outcome) => {
      await rebuild({ [method]: async () => answer(outcome) });
      const response = await post(
        `/admin/bot-texts/welcome/${action}`,
        form('7', 'Мой'),
        withCookie,
      );
      expect(versionsOf(response.body)).toEqual(['7', '7']);
      if (action !== 'reset') expect(textareaOf(response.body)).toBe('\nМой');
    });

    it.each([
      ['save', 'saveBotText'],
      ['reset', 'resetBotText'],
    ] as const)('moves to the current version only on a %s conflict', async (action, method) => {
      await rebuild({
        [method]: async () =>
          answer({ outcome: 'version_conflict', currentVersion: 12, currentSource: 'Чужой' }),
      });
      const response = await post(
        `/admin/bot-texts/welcome/${action}`,
        form('7', 'Мой'),
        withCookie,
      );
      expect([response.statusCode, versionsOf(response.body)]).toEqual([409, ['12', '12']]);
    });
  });

  it('W5 saves: 303 on success, the notice on unchanged, the other text on a conflict', async () => {
    const saved = await post('/admin/bot-texts/welcome/save', form(), withCookie);
    expect([saved.statusCode, saved.headers.location]).toEqual([
      303,
      '/admin/bot-texts/welcome?notice=saved',
    ]);
    expect(calls.saveBotText).toEqual([
      [TOKEN, 'welcome', { source: 'Привет', expectedVersion: 7 }],
    ]);

    for (const [published, publish] of [
      [[{ method: 'setMyCommands', ok: true }], 'setMyCommands%3Aok'],
      [
        [
          {
            method: 'setMyCommands',
            ok: false,
            err: { name: 'GrammyError' },
            cause: { name: 'Error' },
            telegramErrorCode: 400,
          },
        ],
        'setMyCommands%3AGrammyError%3A400',
      ],
    ] as const) {
      await rebuild({
        saveBotText: async () => answering({ outcome: 'saved', version: 8, published }),
      });
      const response = await post('/admin/bot-texts/startCommand/save', form(), withCookie);
      expect([response.statusCode, response.headers.location]).toEqual([
        303,
        `/admin/bot-texts/startCommand?notice=published&publish=${publish}`,
      ]);
    }

    const outcomes: [Record<string, unknown>, number, string][] = [
      [{ outcome: 'unchanged' }, 200, TEXTS.botTextNotice.unchanged],
      [
        { outcome: 'version_conflict', currentVersion: 12, currentSource: 'Чужой <i>текст</i>' },
        409,
        '<pre>Чужой &lt;i&gt;текст&lt;/i&gt;</pre>',
      ],
      [
        { outcome: 'refused', problems: [{ key: 'welcome', reason: 'Пустой текст' }] },
        400,
        'Пустой текст',
      ],
    ];
    for (const [outcome, status, shown] of outcomes) {
      await rebuild({ saveBotText: async () => answering(outcome) });
      const response = await post('/admin/bot-texts/welcome/save', form('7', 'Мой'), withCookie);
      expect([response.statusCode, response.body.includes(shown)]).toEqual([status, true]);
      expect(textareaOf(response.body)).toBe('\nМой');
      if (status === 409) {
        expect(response.body).toContain(TEXTS.botTextConflict(12));
        expect(versionsOf(response.body)).toEqual(['12', '12']);
      }
    }
  });

  it('W6 resets: 303 with the notice, the current text on a conflict, an orphan back to the list', async () => {
    const reset = await post('/admin/bot-texts/welcome/reset', { version: '7' }, withCookie);
    expect([reset.statusCode, reset.headers.location]).toEqual([
      303,
      '/admin/bot-texts/welcome?notice=reset',
    ]);
    expect(calls.resetBotText).toEqual([[TOKEN, 'welcome', { expectedVersion: 7 }]]);

    await rebuild({
      resetBotText: async () =>
        answering({
          outcome: 'reset',
          published: [{ method: 'setMyShortDescription', ok: true }],
        }),
    });
    const published = await post(
      '/admin/bot-texts/profileShortDescription/reset',
      { version: '7' },
      withCookie,
    );
    expect([published.statusCode, published.headers.location]).toEqual([
      303,
      '/admin/bot-texts/profileShortDescription?notice=reset_published&publish=setMyShortDescription%3Aok',
    ]);

    await rebuild({
      resetBotText: async () =>
        answering({ outcome: 'version_conflict', currentVersion: 12, currentSource: 'Чужой' }),
    });
    const conflict = await post('/admin/bot-texts/welcome/reset', { version: '7' }, withCookie);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toContain('<pre>Чужой</pre>');

    for (const [outcome, notice] of [
      ['reset', 'removed'],
      ['already_default', 'gone'],
      ['version_conflict', 'changed'],
    ] as const) {
      await rebuild({
        resetBotText: async (_token, key, request) => {
          calls.resetBotText.push([key, request]);
          return {
            me: SAMPLE_ME,
            text: null,
            outcome,
            currentVersion: 10,
            currentSource: 'x',
            published: [],
          } as never;
        },
      });
      const orphan = await post('/admin/bot-texts/zzz/reset', { version: '9' }, withCookie);
      expect([orphan.statusCode, orphan.headers.location]).toEqual([
        303,
        `/admin/bot-texts?notice=${notice}`,
      ]);
      expect(calls.resetBotText).toEqual([['zzz', { expectedVersion: 9 }]]);
    }

    await rebuild({});
    const bad = await post('/admin/bot-texts/not-a-key/reset', { version: '9' }, withCookie);
    expect(bad.statusCode).toBe(404);
    expect(calls.resetBotText).toEqual([]);
  });

  it('W7 refuses a form outside its shape with a 400 and asks the backend nothing', async () => {
    const raw = (url: string, payload: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        payload,
        cookies: withCookie,
      });
    for (const payload of [
      'source=a&version=abc',
      'source=a&source=b&version=1',
      new URLSearchParams({
        source: '😀'.repeat(BOT_TEXT_SOURCE_MAX + 1),
        version: '1',
      }).toString(),
    ]) {
      const response = await raw('/admin/bot-texts/welcome/save', payload);
      expect([response.statusCode, response.body.includes(TEXTS.badRequest)]).toEqual([400, true]);
    }
    expect((await raw('/admin/bot-texts/welcome/reset', 'version=-1')).statusCode).toBe(400);
    expect(calls.saveBotText).toEqual([]);
    expect(calls.resetBotText).toEqual([]);
  });

  it('W8 clears a session that is gone, and on an unanswered save says the outcome is unknown', async () => {
    const malformed = await post('/admin/bot-texts/welcome/save', form(), {
      [SESSION_COOKIE]: 'short',
    });
    expect([malformed.statusCode, malformed.headers.location]).toEqual([302, '/admin/login']);

    await rebuild({
      saveBotText: async () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
    });
    const gone = await post('/admin/bot-texts/welcome/save', form(), withCookie);
    expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);

    await rebuild({
      saveBotText: async () => Promise.reject(new BackendError(BackendErrorCode.Unreachable)),
    });
    const unknown = await post(
      '/admin/bot-texts/welcome/save',
      form('7', 'СЕКРЕТНЫЙ-ЧЕРНОВИК'),
      withCookie,
    );
    expect(unknown.statusCode).toBe(500);
    expect(unknown.body).toContain(TEXTS.botTextOutcomeUnknown);
    expect(unknown.headers['set-cookie']).toBeUndefined();
    const all = lines.join('\n');
    expect(all).toContain('the bot text write outcome is unknown');
    expect(all).not.toContain('СЕКРЕТНЫЙ-ЧЕРНОВИК');

    // #361: a commands key may have been saved and published, or not
    const publishing = await post('/admin/bot-texts/startCommand/save', form(), withCookie);
    expect(publishing.statusCode).toBe(500);
    expect(publishing.body).toContain(TEXTS.botProfileWriteOutcomeUnknown);
  });

  it('W10 republishes from the list and from an editor, back to the same page with the result', async () => {
    const fromList = await post('/admin/bot-texts/publish', {}, withCookie);
    expect([fromList.statusCode, fromList.headers.location]).toEqual([
      303,
      `/admin/bot-texts?notice=republished&publish=${SAMPLE_PUBLISHED_QUERY}`,
    ]);
    const fromEditor = await post('/admin/bot-texts/profileDescription/publish', {}, withCookie);
    expect([fromEditor.statusCode, fromEditor.headers.location]).toEqual([
      303,
      `/admin/bot-texts/profileDescription?notice=republished&publish=${SAMPLE_PUBLISHED_QUERY}`,
    ]);
    expect(calls.publishBotProfile).toEqual([TOKEN, TOKEN]);

    for (const key of ['welcome', 'zzz', 'not-a-key']) {
      const refused = await post(`/admin/bot-texts/${key}/publish`, {}, withCookie);
      expect(refused.statusCode).toBe(404);
    }
    expect(calls.publishBotProfile).toEqual([TOKEN, TOKEN]);

    const malformed = await post('/admin/bot-texts/publish', {}, { [SESSION_COOKIE]: 'short' });
    expect([malformed.statusCode, malformed.headers.location]).toEqual([302, '/admin/login']);

    for (const failure of [new BackendError(BackendErrorCode.Unreachable), httpFailure(500)]) {
      await rebuild({ publishBotProfile: async () => Promise.reject(failure) });
      const unknown = await post('/admin/bot-texts/publish', {}, withCookie);
      expect(unknown.statusCode).toBe(500);
      expect(unknown.body).toContain(TEXTS.botProfileOutcomeUnknown);
    }
    expect(lines.join('\n')).toContain('the bot profile publish outcome is unknown');

    await rebuild({
      publishBotProfile: async () =>
        Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
    });
    const gone = await post('/admin/bot-texts/publish', {}, withCookie);
    expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);
  });
});

describe('the token adjustment form (#246)', () => {
  const withCookie = { [SESSION_COOKIE]: TOKEN };
  const url = `/admin/users/${SAMPLE_USER_ID}/tokens`;
  const valid = { direction: 'credit', amount: '50', note: ' Компенсация ', balance: '5' };
  const rebuild = async (backend: Partial<BackendClient>) => {
    await app.close();
    app = build(backend);
  };
  const badForm = TEXTS.tokenAdjustBadForm(TOKEN_ADJUSTMENT_MAX_TOKENS, TOKEN_LEDGER_NOTE_MAX);
  const raw = (payload: string, cookies: Record<string, string> = withCookie) =>
    app.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload,
      cookies,
    });

  it('W1 puts the form under «Токены» with the balance the card shows and the shared limits', async () => {
    const { body } = await get(`/admin/users/${SAMPLE_USER_ID}`, withCookie);
    const formAt = body.indexOf(`<form class="stack" method="post" action="${url}">`);
    expect(formAt).toBeGreaterThan(body.indexOf(`<h2>${TEXTS.userTokens}</h2>`));
    expect(formAt).toBeLessThan(body.indexOf(`<h2>${TEXTS.userBrokerAccounts}</h2>`));
    expect(body).toContain('<input type="hidden" name="balance" value="5" />');
    expect(body).toMatch(/<input type="radio" name="direction" value="credit" checked \/>/);
    expect(body).toMatch(/<input type="radio" name="direction" value="debit"\s+\/>/);
    expect(body).toMatch(/name="amount"\s+min="1"\s+max="1000"\s+step="1"\s+value=""\s+required/);
    expect(body).toMatch(/name="note"\s+maxlength="512"\s+value=""\s+required/);
    expect(body).not.toContain(TEXTS.userNotice.adjusted);
  });

  it.each([
    ['notice=adjusted', true],
    ['notice=bogus', false],
    ['notice=adjusted&notice=x', false],
  ])('W1 shows the success notice for ?%s only when it is the one notice', async (query, shown) => {
    const { body } = await get(`/admin/users/${SAMPLE_USER_ID}?${query}`, withCookie);
    expect(body.includes(`<p class="notice">${TEXTS.userNotice.adjusted}</p>`)).toBe(shown);
  });

  it('W2 sends a credit as a positive delta and a debit as a negative one, then back to the card', async () => {
    const credit = await post(url, valid, withCookie);
    expect([credit.statusCode, credit.headers.location]).toEqual([
      303,
      `/admin/users/${SAMPLE_USER_ID}?notice=adjusted`,
    ]);
    await post(url, { ...valid, direction: 'debit' }, withCookie);
    expect(calls.adjustTokens).toEqual([
      [TOKEN, SAMPLE_USER_ID, { delta: '50', note: 'Компенсация', expectedBalance: '5' }],
      [TOKEN, SAMPLE_USER_ID, { delta: '-50', note: 'Компенсация', expectedBalance: '5' }],
    ]);
  });

  it.each([
    ['a zero amount', 'direction=credit&amount=0&note=x&balance=5'],
    ['an amount over the limit', 'direction=credit&amount=1001&note=x&balance=5'],
    ['a fraction', 'direction=credit&amount=1.5&note=x&balance=5'],
    ['an empty amount', 'direction=credit&amount=&note=x&balance=5'],
    ['a leading zero', 'direction=credit&amount=050&note=x&balance=5'],
    ['an unknown direction', 'direction=bogus&amount=5&note=x&balance=5'],
    ['no balance', 'direction=credit&amount=5&note=x'],
    ['a blank note', 'direction=credit&amount=5&note=%20%20%20&balance=5'],
    ['an amount sent twice', 'direction=credit&amount=5&amount=6&note=x&balance=5'],
  ])('W3 refuses %s with 400, without calling the backend', async (_label, payload) => {
    const response = await raw(payload);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(badForm);
    expect(calls.adjustTokens).toEqual([]);
  });

  it('W4 redraws the card on insufficient_available with the answer, the form as sent and the fresh balance', async () => {
    await rebuild({
      adjustTokens: async () =>
        sampleAdjustmentRefusal('insufficient_available', {
          balance: '7',
          reserved: '2',
          available: '5',
        }),
    });
    const response = await post(
      url,
      { ...valid, direction: 'debit', note: 'Списание <b>' },
      withCookie,
    );
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain(TEXTS.tokenAdjustInsufficient('5'));
    expect(response.body).toContain('<input type="hidden" name="balance" value="7" />');
    expect(response.body).toMatch(/<input type="radio" name="direction" value="debit" checked \/>/);
    expect(response.body).toMatch(/<input type="radio" name="direction" value="credit"\s+\/>/);
    expect(response.body).toMatch(/name="amount"[^>]*value="50"/);
    expect(response.body).toMatch(/name="note"[^>]*value="Списание &lt;b&gt;"/);
  });

  it('W4 redraws the card on balance_changed with the current balance', async () => {
    await rebuild({
      adjustTokens: async () =>
        sampleAdjustmentRefusal('balance_changed', { balance: '9', reserved: '0', available: '9' }),
    });
    const response = await post(url, valid, withCookie);
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain(TEXTS.tokenAdjustBalanceChanged('9'));
    expect(response.body).toContain('<input type="hidden" name="balance" value="9" />');
  });

  it('W5 refuses an id that is not a uuid before the backend, and shows a 404 from it', async () => {
    let called = 0;
    await rebuild({
      adjustTokens: async () => {
        called += 1;
        throw httpFailure(404, AdminErrorCode.NotFound);
      },
    });
    const shape = await post('/admin/users/not-a-uuid/tokens', valid, withCookie);
    expect(shape.statusCode).toBe(404);
    expect(called).toBe(0);

    const missing = await post(url, valid, withCookie);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain(TEXTS.userNotFoundBody);
    expect(called).toBe(1);
  });

  it('W5 clears a session the backend calls gone', async () => {
    await rebuild({
      adjustTokens: async () => Promise.reject(httpFailure(401, AdminErrorCode.SessionInvalid)),
    });
    const gone = await post(url, valid, withCookie);
    expect([gone.statusCode, gone.headers.location]).toEqual([302, '/admin/login']);
    expect(cookieOf(gone, SESSION_COOKIE)?.value).toBe('');
  });

  it.each([
    [
      'unreachable',
      new BackendError(BackendErrorCode.Unreachable),
      { name: 'BackendError', code: 'unreachable' },
    ],
    [
      'a 2xx outside the contract',
      new BackendError(BackendErrorCode.ContractViolation),
      { name: 'BackendError', code: 'contract_violation' },
    ],
    ['a 500', httpFailure(500), { name: 'BackendError', code: 'http_status' }],
  ])('W5 says the outcome is unknown when %s, keeping the cookie', async (_label, failure, err) => {
    await rebuild({ adjustTokens: async () => Promise.reject(failure) });
    const response = await post(url, { ...valid, note: 'СЕКРЕТНАЯ-ПРИЧИНА' }, withCookie);
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain(TEXTS.tokenAdjustOutcomeUnknown);
    expect(response.headers['set-cookie']).toBeUndefined();
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = logged.find((line) => line.msg === 'the token adjustment outcome is unknown');
    expect(entry?.err).toEqual(err);
    expect(lines.join('\n')).not.toContain('СЕКРЕТНАЯ-ПРИЧИНА');
  });

  it('W5 answers another 4xx from the backend as our own failure', async () => {
    await rebuild({
      adjustTokens: async () => Promise.reject(httpFailure(400, AdminErrorCode.Validation)),
    });
    const response = await post(url, valid, withCookie);
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain(TEXTS.errorBody);
  });

  it('W6 refuses a POST from another origin before the backend is asked', async () => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(valid).toString(),
      cookies: withCookie,
    });
    expect(response.statusCode).toBe(403);
    expect(calls.adjustTokens).toEqual([]);
  });
});
