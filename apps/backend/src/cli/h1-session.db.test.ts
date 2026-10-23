import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTradingSwitch,
  createTempDatabase,
  seedBalanceSnapshot,
  seedTradingSession,
  seedUserWithAccount,
  type TempDatabase,
} from '@binarius/db/testing';
import { brokerAccounts, openTrading, setH1Mark, setStake, tradingSessions } from '@binarius/db';
import {
  AccountHaltReason,
  DEFAULT_SESSION_CYCLES,
  decimalStringSchema,
  H1_R1_PARAMS,
  martingaleLimitsFor,
  safeParseTradingSessionSettings,
  TradeMode,
  type PairsCatalogView,
  type PairView,
} from '@binarius/shared';
import { runH1Cli } from './h1';
import type { H1SessionDeps } from './h1-session';

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

const NOW = 1_760_000_000_000;
const pair = (patch: Partial<PairView> = {}): PairView => ({
  id: 202,
  symbol: 'EUR/USD',
  isOtc: false,
  type: 'currency',
  digits: 5,
  payout: 94,
  maxPayout: 95,
  minTimeframe: 5,
  maxTimeframe: 3600,
  scheduledUntil: 0,
  ...patch,
});
const catalogOf = (pairs: PairView[], fresh = true) => {
  const calls = { n: 0 };
  const read = (): Promise<PairsCatalogView | undefined> => {
    calls.n += 1;
    return Promise.resolve({ pairs, fetchedAt: NOW, ageMs: 0, fresh });
  };
  return { calls, deps: { catalog: read, now: () => NOW } satisfies H1SessionDeps };
};

async function run(
  argv: string[],
  deps: H1SessionDeps = catalogOf([pair()]).deps,
  env: NodeJS.ProcessEnv = { DATABASE_URL: tmp.url },
) {
  let out = '';
  const err: string[] = [];
  const code = await runH1Cli(
    argv,
    env,
    (text) => (out += text),
    (line) => err.push(line),
    deps,
  );
  return { code, out, err };
}

// a marked account with a snapshot: minimum 1, 10000 demo, 100 real
async function marked(options: { tradingMode?: TradeMode; snapshot?: boolean } = {}) {
  const seed = await seedUserWithAccount(tmp.db, {
    balance: 10n,
    ...(options.tradingMode === undefined ? {} : { tradingMode: options.tradingMode }),
  });
  await tmp.db.transaction((tx) => setH1Mark(tx, { accountId: seed.brokerAccountId, h1: true }));
  if (options.snapshot !== false) await seedBalanceSnapshot(tmp.db, seed.brokerAccountId);
  return seed;
}
const startArgs = (accountId: string, ...extra: string[]) => [
  'session',
  'start',
  '--account',
  accountId,
  '--asset',
  '202',
  ...extra,
];
const sessionOf = async (id: string) =>
  (await tmp.db.select().from(tradingSessions).where(eq(tradingSessions.id, id)))[0]!;
const sessionsOfAccount = (accountId: string) =>
  tmp.db.select().from(tradingSessions).where(eq(tradingSessions.brokerAccountId, accountId));

describe('h1 session start (#670, #775)', () => {
  it('H1-R2′ refuses an unmarked account; no payout floor: a pair at 90 % starts', async () => {
    const plain = await seedUserWithAccount(tmp.db);
    await seedBalanceSnapshot(tmp.db, plain.brokerAccountId);
    expect(await run(startArgs(plain.brokerAccountId))).toEqual({
      code: 1,
      out: '',
      err: [`аккаунт не помечен для H1: сначала h1 mark ${plain.brokerAccountId}`],
    });

    const low = await marked();
    const at = await run(startArgs(low.brokerAccountId), catalogOf([pair({ payout: 90 })]).deps);
    expect(at).toMatchObject({ code: 0, err: [] });
    expect(await sessionsOfAccount(low.brokerAccountId)).toHaveLength(1);
  });

  it("H1-R3′ creates a v5 session: R1, the cycles, the process's strategy, the minimum as the stake, the user mode", async () => {
    const seed = await marked();
    const started = await run(startArgs(seed.brokerAccountId));
    expect(started.code).toBe(0);
    const id = started.out.trim();
    const row = await sessionOf(id);
    expect(row).toMatchObject({
      status: 'active',
      mode: 'demo',
      brokerAccountId: seed.brokerAccountId,
    });
    const settings = safeParseTradingSessionSettings(row.settings);
    expect(settings.success && settings.data).toEqual({
      version: 5,
      assetId: 202,
      durationSec: 5,
      cycles: DEFAULT_SESSION_CYCLES,
      stake: {
        strategy: 'martingale',
        baseStake: '1',
        stakeScale: 0,
        limits: martingaleLimitsFor(decimalStringSchema.parse('1')),
      },
      signal: { kind: 'h1', params: H1_R1_PARAMS, entryDelaySec: 1, expirySec: 5 },
    });

    // the saved stake of the mode wins over the minimum
    const saver = await marked();
    await setStake(
      tmp.db,
      BigInt(saver.telegramUserId),
      TradeMode.Demo,
      decimalStringSchema.parse('2.5'),
    );
    const second = await run(startArgs(saver.brokerAccountId, '--cycles', '3'), undefined, {
      DATABASE_URL: tmp.url,
      SESSION_STAKE_STRATEGY: 'fixed',
    });
    const saved = safeParseTradingSessionSettings((await sessionOf(second.out.trim())).settings);
    expect(saved.success && saved.data).toMatchObject({
      cycles: 3,
      stake: { strategy: 'fixed', baseStake: '2.5' },
    });

    // a second start names the running session and writes nothing
    expect(await run(startArgs(seed.brokerAccountId))).toEqual({
      code: 1,
      out: '',
      err: [`на аккаунте уже идёт торговая сессия: ${id}`],
    });
    expect(await sessionsOfAccount(seed.brokerAccountId)).toHaveLength(1);
  });

  it('H1-R5 DEMO_ONLY refuses a user in real mode before the catalog; without it the session is real', async () => {
    const seed = await marked({ tradingMode: TradeMode.Real });
    const catalog = catalogOf([pair()]);
    expect(
      await run(startArgs(seed.brokerAccountId), catalog.deps, {
        DATABASE_URL: tmp.url,
        DEMO_ONLY: 'true',
      }),
    ).toEqual({
      code: 1,
      out: '',
      err: ['DEMO_ONLY=true, а пользователь в реальном режиме: real-сессии отключены'],
    });
    expect(catalog.calls.n).toBe(0);
    const started = await run(startArgs(seed.brokerAccountId), catalog.deps);
    expect(started.code).toBe(0);
    expect((await sessionOf(started.out.trim())).mode).toBe('real');
  });

  it('H1-R6 every other refusal writes nothing and says why', async () => {
    const seed = await marked();
    const id = seed.brokerAccountId;
    const refusal = async (deps: H1SessionDeps, line: string, argv = startArgs(id)) => {
      expect(await run(argv, deps)).toEqual({ code: 1, out: '', err: [line] });
    };
    await refusal(
      catalogOf([pair()], false).deps,
      'каталог пар брокера недоступен — повторите позже',
    );
    await refusal(
      { catalog: () => Promise.resolve(undefined) },
      'каталог пар брокера недоступен — повторите позже',
    );
    const unavailable = 'пара 202 недоступна: её нет в каталоге, она закрыта или не берёт 5 с';
    await refusal(catalogOf([pair({ id: 101 })]).deps, unavailable);
    await refusal(catalogOf([pair({ minTimeframe: 15 })]).deps, unavailable);
    await refusal(catalogOf([pair({ scheduledUntil: NOW + 60_000 })]).deps, unavailable);

    await closeTradingSwitch(tmp.db);
    await refusal(catalogOf([pair()]).deps, 'торговля остановлена выключателем');
    await openTrading(tmp.db);

    await tmp.db
      .update(brokerAccounts)
      .set({ tradingHalted: true, haltedReason: AccountHaltReason.TradeMismatch })
      .where(eq(brokerAccounts.id, id));
    await refusal(catalogOf([pair()]).deps, 'торговля на аккаунте остановлена до ручной проверки');
    await tmp.db
      .update(brokerAccounts)
      .set({ tradingHalted: false, haltedReason: null })
      .where(eq(brokerAccounts.id, id));

    const blind = await marked({ snapshot: false });
    await refusal(
      catalogOf([pair()]).deps,
      'нет снимка баланса аккаунта: откройте экран сделки в боте и повторите',
      startArgs(blind.brokerAccountId),
    );
    await setStake(
      tmp.db,
      BigInt(seed.telegramUserId),
      TradeMode.Demo,
      decimalStringSchema.parse('20000'),
    );
    await refusal(catalogOf([pair()]).deps, 'на балансе режима меньше ставки');
    // H1-R8: the worst case of 8 martingale cycles of 5 s does not fit the hour
    await refusal(
      catalogOf([pair()]).deps,
      'сессия не укладывается в час: уменьшите --cycles',
      startArgs(blind.brokerAccountId, '--cycles', '8'),
    );
    expect(await sessionsOfAccount(id)).toEqual([]);
    expect(await sessionsOfAccount(blind.brokerAccountId)).toEqual([]);

    const unknown = await run(startArgs('8b1c6f6e-0000-4000-8000-000000000000'));
    expect(unknown).toEqual({ code: 1, out: '', err: ['аккаунт брокера не найден'] });
  });
});

describe('h1 session start: the mark under the account lock (#707)', () => {
  it('H1-R7 an unmark after the check and before the insert refuses the start and says so', async () => {
    const seed = await marked();
    const { deps } = catalogOf([pair()]);
    // the catalog is read after the CLI's own mark check: the unmark lands in between
    const racing: H1SessionDeps = {
      ...deps,
      catalog: async () => {
        await tmp.db.transaction((tx) =>
          setH1Mark(tx, { accountId: seed.brokerAccountId, h1: false }),
        );
        return deps.catalog!();
      },
    };
    expect(await run(startArgs(seed.brokerAccountId), racing)).toEqual({
      code: 1,
      out: '',
      err: ['метка H1 снята во время старта — сессия не создана'],
    });
    expect(await sessionsOfAccount(seed.brokerAccountId)).toEqual([]);
  });
});

describe('h1 session stop and status (#670)', () => {
  it('H1-R4′ stops only an H1 session; status shows the last H1 session in cycles; none is exit 1', async () => {
    const seed = await marked();
    const id = seed.brokerAccountId;
    const account = ['--account', id];
    expect(await run(['session', 'status', ...account])).toEqual({
      code: 1,
      out: '',
      err: ['нет сессий H1'],
    });
    expect((await run(['session', 'stop', ...account])).err).toEqual([
      'у аккаунта нет активной сессии',
    ]);

    const bot = await seedTradingSession(tmp.db, id);
    expect(await run(['session', 'stop', ...account])).toEqual({
      code: 1,
      out: '',
      err: ['активная сессия аккаунта — не H1: её останавливает бот'],
    });
    expect((await sessionOf(bot.id)).status).toBe('active');
    await tmp.pool.query(
      `update trading_sessions set status = 'stopped', stop_reason = 'user_stopped', ended_at = now() where id = $1`,
      [bot.id],
    );

    const started = await run(startArgs(id));
    const sessionId = started.out.trim();
    const live = await run(['session', 'status', ...account]);
    expect(live.code).toBe(0);
    expect(live.out.split('\n').slice(0, 4)).toEqual([
      `сессия ${sessionId}`,
      'статус active, режим demo',
      'циклов 0 из 5, сделок 0: выигрышей 0, проигрышей 0, ничьих 0, отклонено 0',
      'прибыль 0.00000000',
    ]);

    expect(await run(['session', 'stop', ...account])).toEqual({
      code: 0,
      out: `${sessionId}\n`,
      err: ['сессия H1 остановлена'],
    });
    expect(await sessionOf(sessionId)).toMatchObject({
      status: 'stopped',
      stopReason: 'user_stopped',
    });
    const after = await run(['session', 'status', ...account]);
    expect(after.out.split('\n')[1]).toBe('статус stopped (user_stopped), режим demo');
    expect((await run(['session', 'stop', ...account])).code).toBe(1);
  });
});
