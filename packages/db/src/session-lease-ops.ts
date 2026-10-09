import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { brokerSessionLeases } from './schema/broker-session-leases';
import { millisecondsFromNow } from './trade-intent-ops';

// The broker session lease (#93, docs/broker-session.md → The lease). Each operation is one
// autocommit statement on the pool and locks nothing else, so it stays outside the lock chain;
// every time is the database's, a duration goes in as milliseconds.

// Takes a free or lapsed lease, or moves our own: one statement, the predicate inside
// `on conflict ... where`. Two acquires of one key serialize on the row, and the second
// re-evaluates the predicate against the first's committed row, so exactly one wins.
export async function acquireSessionLease(
  db: Db,
  { accountId, ownerId, ttlMs }: { accountId: string; ownerId: string; ttlMs: number },
): Promise<boolean> {
  const l = brokerSessionLeases;
  const rows = await db
    .insert(l)
    .values({ brokerAccountId: accountId, ownerId, acquiredAt: sql`now()`, expiresAt: millisecondsFromNow(ttlMs) })
    .onConflictDoUpdate({
      target: l.brokerAccountId,
      set: {
        ownerId: sql`excluded.owner_id`,
        acquiredAt: sql`excluded.acquired_at`,
        // never earlier than it was: a statement that began first but commits last must not
        // shorten a lease a later one already extended (a lapsed foreign row is in the past)
        expiresAt: sql`greatest(${l.expiresAt}, excluded.expires_at)`,
      },
      setWhere: sql`${l.expiresAt} <= now() or ${l.ownerId} = excluded.owner_id`,
    })
    .returning({ id: l.brokerAccountId });
  return rows.length === 1;
}

// The ids still held. A lease already lapsed is not renewed even when nobody took it: the
// owner's fence has closed (or is about to close) that socket, so lapsed means lost.
export async function renewSessionLeases(
  db: Db,
  { ownerId, accountIds, ttlMs }: { ownerId: string; accountIds: readonly string[]; ttlMs: number },
): Promise<string[]> {
  if (accountIds.length === 0) return [];
  const l = brokerSessionLeases;
  const rows = await db
    .update(l)
    // greatest: a renewal that stalled and commits after a later one must not shorten the lease
    .set({ expiresAt: sql`greatest(${l.expiresAt}, ${millisecondsFromNow(ttlMs)})` })
    .where(
      sql`${l.ownerId} = ${ownerId}
        and ${l.brokerAccountId} = any(${sql.param([...accountIds])}::uuid[])
        and ${l.expiresAt} > now()`,
    )
    .returning({ id: l.brokerAccountId });
  return rows.map((row) => row.id);
}

// At a graceful stop, after the sockets closed: a successor never overlaps them.
export async function releaseSessionLeases(
  db: Db,
  { ownerId }: { ownerId: string },
): Promise<number> {
  const l = brokerSessionLeases;
  const rows = await db
    .delete(l)
    .where(sql`${l.ownerId} = ${ownerId}`)
    .returning({ id: l.brokerAccountId });
  return rows.length;
}
