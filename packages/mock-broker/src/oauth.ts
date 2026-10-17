import type { FastifyInstance } from 'fastify';
import { brokerError, FIXTURE_MESSAGES, LIVE_MESSAGES } from './messages';
import type { BrokerState } from './state';

// The broker's token and email-login endpoints (docs/binodex-oauth.md -> Broker contract), with
// the properties the backend's flow depends on: an authorization code and an email code are
// single-use and expire, the authorization code is bound to its redirect_uri, an email code to its
// address, and a refresh token belongs to its user's family where only the newest member is
// accepted. An issued access token is registered in the store, so REST and the socket accept it.
export interface MockOAuthOptions {
  clientId: string;
  clientSecret: string;
  // the only partner_code the email login accepts; any is accepted when left out
  partnerCode?: string;
  expiresInSec: number;
  codeTtlMs: number;
}

export const MOCK_OAUTH_DEFAULTS = {
  clientId: 'mock-client',
  clientSecret: 'mock-secret',
  // the live answer's expires_in (2026-10-01)
  expiresInSec: 604_800,
  codeTtlMs: 120_000,
} as const satisfies MockOAuthOptions;

export interface MockOAuth {
  // the newest email code sent to the address, as the inbox would show it
  codeFor(email: string): string | undefined;
  // an authorization code for oauth/token, as the broker's authorize page would hand it out
  issueCode(input: { userId: number; redirectUri: string; ttlMs?: number }): string;
}

export type MockOAuthEndpoint = 'oauthToken' | 'emailSendCode' | 'emailLogin' | 'refresh';

interface CodeRecord {
  code: string;
  expiresAt: number;
  used: boolean;
}

const ADDRESS = /^[^\s@]+@[^\s@]+$/;

const fieldOf = (body: Record<string, unknown>, key: string): string | undefined => {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
};

export function attachMockOAuth(
  app: FastifyInstance,
  state: BrokerState,
  options: MockOAuthOptions,
  urls: Record<MockOAuthEndpoint, string>,
): MockOAuth {
  const authorizationCodes = new Map<
    string,
    CodeRecord & { userId: number; redirectUri: string }
  >();
  // lower-cased address -> the newest code sent to it
  const emailCodes = new Map<string, CodeRecord>();
  // user -> the only refresh token still accepted; a replay deletes the entry
  const newestRefresh = new Map<number, string>();
  const refreshOwner = new Map<string, number>();
  let issued = 0;

  function issuePair(userId: number) {
    issued += 1;
    const accessToken = `mock-access-${userId}-${issued}`;
    const refreshToken = `mock-refresh-${userId}-${issued}`;
    state.addAccessToken(userId, accessToken);
    newestRefresh.set(userId, refreshToken);
    refreshOwner.set(refreshToken, userId);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: options.expiresInSec,
    };
  }

  function withUser(userId: number) {
    const profile = state.userProfile(userId);
    return {
      ...issuePair(userId),
      // a JSON number, as the live user.id=101962
      user: {
        id: profile.id,
        email: profile.email ?? '',
        is_partner_client: profile.isPartnerClient,
      },
    };
  }

  const credentialsMatch = (body: Record<string, unknown>) =>
    body.client_id === options.clientId && body.client_secret === options.clientSecret;

  const usable = (record: CodeRecord | undefined): record is CodeRecord =>
    record !== undefined && !record.used && record.expiresAt >= Date.now();

  const bodyOf = (raw: unknown): Record<string, unknown> =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  // the form parser lives in this scope only: elsewhere a form body stays the refused content type
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );

    scope.post(urls.oauthToken, async (request, reply) => {
      const body = bodyOf(request.body);
      if (!credentialsMatch(body)) {
        return reply.code(401).send(brokerError(LIVE_MESSAGES.invalidClientCredentials));
      }
      // the live broker has no refresh grant here and asks for the code it expects
      const code = fieldOf(body, 'code');
      if (fieldOf(body, 'grant_type') !== 'authorization_code' || code === undefined) {
        return reply.code(400).send(brokerError(LIVE_MESSAGES.codeRequired));
      }
      const record = authorizationCodes.get(code);
      if (!usable(record) || record.redirectUri !== fieldOf(body, 'redirect_uri')) {
        return reply.code(400).send(brokerError(LIVE_MESSAGES.invalidAuthorizationCode));
      }
      record.used = true;
      return withUser(record.userId);
    });
  });

  app.post(urls.refresh, async (request, reply) => {
    const presented = fieldOf(bodyOf(request.body), 'refresh_token');
    if (presented === undefined) {
      return reply.code(400).send(brokerError(LIVE_MESSAGES.refreshTokenRequired));
    }
    const userId = refreshOwner.get(presented);
    if (userId === undefined) {
      return reply.code(401).send(brokerError(LIVE_MESSAGES.refreshInvalidToken));
    }
    // an older member kills the whole family: after a replay the newest is refused too (live,
    // docs/binodex-oauth.md -> Live check: OAuth tokens on user-auth/refresh)
    if (newestRefresh.get(userId) !== presented) {
      newestRefresh.delete(userId);
      return reply.code(401).send(brokerError(LIVE_MESSAGES.refreshInvalidToken));
    }
    return issuePair(userId);
  });

  app.post(urls.emailSendCode, async (request, reply) => {
    const body = bodyOf(request.body);
    if (!credentialsMatch(body)) {
      return reply.code(401).send(brokerError(LIVE_MESSAGES.invalidClientCredentials));
    }
    const email = fieldOf(body, 'email');
    // the live broker answers this message for any address it will not take
    if (email === undefined || !ADDRESS.test(email)) {
      return reply.code(400).send(brokerError(LIVE_MESSAGES.emailRequired));
    }
    issued += 1;
    emailCodes.set(email.toLowerCase(), {
      code: String(100_000 + issued),
      expiresAt: Date.now() + options.codeTtlMs,
      used: false,
    });
    return { status: true };
  });

  app.post(urls.emailLogin, async (request, reply) => {
    const body = bodyOf(request.body);
    if (!credentialsMatch(body)) {
      return reply.code(401).send(brokerError(LIVE_MESSAGES.invalidClientCredentials));
    }
    const email = fieldOf(body, 'email');
    const code = fieldOf(body, 'code');
    if (email === undefined || code === undefined) {
      return reply.code(400).send(brokerError(LIVE_MESSAGES.codeRequired));
    }
    // checked before the code, so a foreign partner code leaves the code usable
    if (options.partnerCode !== undefined && body.partner_code !== options.partnerCode) {
      return reply.code(400).send(brokerError(FIXTURE_MESSAGES.partnerCodeForeign));
    }
    const address = email.toLowerCase();
    const record = emailCodes.get(address);
    if (!usable(record) || record.code !== code) {
      return reply.code(400).send(brokerError(LIVE_MESSAGES.invalidEmailCode));
    }
    record.used = true;
    // an unknown address registers, under the partner code the login carries
    const userId = state.findUserByEmail(address) ?? state.registerEmailUser(address);
    return withUser(userId);
  });

  return {
    codeFor: (email) => emailCodes.get(email.toLowerCase())?.code,
    issueCode({ userId, redirectUri, ttlMs }) {
      state.userProfile(userId);
      issued += 1;
      const code = `mock-code-${issued}`;
      authorizationCodes.set(code, {
        code,
        userId,
        redirectUri,
        expiresAt: Date.now() + (ttlMs ?? options.codeTtlMs),
        used: false,
      });
      return code;
    },
  };
}
