import type { FastifyBaseLogger } from 'fastify';
import { BrokerRestError, type BrokerRestClient } from '@binarius/broker-rest';
import {
  AccessTokenRefusal,
  BrokerRestErrorCode,
  DepositErrorCode,
  assertExhausted,
  errorLogFields,
  type DepositWidgetSessionResponse,
} from '@binarius/shared';
import { hashToken } from '@binarius/db';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import { DEPOSIT_BROKER_CALL_BUDGET_MS } from '../timing';

// The one path to a cashier widget session (#11, docs/deposit.md), shared by
// POST /deposit/widget-session and the owner's deposit-probe CLI: the account's token, the broker
// call, and the answer by allowlist. Who the account is and whether DEMO_ONLY refuses are the
// callers' business, decided before this runs.

export interface DepositWidgetDeps {
  accessToken: (accountId: string, options: AccessTokenOptions) => Promise<AccessTokenResult>;
  rest: Pick<BrokerRestClient, 'createWidgetSession'>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  // the origin of apps/web, which embeds the widget: what the broker binds the session to
  webOrigin: string;
  // the broker platform's origin and our OAuth client id: the widget URL when the broker names none
  platformOrigin: string;
  clientId: string;
  // DEPOSIT_WIDGET_ORIGINS: the only origins a widget may be served from
  widgetOrigins: readonly string[];
}

export interface MintDepositWidgetSessionInput {
  accountId: string;
  // true for a user action (Rule 12); the probe passes false and never exchanges
  mayRefresh: boolean;
  // already checked to be an IP address
  userIp?: string;
}

// what the broker itself sent, for the probe's report; region is never returned to the page
export interface WidgetSessionReport {
  widgetUrl?: string;
  widgetOrigin?: string;
  region?: string;
}

type TokenRefusal = Extract<AccessTokenResult, { ok: false }>['reason'];

export type DepositWidgetSessionOutcome =
  | { ok: true; session: DepositWidgetSessionResponse; reported: WidgetSessionReport }
  | { ok: false; kind: 'token'; reason: TokenRefusal }
  | { ok: false; kind: 'broker'; code: BrokerRestErrorCode; status?: number }
  // the widget would be served from an origin outside DEPOSIT_WIDGET_ORIGINS, or not over https
  | { ok: false; kind: 'origin'; origin: string };

export type DepositWidgetSessionFailure = Extract<DepositWidgetSessionOutcome, { ok: false }>;

// The route's answer for each failure (docs/deposit.md -> Error table).
export function depositErrorFor(failure: DepositWidgetSessionFailure): DepositErrorCode {
  switch (failure.kind) {
    case 'origin':
      return DepositErrorCode.BrokerRejected;
    case 'broker':
      return failure.code === BrokerRestErrorCode.Rejected
        ? DepositErrorCode.BrokerRejected
        : DepositErrorCode.BrokerUnavailable;
    case 'token':
      switch (failure.reason) {
        case AccessTokenRefusal.UserBlocked:
          return DepositErrorCode.UserBlocked;
        // the row changed between the resolution and the lock: the user logs in again
        case AccessTokenRefusal.AccountRevoked:
        case AccessTokenRefusal.AccountPending:
        case AccessTokenRefusal.AccountNotFound:
          return DepositErrorCode.TokenUnavailable;
        // passing: the broker's rate limit on the exchange, a key rollout, or an exchange this
        // caller did not make, which the next request does
        case AccessTokenRefusal.RefreshRateLimited:
        case AccessTokenRefusal.KeyUnavailable:
        case AccessTokenRefusal.RefreshNeeded:
          return DepositErrorCode.BrokerUnavailable;
      }
      return assertExhausted(failure.reason, 'access token refusal');
  }
  return assertExhausted(failure, 'deposit widget session failure');
}

// The origin of an https URL in the allowlist, or undefined.
function allowedOrigin(raw: string, allowlist: readonly string[]): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !allowlist.includes(url.origin)) return undefined;
  return url.origin;
}

function fallbackWidgetUrl(platformOrigin: string, clientId: string): string {
  const url = new URL('/embed/pay', platformOrigin);
  url.searchParams.set('mode', 'deposit');
  url.searchParams.set('client_id', clientId);
  return url.toString();
}

export async function mintDepositWidgetSession(
  deps: DepositWidgetDeps,
  { accountId, mayRefresh, userIp }: MintDepositWidgetSessionInput,
): Promise<DepositWidgetSessionOutcome> {
  const { logger } = deps;
  const token = await deps.accessToken(accountId, { mayRefresh });
  if (!token.ok) {
    logger.warn({ accountId, reason: token.reason }, 'deposit widget session: no access token');
    return { ok: false, kind: 'token', reason: token.reason };
  }

  let widget;
  try {
    widget = await deps.rest.createWidgetSession(
      { accessToken: token.accessToken },
      { origin: deps.webOrigin, mode: 'deposit', ...(userIp === undefined ? {} : { userIp }) },
      { signal: AbortSignal.timeout(DEPOSIT_BROKER_CALL_BUDGET_MS) },
    );
  } catch (error) {
    if (!(error instanceof BrokerRestError)) throw error;
    logger.warn(
      { accountId, ...errorLogFields(error), status: error.status, detail: error.detail },
      'deposit widget session: the broker call failed',
    );
    if (error.code === BrokerRestErrorCode.Unauthorized) {
      await reportRefused(deps, accountId, token.accessToken);
    }
    return {
      ok: false,
      kind: 'broker',
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }

  const reported: WidgetSessionReport = {
    ...(widget.widgetUrl === undefined ? {} : { widgetUrl: widget.widgetUrl }),
    ...(widget.widgetOrigin === undefined ? {} : { widgetOrigin: widget.widgetOrigin }),
    ...(widget.region === undefined ? {} : { region: widget.region }),
  };
  const widgetUrl = widget.widgetUrl ?? fallbackWidgetUrl(deps.platformOrigin, deps.clientId);
  const urlOrigin = allowedOrigin(widgetUrl, deps.widgetOrigins);
  if (urlOrigin === undefined) return refuseOrigin(logger, accountId, widgetUrl);
  const widgetOrigin =
    widget.widgetOrigin === undefined
      ? urlOrigin
      : allowedOrigin(widget.widgetOrigin, deps.widgetOrigins);
  if (widgetOrigin === undefined) {
    return refuseOrigin(logger, accountId, widget.widgetOrigin ?? widgetUrl);
  }
  return {
    ok: true,
    session: {
      session: widget.session,
      expiresInSec: widget.expiresInSec,
      widgetUrl,
      widgetOrigin,
    },
    reported,
  };
}

// Only the origin is logged: a widget URL may carry query parameters of the broker's choosing.
function refuseOrigin(
  logger: DepositWidgetDeps['logger'],
  accountId: string,
  raw: string,
): DepositWidgetSessionFailure {
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    origin = 'unparseable';
  }
  logger.warn({ accountId, origin }, 'deposit widget session: widget origin not allowed');
  return { ok: false, kind: 'origin', origin };
}

// A 401 on a token we believed valid: its fingerprint goes back so the backend marks it expired
// (#281), as the balance reconciler does. mayRefresh: false - the route's budget has no room for a
// second exchange; the user's next request makes it. A throw here must not hide the 401.
async function reportRefused(
  deps: DepositWidgetDeps,
  accountId: string,
  accessToken: string,
): Promise<void> {
  try {
    const answer = await deps.accessToken(accountId, {
      mayRefresh: false,
      refusedToken: hashToken(accessToken),
    });
    deps.logger.info(
      { accountId, answer: answer.ok ? 'ok' : answer.reason },
      'refused token reported',
    );
  } catch (error) {
    deps.logger.error({ accountId, ...errorLogFields(error) }, 'refused token report failed');
  }
}
