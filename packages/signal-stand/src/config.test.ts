import {
  BROKER_RATE_LIMIT_PER_MINUTE,
  H1_ENTRY_WINDOW_SEC,
  H1_EXPIRY_SEC,
  H1_R1_PARAMS,
} from '@binarius/shared';
import { DEFAULT_H1_PARAMS } from '@binarius/signal';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_HEADLINE_DELAY_MS,
  H1_DEFAULT_SHAPES,
  H1_ENTRY_DELAY_GRID_SEC,
  H1_EXPIRY_GRID_SEC,
  H1_MOVE_SEC_GRID,
  H1_SD_STEP_GRID,
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

  it('K6 the grids hold R1 and the reference H1, the default shapes are those two (#669)', () => {
    for (const params of [H1_R1_PARAMS, DEFAULT_H1_PARAMS]) {
      expect(H1_MOVE_SEC_GRID).toContain(params.moveSec);
      expect(H1_SD_STEP_GRID).toContain(params.sdStepSec);
      expect(H1_THRESHOLD_GRID).toContain(params.threshold);
    }
    expect(H1_DEFAULT_SHAPES).toEqual([
      { moveSec: DEFAULT_H1_PARAMS.moveSec, sdStepSec: DEFAULT_H1_PARAMS.sdStepSec },
      { moveSec: H1_R1_PARAMS.moveSec, sdStepSec: H1_R1_PARAMS.sdStepSec },
    ]);
  });
});
