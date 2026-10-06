// Test-only fixtures for the trading routes. Compiled by `tsc -b` alongside the *.test.ts files
// next to it and imported by no runtime module.

import type { PairsCatalogView } from '@binarius/shared';
import type { SignalEvaluation } from '@binarius/signal';
import type { PairsRoutesDeps } from './pairs-routes';
import type { TradingRoutesDeps } from './routes';
import type { SignalRoutesDeps } from './signal-routes';

export const PAIRS_TEST_TOKEN = 'internal-token-for-tests';

export const fakeCatalog = (view: PairsCatalogView | undefined): PairsRoutesDeps['catalog'] => ({
  read: () => view,
});

// for suites that never call GET /trading/pairs
export const unusedPairsDeps = (): PairsRoutesDeps => ({
  catalog: fakeCatalog(undefined),
  internalApiToken: PAIRS_TEST_TOKEN,
});

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

// for suites that never call POST /trading/signal
export const unusedSignalDeps = (): SignalRoutesDeps => ({
  feed: {
    evaluate: () => {
      throw new Error('the signal feed is not wired in this test');
    },
  },
  internalApiToken: PAIRS_TEST_TOKEN,
});
