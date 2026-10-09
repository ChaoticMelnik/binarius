import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '@binarius/shared/testing';
import type { Db } from './client';
import { brokerSessionLeases } from './schema/index';
import { acquireSessionLease, releaseSessionLeases, renewSessionLeases } from './session-lease-ops';
import { createTempDatabase, lockWaiters, seedUserWithAccount, type TempDatabase } from './testing';

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
afterAll(async () => {
  await tmp.drop();
});

const TTL = 30_000;
const account = async () => (await seedUserWithAccount(tmp.db)).brokerAccountId;
const rowOf = async (accountId: string) =>
  (
    await tmp.db
      .select()
      .from(brokerSessionLeases)
      .where(eq(brokerSessionLeases.brokerAccountId, accountId))
  )[0];
const acquire = (accountId: string, ownerId: string) =>
  acquireSessionLease(tmp.db, { accountId, ownerId, ttlMs: TTL });
// moves the row's expiry by the database clock, keeping it after acquired_at
const expireIn = (accountId: string, by: string) =>
  tmp.db.execute(
    sql`update broker_session_leases
           set acquired_at = now() + ${by}::interval - interval '1 minute',
               expires_at = now() + ${by}::interval
         where broker_account_id = ${accountId}`,
  );

describe('acquireSessionLease (#93)', () => {
  it('A1 takes a free account, for the TTL by the database clock', async () => {
    const accountId = await account();
    const owner = randomUUID();
    expect(await acquire(accountId, owner)).toBe(true);
    const row = await rowOf(accountId);
    expect(row?.ownerId).toBe(owner);
    expect(row!.expiresAt.getTime() - row!.acquiredAt.getTime()).toBe(TTL);
  });

  it('A2 moves its own live lease', async () => {
    const accountId = await account();
    const owner = randomUUID();
    await acquire(accountId, owner);
    await expireIn(accountId, '5 seconds');
    const before = await rowOf(accountId);
    expect(await acquire(accountId, owner)).toBe(true);
    expect((await rowOf(accountId))!.expiresAt.getTime()).toBeGreaterThan(
      before!.expiresAt.getTime(),
    );
  });

  it('A3 refuses another owner’s live lease and leaves the row as it was', async () => {
    const accountId = await account();
    const owner = randomUUID();
    await acquire(accountId, owner);
    const before = await rowOf(accountId);
    expect(await acquire(accountId, randomUUID())).toBe(false);
    expect(await rowOf(accountId)).toEqual(before);
  });

  it('A4 takes a lapsed foreign lease, at the boundary too, and refuses one a second from lapsing', async () => {
    const lapsed = await account();
    await acquire(lapsed, randomUUID());
    await expireIn(lapsed, '-1 millisecond');
    const taker = randomUUID();
    expect(await acquire(lapsed, taker)).toBe(true);
    expect((await rowOf(lapsed))?.ownerId).toBe(taker);

    const live = await account();
    await acquire(live, randomUUID());
    await expireIn(live, '1 second');
    expect(await acquire(live, randomUUID())).toBe(false);

    // now() is fixed inside one transaction: expires_at = now() is lapsed (`<=`)
    const edge = await account();
    await acquire(edge, randomUUID());
    const owner = randomUUID();
    let taken = 0;
    await tmp.db
      .transaction(async (tx) => {
        await tx.execute(
          sql`update broker_session_leases
               set acquired_at = now() - interval '1 minute', expires_at = now()
             where broker_account_id = ${edge}`,
        );
        // the operation itself, on the transaction's connection, so now() is the same instant
        taken = (await acquireSessionLease(tx as unknown as Db, {
          accountId: edge,
          ownerId: owner,
          ttlMs: TTL,
        }))
          ? 1
          : 0;
        tx.rollback();
      })
      .catch(() => undefined);
    expect(taken).toBe(1);
  });

  it('A5 lets exactly one of two concurrent acquires of an account win', async () => {
    const accountId = await account();
    const first = randomUUID();
    let commit!: () => void;
    const held = new Promise<void>((resolve) => (commit = resolve));
    let inserted!: () => void;
    const insertedOnce = new Promise<void>((resolve) => (inserted = resolve));
    // the first acquire's statement, its transaction held open
    const holder = tmp.db.transaction(async (tx) => {
      await tx.execute(
        sql`insert into broker_session_leases (broker_account_id, owner_id, acquired_at, expires_at)
            values (${accountId}, ${first}, now(), now() + interval '30 seconds')`,
      );
      inserted();
      await held;
    });
    await insertedOnce;
    const second = acquire(accountId, randomUUID());
    await until('the second acquire waits on the first one’s row', async () => {
      return (await lockWaiters(tmp.db)) > 0;
    });
    commit();
    await holder;
    expect(await second).toBe(false);
    expect((await rowOf(accountId))?.ownerId).toBe(first);
  });
});

describe('renewSessionLeases (#93)', () => {
  it('R1 moves the owner’s live leases and returns their ids', async () => {
    const [a, b] = [await account(), await account()];
    const owner = randomUUID();
    await acquire(a, owner);
    await acquire(b, owner);
    await expireIn(a, '5 seconds');
    const before = await rowOf(a);
    expect(
      (await renewSessionLeases(tmp.db, { ownerId: owner, accountIds: [a, b], ttlMs: TTL })).sort(),
    ).toEqual([a, b].sort());
    expect((await rowOf(a))!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
  });

  it('R2 does not renew its own lapsed lease, even when nobody took it', async () => {
    const accountId = await account();
    const owner = randomUUID();
    await acquire(accountId, owner);
    await expireIn(accountId, '-1 second');
    const before = await rowOf(accountId);
    expect(
      await renewSessionLeases(tmp.db, { ownerId: owner, accountIds: [accountId], ttlMs: TTL }),
    ).toEqual([]);
    expect(await rowOf(accountId)).toEqual(before);
  });

  it('R3 does not renew another owner’s lease', async () => {
    const accountId = await account();
    await acquire(accountId, randomUUID());
    expect(
      await renewSessionLeases(tmp.db, {
        ownerId: randomUUID(),
        accountIds: [accountId],
        ttlMs: TTL,
      }),
    ).toEqual([]);
  });

  // a statement that began first but commits last: it must not shorten what a later one set
  it('R5 never shortens a lease, by a renewal or by its own re-acquire', async () => {
    const accountId = await account();
    const owner = randomUUID();
    await acquire(accountId, owner);
    await expireIn(accountId, '1 hour');
    const far = (await rowOf(accountId))!.expiresAt;
    expect(
      await renewSessionLeases(tmp.db, { ownerId: owner, accountIds: [accountId], ttlMs: TTL }),
    ).toEqual([accountId]);
    expect((await rowOf(accountId))!.expiresAt).toEqual(far);
    expect(await acquire(accountId, owner)).toBe(true);
    expect((await rowOf(accountId))!.expiresAt).toEqual(far);
  });

  it('R4 answers an empty list without a query', async () => {
    expect(
      await renewSessionLeases(tmp.db, { ownerId: randomUUID(), accountIds: [], ttlMs: TTL }),
    ).toEqual([]);
  });
});

describe('releaseSessionLeases (#93)', () => {
  it('D1 deletes the owner’s rows only', async () => {
    const [mine, theirs] = [await account(), await account()];
    const owner = randomUUID();
    await acquire(mine, owner);
    await acquire(theirs, randomUUID());
    expect(await releaseSessionLeases(tmp.db, { ownerId: owner })).toBe(1);
    expect(await rowOf(mine)).toBeUndefined();
    expect(await rowOf(theirs)).toBeDefined();
  });
});
