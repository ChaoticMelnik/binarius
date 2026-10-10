import { and, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type {
  AdminDepositView,
  AdminLedgerEntry,
  DepositEventStatus,
  TokenLedgerKind,
} from '@binarius/shared';
import { depositEvents } from './schema/deposit-events';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// The admin token ledger page and the user card's ledger section (#109; docs/admin-pages.md),
// and the deposits page and section (#341).
// Every function takes a Tx, not a Db: each runs inside the staff transaction that also writes
// its audit row (runAsStaff), and none of them locks anything — only the staff_sessions touch is
// an UPDATE. Read only: nothing here writes token_ledger, deposit_events or users.

export type AdminLedgerRow = typeof tokenLedger.$inferSelect & { telegramUserId: bigint };

export interface AdminLedgerFilters {
  userId?: string;
  kind?: TokenLedgerKind;
}

export interface AdminLedgerPage {
  rows: AdminLedgerRow[];
  // the id of the last row shown, only when at least one more row exists
  nextCursor: string | null;
}

const entryWithOwner = { ...getTableColumns(tokenLedger), telegramUserId: users.telegramUserId };

// Newest first, keyset on (created_at, id), as listIntentsForAdmin: the cursor positions, it does
// not filter, and an id with no row makes the comparison NULL, so the page is empty.
export async function listLedgerForAdmin(
  tx: Tx,
  options: { filters: AdminLedgerFilters; cursor?: string; limit: number },
): Promise<AdminLedgerPage> {
  const { userId, kind } = options.filters;
  const conditions: (SQL | undefined)[] = [
    userId === undefined ? undefined : eq(tokenLedger.userId, userId),
    kind === undefined ? undefined : eq(tokenLedger.kind, kind),
  ];
  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${tokenLedger.createdAt}, ${tokenLedger.id}) < (select c.created_at, c.id from ${tokenLedger} as c where c.id = ${options.cursor})`,
    );
  }
  const rows = await tx
    .select(entryWithOwner)
    .from(tokenLedger)
    .innerJoin(users, eq(users.id, tokenLedger.userId))
    .where(and(...conditions))
    .orderBy(desc(tokenLedger.createdAt), desc(tokenLedger.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > options.limit && last !== undefined ? last.id : null,
  };
}

// Key by key, the row is never spread. Deltas are the bigint's own decimal string (Rule 2).
export function toAdminLedgerEntry(row: AdminLedgerRow): AdminLedgerEntry {
  return {
    id: row.id,
    userId: row.userId,
    telegramUserId: row.telegramUserId.toString(),
    kind: row.kind,
    balanceDelta: row.balanceDelta.toString(),
    reservedDelta: row.reservedDelta.toString(),
    intentId: row.intentId,
    depositEventId: row.depositEventId,
    brokerAccountId: row.brokerAccountId,
    refType: row.refType,
    refId: row.refId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Deposits (#341) ----------------------------------------------------------------------------

// The raw postback is not on this table (#141): it lives in postback_deliveries, which no admin
// read selects, so it cannot leave the database, let alone the backend.
export type AdminDepositRow = Pick<
  typeof depositEvents.$inferSelect,
  | 'id'
  | 'userId'
  | 'brokerAccountId'
  | 'brokerUserId'
  | 'paymentId'
  | 'amount'
  | 'currency'
  | 'status'
  | 'processedAt'
  | 'createdAt'
> & { telegramUserId: bigint | null };

export interface AdminDepositFilters {
  userId?: string;
  status?: DepositEventStatus;
}

export interface AdminDepositsPage {
  rows: AdminDepositRow[];
  // the id of the last row shown, only when at least one more row exists
  nextCursor: string | null;
}

// An explicit projection, not getTableColumns: a column added to the table later reaches the
// page only when it is named here.
const depositWithOwner = {
  id: depositEvents.id,
  userId: depositEvents.userId,
  brokerAccountId: depositEvents.brokerAccountId,
  brokerUserId: depositEvents.brokerUserId,
  paymentId: depositEvents.paymentId,
  amount: depositEvents.amount,
  currency: depositEvents.currency,
  status: depositEvents.status,
  processedAt: depositEvents.processedAt,
  createdAt: depositEvents.createdAt,
  telegramUserId: users.telegramUserId,
};

// The same keyset as listLedgerForAdmin. The owner is deposit_events.user_id alone: a left join,
// because an unattributed postback has none, and a row that names an account but no user stays
// out of a `userId` filter, as an unowned one does.
export async function listDepositsForAdmin(
  tx: Tx,
  options: { filters: AdminDepositFilters; cursor?: string; limit: number },
): Promise<AdminDepositsPage> {
  const { userId, status } = options.filters;
  const conditions: (SQL | undefined)[] = [
    userId === undefined ? undefined : eq(depositEvents.userId, userId),
    status === undefined ? undefined : eq(depositEvents.status, status),
  ];
  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${depositEvents.createdAt}, ${depositEvents.id}) < (select c.created_at, c.id from ${depositEvents} as c where c.id = ${options.cursor})`,
    );
  }
  const rows = await tx
    .select(depositWithOwner)
    .from(depositEvents)
    .leftJoin(users, eq(users.id, depositEvents.userId))
    .where(and(...conditions))
    .orderBy(desc(depositEvents.createdAt), desc(depositEvents.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > options.limit && last !== undefined ? last.id : null,
  };
}

// Key by key, the row is never spread. `amount` is the numeric's own string (Rule 2).
export function toAdminDepositView(row: AdminDepositRow): AdminDepositView {
  return {
    id: row.id,
    userId: row.userId,
    telegramUserId: row.telegramUserId === null ? null : row.telegramUserId.toString(),
    brokerAccountId: row.brokerAccountId,
    brokerUserId: row.brokerUserId,
    paymentId: row.paymentId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    processedAt: row.processedAt === null ? null : row.processedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
