import { and, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import {
  ADMIN_INTENTS_ACTIVE_FILTER,
  ADMIN_USER_RECENT_INTENTS,
  safeParseTradingSessionSettings,
  type AdminIntentStatusFilter,
  type AdminTradeIntentView,
  type AdminTradingSessionView,
  type TradeMode,
} from '@binarius/shared';
import { brokerAccounts } from './schema/broker-accounts';
import { sqlLiteralList } from './schema/columns';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';
import { toTradeIntentView, type TradeIntentRow, type Tx } from './trade-intent-ops';

// The admin intents pages (#108), and the trading sessions page and the user card's trading
// section (#330); docs/admin-pages.md. Every function takes a Tx, not a Db: each
// runs inside the staff transaction that also writes its audit row (runAsStaff), and none of
// them locks anything — only the staff_sessions touch is an UPDATE.

// The same set trade_intents_active_account_idx treats as blocking.
const nonTerminalIntent = sql`${tradeIntents.status} not in (${sqlLiteralList(TERMINAL_TRADE_INTENT_STATUSES)})`;

export type AdminIntentRow = TradeIntentRow & { telegramUserId: bigint };

export interface AdminIntentFilters {
  status?: AdminIntentStatusFilter;
  mode?: TradeMode;
  userId?: string;
  tradingSessionId?: string;
}

export interface AdminIntentPage {
  rows: AdminIntentRow[];
  // the id of the last row shown, only when at least one more row exists
  nextCursor: string | null;
}

const intentWithOwner = { ...getTableColumns(tradeIntents), telegramUserId: users.telegramUserId };

// Newest first, keyset on (created_at, id), as listUsersForAdmin. The cursor positions, it does
// not filter: the cursor row need not pass this request's filters, only its (created_at, id) is
// compared. An id with no row makes the comparison NULL, so the page is empty.
export async function listIntentsForAdmin(
  tx: Tx,
  options: { filters: AdminIntentFilters; cursor?: string; limit: number },
): Promise<AdminIntentPage> {
  const { status, mode, userId, tradingSessionId } = options.filters;
  const conditions: (SQL | undefined)[] = [
    status === undefined
      ? undefined
      : status === ADMIN_INTENTS_ACTIVE_FILTER
        ? nonTerminalIntent
        : eq(tradeIntents.status, status),
    mode === undefined ? undefined : eq(tradeIntents.mode, mode),
    userId === undefined ? undefined : eq(tradeIntents.userId, userId),
    tradingSessionId === undefined
      ? undefined
      : eq(tradeIntents.tradingSessionId, tradingSessionId),
  ];
  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${tradeIntents.createdAt}, ${tradeIntents.id}) < (select c.created_at, c.id from ${tradeIntents} as c where c.id = ${options.cursor})`,
    );
  }
  const rows = await tx
    .select(intentWithOwner)
    .from(tradeIntents)
    .innerJoin(users, eq(users.id, tradeIntents.userId))
    .where(and(...conditions))
    .orderBy(desc(tradeIntents.createdAt), desc(tradeIntents.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > options.limit && last !== undefined ? last.id : null,
  };
}

export async function readIntentForAdmin(tx: Tx, id: string): Promise<AdminIntentRow | undefined> {
  const [row] = await tx
    .select(intentWithOwner)
    .from(tradeIntents)
    .innerJoin(users, eq(users.id, tradeIntents.userId))
    .where(eq(tradeIntents.id, id));
  return row;
}

// The bot's allowlist projection, spread, plus the keys only staff navigate by: the row itself
// is never spread.
export function toAdminTradeIntentView(row: AdminIntentRow): AdminTradeIntentView {
  return {
    ...toTradeIntentView(row, row.telegramUserId),
    userId: row.userId,
    tradingSessionId: row.tradingSessionId,
    reconcileClaimedAt:
      row.reconcileClaimedAt === null ? null : row.reconcileClaimedAt.toISOString(),
  };
}

export interface AdminUserIntentRows {
  recent: AdminIntentRow[];
  total: number;
  active: number;
}

// Two statements: the newest intents through the list's own query, so the section and
// "Все заявки →" share one order, and both counters in one SELECT over trade_intents_user_id_idx.
export async function readUserIntentsSection(tx: Tx, userId: string): Promise<AdminUserIntentRows> {
  const { rows: recent } = await listIntentsForAdmin(tx, {
    filters: { userId },
    limit: ADMIN_USER_RECENT_INTENTS,
  });
  const [counts] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`(count(*) filter (where ${nonTerminalIntent}))::int`,
    })
    .from(tradeIntents)
    .where(eq(tradeIntents.userId, userId));
  if (counts === undefined) throw new Error('readUserIntentsSection: the count returned no row');
  return { recent, total: counts.total, active: counts.active };
}

const sessionWithOwner = {
  id: tradingSessions.id,
  brokerAccountId: tradingSessions.brokerAccountId,
  brokerUserId: brokerAccounts.brokerUserId,
  userId: brokerAccounts.userId,
  telegramUserId: users.telegramUserId,
  mode: tradingSessions.mode,
  status: tradingSessions.status,
  stopReason: tradingSessions.stopReason,
  // the column's $type is a promise to writers only: a row written by hand is parsed at read
  settings: sql<unknown>`${tradingSessions.settings}`,
  startedAt: tradingSessions.startedAt,
  endedAt: tradingSessions.endedAt,
  lastDecisionAt: tradingSessions.lastDecisionAt,
  createdAt: tradingSessions.createdAt,
  updatedAt: tradingSessions.updatedAt,
};

export interface AdminTradingSessionRow {
  id: string;
  brokerAccountId: string;
  brokerUserId: string;
  userId: string;
  telegramUserId: bigint;
  mode: AdminTradingSessionView['mode'];
  status: AdminTradingSessionView['status'];
  stopReason: AdminTradingSessionView['stopReason'];
  settings: unknown;
  startedAt: Date;
  endedAt: Date | null;
  lastDecisionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Every session, whatever its account's or owner's status. Newest first, keyset on
// (created_at, id), as listIntentsForAdmin; an id with no row gives an empty page.
export async function listTradingSessionsForAdmin(
  tx: Tx,
  options: { cursor?: string; limit: number },
): Promise<{ rows: AdminTradingSessionRow[]; nextCursor: string | null }> {
  const rows: AdminTradingSessionRow[] = await tx
    .select(sessionWithOwner)
    .from(tradingSessions)
    .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
    .innerJoin(users, eq(users.id, brokerAccounts.userId))
    .where(
      options.cursor === undefined
        ? undefined
        : sql`(${tradingSessions.createdAt}, ${tradingSessions.id}) < (select c.created_at, c.id from ${tradingSessions} as c where c.id = ${options.cursor})`,
    )
    .orderBy(desc(tradingSessions.createdAt), desc(tradingSessions.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > options.limit && last !== undefined ? last.id : null,
  };
}

const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

// Key by key; settings are the parsed v1 value or null, never the raw jsonb.
export function toAdminTradingSessionView(row: AdminTradingSessionRow): AdminTradingSessionView {
  const parsed = safeParseTradingSessionSettings(row.settings);
  return {
    id: row.id,
    brokerAccountId: row.brokerAccountId,
    brokerUserId: row.brokerUserId,
    userId: row.userId,
    telegramUserId: row.telegramUserId.toString(),
    mode: row.mode,
    status: row.status,
    stopReason: row.stopReason,
    settings: parsed.success ? parsed.data : null,
    startedAt: row.startedAt.toISOString(),
    endedAt: isoOrNull(row.endedAt),
    lastDecisionAt: isoOrNull(row.lastDecisionAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
