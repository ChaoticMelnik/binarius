import {
  safeParseUserStartResponse,
  startLoginResponseSchema,
  type StartLoginResponse,
  type UserStartRequest,
  type UserStartView,
} from '@binarius/shared';
import { BACKEND_REQUEST_TIMEOUT_MS } from './timing';

export const BackendErrorCode = {
  // the request never produced a response: network failure, timeout, or an aborted socket
  Unreachable: 'unreachable',
  // a response arrived with a status outside 2xx
  HttpStatus: 'http_status',
  // a 2xx body that is not what the contract says it is
  ContractViolation: 'contract_violation',
} as const;
export type BackendErrorCode = (typeof BackendErrorCode)[keyof typeof BackendErrorCode];

// A backend error code as the routes spell it (`user_blocked`, `validation`, ...). Anything
// else in the body — a message, validation issues, a stack — stays where it is.
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;

// Carries the shape of the failure and nothing from the response body but its error code: the
// body may hold a user's own text or a backend diagnostic, and an error's message and fields
// reach the log through paths no redaction can scrub.
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
  recordStart(request: UserStartRequest): Promise<UserStartView>;
  startLogin(telegramUserId: string): Promise<StartLoginResponse>;
}

export interface BackendClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export function createBackendClient({
  baseUrl,
  token,
  timeoutMs = BACKEND_REQUEST_TIMEOUT_MS,
}: BackendClientOptions): BackendClient {
  // a trailing slash, so a base URL with a path prefix keeps it: `new URL('/x', 'http://h/api')`
  // would drop `/api`
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  const post = async (path: string, body: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, root), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BackendError(BackendErrorCode.Unreachable, { cause: error });
    }
    if (!response.ok) {
      throw new BackendError(BackendErrorCode.HttpStatus, {
        status: response.status,
        reason: await errorCodeOf(response),
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new BackendError(BackendErrorCode.ContractViolation, { cause: error });
    }
  };

  return {
    async recordStart(request) {
      const parsed = safeParseUserStartResponse(await post('users/start', request));
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.user;
    },
    async startLogin(telegramUserId) {
      const parsed = startLoginResponseSchema.safeParse(
        await post('auth/binodex/start', { telegramUserId }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
  };
}

async function errorCodeOf(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined);
  const code = (body as { error?: unknown } | undefined)?.error;
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}
