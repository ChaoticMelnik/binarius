import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerAccountStatus, UserStatus, linkBonusGrantViewSchema } from '@binarius/shared';
import { createTempDatabase, seedBrokerAccount, seedUser, type TempDatabase } from './testing';
import { LINK_BONUS_RULE_CODE, LINK_BONUS_TOKENS, toLinkBonusGrantView } from './link-bonus-ops';
import { confirmBrokerAccount } from './oauth-ops';
import { brokerAccounts, tokenLedger, users } from './schema/index';

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

// A user with no tokens and no ledger, so "balance = sum of the ledger" holds from the start
// and every assertion below can check it.
async function userWithPending(...partner: boolean[]) {
  const user = await seedUser(tmp.db, { balance: 0n });
  const accounts: string[] = [];
  for (const isPartnerClient of partner) {
    accounts.push(
      await seedBrokerAccount(tmp.db, user.userId, {
        status: BrokerAccountStatus.Pending,
        isPartnerClient,
      }),
    );
  }
  return { ...user, accounts };
}

const confirm = (user: { telegramUserId: string }, accountId: string) =>
  confirmBrokerAccount(tmp.db, { telegramUserId: BigInt(user.telegramUserId), accountId });

async function ledgerOf(userId: string) {
  const rows = await tmp.db
    .select({
      kind: tokenLedger.kind,
      balanceDelta: tokenLedger.balanceDelta,
      reservedDelta: tokenLedger.reservedDelta,
      brokerAccountId: tokenLedger.brokerAccountId,
      note: tokenLedger.note,
    })
    .from(tokenLedger)
    .where(eq(tokenLedger.userId, userId));
  const [user] = await tmp.db
    .select({ balance: users.tokenBalance })
    .from(users)
    .where(eq(users.id, userId));
  const sum = rows.reduce((total, row) => total + row.balanceDelta, 0n);
  return { rows, balance: user!.balance, sum };
}

describe('the starter pack', () => {
  it('pays LINK_BONUS_TOKENS once, on the confirm that activates a partner account', async () => {
    const user = await userWithPending(true);
    const result = await confirm(user, user.accounts[0]!);
    expect(result).toMatchObject({ ok: true, grant: { granted: true, tokens: LINK_BONUS_TOKENS } });

    const ledger = await ledgerOf(user.userId);
    expect(ledger.rows).toEqual([
      {
        kind: 'bonus',
        balanceDelta: LINK_BONUS_TOKENS,
        reservedDelta: 0n,
        brokerAccountId: user.accounts[0],
        note: LINK_BONUS_RULE_CODE,
      },
    ]);
    expect(ledger.balance).toBe(LINK_BONUS_TOKENS);
    expect(ledger.sum).toBe(ledger.balance);
  });

  it('pays nothing for a second account of the same user', async () => {
    const user = await userWithPending(true, true);
    await confirm(user, user.accounts[0]!);
    const second = await confirm(user, user.accounts[1]!);
    expect(second).toMatchObject({
      ok: true,
      account: { status: 'active' },
      grant: { granted: false, reason: 'already_granted' },
    });

    const ledger = await ledgerOf(user.userId);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.balance).toBe(LINK_BONUS_TOKENS);
    expect(ledger.sum).toBe(ledger.balance);
  });

  it('links a non-partner account without a pack and without spending the slot', async () => {
    const user = await userWithPending(false, true);
    const first = await confirm(user, user.accounts[0]!);
    expect(first).toMatchObject({
      ok: true,
      account: { status: 'active' },
      grant: { granted: false, reason: 'not_partner_client' },
    });
    const before = await ledgerOf(user.userId);
    expect(before.rows).toEqual([]);
    expect(before.balance).toBe(0n);

    const second = await confirm(user, user.accounts[1]!);
    expect(second).toMatchObject({ ok: true, grant: { granted: true } });
    const after = await ledgerOf(user.userId);
    expect(after.rows.map((row) => row.brokerAccountId)).toEqual([user.accounts[1]]);
    expect(after.balance).toBe(LINK_BONUS_TOKENS);
    expect(after.sum).toBe(after.balance);
  });

  // the users row lock serializes the two, and the unique index is what makes the loser a no-op
  it('pays exactly once when two accounts of one user are confirmed concurrently', async () => {
    const user = await userWithPending(true, true);
    const results = await Promise.all(user.accounts.map((id) => confirm(user, id)));
    const grants = results.map((result) => (result.ok ? result.grant.granted : undefined));
    expect(grants.sort()).toEqual([false, true]);

    const ledger = await ledgerOf(user.userId);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.balance).toBe(LINK_BONUS_TOKENS);
    expect(ledger.sum).toBe(ledger.balance);
  });

  it.each([
    ['an account that is already active', 'not_pending'],
    ['a blocked user', 'user_blocked'],
  ] as const)('pays nothing when the confirm refuses %s', async (_label, reason) => {
    const user = await userWithPending(true);
    if (reason === 'not_pending') {
      await tmp.db
        .update(brokerAccounts)
        .set({ status: BrokerAccountStatus.Active })
        .where(eq(brokerAccounts.id, user.accounts[0]!));
    } else {
      await tmp.db
        .update(users)
        .set({ status: UserStatus.Blocked })
        .where(eq(users.id, user.userId));
    }
    expect(await confirm(user, user.accounts[0]!)).toEqual({ ok: false, reason });
    const ledger = await ledgerOf(user.userId);
    expect(ledger.rows).toEqual([]);
    expect(ledger.balance).toBe(0n);
  });
});

describe('toLinkBonusGrantView', () => {
  it.each([
    [{ granted: true, tokens: 7n } as const, { granted: true, tokens: '7' }],
    [
      { granted: false, reason: 'already_granted' } as const,
      { granted: false, reason: 'already_granted' },
    ],
  ])('puts %o on the wire as %o', (grant, wire) => {
    const view = toLinkBonusGrantView(grant);
    expect(view).toStrictEqual(wire);
    expect(linkBonusGrantViewSchema.parse(view)).toStrictEqual(wire);
  });
});
