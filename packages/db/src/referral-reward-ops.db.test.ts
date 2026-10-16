import { randomBytes } from 'node:crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
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

const callbackLink = (user: SeededUser) =>
  linkBrokerAccount(tmp.db, {
    telegramUserId: BigInt(user.telegramUserId),
    tokens: brokerTokens(true),
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

  it('W9 the OAuth callback pays nothing until the confirm', async () => {
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
  // holds the users row of `userId` until the returned release is called
  async function holdUser(userId: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => (markHeld = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('no key update');
      markHeld();
      await gate;
    });
    await Promise.race([held, holder]);
    return async () => {
      release();
      await holder;
    };
  }

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

  it('L3 two concurrent confirms of the invitee’s two partner accounts pay one reward', async () => {
    const { inviter, invitee, referralId } = await invitation();
    const [first, second] = [await pending(invitee), await pending(invitee)];
    const results = await Promise.all([confirm(invitee, first), confirm(invitee, second)]);
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
});
