import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountHaltReason,
  ADMIN_ACTIVE_WINDOW_MINUTES,
  ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS,
  ADMIN_BOT_PROFILE_IDENTITY_MAX,
  ADMIN_BOT_TEXT_FRAGMENTS_MAX,
  ADMIN_BOT_TEXT_REASON_MAX,
  ADMIN_PAGE_SIZE,
  ADMIN_USER_RECENT_INTENTS,
  ADMIN_USER_RECENT_LEDGER,
  AuditAction,
  AuditActorType,
  AuditEntityType,
  AuthRevokedReason,
  BOT_PROFILE_METHODS,
  BOT_TEXT_OVERRIDES_MAX,
  BOT_TEXT_SOURCE_MAX,
  BrokerAccountStatus,
  CLIENT_USER_AGENT_MAX_LENGTH,
  DepositEventStatus,
  INT4_MAX,
  MAX_SESSION_TRADES,
  NotificationLevel,
  safeParseAdminAuditResponse,
  safeParseAdminBotProfilePublishResponse,
  safeParseAdminBotTextPreviewResponse,
  safeParseAdminBotTextResetResponse,
  safeParseAdminBotTextResponse,
  safeParseAdminBotTextSaveResponse,
  safeParseAdminBotTextsResponse,
  safeParseAdminBrokerAccountsResponse,
  safeParseAdminConfirmResponse,
  safeParseAdminDepositsResponse,
  safeParseAdminIntentResponse,
  safeParseAdminIntentsResponse,
  safeParseAdminLoginResponse,
  safeParseAdminOverviewResponse,
  safeParseAdminTokenAdjustmentResponse,
  safeParseAdminTokensResponse,
  safeParseAdminTradingSessionsResponse,
  safeParseAdminUserResponse,
  safeParseAdminUsersResponse,
  safeParseChangePasswordResponse,
  safeParseLogoutResponse,
  safeParseOAuthCallbackResponse,
  safeParseRevokeSessionResponse,
  safeParseStaffSessionsResponse,
  TOKEN_LEDGER_NOTE_MAX,
  TokenLedgerKind,
  TokenLedgerRefType,
  TradeAction,
  TradeIntentFailureReason,
  TradeIntentStatus,
  TradeMode,
  TradeTransport,
  TradingSessionStatus,
  TradingSessionStopReason,
  UserStatus,
} from '@binarius/shared';
import {
  SAMPLE_ADJUSTED,
  SAMPLE_AUDIT,
  SAMPLE_AUDIT_ENTRY,
  SAMPLE_BOT_TEXT,
  SAMPLE_BOT_TEXTS,
  SAMPLE_BROKER_ACCOUNT_ITEM,
  SAMPLE_BROKER_ACCOUNTS,
  SAMPLE_DEPOSIT,
  SAMPLE_DEPOSITS,
  SAMPLE_INTENT,
  SAMPLE_PUBLISHED,
  SAMPLE_INTENT_RESPONSE,
  SAMPLE_INTENTS,
  SAMPLE_LEDGER_ENTRY,
  SAMPLE_ME,
  SAMPLE_OVERVIEW,
  SAMPLE_SESSION_ID,
  SAMPLE_TOKENS,
  SAMPLE_TRADING_SESSION,
  SAMPLE_TRADING_SESSIONS,
  SAMPLE_USER,
  SAMPLE_USER_ID,
  sampleAdjustmentRefusal,
} from './admin/testing';
import {
  BackendError,
  BackendErrorCode,
  createBackendClient,
  type BackendClient,
  MAX_BACKEND_BODY_BYTES,
  MAX_BOT_TEXTS_BODY_BYTES,
} from './backend-client';

const TOKEN = 'admin-web-token-for-tests';
// `+` is a signed space and `%2B` a signed plus: the forward must carry both exactly as given
const INIT_DATA = 'query_id=AA%2BBB&user=%7B%22first_name%22%3A%22A+B%22%7D&auth_date=1&hash=ff';
const CALLBACK = { state: 's'.repeat(43), code: 'c'.repeat(32), initData: INIT_DATA };
const ACCOUNT = {
  id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01',
  brokerUserId: 'broker-1',
  email: null,
  isPartnerClient: true,
  status: 'pending',
  createdAt: '2026-09-23T09:21:52.000Z',
};

interface Captured {
  method?: string;
  url?: string;
  headers?: IncomingMessage['headers'];
  body?: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(
  handle: (response: ServerResponse) => void,
): Promise<{ baseUrl: string; captured: Captured }> {
  const captured: Captured = {};
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      captured.method = request.method;
      captured.url = request.url;
      captured.headers = request.headers;
      captured.body = body;
      handle(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, captured };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

describe('oauthCallback', () => {
  it('posts the body unchanged to the public callback, without the admin bearer', async () => {
    const { baseUrl, captured } = await serve((response) => {
      json(response, 200, { account: ACCOUNT });
    });
    const answer = await createBackendClient({ baseUrl, token: TOKEN }).oauthCallback(CALLBACK);

    expect(answer).toEqual({ account: ACCOUNT });
    expect(captured.url).toBe('/auth/binodex/callback');
    expect(captured.headers?.authorization).toBeUndefined();
    expect(captured.body).toBe(JSON.stringify(CALLBACK));
    expect((JSON.parse(captured.body ?? '') as { initData: string }).initData).toBe(INIT_DATA);
  });

  it('carries the backend error code and status of a refusal', async () => {
    const { baseUrl } = await serve((response) => {
      json(response, 403, { error: 'telegram_user_mismatch' });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).oauthCallback(CALLBACK),
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 403,
      reason: 'telegram_user_mismatch',
    });
  });

  it('refuses a 2xx body outside the contract', async () => {
    const { baseUrl } = await serve((response) => {
      json(response, 200, { account: { ...ACCOUNT, id: 'not-a-uuid' } });
    });
    const error = await rejectionOf(
      createBackendClient({ baseUrl, token: TOKEN }).oauthCallback(CALLBACK),
    );
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  // its own timeout, not the admin calls' one: the callback is sized against another budget
  it('gives up on a backend that never answers after the callback timeout', async () => {
    const { baseUrl } = await serve(() => {});
    const client = createBackendClient({
      baseUrl,
      token: TOKEN,
      timeoutMs: 60_000,
      oauthCallbackTimeoutMs: 50,
    });
    const error = await rejectionOf(client.oauthCallback(CALLBACK));
    expect(error).toMatchObject({ code: BackendErrorCode.Unreachable });
  });
});

describe('the admin calls', () => {
  it('still carry the bearer', async () => {
    const { baseUrl, captured } = await serve((response) => {
      json(response, 200, { loggedOut: true });
    });
    await createBackendClient({ baseUrl, token: TOKEN }).logout('t'.repeat(43));
    expect(captured.url).toBe('/admin/auth/logout');
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('the read calls (#107)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';

  // a base URL with a path prefix: every path the client sends must stay relative to it
  const prefixed = async (body: unknown, status = 200) => {
    const served = await serve((response) => {
      json(response, status, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the list with the query percent-encoded, under the prefix', async () => {
    const { client, captured } = await prefixed({ me: SAMPLE_ME, users: [], nextCursor: null });
    await client.users(SESSION, { q: 'a&b+c#д', cursor: CURSOR });
    expect(captured.url).toBe(`/api/admin/users?q=a%26b%2Bc%23%D0%B4&cursor=${CURSOR}`);
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
  });

  it('sends no query string for an empty query', async () => {
    const { client, captured } = await prefixed({ me: SAMPLE_ME, users: [], nextCursor: null });
    await client.users(SESSION, {});
    expect(captured.url).toBe('/api/admin/users');
  });

  it('asks for the card and the overview under the prefix', async () => {
    const card = await prefixed(SAMPLE_USER);
    expect(await card.client.user(SESSION, SAMPLE_USER_ID)).toEqual(SAMPLE_USER);
    expect(card.captured.url).toBe(`/api/admin/users/${SAMPLE_USER_ID}`);

    const overview = await prefixed(SAMPLE_OVERVIEW);
    expect(await overview.client.overview(SESSION)).toEqual(SAMPLE_OVERVIEW);
    expect(overview.captured.url).toBe('/api/admin/overview');
  });

  it('carries a missing card as the backend answered it', async () => {
    const { client } = await prefixed({ error: 'not_found' }, 404);
    const error = await rejectionOf(client.user(SESSION, SAMPLE_USER_ID));
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: 'not_found',
    });
  });

  // the views are strict: a column the backend started sending is not silently dropped
  it('refuses a card with a key the contract does not name', async () => {
    const leaked = {
      ...SAMPLE_USER,
      brokerAccounts: [{ ...SAMPLE_USER.brokerAccounts[0], accessTokenEnc: 'x' }],
    };
    const { client } = await prefixed(leaked);
    const error = await rejectionOf(client.user(SESSION, SAMPLE_USER_ID));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the intents calls (#108)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';

  const prefixed = async (body: unknown, status = 200) => {
    const served = await serve((response) => {
      json(response, status, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the list with only the filters given, in the schema order, under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_INTENTS);
    expect(
      await client.intents(SESSION, {
        cursor: CURSOR,
        session: SAMPLE_SESSION_ID,
        status: 'active',
      }),
    ).toEqual(SAMPLE_INTENTS);
    expect(captured.url).toBe(
      `/api/admin/intents?status=active&session=${SAMPLE_SESSION_ID}&cursor=${CURSOR}`,
    );
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
  });

  it('sends no query string for no filters', async () => {
    const { client, captured } = await prefixed(SAMPLE_INTENTS);
    await client.intents(SESSION, {});
    expect(captured.url).toBe('/api/admin/intents');
  });

  it('asks for the card under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_INTENT_RESPONSE);
    expect(await client.intent(SESSION, SAMPLE_INTENT.id)).toEqual(SAMPLE_INTENT_RESPONSE);
    expect(captured.url).toBe(`/api/admin/intents/${SAMPLE_INTENT.id}`);
  });

  it('carries a missing card as the backend answered it', async () => {
    const { client } = await prefixed({ error: 'not_found' }, 404);
    const error = await rejectionOf(client.intent(SESSION, SAMPLE_INTENT.id));
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: 'not_found',
    });
  });

  it.each([
    ['a list row', { ...SAMPLE_INTENTS, intents: [{ ...SAMPLE_INTENT, accessTokenEnc: 'x' }] }],
    ['the list', { ...SAMPLE_INTENTS, extra: 1 }],
  ])('refuses %s with a key the contract does not name', async (_label, body) => {
    const { client } = await prefixed(body);
    const error = await rejectionOf(client.intents(SESSION, {}));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('refuses a card with a key the contract does not name', async () => {
    const { client } = await prefixed({
      ...SAMPLE_INTENT_RESPONSE,
      intent: { ...SAMPLE_INTENT, settings: {} },
    });
    const error = await rejectionOf(client.intent(SESSION, SAMPLE_INTENT.id));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the trading sessions call (#330)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';

  const prefixed = async (body: unknown) => {
    const served = await serve((response) => {
      json(response, 200, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the page with the cursor, the bearer and the staff session, under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_TRADING_SESSIONS);
    expect(await client.tradingSessions(SESSION, { cursor: CURSOR })).toEqual(
      SAMPLE_TRADING_SESSIONS,
    );
    expect(captured.url).toBe(`/api/admin/trading-sessions?cursor=${CURSOR}`);
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no query string for the first page', async () => {
    const { client, captured } = await prefixed(SAMPLE_TRADING_SESSIONS);
    await client.tradingSessions(SESSION, {});
    expect(captured.url).toBe('/api/admin/trading-sessions');
  });

  it.each([
    [
      'a row',
      {
        ...SAMPLE_TRADING_SESSIONS,
        sessions: [{ ...SAMPLE_TRADING_SESSION, summarySentAt: null }],
      },
    ],
    ['the page', { ...SAMPLE_TRADING_SESSIONS, extra: 1 }],
  ])('refuses %s with a key the contract does not name', async (_label, body) => {
    const { client } = await prefixed(body);
    const error = await rejectionOf(client.tradingSessions(SESSION, {}));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the token ledger call (#109)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';

  const prefixed = async (body: unknown) => {
    const served = await serve((response) => {
      json(response, 200, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the page with the filters in the schema order, the bearer and the staff session, under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_TOKENS);
    expect(
      await client.tokens(SESSION, { cursor: CURSOR, kind: 'adjustment', user: SAMPLE_USER_ID }),
    ).toEqual(SAMPLE_TOKENS);
    expect(captured.url).toBe(
      `/api/admin/tokens?user=${SAMPLE_USER_ID}&kind=adjustment&cursor=${CURSOR}`,
    );
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no query string for no filters', async () => {
    const { client, captured } = await prefixed(SAMPLE_TOKENS);
    await client.tokens(SESSION, {});
    expect(captured.url).toBe('/api/admin/tokens');
  });

  it.each([
    ['a row', { ...SAMPLE_TOKENS, entries: [{ ...SAMPLE_LEDGER_ENTRY, accessTokenEnc: 'x' }] }],
    ['the page', { ...SAMPLE_TOKENS, extra: 1 }],
  ])('refuses %s with a key the contract does not name', async (_label, body) => {
    const { client } = await prefixed(body);
    const error = await rejectionOf(client.tokens(SESSION, {}));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the audit log call (#110)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';
  const ACTOR = '00000000-0000-4000-8000-0000000000a1';

  const prefixed = async (body: unknown) => {
    const served = await serve((response) => {
      json(response, 200, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the page with every filter in the schema order, the bearer and the staff session, under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_AUDIT);
    expect(
      await client.audit(SESSION, {
        cursor: CURSOR,
        to: '2026-10-07',
        from: '2026-10-01',
        actorId: ACTOR,
        entityId: SAMPLE_USER_ID,
        entityType: 'user',
        action: 'user_viewed',
      }),
    ).toEqual(SAMPLE_AUDIT);
    expect(captured.url).toBe(
      `/api/admin/audit?action=user_viewed&entityType=user&entityId=${SAMPLE_USER_ID}&actorId=${ACTOR}&from=2026-10-01&to=2026-10-07&cursor=${CURSOR}`,
    );
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no query string for no filters', async () => {
    const { client, captured } = await prefixed(SAMPLE_AUDIT);
    await client.audit(SESSION, {});
    expect(captured.url).toBe('/api/admin/audit');
  });

  it.each([
    ['a row', { ...SAMPLE_AUDIT, entries: [{ ...SAMPLE_AUDIT_ENTRY, payloadRaw: {} }] }],
    ['the page', { ...SAMPLE_AUDIT, extra: 1 }],
  ])('refuses %s with a key the contract does not name', async (_label, body) => {
    const { client } = await prefixed(body);
    const error = await rejectionOf(client.audit(SESSION, {}));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the deposits call (#341)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';

  const prefixed = async (body: unknown) => {
    const served = await serve((response) => {
      json(response, 200, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the page with the filters in the schema order, the bearer and the staff session, under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_DEPOSITS);
    expect(
      await client.deposits(SESSION, { cursor: CURSOR, status: 'credited', user: SAMPLE_USER_ID }),
    ).toEqual(SAMPLE_DEPOSITS);
    expect(captured.url).toBe(
      `/api/admin/deposits?user=${SAMPLE_USER_ID}&status=credited&cursor=${CURSOR}`,
    );
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no query string for no filters', async () => {
    const { client, captured } = await prefixed(SAMPLE_DEPOSITS);
    await client.deposits(SESSION, {});
    expect(captured.url).toBe('/api/admin/deposits');
  });

  it.each([
    ['a row', { ...SAMPLE_DEPOSITS, deposits: [{ ...SAMPLE_DEPOSIT, payload: {} }] }],
    ['the page', { ...SAMPLE_DEPOSITS, extra: 1 }],
  ])('refuses %s with a key the contract does not name', async (_label, body) => {
    const { client } = await prefixed(body);
    const error = await rejectionOf(client.deposits(SESSION, {}));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the broker accounts call (#342)', () => {
  const SESSION = 's'.repeat(43);
  const CURSOR = '00000000-0000-4000-8000-0000000000ee';

  const prefixed = async (body: unknown) => {
    const served = await serve((response) => {
      json(response, 200, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('asks for the page with the filters in the schema order, the bearer and the staff session, under the prefix', async () => {
    const { client, captured } = await prefixed(SAMPLE_BROKER_ACCOUNTS);
    expect(
      await client.brokerAccounts(SESSION, { cursor: CURSOR, halted: 'true', status: 'active' }),
    ).toEqual(SAMPLE_BROKER_ACCOUNTS);
    expect(captured.url).toBe(
      `/api/admin/broker-accounts?status=active&halted=true&cursor=${CURSOR}`,
    );
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no query string for no filters', async () => {
    const { client, captured } = await prefixed(SAMPLE_BROKER_ACCOUNTS);
    await client.brokerAccounts(SESSION, {});
    expect(captured.url).toBe('/api/admin/broker-accounts');
  });

  it.each([
    [
      'a row',
      {
        ...SAMPLE_BROKER_ACCOUNTS,
        accounts: [{ ...SAMPLE_BROKER_ACCOUNT_ITEM, accessTokenEnc: 'x' }],
      },
    ],
    ['the page', { ...SAMPLE_BROKER_ACCOUNTS, extra: 1 }],
  ])('refuses %s with a key the contract does not name', async (_label, body) => {
    const { client } = await prefixed(body);
    const error = await rejectionOf(client.brokerAccounts(SESSION, {}));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the password change call (#79)', () => {
  const SESSION = 's'.repeat(43);
  const REQUEST = {
    currentPassword: 'CURRENT-SECRET',
    newPassword: 'NEW-SECRET',
    ip: '203.0.113.7',
    userAgent: 'agent',
  };

  const prefixed = async (status: number, body: unknown) => {
    const served = await serve((response) => {
      json(response, status, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('posts the request as given with the bearer and the staff session, under the prefix', async () => {
    const { client, captured } = await prefixed(200, { changed: true, revokedSessions: 2 });
    expect(await client.changePassword(SESSION, REQUEST)).toEqual({
      changed: true,
      revokedSessions: 2,
    });
    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('/api/admin/auth/password');
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
    expect(JSON.parse(captured.body ?? '')).toEqual(REQUEST);
  });

  it('carries a refusal as its status and code', async () => {
    const { client } = await prefixed(401, { error: 'invalid_credentials' });
    const error = await rejectionOf(client.changePassword(SESSION, REQUEST));
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 401,
      reason: 'invalid_credentials',
    });
  });

  it.each([
    ['a key the contract does not name', { changed: true, revokedSessions: 1, extra: 1 }],
    ['a negative count', { changed: true, revokedSessions: -1 }],
    ['no count', { changed: true }],
  ])('refuses a 2xx with %s', async (_label, body) => {
    const { client } = await prefixed(200, body);
    const error = await rejectionOf(client.changePassword(SESSION, REQUEST));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the bot texts calls (#300)', () => {
  const SESSION = 's'.repeat(43);
  const prefixed = async (body: unknown) => {
    const served = await serve((response) => {
      json(response, 200, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };
  const text = { me: SAMPLE_ME, text: SAMPLE_BOT_TEXT };

  it.each([
    ['botTexts', [], 'GET', '/api/admin/bot-texts', undefined, SAMPLE_BOT_TEXTS],
    ['botText', ['welcome'], 'GET', '/api/admin/bot-texts/welcome', undefined, text],
    [
      'previewBotText',
      ['a b', { source: 'x' }],
      'POST',
      '/api/admin/bot-texts/a%20b/preview',
      { source: 'x' },
      { ...text, outcome: 'refused', problems: [{ key: 'welcome', reason: 'Пустой текст' }] },
    ],
    [
      'saveBotText',
      ['welcome', { source: 'x', expectedVersion: 7 }],
      'POST',
      '/api/admin/bot-texts/welcome/save',
      { source: 'x', expectedVersion: 7 },
      { ...text, outcome: 'saved', version: 8, published: [] },
    ],
    [
      'resetBotText',
      ['zzz', { expectedVersion: 9 }],
      'POST',
      '/api/admin/bot-texts/zzz/reset',
      { expectedVersion: 9 },
      { me: SAMPLE_ME, text: null, outcome: 'reset', published: [] },
    ],
    [
      'publishBotProfile',
      [],
      'POST',
      '/api/admin/bot-texts/publish',
      undefined,
      { me: SAMPLE_ME, published: SAMPLE_PUBLISHED },
    ],
  ] as const)(
    '%s sends its path, the bearer, the session and the body',
    async (name, args, method, url, body, answer) => {
      const { client, captured } = await prefixed(answer);
      const call = client[name] as (
        session: string,
        ...rest: readonly unknown[]
      ) => Promise<unknown>;
      expect(await call(SESSION, ...args)).toEqual(answer);
      expect([captured.method, captured.url]).toEqual([method, url]);
      expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(captured.headers?.['x-staff-session']).toBe(SESSION);
      if (body !== undefined) expect(JSON.parse(captured.body ?? '')).toEqual(body);
    },
  );

  it('refuses a 2xx with a key the contract does not name', async () => {
    const { client } = await prefixed({ ...text, outcome: 'unchanged', extra: 1 });
    const save = client.saveBotText(SESSION, 'welcome', { source: 'x', expectedVersion: 0 });
    expect(await rejectionOf(save)).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });

  it('C6 publishes with no body, and refuses an answer the contract does not take', async () => {
    const { client, captured } = await prefixed({ me: SAMPLE_ME, published: SAMPLE_PUBLISHED });
    await client.publishBotProfile(SESSION);
    expect(captured.body ?? '').toBe('');
    expect(captured.headers?.['content-type']).toBeUndefined();

    for (const answer of [
      { me: SAMPLE_ME, published: SAMPLE_PUBLISHED, extra: 1 },
      { me: SAMPLE_ME, published: [...SAMPLE_PUBLISHED, SAMPLE_PUBLISHED[0]] },
      {
        me: SAMPLE_ME,
        published: [{ method: 'setMyCommands', ok: false, err: { name: 'E', message: 'x' } }],
      },
    ]) {
      const refused = await prefixed(answer);
      expect(await rejectionOf(refused.client.publishBotProfile(SESSION))).toMatchObject({
        code: BackendErrorCode.ContractViolation,
      });
    }
  });

  it('refuses a 2xx with a preview Telegram would refuse', async () => {
    const { client } = await prefixed({
      ...text,
      outcome: 'rendered',
      rendered: { kind: 'html', telegramHtml: 'a < b' },
    });
    const preview = client.previewBotText(SESSION, 'welcome', { source: 'x' });
    expect(await rejectionOf(preview)).toMatchObject({ code: BackendErrorCode.ContractViolation });
  });
});

describe('the token adjustment call (#246)', () => {
  const SESSION = 's'.repeat(43);
  const REQUEST = { delta: '-50', note: 'Компенсация', expectedBalance: '5' };
  const prefixed = async (status: number, body: unknown) => {
    const served = await serve((response) => {
      json(response, status, body);
    });
    return {
      client: createBackendClient({ baseUrl: `${served.baseUrl}/api`, token: TOKEN }),
      captured: served.captured,
    };
  };

  it('posts the request with the bearer and the staff session to the user path', async () => {
    const { client, captured } = await prefixed(200, SAMPLE_ADJUSTED);
    expect(await client.adjustTokens(SESSION, SAMPLE_USER_ID, REQUEST)).toEqual(SAMPLE_ADJUSTED);
    expect([captured.method, captured.url]).toEqual([
      'POST',
      `/api/admin/users/${SAMPLE_USER_ID}/tokens`,
    ]);
    expect(captured.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(captured.headers?.['x-staff-session']).toBe(SESSION);
    expect(captured.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(captured.body ?? '')).toEqual(REQUEST);
  });

  it.each(['insufficient_available', 'balance_changed'] as const)(
    'reads the %s refusal as an answer, with the card',
    async (outcome) => {
      const refusal = sampleAdjustmentRefusal(outcome);
      const { client } = await prefixed(200, refusal);
      expect(await client.adjustTokens(SESSION, SAMPLE_USER_ID, REQUEST)).toEqual(refusal);
    },
  );

  it('refuses a 2xx with a key the contract does not name', async () => {
    const { client } = await prefixed(200, { ...SAMPLE_ADJUSTED, extra: 1 });
    const adjusting = client.adjustTokens(SESSION, SAMPLE_USER_ID, REQUEST);
    expect(await rejectionOf(adjusting)).toMatchObject({
      code: BackendErrorCode.ContractViolation,
    });
  });

  it('carries a 404 as its status and code', async () => {
    const { client } = await prefixed(404, { error: 'not_found' });
    const error = await rejectionOf(client.adjustTokens(SESSION, SAMPLE_USER_ID, REQUEST));
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({
      code: BackendErrorCode.HttpStatus,
      status: 404,
      reason: 'not_found',
    });
  });
});

describe('body size', () => {
  const SESSION = 's'.repeat(43);
  const PAD = ' '.repeat(64 * 1024);
  const noop = () => {};

  // `head`, then whitespace until the body is longer than `bytes`
  const padded = (response: ServerResponse, status: number, head: string, bytes: number) => {
    response.on('error', noop);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.write(head);
    for (let written = head.length; written <= bytes; written += PAD.length) response.write(PAD);
    response.end();
  };

  // `head`, then whitespace for as long as the client reads
  const endless = (response: ServerResponse, status: number, head: string) => {
    response.on('error', noop);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.write(head);
    const pump = () => {
      for (;;) {
        if (response.destroyed) return;
        if (!response.write(PAD)) break;
      }
      response.once('drain', pump);
    };
    pump();
  };

  const clientOf = (baseUrl: string, timeoutMs = 60_000) =>
    createBackendClient({ baseUrl, token: TOKEN, timeoutMs });

  it('refuses a 2xx longer than its ceiling', async () => {
    const { baseUrl } = await serve((response) => {
      padded(response, 200, '{ "loggedOut": true }', MAX_BACKEND_BODY_BYTES);
    });
    const error = await rejectionOf(clientOf(baseUrl).logout(SESSION));
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  }, 2_000);

  it('carries an endless error body as its status, without a reason', async () => {
    const { baseUrl } = await serve((response) => {
      endless(response, 401, '{"error":"session_invalid",');
    });
    const error = await rejectionOf(clientOf(baseUrl).sessions(SESSION));
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: BackendErrorCode.HttpStatus, status: 401 });
    expect((error as BackendError).reason).toBeUndefined();
  }, 2_000);

  it('a 2xx whose body then stalls is unreachable, with the status', async () => {
    const { baseUrl } = await serve((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"loggedOut":');
    });
    const error = await rejectionOf(clientOf(baseUrl, 50).logout(SESSION));
    expect(error).toMatchObject({ code: BackendErrorCode.Unreachable, status: 200 });
  });

  it('reads a bot text longer than the common ceiling', async () => {
    const answer = { me: SAMPLE_ME, text: SAMPLE_BOT_TEXT };
    const { baseUrl } = await serve((response) => {
      padded(response, 200, JSON.stringify(answer), 2 * MAX_BACKEND_BODY_BYTES);
    });
    expect(await clientOf(baseUrl).botText(SESSION, 'welcome')).toEqual(answer);
  });

  it('refuses a bot text longer than its own ceiling', async () => {
    const head = JSON.stringify({ me: SAMPLE_ME, text: SAMPLE_BOT_TEXT });
    const { baseUrl } = await serve((response) => {
      padded(response, 200, head, MAX_BOT_TEXTS_BODY_BYTES);
    });
    const error = await rejectionOf(clientOf(baseUrl).botText(SESSION, 'welcome'));
    expect(error).toMatchObject({ code: BackendErrorCode.ContractViolation });
  }, 2_000);

  // The longest answer each method can get under the schemas, their writers and the assumptions
  // below, a quarter of its ceiling at most. Appending rule (Rule 26): a task that adds a
  // BackendClient method adds its row here; the gate below is red otherwise. Every assumption is
  // in UTF-8 bytes of the answer's JSON text, not in characters.
  describe('leaves the longest answer under the declared assumptions far below its ceiling', () => {
    // `sessions` of staffSessionsResponseSchema is unbounded; false once a staff member holds 100
    // live sessions
    const ASSUMED_LONGEST_LIST = 100;
    // a string with no max() and no writer that bounds it (brokerUserId, a postback's ids and
    // currency, a staff display name from the CLI); false once one such value is longer
    const ASSUMED_LONGEST_FREE_STRING = 2048;
    // the OAuth path stores the broker's user.email as any string (oauth-ops.ts); false once a
    // broker sends a longer address than RFC 5321 allows
    const ASSUMED_LONGEST_EMAIL = 254;
    // brokerAccounts of the user card (packages/shared/src/admin.ts) is unbounded; false once a
    // user holds more than 10 links
    const ASSUMED_USER_BROKER_ACCOUNTS = 10;
    // problems of a refused preview, save or reset: the schema takes up to BOT_TEXT_OVERRIDES_MAX;
    // false once one change refuses more than 50 overrides
    const ASSUMED_LONGEST_PROBLEMS = 50;

    // A field bounded in characters at its worst: a control character is one UTF-16 unit (what
    // zod's max() counts) and 6 bytes of JSON (\u0001), more than a 4-byte character's 2 a unit.
    const controls = (units: number) => '\x01'.repeat(units);
    const ofBytes = (bytes: number) => 'x'.repeat(bytes);
    // no control characters (checkTokenNote) and counted in code points: 4 bytes each
    const codePoints = (count: number) => '\u{1F600}'.repeat(count);
    const longest = <T extends string>(values: Record<string, T>): T =>
      Object.values(values).reduce((a, b) => (b.length > a.length ? b : a));
    const times = <T>(count: number, item: T): T[] => Array.from({ length: count }, () => item);

    const AT = '2026-10-07T08:00:00.000Z';
    const UUID = '00000000-0000-4000-8000-000000000001';
    const INT8 = '9223372036854775807';
    const MIN_INT8 = '-9223372036854775808';
    const MONEY = '-999999999999.99999999';
    const TRADE_AMOUNT = '999999999999.99999999';
    const COUNT = Number.MAX_SAFE_INTEGER;
    // STAFF_LOGIN_PATTERN: 64 ASCII characters
    const LOGIN = 'a'.repeat(64);
    // BOT_TEXT_KEY_PATTERN: 64 ASCII characters
    const KEY = 'k'.repeat(64);
    const ME = { staffId: UUID, login: LOGIN, sessionId: UUID };

    const brokerAccount = {
      id: UUID,
      brokerUserId: ofBytes(ASSUMED_LONGEST_FREE_STRING),
      email: ofBytes(ASSUMED_LONGEST_EMAIL),
      isPartnerClient: false,
      status: longest(BrokerAccountStatus),
      authRevokedReason: longest(AuthRevokedReason),
      tradingHalted: true,
      haltedReason: longest(AccountHaltReason),
      accessTokenExpiresAt: AT,
      tokenRotatedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    };
    const intent = {
      id: UUID,
      brokerAccountId: UUID,
      telegramUserId: INT8,
      mode: longest(TradeMode),
      assetId: INT4_MAX,
      amount: TRADE_AMOUNT,
      action: longest(TradeAction),
      durationSec: INT4_MAX,
      // createTradeIntentRequestSchema: max(128)
      clientRequestId: controls(128),
      createdAt: AT,
      status: longest(TradeIntentStatus),
      version: COUNT,
      tokensReserved: INT8,
      transport: longest(TradeTransport),
      submittedAt: AT,
      lastError: longest(TradeIntentFailureReason),
      updatedAt: AT,
      userId: UUID,
      tradingSessionId: UUID,
      reconcileClaimedAt: AT,
    };
    const ledgerEntry = {
      id: UUID,
      userId: UUID,
      telegramUserId: INT8,
      kind: longest(TokenLedgerKind),
      balanceDelta: MIN_INT8,
      reservedDelta: MIN_INT8,
      intentId: UUID,
      depositEventId: UUID,
      brokerAccountId: UUID,
      refType: longest(TokenLedgerRefType),
      refId: UUID,
      // the adjustment's note, TOKEN_LEDGER_NOTE_MAX code points (the CHECK of 0036)
      note: codePoints(TOKEN_LEDGER_NOTE_MAX),
      createdAt: AT,
    };
    const deposit = {
      id: UUID,
      userId: UUID,
      telegramUserId: INT8,
      brokerAccountId: UUID,
      postbackId: ofBytes(ASSUMED_LONGEST_FREE_STRING),
      paymentId: ofBytes(ASSUMED_LONGEST_FREE_STRING),
      amount: MONEY,
      currency: ofBytes(ASSUMED_LONGEST_FREE_STRING),
      status: longest(DepositEventStatus),
      processedAt: AT,
      createdAt: AT,
    };
    const card = {
      user: {
        id: UUID,
        telegramUserId: INT8,
        // userStartRequestSchema: max(256)
        displayName: controls(256),
        // languageCodeSchema: max(35) of ASCII
        languageCode: 'x'.repeat(35),
        status: longest(UserStatus),
        // startPayloadSchema: 64 base64url characters
        acquisitionSource: 'x'.repeat(64),
        acquiredAt: AT,
        telegramBlockedAt: AT,
        notificationLevel: longest(NotificationLevel),
        demoStake: MONEY,
        tokens: { balance: INT8, reserved: '0', available: INT8 },
        createdAt: AT,
        updatedAt: AT,
      },
      brokerAccounts: times(ASSUMED_USER_BROKER_ACCOUNTS, brokerAccount),
      intents: { recent: times(ADMIN_USER_RECENT_INTENTS, intent), total: COUNT, active: COUNT },
      ledger: { recent: times(ADMIN_USER_RECENT_LEDGER, ledgerEntry) },
      deposits: { recent: times(ADMIN_USER_RECENT_LEDGER, deposit) },
    };
    const textView = {
      key: KEY,
      override: {
        source: controls(BOT_TEXT_SOURCE_MAX),
        version: COUNT,
        updatedAt: AT,
        updatedByLogin: LOGIN,
      },
      rejection: controls(ADMIN_BOT_TEXT_REASON_MAX),
      fragments: times(ADMIN_BOT_TEXT_FRAGMENTS_MAX, {
        // a catalog placeholder, written by code: a key's length is the longest there
        placeholder: KEY,
        key: KEY,
        source: controls(BOT_TEXT_SOURCE_MAX),
        overridden: true,
      }),
    };
    // longer than a version conflict (a 16 KiB current source) by 50 reasons of 3 KiB
    const refused = {
      me: ME,
      text: textView,
      outcome: 'refused',
      problems: times(ASSUMED_LONGEST_PROBLEMS, {
        key: KEY,
        reason: controls(ADMIN_BOT_TEXT_REASON_MAX),
      }),
    };
    const identity = {
      name: controls(ADMIN_BOT_PROFILE_IDENTITY_MAX),
      code: controls(ADMIN_BOT_PROFILE_IDENTITY_MAX),
    };

    const rows: {
      [K in keyof BackendClient]: {
        parse: (input: unknown) => { success: boolean };
        sample: unknown;
        limit?: number;
      };
    } = {
      login: { parse: safeParseAdminLoginResponse, sample: { challengeId: UUID, expiresAt: AT } },
      confirm: {
        parse: safeParseAdminConfirmResponse,
        sample: { sessionToken: 'a'.repeat(43), expiresAt: AT },
      },
      sessions: {
        parse: safeParseStaffSessionsResponse,
        sample: {
          me: ME,
          sessions: times(ASSUMED_LONGEST_LIST, {
            id: UUID,
            login: LOGIN,
            displayName: ofBytes(ASSUMED_LONGEST_FREE_STRING),
            ip: controls(64),
            userAgent: controls(CLIENT_USER_AGENT_MAX_LENGTH),
            createdAt: AT,
            lastSeenAt: AT,
            expiresAt: AT,
            current: false,
          }),
        },
      },
      revoke: { parse: safeParseRevokeSessionResponse, sample: { revoked: true, current: false } },
      logout: { parse: safeParseLogoutResponse, sample: { loggedOut: true } },
      overview: {
        parse: safeParseAdminOverviewResponse,
        sample: {
          me: ME,
          overview: {
            users: {
              total: COUNT,
              today: COUNT,
              blocked: COUNT,
              withActiveBrokerAccount: COUNT,
              activeNow: COUNT,
            },
            intents: {
              total: COUNT,
              today: COUNT,
              byStatus: Object.fromEntries(
                Object.values(TradeIntentStatus).map((status) => [status, COUNT]),
              ),
              active: COUNT,
            },
            activeWindowMinutes: ADMIN_ACTIVE_WINDOW_MINUTES,
            dayStartsAt: AT,
            asOf: AT,
          },
        },
      },
      users: {
        parse: safeParseAdminUsersResponse,
        sample: {
          me: ME,
          users: times(ADMIN_PAGE_SIZE, {
            id: UUID,
            telegramUserId: INT8,
            displayName: controls(256),
            status: longest(UserStatus),
            tokenBalance: INT8,
            createdAt: AT,
            updatedAt: AT,
          }),
          nextCursor: UUID,
        },
      },
      user: { parse: safeParseAdminUserResponse, sample: { me: ME, ...card } },
      intents: {
        parse: safeParseAdminIntentsResponse,
        sample: { me: ME, intents: times(ADMIN_PAGE_SIZE, intent), nextCursor: UUID },
      },
      intent: { parse: safeParseAdminIntentResponse, sample: { me: ME, intent } },
      tradingSessions: {
        parse: safeParseAdminTradingSessionsResponse,
        sample: {
          me: ME,
          sessions: times(ADMIN_PAGE_SIZE, {
            id: UUID,
            brokerAccountId: UUID,
            brokerUserId: ofBytes(ASSUMED_LONGEST_FREE_STRING),
            userId: UUID,
            telegramUserId: INT8,
            mode: longest(TradeMode),
            status: longest(TradingSessionStatus),
            stopReason: longest(TradingSessionStopReason),
            settings: {
              version: 1,
              assetId: INT4_MAX,
              durationSec: INT4_MAX,
              trades: MAX_SESSION_TRADES,
              stake: { baseStake: TRADE_AMOUNT, stakeScale: 8 },
            },
            startedAt: AT,
            endedAt: AT,
            lastDecisionAt: AT,
            createdAt: AT,
            updatedAt: AT,
          }),
          nextCursor: UUID,
        },
      },
      tokens: {
        parse: safeParseAdminTokensResponse,
        sample: { me: ME, entries: times(ADMIN_PAGE_SIZE, ledgerEntry), nextCursor: UUID },
      },
      deposits: {
        parse: safeParseAdminDepositsResponse,
        sample: { me: ME, deposits: times(ADMIN_PAGE_SIZE, deposit), nextCursor: UUID },
      },
      // a refusal carries the whole card, longer than the adjusted entry
      adjustTokens: {
        parse: safeParseAdminTokenAdjustmentResponse,
        sample: { me: ME, outcome: 'insufficient_available', ...card },
      },
      brokerAccounts: {
        parse: safeParseAdminBrokerAccountsResponse,
        sample: {
          me: ME,
          accounts: times(ADMIN_PAGE_SIZE, {
            ...brokerAccount,
            userId: UUID,
            telegramUserId: INT8,
          }),
          nextCursor: UUID,
        },
      },
      audit: {
        parse: safeParseAdminAuditResponse,
        sample: {
          me: ME,
          entries: times(ADMIN_PAGE_SIZE, {
            id: UUID,
            createdAt: AT,
            actorType: longest(AuditActorType),
            // every writer puts a staff, user or session id there
            actorId: UUID,
            actorLogin: LOGIN,
            action: longest(AuditAction),
            // every writer puts an AuditEntityType there
            entityType: longest(AuditEntityType),
            entityId: UUID,
            payload: controls(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS),
            payloadTruncated: true,
          }),
          nextCursor: UUID,
        },
      },
      changePassword: {
        parse: safeParseChangePasswordResponse,
        sample: { changed: true, revokedSessions: COUNT },
      },
      botTexts: {
        parse: safeParseAdminBotTextsResponse,
        sample: {
          me: ME,
          overrides: times(BOT_TEXT_OVERRIDES_MAX, {
            key: KEY,
            version: COUNT,
            updatedAt: AT,
            updatedByLogin: LOGIN,
            rejection: controls(ADMIN_BOT_TEXT_REASON_MAX),
          }),
        },
      },
      botText: { parse: safeParseAdminBotTextResponse, sample: { me: ME, text: textView } },
      // a plain rendering at RENDERED_MAX (4 sources) outweighs 50 problems
      previewBotText: {
        parse: safeParseAdminBotTextPreviewResponse,
        sample: {
          me: ME,
          text: textView,
          outcome: 'rendered',
          rendered: { kind: 'plain', text: controls(4 * BOT_TEXT_SOURCE_MAX) },
        },
      },
      saveBotText: { parse: safeParseAdminBotTextSaveResponse, sample: refused },
      resetBotText: { parse: safeParseAdminBotTextResetResponse, sample: refused },
      publishBotProfile: {
        parse: safeParseAdminBotProfilePublishResponse,
        sample: {
          me: ME,
          published: BOT_PROFILE_METHODS.map((method) => ({
            method,
            ok: false,
            err: identity,
            cause: identity,
            telegramErrorCode: 599,
          })),
        },
      },
      oauthCallback: {
        parse: safeParseOAuthCallbackResponse,
        sample: {
          account: {
            id: UUID,
            brokerUserId: ofBytes(ASSUMED_LONGEST_FREE_STRING),
            email: ofBytes(ASSUMED_LONGEST_EMAIL),
            isPartnerClient: false,
            status: longest(BrokerAccountStatus),
            createdAt: AT,
          },
        },
      },
    };

    const client = createBackendClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN });
    const BOT_TEXT_METHODS: readonly string[] = [
      'botTexts',
      'botText',
      'previewBotText',
      'saveBotText',
      'resetBotText',
    ];
    const ceilingOf = (name: string) =>
      BOT_TEXT_METHODS.includes(name) ? MAX_BOT_TEXTS_BODY_BYTES : MAX_BACKEND_BODY_BYTES;

    it('has a row for every client method', () => {
      expect(Object.keys(rows).sort()).toEqual(Object.keys(client).sort());
    });

    it.each(Object.entries(rows))('%s: the sample passes its parser', (name, row) => {
      expect(row.parse(row.sample).success, name).toBe(true);
    });

    // #234 stop condition, returned to the owner and not tuned away: under the declared
    // assumptions these rows pass a quarter of their ceiling (sessions: 100 x free displayName and
    // a control-character userAgent; deposits: three free strings a row; audit: a 1024-unit
    // control-character payload; botTexts: 1000 overrides with a 512-unit control-character
    // rejection). it.fails turns red once a row fits, so the mark cannot outlive the cause.
    const OVER_CEILING = ['sessions', 'deposits', 'audit', 'botTexts'];
    const sizeOf = (name: string, row: (typeof rows)[keyof typeof rows]): void => {
      expect(Buffer.byteLength(JSON.stringify(row.sample)), name).toBeLessThan(
        row.limit ?? ceilingOf(name) / 4,
      );
    };

    it.each(Object.entries(rows).filter(([name]) => !OVER_CEILING.includes(name)))(
      '%s: leaves the longest answer under the declared assumptions far below its ceiling',
      sizeOf,
    );

    it.fails.each(Object.entries(rows).filter(([name]) => OVER_CEILING.includes(name)))(
      '%s: KNOWN OVER the ceiling under the declared assumptions (#234 stop condition)',
      sizeOf,
    );
  });
});
