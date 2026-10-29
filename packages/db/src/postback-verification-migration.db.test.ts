import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { createTempDatabase, type TempDatabase } from './testing';

// #142: 0087 marks every deposit already there as authenticated by the URL secret (until it the
// only writer was recordPostback behind that secret); journal rows before it keep no key id. The
// database is migrated to 0086 from a copy of the folder whose journal stops there, seeded at
// 0086's columns, then the full folder runs.
const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const FIRST_NEW = '0087_postback_verification';
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let partial: string;
let db: TempDatabase;
let before: { deposit: string; delivery: string };

const insertDeposit = async (paymentId: string, verification?: string | null) =>
  (
    await db.pool.query<{ id: string }>(
      verification === undefined
        ? `insert into deposit_events (source, broker_user_id, payment_id, amount)
           values ('binodex', 'trader-0087', $1, 10) returning id`
        : `insert into deposit_events (source, broker_user_id, payment_id, amount, verification)
           values ('binodex', 'trader-0087', $1, 10, $2) returning id`,
      verification === undefined ? [paymentId] : [paymentId, verification],
    )
  ).rows[0]!.id;

const insertRejectedDelivery = async (secretKeyId?: string | null) =>
  (
    await db.pool.query<{ id: string }>(
      secretKeyId === undefined
        ? `insert into postback_deliveries (source, outcome, reject_reason, payload)
           values ('binodex', 'rejected', 'missing_postback_id', '{}') returning id`
        : `insert into postback_deliveries (source, outcome, reject_reason, payload, secret_key_id)
           values ('binodex', 'rejected', 'missing_postback_id', '{}', $1) returning id`,
      secretKeyId === undefined ? [] : [secretKeyId],
    )
  ).rows[0]!.id;

const constraintOf = (run: () => Promise<unknown>) =>
  run().then(
    () => undefined,
    (error: unknown) => {
      const { code, constraint } = error as { code?: string; constraint?: string };
      return { code, constraint };
    },
  );

beforeAll(async () => {
  partial = await mkdtemp(path.join(tmpdir(), 'binarius-0087-'));
  await cp(drizzleDir, partial, { recursive: true });
  const journalPath = path.join(partial, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === FIRST_NEW);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await writeFile(journalPath, JSON.stringify(journal));
  db = await createTempDatabase(baseUrl, (pool) =>
    migrate(createDb(pool), { migrationsFolder: partial }),
  );
  // raw SQL at 0086's columns, so 0087's columns do not reach this database through the schema
  before = {
    deposit: await insertDeposit('pay-0087-before'),
    delivery: await insertRejectedDelivery(),
  };
  await runMigrations(db.pool);
});
afterAll(async () => {
  await db.drop();
  await rm(partial, { recursive: true, force: true });
});

describe('migration 0087', () => {
  it('PV1 marks the deposits before it url_secret and leaves the journal rows without a key id', async () => {
    const { rows: deposits } = await db.pool.query<{ verification: string | null }>(
      'select verification from deposit_events where id = $1',
      [before.deposit],
    );
    expect(deposits).toEqual([{ verification: 'url_secret' }]);
    const { rows: deliveries } = await db.pool.query<{ secret_key_id: string | null }>(
      'select secret_key_id from postback_deliveries where id = $1',
      [before.delivery],
    );
    expect(deliveries).toEqual([{ secret_key_id: null }]);
  });

  it('PV2 gives a later deposit no default: the backfill ran once', async () => {
    const later = await insertDeposit('pay-0087-later');
    const { rows } = await db.pool.query<{ verification: string | null }>(
      'select verification from deposit_events where id = $1',
      [later],
    );
    expect(rows).toEqual([{ verification: null }]);
  });

  it('PV3 holds verification to DepositVerification, NULL allowed', async () => {
    expect(await constraintOf(() => insertDeposit('pay-0087-bogus', 'bogus'))).toEqual({
      code: '23514',
      constraint: 'deposit_events_verification_check',
    });
    expect(await constraintOf(() => insertDeposit('pay-0087-null', null))).toBeUndefined();
    expect(
      await constraintOf(() => insertDeposit('pay-0087-secret', 'url_secret')),
    ).toBeUndefined();
  });

  it.each(['ABCDEF12', 'abcdef1', 'abcdef123'])('PV4 refuses the key id %j', async (keyId) => {
    expect(await constraintOf(() => insertRejectedDelivery(keyId))).toEqual({
      code: '23514',
      constraint: 'postback_deliveries_secret_key_id_check',
    });
  });

  it.each([null, 'abcdef12'])('PV4 accepts the key id %j', async (keyId) => {
    expect(await constraintOf(() => insertRejectedDelivery(keyId))).toBeUndefined();
  });
});
