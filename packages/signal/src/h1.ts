import {
  H1_ENTRY_WINDOW_SEC,
  H1_PRICE_RANGE,
  H1_R1_PARAMS,
  H1_VERSION,
  H1ShadowSet,
  H1MissingPrice,
  H1NoSignalReason,
  SignalKind,
  TradeAction,
  type H1Decision,
  type H1Params,
  type H1ShadowEntry,
} from '@binarius/shared';

// The backtest's rule (#667, docs/signal-stand.md -> H1), fixed before the data: a 5-second move
// over the RMS of the 60 non-overlapping 5-second moves of the last 300 s, above 2.
export const DEFAULT_H1_PARAMS: Readonly<H1Params> = Object.freeze({
  moveSec: 5,
  sdWindowSec: 300,
  sdStepSec: 5,
  threshold: 2,
});

function fail(field: keyof H1Params, rule: string, value: number): never {
  throw new RangeError(`h1 params: ${field} must be ${rule}, got ${value}`);
}

export function assertH1Params(params: H1Params): void {
  for (const field of ['moveSec', 'sdWindowSec', 'sdStepSec'] as const) {
    if (!Number.isInteger(params[field]) || params[field] < 1) {
      fail(field, 'an integer >= 1', params[field]);
    }
  }
  // a multiple, so the window's last move is the current one
  if (params.sdWindowSec % params.sdStepSec !== 0) {
    fail('sdWindowSec', `a multiple of sdStepSec (${params.sdStepSec})`, params.sdWindowSec);
  }
  if (!Number.isFinite(params.threshold) || params.threshold <= 0) {
    fail('threshold', 'finite and > 0', params.threshold);
  }
}

// closes[i]: the close of the end-labelled second first + i x 1000 (the last price at or before
// it), NaN where the chart has no row; at: the index of the last closed second f
export interface H1Input {
  closes: ArrayLike<number>;
  at: number;
}

export interface H1Detector {
  version: typeof H1_VERSION;
  params: Readonly<H1Params>;
  decide: (input: H1Input) => H1Decision;
}

export function createH1Detector(params: H1Params = DEFAULT_H1_PARAMS): H1Detector {
  assertH1Params(params);
  const p: Readonly<H1Params> = Object.freeze({ ...params });
  const head = { kind: SignalKind.NoSignal, version: H1_VERSION } as const;

  function decide({ closes, at }: H1Input): H1Decision {
    if (!Number.isInteger(at) || at < 0 || at >= closes.length) {
      throw new RangeError(`h1: at must be an index of closes [0, ${closes.length}), got ${at}`);
    }
    // outside H1_PRICE_RANGE (a close <= 0 included) a close reads as missing, as NaN does
    const price = (i: number) => {
      const c = i >= 0 ? closes[i] : NaN;
      return c >= H1_PRICE_RANGE.min && c <= H1_PRICE_RANGE.max ? c : NaN;
    };
    const last = price(at);
    const before = price(at - p.moveSec);
    if (!Number.isFinite(last)) {
      return {
        ...head,
        reason: H1NoSignalReason.NoPrice,
        detail: { missing: H1MissingPrice.Last },
      };
    }
    if (!Number.isFinite(before)) {
      return {
        ...head,
        reason: H1NoSignalReason.NoPrice,
        detail: { missing: H1MissingPrice.Before },
      };
    }
    // the current move (j = at) is one of them, so moves >= 1 here and z <= sqrt(moves) up to rounding
    let ss = 0;
    let moves = 0;
    for (let j = at - p.sdWindowSec + p.sdStepSec; j <= at; j += p.sdStepSec) {
      const r = price(j) - price(j - p.moveSec);
      if (!Number.isFinite(r)) continue;
      ss += r * r;
      moves += 1;
    }
    const move = last - before;
    const sd = Math.sqrt(ss / moves);
    // in range, sd = 0 only on a flat window; the backtest script computes 0 / 0 = NaN there and
    // does not trade either
    if (sd === 0) return { ...head, reason: H1NoSignalReason.NoVolatility, detail: { moves } };
    const z = Math.abs(move) / sd;
    const features = { move, sd, z, moves, lastClose: last };
    if (z > p.threshold) {
      return {
        kind: SignalKind.Signal,
        version: H1_VERSION,
        action: move > 0 ? TradeAction.Up : TradeAction.Down,
        features,
      };
    }
    return { ...head, reason: H1NoSignalReason.BelowThreshold, features };
  }

  return { version: H1_VERSION, params: p, decide };
}

// a default edited out of its rules fails at import, not on the first decision
assertH1Params(DEFAULT_H1_PARAMS);

// The H1 shadow's two sets (#669, docs/h1.md; the shadow was removed in #830, the sets stay as
// the historical rows' params.set and the window ceiling): R1, the live rule, enters at +1 s; the
// backtest's rule, kept as the reference, at +2 s.
export interface H1ShadowSetSpec {
  name: H1ShadowSet;
  params: Readonly<H1Params>;
  entryDelaySec: number;
}

export const H1_SHADOW_SETS: readonly H1ShadowSetSpec[] = Object.freeze([
  { name: H1ShadowSet.R1, params: H1_R1_PARAMS, entryDelaySec: H1_ENTRY_WINDOW_SEC.from },
  { name: H1ShadowSet.H1, params: DEFAULT_H1_PARAMS, entryDelaySec: H1_ENTRY_WINDOW_SEC.to },
]);

// The earliest close a decision at f reads is f - sdWindowSec + sdStepSec - moveSec, so a window
// of sdWindowSec + 1 closes - the one an H1 row stores (Rule 44) and the H1 driver and the
// scanner decide on (#707, #828) - holds all of them only while moveSec <= sdStepSec.
export function assertH1WindowFits(params: H1Params, name: string): void {
  const { moveSec, sdStepSec } = params;
  if (moveSec > sdStepSec) {
    throw new RangeError(
      `${name}: moveSec (${moveSec}) must be <= sdStepSec (${sdStepSec}): the window of sdWindowSec + 1 closes holds every close a decision reads only then`,
    );
  }
}

export function assertH1ShadowSet(set: H1ShadowSetSpec): void {
  assertH1Params(set.params);
  assertH1WindowFits(set.params, `h1 shadow set ${set.name}`);
}

for (const set of H1_SHADOW_SETS) assertH1ShadowSet(set);

// the longest window a set reads: a decision at f needs the closes of f - sdWindowSec .. f, exact
// because every set passes assertH1ShadowSet; the series' capacity holds it (apps/backend timing)
export const H1_SHADOW_MAX_WINDOW_SEC = Math.max(
  ...H1_SHADOW_SETS.map((set) => set.params.sdWindowSec),
);

// An H1 row decided again from what it stored (Rule 44): the series holds exactly the doubles
// the detector read, with null where it read NaN, and the decision is at its last index.
export function replayH1Entry(entry: H1ShadowEntry): H1Decision {
  const { moveSec, sdWindowSec, sdStepSec, threshold } = entry.params;
  return createH1Detector({ moveSec, sdWindowSec, sdStepSec, threshold }).decide({
    closes: entry.series.map((close) => close ?? NaN),
    at: entry.series.length - 1,
  });
}
