import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  TradeIntentFailureReason,
  UserStatus,
  tradingAccessResponseSchema,
} from '@binarius/shared';
import {
  createTempDatabase,
  intentRequest,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from './testing';
import { LINK_BONUS_TOKENS } from './link-bonus-ops';
import { confirmBrokerAccount } from './oauth-ops';
import { TokenLedgerKind, tokenLedger, users } from './schema/index';
import { readTokenBalance, toTradingAccessView } from './token-balance-ops';
import { TOKENS_PER_INTENT, createTradeIntent, rejectIntent } from './trade-intent-ops';

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

// Credits the way a ledger writer must: the row and the cache in one transaction. Users are
// seeded with balance 0 and credited through here, so cache = sum(ledger) holds from the start.
async function creditTokens(userId: string, tokens: bigint): Promise<void> {
  await tmp.db.transaction(async (tx) => {
    await tx.insert(tokenLedger).values({
      userId,
      kind: TokenLedgerKind.Adjustment,
      balanceDelta: tokens,
      note: 'test credit',
    });
    await tx
      .update(users)
      .set({ tokenBalance: sql`${users.tokenBalance} + ${tokens}` })
      .where(eq(users.id, userId));
  });
}

async function creditedUser(tokens: bigint, status: UserStatus = UserStatus.Active) {
  const user = await seedUser(tmp.db, { balance: 0n, status });
  await creditTokens(user.userId, tokens);
  return user;
}

async function ledgerSums(userId: string): Promise<{ balance: bigint; reserved: bigint }> {
  const [row] = await tmp.db
    .select({
      balance: sql<string>`coalesce(sum(${tokenLedger.balanceDelta}), 0)`,
      reserved: sql<string>`coalesce(sum(${tokenLedger.reservedDelta}), 0)`,
    })
    .from(tokenLedger)
    .where(eq(tokenLedger.userId, userId));
  return { balance: BigInt(row!.balance), reserved: BigInt(row!.reserved) };
}

const read = (user: { telegramUserId: string }) =>
  readTokenBalance(tmp.db, BigInt(user.telegramUserId));

async function expectCacheEqualsLedger(user: { userId: string; telegramUserId: string }) {
  const snapshot = await read(user);
  const sums = await ledgerSums(user.userId);
  expect({ balance: snapshot?.balance, reserved: snapshot?.reserved }).toEqual(sums);
}

describe('readTokenBalance', () => {
  it('answers undefined for a Telegram id with no users row', async () => {
    expect(await readTokenBalance(tmp.db, 999_999_999n)).toBeUndefined();
  });

  it('reads the cache of a credited user, equal to the ledger', async () => {
    const user = await creditedUser(7n);
    const snapshot = await read(user);
    expect(snapshot).toEqual({ status: UserStatus.Active, balance: 7n, reserved: 0n });
    expect(toTradingAccessView(snapshot!)).toEqual({
      status: UserStatus.Active,
      tokens: { balance: '7', reserved: '0', available: '7' },
    });
    await expectCacheEqualsLedger(user);
  });

  it('follows a reserve and its release, equal to the ledger at both points', async () => {
    const user = await creditedUser(7n);
    const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId);
    const { intent } = await createTradeIntent(
      tmp.db,
      intentRequest(user.telegramUserId, { brokerAccountId }),
    );

    const reserved = await read(user);
    expect(reserved).toMatchObject({ balance: 7n, reserved: TOKENS_PER_INTENT });
    expect(toTradingAccessView(reserved!).tokens).toEqual({
      balance: '7',
      reserved: '1',
      available: '6',
    });
    await expectCacheEqualsLedger(user);

    const rejected = await tmp.db.transaction((tx) =>
      rejectIntent(tx, {
        id: intent.id,
        from: 'queued',
        reason: TradeIntentFailureReason.Expired,
      }),
    );
    expect(rejected?.status).toBe('rejected');
    expect(await read(user)).toMatchObject({ balance: 7n, reserved: 0n });
    await expectCacheEqualsLedger(user);
  });

  it('follows the starter pack granted through confirmBrokerAccount', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const accountId = await seedBrokerAccount(tmp.db, user.userId, {
      status: BrokerAccountStatus.Pending,
      isPartnerClient: true,
    });
    const result = await confirmBrokerAccount(tmp.db, {
      telegramUserId: BigInt(user.telegramUserId),
      accountId,
    });
    expect(result).toMatchObject({ ok: true, grant: { granted: true } });

    expect(await read(user)).toMatchObject({ balance: LINK_BONUS_TOKENS, reserved: 0n });
    await expectCacheEqualsLedger(user);
  });

  it('returns a blocked user with their balance', async () => {
    const user = await creditedUser(3n, UserStatus.Blocked);
    expect(await read(user)).toEqual({ status: UserStatus.Blocked, balance: 3n, reserved: 0n });
    await expectCacheEqualsLedger(user);
  });

  it('a burst of reserves ends at 4, equal to the ledger, and every snapshot parses', async () => {
    const user = await creditedUser(10n);
    const accounts = await Promise.all(
      [1, 2, 3, 4].map(() => seedBrokerAccount(tmp.db, user.userId)),
    );
    let settled = false;
    const creates = Promise.all(
      accounts.map((brokerAccountId) =>
        createTradeIntent(tmp.db, intentRequest(user.telegramUserId, { brokerAccountId })),
      ),
    ).finally(() => (settled = true));
    // keeps reading until the last reserve committed, then once more after it
    const snapshots: Awaited<ReturnType<typeof read>>[] = [];
    while (!settled || snapshots.length < 12) {
      snapshots.push(...(await Promise.all([read(user), read(user), read(user)])));
    }
    const created = await creates;
    snapshots.push(await read(user));

    expect(created.every((result) => result.created)).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ balance: 10n, reserved: 4n });
    for (const snapshot of snapshots) {
      expect(snapshot!.balance).toBe(10n);
      expect(snapshot!.reserved >= 0n && snapshot!.reserved <= 4n).toBe(true);
      expect(tradingAccessResponseSchema.safeParse(toTradingAccessView(snapshot!)).success).toBe(
        true,
      );
    }
    await expectCacheEqualsLedger(user);
  });

  it('neither shows nor waits for a reserve still uncommitted', async () => {
    // no ledger row on purpose: this user only probes visibility, never the sums
    const user = await creditedUser(5n);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markUpdated!: () => void;
    const updated = new Promise<void>((resolve) => (markUpdated = resolve));

    const holder = tmp.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ tokenReserved: sql`${users.tokenReserved} + 1` })
        .where(eq(users.id, user.userId));
      markUpdated();
      await gate;
    });
    try {
      // the holder only settles after release(), so here it can win only by rejecting
      await Promise.race([updated, holder]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome;
      try {
        outcome = await Promise.race([
          read(user),
          new Promise<'waited'>((resolve) => (timer = setTimeout(() => resolve('waited'), 1_000))),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(outcome).toEqual({ status: UserStatus.Active, balance: 5n, reserved: 0n });
    } finally {
      release();
      await holder;
    }
    expect(await read(user)).toMatchObject({ reserved: 1n });
  });
});

describe('toTradingAccessView', () => {
  it('refuses a reserve above the balance instead of a signed count', () => {
    expect(() =>
      toTradingAccessView({ status: UserStatus.Active, balance: 1n, reserved: 2n }),
    ).toThrow('token reserve exceeds balance');
  });
});
