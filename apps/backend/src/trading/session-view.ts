import { isTradingSessionFinished, type TradingSessionView } from '@binarius/shared';
import { readTradingSessionAccount, readTradingSessionView, type Db } from '@binarius/db';
import type { BalanceReconciler } from '../broker/balance-reconciler';
import { TRADING_ACCESS_REFRESH_BUDGET_MS } from '../timing';

export interface SessionViewDeps {
  db: Db;
  balance: Pick<BalanceReconciler, 'refresh'>;
}

// The session as its owner sees it, with the balance after its last trade once it is finished
// (#337): the status the bot prints as final and the backend's summary message (#464) both read
// it here. Once nothing of the session can move and the stored snapshot predates its last
// settlement, the broker is asked once more inside TRADING_ACCESS_REFRESH_BUDGET_MS. mayRefresh:
// false - the bot's poll and the notice sender are timers, and a timer exchanges no token
// (Rule 12); no `requested` - neither keeps the account in work. After one 'ok' the snapshot is
// current for good, so a session costs at most one broker GET (Rule 21). A refresh that does not
// answer 'ok' leaves the stored balance and its age; a thrown one reaches the caller.
export async function readFinishedSessionView(
  { db, balance }: SessionViewDeps,
  id: string,
  telegramUserId: string,
): Promise<TradingSessionView | undefined> {
  const view = await readTradingSessionView(db, id, telegramUserId);
  if (
    view === undefined ||
    !isTradingSessionFinished(view) ||
    view.trades.settled === 0 ||
    view.balance?.current === true
  ) {
    return view;
  }
  const account = await readTradingSessionAccount(db, id, telegramUserId);
  if (account === undefined) return view;
  const outcome = await balance.refresh(account.brokerAccountId, {
    signal: AbortSignal.timeout(TRADING_ACCESS_REFRESH_BUDGET_MS),
    mayRefresh: false,
  });
  return outcome === 'ok' ? ((await readTradingSessionView(db, id, telegramUserId)) ?? view) : view;
}
