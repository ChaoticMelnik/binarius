import { BROKER_RATE_LIMIT_PER_MINUTE, H1_ENTRY_WINDOW_SEC, H1_EXPIRY_SEC } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_HEADLINE_DELAY_MS,
  H1_ENTRY_DELAY_GRID_SEC,
  H1_EXPIRY_GRID_SEC,
  H1_THRESHOLD_GRID,
  OPEN_DELAY_GRID_MS,
  STAND_ASSET_IDS,
  STAND_CHAIN_HOLDS,
  STAND_DEFAULT_GETS_PER_MINUTE,
  V2_FIRST_CLEAN_AT,
  V2_MERGED_AT,
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

  it('K4 28 distinct pairs, and the v2 era starts after the merge', () => {
    expect(new Set(STAND_ASSET_IDS).size).toBe(28);
    expect(STAND_ASSET_IDS).toHaveLength(28);
    expect(V2_MERGED_AT).toBeLessThan(V2_FIRST_CLEAN_AT);
  });

  it('K5 the H1 grids are the trade plan of shared', () => {
    expect(H1_THRESHOLD_GRID.length).toBeGreaterThan(0);
    expect(H1_ENTRY_DELAY_GRID_SEC).toEqual([H1_ENTRY_WINDOW_SEC.from, H1_ENTRY_WINDOW_SEC.to]);
    expect(H1_EXPIRY_GRID_SEC).toContain(H1_EXPIRY_SEC);
  });
});
