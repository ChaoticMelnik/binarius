import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  NotificationLevel,
  START_PAYLOAD_PATTERN,
  UserStatus,
  startPayloadSchema,
  userStartViewSchema,
  type DecimalString,
  type OAuthTokens,
} from '@binarius/shared';
import { START_PAYLOAD_CORPUS } from '@binarius/shared/testing';
import { createTokenCipher } from './crypto';
import { setNotificationLevel } from './delivery-ops';
import { confirmBrokerAccount, linkBrokerAccount } from './oauth-ops';
import { createTempDatabase, seedBrokerAccount, type TempDatabase } from './testing';
import { brokerAccounts, referralCodes, referrals, users } from './schema/index';
import { readDemoStake, recordUserStart, setDemoStake, toUserStartView } from './user-ops';

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

let seq = 0;
const nextTelegramUserId = (): bigint => BigInt(500_000 + ++seq);

const start = (
  telegramUserId: bigint,
  patch: Partial<Parameters<typeof recordUserStart>[1]> = {},
) => recordUserStart(tmp.db, { telegramUserId, displayName: 'Ada', ...patch });

const readUser = async (telegramUserId: bigint) => {
  const [row] = await tmp.db
    .select({
      displayName: users.displayName,
      languageCode: users.languageCode,
      status: users.status,
      acquisitionSource: users.acquisitionSource,
      acquiredAt: users.acquiredAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId));
  if (row === undefined) throw new Error(`no users row for ${telegramUserId}`);
  return row;
};

const caught = (error: unknown): Record<string, unknown> =>
  (error as { cause?: Record<string, unknown> } | undefined)?.cause ?? {};

const rejection = (query: Promise<unknown>): Promise<unknown> =>
  query.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

describe('recordUserStart: first touch', () => {
  it('records the first non-empty payload and never replaces it', async () => {
    const telegramUserId = nextTelegramUserId();
    const first = await start(telegramUserId, { startPayload: 'src_one' });
    expect(first.row.acquisitionSource).toBe('src_one');
    expect(first.row.acquiredAt).toBeInstanceOf(Date);

    const second = await start(telegramUserId, { startPayload: 'src_two' });
    expect(second.row.acquisitionSource).toBe('src_one');
    expect(second.row.acquiredAt?.getTime()).toBe(first.row.acquiredAt?.getTime());
  });

  it('leaves both columns NULL while no /start carried a payload, and fills them on the one that does', async () => {
    const telegramUserId = nextTelegramUserId();
    const organic = await start(telegramUserId);
    expect(organic.row.acquisitionSource).toBeNull();
    expect(organic.row.acquiredAt).toBeNull();

    const attributed = await start(telegramUserId, { startPayload: 'src_late' });
    expect(attributed.row.acquisitionSource).toBe('src_late');
    expect(attributed.row.acquiredAt).toBeInstanceOf(Date);

    // a later payload-less /start does not undo it
    const after = await start(telegramUserId);
    expect(after.row.acquisitionSource).toBe('src_late');
    expect(after.row.acquiredAt?.getTime()).toBe(attributed.row.acquiredAt?.getTime());
  });

  it('times the touch by the database clock, not by the caller', async () => {
    const telegramUserId = nextTelegramUserId();
    const { row } = await start(telegramUserId, { startPayload: 'src_clock' });
    expect(row.acquiredAt).not.toBeNull();
    // compared inside the database: the two clocks are the same one only if this holds there
    const [fresh] = await tmp.db
      .select({
        fresh: sql<boolean>`now() - ${users.acquiredAt} between interval '0' and interval '5 seconds'`,
      })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    expect(fresh?.fresh).toBe(true);
  });
});

describe('recordUserStart: the rest of the row', () => {
  it('takes the latest display name and keeps the last usable language code', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId, { displayName: 'Ada', languageCode: 'en-US' });
    await start(telegramUserId, { displayName: 'Ada Lovelace' });
    expect(await readUser(telegramUserId)).toMatchObject({
      displayName: 'Ada Lovelace',
      languageCode: 'en-US',
    });

    await start(telegramUserId, { displayName: 'Ada Lovelace', languageCode: 'ru' });
    expect((await readUser(telegramUserId)).languageCode).toBe('ru');
  });

  it('moves updated_at on a repeat /start, which $onUpdate would not do on this path', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    await tmp.db
      .update(users)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(users.telegramUserId, telegramUserId));
    const backdated = (await readUser(telegramUserId)).updatedAt;

    await start(telegramUserId);
    expect((await readUser(telegramUserId)).updatedAt.getTime()).toBeGreaterThan(
      backdated.getTime(),
    );
  });

  it('does not unblock a blocked user', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.telegramUserId, telegramUserId));

    const { row } = await start(telegramUserId, { startPayload: 'src_blocked' });
    expect(row.status).toBe(UserStatus.Blocked);
    // the row is still maintained: the block is about what the user may do, not about identity
    expect(row.acquisitionSource).toBe('src_blocked');
  });

  it('clears the Telegram block mark on a repeat /start and leaves it NULL on a first one', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    const blockedAt = async () => {
      const [row] = await tmp.db
        .select({ at: users.telegramBlockedAt })
        .from(users)
        .where(eq(users.telegramUserId, telegramUserId));
      return row?.at;
    };
    expect(await blockedAt()).toBeNull();

    await tmp.db
      .update(users)
      .set({ telegramBlockedAt: sql`now()` })
      .where(eq(users.telegramUserId, telegramUserId));
    expect(await blockedAt()).toBeInstanceOf(Date);

    await start(telegramUserId);
    expect(await blockedAt()).toBeNull();
  });

  it('returns all for a new user, the stored level afterwards, and keeps it on a repeat /start', async () => {
    const telegramUserId = nextTelegramUserId();
    expect((await start(telegramUserId)).row.notificationLevel).toBe(NotificationLevel.All);
    await setNotificationLevel(tmp.db, telegramUserId, NotificationLevel.Reduced);
    expect((await start(telegramUserId)).row.notificationLevel).toBe(NotificationLevel.Reduced);
    expect((await start(telegramUserId)).row.notificationLevel).toBe(NotificationLevel.Reduced);
  });

  it('creates exactly one row when two first /start updates race', async () => {
    const telegramUserId = nextTelegramUserId();
    const [a, b] = await Promise.all([
      start(telegramUserId, { startPayload: 'src_race' }),
      start(telegramUserId),
    ]);
    expect(a.row.id).toBe(b.row.id);
    const rows = await tmp.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    expect(rows).toHaveLength(1);
    expect((await readUser(telegramUserId)).acquisitionSource).toBe('src_race');
  });
});

describe('recordUserStart: hasActiveBrokerAccount', () => {
  it.each([
    [BrokerAccountStatus.Pending, false],
    [BrokerAccountStatus.Revoked, false],
    [BrokerAccountStatus.Active, true],
  ])('is %s → %s', async (status, expected) => {
    const telegramUserId = nextTelegramUserId();
    const { row, hasActiveBrokerAccount } = await start(telegramUserId);
    expect(hasActiveBrokerAccount).toBe(false);

    await seedBrokerAccount(tmp.db, row.id, { status });
    expect((await start(telegramUserId)).hasActiveBrokerAccount).toBe(expected);
  });

  it('is true when any one of several accounts is active', async () => {
    const telegramUserId = nextTelegramUserId();
    const { row } = await start(telegramUserId);
    await seedBrokerAccount(tmp.db, row.id, { status: BrokerAccountStatus.Revoked });
    await seedBrokerAccount(tmp.db, row.id, { status: BrokerAccountStatus.Active });
    expect((await start(telegramUserId)).hasActiveBrokerAccount).toBe(true);
  });
});

describe('recordUserStart: pendingBrokerAccounts', () => {
  it('lists only the pending accounts, newest first, as id and email', async () => {
    const telegramUserId = nextTelegramUserId();
    const { row } = await start(telegramUserId);
    expect((await start(telegramUserId)).pendingBrokerAccounts).toEqual([]);

    const older = await seedBrokerAccount(tmp.db, row.id, { status: BrokerAccountStatus.Pending });
    await seedBrokerAccount(tmp.db, row.id, { status: BrokerAccountStatus.Active });
    await seedBrokerAccount(tmp.db, row.id, { status: BrokerAccountStatus.Revoked });
    const newer = await seedBrokerAccount(tmp.db, row.id, { status: BrokerAccountStatus.Pending });
    await tmp.db
      .update(brokerAccounts)
      .set({ email: 'older@example.test', createdAt: sql`now() - interval '1 hour'` })
      .where(eq(brokerAccounts.id, older));

    expect((await start(telegramUserId)).pendingBrokerAccounts).toEqual([
      { id: newer, email: null },
      { id: older, email: 'older@example.test' },
    ]);
  });

  it('does not list another user’s pending account', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    const other = await start(nextTelegramUserId());
    await seedBrokerAccount(tmp.db, other.row.id, { status: BrokerAccountStatus.Pending });
    expect((await start(telegramUserId)).pendingBrokerAccounts).toEqual([]);
  });
});

describe('the source survives linking a broker account', () => {
  it('keeps the first touch across link and confirm, and only then reports an active account', async () => {
    const cipher = createTokenCipher({ keyId: 'test-key', key: randomBytes(32) });
    const telegramUserId = nextTelegramUserId();
    const first = await start(telegramUserId, { startPayload: 'src_survives' });

    const tokens: OAuthTokens = {
      accessToken: 'access-survives',
      refreshToken: 'refresh-survives',
      tokenType: 'Bearer',
      expiresInSec: 3_600,
      user: {
        id: `broker-survives-${telegramUserId}`,
        email: 'a@example.test',
        isPartnerClient: false,
      },
    };
    const linked = await linkBrokerAccount(tmp.db, {
      telegramUserId,
      tokens,
      cipher,
      activate: false,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) throw new Error('link failed');

    const pending = await start(telegramUserId);
    expect(pending.hasActiveBrokerAccount).toBe(false);
    expect(pending.pendingBrokerAccounts).toEqual([
      { id: linked.account.id, email: 'a@example.test' },
    ]);

    const confirmed = await confirmBrokerAccount(tmp.db, {
      telegramUserId,
      accountId: linked.account.id,
    });
    expect(confirmed.ok).toBe(true);

    const after = await start(telegramUserId);
    expect(after.hasActiveBrokerAccount).toBe(true);
    expect(after.pendingBrokerAccounts).toEqual([]);
    expect(after.row.acquisitionSource).toBe('src_survives');
    expect(after.row.acquiredAt?.getTime()).toBe(first.row.acquiredAt?.getTime());
  });
});

describe('startPayloadSchema and users_acquisition_source_check agree', () => {
  // one corpus, two engines: the zod verdict and the live CHECK are compared row by row
  it.each(START_PAYLOAD_CORPUS)('$label', async ({ value, valid }) => {
    expect(startPayloadSchema.safeParse(value).success).toBe(valid);
    expect(START_PAYLOAD_PATTERN.test(value)).toBe(valid);

    const telegramUserId = nextTelegramUserId();
    const insert = tmp.db
      .insert(users)
      .values({ telegramUserId, acquisitionSource: value, acquiredAt: sql`now()` });
    if (valid) {
      await insert;
      expect((await readUser(telegramUserId)).acquisitionSource).toBe(value);
      return;
    }
    expect(caught(await rejection(insert))).toMatchObject({
      code: '23514',
      constraint: 'users_acquisition_source_check',
    });
  });

  it('accepts the NULL pair', async () => {
    const telegramUserId = nextTelegramUserId();
    await tmp.db.insert(users).values({ telegramUserId });
    expect(await readUser(telegramUserId)).toMatchObject({
      acquisitionSource: null,
      acquiredAt: null,
    });
  });

  it.each([
    ['a source without a time', { acquisitionSource: 'src_half' }],
    ['a time without a source', { acquiredAt: sql`now()` }],
  ])('rejects %s', async (_label, patch) => {
    const telegramUserId = nextTelegramUserId();
    expect(
      caught(await rejection(tmp.db.insert(users).values({ telegramUserId, ...patch }))),
    ).toMatchObject({ code: '23514', constraint: 'users_acquisition_pair_check' });
  });
});

describe('toUserStartView', () => {
  it('projects exactly the wire keys', async () => {
    const telegramUserId = nextTelegramUserId();
    const { row, hasActiveBrokerAccount, pendingBrokerAccounts } = await start(telegramUserId, {
      startPayload: 'src_view',
      languageCode: 'ru',
    });
    const view = toUserStartView(row, hasActiveBrokerAccount, pendingBrokerAccounts);
    expect(Object.keys(view).sort()).toEqual([
      'acquiredAt',
      'acquisitionSource',
      'demoStake',
      'hasActiveBrokerAccount',
      'notificationLevel',
      'pendingBrokerAccounts',
      'status',
      'telegramUserId',
    ]);
    expect(view).toMatchObject({
      telegramUserId: telegramUserId.toString(),
      status: UserStatus.Active,
      acquisitionSource: 'src_view',
      hasActiveBrokerAccount: false,
      pendingBrokerAccounts: [],
      notificationLevel: NotificationLevel.All,
      demoStake: null,
    });
    expect(userStartViewSchema.safeParse(view).success).toBe(true);
  });

  // the list arrives typed, but a caller holding a wider row must not widen the wire
  it('copies only id and email of each pending account', async () => {
    const { row } = await start(nextTelegramUserId());
    const wide = { id: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01', email: null, brokerUserId: 'b-1' };
    const view = toUserStartView(row, false, [wide]);
    expect(view.pendingBrokerAccounts).toEqual([{ id: wide.id, email: null }]);
    expect(Object.keys(view.pendingBrokerAccounts[0]!)).toEqual(['id', 'email']);
  });

  // rows stored before #214 may hold a blank address; the button must not read «✅ Подтвердить: »
  it.each([[''], [' \t ']])('shows a blank pending address %j as none', async (email) => {
    const telegramUserId = nextTelegramUserId();
    const { row } = await start(telegramUserId);
    const id = await seedBrokerAccount(tmp.db, row.id, { status: BrokerAccountStatus.Pending });
    await tmp.db.update(brokerAccounts).set({ email }).where(eq(brokerAccounts.id, id));

    const started = await start(telegramUserId);
    expect(started.pendingBrokerAccounts).toEqual([{ id, email }]);
    const view = toUserStartView(
      started.row,
      started.hasActiveBrokerAccount,
      started.pendingBrokerAccounts,
    );
    expect(view.pendingBrokerAccounts).toEqual([{ id, email: null }]);
  });

  it('carries a null acquisition through as null', async () => {
    const telegramUserId = nextTelegramUserId();
    const { row } = await start(telegramUserId);
    const view = toUserStartView(row, false, []);
    expect(view).toMatchObject({ acquisitionSource: null, acquiredAt: null });
    expect(userStartViewSchema.safeParse(view).success).toBe(true);
  });

  it('leaves the broker account columns out of the projection', async () => {
    const telegramUserId = nextTelegramUserId();
    const { row } = await start(telegramUserId);
    await seedBrokerAccount(tmp.db, row.id, { status: BrokerAccountStatus.Active });
    const [account] = await tmp.db
      .select({ id: brokerAccounts.id })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.userId, row.id));
    expect(account).toBeDefined();
    expect(JSON.stringify(toUserStartView(row, true, []))).not.toContain(account!.id);
  });
});

describe('setDemoStake / readDemoStake (#297)', () => {
  const stake = (value: string) => value as DecimalString;

  it('starts at NULL, stores a stake canonically and resets it', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    expect(await readDemoStake(tmp.db, telegramUserId)).toBeNull();

    expect(await setDemoStake(tmp.db, telegramUserId, stake('2.50'))).toEqual({ demoStake: '2.5' });
    expect(await readDemoStake(tmp.db, telegramUserId)).toBe('2.5');
    const { row, hasActiveBrokerAccount, pendingBrokerAccounts } = await start(telegramUserId);
    expect(toUserStartView(row, hasActiveBrokerAccount, pendingBrokerAccounts).demoStake).toBe(
      '2.5',
    );
    expect(await setNotificationLevel(tmp.db, telegramUserId, NotificationLevel.Off)).toEqual({
      level: NotificationLevel.Off,
      demoStake: '2.5',
      canceledJobs: 0,
    });

    expect(await setDemoStake(tmp.db, telegramUserId, null)).toEqual({ demoStake: null });
    expect(await readDemoStake(tmp.db, telegramUserId)).toBeNull();
  });

  it('answers undefined for an unknown user and writes nothing', async () => {
    const telegramUserId = nextTelegramUserId();
    expect(await setDemoStake(tmp.db, telegramUserId, stake('5'))).toBeUndefined();
    expect(await readDemoStake(tmp.db, telegramUserId)).toBeUndefined();
    expect(
      await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)),
    ).toEqual([]);
  });

  it('touches only demo_stake and updated_at', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId, { startPayload: 'src_stake' });
    const before = (
      await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId))
    )[0]!;
    await setDemoStake(tmp.db, telegramUserId, stake('7'));
    const after = (
      await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId))
    )[0]!;
    expect({ ...after, demoStake: before.demoStake, updatedAt: before.updatedAt }).toEqual(before);
    expect(after.demoStake).toBe('7.00000000');
  });
});

// Personal start links (#115, docs/referrals.md): only a user this /start creates is an invitee.
describe('recordUserStart: referral (#115)', () => {
  let codeSeq = 0;
  // an inviter with a code of its own, as readUserReferral leaves it
  const seedInviter = async (): Promise<{ userId: string; code: string }> => {
    const { row } = await start(nextTelegramUserId());
    const code = `Inv${String(++codeSeq).padStart(5, '0')}`;
    await tmp.db.insert(referralCodes).values({ userId: row.id, code });
    return { userId: row.id, code };
  };
  const referralsOf = (inviteeUserId: string) =>
    tmp.db
      .select({ inviterUserId: referrals.inviterUserId })
      .from(referrals)
      .where(eq(referrals.inviteeUserId, inviteeUserId));

  it('R1 records the inviter of a new user’s first /start ref_<code>', async () => {
    const inviter = await seedInviter();
    const started = await start(nextTelegramUserId(), { startPayload: `ref_${inviter.code}` });
    expect(started.referred).toBe(true);
    expect(await referralsOf(started.row.id)).toEqual([{ inviterUserId: inviter.userId }]);
    expect(started.row.acquisitionSource).toBe(`ref_${inviter.code}`);
  });

  it('R2 keeps the first inviter when the same user follows another link', async () => {
    const [first, second] = [await seedInviter(), await seedInviter()];
    const telegramUserId = nextTelegramUserId();
    const started = await start(telegramUserId, { startPayload: `ref_${first.code}` });
    const again = await start(telegramUserId, { startPayload: `ref_${second.code}` });
    expect(again.referred).toBe(false);
    expect(await referralsOf(started.row.id)).toEqual([{ inviterUserId: first.userId }]);
  });

  it.each([
    ['a payload-less /start', undefined],
    ['an organic payload', 'src_organic'],
  ])(
    'R3 records nothing for a user created by %s who then follows a link',
    async (_label, payload) => {
      const inviter = await seedInviter();
      const telegramUserId = nextTelegramUserId();
      const created = await start(telegramUserId, { startPayload: payload });
      const later = await start(telegramUserId, { startPayload: `ref_${inviter.code}` });
      expect(later.referred).toBe(false);
      expect(await referralsOf(created.row.id)).toEqual([]);
      // first touch still fills an empty slot by its own rule
      expect(later.row.acquisitionSource).toBe(payload ?? `ref_${inviter.code}`);
    },
  );

  it('R4 records nothing for an unknown code and answers the /start as before', async () => {
    const started = await start(nextTelegramUserId(), { startPayload: 'ref_Unkn0wn1' });
    expect(started.referred).toBe(false);
    expect(await referralsOf(started.row.id)).toEqual([]);
    expect(started.row.acquisitionSource).toBe('ref_Unkn0wn1');
    expect(started.hasActiveBrokerAccount).toBe(false);
  });

  it.each(['ref_abc', 'ref_abcdEFG1x', 'ref_'])(
    'R5 records nothing for the malformed code in %j',
    async (payload) => {
      // a code that would match once the malformed tail is cut must not be found either
      await tmp.db
        .insert(referralCodes)
        .values({ userId: (await start(nextTelegramUserId())).row.id, code: 'abcdEFG1' })
        .onConflictDoNothing();
      const started = await start(nextTelegramUserId(), { startPayload: payload });
      expect(started.referred).toBe(false);
      expect(await referralsOf(started.row.id)).toEqual([]);
    },
  );

  it('R6 two racing first /start ref_<code> make one users row and one referral', async () => {
    const inviter = await seedInviter();
    const telegramUserId = nextTelegramUserId();
    const results = await Promise.all([
      start(telegramUserId, { startPayload: `ref_${inviter.code}` }),
      start(telegramUserId, { startPayload: `ref_${inviter.code}` }),
    ]);
    expect(results[0].row.id).toBe(results[1].row.id);
    expect(results.filter((result) => result.referred)).toHaveLength(1);
    expect(await referralsOf(results[0].row.id)).toEqual([{ inviterUserId: inviter.userId }]);
  });

  it('R7 refuses a forced self row by referrals_not_self_check', async () => {
    const { row } = await start(nextTelegramUserId());
    const error = await rejection(
      tmp.db.insert(referrals).values({ inviteeUserId: row.id, inviterUserId: row.id }),
    );
    expect(caught(error)).toMatchObject({
      code: '23514',
      constraint: 'referrals_not_self_check',
    });
  });

  it('R8 leaves `referred` off the wire', async () => {
    const inviter = await seedInviter();
    const started = await start(nextTelegramUserId(), { startPayload: `ref_${inviter.code}` });
    const view = toUserStartView(
      started.row,
      started.hasActiveBrokerAccount,
      started.pendingBrokerAccounts,
    );
    expect(Object.keys(view)).not.toContain('referred');
    expect(Object.keys(started.row)).not.toContain('inserted');
  });
});
