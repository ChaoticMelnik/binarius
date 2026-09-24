import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerAccountStatus,
  START_PAYLOAD_PATTERN,
  UserStatus,
  startPayloadSchema,
  userStartViewSchema,
  type OAuthTokens,
} from '@binarius/shared';
import { START_PAYLOAD_CORPUS } from '@binarius/shared/testing';
import { createTokenCipher } from './crypto';
import { confirmBrokerAccount, linkBrokerAccount } from './oauth-ops';
import { createTempDatabase, seedBrokerAccount, type TempDatabase } from './testing';
import { brokerAccounts, users } from './schema/index';
import { recordUserStart, toUserStartView } from './user-ops';

const baseUrl = process.env.DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('DATABASE_URL is required for packages/db integration tests (see README)');
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
    const linked = await linkBrokerAccount(tmp.db, { telegramUserId, tokens, cipher });
    expect(linked.ok).toBe(true);
    if (!linked.ok) throw new Error('link failed');

    const pending = await start(telegramUserId);
    expect(pending.hasActiveBrokerAccount).toBe(false);

    const confirmed = await confirmBrokerAccount(tmp.db, {
      telegramUserId,
      accountId: linked.account.id,
    });
    expect(confirmed.ok).toBe(true);

    const after = await start(telegramUserId);
    expect(after.hasActiveBrokerAccount).toBe(true);
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
    const { row, hasActiveBrokerAccount } = await start(telegramUserId, {
      startPayload: 'src_view',
      languageCode: 'ru',
    });
    const view = toUserStartView(row, hasActiveBrokerAccount);
    expect(Object.keys(view).sort()).toEqual([
      'acquiredAt',
      'acquisitionSource',
      'hasActiveBrokerAccount',
      'status',
      'telegramUserId',
    ]);
    expect(view).toMatchObject({
      telegramUserId: telegramUserId.toString(),
      status: UserStatus.Active,
      acquisitionSource: 'src_view',
      hasActiveBrokerAccount: false,
    });
    expect(userStartViewSchema.safeParse(view).success).toBe(true);
  });

  it('carries a null acquisition through as null', async () => {
    const telegramUserId = nextTelegramUserId();
    const { row } = await start(telegramUserId);
    const view = toUserStartView(row, false);
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
    expect(JSON.stringify(toUserStartView(row, true))).not.toContain(account!.id);
  });
});
