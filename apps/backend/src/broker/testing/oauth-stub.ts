import Fastify, { type FastifyInstance } from 'fastify';

// A stand-in for the broker's two token endpoints that keeps the properties the flow depends on:
// an authorization code is single-use and expires, it is bound to the client and redirect URI
// it was issued for, and a refresh token belongs to a family where only the newest member is
// accepted. Statuses and error bodies are the ones the live broker answers with
// (docs/binodex-oauth.md -> Broker contract). The real mock broker is #35; this one exists so the
// backend suite can prove its own behaviour.
export interface OAuthStubOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeTtlMs?: number;
  expiresInSec?: number;
  // delays the response on both endpoints; used to exercise the client's abort
  delayMs?: number;
}

export interface IssuedCode {
  code: string;
  brokerUserId: string;
  email: string;
  isPartnerClient: boolean;
}

export interface OAuthStub {
  url: string;
  // every request to either endpoint
  tokenRequests: number;
  // the body keys of the last refresh request, to prove what the client sends
  lastRefreshBodyKeys: string[] | undefined;
  issueCode(input: Partial<IssuedCode> & { brokerUserId: string }): string;
  close(): Promise<void>;
}

interface CodeRecord extends IssuedCode {
  expiresAt: number;
  used: boolean;
}

export async function startOAuthStub(options: OAuthStubOptions): Promise<OAuthStub> {
  const codeTtlMs = options.codeTtlMs ?? 120_000;
  const expiresInSec = options.expiresInSec ?? 7 * 24 * 60 * 60;
  const codes = new Map<string, CodeRecord>();
  // family -> the only refresh token still accepted
  const families = new Map<string, string>();
  const familyOfToken = new Map<string, string>();
  let issued = 0;

  const app: FastifyInstance = Fastify({ logger: false });
  const stub: OAuthStub = {
    url: '',
    tokenRequests: 0,
    lastRefreshBodyKeys: undefined,
    issueCode: ({ brokerUserId, email, isPartnerClient, code }) => {
      const value = code ?? `code-${++issued}`;
      codes.set(value, {
        code: value,
        brokerUserId,
        email: email ?? `${brokerUserId}@example.test`,
        isPartnerClient: isPartnerClient ?? false,
        expiresAt: Date.now() + codeTtlMs,
        used: false,
      });
      return value;
    },
    close: () => app.close(),
  };

  function issuePair(family: string) {
    const refreshToken = `refresh-${family}-${++issued}`;
    families.set(family, refreshToken);
    familyOfToken.set(refreshToken, family);
    return {
      access_token: `access-${family}-${issued}`,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: expiresInSec,
    };
  }

  const brokerError = (message: string) => ({ error: { message, details: {} } });

  async function received() {
    stub.tokenRequests += 1;
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  app.post('/v1/broker/oauth/token', async (request, reply) => {
    await received();
    const form = new URLSearchParams(request.body as string);
    if (
      form.get('client_id') !== options.clientId ||
      form.get('client_secret') !== options.clientSecret
    ) {
      return reply.code(401).send(brokerError('Authentication failed: Invalid client credentials'));
    }

    if (form.get('grant_type') === 'authorization_code') {
      const record = codes.get(form.get('code') ?? '');
      const redirectMatches = form.get('redirect_uri') === options.redirectUri;
      if (
        record === undefined ||
        record.used ||
        record.expiresAt < Date.now() ||
        !redirectMatches
      ) {
        return reply.code(400).send(brokerError('Invalid or expired authorization code'));
      }
      record.used = true;
      return reply.send({
        ...issuePair(record.brokerUserId),
        user: {
          id: record.brokerUserId,
          email: record.email,
          is_partner_client: record.isPartnerClient,
        },
      });
    }

    // the live broker has no refresh grant here and asks for the code it expects
    return reply.code(400).send(brokerError('Validation failed: "code" is required'));
  });

  app.post('/v1/broker/user-auth/refresh', async (request, reply) => {
    await received();
    const body = request.body as Record<string, unknown> | undefined;
    stub.lastRefreshBodyKeys = body === undefined ? [] : Object.keys(body).sort();
    const presented = body?.refresh_token;
    if (typeof presented !== 'string') {
      return reply.code(400).send(brokerError('Validation failed: "refresh_token" is required'));
    }
    const family = familyOfToken.get(presented);
    if (family === undefined) {
      return reply.code(401).send(brokerError('Invalid token'));
    }
    // Only the newest member of a family is accepted, and presenting an older one kills the
    // whole family — the live broker does the same: after a replay the newest token is refused
    // too. It cannot tell our retry from someone replaying a stolen token, so it stops trusting
    // the chain rather than the single token.
    if (families.get(family) !== presented) {
      families.delete(family);
      return reply.code(401).send(brokerError('Invalid token'));
    }
    return reply.send(issuePair(family));
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  stub.url = await app.listen({ port: 0, host: '127.0.0.1' });
  return stub;
}
