import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDb, type Db } from './client';
import { runMigrations } from './migrate';
import {
  BrokerAccountStatus,
  TradeAction,
  TradeMode,
  type CreateTradeIntentRequest,
  type DecimalString,
} from '@binarius/shared';
import { brokerAccounts, users, UserStatus } from './schema/index';
import type { BrokerAccountRow } from './oauth-ops';
import { createTradeIntent, type TradeIntentRow } from './trade-intent-ops';

export interface TempDatabase {
  url: string;
  pool: Pool;
  db: Db;
  drop(): Promise<void>;
}

const PREFIX = 'binarius_test_';
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;
// the name carries its creation time so a database left behind by a crashed run can be reaped
const NAME_PATTERN = /^binarius_test_(\d+)_[0-9a-f]{8}$/;

// One migrated database per test file: integration tests commit for real (append-only tables
// cannot be cleaned afterwards) and may open concurrent transactions. Requires CREATEDB on the
// role in DATABASE_URL — the compose/CI role is a superuser.
export async function createTempDatabase(baseUrl: string): Promise<TempDatabase> {
  const name = `${PREFIX}${Date.now()}_${randomBytes(4).toString('hex')}`;
  await withAdmin(baseUrl, async (admin) => {
    await reapOrphans(admin);
    await admin.query(`CREATE DATABASE "${name}"`);
  });
  const url = withDatabase(baseUrl, name);
  const pool = new Pool({ connectionString: url });
  try {
    await runMigrations(pool);
  } catch (error) {
    await pool.end();
    await withAdmin(baseUrl, (admin) => dropDatabase(admin, name));
    throw error;
  }
  return {
    url,
    pool,
    db: createDb(pool),
    drop: async () => {
      await pool.end();
      await withAdmin(baseUrl, (admin) => dropDatabase(admin, name));
    },
  };
}

async function withAdmin<T>(baseUrl: string, run: (admin: Pool) => Promise<T>): Promise<T> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

// WITH (FORCE) terminates sessions still attached to an orphan; the caller ends its own pool first
async function dropDatabase(admin: Pool, name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

async function reapOrphans(admin: Pool): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    'select datname from pg_database where datname like $1',
    [`${PREFIX}%`],
  );
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
  for (const { datname } of rows) {
    // the pattern also guards the identifier interpolated into DROP DATABASE
    const match = NAME_PATTERN.exec(datname);
    if (match === null || Number(match[1]) > cutoff) continue;
    await dropDatabase(admin, datname);
  }
}

function withDatabase(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

// --- Fixtures ---------------------------------------------------------------------------------
// Shared by the integration suites of every package; each temporary database starts empty, so
// the counter only has to be unique within one test file.

let seq = 0;

export interface SeededUser {
  userId: string;
  telegramUserId: string;
}

export interface SeededAccount extends SeededUser {
  brokerAccountId: string;
}

// the whole row, ciphertexts included: the OAuth suites assert on columns the public view
// deliberately hides
export async function brokerAccountRow(db: Db, id: string): Promise<BrokerAccountRow> {
  const [row] = await db.select().from(brokerAccounts).where(eq(brokerAccounts.id, id));
  if (row === undefined) throw new Error(`brokerAccountRow: no broker_accounts row ${id}`);
  return row;
}

export async function seedUser(
  db: Db,
  { balance = 5n, status = UserStatus.Active }: { balance?: bigint; status?: UserStatus } = {},
): Promise<SeededUser> {
  const telegramUserId = BigInt(100_000 + ++seq);
  const [user] = await db
    .insert(users)
    .values({ telegramUserId, tokenBalance: balance, status })
    .returning({ id: users.id });
  if (user === undefined) throw new Error('seedUser: insert returned no row');
  return { userId: user.id, telegramUserId: telegramUserId.toString() };
}

// `status` is passed explicitly: the column defaults to pending, and most suites want an
// account that can already act. `patch` still overrides it.
export async function seedBrokerAccount(
  db: Db,
  userId: string,
  patch: { status?: BrokerAccountStatus; tradingHalted?: boolean } = {},
): Promise<string> {
  const [account] = await db
    .insert(brokerAccounts)
    .values({
      userId,
      brokerUserId: `broker-${++seq}`,
      accessTokenEnc: Buffer.from('enc'),
      refreshTokenEnc: Buffer.from('enc'),
      tokenKeyId: 'k1',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      status: BrokerAccountStatus.Active,
      ...patch,
    })
    .returning({ id: brokerAccounts.id });
  if (account === undefined) throw new Error('seedBrokerAccount: insert returned no row');
  return account.id;
}

export async function seedUserWithAccount(
  db: Db,
  options: { balance?: bigint; status?: UserStatus } = {},
): Promise<SeededAccount> {
  const user = await seedUser(db, options);
  const brokerAccountId = await seedBrokerAccount(db, user.userId);
  return { ...user, brokerAccountId };
}

export function intentRequest(
  telegramUserId: string,
  patch: Partial<CreateTradeIntentRequest> = {},
): CreateTradeIntentRequest {
  return {
    telegramUserId,
    mode: TradeMode.Demo,
    assetId: 91,
    amount: '10.00' as DecimalString,
    action: TradeAction.Up,
    durationSec: 60,
    clientRequestId: `req-${++seq}`,
    ...patch,
  };
}

// a queued intent for a fresh user + account: the starting point of every worker/publisher case
export async function seedQueuedIntent(
  db: Db,
  patch: Partial<CreateTradeIntentRequest> = {},
): Promise<SeededAccount & { intent: TradeIntentRow }> {
  const seed = await seedUserWithAccount(db);
  const { intent } = await createTradeIntent(db, intentRequest(seed.telegramUserId, patch));
  return { ...seed, intent };
}
