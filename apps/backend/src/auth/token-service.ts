import type { FastifyBaseLogger } from 'fastify';
import { AuthRevokedReason, errorIdentity } from '@binarius/shared';
import {
  applyRotatedTokens,
  backfillRefreshTokenHash,
  BrokerAccountStatus,
  hashToken,
  lockAccountForRefresh,
  revokeAccount,
  revokeAccountIfUnchanged,
  TokenCipherError,
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
const REFRESH_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
// renew a little before expiry, so a token handed out now is still valid when it is used
const ACCESS_SKEW_MS = 60_000;

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'account_not_found' }
  // linked but not confirmed in the bot yet, so it may not act on the user's behalf
  | { ok: false; reason: 'account_pending' }
  // the row was encrypted under a key this process does not hold; another process has it
  | { ok: false; reason: 'key_unavailable' }
  | { ok: false; reason: 'account_revoked'; revokedReason: AuthRevokedReason | null };

export interface TokenServiceDeps {
  db: Db;
  broker: BrokerOAuthClient;
  cipher: TokenCipher;
  logger: FastifyBaseLogger;
}

// What the caller was holding when the broker rotated the pair. Everything that fails from that
// moment on — including the COMMIT — means the stored token is spent and its replacement is gone.
interface ExchangedPair {
  accountId: string;
  refreshTokenHash: string | null;
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
  // set inside the transaction, read after it: the exchange is the point of no return, and a
  // failure raised by the COMMIT itself is never visible to code running inside the callback
  let exchanged: ExchangedPair | undefined;
  try {
    return await deps.db.transaction((tx) =>
      refreshUnderLock(deps, tx, accountId, (pair) => {
        exchanged = pair;
      }),
    );
  } catch (error) {
    if (exchanged === undefined) throw error;
    return abandonLostPair(deps, exchanged, error);
  }
}

async function refreshUnderLock(
  deps: TokenServiceDeps,
  tx: Tx,
  accountId: string,
  onExchanged: (pair: ExchangedPair) => void,
): Promise<AccessTokenResult> {
  const { broker, cipher, logger } = deps;
  const account = await lockAccountForRefresh(tx, accountId);
  if (account === undefined) return { ok: false, reason: 'account_not_found' };
  // status before expiry: an account that may not act must not hand out the token it stores
  if (account.status === BrokerAccountStatus.Pending) {
    return { ok: false, reason: 'account_pending' };
  }
  if (account.status !== BrokerAccountStatus.Active) {
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
  try {
    refreshToken = cipher.decrypt(account.refreshTokenEnc, {
      accountId: account.id,
      field: TokenField.Refresh,
    });
  } catch (error) {
    // the key id matches, so this is not a rollout: the ciphertext itself is unusable
    if (!(error instanceof TokenCipherError)) throw error;
    logger.warn(
      { accountId: account.id, err: errorIdentity(error) },
      'stored ciphertext failed to decrypt under its own key, revoking the account',
    );
    return revoked(tx, account.id, AuthRevokedReason.StorageInconsistent);
  }

  // a hash that does not match the ciphertext means storage disagrees with itself; the safe
  // reading is that the pair is not ours to use
  if (account.refreshTokenHash !== null && account.refreshTokenHash !== hashToken(refreshToken)) {
    return revoked(tx, account.id, AuthRevokedReason.StorageInconsistent);
  }

  if (account.accessTokenExpiresAt.getTime() > Date.now() + ACCESS_SKEW_MS) {
    // decrypted only on the branch that returns it: a refresh must not depend on the access
    // ciphertext, which it is about to replace anyway
    let accessToken: string;
    try {
      accessToken = cipher.decrypt(account.accessTokenEnc, {
        accountId: account.id,
        field: TokenField.Access,
      });
    } catch (error) {
      if (!(error instanceof TokenCipherError)) throw error;
      logger.warn(
        { accountId: account.id, err: errorIdentity(error) },
        'stored access ciphertext failed to decrypt under its own key, revoking the account',
      );
      return revoked(tx, account.id, AuthRevokedReason.StorageInconsistent);
    }
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
    return revoked(tx, account.id, AuthRevokedReason.RefreshExpired);
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
    return revoked(tx, account.id, reason);
  }
  onExchanged({ accountId: account.id, refreshTokenHash: account.refreshTokenHash });

  // the pair must belong to the account that asked for it: applying a foreign one would let
  // this account act as another broker user
  if (tokens.user.id !== account.brokerUserId) {
    logger.error(
      { accountId: account.id, expected: account.brokerUserId, received: tokens.user.id },
      'broker returned a pair for another user, revoking the account',
    );
    return revoked(tx, account.id, AuthRevokedReason.StorageInconsistent);
  }

  await applyRotatedTokens(tx, { account, tokens, cipher });
  return { ok: true, accessToken: tokens.accessToken };
}

// Second transaction, because the first one is gone: it rolled back holding the only copy of a
// pair the broker has already rotated. The stored token is now the family's old member, and
// presenting it again is the replay this flow must never perform.
async function abandonLostPair(
  deps: TokenServiceDeps,
  lost: ExchangedPair,
  failure: unknown,
): Promise<AccessTokenResult> {
  const reason = AuthRevokedReason.RefreshOutcomeUnknown;
  deps.logger.error(
    { accountId: lost.accountId, err: errorIdentity(failure) },
    'storing the rotated pair failed, revoking the account in a second transaction',
  );
  let result;
  try {
    result = await deps.db.transaction((tx) =>
      revokeAccountIfUnchanged(tx, {
        accountId: lost.accountId,
        refreshTokenHash: lost.refreshTokenHash,
        reason,
      }),
    );
  } catch (error) {
    // the account stays active holding a token the broker will refuse: the next refresh gets
    // invalid_grant and revokes it there
    deps.logger.error(
      { accountId: lost.accountId, err: errorIdentity(error) },
      'the account could not be revoked after the rotated pair was lost',
    );
    throw failure;
  }

  switch (result.outcome) {
    case 'revoked':
      return { ok: false, reason: 'account_revoked', revokedReason: reason };
    case 'already_revoked':
      return { ok: false, reason: 'account_revoked', revokedReason: result.reason };
    case 'changed':
      // the row now holds a pair we never saw: the user logged in again, and the token we lost
      // is not the one this account depends on any more
      deps.logger.warn(
        { accountId: lost.accountId },
        'the account was re-linked while the rotated pair was being lost, leaving it alone',
      );
      throw failure;
    case 'missing':
      deps.logger.warn({ accountId: lost.accountId }, 'the account is gone, nothing to revoke');
      throw failure;
  }
}

async function revoked(
  tx: Tx,
  accountId: string,
  reason: AuthRevokedReason,
): Promise<AccessTokenResult> {
  await revokeAccount(tx, accountId, reason);
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
