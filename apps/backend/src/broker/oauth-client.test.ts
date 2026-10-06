import { createServer } from 'node:http';
import Fastify, { type FastifyReply } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '@binarius/shared/testing';
import { startOAuthStub, type OAuthStub } from './testing/oauth-stub';
import {
  BROKER_ENDPOINTS,
  BrokerOAuthError,
  BrokerOAuthErrorCode,
  createBrokerOAuthClient,
  type BrokerOAuthClient,
} from './oauth-client';

const CLIENT_ID = 'client-id';
const CLIENT_SECRET = 'client-secret-value';
const REDIRECT_URI = 'https://example.test/oauth/callback';
const PARTNER_CODE = 'zr7IA7';

let stub: OAuthStub;
let client: BrokerOAuthClient;

beforeAll(async () => {
  stub = await startOAuthStub({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    partnerCode: PARTNER_CODE,
  });
  client = createBrokerOAuthClient({
    baseUrl: stub.url,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
});
afterAll(() => stub.close());

// a broker that answers every request to `path` the same way
async function withBroker(
  path: string,
  answer: (reply: FastifyReply) => FastifyReply,
  run: (client: BrokerOAuthClient) => Promise<void>,
): Promise<void> {
  const broker = Fastify({ logger: false });
  // without a parser for the form content type Fastify answers 415 and the case would prove
  // nothing about the status or the body
  broker.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );
  broker.post(path, async (_request, reply) => answer(reply));
  const url = await broker.listen({ port: 0, host: '127.0.0.1' });
  try {
    await run(
      createBrokerOAuthClient({ baseUrl: url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    );
  } finally {
    await broker.close();
  }
}

const TOKEN_PATH = '/v1/broker/oauth/token';
const REFRESH_PATH = '/v1/broker/user-auth/refresh';
const SEND_CODE_PATH = '/v1/broker/user-auth/email/send-code';
const EMAIL_LOGIN_PATH = '/v1/broker/user-auth/email/login';

async function codeOf(error: Promise<unknown>): Promise<string> {
  const thrown = await error.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(thrown).toBeInstanceOf(BrokerOAuthError);
  return (thrown as BrokerOAuthError).code;
}

describe('exchangeCode', () => {
  it('sends the documented form and maps the response to domain tokens', async () => {
    const code = stub.issueCode({ brokerUserId: 'broker-1', isPartnerClient: true });
    const tokens = await client.exchangeCode({ code, redirectUri: REDIRECT_URI });
    expect(tokens).toMatchObject({
      tokenType: 'Bearer',
      user: { id: 'broker-1', email: 'broker-1@example.test', isPartnerClient: true },
    });
    expect(tokens.accessToken).not.toBe('');
    expect(tokens.expiresInSec).toBeGreaterThan(0);
  });

  it('refuses a replayed code, an expired code and a foreign redirect uri', async () => {
    const used = stub.issueCode({ brokerUserId: 'broker-2' });
    await client.exchangeCode({ code: used, redirectUri: REDIRECT_URI });
    expect(await codeOf(client.exchangeCode({ code: used, redirectUri: REDIRECT_URI }))).toBe(
      BrokerOAuthErrorCode.InvalidGrant,
    );

    const fresh = stub.issueCode({ brokerUserId: 'broker-3' });
    expect(
      await codeOf(client.exchangeCode({ code: fresh, redirectUri: 'https://evil.test/cb' })),
    ).toBe(BrokerOAuthErrorCode.InvalidGrant);

    expect(
      await codeOf(client.exchangeCode({ code: 'never-issued', redirectUri: REDIRECT_URI })),
    ).toBe(BrokerOAuthErrorCode.InvalidGrant);
  });

  it('expires a code on the stub clock', async () => {
    const expiring = await startOAuthStub({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      codeTtlMs: 10,
    });
    const shortLived = createBrokerOAuthClient({
      baseUrl: expiring.url,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    try {
      const code = expiring.issueCode({ brokerUserId: 'broker-4' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await codeOf(shortLived.exchangeCode({ code, redirectUri: REDIRECT_URI }))).toBe(
        BrokerOAuthErrorCode.InvalidGrant,
      );
    } finally {
      await expiring.close();
    }
  });

  it('reports a wrong client secret as a rejection, not as a grant problem', async () => {
    const wrong = createBrokerOAuthClient({
      baseUrl: stub.url,
      clientId: CLIENT_ID,
      clientSecret: 'not-the-secret',
    });
    const code = stub.issueCode({ brokerUserId: 'broker-5' });
    expect(await codeOf(wrong.exchangeCode({ code, redirectUri: REDIRECT_URI }))).toBe(
      BrokerOAuthErrorCode.Rejected,
    );
  });
});

describe('refresh', () => {
  it('sends the refresh token alone, as JSON, without the client credentials', async () => {
    const code = stub.issueCode({ brokerUserId: 'broker-8' });
    const first = await client.exchangeCode({ code, redirectUri: REDIRECT_URI });
    const rotated = await client.refresh({ refreshToken: first.refreshToken });
    expect(stub.lastRefreshBodyKeys).toEqual(['refresh_token']);
    expect(rotated).not.toHaveProperty('user');
    expect(rotated.expiresInSec).toBeGreaterThan(0);
  });

  it('rotates the pair and refuses the token it replaced', async () => {
    const code = stub.issueCode({ brokerUserId: 'broker-6' });
    const first = await client.exchangeCode({ code, redirectUri: REDIRECT_URI });
    const rotated = await client.refresh({ refreshToken: first.refreshToken });
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    // the replayed token is exactly what the acceptance criterion is about
    expect(await codeOf(client.refresh({ refreshToken: first.refreshToken }))).toBe(
      BrokerOAuthErrorCode.InvalidGrant,
    );

    // and the replay costs the whole chain, not just the token that was replayed: the current
    // member stops working too, which is why an unknown outcome has to revoke the account
    expect(await codeOf(client.refresh({ refreshToken: rotated.refreshToken }))).toBe(
      BrokerOAuthErrorCode.InvalidGrant,
    );
  });
});

// The status alone decides; the bodies are what the live broker sends, plus an OAuth-style one
// to show that a body naming a grant error changes nothing.
describe('status map', () => {
  const live = (message: string) => ({ error: { message, details: {} } });
  const endpoints = {
    'oauth/token': {
      path: TOKEN_PATH,
      call: (probe: BrokerOAuthClient) =>
        probe.exchangeCode({ code: 'c', redirectUri: REDIRECT_URI }),
    },
    'user-auth/refresh': {
      path: REFRESH_PATH,
      call: (probe: BrokerOAuthClient) => probe.refresh({ refreshToken: 'r' }),
    },
    'email/send-code': {
      path: SEND_CODE_PATH,
      call: (probe: BrokerOAuthClient) => probe.sendEmailCode({ email: 'ada@example.test' }),
    },
    'email/login': {
      path: EMAIL_LOGIN_PATH,
      call: (probe: BrokerOAuthClient) =>
        probe.emailLogin({ email: 'ada@example.test', code: '1', partnerCode: PARTNER_CODE }),
    },
  };

  it.each([
    ['oauth/token', 400, live('Invalid or expired authorization code'), 'invalid_grant'],
    // our own malformed request lands here too: the accepted cost of not reading the body
    ['oauth/token', 400, live('Validation failed: "code" is required'), 'invalid_grant'],
    ['oauth/token', 400, { error: 'invalid_grant' }, 'invalid_grant'],
    ['oauth/token', 401, live('Authentication failed: Invalid client credentials'), 'rejected'],
    ['oauth/token', 401, { error: 'invalid_grant' }, 'rejected'],
    ['oauth/token', 405, '', 'rejected'],
    ['oauth/token', 502, '', 'unavailable'],
    ['user-auth/refresh', 401, live('Invalid token'), 'invalid_grant'],
    ['user-auth/refresh', 400, live('Validation failed: "refresh_token" is required'), 'rejected'],
    ['user-auth/refresh', 400, { error: 'invalid_grant' }, 'rejected'],
    ['user-auth/refresh', 403, live('Forbidden'), 'rejected'],
    ['user-auth/refresh', 503, live('Service unavailable'), 'unavailable'],
    ['email/send-code', 400, live('Validation failed: "email" is required'), 'invalid_grant'],
    ['email/send-code', 401, live('Authentication failed: Invalid client credentials'), 'rejected'],
    ['email/send-code', 503, live('Service unavailable'), 'unavailable'],
    ['email/login', 400, live('Invalid or expired code'), 'invalid_grant'],
    // a partner code that is not ours reads as a bad code: the accepted cost of not reading the body
    [
      'email/login',
      400,
      live('partner_code does not belong to your partner account'),
      'invalid_grant',
    ],
    ['email/login', 401, live('Authentication failed: Invalid client credentials'), 'rejected'],
    ['email/login', 502, '', 'unavailable'],
  ] as const)('%s %i with %j is %s', async (name, status, body, expected) => {
    const { path, call } = endpoints[name];
    await withBroker(
      path,
      (reply) => reply.code(status).send(body),
      async (probe) => {
        const thrown = await call(probe).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(thrown).toBeInstanceOf(BrokerOAuthError);
        expect((thrown as BrokerOAuthError).code).toBe(expected);
        expect((thrown as BrokerOAuthError).status).toBe(status);
      },
    );
  });
});

describe('endpoint table', () => {
  it('names the four documented paths', () => {
    expect(Object.values(BROKER_ENDPOINTS).map(({ path }) => path)).toEqual([
      TOKEN_PATH,
      REFRESH_PATH,
      SEND_CODE_PATH,
      EMAIL_LOGIN_PATH,
    ]);
  });

  it('sends each call to its own row of the table', async () => {
    const calls: Record<keyof typeof BROKER_ENDPOINTS, () => Promise<unknown>> = {
      token: () => client.exchangeCode({ code: 'never-issued', redirectUri: REDIRECT_URI }),
      refresh: () => client.refresh({ refreshToken: 'never-issued' }),
      sendCode: () => client.sendEmailCode({ email: 'table@example.test' }),
      emailLogin: () =>
        client.emailLogin({ email: 'table@example.test', code: 'x', partnerCode: PARTNER_CODE }),
    };
    for (const [name, call] of Object.entries(calls)) {
      const before = stub.paths.length;
      await call().catch(() => undefined);
      expect(stub.paths.slice(before)).toEqual([
        BROKER_ENDPOINTS[name as keyof typeof BROKER_ENDPOINTS].path,
      ]);
    }
  });
});

describe('sendEmailCode', () => {
  it('sends the credentials and the address as JSON and resolves on { status: true }', async () => {
    await expect(client.sendEmailCode({ email: 'Ada@Example.test' })).resolves.toBeUndefined();
    expect(stub.lastSendCodeBodyKeys).toEqual(['client_id', 'client_secret', 'email']);
    expect(stub.codeFor('ada@example.test')).toBeDefined();
  });

  it.each([
    ['{ status: false }', { status: false }],
    ['an empty object', {}],
  ])('treats %s as a contract violation', async (_label, body) => {
    await withBroker(
      SEND_CODE_PATH,
      (reply) => reply.send(body),
      async (probe) => {
        expect(await codeOf(probe.sendEmailCode({ email: 'ada@example.test' }))).toBe(
          BrokerOAuthErrorCode.ContractViolation,
        );
      },
    );
  });

  it('accepts extra fields beside status: true', async () => {
    await withBroker(
      SEND_CODE_PATH,
      (reply) => reply.send({ status: true, message: 'sent' }),
      async (probe) => {
        await expect(probe.sendEmailCode({ email: 'ada@example.test' })).resolves.toBeUndefined();
      },
    );
  });
});

describe('emailLogin', () => {
  it('registers a new partner account with the partner code and returns domain tokens', async () => {
    await client.sendEmailCode({ email: 'new@example.test' });
    const code = stub.codeFor('new@example.test') ?? '';
    const tokens = await client.emailLogin({
      email: 'new@example.test',
      code,
      partnerCode: PARTNER_CODE,
    });
    expect(stub.lastEmailLoginBodyKeys).toEqual([
      'client_id',
      'client_secret',
      'code',
      'email',
      'partner_code',
    ]);
    expect(tokens).toMatchObject({
      tokenType: 'Bearer',
      user: { email: 'new@example.test', isPartnerClient: true },
    });
    expect(tokens.refreshToken).not.toBe('');
    // the code is single-use
    expect(
      await codeOf(
        client.emailLogin({ email: 'new@example.test', code, partnerCode: PARTNER_CODE }),
      ),
    ).toBe(BrokerOAuthErrorCode.InvalidGrant);
  });

  it('signs an existing account in, and its refresh token rotates on user-auth/refresh', async () => {
    stub.registerEmailUser({
      email: 'old@example.test',
      brokerUserId: 'broker-old',
      isPartnerClient: false,
    });
    await client.sendEmailCode({ email: 'old@example.test' });
    const tokens = await client.emailLogin({
      email: 'old@example.test',
      code: stub.codeFor('old@example.test') ?? '',
      partnerCode: PARTNER_CODE,
    });
    expect(tokens.user).toEqual({
      id: 'broker-old',
      email: 'old@example.test',
      isPartnerClient: false,
    });
    const rotated = await client.refresh({ refreshToken: tokens.refreshToken });
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
  });

  it('reports a foreign partner code as a refused grant and leaves the code usable', async () => {
    await client.sendEmailCode({ email: 'partner@example.test' });
    const code = stub.codeFor('partner@example.test') ?? '';
    expect(
      await codeOf(
        client.emailLogin({ email: 'partner@example.test', code, partnerCode: 'not-ours' }),
      ),
    ).toBe(BrokerOAuthErrorCode.InvalidGrant);
    await expect(
      client.emailLogin({ email: 'partner@example.test', code, partnerCode: PARTNER_CODE }),
    ).resolves.toMatchObject({ user: { email: 'partner@example.test' } });
  });

  it('treats a 2xx body without a user as a contract violation', async () => {
    await withBroker(
      EMAIL_LOGIN_PATH,
      (reply) =>
        reply.send({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 60 }),
      async (probe) => {
        expect(
          await codeOf(
            probe.emailLogin({ email: 'a@example.test', code: '1', partnerCode: PARTNER_CODE }),
          ),
        ).toBe(BrokerOAuthErrorCode.ContractViolation);
      },
    );
  });
});

describe('transport failures', () => {
  it('aborts the request when the broker is slow and reports an unknown outcome', async () => {
    const slow = await startOAuthStub({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      hang: true,
    });
    // the client's timer is the only clock here, and it is also the window the request has to
    // reach the stub in
    const impatient = createBrokerOAuthClient({
      baseUrl: slow.url,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      timeoutMs: 1_000,
    });
    try {
      const code = slow.issueCode({ brokerUserId: 'broker-7' });
      const outcome = codeOf(impatient.exchangeCode({ code, redirectUri: REDIRECT_URI }));
      await until('the stub to hold the request', () => slow.pendingHangs === 1);
      expect(await outcome).toBe(BrokerOAuthErrorCode.Unavailable);
      expect(slow.tokenRequests).toBe(1);
    } finally {
      await slow.close();
    }
  });

  it('reports an unreachable broker as unavailable without retrying', async () => {
    const dead = await startOAuthStub({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    const url = dead.url;
    await dead.close();
    const orphan = createBrokerOAuthClient({
      baseUrl: url,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      timeoutMs: 200,
    });
    expect(await codeOf(orphan.exchangeCode({ code: 'x', redirectUri: REDIRECT_URI }))).toBe(
      BrokerOAuthErrorCode.Unavailable,
    );
  });

  // the body decides: one that never finished arriving leaves the outcome unknown, so it must
  // not be filed as the broker breaking its contract
  it('reports a body cut short mid-flight as unavailable', async () => {
    const truncating = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
      response.write('{"access_token":');
      response.socket?.destroy();
    });
    await new Promise<void>((resolve) => truncating.listen(0, '127.0.0.1', resolve));
    const address = truncating.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const probe = createBrokerOAuthClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });
      expect(await codeOf(probe.exchangeCode({ code: 'c', redirectUri: REDIRECT_URI }))).toBe(
        BrokerOAuthErrorCode.Unavailable,
      );
    } finally {
      await new Promise<void>((resolve) => truncating.close(() => resolve()));
    }
  });

  it.each([
    ['a body that is not JSON', 'not-json'],
    ['a response without a refresh token', 'missing-refresh'],
    ['an access token that is already expired', 'zero-expiry'],
  ])('treats %s as a contract violation', async (_label, shape) => {
    const odd = Fastify({ logger: false });
    // without a parser for the form content type Fastify answers 415 and the case would
    // prove nothing about the body
    odd.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => done(null, body),
    );
    odd.post('/v1/broker/oauth/token', async (_request, reply) => {
      if (shape === 'not-json') return reply.type('application/json').send('{oops');
      const user = { id: '1', email: 'e@example.test', is_partner_client: false };
      if (shape === 'missing-refresh') {
        return reply.send({ access_token: 'a', token_type: 'Bearer', expires_in: 60, user });
      }
      return reply.send({
        access_token: 'a',
        refresh_token: 'r',
        token_type: 'Bearer',
        expires_in: 0,
        user,
      });
    });
    const url = await odd.listen({ port: 0, host: '127.0.0.1' });
    try {
      const probe = createBrokerOAuthClient({
        baseUrl: url,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });
      expect(await codeOf(probe.exchangeCode({ code: 'c', redirectUri: REDIRECT_URI }))).toBe(
        BrokerOAuthErrorCode.ContractViolation,
      );
    } finally {
      await odd.close();
    }
  });
});

describe('refresh contract', () => {
  it.each([
    [
      'a response without a refresh token',
      { access_token: 'a', token_type: 'Bearer', expires_in: 60 },
    ],
    [
      'an access token that is already expired',
      { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 0 },
    ],
  ])('treats %s as a contract violation', async (_label, body) => {
    await withBroker(
      REFRESH_PATH,
      (reply) => reply.send(body),
      async (probe) => {
        expect(await codeOf(probe.refresh({ refreshToken: 'r' }))).toBe(
          BrokerOAuthErrorCode.ContractViolation,
        );
      },
    );
  });
});

describe('secrecy', () => {
  it('never carries the secret, the code or a token on the error', async () => {
    const wrong = createBrokerOAuthClient({
      baseUrl: stub.url,
      clientId: CLIENT_ID,
      clientSecret: 'MARKER-SECRET',
    });
    const thrown = await wrong
      .exchangeCode({ code: 'MARKER-CODE', redirectUri: REDIRECT_URI })
      .then(
        () => undefined,
        (e: unknown) => e as BrokerOAuthError,
      );
    const serialized = `${String(thrown?.message)}${String(thrown?.stack)}${JSON.stringify(thrown)}`;
    expect(serialized).not.toContain('MARKER-SECRET');
    expect(serialized).not.toContain('MARKER-CODE');
  });

  it('never carries the refresh token or the broker error text on a refresh error', async () => {
    await withBroker(
      REFRESH_PATH,
      (reply) => reply.code(401).send({ error: { message: 'MARKER-BODY', details: {} } }),
      async (probe) => {
        const thrown = await probe.refresh({ refreshToken: 'MARKER-REFRESH' }).then(
          () => undefined,
          (e: unknown) => e as BrokerOAuthError,
        );
        expect(thrown).toBeInstanceOf(BrokerOAuthError);
        const serialized = `${String(thrown?.message)}${String(thrown?.stack)}${JSON.stringify(thrown)}`;
        expect(serialized).not.toContain('MARKER-REFRESH');
        expect(serialized).not.toContain('MARKER-BODY');
      },
    );
  });

  it.each([
    [
      'email/send-code',
      SEND_CODE_PATH,
      (probe: BrokerOAuthClient) => probe.sendEmailCode({ email: 'MARKER-EMAIL@example.test' }),
    ],
    [
      'email/login',
      EMAIL_LOGIN_PATH,
      (probe: BrokerOAuthClient) =>
        probe.emailLogin({
          email: 'MARKER-EMAIL@example.test',
          code: 'MARKER-CODE',
          partnerCode: 'MARKER-PARTNER',
        }),
    ],
  ])(
    'never carries the address, the code, the partner code or the body on an %s error',
    async (_name, path, call) => {
      await withBroker(
        path,
        (reply) => reply.code(400).send({ error: { message: 'MARKER-BODY', details: {} } }),
        async (probe) => {
          const thrown = await call(probe).then(
            () => undefined,
            (e: unknown) => e as BrokerOAuthError,
          );
          expect(thrown).toBeInstanceOf(BrokerOAuthError);
          const serialized = `${String(thrown?.message)}${String(thrown?.stack)}${JSON.stringify(thrown)}`;
          for (const marker of ['MARKER-EMAIL', 'MARKER-CODE', 'MARKER-PARTNER', 'MARKER-BODY']) {
            expect(serialized).not.toContain(marker);
          }
        },
      );
    },
  );
});
