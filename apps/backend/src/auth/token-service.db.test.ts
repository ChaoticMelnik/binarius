import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  brokerAccounts,
  users,
  confirmBrokerAccount,
  createTokenCipher,
  hashToken,
  linkBrokerAccount,
  TokenField,
  type BrokerAccountRow,
} from '@binarius/db';
import { brokerAccountRow, createTempDatabase, type TempDatabase } from '@binarius/db/testing';
import { until } from '@binarius/shared/testing';
import { createBrokerOAuthClient, type BrokerOAuthClient } from '../broker/oauth-client';
import { startOAuthStub, type OAuthStub } from '../broker/testing/oauth-stub';
import { ensureFreshAccessToken, type TokenServiceDeps } from './token-service';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
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

// a linked and confirmed account whose tokens came from the stub, so the refresh family is
// real: an unconfirmed one never reaches the refresh logic at all
async function linkedAccount(email?: string): Promise<BrokerAccountRow> {
  const account = await pendingAccount(email);
  const confirmed = await confirmBrokerAccount(tmp.db, {
    telegramUserId: telegramIdOf(account.id),
    accountId: account.id,
  });
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.reason}`);
  return confirmed.account;
}

const telegramIds = new Map<string, bigint>();
const telegramIdOf = (accountId: string): bigint => {
  const id = telegramIds.get(accountId);
  if (id === undefined) throw new Error(`no telegram id recorded for ${accountId}`);
  return id;
};

async function pendingAccount(email?: string): Promise<BrokerAccountRow> {
  const n = ++seq;
  const code = stub.issueCode({ brokerUserId: `svc-broker-${n}`, email });
  const tokens = await broker.exchangeCode({ code, redirectUri: REDIRECT_URI });
  const telegramUserId = BigInt(900_000 + n);
  const linked = await linkBrokerAccount(tmp.db, {
    telegramUserId,
    tokens,
    cipher,
    activate: false,
  });
  if (!linked.ok) throw new Error(`link failed: ${linked.reason}`);
  telegramIds.set(linked.account.id, telegramUserId);
  return linked.account;
}

const rowOf = (id: string) => brokerAccountRow(tmp.db, id);

// the starting point of every case that exercises the refresh path
async function expiredAccount(email?: string): Promise<BrokerAccountRow> {
  const account = await linkedAccount(email);
  await expireAccessToken(account.id);
  return account;
}

// the trigger below refuses exactly this account's rotation, which is how a write that fails
// after the broker already rotated the pair is reproduced without stubbing the database
const BLOCKED_EMAIL = 'rotation-blocked@example.test';
const COMMIT_BLOCKED_EMAIL = 'commit-blocked@example.test';
const UNKNOWN_BLOCKED_EMAIL = 'unknown-commit-blocked@example.test';

// fires at COMMIT for the revocation itself, so the transaction that recorded it dies after the
// statement succeeded — which is what makes the recovery the only thing that can save the account
const failRevokeCommit = () =>
  tmp.db.execute(
    sql.raw(`
      create or replace function binarius_test_block_revoke() returns trigger
        language plpgsql as $$
        begin
          raise exception 'revoke commit blocked by test';
        end $$;
      create constraint trigger binarius_test_block_revoke
        after update on broker_accounts
        deferrable initially deferred
        for each row
        when (new.email = '${UNKNOWN_BLOCKED_EMAIL}' and new.status = 'revoked')
        execute function binarius_test_block_revoke();
    `),
  );

// its own sink: the cases above already emit the recovery messages, so a file-wide buffer would
// make the assertion below pass even with the fix reverted
function capturingLogger() {
  const lines: string[] = [];
  const app = Fastify({
    logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
  });
  return { logger: app.log, text: () => lines.join('\n') };
}

// BEFORE UPDATE OF access_token_enc: a revocation does not touch that column, so the second
// transaction still gets through. Raw, unparameterised SQL: several statements can only be
// sent in one call over the simple query protocol.
const failRotation = () =>
  tmp.db.execute(
    sql.raw(`
      create or replace function binarius_test_block_rotation() returns trigger
        language plpgsql as $$
        begin
          if new.email = '${BLOCKED_EMAIL}' then raise exception 'rotation blocked by test'; end if;
          return new;
        end $$;
      create trigger binarius_test_block_rotation
        before update of access_token_enc on broker_accounts
        for each row execute function binarius_test_block_rotation();
    `),
  );

// AFTER … DEFERRABLE INITIALLY DEFERRED fires at COMMIT, so the rotation statement succeeds and
// the transaction dies on the commit itself — the one failure the callback can never observe.
// The WHEN clause keeps it off the revocation, which changes neither ciphertext.
const failCommit = () =>
  tmp.db.execute(
    sql.raw(`
      create or replace function binarius_test_block_commit() returns trigger
        language plpgsql as $$
        begin
          raise exception 'commit blocked by test';
        end $$;
      create constraint trigger binarius_test_block_commit
        after update on broker_accounts
        deferrable initially deferred
        for each row
        when (new.email = '${COMMIT_BLOCKED_EMAIL}'
              and new.access_token_enc is distinct from old.access_token_enc)
        execute function binarius_test_block_commit();
    `),
  );

// every guard below is a trigger plus its function under one name
const dropTestGuard = (name: string) =>
  tmp.db.execute(
    sql.raw(
      `drop trigger if exists ${name} on broker_accounts; drop function if exists ${name}();`,
    ),
  );

// two call sites; the others are dropped by name where they are installed
const allowRotation = () => dropTestGuard('binarius_test_block_rotation');

// blocks every update of the marked row, so the second transaction's revocation fails too
const failAnyUpdate = (email: string) =>
  tmp.db.execute(
    sql.raw(`
      create or replace function binarius_test_block_any() returns trigger
        language plpgsql as $$
        begin
          raise exception 'update blocked by test';
        end $$;
      create trigger binarius_test_block_any
        before update on broker_accounts
        for each row when (new.email = '${email}')
        execute function binarius_test_block_any();
    `),
  );

// a broker that never answers inside the client's patience: the shape both unknown-outcome
// cases need
async function slowBroker() {
  const slow = await startOAuthStub({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    hang: true,
  });
  return {
    impatient: createBrokerOAuthClient({
      baseUrl: slow.url,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      timeoutMs: 50,
    }),
    close: () => slow.close(),
  };
}

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
    const account = await expiredAccount();
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
    const account = await expiredAccount();
    const slow = await slowBroker();
    try {
      expect(await ensureFreshAccessToken(deps({ broker: slow.impatient }), account.id)).toEqual({
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
    const account = await expiredAccount();
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
    const account = await expiredAccount();
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
    // no rotation happened, so the ninety-day clock must not have moved
    expect(row.tokenRotatedAt).toEqual(account.tokenRotatedAt);
  });

  // the pre-#9 shape: a row that never rotated and has no hash. Filling the hash must not
  // hand its refresh token another ninety days by dating it today.
  it('backfills a legacy row without starting its refresh clock over', async () => {
    const account = await linkedAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ refreshTokenHash: null, tokenRotatedAt: null })
      .where(eq(brokerAccounts.id, account.id));

    expect((await ensureFreshAccessToken(deps(), account.id)).ok).toBe(true);
    const row = await rowOf(account.id);
    expect(row.refreshTokenHash).not.toBeNull();
    expect(row.tokenRotatedAt).toBeNull();
    expect(row.accessTokenExpiresAt).toEqual(account.accessTokenExpiresAt);
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

  it('leaves a row encrypted under another key untouched', async () => {
    const account = await linkedAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ tokenKeyId: 'rotated-key' })
      .where(eq(brokerAccounts.id, account.id));
    await expireAccessToken(account.id);

    const before = stub.tokenRequests;
    expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
      ok: false,
      reason: 'key_unavailable',
    });
    // the process that does hold that key must still find the account usable
    expect(await rowOf(account.id)).toMatchObject({
      status: 'active',
      authRevokedReason: null,
      tokenKeyId: 'rotated-key',
    });
    expect(stub.tokenRequests).toBe(before);
  });

  it('revokes when the ciphertext cannot be decrypted under its own key id', async () => {
    const account = await linkedAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ refreshTokenEnc: randomBytes(64) })
      .where(eq(brokerAccounts.id, account.id));

    expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
      ok: false,
      reason: 'account_revoked',
      revokedReason: 'storage_inconsistent',
    });
    expect(await rowOf(account.id)).toMatchObject({ status: 'revoked' });
  });

  // the broker has consumed the old token by then, so the account cannot be left holding it
  it('revokes in a second transaction when storing the rotated pair fails', async () => {
    const account = await expiredAccount(BLOCKED_EMAIL);
    await failRotation();
    try {
      expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
        ok: false,
        reason: 'account_revoked',
        revokedReason: 'refresh_outcome_unknown',
      });
      const row = await rowOf(account.id);
      // the revocation is committed even though the transaction that exchanged was rolled back
      expect(row).toMatchObject({
        status: 'revoked',
        authRevokedReason: 'refresh_outcome_unknown',
      });
      expect(row.refreshTokenEnc).toEqual(account.refreshTokenEnc);
    } finally {
      await allowRotation();
    }
  });

  it('refuses an account nobody has confirmed, without touching the broker', async () => {
    const account = await pendingAccount();
    const before = stub.tokenRequests;
    expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
      ok: false,
      reason: 'account_pending',
    });
    expect(stub.tokenRequests).toBe(before);
    expect((await rowOf(account.id)).status).toBe('pending');
  });

  // the transaction commits the rotation and then dies on the COMMIT: nothing inside the
  // callback ever sees that error, so only the flag set after the exchange can catch it
  it('revokes when the commit itself fails after the pair was stored', async () => {
    const account = await expiredAccount(COMMIT_BLOCKED_EMAIL);
    try {
      await failCommit();
      expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
        ok: false,
        reason: 'account_revoked',
        revokedReason: 'refresh_outcome_unknown',
      });
      const row = await rowOf(account.id);
      expect(row).toMatchObject({
        status: 'revoked',
        authRevokedReason: 'refresh_outcome_unknown',
      });
      // the rotation was rolled back with the transaction, so the stored pair is the old one
      expect(row.refreshTokenEnc).toEqual(account.refreshTokenEnc);
    } finally {
      await dropTestGuard('binarius_test_block_commit');
    }
  });

  // both transactions fail: nothing can be recorded, so the caller has to hear about it
  it('throws when the account cannot be revoked after the pair was lost', async () => {
    const account = await expiredAccount(BLOCKED_EMAIL);
    try {
      await failRotation();
      await failAnyUpdate(BLOCKED_EMAIL);
      await expect(ensureFreshAccessToken(deps(), account.id)).rejects.toThrow();
      expect((await rowOf(account.id)).status).toBe('active');
    } finally {
      await dropTestGuard('binarius_test_block_any');
      await allowRotation();
    }
  });

  // the branch the previous round left uncovered: the broker never answered, so the pair may
  // already be spent, and the revocation that says so is lost when the transaction cannot commit
  it('recovers when an unknown outcome is revoked and that commit fails', async () => {
    const account = await expiredAccount(UNKNOWN_BLOCKED_EMAIL);
    const slow = await slowBroker();
    const captured = capturingLogger();
    try {
      await failRevokeCommit();
      await expect(
        ensureFreshAccessToken(
          deps({ broker: slow.impatient, logger: captured.logger }),
          account.id,
        ),
      ).rejects.toThrow();

      // both transactions die on the same trigger, so the row is unchanged either way: what
      // distinguishes a working recovery from none is that it was attempted at all
      const text = captured.text();
      expect(text).toContain('revoking the account in a second transaction');
      expect(text).toContain('could not be revoked');
      expect((await rowOf(account.id)).status).toBe('active');
    } finally {
      await dropTestGuard('binarius_test_block_revoke');
      await slow.close();
    }
  });

  it('exchanges once when two callers race on the same account', async () => {
    const account = await expiredAccount();
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

// #275: a 429 is the broker's rate limiter refusing before it read the token, so the pair is
// intact; anything after which the pair may be spent still revokes
describe('ensureFreshAccessToken when the broker rate-limits the exchange', () => {
  const refusing = async <T>(
    refusal: NonNullable<OAuthStub['refuseRefresh']>,
    run: () => Promise<T>,
  ): Promise<T> => {
    stub.refuseRefresh = refusal;
    try {
      return await run();
    } finally {
      stub.refuseRefresh = undefined;
    }
  };

  it.each([
    ['with Retry-After', { 'retry-after': '7' }],
    ['without Retry-After', undefined],
  ])('T1 keeps the account and its pair on a 429 %s', async (_label, headers) => {
    const account = await expiredAccount();
    const refreshes = () => stub.paths.filter((path) => path.includes('user-auth/refresh')).length;
    const before = refreshes();
    const result = await refusing(
      { status: 429, ...(headers === undefined ? {} : { headers }) },
      () => ensureFreshAccessToken(deps(), account.id),
    );
    expect(result).toEqual({ ok: false, reason: 'refresh_rate_limited' });
    expect(refreshes()).toBe(before + 1);
    const row = await rowOf(account.id);
    expect(row).toMatchObject({ status: 'active', authRevokedReason: null });
    expect(row.refreshTokenHash).toBe(account.refreshTokenHash);
    expect(row.tokenRotatedAt).toEqual(account.tokenRotatedAt);
    expect(
      cipher.decrypt(row.refreshTokenEnc, { accountId: row.id, field: TokenField.Refresh }),
    ).toBe(
      cipher.decrypt(account.refreshTokenEnc, { accountId: account.id, field: TokenField.Refresh }),
    );

    // the stub takes only the family's newest member: the pair was not spent
    const again = await ensureFreshAccessToken(deps(), account.id);
    expect(again.ok).toBe(true);
    expect((await rowOf(account.id)).refreshTokenHash).not.toBe(account.refreshTokenHash);
  });

  it('T2 still revokes a 5xx on the exchange as an unknown outcome', async () => {
    const account = await expiredAccount();
    expect(
      await refusing({ status: 503 }, () => ensureFreshAccessToken(deps(), account.id)),
    ).toEqual({ ok: false, reason: 'account_revoked', revokedReason: 'refresh_outcome_unknown' });
    expect(await rowOf(account.id)).toMatchObject({ status: 'revoked' });
  });

  it.each([400, 403])(
    'T3 still revokes any other 4xx (%i) as an unknown outcome',
    async (status) => {
      const account = await expiredAccount();
      expect(await refusing({ status }, () => ensureFreshAccessToken(deps(), account.id))).toEqual({
        ok: false,
        reason: 'account_revoked',
        revokedReason: 'refresh_outcome_unknown',
      });
    },
  );
});

// The background balance refresh (#137) passes mayRefresh: false. Whatever the token's state, the
// account must come out exactly as it went in, and the broker must not hear about it.
describe('ensureFreshAccessToken with mayRefresh: false', () => {
  const unchanged = async (account: BrokerAccountRow) => {
    const row = await rowOf(account.id);
    expect(row).toMatchObject({
      status: 'active',
      authRevokedReason: null,
      accessTokenEnc: account.accessTokenEnc,
      tokenRotatedAt: account.tokenRotatedAt,
    });
  };

  it('refuses the exchange an expired token needs', async () => {
    const account = await expiredAccount();
    const before = stub.tokenRequests;
    expect(await ensureFreshAccessToken(deps(), account.id, { mayRefresh: false })).toEqual({
      ok: false,
      reason: 'refresh_needed',
    });
    expect(stub.tokenRequests).toBe(before);
    await unchanged(account);
  });

  // the process clock ahead of the database's: by the database the token has ten minutes left,
  // by the process it expired five minutes ago, and the decision is the process's
  it('refuses it when only the process clock says the token expired', async () => {
    const account = await linkedAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ accessTokenExpiresAt: sql`now() + interval '10 minutes'` })
      .where(eq(brokerAccounts.id, account.id));
    const before = stub.tokenRequests;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 15 * 60_000);
      expect(await ensureFreshAccessToken(deps(), account.id, { mayRefresh: false })).toEqual({
        ok: false,
        reason: 'refresh_needed',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(stub.tokenRequests).toBe(before);
  });

  it('does not revoke a refresh token past its ninety days either', async () => {
    const account = await expiredAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ tokenRotatedAt: sql`now() - interval '91 days'` })
      .where(eq(brokerAccounts.id, account.id));
    expect(await ensureFreshAccessToken(deps(), account.id, { mayRefresh: false })).toEqual({
      ok: false,
      reason: 'refresh_needed',
    });
    expect(await rowOf(account.id)).toMatchObject({ status: 'active', authRevokedReason: null });
  });

  it('still hands out a valid token', async () => {
    const account = await linkedAccount();
    const result = await ensureFreshAccessToken(deps(), account.id, { mayRefresh: false });
    expect(result.ok).toBe(true);
  });
});

// Rule 12: the token of a blocked user's account is never handed out. users.status is read by the
// statement that locks the account, and users itself is not locked (Rule 5).
describe('ensureFreshAccessToken for a blocked user', () => {
  const block = (account: BrokerAccountRow) =>
    tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, account.userId));

  const untouched = async (account: BrokerAccountRow) => {
    expect(await rowOf(account.id)).toMatchObject({
      status: 'active',
      authRevokedReason: null,
      accessTokenEnc: account.accessTokenEnc,
    });
  };

  it('hands out no token while the access token is valid', async () => {
    const account = await linkedAccount();
    await block(account);
    const before = stub.tokenRequests;
    expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
      ok: false,
      reason: 'user_blocked',
    });
    expect(stub.tokenRequests).toBe(before);
    await untouched(account);
  });

  it('exchanges nothing for an expired token either, even when a refresh is allowed', async () => {
    const account = await expiredAccount();
    await block(account);
    const before = stub.tokenRequests;
    expect(await ensureFreshAccessToken(deps(), account.id)).toEqual({
      ok: false,
      reason: 'user_blocked',
    });
    expect(stub.tokenRequests).toBe(before);
    await untouched(account);
  });

  it('does not lock the users row while it holds the account', async () => {
    const slow = await startOAuthStub({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    let refreshing: Promise<unknown> | undefined;
    try {
      const patient = createBrokerOAuthClient({
        baseUrl: slow.url,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        timeoutMs: 5_000,
      });
      const n = ++seq;
      const tokens = await patient.exchangeCode({
        code: slow.issueCode({ brokerUserId: `svc-broker-${n}` }),
        redirectUri: REDIRECT_URI,
      });
      const telegramUserId = BigInt(900_000 + n);
      const linked = await linkBrokerAccount(tmp.db, {
        telegramUserId,
        tokens,
        cipher,
        activate: true,
      });
      if (!linked.ok) throw new Error(`link failed: ${linked.reason}`);
      await expireAccessToken(linked.account.id);

      slow.hang = true;
      refreshing = ensureFreshAccessToken(deps({ broker: patient }), linked.account.id);
      // the exchange is held at the stub: the account row is locked until it answers
      await until('the exchange to reach the stub', () => slow.pendingHangs === 1);

      await tmp.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        await tx.update(users).set({ status: 'active' }).where(eq(users.id, linked.account.userId));
      });
      slow.release();
      expect(await refreshing).toMatchObject({ ok: true });
    } finally {
      await slow.close();
      await refreshing?.catch(() => undefined);
    }
  });
});

// #281: a caller whose token the broker refused reports its fingerprint; under the row lock a
// match marks the stored token expired, and the decision goes on as for an expired token
describe('ensureFreshAccessToken with a refused token (#281)', () => {
  const storedOf = (row: BrokerAccountRow) =>
    cipher.decrypt(row.accessTokenEnc, { accountId: row.id, field: TokenField.Access });
  const fingerprintOf = (row: BrokerAccountRow) => hashToken(storedOf(row));
  const nowDb = async () => {
    const result = await tmp.db.execute<{ now: string }>(sql`select now()::text as now`);
    return new Date(result.rows[0]!.now);
  };

  it('T1 exchanges when the broker refused the stored token and the caller may refresh', async () => {
    const account = await linkedAccount();
    const before = stub.tokenRequests;
    const result = await ensureFreshAccessToken(deps(), account.id, {
      mayRefresh: true,
      refusedToken: fingerprintOf(account),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accessToken).not.toBe(storedOf(account));
    expect(stub.tokenRequests).toBe(before + 1);

    const row = await rowOf(account.id);
    expect(storedOf(row)).toBe(result.accessToken);
    expect(row.refreshTokenEnc).not.toEqual(account.refreshTokenEnc);
    expect(row.accessTokenExpiresAt.getTime()).toBeGreaterThan((await nowDb()).getTime());
    expect(row.tokenRotatedAt!.getTime()).toBeGreaterThan(account.tokenRotatedAt!.getTime() - 1);
  });

  it('T2 marks it expired and exchanges nothing when the caller may not refresh', async () => {
    const account = await linkedAccount();
    const before = stub.tokenRequests;
    expect(
      await ensureFreshAccessToken(deps(), account.id, {
        mayRefresh: false,
        refusedToken: fingerprintOf(account),
      }),
    ).toEqual({ ok: false, reason: 'refresh_needed' });

    const row = await rowOf(account.id);
    expect(row.accessTokenExpiresAt.getTime()).toBeLessThanOrEqual(
      (await nowDb()).getTime() - 24 * 60 * 60_000,
    );
    expect(row).toMatchObject({
      status: 'active',
      accessTokenEnc: account.accessTokenEnc,
      refreshTokenEnc: account.refreshTokenEnc,
      refreshTokenHash: account.refreshTokenHash,
      tokenRotatedAt: account.tokenRotatedAt,
    });
    expect(stub.tokenRequests).toBe(before);

    // the mark is what every later caller sees, with or without a fingerprint
    expect(await ensureFreshAccessToken(deps(), account.id, { mayRefresh: false })).toEqual({
      ok: false,
      reason: 'refresh_needed',
    });
    const exchanged = await ensureFreshAccessToken(deps(), account.id, { mayRefresh: true });
    expect(exchanged.ok).toBe(true);
    expect(stub.tokenRequests).toBe(before + 1);
  });

  it.each([true, false])(
    'T3 returns the stored token for a fingerprint that is not the stored one (mayRefresh: %s)',
    async (mayRefresh) => {
      const account = await linkedAccount();
      const before = stub.tokenRequests;
      expect(
        await ensureFreshAccessToken(deps(), account.id, {
          mayRefresh,
          refusedToken: hashToken('another-token'),
        }),
      ).toEqual({ ok: true, accessToken: storedOf(account) });
      const row = await rowOf(account.id);
      expect(row.accessTokenExpiresAt).toEqual(account.accessTokenExpiresAt);
      expect(row.updatedAt).toEqual(account.updatedAt);
      expect(stub.tokenRequests).toBe(before);
    },
  );

  it.each([
    {
      name: 'a pending account',
      prepare: () => pendingAccount(),
      expected: { ok: false, reason: 'account_pending' },
    },
    {
      name: 'a revoked account',
      prepare: async () => {
        const account = await linkedAccount();
        await tmp.db
          .update(brokerAccounts)
          .set({ status: 'revoked', authRevokedReason: 'refresh_expired' })
          .where(eq(brokerAccounts.id, account.id));
        return account;
      },
      expected: { ok: false, reason: 'account_revoked', revokedReason: 'refresh_expired' },
    },
    {
      name: 'a blocked user',
      prepare: async () => {
        const account = await linkedAccount();
        await tmp.db.update(users).set({ status: 'blocked' }).where(eq(users.id, account.userId));
        return account;
      },
      expected: { ok: false, reason: 'user_blocked' },
    },
    {
      name: 'a row under another key',
      prepare: async () => {
        const account = await linkedAccount();
        await tmp.db
          .update(brokerAccounts)
          .set({ tokenKeyId: 'rotated-key' })
          .where(eq(brokerAccounts.id, account.id));
        return account;
      },
      expected: { ok: false, reason: 'key_unavailable' },
    },
  ])('T4 answers $name before it reads the fingerprint', async ({ prepare, expected }) => {
    const account = await prepare();
    const before = stub.tokenRequests;
    expect(
      await ensureFreshAccessToken(deps(), account.id, {
        mayRefresh: true,
        refusedToken: fingerprintOf(account),
      }),
    ).toEqual(expected);
    expect((await rowOf(account.id)).accessTokenExpiresAt).toEqual(account.accessTokenExpiresAt);
    expect(stub.tokenRequests).toBe(before);
  });

  it('T5 does not read the fingerprint of a token already expired by the clock', async () => {
    const account = await expiredAccount();
    await tmp.db
      .update(brokerAccounts)
      .set({ accessTokenEnc: randomBytes(64) })
      .where(eq(brokerAccounts.id, account.id));
    expect(
      await ensureFreshAccessToken(deps(), account.id, {
        mayRefresh: false,
        refusedToken: hashToken('whatever'),
      }),
    ).toEqual({ ok: false, reason: 'refresh_needed' });
    expect(await rowOf(account.id)).toMatchObject({ status: 'active', authRevokedReason: null });
  });
});
