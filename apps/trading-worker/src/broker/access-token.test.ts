import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@binarius/db';
import { accessTokenPath, safeParseAccessTokenRequest } from '@binarius/shared';
import pino from 'pino';
import { logOptions } from '@binarius/shared';
import {
  createBackendAccessTokenSource,
  isAccessTokenRefusal,
  notConfiguredAccessTokenSource,
  reportRefusedToken,
  type AccessTokenOutcome,
  type AccessTokenSource,
} from './access-token';

const ACCOUNT = '0b8f3c62-7a1e-4d2b-9a55-3c1f2e4d5a6b';
const BEARER = 'internal-token-for-tests-0123456789';
const SECRET = 'live-access-token-from-the-backend';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[];
let reply: (res: ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  reply = (res) => json(res, 200, { accessToken: SECRET });
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const source = (timeoutMs?: number): AccessTokenSource =>
  createBackendAccessTokenSource({ baseUrl, token: BEARER, timeoutMs });

describe('createBackendAccessTokenSource (#90)', () => {
  it('posts mayRefresh with the bearer and answers the token', async () => {
    expect(await source().accessToken(ACCOUNT, { mayRefresh: false })).toEqual({
      ok: true,
      accessToken: SECRET,
    });
    expect(seen).toEqual([
      {
        method: 'POST',
        url: accessTokenPath(ACCOUNT),
        authorization: `Bearer ${BEARER}`,
        body: { mayRefresh: false },
      },
    ]);
  });

  it('asks with mayRefresh: true when the caller names no policy', async () => {
    await source().accessToken(ACCOUNT);
    expect(seen[0]?.body).toEqual({ mayRefresh: true });
  });

  it('posts the fingerprint of the refused token, and the body passes the route schema', async () => {
    await source().accessToken(ACCOUNT, { mayRefresh: false, refusedToken: hashToken('t') });
    expect(seen[0]?.body).toEqual({ mayRefresh: false, refusedToken: hashToken('t') });
    expect(safeParseAccessTokenRequest(seen[0]?.body).success).toBe(true);
  });

  it.each([
    [404, 'account_not_found'],
    [409, 'user_blocked'],
    [409, 'account_pending'],
    [409, 'account_revoked'],
    [409, 'key_unavailable'],
    [409, 'refresh_needed'],
    [409, 'refresh_rate_limited'],
  ])('passes a %i %s refusal through as a refusal', async (status, error) => {
    reply = (res) => json(res, status, { error });
    const outcome = await source().accessToken(ACCOUNT);
    expect(outcome).toEqual({ ok: false, reason: error });
    expect(!outcome.ok && isAccessTokenRefusal(outcome.reason)).toBe(true);
  });

  it.each([401, 400, 500, 503])('answers backend_status for HTTP %i', async (status) => {
    reply = (res) => json(res, status, { error: 'user_blocked' });
    const outcome = await source().accessToken(ACCOUNT);
    expect(outcome).toEqual({ ok: false, reason: 'backend_status', status });
    expect(!outcome.ok && isAccessTokenRefusal(outcome.reason)).toBe(false);
  });

  it.each([
    ['a 2xx without the token', 200, { token: SECRET }],
    ['a 2xx that is not JSON', 200, 'not json'],
    ['a 404 with an unknown code', 404, { error: 'not_found' }],
    ["Fastify's own 404", 404, { message: 'Route not found', error: 'Not Found', statusCode: 404 }],
    ['a 409 with an unknown code', 409, { error: 'internal' }],
  ])('answers contract_violation for %s', async (_name, status, body) => {
    reply = (res) =>
      typeof body === 'string'
        ? (res.writeHead(status, { 'content-type': 'text/plain' }), res.end(body))
        : json(res, status, body);
    expect(await source().accessToken(ACCOUNT)).toEqual({
      ok: false,
      reason: 'contract_violation',
      status,
    });
  });

  it('answers backend_unreachable when nothing listens', async () => {
    const closed = createBackendAccessTokenSource({ baseUrl: 'http://127.0.0.1:1', token: BEARER });
    expect(await closed.accessToken(ACCOUNT)).toEqual({
      ok: false,
      reason: 'backend_unreachable',
    });
  });

  it('answers backend_unreachable when the timeout passes', async () => {
    reply = () => {};
    expect(await source(50).accessToken(ACCOUNT)).toEqual({
      ok: false,
      reason: 'backend_unreachable',
    });
  });

  it("answers backend_unreachable when the caller's signal aborts", async () => {
    reply = () => {};
    const controller = new AbortController();
    const pending = source().accessToken(ACCOUNT, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'backend_unreachable' });
  });

  it('keeps the token and the URL out of every failure', async () => {
    const failures = [
      await createBackendAccessTokenSource({
        baseUrl: 'http://127.0.0.1:1',
        token: BEARER,
      }).accessToken(ACCOUNT),
      await (async () => {
        reply = (res) => json(res, 200, { accessToken: SECRET, extra: SECRET });
        return source().accessToken(ACCOUNT);
      })(),
    ];
    for (const failure of failures) {
      const text = JSON.stringify(failure);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(BEARER);
      expect(text).not.toContain('127.0.0.1');
    }
  });
});

describe('reportRefusedToken (#281)', () => {
  const reportWith = async (answer: AccessTokenOutcome) => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(logOptions('info'), {
      write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    await reportRefusedToken(
      { accessToken: () => Promise.resolve(answer) },
      logger,
      { brokerAccountId: ACCOUNT, intentId: 'intent-1' },
      SECRET,
      { mayRefresh: false },
    );
    return lines;
  };

  it.each<AccessTokenOutcome>([
    { ok: true, accessToken: 'another' },
    { ok: false, reason: 'refresh_needed' },
  ])('logs an answer of the backend as reported: %o', async (answer) => {
    const lines = await reportWith(answer);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'refused token reported',
        brokerAccountId: ACCOUNT,
        intentId: 'intent-1',
        answer: answer.ok ? 'ok' : answer.reason,
      }),
    ]);
  });

  it.each<AccessTokenOutcome>([
    { ok: false, reason: 'backend_status', status: 400 },
    { ok: false, reason: 'backend_unreachable' },
    { ok: false, reason: 'contract_violation', status: 200 },
  ])('warns when the backend never answered for the token: %o', async (answer) => {
    const lines = await reportWith(answer);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'refused token not reported',
        failure: answer.ok ? undefined : answer.reason,
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });
});

describe('notConfiguredAccessTokenSource', () => {
  it('answers not_configured, which is not a refusal', async () => {
    const outcome = await notConfiguredAccessTokenSource.accessToken(ACCOUNT);
    expect(outcome).toEqual({ ok: false, reason: 'not_configured' });
    expect(!outcome.ok && isAccessTokenRefusal(outcome.reason)).toBe(false);
  });
});
