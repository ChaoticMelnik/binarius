// Test-only fixtures for the trading routes. Compiled by `tsc -b` alongside the *.test.ts files
// next to it and imported by no runtime module.

import { SessionStakeStrategy, type PairsCatalogView } from '@binarius/shared';
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
// decision's kind alone; the journal fields are left out.
export const sessionSignalEvaluation = (kind: 'signal' | 'no_signal'): SignalEvaluation =>
  ({ outcome: 'decided', entry: { decision: { kind } } }) as unknown as SignalEvaluation;

// for suites that never call POST /trading/signal
export const unusedSignalDeps = (): SignalRoutesDeps => ({
  feed: {
    evaluate: () => {
      throw new Error('the signal feed is not wired in this test');
    },
  },
  catalog: fakeCatalog(undefined),
  internalApiToken: PAIRS_TEST_TOKEN,
});

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
});
