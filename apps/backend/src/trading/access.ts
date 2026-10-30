import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import {
  ACCESS_SKEW_MS,
  BrokerBalanceUnavailableReason,
  BrokerAccountStatus,
  TradeIntentErrorCode,
  UserErrorCode,
  UserStatus,
  assertExhausted,
  errorLogFields,
  safeParseTradingAccessRequest,
  type BrokerBalanceView,
} from '@binarius/shared';
import {
  BalanceRefreshError,
  readBalanceSnapshot,
  readTradingAccessState,
  toBrokerBalanceView,
  toTradingAccessView,
  touchAndReadBalanceSnapshot,
  type Db,
  type TradingAccessState,
} from '@binarius/db';
import type { BalanceReconciler, BalanceRefreshOutcome } from '../broker/balance-reconciler';
import { TRADING_ACCESS_REFRESH_BUDGET_MS } from '../timing';

export interface TradingAccessDeps {
  db: Db;
  balance: Pick<BalanceReconciler, 'refresh'>;
}

type BrokerSection =
  | { broker: BrokerBalanceView; brokerUnavailable: null }
  | { broker: null; brokerUnavailable: BrokerBalanceUnavailableReason }
  | 'not_found';

const unavailable = (reason: BrokerBalanceUnavailableReason): BrokerSection => ({
  broker: null,
  brokerUnavailable: reason,
});

// what a failed refresh says when there is no snapshot to fall back on
function reasonFor(outcome: BalanceRefreshOutcome): BrokerBalanceUnavailableReason {
  switch (outcome) {
    case BalanceRefreshError.AccountPending:
      return BrokerBalanceUnavailableReason.AccountPending;
    case BalanceRefreshError.AccountRevoked:
      return BrokerBalanceUnavailableReason.AccountRevoked;
    case 'user_blocked':
      return BrokerBalanceUnavailableReason.UserBlocked;
    // joined a background attempt that may not exchange the token; the next request will
    case 'refresh_needed':
      return BrokerBalanceUnavailableReason.Refreshing;
    // ok without a snapshot and account_not_found cannot happen (neither broker_accounts nor
    // snapshot rows are deleted); they are listed so a new outcome has to be placed here
    case 'ok':
    case 'account_not_found':
    case 'aborted':
    case BalanceRefreshError.Unauthorized:
    case BalanceRefreshError.RateLimited:
    case BalanceRefreshError.Rejected:
    case BalanceRefreshError.Unavailable:
    case BalanceRefreshError.ContractViolation:
    case BalanceRefreshError.AccountMismatch:
    case BalanceRefreshError.KeyUnavailable:
      return BrokerBalanceUnavailableReason.BrokerUnavailable;
  }
  return assertExhausted(outcome, 'balance refresh outcome');
}

async function brokerSection(
  { db, balance }: TradingAccessDeps,
  log: FastifyBaseLogger,
  resolved: TradingAccessState['account'],
): Promise<BrokerSection> {
  switch (resolved.kind) {
    case 'not_found':
      return 'not_found';
    case 'ambiguous':
      return unavailable(BrokerBalanceUnavailableReason.AmbiguousAccount);
    case 'no_account':
      return unavailable(BrokerBalanceUnavailableReason.NoAccount);
    case 'account':
      break;
  }
  const { account } = resolved;
  if (account.status === BrokerAccountStatus.Pending) {
    return unavailable(BrokerBalanceUnavailableReason.AccountPending);
  }
  if (account.status === BrokerAccountStatus.Revoked) {
    return unavailable(BrokerBalanceUnavailableReason.AccountRevoked);
  }

  const stored = await touchAndReadBalanceSnapshot(db, account.id);
  const view = stored === undefined ? undefined : toBrokerBalanceView(stored);
  const current = (fallback: BrokerBalanceUnavailableReason): BrokerSection =>
    view === undefined ? unavailable(fallback) : { broker: view, brokerUnavailable: null };

  if (view?.fresh === true) return { broker: view, brokerUnavailable: null };
  // a blocked user never reaches the broker (Rule 12); what is stored is still theirs to see
  if (account.userStatus === UserStatus.Blocked) {
    return current(BrokerBalanceUnavailableReason.UserBlocked);
  }

  // Same comparison and clock as ensureFreshAccessToken: a token it would hand out unchanged.
  // Otherwise the exchange (up to BROKER_HTTP_TIMEOUT_MS) runs in the background and the bot gets
  // the current state now instead of a timeout.
  if (account.accessTokenExpiresAt.getTime() <= Date.now() + ACCESS_SKEW_MS) {
    balance.refresh(account.id, { requested: true }).catch((error: unknown) => {
      log.error({ accountId: account.id, ...errorLogFields(error) }, 'balance refresh threw');
    });
    return current(BrokerBalanceUnavailableReason.Refreshing);
  }

  const outcome = await balance.refresh(account.id, {
    signal: AbortSignal.timeout(TRADING_ACCESS_REFRESH_BUDGET_MS),
    requested: true,
  });
  const refreshed = await readBalanceSnapshot(db, account.id);
  if (refreshed !== undefined) {
    return { broker: toBrokerBalanceView(refreshed), brokerUnavailable: null };
  }
  return unavailable(reasonFor(outcome));
}

// Read-only on the token side: nothing here reserves or credits; the reservation itself is
// createTradeIntent's CAS. The broker side may refresh the balance snapshot (docs/trading-access.md
// → Broker balance). Registered inside tradingRoutes, whose bearer hook covers every route of
// that plugin.
export function registerTradingAccess(app: FastifyInstance, deps: TradingAccessDeps): void {
  app.post('/trading/access', async (request, reply) => {
    const parsed = safeParseTradingAccessRequest(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const state = await readTradingAccessState(deps.db, {
      telegramUserId: BigInt(parsed.data.telegramUserId),
      ...(parsed.data.brokerAccountId === undefined
        ? {}
        : { brokerAccountId: parsed.data.brokerAccountId }),
    });
    if (state === undefined) {
      return reply.code(404).send({ error: UserErrorCode.UserNotFound });
    }
    const section = await brokerSection(deps, request.log, state.account);
    if (section === 'not_found') {
      return reply.code(404).send({ error: TradeIntentErrorCode.BrokerAccountNotFound });
    }
    return reply.send({
      ...toTradingAccessView(state.tokens),
      ...section,
      tradingOpen: state.tradingOpen,
      ...state.stakes,
    });
  });
}
