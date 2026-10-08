import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS,
  ADMIN_PAGE_SIZE,
  adminAuditEntryViewSchema,
  AuditAction,
  AuditActorType,
  AuditEntityType,
} from '@binarius/shared';
import {
  listAuditForAdmin,
  toAdminAuditEntryView,
  type AdminAuditFilters,
} from './admin-audit-ops';
import type { Db } from './client';
import { auditLog } from './schema/index';
import { StaffStatus } from './schema/staff';
import { createTempDatabase, seedStaff, type TempDatabase } from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}
const testUrl = baseUrl;

// each describe owns a database: the page, filter and date oracles need to know every row
const withDatabase = () => {
  const ref: { tmp?: TempDatabase } = {};
  beforeAll(async () => {
    ref.tmp = await createTempDatabase(testUrl);
  });
  afterAll(() => ref.tmp?.drop());
  return (): Db => {
    if (ref.tmp === undefined) throw new Error('database not created yet');
    return ref.tmp.db;
  };
};

const list = (
  db: Db,
  options: { filters?: AdminAuditFilters; cursor?: string; limit?: number; timeZone?: string } = {},
) =>
  db.transaction(async (tx) => {
    if (options.timeZone !== undefined) {
      await tx.execute(sql`select set_config('TimeZone', ${options.timeZone}, true)`);
    }
    return listAuditForAdmin(tx, {
      filters: options.filters ?? {},
      limit: options.limit ?? ADMIN_PAGE_SIZE,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
  });

// audit_log is append-only (0001): every row a test needs is an INSERT, created_at explicit so
// rows written in one go do not share now().
async function insertAudit(
  db: Db,
  row: {
    at: string;
    id?: string;
    action?: AuditAction;
    actorType?: AuditActorType;
    actorId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const [inserted] = await db
    .insert(auditLog)
    .values({
      ...(row.id === undefined ? {} : { id: row.id }),
      actorType: row.actorType ?? AuditActorType.Admin,
      actorId: row.actorId ?? null,
      action: row.action ?? AuditAction.StaffLogout,
      entityType: row.entityType ?? null,
      entityId: row.entityId ?? null,
      payload: row.payload ?? {},
      createdAt: sql`${row.at}::timestamptz`,
    })
    .returning({ id: auditLog.id });
  if (inserted === undefined) throw new Error('insertAudit: insert returned no row');
  return inserted.id;
}

const secondsBefore = (seconds: number): string =>
  new Date(Date.parse('2026-10-01T12:00:00.000Z') - seconds * 1000).toISOString();

describe('listAuditForAdmin — pages', () => {
  const db = withDatabase();
  const ids: string[] = [];

  beforeAll(async () => {
    // 51 rows newest first; the oldest has another action, so filtering leaves exactly 50
    for (let i = 0; i < ADMIN_PAGE_SIZE + 1; i += 1) {
      ids.push(
        await insertAudit(db(), {
          at: secondsBefore(i),
          action: i === ADMIN_PAGE_SIZE ? AuditAction.UserViewed : AuditAction.StaffLogout,
        }),
      );
    }
  });

  it('shows 50 of 51 rows, newest first, and hands the 50th id as the cursor', async () => {
    const first = await list(db());
    expect(first.rows.map((row) => row.id)).toEqual(ids.slice(0, ADMIN_PAGE_SIZE));
    expect(first.nextCursor).toBe(ids[ADMIN_PAGE_SIZE - 1]);
    const second = await list(db(), { cursor: first.nextCursor! });
    expect(second.rows.map((row) => row.id)).toEqual([ids[ADMIN_PAGE_SIZE]]);
    expect(second.nextCursor).toBeNull();
  });

  it('hands no cursor when exactly a page of rows matches', async () => {
    const page = await list(db(), { filters: { action: AuditAction.StaffLogout } });
    expect(page.rows).toHaveLength(ADMIN_PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
  });

  it('answers an id with no row with an empty page', async () => {
    expect(await list(db(), { cursor: randomUUID() })).toEqual({ rows: [], nextCursor: null });
  });
});

describe('listAuditForAdmin — ties on created_at', () => {
  const db = withDatabase();

  it('walks two rows sharing a created_at across a page boundary without a gap or a repeat', async () => {
    const at = '2026-10-01T12:00:00.000000Z';
    const [low, high] = [randomUUID(), randomUUID()].sort();
    await insertAudit(db(), { at: '2026-10-01T12:00:01.000000Z' });
    await insertAudit(db(), { at, id: low! });
    await insertAudit(db(), { at, id: high! });
    await insertAudit(db(), { at: '2026-10-01T11:59:59.000000Z' });
    const all = (await list(db())).rows.map((row) => row.id);
    expect(all.slice(1, 3)).toEqual([high, low]);

    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(db(), { limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      walked.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(walked).toEqual(all);
  });
});

describe('listAuditForAdmin — filters', () => {
  const db = withDatabase();
  const ENTITY = randomUUID();
  const OTHER_ENTITY = randomUUID();
  const ACTOR = randomUUID();
  const rows: Record<string, string> = {};

  beforeAll(async () => {
    const write = async (
      name: string,
      i: number,
      row: Omit<Parameters<typeof insertAudit>[1], 'at'>,
    ) => {
      rows[name] = await insertAudit(db(), { ...row, at: secondsBefore(i) });
    };
    await write('match', 0, {
      action: AuditAction.UserViewed,
      entityType: AuditEntityType.User,
      entityId: ENTITY,
      actorId: ACTOR,
    });
    await write('otherAction', 1, {
      action: AuditAction.UsersViewed,
      entityType: AuditEntityType.User,
      entityId: ENTITY,
      actorId: ACTOR,
    });
    await write('otherType', 2, {
      action: AuditAction.UserViewed,
      entityType: AuditEntityType.TradeIntent,
      entityId: ENTITY,
      actorId: ACTOR,
    });
    await write('otherEntity', 3, {
      action: AuditAction.UserViewed,
      entityType: AuditEntityType.User,
      entityId: OTHER_ENTITY,
      actorId: ACTOR,
    });
    await write('otherActor', 4, {
      action: AuditAction.UserViewed,
      entityType: AuditEntityType.User,
      entityId: ENTITY,
      actorId: 'cli',
    });
  });

  const idsOf = async (filters: AdminAuditFilters) =>
    new Set((await list(db(), { filters })).rows.map((row) => row.id));
  const named = (...names: string[]) => new Set(names.map((name) => rows[name]));

  it.each<[string, AdminAuditFilters, string[]]>([
    [
      'action',
      { action: AuditAction.UserViewed },
      ['match', 'otherType', 'otherEntity', 'otherActor'],
    ],
    [
      'entityType',
      { entityType: AuditEntityType.User },
      ['match', 'otherAction', 'otherEntity', 'otherActor'],
    ],
    ['entityId', { entityId: ENTITY }, ['match', 'otherAction', 'otherType', 'otherActor']],
    ['actorId', { actorId: ACTOR }, ['match', 'otherAction', 'otherType', 'otherEntity']],
  ])('filters by %s alone', async (_label, filters, expected) => {
    expect(await idsOf(filters)).toEqual(named(...expected));
  });

  it('intersects every filter', async () => {
    expect(
      await idsOf({
        action: AuditAction.UserViewed,
        entityType: AuditEntityType.User,
        entityId: ENTITY,
        actorId: ACTOR,
      }),
    ).toEqual(named('match'));
  });

  it("finds nothing for another staff member's id", async () => {
    expect(await idsOf({ actorId: randomUUID() })).toEqual(new Set());
  });
});

describe('listAuditForAdmin — UTC days', () => {
  const db = withDatabase();
  const ids: string[] = [];

  beforeAll(async () => {
    for (const at of [
      '2026-10-05T23:59:59.999999Z',
      '2026-10-06T00:00:00.000000Z',
      '2026-10-06T12:00:00.000000Z',
      '2026-10-06T23:59:59.999999Z',
      '2026-10-07T00:00:00.000000Z',
      '2026-10-07T00:00:00.000000Z',
    ]) {
      ids.push(await insertAudit(db(), { at }));
    }
  });

  // Compared as sets of ids: a mutant reading the date in the session's zone (Tokyo, +09) shifts
  // the window by nine hours and still matches three rows.
  const idsOf = async (filters: AdminAuditFilters) =>
    new Set((await list(db(), { filters, timeZone: 'Asia/Tokyo' })).rows.map((row) => row.id));
  const rowsAt = (...positions: number[]) => new Set(positions.map((n) => ids[n - 1]));

  it('takes from = to as one whole UTC day, to the microsecond, whatever the session zone', async () => {
    expect(await idsOf({ from: '2026-10-06', to: '2026-10-06' })).toEqual(rowsAt(2, 3, 4));
  });

  it('takes from alone as a lower bound', async () => {
    expect(await idsOf({ from: '2026-10-06' })).toEqual(rowsAt(2, 3, 4, 5, 6));
  });

  it('takes to alone as an inclusive upper bound', async () => {
    expect(await idsOf({ to: '2026-10-06' })).toEqual(rowsAt(1, 2, 3, 4));
  });
});

describe('listAuditForAdmin — actor login', () => {
  const db = withDatabase();

  it("names a staff actor by login, disabled or not, and leaves 'cli' and NULL unnamed", async () => {
    const disabled = await seedStaff(db(), { status: StaffStatus.Disabled });
    const byStaff = await insertAudit(db(), { at: secondsBefore(0), actorId: disabled.staffId });
    const byCli = await insertAudit(db(), {
      at: secondsBefore(1),
      actorType: AuditActorType.System,
      actorId: 'cli',
    });
    const byNobody = await insertAudit(db(), { at: secondsBefore(2), actorId: null });
    const logins = new Map((await list(db())).rows.map((row) => [row.id, row.actorLogin]));
    expect(logins).toEqual(
      new Map([
        [byStaff, disabled.login],
        [byCli, null],
        [byNobody, null],
      ]),
    );
  });
});

describe('listAuditForAdmin — payload preview', () => {
  const db = withDatabase();

  const previewOf = async (payload: Record<string, unknown>) => {
    const id = await insertAudit(db(), { at: '2026-10-01T12:00:00Z', payload });
    const row = (await list(db())).rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error('row not listed');
    return row;
  };

  it('cuts a long bot text payload to the preview length in characters and flags it', async () => {
    const row = await previewOf({ key: 'k', oldText: 'я'.repeat(20_000), newText: 'x' });
    expect([...row.payloadPreview]).toHaveLength(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS);
    expect(row.payloadTruncated).toBe(true);
  });

  it('leaves a payload of exactly the preview length whole and unflagged, and flags one more', async () => {
    // {"k": "…"} is 9 characters around the value
    const exact = await previewOf({ k: 'x'.repeat(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS - 9) });
    expect(exact.payloadPreview).toHaveLength(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS);
    expect(exact.payloadTruncated).toBe(false);
    const over = await previewOf({ k: 'x'.repeat(ADMIN_AUDIT_PAYLOAD_PREVIEW_CHARS - 8) });
    expect(over.payloadTruncated).toBe(true);
  });

  it('prints the jsonb as Postgres does: its key order, a space after : and ,', async () => {
    expect((await previewOf({})).payloadPreview).toBe('{}');
    const row = await previewOf({ ip: '1.2.3.4', err: { name: 'E' } });
    expect(row.payloadPreview).toBe('{"ip": "1.2.3.4", "err": {"name": "E"}}');
    expect(row.payloadTruncated).toBe(false);
  });
});

describe('toAdminAuditEntryView', () => {
  const db = withDatabase();

  it('builds exactly the wire keys, and the result passes the wire schema', async () => {
    const staffRow = await seedStaff(db());
    await insertAudit(db(), {
      at: secondsBefore(0),
      action: AuditAction.UserViewed,
      actorId: staffRow.staffId,
      entityType: AuditEntityType.User,
      entityId: randomUUID(),
      payload: { path: '/admin/users/:id' },
    });
    const [row] = (await list(db())).rows;
    const view = toAdminAuditEntryView(row!);
    expect(Object.keys(view)).toEqual(Object.keys(adminAuditEntryViewSchema.shape));
    expect(adminAuditEntryViewSchema.parse(view)).toEqual(view);
    expect(view.actorLogin).toBe(staffRow.login);
    expect(view.payload).toBe('{"path": "/admin/users/:id"}');
  });
});
