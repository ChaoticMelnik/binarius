import {
  StakeRefusal,
  safeParseChatMemberResponse,
  safeParseSetStakeResponse,
  safeParseSetTradingModeResponse,
  safeParseStakeRefusal,
  safeParseConfirmLoginResponse,
  safeParseEmailLoginResponse,
  safeParseEmailSendCodeResponse,
  safeParseNotificationLevelResponse,
  safeParsePairsCatalogResponse,
  BOT_TEXTS_PATH,
  STAKE_PATH,
  botTextOverridesResponseSchema,
  readBody,
  type BotTextOverride,
  safeParseSessionShareResponse,
  safeParseSessionSummaryRefusal,
  safeParseSessionSummaryResponse,
  safeParseTradeIntentView,
  safeParseTradingAccessResponse,
  safeParseForgetSessionStatusMessageResponse,
  safeParseTradingSessionRefusal,
  safeParseTradingSessionResponse,
  safeParseTradingSessionsStoppedResponse,
  safeParseTrackedSessionsResponse,
  safeParseTradingSignalResponse,
  safeParseTradingSignalsResponse,
  TRADING_SIGNALS_PATH,
  TRADING_SESSIONS_STOP_PATH,
  TRADING_SESSIONS_TRACKED_PATH,
  TRACKED_SESSIONS_MAX,
  TRADING_MODE_PATH,
  safeParseUserAccountResponse,
  safeParseUserStartResponse,
  starsInvoiceResponseSchema,
  starsPaidResponseSchema,
  starsPaymentsResponseSchema,
  starsPreCheckoutResponseSchema,
  starsRefundResponseSchema,
  type StarPaymentView,
  type StarsRefundRequestOutcome,
  type StarsInvoiceResponse,
  type StarsPaidRequest,
  type StarsPaidResponse,
  type StarsPreCheckoutRequest,
  type StarsPreCheckoutResponse,
  userReferralResponseSchema,
  type ChatMemberResponse,
  type ConfirmLoginResponse,
  type CreateTradeIntentRequest,
  type CreateTradingSessionRequest,
  type DecimalString,
  type StakeRefusalBody,
  type EmailLoginResponse,
  type EmailSendCodeResponse,
  type NotificationLevel,
  type NotificationLevelResponse,
  type PairsCatalogResponse,
  SESSION_SHARE_SUFFIX,
  SESSION_STATUS_MESSAGE_LOST_SUFFIX,
  SESSION_STATUS_MESSAGE_SUFFIX,
  SESSION_SUMMARY_SUFFIX,
  type SessionShare,
  type SessionSummary,
  type SignalInterval,
  type TradingSignalAnalysis,
  type TelegramChatMemberStatus,
  type TradeIntentView,
  type TrackedSession,
  type TradeMode,
  type SetTradingModeResponse,
  type TradingAccessResponse,
  type TradingSessionView,
  type TradingSignalResponse,
  type TradingSignalsResponse,
  TradingSessionErrorCode,
  type UserAccountView,
  type UserReferralView,
  type UserStartRequest,
  type UserStartView,
  type BotLanguage,
  safeParseUserLanguageResponse,
} from '@binarius/shared';
import {
  BACKEND_REQUEST_TIMEOUT_MS,
  LANGUAGE_READ_TIMEOUT_MS,
  STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS,
} from './timing';

// bounds one internal-API response body (Architecture Rule 26)
export const MAX_BACKEND_BODY_BYTES = 1024 * 1024;
// GET /bot-texts - every override of the catalog; sized for every catalog key at Telegram's
// message limit in 4-byte characters (#234)
export const MAX_BOT_TEXTS_BODY_BYTES = 8 * 1024 * 1024;
// GET /trading/sessions/tracked (#567) - TRACKED_SESSIONS_MAX rows of ~200 bytes at their longest,
// the owner's language included (#508; backend-client.test.ts → the samples table), a quarter of
// it at most
export const MAX_TRACKED_SESSIONS_BODY_BYTES = 2 * 1024 * 1024;

export const BackendErrorCode = {
  // the request never produced a response: network failure, timeout, or an aborted socket
  Unreachable: 'unreachable',
  // a response arrived with a status outside 2xx
  HttpStatus: 'http_status',
  // a 2xx body that is not what the contract says it is, or is longer than its ceiling
  // (MAX_BACKEND_BODY_BYTES, MAX_BOT_TEXTS_BODY_BYTES, MAX_TRACKED_SESSIONS_BODY_BYTES)
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
  // the /invite screen (#115): creates the user's code on the first call; 404 user_not_found
  // before the first /start
  readReferral(telegramUserId: string): Promise<UserReferralView>;
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
  // the language of the bot's texts (#508): the middleware's read of a user it has not cached,
  // bounded by LANGUAGE_READ_TIMEOUT_MS, and the language screen's write; 404 user_not_found
  // before the first /start
  readLanguage(telegramUserId: string): Promise<BotLanguage>;
  setLanguage(telegramUserId: string, language: BotLanguage): Promise<BotLanguage>;
  readTradingAccess(telegramUserId: string): Promise<TradingAccessResponse>;
  readPairs(): Promise<PairsCatalogResponse>;
  // `analysis` only from the analysis card (#484): the backend records it for the reminder
  evaluateSignal(
    assetId: number,
    interval: SignalInterval,
    analysis?: TradingSignalAnalysis,
  ): Promise<TradingSignalResponse>;
  // the scanner's pairs with a signal on the last closed 15s candle (#343); no symbol or payout:
  // the bot joins them with readPairs (#320)
  readSignals(): Promise<TradingSignalsResponse>;
  // a new intent (201) and the replay of the same clientRequestId (200) read the same (#127)
  createIntent(request: CreateTradeIntentRequest): Promise<TradeIntentView>;
  // scoped by the owner: another user's id is the same 404 not_found as a missing one
  readIntent(id: string, telegramUserId: string): Promise<TradeIntentView>;
  // a new session, or the account's active one: the 409 active_session_exists carries it, so a
  // retry after a lost answer learns what the first request created (#283); null when that
  // session ended before the backend read it
  startSession(request: CreateTradingSessionRequest): Promise<StartSessionResult>;
  // both scoped by the owner like readIntent
  readSession(id: string, telegramUserId: string): Promise<TradingSessionView>;
  // waitingMessageId: the waiting message whose «⏹» was pressed (#587): the backend takes it over
  // from its sender, so the bot draws the reply in place of it
  stopSession(
    id: string,
    telegramUserId: string,
    waitingMessageId?: number,
  ): Promise<TradingSessionView>;
  // the finished session's card, claimed at most once (#318): null for the one refusal, which the
  // backend answers before any write; scoped by the owner like readSession
  claimSessionSummary(id: string, telegramUserId: string): Promise<SessionSummary | null>;
  // what the shared promo card needs (#538): creates the caller's referral code on first use;
  // scoped by the owner like readSession (404 not_found)
  readSessionShare(id: string, telegramUserId: string): Promise<SessionShare>;
  // every active session of the user, stopped (#122); empty when there was none
  stopSessions(telegramUserId: string): Promise<TradingSessionView[]>;
  // the first poll of a status message (#567): records its id, the newest one wins (#587), and
  // answers the view readSession does; scoped by the owner like readSession
  recordSessionMessage(
    id: string,
    telegramUserId: string,
    messageId: number,
  ): Promise<TradingSessionView>;
  // the sessions to track again after a restart (#567), oldest first, at most TRACKED_SESSIONS_MAX
  listTrackedSessions(): Promise<TrackedSession[]>;
  // the recorded status message is lost (#567): Telegram refused its edit for good; the backend
  // forgets it by the same id, so the session leaves the recovery list. False when nothing was
  // forgotten: another message is recorded, none is, or the id is not the user's
  forgetSessionMessage(id: string, telegramUserId: string, messageId: number): Promise<boolean>;
  // the saved stake of the mode, or a bounds refusal with the limits it was checked against (#297,
  // #326); any other failure throws as from every method
  setStake(
    telegramUserId: string,
    mode: TradeMode,
    amount: DecimalString | null,
  ): Promise<SetStakeResult>;
  // the user's trading mode (#474, docs/trading-mode.md): the mode now and the active sessions
  // the switch stopped; a refusal (409 demo_only, balance_unavailable, real_balance_below_minimum,
  // 404 user_not_found) throws as from every method, with its code
  setTradingMode(telegramUserId: string, mode: TradeMode): Promise<SetTradingModeResponse>;
  // every text override, as stored: the refresher resolves them (#299)
  readBotTexts(): Promise<BotTextOverride[]>;
  // The Stars purchase (#117, docs/stars.md). The invoice's payload for a package: a read, every
  // refusal a 4xx before anything is written.
  createStarsInvoice(telegramUserId: string, packageCode: string): Promise<StarsInvoiceResponse>;
  // Telegram's pre-checkout query: yes or a refusal reason; bounded by its own, shorter timeout,
  // since Telegram waits 10 s for the answer (timing.ts)
  checkStarsPreCheckout(request: StarsPreCheckoutRequest): Promise<StarsPreCheckoutResponse>;
  // successful_payment: the credit's outcome, the same for a repeated delivery
  reportStarsPaid(request: StarsPaidRequest): Promise<StarsPaidResponse>;
  // /paysupport (#118): the payer's newest payments, a read
  listStarsPayments(telegramUserId: string): Promise<StarPaymentView[]>;
  // «Нужен возврат»: a write, once per payment; 404 payment_not_found and 409 already_refunded are
  // refusals before any write
  requestStarsRefund(telegramUserId: string, paymentId: string): Promise<StarsRefundRequestOutcome>;
}

export type SetStakeResult =
  { saved: DecimalString | null } | { refused: Extract<StakeRefusalBody, { limits: unknown }> };

const STAKE_REFUSALS: ReadonlySet<string> = new Set(Object.values(StakeRefusal));

export type StartSessionResult =
  { started: TradingSessionView } | { active: TradingSessionView | null };

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
  const send = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    maxBytes = MAX_BACKEND_BODY_BYTES,
    callTimeoutMs = timeoutMs,
  ): Promise<{ ok: boolean; status: number; payload: unknown }> => {
    const signal = AbortSignal.timeout(callTimeoutMs);
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

    let text: string | undefined;
    try {
      text = await readBody(response, maxBytes);
    } catch (error) {
      // the timeout stays attached through body streaming, so a backend that flushed its
      // headers and then stalled rejects here with the abort rather than a read failure:
      // a slow backend, not a route that broke the contract. The status is carried so the
      // operator can see the headers did arrive.
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
      // over the ceiling (or an error body cut short): no cause, there is no body to name
      if (response.ok) throw new BackendError(BackendErrorCode.ContractViolation);
      payload = undefined;
    } else {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        if (response.ok) {
          throw new BackendError(BackendErrorCode.ContractViolation, { cause: error });
        }
        // an error response whose body is not JSON still has its status to report
        payload = undefined;
      }
    }

    return { ok: response.ok, status: response.status, payload };
  };
  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    maxBytes?: number,
    callTimeoutMs?: number,
  ): Promise<unknown> => {
    const { ok, status, payload } = await send(method, path, body, maxBytes, callTimeoutMs);
    if (!ok) throw httpStatusError(status, payload);
    return payload;
  };
  const post = (path: string, body: unknown) => request('POST', path, body);
  const get = (path: string, maxBytes?: number) => request('GET', path, undefined, maxBytes);
  const sessionOf = (payload: unknown): TradingSessionView => {
    const parsed = safeParseTradingSessionResponse(payload);
    if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
    return parsed.data.session;
  };
  const intentOf = (payload: unknown): TradeIntentView => {
    const parsed = safeParseTradeIntentView((payload as { intent?: unknown } | null)?.intent);
    if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
    return parsed.data;
  };

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
    async readReferral(telegramUserId) {
      const parsed = userReferralResponseSchema.safeParse(
        await post('users/referral', { telegramUserId }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.user;
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
    async readLanguage(telegramUserId) {
      const query = new URLSearchParams({ telegramUserId });
      const parsed = safeParseUserLanguageResponse(
        await request(
          'GET',
          `users/language?${query.toString()}`,
          undefined,
          undefined,
          Math.min(timeoutMs, LANGUAGE_READ_TIMEOUT_MS),
        ),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.language;
    },
    async setLanguage(telegramUserId, language) {
      const parsed = safeParseUserLanguageResponse(
        await post('users/language', { telegramUserId, language }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.language;
    },
    // no brokerAccountId: the card is about the user's only active account
    async readTradingAccess(telegramUserId) {
      const parsed = safeParseTradingAccessResponse(
        await post('trading/access', { telegramUserId }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async readBotTexts() {
      const parsed = botTextOverridesResponseSchema.safeParse(
        await get(BOT_TEXTS_PATH.slice(1), MAX_BOT_TEXTS_BODY_BYTES),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.overrides;
    },
    // the whole answer: `fresh` is the backend's verdict, and the bot keeps no copy of its bound
    async readPairs() {
      const parsed = safeParsePairsCatalogResponse(await get('trading/pairs'));
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    // a broker failure is a 200 `fetch_failed`, returned like a decision (#258)
    async evaluateSignal(assetId, interval, analysis) {
      const parsed = safeParseTradingSignalResponse(
        await post('trading/signal', { assetId, interval, ...(analysis ? { analysis } : {}) }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async readSignals() {
      const parsed = safeParseTradingSignalsResponse(await get(TRADING_SIGNALS_PATH.slice(1)));
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async createIntent(intentRequest) {
      return intentOf(await post('trading/intents', intentRequest));
    },
    async readIntent(id, telegramUserId) {
      const query = new URLSearchParams({ telegramUserId });
      return intentOf(await get(`trading/intents/${encodeURIComponent(id)}?${query.toString()}`));
    },
    // Only the parsed view and the error code leave this method, as from request(): the 409's body
    // is read for its session alone.
    async startSession(sessionRequest) {
      const { ok, status, payload } = await send('POST', 'trading/sessions', sessionRequest);
      if (ok) return { started: sessionOf(payload) };
      if (errorCodeOf(payload) !== TradingSessionErrorCode.ActiveSessionExists) {
        throw httpStatusError(status, payload);
      }
      // the code without the contract's body: the outcome is not known, like a broken 2xx
      const parsed = safeParseTradingSessionRefusal(payload);
      if (!parsed.success || parsed.data.error !== TradingSessionErrorCode.ActiveSessionExists) {
        throw new BackendError(BackendErrorCode.ContractViolation, { status });
      }
      return { active: parsed.data.session };
    },
    // Only the parsed body and the error code leave this method, as from request(): a bounds 409
    // is read for its limits alone.
    // An answer for another mode than asked is a contract violation.
    async setStake(telegramUserId, mode, amount) {
      // relative, as BOT_TEXTS_PATH: a leading slash would drop a base URL's path prefix
      const { ok, status, payload } = await send('POST', STAKE_PATH.slice(1), {
        telegramUserId,
        mode,
        amount,
      });
      if (ok) {
        const parsed = safeParseSetStakeResponse(payload);
        if (!parsed.success || parsed.data.mode !== mode) {
          throw new BackendError(BackendErrorCode.ContractViolation, { status });
        }
        return { saved: parsed.data.stake };
      }
      if (status !== 409 || !STAKE_REFUSALS.has(errorCodeOf(payload) ?? '')) {
        throw httpStatusError(status, payload);
      }
      const parsed = safeParseStakeRefusal(payload);
      if (!parsed.success || !('limits' in parsed.data)) {
        throw new BackendError(BackendErrorCode.ContractViolation, { status });
      }
      return { refused: parsed.data };
    },
    async readSession(id, telegramUserId) {
      const query = new URLSearchParams({ telegramUserId });
      return sessionOf(await get(`trading/sessions/${encodeURIComponent(id)}?${query.toString()}`));
    },
    async stopSession(id, telegramUserId, waitingMessageId) {
      return sessionOf(
        await post(`trading/sessions/${encodeURIComponent(id)}/stop`, {
          telegramUserId,
          ...(waitingMessageId === undefined ? {} : { waitingMessageId }),
        }),
      );
    },
    async claimSessionSummary(id, telegramUserId) {
      const { ok, status, payload } = await send(
        'POST',
        `trading/sessions/${encodeURIComponent(id)}${SESSION_SUMMARY_SUFFIX}`,
        { telegramUserId },
      );
      if (ok) {
        const parsed = safeParseSessionSummaryResponse(payload);
        if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation, { status });
        return parsed.data.summary;
      }
      if (status === 409 && safeParseSessionSummaryRefusal(payload).success) return null;
      throw httpStatusError(status, payload);
    },
    async readSessionShare(id, telegramUserId) {
      const parsed = safeParseSessionShareResponse(
        await post(`trading/sessions/${encodeURIComponent(id)}${SESSION_SHARE_SUFFIX}`, {
          telegramUserId,
        }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.share;
    },
    async createStarsInvoice(telegramUserId, packageCode) {
      const parsed = starsInvoiceResponseSchema.safeParse(
        await post('payments/stars/invoice', { telegramUserId, packageCode }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async checkStarsPreCheckout(preCheckout) {
      const parsed = starsPreCheckoutResponseSchema.safeParse(
        await request(
          'POST',
          'payments/stars/pre-checkout',
          preCheckout,
          undefined,
          Math.min(timeoutMs, STARS_PRECHECKOUT_BACKEND_TIMEOUT_MS),
        ),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async reportStarsPaid(paid) {
      const parsed = starsPaidResponseSchema.safeParse(await post('payments/stars/paid', paid));
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async listStarsPayments(telegramUserId) {
      const parsed = starsPaymentsResponseSchema.safeParse(
        await post('payments/stars/list', { telegramUserId }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.payments;
    },
    async requestStarsRefund(telegramUserId, paymentId) {
      const parsed = starsRefundResponseSchema.safeParse(
        await post('payments/stars/refund-request', { telegramUserId, paymentId }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.outcome;
    },
    async setTradingMode(telegramUserId, mode) {
      // relative, as BOT_TEXTS_PATH: a leading slash would drop a base URL's path prefix
      const parsed = safeParseSetTradingModeResponse(
        await post(TRADING_MODE_PATH.slice(1), { telegramUserId, mode }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data;
    },
    async recordSessionMessage(id, telegramUserId, messageId) {
      return sessionOf(
        await post(`trading/sessions/${encodeURIComponent(id)}${SESSION_STATUS_MESSAGE_SUFFIX}`, {
          telegramUserId,
          messageId,
        }),
      );
    },
    async forgetSessionMessage(id, telegramUserId, messageId) {
      const parsed = safeParseForgetSessionStatusMessageResponse(
        await post(
          `trading/sessions/${encodeURIComponent(id)}${SESSION_STATUS_MESSAGE_LOST_SUFFIX}`,
          { telegramUserId, messageId },
        ),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.forgotten;
    },
    async listTrackedSessions() {
      const query = new URLSearchParams({ limit: String(TRACKED_SESSIONS_MAX) });
      const parsed = safeParseTrackedSessionsResponse(
        await get(
          `${TRADING_SESSIONS_TRACKED_PATH.slice(1)}?${query.toString()}`,
          MAX_TRACKED_SESSIONS_BODY_BYTES,
        ),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.sessions;
    },
    async stopSessions(telegramUserId) {
      const parsed = safeParseTradingSessionsStoppedResponse(
        await post(TRADING_SESSIONS_STOP_PATH.slice(1), { telegramUserId }),
      );
      if (!parsed.success) throw new BackendError(BackendErrorCode.ContractViolation);
      return parsed.data.sessions;
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

const httpStatusError = (status: number, payload: unknown): BackendError =>
  new BackendError(BackendErrorCode.HttpStatus, { status, reason: errorCodeOf(payload) });

function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | null | undefined)?.error;
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}
