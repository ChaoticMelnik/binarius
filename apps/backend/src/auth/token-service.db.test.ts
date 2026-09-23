import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  brokerAccounts,
  createTokenCipher,
  hashToken,
  linkBrokerAccount,
  TokenField,
  type BrokerAccountRow,
} from '@binarius/db';
import { createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { createBrokerOAuthClient, type BrokerOAuthClient } from '../broker/oauth-client';
import { startOAuthStub, type OAuthStub } from '../broker/testing/oauth-stub';
import { ensureFreshAccessToken, type TokenServiceDeps } from './token-service';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for apps/backend integration tests (see README)');
}

const CLIENT_ID = 'client-id';
const CLIENT_SECRET = 'client-secret-value';
const REDIRECT_URI = 'https://bot.example/oauth/callback';
const cipher = createTokenCipher({ keyId: 'test-key', key: randomBytes(32) });
const logger = Fastify({ logger: false }).log;

let tmp: TempDatabase;
let stub: OAuthStub;
let broker: BrokerOAuthClient;

beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  stub = await startOAuthStub({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
  broker = createBrokerOAuthClient({
    baseUrl: stub.url,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
});
afterAll(async () => {
  await stub.close();
  await tmp.drop();
});

const deps = (override: Partial<TokenServiceDeps> = {}): TokenServiceDeps => ({
  db: tmp.db,
  broker,
  cipher,
  logger,
  ...override,
});

let seq = 0;

// a linked account whose tokens came from the stub, so the refresh family is real
async function linkedAccount(): Promise<BrokerAccountRow> {
  const n = ++seq;
  const code = stub.issueCode({ brokerUserId: `svc-broker-${n}` });
  const tokens = await broker.exchangeCode({ code, redirectUri: REDIRECT_URI });
  const linked = await linkBrokerAccount(tmp.db, {
    telegramUserId: BigInt(900_000 + n),
    tokens,
    cipher,
  });
  if (!linked.ok) throw new Error(`link failed: ${linked.reason}`);
  return linked.account;
}

const rowOf = async (id: string) =>
  (await tmp.db.select().from(brokerAccounts).where(eq(brokerAccounts.id, id)))[0]!;

const expireAccessToken = (id: string) =>
  tmp.db
    .update(brokerAccounts)
    .set({ accessTokenExpiresAt: sql`now() - interval '1 minute'` })
    .where(eq(brokerAccounts.id, id));

describe('ensureFreshAccessToken', () => {
  it('returns the stored token while it is still valid, without calling the broker', async () => {
    const account = await linkedAccount();
    const before = stub.tokenRequests;
    const result = await ensureFreshAccessToken(deps(), account.id);
    expect(result).toEqual({
      ok: true,
      accessToken: cipher.decrypt(account.accessTokenEnc, {
        accountId: account.id,
        field: TokenField.Access,
      }),
    });
    expect(stub.tokenRequests).toBe(before);
  });

  it('rotates an expired token and stores the new pair', async () => {
    const account = await linkedAccount();
    await expireAccessToken(account.id);
    const result = await ensureFreshAccessToken(deps(), account.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await rowOf(account.id);
    expect(
      cipher.decrypt(row.accessTokenEnc, { accountId: row.id, field: TokenField.Access }),
    ).toBe(result.accessToken);
    expect(row.refreshTokenHash).toBe(
      hashToken(
        cipher.decrypt(row.refreshTokenEnc, { accountId: row.id, field: TokenField.Refresh }),
      ),
    );
    expect(row.tokenRotatedAt!.getTime()).toBeGreaterThan(account.tokenRotatedAt!.getTime() - 1);
  });

  it('checks the status before the expiry, so a revoked account never hands out its token', async () => {
    const account = await linkedAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ status: 'revoked', authRevokedReason: 'refresh_expired' })
      .where(eq(brokerAccounts.id, account.id));
    const before = stub.tokenRequests;
    expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
      ok: false,
      reason: 'account_revoked',
      revokedReason: 'refresh_expired',
    });
    expect(stub.tokenRequests).toBe(before);
  });

  it('reports a missing account', async () => {
    expect(await ensureFreshAccessToken(deps(), '00000000-0000-0000-0000-000000000000')).toEqual({
      ok: false,
      reason: 'account_not_found',
    });
  });

  // the acceptance criterion: a refresh token the broker has already rotated must revoke the
  // session instead of quietly minting another pair
  it('revokes the account when the broker refuses a replayed refresh token', async () => {
    const account = await linkedAccount();
    // rotate behind our back: the pair we stored is now the family's old member
    const stored = cipher.decrypt(account.refreshTokenEnc, {
      accountId: account.id,
      field: TokenField.Refresh,
    });
    await broker.refresh({ refreshToken: stored });
    await expireAccessToken(account.id);

    const result = await ensureFreshAccessToken(deps(), account.id);
    expect(result).toEqual({
      ok: false,
      reason: 'account_revoked',
      revokedReason: 'refresh_invalid_grant',
    });
    const row = await rowOf(account.id);
    expect(row).toMatchObject({ status: 'revoked', authRevokedReason: 'refresh_invalid_grant' });
    // the revocation survived the error: it was committed, not rolled back
    expect(
      cipher.decrypt(row.refreshTokenEnc, { accountId: row.id, field: TokenField.Refresh }),
    ).toBe(stored);
  });

  it('treats an unknown outcome as a consumed token and revokes', async () => {
    const account = await linkedAccount();
    await expireAccessToken(account.id);
    const slow = await startOAuthStub({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      delayMs: 2_000,
    });
    try {
      const impatient = createBrokerOAuthClient({
        baseUrl: slow.url,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        timeoutMs: 50,
      });
      expect(await ensureFreshAccessToken(deps({ broker: impatient }), account.id)).toEqual({
        ok: false,
        reason: 'account_revoked',
        revokedReason: 'refresh_outcome_unknown',
      });
      expect(await rowOf(account.id)).toMatchObject({
        status: 'revoked',
        authRevokedReason: 'refresh_outcome_unknown',
      });
    } finally {
      await slow.close();
    }
  });

  it('revokes a refresh token older than ninety days without asking the broker', async () => {
    const account = await linkedAccount();
    await expireAccessToken(account.id);
    await tmp.db
      .update(brokerAccounts)
      .set({ tokenRotatedAt: sql`now() - interval '91 days'` })
      .where(eq(brokerAccounts.id, account.id));

    const before = stub.tokenRequests;
    expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
      ok: false,
      reason: 'account_revoked',
      revokedReason: 'refresh_expired',
    });
    expect(stub.tokenRequests).toBe(before);
  });

  it('falls back to the row age when the account never rotated', async () => {
    const account = await linkedAccount();
    await expireAccessToken(account.id);
    await tmp.db
      .update(brokerAccounts)
      .set({ tokenRotatedAt: null, createdAt: sql`now() - interval '91 days'` })
      .where(eq(brokerAccounts.id, account.id));

    expect(await ensureFreshAccessToken(deps(), account.id)).toMatchObject({
      ok: false,
      revokedReason: 'refresh_expired',
    });
  });

  it('fills in a missing refresh hash instead of treating it as a mismatch', async () => {
    const account = await linkedAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ refreshTokenHash: null })
      .where(eq(brokerAccounts.id, account.id));

    const result = await ensureFreshAccessToken(deps(), account.id);
    expect(result.ok).toBe(true);
    const row = await rowOf(account.id);
    expect(row.refreshTokenHash).toBe(
      hashToken(
        cipher.decrypt(row.refreshTokenEnc, { accountId: row.id, field: TokenField.Refresh }),
      ),
    );
    expect(row.status).toBe('active');
  });

  it('revokes when the stored hash disagrees with the stored ciphertext', async () => {
    const account = await linkedAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ refreshTokenHash: hashToken('something-else') })
      .where(eq(brokerAccounts.id, account.id));

    expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
      ok: false,
      reason: 'account_revoked',
      revokedReason: 'storage_inconsistent',
    });
  });

  it('exchanges once when two callers race on the same account', async () => {
    const account = await linkedAccount();
    await expireAccessToken(account.id);
    const before = stub.tokenRequests;
    const [first, second] = await Promise.all([
      ensureFreshAccessToken(deps(), account.id),
      ensureFreshAccessToken(deps(), account.id),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(stub.tokenRequests).toBe(before + 1);
    if (first.ok && second.ok) expect(first.accessToken).toBe(second.accessToken);
  });
});
