import { describe, expect, it } from 'vitest';
import { decimalStringSchema } from './money';
import {
  DEFAULT_SESSION_TRADES,
  MAX_SESSION_TRADES,
  TRADING_SESSION_SETTINGS_VERSION,
  TradingSessionStopReason,
  safeParseTradingSessionSettings,
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
