import { randomBytes } from 'node:crypto';
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrokerAccountStatus, UserStatus, type OAuthTokens } from '@binarius/shared';
import { until } from '@binarius/shared/testing';
import {
  activateBonusRuleVersion,
  createBonusRuleVersion,
  deactivateBonusRule,
  InvalidBonusRule,
} from './bonus-rule-ops';
import { createTokenCipher } from './crypto';
import { LINK_BONUS_RULE_CODE } from './link-bonus-ops';
import { confirmBrokerAccount, linkBrokerAccount } from './oauth-ops';
import { REFERRAL_REWARD_RULE_CODE } from './referral-reward-ops';
import { bonusRules, brokerAccounts, referrals, tokenLedger, users } from './schema/index';
import {
  SEEDED_LINK_BONUS_TOKENS,
  SEEDED_REFERRAL_REWARD_TOKENS,
  createTempDatabase,
  lockWaiters,
  seedBrokerAccount,
  seedUser,
  type SeededUser,
  type TempDatabase,
} from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

const cipher = createTokenCipher({ keyId: 'test-key', key: randomBytes(32) });

let tmp: TempDatabase;
let rewardV1: string;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
  rewardV1 = await ruleId(REFERRAL_REWARD_RULE_CODE, 1);
});
afterAll(() => tmp.drop());

// every case leaves v1 of both codes the one active version, as the seed has it
afterEach(async () => {
  await tmp.pool.query(
    `update bonus_rules set is_active = false where code in ('link_bonus', 'referral_reward')`,
  );
  await tmp.pool.query(
    `update bonus_rules set is_active = true where code in ('link_bonus', 'referral_reward') and version = 1`,
  );
});

async function ruleId(code: string, version: number): Promise<string> {
  const [row] = await tmp.db
    .select({ id: bonusRules.id })
    .from(bonusRules)
    .where(and(eq(bonusRules.code, code), eq(bonusRules.version, version)));
  return row!.id;
}

// The inviter is created first, as a /start with its code can only follow its own (Rule 34).
// Both start with no tokens and no ledger, so "balance = sum of the ledger" holds throughout.
async function invitation(inviter?: SeededUser) {
  const from = inviter ?? (await seedUser(tmp.db, { balance: 0n }));
  const invitee = await seedUser(tmp.db, { balance: 0n });
  const [row] = await tmp.db
    .insert(referrals)
    .values({ inviteeUserId: invitee.userId, inviterUserId: from.userId })
    .returning({ id: referrals.id });
  return { inviter: from, invitee, referralId: row!.id };
}

const pending = (user: SeededUser, isPartnerClient = true) =>
  seedBrokerAccount(tmp.db, user.userId, { status: BrokerAccountStatus.Pending, isPartnerClient });

const confirm = (user: SeededUser, accountId: string) =>
  confirmBrokerAccount(tmp.db, { telegramUserId: BigInt(user.telegramUserId), accountId });

let seq = 0;
const brokerTokens = (isPartnerClient: boolean, brokerUserId?: string): OAuthTokens => {
  const n = ++seq;
  return {
    accessToken: `access-r${n}`,
    refreshToken: `refresh-r${n}`,
    tokenType: 'Bearer',
    expiresInSec: 3600,
    user: { id: brokerUserId ?? `broker-r${n}`, email: null, isPartnerClient },
  };
};

// the email login: an activating link (#162)
const emailLogin = (user: SeededUser, isPartnerClient = true, brokerUserId?: string) =>
  linkBrokerAccount(tmp.db, {
    telegramUserId: BigInt(user.telegramUserId),
    tokens: brokerTokens(isPartnerClient, brokerUserId),
    cipher,
    activate: true,
  });

const callbackLink = (user: SeededUser, isPartnerClient = true, brokerUserId?: string) =>
  linkBrokerAccount(tmp.db, {
    telegramUserId: BigInt(user.telegramUserId),
    tokens: brokerTokens(isPartnerClient, brokerUserId),
    cipher,
    activate: false,
  });

async function rewardsOf(referralId: string) {
  return tmp.db
    .select({
      userId: tokenLedger.userId,
      kind: tokenLedger.kind,
      balanceDelta: tokenLedger.balanceDelta,
      reservedDelta: tokenLedger.reservedDelta,
      brokerAccountId: tokenLedger.brokerAccountId,
      depositEventId: tokenLedger.depositEventId,
      bonusRuleId: tokenLedger.bonusRuleId,
      bonusRuleKind: tokenLedger.bonusRuleKind,
    })
    .from(tokenLedger)
    .where(eq(tokenLedger.referralId, referralId));
}

// the cache and the ledger it caches (Rule 2)
async function balanceOf(userId: string) {
  const [cache] = await tmp.db
    .select({ balance: users.tokenBalance })
    .from(users)
    .where(eq(users.id, userId));
  const [ledger] = await tmp.db
    .select({ sum: sql<string>`coalesce(sum(${tokenLedger.balanceDelta}), 0)::text` })
    .from(tokenLedger)
    .where(eq(tokenLedger.userId, userId));
  expect(BigInt(ledger!.sum)).toBe(cache!.balance);
  return cache!.balance;
}

const anyReferralRows = async (userId: string) =>
  tmp.db
    .select({ id: tokenLedger.id })
    .from(tokenLedger)
    .where(and(eq(tokenLedger.userId, userId), isNotNull(tokenLedger.referralId)));

const accountStatus = async (accountId: string) => {
  const [row] = await tmp.db
    .select({ status: brokerAccounts.status })
    .from(brokerAccounts)
    .where(eq(brokerAccounts.id, accountId));
  return row?.status;
};

describe('the inviter’s reward on an activation (#116)', () => {
  it('W1 a confirmed partner account pays the inviter once, under referral_reward v1', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const result = await confirm(invitee, await pending(invitee));
    expect(result).toMatchObject({
      ok: true,
      grant: { granted: true, tokens: SEEDED_LINK_BONUS_TOKENS },
      referral: {
        rewarded: true,
        referralId,
        inviterUserId: inviter.userId,
        tokens: SEEDED_REFERRAL_REWARD_TOKENS,
        ruleId: rewardV1,
        version: 1,
      },
    });
    expect(await rewardsOf(referralId)).toEqual([
      {
        userId: inviter.userId,
        kind: 'bonus',
        balanceDelta: SEEDED_REFERRAL_REWARD_TOKENS,
        reservedDelta: 0n,
        brokerAccountId: null,
        depositEventId: null,
        bonusRuleId: rewardV1,
        bonusRuleKind: 'referral_reward',
      },
    ]);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
    expect(await balanceOf(invitee.userId)).toBe(SEEDED_LINK_BONUS_TOKENS);
  });

  it('W1 the email login pays it too', async () => {
    const { inviter, invitee, referralId } = await invitation();
    expect(await emailLogin(invitee)).toMatchObject({
      ok: true,
      referral: { rewarded: true, tokens: SEEDED_REFERRAL_REWARD_TOKENS },
    });
    expect(await rewardsOf(referralId)).toHaveLength(1);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  it('W2 a non-partner account pays nothing; a later partner account does', async () => {
    const { inviter, invitee, referralId } = await invitation();
    expect(await confirm(invitee, await pending(invitee, false))).toMatchObject({
      ok: true,
      referral: { rewarded: false, reason: 'not_partner_client' },
    });
    expect(await rewardsOf(referralId)).toEqual([]);
    expect(await emailLogin(invitee)).toMatchObject({ referral: { rewarded: true } });
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  it('W2 a user nobody invited gets no_referral', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    expect(await confirm(user, await pending(user))).toMatchObject({
      ok: true,
      referral: { rewarded: false, reason: 'no_referral', referralId: null },
    });
  });

  // the same broker account on both sides is broker_accounts_broker_user_id_idx's to refuse
  it('W3 the invitee logging in with the inviter’s broker account is refused, nobody is paid', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const own = await emailLogin(inviter);
    if (!own.ok) throw new Error('setup: the inviter’s login failed');
    expect(await emailLogin(invitee, true, own.account.brokerUserId)).toEqual({
      ok: false,
      reason: 'broker_account_taken',
    });
    expect(await rewardsOf(referralId)).toEqual([]);
    expect(await anyReferralRows(inviter.userId)).toEqual([]);
    expect(await anyReferralRows(invitee.userId)).toEqual([]);
  });

  it('W4 a second partner account and a repeat login pay no second reward, even with the rule off', async () => {
    const { inviter, invitee, referralId } = await invitation();
    expect(await confirm(invitee, await pending(invitee))).toMatchObject({
      referral: { rewarded: true },
    });
    expect(await emailLogin(invitee)).toMatchObject({
      referral: { rewarded: false, reason: 'already_rewarded', referralId },
    });
    await deactivateBonusRule(tmp.db, { code: REFERRAL_REWARD_RULE_CODE });
    expect(await emailLogin(invitee)).toMatchObject({
      ok: true,
      referral: { rewarded: false, reason: 'already_rewarded' },
    });
    expect(await rewardsOf(referralId)).toHaveLength(1);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  it('W5 with no active version the activation commits without a reward; the next login pays', async () => {
    const { inviter, invitee, referralId } = await invitation();
    await deactivateBonusRule(tmp.db, { code: REFERRAL_REWARD_RULE_CODE });
    const accountId = await pending(invitee);
    expect(await confirm(invitee, accountId)).toMatchObject({
      ok: true,
      grant: { granted: true },
      referral: { rewarded: false, reason: 'no_active_rule', referralId },
    });
    expect(await accountStatus(accountId)).toBe('active');
    expect(await rewardsOf(referralId)).toEqual([]);
    expect(await balanceOf(invitee.userId)).toBe(SEEDED_LINK_BONUS_TOKENS);

    await activateBonusRuleVersion(tmp.db, { code: REFERRAL_REWARD_RULE_CODE, version: 1 });
    expect(await emailLogin(invitee)).toMatchObject({ referral: { rewarded: true } });
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  it('W6 a blocked inviter is not paid; unblocked, the next login pays', async () => {
    const { inviter, invitee, referralId } = await invitation();
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, inviter.userId));
    expect(await confirm(invitee, await pending(invitee))).toMatchObject({
      ok: true,
      referral: { rewarded: false, reason: 'inviter_blocked', referralId },
    });
    expect(await rewardsOf(referralId)).toEqual([]);
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Active })
      .where(eq(users.id, inviter.userId));
    expect(await emailLogin(invitee)).toMatchObject({ referral: { rewarded: true } });
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  it('W7 a new version pays new rewards; a paid one stays on its version', async () => {
    const first = await invitation();
    await confirm(first.invitee, await pending(first.invitee));
    const created = await createBonusRuleVersion(tmp.db, {
      code: REFERRAL_REWARD_RULE_CODE,
      params: { tokens: '70' },
    });
    if (!created.ok) throw new Error('setup: version not created');
    await activateBonusRuleVersion(tmp.db, {
      code: REFERRAL_REWARD_RULE_CODE,
      version: created.row.version,
    });
    const second = await invitation(first.inviter);
    expect(await confirm(second.invitee, await pending(second.invitee))).toMatchObject({
      referral: { rewarded: true, tokens: 70n, ruleId: created.row.id },
    });
    expect(await rewardsOf(first.referralId)).toMatchObject([
      { balanceDelta: SEEDED_REFERRAL_REWARD_TOKENS, bonusRuleId: rewardV1 },
    ]);
    expect(await rewardsOf(second.referralId)).toMatchObject([
      { balanceDelta: 70n, bonusRuleId: created.row.id },
    ]);
    expect(await balanceOf(first.inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS + 70n);
  });

  it('W8 the reward does not depend on the starter pack', async () => {
    const { inviter, invitee } = await invitation();
    await deactivateBonusRule(tmp.db, { code: LINK_BONUS_RULE_CODE });
    expect(await confirm(invitee, await pending(invitee))).toMatchObject({
      ok: true,
      grant: { granted: false, reason: 'no_active_rule' },
      referral: { rewarded: true },
    });
    expect(await balanceOf(invitee.userId)).toBe(0n);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  it('W9 a callback that leaves the account pending pays nothing until the confirm', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const linked = await callbackLink(invitee);
    expect(linked).toMatchObject({ ok: true, grant: null, referral: null });
    if (!linked.ok) throw new Error('setup: the callback link failed');
    expect(await rewardsOf(referralId)).toEqual([]);
    expect(await confirm(invitee, linked.account.id)).toMatchObject({
      referral: { rewarded: true },
    });
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  // decision 9: a re-login of an account confirmed before leaves it active, so it pays
  it('W11 the callback re-login of a revoked partner account pays the unpaid reward', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const brokerUserId = `broker-z${++seq}`;
    await seedBrokerAccount(tmp.db, invitee.userId, {
      status: BrokerAccountStatus.Revoked,
      isPartnerClient: true,
      brokerUserId,
    });
    expect(await callbackLink(invitee, true, brokerUserId)).toMatchObject({
      ok: true,
      account: { status: 'active' },
      grant: null,
      referral: { rewarded: true, referralId, tokens: SEEDED_REFERRAL_REWARD_TOKENS },
    });
    expect(await rewardsOf(referralId)).toHaveLength(1);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
    expect(await balanceOf(invitee.userId)).toBe(0n);
  });

  it('W12 an active account the broker now reports partner pays on a callback re-login, once', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const brokerUserId = `broker-z${++seq}`;
    const accountId = await seedBrokerAccount(tmp.db, invitee.userId, {
      status: BrokerAccountStatus.Pending,
      isPartnerClient: false,
      brokerUserId,
    });
    expect(await confirm(invitee, accountId)).toMatchObject({
      referral: { rewarded: false, reason: 'not_partner_client' },
    });
    expect(await callbackLink(invitee, true, brokerUserId)).toMatchObject({
      ok: true,
      grant: null,
      referral: { rewarded: true, referralId },
    });
    expect(await callbackLink(invitee, true, brokerUserId)).toMatchObject({
      ok: true,
      referral: { rewarded: false, reason: 'already_rewarded', referralId },
    });
    expect(await rewardsOf(referralId)).toHaveLength(1);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  it('W10 an active version with params that do not parse rolls the activation back', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const [{ v }] = (
      await tmp.pool.query<{ v: number }>(
        `select max(version) + 1 as v from bonus_rules where code = 'referral_reward'`,
      )
    ).rows as [{ v: number }];
    await tmp.pool.query(`update bonus_rules set is_active = false where code = 'referral_reward'`);
    await tmp.pool.query(
      `insert into bonus_rules (code, version, kind, is_active, params)
         values ('referral_reward', $1, 'referral_reward', true, '{"tokens": 50}'::jsonb)`,
      [v],
    );
    const accountId = await pending(invitee);
    const error = await confirm(invitee, accountId).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(InvalidBonusRule);
    expect(error).toMatchObject({ code: REFERRAL_REWARD_RULE_CODE });
    expect(await accountStatus(accountId)).toBe('pending');
    expect(await rewardsOf(referralId)).toEqual([]);
    expect(await balanceOf(invitee.userId)).toBe(0n);
    expect(await balanceOf(inviter.userId)).toBe(0n);
  });
});

describe('the reward’s locks (Rule 5)', () => {
  // holds the rows `query` locks until the returned release is called
  async function holdRows(query: SQL) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => (markHeld = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await tx.execute(query);
      markHeld();
      await gate;
    });
    await Promise.race([held, holder]);
    return async () => {
      release();
      await holder;
    };
  }

  const holdUser = (userId: string) =>
    holdRows(sql`select 1 from ${users} where ${users.id} = ${userId} for no key update`);

  // parks an activation after its account lock: the pack's ledger insert takes KEY SHARE on the
  // link_bonus rule row through its FK
  const holdLinkBonusRule = () =>
    holdRows(sql`select 1 from bonus_rules where code = 'link_bonus' and is_active for update`);

  it('L1 waits on the inviter’s held users row and pays after its release', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const accountId = await pending(invitee);
    const release = await holdUser(inviter.userId);
    let confirming: ReturnType<typeof confirm> | undefined;
    try {
      confirming = confirm(invitee, accountId);
      await until('the confirm to queue behind the inviter’s row', async () => {
        return (await lockWaiters(tmp.db)) === 1;
      });
      expect(await rewardsOf(referralId)).toEqual([]);
    } finally {
      await release();
    }
    expect(await confirming).toMatchObject({ ok: true, referral: { rewarded: true } });
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  // C invited A, A invited B: A's activation holds A and waits on C, B's holds B and waits on A
  it('L2 a chain of activations up the invitation tree completes without a deadlock', async () => {
    const ca = await invitation();
    const ab = await invitation(ca.invitee);
    const [aAccount, bAccount] = [await pending(ca.invitee), await pending(ab.invitee)];
    const release = await holdUser(ca.inviter.userId);
    let both: Promise<unknown[]> | undefined;
    try {
      const a = confirm(ca.invitee, aAccount);
      await until('A’s confirm to queue behind C', async () => (await lockWaiters(tmp.db)) === 1);
      const b = confirm(ab.invitee, bAccount);
      await until('B’s confirm to queue behind A', async () => (await lockWaiters(tmp.db)) === 2);
      both = Promise.all([a, b]);
    } finally {
      await release();
    }
    expect(await both).toMatchObject([
      { ok: true, referral: { rewarded: true, referralId: ca.referralId } },
      { ok: true, referral: { rewarded: true, referralId: ab.referralId } },
    ]);
    expect(await balanceOf(ca.inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
    expect(await balanceOf(ca.invitee.userId)).toBe(
      SEEDED_LINK_BONUS_TOKENS + SEEDED_REFERRAL_REWARD_TOKENS,
    );
  });

  // the inviter logs in with the invitee's broker account (decision 6's self-invite): its link
  // holds the inviter's users row and waits on the account the invitee's activation holds
  const partnerAccount = async (
    user: SeededUser,
    status: BrokerAccountStatus,
    isPartnerClient = true,
  ) => {
    const brokerUserId = `broker-z${++seq}`;
    const accountId = await seedBrokerAccount(tmp.db, user.userId, {
      status,
      isPartnerClient,
      brokerUserId,
    });
    return { accountId, brokerUserId };
  };

  // a rejected activation shows its SQLSTATE in the diff (40P01 for a deadlock)
  const rejection = (error: unknown) => {
    const cause = (error as { cause?: { code?: string } }).cause;
    return { rejected: cause?.code ?? (error as { code?: string }).code ?? String(error) };
  };

  async function raceInviterLogin(
    activation: () => Promise<unknown>,
    inviterLogin: () => Promise<unknown>,
  ) {
    const release = await holdLinkBonusRule();
    let both: Promise<unknown[]> | undefined;
    try {
      const b = activation();
      await until('the invitee’s activation to park on the rule row', async () => {
        return (await lockWaiters(tmp.db)) === 1;
      });
      const a = inviterLogin();
      await until('the inviter’s login to queue', async () => (await lockWaiters(tmp.db)) === 2);
      both = Promise.all([b, a].map((p) => p.catch(rejection)));
    } finally {
      await release();
    }
    return both;
  }

  it('L4a the invitee’s confirm and the inviter’s callback login with the same account do not deadlock', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const z = await partnerAccount(invitee, BrokerAccountStatus.Pending);
    const [b, a] = await raceInviterLogin(
      () => confirm(invitee, z.accountId),
      () => callbackLink(inviter, true, z.brokerUserId),
    );
    expect(b).toMatchObject({ ok: true, referral: { rewarded: true } });
    expect(a).toEqual({ ok: false, reason: 'broker_account_taken' });
    expect(await rewardsOf(referralId)).toHaveLength(1);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
    expect(await balanceOf(invitee.userId)).toBe(SEEDED_LINK_BONUS_TOKENS);
  });

  it('L4b the invitee’s email login inserting an account and the inviter’s with the same one do not deadlock', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const brokerUserId = `broker-z${++seq}`;
    const [b, a] = await raceInviterLogin(
      () => emailLogin(invitee, true, brokerUserId),
      () => emailLogin(inviter, true, brokerUserId),
    );
    expect(b).toMatchObject({ ok: true, referral: { rewarded: true } });
    expect(a).toEqual({ ok: false, reason: 'broker_account_taken' });
    expect(await rewardsOf(referralId)).toHaveLength(1);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  // The outcome of two confirms queued at once, not which guard decides it: the invitee's row,
  // the inviter's row, the paid read and token_ledger_referral_idx each serialize it, so no single
  // mutation reddens this test and none is listed for it.
  it('L3 two confirms of the invitee’s two partner accounts queued at once pay one reward', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const [first, second] = [await pending(invitee), await pending(invitee)];
    const release = await holdUser(invitee.userId);
    let both: Promise<Awaited<ReturnType<typeof confirm>>[]> | undefined;
    try {
      const queued = [confirm(invitee, first), confirm(invitee, second)];
      await until('both confirms to queue behind the invitee’s row', async () => {
        return (await lockWaiters(tmp.db)) === 2;
      });
      both = Promise.all(queued);
    } finally {
      await release();
    }
    const results = await both;
    expect(results.map((r) => (r.ok ? r.referral.rewarded : r.reason)).sort()).toEqual([
      false,
      true,
    ]);
    expect(results.map((r) => (r.ok && !r.referral.rewarded ? r.referral.reason : null))).toContain(
      'already_rewarded',
    );
    expect(await rewardsOf(referralId)).toHaveLength(1);
    expect(await balanceOf(inviter.userId)).toBe(SEEDED_REFERRAL_REWARD_TOKENS);
  });

  // the order oracle: an activation waiting on the inviter's row holds no broker_accounts lock yet
  async function accountLock(accountId: string): Promise<string> {
    const client = await tmp.pool.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from broker_accounts where id = $1 for no key update nowait', [
        accountId,
      ]);
      return 'free';
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  it.each([
    {
      id: 'a',
      path: 'the confirm of a pending account',
      status: BrokerAccountStatus.Pending,
      activate: (b: SeededUser, z: { accountId: string }) => confirm(b, z.accountId),
    },
    {
      id: 'b',
      path: 'the email re-login of an active account',
      status: BrokerAccountStatus.Active,
      activate: (b: SeededUser, z: { brokerUserId: string }) => emailLogin(b, true, z.brokerUserId),
    },
    {
      id: 'c',
      path: 'the callback re-login of a revoked account',
      status: BrokerAccountStatus.Revoked,
      activate: (b: SeededUser, z: { brokerUserId: string }) =>
        callbackLink(b, true, z.brokerUserId),
    },
  ])('L5$id $path locks the inviter’s row before the account', async ({ status, activate }) => {
    const { inviter, invitee, referralId } = await invitation();
    const z = await partnerAccount(invitee, status);
    const release = await holdUser(inviter.userId);
    let activating: Promise<unknown> | undefined;
    try {
      activating = activate(invitee, z).catch(rejection);
      await until('the activation to queue behind the inviter’s row', async () => {
        return (await lockWaiters(tmp.db)) === 1;
      });
      expect(await accountLock(z.accountId)).toBe('free');
    } finally {
      await release();
    }
    expect(await activating).toMatchObject({ ok: true, referral: { rewarded: true } });
    expect(await rewardsOf(referralId)).toHaveLength(1);
  });
});
