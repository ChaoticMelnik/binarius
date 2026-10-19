import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { outboxEvents, tradeIntents } from './schema/index';
import { createTempDatabase, type TempDatabase } from './testing';

// S6 (#144): migration 0019 moves rows that carry real_trading_disabled to trading_paused before
// it adds the CHECKs without the old value. The database is migrated to 0018 from a copy of the
// folder whose journal stops there, the rows are inserted, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0019_trading_switch';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let tmp: TempDatabase;
beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0019-'));
  await cp(drizzleDir, partial, { recursive: true });
  const journalPath = path.join(partial, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === FIRST_NEW);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journalPath, JSON.stringify(journal));
  tmp = await createTempDatabase(baseUrl, (pool) =>
    migrate(createDb(pool), { migrationsFolder: partial }),
  );
});
afterAll(async () => {
  await tmp.drop();
  await rm(partial, { recursive: true, force: true });
});

describe('migration 0019', () => {
  it('S6 rewrites real_trading_disabled to trading_paused on both tables', async () => {
    // the users row through SQL: the drizzle schema names every column it has today, and a
    // column added after 0018 (users.demo_stake, #297) does not exist in this database yet
    const { rows } = await tmp.pool.query<{ id: string }>(
      'insert into users (telegram_user_id) values ($1) returning id',
      [900_019],
    );
    const userId = rows[0]!.id;
    // the account too: broker_accounts.service_since (#391) came after 0018 as well
    const { rows: accounts } = await tmp.pool.query<{ id: string }>(
      `insert into broker_accounts (user_id, broker_user_id, access_token_enc, refresh_token_enc,
         token_key_id, access_token_expires_at, status)
       values ($1, 'broker-0019', '\\x00'::bytea, '\\x00'::bytea, 'k1', now() + interval '1 hour', 'active')
       returning id`,
      [userId],
    );
    // and the intent: trade_intents.signal_decision_id (#666) came after 0018
    const { rows: intents } = await tmp.pool.query<{ id: string }>(
      `insert into trade_intents (broker_account_id, user_id, mode, asset_id, amount, action,
         duration_sec, client_request_id, status, tokens_reserved, last_error)
       values ($1, $2, 'real', 91, 10.00, 'up', 60, 'before-0019', 'rejected', 0, 'real_trading_disabled')
       returning id`,
      [accounts[0]!.id, userId],
    );
    const intent = intents[0];
    await tmp.db.insert(outboxEvents).values({
      intentId: intent!.id,
      payload: { intent_id: intent!.id },
      lastError: 'real_trading_disabled' as never,
    });

    await runMigrations(tmp.pool);

    const [after] = await tmp.db.select().from(tradeIntents).where(eq(tradeIntents.id, intent!.id));
    expect(after!.lastError).toBe('trading_paused');
    const [event] = await tmp.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.intentId, intent!.id));
    expect(event!.lastError).toBe('trading_paused');
    const refused = await tmp.db
      .update(tradeIntents)
      .set({ lastError: 'real_trading_disabled' as never })
      .where(eq(tradeIntents.id, intent!.id))
      .catch((error: unknown) => (error as { cause?: unknown }).cause);
    expect(refused).toMatchObject({ code: '23514', constraint: 'trade_intents_last_error_check' });
  });
});
