import { and, asc, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
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
import type { DbExecutor, Tx } from './trade-intent-ops';

// H1 sessions (#670, docs/h1.md -> Sessions): the account's mark and the reads of the h1 CLI
// (apps/backend/src/cli/h1-mark.ts, h1-session.ts). The mark gates `h1 session start`, and makes a
// session the bot starts on the account an H1 one (#745, checkTradingSessionStart).

// an H1 session, settings v5 or a read-only v4 row (#775): both carry signal.kind; the kind is
// a bound parameter, not a literal in SQL
export const h1SessionSql: SQL = sql`(${tradingSessions.settings} #>> '{signal,kind}') = ${H1_SESSION_SIGNAL_KIND}`;

const activeH1SessionOfAccountSql: SQL = sql`exists (
  select 1 from ${tradingSessions}
  where ${tradingSessions.brokerAccountId} = ${brokerAccounts.id}
    and ${tradingSessions.status} = ${TradingSessionStatus.Active}
    and ${h1SessionSql})`;

export type H1MarkResult = 'marked' | 'unmarked' | 'unchanged' | 'not_found' | 'active_session';

// One conditional UPDATE, the current state in its predicate, as setServiceMark (#391): a re-mark
// keeps the first date. An unmark also needs no active H1 session of the account, in the same
// predicate; the row is locked first, so the predicate's snapshot is taken after any session start
// that held the row (createTradingSession locks it) has committed. Nothing else on the row changes:
// a revocation or a re-login keeps the mark. It writes no audit row: each caller writes its own in
// the same transaction (#745) - the CLI `h1 mark|unmark` as system, the admin route by asStaff as
// the staff member; a new caller writes one too.
export async function setH1Mark(
  tx: Tx,
  { accountId, h1 }: { accountId: string; h1: boolean },
): Promise<H1MarkResult> {
  const [locked] = await tx
    .select({ h1Since: brokerAccounts.h1Since })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.id, accountId))
    .for('no key update');
  if (locked === undefined) return 'not_found';
  const updated = await tx
    .update(brokerAccounts)
    .set({ h1Since: h1 ? sql`now()` : null, updatedAt: sql`now()` })
    .where(
      and(
        eq(brokerAccounts.id, accountId),
        sql`(${brokerAccounts.h1Since} is null) = ${h1}`,
        h1 ? undefined : sql`not ${activeH1SessionOfAccountSql}`,
      ),
    )
    .returning({ id: brokerAccounts.id });
  if (updated.length === 0) {
    if (h1 || locked.h1Since === null) return 'unchanged';
    return 'active_session';
  }
  return h1 ? 'marked' : 'unmarked';
}

export interface H1Account {
  id: string;
  h1Since: Date | null;
  status: BrokerAccountStatus;
  tradingHalted: boolean;
  userId: string;
  userStatus: UserStatus;
  telegramUserId: string;
  tradingMode: TradeMode;
}

const h1AccountColumns = {
  id: brokerAccounts.id,
  h1Since: brokerAccounts.h1Since,
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

export interface H1ListedAccount extends H1Account {
  h1Since: Date;
  // the account's active H1 session, if any
  activeSessionId: string | null;
}

// the marked accounts, oldest mark first
export async function listH1Accounts(exec: DbExecutor): Promise<H1ListedAccount[]> {
  const rows = await exec
    .select({
      ...h1AccountColumns,
      activeSessionId: sql<string | null>`(select ${tradingSessions.id} from ${tradingSessions}
        where ${tradingSessions.brokerAccountId} = ${brokerAccounts.id}
          and ${tradingSessions.status} = ${TradingSessionStatus.Active}
          and ${h1SessionSql})`,
    })
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(isNotNull(brokerAccounts.h1Since))
    .orderBy(asc(brokerAccounts.h1Since), asc(brokerAccounts.id));
  return rows.map((row) => {
    // the WHERE's term; a NULL here would be a broken query, not a state
    if (row.h1Since === null) throw new Error('listH1Accounts: unmarked row');
    return { ...toH1Account(row), h1Since: row.h1Since, activeSessionId: row.activeSessionId };
  });
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

// The driver's list (#707): every active H1 session on a marked account, oldest start first. An H1
// session on an unmarked account (only by hand since createTradingSession re-reads the mark under
// the account's lock) is not traded; the orchestrator holds it until its hour.
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
    .where(
      and(
        eq(tradingSessions.status, TradingSessionStatus.Active),
        h1SessionSql,
        isNotNull(brokerAccounts.h1Since),
      ),
    )
    .orderBy(asc(tradingSessions.startedAt), asc(tradingSessions.id));
  return rows.map((row) => ({ ...row, telegramUserId: row.telegramUserId.toString() }));
}
