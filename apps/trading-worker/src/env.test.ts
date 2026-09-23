import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('parseEnv', () => {
  it('applies defaults for the optional variables', () => {
    expect(parseEnv(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      logLevel: 'info',
      intentMaxAgeMs: 60_000,
      submitAckTimeoutMs: 10_000,
      workerConcurrency: 5,
    });
  });

  it('accepts explicit values', () => {
    const env = parseEnv({
      ...valid,
      LOG_LEVEL: 'debug',
      INTENT_MAX_AGE_MS: '30000',
      SUBMIT_ACK_TIMEOUT_MS: '5000',
      WORKER_CONCURRENCY: '1',
    });
    expect(env).toMatchObject({
      logLevel: 'debug',
      intentMaxAgeMs: 30_000,
      submitAckTimeoutMs: 5_000,
      workerConcurrency: 1,
    });
  });

  it.each(['DATABASE_URL', 'REDIS_URL'])('rejects missing %s', (name) => {
    expect(() => parseEnv({ ...valid, [name]: undefined })).toThrow(`Missing required env ${name}`);
  });

  it.each([
    ['INTENT_MAX_AGE_MS', '999', 'Env INTENT_MAX_AGE_MS must be between 1000 and 600000'],
    ['INTENT_MAX_AGE_MS', '600001', 'Env INTENT_MAX_AGE_MS must be between 1000 and 600000'],
    ['SUBMIT_ACK_TIMEOUT_MS', '499', 'Env SUBMIT_ACK_TIMEOUT_MS must be between 500 and 30000'],
    ['SUBMIT_ACK_TIMEOUT_MS', '30001', 'Env SUBMIT_ACK_TIMEOUT_MS must be between 500 and 30000'],
    ['WORKER_CONCURRENCY', '0', 'Env WORKER_CONCURRENCY must be between 1 and 100'],
    ['WORKER_CONCURRENCY', 'x', 'Env WORKER_CONCURRENCY must be an integer'],
    ['LOG_LEVEL', 'loud', 'Env LOG_LEVEL must be one of: fatal error warn info debug trace silent'],
  ])('rejects %s=%s', (name, value, message) => {
    expect(() => parseEnv({ ...valid, [name]: value })).toThrow(message);
  });
});
