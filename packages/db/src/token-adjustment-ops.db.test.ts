import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenLedgerKind, UserStatus } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  createTempDatabase,
  intentRequest,
  lockWaiters,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from './testing';
import { tokenLedger, users } from './schema/index';
import {
  adjustTokens,
  InvalidTokenAdjustment,
  type AdjustTokensInput,
} from './token-adjustment-ops';
import { createTradeIntent } from './trade-intent-ops';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const NOTE = 'Компенсация';

const adjust = (input: Omit<AdjustTokensInput, 'note'> & { note?: string }) =>
  tmp.db.transaction((tx) => adjustTokens(tx, { note: NOTE, ...input }));

// Seeded at 0 and credited through the writer, so cache = sum(ledger) holds from the start.
async function userWith(balance: bigint, status: UserStatus = UserStatus.Active) {
  const user = await seedUser(tmp.db, { balance: 0n, status });
  if (balance > 0n) {
    const opened = await adjust({ userId: user.userId, delta: balance, note: 'opening' });
    expect(opened.outcome).toBe('adjusted');
  }
  return user;
}

// one reserved token per intent; each needs its own account (one non-terminal intent per account)
async function reserve(user: { userId: string; telegramUserId: string }, intents: number) {
  for (let i = 0; i < intents; i += 1) {
    const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId);
    const result = await createTradeIntent(
      tmp.db,
      intentRequest(user.telegramUserId, { brokerAccountId }),
    );
    expect(result.created).toBe(true);
  }
}

async function cache(userId: string) {
  const [row] = await tmp.db
    .select({ balance: users.tokenBalance, reserved: users.tokenReserved })
    .from(users)
    .where(eq(users.id, userId));
  return row!;
}

async function ledgerSums(userId: string) {
  const [row] = await tmp.db
    .select({
      rows: sql<number>`count(*)::int`,
      balance: sql<string>`coalesce(sum(${tokenLedger.balanceDelta}), 0)`,
      reserved: sql<string>`coalesce(sum(${tokenLedger.reservedDelta}), 0)`,
    })
    .from(tokenLedger)
    .where(eq(tokenLedger.userId, userId));
  return { rows: row!.rows, balance: BigInt(row!.balance), reserved: BigInt(row!.reserved) };
}

async function expectCacheEqualsLedger(userId: string) {
  const { balance, reserved } = await ledgerSums(userId);
  expect(await cache(userId)).toEqual({ balance, reserved });
}

// An hour back, by raw SQL ($onUpdate is drizzle's): a write that touches the row moves it to
// now, and the comparison is the database's, at its own resolution.
const ageUpdatedAt = (userId: string) =>
  tmp.db.execute(sql`update users set updated_at = now() - interval '1 hour' where id = ${userId}`);
async function touchedRecently(userId: string): Promise<boolean> {
  const { rows } = await tmp.db.execute<{ recent: boolean }>(
    sql`select updated_at > now() - interval '1 minute' as recent from users where id = ${userId}`,
  );
  return rows[0]!.recent;
}

describe('adjustTokens', () => {
  it('A1 credits: one adjustment row naming nothing, and the cache moved with it', async () => {
    const user = await userWith(5n);
    const result = await adjust({ userId: user.userId, delta: 50n, expectedBalance: 5n });
    if (result.outcome !== 'adjusted') throw new Error(`unexpected ${result.outcome}`);
    expect(result).toMatchObject({ balanceBefore: 5n, balanceAfter: 55n, reserved: 0n });
    expect(result.entry).toMatchObject({
      userId: user.userId,
      telegramUserId: BigInt(user.telegramUserId),
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: 50n,
      reservedDelta: 0n,
      note: NOTE,
      intentId: null,
      depositEventId: null,
      brokerAccountId: null,
      refType: null,
      refId: null,
    });
    expect(await cache(user.userId)).toEqual({ balance: 55n, reserved: 0n });
    await expectCacheEqualsLedger(user.userId);
  });

  it('A2 debits below the balance and above the reserve', async () => {
    const user = await userWith(5n);
    await reserve(user, 1);
    const result = await adjust({ userId: user.userId, delta: -3n, expectedBalance: 5n });
    expect(result).toMatchObject({ outcome: 'adjusted', balanceAfter: 2n, reserved: 1n });
    expect(await cache(user.userId)).toEqual({ balance: 2n, reserved: 1n });
    await expectCacheEqualsLedger(user.userId);
  });

  it('A3 debits exactly down to the reserve, leaving nothing available', async () => {
    const user = await userWith(5n);
    await reserve(user, 2);
    const result = await adjust({ userId: user.userId, delta: -3n });
    expect(result).toMatchObject({ outcome: 'adjusted', balanceAfter: 2n, reserved: 2n });
    await expectCacheEqualsLedger(user.userId);
  });

  it('A4 refuses a debit below the reserve and writes nothing', async () => {
    const user = await userWith(5n);
    await reserve(user, 2);
    await ageUpdatedAt(user.userId);
    const before = await ledgerSums(user.userId);
    const result = await adjust({ userId: user.userId, delta: -4n, expectedBalance: 5n });
    expect(result).toEqual({ outcome: 'insufficient_available', balance: 5n, reserved: 2n });
    expect(await ledgerSums(user.userId)).toEqual(before);
    expect(await cache(user.userId)).toEqual({ balance: 5n, reserved: 2n });
    expect(await touchedRecently(user.userId)).toBe(false);
  });

  it('A5 refuses by a balance that moved, and writes when no balance is expected', async () => {
    const user = await userWith(5n);
    const before = await ledgerSums(user.userId);
    expect(await adjust({ userId: user.userId, delta: 1n, expectedBalance: 4n })).toEqual({
      outcome: 'balance_changed',
      balance: 5n,
      reserved: 0n,
    });
    // a stale balance wins over what is available: the fresh numbers come first
    expect(await adjust({ userId: user.userId, delta: -10n, expectedBalance: 4n })).toEqual({
      outcome: 'balance_changed',
      balance: 5n,
      reserved: 0n,
    });
    expect(await ledgerSums(user.userId)).toEqual(before);
    expect(await adjust({ userId: user.userId, delta: 1n })).toMatchObject({
      outcome: 'adjusted',
      balanceAfter: 6n,
    });
  });

  it('A6 answers not_found for a user that does not exist', async () => {
    expect(await adjust({ userId: '00000000-0000-4000-8000-0000000000ff', delta: 1n })).toEqual({
      outcome: 'not_found',
    });
  });

  it('A7 adjusts a blocked user', async () => {
    const user = await userWith(0n, UserStatus.Blocked);
    expect(await adjust({ userId: user.userId, delta: 3n })).toMatchObject({
      outcome: 'adjusted',
      balanceAfter: 3n,
    });
    await expectCacheEqualsLedger(user.userId);
  });

  it.each([
    ['a zero delta', 0n, NOTE],
    ['a delta over the limit', 1001n, NOTE],
    ['a debit over the limit', -1001n, NOTE],
    ['an empty note', 1n, ''],
    ['a blank note', 1n, ' '],
    ['a note of 513 code points', 1n, 'ж'.repeat(513)],
    ['a note with a NUL', 1n, 'a\x00b'],
  ])(
    'A8 throws InvalidTokenAdjustment on %s before writing anything',
    async (_label, delta, note) => {
      const user = await userWith(5n);
      await ageUpdatedAt(user.userId);
      const before = await ledgerSums(user.userId);
      await expect(adjust({ userId: user.userId, delta, note })).rejects.toBeInstanceOf(
        InvalidTokenAdjustment,
      );
      expect(await ledgerSums(user.userId)).toEqual(before);
      expect(await touchedRecently(user.userId)).toBe(false);
    },
  );

  it('A9 waits on a held users row and checks the reserve that row committed', async () => {
    const user = await userWith(5n);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => (markHeld = resolve));
    // A reserve committed by hand, without its ledger row: this user only probes the lock
    const holder = tmp.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ tokenReserved: sql`${users.tokenReserved} + 4` })
        .where(eq(users.id, user.userId));
      markHeld();
      await gate;
    });
    let adjusting: Promise<unknown> | undefined;
    try {
      await Promise.race([held, holder]);
      adjusting = adjust({ userId: user.userId, delta: -2n, expectedBalance: 5n });
      await until('the adjustment to queue behind the held users row', async () => {
        return (await lockWaiters(tmp.db)) === 1;
      });
    } finally {
      release();
      await holder;
    }
    expect(await adjusting).toEqual({
      outcome: 'insufficient_available',
      balance: 5n,
      reserved: 4n,
    });
  });

  it('A10 a burst of reserves and adjustments ends equal to the ledger', async () => {
    const user = await userWith(10n);
    const accounts = await Promise.all(
      [1, 2, 3, 4].map(() => seedBrokerAccount(tmp.db, user.userId)),
    );
    const results = await Promise.all([
      ...accounts.map((brokerAccountId) =>
        createTradeIntent(tmp.db, intentRequest(user.telegramUserId, { brokerAccountId })),
      ),
      adjust({ userId: user.userId, delta: 3n }),
      adjust({ userId: user.userId, delta: -1n }),
    ]);
    expect(results.slice(0, 4).every((r) => 'created' in r && r.created)).toBe(true);
    expect(results.slice(4).map((r) => 'outcome' in r && r.outcome)).toEqual([
      'adjusted',
      'adjusted',
    ]);
    expect(await cache(user.userId)).toEqual({ balance: 12n, reserved: 4n });
    await expectCacheEqualsLedger(user.userId);
  });

  it('A11 moves users.updated_at, the "active now" proxy of the overview', async () => {
    const user = await userWith(5n);
    await ageUpdatedAt(user.userId);
    expect(await touchedRecently(user.userId)).toBe(false);
    expect((await adjust({ userId: user.userId, delta: 1n })).outcome).toBe('adjusted');
    expect(await touchedRecently(user.userId)).toBe(true);
  });
});
