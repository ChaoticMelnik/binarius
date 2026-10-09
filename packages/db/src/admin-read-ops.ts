import { and, desc, eq, exists, or, sql, type SQL } from 'drizzle-orm';
import {
  ADMIN_USER_RECENT_LEDGER,
  addressOrNull,
  BrokerAccountStatus,
  telegramUserIdSchema,
  TradeIntentStatus,
  UserStatus,
  type AdminIntentsByStatus,
  type AdminBrokerAccountListItem,
  type AdminBrokerAccountView,
  type AdminOverview,
  type AdminUserDetail,
  type AdminUserListItem,
} from '@binarius/shared';
import {
  listDepositsForAdmin,
  listLedgerForAdmin,
  type AdminDepositRow,
  type AdminLedgerRow,
} from './admin-ledger-ops';
import { readUserIntentsSection, type AdminUserIntentRows } from './admin-trading-ops';
import { brokerAccounts } from './schema/broker-accounts';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// The admin read pages (#107, the trading section and the overview breakdown #330, the token
// ledger section #109, the deposits section #341, the broker accounts list #342;
// docs/admin-pages.md). Every function takes a Tx, not a Db: each
// runs inside the staff transaction that also writes its audit row (runAsStaff), and none of
// them locks anything — only the staff_sessions touch is an UPDATE.

// Which field the query was compared with on top of broker_user_id, which is always compared:
// broker_user_id is any non-empty string, so the shape of the query cannot rule it out.
export interface UserSearch {
  by: 'telegram_user_id' | 'email' | 'broker_user_id';
  value: string;
}

export function classifyUserSearch(q: string): UserSearch {
  if (telegramUserIdSchema.safeParse(q).success) return { by: 'telegram_user_id', value: q };
  if (q.includes('@')) return { by: 'email', value: q };
  return { by: 'broker_user_id', value: q };
}

export type AdminUserListRow = Pick<
  typeof users.$inferSelect,
  'id' | 'telegramUserId' | 'displayName' | 'status' | 'tokenBalance' | 'createdAt' | 'updatedAt'
>;

export interface AdminUserListPage {
  rows: AdminUserListRow[];
  // the id of the last row shown, only when at least one more row exists
  nextCursor: string | null;
}

function searchCondition(tx: Tx, search: UserSearch): SQL | undefined {
  const accountWhere = (condition: SQL) =>
    exists(
      tx
        .select({ one: sql`1` })
        .from(brokerAccounts)
        .where(and(eq(brokerAccounts.userId, users.id), condition)),
    );
  return or(
    accountWhere(eq(brokerAccounts.brokerUserId, search.value)),
    search.by === 'telegram_user_id' ? eq(users.telegramUserId, BigInt(search.value)) : undefined,
    search.by === 'email'
      ? accountWhere(sql`lower(${brokerAccounts.email}) = lower(${search.value})`)
      : undefined,
  );
}

// Newest first, keyset on (created_at, id). The cursor is a row id and its created_at is read
// from the row, not carried in the URL: a JS Date has milliseconds, timestamptz microseconds. An
// id with no row makes the comparison NULL, so the page is empty rather than an error.
export async function listUsersForAdmin(
  tx: Tx,
  options: { search?: UserSearch; cursor?: string; limit: number },
): Promise<AdminUserListPage> {
  const conditions: (SQL | undefined)[] = [];
  if (options.search !== undefined) conditions.push(searchCondition(tx, options.search));
  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${users.createdAt}, ${users.id}) < (select u.created_at, u.id from ${users} as u where u.id = ${options.cursor})`,
    );
  }
  const rows = await tx
    .select({
      id: users.id,
      telegramUserId: users.telegramUserId,
      displayName: users.displayName,
      status: users.status,
      tokenBalance: users.tokenBalance,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(and(...conditions))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > options.limit && last !== undefined ? last.id : null,
  };
}

export type AdminUserRow = Pick<
  typeof users.$inferSelect,
  | 'id'
  | 'telegramUserId'
  | 'displayName'
  | 'languageCode'
  | 'status'
  | 'acquisitionSource'
  | 'acquiredAt'
  | 'telegramBlockedAt'
  | 'notificationLevel'
  | 'demoStake'
  | 'tokenBalance'
  | 'tokenReserved'
  | 'createdAt'
  | 'updatedAt'
>;

export type AdminBrokerAccountRow = Pick<
  typeof brokerAccounts.$inferSelect,
  | 'id'
  | 'brokerUserId'
  | 'email'
  | 'isPartnerClient'
  | 'status'
  | 'authRevokedReason'
  | 'tradingHalted'
  | 'haltedReason'
  | 'accessTokenExpiresAt'
  | 'tokenRotatedAt'
  | 'createdAt'
  | 'updatedAt'
>;

// The one place that says which broker_accounts columns the admin reads: the ciphertexts, the key
// id and the refresh-token hash are not here, so no select built from it can carry them.
export const adminBrokerAccountColumns = {
  id: brokerAccounts.id,
  brokerUserId: brokerAccounts.brokerUserId,
  email: brokerAccounts.email,
  isPartnerClient: brokerAccounts.isPartnerClient,
  status: brokerAccounts.status,
  authRevokedReason: brokerAccounts.authRevokedReason,
  tradingHalted: brokerAccounts.tradingHalted,
  haltedReason: brokerAccounts.haltedReason,
  accessTokenExpiresAt: brokerAccounts.accessTokenExpiresAt,
  tokenRotatedAt: brokerAccounts.tokenRotatedAt,
  createdAt: brokerAccounts.createdAt,
  updatedAt: brokerAccounts.updatedAt,
};

export interface AdminUserCard {
  user: AdminUserRow;
  brokerAccounts: AdminBrokerAccountRow[];
  intents: AdminUserIntentRows;
  ledger: AdminLedgerRow[];
  deposits: AdminDepositRow[];
}

// Six selects without a shared snapshot (READ COMMITTED): an account linked, an intent created, a
// ledger row written or a deposit recorded in between may or may not show, and either answer was
// true at its moment. Ciphertexts, the key id, the refresh-token hash and a deposit's payload are
// never selected.
export async function readUserForAdmin(tx: Tx, userId: string): Promise<AdminUserCard | undefined> {
  const [user] = await tx
    .select({
      id: users.id,
      telegramUserId: users.telegramUserId,
      displayName: users.displayName,
      languageCode: users.languageCode,
      status: users.status,
      acquisitionSource: users.acquisitionSource,
      acquiredAt: users.acquiredAt,
      telegramBlockedAt: users.telegramBlockedAt,
      notificationLevel: users.notificationLevel,
      demoStake: users.demoStake,
      tokenBalance: users.tokenBalance,
      tokenReserved: users.tokenReserved,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (user === undefined) return undefined;
  const accounts = await tx
    .select(adminBrokerAccountColumns)
    .from(brokerAccounts)
    .where(eq(brokerAccounts.userId, userId))
    .orderBy(desc(brokerAccounts.createdAt), desc(brokerAccounts.id));
  const intents = await readUserIntentsSection(tx, userId);
  const { rows: ledger } = await listLedgerForAdmin(tx, {
    filters: { userId },
    limit: ADMIN_USER_RECENT_LEDGER,
  });
  const { rows: deposits } = await listDepositsForAdmin(tx, {
    filters: { userId },
    limit: ADMIN_USER_RECENT_LEDGER,
  });
  return { user, brokerAccounts: accounts, intents, ledger, deposits };
}

export interface AdminOverviewRow {
  usersTotal: number;
  usersToday: number;
  usersBlocked: number;
  usersWithActiveBrokerAccount: number;
  usersActiveNow: number;
  intentsTotal: number;
  intentsToday: number;
  // only the statuses that have rows; the CHECK keeps every key a TradeIntentStatus
  intentsByStatus: Partial<Record<string, number>>;
  dayStartsAt: Date;
  asOf: Date;
}

// One statement, so one snapshot: the counts agree with each other. "Today" starts at 00:00 UTC
// by the database clock, whatever the session time zone. "Active now" is a users row changed
// within the window — a proxy, not presence (docs/admin-pages.md lists what writes updated_at).
export async function readAdminOverview(
  tx: Tx,
  options: { activeWindowMinutes: number },
): Promise<AdminOverviewRow> {
  const { rows } = await tx.execute<{
    users_total: number;
    users_today: number;
    users_blocked: number;
    users_with_active_broker_account: number;
    users_active_now: number;
    intents_total: number;
    intents_today: number;
    intents_by_status: Partial<Record<string, number>>;
    day_starts_at: Date | string;
    as_of: Date | string;
  }>(sql`
    select
      (select count(*)::int from ${users}) as users_total,
      (select count(*)::int from ${users} where ${users.createdAt} >= d.day_start) as users_today,
      (select count(*)::int from ${users} where ${users.status} = ${UserStatus.Blocked})
        as users_blocked,
      (select count(distinct ${brokerAccounts.userId})::int from ${brokerAccounts}
        where ${brokerAccounts.status} = ${BrokerAccountStatus.Active})
        as users_with_active_broker_account,
      (select count(*)::int from ${users}
        where ${users.updatedAt} >= now() - make_interval(mins => ${options.activeWindowMinutes}::int))
        as users_active_now,
      (select count(*)::int from ${tradeIntents}) as intents_total,
      (select count(*)::int from ${tradeIntents} where ${tradeIntents.createdAt} >= d.day_start)
        as intents_today,
      coalesce((select jsonb_object_agg(s.status, s.n) from
        (select ${tradeIntents.status} as status, count(*)::int as n from ${tradeIntents}
          group by ${tradeIntents.status}) as s), '{}'::jsonb) as intents_by_status,
      d.day_start as day_starts_at,
      now() as as_of
    from (select date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' as day_start) as d
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('readAdminOverview: the select returned no row');
  return {
    usersTotal: row.users_total,
    usersToday: row.users_today,
    usersBlocked: row.users_blocked,
    usersWithActiveBrokerAccount: row.users_with_active_broker_account,
    usersActiveNow: row.users_active_now,
    intentsTotal: row.intents_total,
    intentsToday: row.intents_today,
    intentsByStatus: row.intents_by_status,
    dayStartsAt: new Date(row.day_starts_at),
    asOf: new Date(row.as_of),
  };
}

const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

// --- Wire projections: key by key, a row is never spread --------------------------------------

export function toAdminUserListItem(row: AdminUserListRow): AdminUserListItem {
  return {
    id: row.id,
    telegramUserId: row.telegramUserId.toString(),
    displayName: row.displayName,
    status: row.status,
    tokenBalance: row.tokenBalance.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAdminUserDetail(row: AdminUserRow): AdminUserDetail {
  return {
    id: row.id,
    telegramUserId: row.telegramUserId.toString(),
    displayName: row.displayName,
    languageCode: row.languageCode,
    status: row.status,
    acquisitionSource: row.acquisitionSource,
    acquiredAt: isoOrNull(row.acquiredAt),
    telegramBlockedAt: isoOrNull(row.telegramBlockedAt),
    notificationLevel: row.notificationLevel,
    // numeric string-mode as stored: shown, never computed with (Rule 29)
    demoStake: row.demoStake,
    tokens: {
      balance: row.tokenBalance.toString(),
      reserved: row.tokenReserved.toString(),
      available: (row.tokenBalance - row.tokenReserved).toString(),
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAdminBrokerAccountView(row: AdminBrokerAccountRow): AdminBrokerAccountView {
  return {
    id: row.id,
    brokerUserId: row.brokerUserId,
    email: addressOrNull(row.email),
    isPartnerClient: row.isPartnerClient,
    status: row.status,
    authRevokedReason: row.authRevokedReason,
    tradingHalted: row.tradingHalted,
    haltedReason: row.haltedReason,
    accessTokenExpiresAt: row.accessTokenExpiresAt.toISOString(),
    tokenRotatedAt: isoOrNull(row.tokenRotatedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// The card's projection, spread, plus the owner: what the row carries beyond it is not copied.
export function toAdminBrokerAccountListItem(
  row: AdminBrokerAccountListRow,
): AdminBrokerAccountListItem {
  return {
    ...toAdminBrokerAccountView(row),
    userId: row.userId,
    telegramUserId: row.telegramUserId.toString(),
  };
}

export function toAdminOverview(
  row: AdminOverviewRow,
  activeWindowMinutes: AdminOverview['activeWindowMinutes'],
): AdminOverview {
  const byStatus = Object.fromEntries(
    Object.values(TradeIntentStatus).map((status) => [status, row.intentsByStatus[status] ?? 0]),
  ) as AdminIntentsByStatus;
  return {
    users: {
      total: row.usersTotal,
      today: row.usersToday,
      blocked: row.usersBlocked,
      withActiveBrokerAccount: row.usersWithActiveBrokerAccount,
      activeNow: row.usersActiveNow,
    },
    intents: {
      total: row.intentsTotal,
      today: row.intentsToday,
      byStatus,
      active: Object.values(TradeIntentStatus)
        .filter((status) => !TERMINAL_TRADE_INTENT_STATUSES.includes(status))
        .reduce((sum, status) => sum + byStatus[status], 0),
    },
    activeWindowMinutes,
    dayStartsAt: row.dayStartsAt.toISOString(),
    asOf: row.asOf.toISOString(),
  };
}

// --- The broker accounts list (#342) -----------------------------------------------------------

export type AdminBrokerAccountListRow = AdminBrokerAccountRow & {
  userId: string;
  telegramUserId: bigint;
};

export interface AdminBrokerAccountFilters {
  status?: BrokerAccountStatus;
  halted?: true;
}

export interface AdminBrokerAccountPage {
  rows: AdminBrokerAccountListRow[];
  // the id of the last row shown, only when at least one more row exists
  nextCursor: string | null;
}

// Every account whatever its user's status, newest first, the same keyset as listUsersForAdmin.
// The filters intersect; `halted` asks for trading_halted alone, whatever the account's status.
export async function listBrokerAccountsForAdmin(
  tx: Tx,
  options: { filters: AdminBrokerAccountFilters; cursor?: string; limit: number },
): Promise<AdminBrokerAccountPage> {
  const { status, halted } = options.filters;
  const conditions: (SQL | undefined)[] = [
    status === undefined ? undefined : eq(brokerAccounts.status, status),
    halted === undefined ? undefined : eq(brokerAccounts.tradingHalted, halted),
  ];
  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${brokerAccounts.createdAt}, ${brokerAccounts.id}) < (select c.created_at, c.id from ${brokerAccounts} as c where c.id = ${options.cursor})`,
    );
  }
  const rows = await tx
    .select({
      ...adminBrokerAccountColumns,
      userId: brokerAccounts.userId,
      telegramUserId: users.telegramUserId,
    })
    .from(brokerAccounts)
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(and(...conditions))
    .orderBy(desc(brokerAccounts.createdAt), desc(brokerAccounts.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > options.limit && last !== undefined ? last.id : null,
  };
}
