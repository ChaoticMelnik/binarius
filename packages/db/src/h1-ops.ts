import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  H1_SESSION_SIGNAL_KIND,
  TradingSessionStatus,
  type BrokerAccountStatus,
  type TradeMode,
  type UserStatus,
} from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';
import type { DbExecutor } from './trade-intent-ops';

// H1 sessions (#670, docs/h1.md -> Sessions): the reads of the h1 CLI
// (apps/backend/src/cli/h1-session.ts) and the driver's list. The account's H1 mark was removed
// in #830 (migration 0085).

// an H1 session, settings v5 or a read-only v4 row (#775): both carry signal.kind; the kind is
// a bound parameter, not a literal in SQL
export const h1SessionSql: SQL = sql`(${tradingSessions.settings} #>> '{signal,kind}') = ${H1_SESSION_SIGNAL_KIND}`;

export interface H1Account {
  id: string;
  status: BrokerAccountStatus;
  tradingHalted: boolean;
  userId: string;
  userStatus: UserStatus;
  telegramUserId: string;
  tradingMode: TradeMode;
}

const h1AccountColumns = {
  id: brokerAccounts.id,
  status: brokerAccounts.status,
  tradingHalted: brokerAccounts.tradingHalted,
  userId: users.id,
  userStatus: users.status,
  telegramUserId: users.telegramUserId,
  tradingMode: users.tradingMode,
};

type H1AccountRow = Omit<H1Account, 'telegramUserId'> & { telegramUserId: bigint };
const toH1Account = (row: H1AccountRow): H1Account => ({
  ...row,
  telegramUserId: row.telegramUserId.toString(),
});

export async function readH1Account(
  exec: DbExecutor,
  accountId: string,
): Promise<H1Account | undefined> {
  const [row] = await exec
    .select(h1AccountColumns)
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(eq(brokerAccounts.id, accountId));
  return row === undefined ? undefined : toH1Account(row);
}

export interface AccountActiveSession {
  id: string;
  isH1: boolean;
}

// the account's one active session (trading_sessions_active_account_idx), H1 or not
export async function readActiveH1Session(
  exec: DbExecutor,
  accountId: string,
): Promise<AccountActiveSession | undefined> {
  const [row] = await exec
    .select({ id: tradingSessions.id, isH1: sql<boolean>`coalesce(${h1SessionSql}, false)` })
    .from(tradingSessions)
    .where(
      and(
        eq(tradingSessions.brokerAccountId, accountId),
        eq(tradingSessions.status, TradingSessionStatus.Active),
      ),
    );
  return row;
}

// the account's newest H1 session: the active one, else the latest started
export async function readLastH1Session(
  exec: DbExecutor,
  accountId: string,
): Promise<string | undefined> {
  const [row] = await exec
    .select({ id: tradingSessions.id })
    .from(tradingSessions)
    .where(and(eq(tradingSessions.brokerAccountId, accountId), h1SessionSql))
    .orderBy(
      desc(sql`${tradingSessions.status} = ${TradingSessionStatus.Active}`),
      desc(tradingSessions.startedAt),
      desc(tradingSessions.id),
    )
    .limit(1);
  return row?.id;
}

export interface ActiveH1Session {
  id: string;
  brokerAccountId: string;
  mode: TradeMode;
  // the owner, by the session's account: createSessionIntent's telegramUserId
  telegramUserId: string;
  // raw: the driver parses it
  settings: unknown;
  startedAt: Date;
}

// The driver's list (#707): every active H1 session (settings v4/v5), oldest start first.
export async function listActiveH1Sessions(db: Db): Promise<ActiveH1Session[]> {
  const rows = await db
    .select({
      id: tradingSessions.id,
      brokerAccountId: tradingSessions.brokerAccountId,
      mode: tradingSessions.mode,
      telegramUserId: users.telegramUserId,
      settings: sql<unknown>`${tradingSessions.settings}`,
      startedAt: tradingSessions.startedAt,
    })
    .from(tradingSessions)
    .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(and(eq(tradingSessions.status, TradingSessionStatus.Active), h1SessionSql))
    .orderBy(asc(tradingSessions.startedAt), asc(tradingSessions.id));
  return rows.map((row) => ({ ...row, telegramUserId: row.telegramUserId.toString() }));
}
