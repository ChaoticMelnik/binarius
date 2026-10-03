// Test-only fixtures for the pairs route. Compiled by `tsc -b` alongside the *.test.ts files
// next to it and imported by no runtime module.

import type { PairsCatalogView } from '@binarius/shared';
import type { PairsRoutesDeps } from './pairs-routes';

export const PAIRS_TEST_TOKEN = 'internal-token-for-tests';

export const fakeCatalog = (view: PairsCatalogView | undefined): PairsRoutesDeps['catalog'] => ({
  read: () => view,
});

// for suites that never call GET /trading/pairs
export const unusedPairsDeps = (): PairsRoutesDeps => ({
  catalog: fakeCatalog(undefined),
  internalApiToken: PAIRS_TEST_TOKEN,
});
