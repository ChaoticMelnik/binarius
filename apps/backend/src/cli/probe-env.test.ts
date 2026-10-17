import { describe, expect, it } from 'vitest';
import { readProbeEnv } from './probe-env';

describe('readProbeEnv', () => {
  it('asks for ACCOUNT_ID first', () => {
    expect(() => readProbeEnv({})).toThrow(/^Missing required env ACCOUNT_ID$/);
  });

  it('refuses an ACCOUNT_ID that is not a uuid without echoing it', () => {
    let message = '';
    try {
      readProbeEnv({ ACCOUNT_ID: 'not-a-uuid-SECRET' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Env ACCOUNT_ID must be a uuid');
  });

  it('reads the rest of the env once the id is a uuid', () => {
    expect(() => readProbeEnv({ ACCOUNT_ID: '3f2b0a4c-9d3e-4c1a-8b5e-2a6f7d8c9e01' })).toThrow(
      /^Missing required env DATABASE_URL$/,
    );
  });
});
