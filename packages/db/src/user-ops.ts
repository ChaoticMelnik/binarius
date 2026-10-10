import { and, desc, eq, ne, sql } from 'drizzle-orm';
import {
  addressOrNull,
  AuditAction,
  AuditActorType,
  AuditEntityType,
  BrokerAccountStatus,
  TradeMode,
  decimalStringSchema,
  referralCodeOf,
  normalizeDecimal,
  type DecimalString,
  type PendingBrokerAccountView,
  type UserStartView,
} from '@binarius/shared';
import type { Db } from './client';
import { auditLog } from './schema/audit-log';
import { brokerAccounts } from './schema/broker-accounts';
import { referralCodes, referrals } from './schema/referrals';
import { users } from './schema/users';

export type UserStartRow = Pick<
  typeof users.$inferSelect,
  | 'id'
  | 'telegramUserId'
  | 'status'
  | 'acquisitionSource'
  | 'acquiredAt'
  | 'notificationLevel'
  | 'demoStake'
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
  pendingBrokerAccounts: PendingBrokerAccountView[];
  // this /start created the user from a `ref_<code>` link of another user, and recorded it (#115)
  referred: boolean;
}

// What /users/start writes (/start and /settings): one upsert, no read-before-write, so two such
// updates racing on a new user produce one row rather than a unique violation. The lock order is
// the one every other writer here uses — the UPDATE takes the users row, broker_accounts is read
// after it and only for information. `status` is deliberately absent from the SET: a blocked user
// does not become active by sending /start or /settings, the same line upsertUser (oauth-ops.ts)
// holds.
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
          // the user has just written to the bot, which a blocked bot cannot receive (#119)
          telegramBlockedAt: null,
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
        notificationLevel: users.notificationLevel,
        demoStake: users.demoStake,
        // PostgreSQL 18: `old` is NULL exactly when the upsert inserted the row
        inserted: sql<boolean>`old.id is null`,
      });
    if (row === undefined) throw new Error('users upsert returned no row');
    const { inserted, ...user } = row;

    // Only a user this very /start created is an invitee (#115, docs/referrals.md): the upsert's
    // own verdict, so no earlier read can disagree with it. An unknown code and the user's own
    // insert nothing; the unique invitee key with `do nothing` keeps it to one row per invitee.
    const code = inserted ? referralCodeOf(startPayload) : undefined;
    const referred =
      code !== undefined &&
      (
        await tx
          .insert(referrals)
          .select(
            tx
              .select({
                id: sql<string>`gen_random_uuid()`.as('id'),
                inviteeUserId: sql<string>`${user.id}::uuid`.as('invitee_user_id'),
                inviterUserId: referralCodes.userId,
                createdAt: sql<Date>`now()`.as('created_at'),
              })
              .from(referralCodes)
              .where(and(eq(referralCodes.code, code), ne(referralCodes.userId, user.id))),
          )
          .onConflictDoNothing({ target: referrals.inviteeUserId })
          .returning({ id: referrals.id })
      ).length > 0;

    const [account] = await tx
      .select({ id: brokerAccounts.id })
      .from(brokerAccounts)
      .where(
        and(
          eq(brokerAccounts.userId, user.id),
          eq(brokerAccounts.status, BrokerAccountStatus.Active),
        ),
      )
      .limit(1);
    // what the bot offers to confirm; built key by key, like the view below
    const pending = await tx
      .select({ id: brokerAccounts.id, email: brokerAccounts.email })
      .from(brokerAccounts)
      .where(
        and(
          eq(brokerAccounts.userId, user.id),
          eq(brokerAccounts.status, BrokerAccountStatus.Pending),
        ),
      )
      .orderBy(desc(brokerAccounts.createdAt), desc(brokerAccounts.id));
    return {
      row: user,
      hasActiveBrokerAccount: account !== undefined,
      pendingBrokerAccounts: pending.map(({ id, email }) => ({ id, email })),
      referred,
    };
  });
}

// Allowlisted projection, built key by key: the row also carries the token balance and the
// internal id, and spreading it would put them on the wire the day a column is added.
export function toUserStartView(
  row: UserStartRow,
  hasActiveBrokerAccount: boolean,
  pendingBrokerAccounts: readonly PendingBrokerAccountView[],
): UserStartView {
  return {
    telegramUserId: row.telegramUserId.toString(),
    status: row.status,
    acquisitionSource: row.acquisitionSource,
    acquiredAt: row.acquiredAt === null ? null : row.acquiredAt.toISOString(),
    hasActiveBrokerAccount,
    pendingBrokerAccounts: pendingBrokerAccounts.map(({ id, email }) => ({
      id,
      email: addressOrNull(email),
    })),
    notificationLevel: row.notificationLevel,
    demoStake: canonicalStake(row.demoStake),
  };
}

// numeric(20,8) answers '5.00000000'; the wire carries '5'
export const canonicalStake = (value: DecimalString | null): DecimalString | null =>
  value === null ? null : decimalStringSchema.parse(normalizeDecimal(value));

// The user's demo stake (#297), the only writer of users.demo_stake: one autocommit UPDATE of
// the users row, no other table and no lock beyond the row's own, so the lock order is untouched.
// The bounds are the caller's (POST /trading/demo-stake, checkDemoStake); the column's CHECK only
// refuses a value <= 0. users.status is not read: the stake is a preference, and a blocked
// user's trades are refused at creation. No users row → undefined.
export async function setDemoStake(
  db: Db,
  telegramUserId: bigint,
  amount: DecimalString | null,
): Promise<{ demoStake: DecimalString | null } | undefined> {
  const [row] = await db
    .update(users)
    .set({ demoStake: amount })
    .where(eq(users.telegramUserId, telegramUserId))
    .returning({ demoStake: users.demoStake });
  return row === undefined ? undefined : { demoStake: canonicalStake(row.demoStake) };
}

// canonical; null = the broker's minimum; undefined = no users row
export async function readDemoStake(
  db: Db,
  telegramUserId: bigint,
): Promise<DecimalString | null | undefined> {
  const [row] = await db
    .select({ demoStake: users.demoStake })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  return row === undefined ? undefined : canonicalStake(row.demoStake);
}

export interface SetTradingModeResult {
  tradingMode: TradeMode;
  // false: the user was in that mode already; nothing was written and no audit row added
  changed: boolean;
}

// The one writer of users.trading_mode (#121, Rule 36). The UPDATE carries `trading_mode <> $mode`,
// so two concurrent switches serialize on the row lock and exactly one audit row is written per
// actual change, in the same transaction. Locks only the users row (Rule 5). undefined = no users
// row. The balance check of a switch to real is the route's (POST /trading/mode), not this one's.
export async function setTradingMode(
  db: Db,
  telegramUserId: bigint,
  mode: TradeMode,
): Promise<SetTradingModeResult | undefined> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ tradingMode: mode, updatedAt: sql`now()` })
      .where(and(eq(users.telegramUserId, telegramUserId), ne(users.tradingMode, mode)))
      .returning({ id: users.id });
    if (updated !== undefined) {
      await tx.insert(auditLog).values({
        actorType: AuditActorType.User,
        actorId: telegramUserId.toString(),
        action: AuditAction.TradingModeChanged,
        entityType: AuditEntityType.User,
        entityId: updated.id,
        payload: { from: mode === TradeMode.Real ? TradeMode.Demo : TradeMode.Real, to: mode },
      });
      return { tradingMode: mode, changed: true };
    }
    const [row] = await tx
      .select({ tradingMode: users.tradingMode })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    return row === undefined ? undefined : { tradingMode: row.tradingMode, changed: false };
  });
}
