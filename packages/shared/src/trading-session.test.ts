import { describe, expect, it } from 'vitest';
import { PairsCatalogErrorCode } from './catalog';
import { decimalStringSchema } from './money';
import {
  DEFAULT_SESSION_TRADES,
  MAX_SESSION_TRADES,
  TRADING_SESSION_SETTINGS_VERSION,
  TradingSessionErrorCode,
  TradingSessionStatus,
  TradingSessionStopReason,
  safeParseCreateTradingSessionRequest,
  safeParseReadTradingSessionQuery,
  safeParseStopTradingSessionRequest,
  safeParseTradingSessionRefusal,
  safeParseTradingSessionResponse,
  safeParseTradingSessionSettings,
  sessionFitsDeadline,
  stakeSettingsFor,
  tradingSessionStopReasonSchema,
} from './trading-session';

const settings = {
  version: TRADING_SESSION_SETTINGS_VERSION,
  assetId: 101,
  durationSec: 60,
  trades: DEFAULT_SESSION_TRADES,
  stake: { baseStake: '1', stakeScale: 0 },
};

const refused = (input: unknown) => safeParseTradingSessionSettings(input).success === false;

describe('tradingSessionSettingsSchema', () => {
  it('accepts the CLI object and the trades bounds', () => {
    expect(safeParseTradingSessionSettings(settings).success).toBe(true);
    expect(safeParseTradingSessionSettings({ ...settings, trades: 1 }).success).toBe(true);
    expect(
      safeParseTradingSessionSettings({ ...settings, trades: MAX_SESSION_TRADES }).success,
    ).toBe(true);
  });

  it('refuses trades outside [1, MAX_SESSION_TRADES]', () => {
    expect(refused({ ...settings, trades: 0 })).toBe(true);
    expect(refused({ ...settings, trades: MAX_SESSION_TRADES + 1 })).toBe(true);
    expect(refused({ ...settings, trades: 2.5 })).toBe(true);
  });

  it('refuses a non-integer or non-positive assetId and durationSec', () => {
    expect(refused({ ...settings, assetId: 1.5 })).toBe(true);
    expect(refused({ ...settings, assetId: 0 })).toBe(true);
    expect(refused({ ...settings, durationSec: 0 })).toBe(true);
    expect(refused({ ...settings, durationSec: 2_147_483_648 })).toBe(true);
  });

  it('refuses an unknown version, an extra key, a missing key and the empty default', () => {
    expect(refused({ ...settings, version: 2 })).toBe(true);
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
  const request = { telegramUserId: '42', assetId: 101, durationSec: 60 };

  it('defaults trades to DEFAULT_SESSION_TRADES and keeps an explicit value', () => {
    const parsed = safeParseCreateTradingSessionRequest(request);
    expect(parsed.success && parsed.data.trades).toBe(DEFAULT_SESSION_TRADES);
    const explicit = safeParseCreateTradingSessionRequest({ ...request, trades: 7 });
    expect(explicit.success && explicit.data.trades).toBe(7);
  });

  it('refuses trades outside the settings bounds, an extra key, a bad id and a fractional asset', () => {
    const refusedRequest = (input: unknown) =>
      safeParseCreateTradingSessionRequest(input).success === false;
    expect(refusedRequest({ ...request, trades: 0 })).toBe(true);
    expect(refusedRequest({ ...request, trades: MAX_SESSION_TRADES + 1 })).toBe(true);
    expect(refusedRequest({ ...request, mode: 'demo' })).toBe(true);
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
  it.each([
    [5, 60, true],
    [5, 300, true],
    [5, 900, false],
    [20, 60, true],
    [20, 61, false],
  ])('%i trades of %i s -> %s', (trades, durationSec, fits) => {
    expect(sessionFitsDeadline(trades, durationSec)).toBe(fits);
  });
});

const view = {
  id: '00000000-0000-4000-8000-000000000001',
  mode: 'demo',
  status: TradingSessionStatus.Active,
  stopReason: null,
  settings,
  startedAt: '2026-10-07T10:00:00.000Z',
  endedAt: null,
  trades: { planned: 5, settled: 0, rejected: 0, won: 0, lost: 0, tied: 0 },
  lastIntent: null,
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
    expect(safeParseTradingSessionRefusal({ error: 'validation' }).success).toBe(false);
  });

  it('spells catalog_unavailable as the pairs route does', () => {
    expect(TradingSessionErrorCode.CatalogUnavailable).toBe(PairsCatalogErrorCode.Unavailable);
  });
});
