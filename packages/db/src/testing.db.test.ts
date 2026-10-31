import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createTempDatabase } from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

// Well above an admin connect plus DROP DATABASE (tens of ms): while the client's Terminate is held
// this long, a drop that does not wait for the socket has already run (#895).
const HOLD_MS = 500;

// cork() buffers the client's writes, so its Terminate stays unread by the server while the
// FATAL of a forced DROP can still be read; `connection` is not in pg's types
const socketOf = (client: PoolClient) =>
  (client as unknown as { connection: { stream: Duplex } }).connection.stream;

function watch(pool: Pool): { clients: PoolClient[]; errors: string[] } {
  const clients: PoolClient[] = [];
  const errors: string[] = [];
  pool.on('connect', (client) => clients.push(client));
  pool.on('error', (error: Error & { code?: string }) =>
    errors.push(`${error.code ?? '-'} ${error.message}`),
  );
  return { clients, errors };
}

function onlySocket(clients: PoolClient[]): Duplex {
  const [client] = clients;
  if (client === undefined || clients.length !== 1) {
    throw new Error(`expected one pool client, got ${clients.length}`);
  }
  return socketOf(client);
}

async function databaseExists(name: string): Promise<boolean> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    const { rows } = await admin.query('select 1 from pg_database where datname = $1', [name]);
    return rows.length === 1;
  } finally {
    await admin.end();
  }
}

describe('createTempDatabase teardown (#895, #262)', () => {
  it('drop() runs DROP DATABASE only once every socket of the pool has closed', async () => {
    const tmp = await createTempDatabase(baseUrl, async () => undefined);
    const name = new URL(tmp.url).pathname.slice(1);
    const { clients, errors } = watch(tmp.pool);
    await tmp.db.execute(sql`select 1`);
    const socket = onlySocket(clients);
    socket.cork();
    const dropping = tmp.drop();
    try {
      await sleep(HOLD_MS);
      expect(await databaseExists(name)).toBe(true);
    } finally {
      socket.uncork();
      await dropping;
    }
    expect(errors).toEqual([]);
    expect(await databaseExists(name)).toBe(false);
  });

  it('a failed migration drops the database only once the pool sockets have closed', async () => {
    let errors: string[] = [];
    await expect(
      createTempDatabase(baseUrl, async (pool) => {
        const watched = watch(pool);
        errors = watched.errors;
        await pool.query('select 1');
        const socket = onlySocket(watched.clients);
        socket.cork();
        setTimeout(() => socket.uncork(), HOLD_MS);
        throw new Error('migration failed');
      }),
    ).rejects.toThrow('migration failed');
    expect(errors).toEqual([]);
  });
});
