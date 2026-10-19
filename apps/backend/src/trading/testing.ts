// Test-only fixtures for the trading routes. Compiled by `tsc -b` alongside the *.test.ts files
// next to it and imported by no runtime module.

import { signalRecordFixture } from '@binarius/db/testing';
import {
  NoSignalReason,
  SessionStakeStrategy,
  SignalKind,
  TradeAction,
  type PairsCatalogView,
} from '@binarius/shared';
import type { SignalEvaluation } from '@binarius/signal';
import type { PairsRoutesDeps } from './pairs-routes';
import type { TradingRoutesDeps } from './routes';
import type { TradingSessionRoutesDeps } from './session-routes';
import type { SignalRoutesDeps } from './signal-routes';
import type { SignalsRoutesDeps } from './signals-routes';

export const PAIRS_TEST_TOKEN = 'internal-token-for-tests';

export const fakeCatalog = (view: PairsCatalogView | undefined): PairsRoutesDeps['catalog'] => ({
  read: () => view,
});

// for suites that never call GET /trading/pairs
export const unusedPairsDeps = (): PairsRoutesDeps => ({
  catalog: fakeCatalog(undefined),
  internalApiToken: PAIRS_TEST_TOKEN,
});

// for suites that never call POST /trading/accounts/:id/access-token
export const unusedAccessTokenDeps = (): TradingRoutesDeps['accessToken'] => () => {
  throw new Error('the access token route is not wired in this test');
};

// for suites that never call POST /trading/access
export const unusedBalanceDeps = (): TradingRoutesDeps['balance'] => ({
  refresh: () => {
    throw new Error('balance refresh is not wired in this test');
  },
});

// a feed that answers `evaluation` and records every request it was given
export function fakeSignalFeed(answer: SignalEvaluation | (() => Promise<SignalEvaluation>)) {
  const calls: Parameters<SignalRoutesDeps['feed']['evaluate']>[0][] = [];
  const feed: SignalRoutesDeps['feed'] = {
    evaluate: (request) => {
      calls.push(request);
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    },
  };
  return { feed, calls };
}

// A decided evaluation of `kind` for the session start's signal step (#509), which reads the
// decision's kind and a signal's direction (#568), and records the whole entry (#666)
export const sessionSignalEvaluation = (
  kind: SignalKind,
  action: TradeAction = TradeAction.Up,
): SignalEvaluation => {
  const { entry } = signalRecordFixture();
  return {
    outcome: 'decided',
    entry: {
      ...entry,
      decision:
        kind === SignalKind.Signal
          ? { ...entry.decision, kind, action }
          : {
              kind,
              version: 'v2',
              reason: NoSignalReason.InsufficientCandles,
              detail: { closedCandles: 2, required: 50 },
            },
    },
  } as SignalEvaluation;
};

// for suites that never call POST /trading/signal
export const unusedSignalDeps = (): SignalRoutesDeps => ({
  feed: {
    evaluate: () => {
      throw new Error('the signal feed is not wired in this test');
    },
  },
  catalog: fakeCatalog(undefined),
  internalApiToken: PAIRS_TEST_TOKEN,
  lastAnalysis: recordingLastAnalysis().lastAnalysis,
  ticks: undefined,
});

// a port of the last analysis (#484) that answers `answer` and records every call
export function recordingLastAnalysis(
  answer: () => Promise<boolean> = () => Promise.resolve(true),
) {
  const calls: Parameters<SignalRoutesDeps['lastAnalysis']['set']>[] = [];
  const lastAnalysis: SignalRoutesDeps['lastAnalysis'] = {
    set: (...args) => {
      calls.push(args);
      return answer();
    },
  };
  return { lastAnalysis, calls };
}

// for suites that never call GET /trading/signals
export const unusedSignalsDeps = (): SignalsRoutesDeps => ({
  scanners: [
    {
      snapshot: () => {
        throw new Error('the signal scanner is not wired in this test');
      },
    },
  ],
  internalApiToken: PAIRS_TEST_TOKEN,
});

// for suites that never call the /trading/sessions routes
export const unusedSessionDeps = (): TradingSessionRoutesDeps => ({
  db: {} as TradingSessionRoutesDeps['db'],
  catalog: fakeCatalog(undefined),
  balance: unusedBalanceDeps(),
  signals: {
    evaluate: () => {
      throw new Error('the session start signal is not wired in this test');
    },
  },
  internalApiToken: PAIRS_TEST_TOKEN,
  demoOnly: false,
  stakeStrategy: SessionStakeStrategy.Martingale,
  decisions: {
    record: () => {
      throw new Error('the trade log is not wired in this test');
    },
  },
  ticks: undefined,
});
