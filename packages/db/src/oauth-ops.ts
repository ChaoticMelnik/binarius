import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AuthRevokedReason,
  BrokerAccountStatus,
  type BrokerAccountView,
  type OAuthTokens,
} from '@binarius/shared';
import type { Db } from './client';
import type { TokenCipher } from './crypto';
import { TokenField } from './crypto';
import { brokerAccounts } from './schema/broker-accounts';
import { oauthStates } from './schema/oauth-states';
import { UserStatus, users } from './schema/users';
import type { Tx } from './trade-intent-ops';

export type BrokerAccountRow = typeof brokerAccounts.$inferSelect;

// 32 bytes: a state is the only thing protecting the public callback, so it has to be
// unguessable rather than merely unique
const STATE_BYTES = 32;
const CLEANUP_BATCH = 100;

export const hashToken = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export interface CreatedOAuthState {
  state: string;
  expiresAt: Date;
}

// The caller gets the state; the row keeps only its hash. Expired rows are reaped here rather
// than by a scheduler: SKIP LOCKED keeps concurrent starts from queueing on the same batch.
export async function createOAuthState(
  db: Db,
  input: { telegramUserId: bigint; redirectUri: string; ttlMs: number },
): Promise<CreatedOAuthState> {
  const state = randomBytes(STATE_BYTES).toString('base64url');
  await db.execute(sql`
    delete from ${oauthStates} where id in (
      select id from ${oauthStates}
        where ${oauthStates.expiresAt} < now()
        order by ${oauthStates.expiresAt}
        limit ${CLEANUP_BATCH}
        for update skip locked
    )
  `);
  const [row] = await db
    .insert(oauthStates)
    .values({
      stateHash: hashToken(state),
      telegramUserId: input.telegramUserId,
      redirectUri: input.redirectUri,
      expiresAt: sql`now() + (${input.ttlMs}::int * interval '1 millisecond')`,
    })
    .returning({ expiresAt: oauthStates.expiresAt });
  if (row === undefined) throw new Error('oauth_states insert returned no row');
  return { state, expiresAt: row.expiresAt };
}

export interface ConsumedOAuthState {
  telegramUserId: bigint;
  redirectUri: string;
}

// Single statement, so two callbacks racing on one state produce exactly one winner. Everything
// the callback needs comes from this row — never from the request body.
export async function consumeOAuthState(
  db: Db,
  state: string,
): Promise<ConsumedOAuthState | undefined> {
  const [row] = await db
    .update(oauthStates)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(oauthStates.stateHash, hashToken(state)),
        isNull(oauthStates.usedAt),
        sql`${oauthStates.expiresAt} > now()`,
      ),
    )
    .returning({
      telegramUserId: oauthStates.telegramUserId,
      redirectUri: oauthStates.redirectUri,
    });
  return row;
}

export type LinkBrokerAccountResult =
  | { ok: true; account: BrokerAccountRow }
  | { ok: false; reason: 'broker_account_taken' | 'user_blocked' };

export interface LinkBrokerAccountInput {
  telegramUserId: bigint;
  tokens: OAuthTokens;
  cipher: TokenCipher;
}

// Two steps, because the ciphertext is authenticated against the row id (crypto.ts AAD):
// a single ON CONFLICT DO UPDATE would write ciphertext bound to a candidate id into a row
// that already has a different one, and nothing could decrypt it afterwards.
export async function linkBrokerAccount(
  db: Db,
  { telegramUserId, tokens, cipher }: LinkBrokerAccountInput,
): Promise<LinkBrokerAccountResult> {
  return db.transaction(async (tx) => {
    // lock order users → broker_accounts, as every other writer in this schema does
    const user = await upsertUser(tx, telegramUserId);
    if (user === undefined) return { ok: false, reason: 'user_blocked' };

    const candidateId = randomUUID();
    const expiresAt = sql`now() + (${tokens.expiresInSec}::int * interval '1 second')`;
    const [inserted] = await tx
      .insert(brokerAccounts)
      .values({
        id: candidateId,
        userId: user.id,
        brokerUserId: tokens.user.id,
        email: tokens.user.email,
        isPartnerClient: tokens.user.isPartnerClient,
        accessTokenEnc: cipher.encrypt(tokens.accessToken, {
          accountId: candidateId,
          field: TokenField.Access,
        }),
        refreshTokenEnc: cipher.encrypt(tokens.refreshToken, {
          accountId: candidateId,
          field: TokenField.Refresh,
        }),
        tokenKeyId: cipher.keyId,
        accessTokenExpiresAt: expiresAt,
        refreshTokenHash: hashToken(tokens.refreshToken),
        tokenRotatedAt: sql`now()`,
        status: BrokerAccountStatus.Pending,
      })
      .onConflictDoNothing({ target: brokerAccounts.brokerUserId })
      .returning();
    if (inserted !== undefined) return { ok: true, account: inserted };

    // the account exists: lock it, check who owns it, then re-encrypt under its real id.
    // FOR NO KEY UPDATE (not FOR UPDATE) stays compatible with the KEY SHARE locks the
    // trade_intents foreign keys take on this row.
    const [existing] = await tx
      .select({
        id: brokerAccounts.id,
        userId: brokerAccounts.userId,
        status: brokerAccounts.status,
      })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.brokerUserId, tokens.user.id))
      .for('no key update');
    if (existing === undefined) throw new Error('broker account vanished between insert and lock');
    if (existing.userId !== user.id) return { ok: false, reason: 'broker_account_taken' };

    // id, user_id and broker_user_id stay out of the update: they are key columns, and
    // trading_halted/halted_reason belong to reconciliation (ARCH-04), not to a re-login
    const [updated] = await tx
      .update(brokerAccounts)
      .set({
        email: tokens.user.email,
        isPartnerClient: tokens.user.isPartnerClient,
        accessTokenEnc: cipher.encrypt(tokens.accessToken, {
          accountId: existing.id,
          field: TokenField.Access,
        }),
        refreshTokenEnc: cipher.encrypt(tokens.refreshToken, {
          accountId: existing.id,
          field: TokenField.Refresh,
        }),
        tokenKeyId: cipher.keyId,
        accessTokenExpiresAt: expiresAt,
        refreshTokenHash: hashToken(tokens.refreshToken),
        tokenRotatedAt: sql`now()`,
        // A second login must not activate what nobody confirmed: an account still waiting for
        // its confirmation stays waiting. One that was active or revoked has been confirmed
        // before, so logging in again is enough to make it usable.
        status:
          existing.status === BrokerAccountStatus.Pending
            ? BrokerAccountStatus.Pending
            : BrokerAccountStatus.Active,
        authRevokedReason: null,
      })
      .where(eq(brokerAccounts.id, existing.id))
      .returning();
    if (updated === undefined) throw new Error('broker account update returned no row');
    return { ok: true, account: updated };
  });
}

// A blocked user does not become active by logging in again; undefined means "blocked".
async function upsertUser(tx: Tx, telegramUserId: bigint): Promise<{ id: string } | undefined> {
  const [existing] = await tx
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId))
    .for('no key update');
  if (existing !== undefined) {
    return existing.status === UserStatus.Blocked ? undefined : { id: existing.id };
  }
  const [created] = await tx
    .insert(users)
    .values({ telegramUserId })
    .onConflictDoNothing({ target: users.telegramUserId })
    .returning({ id: users.id });
  if (created !== undefined) return created;
  // lost the race: the row exists now, read it under the same lock
  const [raced] = await tx
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId))
    .for('no key update');
  if (raced === undefined) throw new Error('user vanished between insert and re-read');
  return raced.status === UserStatus.Blocked ? undefined : { id: raced.id };
}

export async function lockAccountForRefresh(
  tx: Tx,
  accountId: string,
): Promise<BrokerAccountRow | undefined> {
  const [row] = await tx
    .select()
    .from(brokerAccounts)
    .where(eq(brokerAccounts.id, accountId))
    .for('no key update');
  return row;
}

export async function applyRotatedTokens(
  tx: Tx,
  {
    account,
    tokens,
    cipher,
  }: { account: BrokerAccountRow; tokens: OAuthTokens; cipher: TokenCipher },
): Promise<void> {
  await tx
    .update(brokerAccounts)
    .set({
      accessTokenEnc: cipher.encrypt(tokens.accessToken, {
        accountId: account.id,
        field: TokenField.Access,
      }),
      refreshTokenEnc: cipher.encrypt(tokens.refreshToken, {
        accountId: account.id,
        field: TokenField.Refresh,
      }),
      tokenKeyId: cipher.keyId,
      accessTokenExpiresAt: sql`now() + (${tokens.expiresInSec}::int * interval '1 second')`,
      refreshTokenHash: hashToken(tokens.refreshToken),
      tokenRotatedAt: sql`now()`,
    })
    .where(eq(brokerAccounts.id, account.id));
}

// Fills in the hash of a refresh token already stored, for a row linked before the column
// existed. Deliberately narrow: token_rotated_at dates the refresh token itself and starts the
// ninety-day clock, so writing it here would hand an old token a fresh expiry.
export async function backfillRefreshTokenHash(
  tx: Tx,
  accountId: string,
  refreshTokenHash: string,
): Promise<void> {
  await tx
    .update(brokerAccounts)
    .set({ refreshTokenHash })
    .where(and(eq(brokerAccounts.id, accountId), isNull(brokerAccounts.refreshTokenHash)));
}

export type ConditionalRevokeOutcome =
  | { outcome: 'revoked' }
  | { outcome: 'already_revoked'; reason: AuthRevokedReason | null }
  | { outcome: 'changed' }
  | { outcome: 'missing' };

// Revokes only while the row still carries the refresh token the caller was holding. The caller
// for this is a transaction that has already rolled back, so its row lock is gone and the user
// may have logged in again in the meantime; revoking by id alone would destroy that new session.
// `is not distinct from` rather than `=` because a row linked before the hash column existed
// carries NULL, and NULL = NULL is not true.
export async function revokeAccountIfUnchanged(
  tx: Tx,
  {
    accountId,
    refreshTokenHash,
    reason,
  }: { accountId: string; refreshTokenHash: string | null; reason: AuthRevokedReason },
): Promise<ConditionalRevokeOutcome> {
  const [updated] = await tx
    .update(brokerAccounts)
    .set({ status: BrokerAccountStatus.Revoked, authRevokedReason: reason })
    .where(
      and(
        eq(brokerAccounts.id, accountId),
        eq(brokerAccounts.status, BrokerAccountStatus.Active),
        sql`${brokerAccounts.refreshTokenHash} is not distinct from ${refreshTokenHash}::text`,
      ),
    )
    .returning({ id: brokerAccounts.id });
  if (updated !== undefined) return { outcome: 'revoked' };

  // zero rows means three different things, and the caller acts differently on each
  const [row] = await tx
    .select({ status: brokerAccounts.status, reason: brokerAccounts.authRevokedReason })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.id, accountId));
  if (row === undefined) return { outcome: 'missing' };
  if (row.status === BrokerAccountStatus.Revoked) {
    return { outcome: 'already_revoked', reason: row.reason };
  }
  return { outcome: 'changed' };
}

export type ConfirmBrokerAccountResult =
  | { ok: true; account: BrokerAccountRow }
  | { ok: false; reason: 'user_blocked' | 'not_found' | 'not_pending' };

// The step that turns "someone authorized at the broker" into "this Telegram user owns that
// account". The user row is read under the same transaction as the account, in the lock order
// every other writer here uses, so a block landing concurrently cannot slip past.
export async function confirmBrokerAccount(
  db: Db,
  { telegramUserId, accountId }: { telegramUserId: bigint; accountId: string },
): Promise<ConfirmBrokerAccountResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId))
      .for('no key update');
    if (user === undefined) return { ok: false, reason: 'not_found' };
    if (user.status === UserStatus.Blocked) return { ok: false, reason: 'user_blocked' };

    // the account id comes from the caller, so ownership is part of the lookup rather than a
    // check afterwards: a row that is not theirs must be indistinguishable from one that is gone
    const [account] = await tx
      .select({ id: brokerAccounts.id, status: brokerAccounts.status })
      .from(brokerAccounts)
      .where(and(eq(brokerAccounts.id, accountId), eq(brokerAccounts.userId, user.id)))
      .for('no key update');
    if (account === undefined) return { ok: false, reason: 'not_found' };
    if (account.status !== BrokerAccountStatus.Pending) return { ok: false, reason: 'not_pending' };

    const [confirmed] = await tx
      .update(brokerAccounts)
      .set({ status: BrokerAccountStatus.Active })
      .where(eq(brokerAccounts.id, account.id))
      .returning();
    if (confirmed === undefined) throw new Error('broker account confirm returned no row');
    return { ok: true, account: confirmed };
  });
}

// Only `status` and `auth_revoked_reason`: trading_halted and halted_reason belong to ARCH-04.
export async function revokeAccount(
  tx: Tx,
  accountId: string,
  reason: AuthRevokedReason,
): Promise<void> {
  await tx
    .update(brokerAccounts)
    .set({ status: BrokerAccountStatus.Revoked, authRevokedReason: reason })
    .where(eq(brokerAccounts.id, accountId));
}

// A blocked user must not even reach the broker: a login they cannot finish would still burn
// a state row and, once they authorize, an authorization code.
export async function isUserBlocked(db: Db, telegramUserId: bigint): Promise<boolean> {
  const [row] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  return row?.status === UserStatus.Blocked;
}

export function toBrokerAccountView(row: BrokerAccountRow): BrokerAccountView {
  return {
    id: row.id,
    brokerUserId: row.brokerUserId,
    email: row.email,
    isPartnerClient: row.isPartnerClient,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
