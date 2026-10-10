import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PAGE_SIZE,
  adminDepositViewSchema,
  adminLedgerEntrySchema,
  DepositEventStatus,
  PostbackSource,
  TokenLedgerKind,
  TokenLedgerRefType,
  type DecimalString,
} from '@binarius/shared';
import {
  listDepositsForAdmin,
  listLedgerForAdmin,
  toAdminDepositView,
  toAdminLedgerEntry,
  type AdminDepositFilters,
  type AdminLedgerFilters,
} from './admin-ledger-ops';
import type { Db } from './client';
import { depositEvents, tokenLedger } from './schema/index';
import {
  createTempDatabase,
  seedQueuedIntent,
  seedUser,
  seedUserWithAccount,
  type SeededAccount,
  type TempDatabase,
} from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}
const testUrl = baseUrl;

// each describe owns a database: the page and filter oracles need to know every row
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
  options: { filters?: AdminLedgerFilters; cursor?: string; limit?: number } = {},
) =>
  db.transaction((tx) =>
    listLedgerForAdmin(tx, { filters: {}, limit: ADMIN_PAGE_SIZE, ...options }),
  );

// Written directly, bypassing adjustTokens: these suites test the reads, and a bonus naming
// nothing still has no writer (#13); neither needs a reference. created_at is explicit — two
// inserts in one transaction would share now(). These rows do not move the users cache; the
// databases are temporary.
async function insertEntry(
  db: Db,
  row: {
    userId: string;
    kind: typeof TokenLedgerKind.Adjustment | typeof TokenLedgerKind.Bonus;
    balanceDelta?: bigint;
    note?: string | null;
    secondsAgo: number;
  },
): Promise<string> {
  const [inserted] = await db
    .insert(tokenLedger)
    .values({
      userId: row.userId,
      kind: row.kind,
      balanceDelta: row.balanceDelta ?? 1n,
      reservedDelta: 0n,
      // token_ledger_adjustment_note_check (#246): an adjustment always carries its reason
      note: row.note ?? (row.kind === TokenLedgerKind.Adjustment ? 'seed' : null),
      createdAt: sql`'2026-10-01T12:00:00.000000Z'::timestamptz - make_interval(secs => ${row.secondsAgo})`,
    })
    .returning({ id: tokenLedger.id });
  if (inserted === undefined) throw new Error('insertEntry: insert returned no row');
  return inserted.id;
}

describe('listLedgerForAdmin — pages', () => {
  const db = withDatabase();
  const ids: string[] = [];

  beforeAll(async () => {
    const { userId } = await seedUser(db());
    // newest first: ids[0] is the newest
    for (let i = 0; i < ADMIN_PAGE_SIZE + 1; i += 1) {
      ids.push(
        await insertEntry(db(), { userId, kind: TokenLedgerKind.Adjustment, secondsAgo: i + 1 }),
      );
    }
  });

  it('shows ADMIN_PAGE_SIZE rows and a cursor at the last one shown when one more exists', async () => {
    const page = await list(db());
    expect(page.rows.map((r) => r.id)).toEqual(ids.slice(0, ADMIN_PAGE_SIZE));
    expect(page.nextCursor).toBe(ids[ADMIN_PAGE_SIZE - 1]);
    const next = await list(db(), { cursor: page.nextCursor ?? undefined });
    expect(next.rows.map((r) => r.id)).toEqual([ids[ADMIN_PAGE_SIZE]]);
    expect(next.nextCursor).toBeNull();
  });

  it('gives no cursor when exactly ADMIN_PAGE_SIZE rows remain', async () => {
    const page = await list(db(), { cursor: ids[0] });
    expect(page.rows).toHaveLength(ADMIN_PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
  });

  it('answers an id with no row with an empty page, not an error', async () => {
    const page = await list(db(), { cursor: '00000000-0000-4000-8000-00000000dead' });
    expect(page).toEqual({ rows: [], nextCursor: null });
  });
});

describe('listLedgerForAdmin — equal created_at across a page boundary', () => {
  const db = withDatabase();

  it('breaks the tie by id, with no row skipped or repeated', async () => {
    const { userId } = await seedUser(db());
    const seeded: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      seeded.push(
        await insertEntry(db(), { userId, kind: TokenLedgerKind.Adjustment, secondsAgo: 0 }),
      );
    }
    const expected = [...seeded].sort().reverse();
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page = await list(db(), { cursor, limit: 1 });
      walked.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(walked).toEqual(expected);
    expect(cursor).toBeUndefined();
  });
});

describe('listLedgerForAdmin — filters', () => {
  const db = withDatabase();
  let userU = '';
  let userV = '';
  const uAdjustments: string[] = [];
  const uBonuses: string[] = [];
  const vAdjustments: string[] = [];

  beforeAll(async () => {
    userU = (await seedUser(db())).userId;
    userV = (await seedUser(db())).userId;
    let age = 0;
    for (let i = 0; i < 25; i += 1) {
      uAdjustments.push(
        await insertEntry(db(), {
          userId: userU,
          kind: TokenLedgerKind.Adjustment,
          secondsAgo: (age += 1),
        }),
      );
    }
    for (let i = 0; i < 2; i += 1) {
      uBonuses.push(
        await insertEntry(db(), {
          userId: userU,
          kind: TokenLedgerKind.Bonus,
          secondsAgo: (age += 1),
        }),
      );
      vAdjustments.push(
        await insertEntry(db(), {
          userId: userV,
          kind: TokenLedgerKind.Adjustment,
          secondsAgo: (age += 1),
        }),
      );
    }
  });

  it("keeps only the user's own rows", async () => {
    const page = await list(db(), { filters: { userId: userV } });
    expect(page.rows.map((r) => r.id)).toEqual(vAdjustments);
  });

  it('keeps only the kind asked for', async () => {
    const page = await list(db(), { filters: { kind: TokenLedgerKind.Bonus } });
    expect(page.rows.map((r) => r.id)).toEqual(uBonuses);
  });

  it('intersects the two filters', async () => {
    const page = await list(db(), {
      filters: { userId: userV, kind: TokenLedgerKind.Bonus },
    });
    expect(page.rows).toEqual([]);
    const own = await list(db(), {
      filters: { userId: userU, kind: TokenLedgerKind.Adjustment },
    });
    expect(own.rows.map((r) => r.id)).toEqual(uAdjustments);
  });

  it('stops at the limit it is given', async () => {
    const page = await list(db(), { filters: { userId: userU }, limit: 20 });
    expect(page.rows.map((r) => r.id)).toEqual(uAdjustments.slice(0, 20));
    expect(page.nextCursor).toBe(uAdjustments[19]);
  });
});

describe('toAdminLedgerEntry', () => {
  const db = withDatabase();

  it('projects a row to exactly the wire keys, deltas as signed bigint strings', async () => {
    const other = await seedUser(db());
    const owner = await seedUser(db());
    const adjustment = await insertEntry(db(), {
      userId: owner.userId,
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: -3n,
      note: 'seed <script>',
      secondsAgo: 1,
    });
    await insertEntry(db(), { userId: other.userId, kind: TokenLedgerKind.Bonus, secondsAgo: 2 });
    const page = await list(db());
    const row = page.rows.find((r) => r.id === adjustment);
    if (row === undefined) throw new Error('row missing');
    const entry = toAdminLedgerEntry(row);
    expect(Object.keys(entry)).toEqual(Object.keys(adminLedgerEntrySchema.shape));
    expect(entry).toMatchObject({
      userId: owner.userId,
      telegramUserId: owner.telegramUserId,
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: '-3',
      reservedDelta: '0',
      intentId: null,
      depositEventId: null,
      brokerAccountId: null,
      refType: null,
      refId: null,
      note: 'seed <script>',
      createdAt: '2026-10-01T11:59:59.000Z',
    });
    expect(adminLedgerEntrySchema.safeParse(entry).success).toBe(true);
  });

  // past 2^53 a JS number would round it; the bigint's own string does not
  it('prints a delta past Number.MAX_SAFE_INTEGER digit for digit', async () => {
    const { userId } = await seedUser(db());
    await insertEntry(db(), {
      userId,
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: -9_007_199_254_740_993n,
      secondsAgo: 3,
    });
    const page = await list(db(), { filters: { userId } });
    expect(page.rows.map(toAdminLedgerEntry).map((e) => e.balanceDelta)).toEqual([
      '-9007199254740993',
    ]);
  });

  it("carries a reserve's intent and a manual reference as they are stored", async () => {
    const seeded = await seedQueuedIntent(db());
    const refId = '00000000-0000-4000-8000-0000000000ab';
    const [manual] = await db()
      .insert(tokenLedger)
      .values({
        userId: seeded.userId,
        kind: TokenLedgerKind.Adjustment,
        balanceDelta: 2n,
        reservedDelta: 0n,
        refType: TokenLedgerRefType.Manual,
        refId,
        note: 'seed',
      })
      .returning({ id: tokenLedger.id });
    const page = await list(db(), { filters: { userId: seeded.userId } });
    const entries = page.rows.map(toAdminLedgerEntry);
    const reserve = entries.find((e) => e.kind === TokenLedgerKind.Reserve);
    expect(reserve).toMatchObject({
      intentId: seeded.intent.id,
      balanceDelta: '0',
      reservedDelta: '1',
    });
    expect(entries.find((e) => e.id === manual?.id)).toMatchObject({
      refType: TokenLedgerRefType.Manual,
      refId,
    });
  });
});

// --- Deposits (#341) ----------------------------------------------------------------------------

const listDeposits = (
  db: Db,
  options: { filters?: AdminDepositFilters; cursor?: string; limit?: number } = {},
) =>
  db.transaction((tx) =>
    listDepositsForAdmin(tx, { filters: {}, limit: ADMIN_PAGE_SIZE, ...options }),
  );

let postbackSeq = 0;

// Written directly rather than through recordPostback (#141): a row's status, processed_at and
// created_at here are the test's choice, and nothing writes a credited deposit until #386.
// The trader id of an attributed row is its account's, as deposit_events_account_trader_fk
// demands.
async function insertDeposit(
  db: Db,
  row: {
    userId?: string;
    brokerAccountId?: string;
    status?: DepositEventStatus;
    amount?: string;
    processedAt?: Date;
    secondsAgo: number;
  },
): Promise<string> {
  const [inserted] = await db
    .insert(depositEvents)
    .values({
      userId: row.userId ?? null,
      brokerAccountId: row.brokerAccountId ?? null,
      source: PostbackSource.Binodex,
      brokerUserId:
        row.brokerAccountId === undefined
          ? `trader-${++postbackSeq}`
          : sql`(select broker_user_id from broker_accounts where id = ${row.brokerAccountId})`,
      paymentId: `pay-${++postbackSeq}`,
      amount: (row.amount ?? '1') as DecimalString,
      status: row.status ?? DepositEventStatus.Received,
      processedAt: row.processedAt ?? null,
      createdAt: sql`'2026-10-01T12:00:00.000000Z'::timestamptz - make_interval(secs => ${row.secondsAgo})`,
    })
    .returning({ id: depositEvents.id });
  if (inserted === undefined) throw new Error('insertDeposit: insert returned no row');
  return inserted.id;
}

describe('listDepositsForAdmin — pages', () => {
  const db = withDatabase();
  const ids: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < ADMIN_PAGE_SIZE + 1; i += 1) {
      ids.push(await insertDeposit(db(), { secondsAgo: i + 1 }));
    }
  });

  it('shows ADMIN_PAGE_SIZE rows and a cursor at the last one shown when one more exists', async () => {
    const page = await listDeposits(db());
    expect(page.rows.map((r) => r.id)).toEqual(ids.slice(0, ADMIN_PAGE_SIZE));
    expect(page.nextCursor).toBe(ids[ADMIN_PAGE_SIZE - 1]);
    const next = await listDeposits(db(), { cursor: page.nextCursor ?? undefined });
    expect(next.rows.map((r) => r.id)).toEqual([ids[ADMIN_PAGE_SIZE]]);
    expect(next.nextCursor).toBeNull();
  });

  it('gives no cursor when exactly ADMIN_PAGE_SIZE rows remain', async () => {
    const page = await listDeposits(db(), { cursor: ids[0] });
    expect(page.rows).toHaveLength(ADMIN_PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
  });

  it('answers an id with no row with an empty page, not an error', async () => {
    const page = await listDeposits(db(), { cursor: '00000000-0000-4000-8000-00000000dead' });
    expect(page).toEqual({ rows: [], nextCursor: null });
  });
});

describe('listDepositsForAdmin — equal created_at across a page boundary', () => {
  const db = withDatabase();

  it('breaks the tie by id, with no row skipped or repeated', async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 3; i += 1) seeded.push(await insertDeposit(db(), { secondsAgo: 0 }));
    const expected = [...seeded].sort().reverse();
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page = await listDeposits(db(), { cursor, limit: 1 });
      walked.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(walked).toEqual(expected);
    expect(cursor).toBeUndefined();
  });
});

describe('listDepositsForAdmin — filters', () => {
  const db = withDatabase();
  let owner: SeededAccount;
  let other: SeededAccount;
  let ownCredited = '';
  let ownReceived = '';
  let otherCredited = '';
  let unowned = '';
  let accountOnly = '';

  beforeAll(async () => {
    owner = await seedUserWithAccount(db());
    other = await seedUserWithAccount(db());
    const own = { userId: owner.userId, brokerAccountId: owner.brokerAccountId };
    ownCredited = await insertDeposit(db(), {
      ...own,
      status: DepositEventStatus.Credited,
      secondsAgo: 1,
    });
    ownReceived = await insertDeposit(db(), { ...own, secondsAgo: 2 });
    otherCredited = await insertDeposit(db(), {
      userId: other.userId,
      brokerAccountId: other.brokerAccountId,
      status: DepositEventStatus.Credited,
      secondsAgo: 3,
    });
    unowned = await insertDeposit(db(), { secondsAgo: 4 });
    // the owner's account but no user: the owner of a deposit is user_id alone
    accountOnly = await insertDeposit(db(), {
      brokerAccountId: owner.brokerAccountId,
      secondsAgo: 5,
    });
  });

  it('shows every row without a filter, with the owner joined by user_id', async () => {
    const page = await listDeposits(db());
    expect(page.rows.map((r) => r.id)).toEqual([
      ownCredited,
      ownReceived,
      otherCredited,
      unowned,
      accountOnly,
    ]);
    expect(page.rows.map((r) => r.telegramUserId?.toString() ?? null)).toEqual([
      owner.telegramUserId,
      owner.telegramUserId,
      other.telegramUserId,
      null,
      null,
    ]);
  });

  it("keeps only the user's own rows: neither an unowned one nor one naming only the account", async () => {
    const page = await listDeposits(db(), { filters: { userId: owner.userId } });
    expect(page.rows.map((r) => r.id)).toEqual([ownCredited, ownReceived]);
  });

  it('keeps only the status asked for', async () => {
    const page = await listDeposits(db(), { filters: { status: DepositEventStatus.Credited } });
    expect(page.rows.map((r) => r.id)).toEqual([ownCredited, otherCredited]);
  });

  it('intersects the two filters', async () => {
    const page = await listDeposits(db(), {
      filters: { userId: owner.userId, status: DepositEventStatus.Credited },
    });
    expect(page.rows.map((r) => r.id)).toEqual([ownCredited]);
  });

  it('stops at the limit it is given', async () => {
    const { userId, brokerAccountId } = await seedUserWithAccount(db());
    const rows: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      rows.push(await insertDeposit(db(), { userId, brokerAccountId, secondsAgo: 10 + i }));
    }
    const page = await listDeposits(db(), { filters: { userId }, limit: 20 });
    expect(page.rows.map((r) => r.id)).toEqual(rows.slice(0, 20));
    expect(page.nextCursor).toBe(rows[19]);
  });
});

describe('toAdminDepositView', () => {
  const db = withDatabase();

  it('projects a row to exactly the wire keys', async () => {
    const { userId, brokerAccountId, telegramUserId } = await seedUserWithAccount(db());
    const id = await insertDeposit(db(), {
      userId,
      brokerAccountId,
      status: DepositEventStatus.Credited,
      amount: '10.5',
      processedAt: new Date('2026-10-01T11:00:00.000Z'),
      secondsAgo: 1,
    });
    const page = await listDeposits(db());
    const row = page.rows.find((r) => r.id === id);
    if (row === undefined) throw new Error('row missing');
    expect(Object.keys(row)).toEqual([
      'id',
      'userId',
      'brokerAccountId',
      'brokerUserId',
      'paymentId',
      'amount',
      'currency',
      'status',
      'processedAt',
      'createdAt',
      'telegramUserId',
    ]);
    const view = toAdminDepositView(row);
    expect(Object.keys(view)).toEqual(Object.keys(adminDepositViewSchema.shape));
    expect(view).toMatchObject({
      id,
      userId,
      telegramUserId,
      brokerAccountId,
      amount: '10.50000000',
      status: DepositEventStatus.Credited,
      processedAt: '2026-10-01T11:00:00.000Z',
      createdAt: '2026-10-01T11:59:59.000Z',
    });
    expect(adminDepositViewSchema.safeParse(view).success).toBe(true);
  });

  it('prints the nullable columns of an unowned row as null', async () => {
    const id = await insertDeposit(db(), { secondsAgo: 2 });
    const page = await listDeposits(db());
    const row = page.rows.find((r) => r.id === id);
    if (row === undefined) throw new Error('row missing');
    const view = toAdminDepositView(row);
    expect(view).toMatchObject({
      userId: null,
      telegramUserId: null,
      brokerAccountId: null,
      currency: null,
      status: DepositEventStatus.Received,
      processedAt: null,
    });
    expect(adminDepositViewSchema.safeParse(view).success).toBe(true);
  });
});
