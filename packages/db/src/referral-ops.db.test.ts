import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFERRAL_CODE_PATTERN, UserStatus } from '@binarius/shared';
import { readUserReferral, randomReferralCode, REFERRAL_CODE_ATTEMPTS } from './referral-ops';
import { referralCodes, referrals } from './schema/index';
import { createTempDatabase, seedUser, type TempDatabase } from './testing';

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

const read = (telegramUserId: string, generate?: () => string) =>
  readUserReferral(tmp.db, BigInt(telegramUserId), generate);
const codesOf = (userId: string) =>
  tmp.db
    .select({ code: referralCodes.code })
    .from(referralCodes)
    .where(eq(referralCodes.userId, userId));
// a generator that answers `codes` in turn and counts its calls
const sequence = (...codes: string[]) => {
  const generator = Object.assign(() => codes[generator.calls++] ?? 'Exhausted', { calls: 0 });
  return generator;
};

describe('readUserReferral (#115)', () => {
  it('C1 creates a code on the first read and returns the same one afterwards', async () => {
    const user = await seedUser(tmp.db);
    const first = await read(user.telegramUserId);
    expect(first?.code).toMatch(REFERRAL_CODE_PATTERN);
    expect(first).toEqual({ status: UserStatus.Active, code: first?.code, invited: 0 });
    const second = await read(user.telegramUserId);
    expect(second?.code).toBe(first?.code);
    expect(await codesOf(user.userId)).toEqual([{ code: first?.code }]);
  });

  it('C2 answers undefined for a Telegram id without a users row, and writes nothing', async () => {
    const before = await tmp.db.select({ code: referralCodes.code }).from(referralCodes);
    expect(await read('999999999')).toBeUndefined();
    expect(await tmp.db.select({ code: referralCodes.code }).from(referralCodes)).toEqual(before);
  });

  it('C3 gives a blocked user no code and creates none', async () => {
    const user = await seedUser(tmp.db, { status: UserStatus.Blocked });
    expect(await read(user.telegramUserId)).toEqual({
      status: UserStatus.Blocked,
      code: null,
      invited: 0,
    });
    expect(await codesOf(user.userId)).toEqual([]);
  });

  it('C4 counts only this inviter’s invitees', async () => {
    const [inviter, other] = [await seedUser(tmp.db), await seedUser(tmp.db)];
    const invitees = [await seedUser(tmp.db), await seedUser(tmp.db), await seedUser(tmp.db)];
    await tmp.db.insert(referrals).values([
      { inviteeUserId: invitees[0]!.userId, inviterUserId: inviter.userId },
      { inviteeUserId: invitees[1]!.userId, inviterUserId: inviter.userId },
      { inviteeUserId: invitees[2]!.userId, inviterUserId: other.userId },
    ]);
    expect((await read(inviter.telegramUserId))?.invited).toBe(2);
    expect((await read(other.telegramUserId))?.invited).toBe(1);
    expect((await read(invitees[0]!.telegramUserId))?.invited).toBe(0);
  });

  it('C4 counts a blocked inviter’s invitees too', async () => {
    const [inviter, invitee] = [
      await seedUser(tmp.db, { status: UserStatus.Blocked }),
      await seedUser(tmp.db),
    ];
    await tmp.db
      .insert(referrals)
      .values({ inviteeUserId: invitee.userId, inviterUserId: inviter.userId });
    expect((await read(inviter.telegramUserId))?.invited).toBe(1);
  });

  it('C5 draws a new code when the first collides with another user’s', async () => {
    const [owner, user] = [await seedUser(tmp.db), await seedUser(tmp.db)];
    await tmp.db.insert(referralCodes).values({ userId: owner.userId, code: 'Taken001' });
    const generator = sequence('Taken001', 'Fresh001');
    expect((await read(user.telegramUserId, generator))?.code).toBe('Fresh001');
    expect(generator.calls).toBe(2);
    expect(await codesOf(owner.userId)).toEqual([{ code: 'Taken001' }]);
  });

  it('C6 throws after REFERRAL_CODE_ATTEMPTS collisions and writes nothing', async () => {
    const [owner, user] = [await seedUser(tmp.db), await seedUser(tmp.db)];
    await tmp.db.insert(referralCodes).values({ userId: owner.userId, code: 'Taken002' });
    const generator = sequence(...Array<string>(REFERRAL_CODE_ATTEMPTS + 1).fill('Taken002'));
    await expect(read(user.telegramUserId, generator)).rejects.toThrow(
      'no free referral code after 3 attempts',
    );
    expect(generator.calls).toBe(REFERRAL_CODE_ATTEMPTS);
    expect(await codesOf(user.userId)).toEqual([]);
  });

  it('C7 two concurrent first reads agree on one code', async () => {
    const user = await seedUser(tmp.db);
    const [a, b] = await Promise.all([read(user.telegramUserId), read(user.telegramUserId)]);
    expect(a?.code).toBe(b?.code);
    expect(await codesOf(user.userId)).toHaveLength(1);
  });
});

describe('randomReferralCode', () => {
  it('draws codes of the pattern over the whole alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const code = randomReferralCode();
      expect(code).toMatch(REFERRAL_CODE_PATTERN);
      for (const character of code) seen.add(character);
    }
    expect(seen.size).toBe(62);
  });
});
