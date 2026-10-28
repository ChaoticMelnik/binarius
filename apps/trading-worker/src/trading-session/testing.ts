import type { PairView } from '@binarius/shared';

// the mock broker's EUR/USD as GET /trading/pairs shows it
export const eurUsd = (patch: Partial<PairView> = {}): PairView => ({
  id: 101,
  symbol: 'EUR/USD',
  isOtc: false,
  type: 'currency',
  digits: 5,
  payout: 85,
  maxPayout: 90,
  minTimeframe: 60,
  maxTimeframe: 3600,
  scheduledUntil: 0,
  ...patch,
});
