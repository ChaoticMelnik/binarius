import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { BrokerRestError, type BrokerRestClient } from '@binarius/broker-rest';
import {
  AccessTokenRefusal,
  BROKER_BALANCE_SLA_SEC,
  BrokerRestErrorCode,
  errorLogFields,
} from '@binarius/shared';
import {
  BalanceRefreshError,
  brokerAccounts,
  listBalanceRefreshCandidates,
  recordBalanceRefreshFailure,
  summarizeWatchedBalances,
  upsertBalanceSnapshot,
  type Db,
} from '@binarius/db';
import {
  ACCESS_SKEW_MS,
  type AccessTokenOptions,
  type AccessTokenResult,
} from '../auth/token-service';
import {
  BALANCE_POLL_CONCURRENCY,
  BALANCE_STALLED_RETRY_MS,
  BALANCE_WATCH_WINDOW_MS,
} from '../timing';

// The REST side of the broker balance snapshot (docs/broker-balance.md): one refresh per account
// at a time, called by POST /trading/access and by a background tick over the accounts in work.

export type BalanceRefreshOutcome =
  | 'ok'
  | BalanceRefreshError
  // our own limit (stop(), the route's budget); never recorded
  | 'aborted'
  // the token needs an exchange and this caller forbade one; nothing recorded
  | 'refresh_needed'
  // the user is blocked, seen under the account lock when the token was taken; nothing recorded
  | 'user_blocked'
  | 'account_not_found';

export interface BalanceRefreshOptions {
  signal?: AbortSignal;
  // the bot asked for this account: last_requested_at moves
  requested?: boolean;
  // false for the background tick: ensureFreshAccessToken never exchanges a token for it
  mayRefresh?: boolean;
}

export interface BalanceReconcilerConfig {
  intervalMs: number;
  maxPerMinute: number;
  concurrency?: number;
  watchWindowMs?: number;
  stalledRetryMs?: number;
}

export interface BalanceReconcilerDeps {
  db: Db;
  client: Pick<BrokerRestClient, 'getUser'>;
  accessToken: (accountId: string, options: AccessTokenOptions) => Promise<AccessTokenResult>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  config: BalanceReconcilerConfig;
}

export interface BalanceReconciler {
  refresh(accountId: string, options?: BalanceRefreshOptions): Promise<BalanceRefreshOutcome>;
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

interface Attempt {
  outcome: BalanceRefreshOutcome;
  // the row records this attempt (a snapshot or a failure code); false leaves its queue key where
  // it was
  marked: boolean;
}

// requested is shared with the callers that join, so any of them can set it before the write
interface FlightState {
  requested: boolean;
}

interface Flight {
  state: FlightState;
  promise: Promise<Attempt>;
}

export const balanceTickLimit = (maxPerMinute: number, intervalMs: number) =>
  Math.max(1, Math.floor((maxPerMinute * intervalMs) / 60_000));

const BROKER_FAILURE: Record<Exclude<BrokerRestErrorCode, 'aborted'>, BalanceRefreshError> = {
  [BrokerRestErrorCode.Unauthorized]: BalanceRefreshError.Unauthorized,
  [BrokerRestErrorCode.RateLimited]: BalanceRefreshError.RateLimited,
  [BrokerRestErrorCode.Rejected]: BalanceRefreshError.Rejected,
  [BrokerRestErrorCode.Unavailable]: BalanceRefreshError.Unavailable,
  [BrokerRestErrorCode.ContractViolation]: BalanceRefreshError.ContractViolation,
};

export function createBalanceReconciler(deps: BalanceReconcilerDeps): BalanceReconciler {
  const { db, client, logger } = deps;
  const concurrency = deps.config.concurrency ?? BALANCE_POLL_CONCURRENCY;
  const watchWindowMs = deps.config.watchWindowMs ?? BALANCE_WATCH_WINDOW_MS;
  const stalledRetryMs = deps.config.stalledRetryMs ?? BALANCE_STALLED_RETRY_MS;
  const limit = balanceTickLimit(deps.config.maxPerMinute, deps.config.intervalMs);

  const flights = new Map<string, Flight>();
  // attempts of the tick that left nothing in the row: held back until retryAt (Date.now() ms)
  const stalled = new Map<string, number>();
  const stopping = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  async function fail(accountId: string, error: BalanceRefreshError): Promise<Attempt> {
    const marked = await recordBalanceRefreshFailure(db, accountId, error);
    return { outcome: error, marked };
  }

  async function attempt(
    accountId: string,
    state: FlightState,
    options: BalanceRefreshOptions,
  ): Promise<Attempt> {
    const signal =
      options.signal === undefined
        ? stopping.signal
        : AbortSignal.any([stopping.signal, options.signal]);
    const token = await deps.accessToken(accountId, { mayRefresh: options.mayRefresh ?? true });
    if (!token.ok) {
      switch (token.reason) {
        case AccessTokenRefusal.AccountNotFound:
          return { outcome: 'account_not_found', marked: false };
        case AccessTokenRefusal.RefreshNeeded:
          return { outcome: 'refresh_needed', marked: false };
        case AccessTokenRefusal.UserBlocked:
          return { outcome: 'user_blocked', marked: false };
        case AccessTokenRefusal.AccountPending:
          return fail(accountId, BalanceRefreshError.AccountPending);
        case AccessTokenRefusal.AccountRevoked:
          return fail(accountId, BalanceRefreshError.AccountRevoked);
        // token-service has already logged it
        case AccessTokenRefusal.KeyUnavailable:
          return fail(accountId, BalanceRefreshError.KeyUnavailable);
        default:
          return assertExhausted(token);
      }
    }
    // before the GET: a missing account must not spend a call counted against the rate limit
    const [account] = await db
      .select({ brokerUserId: brokerAccounts.brokerUserId })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, accountId));
    if (account === undefined) return { outcome: 'account_not_found', marked: false };
    if (signal.aborted) return { outcome: 'aborted', marked: false };

    let user;
    try {
      user = await client.getUser({ accessToken: token.accessToken }, { signal });
    } catch (error) {
      if (!(error instanceof BrokerRestError)) throw error;
      if (error.code === BrokerRestErrorCode.Aborted) return { outcome: 'aborted', marked: false };
      logger.warn(
        {
          accountId,
          ...errorLogFields(error),
          status: error.status,
          retryAfterSec: error.retryAfterSec,
          detail: error.detail,
        },
        'balance refresh failed',
      );
      return fail(accountId, BROKER_FAILURE[error.code]);
    }

    if (account.brokerUserId !== user.id) {
      logger.warn(
        { accountId, expected: account.brokerUserId, received: user.id },
        'broker answered for another user, balance not stored',
      );
      return fail(accountId, BalanceRefreshError.AccountMismatch);
    }

    const written = await upsertBalanceSnapshot(db, {
      brokerAccountId: accountId,
      user,
      requested: state.requested,
    });
    if (!written.written) {
      // the field only: the value is the broker's number and has no place in a log
      logger.warn({ accountId, field: written.field }, 'broker balance outside the stored domain');
      return fail(accountId, BalanceRefreshError.ContractViolation);
    }
    stalled.delete(accountId);
    return { outcome: 'ok', marked: true };
  }

  // one flight per account; a caller that joins gets its outcome, and its own signal only ends
  // its own wait
  function fly(accountId: string, options: BalanceRefreshOptions): Promise<Attempt> {
    const current = flights.get(accountId);
    if (current !== undefined) {
      if (options.requested === true) current.state.requested = true;
      return current.promise;
    }
    const state: FlightState = { requested: options.requested === true };
    // attempt() is async, so this .finally runs after the set below
    const promise = attempt(accountId, state, options).finally(() => {
      flights.delete(accountId);
    });
    flights.set(accountId, { state, promise });
    return promise;
  }

  function refresh(
    accountId: string,
    options: BalanceRefreshOptions = {},
  ): Promise<BalanceRefreshOutcome> {
    const { signal } = options;
    // an already aborted signal starts no flight
    if (stopped || signal?.aborted === true) return Promise.resolve('aborted');
    const outcome = fly(accountId, options).then((result) => result.outcome);
    if (signal === undefined) return outcome;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<BalanceRefreshOutcome>((resolve) => {
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([outcome, aborted]).finally(() => {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    });
  }

  async function runTick(): Promise<void> {
    const now = Date.now();
    for (const [accountId, retryAt] of stalled) {
      if (retryAt <= now) stalled.delete(accountId);
    }
    const candidates = await listBalanceRefreshCandidates(db, {
      watchWindowMs,
      accessSkewMs: ACCESS_SKEW_MS,
      limit,
      exclude: [...stalled.keys()],
    });
    const counts = { refreshed: 0, failed: 0, skipped: 0 };
    let rateLimited = false;
    let next = 0;

    async function worker(): Promise<void> {
      while (!rateLimited && !stopped && next < candidates.length) {
        const accountId = candidates[next++];
        let result: Attempt;
        try {
          result = await fly(accountId, { mayRefresh: false });
        } catch (error) {
          // a database error carries the statement and the row's values: name and code only
          logger.error({ accountId, ...errorLogFields(error) }, 'balance refresh threw');
          // nothing reached the row, so its queue key did not move: held back like any attempt
          // that left nothing
          stalled.set(accountId, Date.now() + stalledRetryMs);
          counts.failed += 1;
          continue;
        }
        const { outcome, marked } = result;
        if (outcome === 'ok') counts.refreshed += 1;
        else if (
          outcome === 'refresh_needed' ||
          outcome === 'account_not_found' ||
          outcome === 'user_blocked'
        ) {
          counts.skipped += 1;
        } else if (outcome !== 'aborted') counts.failed += 1;
        if (outcome !== 'ok' && outcome !== 'aborted' && !marked) {
          stalled.set(accountId, Date.now() + stalledRetryMs);
        }
        if (outcome === BalanceRefreshError.RateLimited) rateLimited = true;
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));

    const summary = await summarizeWatchedBalances(db, { watchWindowMs });
    logger.info({ candidates: candidates.length, ...counts, ...summary }, 'balance tick');
    if (summary.oldestAgeSec !== null && summary.oldestAgeSec > 2 * BROKER_BALANCE_SLA_SEC) {
      logger.warn(
        { oldestAgeSec: summary.oldestAgeSec, watched: summary.watched },
        'watched broker balances are stale',
      );
    }
  }

  // a tick longer than the interval makes the next one a no-op, so the per-minute ceiling holds
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    running ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'balance tick failed');
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    refresh,
    tick,
    start() {
      if (stopped || timer !== undefined) return;
      timer = setInterval(() => void tick(), deps.config.intervalMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      stopping.abort();
      await Promise.allSettled([running, ...[...flights.values()].map((flight) => flight.promise)]);
    },
  };
}

function assertExhausted(value: never): never {
  throw new Error(`unhandled access token result: ${JSON.stringify(value)}`);
}
