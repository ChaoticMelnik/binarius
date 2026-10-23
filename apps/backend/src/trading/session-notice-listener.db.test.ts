import { Pool, type PoolClient } from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { logOptions } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import { SESSION_NOTICE_CHANNEL } from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { createSessionNoticeListener, type SessionNoticeListener } from './session-notice-listener';

// The session notice listener (#723, docs/bot-session.md → Rate and timing → The wake) against a
// temporary migrated database: NOTIFY reaches the listeners of that database only, so a parallel
// run of another file sees none of these notifications.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

const RETRY_MS = 100;
const made: SessionNoticeListener[] = [];
const pools: Pool[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((listener) => listener.stop()));
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

function listenerOn(pool: Pool) {
  const payloads: string[] = [];
  const lines: string[] = [];
  const listener = createSessionNoticeListener({
    pool,
    channel: SESSION_NOTICE_CHANNEL,
    onNotification: (payload) => payloads.push(payload),
    logger: pino(logOptions('info'), { write: (line: string) => void lines.push(line) }),
    retryMs: RETRY_MS,
  });
  made.push(listener);
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const said = (msg: string) => logs().filter((line) => line.msg === msg);
  return { listener, payloads, logs, said };
}

// a pool of one client, so a test can hold it and make the listener's connect wait
function onePool(): Pool {
  const pool = new Pool({ connectionString: tmp.url, max: 1, connectionTimeoutMillis: 100 });
  pools.push(pool);
  return pool;
}

const notify = (payload: string) =>
  tmp.pool.query('select pg_notify($1, $2)', [SESSION_NOTICE_CHANNEL, payload]);
const busy = (pool: Pool) => pool.totalCount - pool.idleCount;

describe('the session notice listener (#723)', () => {
  it('L1 hands a notification to onNotification on one client of the pool', async () => {
    const { listener, payloads, said } = listenerOn(tmp.pool);
    listener.start();
    await until('the listening line', () => said('session notice listener listening').length === 1);
    expect(said('session notice listener listening')[0]).toMatchObject({
      level: 30,
      channel: SESSION_NOTICE_CHANNEL,
    });
    await notify('L1');
    await until('the L1 notification', () => payloads.includes('L1'));
    expect(payloads).toEqual(['L1']);
    expect(busy(tmp.pool)).toBe(1);
  });

  it('L2 a lost connection is logged once and listened again after the retry', async () => {
    const { listener, payloads, said } = listenerOn(tmp.pool);
    listener.start();
    await until('the listening line', () => said('session notice listener listening').length === 1);
    // LISTEN is the last statement of the listener's connection: it sends nothing after it
    const terminated = await tmp.pool.query<{ done: boolean }>(
      `select pg_terminate_backend(pid) as done from pg_stat_activity
        where datname = current_database() and query = $1`,
      [`LISTEN "${SESSION_NOTICE_CHANNEL}"`],
    );
    expect(terminated.rows).toEqual([{ done: true }]);
    await until('listening again', () => said('session notice listener listening').length === 2);
    const lost = said('session notice listener lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ level: 40, retryMs: RETRY_MS, err: { code: '57P01' } });
    await notify('L2');
    await until('the L2 notification', () => payloads.includes('L2'));
    expect(busy(tmp.pool)).toBe(1);
  });

  it('L3 stop() destroys the client: nothing is busy and nothing more is heard', async () => {
    const idle = listenerOn(tmp.pool);
    await idle.listener.stop();
    expect(idle.said('session notice listener listening')).toEqual([]);

    const { listener, payloads, said } = listenerOn(tmp.pool);
    listener.start();
    await until('the listening line', () => said('session notice listener listening').length === 1);
    expect(busy(tmp.pool)).toBe(1);
    const before = tmp.pool.totalCount;
    await listener.stop();
    expect(busy(tmp.pool)).toBe(0);
    expect(tmp.pool.totalCount).toBe(before - 1);
    // a client of our own LISTENs, and hears its barrier after the notification it must not
    const other: PoolClient = await tmp.pool.connect();
    const heard: string[] = [];
    try {
      other.on('notification', (n) => heard.push(n.payload ?? ''));
      await other.query(`LISTEN "${SESSION_NOTICE_CHANNEL}"`);
      await notify('L3');
      await notify('L3-barrier');
      await until('the barrier', () => heard.includes('L3-barrier'));
    } finally {
      other.release(true);
    }
    expect(heard).toEqual(['L3', 'L3-barrier']);
    expect(payloads).toEqual([]);
    await listener.stop();
  });

  it('L4 a refused connect is logged and tried again after the retry', async () => {
    const pool = onePool();
    const held = await pool.connect();
    const { listener, payloads, said } = listenerOn(pool);
    listener.start();
    await until('the refusal', () => said('session notice listener not connected').length >= 1);
    expect(said('session notice listener not connected')[0]).toMatchObject({
      level: 40,
      retryMs: RETRY_MS,
    });
    held.release();
    await until('the listening line', () => said('session notice listener listening').length === 1);
    await notify('L4');
    await until('the L4 notification', () => payloads.includes('L4'));
    expect(busy(pool)).toBe(1);
  });

  it('L5 stop() during a connect in flight: the late client is destroyed, nothing listens', async () => {
    const pool = onePool();
    const held = await pool.connect();
    const timedOut = listenerOn(pool);
    timedOut.listener.start();
    await timedOut.listener.stop();
    expect(timedOut.said('session notice listener listening')).toEqual([]);
    expect(timedOut.said('session notice listener not connected')).toHaveLength(1);

    const late = listenerOn(pool);
    late.listener.start();
    const stopping = late.listener.stop();
    // the connect waiting in the pool gets this client after the stop
    held.release();
    await stopping;
    expect(late.said('session notice listener listening')).toEqual([]);
    expect(late.said('session notice listener not connected')).toEqual([]);
    expect(busy(pool)).toBe(0);
    expect(pool.totalCount).toBe(0);
  });
});
