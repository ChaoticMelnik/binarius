import type { FastifyBaseLogger } from 'fastify';
import { AuthRevokedReason, errorIdentity } from '@binarius/shared';
import {
  applyRotatedTokens,
  backfillRefreshTokenHash,
  hashToken,
  lockAccountForRefresh,
  revokeAccount,
  TokenCipherError,
  type BrokerAccountRow,
  type Db,
  type TokenCipher,
  type Tx,
} from '@binarius/db';
import { TokenField } from '@binarius/db';
import {
  BrokerOAuthError,
  BrokerOAuthErrorCode,
  type BrokerOAuthClient,
} from '../broker/oauth-client';

// refresh tokens live 90 days; past that the broker would refuse the exchange anyway, and
// asking would burn the token we still hold
export const REFRESH_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
// renew a little before expiry, so a token handed out now is still valid when it is used
export const ACCESS_SKEW_MS = 60_000;

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'account_not_found' }
  // the row was encrypted under a key this process does not hold; another process has it
  | { ok: false; reason: 'key_unavailable' }
  | { ok: false; reason: 'account_revoked'; revokedReason: AuthRevokedReason | null };

export interface TokenServiceDeps {
  db: Db;
  broker: BrokerOAuthClient;
  cipher: TokenCipher;
  logger: FastifyBaseLogger;
}

// Thrown after the broker has already rotated the pair but storing it failed. The transaction
// is aborted at that point, so the account can only be revoked by a second one.
class RotatedTokensLost extends Error {
  constructor(
    readonly accountId: string,
    readonly failure: unknown,
  ) {
    super('storing the rotated token pair failed');
    this.name = 'RotatedTokensLost';
  }
}

// Returns a usable access token for the account, refreshing it when needed.
//
// The whole decision runs under one row lock, which makes the refresh single-flight per
// account: a second caller waits and then finds a fresh token instead of exchanging a token
// the first caller has already consumed. Revocation is committed by the transaction and only
// then reported — throwing inside it would roll the revocation back.
export async function ensureFreshAccessToken(
  deps: TokenServiceDeps,
  accountId: string,
): Promise<AccessTokenResult> {
  try {
    return await refreshUnderLock(deps, accountId);
  } catch (error) {
    if (!(error instanceof RotatedTokensLost)) throw error;
    return abandonLostPair(deps, error);
  }
}

async function refreshUnderLock(
  deps: TokenServiceDeps,
  accountId: string,
): Promise<AccessTokenResult> {
  const { db, broker, cipher, logger } = deps;
  return db.transaction(async (tx): Promise<AccessTokenResult> => {
    const account = await lockAccountForRefresh(tx, accountId);
    if (account === undefined) return { ok: false, reason: 'account_not_found' };
    // status before expiry: a revoked account must not hand out the token it still stores
    if (account.status !== 'active') {
      return { ok: false, reason: 'account_revoked', revokedReason: account.authRevokedReason };
    }

    // Another key id means another process owns this row — during a key rollout both run at
    // once. Declining to serve it is the only safe answer: revoking here would let a process
    // still holding the old key destroy an account that was just re-authorized under the new
    // one, and that revocation is not reversible without the user logging in again.
    if (account.tokenKeyId !== cipher.keyId) {
      logger.warn(
        { accountId: account.id, rowKeyId: account.tokenKeyId, processKeyId: cipher.keyId },
        'account is encrypted under another key, leaving it untouched',
      );
      return { ok: false, reason: 'key_unavailable' };
    }

    let refreshToken: string;
    let accessToken: string;
    try {
      refreshToken = cipher.decrypt(account.refreshTokenEnc, {
        accountId: account.id,
        field: TokenField.Refresh,
      });
      accessToken = cipher.decrypt(account.accessTokenEnc, {
        accountId: account.id,
        field: TokenField.Access,
      });
    } catch (error) {
      // the key id matches, so this is not a rollout: the ciphertext itself is unusable
      if (!(error instanceof TokenCipherError)) throw error;
      logger.warn(
        { accountId: account.id, err: errorIdentity(error) },
        'stored ciphertext failed to decrypt under its own key, revoking the account',
      );
      return revoked(tx, account, AuthRevokedReason.StorageInconsistent);
    }

    // a hash that does not match the ciphertext means storage disagrees with itself; the safe
    // reading is that the pair is not ours to use
    if (account.refreshTokenHash !== null && account.refreshTokenHash !== hashToken(refreshToken)) {
      return revoked(tx, account, AuthRevokedReason.StorageInconsistent);
    }

    if (account.accessTokenExpiresAt.getTime() > Date.now() + ACCESS_SKEW_MS) {
      // a row linked before the hash column existed gets it filled in here, under the lock.
      // Only the hash: token_rotated_at dates the refresh token, and moving it would give a
      // token that is already months old another ninety days of life.
      if (account.refreshTokenHash === null) {
        await backfillRefreshTokenHash(tx, account.id, hashToken(refreshToken));
      }
      return { ok: true, accessToken };
    }

    const rotatedAt = account.tokenRotatedAt ?? account.createdAt;
    if (rotatedAt.getTime() < Date.now() - REFRESH_MAX_AGE_MS) {
      return revoked(tx, account, AuthRevokedReason.RefreshExpired);
    }

    let tokens;
    try {
      tokens = await broker.refresh({ refreshToken });
    } catch (error) {
      const reason = revocationReasonFor(error);
      logger.warn(
        { accountId: account.id, reason, err: errorIdentity(error) },
        'broker refresh failed, revoking the account',
      );
      return revoked(tx, account, reason);
    }

    // the pair must belong to the account that asked for it: applying a foreign one would let
    // this account act as another broker user
    if (tokens.user.id !== account.brokerUserId) {
      logger.error(
        { accountId: account.id, expected: account.brokerUserId, received: tokens.user.id },
        'broker returned a pair for another user, revoking the account',
      );
      return revoked(tx, account, AuthRevokedReason.StorageInconsistent);
    }

    try {
      await applyRotatedTokens(tx, { account, tokens, cipher });
    } catch (error) {
      // the broker has consumed the old token and this transaction can no longer write:
      // everything after a failed statement in it is rejected, revocation included
      throw new RotatedTokensLost(account.id, error);
    }
    return { ok: true, accessToken: tokens.accessToken };
  });
}

// Second transaction, because the first one died holding the only copy of a pair the broker
// has already rotated: the stored token is now the family's old member and presenting it again
// is the replay this flow must never perform.
async function abandonLostPair(
  deps: TokenServiceDeps,
  lost: RotatedTokensLost,
): Promise<AccessTokenResult> {
  const reason = AuthRevokedReason.RefreshOutcomeUnknown;
  deps.logger.error(
    { accountId: lost.accountId, err: errorIdentity(lost.failure) },
    'storing the rotated pair failed, revoking the account in a second transaction',
  );
  try {
    await deps.db.transaction((tx) => revokeAccount(tx, lost.accountId, reason));
  } catch (error) {
    // the account stays active holding a token the broker will refuse: the next refresh gets
    // invalid_grant and revokes it there
    deps.logger.error(
      { accountId: lost.accountId, err: errorIdentity(error) },
      'the account could not be revoked after the rotated pair was lost',
    );
    throw lost.failure;
  }
  return { ok: false, reason: 'account_revoked', revokedReason: reason };
}

async function revoked(
  tx: Tx,
  account: BrokerAccountRow,
  reason: AuthRevokedReason,
): Promise<AccessTokenResult> {
  await revokeAccount(tx, account.id, reason);
  return { ok: false, reason: 'account_revoked', revokedReason: reason };
}

// An unknown outcome is treated as a consumed token: the broker may have rotated the pair
// before the connection died, and presenting the old one again is the replay we must avoid.
function revocationReasonFor(error: unknown): AuthRevokedReason {
  if (error instanceof BrokerOAuthError && error.code === BrokerOAuthErrorCode.InvalidGrant) {
    return AuthRevokedReason.RefreshInvalidGrant;
  }
  return AuthRevokedReason.RefreshOutcomeUnknown;
}
