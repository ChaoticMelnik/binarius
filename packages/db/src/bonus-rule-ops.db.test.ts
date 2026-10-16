import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrokerAccountStatus } from '@binarius/shared';
import {
  activateBonusRuleVersion,
  applyBonus,
  createBonusRuleVersion,
  deactivateBonusRule,
  InvalidBonusRule,
  listBonusRules,
  resolveActiveRule,
} from './bonus-rule-ops';
import { LINK_BONUS_RULE_CODE } from './link-bonus-ops';
import { confirmBrokerAccount } from './oauth-ops';
import { auditLog, bonusRules, brokerAccounts, tokenLedger, users } from './schema/index';
import {
  SEEDED_LINK_BONUS_TOKENS,
  createTempDatabase,
  lockWaiters,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from './testing';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for packages/db integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

// every case leaves link_bonus v1 the one active version, as the seed has it
afterEach(async () => {
  await tmp.pool.query(`update bonus_rules set is_active = false where code = 'link_bonus'`);
  await tmp.pool.query(
    `update bonus_rules set is_active = true, valid_from = null, valid_to = null
      where code = 'link_bonus' and version = 1`,
  );
});

async function pendingPartner() {
  const user = await seedUser(tmp.db, { balance: 0n });
  const accountId = await seedBrokerAccount(tmp.db, user.userId, {
    status: BrokerAccountStatus.Pending,
    isPartnerClient: true,
  });
  return { ...user, accountId };
}

const confirm = (user: { telegramUserId: string; accountId: string }) =>
  confirmBrokerAccount(tmp.db, {
    telegramUserId: BigInt(user.telegramUserId),
    accountId: user.accountId,
  });

async function ledgerOf(userId: string) {
  const rows = await tmp.db
    .select({
      balanceDelta: tokenLedger.balanceDelta,
      version: bonusRules.version,
    })
    .from(tokenLedger)
    .leftJoin(bonusRules, eq(bonusRules.id, tokenLedger.bonusRuleId))
    .where(eq(tokenLedger.userId, userId));
  const [user] = await tmp.db
    .select({ balance: users.tokenBalance })
    .from(users)
    .where(eq(users.id, userId));
  return { rows, balance: user!.balance };
}

const ledgerCount = async () =>
  Number(
    (await tmp.pool.query<{ n: string }>('select count(*) as n from token_ledger')).rows[0]!.n,
  );

const accountStatus = async (accountId: string) =>
  (
    await tmp.db
      .select({ status: brokerAccounts.status })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, accountId))
  )[0]?.status;

// a version whose params the schema refuses, written by SQL as an operator could
async function insertRawVersion(version: number, kind: string, params: unknown) {
  await tmp.pool.query(
    `insert into bonus_rules (code, version, kind, params) values ('link_bonus', $1, $2, $3::jsonb)`,
    [version, kind, JSON.stringify(params)],
  );
}

describe('the seed', () => {
  it('holds link_bonus v1 (100) and referral_reward v1 (50) active, and no deposit_bonus', async () => {
    const rows = await listBonusRules(tmp.db);
    expect(
      rows.map(({ code, version, kind, isActive, params }) => ({
        code,
        version,
        kind,
        isActive,
        params,
      })),
    ).toEqual([
      {
        code: 'link_bonus',
        version: 1,
        kind: 'link_bonus',
        isActive: true,
        params: { tokens: '100' },
      },
      {
        code: 'referral_reward',
        version: 1,
        kind: 'referral_reward',
        isActive: true,
        params: { tokens: '50' },
      },
    ]);
    expect(SEEDED_LINK_BONUS_TOKENS).toBe(100n);
  });
});

describe('a rule change (acceptance 1 and 2)', () => {
  it('credits a new user under v2 and leaves an earlier pack on v1, writing no ledger row itself', async () => {
    const earlier = await pendingPartner();
    expect(await confirm(earlier)).toMatchObject({ grant: { granted: true, tokens: 100n } });

    const before = await ledgerCount();
    const created = await createBonusRuleVersion(tmp.db, {
      code: LINK_BONUS_RULE_CODE,
      params: { tokens: '150' },
    });
    expect(created).toMatchObject({ ok: true, row: { version: 2, isActive: false } });
    expect(
      await activateBonusRuleVersion(tmp.db, { code: LINK_BONUS_RULE_CODE, version: 2 }),
    ).toMatchObject({ ok: true, previousVersion: 1, row: { version: 2, isActive: true } });
    expect(await ledgerCount()).toBe(before);

    const later = await pendingPartner();
    expect(await confirm(later)).toMatchObject({ grant: { granted: true, tokens: 150n } });

    const earlierLedger = await ledgerOf(earlier.userId);
    expect(earlierLedger.rows).toEqual([{ balanceDelta: 100n, version: 1 }]);
    expect(earlierLedger.balance).toBe(100n);
    const laterLedger = await ledgerOf(later.userId);
    expect(laterLedger.rows).toEqual([{ balanceDelta: 150n, version: 2 }]);
    expect(laterLedger.balance).toBe(150n);
  });
});

describe('resolveActiveRule', () => {
  it('finds nothing when the code has no active version', async () => {
    await tmp.pool.query(`update bonus_rules set is_active = false where code = 'link_bonus'`);
    expect(await resolveActiveRule(tmp.db, LINK_BONUS_RULE_CODE)).toBeUndefined();
  });

  it.each([
    ['ended', `valid_to = now() - interval '1 second'`],
    ['not started', `valid_from = now() + interval '1 hour'`],
  ])('finds nothing when the active version is %s, by the database clock', async (_l, set) => {
    await tmp.pool.query(`update bonus_rules set ${set} where code = 'link_bonus' and version = 1`);
    expect(await resolveActiveRule(tmp.db, LINK_BONUS_RULE_CODE)).toBeUndefined();
  });

  it('finds the active version inside its window', async () => {
    await tmp.pool.query(
      `update bonus_rules set valid_from = now() - interval '1 hour', valid_to = now() + interval '1 hour'
        where code = 'link_bonus' and version = 1`,
    );
    expect(await resolveActiveRule(tmp.db, LINK_BONUS_RULE_CODE)).toMatchObject({
      version: 1,
      kind: 'link_bonus',
      params: { tokens: 100n },
    });
  });
});

describe('no active link_bonus version', () => {
  it('activates the account without a pack (no_active_rule)', async () => {
    await deactivateBonusRule(tmp.db, { code: LINK_BONUS_RULE_CODE });
    const user = await pendingPartner();
    expect(await confirm(user)).toMatchObject({
      ok: true,
      account: { status: 'active' },
      grant: { granted: false, reason: 'no_active_rule' },
    });
    expect(await ledgerOf(user.userId)).toEqual({ rows: [], balance: 0n });
  });
});

describe('an active version that cannot be applied', () => {
  it.each([
    ['tokens as a JSON number', 'link_bonus', { tokens: 150 }],
    ['tokens over the cap', 'link_bonus', { tokens: '1001' }],
    ['an unknown key', 'link_bonus', { tokens: '10', extra: true }],
    ['a kind the reference does not take', 'referral_reward', { tokens: '10' }],
  ])('throws InvalidBonusRule and writes nothing: %s', async (_label, kind, params) => {
    const version = Number(
      (
        await tmp.pool.query<{ v: number }>(
          `select max(version) + 1 as v from bonus_rules where code = 'link_bonus'`,
        )
      ).rows[0]!.v,
    );
    await insertRawVersion(version, kind, params);
    await tmp.pool.query(`update bonus_rules set is_active = false where code = 'link_bonus'`);
    await tmp.pool.query(
      `update bonus_rules set is_active = true where code = 'link_bonus' and version = $1`,
      [version],
    );
    const user = await pendingPartner();
    const error = await confirm(user).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(InvalidBonusRule);
    expect(error).toMatchObject({ name: 'InvalidBonusRule', code: 'link_bonus' });
    expect(await accountStatus(user.accountId)).toBe('pending');
    expect(await ledgerOf(user.userId)).toEqual({ rows: [], balance: 0n });
  });
});

// #116: the reference picks the kind, so an inviter's reward never pays under a pack's rule
describe('a reference the rule kind does not take', () => {
  it('throws InvalidBonusRule for a referral reference under the link_bonus rule', async () => {
    const user = await seedUser(tmp.db, { balance: 0n });
    const error = await tmp.db
      .transaction((tx) =>
        applyBonus(tx, {
          code: LINK_BONUS_RULE_CODE,
          userId: user.userId,
          reference: { referralId: randomUUID() },
        }),
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(InvalidBonusRule);
    expect(error).toMatchObject({ code: LINK_BONUS_RULE_CODE });
    expect(await ledgerOf(user.userId)).toEqual({ rows: [], balance: 0n });
  });
});

describe('a grant during an activation', () => {
  // the swap holds the code's rows FOR NO KEY UPDATE; the grant's FK takes KEY SHARE, which does
  // not wait for it, and binds the version it read
  it('does not wait for the swap and stays on the version it read', async () => {
    const created = await createBonusRuleVersion(tmp.db, {
      code: LINK_BONUS_RULE_CODE,
      params: { tokens: '7' },
    });
    if (!created.ok) throw new Error('setup: version not created');
    const user = await pendingPartner();

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const swap = tmp.db.transaction(async (tx) => {
      await tx
        .select({ id: bonusRules.id })
        .from(bonusRules)
        .where(eq(bonusRules.code, LINK_BONUS_RULE_CODE))
        .for('no key update');
      await tx
        .update(bonusRules)
        .set({ isActive: false })
        .where(and(eq(bonusRules.code, LINK_BONUS_RULE_CODE), eq(bonusRules.isActive, true)));
      locked();
      await held;
      await tx.update(bonusRules).set({ isActive: true }).where(eq(bonusRules.id, created.row.id));
    });
    await lockTaken;
    try {
      const grant = await confirm(user);
      expect(grant).toMatchObject({ grant: { granted: true, tokens: 100n } });
      expect(await lockWaiters(tmp.db)).toBe(0);
    } finally {
      release();
      await swap;
    }
    expect((await ledgerOf(user.userId)).rows).toEqual([{ balanceDelta: 100n, version: 1 }]);
  });
});

describe('applyBonus', () => {
  it('moves the cache by the rule tokens in the same transaction, once per user', async () => {
    const user = await seedUser(tmp.db, { balance: 3n });
    const accountId = await seedBrokerAccount(tmp.db, user.userId, { isPartnerClient: true });
    const grant = () =>
      tmp.db.transaction((tx) =>
        applyBonus(tx, {
          code: LINK_BONUS_RULE_CODE,
          userId: user.userId,
          reference: { brokerAccountId: accountId },
        }),
      );
    expect(await grant()).toMatchObject({ granted: true, tokens: 100n, version: 1 });
    expect(await grant()).toEqual({ granted: false, reason: 'already_granted' });
    const ledger = await ledgerOf(user.userId);
    expect(ledger.balance).toBe(103n);
    expect(ledger.rows).toEqual([{ balanceDelta: 100n, version: 1 }]);
  });
});

describe('the CLI writers', () => {
  const auditOf = async (action: string) =>
    tmp.db
      .select({ actorType: auditLog.actorType, payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.action, action as never));

  it('creates a first version of a new code only with a kind, and with valid params', async () => {
    expect(await createBonusRuleVersion(tmp.db, { code: 'deposit_bonus', params: {} })).toEqual({
      ok: false,
      reason: 'kind_required',
    });
    expect(
      await createBonusRuleVersion(tmp.db, {
        code: 'deposit_bonus',
        kind: 'deposit_bonus',
        params: { tokensPerUsd: '1' },
      }),
    ).toMatchObject({ ok: false, reason: 'params_refused' });
    const created = await createBonusRuleVersion(tmp.db, {
      code: 'deposit_bonus',
      kind: 'deposit_bonus',
      params: { tokensPerUsd: '0.5', minAmountUsd: '10', maxTokens: '500' },
    });
    expect(created).toMatchObject({
      ok: true,
      row: { code: 'deposit_bonus', version: 1, kind: 'deposit_bonus', isActive: false },
    });
    expect(await auditOf('bonus_rule_version_created')).toContainEqual({
      actorType: 'system',
      payload: {
        code: 'deposit_bonus',
        version: 1,
        kind: 'deposit_bonus',
        params: { tokensPerUsd: '0.5', minAmountUsd: '10', maxTokens: '500' },
      },
    });
  });

  it('refuses a kind other than the code’s own', async () => {
    expect(
      await createBonusRuleVersion(tmp.db, {
        code: LINK_BONUS_RULE_CODE,
        kind: 'referral_reward',
        params: { tokens: '5' },
      }),
    ).toEqual({ ok: false, reason: 'kind_mismatch', kind: 'link_bonus' });
  });

  it('refuses to activate an unknown or an already active version, and writes no audit row', async () => {
    const before = (await auditOf('bonus_rule_activated')).length;
    expect(
      await activateBonusRuleVersion(tmp.db, { code: LINK_BONUS_RULE_CODE, version: 99 }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(
      await activateBonusRuleVersion(tmp.db, { code: LINK_BONUS_RULE_CODE, version: 1 }),
    ).toEqual({ ok: false, reason: 'already_active' });
    expect((await auditOf('bonus_rule_activated')).length).toBe(before);
  });

  it('refuses to activate a version whose params no longer parse', async () => {
    const version = Number(
      (
        await tmp.pool.query<{ v: number }>(
          `select max(version) + 1 as v from bonus_rules where code = 'link_bonus'`,
        )
      ).rows[0]!.v,
    );
    await insertRawVersion(version, 'link_bonus', { tokens: 5 });
    expect(
      await activateBonusRuleVersion(tmp.db, { code: LINK_BONUS_RULE_CODE, version }),
    ).toMatchObject({ ok: false, reason: 'params_refused' });
    expect(await resolveActiveRule(tmp.db, LINK_BONUS_RULE_CODE)).toMatchObject({ version: 1 });
  });

  it('records an activation and a deactivation, each with its audit row', async () => {
    const created = await createBonusRuleVersion(tmp.db, {
      code: LINK_BONUS_RULE_CODE,
      params: { tokens: '20' },
    });
    if (!created.ok) throw new Error('setup: version not created');
    const { version } = created.row;
    await activateBonusRuleVersion(tmp.db, { code: LINK_BONUS_RULE_CODE, version });
    expect(await auditOf('bonus_rule_activated')).toContainEqual({
      actorType: 'system',
      payload: { code: 'link_bonus', version, previousVersion: 1 },
    });
    expect(await deactivateBonusRule(tmp.db, { code: LINK_BONUS_RULE_CODE })).toMatchObject({
      ok: true,
      row: { version, isActive: false },
    });
    expect(await auditOf('bonus_rule_deactivated')).toContainEqual({
      actorType: 'system',
      payload: { code: 'link_bonus', version },
    });
    expect(await deactivateBonusRule(tmp.db, { code: LINK_BONUS_RULE_CODE })).toEqual({
      ok: false,
      reason: 'not_active',
    });
    expect(await deactivateBonusRule(tmp.db, { code: 'nothing' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    // nothing active: an activation from there has no previous version
    expect(
      await activateBonusRuleVersion(tmp.db, { code: LINK_BONUS_RULE_CODE, version: 1 }),
    ).toMatchObject({ ok: true, previousVersion: null });
  });

  it('never edits a version: the triggers refuse what the writers never attempt', async () => {
    await expect(
      tmp.db.execute(
        sql`update bonus_rules set params = '{"tokens": "1"}' where code = 'link_bonus'`,
      ),
    ).rejects.toMatchObject({ cause: { code: 'P0001' } });
  });
});
