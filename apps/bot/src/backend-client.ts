import {
  safeParseChatMemberResponse,
  safeParseConfirmLoginResponse,
  safeParseEmailLoginResponse,
  safeParseEmailSendCodeResponse,
  safeParseNotificationLevelResponse,
  safeParsePairsCatalogResponse,
  safeParseTradingAccessResponse,
  safeParseTradingSignalResponse,
  safeParseUserAccountResponse,
  safeParseUserStartResponse,
  startLoginResponseSchema,
  type ChatMemberResponse,
  type ConfirmLoginResponse,
  type EmailLoginResponse,
  type EmailSendCodeResponse,
  type NotificationLevel,
  type NotificationLevelResponse,
  type PairsCatalogResponse,
  type SignalInterval,
  type StartLoginResponse,
  type TelegramChatMemberStatus,
  type TradingAccessResponse,
  type TradingSignalResponse,
  type UserAccountView,
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
  readAccount(telegramUserId: string): Promise<UserAccountView>;
  startLogin(telegramUserId: string): Promise<StartLoginResponse>;
  confirmLogin(telegramUserId: string, accountId: string): Promise<ConfirmLoginResponse>;
  sendEmailCode(telegramUserId: string, email: string): Promise<EmailSendCodeResponse>;
  emailLogin(telegramUserId: string, email: string, code: string): Promise<EmailLoginResponse>;
  recordChatMember(
    telegramUserId: string,
    status: TelegramChatMemberStatus,
  ): Promise<ChatMemberResponse>;
  setNotificationLevel(
    telegramUserId: string,
    level: NotificationLevel,
  ): Promise<NotificationLevelResponse>;
  readTradingAccess(telegramUserId: string): Promise<TradingAccessResponse>;
  readPairs(): Promise<PairsCatalogResponse>;
  evaluateSignal(assetId: number, interval: SignalInterval): Promise<TradingSignalResponse>;
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

  // a GET sends no body and so no content-type
  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(new URL(path, root), {
        method,
        headers:
          method === 'POST'
            ? { 'content-type': 'application/json', authorization: `Bearer ${token}` }
            : { authorization: `Bearer ${token}` },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
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
      // headers and then stalled rejects here with the abort rather than a parse failure:
      // a slow backend, not a route that broke the contract. The status is carried so the
      // operator can see the headers did arrive.
      if (signal.aborted) {
        throw new BackendError(BackendErrorCode.Unreachable, {
          status: response.status,
          cause: error,
        });
      }
      if (response.ok) throw new BackendError(BackendErrorCode.ContractViolation, { cause: error });
      // an error response whose body is not JSON still has its status to report
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
  const post = (path: string, body: unknown) => request('POST', path, body);

  return {
    async recordStart(request) {
      const parsed = safeParseUserStartResponse(await post('users/start', request));
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.user;
    },
    async readAccount(telegramUserId) {
      const parsed = safeParseUserAccountResponse(await post('users/account', { telegramUserId }));
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
    async confirmLogin(telegramUserId, accountId) {
      const parsed = safeParseConfirmLoginResponse(
        await post('auth/binodex/confirm', { telegramUserId, accountId }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async sendEmailCode(telegramUserId, email) {
      const parsed = safeParseEmailSendCodeResponse(
        await post('auth/binodex/email/send-code', { telegramUserId, email }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async emailLogin(telegramUserId, email, code) {
      const parsed = safeParseEmailLoginResponse(
        await post('auth/binodex/email/login', { telegramUserId, email, code }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async recordChatMember(telegramUserId, status) {
      const parsed = safeParseChatMemberResponse(
        await post('users/chat-member', { telegramUserId, status }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async setNotificationLevel(telegramUserId, level) {
      const parsed = safeParseNotificationLevelResponse(
        await post('users/notification-level', { telegramUserId, level }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    // no brokerAccountId: the card is about the user's only active account
    async readTradingAccess(telegramUserId) {
      const parsed = safeParseTradingAccessResponse(
        await post('trading/access', { telegramUserId }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    // the whole answer: `fresh` is the backend's verdict, and the bot keeps no copy of its bound
    async readPairs() {
      const parsed = safeParsePairsCatalogResponse(await request('GET', 'trading/pairs'));
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    // a broker failure is a 200 `fetch_failed`, returned like a decision (#258)
    async evaluateSignal(assetId, interval) {
      const parsed = safeParseTradingSignalResponse(
        await post('trading/signal', { assetId, interval }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
  };
}

// The two fields a log line about a failed backend call carries besides the error's identity.
export function backendErrorFields(error: unknown): {
  backendStatus?: number;
  backendReason?: string;
} {
  if (!(error instanceof BackendError)) return {};
  return { backendStatus: error.status, backendReason: error.reason };
}

function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | null | undefined)?.error;
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}
