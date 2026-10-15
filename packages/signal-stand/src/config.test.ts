import { BROKER_RATE_LIMIT_PER_MINUTE } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_HEADLINE_DELAY_MS,
  OPEN_DELAY_GRID_MS,
  STAND_ASSET_IDS,
  STAND_CHAIN_HOLDS,
  STAND_DEFAULT_GETS_PER_MINUTE,
} from './config';

describe('stand config', () => {
  it('K1 the cap chain holds at import', () => {
    expect(STAND_CHAIN_HOLDS).toBe(true);
  });

  it('K2 the default cap stays below the broker window', () => {
    expect(STAND_DEFAULT_GETS_PER_MINUTE).toBeLessThan(BROKER_RATE_LIMIT_PER_MINUTE);
  });

  it('K3 the delay grid holds the fallback headline delay', () => {
    expect(OPEN_DELAY_GRID_MS).toContain(FALLBACK_HEADLINE_DELAY_MS);
  });

  it('K4 28 distinct pairs', () => {
    expect(new Set(STAND_ASSET_IDS).size).toBe(28);
    expect(STAND_ASSET_IDS).toHaveLength(28);
  });
});
