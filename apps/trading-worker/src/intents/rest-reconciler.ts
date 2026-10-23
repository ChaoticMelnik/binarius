import { BrokerRestError, TradeListStatus, type BrokerRestClient } from '@binarius/broker-rest';
import {
  BrokerRestErrorCode,
  errorLogFields,
  normalizeDecimal,
  TradeIntentFailureReason,
  TradeMode,
  type BrokerTrade,
} from '@binarius/shared';
import type { TradeIntentRow } from '@binarius/db';
import {
  isAccessTokenRefusal,
  reportRefusedToken,
  type AccessTokenSource,
} from '../broker/access-token';
import type { Logger } from './processor';
import { readTradePages, TradePagesError } from './trade-pages';
import {
  ReconcileUnavailableReason,
  type IntentReconciler,
  type ReconcileResult,
} from './reconciler';

// Matches an unknown intent against the broker's own trade lists (#90, docs/trade-intent-
// transport.md -> Reconciliation matching). It only reads: no trade is opened and nothing is
// written here; the pass persists the result. A demo intent with no candidate is released
// (`not_found`) only on two agreeing first-page proofs of absence (#274).

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
  pagesRead: number;
  // the list's end is proven on its first page alone (#274, docs/broker-rest.md -> A1/A7)
  proof: boolean;
}

const ABSENT = Symbol('absent');

const unavailable = (reason: ReconcileUnavailableReason): ReconcileResult => ({
  outcome: 'unavailable',
  reason,
});

const REST_ERROR_REASON: Record<BrokerRestErrorCode, ReconcileUnavailableReason> = {
  [BrokerRestErrorCode.RateLimited]: ReconcileUnavailableReason.RateLimited,
  // the token is reported back first (#281); the next attempt by lease takes the exchanged one
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
    // A one-page covered read is an empty first page or one that reached a trade older than the
    // window. Newest first, a trade inside the window sorts before it, so ours would be there.
    // The reader refuses only growth: one trade, repeated ids or equal timestamps show no
    // direction, so the first trade must be strictly newer than the last and every id distinct.
    const page = read.trades;
    const firstPageEnd = read.covered && read.pagesRead === 1;
    const distinct = new Set(page.map((trade) => trade.id)).size === page.length;
    const strict = page.length === 0 || page[0]!.openTimestamp > page.at(-1)!.openTimestamp;
    const sameMode = page.every((trade) => trade.isDemo === isDemo);
    return {
      trades: read.trades.filter(
        (trade) => trade.openTimestamp >= windowStart && trade.openTimestamp <= windowEnd,
      ),
      covered: read.covered,
      pagesRead: read.pagesRead,
      proof: firstPageEnd && distinct && strict && sameMode,
    };
  }

  // intent id -> the claim of the attempt that first proved absence; every other ending of a
  // non-aborted attempt deletes it, so the two proofs are consecutive attempts
  const absentSince = new Map<string, number>();

  async function decide(
    intent: TradeIntentRow,
    submittedAt: number,
    claimedAt: number,
    signal: AbortSignal,
  ): Promise<ReconcileResult | typeof ABSENT> {
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
      if (error.code === BrokerRestErrorCode.Unauthorized) {
        await reportRefusedToken(tokens, logger, ids, token.accessToken, {
          mayRefresh: true,
          signal,
        });
      }
      return unavailable(REST_ERROR_REASON[error.code]);
    }

    // a trade that closed between the two reads is in both; the closed form is the newer
    const byId = new Map<string, BrokerTrade>();
    for (const trade of [...open.trades, ...closed.trades]) byId.set(trade.id, trade);
    // exact: every key equal; near: the amount differs, the one key the broker may change by
    // rounding. A near match is never `found`; once the window has closed it parks the
    // intent as ambiguous rather than unresolved.
    const amount = normalizeDecimal(intent.amount);
    const sameTrade = [...byId.values()].filter(
      (trade) =>
        trade.assetId === intent.assetId &&
        trade.action === intent.action &&
        trade.isDemo === isDemo,
    );
    // an earlier trade of the account backs its own intent (a Martingale step changes the
    // amount between neighbours), so it is neither a candidate nor a near match
    const linked =
      sameTrade.length === 0
        ? new Set<string>()
        : await linkedTradeIds(
            intent.brokerAccountId,
            sameTrade.map((trade) => trade.id),
          );
    const unlinked = sameTrade.filter((trade) => !linked.has(trade.id));
    const exact = unlinked.filter((trade) => normalizeDecimal(trade.amount) === amount);
    const near = unlinked.length - exact.length;
    // the executor saw the broker open a trade for this order, only not the expected one
    const ackMismatch = intent.lastError === TradeIntentFailureReason.TradeMismatch;
    const covered = open.covered && closed.covered;
    const ambiguous = (): ReconcileResult => {
      logger.warn(
        { ...ids, candidates: exact.length, nearMatches: near, ackMismatch, covered },
        'reconciliation is ambiguous',
      );
      return { outcome: 'ambiguous' };
    };

    // Absence is concluded only from first pages (proof above), never from a page's length or
    // a later offset, whose semantics were not observed live (docs/broker-rest.md -> A2).
    if (exact.length > 1) return ambiguous();
    const [found] = exact;
    if (found !== undefined && covered) return { outcome: 'found', trade: found };
    // by the database clock: a trade may still be opened inside the window
    if (claimedAt < windowEnd) {
      if (!covered) {
        logger.warn(ids, 'trade pages did not cover the reconciliation window');
        return unavailable(ReconcileUnavailableReason.WindowNotCovered);
      }
      return unavailable(ReconcileUnavailableReason.WindowOpen);
    }
    // one candidate in pages that did not cover the window could have a twin beyond them
    if (found !== undefined) return ambiguous();
    if (near > 0 || ackMismatch) return ambiguous();
    if (isDemo && open.proof && closed.proof) return ABSENT;
    logger.warn(
      {
        ...ids,
        covered,
        openPages: open.pagesRead,
        closedPages: closed.pagesRead,
        proof: { open: open.proof, closed: closed.proof },
      },
      'reconciliation unresolved; parked for manual review',
    );
    return { outcome: 'unresolved' };
  }

  function confirmAbsence(intent: TradeIntentRow, claimedAt: number): ReconcileResult {
    const ids = { intentId: intent.id, brokerAccountId: intent.brokerAccountId };
    const first = absentSince.get(intent.id);
    // the same claim seen again is not a second attempt: the reads must be a retry apart
    if (first === undefined || claimedAt <= first) {
      absentSince.set(intent.id, claimedAt);
      logger.info(ids, 'reconciliation proved absence once; confirming on the next attempt');
      return unavailable(ReconcileUnavailableReason.AbsenceUnconfirmed);
    }
    absentSince.delete(intent.id);
    logger.info(ids, 'reconciliation proved absence; releasing the reserve');
    return { outcome: 'not_found' };
  }

  return {
    async reconcile(intent: TradeIntentRow, signal: AbortSignal): Promise<ReconcileResult> {
      if (intent.submittedAt === null) throw new ReconcilerInputError('submittedAt');
      if (intent.reconcileClaimedAt === null) throw new ReconcilerInputError('reconcileClaimedAt');
      const claimedAt = intent.reconcileClaimedAt.getTime();
      let result: ReconcileResult | typeof ABSENT;
      try {
        result = await decide(intent, intent.submittedAt.getTime(), claimedAt, signal);
      } catch (error) {
        if (!signal.aborted) absentSince.delete(intent.id);
        throw error;
      }
      // the pass has given up on this attempt (deadline or stop): it may neither record a proof
      // after a later claim began nor erase one
      if (signal.aborted) return unavailable(ReconcileUnavailableReason.Timeout);
      if (result === ABSENT) return confirmAbsence(intent, claimedAt);
      absentSince.delete(intent.id);
      return result;
    },
  };
}
