import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { accessTokenPath, safeParseAccessTokenResponse } from '@binarius/shared';
import { buildApp } from '../app';
import { unusedAdminDeps } from '../admin/testing';
import type { AuthRoutesDeps } from '../auth/routes';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import type { UsersRoutesDeps } from '../users/routes';
import type { TradingRoutesDeps } from './routes';
import {
  PAIRS_TEST_TOKEN,
  unusedBalanceDeps,
  unusedPairsDeps,
  unusedSignalDeps,
  unusedSessionDeps,
  unusedSignalsDeps,
} from './testing';

const ACCOUNT = '0b8f3c62-7a1e-4d2b-9a55-3c1f2e4d5a6b';
const SECRET = 'live-access-token-must-not-reach-a-log';

let app: FastifyInstance | undefined;
let calls: { accountId: string; options: AccessTokenOptions }[] = [];
let lines: string[] = [];

function appWith(answer: AccessTokenResult): FastifyInstance {
  app = buildApp({
    checkPostgres: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    // the most verbose level: a body that reached any line would show here
    logLevel: 'trace',
    checkTimeoutMs: 20,
    logDestination: { write: (line: string) => void lines.push(line) },
    trading: {
      db: {} as TradingRoutesDeps['db'],
      internalApiToken: PAIRS_TEST_TOKEN,
      onIntentQueued: () => {},
      balance: unusedBalanceDeps(),
      accessToken: (accountId, options) => {
        calls.push({ accountId, options });
        return Promise.resolve(answer);
      },
    },
    pairs: unusedPairsDeps(),
    sessions: unusedSessionDeps(),
    signal: unusedSignalDeps(),
    signals: unusedSignalsDeps(),
    auth: { internalApiToken: PAIRS_TEST_TOKEN } as AuthRoutesDeps,
    users: { db: {} as UsersRoutesDeps['db'], internalApiToken: PAIRS_TEST_TOKEN },
    admin: unusedAdminDeps(),
  });
  return app;
}

const post = (
  target: FastifyInstance,
  body: unknown,
  { id = ACCOUNT, token = PAIRS_TEST_TOKEN }: { id?: string; token?: string | null } = {},
) =>
  target.inject({
    method: 'POST',
    url: accessTokenPath(id),
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body as object,
  });

afterEach(async () => {
  await app?.close();
  app = undefined;
  calls = [];
  lines = [];
});

describe('POST /trading/accounts/:id/access-token (#90)', () => {
  const granted: AccessTokenResult = { ok: true, accessToken: SECRET };

  it.each([null, 'wrong-token'])('refuses bearer %s with 401 before the lookup', async (token) => {
    const response = await post(appWith(granted), { mayRefresh: true }, { token });
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers the token alone', async () => {
    const response = await post(appWith(granted), { mayRefresh: true });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accessToken: SECRET });
    expect(safeParseAccessTokenResponse(response.json()).success).toBe(true);
  });

  it.each([true, false])('passes mayRefresh: %s through as the caller named it', async (flag) => {
    await post(appWith(granted), { mayRefresh: flag });
    expect(calls).toEqual([{ accountId: ACCOUNT, options: { mayRefresh: flag } }]);
  });

  it('answers 404 for an id that is not a uuid, without a lookup', async () => {
    const response = await post(appWith(granted), { mayRefresh: true }, { id: 'not-a-uuid' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'account_not_found' });
    expect(calls).toEqual([]);
  });

  it('answers 404 for an account the lookup does not find', async () => {
    const response = await post(appWith({ ok: false, reason: 'account_not_found' }), {
      mayRefresh: true,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'account_not_found' });
  });

  it.each([
    ['no mayRefresh', {}],
    ['a string flag', { mayRefresh: 'true' }],
    ['an extra key', { mayRefresh: true, accountId: ACCOUNT }],
  ])('answers 400 for a body with %s, without a lookup', async (_name, body) => {
    const response = await post(appWith(granted), body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation' });
    expect(calls).toEqual([]);
  });

  it.each([
    { ok: false, reason: 'user_blocked' },
    { ok: false, reason: 'account_pending' },
    { ok: false, reason: 'key_unavailable' },
    { ok: false, reason: 'refresh_needed' },
    { ok: false, reason: 'account_revoked', revokedReason: 'refresh_expired' },
  ] as const satisfies AccessTokenResult[])(
    'answers 409 for $reason, code only',
    async (answer) => {
      const response = await post(appWith(answer), { mayRefresh: false });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: answer.reason });
    },
  );

  it('keeps the token out of every log line', async () => {
    await post(appWith(granted), { mayRefresh: true });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
