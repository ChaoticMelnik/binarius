import { describe, expect, it } from 'vitest';
import { MAX_SPIKE_MINUTES, parseSpikeEnv, runCandleSpikeCli } from './candle-spike';

const valid = {
  ACCOUNT_ID: '3f0c2a52-58b4-4e6a-9d0e-6a1b2c3d4e5f',
  BROKER_WS_URL: 'wss://broker-ws.example.test',
  BACKEND_URL: 'http://backend:3000',
  INTERNAL_API_TOKEN: 'internal-token-for-tests-0123456789',
  DATABASE_URL: 'postgres://binarius@127.0.0.1:5434/binarius',
  BROKER_API_BASE_URL: 'https://broker-api.example.test',
};

describe('parseSpikeEnv', () => {
  it('E1 SPIKE_MINUTES: 30 by default, 1..80', () => {
    expect(parseSpikeEnv(valid)).toMatchObject({ minutes: 30, pairs: 10, subscribeAll: true });
    expect(parseSpikeEnv({ ...valid, SPIKE_MINUTES: '80' }).minutes).toBe(80);
    expect(() => parseSpikeEnv({ ...valid, SPIKE_MINUTES: '0' })).toThrow('SPIKE_MINUTES');
    expect(() => parseSpikeEnv({ ...valid, SPIKE_MINUTES: '81' })).toThrow('SPIKE_MINUTES');
    // the 1s fetch of the longest run stays under the broker's 5000-row cap
    expect(MAX_SPIKE_MINUTES * 60 + 6).toBeLessThan(5_000);
  });

  it('E2 SPIKE_ASSET_IDS: positive integers, at most 40', () => {
    expect(parseSpikeEnv({ ...valid, SPIKE_ASSET_IDS: '7, 12' }).assetIds).toEqual([7, 12]);
    expect(() => parseSpikeEnv({ ...valid, SPIKE_ASSET_IDS: '1,x' })).toThrow('SPIKE_ASSET_IDS');
    expect(() => parseSpikeEnv({ ...valid, SPIKE_ASSET_IDS: '0' })).toThrow('SPIKE_ASSET_IDS');
    const many = Array.from({ length: 41 }, (_, i) => i + 1).join(',');
    expect(() => parseSpikeEnv({ ...valid, SPIKE_ASSET_IDS: many })).toThrow('SPIKE_ASSET_IDS');
    expect(() => parseSpikeEnv({ ...valid, SPIKE_SUBSCRIBE_ALL: 'yes' })).toThrow(
      'SPIKE_SUBSCRIBE_ALL',
    );
  });

  it('E3 a non-uuid ACCOUNT_ID: setup failed, naming the variable only', async () => {
    const err: string[] = [];
    const out: string[] = [];
    const code = await runCandleSpikeCli(
      { ...valid, ACCOUNT_ID: 'SECRET-not-a-uuid' },
      (line) => out.push(line),
      (line) => err.push(line),
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['setup failed: Env ACCOUNT_ID must be a broker_accounts.id (uuid)']);
  });
});
