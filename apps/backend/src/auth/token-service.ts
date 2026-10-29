import type { FastifyBaseLogger } from 'fastify';
import {
  ACCESS_SKEW_MS,
  AuthRevokedReason,
  BrokerAccountStatus,
  UserStatus,
  assertExhausted,
  errorLogFields,
} from '@binarius/shared';
import {
  applyRotatedTokens,
  backfillRefreshTokenHash,
  hashToken,
  lockAccountForRefresh,
  markAccessTokenExpired,
  readAccountForToken,
  readUserStatus,
  revokeAccount,
  revokeAccountIfUnchanged,
  TokenCipherError,
  type Db,
  type BrokerAccountRow,
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

export type AccessTokenResult =
  // brokerUserId: the account row's, read with the token (#868)
  | { ok: true; accessToken: string; brokerUserId: string }
  | { ok: false; reason: 'account_not_found' }
  // blocked under the lock: nothing decrypted, exchanged or revoked; blocked by the time the
  // exchange answered: the rotated pair is stored (the old one is spent), no token handed out,
  // nothing revoked (Rule 12)
  | { ok: false; reason: 'user_blocked' }
  // linked but not confirmed in the bot yet, so it may not act on the user's behalf
  | { ok: false; reason: 'account_pending' }
  // the row was encrypted under a key this process does not hold; another process has it
  | { ok: false; reason: 'key_unavailable' }
  // the token needs an exchange and the caller forbade one (mayRefresh: false): it expired, or
  // the stored token was just marked expired on the caller's report (#281)
  | { ok: false; reason: 'refresh_needed' }
  // the broker's rate limit refused the exchange before acting: the pair is intact, nothing
  // written (#275)
  | { ok: false; reason: 'refresh_rate_limited' }
  // serviceOnly and the row is not a service account (#391): nothing decrypted or written
  | { ok: false; reason: 'not_service' }
  | { ok: false; reason: 'account_revoked'; revokedReason: AuthRevokedReason | null };

export interface TokenServiceDeps {
  db: Db;
  broker: BrokerOAuthClient;
  cipher: TokenCipher;
  logger: FastifyBaseLogger;
}

// What the caller was holding once the stored pair stopped being reliably ours: either the broker
// rotated it, or the outcome is unknown and it may have. Everything that fails from that moment
// on — including the COMMIT — has to leave the account revoked rather than holding a spent token.
interface ExchangedPair {
  accountId: string;
  refreshTokenHash: string | null;
}

export interface AccessTokenOptions {
  // false: never exchange the refresh token here, and never revoke for its age either — a caller
  // nobody is waiting on (the background balance refresh) must not change the account. Decided
  // on the fast read and under the row lock, by the same clock and comparison as the exchange
  // itself.
  mayRefresh?: boolean;
  // sha256 (hashToken) of an access token the broker refused. Compared with the stored token
  // under the row lock: a match marks it expired and the decision goes on as for an expired
  // token; another token means someone already rotated the pair, and the stored one is returned
  // (#281)
  refusedToken?: string | undefined;
  // Both read only when mayRefresh is not false (#391, docs/service-accounts.md).
  // serviceOnly: the row must be a service account (service_since set), checked on the fast read
  // and under the row lock; any other row is refused with not_service before anything is decrypted. This is what
  // keeps a timer's exchange to the service accounts alone (Rule 12's exception).
  serviceOnly?: true;
  // how long before its expiry a token is exchanged, in place of ACCESS_SKEW_MS
  renewAheadMs?: number;
}

// Returns a usable access token for the account, refreshing it when needed (docs/binodex-oauth.md
// -> Refresh, The fast path and the flights).
//
// A valid token with nothing to write is served by one statement, without a transaction or a
// lock. Anything else is decided under the account's row lock, which makes an exchange
// single-flight across processes; within this process one caller per account at a time goes
// there (its flight), and a caller that finds a flight waits for it and then decides again on
// its own read, never taking the flight's result: the policies differ, and after an exchange its
// own read finds the fresh token without the lock. Revocation is committed by the transaction and
// only then reported — throwing inside it would roll the revocation back.
//
// A fast hit is returned only when no flight of the account runs at the start of the read or at
// its end: a flight replaces the token it read, and its transaction is not committed while the
// read runs. Nothing awaits between the second check and runFlight, which registers its flight
// before its first await.
export async function ensureFreshAccessToken(
  deps: TokenServiceDeps,
  accountId: string,
  options: AccessTokenOptions = {},
): Promise<AccessTokenResult> {
  for (;;) {
    const running = flights.get(accountId);
    if (running !== undefined) {
      await running;
      continue;
    }
    // a refused token always goes under the lock: it may mark the stored one expired
    const fast =
      options.refusedToken === undefined
        ? await readStoredToken(deps, accountId, options)
        : undefined;
    const begun = flights.get(accountId);
    if (begun !== undefined) {
      await begun;
      continue;
    }
    if (fast !== undefined) return fast;
    return runFlight(deps, accountId, options);
  }
}

// One entry per account while its flight runs. The stored promise never rejects: a throw reaches
// the flight's own caller, and the callers waiting on it decide again.
const flights = new Map<string, Promise<void>>();
const noop = (): void => {};

async function runFlight(
  deps: TokenServiceDeps,
  accountId: string,
  options: AccessTokenOptions,
): Promise<AccessTokenResult> {
  const run = decideUnderLock(deps, accountId, options);
  flights.set(accountId, run.then(noop, noop));
  try {
    return await run;
  } finally {
    flights.delete(accountId);
  }
}

// The same checks in the same order as refreshUnderLock, up to the first that needs a write or
// the lock; undefined is a miss, and the path under the lock gives the answer. Only a valid token
// is answered here, so every refusal and every write stays under the lock.
async function readStoredToken(
  deps: TokenServiceDeps,
  accountId: string,
  options: AccessTokenOptions,
): Promise<AccessTokenResult | undefined> {
  const { cipher } = deps;
  const account = await readAccountForToken(deps.db, accountId);
  if (
    account === undefined ||
    account.userStatus === UserStatus.Blocked ||
    account.status !== BrokerAccountStatus.Active ||
    notService(account, options) ||
    account.tokenKeyId !== cipher.keyId ||
    // a row linked before the hash column existed gets it filled in under the lock
    account.refreshTokenHash === null
  ) {
    return undefined;
  }
  // a ciphertext that fails to decrypt is revoked under the lock, which also logs it
  const refreshToken = decryptOrUndefined(cipher, account, TokenField.Refresh);
  if (refreshToken === undefined || hashToken(refreshToken) !== account.refreshTokenHash) {
    return undefined;
  }
  if (account.accessTokenExpiresAt.getTime() <= Date.now() + renewAheadOf(options)) {
    return undefined;
  }
  const accessToken = decryptOrUndefined(cipher, account, TokenField.Access);
  if (accessToken === undefined) return undefined;
  return { ok: true, accessToken, brokerUserId: account.brokerUserId };
}

function decryptOrUndefined(
  cipher: TokenCipher,
  account: BrokerAccountRow,
  field: TokenField,
): string | undefined {
  try {
    return cipher.decrypt(
      field === TokenField.Refresh ? account.refreshTokenEnc : account.accessTokenEnc,
      { accountId: account.id, field },
    );
  } catch (error) {
    if (!(error instanceof TokenCipherError)) throw error;
    return undefined;
  }
}

function notService(account: BrokerAccountRow, options: AccessTokenOptions): boolean {
  return (
    options.mayRefresh !== false && options.serviceOnly === true && account.serviceSince === null
  );
}

function renewAheadOf(options: AccessTokenOptions): number {
  return options.mayRefresh === false ? ACCESS_SKEW_MS : (options.renewAheadMs ?? ACCESS_SKEW_MS);
}

async function decideUnderLock(
  deps: TokenServiceDeps,
  accountId: string,
  options: AccessTokenOptions,
): Promise<AccessTokenResult> {
  // set inside the transaction, read after it: the exchange is the point of no return, and a
  // failure raised by the COMMIT itself is never visible to code running inside the callback
  let exchanged: ExchangedPair | undefined;
  try {
    return await deps.db.transaction((tx) =>
      refreshUnderLock(deps, tx, accountId, options, (pair) => {
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
  options: AccessTokenOptions,
  onExchanged: (pair: ExchangedPair) => void,
): Promise<AccessTokenResult> {
  const { broker, cipher, logger } = deps;
  const account = await lockAccountForRefresh(tx, accountId);
  if (account === undefined) return { ok: false, reason: 'account_not_found' };
  if (account.userStatus === UserStatus.Blocked) return { ok: false, reason: 'user_blocked' };
  // status before expiry: an account that may not act must not hand out the token it stores
  if (account.status === BrokerAccountStatus.Pending) {
    return { ok: false, reason: 'account_pending' };
  }
  if (account.status !== BrokerAccountStatus.Active) {
    return { ok: false, reason: 'account_revoked', revokedReason: account.authRevokedReason };
  }
  if (notService(account, options)) return { ok: false, reason: 'not_service' };

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
      { accountId: account.id, ...errorLogFields(error) },
      'stored ciphertext failed to decrypt under its own key, revoking the account',
    );
    return revoked(tx, account.id, AuthRevokedReason.StorageInconsistent);
  }

  // a hash that does not match the ciphertext means storage disagrees with itself; the safe
  // reading is that the pair is not ours to use
  if (account.refreshTokenHash !== null && account.refreshTokenHash !== hashToken(refreshToken)) {
    return revoked(tx, account.id, AuthRevokedReason.StorageInconsistent);
  }

  if (account.accessTokenExpiresAt.getTime() > Date.now() + renewAheadOf(options)) {
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
        { accountId: account.id, ...errorLogFields(error) },
        'stored access ciphertext failed to decrypt under its own key, revoking the account',
      );
      return revoked(tx, account.id, AuthRevokedReason.StorageInconsistent);
    }
    const refused =
      options.refusedToken !== undefined && hashToken(accessToken) === options.refusedToken;
    if (refused) {
      logger.warn(
        { accountId: account.id, mayRefresh: options.mayRefresh !== false },
        'broker refused the stored access token, marking it expired',
      );
      await markAccessTokenExpired(tx, account.id);
    } else {
      // a row linked before the hash column existed gets it filled in here, under the lock.
      // Only the hash: token_rotated_at dates the refresh token, and moving it would give a
      // token that is already months old another ninety days of life.
      if (account.refreshTokenHash === null) {
        await backfillRefreshTokenHash(tx, account.id, hashToken(refreshToken));
      }
      return { ok: true, accessToken, brokerUserId: account.brokerUserId };
    }
  }

  if (options.mayRefresh === false) return { ok: false, reason: 'refresh_needed' };

  const rotatedAt = account.tokenRotatedAt ?? account.createdAt;
  if (rotatedAt.getTime() < Date.now() - REFRESH_MAX_AGE_MS) {
    return revoked(tx, account.id, AuthRevokedReason.RefreshExpired);
  }

  const heldPair: ExchangedPair = {
    accountId: account.id,
    refreshTokenHash: account.refreshTokenHash,
  };
  let tokens;
  try {
    tokens = await broker.refresh({ refreshToken });
  } catch (error) {
    // refused before the broker read the token: the pair is not spent, so the account stays
    // active and the next caller exchanges the same pair (#275)
    if (error instanceof BrokerOAuthError && error.code === BrokerOAuthErrorCode.RateLimited) {
      logger.warn(
        { accountId: account.id, ...errorLogFields(error) },
        'broker refresh rate limited, keeping the pair',
      );
      return { ok: false, reason: 'refresh_rate_limited' };
    }
    const reason = revocationReasonFor(error);
    if (pairMayBeSpent(reason)) onExchanged(heldPair);
    logger.warn(
      { accountId: account.id, reason, ...errorLogFields(error) },
      'broker refresh failed, revoking the account',
    );
    return revoked(tx, account.id, reason);
  }
  onExchanged(heldPair);

  // The refresh answer names no user. The pair is ours because the token we presented is: it was
  // decrypted from this account's row (the row id is in the AAD) and matched the stored hash, and
  // the answer goes back into the same locked row.
  await applyRotatedTokens(tx, { account, tokens, cipher });
  // the exchange can take up to BROKER_HTTP_TIMEOUT_MS under the lock; a block committed
  // meanwhile is caught here, after the pair is stored, because the old one is already spent
  if ((await readUserStatus(tx, account.userId)) === UserStatus.Blocked) {
    return { ok: false, reason: 'user_blocked' };
  }
  return { ok: true, accessToken: tokens.accessToken, brokerUserId: account.brokerUserId };
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
    { accountId: lost.accountId, ...errorLogFields(failure) },
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
      { accountId: lost.accountId, ...errorLogFields(error) },
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
// before the connection died, and presenting the old one again is the replay we must avoid. A
// 429 never gets here: it is refused before the broker acted (#275).
function revocationReasonFor(error: unknown): AuthRevokedReason {
  if (error instanceof BrokerOAuthError && error.code === BrokerOAuthErrorCode.InvalidGrant) {
    return AuthRevokedReason.RefreshInvalidGrant;
  }
  return AuthRevokedReason.RefreshOutcomeUnknown;
}

// Whether the stored pair may already have been consumed, which is what decides if a failure
// after this point has to survive the transaction dying. Exhaustive on purpose: a new reason
// has to break the build rather than fall silently to either side. Neither `=== unknown` nor
// `!== invalid_grant` would do — the first drops a new reason out of the recovery, the second
// drags in one that may prove the token never left.
function pairMayBeSpent(reason: AuthRevokedReason): boolean {
  switch (reason) {
    // the broker answered, refusing the grant: nothing was rotated
    case AuthRevokedReason.RefreshInvalidGrant:
      return false;
    // storage was already wrong, or the token aged out unused: the broker never saw it
    case AuthRevokedReason.StorageInconsistent:
    case AuthRevokedReason.RefreshExpired:
      return false;
    // no answer at all: the broker may have rotated the pair before the connection died
    case AuthRevokedReason.RefreshOutcomeUnknown:
      return true;
    default:
      return assertExhausted(reason, 'revocation reason');
  }
}
