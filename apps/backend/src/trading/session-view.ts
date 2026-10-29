import { isTradingSessionFinished, type TradingSessionView } from '@binarius/shared';
import { readTradingSessionAccount, readTradingSessionView, type Db } from '@binarius/db';
import type { BalanceReconciler, BalanceRefreshOutcome } from '../broker/balance-reconciler';
import { TRADING_ACCESS_REFRESH_BUDGET_MS } from '../timing';

export interface SessionViewDeps {
  db: Db;
  balance: Pick<BalanceReconciler, 'refresh'>;
}

// The session as its owner sees it, with the balance after its last trade once it is finished
// (#337): the status the bot prints as final and its summary (#537) read it here. Once nothing of
// the session can move and the stored snapshot predates its last settlement or there is none
// (`balance: null`), the broker is asked once more inside TRADING_ACCESS_REFRESH_BUDGET_MS.
// mayRefresh: false - the bot's poll and the notice sender are timers, and a timer exchanges no
// token (Rule 12); no `requested` - neither keeps the account in work. After one 'ok' the snapshot
// is current for good, so a session costs at most one successful broker GET (Rule 21); a refresh
// that does not answer 'ok' leaves the stored balance and its age and is asked again by the next
// read of the finished view - the tracker's last poll, the stop route's reply - one GET each; a
// thrown one reaches the caller. The backend's fallback text summary does not wait for it: it
// starts refreshFinishedBalance once and reads the view again on a later tick (#870).
export async function readFinishedSessionView(
  deps: SessionViewDeps,
  id: string,
  telegramUserId: string,
): Promise<TradingSessionView | undefined> {
  const view = await readTradingSessionView(deps.db, id, telegramUserId);
  if (view === undefined || !finishedViewNeedsBalance(view)) return view;
  const outcome = await refreshFinishedBalance(deps, id, telegramUserId);
  return outcome === 'ok'
    ? ((await readTradingSessionView(deps.db, id, telegramUserId)) ?? view)
    : view;
}

export const finishedViewNeedsBalance = (view: TradingSessionView): boolean =>
  isTradingSessionFinished(view) && view.trades.settled > 0 && view.balance?.current !== true;

export async function refreshFinishedBalance(
  { db, balance }: SessionViewDeps,
  id: string,
  telegramUserId: string,
): Promise<BalanceRefreshOutcome | 'account_not_found'> {
  const account = await readTradingSessionAccount(db, id, telegramUserId);
  if (account === undefined) return 'account_not_found';
  return balance.refresh(account.brokerAccountId, {
    signal: AbortSignal.timeout(TRADING_ACCESS_REFRESH_BUDGET_MS),
    mayRefresh: false,
  });
}
