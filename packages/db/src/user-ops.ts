import { and, desc, eq, ne, sql } from 'drizzle-orm';
import {
  addressOrNull,
  AuditAction,
  AuditActorType,
  AuditEntityType,
  BrokerAccountStatus,
  TradeMode,
  botLanguageOf,
  type BotLanguage,
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
import { stopUserSessions } from './trading-session-ops';

export type UserStartRow = Pick<
  typeof users.$inferSelect,
  | 'id'
  | 'telegramUserId'
  | 'status'
  | 'acquisitionSource'
  | 'acquiredAt'
  | 'notificationLevel'
  | 'demoStake'
  | 'realStake'
  | 'language'
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
        // only here: the conflict's SET below leaves it, so a later /start never changes it
        language: botLanguageOf(languageCode),
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
        realStake: users.realStake,
        language: users.language,
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
    realStake: canonicalStake(row.realStake),
    language: row.language,
  };
}

// The user's choice on the bot's language screen (#508), with the INSERT in recordUserStart the
// only writer of users.language: one autocommit UPDATE of the user's own row, no other table and
// no lock beyond the row's own (Rule 5). users.status is not read: the language is a preference,
// like the notification level. undefined = no users row.
export async function setUserLanguage(
  db: Db,
  telegramUserId: bigint,
  language: BotLanguage,
): Promise<BotLanguage | undefined> {
  const [row] = await db
    .update(users)
    .set({ language })
    .where(eq(users.telegramUserId, telegramUserId))
    .returning({ language: users.language });
  return row?.language;
}

// undefined = no users row
export async function readUserLanguage(
  db: Db,
  telegramUserId: bigint,
): Promise<BotLanguage | undefined> {
  const [row] = await db
    .select({ language: users.language })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  return row?.language;
}

// numeric(20,8) answers '5.00000000'; the wire carries '5'
export const canonicalStake = (value: DecimalString | null): DecimalString | null =>
  value === null ? null : decimalStringSchema.parse(normalizeDecimal(value));

// The user's stake of one mode (#297 demo, #326 real), the only writer of users.demo_stake and
// users.real_stake: one autocommit UPDATE of the users row, no other table and no lock beyond the
// row's own, so the lock order is untouched. The bounds are the caller's (POST /trading/stake,
// checkStake); the column's CHECK only refuses a value <= 0. users.status and
// users.trading_mode are not read: the stake is a preference, and a blocked user's trades are
// refused at creation. No users row → undefined.
export async function setStake(
  db: Db,
  telegramUserId: bigint,
  mode: TradeMode,
  amount: DecimalString | null,
): Promise<{ mode: TradeMode; stake: DecimalString | null } | undefined> {
  const column = mode === TradeMode.Real ? users.realStake : users.demoStake;
  const [row] = await db
    .update(users)
    .set(mode === TradeMode.Real ? { realStake: amount } : { demoStake: amount })
    .where(eq(users.telegramUserId, telegramUserId))
    .returning({ stake: column });
  return row === undefined ? undefined : { mode, stake: canonicalStake(row.stake) };
}

// The fact the analysis reminder counts from (#484): the analysis card with a signal of this pair
// and duration, at the database clock; null records an analysis with no signal, which ends the
// previous one's reminder. One autocommit UPDATE of the user's own row; false = no users row.
export async function setLastAnalysis(
  db: Db,
  telegramUserId: bigint,
  analysis: { assetId: number; durationSec: number } | null,
): Promise<boolean> {
  const rows = await db
    .update(users)
    .set(
      analysis === null
        ? { lastAnalysisAt: null, lastAnalysisAssetId: null, lastAnalysisDurationSec: null }
        : {
            lastAnalysisAt: sql`now()`,
            lastAnalysisAssetId: analysis.assetId,
            lastAnalysisDurationSec: analysis.durationSec,
          },
    )
    .where(eq(users.telegramUserId, telegramUserId))
    .returning({ id: users.id });
  return rows.length > 0;
}

// canonical; null = the broker's minimum; undefined = no users row
export async function readStakes(
  db: Db,
  telegramUserId: bigint,
): Promise<{ demoStake: DecimalString | null; realStake: DecimalString | null } | undefined> {
  const [row] = await db
    .select({ demoStake: users.demoStake, realStake: users.realStake })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  return row === undefined
    ? undefined
    : { demoStake: canonicalStake(row.demoStake), realStake: canonicalStake(row.realStake) };
}

export interface SetTradingModeResult {
  tradingMode: TradeMode;
  // false: the user was in that mode already; nothing was written and no audit row added
  changed: boolean;
  // the user's active sessions the switch stopped (user_stopped), 0 when nothing changed (#327)
  stoppedSessions: number;
}

// The one writer of users.trading_mode (#121, Rule 36). The UPDATE carries `trading_mode <> $mode`,
// so two concurrent switches serialize on the row lock and exactly one audit row is written per
// actual change, in the same transaction. A change also stops the user's active sessions in that
// transaction (#327): a session runs only in its user's mode. Locks the users row, then those
// sessions (Rule 5). undefined = no users row. The balance check of a switch to real is the route's (POST /trading/mode), not this one's.
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
      const stopped = await stopUserSessions(tx, { telegramUserId: telegramUserId.toString() });
      return { tradingMode: mode, changed: true, stoppedSessions: stopped.length };
    }
    const [row] = await tx
      .select({ tradingMode: users.tradingMode })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    return row === undefined
      ? undefined
      : { tradingMode: row.tradingMode, changed: false, stoppedSessions: 0 };
  });
}
