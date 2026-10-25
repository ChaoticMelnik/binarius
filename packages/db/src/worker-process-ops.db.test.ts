import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client';
import { workerProcesses } from './schema/index';
import { createTempDatabase, type TempDatabase } from './testing';
import { deregisterWorkerProcess, heartbeatWorkerProcess } from './worker-process-ops';

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
// every case reads the whole live set, so each starts from an empty table
beforeEach(async () => {
  await tmp.db.delete(workerProcesses);
});

const TTL = 30_000;
const PRUNE = 3_600_000;
const heartbeat = (ownerId: string, db: Db = tmp.db) =>
  heartbeatWorkerProcess(db, { ownerId, ttlMs: TTL, pruneAfterMs: PRUNE });
const rowOf = async (ownerId: string) =>
  (await tmp.db.select().from(workerProcesses).where(eq(workerProcesses.ownerId, ownerId)))[0];
// moves a row's expiry by the database clock, keeping it after heartbeat_at
const expireIn = (ownerId: string, by: string) =>
  tmp.db.execute(
    sql`update worker_processes
           set heartbeat_at = now() + ${by}::interval - interval '1 minute',
               expires_at = now() + ${by}::interval
         where owner_id = ${ownerId}`,
  );

describe('heartbeatWorkerProcess (#94)', () => {
  it('G1 a lone process’s first heartbeat returns itself and holds its row for the TTL', async () => {
    const me = randomUUID();
    expect(await heartbeat(me)).toEqual([me]);
    const row = await rowOf(me);
    expect(row!.expiresAt.getTime() - row!.heartbeatAt.getTime()).toBe(TTL);
  });

  it('G2 two processes each see both', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await heartbeat(a);
    expect((await heartbeat(b)).sort()).toEqual([a, b].sort());
    expect((await heartbeat(a)).sort()).toEqual([a, b].sort());
  });

  it('G3 a row is live strictly before its expiry, by the database clock', async () => {
    const [edge, inside] = [randomUUID(), randomUUID()];
    await heartbeat(edge);
    await heartbeat(inside);
    const me = randomUUID();
    let live: string[] = [];
    // now() is fixed inside one transaction: expires_at = now() is lapsed, now() + 1 ms is live
    await tmp.db
      .transaction(async (tx) => {
        await tx.execute(
          sql`update worker_processes set heartbeat_at = now() - interval '1 minute', expires_at = now()
               where owner_id = ${edge}`,
        );
        await tx.execute(
          sql`update worker_processes
                 set heartbeat_at = now() - interval '1 minute',
                     expires_at = now() + interval '1 millisecond'
               where owner_id = ${inside}`,
        );
        live = await heartbeat(me, tx as unknown as Db);
        tx.rollback();
      })
      .catch(() => undefined);
    expect(live.sort()).toEqual([inside, me].sort());
  });

  it('G5 another process’s heartbeat prunes a row lapsed longer than pruneAfterMs, not a recent one', async () => {
    const [old, recent, me] = [randomUUID(), randomUUID(), randomUUID()];
    await heartbeat(old);
    await heartbeat(recent);
    await expireIn(old, '-2 hours');
    await expireIn(recent, '-10 minutes');
    expect(await heartbeat(me)).toEqual([me]);
    expect(await rowOf(old)).toBeUndefined();
    expect(await rowOf(recent)).toBeDefined();
  });

  it('G6 the own id is in the answer when the upsert inserts: a fresh table, a row deleted by hand', async () => {
    const [other, me] = [randomUUID(), randomUUID()];
    await heartbeat(other);
    expect((await heartbeat(me)).sort()).toEqual([other, me].sort());
    await tmp.db.delete(workerProcesses).where(eq(workerProcesses.ownerId, me));
    expect((await heartbeat(me)).sort()).toEqual([other, me].sort());
    expect(await rowOf(me)).toBeDefined();
  });
});

describe('deregisterWorkerProcess (#94)', () => {
  it('G4 deletes the own row only', async () => {
    const [me, other] = [randomUUID(), randomUUID()];
    await heartbeat(me);
    await heartbeat(other);
    expect(await deregisterWorkerProcess(tmp.db, { ownerId: me })).toBe(1);
    expect(await rowOf(me)).toBeUndefined();
    expect(await rowOf(other)).toBeDefined();
  });
});
