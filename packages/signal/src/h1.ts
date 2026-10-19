import {
  H1_VERSION,
  H1MissingPrice,
  H1NoSignalReason,
  SignalKind,
  TradeAction,
  type H1Decision,
  type H1Params,
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
    const close = (i: number) => (i >= 0 ? closes[i] : NaN);
    const last = closes[at];
    const before = close(at - p.moveSec);
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
    // the current move (j = at) is one of them, so moves >= 1 here and z <= sqrt(moves)
    let ss = 0;
    let moves = 0;
    for (let j = at - p.sdWindowSec + p.sdStepSec; j <= at; j += p.sdStepSec) {
      const r = close(j) - close(j - p.moveSec);
      if (!Number.isFinite(r)) continue;
      ss += r * r;
      moves += 1;
    }
    const move = last - before;
    const sd = Math.sqrt(ss / moves);
    // the backtest script computes 0 / 0 = NaN here and does not trade either
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
