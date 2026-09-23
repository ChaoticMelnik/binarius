import type { FastifyBaseLogger } from 'fastify';
import { AuthRevokedReason } from '@binarius/shared';
import {
  applyRotatedTokens,
  hashToken,
  lockAccountForRefresh,
  revokeAccount,
  type Db,
  type TokenCipher,
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
  | { ok: false; reason: 'account_revoked'; revokedReason: AuthRevokedReason | null };

export interface TokenServiceDeps {
  db: Db;
  broker: BrokerOAuthClient;
  cipher: TokenCipher;
  logger: FastifyBaseLogger;
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
  const { db, broker, cipher, logger } = deps;
  return db.transaction(async (tx): Promise<AccessTokenResult> => {
    const account = await lockAccountForRefresh(tx, accountId);
    if (account === undefined) return { ok: false, reason: 'account_not_found' };
    // status before expiry: a revoked account must not hand out the token it still stores
    if (account.status !== 'active') {
      return { ok: false, reason: 'account_revoked', revokedReason: account.authRevokedReason };
    }

    const refreshToken = cipher.decrypt(account.refreshTokenEnc, {
      accountId: account.id,
      field: TokenField.Refresh,
    });
    // a hash that does not match the ciphertext means storage disagrees with itself; the safe
    // reading is that the pair is not ours to use
    if (account.refreshTokenHash !== null && account.refreshTokenHash !== hashToken(refreshToken)) {
      await revokeAccount(tx, account.id, AuthRevokedReason.StorageInconsistent);
      return {
        ok: false,
        reason: 'account_revoked',
        revokedReason: AuthRevokedReason.StorageInconsistent,
      };
    }

    if (account.accessTokenExpiresAt.getTime() > Date.now() + ACCESS_SKEW_MS) {
      // a row linked before the hash column existed gets it filled in here, under the lock
      if (account.refreshTokenHash === null) {
        await applyRotatedTokens(tx, {
          account,
          tokens: {
            accessToken: cipher.decrypt(account.accessTokenEnc, {
              accountId: account.id,
              field: TokenField.Access,
            }),
            refreshToken,
            tokenType: 'Bearer',
            expiresInSec: Math.max(
              1,
              Math.floor((account.accessTokenExpiresAt.getTime() - Date.now()) / 1000),
            ),
            user: {
              id: account.brokerUserId,
              email: account.email ?? '',
              isPartnerClient: account.isPartnerClient,
            },
          },
          cipher,
        });
      }
      return {
        ok: true,
        accessToken: cipher.decrypt(account.accessTokenEnc, {
          accountId: account.id,
          field: TokenField.Access,
        }),
      };
    }

    const rotatedAt = account.tokenRotatedAt ?? account.createdAt;
    if (rotatedAt.getTime() < Date.now() - REFRESH_MAX_AGE_MS) {
      await revokeAccount(tx, account.id, AuthRevokedReason.RefreshExpired);
      return {
        ok: false,
        reason: 'account_revoked',
        revokedReason: AuthRevokedReason.RefreshExpired,
      };
    }

    try {
      const tokens = await broker.refresh({ refreshToken });
      await applyRotatedTokens(tx, { account, tokens, cipher });
      return { ok: true, accessToken: tokens.accessToken };
    } catch (error) {
      const reason = revocationReasonFor(error);
      logger.warn(
        { accountId: account.id, reason, err: errorIdentity(error) },
        'broker refresh failed, revoking the account',
      );
      await revokeAccount(tx, account.id, reason);
      return { ok: false, reason: 'account_revoked', revokedReason: reason };
    }
  });
}

// An unknown outcome is treated as a consumed token: the broker may have rotated the pair
// before the connection died, and presenting the old one again is the replay we must avoid.
function revocationReasonFor(error: unknown): AuthRevokedReason {
  if (error instanceof BrokerOAuthError && error.code === BrokerOAuthErrorCode.InvalidGrant) {
    return AuthRevokedReason.RefreshInvalidGrant;
  }
  return AuthRevokedReason.RefreshOutcomeUnknown;
}

// name and code only: a client error's message can carry a header or a response body
function errorIdentity(error: unknown): { name: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { name, code } : { name };
}
