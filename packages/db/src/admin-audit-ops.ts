import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS,
  type AdminAuditEntryView,
  type AuditAction,
  type AuditEntityType,
} from '@binarius/shared';
import { auditLog } from './schema/audit-log';
import { staff } from './schema/staff';
import type { Tx } from './trade-intent-ops';

// The admin audit log page (#110; docs/admin-pages.md). Takes a Tx: it runs inside the staff
// transaction that also writes the page's own audit_log_viewed row (runAsStaff), after this
// SELECT. Locks nothing and writes nothing — audit_log is append-only.

export interface AdminAuditFilters {
  action?: AuditAction;
  entityType?: AuditEntityType;
  entityId?: string;
  actorId?: string;
  // YYYY-MM-DD, whole UTC days by the database's clock, both bounds inclusive
  from?: string;
  to?: string;
}

export interface AdminAuditRow {
  id: string;
  createdAt: Date;
  actorType: (typeof auditLog.$inferSelect)['actorType'];
  actorId: string | null;
  actorLogin: string | null;
  action: AuditAction;
  entityType: string | null;
  entityId: string | null;
  payloadPreview: string;
  payloadTruncated: boolean;
}

export interface AdminAuditPage {
  rows: AdminAuditRow[];
  // the id of the last row shown, only when at least one more row exists
  nextCursor: string | null;
}

// The jsonb itself never reaches Node: a bot text row carries up to two 16 384-character texts.
// left() and length() count characters, as the wire schema's max() does.
const payloadText = sql`${auditLog.payload}::text`;

// `at time zone 'UTC'` on a timestamp gives the timestamptz of that UTC wall time whatever the
// session's TimeZone is; a bare ::timestamptz would read the date in the session's zone.
const dayStart = (day: string): SQL => sql`(${day}::date)::timestamp at time zone 'UTC'`;
const nextDayStart = (day: string): SQL => sql`((${day}::date + 1)::timestamp) at time zone 'UTC'`;

// Newest first, keyset on (created_at, id), as listLedgerForAdmin: the cursor positions, it does
// not filter, and an id with no row makes the comparison NULL, so the page is empty.
export async function listAuditForAdmin(
  tx: Tx,
  options: { filters: AdminAuditFilters; cursor?: string; limit: number },
): Promise<AdminAuditPage> {
  const { action, entityType, entityId, actorId, from, to } = options.filters;
  const conditions: (SQL | undefined)[] = [
    action === undefined ? undefined : eq(auditLog.action, action),
    entityType === undefined ? undefined : eq(auditLog.entityType, entityType),
    entityId === undefined ? undefined : eq(auditLog.entityId, entityId),
    actorId === undefined ? undefined : eq(auditLog.actorId, actorId),
    from === undefined ? undefined : sql`${auditLog.createdAt} >= ${dayStart(from)}`,
    to === undefined ? undefined : sql`${auditLog.createdAt} < ${nextDayStart(to)}`,
  ];
  if (options.cursor !== undefined) {
    conditions.push(
      sql`(${auditLog.createdAt}, ${auditLog.id}) < (select c.created_at, c.id from ${auditLog} as c where c.id = ${options.cursor})`,
    );
  }
  const rows = await tx
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      actorLogin: staff.login,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      payloadPreview: sql<string>`left(${payloadText}, ${ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS})`,
      payloadTruncated: sql<boolean>`length(${payloadText}) > ${ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS}`,
    })
    .from(auditLog)
    // actor_id is free text ('cli', NULL): the uuid side is cast, never the text side
    .leftJoin(staff, sql`${staff.id}::text = ${auditLog.actorId}`)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length > options.limit && last !== undefined ? last.id : null,
  };
}

// Key by key, the row is never spread.
export function toAdminAuditEntryView(row: AdminAuditRow): AdminAuditEntryView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    actorLogin: row.actorLogin,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: row.payloadPreview,
    payloadTruncated: row.payloadTruncated,
  };
}
