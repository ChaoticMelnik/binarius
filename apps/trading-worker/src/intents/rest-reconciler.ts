import { BrokerRestError, TradeListStatus, type BrokerRestClient } from '@binarius/broker-rest';
import { BrokerRestErrorCode, errorLogFields, TradeMode, type BrokerTrade } from '@binarius/shared';
import { normalizeDecimal, type TradeIntentRow } from '@binarius/db';
import { isAccessTokenRefusal, type AccessTokenSource } from '../broker/access-token';
import type { Logger } from './processor';
import { readTradePages, TradePagesError } from './trade-pages';
import {
  ReconcileUnavailableReason,
  type IntentReconciler,
  type ReconcileResult,
} from './reconciler';

// Matches an unknown intent against the broker's own trade lists (#90, docs/trade-intent-
// transport.md -> Reconciliation matching). It only reads: no trade is opened and nothing is
// written here; the pass persists the result.

export interface RestReconcilerConfig {
  // the window on the trade's open_timestamp around the intent's submitted_at, inclusive
  windowBeforeMs: number;
  windowAfterMs: number;
  pageSize: number;
  // pages read per list at most
  maxPages: number;
}

export interface RestReconcilerDeps {
  rest: Pick<BrokerRestClient, 'listTrades'>;
  tokens: AccessTokenSource;
  // which of these broker trade ids already back an intent of the account
  linkedTradeIds: (brokerAccountId: string, ids: readonly string[]) => Promise<ReadonlySet<string>>;
  logger: Logger;
  config: RestReconcilerConfig;
}

// A reconciling intent always has both: takeIntent sets submitted_at, claimReconciling sets the
// claim before the reconciler runs. Missing either is a bug upstream, not a broker answer.
export class ReconcilerInputError extends Error {
  constructor(readonly field: 'submittedAt' | 'reconcileClaimedAt') {
    super(`reconciling intent without ${field}`);
    this.name = 'ReconcilerInputError';
  }
}

interface WindowRead {
  // the list's trades inside the window
  trades: BrokerTrade[];
  // the list was read down past the window's start, or to its end
  covered: boolean;
}

const unavailable = (reason: ReconcileUnavailableReason): ReconcileResult => ({
  outcome: 'unavailable',
  reason,
});

const REST_ERROR_REASON: Record<BrokerRestErrorCode, ReconcileUnavailableReason> = {
  [BrokerRestErrorCode.RateLimited]: ReconcileUnavailableReason.RateLimited,
  // 401 on a token the backend just handed out; refreshing on it is #101's
  [BrokerRestErrorCode.Unauthorized]: ReconcileUnavailableReason.TokenUnavailable,
  [BrokerRestErrorCode.Rejected]: ReconcileUnavailableReason.BrokerContract,
  [BrokerRestErrorCode.ContractViolation]: ReconcileUnavailableReason.BrokerContract,
  [BrokerRestErrorCode.Unavailable]: ReconcileUnavailableReason.BrokerUnavailable,
  [BrokerRestErrorCode.Aborted]: ReconcileUnavailableReason.Timeout,
};

export function createRestReconciler({
  rest,
  tokens,
  linkedTradeIds,
  logger,
  config,
}: RestReconcilerDeps): IntentReconciler {
  async function readWindow(
    accessToken: string,
    status: TradeListStatus,
    isDemo: boolean,
    windowStart: number,
    windowEnd: number,
    signal: AbortSignal,
  ): Promise<WindowRead> {
    const read = await readTradePages(
      (offset) =>
        rest.listTrades(
          { accessToken },
          { status, isDemo, limit: config.pageSize, offset },
          { signal },
        ),
      { maxPages: config.maxPages, stopAt: (trade) => trade.openTimestamp < windowStart },
    );
    return {
      trades: read.trades.filter(
        (trade) => trade.openTimestamp >= windowStart && trade.openTimestamp <= windowEnd,
      ),
      covered: read.covered,
    };
  }

  return {
    async reconcile(intent: TradeIntentRow, signal: AbortSignal): Promise<ReconcileResult> {
      if (intent.submittedAt === null) throw new ReconcilerInputError('submittedAt');
      if (intent.reconcileClaimedAt === null) throw new ReconcilerInputError('reconcileClaimedAt');
      const submittedAt = intent.submittedAt.getTime();
      const windowStart = submittedAt - config.windowBeforeMs;
      const windowEnd = submittedAt + config.windowAfterMs;
      const ids = { intentId: intent.id, brokerAccountId: intent.brokerAccountId };

      const token = await tokens.accessToken(intent.brokerAccountId, { mayRefresh: true, signal });
      if (!token.ok) {
        if (isAccessTokenRefusal(token.reason)) {
          logger.warn({ ...ids, refusal: token.reason }, 'reconciliation token refused');
          return unavailable(ReconcileUnavailableReason.TokenUnavailable);
        }
        logger.warn(
          { ...ids, failure: token.reason, status: token.status },
          'reconciliation token unavailable',
        );
        return unavailable(ReconcileUnavailableReason.BackendUnavailable);
      }

      const isDemo = intent.mode === TradeMode.Demo;
      let open: WindowRead;
      let closed: WindowRead;
      try {
        open = await readWindow(
          token.accessToken,
          TradeListStatus.Open,
          isDemo,
          windowStart,
          windowEnd,
          signal,
        );
        closed = await readWindow(
          token.accessToken,
          TradeListStatus.Closed,
          isDemo,
          windowStart,
          windowEnd,
          signal,
        );
      } catch (error) {
        if (error instanceof TradePagesError) {
          logger.warn(
            { ...ids, violation: error.violation },
            'broker trade pages are inconsistent; nothing concluded',
          );
          return unavailable(ReconcileUnavailableReason.BrokerContract);
        }
        if (!(error instanceof BrokerRestError)) throw error;
        logger.warn(
          {
            ...ids,
            ...errorLogFields(error),
            status: error.status,
            retryAfterSec: error.retryAfterSec,
            detail: error.detail,
          },
          'reconciliation trade list failed',
        );
        return unavailable(REST_ERROR_REASON[error.code]);
      }

      // a trade that closed between the two reads is in both; the closed form is the newer
      const byId = new Map<string, BrokerTrade>();
      for (const trade of [...open.trades, ...closed.trades]) byId.set(trade.id, trade);
      const amount = normalizeDecimal(intent.amount);
      const matching = [...byId.values()].filter(
        (trade) =>
          trade.assetId === intent.assetId &&
          trade.action === intent.action &&
          trade.isDemo === isDemo &&
          normalizeDecimal(trade.amount) === amount,
      );
      const linked =
        matching.length === 0
          ? new Set<string>()
          : await linkedTradeIds(
              intent.brokerAccountId,
              matching.map((trade) => trade.id),
            );
      const candidates = matching.filter((trade) => !linked.has(trade.id));
      const covered = open.covered && closed.covered;

      if (candidates.length > 1) {
        logger.warn({ ...ids, candidates: candidates.length }, 'reconciliation is ambiguous');
        return { outcome: 'ambiguous' };
      }
      // one candidate in a window the pages did not cover could have a twin beyond them
      if (!covered) {
        logger.warn(ids, 'trade pages did not cover the reconciliation window');
        return unavailable(ReconcileUnavailableReason.WindowNotCovered);
      }
      const [found] = candidates;
      if (found !== undefined) return { outcome: 'found', trade: found };
      // absence is certain only once the window has closed by the database clock
      if (intent.reconcileClaimedAt.getTime() < windowEnd) {
        return unavailable(ReconcileUnavailableReason.WindowOpen);
      }
      return { outcome: 'not_found' };
    },
  };
}
