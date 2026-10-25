import { describe, expect, it } from 'vitest';
import { breakEvenPct, MIN_CYCLE_PAYOUT_PCT } from './catalog';
import {
  H1_DECISION_SETS,
  H1_ENTRY_WINDOW_SEC,
  H1_SESSION_DECISION_SET,
  H1ShadowSet,
  H1_EXPIRY_SEC,
  H1_MIN_PAYOUT_PCT,
  H1_PRICE_RANGE,
  H1_R1_PARAMS,
  H1_REPEAT_VERSION,
  H1_START_VERSION,
  H1_VERSION,
  h1DecisionSchema,
  h1ShadowEntrySchema,
  h1ShadowParamsSchema,
  h1ShadowResultSchema,
  h1ShadowSourceSchema,
  shownSignalSchema,
  tradeOutcomeOf,
} from './h1';
import { SIGNAL_ALGORITHM_VERSIONS } from './signal';
import { TradeAction } from './trading';
import { SIGNAL_VERSION_PATTERN } from './trade-log';

const features = { move: 3, sd: 1, z: 3, moves: 60, lastClose: 1004 };
const signal = { kind: 'signal', version: 'h1', action: 'up', features };

describe('the H1 decision wire (#667)', () => {
  it('H-S1: every shape the detector returns parses, a malformed one is refused', () => {
    for (const decision of [
      signal,
      { ...signal, action: 'down', features: { ...features, move: -3, lastClose: 996 } },
      { kind: 'no_signal', version: 'h1', reason: 'below_threshold', features },
      { kind: 'no_signal', version: 'h1', reason: 'no_price', detail: { missing: 'last' } },
      { kind: 'no_signal', version: 'h1', reason: 'no_price', detail: { missing: 'before' } },
      { kind: 'no_signal', version: 'h1', reason: 'no_volatility', detail: { moves: 60 } },
      { ...signal, features: { ...features, lastClose: H1_PRICE_RANGE.min } },
      { ...signal, features: { ...features, lastClose: H1_PRICE_RANGE.max } },
    ]) {
      expect(h1DecisionSchema.safeParse(decision).success, JSON.stringify(decision)).toBe(true);
    }
    for (const decision of [
      { ...signal, features: { ...features, z: Infinity } },
      { ...signal, features: { ...features, z: NaN } },
      { ...signal, features: { ...features, sd: 0 } },
      { ...signal, features: { ...features, moves: 0 } },
      { ...signal, extra: 1 },
      { ...signal, version: 'v2' },
      { kind: 'no_signal', version: 'h1', reason: 'no_history', detail: { moves: 0 } },
      { kind: 'no_signal', version: 'h1', reason: 'no_volatility', detail: { moves: 0 } },
      { kind: 'no_signal', version: 'h1', reason: 'no_price', detail: { missing: 'next' } },
      { ...signal, features: { ...features, lastClose: 0 } },
      { ...signal, features: { ...features, lastClose: -1 } },
      { ...signal, features: { ...features, lastClose: 5e-101 } },
      { ...signal, features: { ...features, lastClose: 2e100 } },
    ]) {
      expect(h1DecisionSchema.safeParse(decision).success, JSON.stringify(decision)).toBe(false);
    }
  });

  it('H-S2: the version fits the decision log version column of #666', () => {
    expect(H1_VERSION).toMatch(SIGNAL_VERSION_PATTERN);
  });

  it('H-S3: the trade plan opens after the closed second and pays above the cycle floor', () => {
    expect(H1_ENTRY_WINDOW_SEC.from).toBeGreaterThanOrEqual(1);
    expect(H1_ENTRY_WINDOW_SEC.to).toBeGreaterThanOrEqual(H1_ENTRY_WINDOW_SEC.from);
    expect(H1_EXPIRY_SEC).toBeGreaterThan(0);
    expect(H1_MIN_PAYOUT_PCT).toBeGreaterThan(MIN_CYCLE_PAYOUT_PCT);
    expect(breakEvenPct(H1_MIN_PAYOUT_PCT)).toBeLessThan(52);
  });

  // The smallest non-zero move between two closes >= min is ulp(min) >= min x 2^-53; its square over
  // 2^53 moves (more than any array holds) is still normal, and 2^53 squares of max stay finite.
  it("H-S4: inside the price range a move's square and the mean of up to 2^53 squares stay normal", () => {
    expect((H1_PRICE_RANGE.min * 2 ** -53) ** 2 / 2 ** 53).toBeGreaterThanOrEqual(2 ** -1022);
    expect(2 ** 53 * H1_PRICE_RANGE.max ** 2).toBeLessThan(Number.MAX_VALUE);
  });
});

describe('the H1 shadow row (#669)', () => {
  const params = { set: 'r1', ...H1_R1_PARAMS, entryDelaySec: 1, expirySec: 5 };
  const series = [...Array<number | null>(H1_R1_PARAMS.sdWindowSec).fill(1.1), 1.1002];
  const entry = {
    assetId: 1605169136,
    interval: null,
    digits: 5,
    nowMs: 1_760_000_000_000,
    source: { kind: 'ticks', symbol: 'EUR/USD', closedBy: 'clock', closedAtMs: 1_760_000_000_500 },
    version: H1_VERSION,
    params,
    series,
    decision: {
      kind: 'no_signal',
      version: H1_VERSION,
      reason: 'no_price',
      detail: { missing: 'before' },
    },
  };

  it('H-S5: R1 is a 3-second move over a 300 s window, and the params carry the set and the plan', () => {
    expect(H1_R1_PARAMS.moveSec).toBe(3);
    expect(H1_R1_PARAMS.sdWindowSec).toBe(300);
    expect(Object.isFrozen(H1_R1_PARAMS)).toBe(true);
    expect(h1ShadowParamsSchema.parse(params)).toEqual(params);
    expect(h1ShadowParamsSchema.safeParse({ ...params, set: 'r2' }).success).toBe(false);
    expect(h1ShadowParamsSchema.safeParse({ ...params, entryDelaySec: 0 }).success).toBe(false);
    expect(h1ShadowParamsSchema.safeParse({ ...params, extra: 1 }).success).toBe(false);
  });

  it('H-S6: the entry a shadow row rebuilds parses; its series holds sdWindowSec + 1 closes', () => {
    expect(h1ShadowEntrySchema.parse(entry)).toEqual(entry);
    expect(h1ShadowEntrySchema.safeParse({ ...entry, series: series.slice(1) }).success).toBe(
      false,
    );
    expect(
      h1ShadowEntrySchema.safeParse({ ...entry, series: [...series.slice(1), 0] }).success,
    ).toBe(false);
    expect(h1ShadowEntrySchema.safeParse({ ...entry, interval: '1s' }).success).toBe(false);
    expect(h1ShadowEntrySchema.safeParse({ ...entry, version: 'v2' }).success).toBe(false);
    expect(h1ShadowSourceSchema.safeParse({ ...entry.source, closedBy: 'rest' }).success).toBe(
      false,
    );
  });

  it("H-S9: the driver's rows (#707) carry set session; every shadow set is a decision set", () => {
    expect(H1_SESSION_DECISION_SET).toBe('session');
    expect(h1ShadowParamsSchema.parse({ ...params, set: 'session' }).set).toBe('session');
    expect(h1ShadowEntrySchema.parse({ ...entry, params: { ...params, set: 'session' } })).toEqual({
      ...entry,
      params: { ...params, set: 'session' },
    });
    for (const set of Object.values(H1ShadowSet)) expect(H1_DECISION_SETS).toContain(set);
    expect(h1ShadowParamsSchema.safeParse({ ...params, set: 'sessions' }).success).toBe(false);
  });

  it('H-S7: an up wins on a rise, a tie is neither, a down mirrors', () => {
    expect(tradeOutcomeOf(TradeAction.Up, 1, 2)).toBe('win');
    expect(tradeOutcomeOf(TradeAction.Up, 2, 1)).toBe('loss');
    expect(tradeOutcomeOf(TradeAction.Up, 1, 1)).toBe('tie');
    expect(tradeOutcomeOf(TradeAction.Down, 2, 1)).toBe('win');
    expect(tradeOutcomeOf(TradeAction.Down, 1, 2)).toBe('loss');
    expect(tradeOutcomeOf(TradeAction.Down, 1, 1)).toBe('tie');
  });

  it('H-S8: the result holds at least one entry, unpriced without prices', () => {
    const result = {
      entries: [
        { entryDelaySec: 1, entryPrice: 1.1, exitPrice: 1.2, outcome: 'win' },
        { entryDelaySec: 2, entryPrice: null, exitPrice: null, outcome: 'unpriced' },
      ],
    };
    expect(h1ShadowResultSchema.parse(result)).toEqual(result);
    expect(h1ShadowResultSchema.safeParse({ entries: [] }).success).toBe(false);
    expect(
      h1ShadowResultSchema.safeParse({
        entries: [{ entryDelaySec: 1, entryPrice: 1, exitPrice: 1, outcome: 'refund' }],
      }).success,
    ).toBe(false);
  });
});

describe('the repeat step of an H1 session (#775)', () => {
  it("H-S10′: the repeat row's version fits the pattern, is no signal algorithm and is not H1's", () => {
    expect(H1_REPEAT_VERSION).toMatch(SIGNAL_VERSION_PATTERN);
    expect((SIGNAL_ALGORITHM_VERSIONS as readonly string[]).includes(H1_REPEAT_VERSION)).toBe(
      false,
    );
    expect(H1_REPEAT_VERSION).not.toBe(H1_VERSION);
  });
});

describe('the shown direction of a start (#829)', () => {
  const shown = {
    action: 'up',
    second: 1_700_000_000_000,
    decidedAt: 1_700_000_000_400,
    shownAtMs: 1_700_000_002_000,
    source: 'analysis',
  };

  it('H-S11: the record parses; an unknown source, an extra key, a zero or fractional second do not', () => {
    expect(shownSignalSchema.parse(shown)).toEqual(shown);
    expect(shownSignalSchema.parse({ ...shown, source: 'list' }).source).toBe('list');
    for (const bad of [
      { ...shown, source: 'card' },
      { ...shown, extra: 1 },
      { ...shown, second: 0 },
      { ...shown, second: 1.5 },
      { ...shown, action: 'sideways' },
      { ...shown, shownAtMs: undefined },
    ]) {
      expect(shownSignalSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("H-S12: the start row's version fits the pattern, is no signal algorithm, neither H1's nor the repeat's", () => {
    expect(H1_START_VERSION).toMatch(SIGNAL_VERSION_PATTERN);
    expect((SIGNAL_ALGORITHM_VERSIONS as readonly string[]).includes(H1_START_VERSION)).toBe(false);
    expect(H1_START_VERSION).not.toBe(H1_VERSION);
    expect(H1_START_VERSION).not.toBe(H1_REPEAT_VERSION);
  });
});
