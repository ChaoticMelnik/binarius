import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import {
  addressOrNull,
  AuditAction,
  AuditActorType,
  AuditEntityType,
  BrokerAccountStatus,
  DepositModeSwitch,
  TradeMode,
  TradingSessionStatus,
  UserStatus,
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
import { depositEvents } from './schema/deposit-events';
import { referralCodes, referrals } from './schema/referrals';
import { tradingSessions } from './schema/trading-sessions';
import { users } from './schema/users';
import { markDepositModeSwitch, markUserDepositModeSwitches } from './deposit-mode-switch-ops';
import type { Tx } from './trade-intent-ops';
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

// Who switched the mode: the user (the mode screen, /stop) or the pass over a deposit (#686).
type TradingModeActor =
  { kind: 'user'; telegramUserId: bigint } | { kind: 'deposit'; depositEventId: string };

// The one writer of users.trading_mode (#121, Rule 36), for setTradingMode and
// switchTradingModeOnDeposit. The UPDATE carries `trading_mode <> $mode`, so two concurrent
// switches serialize on the row lock and exactly one audit row is written per actual change, in
// the caller's transaction. Returns the user's id, or undefined when nothing changed.
async function writeTradingMode(
  tx: Tx,
  { by, mode, actor }: { by: SQL; mode: TradeMode; actor: TradingModeActor },
): Promise<string | undefined> {
  const [updated] = await tx
    .update(users)
    .set({ tradingMode: mode, updatedAt: sql`now()` })
    .where(and(by, ne(users.tradingMode, mode)))
    .returning({ id: users.id });
  if (updated === undefined) return undefined;
  const from = mode === TradeMode.Real ? TradeMode.Demo : TradeMode.Real;
  await tx.insert(auditLog).values({
    ...(actor.kind === 'user'
      ? { actorType: AuditActorType.User, actorId: actor.telegramUserId.toString() }
      : { actorType: AuditActorType.System, actorId: null }),
    action: AuditAction.TradingModeChanged,
    entityType: AuditEntityType.User,
    entityId: updated.id,
    payload:
      actor.kind === 'user'
        ? { from, to: mode }
        : { from, to: mode, depositEventId: actor.depositEventId },
  });
  return updated.id;
}

// The user's own switch. A change also stops the user's active sessions in that transaction
// (#327): a session runs only in its user's mode; and closes the user's deposits still waiting for
// the switch after a deposit as `superseded` (#686): the user decided the mode after them. Locks
// the users row, then those sessions, then those deposits (Rule 5). undefined = no users row. The
// balance check of a switch to real is the route's (POST /trading/mode), not this one's.
export async function setTradingMode(
  db: Db,
  telegramUserId: bigint,
  mode: TradeMode,
): Promise<SetTradingModeResult | undefined> {
  return db.transaction(async (tx) => {
    const userId = await writeTradingMode(tx, {
      by: eq(users.telegramUserId, telegramUserId),
      mode,
      actor: { kind: 'user', telegramUserId },
    });
    if (userId !== undefined) {
      const stopped = await stopUserSessions(tx, { telegramUserId: telegramUserId.toString() });
      await markUserDepositModeSwitches(tx, { userId, outcome: DepositModeSwitch.Superseded });
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

// What one attempt of the pass made of a deposit: an outcome written on the row, or nothing —
// `session_active` (the user runs a session; the deposit waits for its end, #686 issue item 6) and
// `gone` (the row has an outcome already, written by another process or by setTradingMode).
export type DepositModeSwitchAttempt = DepositModeSwitch | 'session_active' | 'gone';

class DepositModeSwitchGone extends Error {}

// The switch to real after a deposit (#686, docs/trading-mode.md → The automatic switch after a
// deposit). With demoOnly (DEMO_ONLY, #396) the row is closed `demo_only` with no users lock and
// never switches later. Otherwise, under the users lock (FOR NO KEY UPDATE, Rule 5: users →
// deposit_events): blocked → user_blocked, real → already_real, the deposit's account not active
// → account_inactive, a session not stopped on any account of the user → nothing (it waits),
// else the switch with its audit row and `switched`, in one transaction. A session cannot start
// while the users row is held (createTradingSession locks it first), so the check holds to the
// commit.
export async function switchTradingModeOnDeposit(
  db: Db,
  { depositEventId, demoOnly }: { depositEventId: string; demoOnly: boolean },
): Promise<{ outcome: DepositModeSwitchAttempt }> {
  if (demoOnly) {
    const outcome = DepositModeSwitch.DemoOnly;
    return {
      outcome: (await markDepositModeSwitch(db, { depositEventId, outcome })) ? outcome : 'gone',
    };
  }
  try {
    return await db.transaction(async (tx) => {
      const [deposit] = await tx
        .select({
          userId: depositEvents.userId,
          brokerAccountId: depositEvents.brokerAccountId,
          modeSwitch: depositEvents.modeSwitch,
        })
        .from(depositEvents)
        .where(eq(depositEvents.id, depositEventId));
      if (deposit?.userId == null || deposit.modeSwitch !== null) return { outcome: 'gone' };
      const userId = deposit.userId;
      const [user] = await tx
        .select({ status: users.status, tradingMode: users.tradingMode })
        .from(users)
        .where(eq(users.id, userId))
        .for('no key update');
      if (user === undefined) return { outcome: 'gone' };
      const outcome = await (async (): Promise<DepositModeSwitchAttempt> => {
        if (user.status === UserStatus.Blocked) return DepositModeSwitch.UserBlocked;
        if (user.tradingMode === TradeMode.Real) return DepositModeSwitch.AlreadyReal;
        // deposit_events_owner_pair_check: an attributed row names its account
        const accountId = deposit.brokerAccountId;
        if (accountId === null) return DepositModeSwitch.AccountInactive;
        const [account] = await tx
          .select({ status: brokerAccounts.status })
          .from(brokerAccounts)
          .where(eq(brokerAccounts.id, accountId));
        if (account?.status !== BrokerAccountStatus.Active)
          return DepositModeSwitch.AccountInactive;
        const [session] = await tx
          .select({ id: tradingSessions.id })
          .from(tradingSessions)
          .innerJoin(brokerAccounts, eq(brokerAccounts.id, tradingSessions.brokerAccountId))
          .where(
            and(
              eq(brokerAccounts.userId, userId),
              ne(tradingSessions.status, TradingSessionStatus.Stopped),
            ),
          )
          .limit(1);
        if (session !== undefined) return 'session_active';
        const switched = await writeTradingMode(tx, {
          by: eq(users.id, userId),
          mode: TradeMode.Real,
          actor: { kind: 'deposit', depositEventId },
        });
        // the mode was read as demo under this lock
        if (switched === undefined)
          throw new Error('deposit mode switch: the user changed under its lock');
        return DepositModeSwitch.Switched;
      })();
      if (outcome === 'session_active' || outcome === 'gone') return { outcome };
      // another process closed the row since the read: its outcome stands, this one rolls back
      if (!(await markDepositModeSwitch(tx, { depositEventId, outcome }))) {
        throw new DepositModeSwitchGone();
      }
      return { outcome };
    });
  } catch (error) {
    if (error instanceof DepositModeSwitchGone) return { outcome: 'gone' };
    throw error;
  }
}
