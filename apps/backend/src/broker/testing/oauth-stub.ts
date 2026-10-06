import Fastify, { type FastifyInstance } from 'fastify';

// A stand-in for the broker's token and email-login endpoints that keeps the properties the flow
// depends on: an authorization code is single-use and expires, it is bound to the client and
// redirect URI it was issued for, a refresh token belongs to a family where only the newest
// member is accepted, and an email code is single-use, expires and belongs to one address. Statuses and error bodies are the ones the live broker answers with
// (docs/binodex-oauth.md -> Broker contract). The real mock broker is #35; this one exists so the
// backend suite can prove its own behaviour.
export interface OAuthStubOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeTtlMs?: number;
  expiresInSec?: number;
  // the only partner_code the email login accepts
  partnerCode?: string;
  // holds every request until release(), counted on arrival; used to exercise the client's abort
  // while the request is provably still at the broker
  hang?: boolean;
}

export interface IssuedCode {
  code: string;
  brokerUserId: string;
  email: string;
  isPartnerClient: boolean;
}

export interface OAuthStub {
  url: string;
  // every request to any endpoint
  tokenRequests: number;
  // the path of every request, in order
  paths: string[];
  // seeded from the option; a case that needs one answered request first switches it on later
  hang: boolean;
  // requests parked by `hang` and not released yet
  pendingHangs: number;
  // the body keys of the last request to each JSON endpoint, to prove what the client sends
  lastRefreshBodyKeys: string[] | undefined;
  lastSendCodeBodyKeys: string[] | undefined;
  lastEmailLoginBodyKeys: string[] | undefined;
  issueCode(input: Partial<IssuedCode> & { brokerUserId: string }): string;
  // an account the broker already has, so an email login signs in rather than registers
  registerEmailUser(input: { email: string; brokerUserId: string; isPartnerClient: boolean }): void;
  // the newest code sent to the address, as the inbox would show it
  codeFor(email: string): string | undefined;
  // lets every parked request answer as usual
  release(): void;
  // releases first: Fastify's close waits for handlers still in flight
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
  // lower-cased address -> the newest code sent to it, and the account it signs in to
  const emailCodes = new Map<string, { code: string; expiresAt: number; used: boolean }>();
  const emailUsers = new Map<string, { brokerUserId: string; isPartnerClient: boolean }>();
  let issued = 0;
  let parked: (() => void)[] = [];

  const app: FastifyInstance = Fastify({ logger: false });
  const stub: OAuthStub = {
    url: '',
    tokenRequests: 0,
    paths: [],
    hang: options.hang ?? false,
    pendingHangs: 0,
    lastRefreshBodyKeys: undefined,
    lastSendCodeBodyKeys: undefined,
    lastEmailLoginBodyKeys: undefined,
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
    registerEmailUser: ({ email, brokerUserId, isPartnerClient }) => {
      emailUsers.set(email.toLowerCase(), { brokerUserId, isPartnerClient });
    },
    codeFor: (email) => emailCodes.get(email.toLowerCase())?.code,
    release: () => {
      const waiting = parked;
      parked = [];
      stub.pendingHangs = 0;
      for (const resume of waiting) resume();
    },
    close: () => {
      stub.release();
      return app.close();
    },
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

  async function received(path: string) {
    stub.tokenRequests += 1;
    stub.paths.push(path);
    if (stub.hang) {
      stub.pendingHangs += 1;
      await new Promise<void>((resolve) => parked.push(resolve));
    }
  }

  app.post('/v1/broker/oauth/token', async (request, reply) => {
    await received(request.url);
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
    await received(request.url);
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

  const keysOf = (body: Record<string, unknown> | undefined) =>
    body === undefined ? [] : Object.keys(body).sort();
  const credentialsMatch = (body: Record<string, unknown> | undefined) =>
    body?.client_id === options.clientId && body.client_secret === options.clientSecret;

  app.post('/v1/broker/user-auth/email/send-code', async (request, reply) => {
    await received(request.url);
    const body = request.body as Record<string, unknown> | undefined;
    stub.lastSendCodeBodyKeys = keysOf(body);
    if (!credentialsMatch(body)) {
      return reply.code(401).send(brokerError('Authentication failed: Invalid client credentials'));
    }
    const email = body?.email;
    // the live broker answers this message for any address it will not take, not only a missing one
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      return reply.code(400).send(brokerError('Validation failed: "email" is required'));
    }
    const code = `${100_000 + ++issued}`;
    emailCodes.set(email.toLowerCase(), { code, expiresAt: Date.now() + codeTtlMs, used: false });
    return reply.send({ status: true });
  });

  app.post('/v1/broker/user-auth/email/login', async (request, reply) => {
    await received(request.url);
    const body = request.body as Record<string, unknown> | undefined;
    stub.lastEmailLoginBodyKeys = keysOf(body);
    if (!credentialsMatch(body)) {
      return reply.code(401).send(brokerError('Authentication failed: Invalid client credentials'));
    }
    const { email, code } = body ?? {};
    if (typeof email !== 'string' || typeof code !== 'string') {
      return reply.code(400).send(brokerError('Validation failed: "code" is required'));
    }
    // checked before the code, so a wrong partner code leaves the code usable
    if (options.partnerCode !== undefined && body?.partner_code !== options.partnerCode) {
      return reply
        .code(400)
        .send(brokerError('partner_code does not belong to your partner account'));
    }
    const key = email.toLowerCase();
    const record = emailCodes.get(key);
    if (
      record === undefined ||
      record.used ||
      record.expiresAt < Date.now() ||
      record.code !== code
    ) {
      return reply.code(400).send(brokerError('Invalid or expired code'));
    }
    record.used = true;
    let account = emailUsers.get(key);
    if (account === undefined) {
      // a new account is registered under the partner code, so it is a partner client
      account = { brokerUserId: `email-user-${++issued}`, isPartnerClient: true };
      emailUsers.set(key, account);
    }
    return reply.send({
      ...issuePair(account.brokerUserId),
      user: { id: account.brokerUserId, email: key, is_partner_client: account.isPartnerClient },
    });
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  stub.url = await app.listen({ port: 0, host: '127.0.0.1' });
  return stub;
}
