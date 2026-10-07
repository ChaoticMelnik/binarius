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
import { createTempDatabase, seedUserWithAccount, type TempDatabase } from './testing';

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
    const seed = await seedUserWithAccount(tmp.db);
    const [intent] = await tmp.db
      .insert(tradeIntents)
      .values({
        brokerAccountId: seed.brokerAccountId,
        userId: seed.userId,
        mode: 'real',
        assetId: 91,
        amount: '10.00' as never,
        action: 'up',
        durationSec: 60,
        clientRequestId: 'before-0019',
        status: 'rejected',
        tokensReserved: 0n,
        lastError: 'real_trading_disabled' as never,
      })
      .returning();
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
