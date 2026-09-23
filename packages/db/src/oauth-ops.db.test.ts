import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRevokedReason, type OAuthTokens } from '@binarius/shared';
import { createTempDatabase, seedUser, type TempDatabase } from './testing';
import { createTokenCipher, TokenField } from './crypto';
import {
  applyRotatedTokens,
  consumeOAuthState,
  createOAuthState,
  hashToken,
  isRefreshTokenExpired,
  linkBrokerAccount,
  lockAccountForRefresh,
  revokeAccount,
  toBrokerAccountView,
} from './oauth-ops';
import { brokerAccounts, oauthStates, users } from './schema/index';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for packages/db integration tests (see README)');
}

const cipher = createTokenCipher({ keyId: 'test-key', key: randomBytes(32) });
const REDIRECT_URI = 'https://example.test/oauth/callback';
const STATE_TTL_MS = 600_000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

let seq = 0;
const brokerTokens = (patch: Partial<OAuthTokens> = {}): OAuthTokens => {
  const n = ++seq;
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    tokenType: 'Bearer',
    expiresInSec: 7 * 24 * 60 * 60,
    user: { id: `broker-${n}`, email: `user${n}@example.test`, isPartnerClient: false },
    ...patch,
  };
};

const accountRow = async (id: string) =>
  (await tmp.db.select().from(brokerAccounts).where(eq(brokerAccounts.id, id)))[0]!;

const startState = (telegramUserId: bigint) =>
  createOAuthState(tmp.db, { telegramUserId, redirectUri: REDIRECT_URI, ttlMs: STATE_TTL_MS });

// both timestamps move: oauth_states_expires_after_created_check forbids a row that expired
// before it existed, so backdating only expires_at would be rejected — correctly
const expire = (state: string) =>
  tmp.db
    .update(oauthStates)
    .set({
      createdAt: sql`now() - interval '2 hours'`,
      expiresAt: sql`now() - interval '1 hour'`,
    })
    .where(eq(oauthStates.stateHash, hashToken(state)));

describe('createOAuthState', () => {
  it('returns the state to the caller and stores only its hash', async () => {
    const { state, expiresAt } = await startState(700_001n);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const rows = await tmp.db
      .select({ stateHash: oauthStates.stateHash })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, hashToken(state)));
    expect(rows).toHaveLength(1);
    const raw = await tmp.db
      .select({ id: oauthStates.id })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, state));
    expect(raw).toEqual([]);
  });

  it('reaps expired rows and leaves live ones alone', async () => {
    const live = await startState(700_002n);
    const stale = await startState(700_003n);
    await expire(stale.state);

    await startState(700_004n);

    const remaining = await tmp.db.select({ stateHash: oauthStates.stateHash }).from(oauthStates);
    const hashes = remaining.map((r) => r.stateHash);
    expect(hashes).toContain(hashToken(live.state));
    expect(hashes).not.toContain(hashToken(stale.state));
  });
});

describe('consumeOAuthState', () => {
  it('returns the row data once and refuses every later attempt', async () => {
    const { state } = await startState(700_010n);
    expect(await consumeOAuthState(tmp.db, state)).toEqual({
      telegramUserId: 700_010n,
      redirectUri: REDIRECT_URI,
    });
    expect(await consumeOAuthState(tmp.db, state)).toBeUndefined();
  });

  it('refuses an expired or unknown state', async () => {
    const { state } = await startState(700_011n);
    await expire(state);
    expect(await consumeOAuthState(tmp.db, state)).toBeUndefined();
    expect(await consumeOAuthState(tmp.db, 'never-issued')).toBeUndefined();
  });

  it('lets exactly one of two parallel consumers win', async () => {
    const { state } = await startState(700_012n);
    const results = await Promise.all([
      consumeOAuthState(tmp.db, state),
      consumeOAuthState(tmp.db, state),
      consumeOAuthState(tmp.db, state),
    ]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });
});

describe('linkBrokerAccount', () => {
  it('creates the user and the account, and the tokens decrypt under the stored id', async () => {
    const tokens = brokerTokens();
    const result = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_020n,
      tokens,
      cipher,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await accountRow(result.account.id);
    expect(row).toMatchObject({
      brokerUserId: tokens.user.id,
      email: tokens.user.email,
      isPartnerClient: false,
      status: 'active',
      authRevokedReason: null,
      refreshTokenHash: hashToken(tokens.refreshToken),
    });
    expect(row.tokenRotatedAt).toBeInstanceOf(Date);
    expect(row.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(
      cipher.decrypt(row.accessTokenEnc, { accountId: row.id, field: TokenField.Access }),
    ).toBe(tokens.accessToken);
    expect(
      cipher.decrypt(row.refreshTokenEnc, { accountId: row.id, field: TokenField.Refresh }),
    ).toBe(tokens.refreshToken);
  });

  it('updates the same row on a repeated login and keeps the tokens decryptable', async () => {
    const first = brokerTokens();
    const created = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_021n,
      tokens: first,
      cipher,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const second = brokerTokens({ user: first.user });
    const again = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_021n,
      tokens: second,
      cipher,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.account.id).toBe(created.account.id);

    const row = await accountRow(again.account.id);
    expect(
      cipher.decrypt(row.accessTokenEnc, { accountId: row.id, field: TokenField.Access }),
    ).toBe(second.accessToken);
    expect(row.refreshTokenHash).toBe(hashToken(second.refreshToken));
    expect(
      await tmp.db
        .select()
        .from(brokerAccounts)
        .where(eq(brokerAccounts.userId, created.account.userId)),
    ).toHaveLength(1);
  });

  it('clears an OAuth revocation but never the trading halt', async () => {
    const tokens = brokerTokens();
    const created = await linkBrokerAccount(tmp.db, { telegramUserId: 700_022n, tokens, cipher });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await tmp.db
      .update(brokerAccounts)
      .set({
        status: 'revoked',
        authRevokedReason: AuthRevokedReason.RefreshInvalidGrant,
        tradingHalted: true,
        haltedReason: 'ambiguous reconciliation match',
      })
      .where(eq(brokerAccounts.id, created.account.id));

    const again = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_022n,
      tokens: brokerTokens({ user: tokens.user }),
      cipher,
    });
    expect(again.ok).toBe(true);
    const row = await accountRow(created.account.id);
    expect(row).toMatchObject({
      status: 'active',
      authRevokedReason: null,
      tradingHalted: true,
      haltedReason: 'ambiguous reconciliation match',
    });
  });

  it('refuses an account that belongs to another telegram user', async () => {
    const tokens = brokerTokens();
    expect((await linkBrokerAccount(tmp.db, { telegramUserId: 700_023n, tokens, cipher })).ok).toBe(
      true,
    );
    const stolen = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_024n,
      tokens: brokerTokens({ user: tokens.user }),
      cipher,
    });
    expect(stolen).toEqual({ ok: false, reason: 'broker_account_taken' });
  });

  it('refuses a blocked user and does not unblock them', async () => {
    const blocked = await seedUser(tmp.db, { status: 'blocked' });
    const result = await linkBrokerAccount(tmp.db, {
      telegramUserId: BigInt(blocked.telegramUserId),
      tokens: brokerTokens(),
      cipher,
    });
    expect(result).toEqual({ ok: false, reason: 'user_blocked' });
    const [row] = await tmp.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, blocked.userId));
    expect(row?.status).toBe('blocked');
    expect(
      await tmp.db.select().from(brokerAccounts).where(eq(brokerAccounts.userId, blocked.userId)),
    ).toEqual([]);
  });

  it('lets exactly one of two users claim the same broker account concurrently', async () => {
    const shared = brokerTokens().user;
    const results = await Promise.all([
      linkBrokerAccount(tmp.db, {
        telegramUserId: 700_025n,
        tokens: brokerTokens({ user: shared }),
        cipher,
      }),
      linkBrokerAccount(tmp.db, {
        telegramUserId: 700_026n,
        tokens: brokerTokens({ user: shared }),
        cipher,
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'broker_account_taken')).toHaveLength(1);
  });

  it('allows a second broker account for the same user', async () => {
    const first = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_027n,
      tokens: brokerTokens(),
      cipher,
    });
    const second = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_027n,
      tokens: brokerTokens(),
      cipher,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.account.id).not.toBe(first.account.id);
    expect(second.account.userId).toBe(first.account.userId);
  });
});

describe('refresh helpers', () => {
  it('rotates tokens under the row id and records the new hash', async () => {
    const created = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_030n,
      tokens: brokerTokens(),
      cipher,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rotated = brokerTokens();

    await tmp.db.transaction(async (tx) => {
      const locked = await lockAccountForRefresh(tx, created.account.id);
      expect(locked).toBeDefined();
      await applyRotatedTokens(tx, { account: locked!, tokens: rotated, cipher });
    });

    const row = await accountRow(created.account.id);
    expect(
      cipher.decrypt(row.refreshTokenEnc, { accountId: row.id, field: TokenField.Refresh }),
    ).toBe(rotated.refreshToken);
    expect(row.refreshTokenHash).toBe(hashToken(rotated.refreshToken));
  });

  it('revokes with a reason and leaves the trading halt untouched', async () => {
    const created = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_031n,
      tokens: brokerTokens(),
      cipher,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await tmp.db.transaction((tx) =>
      revokeAccount(tx, created.account.id, AuthRevokedReason.RefreshOutcomeUnknown),
    );
    expect(await accountRow(created.account.id)).toMatchObject({
      status: 'revoked',
      authRevokedReason: 'refresh_outcome_unknown',
      tradingHalted: false,
      haltedReason: null,
    });
  });

  it('measures the refresh age from the rotation, or from the row when it never rotated', async () => {
    const created = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_032n,
      tokens: brokerTokens(),
      cipher,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await isRefreshTokenExpired(tmp.db, created.account.id, NINETY_DAYS_MS)).toBe(false);

    await tmp.db
      .update(brokerAccounts)
      .set({ tokenRotatedAt: sql`now() - interval '91 days'` })
      .where(eq(brokerAccounts.id, created.account.id));
    expect(await isRefreshTokenExpired(tmp.db, created.account.id, NINETY_DAYS_MS)).toBe(true);

    // a legacy row that never rotated falls back to created_at
    await tmp.db
      .update(brokerAccounts)
      .set({ tokenRotatedAt: null, createdAt: sql`now() - interval '91 days'` })
      .where(eq(brokerAccounts.id, created.account.id));
    expect(await isRefreshTokenExpired(tmp.db, created.account.id, NINETY_DAYS_MS)).toBe(true);
  });
});

describe('toBrokerAccountView', () => {
  it('exposes exactly the six public fields', async () => {
    const created = await linkBrokerAccount(tmp.db, {
      telegramUserId: 700_040n,
      tokens: brokerTokens(),
      cipher,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const view = toBrokerAccountView(created.account);
    expect(Object.keys(view).sort()).toEqual([
      'brokerUserId',
      'createdAt',
      'email',
      'id',
      'isPartnerClient',
      'status',
    ]);
    expect(JSON.stringify(view)).not.toContain('Enc');
  });
});
