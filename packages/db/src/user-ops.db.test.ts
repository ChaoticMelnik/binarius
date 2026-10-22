import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditAction,
  BrokerAccountStatus,
  DepositModeSwitch,
  NotificationLevel,
  PostbackSource,
  TradeMode,
  START_PAYLOAD_PATTERN,
  UserStatus,
  botLanguageOf,
  startPayloadSchema,
  userStartViewSchema,
  type DecimalString,
  type OAuthTokens,
} from '@binarius/shared';
import { START_PAYLOAD_CORPUS, until } from '@binarius/shared/testing';
import { createTokenCipher } from './crypto';
import { setNotificationLevel } from './delivery-ops';
import { listDepositsAwaitingModeSwitch, markDepositModeSwitch } from './deposit-mode-switch-ops';
import { confirmBrokerAccount, linkBrokerAccount } from './oauth-ops';
import { recordPostback } from './postback-ops';
import { stopUserSessions } from './trading-session-ops';
import {
  createTempDatabase,
  lockWaiters,
  seedBrokerAccount,
  seedTradingSession,
  seedUser,
  type TempDatabase,
} from './testing';
import {
  auditLog,
  brokerAccounts,
  depositEvents,
  referralCodes,
  referrals,
  tradingSessions,
  users,
} from './schema/index';
import {
  readStakes,
  readUserLanguage,
  recordUserStart,
  setLastAnalysis,
  setStake,
  setTradingMode,
  setUserLanguage,
  switchTradingModeOnDeposit,
  toUserStartView,
} from './user-ops';

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
      'language',
      'notificationLevel',
      'pendingBrokerAccounts',
      'realStake',
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
      language: 'ru',
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

describe('setLastAnalysis (#484)', () => {
  const rowOf = async (telegramUserId: bigint) => {
    const [row] = await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId));
    if (row === undefined) throw new Error('no users row');
    return row;
  };
  const dbNow = async () => {
    const { rows } = await tmp.pool.query<{ now: Date }>('select clock_timestamp() as now');
    return rows[0]!.now.getTime();
  };

  it('LA1 records the pair and duration at the database clock, and null clears all three', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    const before = await dbNow();
    expect(await setLastAnalysis(tmp.db, telegramUserId, { assetId: 101, durationSec: 15 })).toBe(
      true,
    );
    const after = await dbNow();
    const row = await rowOf(telegramUserId);
    expect(row).toMatchObject({ lastAnalysisAssetId: 101, lastAnalysisDurationSec: 15 });
    expect(row.lastAnalysisAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.lastAnalysisAt!.getTime()).toBeLessThanOrEqual(after);

    expect(await setLastAnalysis(tmp.db, telegramUserId, null)).toBe(true);
    expect(await rowOf(telegramUserId)).toMatchObject({
      lastAnalysisAt: null,
      lastAnalysisAssetId: null,
      lastAnalysisDurationSec: null,
    });
  });

  it('LA2 answers false for an unknown user and writes nothing', async () => {
    const telegramUserId = nextTelegramUserId();
    expect(await setLastAnalysis(tmp.db, telegramUserId, { assetId: 101, durationSec: 15 })).toBe(
      false,
    );
    const rows = await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId));
    expect(rows).toEqual([]);
  });

  it('LA3 touches only the three columns and updated_at', async () => {
    const telegramUserId = nextTelegramUserId();
    const other = nextTelegramUserId();
    await start(telegramUserId);
    await start(other);
    await setStake(tmp.db, telegramUserId, TradeMode.Demo, '2.5' as DecimalString);
    const before = await rowOf(telegramUserId);
    const otherBefore = await rowOf(other);
    await setLastAnalysis(tmp.db, telegramUserId, { assetId: 202, durationSec: 5 });
    const outside = (row: typeof before) => ({
      ...row,
      lastAnalysisAt: undefined,
      lastAnalysisAssetId: undefined,
      lastAnalysisDurationSec: undefined,
      updatedAt: undefined,
    });
    const after = await rowOf(telegramUserId);
    expect(after).toMatchObject({ lastAnalysisAssetId: 202, lastAnalysisDurationSec: 5 });
    expect(outside(after)).toEqual(outside(before));
    expect(await rowOf(other)).toEqual(otherBefore);
  });
});

describe('setStake / readStakes (#297, #326)', () => {
  const stake = (value: string) => value as DecimalString;

  it("starts at NULL, stores each mode's stake canonically in its own column and resets it", async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    expect(await readStakes(tmp.db, telegramUserId)).toEqual({ demoStake: null, realStake: null });

    expect(await setStake(tmp.db, telegramUserId, TradeMode.Demo, stake('2.50'))).toEqual({
      mode: TradeMode.Demo,
      stake: '2.5',
    });
    expect(await readStakes(tmp.db, telegramUserId)).toEqual({ demoStake: '2.5', realStake: null });
    expect(await setStake(tmp.db, telegramUserId, TradeMode.Real, stake('7.000'))).toEqual({
      mode: TradeMode.Real,
      stake: '7',
    });
    expect(await readStakes(tmp.db, telegramUserId)).toEqual({ demoStake: '2.5', realStake: '7' });

    const { row, hasActiveBrokerAccount, pendingBrokerAccounts } = await start(telegramUserId);
    const view = toUserStartView(row, hasActiveBrokerAccount, pendingBrokerAccounts);
    expect([view.demoStake, view.realStake]).toEqual(['2.5', '7']);
    expect(await setNotificationLevel(tmp.db, telegramUserId, NotificationLevel.Off)).toEqual({
      level: NotificationLevel.Off,
      demoStake: '2.5',
      realStake: '7',
      canceledJobs: 0,
    });

    expect(await setStake(tmp.db, telegramUserId, TradeMode.Real, null)).toEqual({
      mode: TradeMode.Real,
      stake: null,
    });
    expect(await readStakes(tmp.db, telegramUserId)).toEqual({ demoStake: '2.5', realStake: null });
    expect(await setStake(tmp.db, telegramUserId, TradeMode.Demo, null)).toEqual({
      mode: TradeMode.Demo,
      stake: null,
    });
    expect(await readStakes(tmp.db, telegramUserId)).toEqual({ demoStake: null, realStake: null });
  });

  it('answers undefined for an unknown user and writes nothing', async () => {
    const telegramUserId = nextTelegramUserId();
    for (const mode of [TradeMode.Demo, TradeMode.Real]) {
      expect(await setStake(tmp.db, telegramUserId, mode, stake('5'))).toBeUndefined();
    }
    expect(await readStakes(tmp.db, telegramUserId)).toBeUndefined();
    expect(
      await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)),
    ).toEqual([]);
  });

  it.each([
    [TradeMode.Demo, 'demoStake'],
    [TradeMode.Real, 'realStake'],
  ] as const)('a %s save touches only %s and updated_at', async (mode, field) => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId, { startPayload: 'src_stake' });
    const before = (
      await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId))
    )[0]!;
    await setStake(tmp.db, telegramUserId, mode, stake('7'));
    const after = (
      await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId))
    )[0]!;
    expect({ ...after, [field]: before[field], updatedAt: before.updatedAt }).toEqual(before);
    expect(after[field]).toBe('7.00000000');
  });
});

// The one writer of users.trading_mode (#121, Rule 36).
describe('setTradingMode (#121)', () => {
  const modeOf = async (telegramUserId: bigint) =>
    (
      await tmp.db
        .select({ tradingMode: users.tradingMode, id: users.id })
        .from(users)
        .where(eq(users.telegramUserId, telegramUserId))
    )[0];
  const auditRowsOf = (userId: string) =>
    tmp.db
      .select({
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(eq(auditLog.entityId, userId));

  it('U-mode 1 starts in demo, writes the column and one audit row per change', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    const { id, tradingMode } = (await modeOf(telegramUserId))!;
    expect(tradingMode).toBe(TradeMode.Demo);

    expect(await setTradingMode(tmp.db, telegramUserId, TradeMode.Real)).toEqual({
      tradingMode: TradeMode.Real,
      changed: true,
      stoppedSessions: 0,
    });
    expect((await modeOf(telegramUserId))!.tradingMode).toBe(TradeMode.Real);
    expect(await auditRowsOf(id)).toEqual([
      {
        actorType: 'user',
        actorId: telegramUserId.toString(),
        action: AuditAction.TradingModeChanged,
        entityType: 'user',
        entityId: id,
        payload: { from: 'demo', to: 'real' },
      },
    ]);

    expect(await setTradingMode(tmp.db, telegramUserId, TradeMode.Demo)).toEqual({
      tradingMode: TradeMode.Demo,
      changed: true,
      stoppedSessions: 0,
    });
    expect((await auditRowsOf(id)).map((row) => row.payload)).toEqual([
      { from: 'demo', to: 'real' },
      { from: 'real', to: 'demo' },
    ]);
  });

  it('U-mode 2 writes nothing for the mode the user is in already', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    const { id } = (await modeOf(telegramUserId))!;
    expect(await setTradingMode(tmp.db, telegramUserId, TradeMode.Demo)).toEqual({
      tradingMode: TradeMode.Demo,
      changed: false,
      stoppedSessions: 0,
    });
    await setTradingMode(tmp.db, telegramUserId, TradeMode.Real);
    expect(await setTradingMode(tmp.db, telegramUserId, TradeMode.Real)).toEqual({
      tradingMode: TradeMode.Real,
      changed: false,
      stoppedSessions: 0,
    });
    expect(await auditRowsOf(id)).toHaveLength(1);
  });

  it('U-mode 3 answers undefined for an unknown user and writes nothing', async () => {
    const telegramUserId = nextTelegramUserId();
    expect(await setTradingMode(tmp.db, telegramUserId, TradeMode.Real)).toBeUndefined();
    expect(await modeOf(telegramUserId)).toBeUndefined();
  });

  it('U-mode 4 two concurrent switches to real write one audit row', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    const { id } = (await modeOf(telegramUserId))!;
    const results = await Promise.all([
      setTradingMode(tmp.db, telegramUserId, TradeMode.Real),
      setTradingMode(tmp.db, telegramUserId, TradeMode.Real),
    ]);
    expect(results.map((result) => result?.changed).sort()).toEqual([false, true]);
    expect(await auditRowsOf(id)).toHaveLength(1);
  });

  // the audit row is in the switch's transaction: a refused audit insert leaves the mode as it was
  it('U-mode 5 keeps the mode when its audit row cannot be written', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId);
    await tmp.pool.query(
      `alter table audit_log add constraint audit_log_no_mode_check check (action <> 'trading_mode_changed') not valid`,
    );
    try {
      await expect(setTradingMode(tmp.db, telegramUserId, TradeMode.Real)).rejects.toThrow();
    } finally {
      await tmp.pool.query('alter table audit_log drop constraint audit_log_no_mode_check');
    }
    expect((await modeOf(telegramUserId))!.tradingMode).toBe(TradeMode.Demo);
  });

  // #327: a session runs only in its user's mode, so a switch stops the user's sessions
  const sessionStateOf = async (id: string) =>
    (
      await tmp.db
        .select({
          status: tradingSessions.status,
          stopReason: tradingSessions.stopReason,
          endedAt: tradingSessions.endedAt,
        })
        .from(tradingSessions)
        .where(eq(tradingSessions.id, id))
    )[0]!;
  const seedRealUserWithSessions = async (accounts: number) => {
    const user = await seedUser(tmp.db, { tradingMode: TradeMode.Real });
    const sessions = [];
    for (let i = 0; i < accounts; i++) {
      const brokerAccountId = await seedBrokerAccount(tmp.db, user.userId);
      sessions.push(await seedTradingSession(tmp.db, brokerAccountId, { mode: TradeMode.Real }));
    }
    return { telegramUserId: BigInt(user.telegramUserId), sessions };
  };

  it("U-mode 6 a switch stops the user's active sessions on every account, no one else's", async () => {
    const seed = await seedRealUserWithSessions(2);
    const other = await seedRealUserWithSessions(1);
    expect(await setTradingMode(tmp.db, seed.telegramUserId, TradeMode.Demo)).toEqual({
      tradingMode: TradeMode.Demo,
      changed: true,
      stoppedSessions: 2,
    });
    for (const session of seed.sessions) {
      const state = await sessionStateOf(session.id);
      expect(state).toMatchObject({ status: 'stopped', stopReason: 'user_stopped' });
      expect(state.endedAt).toBeInstanceOf(Date);
    }
    expect(await sessionStateOf(other.sessions[0]!.id)).toMatchObject({
      status: 'active',
      stopReason: null,
    });
  });

  it('U-mode 7 the mode the user is in already stops nothing', async () => {
    const seed = await seedRealUserWithSessions(1);
    expect(await setTradingMode(tmp.db, seed.telegramUserId, TradeMode.Real)).toEqual({
      tradingMode: TradeMode.Real,
      changed: false,
      stoppedSessions: 0,
    });
    expect(await sessionStateOf(seed.sessions[0]!.id)).toMatchObject({ status: 'active' });
  });

  it("U-mode 8 the stop is in the switch's transaction: the mode commits with it", async () => {
    const seed = await seedRealUserWithSessions(1);
    const sessionId = seed.sessions[0]!.id;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const lockTaken = new Promise<void>((resolve) => (taken = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await tx
        .select()
        .from(tradingSessions)
        .where(eq(tradingSessions.id, sessionId))
        .for('update');
      taken();
      await released;
    });
    await lockTaken;
    let settled = false;
    const switching = setTradingMode(tmp.db, seed.telegramUserId, TradeMode.Demo).finally(
      () => (settled = true),
    );
    await until('the switch to queue behind the session lock or finish', async () => {
      const { rows } = await tmp.db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return settled || (rows[0]?.waiting ?? 0) > 0;
    });
    const modeWhileWaiting = (
      await tmp.db
        .select({ tradingMode: users.tradingMode })
        .from(users)
        .where(eq(users.telegramUserId, seed.telegramUserId))
    )[0]!.tradingMode;
    release();
    await holder;
    expect(settled).toBe(false);
    expect(modeWhileWaiting).toBe(TradeMode.Real);
    expect(await switching).toMatchObject({ changed: true, stoppedSessions: 1 });
    expect(await sessionStateOf(sessionId)).toMatchObject({ stopReason: 'user_stopped' });
  });

  it('touches only trading_mode and updated_at', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId, { startPayload: 'src_mode' });
    const before = (
      await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId))
    )[0]!;
    await setTradingMode(tmp.db, telegramUserId, TradeMode.Real);
    const after = (
      await tmp.db.select().from(users).where(eq(users.telegramUserId, telegramUserId))
    )[0]!;
    expect({ ...after, tradingMode: before.tradingMode, updatedAt: before.updatedAt }).toEqual(
      before,
    );
  });
});

// #686 (docs/trading-mode.md → The automatic switch after a deposit)
describe('switchTradingModeOnDeposit (#686)', () => {
  let n = 0;
  const depositRow = async (
    userId: string | null,
    accountId: string | null,
    brokerUserId: string,
  ): Promise<string> => {
    const [row] = await tmp.db
      .insert(depositEvents)
      .values({
        userId,
        brokerAccountId: accountId,
        source: PostbackSource.Binodex,
        brokerUserId,
        paymentId: `mode-pay-${String(++n)}`,
        amount: '10' as DecimalString,
      })
      .returning({ id: depositEvents.id });
    return row!.id;
  };
  // a user with an account and one deposit on it, demo and active unless told otherwise
  const seed = async ({
    tradingMode = TradeMode.Demo,
    status = UserStatus.Active,
    accountStatus = BrokerAccountStatus.Active,
  }: {
    tradingMode?: TradeMode;
    status?: UserStatus;
    accountStatus?: BrokerAccountStatus;
  } = {}) => {
    const user = await seedUser(tmp.db, { tradingMode, status });
    const brokerUserId = `mode-trader-${String(++n)}`;
    const accountId = await seedBrokerAccount(tmp.db, user.userId, {
      status: accountStatus,
      brokerUserId,
    });
    const depositEventId = await depositRow(user.userId, accountId, brokerUserId);
    return { ...user, accountId, brokerUserId, depositEventId };
  };
  const attempt = (depositEventId: string, demoOnly = false) =>
    switchTradingModeOnDeposit(tmp.db, { depositEventId, demoOnly });
  const depositOf = async (id: string) =>
    (
      await tmp.db
        .select({ modeSwitch: depositEvents.modeSwitch, modeSwitchAt: depositEvents.modeSwitchAt })
        .from(depositEvents)
        .where(eq(depositEvents.id, id))
    )[0]!;
  const modeOf = async (userId: string) =>
    (
      await tmp.db
        .select({ tradingMode: users.tradingMode })
        .from(users)
        .where(eq(users.id, userId))
    )[0]!.tradingMode;
  const auditOf = (userId: string) =>
    tmp.db
      .select({
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(eq(auditLog.entityId, userId));
  const dbNow = async () =>
    (await tmp.db.execute<{ now: string }>(sql`select clock_timestamp()::text as now`)).rows[0]!
      .now;
  const nothingWritten = async (seeded: { userId: string; depositEventId: string }) => {
    expect(await depositOf(seeded.depositEventId)).toEqual({
      modeSwitch: null,
      modeSwitchAt: null,
    });
    expect(await modeOf(seeded.userId)).toBe(TradeMode.Demo);
    expect(await auditOf(seeded.userId)).toEqual([]);
  };

  it('U-dep 1 switches a demo user with an active account and no session, one audit row', async () => {
    const seeded = await seed();
    const before = await dbNow();
    expect(await attempt(seeded.depositEventId)).toEqual({ outcome: DepositModeSwitch.Switched });
    const after = await dbNow();
    expect(await modeOf(seeded.userId)).toBe(TradeMode.Real);
    expect(await auditOf(seeded.userId)).toEqual([
      {
        actorType: 'system',
        actorId: null,
        action: AuditAction.TradingModeChanged,
        entityType: 'user',
        entityId: seeded.userId,
        payload: { from: 'demo', to: 'real', depositEventId: seeded.depositEventId },
      },
    ]);
    const deposit = await depositOf(seeded.depositEventId);
    expect(deposit.modeSwitch).toBe(DepositModeSwitch.Switched);
    // by the database clock, inside the pass's transaction
    const { rows } = await tmp.db.execute<{ within: boolean }>(
      sql`select mode_switch_at between ${before}::timestamptz and ${after}::timestamptz as within
        from deposit_events where id = ${seeded.depositEventId}`,
    );
    expect(rows[0]?.within).toBe(true);
  });

  it('U-dep 2 closes a deposit of a user in real as already_real, no audit row', async () => {
    const seeded = await seed({ tradingMode: TradeMode.Real });
    expect(await attempt(seeded.depositEventId)).toEqual({
      outcome: DepositModeSwitch.AlreadyReal,
    });
    expect(await modeOf(seeded.userId)).toBe(TradeMode.Real);
    expect(await auditOf(seeded.userId)).toEqual([]);
    expect((await depositOf(seeded.depositEventId)).modeSwitch).toBe(DepositModeSwitch.AlreadyReal);
  });

  it('U-dep 3 a deposit on a pending account waits for the activation, then switches', async () => {
    const cipher = createTokenCipher({ keyId: 'test-key', key: randomBytes(32) });
    const user = await seedUser(tmp.db);
    const telegramUserId = BigInt(user.telegramUserId);
    const brokerUserId = `mode-pending-${String(++n)}`;
    const linked = await linkBrokerAccount(tmp.db, {
      telegramUserId,
      tokens: {
        accessToken: 'access-mode',
        refreshToken: 'refresh-mode',
        tokenType: 'Bearer',
        expiresInSec: 3_600,
        user: { id: brokerUserId, email: 'mode@example.test', isPartnerClient: false },
      },
      cipher,
      activate: false,
    });
    if (!linked.ok) throw new Error('link failed');
    const paymentId = `mode-pay-${String(++n)}`;
    const recorded = await recordPostback(tmp.db, {
      source: PostbackSource.Binodex,
      query: {
        event: 'deposit',
        id: `mode-pb-${String(n)}`,
        payment_id: paymentId,
        a: brokerUserId,
        amount: '10',
      },
    });
    expect(recorded.outcome).toBe('recorded');
    const [row] = await tmp.db
      .select({ id: depositEvents.id, userId: depositEvents.userId })
      .from(depositEvents)
      .where(eq(depositEvents.paymentId, paymentId));
    expect(row?.userId).toBeNull();
    expect(await listDepositsAwaitingModeSwitch(tmp.db, { limit: 1000 })).not.toContain(row!.id);

    expect(
      (await confirmBrokerAccount(tmp.db, { telegramUserId, accountId: linked.account.id })).ok,
    ).toBe(true);
    expect(await listDepositsAwaitingModeSwitch(tmp.db, { limit: 1000 })).toContain(row!.id);
    expect(await attempt(row!.id)).toEqual({ outcome: DepositModeSwitch.Switched });
    expect(await modeOf(user.userId)).toBe(TradeMode.Real);
  });

  it('U-dep 4 a deposit on a revoked account does not switch: account_inactive', async () => {
    const seeded = await seed({ accountStatus: BrokerAccountStatus.Revoked });
    expect(await attempt(seeded.depositEventId)).toEqual({
      outcome: DepositModeSwitch.AccountInactive,
    });
    expect(await modeOf(seeded.userId)).toBe(TradeMode.Demo);
    expect(await auditOf(seeded.userId)).toEqual([]);
  });

  it('U-dep 5 waits while a session runs on any account of the user, and switches after it', async () => {
    const seeded = await seed();
    const other = await seedBrokerAccount(tmp.db, seeded.userId);
    await seedTradingSession(tmp.db, other);
    expect(await attempt(seeded.depositEventId)).toEqual({ outcome: 'session_active' });
    await nothingWritten(seeded);
    expect(await listDepositsAwaitingModeSwitch(tmp.db, { limit: 1000 })).toContain(
      seeded.depositEventId,
    );

    // U-dep 5b: the session ends, the next attempt switches
    await stopUserSessions(tmp.db, { telegramUserId: seeded.telegramUserId });
    expect(await attempt(seeded.depositEventId)).toEqual({ outcome: DepositModeSwitch.Switched });
    expect(await modeOf(seeded.userId)).toBe(TradeMode.Real);
  });

  it('U-dep 6 a user blocked by the admin is not switched: user_blocked', async () => {
    const seeded = await seed({ status: UserStatus.Blocked });
    expect(await attempt(seeded.depositEventId)).toEqual({
      outcome: DepositModeSwitch.UserBlocked,
    });
    expect(await modeOf(seeded.userId)).toBe(TradeMode.Demo);
    expect(await auditOf(seeded.userId)).toEqual([]);
  });

  it('U-dep 7 a second deposit after the switch is already_real: one switched fact', async () => {
    const seeded = await seed();
    const second = await depositRow(seeded.userId, seeded.accountId, seeded.brokerUserId);
    expect(await attempt(seeded.depositEventId)).toEqual({ outcome: DepositModeSwitch.Switched });
    expect(await attempt(second)).toEqual({ outcome: DepositModeSwitch.AlreadyReal });
    expect(await auditOf(seeded.userId)).toHaveLength(1);
    const switched = await tmp.db
      .select({ id: depositEvents.id })
      .from(depositEvents)
      .where(
        sql`${depositEvents.userId} = ${seeded.userId} and ${depositEvents.modeSwitch} = 'switched'`,
      );
    expect(switched).toEqual([{ id: seeded.depositEventId }]);
  });

  it('U-dep 8 with DEMO_ONLY closes the deposit demo_only without waiting for the users row', async () => {
    const seeded = await seed();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const lockTaken = new Promise<void>((resolve) => (taken = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, seeded.userId)).for('no key update');
      taken();
      await released;
    });
    await lockTaken;
    let outcome: unknown;
    const switching = attempt(seeded.depositEventId, true).then((result) => (outcome = result));
    try {
      await until('the DEMO_ONLY outcome while the users row is held', () => outcome !== undefined);
    } finally {
      release();
      await holder;
      await switching;
    }
    expect(outcome).toEqual({ outcome: DepositModeSwitch.DemoOnly });
    expect((await depositOf(seeded.depositEventId)).modeSwitch).toBe(DepositModeSwitch.DemoOnly);
    expect(await modeOf(seeded.userId)).toBe(TradeMode.Demo);
    expect(await auditOf(seeded.userId)).toEqual([]);
  });

  it("U-dep 9 the user's own switch closes the waiting deposits superseded, in its transaction", async () => {
    const seeded = await seed();
    await seedTradingSession(tmp.db, seeded.accountId);
    const telegramUserId = BigInt(seeded.telegramUserId);
    // a refused audit row rolls the switch back, and the outcome with it
    await tmp.pool.query(
      `alter table audit_log add constraint audit_log_no_mode_686 check (action <> 'trading_mode_changed') not valid`,
    );
    try {
      await expect(setTradingMode(tmp.db, telegramUserId, TradeMode.Real)).rejects.toThrow();
    } finally {
      await tmp.pool.query('alter table audit_log drop constraint audit_log_no_mode_686');
    }
    expect(await depositOf(seeded.depositEventId)).toEqual({
      modeSwitch: null,
      modeSwitchAt: null,
    });

    expect(await setTradingMode(tmp.db, telegramUserId, TradeMode.Real)).toMatchObject({
      changed: true,
    });
    expect((await depositOf(seeded.depositEventId)).modeSwitch).toBe(DepositModeSwitch.Superseded);
    expect(await attempt(seeded.depositEventId)).toEqual({ outcome: 'gone' });
  });

  it('U-dep 10 a switch that changes nothing (/stop in demo) leaves the deposit waiting', async () => {
    const seeded = await seed();
    await seedTradingSession(tmp.db, seeded.accountId);
    expect(
      await setTradingMode(tmp.db, BigInt(seeded.telegramUserId), TradeMode.Demo),
    ).toMatchObject({ changed: false });
    expect(await depositOf(seeded.depositEventId)).toEqual({
      modeSwitch: null,
      modeSwitchAt: null,
    });
  });

  it('U-dep 11 waits behind a switch to real in flight, then finds the user in real', async () => {
    const seeded = await seed();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const lockTaken = new Promise<void>((resolve) => (taken = resolve));
    const holder = tmp.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ tradingMode: TradeMode.Real })
        .where(eq(users.id, seeded.userId));
      taken();
      await released;
    });
    await lockTaken;
    let settled = false;
    const switching = attempt(seeded.depositEventId).finally(() => (settled = true));
    await until(
      'the pass to queue behind the users lock',
      async () => (await lockWaiters(tmp.db)) > 0,
    );
    expect(settled).toBe(false);
    release();
    await holder;
    expect(await switching).toEqual({ outcome: DepositModeSwitch.AlreadyReal });
    expect(await auditOf(seeded.userId)).toEqual([]);
  });

  it('U-dep 12 a deposit with an outcome already is gone: nothing is written', async () => {
    const seeded = await seed();
    expect(
      await markDepositModeSwitch(tmp.db, {
        depositEventId: seeded.depositEventId,
        outcome: DepositModeSwitch.Superseded,
      }),
    ).toBe(true);
    const marked = await depositOf(seeded.depositEventId);
    expect(await attempt(seeded.depositEventId)).toEqual({ outcome: 'gone' });
    expect(
      await markDepositModeSwitch(tmp.db, {
        depositEventId: seeded.depositEventId,
        outcome: DepositModeSwitch.Switched,
      }),
    ).toBe(false);
    expect(await depositOf(seeded.depositEventId)).toEqual(marked);
    expect(await modeOf(seeded.userId)).toBe(TradeMode.Demo);
    expect(await auditOf(seeded.userId)).toEqual([]);
  });

  describe('listDepositsAwaitingModeSwitch', () => {
    it('L1 lists attributed deposits with no outcome, oldest first; L2 not the closed ones', async () => {
      const older = await seed();
      const newer = await seed();
      await tmp.db
        .update(depositEvents)
        .set({ createdAt: sql`now() - interval '1 hour'` })
        .where(eq(depositEvents.id, older.depositEventId));
      const unattributed = await depositRow(null, null, `mode-free-${String(++n)}`);
      const closed = await seed();
      await markDepositModeSwitch(tmp.db, {
        depositEventId: closed.depositEventId,
        outcome: DepositModeSwitch.Predates,
      });
      const listed = await listDepositsAwaitingModeSwitch(tmp.db, { limit: 1000 });
      expect(listed.indexOf(older.depositEventId)).toBeGreaterThanOrEqual(0);
      expect(listed.indexOf(older.depositEventId)).toBeLessThan(
        listed.indexOf(newer.depositEventId),
      );
      expect(listed).not.toContain(unattributed);
      expect(listed).not.toContain(closed.depositEventId);
    });

    it('L3 takes at most `limit` rows', async () => {
      await seed();
      await seed();
      expect(await listDepositsAwaitingModeSwitch(tmp.db, { limit: 1 })).toHaveLength(1);
      expect(await listDepositsAwaitingModeSwitch(tmp.db, { limit: 2 })).toHaveLength(2);
    });
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
    // another code exists, so a statement that ignored the code would find one
    await seedInviter();
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

describe('the bot language (#508)', () => {
  const languageOf = async (telegramUserId: bigint) => {
    const [row] = await tmp.db
      .select({ language: users.language, languageCode: users.languageCode })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    return row;
  };

  it('U-lang 1 a first /start sets the language botLanguageOf gives its tag', async () => {
    for (const languageCode of ['ru', 'ru-RU', 'RU', 'en', 'uk', 'de-DE', undefined]) {
      const telegramUserId = nextTelegramUserId();
      const { row } = await start(telegramUserId, { languageCode });
      expect(row.language, String(languageCode)).toBe(botLanguageOf(languageCode));
      expect((await languageOf(telegramUserId))?.language).toBe(botLanguageOf(languageCode));
    }
  });

  it('U-lang 2 a later /start with another tag keeps the language and still updates language_code', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId, { languageCode: 'en' });
    const { row } = await start(telegramUserId, { languageCode: 'ru' });
    expect(row.language).toBe('en');
    expect(await languageOf(telegramUserId)).toEqual({ language: 'en', languageCode: 'ru' });
  });

  it('U-lang 3 setUserLanguage writes and answers the language, moves updated_at only; an unknown id is undefined', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId, { languageCode: 'ru' });
    const before = await readUser(telegramUserId);
    const [{ snapshot } = { snapshot: '' }] = await tmp.db
      .select({ snapshot: sql<string>`(to_jsonb(users) - 'language' - 'updated_at')::text` })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));

    expect(await setUserLanguage(tmp.db, telegramUserId, 'en')).toBe('en');

    expect((await languageOf(telegramUserId))?.language).toBe('en');
    const [{ snapshot: after } = { snapshot: '' }] = await tmp.db
      .select({ snapshot: sql<string>`(to_jsonb(users) - 'language' - 'updated_at')::text` })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));
    expect(after).toBe(snapshot);
    expect((await readUser(telegramUserId)).updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
    expect(await setUserLanguage(tmp.db, nextTelegramUserId(), 'en')).toBeUndefined();
  });

  it('U-lang 4 readUserLanguage answers the stored language, undefined without a row', async () => {
    const telegramUserId = nextTelegramUserId();
    await start(telegramUserId, { languageCode: 'de' });
    expect(await readUserLanguage(tmp.db, telegramUserId)).toBe('en');
    await setUserLanguage(tmp.db, telegramUserId, 'ru');
    expect(await readUserLanguage(tmp.db, telegramUserId)).toBe('ru');
    expect(await readUserLanguage(tmp.db, nextTelegramUserId())).toBeUndefined();
  });
});
