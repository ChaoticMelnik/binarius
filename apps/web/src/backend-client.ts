import {
  adminIntentsSearchParams,
  adminUsersSearchParams,
  safeParseAdminIntentResponse,
  safeParseAdminIntentsResponse,
  safeParseAdminOverviewResponse,
  safeParseAdminUserResponse,
  safeParseAdminUsersResponse,
  safeParseOAuthCallbackResponse,
  safeParseAdminConfirmResponse,
  safeParseAdminLoginResponse,
  safeParseLogoutResponse,
  safeParseRevokeSessionResponse,
  safeParseStaffSessionsResponse,
  type AdminConfirmRequest,
  type AdminConfirmResponse,
  type AdminIntentResponse,
  type AdminIntentsQuery,
  type AdminIntentsResponse,
  type AdminLoginRequest,
  type AdminLoginResponse,
  type AdminOverviewResponse,
  type AdminUserResponse,
  type AdminUsersQuery,
  type AdminUsersResponse,
  type LogoutResponse,
  type OAuthCallbackRequest,
  type OAuthCallbackResponse,
  type RevokeSessionResponse,
  type StaffSessionsResponse,
} from '@binarius/shared';
import { BACKEND_REQUEST_TIMEOUT_MS, OAUTH_CALLBACK_REQUEST_TIMEOUT_MS } from './timing';

export const BackendErrorCode = {
  /** the request never produced a response: network failure, timeout, or an aborted socket */
  Unreachable: 'unreachable',
  /** a response arrived with a status outside 2xx */
  HttpStatus: 'http_status',
  /** a 2xx body that is not what the contract says it is */
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
  sessions(token: string): Promise<StaffSessionsResponse>;
  revoke(token: string, sessionId: string): Promise<RevokeSessionResponse>;
  logout(token: string): Promise<LogoutResponse>;
  overview(token: string): Promise<AdminOverviewResponse>;
  users(token: string, query: AdminUsersQuery): Promise<AdminUsersResponse>;
  user(token: string, userId: string): Promise<AdminUserResponse>;
  intents(token: string, query: AdminIntentsQuery): Promise<AdminIntentsResponse>;
  intent(token: string, intentId: string): Promise<AdminIntentResponse>;
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
    options: { body?: unknown; session?: string; bearer?: false; timeoutMs?: number },
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

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // the timeout stays attached through body streaming, so a backend that flushed its
      // headers and then stalled rejects here with the abort rather than a parse failure
      if (signal.aborted) {
        throw new BackendError(BackendErrorCode.Unreachable, {
          status: response.status,
          cause: error,
        });
      }
      if (response.ok) throw new BackendError(BackendErrorCode.ContractViolation, { cause: error });
      payload = undefined;
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

function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | null | undefined)?.error;
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}
