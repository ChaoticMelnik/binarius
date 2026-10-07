import { BrokerRestError, TradeListStatus, type BrokerRestClient } from '@binarius/broker-rest';
import {
  BrokerRestErrorCode,
  errorLogFields,
  isClosedTrade,
  TradeMode,
  type ClosedTrade,
} from '@binarius/shared';
import {
  listOverdueAcceptedIntents,
  settleClosedTrades,
  type Db,
  type OverdueAcceptedIntent,
} from '@binarius/db';
import { isAccessTokenRefusal, type AccessTokenSource } from '../broker/access-token';
import type { Logger } from './processor';
import { readTradePages, TradePagesError } from './trade-pages';

// The REST catch-up for accepted intents past their expected close (#90): the main settlement path
// is close_trade.success (the broker sessions, #101, with BROKER_WS_URL set); this reads the
// closed list for the ones it missed and applies it through settleClosedTrades. It runs on a timer, so it never asks the backend to exchange a token
// (mayRefresh: false). Every attempt that does not take its intent out of `accepted` holds the
// account back for stalledRetryMs, so the head of the queue cannot starve the rest
// (docs/trade-intent-transport.md -> Reconciliation matching -> Settlement catch-up).

export interface SettlementCatchupConfig {
  tickMs: number;
  // how long past the expected close the socket gets before REST is asked
  graceMs: number;
  batchSize: number;
  pageSize: number;
  maxPages: number;
  attemptTimeoutMs: number;
  stalledRetryMs: number;
}

export interface SettlementCatchupDeps {
  db: Db;
  rest: Pick<BrokerRestClient, 'listTrades'>;
  tokens: AccessTokenSource;
  logger: Logger;
  config: SettlementCatchupConfig;
}

export interface SettlementCatchup {
  // one tick at once, then every tickMs
  start(): void;
  // resolves when the tick (the running one, if any) ends; never rejects
  tick(): Promise<void>;
  // stops the timer, aborts the attempt's signal and waits for the running tick
  stop(): Promise<void>;
}

export interface CatchupTickSummary {
  overdue: number;
  // the intent left `accepted`: settled here, or settled/parked by someone else meanwhile
  settled: number;
  left: number;
  // held back for stalledRetryMs
  stalled: number;
  rateLimited: number;
}

type Ending = 'settled' | 'left' | 'stalled' | 'rate_limited' | 'stopped';

export function createSettlementCatchup({
  db,
  rest,
  tokens,
  logger,
  config,
}: SettlementCatchupDeps): SettlementCatchup {
  const stopping = new AbortController();
  // account id -> when it may be attempted again; in memory, one worker container (Rule 21)
  const stalled = new Map<string, number>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  const hold = (accountId: string) => stalled.set(accountId, Date.now() + config.stalledRetryMs);

  async function readClosed(
    accessToken: string,
    overdue: OverdueAcceptedIntent,
    signal: AbortSignal,
  ): Promise<{ trades: ClosedTrade[]; pagesRead: number }> {
    const read = await readTradePages(
      (offset) =>
        rest.listTrades(
          { accessToken },
          {
            status: TradeListStatus.Closed,
            isDemo: overdue.mode === TradeMode.Demo,
            limit: config.pageSize,
            offset,
          },
          { signal },
        ),
      { maxPages: config.maxPages, stopAt: (trade) => trade.id === overdue.brokerTradeId },
    );
    return { trades: read.trades.filter(isClosedTrade), pagesRead: read.pagesRead };
  }

  async function attempt(overdue: OverdueAcceptedIntent, signal: AbortSignal): Promise<Ending> {
    const ids = { intentId: overdue.id, brokerAccountId: overdue.brokerAccountId };
    const token = await tokens.accessToken(overdue.brokerAccountId, { mayRefresh: false, signal });
    if (!token.ok) {
      if (isAccessTokenRefusal(token.reason)) {
        logger.warn({ ...ids, refusal: token.reason }, 'settlement catch-up token refused');
      } else if (stopping.signal.aborted) {
        // stop() aborted the request, and the source answers an abort as unreachable
        return 'stopped';
      } else {
        logger.warn(
          { ...ids, failure: token.reason, status: token.status },
          'settlement catch-up token unavailable',
        );
      }
      return 'stalled';
    }
    let read: { trades: ClosedTrade[]; pagesRead: number };
    try {
      read = await readClosed(token.accessToken, overdue, signal);
    } catch (error) {
      if (error instanceof TradePagesError) {
        logger.warn(
          { ...ids, violation: error.violation },
          'broker trade pages are inconsistent; catch-up held back',
        );
        return 'stalled';
      }
      if (!(error instanceof BrokerRestError)) throw error;
      if (error.code === BrokerRestErrorCode.Aborted && stopping.signal.aborted) return 'stopped';
      logger.warn(
        {
          ...ids,
          ...errorLogFields(error),
          status: error.status,
          retryAfterSec: error.retryAfterSec,
          detail: error.detail,
        },
        'settlement catch-up trade list failed',
      );
      // a 429 is the IP's state, not the account's: the tick ends and nobody is held back
      return error.code === BrokerRestErrorCode.RateLimited ? 'rate_limited' : 'stalled';
    }
    const outcomes = await settleClosedTrades(db, {
      brokerAccountId: overdue.brokerAccountId,
      trades: read.trades,
    });
    const target = outcomes.find((outcome) => outcome.brokerTradeId === overdue.brokerTradeId);
    if (target?.result === 'settled') return 'settled';
    if (target?.result === 'already_settled' || target?.result === 'intent_not_accepted') {
      return 'left';
    }
    logger.warn(
      { ...ids, brokerTradeId: overdue.brokerTradeId, pagesRead: read.pagesRead },
      'overdue trade not closed at the broker',
    );
    return 'stalled';
  }

  // The deadline is enforced here, as in the reconciliation pass and the trading session
  // orchestrator: an attempt that ignores its signal cannot hold the tick past it. Kept as a copy
  // in each of the three rather than a shared helper: each has its own result type, its own lines
  // and its own handling of the stop signal, so a helper would take all three as parameters.
  function attemptWithDeadline(overdue: OverdueAcceptedIntent): Promise<Ending> {
    const deadline = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<Ending>((resolve) => {
      timeout = setTimeout(() => {
        deadline.abort();
        logger.warn(
          { intentId: overdue.id, brokerAccountId: overdue.brokerAccountId },
          'settlement catch-up attempt timed out',
        );
        resolve('stalled');
      }, config.attemptTimeoutMs);
    });
    const signal = AbortSignal.any([stopping.signal, deadline.signal]);
    const run = Promise.resolve()
      .then(() => attempt(overdue, signal))
      .catch((error: unknown): Ending => {
        logger.error(
          { ...errorLogFields(error), intentId: overdue.id },
          'settlement catch-up attempt failed',
        );
        return 'stalled';
      });
    return Promise.race([run, expired]).finally(() => clearTimeout(timeout));
  }

  async function runTick(): Promise<void> {
    const now = Date.now();
    for (const [accountId, retryAt] of stalled) if (retryAt <= now) stalled.delete(accountId);
    const overdue = await listOverdueAcceptedIntents(db, {
      graceMs: config.graceMs,
      limit: config.batchSize,
      exclude: [...stalled.keys()],
    });
    const summary: CatchupTickSummary = {
      overdue: overdue.length,
      settled: 0,
      left: 0,
      stalled: 0,
      rateLimited: 0,
    };
    for (const intent of overdue) {
      if (stopped) break;
      const ending = await attemptWithDeadline(intent);
      if (ending === 'stopped') break;
      if (ending === 'rate_limited') {
        summary.rateLimited += 1;
        break;
      }
      if (ending === 'stalled') hold(intent.brokerAccountId);
      summary[ending] += 1;
    }
    if (overdue.length > 0) logger.info(summary, 'settlement catch-up tick');
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    running ??= runTick()
      .catch((error: unknown) => {
        logger.error(errorLogFields(error), 'settlement catch-up tick failed');
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    tick,
    start() {
      if (stopped || timer !== undefined) return;
      void tick();
      timer = setInterval(() => void tick(), config.tickMs);
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      stopping.abort();
      await running;
    },
  };
}
