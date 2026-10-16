import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEPOSIT_BODY_LIMIT_BYTES,
  type DepositCreditedRequest,
  type DepositCreditedResponse,
  type DepositWidgetSessionRequest,
  type DepositWidgetSessionResponse,
} from '@binarius/shared';
import { buildWebApp } from '../app';
import { BackendError, BackendErrorCode, type BackendClient } from '../backend-client';
import { TELEGRAM_SDK_URL } from '../mini-app';
import { CASHIER_CLIENT_JS } from './client';
import { CashierNotice, CashierState } from './pages';
import { CASHIER_TEXTS } from './texts';

const ORIGIN = 'https://binarius.example';
const WIDGET_ORIGINS = ['https://binodex.app', 'https://pay.binodex.app'];
const INIT_DATA = 'query_id=AA%2BBB&user=%7B%22first_name%22%3A%22A+B%22%7D&auth_date=1&hash=ff';
const SESSION = 'widget-session-SECRET-7f3a';
const ANSWER: DepositWidgetSessionResponse = {
  session: SESSION,
  expiresInSec: 600,
  widgetUrl: 'https://binodex.app/embed/pay?client_id=client',
  widgetOrigin: 'https://binodex.app',
};

const CASHIER_CSP =
  "default-src 'none'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self'; frame-src https://binodex.app https://pay.binodex.app; form-action 'none'; frame-ancestors https://web.telegram.org; base-uri 'none'";
const ADMIN_CSP =
  "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

let app: FastifyInstance;
let forwarded: DepositWidgetSessionRequest[];
let lines: string[];
let answer: () => Promise<DepositWidgetSessionResponse>;
let creditedForwarded: DepositCreditedRequest[];
let creditedAnswer: () => Promise<DepositCreditedResponse>;

beforeEach(() => {
  forwarded = [];
  lines = [];
  answer = () => Promise.resolve(ANSWER);
  creditedForwarded = [];
  creditedAnswer = () => Promise.resolve({ outcome: 'refreshed' });
  const unused = () => Promise.reject(new Error('unused'));
  const backend: BackendClient = {
    login: unused,
    confirm: unused,
    inspectLoginLink: unused,
    completeLoginLink: unused,
    sessions: unused,
    revoke: unused,
    logout: unused,
    overview: unused,
    users: unused,
    user: unused,
    intents: unused,
    intent: unused,
    tradingSessions: unused,
    tokens: unused,
    deposits: unused,
    adjustTokens: unused,
    brokerAccounts: unused,
    serviceAccounts: unused,
    setServiceMark: unused,
    audit: unused,
    changePassword: unused,
    botTexts: unused,
    botText: unused,
    previewBotText: unused,
    saveBotText: unused,
    resetBotText: unused,
    publishBotProfile: unused,
    oauthCallback: unused,
    depositWidgetSession: (request) => {
      forwarded.push(request);
      return answer();
    },
    depositCredited: (request) => {
      creditedForwarded.push(request);
      return creditedAnswer();
    },
  };
  app = buildWebApp({
    backend,
    publicOrigin: ORIGIN,
    brokerAuthorizeUrl: 'https://binodex.app/oauth/authorize',
    secureCookies: true,
    depositWidgetOrigins: WIDGET_ORIGINS,
    logLevel: 'info',
    logDestination: { write: (line) => lines.push(line) },
  });
});
afterEach(() => app.close());

interface MintOptions {
  body?: unknown;
  payload?: string;
  /** the TCP peer; inject's default is 127.0.0.1 */
  peer?: string;
  forwardedFor?: string;
  origin?: string;
}

const mint = ({ body, payload, peer, forwardedFor, origin = ORIGIN }: MintOptions = {}) =>
  app.inject({
    method: 'POST',
    url: '/cashier/session',
    ...(peer === undefined ? {} : { remoteAddress: peer }),
    headers: {
      origin,
      'content-type': 'application/json',
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    },
    payload: payload ?? JSON.stringify(body ?? { initData: INIT_DATA }),
  });

const refusal = (status: number, reason?: string) =>
  new BackendError(BackendErrorCode.HttpStatus, { status, ...(reason ? { reason } : {}) });

const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const errorLines = () => logged().filter((line) => line.level === 50);

describe('GET /cashier (W1)', () => {
  it('serves the Mini App page: the SDK, its script, every state and an iframe without a src', async () => {
    const response = await app.inject({ method: 'GET', url: '/cashier' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    const body = response.body;
    expect(body).toContain('data-page="cashier"');
    expect(body).toContain(`<script src="${TELEGRAM_SDK_URL}"></script>`);
    expect(body).toContain('<script src="/cashier/static/app.js" defer></script>');
    const iframe = /<iframe[^>]*>/.exec(body)?.[0] ?? '';
    expect(iframe).toContain('id="widget"');
    expect(iframe).toContain('allow="payment *; clipboard-write *"');
    expect(iframe).toMatch(/\stitle="[^"]+"/);
    expect(iframe).toMatch(/\shidden\b/);
    expect(iframe).not.toMatch(/\ssrc=/);
    expect(iframe).not.toMatch(/\ssandbox/);
    for (const state of Object.values(CashierState)) {
      expect(body).toMatch(new RegExp(`<p data-state="${state}" hidden>[^<]+</p>`));
    }
    for (const notice of Object.values(CashierNotice)) {
      expect(body).toMatch(new RegExp(`<p data-notice="${notice}" role="status" hidden>[^<]+</p>`));
    }
    expect(body).toContain(CASHIER_TEXTS.credited);
    expect(body).toContain(CASHIER_TEXTS.widgetError);
    expect(body).toContain('<button id="retry" type="button" hidden>');
    expect(body).toContain('<button id="close" type="button" hidden>');
  });
});

describe('the cashier headers (W2, W3)', () => {
  it.each([
    ['the page', () => app.inject({ method: 'GET', url: '/cashier' })],
    ['the script', () => app.inject({ method: 'GET', url: '/cashier/static/app.js' })],
    ['a minted session', () => mint()],
    ['a refused POST', () => mint({ body: {} })],
  ])('%s: the Mini App policy framing exactly the widget origins', async (_label, request) => {
    const response = await request();
    expect(response.headers['content-security-policy']).toBe(CASHIER_CSP);
    expect(response.headers['referrer-policy']).toBe('strict-origin');
    expect(response.headers['x-frame-options']).toBeUndefined();
  });

  it('never lets the session answer be cached', async () => {
    expect((await mint()).headers['cache-control']).toBe('no-store');
    expect((await mint({ body: {} })).headers['cache-control']).toBe('no-store');
  });

  it('serves the script as JavaScript that may be cached', async () => {
    const response = await app.inject({ method: 'GET', url: '/cashier/static/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.body).toBe(CASHIER_CLIENT_JS);
  });

  it('leaves the admin pages their own policy', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(response.headers['content-security-policy']).toBe(ADMIN_CSP);
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});

describe('the forward (W4)', () => {
  it.each([
    ['loopback', '127.0.0.1', '203.0.113.7'],
    ['the compose bridge gateway', '172.18.0.1', '203.0.113.7'],
    ['loopback, an IPv6 client', '127.0.0.1', '2001:db8::7'],
  ])(
    'sends the launch data and the client address a trusted proxy (%s) forwarded',
    async (_l, peer, client) => {
      const response = await mint({ peer, forwardedFor: client });
      expect(response.statusCode).toBe(200);
      expect(forwarded).toEqual([{ initData: INIT_DATA, clientIp: client }]);
    },
  );

  it.each([
    ['no proxy header', { peer: '127.0.0.1' }],
    ['a header that is not an address', { peer: '127.0.0.1', forwardedFor: 'not-an-ip' }],
    ['a public peer with a header', { peer: '198.51.100.9', forwardedFor: '203.0.113.7' }],
  ])('sends no client address with %s', async (_label, options) => {
    await mint(options);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toStrictEqual({ initData: INIT_DATA });
  });
});

describe('the page states (W5)', () => {
  it('row 4: answers the session and both URLs', async () => {
    const response = await mint();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'ready', ...ANSWER });
  });

  it.each([
    [8, 429, 'too_many_requests', CashierState.Busy],
    [9, 409, 'demo_only', CashierState.DemoOnly],
    [10, 401, 'invalid_telegram_auth', CashierState.OpenFromTelegram],
    [11, 409, 'no_active_account', CashierState.ConnectFirst],
    [12, 409, 'ambiguous_account', CashierState.Ambiguous],
    [13, 409, 'user_blocked', CashierState.Blocked],
    [14, 409, 'token_unavailable', CashierState.Relogin],
    [15, 502, 'broker_unavailable', CashierState.Unavailable],
    [16, 502, 'broker_rejected', CashierState.Rejected],
  ])('row %i: %i %s -> 200 %s, nothing logged as an error', async (_row, status, code, state) => {
    answer = () => Promise.reject(refusal(status, code));
    const response = await mint();
    expect([response.statusCode, response.json()]).toEqual([200, { outcome: state }]);
    expect(errorLines()).toEqual([]);
  });

  it.each([
    ['row 6: a 2xx outside the contract', new BackendError(BackendErrorCode.ContractViolation), {}],
    [
      'row 7: the backend refusing our body',
      refusal(400, 'validation'),
      { status: 400, reason: 'validation' },
    ],
    ['row 17: 500 internal', refusal(500, 'internal'), { status: 500, reason: 'internal' }],
    [
      'row 17: 404 (a backend without #11)',
      refusal(404, 'not_found'),
      { status: 404, reason: 'not_found' },
    ],
    ['row 17: 413 without a code', refusal(413), { status: 413 }],
    [
      'row 17: an unknown 409 code',
      refusal(409, 'something_new'),
      { status: 409, reason: 'something_new' },
    ],
    ['row 17: a known code on another status', refusal(502, 'no_active_account'), { status: 502 }],
    ['row 18: no answer', new BackendError(BackendErrorCode.Unreachable), {}],
  ])('%s -> 500 unavailable and one error line', async (_label, error, fields) => {
    answer = () => Promise.reject(error);
    const response = await mint();
    expect([response.statusCode, response.json()]).toEqual([500, { outcome: 'unavailable' }]);
    const errors = errorLines();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe('the cashier session could not be minted');
    expect(errors[0]).toMatchObject(fields);
  });
});

describe('the per-IP window (W6, W11)', () => {
  const fill = async (forwardedFor: string | undefined, peer = '127.0.0.1') => {
    for (let index = 0; index < 60; index += 1) {
      const response = await mint({
        peer,
        ...(forwardedFor === undefined ? {} : { forwardedFor }),
      });
      expect(response.statusCode).toBe(200);
    }
  };

  it('answers the 61st request from one address in a minute busy, without a forward', async () => {
    await fill('203.0.113.7');
    const response = await mint({ forwardedFor: '203.0.113.7' });
    expect([response.statusCode, response.json()]).toEqual([429, { outcome: 'busy' }]);
    expect(forwarded).toHaveLength(60);
    // another address has its own allowance
    expect((await mint({ forwardedFor: '203.0.113.8' })).statusCode).toBe(200);
    expect(forwarded).toHaveLength(61);
  });

  it('counts an IPv6 /64 as one address and an IPv4-mapped address as its IPv4', async () => {
    await fill('2001:db8:1:2::1');
    expect((await mint({ forwardedFor: '2001:db8:1:2::ffff' })).statusCode).toBe(429);
    expect((await mint({ forwardedFor: '2001:db8:1:3::1' })).statusCode).toBe(200);

    await fill('198.51.100.20');
    expect((await mint({ forwardedFor: '::ffff:198.51.100.20' })).statusCode).toBe(429);
  });

  it('counts an untrusted peer by its own address, whatever header it forges', async () => {
    for (let index = 0; index < 60; index += 1) {
      const response = await mint({ peer: '198.51.100.9', forwardedFor: `203.0.113.${index}` });
      expect(response.statusCode).toBe(200);
    }
    const response = await mint({ peer: '198.51.100.9', forwardedFor: '203.0.113.200' });
    expect(response.statusCode).toBe(429);
    expect(forwarded.every((request) => request.clientIp === undefined)).toBe(true);
  });

  it("leaves request.ip the untrusted peer's own address under a forged header", async () => {
    app.get('/probe-ip', async (request) => ({ ip: request.ip, ips: request.ips }));
    const response = await app.inject({
      method: 'GET',
      url: '/probe-ip',
      remoteAddress: '198.51.100.9',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(response.json()).toEqual({ ip: '198.51.100.9', ips: ['198.51.100.9'] });
  });
});

describe('a body the page did not build (W7)', () => {
  it.each([
    ['no initData', { body: {} }],
    ['an empty initData', { body: { initData: '' } }],
    ['an extra key', { body: { initData: INIT_DATA, clientIp: '203.0.113.7' } }],
    ['a body that is not JSON', { payload: 'initData=x' }],
    ['a body over the limit', { body: { initData: 'x'.repeat(DEPOSIT_BODY_LIMIT_BYTES) } }],
  ])('refuses %s with 400 unavailable, without a forward', async (_label, options) => {
    const response = await mint(options);
    expect([response.statusCode, response.json()]).toEqual([400, { outcome: 'unavailable' }]);
    expect(forwarded).toEqual([]);
  });
});

describe('the log (W8)', () => {
  it('holds neither the session nor the launch data after a success or any failure', async () => {
    await mint();
    for (const error of [
      refusal(409, 'no_active_account'),
      refusal(400, 'validation'),
      refusal(500, 'internal'),
      new BackendError(BackendErrorCode.ContractViolation),
      new BackendError(BackendErrorCode.Unreachable, { cause: new Error(INIT_DATA) }),
    ]) {
      answer = () => Promise.reject(error);
      await mint();
    }
    answer = () => Promise.resolve({ ...ANSWER, widgetOrigin: 'https://evil.example' });
    await mint();
    await mint({ body: { initData: INIT_DATA, extra: SESSION } });

    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join('\n');
    expect(text).not.toContain(SESSION);
    expect(text).not.toContain(INIT_DATA);
  });
});

describe('the backend answering a widget outside the web list (W9)', () => {
  it.each([
    ['widgetOrigin', { widgetOrigin: 'https://evil.example' }, 'https://evil.example'],
    ['the widget URL', { widgetUrl: 'https://evil.example/embed/pay' }, 'https://evil.example'],
    [
      'a spelling the list does not hold',
      { widgetOrigin: 'https://binodex.app/' },
      'https://binodex.app/',
    ],
  ])('%s -> rejected and one error line with the origin', async (_label, change, origin) => {
    answer = () => Promise.resolve({ ...ANSWER, ...change });
    const response = await mint();
    expect([response.statusCode, response.json()]).toEqual([200, { outcome: 'rejected' }]);
    const errors = errorLines();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: 'the backend returned a widget origin outside DEPOSIT_WIDGET_ORIGINS',
      origin,
    });
  });

  it('accepts a widget served from the second listed origin', async () => {
    answer = () =>
      Promise.resolve({
        ...ANSWER,
        widgetUrl: 'https://pay.binodex.app/embed/pay',
        widgetOrigin: 'https://pay.binodex.app',
      });
    expect((await mint()).json()).toMatchObject({ outcome: 'ready' });
  });
});

describe('a POST from another origin (W10)', () => {
  it('is refused by the app before the cashier sees it', async () => {
    const response = await mint({ origin: 'https://evil.example' });
    expect(response.statusCode).toBe(403);
    expect(forwarded).toEqual([]);
  });
});

const credited = ({ body, payload, peer, forwardedFor, origin = ORIGIN }: MintOptions = {}) =>
  app.inject({
    method: 'POST',
    url: '/cashier/credited',
    ...(peer === undefined ? {} : { remoteAddress: peer }),
    headers: {
      origin,
      'content-type': 'application/json',
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    },
    payload: payload ?? JSON.stringify(body ?? { initData: INIT_DATA }),
  });

describe('POST /cashier/credited (#112)', () => {
  // W12
  it('forwards initData alone and answers 204 with no body', async () => {
    const response = await credited({ forwardedFor: '203.0.113.7' });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(creditedForwarded).toEqual([{ initData: INIT_DATA }]);
    expect(Object.keys(creditedForwarded[0] ?? {})).toEqual(['initData']);
    expect(forwarded).toEqual([]);
  });

  // W13
  it.each([
    ['no initData', { body: {} }],
    ['an empty initData', { body: { initData: '' } }],
    ['the widget amount', { body: { initData: INIT_DATA, amount: 100 } }],
    ['an extra key', { body: { initData: INIT_DATA, clientIp: '203.0.113.7' } }],
    ['a body that is not JSON', { payload: 'initData=x' }],
    ['a body over the limit', { body: { initData: 'x'.repeat(DEPOSIT_BODY_LIMIT_BYTES) } }],
  ])('refuses %s with 400, without a forward', async (_label, options) => {
    const response = await credited(options);
    expect(response.statusCode).toBe(400);
    expect(creditedForwarded).toEqual([]);
  });

  // W14
  it.each([
    ['the session route', () => mint({ forwardedFor: '203.0.113.7' })],
    ['the credited route', () => credited({ forwardedFor: '203.0.113.7' })],
  ])('shares the per-IP window with the session: then %s is refused', async (_label, next) => {
    for (let index = 0; index < 30; index += 1) {
      expect((await mint({ forwardedFor: '203.0.113.7' })).statusCode).toBe(200);
      expect((await credited({ forwardedFor: '203.0.113.7' })).statusCode).toBe(204);
    }
    expect((await next()).statusCode).toBe(429);
    expect(forwarded).toHaveLength(30);
    expect(creditedForwarded).toHaveLength(30);
  });

  // W15
  it.each([
    ['refreshed', () => Promise.resolve({ outcome: 'refreshed' as const }), undefined],
    ['pending', () => Promise.resolve({ outcome: 'pending' as const }), undefined],
    ['401 invalid_telegram_auth', () => Promise.reject(refusal(401, 'invalid_telegram_auth')), 40],
    ['429 too_many_requests', () => Promise.reject(refusal(429, 'too_many_requests')), 40],
    ['409 demo_only', () => Promise.reject(refusal(409, 'demo_only')), 40],
    ['409 no_active_account', () => Promise.reject(refusal(409, 'no_active_account')), 40],
    ['409 user_blocked', () => Promise.reject(refusal(409, 'user_blocked')), 40],
    ['400 validation', () => Promise.reject(refusal(400, 'validation')), 50],
    ['500 internal', () => Promise.reject(refusal(500, 'internal')), 50],
    ['409 an unknown code', () => Promise.reject(refusal(409, 'something_new')), 50],
    ['502 broker_unavailable', () => Promise.reject(refusal(502, 'broker_unavailable')), 50],
    [
      'a 2xx outside the contract',
      () => Promise.reject(new BackendError(BackendErrorCode.ContractViolation)),
      50,
    ],
    [
      'no answer',
      () =>
        Promise.reject(
          new BackendError(BackendErrorCode.Unreachable, { cause: new Error(INIT_DATA) }),
        ),
      50,
    ],
    ['a throw', () => Promise.reject(new Error(INIT_DATA)), 50],
  ])('backend %s -> 204 and its log level', async (_label, outcome, level) => {
    creditedAnswer = outcome as () => Promise<DepositCreditedResponse>;
    const response = await credited();
    expect(response.statusCode).toBe(204);
    const lines_ = logged().filter((line) => String(line.msg).includes('credited'));
    if (level === undefined) {
      expect(lines_).toEqual([]);
    } else {
      expect(lines_.map((line) => line.level)).toEqual([level]);
    }
    expect(lines.join('\n')).not.toContain(INIT_DATA);
  });

  it('logs a known refusal with its status and reason', async () => {
    creditedAnswer = () => Promise.reject(refusal(429, 'too_many_requests'));
    await credited();
    expect(logged()).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'the backend refused a cashier credited event',
        status: 429,
        reason: 'too_many_requests',
      }),
    );
  });

  // W16
  it('refuses a POST from another origin before the cashier sees it', async () => {
    const response = await credited({ origin: 'https://evil.example' });
    expect(response.statusCode).toBe(403);
    expect(creditedForwarded).toEqual([]);
  });
});
