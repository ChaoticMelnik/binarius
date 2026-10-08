import { and, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { AdminLedgerEntry, TokenLedgerKind } from '@binarius/shared';
import { tokenLedger } from './schema/token-ledger';
import { users } from './schema/users';
import type { Tx } from './trade-intent-ops';

// The admin token ledger page and the user card's ledger section (#109; docs/admin-pages.md).
// Every function takes a Tx, not a Db: each runs inside the staff transaction that also writes
// its audit row (runAsStaff), and none of them locks anything — only the staff_sessions touch is
// an UPDATE. Read only: nothing here writes token_ledger or users.

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
