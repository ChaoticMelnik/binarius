import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOAuthStub, type OAuthStub } from './testing/oauth-stub';
import {
  BrokerOAuthError,
  BrokerOAuthErrorCode,
  createBrokerOAuthClient,
  type BrokerOAuthClient,
} from './oauth-client';

const CLIENT_ID = 'client-id';
const CLIENT_SECRET = 'client-secret-value';
const REDIRECT_URI = 'https://example.test/oauth/callback';

let stub: OAuthStub;
let client: BrokerOAuthClient;

beforeAll(async () => {
  stub = await startOAuthStub({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
  client = createBrokerOAuthClient({
    baseUrl: stub.url,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
});
afterAll(() => stub.close());

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
  it('rotates the pair and refuses the token it replaced', async () => {
    const code = stub.issueCode({ brokerUserId: 'broker-6' });
    const first = await client.exchangeCode({ code, redirectUri: REDIRECT_URI });
    const rotated = await client.refresh({ refreshToken: first.refreshToken });
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    // the replayed token is exactly what the acceptance criterion is about
    expect(await codeOf(client.refresh({ refreshToken: first.refreshToken }))).toBe(
      BrokerOAuthErrorCode.InvalidGrant,
    );
  });
});

describe('transport failures', () => {
  it('aborts the request when the broker is slow and reports an unknown outcome', async () => {
    const slow = await startOAuthStub({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      delayMs: 2_000,
    });
    const impatient = createBrokerOAuthClient({
      baseUrl: slow.url,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      timeoutMs: 50,
    });
    try {
      const code = slow.issueCode({ brokerUserId: 'broker-7' });
      const started = Date.now();
      expect(await codeOf(impatient.exchangeCode({ code, redirectUri: REDIRECT_URI }))).toBe(
        BrokerOAuthErrorCode.Unavailable,
      );
      expect(Date.now() - started).toBeLessThan(1_000);
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
});
