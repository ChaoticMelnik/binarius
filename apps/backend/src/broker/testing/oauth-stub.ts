import Fastify, { type FastifyInstance } from 'fastify';

// A stand-in for the broker's token endpoint that keeps the properties the flow depends on:
// an authorization code is single-use and expires, it is bound to the client and redirect URI
// it was issued for, and a refresh token belongs to a family where only the newest member is
// accepted. The real mock broker is #35; this one exists so the backend suite can prove its
// own behaviour.
export interface OAuthStubOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeTtlMs?: number;
  expiresInSec?: number;
  // delays the response body; used to exercise the client's abort
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
  tokenRequests: number;
  issueCode(input: Partial<IssuedCode> & { brokerUserId: string }): string;
  // the refresh token the stub currently considers valid for a family
  currentRefreshToken(family: string): string | undefined;
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
  const users = new Map<string, IssuedCode>();
  let issued = 0;

  const app: FastifyInstance = Fastify({ logger: false });
  const stub: OAuthStub = {
    url: '',
    tokenRequests: 0,
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
    currentRefreshToken: (family) => families.get(family),
    close: () => app.close(),
  };

  function issueTokens(family: string, user: IssuedCode) {
    const refreshToken = `refresh-${family}-${++issued}`;
    families.set(family, refreshToken);
    familyOfToken.set(refreshToken, family);
    users.set(family, user);
    return {
      access_token: `access-${family}-${issued}`,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: expiresInSec,
      user: { id: user.brokerUserId, email: user.email, is_partner_client: user.isPartnerClient },
    };
  }

  app.post('/v1/broker/oauth/token', async (request, reply) => {
    stub.tokenRequests += 1;
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const form = new URLSearchParams(request.body as string);
    if (
      form.get('client_id') !== options.clientId ||
      form.get('client_secret') !== options.clientSecret
    ) {
      return reply.code(401).send({ error: 'invalid_client' });
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
        return reply.code(400).send({ error: 'invalid_grant' });
      }
      record.used = true;
      return reply.send(issueTokens(record.brokerUserId, record));
    }

    if (form.get('grant_type') === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const family = familyOfToken.get(presented);
      const user = family === undefined ? undefined : users.get(family);
      // only the newest member of a family is accepted; an older one means the pair was
      // already rotated, which is what a replayed refresh token looks like
      if (family === undefined || user === undefined || families.get(family) !== presented) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
      return reply.send(issueTokens(family, user));
    }

    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  stub.url = await app.listen({ port: 0, host: '127.0.0.1' });
  return stub;
}
