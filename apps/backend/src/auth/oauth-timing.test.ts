import { describe, expect, it } from 'vitest';
import { INIT_DATA_CLOCK_SKEW_MS, INIT_DATA_MAX_AGE_MS, OAUTH_STATE_TTL_MS } from './oauth-timing';

describe('the OAuth timing constants', () => {
  it('accepts initData as old as the state can live, plus the clock skew', () => {
    expect(OAUTH_STATE_TTL_MS).toBe(600_000);
    expect(INIT_DATA_CLOCK_SKEW_MS).toBe(60_000);
    expect(INIT_DATA_MAX_AGE_MS).toBe(OAUTH_STATE_TTL_MS + INIT_DATA_CLOCK_SKEW_MS);
  });
});
