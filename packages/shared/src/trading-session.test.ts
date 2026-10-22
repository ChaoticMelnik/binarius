import { describe, expect, it } from 'vitest';
import { PairsCatalogErrorCode } from './catalog';
import { H1_EXPIRY_SEC, H1_R1_PARAMS } from './h1';
import { decimalStringSchema } from './money';
import { SIGNAL_SHORTEST_INTERVAL_MS } from './signal';
import { INT4_MAX, TradeIntentErrorCode, TradeIntentStatus, type TradeIntentView } from './trading';
import {
  TRACKED_SESSIONS_MAX,
  safeParseForgetSessionStatusMessageRequest,
  safeParseRecordSessionStatusMessageRequest,
  safeParseTrackedSessionsQuery,
  safeParseTrackedSessionsResponse,
  DEFAULT_SESSION_CYCLES,
  MAX_SESSION_CYCLES,
  MAX_SESSION_SUMMARY_TRADES,
  MIN_SESSION_DURATION_SEC,
  SESSION_MAX_DURATION_MS,
  SESSION_NO_SIGNAL_CANDLES,
  sessionNoSignalTimeoutMs,
  sessionSignalCandleMs,
  TRADING_SESSION_SETTINGS_VERSION,
  safeParseSessionSummaryResponse,
  safeParseSessionShareResponse,
  sessionProgress,
  TradingSessionErrorCode,
  buildSessionSettings,
  martingaleLimitsFor,
  sessionStakeParams,
  TradingSessionStatus,
  TradingSessionStopReason,
  safeParseCreateTradingSessionRequest,
  safeParseReadTradingSessionQuery,
  safeParseStopOneTradingSessionRequest,
  safeParseStopTradingSessionRequest,
  safeParseTradingSessionRefusal,
  safeParseTradingSessionResponse,
  safeParseTradingSessionSettings,
  safeParseTradingSessionsStoppedResponse,
  isTradingSessionFinished,
  sessionFitsDeadline,
  stakeSettingsFor,
  TRADING_SESSIONS_PATH,
  TRADING_SESSIONS_STOP_PATH,
  tradingSessionStopReasonSchema,
  SESSION_SUMMARY_FALLBACK_MS,
  buildH1SessionSettings,
  H1_SESSION_SETTINGS_VERSION,
  isH1Settings,
  MAX_H1_LOSS_MULTIPLIER,
  SESSION_INTENT_REFUSALS,
  sessionIntentBlock,
  SessionIntentBlockReason,
} from './trading-session';

const settings = {
  version: 1,
  assetId: 101,
  durationSec: 60,
  trades: 5,
  stake: { baseStake: '1', stakeScale: 0 },
};

const martingaleStake = {
  strategy: 'martingale',
  baseStake: '1',
  stakeScale: 0,
  limits: { maxSteps: 4, maxStake: '12', maxSessionLoss: '20', maxSessionDurationMs: 3_600_000 },
};
const settingsV2 = { ...settings, version: 2, stake: martingaleStake };
const settingsV3 = {
  version: 3,
  assetId: 101,
  durationSec: 60,
  cycles: 5,
  stake: martingaleStake,
};

const refused = (input: unknown) => safeParseTradingSessionSettings(input).success === false;

describe('tradingSessionSettingsSchema', () => {
  it('accepts the CLI object and the trades bounds', () => {
    expect(safeParseTradingSessionSettings(settings).success).toBe(true);
    expect(safeParseTradingSessionSettings({ ...settings, trades: 1 }).success).toBe(true);
    expect(safeParseTradingSessionSettings({ ...settings, trades: 20 }).success).toBe(true);
  });

  it('refuses trades outside [1, 20]', () => {
    expect(refused({ ...settings, trades: 0 })).toBe(true);
    expect(refused({ ...settings, trades: 21 })).toBe(true);
    expect(refused({ ...settings, trades: 2.5 })).toBe(true);
  });

  // #552: v3 counts cycles, v1/v2 keep their trades
  it('reads v3 with cycles in [1, MAX_SESSION_CYCLES], and v2 and v1 with trades', () => {
    expect(safeParseTradingSessionSettings(settingsV3).success).toBe(true);
    expect(safeParseTradingSessionSettings({ ...settingsV3, cycles: 1 }).success).toBe(true);
    expect(
      safeParseTradingSessionSettings({ ...settingsV3, cycles: MAX_SESSION_CYCLES }).success,
    ).toBe(true);
    expect(safeParseTradingSessionSettings(settingsV2).success).toBe(true);
    expect(safeParseTradingSessionSettings(settings).success).toBe(true);
    expect(refused({ ...settingsV3, cycles: 0 })).toBe(true);
    expect(refused({ ...settingsV3, cycles: MAX_SESSION_CYCLES + 1 })).toBe(true);
    expect(refused({ ...settingsV3, trades: 5 })).toBe(true);
    expect(refused({ ...settingsV2, cycles: 5 })).toBe(true);
    expect(refused({ ...settingsV3, stake: settings.stake })).toBe(true);
  });

  // #552: no trade is shorter than the signal's shortest candle
  it('refuses durationSec below MIN_SESSION_DURATION_SEC in every version', () => {
    expect(MIN_SESSION_DURATION_SEC).toBe(5);
    expect(MIN_SESSION_DURATION_SEC * 1000).toBe(SIGNAL_SHORTEST_INTERVAL_MS);
    for (const row of [settings, settingsV2, settingsV3]) {
      expect(refused({ ...row, durationSec: 4 })).toBe(true);
      expect(safeParseTradingSessionSettings({ ...row, durationSec: 5 }).success).toBe(true);
    }
  });

  it('refuses a non-integer or non-positive assetId and durationSec', () => {
    expect(refused({ ...settings, assetId: 1.5 })).toBe(true);
    expect(refused({ ...settings, assetId: 0 })).toBe(true);
    expect(refused({ ...settings, durationSec: 0 })).toBe(true);
    expect(refused({ ...settings, durationSec: 2_147_483_648 })).toBe(true);
  });

  it('refuses an unknown version, an extra key, a missing key and the empty default', () => {
    expect(refused({ ...settings, version: 4 })).toBe(true);
    expect(refused({ ...settings, strategy: 'martingale' })).toBe(true);
    expect(refused({ ...settings, stake: { ...settings.stake, limits: {} } })).toBe(true);
    expect(refused({ ...settings, trades: undefined })).toBe(true);
    expect(refused({})).toBe(true);
  });

  it('refuses a baseStake outside numeric(20,8) and a stakeScale outside [0, 8]', () => {
    expect(refused({ ...settings, stake: { baseStake: '1234567890123', stakeScale: 0 } })).toBe(
      true,
    );
    expect(refused({ ...settings, stake: { baseStake: '0.000000001', stakeScale: 8 } })).toBe(true);
    expect(refused({ ...settings, stake: { baseStake: '0', stakeScale: 0 } })).toBe(true);
    expect(refused({ ...settings, stake: { baseStake: '1', stakeScale: 9 } })).toBe(true);
    expect(refused({ ...settings, stake: { baseStake: '1', stakeScale: -1 } })).toBe(true);
  });
});

// #450: v2 carries the strategy, martingale with its limits; only v2 is written
describe('tradingSessionSettingsSchema v2', () => {
  const limits = {
    maxSteps: 4,
    maxStake: '12',
    maxSessionLoss: '20',
    maxSessionDurationMs: 3_600_000,
  };
  const fixed = {
    ...settings,
    version: 2,
    stake: { strategy: 'fixed', baseStake: '1', stakeScale: 2 },
  };
  const martingale = { ...fixed, stake: { ...fixed.stake, strategy: 'martingale', limits } };

  it('accepts fixed and martingale', () => {
    expect(safeParseTradingSessionSettings(fixed).success).toBe(true);
    expect(safeParseTradingSessionSettings(martingale).success).toBe(true);
  });

  it('refuses martingale without limits, fixed with them and a v2 stake without a strategy', () => {
    expect(refused({ ...martingale, stake: { ...fixed.stake, strategy: 'martingale' } })).toBe(
      true,
    );
    expect(refused({ ...fixed, stake: { ...fixed.stake, limits } })).toBe(true);
    expect(refused({ ...fixed, stake: settings.stake })).toBe(true);
    expect(refused({ ...fixed, stake: { ...fixed.stake, strategy: 'other' } })).toBe(true);
  });

  it('refuses limits outside their domain', () => {
    const withLimits = (patch: object) => ({
      ...martingale,
      stake: { ...martingale.stake, limits: { ...limits, ...patch } },
    });
    expect(refused(withLimits({ maxSteps: 1 }))).toBe(true);
    expect(refused(withLimits({ maxStake: '0' }))).toBe(true);
    expect(refused(withLimits({ maxSessionLoss: '-20' }))).toBe(true);
    expect(refused(withLimits({ maxSessionLoss: '1234567890123' }))).toBe(true);
    expect(refused(withLimits({ maxSessionDurationMs: 0 }))).toBe(true);
    expect(refused(withLimits({ extra: 1 }))).toBe(true);
  });

  it('reads v1 as the fixed strategy and v2 as stored', () => {
    const v1 = safeParseTradingSessionSettings(settings);
    expect(v1.success && sessionStakeParams(v1.data)).toEqual({
      strategy: 'fixed',
      baseStake: '1',
      stakeScale: 0,
    });
    const v2 = safeParseTradingSessionSettings(martingale);
    expect(v2.success && sessionStakeParams(v2.data)).toEqual(martingale.stake);
  });
});

describe('martingaleLimitsFor (#450, docs/stake.md -> Defaults)', () => {
  const d = (value: string) => decimalStringSchema.parse(value);

  it('pins 4 steps, 12×B, 20×B and the session hour', () => {
    expect(martingaleLimitsFor(d('1.00'))).toEqual({
      maxSteps: 4,
      maxStake: '12',
      maxSessionLoss: '20',
      maxSessionDurationMs: 3_600_000,
    });
    expect(martingaleLimitsFor(d('1.55'))).toMatchObject({
      maxStake: '18.6',
      maxSessionLoss: '31',
    });
  });

  it('keeps a stake of 8 fraction digits on its grid', () => {
    expect(martingaleLimitsFor(d('0.00500000'))).toMatchObject({
      maxStake: '0.06',
      maxSessionLoss: '0.1',
    });
    expect(martingaleLimitsFor(d('0.00000001'))).toMatchObject({
      maxStake: '0.00000012',
      maxSessionLoss: '0.0000002',
    });
  });
});

describe('buildSessionSettings (#450)', () => {
  const input = {
    assetId: 101,
    durationSec: 60,
    cycles: 5,
    stake: { baseStake: decimalStringSchema.parse('1.55'), stakeScale: 2 },
  };

  it('writes v3 martingale with the limits of the base stake', () => {
    expect(TRADING_SESSION_SETTINGS_VERSION).toBe(3);
    const built = buildSessionSettings({ ...input, strategy: 'martingale' });
    expect(built.success && built.data).toEqual({
      version: 3,
      assetId: 101,
      durationSec: 60,
      cycles: 5,
      stake: {
        strategy: 'martingale',
        baseStake: '1.55',
        stakeScale: 2,
        limits: {
          maxSteps: 4,
          maxStake: '18.6',
          maxSessionLoss: '31',
          maxSessionDurationMs: 3_600_000,
        },
      },
    });
  });

  it('writes v3 fixed without limits', () => {
    const built = buildSessionSettings({ ...input, strategy: 'fixed' });
    expect(built.success && built.data.stake).toEqual({
      strategy: 'fixed',
      baseStake: '1.55',
      stakeScale: 2,
    });
  });

  it('refuses a zero stake and a stake whose limits leave numeric(20,8)', () => {
    for (const strategy of ['fixed', 'martingale'] as const) {
      const zero = { ...input.stake, baseStake: decimalStringSchema.parse('0') };
      expect(buildSessionSettings({ ...input, stake: zero, strategy }).success).toBe(false);
    }
    const huge = { ...input.stake, baseStake: decimalStringSchema.parse('100000000000') };
    expect(buildSessionSettings({ ...input, stake: huge, strategy: 'fixed' }).success).toBe(true);
    expect(buildSessionSettings({ ...input, stake: huge, strategy: 'martingale' }).success).toBe(
      false,
    );
  });
});

describe('tradingSessionStopReasonSchema', () => {
  it('accepts every constant value and refuses anything else', () => {
    for (const reason of Object.values(TradingSessionStopReason)) {
      expect(tradingSessionStopReasonSchema.safeParse(reason).success).toBe(true);
    }
    expect(tradingSessionStopReasonSchema.safeParse('bogus').success).toBe(false);
  });
});

describe('stakeSettingsFor', () => {
  it.each([
    ['1.00000000', '1', 0],
    ['0.50000000', '0.5', 1],
    ['1.25', '1.25', 2],
    ['0.00000001', '0.00000001', 8],
    ['10.00000000', '10', 0],
    ['007.10', '7.1', 1],
  ])('%s -> { %s, %i }', (min, baseStake, stakeScale) => {
    expect(stakeSettingsFor(decimalStringSchema.parse(min))).toEqual({ baseStake, stakeScale });
  });

  it('gives settings the schema accepts for every scale', () => {
    for (const min of [
      '1',
      '1.5',
      '0.25',
      '0.125',
      '12.3456',
      '0.00001',
      '9.999999',
      '0.12345678',
    ]) {
      expect(
        safeParseTradingSessionSettings({
          ...settings,
          stake: stakeSettingsFor(decimalStringSchema.parse(min)),
        }).success,
      ).toBe(true);
    }
  });
});

describe('createTradingSessionRequestSchema', () => {
  const request = { telegramUserId: '42', mode: 'demo', assetId: 101, durationSec: 60 };

  it.each(['demo', 'real'])('parses mode %s', (mode) => {
    const parsed = safeParseCreateTradingSessionRequest({ ...request, mode });
    expect(parsed.success && parsed.data.mode).toBe(mode);
  });

  it('refuses a request without a mode or with an unknown one', () => {
    const withoutMode = { telegramUserId: '42', assetId: 101, durationSec: 60 };
    expect(safeParseCreateTradingSessionRequest(withoutMode).success).toBe(false);
    expect(safeParseCreateTradingSessionRequest({ ...request, mode: 'bogus' }).success).toBe(false);
  });

  it('defaults cycles to DEFAULT_SESSION_CYCLES and keeps an explicit value', () => {
    const parsed = safeParseCreateTradingSessionRequest(request);
    expect(parsed.success && parsed.data.cycles).toBe(DEFAULT_SESSION_CYCLES);
    const explicit = safeParseCreateTradingSessionRequest({ ...request, cycles: 7 });
    expect(explicit.success && explicit.data.cycles).toBe(7);
  });

  it('refuses cycles outside the settings bounds, trades, a short duration, an extra key, a bad id and a fractional asset', () => {
    const refusedRequest = (input: unknown) =>
      safeParseCreateTradingSessionRequest(input).success === false;
    expect(refusedRequest({ ...request, cycles: 0 })).toBe(true);
    expect(refusedRequest({ ...request, cycles: MAX_SESSION_CYCLES + 1 })).toBe(true);
    expect(refusedRequest({ ...request, trades: 5 })).toBe(true);
    expect(refusedRequest({ ...request, durationSec: 4 })).toBe(true);
    expect(refusedRequest({ ...request, durationSec: 5 })).toBe(false);
    expect(refusedRequest({ ...request, stake: '1' })).toBe(true);
    expect(refusedRequest({ ...request, brokerAccountId: 'nope' })).toBe(true);
    expect(refusedRequest({ ...request, assetId: 1.5 })).toBe(true);
    expect(refusedRequest({ ...request, telegramUserId: 42 })).toBe(true);
  });

  it('reads the query and the stop body', () => {
    expect(safeParseReadTradingSessionQuery({ telegramUserId: '42' }).success).toBe(true);
    expect(safeParseReadTradingSessionQuery({}).success).toBe(false);
    expect(safeParseStopTradingSessionRequest({ telegramUserId: '42' }).success).toBe(true);
    expect(safeParseStopTradingSessionRequest({ telegramUserId: '42', x: 1 }).success).toBe(false);
  });
});

describe('sessionFitsDeadline', () => {
  // #552: martingale counts MARTINGALE_MAX_STEPS trades a cycle, fixed one
  it.each([
    ['martingale', 5, 5, true],
    ['martingale', 5, 15, true],
    ['martingale', 5, 60, true],
    ['martingale', 5, 61, false],
    ['martingale', 5, 300, false],
    ['martingale', 7, 5, true],
    ['martingale', 8, 5, false],
    ['fixed', 5, 300, true],
    ['fixed', 5, 900, false],
    ['fixed', 20, 60, true],
    ['fixed', 20, 61, false],
  ] as const)('%s: %i cycles of %i s -> %s', (strategy, cycles, durationSec, fits) => {
    expect(sessionFitsDeadline(cycles, durationSec, strategy)).toBe(fits);
  });
});

describe('the no-signal limit in candles (#637)', () => {
  it('is 20 candles of the session signal interval', () => {
    expect(SESSION_NO_SIGNAL_CANDLES).toBe(20);
    expect(sessionNoSignalTimeoutMs(5)).toBe(100_000);
    expect(sessionNoSignalTimeoutMs(15)).toBe(300_000);
    expect(sessionNoSignalTimeoutMs(20)).toBe(300_000);
    expect(sessionNoSignalTimeoutMs(60)).toBe(1_200_000);
    expect(sessionSignalCandleMs(20)).toBe(15_000);
  });
});

describe('sessionProgress (#552)', () => {
  const counts = { settled: 3, won: 1 };
  it('v1 and v2 count settled trades against settings.trades', () => {
    expect(sessionProgress(safeParse(settings), counts)).toEqual({ planned: 5, done: 3 });
    expect(sessionProgress(safeParse(settingsV2), counts)).toEqual({ planned: 5, done: 3 });
  });
  it('v3 martingale counts the wins: only a win closes a cycle', () => {
    expect(sessionProgress(safeParse(settingsV3), counts)).toEqual({ planned: 5, done: 1 });
  });
  it('v3 fixed counts every settled trade as a cycle', () => {
    const fixed = { ...settingsV3, stake: { strategy: 'fixed', baseStake: '1', stakeScale: 0 } };
    expect(sessionProgress(safeParse(fixed), counts)).toEqual({ planned: 5, done: 3 });
  });
  it('nothing settled is nothing done', () => {
    expect(sessionProgress(safeParse(settingsV3), { settled: 0, won: 0 })).toEqual({
      planned: 5,
      done: 0,
    });
  });
});

describe('MAX_SESSION_SUMMARY_TRADES (#552)', () => {
  it('is the hour over the shortest trade', () => {
    expect(MAX_SESSION_SUMMARY_TRADES).toBe(720);
    expect(MAX_SESSION_SUMMARY_TRADES).toBe(
      SESSION_MAX_DURATION_MS / (MIN_SESSION_DURATION_SEC * 1000),
    );
  });
  it('bounds the summary trades', () => {
    const trades = (n: number) =>
      Array.from({ length: n }, () => ({ profit: '0', openPrice: 1, closePrice: 1 }));
    const parse = (n: number) =>
      safeParseSessionSummaryResponse({
        summary: { result: '0', trades: trades(n), referralCode: null },
      }).success;
    expect(parse(MAX_SESSION_SUMMARY_TRADES)).toBe(true);
    expect(parse(MAX_SESSION_SUMMARY_TRADES + 1)).toBe(false);
  });
});

describe('the summary in one message (#537)', () => {
  const parse = (summary: unknown) => safeParseSessionSummaryResponse({ summary }).success;
  it('pins the fallback grace at 30 minutes', () => {
    expect(SESSION_SUMMARY_FALLBACK_MS).toBe(1_800_000);
  });
  it('takes a summary without trades and without a referral code', () => {
    expect(parse({ result: '0.00000000', trades: [], referralCode: null })).toBe(true);
  });
  it('takes the owner referral code and refuses one off its pattern or a missing field', () => {
    const trades = [{ profit: '1', openPrice: 1, closePrice: 2 }];
    expect(parse({ result: '1', trades, referralCode: 'abcd2345' })).toBe(true);
    expect(parse({ result: '1', trades, referralCode: 'a b' })).toBe(false);
    expect(parse({ result: '1', trades })).toBe(false);
  });
});

function safeParse(input: unknown) {
  const parsed = safeParseTradingSessionSettings(input);
  if (!parsed.success) throw new Error('fixture settings do not parse');
  return parsed.data;
}

const view = {
  id: '00000000-0000-4000-8000-000000000001',
  mode: 'demo',
  status: TradingSessionStatus.Active,
  stopReason: null,
  settings,
  startedAt: '2026-10-07T10:00:00.000Z',
  endedAt: null,
  trades: { settled: 0, rejected: 0, won: 0, lost: 0, tied: 0, profit: '0.00000000' },
  cycles: { planned: 5, closed: 0 },
  lastIntent: null,
  signalAction: null,
  balance: null,
  noticesDone: false,
};

describe('tradingSessionViewSchema', () => {
  it('accepts the view, null settings and a stopped session', () => {
    expect(safeParseTradingSessionResponse({ session: view }).success).toBe(true);
    expect(safeParseTradingSessionResponse({ session: { ...view, settings: null } }).success).toBe(
      true,
    );
    expect(
      safeParseTradingSessionResponse({
        session: {
          ...view,
          status: TradingSessionStatus.Stopped,
          stopReason: TradingSessionStopReason.UserStopped,
          endedAt: '2026-10-07T10:05:00.000Z',
        },
      }).success,
    ).toBe(true);
  });

  it('refuses an extra key and a missing tied counter', () => {
    expect(safeParseTradingSessionResponse({ session: { ...view, userId: 'x' } }).success).toBe(
      false,
    );
    const withoutTied: Partial<typeof view.trades> = { ...view.trades };
    delete withoutTied.tied;
    expect(
      safeParseTradingSessionResponse({ session: { ...view, trades: withoutTied } }).success,
    ).toBe(false);
  });

  it('carries the profit sum and the balance, both required (#337)', () => {
    const balance = { available: '10002.50000000', ageSec: 0, current: true };
    expect(safeParseTradingSessionResponse({ session: { ...view, balance } }).success).toBe(true);
    const withoutBalance: Partial<typeof view> = { ...view };
    delete withoutBalance.balance;
    expect(safeParseTradingSessionResponse({ session: withoutBalance }).success).toBe(false);
    const withoutProfit: Partial<typeof view.trades> = { ...view.trades };
    delete withoutProfit.profit;
    expect(
      safeParseTradingSessionResponse({ session: { ...view, trades: withoutProfit } }).success,
    ).toBe(false);
    expect(
      safeParseTradingSessionResponse({
        session: { ...view, balance: { ...balance, ageSec: -1 } },
      }).success,
    ).toBe(false);
    expect(
      safeParseTradingSessionResponse({ session: { ...view, balance: { ...balance, extra: 1 } } })
        .success,
    ).toBe(false);
  });

  it('requires the summary mark as a boolean (#464)', () => {
    const withoutMark: Partial<typeof view> = { ...view };
    delete withoutMark.noticesDone;
    expect(safeParseTradingSessionResponse({ session: withoutMark }).success).toBe(false);
    expect(
      safeParseTradingSessionResponse({ session: { ...view, noticesDone: 'yes' } }).success,
    ).toBe(false);
    expect(
      safeParseTradingSessionResponse({ session: { ...view, noticesDone: true } }).success,
    ).toBe(true);
  });

  it('requires the direction of the session picture, up, down or null (#568)', () => {
    const withoutSignal: Partial<typeof view> = { ...view };
    delete withoutSignal.signalAction;
    expect(safeParseTradingSessionResponse({ session: withoutSignal }).success).toBe(false);
    for (const signalAction of ['up', 'down', null]) {
      expect(safeParseTradingSessionResponse({ session: { ...view, signalAction } }).success).toBe(
        true,
      );
    }
    expect(
      safeParseTradingSessionResponse({ session: { ...view, signalAction: 'sideways' } }).success,
    ).toBe(false);
  });
});

describe('isTradingSessionFinished', () => {
  const intent = (status: TradeIntentStatus) => ({ status }) as TradeIntentView;
  const stopped = TradingSessionStatus.Stopped;

  it('is true for a stopped session whose last trade has no edge left', () => {
    expect(isTradingSessionFinished({ status: stopped, lastIntent: null })).toBe(true);
    expect(
      isTradingSessionFinished({ status: stopped, lastIntent: intent(TradeIntentStatus.Settled) }),
    ).toBe(true);
    expect(
      isTradingSessionFinished({ status: stopped, lastIntent: intent(TradeIntentStatus.Rejected) }),
    ).toBe(true);
  });

  it('is false while a trade can still move or the session runs', () => {
    expect(
      isTradingSessionFinished({
        status: stopped,
        lastIntent: intent(TradeIntentStatus.ManualReview),
      }),
    ).toBe(false);
    expect(
      isTradingSessionFinished({ status: stopped, lastIntent: intent(TradeIntentStatus.Accepted) }),
    ).toBe(false);
    expect(
      isTradingSessionFinished({ status: TradingSessionStatus.Active, lastIntent: null }),
    ).toBe(false);
  });
});

describe('tradingSessionRefusalSchema', () => {
  it('carries a session only on active_session_exists', () => {
    const active = TradingSessionErrorCode.ActiveSessionExists;
    expect(safeParseTradingSessionRefusal({ error: active, session: view }).success).toBe(true);
    expect(safeParseTradingSessionRefusal({ error: active, session: null }).success).toBe(true);
    expect(safeParseTradingSessionRefusal({ error: active }).success).toBe(false);
    expect(
      safeParseTradingSessionRefusal({ error: TradingSessionErrorCode.UserNotFound }).success,
    ).toBe(true);
    expect(
      safeParseTradingSessionRefusal({ error: TradingSessionErrorCode.UserNotFound, session: null })
        .success,
    ).toBe(false);
    expect(
      safeParseTradingSessionRefusal({ error: TradingSessionErrorCode.TradingPaused }).success,
    ).toBe(true);
    expect(safeParseTradingSessionRefusal({ error: 'validation' }).success).toBe(false);
  });

  it('spells catalog_unavailable as the pairs route does', () => {
    expect(TradingSessionErrorCode.CatalogUnavailable).toBe(PairsCatalogErrorCode.Unavailable);
  });
});

describe('tradingSessionsStoppedResponseSchema (#122)', () => {
  it('accepts an empty list and a list of views', () => {
    expect(safeParseTradingSessionsStoppedResponse({ sessions: [] }).success).toBe(true);
    expect(safeParseTradingSessionsStoppedResponse({ sessions: [view, view] }).success).toBe(true);
  });

  it('refuses an extra key, a missing list and an element that is not a view', () => {
    expect(safeParseTradingSessionsStoppedResponse({ sessions: [], stopped: 0 }).success).toBe(
      false,
    );
    expect(safeParseTradingSessionsStoppedResponse({}).success).toBe(false);
    expect(
      safeParseTradingSessionsStoppedResponse({ sessions: [{ ...view, userId: 'x' }] }).success,
    ).toBe(false);
    expect(safeParseTradingSessionsStoppedResponse({ session: view }).success).toBe(false);
  });

  it('sits under the sessions path', () => {
    expect(TRADING_SESSIONS_STOP_PATH).toBe(`${TRADING_SESSIONS_PATH}/stop`);
  });
});

describe('the stop body (#587)', () => {
  const owner = '123456789';
  it('the one-session stop accepts waitingMessageId from 1 to INT4_MAX, and none', () => {
    expect(safeParseStopOneTradingSessionRequest({ telegramUserId: owner }).data).toEqual({
      telegramUserId: owner,
    });
    for (const waitingMessageId of [1, INT4_MAX]) {
      expect(
        safeParseStopOneTradingSessionRequest({ telegramUserId: owner, waitingMessageId }).data,
      ).toEqual({ telegramUserId: owner, waitingMessageId });
    }
  });
  it.each([0, INT4_MAX + 1, 1.5, '7'])('the one-session stop refuses waitingMessageId %s', (id) => {
    expect(
      safeParseStopOneTradingSessionRequest({ telegramUserId: owner, waitingMessageId: id })
        .success,
    ).toBe(false);
  });
  it('the one-session stop refuses an extra key; the stop-all and summary body refuses waitingMessageId', () => {
    expect(
      safeParseStopOneTradingSessionRequest({ telegramUserId: owner, waitingMessageId: 1, x: 1 })
        .success,
    ).toBe(false);
    expect(
      safeParseStopTradingSessionRequest({ telegramUserId: owner, waitingMessageId: 1 }).success,
    ).toBe(false);
  });
});

describe('the recovery contract (#567)', () => {
  const owner = '123456789';
  it.each([0, INT4_MAX + 1, 1.5])('refuses a status messageId of %s', (messageId) => {
    expect(
      safeParseRecordSessionStatusMessageRequest({ telegramUserId: owner, messageId }).success,
    ).toBe(false);
  });
  it('accepts a status messageId from 1 to INT4_MAX and refuses an extra field', () => {
    for (const messageId of [1, INT4_MAX]) {
      expect(
        safeParseRecordSessionStatusMessageRequest({ telegramUserId: owner, messageId }).success,
      ).toBe(true);
    }
    expect(
      safeParseRecordSessionStatusMessageRequest({ telegramUserId: owner, messageId: 1, x: 1 })
        .success,
    ).toBe(false);
  });
  // #587: the newest id wins, so a record no longer names a message it replaces
  it('the record and the lost bodies refuse replacesMessageId', () => {
    expect(
      safeParseRecordSessionStatusMessageRequest({
        telegramUserId: owner,
        messageId: 2,
        replacesMessageId: 1,
      }).success,
    ).toBe(false);
    expect(
      safeParseForgetSessionStatusMessageRequest({ telegramUserId: owner, messageId: 1 }).success,
    ).toBe(true);
    expect(
      safeParseForgetSessionStatusMessageRequest({
        telegramUserId: owner,
        messageId: 1,
        replacesMessageId: 2,
      }).success,
    ).toBe(false);
  });

  it.each(['0', String(TRACKED_SESSIONS_MAX + 1), 'ten', ''])('refuses limit=%s', (limit) => {
    expect(safeParseTrackedSessionsQuery({ limit }).success).toBe(false);
  });
  it('reads limit, and the ceiling when it is absent', () => {
    expect(safeParseTrackedSessionsQuery({ limit: '3' }).data).toEqual({ limit: 3 });
    expect(safeParseTrackedSessionsQuery({}).data).toEqual({ limit: TRACKED_SESSIONS_MAX });
  });

  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    telegramUserId: owner,
    messageId: 7,
    assetId: null,
    startedAt: '2026-10-16T10:00:00.000Z',
    language: 'en',
  };
  it('reads a tracked session list and refuses a row without a field', () => {
    expect(
      safeParseTrackedSessionsResponse({ sessions: [row, { ...row, assetId: 101 }] }).success,
    ).toBe(true);
    const short: Partial<typeof row> = { ...row };
    delete short.assetId;
    expect(safeParseTrackedSessionsResponse({ sessions: [short] }).success).toBe(false);
    // #508: the owner's language is required and one of the two
    const unspoken: Partial<typeof row> = { ...row };
    delete unspoken.language;
    expect(safeParseTrackedSessionsResponse({ sessions: [unspoken] }).success).toBe(false);
    expect(
      safeParseTrackedSessionsResponse({ sessions: [{ ...row, language: 'de' }] }).success,
    ).toBe(false);
    expect(
      safeParseTrackedSessionsResponse({
        sessions: Array.from({ length: TRACKED_SESSIONS_MAX + 1 }, () => row),
      }).success,
    ).toBe(false);
  });
});

describe('sessionShareResponseSchema (#538)', () => {
  const trade = { profit: '1.5', openPrice: 1.1, closePrice: 1.2, action: 'up' as const };
  const share = {
    session: view,
    trades: [trade],
    pair: { symbol: 'EURUSD', isOtc: true, digits: 5 },
    referralCode: 'AbC123xY',
  };
  const parse = (patch: Record<string, unknown>) =>
    safeParseSessionShareResponse({ share: { ...share, ...patch } }).success;

  it('round-trips the share and accepts a null pair, code and an empty trade list', () => {
    const parsed = safeParseSessionShareResponse({ share });
    expect(parsed.success && parsed.data).toEqual({ share });
    expect(parse({ pair: null, referralCode: null, trades: [] })).toBe(true);
    expect(parse({ pair: { symbol: 'EURUSD', digits: 5 } })).toBe(true);
  });
  it('bounds the trades by MAX_SESSION_SUMMARY_TRADES', () => {
    const trades = (n: number) => Array.from({ length: n }, () => trade);
    expect(parse({ trades: trades(MAX_SESSION_SUMMARY_TRADES) })).toBe(true);
    expect(parse({ trades: trades(MAX_SESSION_SUMMARY_TRADES + 1) })).toBe(false);
  });
  it('refuses a code off the pattern, a trade without its direction and an extra pair key', () => {
    expect(parse({ referralCode: 'short' })).toBe(false);
    expect(parse({ referralCode: 'AbC123x!' })).toBe(false);
    expect(parse({ trades: [{ profit: '1', openPrice: 1, closePrice: 1 }] })).toBe(false);
    expect(parse({ pair: { symbol: 'EURUSD', digits: 5, payout: 80 } })).toBe(false);
  });
});

describe('settings v4, the H1 session (#670)', () => {
  const h1Settings = {
    version: 4,
    assetId: 101,
    durationSec: 5,
    trades: 50,
    stake: { strategy: 'fixed', baseStake: '1.5', stakeScale: 2 },
    signal: { kind: 'h1', params: { ...H1_R1_PARAMS }, entryDelaySec: 1, expirySec: 5 },
    maxLoss: '30',
  };
  const v4 = (patch: Record<string, unknown> = {}) => ({ ...h1Settings, ...patch });

  it('H1-S1 reads v4 and refuses it outside its bounds', () => {
    expect(safeParseTradingSessionSettings(v4()).success).toBe(true);
    expect(
      safeParseTradingSessionSettings(v4({ trades: MAX_SESSION_SUMMARY_TRADES })).success,
    ).toBe(true);
    expect(refused(v4({ trades: 0 }))).toBe(true);
    expect(refused(v4({ trades: MAX_SESSION_SUMMARY_TRADES + 1 }))).toBe(true);
    expect(refused(v4({ durationSec: 60 }))).toBe(true);
    expect(refused(v4({ stake: martingaleStake }))).toBe(true);
    expect(refused(v4({ maxLoss: '0' }))).toBe(true);
    expect(refused(v4({ maxLoss: '1000000000000' }))).toBe(true);
    expect(refused(v4({ signal: { ...h1Settings.signal, kind: 'momentum' } }))).toBe(true);
    expect(refused(v4({ signal: { ...h1Settings.signal, expirySec: 15 } }))).toBe(true);
    expect(refused(v4({ signal: { ...h1Settings.signal, entryDelaySec: 0 } }))).toBe(true);
    expect(refused(v4({ cycles: 5 }))).toBe(true);
    expect(refused(v4({ maxLoss: undefined }))).toBe(true);
  });

  it('H1-S2 counts every settled trade against settings.trades', () => {
    expect(sessionProgress(safeParse(v4()), { settled: 3, won: 1 })).toEqual({
      planned: 50,
      done: 3,
    });
  });

  it('H1-S3 reads the stake as fixed', () => {
    expect(sessionStakeParams(safeParse(v4()))).toEqual(h1Settings.stake);
  });

  it('H1-S4 buildH1SessionSettings writes R1, entry +1 s, expiry 5 s and maxLoss = k × B', () => {
    const built = buildH1SessionSettings({
      assetId: 101,
      trades: 50,
      stake: { baseStake: decimalStringSchema.parse('1.5'), stakeScale: 2 },
      maxLossMultiplier: 20,
    });
    expect(built.success && built.data).toEqual(h1Settings);
    const ceiling = buildH1SessionSettings({
      assetId: 101,
      trades: 1,
      stake: { baseStake: decimalStringSchema.parse('0.00000001'), stakeScale: 8 },
      maxLossMultiplier: MAX_H1_LOSS_MULTIPLIER,
    });
    expect(ceiling.success && ceiling.data.version === 4 && ceiling.data.maxLoss).toBe('0.00001');
    const zero = buildH1SessionSettings({
      assetId: 101,
      trades: 50,
      stake: { baseStake: decimalStringSchema.parse('0'), stakeScale: 0 },
      maxLossMultiplier: 20,
    });
    expect(zero.success).toBe(false);
    const overflow = buildH1SessionSettings({
      assetId: 101,
      trades: 50,
      stake: { baseStake: decimalStringSchema.parse('999999999999'), stakeScale: 0 },
      maxLossMultiplier: 2,
    });
    expect(overflow.success).toBe(false);
  });

  it('H1-S5 isH1Settings is true for v4 only; the shortest session trade is the H1 expiry', () => {
    expect(H1_SESSION_SETTINGS_VERSION).toBe(4);
    expect(isH1Settings(safeParse(v4()))).toBe(true);
    expect(isH1Settings(safeParse(settings))).toBe(false);
    expect(isH1Settings(safeParse(settingsV2))).toBe(false);
    expect(isH1Settings(safeParse(settingsV3))).toBe(false);
    expect(MIN_SESSION_DURATION_SEC).toBe(H1_EXPIRY_SEC);
  });

  it('H1-S6 SESSION_INTENT_REFUSALS: every code, two reschedules, a halt is manual_review', () => {
    expect(Object.keys(SESSION_INTENT_REFUSALS).sort()).toEqual(
      Object.values(TradeIntentErrorCode).sort(),
    );
    const reschedules = Object.entries(SESSION_INTENT_REFUSALS)
      .filter(([, refusal]) => refusal.kind === 'reschedule')
      .map(([code]) => code)
      .sort();
    expect(reschedules).toEqual(
      [
        TradeIntentErrorCode.ActiveIntentExists,
        TradeIntentErrorCode.ClientRequestIdConflict,
      ].sort(),
    );
    expect(SESSION_INTENT_REFUSALS[TradeIntentErrorCode.AccountHalted]).toEqual({
      kind: 'stop',
      reason: TradingSessionStopReason.ManualReview,
    });
    expect(SESSION_INTENT_REFUSALS[TradeIntentErrorCode.TradingPaused]).toEqual({
      kind: 'stop',
      reason: TradingSessionStopReason.KillSwitch,
    });
    expect(SESSION_INTENT_REFUSALS[TradeIntentErrorCode.DemoOnly]).toEqual({
      kind: 'stop',
      reason: TradingSessionStopReason.AccountUnavailable,
    });
  });
});

describe('sessionIntentBlock (#707): why a session may not create its next intent', () => {
  const h1 = safeParse({
    version: 4,
    assetId: 101,
    durationSec: 5,
    trades: 3,
    stake: { strategy: 'fixed', baseStake: '1', stakeScale: 0 },
    signal: { kind: 'h1', params: { ...H1_R1_PARAMS }, entryDelaySec: 1, expirySec: 5 },
    maxLoss: '20',
  });
  const won = { status: TradeIntentStatus.Settled, profit: '0.92' };
  const lost = { status: TradeIntentStatus.Settled, profit: '-1' };
  const rejected = { status: TradeIntentStatus.Rejected, profit: null };
  const live = { status: TradeIntentStatus.Submitting, profit: null };
  const history = (
    intents: { status: TradeIntentStatus; profit: string | null }[],
    patch: { expired?: boolean; lossLimitReached?: boolean } = {},
  ) => ({ expired: false, lossLimitReached: false, intents, ...patch });

  it('H1-S7 nothing blocks a session inside its limits', () => {
    expect(sessionIntentBlock(history([]), h1)).toBeNull();
    expect(sessionIntentBlock(history([won, rejected, lost]), h1)).toBeNull();
  });

  it('H1-S8 each reason alone blocks, every other condition clear', () => {
    expect(sessionIntentBlock(history([won], { expired: true }), h1)).toEqual({
      reason: SessionIntentBlockReason.Expired,
    });
    expect(sessionIntentBlock(history([won, live]), h1)).toEqual({
      reason: SessionIntentBlockReason.Live,
    });
    expect(
      sessionIntentBlock(history([{ status: TradeIntentStatus.ManualReview, profit: null }]), h1),
    ).toEqual({ reason: SessionIntentBlockReason.Live });
    expect(sessionIntentBlock(history([won, lost, lost]), h1)).toEqual({
      reason: SessionIntentBlockReason.Completed,
      settled: 3,
      done: 3,
    });
    expect(sessionIntentBlock(history([lost], { lossLimitReached: true }), h1)).toEqual({
      reason: SessionIntentBlockReason.MaxLoss,
    });
    expect(sessionIntentBlock(history([won, rejected, rejected]), h1)).toEqual({
      reason: SessionIntentBlockReason.RejectedTwice,
    });
  });

  it('H1-S9 the order: expired, live, completed, max loss, two rejections', () => {
    const all = history([won, lost, rejected, rejected, live], {
      expired: true,
      lossLimitReached: true,
    });
    expect(sessionIntentBlock(all, h1)?.reason).toBe(SessionIntentBlockReason.Expired);
    expect(sessionIntentBlock({ ...all, expired: false }, h1)?.reason).toBe(
      SessionIntentBlockReason.Live,
    );
    const done = history([won, lost, won], { lossLimitReached: true });
    expect(sessionIntentBlock(done, h1)?.reason).toBe(SessionIntentBlockReason.Completed);
    const twice = history([rejected, rejected], { lossLimitReached: true });
    expect(sessionIntentBlock(twice, h1)?.reason).toBe(SessionIntentBlockReason.MaxLoss);
  });

  it('H1-S10 a martingale v3 session counts cycles by wins; a zero or missing profit is no win', () => {
    const v3 = safeParse({ ...settingsV3, cycles: 2 });
    const zero = { status: TradeIntentStatus.Settled, profit: '0.00000000' };
    const missing = { status: TradeIntentStatus.Settled, profit: null };
    expect(sessionIntentBlock(history([won, lost, zero, missing]), v3)).toBeNull();
    expect(sessionIntentBlock(history([won, lost, won]), v3)).toEqual({
      reason: SessionIntentBlockReason.Completed,
      settled: 3,
      done: 2,
    });
  });
});
