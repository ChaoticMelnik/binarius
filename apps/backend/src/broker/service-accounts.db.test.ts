import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthRevokedReason,
  BrokerAccountStatus,
  SERVICE_ACCOUNTS_MIN,
  ServiceAccountNotWorkingReason,
  UserStatus,
} from '@binarius/shared';
import { brokerAccounts, users } from '@binarius/db';
import {
  createTempDatabase,
  seedBrokerAccount,
  seedUser,
  type TempDatabase,
} from '@binarius/db/testing';
import { ADMIN_TEXTS } from '../admin/texts';
import type { AccessTokenOptions, AccessTokenResult } from '../auth/token-service';
import { createServiceAccountKeeper, type ServiceAccountKeeperConfig } from './service-accounts';

const baseUrl = process.env.TEST_DATABASE_URL;
if (baseUrl === undefined || baseUrl === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for apps/backend integration tests (see README → Test database)',
  );
}

let tmp: TempDatabase;
beforeAll(async () => {
  tmp = await createTempDatabase(baseUrl);
});
afterAll(() => tmp.drop());

// every case starts with no service account in this file's database, and with every earlier
// case's account far from due, so a case sees only the rows it made
beforeEach(async () => {
  await tmp.db
    .update(brokerAccounts)
    .set({ serviceSince: null, accessTokenExpiresAt: sql`now() + interval '30 days'` });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CONFIG: ServiceAccountKeeperConfig = {
  tickMs: 1_000,
  renewAheadMs: DAY,
  rotationGapMs: HOUR,
  perTick: 5,
  stalledRetryMs: 300_000,
  minWorking: SERVICE_ACCOUNTS_MIN,
};
const TOKEN = 'the-fake-access-token';

let marks = 0;

// a marked account: the n-th mark of the case is the n-th in service_since order. Rotated long
// ago, so the gap never hides it; `expiresInHours` decides whether it is due
async function serviceAccount(
  patch: {
    expiresInHours?: number;
    status?: BrokerAccountStatus;
    userStatus?: UserStatus;
    marked?: boolean;
    email?: string;
    revokedReason?: AuthRevokedReason;
  } = {},
): Promise<string> {
  const { userId } = await seedUser(tmp.db, { status: patch.userStatus ?? UserStatus.Active });
  const id = await seedBrokerAccount(tmp.db, userId, {
    status: patch.status ?? BrokerAccountStatus.Active,
  });
  marks += 1;
  await tmp.db
    .update(brokerAccounts)
    .set({
      serviceSince:
        patch.marked === false
          ? null
          : sql`'2026-10-01T00:00:00Z'::timestamptz + make_interval(secs => ${marks})`,
      accessTokenExpiresAt: sql`now() + make_interval(secs => ${(patch.expiresInHours ?? 72) * 3600})`,
      tokenRotatedAt: sql`now() - interval '2 hours'`,
      email: patch.email ?? null,
      authRevokedReason: patch.revokedReason ?? null,
    })
    .where(eq(brokerAccounts.id, id));
  return id;
}

const setAccount = (id: string, patch: Partial<typeof brokerAccounts.$inferInsert>) =>
  tmp.db.update(brokerAccounts).set(patch).where(eq(brokerAccounts.id, id));

interface Call {
  accountId: string;
  options: AccessTokenOptions;
}

function fakeAccessToken(
  answer: (
    accountId: string,
    call: number,
  ) => AccessTokenResult | Promise<AccessTokenResult> = () => ({
    ok: true,
    accessToken: TOKEN,
    brokerUserId: 'broker-user',
  }),
) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const accessToken = async (accountId: string, options: AccessTokenOptions) => {
    calls.push({ accountId, options });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await answer(accountId, calls.length);
    } finally {
      inFlight -= 1;
    }
  };
  return { accessToken, calls, maxInFlight: () => maxInFlight };
}

function fakeNotify(
  answer: () => { sent: number; failed: number } = () => ({ sent: 2, failed: 0 }),
) {
  const texts: string[] = [];
  const notifyStaff = (text: string) => {
    texts.push(text);
    return Promise.resolve(answer());
  };
  return { notifyStaff, texts };
}

const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function keeper(
  overrides: {
    accessToken?: ReturnType<typeof fakeAccessToken>;
    notify?: ReturnType<typeof fakeNotify>;
    config?: Partial<ServiceAccountKeeperConfig>;
    random?: () => number;
  } = {},
) {
  const token = overrides.accessToken ?? fakeAccessToken();
  const notify = overrides.notify ?? fakeNotify();
  const logger = fakeLogger();
  const instance = createServiceAccountKeeper({
    db: tmp.db,
    accessToken: token.accessToken,
    notifyStaff: notify.notifyStaff,
    logger,
    config: { ...CONFIG, ...overrides.config },
    ...(overrides.random === undefined ? {} : { random: overrides.random }),
  });
  return { instance, token, notify, logger };
}

const RENEW = { mayRefresh: true, serviceOnly: true, renewAheadMs: DAY };

describe('the keeper renews the due service tokens', () => {
  it('K1 asks for each due account one after another, service-only, at most perTick', async () => {
    const a = await serviceAccount({ expiresInHours: 1 });
    const b = await serviceAccount({ expiresInHours: 2 });
    const c = await serviceAccount({ expiresInHours: 3 });
    const { instance, token } = keeper();
    await instance.tick();
    expect(token.calls).toEqual([
      { accountId: a, options: RENEW },
      { accountId: b, options: RENEW },
      { accountId: c, options: RENEW },
    ]);
    expect(token.maxInFlight()).toBe(1);

    const limited = keeper({ config: { perTick: 2 } });
    await limited.instance.tick();
    expect(limited.token.calls.map((call) => call.accountId)).toEqual([a, b]);
  });

  it('K2 never passes an unmarked account or a marked one outside the window', async () => {
    await serviceAccount({ expiresInHours: 1, marked: false });
    await serviceAccount({ expiresInHours: -1, marked: false });
    await serviceAccount({ expiresInHours: 25 });
    const { instance, token } = keeper();
    await instance.tick();
    expect(token.calls).toEqual([]);
  });

  it('K3 ends the renewals on a rate limit and starts the next tick with the same account', async () => {
    const a = await serviceAccount({ expiresInHours: 1 });
    await serviceAccount({ expiresInHours: 2 });
    const token = fakeAccessToken((_id, call) =>
      call === 1
        ? { ok: false, reason: 'refresh_rate_limited' }
        : { ok: true, accessToken: TOKEN, brokerUserId: 'broker-user' },
    );
    const { instance } = keeper({ accessToken: token });
    await instance.tick();
    expect(token.calls.map((call) => call.accountId)).toEqual([a]);
    await instance.tick();
    expect(token.calls[1]?.accountId).toBe(a);
  });

  it('K4 holds back an account with key_unavailable until stalledRetryMs passed, and goes on', async () => {
    const a = await serviceAccount({ expiresInHours: 1 });
    const b = await serviceAccount({ expiresInHours: 2 });
    const token = fakeAccessToken((id) =>
      id === a
        ? { ok: false, reason: 'key_unavailable' }
        : { ok: true, accessToken: TOKEN, brokerUserId: 'broker-user' },
    );
    const { instance } = keeper({ accessToken: token });
    await instance.tick();
    expect(token.calls.map((call) => call.accountId)).toEqual([a, b]);
    // read after the attempt that held it back, so the clock below is past its retry time
    const released = Date.now() + CONFIG.stalledRetryMs + 1;

    await instance.tick();
    expect(token.calls.map((call) => call.accountId)).toEqual([a, b, b]);

    vi.spyOn(Date, 'now').mockReturnValue(released);
    await instance.tick();
    expect(token.calls.map((call) => call.accountId)).toEqual([a, b, b, a, b]);
  });

  it('K4b logs a throw by name and code, holds the account back and goes on', async () => {
    const a = await serviceAccount({ expiresInHours: 1 });
    const b = await serviceAccount({ expiresInHours: 2 });
    const failure = Object.assign(new Error('relation "secret" does not exist'), { code: '42P01' });
    const token = fakeAccessToken((id) => {
      if (id === a) throw failure;
      return { ok: true, accessToken: TOKEN, brokerUserId: 'broker-user' };
    });
    const { instance, logger } = keeper({ accessToken: token });
    await instance.tick();
    expect(token.calls.map((call) => call.accountId)).toEqual([a, b]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: a,
        err: expect.objectContaining({ name: 'Error', code: '42P01' }) as unknown,
      }),
      'service token renewal threw',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    await instance.tick();
    expect(token.calls.map((call) => call.accountId)).toEqual([a, b, b]);
  });
});

describe('the keeper alerts the staff bot on changes below the minimum', () => {
  // three marked: one working, one revoked by a failed exchange, one with an expired token
  async function belowScene() {
    const working = await serviceAccount({ email: 'working@example.com' });
    const revoked = await serviceAccount({
      status: BrokerAccountStatus.Revoked,
      revokedReason: AuthRevokedReason.RefreshOutcomeUnknown,
      email: 'revoked@example.com',
    });
    const expired = await serviceAccount({ expiresInHours: -1 });
    const [row] = await tmp.db
      .select({ brokerUserId: brokerAccounts.brokerUserId })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, expired));
    return { working, revoked, expired, expiredLabel: row?.brokerUserId ?? '' };
  }

  it('K5 sends the below message once with the accounts not working, then nothing while the count holds', async () => {
    const scene = await belowScene();
    const { instance, notify } = keeper();
    await instance.tick();
    expect(notify.texts).toEqual([
      ADMIN_TEXTS.serviceAccountsBelow({
        working: 1,
        marked: 3,
        min: 3,
        notWorking: [
          {
            label: 'revoked@example.com',
            reason: ServiceAccountNotWorkingReason.Revoked,
            revokedReason: AuthRevokedReason.RefreshOutcomeUnknown,
          },
          {
            label: scene.expiredLabel,
            reason: ServiceAccountNotWorkingReason.TokenExpired,
            revokedReason: null,
          },
        ],
      }),
    ]);
    expect(notify.texts[0]).toContain('— revoked@example.com: отозван (refresh_outcome_unknown)');
    await instance.tick();
    expect(notify.texts).toHaveLength(1);
  });

  it('K6 stays silent while the count holds and speaks again when it changes below the minimum', async () => {
    const scene = await belowScene();
    const { instance, notify } = keeper();
    await instance.tick();
    await setAccount(scene.expired, { status: BrokerAccountStatus.Revoked });
    await instance.tick();
    expect(notify.texts).toHaveLength(1);
    await setAccount(scene.revoked, {
      status: BrokerAccountStatus.Active,
      authRevokedReason: null,
    });
    await instance.tick();
    expect(notify.texts).toHaveLength(2);
    expect(notify.texts[1]).toContain('в работе: 2 из минимум 3');
  });

  it('K7 sends the restored message once when the minimum is reached again', async () => {
    const scene = await belowScene();
    const { instance, notify } = keeper();
    await instance.tick();
    await setAccount(scene.revoked, {
      status: BrokerAccountStatus.Active,
      authRevokedReason: null,
    });
    await tmp.db
      .update(brokerAccounts)
      .set({ accessTokenExpiresAt: sql`now() + interval '3 days'` })
      .where(eq(brokerAccounts.id, scene.expired));
    await instance.tick();
    expect(notify.texts.slice(1)).toEqual([
      ADMIN_TEXTS.serviceAccountsRestored({ working: 3, min: 3 }),
    ]);
    await instance.tick();
    expect(notify.texts).toHaveLength(2);
  });

  it('K8 says it once on the first tick of a process started below the minimum, nothing at or above it', async () => {
    await belowScene();
    const below = keeper();
    await below.instance.tick();
    expect(below.notify.texts).toHaveLength(1);

    await tmp.db.update(brokerAccounts).set({ serviceSince: null });
    await serviceAccount();
    await serviceAccount();
    await serviceAccount();
    const fine = keeper();
    await fine.instance.tick();
    await fine.instance.tick();
    expect(fine.notify.texts).toEqual([]);
  });

  it('K9 tries again on the next tick when nobody got it, and not when somebody did', async () => {
    await belowScene();
    let answer = { sent: 0, failed: 2 };
    const notify = fakeNotify(() => answer);
    const { instance } = keeper({ notify });
    await instance.tick();
    await instance.tick();
    expect(notify.texts).toHaveLength(2);
    answer = { sent: 1, failed: 1 };
    await instance.tick();
    await instance.tick();
    expect(notify.texts).toHaveLength(3);
  });

  it('K9b warns once and does not repeat when there is no active staff member', async () => {
    await belowScene();
    const notify = fakeNotify(() => ({ sent: 0, failed: 0 }));
    const { instance, logger } = keeper({ notify });
    await instance.tick();
    await instance.tick();
    expect(notify.texts).toHaveLength(1);
    const warns = logger.warn.mock.calls.filter(
      ([, message]) => message === 'no active staff to alert',
    );
    expect(warns).toHaveLength(1);
  });
});

describe('the keeper as a loop', () => {
  it('K10 stop() lets the exchange in flight finish, skips the rest and sends nothing', async () => {
    await serviceAccount({ expiresInHours: 1 });
    await serviceAccount({ expiresInHours: 2 });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const token = fakeAccessToken(async () => {
      entered?.();
      await held;
      return { ok: true, accessToken: TOKEN, brokerUserId: 'broker-user' };
    });
    const { instance, notify } = keeper({ accessToken: token });
    const ticking = instance.tick();
    await inFlight;
    const stopping = instance.stop();
    release?.();
    await stopping;
    await ticking;
    expect(token.calls).toHaveLength(1);
    expect(notify.texts).toEqual([]);
  });

  it('K11 logs one tick line with its counts and never the token or the message', async () => {
    await serviceAccount({ expiresInHours: 1 });
    await serviceAccount({ status: BrokerAccountStatus.Revoked });
    const { instance, logger, notify } = keeper();
    await instance.tick();
    expect(logger.info).toHaveBeenCalledWith(
      {
        marked: 2,
        working: 1,
        min: 3,
        candidates: 1,
        renewed: 1,
        refused: 0,
        held: 0,
        below: true,
        alerted: true,
      },
      'service accounts tick',
    );
    const logged = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(notify.texts).toHaveLength(1);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(notify.texts[0]);
    expect(logged).not.toContain('Служебных');
  });

  // #874, Rule 65: the first tick at firstTickAtMs (random 0: the jitter is the floor), the
  // interval from it. The waits below run on the real clock the fake one leaves alone; the first
  // delay is armed once the read of the last rotation answered, real I/O the fake clock does not
  // touch.
  const realSetTimeout = globalThis.setTimeout;
  const realSleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
  const FIRST_MS = 200;
  // the jitter is drawn right before the first delay is armed, in the same callback
  let drawn = false;
  const random = () => {
    drawn = true;
    return 0;
  };
  const armed = async () => {
    for (let i = 0; i < 100 && !drawn; i += 1) await realSleep(20);
    expect(drawn).toBe(true);
  };
  beforeEach(() => {
    drawn = false;
  });

  it('K12 ticks first at its floor after start(), then every tickMs, and reuses a tick still running', async () => {
    await serviceAccount({ expiresInHours: 1 });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const token = fakeAccessToken(async () => {
      await held;
      return { ok: true, accessToken: TOKEN, brokerUserId: 'broker-user' };
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { instance } = keeper({
      accessToken: token,
      config: { firstTickMinMs: FIRST_MS },
      random,
    });
    instance.start();
    await armed();
    vi.advanceTimersByTime(FIRST_MS - 1);
    await realSleep(100);
    expect(token.calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    for (let i = 0; i < 100 && token.calls.length === 0; i += 1) await realSleep(20);
    expect(token.calls).toHaveLength(1);
    const again = instance.tick();
    vi.advanceTimersByTime(CONFIG.tickMs);
    release?.();
    await again;
    expect(token.calls).toHaveLength(1);
    // the interval runs from the first tick: its next fire is FIRST_MS + 2 tickMs
    vi.advanceTimersByTime(CONFIG.tickMs - 1);
    await realSleep(100);
    expect(token.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    for (let i = 0; i < 100 && token.calls.length === 1; i += 1) await realSleep(20);
    expect(token.calls).toHaveLength(2);
    await instance.stop();
  });

  it('K13 a stop() inside the first delay leaves the keeper without an exchange', async () => {
    await serviceAccount({ expiresInHours: 1 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { instance, token } = keeper({ config: { firstTickMinMs: FIRST_MS }, random });
    instance.start();
    await armed();
    vi.advanceTimersByTime(FIRST_MS - 1);
    await instance.stop();
    vi.advanceTimersByTime(10 * CONFIG.tickMs);
    await realSleep(100);
    expect(token.calls).toHaveLength(0);
  });

  // a marked account rotated 400 ms ago stands for the previous process's last exchange: the
  // jitter is FIRST_MS, the floor about tickMs − 400 = 600 ms
  it('K14 ticks first no sooner than an interval after the last rotation of a marked account', async () => {
    const due = await serviceAccount({ expiresInHours: 1 });
    const recent = await serviceAccount({ expiresInHours: 720 });
    try {
      await tmp.db
        .update(brokerAccounts)
        .set({ tokenRotatedAt: sql`now() - interval '400 milliseconds'` })
        .where(eq(brokerAccounts.id, recent));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const { instance, token } = keeper({ config: { firstTickMinMs: FIRST_MS }, random });
      instance.start();
      await armed();
      vi.advanceTimersByTime(400);
      await realSleep(100);
      expect(token.calls).toHaveLength(0);
      vi.advanceTimersByTime(300);
      for (let i = 0; i < 100 && token.calls.length === 0; i += 1) await realSleep(20);
      expect(token.calls.map((call) => call.accountId)).toEqual([due]);
      await instance.stop();
    } finally {
      await setAccount(recent, { serviceSince: null });
    }
  });
});

describe('the keeper and a blocked owner', () => {
  it("counts a blocked user's service account as not working and never asks for its token", async () => {
    const id = await serviceAccount({ expiresInHours: 1 });
    const [row] = await tmp.db
      .select({ userId: brokerAccounts.userId })
      .from(brokerAccounts)
      .where(eq(brokerAccounts.id, id));
    await tmp.db
      .update(users)
      .set({ status: UserStatus.Blocked })
      .where(eq(users.id, row?.userId ?? ''));
    const { instance, token, notify } = keeper();
    await instance.tick();
    expect(token.calls).toEqual([]);
    expect(notify.texts[0]).toContain('пользователь заблокирован');
  });
});
