import {
  safeParseAdminBotProfilePublishResponse,
  safeParseAdminBotTextPreviewResponse,
  safeParseAdminBotTextResetResponse,
  safeParseAdminBotTextResponse,
  safeParseAdminBotTextSaveResponse,
  safeParseAdminBotTextsResponse,
  type AdminBotProfilePublishResponse,
  type AdminBotTextPreviewRequest,
  type AdminBotTextPreviewResponse,
  type AdminBotTextResetRequest,
  type AdminBotTextResetResponse,
  type AdminBotTextResponse,
  type AdminBotTextSaveRequest,
  type AdminBotTextSaveResponse,
  type AdminBotTextsResponse,
  adminIntentsSearchParams,
  adminAuditSearchParams,
  adminBrokerAccountsSearchParams,
  adminDepositsSearchParams,
  adminTokensSearchParams,
  adminTradingSessionsSearchParams,
  adminUsersSearchParams,
  safeParseAdminIntentResponse,
  safeParseAdminIntentsResponse,
  safeParseAdminOverviewResponse,
  safeParseAdminAuditResponse,
  safeParseAdminBrokerAccountsResponse,
  safeParseAdminDepositsResponse,
  safeParseAdminTokenAdjustmentResponse,
  safeParseAdminTokensResponse,
  safeParseAdminTradingSessionsResponse,
  safeParseAdminUserResponse,
  safeParseAdminUsersResponse,
  safeParseChangePasswordResponse,
  safeParseOAuthCallbackResponse,
  safeParseAdminConfirmResponse,
  safeParseAdminLinkInspectResponse,
  safeParseAdminLoginResponse,
  safeParseLogoutResponse,
  safeParseRevokeSessionResponse,
  safeParseStaffSessionsResponse,
  type AdminConfirmRequest,
  type AdminConfirmResponse,
  type AdminIntentResponse,
  type AdminIntentsQuery,
  type AdminIntentsResponse,
  type AdminLinkCompleteRequest,
  type AdminLinkInspectResponse,
  type AdminLoginRequest,
  type AdminLoginResponse,
  type AdminOverviewResponse,
  type AdminAuditQuery,
  type AdminAuditResponse,
  type AdminChangePasswordRequest,
  type AdminBrokerAccountsQuery,
  type AdminBrokerAccountsResponse,
  type AdminDepositsQuery,
  type AdminDepositsResponse,
  type AdminTokenAdjustmentRequest,
  type AdminTokenAdjustmentResponse,
  type AdminTokensQuery,
  type AdminTokensResponse,
  type AdminTradingSessionsQuery,
  type AdminTradingSessionsResponse,
  type AdminUserResponse,
  type AdminUsersQuery,
  type AdminUsersResponse,
  type ChangePasswordResponse,
  type LogoutResponse,
  type OAuthCallbackRequest,
  readBody,
  type OAuthCallbackResponse,
  type RevokeSessionResponse,
  type StaffSessionsResponse,
} from '@binarius/shared';
import { BACKEND_REQUEST_TIMEOUT_MS, OAUTH_CALLBACK_REQUEST_TIMEOUT_MS } from './timing';

// bounds one backend response body (Architecture Rule 26)
export const MAX_BACKEND_BODY_BYTES = 1024 * 1024;
// the five "Тексты бота" reads and writes under /admin/bot-texts (publish excluded): a version
// conflict carries 16 fragments and the current source at the schema bound (#234)
export const MAX_BOT_TEXTS_BODY_BYTES = 8 * 1024 * 1024;

export const BackendErrorCode = {
  /** the request never produced a response: network failure, timeout, or an aborted socket */
  Unreachable: 'unreachable',
  /** a response arrived with a status outside 2xx */
  HttpStatus: 'http_status',
  /**
   * a 2xx body that is not what the contract says it is, or is longer than its ceiling
   * (MAX_BACKEND_BODY_BYTES, MAX_BOT_TEXTS_BODY_BYTES)
   */
  ContractViolation: 'contract_violation',
} as const;
export type BackendErrorCode = (typeof BackendErrorCode)[keyof typeof BackendErrorCode];

// An error code as the backend spells it (`invalid_credentials`, `session_invalid`, …).
// Anything else in the body — a message, validation issues — stays where it is.
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;

/**
 * Carries the shape of the failure and nothing from the response body but its error code. The
 * body can hold a staff member's own input and a backend diagnostic, and an error's message
 * and fields reach the log through paths no redaction can scrub.
 */
export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly status?: number;
  readonly reason?: string;

  constructor(
    code: BackendErrorCode,
    options: { status?: number; reason?: string; cause?: unknown } = {},
  ) {
    super(`backend request failed: ${code}`, { cause: options.cause });
    this.name = 'BackendError';
    this.code = code;
    this.status = options.status;
    this.reason = options.reason;
  }
}

export interface BackendClient {
  login(request: AdminLoginRequest): Promise<AdminLoginResponse>;
  confirm(request: AdminConfirmRequest): Promise<AdminConfirmResponse>;
  /** the login link from the staff bot (#448): read without spending it */
  inspectLoginLink(token: string): Promise<AdminLinkInspectResponse>;
  /** the login link spent for a session; the answer is the confirm step's */
  completeLoginLink(request: AdminLinkCompleteRequest): Promise<AdminConfirmResponse>;
  sessions(token: string): Promise<StaffSessionsResponse>;
  revoke(token: string, sessionId: string): Promise<RevokeSessionResponse>;
  logout(token: string): Promise<LogoutResponse>;
  overview(token: string): Promise<AdminOverviewResponse>;
  users(token: string, query: AdminUsersQuery): Promise<AdminUsersResponse>;
  user(token: string, userId: string): Promise<AdminUserResponse>;
  intents(token: string, query: AdminIntentsQuery): Promise<AdminIntentsResponse>;
  intent(token: string, intentId: string): Promise<AdminIntentResponse>;
  tradingSessions(
    token: string,
    query: AdminTradingSessionsQuery,
  ): Promise<AdminTradingSessionsResponse>;
  tokens(token: string, query: AdminTokensQuery): Promise<AdminTokensResponse>;
  deposits(token: string, query: AdminDepositsQuery): Promise<AdminDepositsResponse>;
  /** the manual token adjustment (#246); a refusal is an outcome, not an error */
  adjustTokens(
    token: string,
    userId: string,
    request: AdminTokenAdjustmentRequest,
  ): Promise<AdminTokenAdjustmentResponse>;
  brokerAccounts(
    token: string,
    query: AdminBrokerAccountsQuery,
  ): Promise<AdminBrokerAccountsResponse>;
  audit(token: string, query: AdminAuditQuery): Promise<AdminAuditResponse>;
  changePassword(
    token: string,
    request: AdminChangePasswordRequest,
  ): Promise<ChangePasswordResponse>;
  botTexts(token: string): Promise<AdminBotTextsResponse>;
  botText(token: string, key: string): Promise<AdminBotTextResponse>;
  previewBotText(
    token: string,
    key: string,
    request: AdminBotTextPreviewRequest,
  ): Promise<AdminBotTextPreviewResponse>;
  saveBotText(
    token: string,
    key: string,
    request: AdminBotTextSaveRequest,
  ): Promise<AdminBotTextSaveResponse>;
  resetBotText(
    token: string,
    key: string,
    request: AdminBotTextResetRequest,
  ): Promise<AdminBotTextResetResponse>;
  /** «Опубликовать заново»: the command menu and the profile from the texts in effect (#361) */
  publishBotProfile(token: string): Promise<AdminBotProfilePublishResponse>;
  /** the backend's public OAuth callback; carries no bearer */
  oauthCallback(request: OAuthCallbackRequest): Promise<OAuthCallbackResponse>;
}

export interface BackendClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  oauthCallbackTimeoutMs?: number;
}

type Parse<T> = (input: unknown) => { success: true; data: T } | { success: false };

export function createBackendClient({
  baseUrl,
  token,
  timeoutMs = BACKEND_REQUEST_TIMEOUT_MS,
  oauthCallbackTimeoutMs = OAUTH_CALLBACK_REQUEST_TIMEOUT_MS,
}: BackendClientOptions): BackendClient {
  // a trailing slash, so a base URL with a path prefix keeps it: `new URL('/x', 'http://h/api')`
  // would drop `/api`
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    options: {
      body?: unknown;
      session?: string;
      bearer?: false;
      timeoutMs?: number;
      maxBytes?: number;
    },
  ): Promise<unknown> => {
    const signal = AbortSignal.timeout(options.timeoutMs ?? timeoutMs);
    let response: Response;
    try {
      response = await fetch(new URL(path, root), {
        method,
        headers: {
          ...(options.bearer === false ? {} : { authorization: `Bearer ${token}` }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.session === undefined ? {} : { 'x-staff-session': options.session }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
      });
    } catch (error) {
      throw new BackendError(BackendErrorCode.Unreachable, { cause: error });
    }

    let text: string | undefined;
    try {
      text = await readBody(response, options.maxBytes ?? MAX_BACKEND_BODY_BYTES);
    } catch (error) {
      // the timeout stays attached through body streaming, so a backend that flushed its
      // headers and then stalled rejects here with the abort rather than a short body
      if (signal.aborted) {
        throw new BackendError(BackendErrorCode.Unreachable, {
          status: response.status,
          cause: error,
        });
      }
      if (response.ok) throw new BackendError(BackendErrorCode.ContractViolation, { cause: error });
      text = undefined;
    }

    let payload: unknown;
    if (text === undefined) {
      // over the ceiling, or an error body cut short: no cause, there is no body to name
      if (response.ok) throw new BackendError(BackendErrorCode.ContractViolation);
      payload = undefined;
    } else {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        if (response.ok) {
          throw new BackendError(BackendErrorCode.ContractViolation, { cause: error });
        }
        payload = undefined;
      }
    }

    if (!response.ok) {
      throw new BackendError(BackendErrorCode.HttpStatus, {
        status: response.status,
        reason: errorCodeOf(payload),
      });
    }
    return payload;
  };

  const parsed = <T>(parse: Parse<T>, payload: unknown): T => {
    const result = parse(payload);
    if (!result.success) throw new BackendError(BackendErrorCode.ContractViolation);
    return result.data;
  };

  return {
    async login(request) {
      return parsed(safeParseAdminLoginResponse, await call('POST', 'admin/auth/login', { body: request }));
    },
    async confirm(request) {
      return parsed(
        safeParseAdminConfirmResponse,
        await call('POST', 'admin/auth/confirm', { body: request }),
      );
    },
    // the token in the body, not the path: no request line of this hop carries it
    async inspectLoginLink(linkToken) {
      return parsed(
        safeParseAdminLinkInspectResponse,
        await call('POST', 'admin/auth/link/inspect', { body: { token: linkToken } }),
      );
    },
    async completeLoginLink(request) {
      return parsed(
        safeParseAdminConfirmResponse,
        await call('POST', 'admin/auth/link/complete', { body: request }),
      );
    },
    async sessions(session) {
      return parsed(safeParseStaffSessionsResponse, await call('GET', 'admin/sessions', { session }));
    },
    async revoke(session, sessionId) {
      return parsed(
        safeParseRevokeSessionResponse,
        await call('POST', `admin/sessions/${encodeURIComponent(sessionId)}/revoke`, { session }),
      );
    },
    async logout(session) {
      return parsed(safeParseLogoutResponse, await call('POST', 'admin/auth/logout', { session }));
    },
    async overview(session) {
      return parsed(
        safeParseAdminOverviewResponse,
        await call('GET', 'admin/overview', { session }),
      );
    },
    // relative, like every path here, and serialized by the same helper web's links use
    async users(session, query) {
      const params = adminUsersSearchParams(query);
      const path = params.size > 0 ? `admin/users?${params}` : 'admin/users';
      return parsed(safeParseAdminUsersResponse, await call('GET', path, { session }));
    },
    async user(session, userId) {
      return parsed(
        safeParseAdminUserResponse,
        await call('GET', `admin/users/${encodeURIComponent(userId)}`, { session }),
      );
    },
    async intents(session, query) {
      const params = adminIntentsSearchParams(query);
      const path = params.size > 0 ? `admin/intents?${params}` : 'admin/intents';
      return parsed(safeParseAdminIntentsResponse, await call('GET', path, { session }));
    },
    async intent(session, intentId) {
      return parsed(
        safeParseAdminIntentResponse,
        await call('GET', `admin/intents/${encodeURIComponent(intentId)}`, { session }),
      );
    },
    async tradingSessions(session, query) {
      const params = adminTradingSessionsSearchParams(query);
      const path = params.size > 0 ? `admin/trading-sessions?${params}` : 'admin/trading-sessions';
      return parsed(safeParseAdminTradingSessionsResponse, await call('GET', path, { session }));
    },
    async tokens(session, query) {
      const params = adminTokensSearchParams(query);
      const path = params.size > 0 ? `admin/tokens?${params}` : 'admin/tokens';
      return parsed(safeParseAdminTokensResponse, await call('GET', path, { session }));
    },
    async deposits(session, query) {
      const params = adminDepositsSearchParams(query);
      const path = params.size > 0 ? `admin/deposits?${params}` : 'admin/deposits';
      return parsed(safeParseAdminDepositsResponse, await call('GET', path, { session }));
    },
    async adjustTokens(session, userId, request) {
      return parsed(
        safeParseAdminTokenAdjustmentResponse,
        await call('POST', `admin/users/${encodeURIComponent(userId)}/tokens`, {
          body: request,
          session,
        }),
      );
    },
    async brokerAccounts(session, query) {
      const params = adminBrokerAccountsSearchParams(query);
      const path = params.size > 0 ? `admin/broker-accounts?${params}` : 'admin/broker-accounts';
      return parsed(safeParseAdminBrokerAccountsResponse, await call('GET', path, { session }));
    },
    async audit(session, query) {
      const params = adminAuditSearchParams(query);
      const path = params.size > 0 ? `admin/audit?${params}` : 'admin/audit';
      return parsed(safeParseAdminAuditResponse, await call('GET', path, { session }));
    },
    async changePassword(session, request) {
      return parsed(
        safeParseChangePasswordResponse,
        await call('POST', 'admin/auth/password', { body: request, session }),
      );
    },
    async botTexts(session) {
      return parsed(
        safeParseAdminBotTextsResponse,
        await call('GET', 'admin/bot-texts', { session, maxBytes: MAX_BOT_TEXTS_BODY_BYTES }),
      );
    },
    async botText(session, key) {
      return parsed(
        safeParseAdminBotTextResponse,
        await call('GET', botTextPath(key), { session, maxBytes: MAX_BOT_TEXTS_BODY_BYTES }),
      );
    },
    async previewBotText(session, key, request) {
      return parsed(
        safeParseAdminBotTextPreviewResponse,
        await call('POST', `${botTextPath(key)}/preview`, {
          body: request,
          session,
          maxBytes: MAX_BOT_TEXTS_BODY_BYTES,
        }),
      );
    },
    async saveBotText(session, key, request) {
      return parsed(
        safeParseAdminBotTextSaveResponse,
        await call('POST', `${botTextPath(key)}/save`, {
          body: request,
          session,
          maxBytes: MAX_BOT_TEXTS_BODY_BYTES,
        }),
      );
    },
    async resetBotText(session, key, request) {
      return parsed(
        safeParseAdminBotTextResetResponse,
        await call('POST', `${botTextPath(key)}/reset`, {
          body: request,
          session,
          maxBytes: MAX_BOT_TEXTS_BODY_BYTES,
        }),
      );
    },
    async publishBotProfile(session) {
      return parsed(
        safeParseAdminBotProfilePublishResponse,
        await call('POST', 'admin/bot-texts/publish', { session }),
      );
    },
    // The route is public on the backend and checks no bearer; this one opens /admin/*, and a
    // token sent where nothing needs it is only a place for it to leak from.
    async oauthCallback(request) {
      return parsed(
        safeParseOAuthCallbackResponse,
        await call('POST', 'auth/binodex/callback', {
          body: request,
          bearer: false,
          timeoutMs: oauthCallbackTimeoutMs,
        }),
      );
    },
  };
}

const botTextPath = (key: string): string => `admin/bot-texts/${encodeURIComponent(key)}`;

function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | null | undefined)?.error;
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}
