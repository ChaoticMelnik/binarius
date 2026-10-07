import { and, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import {
  ADMIN_INTENTS_ACTIVE_FILTER,
  type AdminIntentStatusFilter,
  type AdminTradeIntentView,
  type TradeMode,
} from '@binarius/shared';
import { sqlLiteralList } from './schema/columns';
import { TERMINAL_TRADE_INTENT_STATUSES, tradeIntents } from './schema/trade-intents';
import { users } from './schema/users';
import { toTradeIntentView, type TradeIntentRow, type Tx } from './trade-intent-ops';

// The admin intents pages (#108, docs/admin-pages.md). Every function takes a Tx, not a Db: each
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
