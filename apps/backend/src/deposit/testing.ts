// Test-only fixtures for the deposit route. Compiled by `tsc -b` alongside the *.test.ts files next
// to it and imported by no runtime module.

import type { DepositRoutesDeps } from './routes';

// for suites that never call POST /deposit/widget-session
export const unusedDepositDeps = (): DepositRoutesDeps => ({
  db: {} as DepositRoutesDeps['db'],
  accessToken: () => {
    throw new Error('the deposit route is not wired in this test');
  },
  rest: {
    createWidgetSession: () => {
      throw new Error('the deposit route is not wired in this test');
    },
  },
  initDataVerifier: {
    verify: () => {
      throw new Error('the deposit route is not wired in this test');
    },
  },
  demoOnly: false,
  webOrigin: 'https://cashier.example',
  platformOrigin: 'https://binodex.app',
  clientId: 'client-id',
  widgetOrigins: ['https://binodex.app'],
});
