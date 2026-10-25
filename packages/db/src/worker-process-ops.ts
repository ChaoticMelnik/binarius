import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { workerProcesses } from './schema/worker-processes';
import { millisecondsAgo, millisecondsFromNow } from './sql-time';

// The worker process registry (#94, docs/worker-capacity.md → The registry). Each operation is
// one autocommit statement that locks nothing outside worker_processes, so it stays outside the
// lock chain; every time is the database's, a duration goes in as milliseconds.

// Moves our own row (inserting it on the first call or after it was pruned), deletes rows lapsed
// longer than `pruneAfterMs`, and returns the live ids, ours included. The outer select reads the
// statement's snapshot and does not see the CTE's write, hence the union with `mine`;
// `owner_id <> me` keeps the delete off the row the upsert touches (a row may be affected once).
export async function heartbeatWorkerProcess(
  db: Db,
  { ownerId, ttlMs, pruneAfterMs }: { ownerId: string; ttlMs: number; pruneAfterMs: number },
): Promise<string[]> {
  const w = workerProcesses;
  const { rows } = await db.execute<{ owner_id: string }>(sql`
    with pruned as (
      delete from ${w}
       where ${w.expiresAt} < ${millisecondsAgo(pruneAfterMs)}
         and ${w.ownerId} <> ${ownerId}),
    mine as (
      insert into ${w} (owner_id, heartbeat_at, expires_at)
      values (${ownerId}, now(), ${millisecondsFromNow(ttlMs)})
      on conflict (owner_id) do update
        set heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at
      returning owner_id)
    select owner_id from ${w} where ${w.expiresAt} > now()
    union select owner_id from mine`);
  return rows.map((row) => row.owner_id);
}

// At a graceful stop, after our leases were released.
export async function deregisterWorkerProcess(
  db: Db,
  { ownerId }: { ownerId: string },
): Promise<number> {
  const w = workerProcesses;
  const rows = await db
    .delete(w)
    .where(sql`${w.ownerId} = ${ownerId}`)
    .returning({ id: w.ownerId });
  return rows.length;
}
