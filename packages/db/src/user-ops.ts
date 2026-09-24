import { and, eq, sql } from 'drizzle-orm';
import { BrokerAccountStatus, type UserStartView } from '@binarius/shared';
import type { Db } from './client';
import { brokerAccounts } from './schema/broker-accounts';
import { users } from './schema/users';

export type UserStartRow = Pick<
  typeof users.$inferSelect,
  'id' | 'telegramUserId' | 'status' | 'acquisitionSource' | 'acquiredAt'
>;

export interface RecordUserStartInput {
  telegramUserId: bigint;
  displayName: string;
  languageCode?: string;
  startPayload?: string;
}

export interface RecordedUserStart {
  row: UserStartRow;
  hasActiveBrokerAccount: boolean;
}

// What /start writes: one upsert, no read-before-write, so two /start updates racing on a new
// user produce one row rather than a unique violation. The lock order is the one every other
// writer here uses — the UPDATE takes the users row, broker_accounts is read after it and only
// for information. `status` is deliberately absent from the SET: a blocked user does not become
// active by sending /start, the same line upsertUser (oauth-ops.ts) holds.
export async function recordUserStart(
  db: Db,
  { telegramUserId, displayName, languageCode, startPayload }: RecordUserStartInput,
): Promise<RecordedUserStart> {
  return db.transaction(async (tx) => {
    const source = startPayload ?? null;
    const [row] = await tx
      .insert(users)
      .values({
        telegramUserId,
        displayName,
        languageCode: languageCode ?? null,
        acquisitionSource: source,
        // the database clock, so the moment does not depend on the bot host's time
        acquiredAt: source === null ? null : sql`now()`,
      })
      .onConflictDoUpdate({
        target: users.telegramUserId,
        set: {
          displayName: sql`excluded.display_name`,
          // a /start that carried no usable language code must not erase the one on file
          languageCode: sql`coalesce(excluded.language_code, ${users.languageCode})`,
          // first touch wins: once a source is recorded, no later /start replaces it
          acquisitionSource: sql`coalesce(${users.acquisitionSource}, excluded.acquisition_source)`,
          acquiredAt: sql`coalesce(${users.acquiredAt}, excluded.acquired_at)`,
          // spelled out: $onUpdate does not reach the on-conflict path
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: users.id,
        telegramUserId: users.telegramUserId,
        status: users.status,
        acquisitionSource: users.acquisitionSource,
        acquiredAt: users.acquiredAt,
      });
    if (row === undefined) throw new Error('users upsert returned no row');

    const [account] = await tx
      .select({ id: brokerAccounts.id })
      .from(brokerAccounts)
      .where(
        and(
          eq(brokerAccounts.userId, row.id),
          eq(brokerAccounts.status, BrokerAccountStatus.Active),
        ),
      )
      .limit(1);
    return { row, hasActiveBrokerAccount: account !== undefined };
  });
}

// Allowlisted projection, built key by key: the row also carries the token balance and the
// internal id, and spreading it would put them on the wire the day a column is added.
export function toUserStartView(row: UserStartRow, hasActiveBrokerAccount: boolean): UserStartView {
  return {
    telegramUserId: row.telegramUserId.toString(),
    status: row.status,
    acquisitionSource: row.acquisitionSource,
    acquiredAt: row.acquiredAt === null ? null : row.acquiredAt.toISOString(),
    hasActiveBrokerAccount,
  };
}
